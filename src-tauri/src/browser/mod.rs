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


mod actions;
mod cdp;
mod cookies;
mod discover;
mod fingerprint;
mod frames;
mod install;
mod launch;
mod reaper;
mod tabs;

#[allow(unused_imports)] // used by tests under cfg(test)
use actions::*;
use cdp::*;
#[allow(unused_imports)] // used by tests under cfg(test)
use cookies::*;
use discover::*;
use fingerprint::*;
use frames::*;
use install::*;
use launch::*;
use reaper::*;
use tabs::*;

// Public re-exports reproduce the original browser surface.
#[allow(unused_imports)]
pub use discover::*;
pub use actions::{click, close, devtools_url, history, launch, move_mouse, navigate_to,
                  press_key, scroll, screenshot, search, set_viewport, status, type_text};
pub use cookies::import_cookies;
pub use frames::frame;
pub use discover::is_available;
pub use install::{install, install_status};
pub use reaper::{reap_orphans, start_idle_reaper};
pub use tabs::kill_all_sessions;
pub(crate) use actions::driver_hooks;
pub(crate) use discover::build_rank;
pub(crate) use fingerprint::consistency_js;
pub(crate) use actions::{is_short_plain_text, char_key_events};

#[cfg(test)]
mod tests;
