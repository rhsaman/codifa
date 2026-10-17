//! Native in-app browser session (migrated from the Python sidecar's
//! `browser_session.py`).
//!
//! ONE shared headless Chromium serves the whole app, driven over the Chrome
//! DevTools Protocol. Each chat gets its own TAB plus its own CDP session
//! (`Target.attachToTarget` + `sessionId`), so isolation comes from tabs rather
//! than from processes: N open chats cost one Chromium instead of N, while
//! cookies/logins stay shared. The right-side Browser panel polls
//! `/browser/screenshot` for JPEG frames and posts its clicks/keys back through
//! `/browser/*`, while the agent's Playwright MCP connector attaches to the SAME
//! browser via `--cdp-endpoint` — so both sides drive one page and nothing ever
//! opens outside the app.
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

/// Viewport a fresh tab starts with (mirrors browser_session.DEFAULT_VIEWPORT).
const DEFAULT_VIEWPORT: (u32, u32) = (1280, 800);
/// JPEG quality for the panel's frames (mirrors the Python `quality=60`).
const SCREENSHOT_QUALITY: u32 = 60;
/// How long to wait for Chromium's debugging port to answer.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-CDP-command timeout.
const CDP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the whole browser may sit unused before it is reaped. The panel
/// polls every ~1.2s while open, so only "no panel anywhere" goes idle.
const IDLE_REAP: Duration = Duration::from_secs(600);

/// The one shared Chromium the whole app drives.
///
/// A single browser (with a single `--user-data-dir` profile) serves every
/// chat: cookies and logins stay shared, and N open chats cost one Chromium
/// instead of N. Per-chat isolation comes from tabs, not from processes.
struct BrowserProc {
    child: Child,
    port: u16,
    /// Last time ANY tab touched the browser, for idle reaping of the process.
    last_used: Instant,
}

/// One tab inside the shared browser, keyed by normalized chat id. Each chat
/// drives its own tab through its own CDP session, so chats never interact.
#[derive(Clone)]
struct Tab {
    target_id: String,
    /// Emulated viewport, persisted per tab so the panel's ruler and
    /// fit-to-pane resizes STICK: every `/browser/status` and screenshot
    /// reports this size, and a poll can never reset the user's choice.
    viewport: (u32, u32),
}

/// The shared browser process. `Option` (not a lazy cell) so the static stays
/// `const`-constructible.
static BROWSER: Mutex<Option<BrowserProc>> = Mutex::new(None);

/// Tabs keyed by normalized chat id. `Vec` (not `HashMap`) so the static stays
/// `const`-constructible without a lazy initializer.
static TABS: Mutex<Vec<(String, Tab)>> = Mutex::new(Vec::new());

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

/// The single shared persistent profile, so cookies/logins survive a restart
/// and every chat sees the same signed-in state (one browser, one profile).
fn profile_dir() -> PathBuf {
    data_root().join("browser-profile")
}

/// Resolve an executable on PATH (a GUI-launched app has a minimal PATH, so
/// the login-shell PATH is merged in first — same helper the sidecar uses).
fn which(name: &str) -> Option<PathBuf> {
    let path = crate::shell_env::shell_path();
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

/// WebSocket URL of the BROWSER-level endpoint (`/json/version`). All work then
/// happens through `Target.attachToTarget{flatten:true}` + `sessionId`, which is
/// what lets one WebSocket drive many tabs — one per chat — side by side.
fn browser_ws_url(port: u16) -> Result<String, String> {
    let info = http_get_json(port, "/json/version")?;
    info["webSocketDebuggerUrl"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no browser websocket endpoint".to_string())
}

/// Open a new tab and return its target id.
async fn create_target(cdp: &mut Cdp, url: &str) -> Result<String, String> {
    let res = cdp.send("Target.createTarget", json!({"url": url})).await?;
    res["targetId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Target.createTarget returned no targetId".to_string())
}

/// Close a tab, ignoring "already gone" (Chrome drops a target when its last
/// session detaches, so a second close is a no-op rather than an error).
async fn close_target(cdp: &mut Cdp, target_id: &str) -> Result<(), String> {
    match cdp
        .send("Target.closeTarget", json!({"targetId": target_id}))
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.contains("No target") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Browser-level CDP connection: one WebSocket, one `sessionId` per tab.
struct Cdp {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
    /// Session id of the tab this connection is currently driving.
    session: Option<String>,
}

impl Cdp {
    async fn connect(port: u16) -> Result<Self, String> {
        let ws_url = browser_ws_url(port)?;
        let (ws, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect failed: {e}"))?;
        Ok(Self {
            ws,
            next_id: 1,
            session: None,
        })
    }

    /// Send one command and wait for its matching reply. Commands carry the
    /// current `sessionId` (flatten mode), so replies come back on the same
    /// socket tagged with the same id.
    async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(session) = &self.session {
            msg["sessionId"] = json!(session);
        }
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

    /// Attach to one tab and make it the session every later command targets.
    async fn attach(&mut self, target_id: &str) -> Result<(), String> {
        let res = self
            .send(
                "Target.attachToTarget",
                json!({"targetId": target_id, "flatten": true}),
            )
            .await?;
        let session = res["sessionId"]
            .as_str()
            .ok_or_else(|| "attachToTarget returned no sessionId".to_string())?;
        self.session = Some(session.to_string());
        Ok(())
    }
}

/// Run a sequence of CDP commands against `tab` over ONE connection.
async fn cdp_calls(tab: &Tab, calls: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    cdp_calls_on(tab, calls, true).await
}

/// `attach` controls the viewport override: the tab's emulated size is
/// re-applied first for screenshots and input, but not for navigation (which
/// must not drag the emulated size into the next page's first paint).
async fn cdp_calls_on(
    tab: &Tab,
    calls: Vec<(&'static str, Value)>,
    with_viewport: bool,
) -> Result<Vec<Value>, String> {
    let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
    let mut cdp = Cdp::connect(port).await?;
    cdp.attach(&tab.target_id).await?;
    let mut calls = calls;
    if with_viewport {
        calls = with_viewport_override(tab.viewport.0, tab.viewport.1, calls);
    }
    let mut out = Vec::with_capacity(calls.len());
    for (method, params) in calls {
        out.push(cdp.send(method, params).await?);
    }
    if with_viewport && !out.is_empty() {
        out.remove(0); // the override's own reply
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

/// Prepend the tab's viewport override to a batch of CDP calls.
///
/// `Emulation.setDeviceMetricsOverride` is scoped to the CDP SESSION, and every
/// call here opens a fresh WebSocket — so an override set by an earlier
/// /browser/viewport request would be gone by the time the next command runs.
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

/// Drive an async CDP operation from a sync caller (the router handlers and the
/// MCP connector are both sync). A fresh thread owns the runtime, so this is
/// safe from inside the axum runtime too.
fn block_on<F, T>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
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
// Browser + tab registry
// ---------------------------------------------------------------------------

/// Whether an idle browser should be reaped. Pure so the policy is unit-tested
/// without spawning a real Chromium.
fn should_reap(elapsed: Duration, ttl: Duration) -> bool {
    elapsed >= ttl
}

/// Port of the live shared browser, or None when it is down. Reaps a browser
/// nobody has touched for `IDLE_REAP` (the process, not the profile) and forgets
/// its tabs, since a dead browser can serve none of them.
fn alive_port() -> Option<u16> {
    let mut guard = BROWSER.lock().ok()?;
    let reap = guard
        .as_ref()
        .map(|b| should_reap(b.last_used.elapsed(), IDLE_REAP))
        .unwrap_or(false);
    if reap {
        if let Some(mut b) = guard.take() {
            let _ = b.child.kill();
            let _ = b.child.wait();
            forget_all_tabs();
        }
    }
    match guard.as_mut() {
        Some(b) => {
            // A crashed process must never look active.
            if b.child.try_wait().ok().flatten().is_some() {
                let mut dead = guard.take().expect("browser entry just checked");
                let _ = dead.child.kill();
                forget_all_tabs();
                return None;
            }
            b.last_used = Instant::now();
            Some(b.port)
        }
        None => None,
    }
}

/// Drop every tab entry (called when the shared browser dies).
fn forget_all_tabs() {
    if let Ok(mut tabs) = TABS.lock() {
        tabs.clear();
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

/// Start the shared Chromium against `profile`. stderr is captured to a file so
/// a startup failure can be REPORTED instead of surfacing as a bare timeout.
fn try_launch(bin: &std::path::Path, port: u16, profile: &std::path::Path) -> Result<Child, String> {
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
fn wait_for_port(child: &mut Child, port: u16, profile: &std::path::Path) -> Result<(), String> {
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

/// Start the shared Chromium (once) and wait until its debugging port answers.
fn spawn_browser() -> Result<u16, String> {
    let bin = find_chromium().ok_or_else(|| {
        "no Chromium available — install Google Chrome or run `npx playwright install chromium`"
            .to_string()
    })?;
    let port = pick_port()?;
    let profile = profile_dir();

    // First attempt: the shared persistent profile, so logins/cookies survive.
    let mut child = try_launch(&bin, port, &profile)?;
    if let Err(first) = wait_for_port(&mut child, port, &profile) {
        // A profile another (dead) Chromium still owns can block startup even
        // after the lock files are gone. Retry once on a throwaway profile so
        // the panel always gets a browser instead of a dead session.
        let _ = child.kill();
        let _ = child.wait();
        let fresh = std::env::temp_dir().join(format!("codifa-browser-{}", std::process::id()));
        let mut retry = try_launch(&bin, port, &fresh)?;
        wait_for_port(&mut retry, port, &fresh)
            .map_err(|second| format!("{first}; retry on a fresh profile: {second}"))?;
        child = retry;
    }

    let mut guard = BROWSER.lock().map_err(|_| "browser lock poisoned")?;
    // A previous process (e.g. a crashed one) is replaced.
    if let Some(mut old) = guard.take() {
        let _ = old.child.kill();
        let _ = old.child.wait();
    }
    *guard = Some(BrowserProc {
        child,
        port,
        last_used: Instant::now(),
    });
    Ok(port)
}

/// Port of the shared browser, starting it (and nothing else) when needed.
fn ensure_browser() -> Result<u16, String> {
    match alive_port() {
        Some(p) => Ok(p),
        None => spawn_browser(),
    }
}

/// The chat's tab, opening it on `about:blank` when the chat has none yet.
/// A tab whose target vanished (surfaced as a `No target` CDP error) is
/// replaced rather than returned, so a stale entry never wedges a chat.
async fn ensure_tab_async(chat: &str) -> Result<Tab, String> {
    let existing = TABS
        .lock()
        .ok()
        .and_then(|tabs| tabs.iter().find(|(k, _)| k == chat).map(|(_, t)| t.clone()));
    if let Some(tab) = existing {
        if tab_usable(tab.target_id.as_str()).await {
            return Ok(tab);
        }
        TABS.lock()
            .ok()
            .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    }
    let port = ensure_browser()?;
    let mut cdp = Cdp::connect(port).await?;
    let target_id = create_target(&mut cdp, "about:blank").await?;
    let tab = Tab {
        target_id,
        viewport: DEFAULT_VIEWPORT,
    };
    if let Ok(mut tabs) = TABS.lock() {
        tabs.retain(|(k, _)| k != chat);
        tabs.push((chat.to_string(), tab.clone()));
    }
    Ok(tab)
}

/// True when a target still exists in the browser.
async fn tab_usable(target_id: &str) -> bool {
    let Some(port) = alive_port() else {
        return false;
    };
    let Ok(mut cdp) = Cdp::connect(port).await else {
        return false;
    };
    match cdp
        .send("Target.getTargetInfo", json!({"targetId": target_id}))
        .await
    {
        Ok(res) => res["targetInfo"]["targetId"].as_str() == Some(target_id),
        Err(_) => false,
    }
}

/// Synchronous wrapper around `ensure_tab_async`.
fn ensure_tab(chat: &str) -> Result<Tab, String> {
    let chat = chat.to_string();
    block_on(async move { ensure_tab_async(&chat).await })
}

/// The chat's registered tab without creating one.
fn existing_tab(chat: &str) -> Option<Tab> {
    TABS
        .lock()
        .ok()?
        .iter()
        .find(|(k, _)| k == chat)
        .map(|(_, t)| t.clone())
}

/// Remember a tab's viewport so later polls report the same size.
fn store_viewport(chat: &str, size: (u32, u32)) {
    if let Ok(mut tabs) = TABS.lock() {
        if let Some((_, tab)) = tabs.iter_mut().find(|(k, _)| k == chat) {
            tab.viewport = size;
        }
    }
}

/// Close one chat's tab. The shared browser stays up: other chats may be using
/// it, and a fresh panel reuses the warm process (and its profile).
fn close_tab(chat: &str) -> bool {
    let Some(tab) = existing_tab(chat) else {
        return false;
    };
    TABS.lock()
        .ok()
        .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    let _ = block_on(async move {
        let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
        let mut cdp = Cdp::connect(port).await?;
        close_target(&mut cdp, &tab.target_id).await?;
        Ok(Value::Null)
    });
    true
}

/// Kill the shared browser (and with it every tab). Called on app shutdown so
/// no orphaned browser keeps holding memory after the window is gone.
pub fn kill_all_sessions() -> usize {
    let tabs = TABS.lock().ok().map(|t| t.len()).unwrap_or(0);
    let mut guard = match BROWSER.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    match guard.take() {
        Some(mut proc) => {
            let _ = proc.child.kill();
            let _ = proc.child.wait();
            tabs.max(1)
        }
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Current page URL of a tab, or "" when it cannot be read.
fn current_url(tab: &Tab) -> String {
    let tab = tab.clone();
    let fut = async move {
        let res = cdp_calls(
            &tab,
            vec![(
                "Runtime.evaluate",
                json!({"expression": "location.href", "returnByValue": true}),
            )],
        )
        .await?;
        Ok(res.into_iter().next().unwrap_or(Value::Null)["result"]["value"].clone())
    };
    match block_on(fut) {
        Ok(v) => v.as_str().unwrap_or_default().to_string(),
        Err(_) => String::new(),
    }
}

/// The `status` payload the panel polls (same keys as the Python sidecar).
pub fn status(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
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
    let url = current_url(&tab);
    json!({
        "ok": true,
        "active": true,
        "url": url,
        "viewport": {"width": tab.viewport.0, "height": tab.viewport.1},
        "available": true,
        "chat": chat,
        "cdp": alive_port().map(|p| format!("http://127.0.0.1:{p}")),
    })
}

/// CDP endpoint of the shared browser, starting it when needed. Used by the MCP
/// connector so Playwright attaches to the panel's Chromium. The endpoint is
/// browser-level, so Playwright MCP drives the same tabs the panel does.
pub fn cdp_endpoint(chat_id: &str) -> Option<String> {
    let chat = normalize_chat(chat_id);
    // The MCP connector needs the chat's tab to exist so the agent and the
    // panel stay on one page; `ensure_tab` starts the browser when needed.
    ensure_tab(&chat).ok()?;
    let port = alive_port()?;
    Some(format!("http://127.0.0.1:{port}"))
}

/// Navigate a tab (idempotent: an existing tab is reused).
async fn navigate(tab: &Tab, url: &str) -> Result<(), String> {
    let tab = tab.clone();
    let url = url.to_string();
    let fut = async move {
        cdp_calls_on(&tab, vec![("Page.navigate", json!({"url": url}))], false).await?;
        Ok(Value::Null)
    };
    block_on(fut).map(|_| ())
}

/// Navigate an already-open chat tab (the panel's address bar). Unlike `launch`
/// this never starts a browser: a down session reports the same
/// "browser is not running" error the panel already handles.
pub fn navigate_to(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let target = url.trim();
    if target.is_empty() {
        return json!({"ok": false, "error": "empty url"});
    }
    let tab_for_call = tab.clone();
    let target_owned = target.to_string();
    let fut = async move {
        navigate(&tab_for_call, &target_owned).await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => {
            // Give the navigation a moment to commit so the returned url is the
            // new page rather than the one being left.
            std::thread::sleep(Duration::from_millis(400));
            json!({"ok": true, "url": current_url(&tab)})
        }
        Err(e) => json!({"ok": false, "error": format!("navigation failed: {e}")}),
    }
}

/// Launch (or reuse) the chat's tab and optionally navigate it.
pub fn launch(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let target = url.trim();
    let tab = match existing_tab(&chat) {
        Some(t) => t,
        None => match ensure_tab(&chat) {
            Ok(t) => t,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    // A fresh tab starts on about:blank; only navigate when asked for a real
    // page (and not the one already showing).
    if !target.is_empty() && target != "about:blank" {
        let current = current_url(&tab);
        if current != target {
            let tab_for_call = tab.clone();
            let target_owned = target.to_string();
            let fut = async move {
                navigate(&tab_for_call, &target_owned).await?;
                Ok(Value::Null)
            };
            if let Err(e) = block_on(fut) {
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
/// an earlier /browser/viewport call would be gone by the time we capture.
pub fn screenshot(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    let tab_for_call = tab.clone();
    let fut = async move {
        let res = cdp_calls(
            &tab_for_call,
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
            Some(b64) if !b64.is_empty() => json!({
                "ok": true,
                "image": format!("data:image/jpeg;base64,{b64}"),
                "width": w,
                "height": h,
            }),
            _ => json!({"ok": false, "error": "empty screenshot"}),
        },
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Dispatch one mouse event at viewport coordinates.
fn mouse_event(tab: &Tab, kind: &'static str, x: i64, y: i64, extra: Value) -> Result<(), String> {
    let tab = tab.clone();
    let fut = async move {
        let mut params = json!({"type": kind, "x": x, "y": y});
        if let (Some(dst), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                dst.insert(k.clone(), v.clone());
            }
        }
        cdp_calls(&tab, vec![("Input.dispatchMouseEvent", params)]).await?;
        Ok(Value::Null)
    };
    block_on(fut).map(|_| ())
}

/// Click at viewport coordinates.
pub fn click(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let press = mouse_event(
        &tab,
        "mousePressed",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    );
    if let Err(e) = press {
        return json!({"ok": false, "error": e});
    }
    match mouse_event(
        &tab,
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
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    match mouse_event(&tab, "mouseMoved", x, y, json!({"buttons": 0})) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Type text into the focused element.
pub fn type_text(text: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let tab_for_call = tab.clone();
    let text = text.to_string();
    let fut = async move {
        cdp_calls(
            &tab_for_call,
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
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some((code, name, dom_code)) = key_spec(key) else {
        // Not a named key: type it as text (matches the Python fallback).
        return type_text(key, &chat);
    };
    let tab_for_call = tab.clone();
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
        cdp_calls(
            &tab_for_call,
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
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    let tab_for_call = tab.clone();
    let fut = async move {
        cdp_calls(
            &tab_for_call,
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

/// Resize the emulated viewport. The size is REMEMBERED on the tab so the
/// panel's ruler and fit-to-pane resizes survive the next status poll.
pub fn set_viewport(width: u32, height: u32, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    // Guard against a zero/absurd size from a mid-typing input.
    let w = width.clamp(200, 4096);
    let h = height.clamp(200, 4096);
    let tab_for_call = tab.clone();
    let fut = async move {
        cdp_calls_on(
            &tab_for_call,
            vec![("Emulation.setDeviceMetricsOverride", viewport_override(w, h))],
            false,
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
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let expr = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return json!({"ok": false, "error": format!("unknown history action: {other}")}),
    };
    let tab_for_call = tab.clone();
    let fut = async move {
        cdp_calls(
            &tab_for_call,
            vec![(
                "Runtime.evaluate",
                json!({"expression": expr, "returnByValue": true}),
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

/// Omnibox search: try Google, then Bing, then DuckDuckGo — the first engine
/// that actually loads wins, and its results URL is returned for the address bar.
pub fn search(query: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
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
        let tab_for_call = tab.clone();
        let url_for_call = url.clone();
        let fut = async move {
            navigate(&tab_for_call, &url_for_call).await?;
            Ok(Value::Null)
        };
        if let Err(e) = block_on(fut) {
            last = e;
            continue;
        }
        // Give the engine a moment to commit the navigation before reading back.
        std::thread::sleep(Duration::from_millis(600));
        let href = current_url(&tab);
        if href.contains(host) {
            return json!({"ok": true, "url": href});
        }
        last = format!("{host} did not load");
    }
    json!({"ok": false, "error": format!("search failed: {last}")})
}

/// DevTools frontend URL opened in the user's browser. DevTools drives a TAB, so
/// the frontend points at the tab's own websocket target (`/json/list` is
/// browser-wide and each page target still carries its own debugger url), never
/// at the browser-level endpoint — the latter is not inspectable.
pub fn devtools_url(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = existing_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some(port) = alive_port() else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let ws = match http_get_json(port, "/json/list")
        .ok()
        .and_then(|list| {
            list.as_array()?.iter().find_map(|t| {
                (t["id"].as_str() == Some(tab.target_id.as_str()))
                    .then(|| t["webSocketDebuggerUrl"].as_str().map(str::to_string))
                    .flatten()
            })
        }) {
        Some(ws) => ws,
        None => return json!({"ok": false, "error": "no tab websocket endpoint"}),
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

/// Close one chat's tab (the shared browser keeps running for the other chats).
pub fn close(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let removed = close_tab(&chat);
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
    fn profile_dir_is_shared_and_stable() {
        // One browser, one profile: every chat must resolve to the SAME dir so
        // cookies/logins stay shared (the per-chat dirs were the memory hog).
        let base = profile_dir();
        assert!(base.ends_with("browser-profile"), "{}", base.display());
        assert_eq!(base, profile_dir());
        assert!(!base.to_string_lossy().contains("default/"));
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
        // Closing a tab that does not exist is a no-op, not an error.
        assert_eq!(close("no-such-chat-xyz")["closed"], false);
    }

    #[test]
    fn viewport_is_remembered_per_tab() {
        let chat = "browser-test-viewport";
        // No tab yet: there is nothing to attach a size to.
        store_viewport(chat, (900, 600));
        assert!(existing_tab(chat).is_none());

        // With a tab present the size sticks, so the panel's ruler and
        // fit-to-pane resize survive the next status poll and screenshot.
        TABS.lock().unwrap().push((
            chat.to_string(),
            Tab {
                target_id: "T-viewport".to_string(),
                viewport: DEFAULT_VIEWPORT,
            },
        ));
        store_viewport(chat, (900, 600));
        assert_eq!(existing_tab(chat).unwrap().viewport, (900, 600));
        assert!(close_tab(chat));
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
    fn idle_browser_is_reaped_but_a_fresh_one_is_kept() {
        // One Chromium (~150-300 MB) is shared, so it is only released when no
        // panel anywhere has polled it for a while.
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

    /// Live check that TWO chats share ONE Chromium yet drive two separate
    /// tabs (the whole point of the shared-browser refactor).
    ///
    /// Ignored by default: it starts a real Chromium, which is far too slow and
    /// too environment-dependent for the normal unit suite. Run it on demand:
    /// `cargo test --ignored shared_browser_serves_isolated_tabs`.
    #[test]
    #[ignore]
    fn shared_browser_serves_isolated_tabs() {
        let (a, b) = ("live-tab-a", "live-tab-b");
        let tab_a = ensure_tab(a).expect("first tab");
        let tab_b = ensure_tab(b).expect("second tab");
        assert_ne!(tab_a.target_id, tab_b.target_id, "chats must not share a tab");
        assert!(tab_usable_sync(&tab_a.target_id), "first tab must be live");
        assert!(tab_usable_sync(&tab_b.target_id), "second tab must be live");
        // One process, two tabs.
        assert_eq!(BROWSER.lock().unwrap().as_ref().map(|_| 1), Some(1));
        assert_eq!(TABS.lock().unwrap().len(), 2);
        assert!(close_tab(a));
        assert!(close_tab(b));
        let killed = kill_all_sessions();
        assert!(killed >= 1, "the shared browser must be reaped");
    }

    /// `tab_usable` is async; the live test is sync like every public entry.
    fn tab_usable_sync(target_id: &str) -> bool {
        let target = target_id.to_string();
        block_on(async move { Ok::<Value, String>(json!(tab_usable(&target).await)) })
            .map(|v| v.as_bool().unwrap_or(false))
            .unwrap_or(false)
    }

    #[test]
    fn tabs_are_isolated_by_chat_key() {
        for (chat, target) in [("chat-a", "T1"), ("chat-b", "T2")] {
            let mut tabs = TABS.lock().unwrap();
            tabs.retain(|(k, _)| k != chat);
            tabs.push((
                chat.to_string(),
                Tab {
                    target_id: target.to_string(),
                    viewport: DEFAULT_VIEWPORT,
                },
            ));
        }
        assert_eq!(
            existing_tab("chat-a").map(|t| t.target_id),
            Some("T1".to_string())
        );
        assert_eq!(
            existing_tab("chat-b").map(|t| t.target_id),
            Some("T2".to_string())
        );
        // The tab's viewport is remembered per tab, not globally.
        store_viewport("chat-a", (640, 480));
        assert_eq!(existing_tab("chat-a").unwrap().viewport, (640, 480));
        assert_eq!(existing_tab("chat-b").unwrap().viewport, DEFAULT_VIEWPORT);
        // Closing one chat releases only its own tab.
        assert!(close_tab("chat-a"));
        assert!(existing_tab("chat-a").is_none());
        assert!(existing_tab("chat-b").is_some());
        assert!(close_tab("chat-b"));
    }
}
