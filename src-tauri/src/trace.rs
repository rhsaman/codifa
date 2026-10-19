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
    pub input: u64,
    pub output: u64,
    /// The part of `input` the provider served from its prefix cache. Already
    /// counted inside `input`; recorded separately so the ruler can report a
    /// cache-hit rate instead of a guess.
    pub cache_read: u64,
    pub total: u64,
}

/// Per-chat trace log, persisted as JSONL under {data_root}/traces/.
pub struct TraceStore {
    chat_id: String,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

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
        Self { chat_id }
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
        let id = format!("t{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let row = json!({
            "id": id,
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            "kind": entry.kind,
            "summary": entry.summary,
            "model": entry.model,
            "tokens": entry.tokens.map(|t| json!({
                "input": t.input, "output": t.output,
                "cache_read": t.cache_read, "total": t.total,
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

/// Counts over the whole log: `[all, llm, prompt, tool, tool_without_sub]`.
type TraceCounts = [usize; 5];

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
    let mut counts: TraceCounts = [0; 5];
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
    let mut page: Vec<Value> = Vec::new();
    let mut counts: TraceCounts = [0; 5];
    if let Some(dir) = traces_dir() {
        let path = dir.join(format!("{}.jsonl", sanitize(&chat_id)));
        if let Ok(content) = std::fs::read_to_string(&path) {
            // Keep empty lines out so `before` counts real entries.
            let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
            let (p, c) = trace_page(&lines, limit, q.before, &q.kind, q.sub);
            page = p;
            counts = c;
        }
    }
    axum::Json(json!({
        "traces": page,
        // Total for the ACTIVE filter: the panel compares it with what it holds
        // to decide whether an older page still exists.
        "total": matching_total(&counts, &q.kind, q.sub),
        "counts": {
            "all": counts[0],
            "llm": counts[1],
            "prompt": counts[2],
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
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(sanitize("abc-123_x"), "abc-123_x");
        assert_eq!(sanitize("a/b c"), "a_b_c");
    }

    #[test]
    fn trace_page_walks_backwards_from_the_newest() {
        let rows: Vec<String> = (0..5)
            .map(|i| format!(r#"{{"id":"t{i}","kind":"tool"}}"#))
            .collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        // The newest page is the LAST `limit` entries, in log order.
        let (page, counts) = trace_page(&lines, 2, 0, "", true);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["id"], "t3");
        assert_eq!(page[1]["id"], "t4");
        assert_eq!(counts[0], 5);
        // `before` = already loaded, so the next page is the two above it.
        let (older, _) = trace_page(&lines, 2, 2, "", true);
        assert_eq!(older.len(), 2);
        assert_eq!(older[0]["id"], "t1");
        assert_eq!(older[1]["id"], "t2");
        // Past the start: return what exists, never an error.
        let (rest, _) = trace_page(&lines, 2, 4, "", true);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["id"], "t0");
        let (none, _) = trace_page(&lines, 2, 9, "", true);
        assert!(none.is_empty());
    }

    #[test]
    fn trace_page_filters_by_kind_without_skipping_rows() {
        // 3 tools interleaved with llm/prompt rows.
        let lines = [
            r#"{"id":"a","kind":"tool"}"#,
            r#"{"id":"b","kind":"llm"}"#,
            r#"{"id":"c","kind":"tool"}"#,
            r#"{"id":"d","kind":"prompt"}"#,
            r#"{"id":"e","kind":"tool"}"#,
        ];
        // Newest tool page.
        let (page, counts) = trace_page(&lines, 2, 0, "tool", false);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["id"], "c");
        assert_eq!(page[1]["id"], "e");
        // Older tool page continues exactly where the first stopped.
        let (older, _) = trace_page(&lines, 2, 2, "tool", false);
        assert_eq!(older.len(), 1);
        assert_eq!(older[0]["id"], "a");
        // Counts stay whole-log regardless of the filter.
        assert_eq!(counts, [5, 1, 1, 3, 3]);
    }

    /// The Tools tab mirrors the chat's cards: a sub-agent's own calls nest
    /// under its parent card, so they must not be paged into the top-level list
    /// (but a sub-agent trace view asks for them with `sub=true`).
    #[test]
    fn trace_page_excludes_sub_tools_unless_asked() {
        let lines = [
            r#"{"id":"top1","kind":"tool"}"#,
            r#"{"id":"deep","kind":"tool","detail":{"sub":true}}"#,
            r#"{"id":"top2","kind":"tool"}"#,
        ];
        let (page, counts) = trace_page(&lines, 10, 0, "tool", false);
        let ids: Vec<&str> = page.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["top1", "top2"]);
        assert_eq!(counts, [3, 0, 0, 3, 2]);
        assert_eq!(matching_total(&counts, "tool", false), 2);
        assert_eq!(matching_total(&counts, "tool", true), 3);
        // A sub-agent's own trace shows everything.
        let (all, _) = trace_page(&lines, 10, 0, "tool", true);
        assert_eq!(all.len(), 3);
        // The All tab is never filtered by `sub`.
        let (everything, _) = trace_page(&lines, 10, 0, "", false);
        assert_eq!(everything.len(), 3);
    }

    #[test]
    fn trace_page_counts_kinds_across_the_whole_log() {
        let lines = [
            r#"{"kind":"llm"}"#,
            r#"{"kind":"prompt"}"#,
            r#"{"kind":"tool"}"#,
            r#"{"kind":"tool"}"#,
            "not json",
        ];
        let (page, counts) = trace_page(&lines, 10, 0, "", true);
        assert_eq!(counts, [4, 1, 1, 2, 2]);
        assert_eq!(page.len(), 4);
        // A torn/unparsable line is skipped, not counted.
        assert_eq!(counts[0], 4);
    }

    /// A runaway trace log is trimmed from the OLDEST end, keeping whole lines
    /// so the rewritten file is still valid JSONL.
    #[test]
    fn trim_oversized_keeps_the_newest_whole_lines() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-trace-trim-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.jsonl");
        // 10 rows of ~20 bytes each.
        let mut text = String::new();
        for i in 0..10 {
            text.push_str(&format!(r#"{{"id":"t{i}","kind":"tool"}}"#));
            text.push('\n');
        }
        std::fs::write(&path, &text).unwrap();

        // Cap 100 bytes, keep 60: the newest lines that fit survive.
        assert!(trim_oversized_with(&path, 100, 60));
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.len() <= 60);
        assert!(after.ends_with('\n'));
        for line in after.lines() {
            let v: Value = serde_json::from_str(line).expect("whole lines only");
            assert!(v["id"].is_string());
        }
        // The newest entry is always kept (the panel reads it first).
        assert!(after.contains(r#""t9""#), "newest entry survived: {after}");
        assert!(!after.contains(r#""t0""#), "oldest entry dropped: {after}");

        // Under the cap: untouched.
        assert!(!trim_oversized_with(&path, 1_000_000, 600_000));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_and_read_roundtrip() {
        // Use a unique chat id per run instead of touching the process-global
        // CODER_DATA_DIR (parallel tests read it — mutating it races).
        let chat = format!("trace-test-{}", std::process::id());
        // Serialize with the memory tests: CODER_DATA_DIR is process-global
        // (set_var races with parallel tests that also mutate it). Reuse the
        // memory tests' lock — two separate locks would deadlock (test A holds
        // its lock while waiting for the env, test B holds the env).
        let _env = crate::memory::tests::DATA_DIR_LOCK.lock();
        // The store resolves CODER_DATA_DIR lazily on every record/read, so
        // the env var must be set BEFORE the first record call. Other tests
        // (memory) also set it — always overwrite with our own temp dir and
        // restore afterwards to keep the parallel suite deterministic.
        let prev = std::env::var("CODER_DATA_DIR").ok();
        let tmp = std::env::temp_dir().join(format!("codifa-trace-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::env::set_var("CODER_DATA_DIR", &tmp);
        let store = TraceStore::new(chat.clone());
        store.record(TraceEntry {
            kind: "llm".into(),
            summary: "m · 10 tokens".into(),
            model: Some("m".into()),
            tokens: Some(Tokens { input: 7, output: 3, cache_read: 4, total: 10 }),
            ..Default::default()
        });
        store.record(TraceEntry {
            kind: "tool".into(),
            summary: "grep".into(),
            result: Some("3 matches".into()),
            ..Default::default()
        });
        let dir = traces_dir().expect("CODER_DATA_DIR set above");
        let path = dir.join(format!("{chat}.jsonl"));
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["kind"], "llm");
        assert_eq!(first["tokens"]["total"], 10);
        assert_eq!(first["tokens"]["cache_read"], 4);
        std::fs::remove_file(&path).ok();
        // Restore the previous env so parallel tests are unaffected.
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
    }
}
