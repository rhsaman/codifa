//! Native browser driver — the CDP layer the agent calls as tools.
//!
//! `browser.rs` already speaks CDP, but only request/reply on a socket it opens
//! and drops per call: it throws events away, cannot wait for a page to settle,
//! and has no notion of an element. That is enough to mirror a page as JPEG
//! frames, and not enough to drive one. This module adds the missing half:
//!
//! * ONE long-lived WebSocket per chat, with a writer task and a reader loop, so
//!   events (`Page.loadEventFired`, `Runtime.consoleAPICalled`,
//!   `Network.responseReceived`, `Page.javascriptDialogOpening`) actually arrive.
//! * A SNAPSHOT of the page as a compact list of `[ref] role "name"` entries.
//!   Refs are `(role, name, occurrence)` triples, so they survive scrolling and
//!   layout shifts instead of being dead pixel coordinates.
//! * Element actions resolved through the DOM (`DOM.scrollIntoViewIfNeeded` then
//!   a real mouse event at the element's centre), which is what makes click/type
//!   reliable on a page we have never seen.
//!
//! It deliberately reuses the shared Chromium owned by `browser.rs` (through
//! `driver_hooks`): the agent and the right-side panel drive the SAME tab, so
//! the user always sees what the agent is doing.
//!
//! Everything here is synchronous. The callers are the tool dispatcher (a
//! blocking thread) and the axum handlers (which call into it via
//! `spawn_blocking`), so a blocking API keeps the two paths identical.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender as Waiter;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use crate::browser::driver_hooks as hooks;

/// Per-command timeout. Generous enough for a heavy `Runtime.evaluate`,
/// short enough that a wedged renderer cannot hang a turn.
const CDP_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a navigation may take to reach `load`.
const NAV_TIMEOUT: Duration = Duration::from_secs(30);
/// How many past snapshots keep their refs resolvable.
const MAX_SNAPSHOTS: usize = 24;
/// Cap on the text handed back to the model for a FULL snapshot (`full=true`).
const SNAPSHOT_MAX_CHARS: usize = 12_000;
/// Budget for the default `browser_snapshot` summary: main text, headings and
/// the important (main/dialog) interactive entries first — a page's nav/footer
/// links and the tail of its body text are what a summary gives up, and
/// `full=true` brings them back.
const SNAPSHOT_SUMMARY_CHARS: usize = 6_000;
/// Budget for the summary that `navigate`/`navigate_back` return INLINE, so
/// "open X" costs ONE tool call instead of navigate + snapshot. Started at
/// 2_500, but the trace showed the model following EVERY navigate with a full
/// browser_snapshot round anyway (the interactive page needed refs the short
/// summary had dropped) — the "one call" win never landed while the budget
/// was tighter than the snapshot's. Same budget, no follow-up round.
const SNAPSHOT_NAV_CHARS: usize = SNAPSHOT_SUMMARY_CHARS;
/// Cap on the captured console / network buffers (per chat).
const LOG_CAP: usize = 200;
const NET_CAP: usize = 300;
/// Fire-and-forget CDP id: replies to it are dropped on the floor.
const NO_REPLY_ID: u64 = 0;
/// Actions that CHANGE the page, so the result carries the page summary with
/// fresh refs (see the post-action block in `run`).
const POST_ACTION_SNAPSHOT_OPS: &[&str] =
    &["click", "type", "select_option", "press_key", "file_upload", "drag"];

// ---------------------------------------------------------------------------
// Injected page helpers
// ---------------------------------------------------------------------------


mod actions;
mod cdp;
mod driver;
mod ops;
mod snapshot;

// Public re-exports reproduce the original browser_driver surface.
use actions::*;
use cdp::*;
use driver::*;
#[allow(unused_imports)] // used by tests under cfg(test)
use ops::*;
use snapshot::*;

#[allow(unused_imports)] // original API surface, preserved verbatim
pub use actions::{ACTIONS, action_of, handles, entries};
pub use ops::run;
pub(crate) use driver::forget;

#[cfg(test)]
mod tests;
