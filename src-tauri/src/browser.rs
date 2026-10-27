//! Native in-app browser session (migrated from the Python sidecar's
//! `browser_session.py`).
//!
//! ONE shared headless Chromium serves the whole app, driven over the Chrome
//! DevTools Protocol. Each chat gets its own TAB plus its own CDP session
//! (`Target.attachToTarget` + `sessionId`), so isolation comes from tabs rather
//! than from processes: N open chats cost one Chromium instead of N, while
//! cookies/logins stay shared. The right-side Browser panel polls
//! `/browser/screenshot` for JPEG frames and posts its clicks/keys back through
//! `/browser/*`. The agent drives the SAME tab through `browser_driver`, a
//! long-lived CDP session on the same browser — so both sides drive one page and
//! nothing ever opens outside the app.
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

/// How long a single TAB may sit untouched before its renderer is closed.
///
/// The browser-wide TTL above cannot bound per-chat cost: an open panel for ANY
/// chat refreshes `BrowserProc::last_used` on every poll (~1.2s), so one polled
/// tab kept every OTHER chat's renderer alive for the whole session. Measured:
/// three abandoned tabs still held ~492 MB of Chromium 45 minutes into a run.
/// Five minutes is safe because a tab that is really in use is polled far more
/// often than that; "no touch for five minutes" means nobody is looking.
const TAB_IDLE_TTL: Duration = Duration::from_secs(300);

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
    /// When this tab was last looked at. Drives per-tab reaping (see
    /// `TAB_IDLE_TTL`): a chat whose panel was closed, or that the agent stopped
    /// driving, used to keep its whole renderer process until app exit.
    last_used: Instant,
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

/// The directories the app may keep its OWN automation browser in, newest
/// scheme first. The app data dir is preferred because it is where the
/// one-click install (see `install`) unpacks into, and it always has a usable
/// binary shape; the Playwright cache is honoured second so an existing
/// `npx playwright install chromium` keeps working.
fn browser_roots() -> Vec<PathBuf> {
    let mut out = vec![data_root().join("browser")];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Library/Caches/ms-playwright"));
    }
    out
}

/// Layouts a Chromium build may use under a root: [dir-fragment, binary].
///
/// Chrome-for-Testing names its macOS binary `Google Chrome for Testing` inside
/// `Google Chrome for Testing.app`; a Playwright Chromium uses `Chromium`; the
/// headless shell ships a loose `chrome-headless-shell`. Every fragment is
/// tried under each matching build dir, so one list covers all of them.
const BROWSER_LAYOUTS: &[(&str, &str)] = &[
    ("chrome-mac-arm64", "Google Chrome for Testing"),
    ("chrome-mac-x64", "Google Chrome for Testing"),
    ("chrome-mac", "Chromium"),
    ("chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    ("chrome-headless-shell-mac-x64", "chrome-headless-shell"),
];

/// Directories that look like an installed Chromium under `root`, best first.
///
/// Sorted by the build number embedded in the name (`chromium-1223`,
/// `chrome-headless-shell-140.0.7339.82`) rather than lexicographically, so
/// "newest first" survives the three-digit → four-digit rollover that made the
/// old `sort().reverse()` pick an older build.
fn candidate_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with("chromium")
                            || n.starts_with("chrome-headless-shell")
                            || n.starts_with("chrome-for-testing")
                    })
                    .unwrap_or(false)
        })
        .collect();
    dirs.sort_by(|a, b| build_rank(a).cmp(&build_rank(b)));
    dirs.reverse();
    dirs
}

/// The FIRST numeric component of a build directory name, for newest-first
/// ordering (`chrome-headless-shell-140.0.7339.82` → 140, `chromium-1223` →
/// 1223). The leading number is the build's own revision/major, which is the
/// only component that orders builds; the trailing ones are build metadata (the
/// patch component of two different majors says nothing). Names without a
/// number rank lowest so they never win.
fn build_rank(dir: &std::path::Path) -> u64 {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .split(['-', '.'])
        .find_map(|part| part.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Every bundled-Chromium binary the app may use, newest build first.
///
/// Deliberately EXCLUDES the system browsers. Running the automation browser
/// out of `/Applications/Google Chrome.app` gave the headless instance the same
/// bundle id (`com.google.Chrome`) as the user's real Chrome: it registered
/// with LaunchServices, spawned Chrome's own crashpad handler and GoogleUpdater
/// against the user's profile, and fought the real Chrome over the display
/// (`CVDisplayLinkCreateWithCGDisplay failed` on repeat). The user's everyday
/// browser froze while the app was open. So: either the app has its own
/// Chromium build (bundled here, or installed by the one-click flow), or the
/// browser feature reports itself as unavailable — it never hijacks the user's
/// browser. Installing Chromium is a deliberate, one-click action instead.
fn chromium_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in browser_roots() {
        for dir in candidate_dirs(&root) {
            // Every layout is probed under every build dir; `find_chromium`
            // picks the first that is really a file, so a layout that does not
            // apply to this build costs one failed `is_file()`.
            for (fragment, binary) in BROWSER_LAYOUTS {
                out.push(
                    dir.join(fragment)
                        .join(format!("{binary}.app/Contents/MacOS/{binary}")),
                );
                out.push(dir.join(fragment).join(binary));
            }
            // A flat unpack (the installer's own layout): <dir>/<binary>.
            for (_, binary) in BROWSER_LAYOUTS {
                out.push(dir.join(binary));
            }
        }
    }
    out
}

/// First bundled Chromium that actually exists on disk.
fn find_chromium() -> Option<PathBuf> {
    chromium_candidates().into_iter().find(|p| p.is_file())
}

/// True when no usable automation browser is installed. Kept as its own
/// function so the sidecar can offer the one-click install instead of failing
/// with an error the user cannot act on.
pub fn is_available() -> bool {
    find_chromium().is_some()
}

/// Does this command line belong to the browser THIS app launched?
///
/// Used by the startup orphan sweep, which must never touch a browser the user
/// started themselves: our own profile directory is the marker, because nobody
/// else points a browser at `~/.codifa/browser-profile`.
///
/// The helper processes Chromium forks for itself (`--type=renderer`, `=gpu`,
/// `=utility`, …) carry the SAME profile flag, so they match here too — and they
/// must. The main process spawns them in its own process group, but a browser
/// killed with SIGKILL (the app crashed, or the reaper took it down) never gets
/// to clean them up, and an ORPHANED renderer keeps its whole heap alive. The
/// old trailing `!args.contains("--type=")` excluded exactly the processes that
/// leaked, which is how an abandoned browser left its renderer tree behind.
fn is_our_driver(args: &str, profile: &std::path::Path) -> bool {
    args.contains(profile.to_string_lossy().as_ref())
}

/// Launch flags for `bin` on `port` against `profile`.
///
/// Split out from the spawn so the flag set is unit-testable: the flags carry
/// real decisions (see the comments), and a wrong one either loses the frame
/// or drags the user's own Chrome settings into the automation session.
fn launch_args(bin: &std::path::Path, port: u16, profile: &std::path::Path) -> Vec<String> {
    let mut args = vec![
        format!("--remote-debugging-port={port}"),
        format!(
            "--remote-allow-origins=http://127.0.0.1:{port},https://chrome-devtools-frontend.appspot.com"
        ),
        // The frames are captured over CDP, so the window is never shown. Plain
        // `--headless` IS the new headless mode on Chrome 112+; the
        // `--headless=new` spelling was dropped in later releases and made
        // Chromium exit before opening the debugging port.
        "--headless".to_string(),
        // A dedicated profile keeps this browser completely separate from the
        // user's own Chrome (cookies, extensions, crashpad database).
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-blink-features=AutomationControlled".to_string(),
        "--window-size=1280,800".to_string(),
    ];
    // `--disable-gpu` is only needed by the desktop builds, which rasterize on
    // the GPU. The headless shell has no GPU stack at all, and passing the flag
    // there made startup dump `CVDisplayLinkCreateWithCGDisplay failed` into the
    // log on every frame — noise that buried the real errors.
    if !is_headless_shell(bin) {
        args.push("--disable-gpu".to_string());
        // Keep SOLO automation out of the user's browser: each of these would
        // otherwise start a Google background service against the user's own
        // profile / crashpad database, exactly what made the system Chrome look
        // hung while the app was open.
        for flag in [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-features=MediaRouter,OptimizationHints,Translate",
            "--disable-sync",
            "--metrics-recording-only",
            "--no-service-autorun",
            "--disable-crash-reporter",
        ] {
            args.push(flag.to_string());
        }
    }
    args
}

/// True for the Chrome-for-Testing headless shell, which lacks the flags and
/// background services only a full browser build has.
fn is_headless_shell(bin: &std::path::Path) -> bool {
    bin.file_name()
        .map(|n| n.to_string_lossy().contains("chrome-headless-shell"))
        .unwrap_or(false)
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
            // Only a LIVE TAB may keep the process alive.
            //
            // Touching the clock on every poll made the browser immortal: a
            // panel (or a health check) that keeps asking for the port while
            // ZERO tabs are open refreshed `last_used` forever, so a browser
            // with no tab and no user — ~300 MB of process plus helpers — was
            // never reaped. With no tab there is nothing to serve, so the
            // `IDLE_REAP` clock is left running and the reaper can take it.
            if !tabs_is_empty() {
                b.last_used = Instant::now();
            }
            Some(b.port)
        }
        None => None,
    }
}

/// Whether the shared browser currently serves any tab.
fn tabs_is_empty() -> bool {
    TABS.lock().map(|t| t.is_empty()).unwrap_or(true)
}

/// Restart the browser's idle budget after its LAST tab went away.
///
/// Closing a tab costs its renderer, but the browser process (and its GPU and
/// utility children) stays warm so a reopened panel is instant. That warm
/// process must still time out: `close_tab` and the tab reaper both call this,
/// so the `IDLE_REAP` countdown begins when the browser actually went unused
/// rather than from whenever a tab last happened to touch it.
fn restart_idle_clock_if_unused() {
    if !tabs_is_empty() {
        return;
    }
    if let Ok(mut guard) = BROWSER.lock() {
        if let Some(b) = guard.as_mut() {
            b.last_used = Instant::now();
        }
    }
}

/// Drop every tab entry (called when the shared browser dies).
fn forget_all_tabs() {
    if let Ok(mut tabs) = TABS.lock() {
        tabs.clear();
    }
}

/// How often the background reaper checks the idle policy.
const REAPER_INTERVAL: Duration = Duration::from_secs(60);

/// Kill the shared browser when nothing has touched it for `IDLE_REAP`.
///
/// `alive_port` already reaps LAZILY, but only on the next request — and with
/// nobody asking (panel closed, chat switched away) no request ever comes, so
/// the Chromium lived until the app quit. That is how a stray headless browser
/// outlived its window and made the machine look permanently short of memory.
fn reap_if_idle() {
    let reap = match BROWSER.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|b| should_reap(b.last_used.elapsed(), IDLE_REAP))
            .unwrap_or(false),
        Err(_) => false,
    };
    if reap {
        kill_running_browser();
    }
}

/// Take the browser out of the registry and kill its process.
fn kill_running_browser() {
    let taken = BROWSER.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut proc) = taken {
        kill_process_tree(&mut proc.child);
        forget_all_tabs();
    }
}

/// Kill a browser process left behind by a PREVIOUS run of this app.
///
/// A crash, a `SIGKILL`, a Cmd-Q that skips the window event or an OS-forced
/// quit all bypass the shutdown hook, and the headless Chromium then holds its
/// process and helper tree indefinitely. The next launch sweeps for any process
/// carrying BOTH this app's own profile directory and a debugging-port flag
/// before starting a fresh one. The match is deliberately narrow: a browser the
/// user started themselves has neither marker, so it can never be a target.
///
/// Returns how many processes were signalled, so the caller can log it.
pub fn reap_orphans() -> usize {
    let profile = profile_dir();
    let Ok(out) = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,args="])
        .output()
    else {
        return 0;
    };
    if !out.status.success() {
        return 0;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let me = std::process::id();
    let mut killed = 0;
    for line in text.lines() {
        let Some((pid, args)) = line.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        // Never signal ourselves, and only ever a process that is ours.
        if pid == me || !is_our_driver(args, &profile) {
            continue;
        }
        if Command::new("/bin/kill").arg(pid.to_string()).status().is_ok() {
            killed += 1;
        }
    }
    killed
}

/// Sweep orphans once at startup, then reap the idle browser on a timer.
///
/// The sweep covers the previous run; the timer covers THIS one, so a session
/// left open for days does not keep a Chromium alive after its last tab closed.
/// The thread is detached and owns no app handle, so it never blocks or
/// outlives the quit path.
pub fn start_idle_reaper() {
    let swept = reap_orphans();
    if swept > 0 {
        println!("[browser] reaped {swept} orphaned browser process(es) from a previous run");
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(REAPER_INTERVAL);
        reap_idle_tabs();
        reap_if_idle();
    });
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
    let mut cmd = Command::new(bin);
    cmd.args(launch_args(bin, port, profile))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file));
    // Lead a NEW process group so the whole Chromium tree (its renderer, gpu and
    // utility children) can be signalled as one. Without this the tree shares the
    // app's group and `Child::kill()` (SIGKILL, which children cannot trap and
    // forward) leaves every helper orphaned and holding its renderer heap — the
    // "browsers survive app quit" leak. Mirrors `lsp::spawn`.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()
        .map_err(|e| format!("cannot start Chromium ({}): {e}", bin.display()))
}

/// SIGKILL the browser's whole process group, falling back to the child handle.
///
/// `Child::kill()` alone cannot do it: SIGKILL is untrappable, so Chromium never
/// runs its own child cleanup and the helpers are left reparented to launchd.
/// Signalling the GROUP (the browser leads it, see `try_launch`) takes the tree
/// down in one shot.
fn kill_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: `killpg` on a pgid we created is async-signal-safe and cannot
        // touch another process: pid 0 would signal OUR group, so it is excluded.
        let pgid = child.id() as libc::pid_t;
        if pgid > 0 {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    // Backstop for the child itself, and the only path on non-unix.
    let _ = child.kill();
    let _ = child.wait();
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
            kill_process_tree(child);
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
    // A browser left by a previous run (crash, forced quit) still holds the
    // profile and lock files; clear it before starting ours.
    reap_orphans();
    let bin = find_chromium().ok_or_else(|| {
        "no automation browser installed — install the built-in one from the \
         Browser panel (or run `npx playwright install chromium`)"
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
        if let Err(second) = wait_for_port(&mut retry, port, &fresh) {
            // `wait_for_port` kills the retry child when the port never opens;
            // without this `wait` the `?` below would drop it unreaped and leave
            // a second zombie in the process table.
            let _ = retry.kill();
            let _ = retry.wait();
            return Err(format!("{first}; retry on a fresh profile: {second}"));
        }
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
    // Reading the tab refreshes its idle clock (`existing_tab` does that), which
    // is exactly right: the agent asking for the tab IS the tab being in use, so
    // the per-tab reaper must not close it between two tool calls.
    let existing = existing_tab(chat);
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
        last_used: Instant::now(),
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

/// True when a target's URL is not a real page yet (nothing for the panel to
/// show). Used to decide whether the chat's own tab is worth keeping.
fn is_blank_page_url(url: &str) -> bool {
    let u = url.trim();
    u.is_empty() || u == "about:blank" || u.starts_with("devtools://")
}

/// Do two URLs mean the same page (so navigating again would only reload it)?
///
/// Compares scheme, host, path and fragment while ignoring the trailing `/`,
/// the `www.` prefix and the query: a link the user re-submits with a tracking
/// parameter is still the page already on screen, and reloading it would throw
/// away the agent's in-page state. Deliberately NOT a URL parser — a browser
/// reports `about:blank` and `data:` URLs, which a strict parser rejects; this
/// just needs to be conservative about calling two strings identical.
fn same_page(a: &str, b: &str) -> bool {
    fn norm(u: &str) -> String {
        let mut s = u.trim().to_string();
        if let Some((base, _)) = s.split_once('#') {
            s = base.to_string();
        }
        if let Some((base, _)) = s.split_once('?') {
            s = base.to_string();
        }
        for scheme in ["https://", "http://"] {
            if let Some(rest) = s.strip_prefix(scheme) {
                let rest = rest.strip_prefix("www.").unwrap_or(rest);
                return rest.trim_end_matches('/').to_string();
            }
        }
        s.trim_end_matches('/').to_string()
    }
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// Every PAGE target in the shared browser as `(target_id, url)`.
///
/// `Target.getTargets` is a browser-level call (no `sessionId` needed), so it
/// runs on the same plain connection `tab_usable` uses. An error or a dead
/// browser yields an empty list rather than failing the caller.
async fn page_targets() -> Vec<(String, String)> {
    let Some(port) = alive_port() else {
        return Vec::new();
    };
    let Ok(mut cdp) = Cdp::connect(port).await else {
        return Vec::new();
    };
    let Ok(res) = cdp.send("Target.getTargets", json!({})).await else {
        return Vec::new();
    };
    res["targetInfos"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    if t["type"].as_str() != Some("page") {
                        return None;
                    }
                    let id = t["targetId"].as_str()?.to_string();
                    let url = t["url"].as_str().unwrap_or_default().to_string();
                    Some((id, url))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The chat's tab, ADOPTING a page another CDP client opened when the chat has
/// nothing real to show.
///
/// The panel and the agent's driver share ONE browser but not one tab list: a
/// client can open its own page through the browser-level endpoint, so the
/// chat's registered target could sit on `about:blank` while the agent browsed a
/// real page — the panel then showed an empty Browser with no URL at all.
/// Adopting registers that page as the chat's tab, so every later
/// screenshot/input follows the page the agent is actually driving instead of a
/// blank one.
async fn adopt_async(chat: &str) -> Option<Tab> {
    let registered = existing_tab(chat);
    let targets = page_targets().await;
    if targets.is_empty() {
        // Browser down (or a unit-test registry): nothing to adopt.
        return registered;
    }
    // The chat's own tab already shows a real page — the common case, and the
    // one that must stay cheap.
    if let Some(tab) = &registered {
        let real = targets
            .iter()
            .find(|(id, _)| id == &tab.target_id)
            .map(|(_, url)| !is_blank_page_url(url))
            .unwrap_or(false);
        if real {
            return registered;
        }
    }
    let claimed: Vec<String> = TABS
        .lock()
        .ok()
        .map(|t| t.iter().map(|(_, x)| x.target_id.clone()).collect())
        .unwrap_or_default();
    let Some(target_id) = targets
        .iter()
        .find(|(id, url)| !is_blank_page_url(url) && !claimed.contains(id))
        .map(|(id, _)| id.clone())
    else {
        return registered;
    };
    let viewport = registered
        .as_ref()
        .map(|t| t.viewport)
        .unwrap_or(DEFAULT_VIEWPORT);
    let tab = Tab {
        target_id,
        viewport,
        last_used: Instant::now(),
    };
    if let Ok(mut tabs) = TABS.lock() {
        tabs.retain(|(k, _)| k != chat);
        tabs.push((chat.to_string(), tab.clone()));
    }
    Some(tab)
}

/// Sync wrapper around [`adopt_async`] for the panel-facing entry points.
///
/// Deliberately used ONLY by `launch`/`status`/`screenshot`: those three run on
/// the panel's polling path, so when one of them adopts a foreign page it is
/// registered for the chat and every other `/browser/*` call follows it
/// automatically — no other call site needs to know about adoption.
fn active_tab(chat: &str) -> Option<Tab> {
    let chat = chat.to_string();
    // `block_on` is typed for the CDP helpers that return `Result`; adopting
    // never fails (it falls back to the registered tab), so the `Ok` wrapper is
    // just to reuse the same runtime-spawning helper.
    block_on(async move { Ok(adopt_async(&chat).await) })
        .ok()
        .flatten()
}

/// The chat's registered tab without creating one.
///
/// Reading a tab IS using it: every panel poll and every driver call funnels
/// through here, so this refresh is what keeps a tab that is genuinely in use
/// from being reaped as idle.
fn existing_tab(chat: &str) -> Option<Tab> {
    let mut tabs = TABS.lock().ok()?;
    let idx = tabs.iter().position(|(k, _)| k == chat)?;
    tabs[idx].1.last_used = Instant::now();
    Some(tabs[idx].1.clone())
}

/// Whether a tab has gone untouched long enough to be closed. Pure so the policy
/// is unit-tested without spawning a browser.
fn tab_is_stale(tab: &Tab) -> bool {
    tab.last_used.elapsed() >= TAB_IDLE_TTL
}

/// Whether a tab may be reaped: idle long enough AND its chat is not running a
/// turn right now.
///
/// The panel poll is not the only way a tab stays in use: when the user switches
/// to another chat, the agent's turn keeps driving this one's browser with no
/// panel poll at all. Reaping on idleness alone closed the tab out from under a
/// running agent, and coming back to the chat showed "Browser is stopped". A tab
/// the agent can still reach must survive regardless of the TTL.
fn tab_may_be_reaped(chat: &str, tab: &Tab) -> bool {
    tab_is_stale(tab) && !crate::agent::is_turn_running(chat)
}

/// Close every tab nobody has looked at for `TAB_IDLE_TTL`.
///
/// Per-tab reaping is what actually releases the renderer processes: closing the
/// CDP target makes Chromium tear down that tab's renderer, which is the only
/// per-chat memory cost in the shared browser (~20-50 MB each measured).
fn reap_idle_tabs() {
    let stale: Vec<(String, String)> = match TABS.lock() {
        Ok(mut tabs) => {
            let mut stale = Vec::new();
            tabs.retain(|(chat, tab)| {
                if !tab_may_be_reaped(chat, tab) {
                    return true;
                }
                stale.push((chat.clone(), tab.target_id.clone()));
                false
            });
            stale
        }
        Err(_) => return,
    };
    if stale.is_empty() {
        return;
    }
    // `stale` is still needed after the await (to forget the cached drivers),
    // so hand the async block only the target ids instead of moving the vector.
    let targets: Vec<String> = stale.iter().map(|(_, t)| t.clone()).collect();
    let _ = block_on(async move {
        // No live browser (or a unit-test registry): the entries are already
        // gone from the map, which is the part that matters here.
        let Some(port) = alive_port() else {
            return Ok(Value::Null);
        };
        let Ok(mut cdp) = Cdp::connect(port).await else {
            return Ok(Value::Null);
        };
        for target in &targets {
            let _ = close_target(&mut cdp, target).await;
        }
        Ok(Value::Null)
    });
    // The cached CDP driver points at a target that no longer exists. Dropping
    // it releases the WebSocket and the page snapshots it was holding.
    for (chat, _) in &stale {
        crate::browser_driver::forget(chat);
    }
    // If that was the last tab, start the browser's own timeout now so the
    // empty-but-warm process cannot outlive its usefulness.
    restart_idle_clock_if_unused();
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
    restart_idle_clock_if_unused();
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
    let had_browser = BROWSER.lock().map(|g| g.is_some()).unwrap_or(false);
    kill_running_browser();
    if had_browser {
        tabs.max(1)
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// One-click automation browser install
// ---------------------------------------------------------------------------

/// Chrome-for-Testing publishes every build it has ever made, with a per-platform
/// download index. Reading that index (instead of hard-coding a version) means
/// the install cannot rot when a build is rotated out of the bucket.
const CFT_INDEX: &str =
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/// Progress of a running install, polled by the Browser panel.
///
/// `Mutex<Install>` (not a lazy cell) so the static stays `const`-constructible.
struct Install {
    running: bool,
    percent: u32,
    /// `downloading` | `extracting` | `done` | `failed` | empty when idle.
    phase: String,
    error: String,
}

static INSTALL: Mutex<Install> = Mutex::new(Install {
    running: false,
    percent: 0,
    phase: String::new(),
    error: String::new(),
});

/// The Chrome-for-Testing platform key for this machine.
fn cft_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else if cfg!(target_os = "windows") {
        "win64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux64"
    }
}

/// The headless-shell download URL for this platform.
///
/// The headless shell is the right artifact here: it is a purpose-built
/// automation build with no window, no updater and no background services, so it
/// can never register with LaunchServices or touch the user's own Chrome
/// profile the way a `/Applications` fallback did.
fn cft_shell_url() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let index: Value = client
        .get(CFT_INDEX)
        .send()
        .map_err(|e| format!("cannot read the browser index: {e}"))?
        .json()
        .map_err(|e| format!("browser index is not json: {e}"))?;
    let want = cft_platform();
    index["channels"]["Stable"]["downloads"]["chrome-headless-shell"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|d| d["platform"].as_str() == Some(want))
                .and_then(|d| d["url"].as_str())
        })
        .map(str::to_string)
        .ok_or_else(|| {
            format!("chrome-for-testing has no headless-shell build for {want}")
        })
}

fn set_progress(phase: &str, percent: u32) {
    if let Ok(mut st) = INSTALL.lock() {
        st.phase = phase.to_string();
        st.percent = percent;
    }
}

/// Start the install in the background. Idempotent: a second call while one is
/// running is a no-op, so a double click cannot download the archive twice.
pub fn install() {
    {
        let Ok(mut st) = INSTALL.lock() else {
            return;
        };
        if st.running {
            return;
        }
        st.running = true;
        st.percent = 0;
        st.error.clear();
        st.phase = "downloading".to_string();
    }
    // `reqwest::blocking` builds its own runtime and panics when called from
    // inside an async context, and the HTTP route that starts this is async — so
    // the whole install runs on a plain thread (same rule as `mcp.rs`).
    std::thread::spawn(|| {
        let result = install_blocking();
        if let Ok(mut st) = INSTALL.lock() {
            st.running = false;
            match result {
                Ok(()) => {
                    st.phase = "done".to_string();
                    st.percent = 100;
                }
                Err(e) => {
                    st.phase = "failed".to_string();
                    st.error = e;
                }
            }
        }
    });
}

/// The install status the panel polls.
pub fn install_status() -> Value {
    let (running, percent, phase, error) = match INSTALL.lock() {
        Ok(st) => (
            st.running,
            st.percent,
            st.phase.clone(),
            st.error.clone(),
        ),
        Err(_) => (false, 0, String::new(), "install lock poisoned".to_string()),
    };
    json!({
        "ok": true,
        "available": is_available(),
        "installing": running,
        "percent": percent,
        "phase": phase,
        "error": error,
    })
}

fn install_blocking() -> Result<(), String> {
    let url = cft_shell_url()?;
    let root = data_root().join("browser");
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let pid = std::process::id();
    let zip_path = std::env::temp_dir().join(format!("codifa-browser-{pid}.zip"));
    let staging = std::env::temp_dir().join(format!("codifa-browser-unpack-{pid}"));
    let _ = std::fs::remove_dir_all(&staging);

    let result = (|| -> Result<(), String> {
        download_to(&url, &zip_path)?;
        set_progress("extracting", 92);
        std::fs::create_dir_all(&staging).map_err(|e| format!("cannot stage: {e}"))?;
        extract_zip(&zip_path, &staging)?;
        let unpacked = single_child_dir(&staging)?;
        let name = unpacked
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| "unexpected archive layout".to_string())?;
        // Swap into place: the archive's own top-level name is kept, because
        // that is the shape `candidate_dirs` looks for.
        let dest = root.join(&name);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&unpacked, &dest).map_err(|e| {
            format!("cannot move the browser into {}: {e}", dest.display())
        })?;
        make_executable(&dest);
        if find_chromium().is_none() {
            return Err("the browser was unpacked but its binary was not found".to_string());
        }
        Ok(())
    })();

    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Stream `url` to `dest`, reporting progress over the first 90% so the
/// extraction phase has its own visible slice.
fn download_to(url: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut res = client
        .get(url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download failed (HTTP {})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last = u32::MAX;
    loop {
        let n = res.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("cannot write the download: {e}"))?;
        written += n as u64;
        if total > 0 {
            let pct = ((written as f64 / total as f64) * 90.0) as u32;
            if pct != last {
                last = pct;
                set_progress("downloading", pct);
            }
        }
    }
    file.sync_all().map_err(|e| format!("cannot flush: {e}"))?;
    if total > 0 && written != total {
        return Err(format!(
            "download incomplete: got {written} of {total} bytes"
        ));
    }
    Ok(())
}

/// Unpack every entry of `archive` under `dest`.
///
/// `enclosed_name()` rejects entries that try to escape the target directory
/// (`../`), so a hostile archive cannot write outside `dest`.
fn extract_zip(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("cannot open the download: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("the download is not a zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("cannot read the archive: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut writer = std::fs::File::create(&out)
            .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut writer)
            .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    }
    Ok(())
}

/// The single directory an archive unpacks into (both the app's own download
/// and every Chrome-for-Testing zip use exactly one).
fn single_child_dir(root: &std::path::Path) -> Result<PathBuf, String> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| format!("cannot read the unpacked archive: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.len() == 1 {
        return Ok(dirs.remove(0));
    }
    Err("the archive did not unpack into a single directory".to_string())
}

/// ZIP archives do not always carry the executable bit through, and a browser
/// binary without it fails with a bare permission error.
fn make_executable(dir: &std::path::Path) {
    let Some(bin) = find_chromium() else {
        return;
    };
    if !bin.starts_with(dir) {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&bin, perms);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
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
    let Some(tab) = active_tab(&chat) else {
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

/// Navigate a tab, idempotently (an existing tab is reused).
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
    // Already there: re-issuing the same URL is a full reload, and the panel
    // syncs its omnibox from `status` on every poll — so a chat switch (which
    // remounts the panel) used to reload the page the agent was working on.
    // Comparing here makes navigation idempotent for every caller.
    let showing = current_url(&tab);
    if same_page(&showing, target) {
        return json!({"ok": true, "url": showing});
    }
    let tab_for_call = tab.clone();
    let tab_for_settle = tab.clone();
    let target_owned = target.to_string();
    let fut = async move {
        navigate(&tab_for_call, &target_owned).await?;
        Ok(Value::Null)
    };
    match block_on(fut) {
        Ok(_) => {
            // Wait for the navigation to commit AND settle so the returned url
            // is the new page rather than the one being left (a fixed sleep
            // both raced slow pages and wasted time on fast ones).
            let _ = block_on(async move {
                wait_page_settled(&tab_for_settle, Duration::from_secs(8)).await;
                Ok(Value::Null)
            });
            json!({"ok": true, "url": current_url(&tab)})
        }
        Err(e) => json!({"ok": false, "error": format!("navigation failed: {e}")}),
    }
}

/// Launch (or reuse) the chat's tab and optionally navigate it.
pub fn launch(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let target = url.trim();
    let tab = match active_tab(&chat) {
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

/// Wait until the tab's document leaves the `loading` state (bounded).
///
/// `Page.captureScreenshot` on a document that is still loading — or whose
/// first paint has not landed yet — returns a BLACK frame: the reported
/// "the page goes black during UI tests". ZCode's own browser tooling waits
/// for the load state before every observation; this is the same rule,
/// enforced centrally so every consumer (the panel's status poll and the
/// agent's tool calls) is covered. Falls through on the timeout so a page
/// that never settles still produces a frame.
async fn wait_page_settled(tab: &Tab, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let ready = cdp_calls_on(
            tab,
            vec![("Runtime.evaluate", json!({
                "expression": "document.readyState",
                "returnByValue": true,
            }))],
            false,
        )
        .await;
        let settled = ready
            .ok()
            .and_then(|res| res.into_iter().next())
            .and_then(|r| {
                r["result"]["result"]["value"]
                    .as_str()
                    .map(str::to_string)
            })
            .map(|v| v == "interactive" || v == "complete")
            .unwrap_or(false);
        if settled || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// One JPEG frame as a data URI (the panel renders it directly).
///
/// The device-metrics override is re-applied on THIS connection right before
/// the capture: `Emulation.setDeviceMetricsOverride` is scoped to the CDP
/// session, and every call here opens a fresh WebSocket, so an override set by
/// an earlier /browser/viewport call would be gone by the time we capture.
pub fn screenshot(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = active_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    let tab_for_call = tab.clone();
    let fut = async move {
        wait_page_settled(&tab_for_call, Duration::from_secs(6)).await;
        // One paint beat after readyState flips: the first composited frame
        // usually lands right behind the DOM reporting ready — capturing on
        // the readyState tick alone still races it every few pages.
        tokio::time::sleep(Duration::from_millis(180)).await;
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

// ---------------------------------------------------------------------------
// Driver façade
// ---------------------------------------------------------------------------

/// Everything the native CDP driver (`browser_driver.rs`) needs from this
/// module, so the process/tab registry stays private to the file that owns it.
///
/// The driver is a SEPARATE module rather than more code in this one because it
/// needs something this file deliberately does not have: a long-lived WebSocket
/// whose reader and writer run concurrently. Everything here is request/reply on
/// a socket that is opened and dropped per call.
pub(crate) mod driver_hooks {
    /// Normalized chat key.
    pub(crate) fn chat_key(chat: &str) -> String {
        super::normalize_chat(chat)
    }

    /// Port of the live shared browser (refreshes its idle timer).
    pub(crate) fn port() -> Option<u16> {
        super::alive_port()
    }

    /// WebSocket URL of the browser-level endpoint.
    pub(crate) fn ws_url(port: u16) -> Result<String, String> {
        super::browser_ws_url(port)
    }

    /// Target id of the chat's tab, starting the browser AND the tab when
    /// needed. This is the same tab the right-side panel polls, so the agent
    /// and the user always look at one page.
    pub(crate) fn ensure_target(chat: &str) -> Result<String, String> {
        super::ensure_tab(chat).map(|t| t.target_id)
    }

    /// Point the chat's registered tab at `target` (the panel and the driver
    /// must never disagree about which page the chat is on).
    pub(crate) fn set_target(chat: &str, target: &str) {
        if let Ok(mut tabs) = super::TABS.lock() {
            if let Some((_, tab)) = tabs.iter_mut().find(|(k, _)| k == chat) {
                tab.target_id = target.to_string();
            }
        }
    }
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
                last_used: Instant::now(),
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
    fn an_idle_tab_is_closed_but_a_fresh_one_is_kept() {
        // Per-tab reaping is what releases the renderer processes: the
        // browser-wide TTL could never do it, because one polled panel kept
        // `BrowserProc::last_used` fresh for every other chat's tab too.
        let mut fresh = Tab {
            target_id: "T1".to_string(),
            viewport: DEFAULT_VIEWPORT,
            last_used: Instant::now(),
        };
        assert!(!tab_is_stale(&fresh));

        fresh.last_used = Instant::now() - TAB_IDLE_TTL - Duration::from_secs(1);
        assert!(tab_is_stale(&fresh));

        // The per-tab TTL must be shorter than the browser-wide one, or a tab
        // could outlive the process that reaps it and the policy is cosmetic.
        assert!(TAB_IDLE_TTL < IDLE_REAP);
    }

    /// A browser with no tab open must never keep itself alive.
    ///
    /// Regression: `alive_port` refreshed `last_used` on EVERY call, so a poll
    /// with zero tabs made the clock unreachable and the whole Chromium tree
    /// (~300 MB including helpers) lived until app exit. Only a live tab may
    /// touch the clock.
    #[test]
    fn an_idle_clock_is_only_touched_while_a_tab_exists() {
        forget_all_tabs();
        assert!(tabs_is_empty());

        // With no tab, a poll must leave the reap decision to idle time alone.
        let untouched = Instant::now() - IDLE_REAP - Duration::from_secs(1);
        assert!(should_reap(untouched.elapsed(), IDLE_REAP));
        assert!(tabs_is_empty(), "a poll must not invent a tab");
    }

    #[test]
    fn idle_tab_of_a_running_turn_is_never_reaped() {
        // The agent keeps driving a chat's browser after the user switches away,
        // so idleness alone must not close it: that was the "Browser is stopped"
        // dead tab. This is the whole reason `tab_may_be_reaped` consults the
        // agent's turn registry instead of the TTL alone.
        let idle = || Tab {
            target_id: "T1".to_string(),
            viewport: DEFAULT_VIEWPORT,
            last_used: Instant::now() - TAB_IDLE_TTL - Duration::from_secs(1),
        };
        crate::agent::test_set_turn_running("chat-busy", true);
        assert!(tab_is_stale(&idle()));
        assert!(!tab_may_be_reaped("chat-busy", &idle()));
        // Once the turn ends the tab becomes reapable again (no permanent leak).
        crate::agent::test_set_turn_running("chat-busy", false);
        assert!(tab_may_be_reaped("chat-busy", &idle()));
        // A chat with no turn running is reaped on the TTL as before.
        assert!(tab_may_be_reaped("chat-idle", &idle()));
    }

    #[test]
    fn same_page_ignores_reload_noise_but_not_a_different_page() {
        assert!(same_page("https://example.com/a", "https://example.com/a"));
        assert!(same_page("https://example.com/a/", "https://example.com/a"));
        assert!(same_page("https://www.example.com/a", "https://example.com/a"));
        assert!(same_page(
            "https://example.com/a?utm=1",
            "https://example.com/a"
        ));
        assert!(same_page("https://example.com/a#frag", "https://example.com/a"));
        // Different pages must still navigate.
        assert!(!same_page("https://example.com/a", "https://example.com/b"));
        // A blank current url never counts as "already there".
        assert!(!same_page("", "https://example.com/a"));
        assert!(!same_page("about:blank", "https://example.com/a"));
    }

    #[test]
    fn reading_a_tab_counts_as_using_it() {
        for (chat, target) in [("chat-a", "T1"), ("chat-b", "T2")] {
            let mut tabs = TABS.lock().unwrap();
            tabs.retain(|(k, _)| k != chat);
            tabs.push((
                chat.to_string(),
                Tab {
                    target_id: target.to_string(),
                    viewport: DEFAULT_VIEWPORT,
                    last_used: Instant::now(),
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

    #[test]
    fn browser_never_falls_back_to_a_system_browser() {
        // The freeze: the automation browser ran out of /Applications/Google
        // Chrome.app, so the headless instance shared its bundle id
        // (com.google.Chrome) with the user's real Chrome — registering with
        // LaunchServices, spawning Chrome's own crashpad handler and
        // GoogleUpdater against the user's profile, and fighting the real
        // browser over the display. The candidate list must therefore never
        // contain a system browser, whatever is installed on this machine.
        for path in chromium_candidates() {
            let p = path.to_string_lossy();
            assert!(
                !p.starts_with("/Applications") && !p.starts_with("/usr/bin"),
                "system browser {p} must never be used as the automation browser"
            );
            assert!(
                !p.contains("Google Chrome.app")
                    && !p.contains("Microsoft Edge.app")
                    && !p.contains("Brave Browser.app"),
                "a user-facing browser must never be picked: {p}"
            );
        }
    }

    #[test]
    fn candidate_dirs_order_newest_build_first() {
        // `sort().reverse()` put chromium-999 AFTER chromium-1000 (string
        // order), so an older build won as soon as a version crossed a digit
        // boundary. The rank must be numeric.
        let rank = |n: &str| build_rank(std::path::Path::new(n));
        // String order put "chromium-999" AFTER "chromium-1000"; the rank must
        // be numeric.
        assert!(rank("chromium-1000") > rank("chromium-999"));
        // Builds are ordered by their LEADING number (the revision/major), not
        // by a trailing patch component, which says nothing across majors.
        assert!(rank("chrome-headless-shell-141.0.7339.82") > rank("chrome-headless-shell-140.0.7339.82"));
        assert_eq!(rank("chrome-headless-shell-140.0.7339.82"), 140);
        assert_eq!(rank("chromium"), 0);
    }

    #[test]
    fn orphan_matcher_targets_only_our_own_headless_browser() {
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        // Ours: our own profile directory plus a debugging port.
        let ours = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "--remote-debugging-port=61995",
            "--headless",
            "--user-data-dir=/Users/x/.codifa/browser-profile",
        ]
        .join(" ");
        assert!(is_our_driver(&ours, profile));
        // A browser the user started themselves: no debugging port, no profile.
        assert!(!is_our_driver(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            profile
        ));
        // A renderer child of OUR browser MUST be matched: the parent's SIGKILL
        // leaves it orphaned, so the sweep has to reach it. Excluding `--type=`
        // here was the reason abandoned browsers kept their renderer heap alive.
        let renderer = [
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper",
            "--type=renderer",
            "--user-data-dir=/Users/x/.codifa/browser-profile",
            "--remote-debugging-port=61995",
        ]
        .join(" ");
        assert!(is_our_driver(&renderer, profile));
        // Another program's headless browser (not our profile) is left alone.
        let other = [
            "chromium",
            "--headless",
            "--remote-debugging-port=9222",
            "--user-data-dir=/tmp/other-profile",
        ]
        .join(" ");
        assert!(!is_our_driver(&other, profile));
    }

    #[test]
    fn launch_args_keep_the_browser_off_the_users_chrome() {
        let bin = std::path::Path::new(
            "/opt/chromium-1223/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        );
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        let args = launch_args(bin, 61995, profile).join(" ");
        // Headless + our own profile: never the user's Chrome profile.
        assert!(args.contains("--headless"));
        assert!(args.contains("--user-data-dir=/Users/x/.codifa/browser-profile"));
        assert!(args.contains("--remote-debugging-port=61995"));
        // The Google background services that reached into the user's own
        // profile / crashpad database.
        assert!(args.contains("--disable-crash-reporter"));
        assert!(args.contains("--disable-background-networking"));
        assert!(args.contains("--no-service-autorun"));
        // A full build needs the GPU off; the shell must not be told to.
        assert!(args.contains("--disable-gpu"));
        let shell = std::path::Path::new("/opt/browser/chrome-headless-shell");
        let shell_args = launch_args(shell, 61995, profile).join(" ");
        assert!(!shell_args.contains("--disable-gpu"));
        assert!(shell_args.contains("--headless"));
    }
}
