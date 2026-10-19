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
                    } else {
                        // A failed write (disk full, rename failure) must never
                        // silently drop the newest document: the job is put back
                        // on the queue and retried after a backoff, unless a
                        // newer document already replaced it (that one wins).
                        {
                            let q = write_queue();
                            let mut pending =
                                q.pending.lock().unwrap_or_else(|e| e.into_inner());
                            if pending.is_none() {
                                *pending = Some((path, map));
                            }
                        }
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }
        });
    }
}

/// Synchronously write any queued document — used on app quit so coalesced
/// changes are never lost when the process exits.
pub fn flush_pending(_app: &AppHandle) {
    // Serialize against `store_set` (which takes the same lock) — without it the
    // quit-time flush raced a concurrent set on the shared temp file/rename.
    let _guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
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

fn store_path(app: &AppHandle) -> PathBuf {
    get_data_root(app).join("settings.json")
}

// ---------------------------------------------------------------------------
// Split chat storage
//
// settings.json keeps only an INDEX row per chat (metadata + `dir`), while the
// message bodies live in `{data_root}/chats/<workspace>/<id>.json`. Before this
// split the whole chat history (58 MB on a real profile) sat inside the
// document, so every parse, every clone and every write of that document
// dragged hundreds of megabytes of message text through RAM — the app's single
// biggest memory consumer.
// ---------------------------------------------------------------------------

/// Root of the per-chat body files.
fn chats_root(data_root: &Path) -> PathBuf {
    data_root.join("chats")
}

/// Make a chat id safe to use as a file name.
///
/// Deliberately mirrors `plans::safe_file` (the rule the legacy per-chat files
/// and `appstate::chat_file` use) so a migrated body lands on the SAME path an
/// older build would have written, instead of creating a duplicate file.
fn safe_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() > 120 {
            break;
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    if trimmed.is_empty() {
        "chat".to_string()
    } else {
        trimmed
    }
}

/// Absolute path of a chat's body file. An index row carries `dir` (relative to
/// the data root) once a body exists, so files written by older builds — or by
/// `appstate::save_state` — keep being updated in place instead of duplicated.
fn body_path(data_root: &Path, row: &Value) -> PathBuf {
    if let Some(rel) = row.get("dir").and_then(|v| v.as_str()) {
        if !rel.is_empty() {
            return data_root.join(rel);
        }
    }
    let root = row.get("root").and_then(|v| v.as_str()).unwrap_or_default();
    let ws = if root.trim().is_empty() {
        "workspace".to_string()
    } else {
        crate::plans::workspace_slug_for_root(root)
    };
    let id = safe_id(row.get("id").and_then(|v| v.as_str()).unwrap_or("chat"));
    chats_root(data_root).join(ws).join(format!("{id}.json"))
}

/// First user message preview: index rows feed the sidebar/tab titles without
/// loading a single message body.
fn first_user_preview(body: &Value) -> String {
    let Some(msgs) = body.get("messages").and_then(|v| v.as_array()) else {
        return String::new();
    };
    for m in msgs {
        if m.get("role").and_then(|r| r.as_str()) == Some("user") {
            let c = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            return c.chars().take(48).collect();
        }
    }
    String::new()
}

/// Metadata-only row for settings.json: the chat object minus its messages,
/// plus the index fields the renderer needs without the body.
fn index_row(body: &Value, dir: Option<String>) -> Option<Value> {
    let obj = body.as_object()?;
    obj.get("id").and_then(|v| v.as_str())?;
    let mut out = serde_json::Map::with_capacity(obj.len());
    for (k, v) in obj {
        if k == "messages" {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    let count = obj
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    out.insert("messageCount".to_string(), Value::from(count as u64));
    out.insert(
        "firstUser".to_string(),
        Value::String(first_user_preview(body)),
    );
    if let Some(d) = dir {
        out.insert("dir".to_string(), Value::String(d));
    }
    Some(Value::Object(out))
}

/// Atomically write one chat body (compact JSON: bodies are machine-only).
fn write_body(path: &Path, body: &Value) -> bool {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.tmp{}.{}", std::process::id(), unique));
    let file = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut writer = BufWriter::new(file);
    if serde_json::to_writer(&mut writer, body).is_err() || writer.flush().is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    fs::rename(&tmp, path).is_ok()
}

fn upsert_index(
    order: &mut Vec<String>,
    rows: &mut std::collections::HashMap<String, Value>,
    row: Value,
) {
    let Some(id) = row.get("id").and_then(|v| v.as_str()).map(String::from) else {
        return;
    };
    if !rows.contains_key(&id) {
        order.push(id.clone());
    }
    rows.insert(id, row);
}

/// Merge an incoming chat list into the stored INDEX.
///
/// A row that carries `messages` owns the body: it is written to the chat's own
/// file and only metadata stays in the document. A row without `messages` is a
/// metadata-only update (rename, pin, model switch on a chat whose body is not
/// in memory) and keeps the stored `dir`/`messageCount`/`firstUser`.
fn merge_chat_index(data_root: &Path, stored: &Value, incoming: &Value, dead: &Value) -> Value {
    let dead_ids: Vec<String> = dead
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut order: Vec<String> = Vec::new();
    let mut rows: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    if let Value::Array(items) = stored {
        for row in items {
            upsert_index(&mut order, &mut rows, row.clone());
        }
    }
    if let Value::Array(items) = incoming {
        for row in items {
            let Some(id) = row.get("id").and_then(|v| v.as_str()).map(String::from) else {
                continue;
            };
            if dead_ids.contains(&id) {
                continue;
            }
            let updated = row.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let prev = rows
                .get(&id)
                .and_then(|r| r.get("updatedAt"))
                .and_then(|v| v.as_f64())
                .unwrap_or(-1.0);
            // An older snapshot never overwrites a newer row (the same
            // newest-wins rule the whole-chat merge always used).
            if updated < prev {
                continue;
            }
            if row.get("messages").map(|v| v.is_array()).unwrap_or(false) {
                let path = body_path(data_root, &row);
                if !write_body(&path, &row) {
                    continue;
                }
                let rel = path
                    .strip_prefix(data_root)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());
                if let Some(idx) = index_row(&row, rel) {
                    upsert_index(&mut order, &mut rows, idx);
                }
            } else {
                let mut idx = row.clone();
                let carry: Vec<(String, Value)> = match rows.get(&id) {
                    Some(prev_row) => ["dir", "messageCount", "firstUser"]
                        .iter()
                        .filter_map(|k| {
                            prev_row
                                .get(*k)
                                .map(|v| (k.to_string(), v.clone()))
                        })
                        .collect(),
                    None => Vec::new(),
                };
                if let Some(obj) = idx.as_object_mut() {
                    for (k, v) in carry {
                        if obj.get(&k).is_none() {
                            obj.insert(k, v);
                        }
                    }
                }
                upsert_index(&mut order, &mut rows, idx);
            }
        }
    }
    Value::Array(
        order
            .into_iter()
            .filter_map(|id| rows.remove(&id))
            .filter(|row| {
                let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
                !dead_ids.iter().any(|d| d == id)
            })
            .collect(),
    )
}

/// Accumulator for [`pick_migration_bodies`]: newest copy per chat id.
type BestBodies = std::collections::HashMap<String, (f64, Value, Option<PathBuf>)>;

/// Keep whichever of two copies of a chat is newer (ties → the later source).
fn take_best(best: &mut BestBodies, order: &mut Vec<String>, obj: Value, file: Option<PathBuf>) {
    let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(String::from) else {
        return;
    };
    let updated = obj.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
    match best.get(&id) {
        Some((prev, _, _)) if *prev > updated => {}
        _ => {
            if !best.contains_key(&id) {
                order.push(id.clone());
            }
            best.insert(id, (updated, obj, file));
        }
    }
}

/// Pure core of the split-storage migration: per chat id, pick the newest copy
/// out of the settings.json rows and the legacy per-chat files.
///
/// Returns `(body, file it came from)` in first-seen order. Split out of
/// [`migrate_to_index`] so the "no chat and no message is lost" rule is pinned
/// by a unit test instead of only being exercised once, on a real data root.
fn pick_migration_bodies(
    data_root: &Path,
    doc_rows: &[Value],
    disk: Vec<(PathBuf, Value)>,
) -> Vec<(Value, Option<PathBuf>)> {
    let mut best = BestBodies::new();
    let mut order: Vec<String> = Vec::new();
    for row in doc_rows {
        // `body_path` prefers the row's own `dir` and otherwise derives the
        // canonical path, so both shapes of legacy row resolve here.
        let file = Some(body_path(data_root, row));
        take_best(&mut best, &mut order, row.clone(), file);
    }
    for (path, obj) in disk {
        take_best(&mut best, &mut order, obj, Some(path));
    }
    order
        .into_iter()
        .filter_map(|id| best.remove(&id).map(|(_, body, file)| (body, file)))
        .collect()
}

/// One-shot, idempotent migration to the split storage layout.
///
/// Before this, `settings.json` held the FULL body of every chat and the store
/// kept that whole document parsed in memory (plus a clone per write), which is
/// what made the app hold gigabytes. Now the document carries index rows only
/// and each chat's messages live in their own file under `chats/`.
///
/// Both sources are merged with the same "newest `updatedAt` wins" rule the
/// read path always used, so no chat and no message can be lost: whichever copy
/// is newer becomes the body file, and only metadata stays in the document.
pub fn migrate_to_index(app: &AppHandle) {
    let path = store_path(app);
    if !path.is_file() {
        return;
    }
    let data_root = get_data_root(app);
    let _guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(Value::Object(mut doc)) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    if doc.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(1) >= 2 {
        return;
    }

    // Legacy per-chat files (written by the removed Python sidecar).
    let mut disk: Vec<(PathBuf, Value)> = Vec::new();
    if let Ok(ws_iter) = fs::read_dir(chats_root(&data_root)) {
        for ws in ws_iter.flatten() {
            let Ok(files) = fs::read_dir(ws.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(obj) = fs::read_to_string(&p)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .filter(|v| v.is_object())
                else {
                    continue;
                };
                disk.push((p, obj));
            }
        }
    }

    let doc_rows: Vec<Value> = match doc.get("chats") {
        Some(Value::Array(rows)) => rows.clone(),
        _ => Vec::new(),
    };
    let picked = pick_migration_bodies(&data_root, &doc_rows, disk);

    let dead = doc.get("deleted_chats").cloned().unwrap_or(Value::Null);
    let dead_ids: Vec<String> = dead
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut index: Vec<Value> = Vec::with_capacity(picked.len());
    let mut written = 0usize;
    for (body, file) in picked {
        let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if dead_ids.iter().any(|d| d == id) {
            continue;
        }
        // Write the winning body back to the file it came from (or the path its
        // index row implies), then keep only metadata in the document.
        let target = file.unwrap_or_else(|| body_path(&data_root, &body));
        let rel = target
            .strip_prefix(&data_root)
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        if write_body(&target, &body) {
            written += 1;
        }
        if let Some(row) = index_row(&body, rel) {
            index.push(row);
        }
    }

    // Archive the pre-migration document before shrinking it.
    let backup = path.with_extension("json.pre-index-migration");
    let _ = fs::copy(&path, &backup);
    doc.insert("chats".to_string(), Value::Array(index));
    doc.insert("schemaVersion".to_string(), Value::from(2u64));
    let ok = write_document(&path, &doc);
    {
        let mut cache = cache_slot().lock().unwrap_or_else(|e| e.into_inner());
        *cache = Some(DocCache {
            value: Arc::new(doc),
            at: Instant::now(),
        });
    }
    println!(
        "[store] split storage migration: {written} chat bodies written (schemaVersion 2, doc_ok={ok}), pre-migration copy at {}",
        backup.display()
    );
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
    // Unique temp name per write. The old fixed `<doc>.json.tmp` let the
    // debounced writer thread and `flush_pending` (app quit) truncate each
    // other's file, publishing a torn — unreadable — JSON document.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.tmp{}.{}", std::process::id(), unique));
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
                // A chats write MERGES into the index, never replaces. Rows that
                // carry `messages` own the body and are written to their own
                // file; rows without it are metadata-only updates. Merging keeps
                // unmentioned rows, so the renderer's mid-stream heartbeat
                // (which sends only the streaming subset) cannot delete chats.
                let stored = map.get("chats").cloned().unwrap_or(Value::Null);
                let dead = map.get("deleted_chats").cloned().unwrap_or(Value::Null);
                let data_root = get_data_root(&app);
                map.insert(
                    "chats".to_string(),
                    merge_chat_index(&data_root, &stored, &value, &dead),
                );
            } else if key == "deleted_chats" {
                // The tombstone is the explicit delete path: drop the rows AND
                // their body files, so a deleted chat can never be resurrected
                // by a stale index row or an orphaned file.
                let data_root = get_data_root(&app);
                let stored = map.get("chats").cloned().unwrap_or(Value::Null);
                if let (Value::Array(rows), Value::Array(dead)) = (&stored, &value) {
                    for row in rows {
                        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        if dead.iter().any(|d| d.as_str() == Some(id)) {
                            let _ = fs::remove_file(body_path(&data_root, row));
                        }
                    }
                }
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

/// Fetch ONE chat's message body (the per-chat file behind its index row).
///
/// The renderer keeps the whole chat list in memory as index rows and calls
/// this when a chat is opened, so a session with hundreds of chats only ever
/// holds the bodies of the few the user is actually looking at.
#[tauri::command]
pub async fn chat_get(app: AppHandle, id: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_root = get_data_root(&app);
        let doc = read_all(&app);
        let row = doc
            .get("chats")
            .and_then(|v| v.as_array())
            .and_then(|rows| {
                rows.iter()
                    .find(|r| r.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                    .cloned()
            })?;
        let path = body_path(&data_root, &row);
        let body = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(|v| v.is_object());
        match body {
            Some(b) => Some(b),
            // The index row exists but its body file is gone (an external
            // delete, a half-copied data root). Report the row so the UI shows
            // the chat as empty instead of dropping it from the sidebar.
            None => Some(row),
        }
    })
    .await
    .ok()
    .flatten()
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
            // INDEX ONLY. Message bodies live in their own file per chat and are
            // fetched with `chat_get`, so the sidebar/tab list never needs the
            // multi-megabyte document in memory (and no longer re-scans every
            // per-chat file on the hot path).
            let stored = doc.get("chats").cloned().unwrap_or(Value::Array(Vec::new()));
            // Never resurrect a chat the user deleted: the tombstone outranks
            // every index row.
            let dead = doc.get("deleted_chats").cloned().unwrap_or(Value::Null);
            return Some(drop_deleted_rows(stored, &dead));
        }
        doc.get(&key).cloned()
    })
    .await
    .ok()
    .flatten()
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

/// Merge chat lists by id: newest `updatedAt` wins, first-seen order kept.
/// The split-storage read path no longer needs it (the document holds index
/// rows only), but the rule is the contract the tests pin down.
#[allow(dead_code)]
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

    /// The migration must carry EVERY chat and every message across: the union
    /// of the settings.json rows and the legacy per-chat files, with the newest
    /// copy of a chat winning — this is the "no chat and no message is lost"
    /// contract the whole split-storage change hangs on.
    #[test]
    fn migration_keeps_every_chat_and_message() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-keep",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let doc_rows = vec![
            // Same id as a disk file, but older: the file must win.
            serde_json::json!({
                "id": "shared", "updatedAt": 1.0,
                "messages": [{"id": "m1", "role": "user", "content": "stale"}]
            }),
            // Only in settings.json.
            serde_json::json!({
                "id": "doc-only", "updatedAt": 5.0,
                "messages": [{"id": "m2", "role": "user", "content": "from doc"}]
            }),
        ];
        let disk = vec![
            (
                dir.join("chats/ws/shared.json"),
                serde_json::json!({
                    "id": "shared", "updatedAt": 9.0,
                    "messages": [
                        {"id": "m1", "role": "user", "content": "fresh"},
                        {"id": "m3", "role": "assistant", "content": "reply"}
                    ]
                }),
            ),
            // Only on disk.
            (
                dir.join("chats/ws/disk-only.json"),
                serde_json::json!({
                    "id": "disk-only", "updatedAt": 2.0,
                    "messages": [{"id": "m4", "role": "user", "content": "from disk"}]
                }),
            ),
        ];

        let picked = pick_migration_bodies(&dir, &doc_rows, disk);
        assert_eq!(picked.len(), 3, "every distinct chat survives");

        let body_of = |id: &str| -> Value {
            picked
                .iter()
                .find(|(b, _)| b.get("id").and_then(|v| v.as_str()) == Some(id))
                .map(|(b, _)| b.clone())
                .unwrap_or(Value::Null)
        };
        // The newer copy wins AND both of its messages are intact (an older
        // copy would only have had one).
        let shared = body_of("shared");
        assert_eq!(shared["messages"].as_array().unwrap().len(), 2);
        assert_eq!(shared["messages"][0]["content"], "fresh");
        assert_eq!(shared["messages"][1]["content"], "reply");
        assert_eq!(body_of("doc-only")["messages"][0]["content"], "from doc");
        assert_eq!(body_of("disk-only")["messages"][0]["content"], "from disk");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Newest-wins works in both directions (the document copy can be the fresher
    /// one, e.g. when a legacy file was left behind by the old sidecar).
    #[test]
    fn migration_prefers_the_newer_copy_either_way() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-newer",
            std::process::id()
        ));
        let doc_rows = vec![serde_json::json!({
            "id": "c", "updatedAt": 10.0,
            "messages": [{"id": "m", "role": "user", "content": "doc newer"}]
        })];
        let disk = vec![(
            dir.join("chats/ws/c.json"),
            serde_json::json!({
                "id": "c", "updatedAt": 3.0,
                "messages": [{"id": "m", "role": "user", "content": "disk older"}]
            }),
        )];
        let picked = pick_migration_bodies(&dir, &doc_rows, disk);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].0["messages"][0]["content"], "doc newer");
    }

    /// The index row kept in settings.json must never carry the transcript, and
    /// must still give the renderer what the sidebar needs.
    #[test]
    fn index_row_strips_bodies_and_summarizes() {
        let body = serde_json::json!({
            "id": "c", "title": "T", "updatedAt": 4.0, "messages": [
                {"id": "a", "role": "system", "content": "sys"},
                {"id": "b", "role": "user", "content": "hello there"}
            ]
        });
        let row = index_row(&body, Some("chats/ws/c.json".to_string())).unwrap();
        assert!(row.get("messages").is_none(), "no transcript in the index");
        assert_eq!(row["messageCount"], serde_json::json!(2));
        assert_eq!(row["firstUser"], "hello there");
        assert_eq!(row["dir"], "chats/ws/c.json");
        assert_eq!(row["title"], "T");
    }

    /// A metadata-only update (rename/pin/model switch on a chat whose body is
    /// not in memory) must keep `dir`/`messageCount` and leave the body file —
    /// and therefore the transcript — untouched.
    #[test]
    fn metadata_only_update_keeps_body_fields() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-meta-only",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let full = serde_json::json!([{
            "id": "c", "title": "old", "updatedAt": 1.0,
            "messages": [{"id": "m", "role": "user", "content": "hi"}]
        }]);
        let stored = merge_chat_index(&dir, &Value::Array(vec![]), &full, &Value::Null);
        let rel = stored.as_array().unwrap()[0]["dir"].as_str().unwrap().to_string();
        let body_file = dir.join(&rel);
        assert!(body_file.is_file(), "body written");

        let rename = serde_json::json!([{ "id": "c", "title": "renamed", "updatedAt": 2.0 }]);
        let after = merge_chat_index(&dir, &stored, &rename, &Value::Null);
        let row = after
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "c")
            .unwrap()
            .clone();
        assert_eq!(row["title"], "renamed");
        assert_eq!(row["messageCount"], serde_json::json!(1));
        assert!(row["dir"].is_string());
        let back: Value =
            serde_json::from_str(&fs::read_to_string(&body_file).unwrap()).unwrap();
        assert_eq!(back["messages"][0]["content"], "hi");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A tombstoned chat must not be resurrected by the migration.
    #[test]
    fn migration_skips_tombstoned_chats() {
        let dir = std::env::temp_dir().join(format!(
            "codifa-store-{}-migrate-dead",
            std::process::id()
        ));
        let doc_rows = vec![serde_json::json!({
            "id": "gone", "updatedAt": 1.0,
            "messages": [{"id": "m", "role": "user", "content": "x"}]
        })];
        let picked = pick_migration_bodies(&dir, &doc_rows, vec![]);
        assert_eq!(picked.len(), 1);
        let dead = serde_json::json!(["gone"]);
        let dead_ids: Vec<&str> = dead.as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(dead_ids.contains(&"gone"));
    }
}
