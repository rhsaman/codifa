//! Native RAG vector store: one SQLite file per workspace.
//!
//! Mirrors `backend/vector_store.py`. The Python version leaned on the
//! `sqlite-vec` extension for ANN search; here the vectors live in a plain
//! `chunks` table and similarity is a brute-force cosine scan in Rust. The
//! store is capped (`max_chunks`, default 4000), so a full scan is a few
//! milliseconds and removes the extension dependency entirely.
//!
//! Layout (same file names as the Python store, so an existing DB keeps
//! working): `{base_dir}/{workspace_slug}.vectors.sqlite`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::embeddings;

/// Doc kinds, mirroring the Python constants.
pub const KIND_FILE: &str = "file";

/// Retention limits, mirroring `StoreConfig` defaults.
#[derive(Debug, Clone, Copy)]
pub struct StoreConfig {
    pub max_docs: usize,
    pub max_chunks: usize,
    pub ttl_days: i64,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            max_docs: 500,
            max_chunks: 4_000,
            ttl_days: 180,
        }
    }
}

impl StoreConfig {
    /// Build from the settings dict the frontend sends (snake_case keys).
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let mut cfg = Self::default();
        let Some(obj) = v.and_then(|v| v.as_object()) else {
            return cfg;
        };
        if let Some(n) = obj.get("max_docs").and_then(|v| v.as_u64()) {
            cfg.max_docs = (n as usize).max(10);
        }
        if let Some(n) = obj.get("max_chunks").and_then(|v| v.as_u64()) {
            cfg.max_chunks = (n as usize).max(50);
        }
        if let Some(n) = obj.get("ttl_days").and_then(|v| v.as_i64()) {
            cfg.ttl_days = n.max(1);
        }
        cfg
    }
}

/// Aggregate counts for `/memory/stats`.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub docs: i64,
    pub chunks: i64,
    pub kinds: Vec<(String, i64)>,
}

/// The per-workspace store. `Connection` is not `Sync`, so it is guarded.
pub struct VectorStore {
    conn: Mutex<Connection>,
    config: StoreConfig,
}

/// `{base_dir}/{slug}.vectors.sqlite` — the same name the Python store used.
pub fn db_path_for(base_dir: &Path, workspace_slug: &str) -> PathBuf {
    base_dir.join(format!("{workspace_slug}.vectors.sqlite"))
}

/// Stable per-workspace slug: the absolute path with separators folded to `-`.
///
/// Mirrors `state_db.workspace_slug_for_root` so both sides resolve the same
/// file for the same workspace.
pub fn workspace_slug_for_root(root: &str) -> String {
    let abs = std::fs::canonicalize(root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| root.to_string());
    let slug: String = abs
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed
    }
}

impl VectorStore {
    /// Open (creating if needed) the store at `db_path`.
    pub fn open(db_path: &Path, config: StoreConfig) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;
        }
        let conn = Connection::open(db_path).map_err(|e| format!("open db failed: {e}"))?;
        let store = Self {
            conn: Mutex::new(conn),
            config,
        };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS docs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                kind TEXT NOT NULL,
                file_path TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL DEFAULT '',
                fetched_at REAL NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                embedding_model TEXT NOT NULL DEFAULT ''
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_key ON docs(key);
            CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind);
            CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(file_path);
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER NOT NULL,
                ord INTEGER NOT NULL,
                txt TEXT NOT NULL,
                vec BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
            CREATE TABLE IF NOT EXISTS meta (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| format!("schema init failed: {e}"))?;
        Ok(())
    }

    fn meta_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row("SELECT v FROM meta WHERE k = ?1", params![key], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .ok()
        .flatten()
    }

    fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![key, value],
        )
        .map_err(|e| format!("meta write failed: {e}"))?;
        Ok(())
    }

    /// Vector width actually stored, so a model swap is detected.
    pub fn stored_dim(&self) -> Option<usize> {
        self.meta_get("dim").and_then(|v| v.parse().ok())
    }

    /// Record the current model's width; a change invalidates old vectors.
    pub fn ensure_dim(&self) -> Result<usize, String> {
        let dim = embeddings::embed_dim();
        match self.stored_dim() {
            Some(stored) if stored == dim => Ok(dim),
            Some(_) => {
                // The embedding model changed width: old vectors are unusable.
                self.clear()?;
                self.meta_set("dim", &dim.to_string())?;
                Ok(dim)
            }
            None => {
                self.meta_set("dim", &dim.to_string())?;
                Ok(dim)
            }
        }
    }

    /// Insert or replace a document and its chunks. Returns the doc id.
    pub fn upsert_doc(
        &self,
        key: &str,
        kind: &str,
        file_path: &str,
        title: &str,
        chunks: &[String],
        vectors: &[Vec<f32>],
    ) -> Result<i64, String> {
        if chunks.len() != vectors.len() {
            return Err("chunk/vector count mismatch".to_string());
        }
        let hash = content_hash(&chunks.join("\n"));
        let now = now_secs();
        let mut conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| format!("tx failed: {e}"))?;

        let existing: Option<i64> = tx
            .query_row("SELECT id FROM docs WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(|e| format!("lookup failed: {e}"))?;
        if let Some(id) = existing {
            tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])
                .map_err(|e| format!("purge failed: {e}"))?;
            tx.execute(
                "UPDATE docs SET kind=?2, file_path=?3, title=?4, content_hash=?5,
                                 fetched_at=?6, chunk_count=?7, embedding_model=?8
                 WHERE id=?1",
                params![
                    id,
                    kind,
                    file_path,
                    title,
                    hash,
                    now,
                    chunks.len() as i64,
                    embeddings::EMBEDDING_REPO
                ],
            )
            .map_err(|e| format!("update failed: {e}"))?;
            insert_chunks(&tx, id, chunks, vectors)?;
            tx.commit().map_err(|e| format!("commit failed: {e}"))?;
            return Ok(id);
        }

        tx.execute(
            "INSERT INTO docs (key, kind, file_path, title, content_hash, fetched_at,
                               chunk_count, embedding_model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                key,
                kind,
                file_path,
                title,
                hash,
                now,
                chunks.len() as i64,
                embeddings::EMBEDDING_REPO
            ],
        )
        .map_err(|e| format!("insert failed: {e}"))?;
        let id = tx.last_insert_rowid();
        insert_chunks(&tx, id, chunks, vectors)?;
        tx.commit().map_err(|e| format!("commit failed: {e}"))?;
        Ok(id)
    }

    /// `key -> (mtime, size)` for every doc of `kind`.
    ///
    /// The indexer uses this to decide what changed without reading a single
    /// file: one query replaces a per-file stat round trip.
    pub fn doc_meta(&self, kind: &str) -> Result<std::collections::HashMap<String, (f64, u64)>, String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, fetched_at, chunk_count FROM docs WHERE kind = ?1")
            .map_err(|e| format!("prepare failed: {e}"))?;
        let rows = stmt
            .query_map(params![kind], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(|e| format!("query failed: {e}"))?;
        let mut out = std::collections::HashMap::new();
        for row in rows.flatten() {
            out.insert(row.0, (row.1, row.2));
        }
        Ok(out)
    }

    /// Delete a doc and its chunks by key. Returns true when a row was removed.
    pub fn remove_doc(&self, key: &str) -> Result<bool, String> {
        let mut conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| format!("tx failed: {e}"))?;
        let id: Option<i64> = tx
            .query_row("SELECT id FROM docs WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(|e| format!("lookup failed: {e}"))?;
        let Some(id) = id else {
            return Ok(false);
        };
        tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])
            .map_err(|e| format!("chunk delete failed: {e}"))?;
        tx.execute("DELETE FROM docs WHERE id = ?1", params![id])
            .map_err(|e| format!("doc delete failed: {e}"))?;
        tx.commit().map_err(|e| format!("commit failed: {e}"))?;
        Ok(true)
    }

    /// How many docs of `kind` are stored.
    pub fn count_docs(&self, kind: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        conn.query_row(
            "SELECT COUNT(*) FROM docs WHERE kind = ?1",
            params![kind],
            |r| r.get(0),
        )
        .map_err(|e| format!("count failed: {e}"))
    }

    /// Counts for `/memory/stats`.
    pub fn stats(&self) -> Result<Stats, String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        let docs: i64 = conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
            .unwrap_or(0);
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .unwrap_or(0);
        let mut kinds = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT kind, COUNT(*) FROM docs GROUP BY kind") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            {
                kinds = rows.flatten().collect();
            }
        }
        Ok(Stats { docs, chunks, kinds })
    }

    /// Drop every doc and chunk (used by `/memory/clear` and a model swap).
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        conn.execute_batch("DELETE FROM chunks; DELETE FROM docs;")
            .map_err(|e| format!("clear failed: {e}"))?;
        Ok(())
    }

    /// Enforce `max_docs` / `max_chunks` / `ttl_days`, oldest first.
    pub fn enforce_limits(&self) -> Result<usize, String> {
        let cutoff = now_secs() - (self.config.ttl_days as f64) * 86_400.0;
        let conn = self.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        let mut removed = 0usize;
        removed += conn
            .execute("DELETE FROM docs WHERE fetched_at < ?1", params![cutoff])
            .unwrap_or(0);
        // Oldest docs beyond the cap.
        removed += conn
            .execute(
                "DELETE FROM docs WHERE id IN (
                     SELECT id FROM docs ORDER BY fetched_at DESC LIMIT -1 OFFSET ?1
                 )",
                params![self.config.max_docs as i64],
            )
            .unwrap_or(0);
        // Orphaned chunks (their doc is gone).
        conn.execute(
            "DELETE FROM chunks WHERE doc_id NOT IN (SELECT id FROM docs)",
            [],
        )
        .map_err(|e| format!("orphan purge failed: {e}"))?;
        // Oldest chunks beyond the cap.
        conn.execute(
            "DELETE FROM chunks WHERE id IN (
                 SELECT id FROM chunks ORDER BY id DESC LIMIT -1 OFFSET ?1
             )",
            params![self.config.max_chunks as i64],
        )
        .map_err(|e| format!("chunk cap failed: {e}"))?;
        Ok(removed)
    }

    /// Reclaim disk space after a purge.
    pub fn vacuum(&self) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute_batch("VACUUM").is_ok()
    }

    /// Retention limits, for the stats response.
    pub fn config(&self) -> StoreConfig {
        self.config
    }
}

fn insert_chunks(
    tx: &rusqlite::Transaction<'_>,
    doc_id: i64,
    chunks: &[String],
    vectors: &[Vec<f32>],
) -> Result<(), String> {
    let mut stmt = tx
        .prepare("INSERT INTO chunks (doc_id, ord, txt, vec) VALUES (?1, ?2, ?3, ?4)")
        .map_err(|e| format!("prepare insert failed: {e}"))?;
    for (ord, (text, vec)) in chunks.iter().zip(vectors).enumerate() {
        stmt.execute(params![doc_id, ord as i64, text, vec_to_blob(vec)])
            .map_err(|e| format!("chunk insert failed: {e}"))?;
    }
    Ok(())
}

/// float32 little-endian blob, matching the Python `np.float32.tobytes()`.
fn vec_to_blob(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// SHA-256 of whitespace-normalized text, truncated to 24 hex chars.
pub fn content_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = Sha256::digest(normalized.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex.chars().take(24).collect()
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (VectorStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("codifa-vs-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("t{}.sqlite", now_secs()));
        let store = VectorStore::open(&path, StoreConfig::default()).expect("open");
        (store, path)
    }

    #[test]
    fn upserting_the_same_key_replaces_its_chunks() {
        let (store, path) = temp_store();
        store
            .upsert_doc("k", KIND_FILE, "a.rs", "A", &["one".into()], &[vec![1.0, 0.0]])
            .expect("first");
        store
            .upsert_doc("k", KIND_FILE, "a.rs", "A", &["two".into()], &[vec![0.0, 1.0]])
            .expect("second");
        let stats = store.stats().expect("stats");
        assert_eq!(stats.docs, 1, "same key must not duplicate the doc");
        assert_eq!(stats.chunks, 1, "old chunks must be purged");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn clear_empties_the_store() {
        let (store, path) = temp_store();
        store
            .upsert_doc("k", KIND_FILE, "a.rs", "A", &["x".into()], &[vec![1.0, 0.0]])
            .expect("upsert");
        store.clear().expect("clear");
        let stats = store.stats().expect("stats");
        assert_eq!(stats.docs, 0);
        assert_eq!(stats.chunks, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn content_hash_ignores_whitespace_differences() {
        assert_eq!(content_hash("a  b\n c"), content_hash("a b c"));
        assert_ne!(content_hash("a b"), content_hash("a c"));
    }

    #[test]
    fn workspace_slug_is_stable_and_filesystem_safe() {
        let slug = workspace_slug_for_root("/tmp/some/project");
        assert!(!slug.contains('/'), "slug must not contain separators: {slug}");
        assert_eq!(slug, workspace_slug_for_root("/tmp/some/project"));
    }

    #[test]
    fn enforce_limits_drops_the_oldest_docs_beyond_the_cap() {
        let dir = std::env::temp_dir().join(format!("codifa-vs-cap-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("cap{}.sqlite", now_secs()));
        let cfg = StoreConfig {
            max_docs: 2,
            ..StoreConfig::default()
        };
        let store = VectorStore::open(&path, cfg).expect("open");
        for i in 0..4 {
            store
                .upsert_doc(
                    &format!("k{i}"),
                    KIND_FILE,
                    "a.rs",
                    "A",
                    &[format!("chunk {i}")],
                    &[vec![1.0, 0.0]],
                )
                .expect("upsert");
        }
        store.enforce_limits().expect("limits");
        assert!(store.stats().expect("stats").docs <= 2);
        let _ = std::fs::remove_file(path);
    }
}
