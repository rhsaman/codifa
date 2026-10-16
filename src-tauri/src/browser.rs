//! Native in-app browser session (migrated from the Python sidecar's
//! `browser_session.py`).
//!
//! One headless Chromium per chat, driven over the Chrome DevTools Protocol.
//! The right-side Browser panel polls `/browser/screenshot` for JPEG frames and
//! posts its clicks/keys back through `/browser/*`, while the agent's Playwright
//! MCP connector attaches to the SAME browser via `--cdp-endpoint` — so both
//! sides drive one page and nothing ever opens outside the app.
//!
//! The user's real mouse and keyboard are never touched: every input goes
//! through CDP. All entry points are safe to call while the session is down —
//! they return `{"ok": false, "error": ...}` instead of raising, matching the
//! Python contract the frontend already consumes.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// Viewport a fresh session starts with (mirrors browser_session.DEFAULT_VIEWPORT).
const DEFAULT_VIEWPORT: (u32, u32) = (1280, 800);
/// JPEG quality for the panel's frames (mirrors the Python `quality=60`).
const SCREENSHOT_QUALITY: u32 = 60;
/// How long to wait for Chromium's debugging port to answer.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-CDP-command timeout.
const CDP_TIMEOUT: Duration = Duration::from_secs(30);

/// A live Chromium owned by one chat.
struct BrowserProc {
    child: Child,
    port: u16,
    /// Emulated viewport. Persisted per session so the panel's ruler and
    /// fit-to-pane resizes STICK: every `/browser/status` and screenshot
    /// reports this size, and a poll can never reset the user's choice.
    viewport: (u32, u32),
    /// Last time this session was used. A Chromium is ~150-300 MB, and one is
    /// spawned per chat, so sessions that nobody polls any more must be reaped
    /// instead of accumulating until the app exits.
    last_used: std::time::Instant,
}

/// Sessions keyed by normalized chat id. `Vec` (not `HashMap`) so the static
/// stays `const`-constructible without a lazy initializer.
static SESSIONS: Mutex<Vec<(String, BrowserProc)>> = Mutex::new(Vec::new());

// ---------------------------------------------------------------------------
// Paths and process discovery
// ---------------------------------------------------------------------------

/// Session key for a chat (empty/None falls back to the legacy default).
fn normalize_chat(chat_id: &str) -> String {
    let key = chat_id.trim();
    if key.is_empty() {
        "default".to_string()
    } else {
        key.to_string()
    }
}

/// App data root (mirrors the sidecar's CODER_DATA_DIR / ~/.codifa fallback).
fn data_root() -> PathBuf {
    if let Ok(d) = std::env::var("CODER_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codifa")
}

/// Persistent profile dir for one chat, so cookies/logins survive a restart.
fn profile_dir(chat: &str) -> PathBuf {
    let base = data_root().join("browser-profile");
    if chat == "default" {
        return base;
    }
    let safe: String = chat
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    base.join(format!(
        "chat-{}",
        if safe.is_empty() { "x".to_string() } else { safe }
    ))
}

/// Resolve an executable on PATH (a GUI-launched app has a minimal PATH, so
/// the login-shell PATH is merged in first — same helper the sidecar uses).
fn which(name: &str) -> Option<PathBuf> {
    let path = crate::sidecar::shell_path();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Chromium binaries to try, in order: Playwright's bundled build first (it is
/// already on disk for most installs), then the system browsers.
fn chromium_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let cache = home.join("Library/Caches/ms-playwright");
        if let Ok(entries) = std::fs::read_dir(&cache) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("chromium"))
                        .unwrap_or(false)
                })
                .collect();
            dirs.sort();
            dirs.reverse(); // newest build first
            for d in dirs {
                out.push(d.join("chrome-mac/Chromium.app/Contents/MacOS/Chromium"));
            }
        }
    }
    for p in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ] {
        out.push(PathBuf::from(p));
    }
    for name in ["chromium", "google-chrome", "chrome", "chromium-browser"] {
        if let Some(p) = which(name) {
            out.push(p);
        }
    }
    out
}

/// First Chromium that actually exists on disk.
fn find_chromium() -> Option<PathBuf> {
    chromium_candidates().into_iter().find(|p| p.is_file())
}

// ---------------------------------------------------------------------------
// Minimal CDP transport
// ---------------------------------------------------------------------------

/// Raw HTTP GET returning the parsed JSON body. Uses a plain socket rather than
/// `reqwest::blocking`, which panics when called from inside a runtime.
///
/// The body is read by `Content-Length` instead of `read_to_end`: Chrome's
/// DevTools HTTP server keeps the socket open after the response, so
/// `read_to_end` would block until the read timeout and report a failure even
/// though the reply had already arrived.
fn http_get_json(port: u16, path: &str) -> Result<Value, String> {
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "bad cdp address".to_string())?;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("cdp http connect: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("cdp http write: {e}"))?;

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let mut want: Option<usize> = None;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let head = String::from_utf8_lossy(&buf[..pos]);
                        want = head.lines().find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        });
                    }
                }
                if let (Some(h), Some(w)) = (header_end, want) {
                    if buf.len() >= h + w {
                        break;
                    }
                }
            }
            // Read timeout: fall through with whatever arrived so far.
            Err(_) => break,
        }
    }
    let start = header_end.ok_or_else(|| "cdp http: no response headers".to_string())?;
    serde_json::from_slice(&buf[start..]).map_err(|e| format!("cdp http body: {e}"))
}

/// WebSocket URL of the page target (the tab the panel mirrors).
fn page_ws_url(port: u16) -> Result<String, String> {
    let list = http_get_json(port, "/json/list")?;
    let arr = list
        .as_array()
        .ok_or_else(|| "cdp target list is not an array".to_string())?;
    for t in arr {
        if t["type"].as_str() != Some("page") {
            continue;
        }
        if let Some(ws) = t["webSocketDebuggerUrl"].as_str() {
            if !ws.is_empty() {
                return Ok(ws.to_string());
            }
        }
    }
    Err("no debuggable page target".into())
}

/// One CDP connection to the page target.
struct Cdp {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
}

impl Cdp {
    async fn connect(ws_url: &str) -> Result<Self, String> {
        let (ws, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect failed: {e}"))?;
        Ok(Self { ws, next_id: 1 })
    }

    /// Send one command and wait for its matching reply.
    async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({"id": id, "method": method, "params": params});
        self.ws
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("cdp send {method}: {e}"))?;
        let deadline = Instant::now() + CDP_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("cdp {method} timed out"));
            }
            let next = tokio::time::timeout(remaining, self.ws.next())
                .await
                .map_err(|_| format!("cdp {method} timed out"))?;
            let Some(Ok(Message::Text(txt))) = next else {
                continue;
            };
            let v: Value = match serde_json::from_str(&txt) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue; // an event or another command's reply
            }
            if let Some(err) = v.get("error") {
                return Err(format!("cdp {method}: {err}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

/// Run a sequence of CDP commands over ONE connection.
async fn cdp_calls(port: u16, calls: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    let ws = page_ws_url(port)?;
    let mut cdp = Cdp::connect(&ws).await?;
    let mut out = Vec::with_capacity(calls.len());
    for (method, params) in calls {
        out.push(cdp.send(method, params).await?);
    }
    Ok(out)
}

/// Device-metrics override params for an emulated viewport.
fn viewport_override(w: u32, h: u32) -> Value {
    json!({
        "width": w,
        "height": h,
        "deviceScaleFactor": 1,
        "mobile": false,
    })
}

/// Prepend the session's viewport override to a batch of CDP calls.
///
/// `Emulation.setDeviceMetricsOverride` is scoped to the CDP SESSION, and every
/// call here opens a fresh WebSocket — so an override set by an earlier
/// /browser/viewport request is already gone by the time the next command runs.
/// That is why the frame (and the input coordinate space) stayed at the launch
/// size no matter what the ruler said. Riding along in the SAME batch makes the
/// size stick for screenshots AND for click/type/scroll coordinates.
fn with_viewport_override(
    w: u32,
    h: u32,
    calls: Vec<(&'static str, Value)>,
) -> Vec<(&'static str, Value)> {
    let mut all = Vec::with_capacity(calls.len() + 1);
    all.push(("Emulation.setDeviceMetricsOverride", viewport_override(w, h)));
    all.extend(calls);
    all
}

/// Run CDP commands with the session's emulated viewport re-applied first.
async fn cdp_calls_sized(
    port: u16,
    chat: &str,
    calls: Vec<(&'static str, Value)>,
) -> Result<Vec<Value>, String> {
    let (w, h) = session_viewport(chat);
    let mut out = cdp_calls(port, with_viewport_override(w, h, calls)).await?;
    out.remove(0);
    Ok(out)
}

/// Run one CDP command.
async fn cdp_call(port: u16, method: &'static str, params: Value) -> Result<Value, String> {
    Ok(cdp_calls(port, vec![(method, params)])
        .await?
        .pop()
        .unwrap_or(Value::Null))
}

/// Drive an async CDP operation from a sync caller (the router handlers and the
/// MCP connector are both sync). A fresh thread owns the runtime, so this is
/// safe from inside the axum runtime too.
fn block_on<F>(fut: F) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("browser runtime: {e}"))?;
        rt.block_on(fut)
    })
    .join()
    .map_err(|_| "browser thread panicked".to_string())?
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/// How long a session may sit unused before its Chromium is reaped. The panel
/// polls every ~1.2s while it is open, so only a closed panel goes idle.
const IDLE_REAP: Duration = Duration::from_secs(600);

/// Whether a session idle for `elapsed` should be reaped. Pure so the policy is
/// unit-tested without spawning a real Chromium.
fn should_reap(elapsed: Duration, ttl: Duration) -> bool {
    elapsed >= ttl
}

/// Kill sessions nobody has touched for `IDLE_REAP`. Called on every session
/// lookup (i.e. on each panel poll), so a closed panel's Chromium is released
/// without needing a background thread.
fn reap_idle(guard: &mut Vec<(String, BrowserProc)>) {
    let now = std::time::Instant::now();
    guard.retain_mut(|(_, proc)| {
        if !should_reap(now.duration_since(proc.last_used), IDLE_REAP) {
            return true;
        }
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        false
    });
}

/// Port of a live session, reaping a crashed Chromium so it never looks active.
fn session_port(chat: &str) -> Option<u16> {
    let mut guard = SESSIONS.lock().ok()?;
    reap_idle(&mut guard);
    let idx = guard.iter().position(|(k, _)| k == chat)?;
    let alive = guard[idx].1.child.try_wait().ok().flatten().is_none();
    if !alive {
        let (_, mut proc) = guard.remove(idx);
        let _ = proc.child.kill();
        return None;
    }
    guard[idx].1.last_used = std::time::Instant::now();
    Some(guard[idx].1.port)
}

/// Emulated viewport of a live session (falls back to the default size).
fn session_viewport(chat: &str) -> (u32, u32) {
    let Ok(guard) = SESSIONS.lock() else {
        return DEFAULT_VIEWPORT;
    };
    guard
        .iter()
        .find(|(k, _)| k == chat)
        .map(|(_, p)| p.viewport)
        .unwrap_or(DEFAULT_VIEWPORT)
}

/// Remember a session's viewport so later polls report the same size.
fn store_viewport(chat: &str, size: (u32, u32)) {
    if let Ok(mut guard) = SESSIONS.lock() {
        if let Some((_, proc)) = guard.iter_mut().find(|(k, _)| k == chat) {
            proc.viewport = size;
        }
    }
}

/// Pick a free ephemeral port for Chromium's debugging endpoint.
fn pick_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("cannot pick a cdp port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

/// Remove a stale Chromium profile lock left behind by a crashed run.
/// Chromium refuses to open its debugging port (or silently hands the command
/// to a dead instance) while `SingletonLock` still points at a gone process.
fn clear_stale_profile_lock(profile: &std::path::Path) {
    for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
}

/// Last meaningful lines of the captured Chromium stderr, for error messages.
/// Chrome spawns its updater/crashpad helpers on the same stream, so their
/// noise is filtered out and only lines that look like real failures survive.
fn stderr_tail(profile: &std::path::Path) -> String {
    let text = std::fs::read_to_string(profile.join("chromium-stderr.log")).unwrap_or_default();
    let interesting: Vec<&str> = text
        .lines()
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            !l.trim().is_empty()
                && (low.contains("devtools listening")
                    || low.contains("failed")
                    || low.contains("cannot")
                    || low.contains("singleton")
                    || low.contains("profile"))
        })
        .collect();
    let tail = interesting[interesting.len().saturating_sub(3)..].join(" / ");
    if tail.is_empty() {
        "no diagnostic output".to_string()
    } else {
        tail
    }
}

/// Start one Chromium for `profile`. stderr is captured to a file so a startup
/// failure can be REPORTED instead of surfacing as a bare timeout.
fn try_launch(
    bin: &std::path::Path,
    port: u16,
    profile: &std::path::Path,
) -> Result<Child, String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("cannot create profile dir: {e}"))?;
    clear_stale_profile_lock(profile);
    let err_file = std::fs::File::create(profile.join("chromium-stderr.log"))
        .map_err(|e| format!("cannot open chromium log: {e}"))?;
    Command::new(bin)
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!(
            "--remote-allow-origins=http://127.0.0.1:{port},https://chrome-devtools-frontend.appspot.com"
        ))
        // Plain `--headless` IS the new headless mode on Chrome 112+; the
        // `--headless=new` spelling was dropped in later releases and made
        // Chromium exit before opening the debugging port.
        .arg("--headless")
        .arg("--disable-gpu")
        .arg("--disable-blink-features=AutomationControlled")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--window-size=1280,800")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file))
        .spawn()
        .map_err(|e| format!("cannot start Chromium ({}): {e}", bin.display()))
}

/// Wait until Chromium's debugging port answers, or report why it never did.
fn wait_for_port(
    child: &mut Child,
    port: u16,
    profile: &std::path::Path,
) -> Result<(), String> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if http_get_json(port, "/json/version").is_ok() {
            return Ok(());
        }
        if child.try_wait().ok().flatten().is_some() {
            return Err(format!(
                "Chromium exited during startup: {}",
                stderr_tail(profile)
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err(format!(
                "Chromium did not open its debugging port in time: {}",
                stderr_tail(profile)
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Start Chromium for one chat and wait until its debugging port answers.
fn spawn_browser(chat: &str) -> Result<u16, String> {
    let bin = find_chromium().ok_or_else(|| {
        "no Chromium available — install Google Chrome or run `npx playwright install chromium`"
            .to_string()
    })?;
    let port = pick_port()?;
    let profile = profile_dir(chat);

    // First attempt: the chat's persistent profile, so logins/cookies survive.
    let mut child = try_launch(&bin, port, &profile)?;
    if let Err(first) = wait_for_port(&mut child, port, &profile) {
        // A profile another (dead) Chromium still owns can block startup even
        // after the lock files are gone. Retry once on a throwaway profile so
        // the panel always gets a browser instead of a dead session.
        let _ = child.kill();
        let _ = child.wait();
        let fresh = std::env::temp_dir().join(format!(
            "codifa-browser-{}-{port}",
            std::process::id()
        ));
        let mut retry = try_launch(&bin, port, &fresh)?;
        wait_for_port(&mut retry, port, &fresh)
            .map_err(|second| format!("{first}; retry on a fresh profile: {second}"))?;
        child = retry;
    }

    let mut guard = SESSIONS.lock().map_err(|_| "browser lock poisoned")?;
    // A previous entry for this chat (e.g. a crashed process) is replaced.
    if let Some(idx) = guard.iter().position(|(k, _)| k == chat) {
        let (_, mut old) = guard.remove(idx);
        let _ = old.child.kill();
    }
    guard.push((
        chat.to_string(),
        BrowserProc {
            child,
            port,
            viewport: DEFAULT_VIEWPORT,
            last_used: std::time::Instant::now(),
        },
    ));
    Ok(port)
}

/// Kill one chat's Chromium and forget it.
fn kill_session(chat: &str) -> bool {
    let Ok(mut guard) = SESSIONS.lock() else {
        return false;
    };
    let Some(idx) = guard.iter().position(|(k, _)| k == chat) else {
        return false;
    };
    let (_, mut proc) = guard.remove(idx);
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    true
}

/// Kill every live Chromium session. Called on app shutdown so no orphaned
/// browser keeps holding memory after the window is gone.
pub fn kill_all_sessions() -> usize {
    let Ok(mut guard) = SESSIONS.lock() else {
        return 0;
    };
    let count = guard.len();
    for (_, mut proc) in guard.drain(..) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    count
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Current page URL, or "" when it cannot be read.
fn current_url(port: u16) -> String {
    let fut = async move {
        let res = cdp_call(
            port,
            "Runtime.evaluate",
            json!({"expression": "location.href", "returnByValue": true}),
        )
        .await?;
        Ok(res["result"]["value"].clone())
    };
    match block_on(fut) {
        Ok(v) => v.as_str().unwrap_or_default().to_string(),
        Err(_) => String::new(),
    }
}

/// The `status` payload the panel polls (same keys as the Python sidecar).
pub fn status(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({
            "ok": true,
            "active": false,
            "url": "",
            "viewport": {"width": DEFAULT_VIEWPORT.0, "height": DEFAULT_VIEWPORT.1},
            "available": find_chromium().is_some(),
            "chat": chat,
            "cdp": Value::Null,
        });
    };
    let url = current_url(port);
    let (w, h) = session_viewport(&chat);
    json!({
        "ok": true,
        "active": true,
        "url": url,
        "viewport": {"width": w, "height": h},
        "available": true,
        "chat": chat,
        "cdp": format!("http://127.0.0.1:{port}"),
    })
}

/// CDP endpoint of a chat's browser, starting it when needed. Used by the MCP
/// connector so Playwright attaches to the panel's Chromium.
pub fn cdp_endpoint(chat_id: &str) -> Option<String> {
    let chat = normalize_chat(chat_id);
    let port = match session_port(&chat) {
        Some(p) => p,
        None => spawn_browser(&chat).ok()?,
    };
    Some(format!("http://127.0.0.1:{port}"))
}

/// Navigate the page (idempotent: a running session is reused).
fn navigate(port: u16, url: &str) -> Result<(), String> {
    let url = url.to_string();
    let fut = async move {
        cdp_call(port, "Page.navigate", json!({"url": url})).await?;
        Ok(Value::Null)
    };
    block_on(fut).map(|_| ())
}

/// Navigate an already-running session (the panel's address bar). Unlike
/// `launch` this never starts a browser: a down session reports the same
/// "browser is not running" error the panel already handles.
pub fn navigate_to(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let target = url.trim();
    if target.is_empty() {
        return json!({"ok": false, "error": "empty url"});
    }
    match navigate(port, target) {
        Ok(()) => {
            // Give the navigation a moment to commit so the returned url is the
            // new page rather than the one being left.
            std::thread::sleep(Duration::from_millis(400));
            json!({"ok": true, "url": current_url(port)})
        }
        Err(e) => json!({"ok": false, "error": format!("navigation failed: {e}")}),
    }
}

/// Launch (or reuse) the chat's browser and optionally navigate it.
pub fn launch(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let target = url.trim();
    let port = match session_port(&chat) {
        Some(p) => p,
        None => match spawn_browser(&chat) {
            Ok(p) => p,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    // A fresh session starts on about:blank; only navigate when asked for a
    // real page (and not the one already showing).
    if !target.is_empty() && target != "about:blank" {
        let current = current_url(port);
        if current != target {
            if let Err(e) = navigate(port, target) {
                return json!({"ok": false, "error": format!("navigation failed: {e}")});
            }
        }
    }
    let _ = set_viewport(DEFAULT_VIEWPORT.0, DEFAULT_VIEWPORT.1, &chat);
    status(&chat)
}

/// One JPEG frame as a data URI (the panel renders it directly).
///
/// The device-metrics override is re-applied on THIS connection right before
/// the capture: `Emulation.setDeviceMetricsOverride` is scoped to the CDP
/// session, and every call here opens a fresh WebSocket, so an override set by
/// an earlier /browser/viewport call is already gone by the time we capture —
/// which is why the frame stayed at the launch size no matter what the ruler
/// said. Applying both in one connection makes the size stick.
pub fn screenshot(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = session_viewport(&chat);
    let chat_for_call = chat.clone();
    let fut = async move {
        let res = cdp_calls_sized(
            port,
            &chat_for_call,
            vec![(
                "Page.captureScreenshot",
                json!({"format": "jpeg", "quality": SCREENSHOT_QUALITY}),
            )],
        )
        .await?;
        Ok(res.into_iter().next().unwrap_or(Value::Null)["data"].clone())
    };
    match block_on(fut) {
        Ok(data) => match data.as_str() {
            Some(b64) if !b64.is_empty() => {
                json!({
                    "ok": true,
                    "image": format!("data:image/jpeg;base64,{b64}"),
                    "width": w,
                    "height": h,
                })
            }
            _ => json!({"ok": false, "error": "empty screenshot"}),
        },
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Dispatch one mouse event at viewport coordinates.
fn mouse_event(
    port: u16,
    chat: &str,
    kind: &'static str,
    x: i64,
    y: i64,
    extra: Value,
) -> Result<(), String> {
    let chat = chat.to_string();
    let fut = async move {
        let mut params = json!({"type": kind, "x": x, "y": y});
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                params[k] = v.clone();
            }
        }
        cdp_calls_sized(port, &chat, vec![("Input.dispatchMouseEvent", params)]).await?;
        Ok(Value::Null)
    };
    block_on(fut).map(|_| ())
}

/// Click at viewport coordinates.
pub fn click(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let press = mouse_event(
        port,
        &chat,
        "mousePressed",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    );
    if let Err(e) = press {
        return json!({"ok": false, "error": e});
    }
    match mouse_event(
        port,
        &chat,
        "mouseReleased",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 0}),
    ) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Move the virtual cursor (hover).
pub fn move_mouse(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    match mouse_event(port, &chat, "mouseMoved", x, y, json!({"buttons": 0})) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Type text into the focused element.
pub fn type_text(text: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let text = text.to_string();
    let chat_for_call = chat.clone();
    let fut = async move {
        cdp_calls_sized(
            port,
            &chat_for_call,
            vec![("Input.insertText", json!({"text": text}))],
        )
        .await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Named keys we can dispatch as real key events: (virtual key code, key, code).
fn key_spec(name: &str) -> Option<(i64, &'static str, &'static str)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => (13, "Enter", "Enter"),
        "tab" => (9, "Tab", "Tab"),
        "escape" | "esc" => (27, "Escape", "Escape"),
        "backspace" => (8, "Backspace", "Backspace"),
        "delete" => (46, "Delete", "Delete"),
        "up" | "arrowup" => (38, "ArrowUp", "ArrowUp"),
        "down" | "arrowdown" => (40, "ArrowDown", "ArrowDown"),
        "left" | "arrowleft" => (37, "ArrowLeft", "ArrowLeft"),
        "right" | "arrowright" => (39, "ArrowRight", "ArrowRight"),
        "home" => (36, "Home", "Home"),
        "end" => (35, "End", "End"),
        "pageup" => (33, "PageUp", "PageUp"),
        "pagedown" => (34, "PageDown", "PageDown"),
        "space" => (32, " ", "Space"),
        _ => return None,
    })
}

/// Press one key (a named key, or a single character typed literally).
pub fn press_key(key: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some((code, name, dom_code)) = key_spec(key) else {
        // Not a named key: type it as text (matches the Python fallback).
        return type_text(key, &chat);
    };
    let chat_for_call = chat.clone();
    let fut = async move {
        let base = json!({
            "windowsVirtualKeyCode": code,
            "nativeVirtualKeyCode": code,
            "key": name,
            "code": dom_code,
        });
        let mut down = base.clone();
        down["type"] = json!("keyDown");
        let mut up = base;
        up["type"] = json!("keyUp");
        cdp_calls_sized(
            port,
            &chat_for_call,
            vec![
                ("Input.dispatchKeyEvent", down),
                ("Input.dispatchKeyEvent", up),
            ],
        )
        .await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Scroll the page by a wheel delta.
pub fn scroll(dx: i64, dy: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let chat_for_call = chat.clone();
    let fut = async move {
        let (w, h) = session_viewport(&chat_for_call);
        cdp_calls_sized(
            port,
            &chat_for_call,
            vec![(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": w / 2,
                    "y": h / 2,
                    "deltaX": dx,
                    "deltaY": dy,
                }),
            )],
        )
        .await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Resize the emulated viewport. The size is REMEMBERED on the session so the
/// panel's ruler and fit-to-pane resizes survive the next status poll.
pub fn set_viewport(width: u32, height: u32, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    // Guard against a zero/absurd size from a mid-typing input.
    let w = width.clamp(200, 4096);
    let h = height.clamp(200, 4096);
    let fut = async move {
        cdp_call(
            port,
            "Emulation.setDeviceMetricsOverride",
            viewport_override(w, h),
        )
        .await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => {
            store_viewport(&chat, (w, h));
            json!({"ok": true, "width": w, "height": h})
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Back / forward / reload through the page's own history.
pub fn history(action: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let expr = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return json!({"ok": false, "error": format!("unknown history action: {other}")}),
    };
    let fut = async move {
        cdp_call(
            port,
            "Runtime.evaluate",
            json!({"expression": expr, "returnByValue": true}),
        )
        .await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Omnibox search: try Google, then Bing, then DuckDuckGo — the first engine
/// that actually loads wins, and its results URL is returned for the address bar.
pub fn search(query: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let q = percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let engines = [
        ("google.com", format!("https://www.google.com/search?q={q}")),
        ("bing.com", format!("https://www.bing.com/search?q={q}")),
        ("duckduckgo.com", format!("https://duckduckgo.com/?q={q}")),
    ];
    let mut last = String::new();
    for (host, url) in engines {
        if let Err(e) = navigate(port, &url) {
            last = e;
            continue;
        }
        // Give the engine a moment to commit the navigation before reading back.
        std::thread::sleep(Duration::from_millis(600));
        let href = current_url(port);
        if href.contains(host) {
            return json!({"ok": true, "url": href});
        }
        last = format!("{host} did not load");
    }
    json!({"ok": false, "error": format!("search failed: {last}")})
}

/// DevTools frontend URL for the page target (opened in the user's browser).
pub fn devtools_url(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(port) = session_port(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let ws = match page_ws_url(port) {
        Ok(w) => w,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    let ws_arg = ws
        .strip_prefix("ws://")
        .unwrap_or(&ws)
        .to_string();
    json!({
        "ok": true,
        "url": format!("http://127.0.0.1:{port}/devtools/inspector.html?ws={ws_arg}"),
    })
}

/// Close one chat's browser.
pub fn close(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let removed = kill_session(&chat);
    json!({"ok": true, "closed": removed})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_keys_normalize_to_the_legacy_default() {
        assert_eq!(normalize_chat(""), "default");
        assert_eq!(normalize_chat("   "), "default");
        assert_eq!(normalize_chat(" c1 "), "c1");
    }

    #[test]
    fn profile_dir_is_per_chat_and_path_safe() {
        let base = profile_dir("default");
        assert!(base.ends_with("browser-profile"), "{}", base.display());
        let chat = profile_dir("../../etc/passwd");
        assert!(chat.starts_with(&base), "{}", chat.display());
        // Traversal characters never survive into the directory name.
        assert!(!chat.to_string_lossy().contains(".."));
        assert!(!chat.to_string_lossy().contains('/'.to_string().as_str()) || chat.starts_with(&base));
    }

    #[test]
    fn named_keys_map_and_unknown_keys_fall_back_to_text() {
        assert_eq!(key_spec("Enter").unwrap().0, 13);
        assert_eq!(key_spec("escape").unwrap().1, "Escape");
        assert_eq!(key_spec("ArrowDown").unwrap().0, 40);
        assert!(key_spec("a").is_none());
        assert!(key_spec("F5").is_none());
    }

    #[test]
    fn status_reports_inactive_without_a_session() {
        let st = status("no-such-chat-xyz");
        assert_eq!(st["ok"], true);
        assert_eq!(st["active"], false);
        assert_eq!(st["chat"], "no-such-chat-xyz");
        assert!(st["cdp"].is_null());
    }

    #[test]
    fn operations_report_a_down_session_instead_of_panicking() {
        for v in [
            screenshot("no-such-chat-xyz"),
            click(1, 2, "no-such-chat-xyz"),
            move_mouse(1, 2, "no-such-chat-xyz"),
            type_text("hi", "no-such-chat-xyz"),
            press_key("Enter", "no-such-chat-xyz"),
            scroll(0, 100, "no-such-chat-xyz"),
            set_viewport(800, 600, "no-such-chat-xyz"),
            history("back", "no-such-chat-xyz"),
            search("x", "no-such-chat-xyz"),
            devtools_url("no-such-chat-xyz"),
            navigate_to("https://example.com", "no-such-chat-xyz"),
        ] {
            assert_eq!(v["ok"], false, "{v}");
            assert_eq!(v["error"], "browser is not running", "{v}");
        }
    }

    #[test]
    fn viewport_is_remembered_per_session() {
        // The panel's ruler / fit-to-pane resize must survive the next poll:
        // status and screenshot report the STORED size, not the default.
        assert_eq!(session_viewport("no-such-chat-xyz"), DEFAULT_VIEWPORT);
        store_viewport("no-such-chat-xyz", (900, 600));
        // No session exists, so nothing is stored and the default stands.
        assert_eq!(session_viewport("no-such-chat-xyz"), DEFAULT_VIEWPORT);
    }

    #[test]
    fn viewport_override_rides_in_the_same_batch_as_the_command() {
        // The override is session-scoped and every call opens a fresh
        // WebSocket, so it MUST travel with the command it applies to —
        // otherwise the frame and the input coordinates stay at the launch
        // size and the panel never fits the pane (the responsive bug).
        let batch = with_viewport_override(
            420,
            800,
            vec![("Page.captureScreenshot", json!({"format": "jpeg"}))],
        );
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].0, "Emulation.setDeviceMetricsOverride");
        assert_eq!(batch[0].1["width"], 420);
        assert_eq!(batch[0].1["height"], 800);
        assert_eq!(batch[0].1["mobile"], false);
        assert_eq!(batch[1].0, "Page.captureScreenshot");
    }

    #[test]
    fn idle_sessions_are_reaped_but_fresh_ones_are_kept() {
        // A Chromium is ~150-300 MB and one is spawned per chat, so a closed
        // panel's session must be released instead of piling up until exit.
        let ttl = Duration::from_secs(600);
        assert!(!should_reap(Duration::from_secs(0), ttl));
        assert!(!should_reap(Duration::from_secs(599), ttl));
        assert!(should_reap(Duration::from_secs(600), ttl));
        assert!(should_reap(Duration::from_secs(3600), ttl));
    }

    #[test]
    fn navigate_rejects_an_empty_url_before_touching_the_browser() {
        // An empty address-bar submit must not start a browser.
        let v = navigate_to("   ", "no-such-chat-xyz");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "browser is not running");
    }
}
