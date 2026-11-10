// Phase 3-2: native core file tools mirroring backend/tools.py semantics —
// resolve_safe sandboxing, read (windows/batch), grep, glob, write, edit.
//! LSP-backed features (symbols=, symbol fast paths) run natively; the agent
//! loop falls back to grep for names the language server cannot resolve.

// Phase 3-2 WIP: native core tools are only called from agent.rs, which is
// not wired to a route yet. Silence dead-code until the route lands.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Largest file the EDITORS will rewrite in memory. Reads are NOT bounded by
/// it: `read` streams windows and documents are windowed by extracted text.
pub const MAX_READ_BYTES: usize = 2_000_000;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const MAX_FILES: usize = 10_000;
pub const MAX_TERMINAL_OUTPUT: usize = 10_000;

/// The ONE budget of a foreground tool wait — chat and scheduled alike.
///
/// The schema hands `timeout` to the MODEL, and nothing validated it: a prompt
/// that wanted a long-running monitor once sent a 5400-second foreground call
/// and the tool sat on it for the full 90 minutes while the turn (and the
/// scheduled run row) stayed `running` with no error anywhere. A long job is
/// what `background=true` is for, so a foreground call past this is clipped.
///
/// Deliberately ONE number: there is no second, larger "headless" budget. A paid
/// plugin script (article + image) legitimately takes minutes, and a run killed
/// mid-way pays for the same work twice, so the wait has to outlast the work in
/// both contexts.
pub const MAX_TERMINAL_TIMEOUT_SECS: u64 = 30 * 60;

/// Live-output sink for a RUNNING terminal command: called periodically with
/// the current tail of the combined output while the child is still alive.
/// The agent loop forwards it to the UI as `ToolOutput` events, so a long
/// download or build is visible in the chat while it runs instead of only
/// after the command returns.
pub type TailSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Minimum wall-clock gap between two `TailSink` calls for one command. The
/// poll loop ticks every 20 ms; without this gate a 30-minute command would
/// push a tail 90 000 times.
const TERMINAL_TAIL_EMIT_MS: u64 = 500;

/// Size of the live tail handed to `TailSink` — the LAST bytes of the output.
/// A curl progress refresh writes ~90 bytes per second, so this covers the
/// most recent minute or so of a typical download.
const TERMINAL_TAIL_BYTES: usize = 4096;
/// Hard depth cap for filesystem walks (`collect_files`) — a second belt next
/// to the canonical-path visited set, so a pathological tree cannot blow the
/// stack.
const MAX_WALK_DEPTH: usize = 64;

const MAX_GREP_ALTERNATIVES: usize = 3;

/// Identifiers are what `find_symbol` takes; anything else is grep-only.
///
/// Kept in sync with `find_symbol`'s own input check (bare letters, digits, `_`
/// or `$`), so the hint never sends the model to a tool that would refuse it.
fn is_bare_identifier(sym: &str) -> bool {
    !sym.is_empty() && sym.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// Upper bound on the follow-up hint `grep` appends to its own result.
const GREP_HINT_MAX: usize = 420;

/// Marker prefix of the diagnostics payload `post_edit_diagnostics` appends.
const POST_EDIT_DIAGNOSTICS_MARK: &str = "[language server]";
/// Marker prefix of the `find_symbol` payload `identifier_symbol_block` appends.
const IDENTIFIER_SYMBOL_MARK: &str = "[find_symbol ";
/// Notes the two read-side levers append to their own result, so the ruler can
/// count them as FACT instead of inferring them from the round count.
const READ_MERGED_MARK: &str = "[read] merged ";
const READ_COVERED_MARK: &str = "already returned above";
/// Marks a `read` block whose window was stretched to the end of the file (see
/// `file_window_upto`): the tail is already on the wire, so asking for it again
/// is a whole round trip for bytes the model is looking at.
const READ_TO_EOF_MARK: &str = "[read] extended ";
/// Marker of the outline `read` attaches to a window of a LARGE file, so the
/// model can jump straight to the lines it needs instead of walking the file.
const READ_OUTLINE_MARK: &str = "[read] outline ";
/// Shortest file that earns an outline. Below this a window IS the whole file,
/// so an outline would be pure overhead on every read of a small module.
const READ_OUTLINE_MIN_LINES: usize = 400;

mod diff;
mod dispatch;
mod hints;
mod outline;
mod paths;
mod read;
mod search;
mod terminal;
mod write;

// Private glob re-imports keep every item visible to the sibling parts and to
// the test modules exactly as in the single-file module. The `pub use` lines
// reproduce the original `tools` surface — nothing new is exposed.
// Glob re-imports used by the test modules (cfg(test)) and cross-part helpers.
#[allow(unused_imports)]
use diff::*;
#[allow(unused_imports)]
use dispatch::*;
#[allow(unused_imports)]
use terminal::*;

#[cfg(test)]
mod diff_tests;
#[cfg(test)]
mod tests;

use hints::*;
use outline::*;
use paths::*;
use read::*;
use search::*;
use write::*;

pub use diff::unified_diff;
#[allow(unused_imports)] // original tools API surface, preserved verbatim
pub use dispatch::{dispatch, dispatch_with_data_root, dispatch_bounded, dispatch_bounded_with};
pub use outline::{find_symbol, find_symbol_in};
#[allow(unused_imports)] // original tools API surface, preserved verbatim
pub use paths::{absolute_target, resolve_safe, is_inside_root, PathAccess, path_access, lookup_paths, writer_gate_paths};
#[allow(unused_imports)] // original tools API surface, preserved verbatim
pub use read::{read_window, read_window_block, read_window_block_capped, numbered_window, parse_ranges, read_pre_edit};
#[allow(unused_imports)] // original tools API surface, preserved verbatim
pub use search::{count_grep_alternatives, broad_pattern_refusal, layout_snapshot, grep_scope, grep_scope_in, glob_scope, glob_scope_in};
pub use terminal::{run_terminal, run_terminal_bounded, run_terminal_bounded_with};
pub use write::{edit_file, write_file};
pub(crate) use hints::levers_fired;
#[allow(unused_imports)] // used by agent tests under cfg(test)
pub(crate) use paths::tool_dirs;
pub(crate) use read::{read_windows_of, read_extended_spans, DIR_LIST_LIMIT, POST_EDIT_STALE_NOTE};
pub(crate) use outline::reset_outline_claims;
