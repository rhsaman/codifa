//! Native memory store mirroring memory_manager.py's JSONL layer.
//!
//! Source of truth is `{data_root}/memory/memories.jsonl`; notes are scoped
//! per project (project_id = workspace root), deduped, TTL-bounded and capped.
//! Semantic (vector) recall stays on the Python sidecar until phase 4 — this
//! module covers the lexical store the native agent loop needs.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MEMORY_TYPES: [&str; 4] = ["permanent", "long_term", "task", "short_term"];
/// Default TTLs in seconds (permanent = never expires).
const TTL: [(&str, Option<f64>); 4] = [
    ("permanent", None),
    ("long_term", Some(24.0 * 365.0 * 3600.0)),
    ("task", Some(6.0 * 3600.0)),
    ("short_term", Some(24.0 * 3600.0)),
];
const MAX_NOTES: usize = 500;
const MAX_CONTENT: usize = 4000;
const SEARCH_MAX_RESULTS: usize = 15;

static MEM_LOCK: Mutex<()> = Mutex::new(());

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// `{data_root}/memory/memories.jsonl` — data root mirrors the sidecar's
/// CODER_DATA_DIR default (~/.codifa).
pub fn memories_path() -> PathBuf {
    let root = std::env::var("CODER_DATA_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codifa")))
        .unwrap_or_else(|| PathBuf::from("."));
    root.join("memory").join("memories.jsonl")
}

fn ttl_for(memory_type: &str) -> Option<f64> {
    TTL.iter()
        .find(|(t, _)| *t == memory_type)
        .and_then(|(_, ttl)| *ttl)
}

fn load_all(path: &PathBuf) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(|rec| rec.get("id").is_some())
        })
        .collect()
}

fn write_all(path: &PathBuf, mems: &[Value]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let body: String = mems
        .iter()
        .filter_map(|m| serde_json::to_string(m).ok())
        .map(|s| s + "\n")
        .collect();
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn expired(rec: &Value, at: f64) -> bool {
    rec.get("expires_at")
        .and_then(Value::as_f64)
        .map(|exp| exp < at)
        .unwrap_or(false)
}

/// Store a note; dedupes near-duplicates per project (normalized substring).
/// Returns `{"memory": id, "ok": true}` / `{"skipped": "duplicate", ...}`.
pub fn add(content: &str, memory_type: &str, project_id: &str) -> Value {
    let content = content.trim();
    if content.is_empty() {
        return json!({"error": "empty note"});
    }
    let memory_type = if MEMORY_TYPES.contains(&memory_type) {
        memory_type
    } else {
        "long_term"
    };
    let content = if content.len() > MAX_CONTENT {
        // Cut on a UTF-8 char boundary — byte-slicing multi-byte text panics.
        let mut end = MAX_CONTENT;
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\u{2026}", &content[..end])
    } else {
        content.to_string()
    };
    let ts = now();
    let mid: String = uuid();
    let rec = json!({
        "id": mid,
        "memory_type": memory_type,
        "content": content,
        "project_id": project_id,
        "source": "agent",
        "source_id": "",
        "confidence": 1.0,
        "created_at": ts,
        "updated_at": ts,
        "last_accessed_at": ts,
        "expires_at": ttl_for(memory_type).map(|ttl| ts + ttl),
    });

    let _guard = MEM_LOCK.lock();
    let path = memories_path();
    let mut mems = load_all(&path);
    let norm = normalize(&content);
    for m in &mems {
        if m.get("project_id").and_then(Value::as_str) == Some(project_id)
            && !norm.is_empty()
            && normalize(m.get("content").and_then(Value::as_str).unwrap_or("")).contains(&norm)
        {
            return json!({
                "memory": m.get("id"),
                "ok": true,
                "skipped": "duplicate",
                "matched": m.get("id"),
            });
        }
    }
    // Enforce the cap: drop the oldest non-permanent notes by last access.
    if mems.len() >= MAX_NOTES {
        let mut droppable: Vec<usize> = mems
            .iter()
            .enumerate()
            .filter(|(_, m)| m.get("memory_type").and_then(Value::as_str) != Some("permanent"))
            .map(|(i, _)| i)
            .collect();
        droppable.sort_by(|&a, &b| {
            let ka = mems[a]
                .get("last_accessed_at")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let kb = mems[b]
                .get("last_accessed_at")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            ka.total_cmp(&kb)
        });
        let excess = mems.len() - MAX_NOTES + 1;
        let drop: Vec<usize> = droppable.into_iter().take(excess).collect();
        for idx in drop.into_iter().rev() {
            mems.remove(idx);
        }
    }
    mems.push(rec);
    if let Err(e) = write_all(&path, &mems) {
        return json!({"error": e});
    }
    json!({"memory": mid, "ok": true})
}

/// Lexical search: exact word hit scores 0.55, substring 0.9 (mirrors the
/// Python scoring). Matching notes get their last_accessed_at touched
/// (sliding TTL). Expired notes are skipped.
pub fn search(query: &str, project_id: &str, limit: usize) -> Vec<Value> {
    let norm_q = normalize(query);
    if norm_q.is_empty() {
        return Vec::new();
    }
    let words: Vec<&str> = norm_q.split_whitespace().collect();
    let ts = now();
    let _guard = MEM_LOCK.lock();
    let path = memories_path();
    let mut mems = load_all(&path);
    let mut scored: Vec<(f64, Value)> = mems
        .iter_mut()
        .filter(|m| {
            project_id.is_empty()
                || m.get("project_id").and_then(Value::as_str) == Some(project_id)
        })
        .filter(|m| !expired(m, ts))
        .filter_map(|m| {
            let norm_c = normalize(m.get("content").and_then(Value::as_str)?);
            let score = if words.iter().any(|w| norm_c.contains(w)) {
                0.55
            } else {
                return None;
            };
            let score = if norm_c.contains(&norm_q) { 0.9 } else { score };
            // Sliding TTL: touch the note so hot knowledge survives.
            if let Some(obj) = m.as_object_mut() {
                obj.insert("last_accessed_at".into(), json!(ts));
            }
            Some((score, m.clone()))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let _ = write_all(&path, &mems);
    scored
        .into_iter()
        .take(limit.min(SEARCH_MAX_RESULTS))
        .map(|(score, mut m)| {
            if let Some(obj) = m.as_object_mut() {
                obj.insert("score".into(), json!(score));
            }
            m
        })
        .collect()
}

/// Delete one note by id; returns true when a note was removed.
pub fn delete(mid: &str) -> bool {
    let _guard = MEM_LOCK.lock();
    let path = memories_path();
    let mut mems = load_all(&path);
    let before = mems.len();
    mems.retain(|m| m.get("id").and_then(Value::as_str) != Some(mid));
    if mems.len() == before {
        return false;
    }
    write_all(&path, &mems).is_ok()
}

fn uuid() -> String {
    let ts = now().to_bits();
    format!("{:012x}", ts ^ (std::process::id() as u64) << 32)
}

#[cfg(test)]
    pub(crate) mod tests {
    use super::*;

    fn isolated(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-mem-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("CODER_DATA_DIR", &dir);
        dir
    }

    /// Serialize tests that mutate CODER_DATA_DIR (set_var is process-global
    /// and parallel tests would otherwise race on the shared env). Public so
    /// the trace tests (which also mutate the env) share the same lock —
    /// two separate locks would deadlock.
    pub(crate) static DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn add_dedupes_and_searches() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("dedup");
        assert_eq!(add("uses uv add for python packages", "long_term", "/w")["ok"], json!(true));
        // Near-duplicate: the new note's normalized text is a substring of an
        // existing note in the same project (same direction as Python).
        let dup = add("uses uv add for python", "long_term", "/w");
        assert_eq!(dup["skipped"], json!("duplicate"));
        // Different project is a separate note.
        assert_eq!(add("uses uv add for python packages", "long_term", "/other")["ok"], json!(true));

        let hits = search("python packages", "/w", 15);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["score"], json!(0.9));
        assert_eq!(hits[0]["project_id"], json!("/w"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_and_unknown_type_are_handled() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("types");
        assert!(add("   ", "long_term", "/w").get("error").is_some());
        // Unknown type falls back to long_term.
        let rec = add("note about rust", "bogus", "/w");
        assert_eq!(rec["ok"], json!(true));
        let hits = search("rust", "/w", 15);
        assert_eq!(hits[0]["memory_type"], json!("long_term"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_truncates_on_char_boundary() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("utf8");
        // Multi-byte Persian text longer than MAX_CONTENT must not panic.
        let long_fa = "مهاجرت به تائوری".repeat(400);
        let rec = add(&long_fa, "long_term", "/w");
        assert_eq!(rec["ok"], json!(true));
        let hits = search("مهاجرت", "/w", 15);
        assert_eq!(hits.len(), 1);
        let stored = hits[0]["content"].as_str().unwrap();
        assert!(stored.chars().count() <= MAX_CONTENT + 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_removes_only_target() {
        let _env = DATA_DIR_LOCK.lock();
        let dir = isolated("delete");
        add("alpha note", "long_term", "/w");
        let rec = add("beta note", "long_term", "/w");
        let mid = rec["memory"].as_str().unwrap().to_string();
        assert!(delete(&mid));
        assert!(!delete(&mid));
        let hits = search("note", "/w", 15);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["content"], json!("alpha note"));
        let _ = fs::remove_dir_all(dir);
    }
}
