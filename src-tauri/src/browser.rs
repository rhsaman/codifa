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
//!
//! POPUPS: a `window.open` call (Google "Continue with Google", every OAuth
//! button, plain `target="_blank"` links) opens a SECOND target that the
//! opener tab keeps talking to via `window.opener`. Chromium creates it fine,
//! but only the chat's own tab was ever screencast, so login popups ran
//! invisibly and "the popup never opens". The panel now FOLLOWS popups: while
//! a popup opened by the chat's tab lives, the panel displays it (and points
//! input at it); when it closes, the view falls back to the tab. The cookies
//! land in the same shared profile either way.

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

/// One popup: a page some chat's tab opened via `window.open` (or a
/// `target="_blank"` link) — the OAuth/login popups sites rely on. The popup
/// is its own Chromium target; the opener keeps reaching it through
/// `window.opener`, so it must stay a real separate target (collapsing it
/// into the tab would break the callback that reports "login succeeded").
#[derive(Clone)]
struct Popup {
    /// The popup's own target id: what the panel displays while it lives.
    target_id: String,
    /// Target id of the chat tab that opened it. Popups of popups roll up to
    /// the same root, so panel resolution never walks more than one hop.
    root: String,
}

/// Live popups across the shared browser, oldest first. Kept in step with
/// Chromium by `sync_popups` (poll) plus the pushed `Target.targetDestroyed`
/// events (instant teardown), and read on every panel poll/input by
/// `with_visible_popup`.
static POPUPS: Mutex<Vec<Popup>> = Mutex::new(Vec::new());

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
/// `Google Chrome for Testing.app`; on Windows the same build is
/// `chrome-win64/chrome.exe` (the `.exe` suffix is added per-platform below),
/// on Linux `chrome-linux64/chrome`. A Playwright Chromium uses `Chromium`
/// (mac) / `chrome` (linux); the headless shell ships `chrome-headless-shell`.
/// Every fragment is tried under each matching build dir, so one list covers
/// all of them.
const BROWSER_LAYOUTS: &[(&str, &str)] = &[
    ("chrome-mac-arm64", "Google Chrome for Testing"),
    ("chrome-mac-x64", "Google Chrome for Testing"),
    // The full-chrome zip for macOS unpacks the .app at the TOP LEVEL (next
    // to ABOUT/resources) with no wrapper dir — the "" fragment probes the
    // build dir itself, which is what the installer's rename produces.
    ("", "Google Chrome for Testing"),
    ("chrome-win64", "chrome"),
    ("chrome-linux64", "chrome"),
    ("chrome-linux", "chrome"),
    ("chrome-mac", "Chromium"),
    ("chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    ("chrome-headless-shell-mac-x64", "chrome-headless-shell"),
    ("chrome-headless-shell-win64", "chrome-headless-shell"),
    ("chrome-headless-shell-linux64", "chrome-headless-shell"),
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
pub(crate) fn build_rank(dir: &std::path::Path) -> u64 {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .split(['-', '.'])
        .find_map(|part| part.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Every build-dir + layout probe under `root`, as exact candidate paths.
/// Shared by `chromium_candidates` (which walks the app's browser roots) and
/// `make_executable` (which must find the binary INSIDE the just-unpacked
/// build — `find_chromium` cannot be used there: until the exec bit is set and
/// the layout is right, it still resolves to the previous install).
fn binaries_under(root: &std::path::Path) -> Vec<PathBuf> {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let mut out = Vec::new();
    for dir in candidate_dirs(root) {
        for (fragment, binary) in BROWSER_LAYOUTS {
            if cfg!(target_os = "macos") {
                out.push(
                    dir.join(fragment)
                        .join(format!("{binary}.app/Contents/MacOS/{binary}")),
                );
            }
            out.push(dir.join(fragment).join(format!("{binary}{exe}")));
            // A flat unpack (the installer's own layout): <dir>/<binary>.
            out.push(dir.join(format!("{binary}{exe}")));
        }
    }
    out
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
        out.extend(binaries_under(&root));
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
/// `ua` pins the USER-AGENT at the process level: a popup's first document
/// request leaves the browser BEFORE any CDP session can attach and override
/// the UA per-session, and that one request used to say `HeadlessChrome` —
/// exactly what Google's sign-in gate reads as "not a real browser".
fn launch_args(
    bin: &std::path::Path,
    port: u16,
    profile: &std::path::Path,
    ua: Option<&str>,
) -> Vec<String> {
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
    if let Some(ua) = ua {
        args.push(format!("--user-agent={ua}"));
    }
    // `--disable-gpu` is only needed by the desktop builds, which rasterize on
    // the GPU. The headless shell has no GPU stack at all, and passing the flag
    // there made startup dump `CVDisplayLinkCreateWithCGDisplay failed` into the
    // log on every frame — noise that buried the real errors.
    if !is_headless_shell(bin) {
        // The full build still runs its OUTPUT on SwiftShader: a GPU process
        // cannot be hosted from a daemon context (launch failure 1003), and
        // both failure modes around that are worse than software rendering —
        // Chromium used to EXIT ("GPU process isn't usable. Goodbye.") and
        // with the crash limit lifted it crash-LOOPS at a full CPU core. What
        // the full build buys over the headless shell is the rest of the
        // fingerprint: real PDF plugins, a real `window.chrome`, the desktop
        // binary's font/codec stack — and the SwiftShader WebGL string is
        // covered by the consistency script.
        args.push("--disable-gpu".to_string());
        // Chrome 139+ gates software WebGL behind an explicit opt-in.
        args.push("--enable-unsafe-swiftshader".to_string());
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
        // The full build wants "Chromium Safe Storage" in the user's LOGIN
        // KEYCHAIN on every launch (a password prompt over the user's work).
        // The mock keychain keeps cookie encryption inside our own profile
        // and never asks — cookies here are disposable automation state.
        if cfg!(target_os = "macos") {
            args.push("--use-mock-keychain".to_string());
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

/// Browser-level CDP connection: one WebSocket, one `sessionId` per tab.
///
/// The socket is split into read/write halves so the driver can race incoming
/// events (screencast frames) against new batches without borrow conflicts.
struct Cdp {
    tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    next_id: u64,
    /// Session id of the tab this connection is currently driving.
    session: Option<String>,
    /// Screencast frames absorbed while a command was waiting for its reply:
    /// `(flatten sessionId, base64 jpeg)`, latest per session. The driver moves
    /// them into the frame cache after the batch (see `flush_frames`).
    frames: Vec<(String, String)>,
    /// Viewport override each session already holds. The override is scoped to
    /// the CDP session and persists on a warm connection, so re-sending it with
    /// every keystroke, hover and status poll only forced a relayout and a new
    /// frame each time. It lives here so it is dropped with the connection.
    applied_vp: std::collections::HashMap<String, (u32, u32)>,
    /// `Emulation.setUserAgentOverride` params built from the browser's own
    /// version (see `ua_override`), cached for the life of the connection.
    ua: Option<Value>,
}

impl Cdp {
    async fn connect(port: u16) -> Result<Self, String> {
        let ws_url = browser_ws_url(port)?;
        let (ws, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect failed: {e}"))?;
        let (tx, rx) = ws.split();
        Ok(Self {
            tx,
            rx,
            next_id: 1,
            session: None,
            frames: Vec::new(),
            applied_vp: std::collections::HashMap::new(),
            ua: None,
        })
    }

    /// Cache one pushed screencast frame and acknowledge it immediately.
    ///
    /// Two things stalled the panel's frames before:
    ///   1. `send` skipped every event while waiting for its reply, so a frame
    ///      that landed during a command (exactly when typing or clicking) was
    ///      never stored or acknowledged;
    ///   2. the acknowledgement carried the CDP flatten session id (a string)
    ///      instead of the frame's own integer `params.sessionId`, which
    ///      Chromium rejects — the frame stays unacknowledged and after a couple
    ///      of them it stops pushing frames altogether.
    async fn absorb_frame(&mut self, v: &Value) {
        let Some(data) = v["params"]["data"].as_str() else {
            return;
        };
        let Some(flat) = v["sessionId"].as_str() else {
            return;
        };
        let ack_id = v["params"]["sessionId"].as_i64().unwrap_or(0);
        self.frames.retain(|(s, _)| s != flat);
        self.frames.push((flat.to_string(), data.to_string()));
        let id = self.next_id;
        self.next_id += 1;
        // Fire and forget: the ack's own reply is ignored by id mismatch.
        let ack = json!({
            "id": id,
            "method": "Page.screencastFrameAck",
            "sessionId": flat,
            "params": {"sessionId": ack_id},
        });
        let _ = self.tx.send(Message::Text(ack.to_string().into())).await;
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
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("cdp send {method}: {e}"))?;
        let deadline = Instant::now() + CDP_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("cdp {method} timed out"));
            }
            let next = tokio::time::timeout(remaining, self.rx.next())
                .await
                .map_err(|_| format!("cdp {method} timed out"))?;
            let Some(Ok(Message::Text(txt))) = next else {
                continue;
            };
            let v: Value = match serde_json::from_str(&txt) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("method").and_then(Value::as_str) == Some("Page.screencastFrame") {
                self.absorb_frame(&v).await;
                continue;
            }
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

// ---------------------------------------------------------------------------
// Shared CDP connection: ONE warm WebSocket for the whole app
// ---------------------------------------------------------------------------
//
// Every keystroke, hover move and frame used to open a fresh WebSocket
// (`/json/version` probe + handshake + `Target.attachToTarget` + viewport
// override) and spawn a fresh thread + tokio runtime for it. At the panel's
// input rate that work queued up faster than it drained — typing and the
// virtual cursor lagged seconds behind, and a size change sat minutes behind a
// flood of stale hover moves. One long-lived connection, driven by one thread
// that executes batches strictly in arrival order, turns every action into a
// single warm-socket command and preserves input order for free.

/// One batch of CDP commands, executed in order on the shared connection.
struct CdpBatch {
    /// Tab to drive, or `None` for browser-level commands
    /// (Target.getTargets / createTarget / closeTarget / getTargetInfo).
    target: Option<String>,
    /// The tab's emulated viewport, applied when `with_viewport` is set.
    viewport: (u32, u32),
    /// Re-apply the emulated viewport before the commands: screenshots and
    /// input need the tab's coordinate space, while navigation must not drag
    /// it into the next page's first paint.
    with_viewport: bool,
    commands: Vec<(&'static str, Value)>,
    reply: std::sync::mpsc::Sender<Result<Vec<Value>, String>>,
}

/// Handle on the driver thread: its request channel plus the browser port the
/// connection was opened against.
struct CdpPool {
    port: u16,
    tx: tokio::sync::mpsc::Sender<CdpBatch>,
}

/// The one driver serving every tab. `Option` (not a lazy cell) so the static
/// stays `const`-constructible.
static CDP_POOL: Mutex<Option<CdpPool>> = Mutex::new(None);

/// Sender for the shared connection, (re)starting the driver thread when the
/// browser is new or was restarted on a different port.
fn cdp_pool() -> Result<tokio::sync::mpsc::Sender<CdpBatch>, String> {
    let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
    let mut guard = CDP_POOL.lock().map_err(|_| "cdp pool poisoned")?;
    if let Some(pool) = guard.as_ref() {
        if pool.port == port {
            return Ok(pool.tx.clone());
        }
        // The browser restarted on another port — the old driver's socket is
        // dead, so fall through and spawn a fresh one. The old thread winds
        // down once its channel closes.
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<CdpBatch>(64);
    std::thread::Builder::new()
        .name("cdp-driver".to_string())
        .spawn(move || cdp_driver_main(rx))
        .map_err(|e| format!("cannot start the cdp driver: {e}"))?;
    *guard = Some(CdpPool { port, tx: tx.clone() });
    Ok(tx)
}

/// Drop the stored handle so the next call starts a fresh driver thread.
/// Called wherever the browser process is killed or replaced: a same-port
/// restart still self-heals via the transport-error retry, this just makes the
/// common path immediate.
fn invalidate_cdp_pool() {
    if let Ok(mut guard) = CDP_POOL.lock() {
        *guard = None;
    }
}

/// True for errors that mean the CONNECTION or the cached session is gone
/// (browser restart, cross-process navigation) rather than the command itself
/// failing — those are retried once on a fresh connection. A timed-out command
/// is deliberately NOT retried: its reply may still be in flight, and replaying
/// a slow input event is worse than reporting the failure.
fn is_transport_error(err: &str) -> bool {
    let low = err.to_ascii_lowercase();
    if low.contains("timed out") {
        return false;
    }
    low.contains("websocket")
        || low.contains("connect")
        || low.contains("closed")
        || low.contains("session")
        || low.contains("no target")
        || low.contains("target crashed")
        || low.contains("detached")
        || low.contains("io error")
        || low.contains("protocol")
        || low.contains("broken pipe")
        || low.contains("reset")
}

/// The driver: pull batches in arrival order and run each one to completion
/// before taking the next. Strict ordering is what keeps a typing burst (one
/// batch per flush) from being reordered behind later requests. Between
/// batches the loop reads the socket, so Chromium's PUSHED frames (screencast)
/// land in the frame cache instead of piling up unacked.
fn cdp_driver_main(mut rx: tokio::sync::mpsc::Receiver<CdpBatch>) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    rt.block_on(async move {
        let mut conn: Option<Cdp> = None;
        // target_id -> flatten sessionId. Sessions outlive batches, so a tab is
        // attached ONCE and every later command rides the cached session.
        let mut sessions: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // Sessions with Page.startScreencast already running (frame push).
        let mut screencast_on: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        loop {
            if conn.is_none() {
                // No connection: there is nothing to race the channel against.
                match rx.recv().await {
                    Some(batch) => {
                        let res = run_batch(
                            &mut conn,
                            &mut sessions,
                            &mut screencast_on,
                            &batch,
                        )
                        .await;
                        let _ = batch.reply.send(res);
                    }
                    None => break,
                }
                continue;
            }
            tokio::select! {
                batch = rx.recv() => {
                    match batch {
                        Some(batch) => {
                            let res = run_batch(
                                &mut conn,
                                &mut sessions,
                                &mut screencast_on,
                                &batch,
                            )
                            .await;
                            let _ = batch.reply.send(res);
                        }
                        None => break,
                    }
                }
                msg = conn.as_mut().expect("connection checked above").rx.next() => {
                    on_socket_msg(&mut conn, &mut sessions, &mut screencast_on, msg).await;
                }
            }
        }
    });
}

/// Move the frames a connection absorbed into the shared per-tab cache, which
/// wakes the panel's long-poll.
fn flush_frames(cdp: &mut Cdp, sessions: &std::collections::HashMap<String, String>) {
    for (flat, data) in std::mem::take(&mut cdp.frames) {
        let target = sessions
            .iter()
            .find(|(_, s)| **s == flat)
            .map(|(t, _)| t.clone());
        if let Some(target) = target {
            mark_pushed(&target);
            store_frame(&target, &format!("data:image/jpeg;base64,{data}"));
        }
    }
}

/// Handle one socket message while no batch is running. Screencast frames are
/// stored for the panel's long-poll and acked (an unacked frame stops the
/// stream); `Target.targetDestroyed` tears a popup out of the registry the
/// moment Chromium closes it (the "log in succeeded, popup closes" beat must
/// snap the panel back to the page instantly, not a poll later); everything
/// else — stray events, late replies — is dropped.
async fn on_socket_msg(
    conn: &mut Option<Cdp>,
    sessions: &mut std::collections::HashMap<String, String>,
    screencast_on: &mut std::collections::HashSet<String>,
    msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) {
    let Some(Ok(Message::Text(txt))) = msg else {
        // Socket closed or errored: drop everything session-scoped so the
        // next batch reconnects and re-attaches from scratch.
        *conn = None;
        sessions.clear();
        screencast_on.clear();
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return;
    };
    match v.get("method").and_then(Value::as_str) {
        Some("Page.screencastFrame") => {
            if let Some(c) = conn.as_mut() {
                c.absorb_frame(&v).await;
                flush_frames(c, sessions);
            }
        }
        Some("Target.targetDestroyed") => {
            let gone = v["params"]["targetId"].as_str().unwrap_or_default();
            if !gone.is_empty() {
                if let Ok(mut popups) = POPUPS.lock() {
                    popups.retain(|p| p.target_id != gone);
                }
                drop_frame(gone);
            }
        }
        _ => {}
    }
}

/// The WebGL strings the consistency script reports are PLATFORM-specific —
/// a macOS machine claiming an NVIDIA D3D11 renderer would itself be a
/// fingerprint. One plausible per-OS desktop GPU each; the automation browser
/// runs on the user's own hardware, so the real build (GPU enabled) reports
/// the genuine string and this only covers the SwiftShader fallback.
fn gl_fingerprint() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("Apple Inc.", "ANGLE Metal Renderer: Apple M1, Unspecified Version")
    } else if cfg!(target_os = "windows") {
        (
            "Google Inc. (Intel)",
            "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 (vs_5_0, ps_5_0), D3D11)",
        )
    } else {
        (
            "Google Inc. (Intel)",
            "ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
        )
    }
}

/// The consistency script with the platform's WebGL strings spliced in.
pub(crate) fn consistency_js() -> String {
    let (vendor, renderer) = gl_fingerprint();
    CONSISTENCY_JS_TEMPLATE
        .replace("__GL_VENDOR__", vendor)
        .replace("__GL_RENDERER__", renderer)
}

/// Injected into every new document of a tab: the places where a headless
/// Chromium differs from the desktop Chrome the User-Agent now claims to be,
/// which sign-in providers (Google's "This browser or app may not be secure"
/// gate above all) probe. Each line is guarded so one failure cannot stop the
/// rest, and none of it changes what the page can do:
///   * `navigator.webdriver` — the automation flag;
///   * `window.chrome` + `app`/`csi`/`loadTimes` — absent in the headless shell;
///   * `navigator.plugins`/`mimeTypes` — a headless shell has none, desktop
///     Chrome always ships the five PDF viewers;
///   * `document.hasFocus` — headless reports false for every document, a
///     clicked-open OAuth popup is focused;
///   * WebGL `UNMASKED_VENDOR/RENDERER` — the shell renders through
///     SwiftShader and says so, which reads as "not a real browser";
///   * `navigator.mediaDevices` — absent in the shell.
const CONSISTENCY_JS_TEMPLATE: &str = r#"(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      connect: function () { return { onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; },
      sendMessage: function () {},
    };
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () {},
        getIsInstalled: function () {},
        installState: function () { return 'not_installed'; },
        runningState: function () { return 'cannot_run'; },
      };
    }
    window.chrome.csi = window.chrome.csi || function () {
      return { startE: Date.now(), onloadT: Date.now(), pageT: Math.round(performance.now()), tran: 15 };
    };
    window.chrome.loadTimes = window.chrome.loadTimes || function () {
      const now = Date.now() / 1000;
      return { requestTime: now, startloadTime: now, commitLoadTime: now, finishDocumentLoadTime: now, finishLoadTime: now, firstPaintTime: now, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
    };
  } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const mime = () => ({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null });
      const make = (name) => {
        const m = mime();
        const p = { name: name, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, 0: m, item: function () { return m; }, namedItem: function () { return m; } };
        m.enabledPlugin = p;
        return p;
      };
      const list = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'].map(make);
      const plugins = { length: list.length, item: function (i) { return list[i] || null; }, namedItem: function (n) { return list.find(function (p) { return p.name === n; }) || null; }, refresh: function () {} };
      list.forEach(function (p, i) { plugins[i] = p; });
      Object.defineProperty(navigator, 'plugins', { get: function () { return plugins; } });
      const pdf = list[0][0];
      const mimeTypes = { length: 1, 0: pdf, item: function () { return pdf; }, namedItem: function (t) { return t === 'application/pdf' ? pdf : null; } };
      Object.defineProperty(navigator, 'mimeTypes', { get: function () { return mimeTypes; } });
    }
  } catch (e) {}
  try { document.hasFocus = function () { return true; }; } catch (e) {}
  try {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { get: function () { return { enumerateDevices: function () { return Promise.resolve([]); } }; } });
    }
  } catch (e) {}
  try {
    const vendor = '__GL_VENDOR__';
    const renderer = '__GL_RENDERER__';
    const patch = function (proto) {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        // Only the SOFTWARE fallback needs covering: when the real GPU stack
        // is up (full build) the genuine vendor/renderer is already the best
        // possible answer and must pass through untouched.
        const v = orig.call(this, p);
        try {
          if (typeof v === 'string' && /swiftshader/i.test(v)) {
            if (p === 37445) return vendor;
            if (p === 37446) return renderer;
          }
        } catch (e) {}
        return v;
      };
    };
    if (window.WebGLRenderingContext) patch(window.WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(window.WebGL2RenderingContext.prototype);
  } catch (e) {}
  try {
    if (!window.outerWidth) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
    }
  } catch (e) {}
})();"#;

/// `Emulation.setUserAgentOverride` params that make the headless browser
/// present as the ordinary Chrome it is built from.
///
/// A headless Chromium announces itself as `HeadlessChrome` in the User-Agent
/// header AND in the `Sec-CH-UA` client hints, which sites such as Instagram
/// treat as an automated client — a correct login is then answered with the
/// generic "login information is incorrect". Both are rewritten from the
/// browser's own `Browser.getVersion` reply, so the version always matches the
/// binary that is really running. Pure so it is unit-testable.
fn ua_override(version: &Value) -> Option<Value> {
    let ua = version["userAgent"].as_str()?;
    // `product` is `HeadlessChrome/140.0.7339.82` (or `Chrome/...`).
    let full = version["product"]
        .as_str()
        .and_then(|p| p.split('/').nth(1))
        .filter(|v| !v.is_empty())?
        .to_string();
    let major = full.split('.').next().unwrap_or_default().to_string();
        let mut params = json!({
            "userAgent": ua.replace("HeadlessChrome", "Chrome"),
            "acceptLanguage": "en-US,en",
        });
        // Client hints describe the OS, so they are only filled in for the platform
        // this build actually runs on; elsewhere the plain UA rewrite is still safe.
        if cfg!(target_os = "macos") {
            params["platform"] = json!("MacIntel");
            let brands = json!([
                {"brand": "Chromium", "version": major},
                {"brand": "Not=A?Brand", "version": "24"},
                {"brand": "Google Chrome", "version": major},
            ]);
            let full_list = json!([
                {"brand": "Chromium", "version": full},
                {"brand": "Not=A?Brand", "version": "24.0.0.0"},
                {"brand": "Google Chrome", "version": full},
            ]);
            params["userAgentMetadata"] = json!({
                "brands": brands,
                "fullVersionList": full_list,
                "fullVersion": full,
                "platform": "macOS",
                "platformVersion": macos_platform_version(),
            "architecture": if cfg!(target_arch = "aarch64") { "arm" } else { "x86" },
            "bitness": "64",
            "model": "",
            "mobile": false,
            "wow64": false,
        });
    }
    Some(params)
}

/// Apply the browser-matched User-Agent to a freshly attached tab session.
/// Best effort: a failure leaves the browser's own identity in place.
async fn apply_user_agent(cdp: &mut Cdp, session: &str) {
    if cdp.ua.is_none() {
        // Browser-level call: no session.
        cdp.session = None;
        if let Ok(v) = cdp.send("Browser.getVersion", json!({})).await {
            cdp.ua = ua_override(&v);
        }
    }
    cdp.session = Some(session.to_string());
    // Page domain commands need Page.enable on this session — measured:
    // addScriptToEvaluateOnNewDocument registered WITHOUT it replies fine but
    // never fires, so every new document ran unpatched (UA fix and all).
    let _ = cdp.send("Page.enable", json!({})).await;
    if let Some(params) = cdp.ua.clone() {
        let _ = cdp.send("Emulation.setUserAgentOverride", params).await;
    }
    let _ = cdp
        .send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": consistency_js()}),
        )
        .await;
}

/// Run one batch on the shared connection. On a transport-level failure the
/// connection (and the session cache) is dropped and the batch is replayed
/// once — the same "fresh connection" recovery the per-call design had for
/// free, without paying a reconnect on every success.
async fn run_batch(
    conn: &mut Option<Cdp>,
    sessions: &mut std::collections::HashMap<String, String>,
    screencast_on: &mut std::collections::HashSet<String>,
    batch: &CdpBatch,
) -> Result<Vec<Value>, String> {
    for attempt in 0..2 {
        if conn.is_none() {
            let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
            *conn = Some(Cdp::connect(port).await?);
        }
        let cdp = conn.as_mut().expect("connection just checked");
        match &batch.target {
            Some(target_id) => {
                let session = match sessions.get(target_id) {
                    Some(s) => s.clone(),
                    None => {
                        let res = cdp
                            .send(
                                "Target.attachToTarget",
                                json!({"targetId": target_id, "flatten": true}),
                            )
                            .await?;
                        let s = res["sessionId"]
                            .as_str()
                            .ok_or_else(|| "attachToTarget returned no sessionId".to_string())?
                            .to_string();
                        sessions.insert(target_id.clone(), s.clone());
                        apply_user_agent(cdp, &s).await;
                        // A freshly attached POPUP's first document predates
                        // this session, so addScriptToEvaluateOnNewDocument
                        // never ran inside it. Re-run the consistency script
                        // IN the live document — a reload here was tried and
                        // is wrong: it fires exactly when the user starts
                        // clicking/typing and wipes their focus mid-flow.
                        // Future documents get the script via the registration.
                        if popup_root_of(target_id).is_some() {
                            let _ = cdp
                                .send(
                                    "Runtime.evaluate",
                                    json!({"expression": consistency_js()}),
                                )
                                .await;
                        }
                        s
                    }
                };
                cdp.session = Some(session.clone());
                // Push frames for this tab once per session: the panel's
                // long-poll then renders on every page repaint with no capture
                // round trip at all.
                if !screencast_on.contains(&session) {
                    let _ = cdp
                        .send(
                            "Page.startScreencast",
                            json!({
                                "format": "jpeg",
                                "quality": SCREENSHOT_QUALITY,
                                "maxWidth": 4096,
                                "maxHeight": 4096,
                                "everyNthFrame": 1,
                            }),
                        )
                        .await;
                    screencast_on.insert(session.clone());
                }
                // Only the DISPLAYED page may push frames. While a popup is on
                // screen its opener tab still screencasts — for a live-chart
                // page like TradingView that is a firehose of frames nobody
                // displays, all serialized through this one socket, and the
                // popup's own click/keystroke batches queue behind megabytes
                // of them (measured as "the popup works but seconds late").
                // Silence the opener while its popup is displayed; the normal
                // `!screencast_on` path restarts it the moment the panel is
                // back on the tab.
                if let Some(root_id) = popup_root_of(target_id) {
                    if let Some(root_session) = sessions.get(&root_id) {
                        if screencast_on.contains(root_session) {
                            let saved = cdp.session.clone();
                            cdp.session = Some(root_session.clone());
                            let _ = cdp.send("Page.stopScreencast", json!({})).await;
                            cdp.session = saved;
                            screencast_on.remove(root_session);
                        }
                    }
                }
            }
            None => cdp.session = None,
        }
        let mut calls: Vec<(&'static str, Value)> = Vec::new();
        // Re-send the override only when this session does not hold it yet
        // (first use, or the tab's size changed) — not on every input event.
        let mut prepended = false;
        if batch.with_viewport {
            let held = cdp
                .session
                .as_ref()
                .and_then(|s| cdp.applied_vp.get(s))
                .copied();
            if held != Some(batch.viewport) {
                calls = with_viewport_override(batch.viewport.0, batch.viewport.1, calls);
                prepended = true;
            }
        }
        calls.extend(batch.commands.iter().cloned());
        let mut out = Vec::with_capacity(calls.len());
        let mut failure = None;
        for (method, params) in calls {
            match cdp.send(method, params).await {
                Ok(v) => out.push(v),
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        match failure {
            None => {
                // The override's own reply is bookkeeping, not a result: strip
                // it so callers reading `out[0]` see the FIRST COMMAND's reply
                // (a missing strip made screenshot/current_url read the
                // override's ack and report "empty screenshot" forever).
                if prepended && !out.is_empty() {
                    out.remove(0);
                    if let Some(s) = cdp.session.clone() {
                        cdp.applied_vp.insert(s, batch.viewport);
                    }
                }
                // A batch that carries its own override (set_viewport) also
                // updates what the session holds.
                for (method, params) in &batch.commands {
                    if *method == "Emulation.setDeviceMetricsOverride" {
                        if let (Some(s), Some(w), Some(h)) = (
                            cdp.session.clone(),
                            params["width"].as_u64(),
                            params["height"].as_u64(),
                        ) {
                            cdp.applied_vp.insert(s, (w as u32, h as u32));
                        }
                    }
                }
                flush_frames(cdp, sessions);
                return Ok(out);
            }
            Some(e) if attempt == 0 && is_transport_error(&e) => {
                *conn = None;
                sessions.clear();
                screencast_on.clear();
                continue;
            }
            Some(e) => return Err(e),
        }
    }
    Err("cdp retry exhausted".to_string())
}

/// Submit one batch to the shared connection and wait for the result.
fn cdp_batch(
    target: Option<&Tab>,
    with_viewport: bool,
    commands: Vec<(&'static str, Value)>,
) -> Result<Vec<Value>, String> {
    let tx = cdp_pool()?;
    let (reply, rx) = std::sync::mpsc::channel();
    let batch = CdpBatch {
        target: target.map(|t| t.target_id.clone()),
        viewport: target.map(|t| t.viewport).unwrap_or(DEFAULT_VIEWPORT),
        with_viewport,
        commands,
        reply,
    };
    // `try_send` (not an await): every caller of this fn sits in sync code on
    // an async runtime. A full queue means the driver is hopelessly behind —
    // erroring one stale batch beats buffering minutes of them.
    tx.try_send(batch)
        .map_err(|_| "the cdp driver is not accepting work".to_string())?;
    // Cdp::send already bounds every command at CDP_TIMEOUT; the headroom only
    // covers queueing behind the batches ahead of this one.
    match rx.recv_timeout(CDP_TIMEOUT + Duration::from_secs(5)) {
        Ok(res) => res,
        Err(_) => Err("the cdp driver did not answer in time".to_string()),
    }
}

/// Run a sequence of CDP commands against `tab` with the tab's emulated
/// viewport re-applied first (screenshots and input need the coordinate space).
fn cdp_calls(tab: &Tab, calls: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    cdp_batch(Some(tab), true, calls)
}

/// Same batch with explicit control over the viewport override: navigation
/// must not drag the emulated size into the next page's first paint, while
/// `Emulation.setDeviceMetricsOverride` itself rides in its own batch.
fn cdp_calls_on(
    tab: &Tab,
    calls: Vec<(&'static str, Value)>,
    with_viewport: bool,
) -> Result<Vec<Value>, String> {
    cdp_batch(Some(tab), with_viewport, calls)
}

/// Browser-level commands (no tab session): target discovery, creation, close.
fn cdp_browser_batch(commands: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    cdp_batch(None, false, commands)
}

// ---------------------------------------------------------------------------
// Pushed frames (Page.startScreencast)
// ---------------------------------------------------------------------------
//
// Polling Page.captureScreenshot cost a forced capture + JPEG encode on every
// panel tick and serialized against input on the shared connection — the
// click/keystroke feedback could never beat ~a capture time. Screencast flips
// it around: Chromium pushes a frame on every page REPAINT (a keystroke, a
// hover state, a navigation), the driver caches the latest one and acks it,
// and /browser/frame long-polls until something newer exists. Idle pages push
// nothing, so the idle cost is zero.

/// Latest pushed frame of a tab: a monotonically increasing sequence (the
/// panel sends back the seq it has seen) plus the JPEG data URI.
struct LiveFrame {
    seq: u64,
    image: String,
}

/// One GLOBAL sequence across every target's frames. The panel's long-poll
/// carries `after` = the last seq it rendered, and the VISIBLE target can
/// switch underneath it (a popup opening): with a per-target counter the
/// popup's first frame (seq 1) could never beat the tab's last seq (57), and
/// the panel stayed frozen on the old page forever — "clicked the button and
/// it just stayed there" while the URL bar already showed the popup. One
/// shared counter makes every switch strictly newer.
static FRAME_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Frames keyed by target id, each with a notify that wakes long-polls.
/// `Option` (not a lazy cell) so the static stays `const`-constructible.
static FRAMES: Mutex<
    Option<std::collections::HashMap<String, (LiveFrame, std::sync::Arc<tokio::sync::Notify>)>>,
> = Mutex::new(None);

/// Cache one pushed frame and wake anything waiting for it.
fn store_frame(target_id: &str, image: &str) {
    let Ok(mut guard) = FRAMES.lock() else {
        return;
    };
    let map = guard.get_or_insert_with(Default::default);
    let entry = map.entry(target_id.to_string()).or_insert_with(|| {
        (
            LiveFrame {
                seq: 0,
                image: String::new(),
            },
            std::sync::Arc::new(tokio::sync::Notify::new()),
        )
    });
    entry.0.seq = FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    entry.0.image = image.to_string();
    entry.1.notify_waiters();
}

/// `(seq, image)` of a tab's cached frame, when one exists.
fn peek_frame(target_id: &str) -> Option<(u64, String)> {
    let guard = FRAMES.lock().ok()?;
    guard
        .as_ref()?
        .get(target_id)
        .map(|f| (f.0.seq, f.0.image.clone()))
}

/// The notify a long-poll should wait on, or None when nothing is cached yet.
fn frame_notify(target_id: &str) -> Option<std::sync::Arc<tokio::sync::Notify>> {
    let guard = FRAMES.lock().ok()?;
    guard.as_ref()?.get(target_id).map(|f| f.1.clone())
}

/// Forget a tab's frame (tab closed or browser gone).
fn drop_frame(target_id: &str) {
    if let Ok(mut guard) = FRAMES.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(target_id);
        }
    }
    drop_pushed(target_id);
}

/// Forget every cached frame.
fn drop_all_frames() {
    if let Ok(mut guard) = FRAMES.lock() {
        *guard = None;
    }
}

/// Targets that have received at least one GENUINE pushed frame. A tab whose
/// frames only ever come from the forced-capture fallback (a build without
/// screencast support, say) reports `pushed: false` so the panel can fall back
/// to capture polling instead of waiting on a push that never comes.
static PUSHED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

fn mark_pushed(target_id: &str) {
    if let Ok(mut guard) = PUSHED.lock() {
        guard
            .get_or_insert_with(Default::default)
            .insert(target_id.to_string());
    }
}

fn is_pushed(target_id: &str) -> bool {
    PUSHED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.contains(target_id)))
        .unwrap_or(false)
}

fn drop_pushed(target_id: &str) {
    if let Ok(mut guard) = PUSHED.lock() {
        if let Some(set) = guard.as_mut() {
            set.remove(target_id);
        }
    }
}

/// Long-poll one frame for the panel: answers the moment Chromium pushes a
/// frame newer than `after`, else falls back to one forced capture when the
/// cache is empty, else times out quietly (the panel just asks again).
pub async fn frame(chat_id: &str, after: u64) -> Value {
    let chat = normalize_chat(chat_id);
    // Popup discovery rides the panel's poll loop (throttled inside); the
    // blocking CDP read stays off the async workers, same rule as the seed
    // capture below.
    let _ = tokio::task::spawn_blocking(sync_popups).await;
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let target = tab.target_id.clone();
    if peek_frame(&target).is_none() {
        // Nothing cached yet — a fresh panel (or the first moment after
        // attach, before the first push). One forced capture seeds the cache
        // AND starts the screencast (the capture batch opens the session).
        let chat_for_shot = chat.clone();
        let shot = tokio::task::spawn_blocking(move || screenshot(&chat_for_shot))
            .await
            .unwrap_or(Value::Null);
        if let Some(img) = shot.get("image").and_then(Value::as_str) {
            store_frame(&target, img);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    let pushed = is_pushed(&target);
    loop {
        if let Some((seq, image)) = peek_frame(&target) {
            if seq > after {
                return json!({
                    "ok": true,
                    "pushed": pushed,
                    "seq": seq,
                    "image": image,
                    "width": tab.viewport.0,
                    "height": tab.viewport.1,
                });
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // Nothing newer within the window: an empty frame tells the panel
            // to simply ask again (the page has not repainted).
            return json!({
                "ok": true,
                "pushed": pushed,
                "seq": after,
                "image": Value::Null,
                "width": tab.viewport.0,
                "height": tab.viewport.1,
            });
        }
        // Register interest BEFORE re-peeking so a frame pushed between the
        // peek and the wait cannot be missed, then wait bounded.
        if let Some(notify) = frame_notify(&target) {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some((seq, image)) = peek_frame(&target) {
                if seq > after {
                    return json!({
                        "ok": true,
                        "pushed": pushed,
                        "seq": seq,
                        "image": image,
                        "width": tab.viewport.0,
                        "height": tab.viewport.1,
                    });
                }
            }
            let _ = tokio::time::timeout(remaining, notified).await;
        } else {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
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
            invalidate_cdp_pool();
            forget_all_tabs();
        }
    }
    match guard.as_mut() {
        Some(b) => {
            // A crashed process must never look active.
            if b.child.try_wait().ok().flatten().is_some() {
                let mut dead = guard.take().expect("browser entry just checked");
                let _ = dead.child.kill();
                invalidate_cdp_pool();
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
    drop_all_frames();
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
        invalidate_cdp_pool();
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

/// The UA to pin at launch, from the binary's own `--version` output
/// ("Google Chrome for Testing 156.0.8078.80" → the last token), so the pinned
/// version always matches the binary — and with it its own client hints.
/// `None` when the binary does not answer (Windows GUI builds sometimes print
/// nothing): the per-session override then stays the only UA fix.
fn chrome_user_agent(bin: &std::path::Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text.trim().rsplit(' ').next()?.trim();
    if version.is_empty() || !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    let platform = if cfg!(target_os = "macos") {
        // Chrome freezes the macOS UA at 10_15_7 even on newer releases.
        "Macintosh; Intel Mac OS X 10_15_7"
    } else if cfg!(target_os = "windows") {
        "Windows NT 10.0; Win64; x64"
    } else {
        "X11; Linux x86_64"
    };
    Some(format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36"
    ))
}

/// The REAL macOS version for high-entropy client hints: Chrome freezes the
/// UA string at 10_15_7 but reports the true OS version in `platformVersion` —
/// a hardcoded old value there is itself a mismatch Google can read.
fn macos_platform_version() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "14.5.0".to_string())
        })
        .clone()
}

/// Start the shared Chromium against `profile`. stderr is captured to a file so
/// a startup failure can be REPORTED instead of surfacing as a bare timeout.
fn try_launch(
    bin: &std::path::Path,
    port: u16,
    profile: &std::path::Path,
    ua: Option<&str>,
) -> Result<Child, String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("cannot create profile dir: {e}"))?;
    clear_stale_profile_lock(profile);
    let err_file = std::fs::File::create(profile.join("chromium-stderr.log"))
        .map_err(|e| format!("cannot open chromium log: {e}"))?;
    let mut cmd = Command::new(bin);
    cmd.args(launch_args(bin, port, profile, ua))
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
///
/// Tries EVERY installed build, best first (the full Chrome-for-Testing from
/// the one-click install, then the Playwright headless shell, ...): a build
/// that cannot START here must not take the whole browser feature down — the
/// full build's helper processes, for one, fail to spawn inside a daemon or
/// sandboxed context (GPU process launch 1003 → "GPU process isn't usable.
/// Goodbye.") while the headless shell runs fine in the same context. The
/// first build whose debugging port answers wins; per-build errors are
/// collected so a total failure still explains itself.
fn spawn_browser() -> Result<u16, String> {
    // A browser left by a previous run (crash, forced quit) still holds the
    // profile and lock files; clear it before starting ours.
    reap_orphans();
    // An install unpacked by an older build can be missing the executable bit
    // on Chrome's INTERNAL helpers (crashpad handler, Helper apps) even though
    // the main binary runs — every launch then spawns a fork child that dies
    // pre-exec and macOS pops a crash dialog. Re-grant the bits on every
    // installed build before probing candidates; a no-op once fixed.
    for root in browser_roots() {
        for dir in candidate_dirs(&root) {
            make_executable(&dir);
        }
    }
    let candidates = chromium_candidates();
    if candidates.is_empty() {
        return Err(
            "no automation browser installed — install the built-in one from the \
             Browser panel (or run `npx playwright install chromium`)"
                .to_string(),
        );
    }
    let port = pick_port()?;
    let profile = profile_dir();
    let mut failures: Vec<String> = Vec::new();
    for bin in &candidates {
        let ua = chrome_user_agent(bin);
        let mut child = match try_launch(bin, port, &profile, ua.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                failures.push(format!("{}: {e}", bin.display()));
                continue;
            }
        };
        if let Err(e) = wait_for_port(&mut child, port, &profile) {
            // `wait_for_port` kills the child when the port never opens; the
            // explicit `wait` keeps it from becoming a zombie. A failed child
            // may also have left the profile lock wedged — clear it before the
            // next candidate inherits the same profile.
            let _ = child.kill();
            let _ = child.wait();
            clear_stale_profile_lock(&profile);
            failures.push(format!("{}: {e}", bin.display()));
            continue;
        }
        // A build whose helper processes cannot spawn here (the full build's
        // GPU process in a daemon/sandboxed context) binds its debugging port,
        // then DIES the moment the first page needs compositing — the port
        // alone is not proof of health. Wait one settle beat, then demand a
        // REAL round trip on a short-lived browser-level connection
        // (independent of the not-yet-registered BROWSER state): create a
        // page, attach, and capture one frame — exactly the work that dies.
        std::thread::sleep(Duration::from_millis(1200));
        let died = child.try_wait().ok().flatten().is_some();
        let health_port = port;
        let healthy = !died
            && block_on(async move {
                let mut cdp = Cdp::connect(health_port).await?;
                let res = cdp
                    .send(
                        "Target.createTarget",
                        json!({"url": "about:blank#health"}),
                    )
                    .await?;
                let id = res["targetId"]
                    .as_str()
                    .ok_or_else(|| "no targetId".to_string())?
                    .to_string();
                let attached = cdp
                    .send(
                        "Target.attachToTarget",
                        json!({"targetId": id, "flatten": true}),
                    )
                    .await?;
                cdp.session = Some(
                    attached["sessionId"]
                        .as_str()
                        .ok_or_else(|| "no sessionId".to_string())?
                        .to_string(),
                );
                let shot = cdp
                    .send(
                        "Page.captureScreenshot",
                        json!({"format": "jpeg", "quality": 40}),
                    )
                    .await;
                let _ = cdp
                    .send("Target.closeTarget", json!({"targetId": id}))
                    .await;
                shot.map(|v| v["data"].as_str().is_some())
                    .map_err(|e| format!("capture failed: {e}"))
            })
            .unwrap_or(false);
        if !healthy {
            let _ = child.kill();
            let _ = child.wait();
            clear_stale_profile_lock(&profile);
            failures.push(format!(
                "{}: debugging port opened but the browser did not survive startup",
                bin.display()
            ));
            continue;
        }
        let mut guard = BROWSER.lock().map_err(|_| "browser lock poisoned")?;
        // A previous process (e.g. a crashed one) is replaced.
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        // A brand-new Chromium: the pooled connection (if any) points at the
        // dead process, so the next call starts a fresh driver.
        invalidate_cdp_pool();
        drop_all_frames();
        *guard = Some(BrowserProc {
            child,
            port,
            last_used: Instant::now(),
        });
        return Ok(port);
    }
    Err(failures.join("; "))
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
fn ensure_tab(chat: &str) -> Result<Tab, String> {
    // Reading the tab refreshes its idle clock (`existing_tab` does that), which
    // is exactly right: the agent asking for the tab IS the tab being in use, so
    // the per-tab reaper must not close it between two tool calls.
    if let Some(tab) = existing_tab(chat) {
        if tab_usable(&tab.target_id) {
            return Ok(tab);
        }
        TABS.lock()
            .ok()
            .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    }
    ensure_browser()?;
    let out = cdp_browser_batch(vec![(
        "Target.createTarget",
        json!({"url": "about:blank"}),
    )])?;
    let target_id = out
        .into_iter()
        .next()
        .and_then(|v| v["targetId"].as_str().map(str::to_string))
        .ok_or_else(|| "Target.createTarget returned no targetId".to_string())?;
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
fn tab_usable(target_id: &str) -> bool {
    if alive_port().is_none() {
        return false;
    }
    match cdp_browser_batch(vec![(
        "Target.getTargetInfo",
        json!({"targetId": target_id}),
    )]) {
        Ok(out) => out
            .into_iter()
            .next()
            .map(|res| res["targetInfo"]["targetId"].as_str() == Some(target_id))
            .unwrap_or(false),
        Err(_) => false,
    }
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

    /// Every PAGE target in the shared browser as
    /// `(target_id, url, opener_target_id)`.
    ///
    /// `Target.getTargets` is a browser-level call (no `sessionId` needed), so
    /// it rides the shared connection. An error or a dead browser yields an
    /// empty list rather than failing the caller. The opener id is empty for
    /// targets no other page opened (chat tabs, `Target.createTarget` pages);
    /// it is what ties a `window.open` popup back to the tab that opened it.
    fn page_targets() -> Vec<(String, String, String)> {
        let Ok(out) = cdp_browser_batch(vec![("Target.getTargets", json!({}))]) else {
            return Vec::new();
        };
        out.into_iter()
            .next()
            .and_then(|res| {
                res["targetInfos"].as_array().map(|a| {
                    a.iter()
                        .filter_map(|t| {
                            if t["type"].as_str() != Some("page") {
                                return None;
                            }
                            // CDP's TargetInfo spells the key `targetId` (the
                            // legacy `/json/list` HTTP endpoint uses `id`); a
                            // miss here silently emptied the list and made
                            // adoption a no-op.
                            let id = t["targetId"]
                                .as_str()
                                .or_else(|| t["id"].as_str())?
                                .to_string();
                            let url = t["url"].as_str().unwrap_or_default().to_string();
                            let opener =
                                t["openerId"].as_str().unwrap_or_default().to_string();
                            Some((id, url, opener))
                        })
                        .collect()
                })
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
fn adopt(chat: &str) -> Option<Tab> {
    let registered = existing_tab(chat);
    let targets = page_targets();
    if targets.is_empty() {
        // Browser down (or a unit-test registry): nothing to adopt.
        return registered;
    }
    // The chat's own tab already shows a real page — the common case, and the
    // one that must stay cheap.
    if let Some(tab) = &registered {
        let real = targets
            .iter()
            .find(|(id, _, _)| id == &tab.target_id)
            .map(|(_, url, _)| !is_blank_page_url(url))
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
    let popups: Vec<String> = POPUPS
        .lock()
        .ok()
        .map(|p| p.iter().map(|x| x.target_id.clone()).collect())
        .unwrap_or_default();
    let Some(target_id) = targets
        .iter()
        .find(|(id, url, opener)| {
            !is_blank_page_url(url)
                && !claimed.contains(id)
                && !popups.contains(id)
                // A POPUP of a claimed tab (or of a known popup) belongs to
                // that chat's flow — an OAuth window mid-login must never be
                // stolen by whichever chat currently has no real page.
                && !(claimed.contains(opener) || popups.contains(opener))
        })
        .map(|(id, _, _)| id.clone())
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

/// Root chat-tab target of a popup chain, given the live target list
/// `(id, url, opener)` and the registered chat-tab ids.
///
/// A popup opened by a POPUP (some flows do) rolls up to the same chat tab.
/// `None` when the chain leaves the app's own tabs — a foreign CDP client's
/// popup tree is none of the panel's business — or is absurdly deep. Pure so
/// the walk is unit-testable without a browser.
fn popup_root(id: &str, targets: &[(String, String, String)], claimed: &[String]) -> Option<String> {
    let mut cur = id.to_string();
    for _ in 0..8 {
        let (_, _, opener) = targets.iter().find(|(tid, _, _)| *tid == cur)?;
        if opener.is_empty() {
            // `cur` is itself a root: `id` was never a popup.
            return None;
        }
        if claimed.contains(opener) {
            return Some(opener.clone());
        }
        cur = opener.clone();
    }
    None
}

/// How often the panel's poll paths re-read the target list for popup
/// discovery. The pushed `Target.targetDestroyed` events already snap the
/// registry when a popup CLOSES; this cadence bounds how long a popup that
/// OPENS can stay invisible (one poll cycle, ~1s).
const POPUP_SYNC_MIN: Duration = Duration::from_millis(400);
static LAST_POPUP_SYNC: Mutex<Option<Instant>> = Mutex::new(None);

/// Bring `POPUPS` in step with what Chromium actually has.
///
/// `window.open` (TradingView's "Continue with Google", every OAuth button) is
/// answered by Chromium with a SECOND target that the opener reaches through
/// `window.opener`. Nothing used to look at it, so login popups ran invisibly.
/// This re-reads the browser-level target list and registers every page whose
/// opener chain lands on a registered chat tab; the panel then displays the
/// newest live popup instead of the tab (`with_visible_popup`).
///
/// Callers sit on blocking contexts (the `/browser/*` handlers' spawn_blocking
/// pool, or `frame`'s seed path) — never directly on an async worker.
fn sync_popups() {
    // Panel polls arrive in pairs (status + frame) a few hundred ms apart;
    // one target re-read per `POPUP_SYNC_MIN` is plenty for both.
    if let Ok(mut last) = LAST_POPUP_SYNC.lock() {
        if last.map(|t| t.elapsed() < POPUP_SYNC_MIN).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
    }
    let targets = page_targets();
    if targets.is_empty() {
        // Browser down (or no targets at all): nothing can be alive.
        if let Ok(mut popups) = POPUPS.lock() {
            let gone: Vec<String> = popups.drain(..).map(|p| p.target_id).collect();
            for id in gone {
                drop_frame(&id);
            }
        }
        return;
    }
    let claimed: Vec<String> = TABS
        .lock()
        .ok()
        .map(|t| t.iter().map(|(_, x)| x.target_id.clone()).collect())
        .unwrap_or_default();
    let discovered: Vec<Popup> = targets
        .iter()
        .filter(|(id, _, opener)| !opener.is_empty() && !claimed.contains(id))
        .filter_map(|(id, _, _)| {
            popup_root(id, &targets, &claimed).map(|root| Popup {
                target_id: id.clone(),
                root,
            })
        })
        .collect();
    if let Ok(mut popups) = POPUPS.lock() {
        // Keep the discovery order stable (oldest first, "newest wins" for the
        // display) and forget frames of popups that went away.
        let mut merged: Vec<Popup> = popups
            .iter()
            .filter_map(|old| {
                discovered
                    .iter()
                    .find(|d| d.target_id == old.target_id)
                    .cloned()
            })
            .collect();
        for d in &discovered {
            if !merged.iter().any(|m| m.target_id == d.target_id) {
                merged.push(d.clone());
            }
        }
        let gone: Vec<String> = popups
            .iter()
            .filter(|old| !merged.iter().any(|m| m.target_id == old.target_id))
            .map(|old| old.target_id.clone())
            .collect();
        *popups = merged;
        for id in gone {
            // A dropped entry is either a popup Chromium already closed (its
            // target is gone — nothing to do) or one that OUTLIVED its root
            // (root reaped/closed first): close the straggler so no invisible
            // renderer lingers holding the profile.
            if targets.iter().any(|(tid, _, _)| *tid == id) {
                let _ = cdp_browser_batch(vec![(
                    "Target.closeTarget",
                    json!({"targetId": id}),
                )]);
            }
            drop_frame(&id);
        }
    }
}

/// Root chat-tab target of `target_id` when it is a live popup, else None.
/// Used by the CDP driver to silence an opener tab's screencast while one of
/// its popups owns the display.
fn popup_root_of(target_id: &str) -> Option<String> {
    let popups = POPUPS.lock().ok()?;
    popups
        .iter()
        .find(|p| p.target_id == target_id)
        .map(|p| p.root.clone())
}

/// Target id of the chat's live popup to display instead of `root`, if any.
/// The NEWEST popup wins (a second `window.open` replaces the first on
/// screen); when it closes the view falls back to any older one, then to the
/// tab itself.
fn visible_popup(root: &str) -> Option<String> {
    let popups = POPUPS.lock().ok()?;
    popups
        .iter()
        .rev()
        .find(|p| p.root == root)
        .map(|p| p.target_id.clone())
}

/// The chat's tab with the display swapped to its live popup, if one is open.
///
/// Only the CDP target changes: the viewport stays the chat's own, and every
/// batch re-applies it to whichever target is visible, so frames and click
/// coordinates keep one coordinate space across the swap.
fn with_visible_popup(mut tab: Tab) -> Tab {
    if let Some(popup) = visible_popup(&tab.target_id) {
        tab.target_id = popup;
    }
    tab
}

/// The chat's registered tab as the PANEL should see it (no discovery — input
/// calls stay cheap; the poll paths refresh the registry).
fn panel_tab(chat: &str) -> Option<Tab> {
    existing_tab(chat).map(with_visible_popup)
}

/// ADOPT a page another CDP client opened when the chat has nothing real to
/// show, then follow the chat's own popups. Deliberately used ONLY by
/// `launch`/`status`/`screenshot`: those three run on the panel's polling
/// path, so when one of them adopts a foreign page it is registered for the
/// chat and every other `/browser/*` call follows it automatically — no other
/// call site needs to know about adoption.
fn active_tab(chat: &str) -> Option<Tab> {
    sync_popups();
    adopt(chat).map(with_visible_popup)
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
    // Close each stale target through the shared connection. One batch per
    // target: a target that is ALREADY gone errors the batch, and a batch that
    // stops at its first error must not skip the remaining targets.
    for (chat, target) in &stale {
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": target}),
        )]);
        drop_frame(target);
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

// ---------------------------------------------------------------------------
// Session cookie import ("log in outside, keep the session inside")
// ---------------------------------------------------------------------------

/// One pasted cookie ready for `Network.setCookie`.
#[derive(Clone, Debug, PartialEq)]
struct PastedCookie {
    name: String,
    value: String,
}

/// Set-Cookie attribute names that must never become a cookie when the user
/// pastes a whole `Set-Cookie:` header line.
const COOKIE_ATTRS: [&str; 8] = [
    "path",
    "domain",
    "expires",
    "max-age",
    "secure",
    "httponly",
    "samesite",
    "partitioned",
];

/// Parse what the user pasted into the import dialog. Accepted shapes, most
/// specific first:
///   * a JSON array of DevTools-style cookie objects (`[{"name": ..., "value": ...}]`);
///   * `name=value; name2=value2` — the shape of `document.cookie` / a
///     `Cookie:` header / a `Set-Cookie:` line (attributes are dropped);
///   * one bare token with no `=` — treated as the `sessionid` value, the one
///     cookie an Instagram session needs.
/// Later duplicates of the same name win (the paste's own intent).
fn parse_cookie_blob(raw: &str) -> Vec<PastedCookie> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    // JSON array of cookie objects (the "EditThisCookie"-style export).
    if raw.starts_with('[') {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(raw) {
            let out: Vec<PastedCookie> = items
                .iter()
                .filter_map(|c| {
                    let name = c["name"].as_str()?.trim().to_string();
                    let value = c["value"].as_str()?.to_string();
                    (!name.is_empty()).then_some(PastedCookie { name, value })
                })
                .collect();
            if !out.is_empty() {
                return dedupe_cookies(out);
            }
        }
    }
    // name=value pairs. No `=` anywhere: a single bare token is the sessionid
    // value itself.
    if !raw.contains('=') {
        return vec![PastedCookie {
            name: "sessionid".to_string(),
            value: raw.to_string(),
        }];
    }
    let out: Vec<PastedCookie> = raw
        .split(';')
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            let name = name.trim().to_string();
            if name.is_empty() || COOKIE_ATTRS.contains(&name.to_ascii_lowercase().as_str()) {
                return None;
            }
            Some(PastedCookie {
                name,
                value: value.trim().to_string(),
            })
        })
        .collect();
    dedupe_cookies(out)
}

/// Keep the LAST value for every name (a paste that repeats a cookie means
/// "the later one is the current one").
fn dedupe_cookies(cookies: Vec<PastedCookie>) -> Vec<PastedCookie> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<PastedCookie> = Vec::with_capacity(cookies.len());
    for c in cookies {
        match seen.get(&c.name) {
            Some(&i) => out[i] = c,
            None => {
                seen.insert(c.name.clone(), out.len());
                out.push(c);
            }
        }
    }
    out
}

/// Import pasted session cookies into the shared browser profile.
///
/// The paste flow exists for sites whose server-side bot defenses reject even
/// a perfectly presented login form from an automation browser — Instagram
/// above all. Importing the user's OWN session cookie is ordinary multi-device
/// behavior: no password is typed into the virtual browser, so there is no
/// failed-login signal, and the cookie lands in the same persistent profile
/// the in-app logins live in.
pub fn import_cookies(chat_id: &str, domain: &str, raw: &str) -> Value {
    let cookies = parse_cookie_blob(raw);
    if cookies.is_empty() {
        return json!({"ok": false, "error": "no cookies found in the paste"});
    }
    let host = domain
        .trim()
        .split("://")
        .last()
        .unwrap_or_default()
        .trim_matches('/')
        .trim_start_matches('.')
        .to_string();
    if host.is_empty() || !host.contains('.') {
        return json!({"ok": false, "error": "a domain like instagram.com is required"});
    }
    let chat = normalize_chat(chat_id);
    // The setCookie call rides a tab's CDP session; cookies are browser-global
    // once set, so the choice of tab does not matter — any live one works.
    let tab = match existing_tab(&chat) {
        Some(t) if tab_usable(&t.target_id) => t,
        _ => match ensure_tab(&chat) {
            Ok(t) => t,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    // One year out: a session-scoped cookie would vanish with the browser,
    // and the paste came from a long-lived login.
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 365 * 24 * 3600;
    let mut calls: Vec<(&'static str, Value)> = vec![("Network.enable", json!({}))];
    let mut names = Vec::new();
    for c in &cookies {
        calls.push((
            "Network.setCookie",
            json!({
                "name": c.name,
                "value": c.value,
                "domain": format!(".{host}"),
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "Lax",
                "expires": expires,
            }),
        ));
        names.push(c.name.clone());
    }
    match cdp_calls_on(&tab, calls, false) {
        Ok(results) => {
            let imported = results
                .iter()
                .skip(1) // Network.enable's ack
                .filter(|r| r["success"] == true)
                .count();
            json!({"ok": true, "imported": imported, "names": names, "domain": host})
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Close one chat's tab (the shared browser stays up: other chats may be using
/// it, and a fresh panel reuses the warm process and its profile).
///
/// The chat's open POPUPS are closed with it: Chromium tears them down with
/// the opener anyway, but closing them here keeps the registry, the frame
/// cache and the renderer count from depending on that timing.
fn close_tab(chat: &str) -> bool {
    let Some(tab) = existing_tab(chat) else {
        return false;
    };
    let mut targets = vec![tab.target_id.clone()];
    if let Ok(popups) = POPUPS.lock() {
        targets.extend(
            popups
                .iter()
                .filter(|p| p.root == tab.target_id)
                .map(|p| p.target_id.clone()),
        );
    }
    TABS.lock()
        .ok()
        .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    restart_idle_clock_if_unused();
    // One batch per target: an "already gone" target arrives as a
    // transport-shaped error that would stop a merged batch short, and a
    // vanished popup must not prevent the tab itself from closing.
    for target in &targets {
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": target}),
        )]);
        drop_frame(target);
    }
    if let Ok(mut popups) = POPUPS.lock() {
        popups.retain(|p| p.root != tab.target_id);
    }
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

/// The full Chrome-for-Testing download for this platform, as `(url, version)`.
///
/// The FULL browser is the right artifact, not the headless shell: the new
/// headless mode keeps the real GPU stack (ANGLE/Metal), so heavy pages
/// rasterize on the GPU instead of SwiftShader software rendering, and the
/// WebGL fingerprint reports a genuine Apple GPU — the shell's SwiftShader
/// string is exactly what Google's "may not be secure" sign-in gate reads as
/// "not a real browser". It still lives inside the app's own data root, so
/// the system-Chrome hijacking concerns in `chromium_candidates` never apply.
fn cft_browser_url() -> Result<(String, String), String> {
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
    let stable = &index["channels"]["Stable"];
    let version = stable["version"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let url = stable["downloads"]["chrome"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|d| d["platform"].as_str() == Some(want))
                .and_then(|d| d["url"].as_str())
        })
        .map(str::to_string)
        .ok_or_else(|| format!("chrome-for-testing has no chrome build for {want}"))?;
    Ok((url, version))
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
    let (url, version) = cft_browser_url()?;
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
        // The zip's own top-level name (`chrome-mac-arm64`) is NOT a shape
        // `candidate_dirs` filters on; rehouse it under the versioned
        // chrome-for-testing name so the numeric rank orders it and the
        // layout probes find the binary.
        let dest = root.join(format!("chrome-for-testing-{version}"));
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

    // One build is enough: the retention backstop only removes superseded
    // builds a day late, so the install reclaims the ~150 MB apiece right now.
    if result.is_ok() {
        let keep = root.join(format!("chrome-for-testing-{version}"));
        prune_other_browser_builds(&root, &keep);
    }
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Delete every `chrome-for-testing-*` build under `root` except `keep`.
/// Best-effort: a build still running (locked on Windows) simply survives and
/// is picked up by the retention backstop later.
fn prune_other_browser_builds(root: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("chrome-for-testing")
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
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
///
/// The archive's stored Unix mode is applied: the Chrome-for-Testing zips mark
/// every binary 0755, and dropping that bit breaks the browser's INTERNAL
/// spawns (crashpad's handler, the Helper apps) even though the main binary is
/// chmod'ed afterwards — the missing bit made macOS pop a crash dialog on
/// every launch (see `make_executable`).
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A mode-less archive means a plain file; a stored mode with any
            // permission bit set is honoured as-is so 0755 binaries stay 0755.
            let mode = entry.unix_mode().unwrap_or(0o644) & 0o7777;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
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

/// True when `file` starts with a Mach-O (or shebang) header — something
/// `exec()` would run. Chrome's bundle carries executables far beyond the main
/// binary: `Helpers/chrome_crashpad_handler`, `app_mode_loader` and every
/// `Helper (...).app/Contents/MacOS/*`. A missing +x on any of them makes the
/// browser's internal spawns fail with EACCES — crashpad's handler spawn then
/// leaves a fork child that dies pre-exec, and macOS pops a "quit
/// unexpectedly" dialog on EVERY launch even though the browser itself works.
fn is_executable_image(file: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(file) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok()
        && matches!(
            magic,
            [0xCA, 0xFE, 0xBA, 0xBE]   // fat/universal binary
                | [0xCE, 0xFA, 0xED, 0xFE] // Mach-O 32-bit LE
                | [0xFE, 0xED, 0xFA, 0xCE] // Mach-O 32-bit BE
                | [0xCF, 0xFA, 0xED, 0xFE] // Mach-O 64-bit LE
                | [0xFE, 0xED, 0xFA, 0xCF] // Mach-O 64-bit BE
                | [b'#', b'!', _, _]   // shebang script
        )
}

/// Grant the executable bit to every executable image under `dir`.
///
/// ZIP archives do not always carry the executable bit through, and a browser
/// binary without it fails with a bare permission error. The probe walks the
/// unpacked build itself — NOT `find_chromium()`, which until this fix lands
/// still resolves to the previous install and once made it skip the chmod
/// entirely (`Permission denied` on the very next launch).
///
/// `binaries_under` alone only reaches the MAIN binary; the same install also
/// unpacked `chrome_crashpad_handler` and the Helper apps without their exec
/// bit, and every launch then died in crashpad's handler spawn — visible to
/// the user as a repeating macOS crash-report dialog. The deep walk below
/// fixes every Mach-O in the tree, and the same walk is run over ALREADY
/// installed builds from `spawn_browser`, so existing installs self-heal on
/// the next launch without a re-download.
fn make_executable(dir: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The known main binaries first: the deep walk below would cover them,
        // but this also reaches launcher shapes the layout list knows that the
        // magic sniffing cannot (and the layout list is the documented path).
        for bin in binaries_under(dir) {
            if bin.is_file() {
                if let Ok(meta) = std::fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    if perms.mode() & 0o111 == 0 {
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&bin, perms);
                    }
                }
            }
        }
        // Then the whole tree, so the bundle's internal helpers — crashpad's
        // handler and every Helper app — end up executable too.
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.is_file() && is_executable_image(&p) {
                    if let Ok(meta) = std::fs::metadata(&p) {
                        let mut perms = meta.permissions();
                        if perms.mode() & 0o111 == 0 {
                            perms.set_mode(0o755);
                            let _ = std::fs::set_permissions(&p, perms);
                        }
                    }
                }
            }
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
    let res = cdp_calls(
        tab,
        vec![(
            "Runtime.evaluate",
            json!({"expression": "location.href", "returnByValue": true}),
        )],
    );
    match res {
        Ok(out) => out
            .into_iter()
            .next()
            .unwrap_or(Value::Null)["result"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
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
fn navigate(tab: &Tab, url: &str) -> Result<(), String> {
    cdp_calls_on(
        tab,
        vec![("Page.navigate", json!({"url": url}))],
        false,
    )
    .map(|_| ())
}

/// Navigate an already-open chat tab (the panel's address bar). Unlike `launch`
/// this never starts a browser: a down session reports the same
/// "browser is not running" error the panel already handles.
pub fn navigate_to(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
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
    match block_on(async move {
        navigate(&tab_for_call, &target_owned)?;
        Ok(Value::Null)
    }) {
        Ok(_) => {
            // Wait for the navigation to commit AND settle so the returned url
            // is the new page rather than the one being left (a fixed sleep
            // both raced slow pages and wasted time on fast ones). On a thrown
            // thread, so the axum worker is never parked for up to 8s.
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
            if let Err(e) = navigate(&tab, target) {
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
        );
        let settled = ready
            .ok()
            .and_then(|res| res.into_iter().next())
            .and_then(|r| {
                // Runtime.evaluate's reply carries the RemoteObject under its
                // own `result` key (`{"result": {"result": {...}}}` on the
                // wire, one level stripped by `Cdp::send`). Reading one level
                // deeper than that always yielded Null, so every navigation
                // waited out the whole timeout instead of settling early.
                r["result"]["value"]
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
/// The device-metrics override rides in the capture batch (`cdp_calls`
/// prepends it): `Emulation.setDeviceMetricsOverride` is scoped to the CDP
/// session, and the session a screenshot drives must hold the tab's emulated
/// size before the capture, whatever ran before it.
pub fn screenshot(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = active_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    let tab_for_call = tab.clone();
    let fut = async move {
        // A settled page captures cleanly; an unsettled one gets a readiness
        // wait first. Each check is one warm-socket command now.
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut waited = false;
        loop {
            let ready = cdp_calls(
                &tab_for_call,
                vec![(
                    "Runtime.evaluate",
                    json!({
                        "expression": "document.readyState",
                        "returnByValue": true,
                    }),
                )],
            );
            let settled = ready
                .ok()
                .and_then(|res| res.into_iter().next())
                .and_then(|res| {
                    // Same reply depth as `wait_page_settled`: one `result`
                    // from the CDP envelope (stripped by send), one from the
                    // RemoteObject. A deeper read was always Null and made
                    // every seed capture burn its whole 6s deadline.
                    res["result"]["value"]
                        .as_str()
                        .map(str::to_string)
                })
                .map(|v| v == "interactive" || v == "complete")
                .unwrap_or(false);
            if settled || Instant::now() >= deadline {
                break;
            }
            waited = true;
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if waited {
            // One paint beat after readyState flips: the first composited
            // frame usually lands right behind the DOM reporting ready —
            // capturing on the readyState tick alone still races it every few
            // pages. A page that was ALREADY settled needs no beat; skipping
            // it here never covered a resize (the override below re-lays-out
            // synchronously before the capture).
            tokio::time::sleep(Duration::from_millis(180)).await;
        }
        let res = cdp_calls(
            &tab_for_call,
            vec![(
                "Page.captureScreenshot",
                json!({"format": "jpeg", "quality": SCREENSHOT_QUALITY}),
            )],
        )?;
        Ok(res
            .into_iter()
            .next()
            .and_then(|v| v["data"].as_str().map(str::to_string))
            .unwrap_or_default())
    };
    match block_on(fut) {
        Ok(b64) if !b64.is_empty() => json!({
            "ok": true,
            "image": format!("data:image/jpeg;base64,{b64}"),
            "width": w,
            "height": h,
        }),
        Ok(_) => json!({"ok": false, "error": "empty screenshot"}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Dispatch one mouse event at viewport coordinates.
fn mouse_event(
    tab: &Tab,
    kind: &'static str,
    x: i64,
    y: i64,
    extra: Value,
) -> Result<(), String> {
    let mut params = json!({"type": kind, "x": x, "y": y});
    if let (Some(dst), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            dst.insert(k.clone(), v.clone());
        }
    }
    cdp_calls(tab, vec![("Input.dispatchMouseEvent", params)]).map(|_| ())
}

/// Click at viewport coordinates.
///
/// Press and release ride in ONE batch: on the shared, strictly ordered
/// connection two separate requests could be interleaved by a hover move from
/// the panel, splitting the click.
pub fn click(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let press = json!({
        "type": "mousePressed",
        "x": x,
        "y": y,
        "button": "left",
        "clickCount": 1,
        "buttons": 1,
    });
    let release = json!({
        "type": "mouseReleased",
        "x": x,
        "y": y,
        "button": "left",
        "clickCount": 1,
        "buttons": 0,
    });
    match cdp_calls(
        &tab,
        vec![
            ("Input.dispatchMouseEvent", press),
            ("Input.dispatchMouseEvent", release),
        ],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Move the virtual cursor (hover).
pub fn move_mouse(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    match mouse_event(&tab, "mouseMoved", x, y, json!({"buttons": 0})) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Whether `text` is short enough to be typed key by key. Long runs and text
/// with line breaks keep the single `Input.insertText` call: they are pastes in
/// practice, and thousands of key events would only slow them down.
pub(crate) fn is_short_plain_text(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= 80 && !text.contains(['\n', '\r', '\t'])
}

/// The keyDown/keyUp pair for one typed character.
///
/// `Input.insertText` changes the field but fires no `keydown`/`keyup`, which is
/// exactly how a script tells a person from an automated client. Real events
/// carry the key, its text and (for ASCII) the physical code and key code.
pub(crate) fn char_key_events(ch: char) -> [Value; 2] {
    let key = ch.to_string();
    let mut base = json!({"key": key, "text": key, "unmodifiedText": key});
    let (code, vk): (Option<String>, u32) = if ch.is_ascii_alphabetic() {
        let up = ch.to_ascii_uppercase();
        (Some(format!("Key{up}")), up as u32)
    } else if ch.is_ascii_digit() {
        (Some(format!("Digit{ch}")), ch as u32)
    } else if ch == ' ' {
        (Some("Space".to_string()), 32)
    } else {
        (None, 0)
    };
    if let Some(code) = code {
        base["code"] = json!(code);
        base["windowsVirtualKeyCode"] = json!(vk);
        base["nativeVirtualKeyCode"] = json!(vk);
    }
    if ch.is_ascii_uppercase() {
        base["modifiers"] = json!(8); // Shift
    }
    let mut down = base.clone();
    down["type"] = json!("keyDown");
    let mut up = base;
    up["type"] = json!("keyUp");
    if let Some(o) = up.as_object_mut() {
        o.remove("text");
        o.remove("unmodifiedText");
    }
    [down, up]
}

/// Type text into the focused element.
pub fn type_text(text: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let calls: Vec<(&'static str, Value)> = if is_short_plain_text(text) {
        text.chars()
            .flat_map(char_key_events)
            .map(|ev| ("Input.dispatchKeyEvent", ev))
            .collect()
    } else {
        vec![("Input.insertText", json!({"text": text}))]
    };
    match cdp_calls(&tab, calls) {
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
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some((code, name, dom_code)) = key_spec(key) else {
        // Not a named key: type it as text (matches the Python fallback).
        return type_text(key, &chat);
    };
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
    match cdp_calls(
        &tab,
        vec![
            ("Input.dispatchKeyEvent", down),
            ("Input.dispatchKeyEvent", up),
        ],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Scroll the page by a wheel delta.
pub fn scroll(dx: i64, dy: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    match cdp_calls(
        &tab,
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
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Resize the emulated viewport. The size is REMEMBERED on the tab so the
/// panel's ruler and fit-to-pane resizes survive the next status poll.
pub fn set_viewport(width: u32, height: u32, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    // Guard against a zero/absurd size from a mid-typing input.
    let w = width.clamp(200, 4096);
    let h = height.clamp(200, 4096);
    match cdp_calls_on(
        &tab,
        vec![("Emulation.setDeviceMetricsOverride", viewport_override(w, h))],
        false,
    ) {
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
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let expr = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return json!({"ok": false, "error": format!("unknown history action: {other}")}),
    };
    let tab_for_call = tab.clone();
    let expr_owned = expr;
    match cdp_calls(
        &tab_for_call,
        vec![(
            "Runtime.evaluate",
            json!({"expression": expr_owned, "returnByValue": true}),
        )],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Omnibox search: try Google, then Bing, then DuckDuckGo — the first engine
/// that actually loads wins, and its results URL is returned for the address bar.
pub fn search(query: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
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
        if let Err(e) = navigate(&tab, &url) {
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
    let Some(tab) = panel_tab(&chat) else {
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
/// needs something this file used to lack: the driver thread OWNS the one
/// long-lived WebSocket and runs strictly request→reply, so it cannot also
/// serve the agent's concurrently reading driver. Everything here is
/// request/reply on that separate, per-driver socket.
pub(crate) mod driver_hooks {
    /// The identity the panel's session presents (Chrome User-Agent + client
    /// hints, plus the consistency script), built from the running browser's own
    /// version. The agent's driver is a SEPARATE CDP session on the same tab, so
    /// it has to send the same override or the two sessions disagree about who
    /// the browser is.
    pub(crate) fn identity() -> Option<(serde_json::Value, String)> {
        let port = super::alive_port()?;
        let info = super::http_get_json(port, "/json/version").ok()?;
        let version = serde_json::json!({
            "userAgent": info["User-Agent"],
            "product": info["Browser"],
        });
        super::ua_override(&version).map(|ua| (ua, super::consistency_js()))
    }

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
        assert!(tab_usable(&tab_a.target_id), "first tab must be live");
        assert!(tab_usable(&tab_b.target_id), "second tab must be live");
        // One process, two tabs.
        assert_eq!(BROWSER.lock().unwrap().as_ref().map(|_| 1), Some(1));
        assert_eq!(TABS.lock().unwrap().len(), 2);
        // The screenshot/url paths read the FIRST COMMAND's reply from a
        // viewport-override batch — a missing strip of the override's own ack
        // made every frame come back "empty screenshot" (regression guard).
        let shot = screenshot(a);
        assert_eq!(shot["ok"], true, "{shot}");
        assert!(
            shot["image"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/jpeg"),
            "{shot}"
        );
        let url = current_url(&tab_a);
        assert_eq!(url, "about:blank", "the fresh tab sits on about:blank");
        // A warm-socket input path end to end.
        assert_eq!(type_text("hi", a)["ok"], true);
        assert_eq!(click(10, 10, a)["ok"], true);
        // The PUSH pipeline: navigating repaints the page, Chromium pushes a
        // frame through screencast, and a long-poll with after=0 returns it
        // (a real JPEG, seq > 0) instead of timing out.
        let nav = navigate_to("data:text/html,<h1>codifa-live</h1>", a);
        assert_eq!(nav["ok"], true, "{nav}");
        let f = block_on(async move {
            let v = frame(a, 0).await;
            Ok::<Value, String>(v)
        })
        .unwrap_or(Value::Null);
        assert_eq!(f["ok"], true, "{f}");
        assert!(
            f["image"].as_str().unwrap_or_default().starts_with("data:image/jpeg"),
            "the pushed frame must be a JPEG data URI: {f}"
        );
        assert!(close_tab(a));
        assert!(close_tab(b));
        let killed = kill_all_sessions();
        assert!(killed >= 1, "the shared browser must be reaped");
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
    fn popup_root_walks_to_the_registered_chat_tab() {
        let targets = vec![
            ("root-1".to_string(), "https://site".to_string(), String::new()),
            ("pop-1".to_string(), "about:blank".to_string(), "root-1".to_string()),
            ("pop-2".to_string(), "about:blank".to_string(), "pop-1".to_string()),
            ("foreign".to_string(), "https://other".to_string(), String::new()),
            ("foreign-pop".to_string(), "about:blank".to_string(), "foreign".to_string()),
        ];
        let claimed = vec!["root-1".to_string()];
        assert_eq!(
            popup_root("pop-1", &targets, &claimed).as_deref(),
            Some("root-1")
        );
        // A popup of a popup rolls up to the same chat tab.
        assert_eq!(
            popup_root("pop-2", &targets, &claimed).as_deref(),
            Some("root-1")
        );
        // A root is not a popup; a foreign client's popup tree and a ghost id
        // are none of the panel's business.
        assert_eq!(popup_root("root-1", &targets, &claimed), None);
        assert_eq!(popup_root("foreign-pop", &targets, &claimed), None);
        assert_eq!(popup_root("ghost", &targets, &claimed), None);
    }

    #[test]
    fn panel_display_follows_the_newest_live_popup() {
        // Other tests in this suite mutate the shared TABS/POPUPS statics
        // concurrently (the idle-clock one wipes TABS wholesale), so a wipe
        // landing mid-test would surface as a spurious None. Re-seed and
        // retry: a race that says nothing about the code under test must not
        // fail it, and the walk itself is pure in-memory work.
        let attempt = || -> Option<()> {
            TABS.lock().unwrap().retain(|(k, _)| k != "popup-display-test");
            TABS.lock().unwrap().push((
                "popup-display-test".to_string(),
                Tab {
                    target_id: "T-root".to_string(),
                    viewport: DEFAULT_VIEWPORT,
                    last_used: Instant::now(),
                },
            ));
            POPUPS.lock().unwrap().clear();
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-pop1".to_string(),
                root: "T-root".to_string(),
            });
            // Another chat's popup must never leak into this chat's display.
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-other".to_string(),
                root: "T-unrelated".to_string(),
            });
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop1".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-pop2".to_string(),
                root: "T-root".to_string(),
            });
            // Newest wins while both live…
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop2".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().retain(|p| p.target_id != "T-pop2");
            // …and closing it falls back to the older popup, then to the tab.
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop1".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().clear();
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-root".to_string())
            {
                return None;
            }
            TABS.lock().unwrap().retain(|(k, _)| k != "popup-display-test");
            Some(())
        };
        let mut settled = false;
        for _ in 0..50 {
            if attempt().is_some() {
                settled = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        POPUPS.lock().unwrap().clear();
        assert!(
            settled,
            "the popup display walk never settled (state kept getting wiped by a concurrent test)"
        );
    }

    #[test]
    fn parse_cookie_blob_accepts_every_paste_shape() {
        // The bare sessionid token (the Instagram flow).
        assert_eq!(
            parse_cookie_blob("abcDEF123xyz"),
            vec![PastedCookie {
                name: "sessionid".to_string(),
                value: "abcDEF123xyz".to_string()
            }]
        );
        // document.cookie / Cookie-header shape.
        assert_eq!(
            parse_cookie_blob("sessionid=AAA; csrftoken=BBB; ds_user_id=123"),
            vec![
                PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() },
                PastedCookie { name: "csrftoken".to_string(), value: "BBB".to_string() },
                PastedCookie { name: "ds_user_id".to_string(), value: "123".to_string() },
            ]
        );
        // A pasted Set-Cookie line: attributes are dropped, not imported.
        assert_eq!(
            parse_cookie_blob("sessionid=AAA; Path=/; Domain=.instagram.com; Secure; HttpOnly"),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
        // DevTools-style JSON export.
        assert_eq!(
            parse_cookie_blob(r#"[{"name":"sessionid","value":"AAA","domain":".instagram.com"}]"#),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
        // A later duplicate wins.
        assert_eq!(
            parse_cookie_blob("sessionid=OLD; sessionid=NEW"),
            vec![PastedCookie { name: "sessionid".to_string(), value: "NEW".to_string() }]
        );
        // Empty paste yields nothing (the caller reports it).
        assert!(parse_cookie_blob("   ").is_empty());
        // Whitespace around pairs and values is trimmed.
        assert_eq!(
            parse_cookie_blob("  sessionid =  AAA  ; "),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
    }

    /// Live check that an imported cookie really lands in the shared profile
    /// and is visible to the site: import a marker cookie for a local origin,
    /// then read it back through the page. Run on demand:
    /// `cargo test --ignored imported_cookies_reach_the_site`.
    #[test]
    #[ignore]
    fn imported_cookies_reach_the_site() {
        let chat = "live-cookie";
        let tab = ensure_tab(chat).expect("tab");
        // Land the tab on a stable origin first (the cookie is domain-scoped).
        let nav = navigate_to("https://example.com/", chat);
        assert_eq!(nav["ok"], true, "{nav}");
        let v = import_cookies(
            chat,
            "example.com",
            "codifa_import_test=hello-import",
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["imported"], 1, "{v}");
        // The page sees it: the cookie is set httpOnly, so read the jar via
        // CDP instead of document.cookie.
        let seen = cdp_calls(
            &tab,
            vec![
                ("Network.enable", json!({})),
                (
                    "Network.getCookies",
                    json!({"urls": ["https://example.com/"]}),
                ),
            ],
        )
        .expect("getCookies");
        let cookies = &seen[1]["cookies"];
        let hit = cookies
            .as_array()
            .map(|a| {
                a.iter().any(|c| {
                    c["name"] == "codifa_import_test" && c["value"] == "hello-import"
                })
            })
            .unwrap_or(false);
        assert!(hit, "imported cookie must be in the jar: {cookies}");
        assert!(close_tab(chat));
        kill_all_sessions();
    }

    /// Live check that a `window.open` popup is discovered and FOLLOWED: the
    /// panel switches to the popup while it lives and falls back to the chat's
    /// tab when it closes. This is the OAuth shape ("Continue with Google"
    /// opens a popup whose callback talks to `window.opener`) that used to run
    /// invisibly — the popup target existed, nothing ever displayed it.
    ///
    /// Ignored by default (starts a real Chromium), like the other live test:
    /// `cargo test --ignored the_panel_follows_window_open_popups`.
    #[test]
    #[ignore]
    fn the_panel_follows_window_open_popups() {
        let chat = "live-popup";
        let tab = ensure_tab(chat).expect("tab");
        POPUPS.lock().unwrap().clear();
        // Open the popup THROUGH the page, so the opener relation is the real
        // `window.open` path (`userGesture` bypasses the popup blocker the way
        // a click would; the return value is coerced to a boolean because the
        // Window object itself does not serialize with returnByValue).
        let opened = cdp_calls(
            &tab,
            vec![(
                "Runtime.evaluate",
                json!({
                    "expression":
                        "!!window.open('data:text/html,<h1>popup</h1>', '_blank', 'width=480,height=640')",
                    "returnByValue": true,
                    "userGesture": true,
                }),
            )],
        )
        .expect("window.open must evaluate");
        assert_eq!(
            opened[0]["result"]["value"], true,
            "window.open must return a window, not null (popup-blocked?): {opened:?}"
        );
        let mut popup = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            sync_popups();
            if let Some(p) = visible_popup(&tab.target_id) {
                popup = p;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        assert!(
            !popup.is_empty(),
            "the popup must be discovered; page_targets={:?}",
            page_targets()
        );
        // The panel (and every panel input call) now points at the popup.
        assert_eq!(
            panel_tab(chat).map(|t| t.target_id),
            Some(popup.clone())
        );
        // Closing the popup snaps the view back to the chat's own tab.
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": popup}),
        )]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            sync_popups();
            if visible_popup(&tab.target_id).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        assert!(visible_popup(&tab.target_id).is_none());
        assert_eq!(
            panel_tab(chat).map(|t| t.target_id),
            Some(tab.target_id.clone())
        );
        assert!(close_tab(chat));
        kill_all_sessions();
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
        let args = launch_args(bin, 61995, profile, None).join(" ");
        // Headless + our own profile: never the user's Chrome profile.
        assert!(args.contains("--headless"));
        assert!(args.contains("--user-data-dir=/Users/x/.codifa/browser-profile"));
        assert!(args.contains("--remote-debugging-port=61995"));
        assert!(!args.contains("--user-agent="));
        // The Google background services that reached into the user's own
        // profile / crashpad database.
        assert!(args.contains("--disable-crash-reporter"));
        assert!(args.contains("--disable-background-networking"));
        assert!(args.contains("--no-service-autorun"));
        // The full build renders on SwiftShader ON PURPOSE: a GPU process
        // cannot be hosted from a daemon context, and both failure modes
        // around that (fatal exit / crash-loop at 100% CPU) are worse than
        // software rendering. Software WebGL needs its Chrome-139+ opt-in,
        // and macOS must never touch the user's keychain.
        assert!(args.contains("--disable-gpu"));
        assert!(args.contains("--enable-unsafe-swiftshader"));
        assert!(args.contains("--use-mock-keychain"));
        let shell = std::path::Path::new("/opt/browser/chrome-headless-shell");
        let shell_args = launch_args(shell, 61995, profile, None).join(" ");
        assert!(!shell_args.contains("--disable-gpu"));
        assert!(!shell_args.contains("--use-mock-keychain"));
        assert!(shell_args.contains("--headless"));
    }

    #[test]
    fn launch_args_pin_the_process_level_user_agent() {
        // A popup's FIRST document request leaves the browser before any CDP
        // session can attach and override the UA — the process-level flag is
        // the only thing that covers it.
        let bin = std::path::Path::new("/opt/browser/chrome-headless-shell");
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        let args = launch_args(
            bin,
            61995,
            profile,
            Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36"),
        )
        .join(" ");
        assert!(args.contains("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"));
        assert!(args.contains("Chrome/156.0.8078.80 Safari/537.36"));
    }

    #[test]
    fn chrome_user_agent_builds_from_the_binary_version() {
        // Pure construction check via a stubbed binary: a shell script whose
        // `--version` output carries the version token.
        let dir = std::env::temp_dir().join(format!("codifa-ua-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-chrome");
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::PermissionsExt;
            let mut f = std::fs::File::create(&bin).unwrap();
            f.write_all(b"#!/bin/sh\necho \"Google Chrome for Testing 156.0.8078.80\"\n").unwrap();
            drop(f);
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let ua = chrome_user_agent(&bin).expect("version must parse");
            assert!(ua.ends_with("Chrome/156.0.8078.80 Safari/537.36"), "{ua}");
            assert!(ua.starts_with("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "{ua}");
            // A binary that prints nothing yields None (per-session override
            // stays the only UA fix).
            let silent = dir.join("silent-chrome");
            let mut f = std::fs::File::create(&silent).unwrap();
            f.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
            drop(f);
            std::fs::set_permissions(&silent, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(chrome_user_agent(&silent), None);
        }
        let _ = bin;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
