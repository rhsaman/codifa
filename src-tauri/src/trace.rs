//! Native trace store — the right-panel Trace reads entries via
//! GET /chats/{chat_id}/traces, the same endpoint the Python sidecar
//! serves. Entries mirror the frontend TraceEntry shape (src/types.ts).

use axum::response::IntoResponse;
use serde_json::{json, Value};
use std::path::PathBuf;
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
    pub total: u64,
}

/// Per-chat trace log, persisted as JSONL under {data_root}/traces/.
pub struct TraceStore {
    chat_id: String,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

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
                "input": t.input, "output": t.output, "total": t.total,
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
    }
}

/// GET /chats/{chat_id}/traces — newest last, same shape as the sidecar.
pub async fn traces_list(
    axum::extract::Path(chat_id): axum::extract::Path<String>,
) -> axum::response::Response {
    let mut rows: Vec<Value> = Vec::new();
    if let Some(dir) = traces_dir() {
        let path = dir.join(format!("{}.jsonl", sanitize(&chat_id)));
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    rows.push(v);
                }
            }
        }
    }
    axum::Json(json!({ "traces": rows })).into_response()
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
            tokens: Some(Tokens { input: 7, output: 3, total: 10 }),
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
        std::fs::remove_file(&path).ok();
        // Restore the previous env so parallel tests are unaffected.
        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
    }
}
