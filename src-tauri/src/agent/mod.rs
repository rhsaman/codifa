//! Native agent loop: streams the model, executes tool calls and emits the
//! `kind`-discriminated SSE events the frontend consumes. Everything runs
//! in-process — LSP tools, MCP connectors, sub-agents and compaction are all
//! native (see `tools`, `mcp`, `lsp`, `compact`).

// Some helpers below are shared with the scheduler and the sub-agent paths, so
// not every item is referenced from this module alone.
#![allow(dead_code)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::llm::{http_client, stream_chat, InterruptSignal, LlmConfig, StreamAcc, StreamSignal};
use crate::tools;

/// Test-only view of the turn registry, so the browser reaper's policy can be
/// locked down (a running turn must keep its tab alive) without forging one.
#[cfg(test)]
pub(crate) fn test_set_turn_running(chat_id: &str, running: bool) {
    let mut r = running_turns().lock().unwrap();
    if running {
        r.insert(chat_id.to_string());
    } else {
        r.remove(chat_id);
    }
}

mod caps;
mod context;
mod events;
mod fold;
mod prompt;
mod schemas;
mod shell_safety;
mod steer;
mod subagent;
mod trust;
mod turn;
mod types;
mod vision;

#[cfg(test)]
mod tests;
use turn::*;

// Private glob re-imports: every item below stays visible to the sibling parts
// and to `tests` exactly as it was in the single-file module. `pub use` lines
// reproduce the ORIGINAL public surface of `agent` — nothing new is exposed.
use caps::*;
use context::*;
use fold::*;
use prompt::*;
use schemas::*;
use shell_safety::*;
use steer::*;
use subagent::*;
use trust::*;
// The `batch` executor resolves each op's name through this same table, so a
// foreign name (`run_command`, `shell`, `read_file`) means its Codifa tool
// INSIDE a batch exactly as it does at the top level.
pub(crate) use trust::canonical_tool_name;
use types::*;
use vision::*;

pub use events::AgentEvent;
#[allow(unused_imports)] // original API surface, preserved verbatim
pub use steer::{SteerMessage, is_turn_running, forget_chat, deliver_answer, push_steer, cancel_steer};
pub use trust::{add_trusted_folder, add_trusted_host};
pub use types::{AgentRequest, ToolCaps, caps_for_mode};
pub use turn::run_turn;
#[allow(unused_imports)] // original API surface, preserved verbatim
pub use subagent::{retry_ladder_live, nudge_subagent_retry, set_live_slot_entry};
pub(crate) use caps::{provider_model_thinking_levels, provider_model_reasoning};
pub(crate) use context::{resolve_compact_window, DEFAULT_CONTEXT_WINDOW, provider_context_window, MODEL_RESULT_CAP};
