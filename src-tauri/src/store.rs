//! JSON file store (mirrors electron/store-db.ts): a single settings.json in
//! the data root holding key -> value pairs, written atomically.
//!
//! All commands are async and run on the blocking pool so a slow disk read
//! never stalls the webview's main thread (the "chat updates late" lag).

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;

use crate::state::get_data_root;

/// Serializes store writes across commands (reads are lock-free).
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Cache TTL for the parsed settings.json document. The file is shared with
/// the Python sidecar, so it must expire quickly — but re-parsing a ~7k-line
/// JSON on every keystroke-driven store_get was the startup/UI lag source.
const CACHE_TTL: Duration = Duration::from_millis(250);

/// Longer TTL for the chats merge cache: writes fold into it (see write_all),
/// so a full re-scan of every per-chat file stays rare.
const CHATS_TTL: Duration = Duration::from_millis(1000);

/// Store writes are coalesced: each store_set only updates the in-memory
/// document and hands it to a background writer, which flushes the whole
/// settings.json at most once per interval. Serializing the multi-MB document
/// on every mid-stream store_set queued dozens of blocking tasks on the write
/// lock (visible as ~100% CPU and stalled chat updates in `sample`).
const WRITE_DEBOUNCE: Duration = Duration::from_millis(150);

struct WriteQueue {
    /// The document awaits the writer thread here; kept behind an `Arc` so the
    /// cache and the queued job reference ONE allocation instead of two copies.
    pending: Mutex<Option<(PathBuf, Arc<serde_json::Map<String, Value>>)>>,
    cv: Condvar,
}

fn write_queue() -> &'static WriteQueue {
    static Q: OnceLock<WriteQueue> = OnceLock::new();
    Q.get_or_init(|| WriteQueue { pending: Mutex::new(None), cv: Condvar::new() })
}

/// Spawn the single background writer thread on first use.
fn ensure_writer() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_ok() {
        std::thread::spawn(|| {
            let q = write_queue();
            loop {
                let mut guard = q
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                while guard.is_none() {
                    guard = q.cv.wait(guard).unwrap_or_else(|e| e.into_inner());
                }
                // Coalesce: a brief wait lets rapid successive sets collapse
                // into one disk write.
                std::thread::sleep(WRITE_DEBOUNCE);
                let job = guard.take();
                drop(guard);
                if let Some((path, map)) = job {
                    // On success the flushed document becomes the cache entry —
                    // the same allocation, never a post-write copy of the doc.
                    if write_document(&path, &map) {
                        let mut cache = cache_slot().lock().unwrap_or_else(|e| e.into_inner());
                        *cache = Some(DocCache { value: map, at: Instant::now() });
                    }
                }
            }
        });
    }
}

/// Synchronously write any queued document — used on app quit so coalesced
/// changes are never lost when the process exits.
pub fn flush_pending(_app: &AppHandle) {
    // Poison-tolerant: this runs on the QUIT path, where a panic would abort the
    // close sequence and leave the window stuck open instead of persisting.
    let job = write_queue()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some((path, map)) = job {
        let _ = write_document(&path, &map);
    }
}

struct DocCache {
    value: Arc<serde_json::Map<String, Value>>,
    at: Instant,
}

fn cache_slot() -> &'static Mutex<Option<DocCache>> {
    static CACHE: OnceLock<Mutex<Option<DocCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Cached result of the (expensive) chats disk merge: reading every per-chat
/// file on each store_get("chats") stalled chat switching.
fn chats_cache_slot() -> &'static Mutex<Option<(Value, Instant)>> {
    static CACHE: OnceLock<Mutex<Option<(Value, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn store_path(app: &AppHandle) -> PathBuf {
    get_data_root(app).join("settings.json")
}

fn read_all(app: &AppHandle) -> Arc<serde_json::Map<String, Value>> {
    // Newest state lives in the write queue until the writer flushes it —
    // the on-disk file may lag behind by up to WRITE_DEBOUNCE.
    {
        let guard = write_queue().pending.lock().unwrap();
        if let Some((_, map)) = guard.as_ref() {
            return map.clone();
        }
    }
    // Fast path: fresh cache.
    {
        let cache = cache_slot().lock().unwrap();
        if let Some(c) = cache.as_ref() {
            if c.at.elapsed() < CACHE_TTL {
                return c.value.clone();
            }
        }
    }
    let parsed = Arc::new(match fs::read_to_string(store_path(app)) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    });
    {
        let mut cache = cache_slot().lock().unwrap();
        *cache = Some(DocCache { value: parsed.clone(), at: Instant::now() });
    }
    parsed
}

/// Serialize straight into the temp file (streamed through a `BufWriter`, so
/// no multi-MB `String` is ever materialized) and rename it into place, so a
/// crash never truncates the store.
fn write_document(path: &Path, value: &serde_json::Map<String, Value>) -> bool {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    let file = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut writer = BufWriter::new(file);
    if serde_json::to_writer_pretty(&mut writer, value).is_err() || writer.flush().is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    // Force the bytes to the platter BEFORE the rename publishes them. Without
    // this the rename only guaranteed "no torn file" — a crash or power loss
    // right after it could still leave an EMPTY or half-written document, which
    // is exactly the reported "the app closed suddenly and my new chats were
    // gone".
    if writer.into_inner().map(|f| f.sync_all().is_err()).unwrap_or(true) {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    fs::rename(&tmp, path).is_ok()
}

#[tauri::command]
pub async fn store_set(app: AppHandle, key: String, value: Value) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = write_lock().lock().unwrap();
        // A write needs the document owned; with the cache and the writer thread
        // sharing it via `Arc`, that copy happens at most once per set.
        let mut map = Arc::try_unwrap(read_all(&app)).unwrap_or_else(|shared| (*shared).clone());
        if key == "settings" {
            // settings.json is a FLAT document shared with the Python sidecar
            // and also holds sibling keys written via store_set ("chats", ...).
            // A settings write must MERGE into the document — replacing it
            // would wipe "chats" and empty the sidebar on every settings change.
            if let Value::Object(incoming) = value {
                for (k, v) in incoming {
                    // Providers are UNIONED by id instead of replaced. The old
                    // shallow key merge let any settings payload carrying a
                    // stale or trimmed `providers` array (a partial hydrate, a
                    // cold-start default snapshot) silently DELETE every row it
                    // did not list — including rows holding `enc:v1:` API keys.
                    // Deleting a provider is explicit: the renderer publishes
                    // the id to the `deleted_providers` tombstone below.
                    if k == "providers" {
                        let stored = map.get("providers").cloned().unwrap_or(Value::Null);
                        let merged = merge_providers([stored, v]);
                        // Re-apply the tombstones on every settings write: a
                        // payload that still carries a removed provider row
                        // (a stale renderer snapshot) must not resurrect it.
                        let dead = map.get("deleted_providers").cloned().unwrap_or(Value::Null);
                        map.insert(k, drop_deleted_providers(merged, &dead));
                    } else {
                        map.insert(k, v);
                    }
                }
            }
        } else {
            if key == "deleted_providers" {
                // A tombstone is authoritative: drop the tombstoned rows in the
                // same write so the union above can never resurrect them.
                let stored = map.get("providers").cloned().unwrap_or(Value::Null);
                map.insert("providers".to_string(), drop_deleted_providers(stored, &value));
            } else if key == "chats" {
                // A chats write must MERGE by id, never replace. The renderer's
                // mid-stream heartbeat (writeChatsNow) persists only the
                // streaming subset, so replacing the whole array with that
                // subset deleted every other chat from settings.json — the
                // "app closed / restarted and my recent chats are gone" data
                // loss. Merging keeps unmentioned rows and lets listed rows win.
                let stored = map.get("chats").cloned().unwrap_or(Value::Null);
                let merged = merge_chat_lists([stored, value.clone()]);
                // A chat deleted earlier must not come back through the union.
                let dead = map.get("deleted_chats").cloned().unwrap_or(Value::Null);
                map.insert("chats".to_string(), drop_deleted_rows(merged, &dead));
            } else if key == "deleted_chats" {
                // The tombstone is the explicit delete path: drop those rows in
                // the same write so the merge above can never resurrect them.
                let stored = map.get("chats").cloned().unwrap_or(Value::Null);
                map.insert("chats".to_string(), drop_deleted_rows(stored, &value));
            }
            // The tombstone keys themselves are always stored verbatim so the
            // next write can consult them. `chats`, however, must NOT be
            // re-inserted raw here: the merge above already produced the
            // authoritative array, and an unconditional insert re-introduced
            // the streaming subset, deleting every other chat from
            // settings.json (the "my recent chats are gone" data loss).
            if key != "chats" {
                map.insert(key.clone(), value);
            }
        }
        // Publish the document ONCE and let the cache and the writer share that
        // single allocation through an `Arc` — the old code kept a private copy
        // in each, so every mid-stream store_set duplicated the whole document.
        let shared = Arc::new(map);
        {
            let mut cache = cache_slot().lock().unwrap();
            *cache = Some(DocCache { value: shared.clone(), at: Instant::now() });
        }
        if key == "chats" {
            // Fold the written subset into the merge cache instead of dropping
            // it (dropping forced a full re-scan of every per-chat file on the
            // next read — the chat-switch lag while streaming). The cached list
            // is TAKEN rather than cloned, so the merge keeps only one copy.
            let mut slot = chats_cache_slot().lock().unwrap();
            if let Some((cached, _)) = slot.take() {
                let incoming = shared.get("chats").cloned().unwrap_or(Value::Null);
                slot.replace((merge_chat_lists([cached, incoming]), Instant::now()));
            }
        }
        {
            let q = write_queue();
            let mut pending = q.pending.lock().unwrap_or_else(|e| e.into_inner());
            *pending = Some((store_path(&app), shared));
            q.cv.notify_one();
        }
        ensure_writer();
        true
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn store_get(app: AppHandle, key: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        // A missing store still reports None (not an empty document), so the
        // frontend's "no settings yet" branch keeps working.
        if !store_path(&app).is_file() {
            return None;
        }
        // Serve from the shared in-memory document instead of re-reading and
        // re-parsing the multi-MB settings.json on every keystroke: the write
        // queue holds the newest state and the short-TTL cache re-reads disk, so
        // changes made by the Python sidecar still show up.
        let doc = read_all(&app);
        // settings.json IS the settings document: the Python sidecar reads/writes
        // it flat (state_db.settings_path), and Electron's store-db exposed the
        // whole file under the "settings" key. Any other key is a plain entry in
        // the same document.
        if key == "settings" {
            return Some(Value::Object((*doc).clone()));
        }
        if key == "chats" {
            // Serve the merged list from cache when fresh; the merge reads
            // every per-chat file on disk and must not run per keystroke.
            {
                let cache = chats_cache_slot().lock().unwrap();
                if let Some((v, at)) = cache.as_ref() {
                    if at.elapsed() < CHATS_TTL {
                        return Some(v.clone());
                    }
                }
            }
            let merged = merge_chats_from_disk(&app, doc.get("chats"));
            // Never resurrect a chat the user deleted: its per-chat file under
            // `chats/` survives a delete, and without this filter the disk merge
            // above would put the row straight back into the sidebar.
            let dead = doc.get("deleted_chats").cloned().unwrap_or(Value::Null);
            let merged = drop_deleted_rows(merged, &dead);
            *chats_cache_slot().lock().unwrap() = Some((merged.clone(), Instant::now()));
            return Some(merged);
        }
        doc.get(&key).cloned()
    })
    .await
    .ok()
    .flatten()
}

/// Self-healing read for the "chats" key.
///
/// The sidebar list lives in settings.json, but the Python sidecar also writes
/// one file per chat under `{data_root}/chats/<workspace>/<id>.json` (see
/// backend/state_db.py). A bad write (or a race between the two writers) can
/// leave the settings.json copy empty while the per-chat files are intact, so
/// the read merges both sources: newest `updatedAt` per chat id wins, matching
/// the sidecar's own `_iter_chat_files` de-duplication rule.
fn merge_chats_from_disk(app: &AppHandle, stored: Option<&Value>) -> Value {
    let mut lists: Vec<Value> = Vec::new();
    if let Some(s) = stored {
        lists.push(s.clone());
    }
    if let Some(chats_dir) = store_path(app).parent().map(|p| p.join("chats")) {
        if let Ok(ws_iter) = fs::read_dir(&chats_dir) {
            for ws in ws_iter.flatten() {
                let Ok(files) = fs::read_dir(ws.path()) else { continue };
                for f in files.flatten() {
                    let path = f.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    if let Ok(raw) = fs::read_to_string(&path) {
                        if let Ok(obj) = serde_json::from_str::<Value>(&raw) {
                            lists.push(Value::Array(vec![obj]));
                        }
                    }
                }
            }
        }
    }
    merge_chat_lists(lists)
}

/// Merge provider lists by id: the LAST occurrence wins (the renderer's payload
/// is the source of truth for edits), while rows the payload does not mention
/// are preserved — a partial settings snapshot must never delete a provider.
/// Same shape as `merge_chat_lists`, keyed on `id` instead of `updatedAt`.
fn merge_providers(lists: impl IntoIterator<Item = Value>) -> Value {
    fn upsert(obj: Value, best: &mut serde_json::Map<String, Value>, order: &mut Vec<String>) {
        let Some(id) = obj.get("id").and_then(|v| v.as_str().map(String::from)) else {
            return;
        };
        if !best.contains_key(&id) {
            order.push(id.clone());
        }
        best.insert(id, obj);
    }
    let mut best = serde_json::Map::new();
    let mut order: Vec<String> = Vec::new();
    for list in lists {
        if let Value::Array(items) = list {
            for obj in items {
                upsert(obj, &mut best, &mut order);
            }
        }
    }
    Value::Array(order.into_iter().filter_map(|id| best.remove(&id)).collect())
}

/// Remove tombstoned provider ids (`deleted_providers`) from a provider array.
/// The tombstone is the explicit delete path, so it outranks the union merge.
fn drop_deleted_providers(providers: Value, tombstones: &Value) -> Value {
    let Value::Array(rows) = providers else {
        return providers;
    };
    let Value::Array(dead) = tombstones else {
        return Value::Array(rows);
    };
    let dead: Vec<&str> = dead.iter().filter_map(|v| v.as_str()).collect();
    if dead.is_empty() {
        return Value::Array(rows);
    }
    Value::Array(
        rows.into_iter()
            .filter(|row| {
                let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
                !dead.contains(&id)
            })
            .collect(),
    )
}

/// Remove rows whose `id` appears in a tombstone list (`deleted_chats`).
/// Unlike `drop_deleted_providers` this is generic: chats and providers share
/// the same `id`-keyed array shape.
fn drop_deleted_rows(rows: Value, tombstones: &Value) -> Value {
    let Value::Array(items) = rows else {
        return rows;
    };
    let Value::Array(dead) = tombstones else {
        return Value::Array(items);
    };
    let dead: Vec<&str> = dead.iter().filter_map(|v| v.as_str()).collect();
    if dead.is_empty() {
        return Value::Array(items);
    }
    Value::Array(
        items
            .into_iter()
            .filter(|row| {
                let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
                !dead.contains(&id)
            })
            .collect(),
    )
}

/// Merge chat lists by id: newest `updatedAt` wins, first-seen order kept —
/// the same de-duplication rule as the sidecar's `_iter_chat_files`.
fn merge_chat_lists(lists: impl IntoIterator<Item = Value>) -> Value {
    fn upsert(obj: Value, best: &mut serde_json::Map<String, Value>, order: &mut Vec<String>) {
        let Some(id) = obj.get("id").and_then(|v| v.as_str().map(String::from)) else {
            return;
        };
        let updated = obj.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        match best.get(&id) {
            Some(existing) => {
                let prev = existing.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if updated >= prev {
                    best.insert(id, obj);
                }
            }
            None => {
                order.push(id.clone());
                best.insert(id, obj);
            }
        }
    }
    let mut best = serde_json::Map::new();
    let mut order: Vec<String> = Vec::new();
    for list in lists {
        if let Value::Array(items) = list {
            for obj in items {
                upsert(obj, &mut best, &mut order);
            }
        }
    }
    Value::Array(order.into_iter().filter_map(|id| best.remove(&id)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The chats merge must keep the newest updatedAt per id and preserve
    /// first-seen order — the sidebar dedupe rule.
    #[test]
    fn chats_merge_newest_wins() {
        let older = serde_json::json!({"id": "a", "updatedAt": 1.0, "title": "old"});
        let newer = serde_json::json!({"id": "a", "updatedAt": 2.0, "title": "new"});
        let merged = merge_chat_lists([serde_json::json!([older]), serde_json::json!([newer])]);
        let list = merged.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["title"], "new");
    }

    #[test]
    fn chats_merge_keeps_first_seen_order() {
        let a = serde_json::json!({"id": "a", "updatedAt": 3.0});
        let b = serde_json::json!({"id": "b", "updatedAt": 1.0});
        let merged = merge_chat_lists([serde_json::json!([a, b])]);
        let ids: Vec<&str> = merged.as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// Disk-only chats (settings.json copy wiped) must still be returned.
    #[test]
    fn chats_merge_recovers_from_disk_files() {
        let disk = serde_json::json!({"id": "x", "updatedAt": 9.0});
        let merged = merge_chat_lists([Value::Array(vec![disk])]);
        assert_eq!(merged.as_array().unwrap().len(), 1);
        assert_eq!(merged[0]["id"], "x");
    }

    /// A partial settings payload (missing provider rows) must never delete a
    /// provider — rows absent from the payload are preserved, listed rows win.
    #[test]
    fn providers_merge_preserves_unlisted_rows() {
        let kept = serde_json::json!({"id": "custom-1", "name": "9router"});
        let edited = serde_json::json!({"id": "openrouter", "name": "Edited"});
        let merged = merge_providers([
            serde_json::json!([kept, serde_json::json!({"id": "openrouter", "name": "OpenRouter"})]),
            serde_json::json!([edited]),
        ]);
        let rows = merged.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "custom-1");
        assert_eq!(rows[1]["name"], "Edited");
    }

    /// The `deleted_providers` tombstone is the explicit delete path: it outranks
    /// the union merge so a removed provider cannot be resurrected.
    #[test]
    fn providers_tombstone_drops_rows() {
        let providers = serde_json::json!([{"id": "a"}, {"id": "b"}]);
        let dropped = drop_deleted_providers(providers, &serde_json::json!(["a"]));
        let rows = dropped.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "b");
        // An empty or malformed tombstone is a no-op.
        let same = drop_deleted_providers(serde_json::json!([{"id": "a"}]), &Value::Null);
        assert_eq!(same.as_array().unwrap().len(), 1);
    }

    /// The streamed atomic write must round-trip the document and leave no
    /// temp file behind (the store is the app's single source of truth).
    /// A mid-stream chat heartbeat writes only the streaming SUBSET; the store
    /// must merge it by id instead of replacing the whole array, or every other
    /// chat is deleted from settings.json (the "app closed, recent chats gone"
    /// data loss).
    #[test]
    fn chats_write_merges_subset_without_deleting_rows() {
        let full = serde_json::json!([
            {"id": "a", "updatedAt": 1.0, "title": "keep me"},
            {"id": "b", "updatedAt": 1.0, "title": "streaming"},
        ]);
        let subset = serde_json::json!([{"id": "b", "updatedAt": 2.0, "title": "streaming"}]);
        let merged = merge_chat_lists([full, subset]);
        let rows = merged.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["title"], "keep me");
        assert_eq!(rows[1]["updatedAt"], 2.0);
    }

    /// A deleted chat must stay deleted even though its per-chat file and the
    /// on-disk copy both still exist.
    #[test]
    fn deleted_chats_tombstone_drops_rows() {
        let rows = serde_json::json!([{"id": "a"}, {"id": "b"}]);
        let dropped = drop_deleted_rows(rows, &serde_json::json!(["a"]));
        let out = dropped.as_array().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "b");
        // An empty or malformed tombstone is a no-op.
        let same = drop_deleted_rows(serde_json::json!([{"id": "a"}]), &Value::Null);
        assert_eq!(same.as_array().unwrap().len(), 1);
    }

    #[test]
    fn write_document_round_trips_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-write-document",
            std::process::id()
        ));
        let path = dir.join("settings.json");
        let mut map = serde_json::Map::new();
        map.insert("theme".to_string(), serde_json::json!("rose-pine"));
        map.insert("chats".to_string(), serde_json::json!([{"id": "a"}]));

        assert!(write_document(&path, &map));
        let back: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["theme"], "rose-pine");
        assert_eq!(back["chats"][0]["id"], "a");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
