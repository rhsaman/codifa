//! Native trace store — the right-panel Trace reads entries via
//! GET /chats/{chat_id}/traces, the same endpoint the Python sidecar
//! serves. Entries mirror the frontend TraceEntry shape (src/types.ts).

use axum::response::IntoResponse;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// One trace row: kind=llm (model+tokens) / prompt / tool (args+result).
#[derive(Debug, Clone, Default)]
pub struct TraceEntry {
    pub kind: String,
    pub summary: String,
    pub model: Option<String>,
    pub tokens: Option<Tokens>,
    pub error: Option<String>,
    pub prompt: Option<String>,
    pub result: Option<String>,
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct Tokens {
    /// INCLUSIVE billed input: the provider's whole input footprint with the
    /// cache share inside it (`llm::NormalizedUsage::input_total`), so a call's
    /// cost math and cold/warm split need no per-provider cases.
    pub input: u64,
    pub output: u64,
    /// The part of `input` the provider served from its prefix cache. Already
    /// counted inside `input`; recorded separately so the ruler can report a
    /// cache-hit rate instead of a guess.
    pub cache_read: u64,
    /// The part of the input that FILLED the cache this call (Anthropic
    /// `cache_creation_input_tokens` — a cold call is all write). Already
    /// counted inside `input`; a warm call reports reads instead.
    pub cache_write: u64,
    /// The usage payload carried a cache field at all — a gateway that reports
    /// nothing must stay "not reported" (the ruler prints the state) instead
    /// of masquerading as a genuine 0% hit rate.
    pub cache_read_reported: bool,
    pub cache_write_reported: bool,
    pub total: u64,
}

/// Per-chat trace log, persisted as JSONL under {data_root}/traces/.
pub struct TraceStore {
    chat_id: String,
    /// Identifier of the agent run that owns this store.
    ///
    /// Every row written through one `TraceStore` carries it. Without it a
    /// trace file is unattributable: the main agent fans its `explore` calls
    /// out CONCURRENTLY (`join_all`) and every sibling inherits the parent's
    /// `chat_id`, so their rows interleave in the SAME file. Rows only had
    /// `kind`/`tokens`, and the ruler attributed them to main-or-explore by
    /// POSITION (the last `prompt` row seen) — which silently billed a
    /// still-running sibling's calls to the main agent as soon as the first
    /// sibling finished and its card closed. `run_id` makes the split exact.
    run_id: u64,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Launch time of this process in ms, fixed on first use.
///
/// `SEQ` restarts at 0 on every launch while the JSONL log survives restarts, so
/// a bare sequence number reused the ids of earlier runs (`t0`, `t1`, …). The
/// panel dedups by id, so after a restart every new row that collided with an
/// old one was silently dropped and the trace stopped being live.
fn boot_stamp() -> u64 {
    static BOOT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *BOOT.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// Hard size cap for one chat's trace log.
///
/// The system prompt is re-logged on EVERY LLM call (8-36 KB each), so a busy
/// chat adds megabytes per hour. The age-based TTL cannot protect the disk from
/// a single runaway file inside one day, so the log is also capped by bytes:
/// past this size the OLDEST entries are dropped.
pub(crate) const TRACE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// What a trimmed log keeps. Well below the cap, so the rewrite happens once
/// every few hundred entries instead of on every single append.
pub(crate) const TRACE_KEEP_BYTES: u64 = 6 * 1024 * 1024;

/// Trim `path` when it is larger than `max`, keeping the newest whole lines
/// that fit in `keep`. Returns true when the file was rewritten.
///
/// Shared by the write path (every append re-checks the size) and the retention
/// sweep (which repairs a log left oversized by an older build).
pub(crate) fn trim_oversized_with(path: &Path, max: u64, keep: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() <= max {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    // Walk the log BACKWARDS (the panel reads it newest-first) and keep the
    // newest lines that fit. Only whole lines survive, so the rewritten file is
    // always valid JSONL — a torn row would be skipped on read but still waste
    // bytes and confuse the entry count.
    let budget = keep as usize;
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0usize;
    for line in content.lines().rev() {
        let n = line.len() + 1;
        if bytes + n > budget {
            break;
        }
        bytes += n;
        kept.push(line);
    }
    kept.reverse();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    write_atomic_text(path, &out)
}

/// Drop the oldest entries of a trace log when it exceeds the byte cap.
pub(crate) fn trim_oversized(path: &Path) -> bool {
    trim_oversized_with(path, TRACE_MAX_BYTES, TRACE_KEEP_BYTES)
}

/// Replace `path` with `text` in one step: a crash mid-trim must never publish a
/// half-written log, which readers would see as a truncated JSONL.
fn write_atomic_text(path: &Path, text: &str) -> bool {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("jsonl.tmp{}.{}", std::process::id(), unique));
    if std::fs::write(&tmp, text).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

pub fn traces_dir() -> Option<PathBuf> {
    let root = match std::env::var("CODER_DATA_DIR") {
        Ok(r) if !r.is_empty() => PathBuf::from(r),
        // The app process itself may not have CODER_DATA_DIR set (it is
        // only injected into the sidecar's env) — fall back to the same
        // default the sidecar uses so traces land in ~/.codifa/traces.
        _ => dirs::home_dir()?.join(".codifa"),
    };
    Some(root.join("traces"))
}

fn sanitize(chat_id: &str) -> String {
    chat_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

impl TraceStore {
    pub fn new(chat_id: String) -> Self {
        Self { chat_id, run_id: 0 }
    }

    /// Same store, stamped with the id of the run that owns it.
    ///
    /// `run_id` is the metric that makes concurrency survivable in one file:
    /// concurrent explore siblings write interleaved rows, and this is the only
    /// field that tells them apart (each sibling has its own id).
    pub fn with_run(mut self, run_id: u64) -> Self {
        self.run_id = run_id;
        self
    }

    /// The run this store was stamped with (0 when unstamped).
    #[cfg(test)]
    pub fn run_id(&self) -> u64 {
        self.run_id
    }

    /// Append one entry to the chat's JSONL trace file.
    pub fn record(&self, entry: TraceEntry) {
        if self.chat_id.is_empty() {
            return;
        }
        let Some(dir) = traces_dir() else { return };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let id = format!("t{}-{}", boot_stamp(), SEQ.fetch_add(1, Ordering::Relaxed));
        let row = json!({
            "id": id,
            // Which run produced this row. Concurrent explore siblings share one
            // chat id and therefore one file, so this is the ONLY exact way to
            // attribute a row; the ruler maps `run` -> main/explore through the
            // matching `prompt` row. 0 on rows written by an unstamped store.
            "run": self.run_id,
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            "kind": entry.kind,
            "summary": entry.summary,
            "model": entry.model,
            "tokens": entry.tokens.map(|t| json!({
                "input": t.input, "output": t.output,
                "cache_read": t.cache_read, "cache_write": t.cache_write,
                "cache_read_reported": t.cache_read_reported,
                "cache_write_reported": t.cache_write_reported,
                "total": t.total,
            })),
            "error": entry.error,
            "prompt": entry.prompt,
            "result": entry.result,
            "detail": entry.detail,
        });
        let path = dir.join(format!("{}.jsonl", sanitize(&self.chat_id)));
        // Append-only single line; a torn last line is skipped on read.
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "{row}");
        }
        // Keep the log bounded: one `stat` per entry, and a rewrite only when the
        // cap is actually crossed, so a long chat can never fill the disk between
        // TTL sweeps.
        trim_oversized(&path);
    }
}

/// Page size used when the caller does not ask for one.
fn default_trace_limit() -> usize {
    200
}

/// Upper bound on `limit`, so a hand-written query cannot pull a whole log.
const TRACE_LIMIT_MAX: usize = 2000;

#[derive(serde::Deserialize)]
pub struct TracesQuery {
    #[serde(default = "default_trace_limit")]
    limit: usize,
    /// How many entries back from the END of the log the page starts at:
    /// `0` is the newest page, `entries.len()` is the next older one. Measured
    /// against the SAME filter the page uses, so paging never skips a row.
    #[serde(default)]
    before: usize,
    /// Restrict the page to one trace kind (`llm` / `prompt` / `tool`). The tab
    /// counts returned alongside are still computed over the WHOLE log, so the
    /// badges stay honest while a page is all that is in memory.
    #[serde(default)]
    kind: String,
    /// Include sub-agent tool calls in a `kind=tool` page. The Tools tab mirrors
    /// the chat's tool cards, which nest a sub-agent's calls under its parent
    /// card, so the panel asks for top-level tools only unless it is showing a
    /// sub-agent's own trace.
    #[serde(default)]
    sub: bool,
}

/// Only the fields the counts and the filter need; everything else is skipped.
///
/// Counting the whole log used to mean fully deserializing every line, and each
/// `kind:"prompt"` row carries a ~35 KB system prompt — so counting alone
/// allocated tens of MB. Serde skips the heavy fields without allocating them
/// (`detail` is kept because it is small and carries the `sub` flag).
#[derive(serde::Deserialize)]
struct TraceKind {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    detail: Value,
}

impl TraceKind {
    /// A sub-agent tool call (nested under its parent card in the chat).
    fn is_sub(&self) -> bool {
        self.detail
            .get("sub")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

/// Counts over the whole log: `[all, llm, prompt, tool, tool_without_sub, fold]`.
type TraceCounts = [usize; 6];

/// Slice one page out of the log and count the whole log's kinds.
///
/// Returns `(page, counts)`: `counts` covers every PARSEABLE line (not just the
/// page), so the panel's tab badges stay honest while only a page or two of
/// entries is in memory.
fn trace_page(
    lines: &[&str],
    limit: usize,
    before: usize,
    kind: &str,
    include_sub: bool,
) -> (Vec<Value>, TraceCounts) {
    let mut counts: TraceCounts = [0; 6];
    // Indices of the entries this page may draw from, in log order.
    let mut matching: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Ok(k) = serde_json::from_str::<TraceKind>(line) else {
            continue;
        };
        counts[0] += 1;
        match k.kind.as_str() {
            "llm" => counts[1] += 1,
            "prompt" => counts[2] += 1,
            // An in-turn fold. Counted separately because it is the event that
            // resets the prefix cache: seeing how often it fires is the whole
            // point of recording it.
            "fold" => counts[5] += 1,
            "tool" => {
                counts[3] += 1;
                if !k.is_sub() {
                    counts[4] += 1;
                }
            }
            _ => {}
        }
        // The All tab shows everything; the Tools tab mirrors the chat's cards,
        // i.e. top-level calls only unless a sub-agent trace is being viewed.
        let wanted = if kind.is_empty() {
            true
        } else if kind == "tool" {
            k.kind == "tool" && (include_sub || !k.is_sub())
        } else {
            k.kind == kind
        };
        if wanted {
            matching.push(i);
        }
    }
    let total = matching.len();
    let end = total.saturating_sub(before);
    let start = end.saturating_sub(limit);
    let mut page: Vec<Value> = Vec::new();
    for i in &matching[start..end] {
        if let Ok(v) = serde_json::from_str::<Value>(lines[*i]) {
            page.push(v);
        }
    }
    (page, counts)
}

/// Number of entries the given filter can return, from whole-log counts.
fn matching_total(counts: &TraceCounts, kind: &str, include_sub: bool) -> usize {
    match kind {
        "" => counts[0],
        "llm" => counts[1],
        "prompt" => counts[2],
        "fold" => counts[5],
        "tool" => {
            if include_sub {
                counts[3]
            } else {
                counts[4]
            }
        }
        _ => 0,
    }
}

/// GET /chats/{chat_id}/traces — the newest page by default.
///
/// The whole log used to be returned on every 2s poll. A long chat's log reaches
/// several MB (the system prompt is re-logged on every LLM call), which put tens
/// of MB into the renderer heap for a panel that shows one screenful. The panel
/// now asks for a page and walks backwards with `before` on scroll-up.
pub async fn traces_list(
    axum::extract::Path(chat_id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<TracesQuery>,
) -> axum::response::Response {
    let limit = q.limit.clamp(1, TRACE_LIMIT_MAX);
    // Reading and parsing a log of up to TRACE_MAX_BYTES is blocking work, and
    // the panel asks every second on a router with only two async workers.
    // Inline, it starved every other request (the panel's own poll included),
    // so the trace stopped being live. Run it on the blocking pool.
    let (before, kind, sub) = (q.before, q.kind.clone(), q.sub);
    let (page, counts) = tokio::task::spawn_blocking(move || {
        let mut counts: TraceCounts = [0; 6];
        let mut page: Vec<Value> = Vec::new();
        if let Some(dir) = traces_dir() {
            let path = dir.join(format!("{}.jsonl", sanitize(&chat_id)));
            if let Ok(content) = std::fs::read_to_string(&path) {
                // Keep empty lines out so `before` counts real entries.
                let lines: Vec<&str> =
                    content.lines().filter(|l| !l.trim().is_empty()).collect();
                let (p, c) = trace_page(&lines, limit, before, &kind, sub);
                page = p;
                counts = c;
            }
        }
        (page, counts)
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), [0; 6]));
    axum::Json(json!({
        "traces": page,
        // Total for the ACTIVE filter: the panel compares it with what it holds
        // to decide whether an older page still exists.
        "total": matching_total(&counts, &q.kind, q.sub),
        "counts": {
            "all": counts[0],
            "llm": counts[1],
            "prompt": counts[2],
            "fold": counts[5],
            "tool": if q.sub { counts[3] } else { counts[4] },
        },
    }))
    .into_response()
}

/// DELETE /chats/{chat_id}/traces — clear the chat's trace log.
pub async fn traces_clear(
    axum::extract::Path(chat_id): axum::extract::Path<String>,
) -> axum::response::Response {
    let mut removed = 0u64;
    if let Some(dir) = traces_dir() {
        let path = dir.join(format!("{}.jsonl", sanitize(&chat_id)));
        if let Ok(content) = std::fs::read_to_string(&path) {
            removed = content.lines().filter(|l| !l.trim().is_empty()).count() as u64;
        }
        let _ = std::fs::remove_file(&path);
    }
    axum::Json(json!({ "ok": true, "removed": removed })).into_response()
}

#[cfg(test)]
mod tests;
