//! Retention janitor for on-disk artifacts that would otherwise grow forever:
//! chat traces (JSONL), undo checkpoints, and imported uploads. Files older
//! than their TTL are deleted, and trace logs are also trimmed by size.
//!
//! It runs once at startup AND then on a timer, because a desktop app is often
//! left open for days: a startup-only sweep never fires for that user, which is
//! exactly how a trace directory grows until the disk fills.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Retention windows (days). Traces are debug aids, checkpoints are undo
/// history, uploads are imported attachments — none need to outlive these.
const TRACE_TTL_DAYS: u64 = 14;
const CHECKPOINT_TTL_DAYS: u64 = 14;
const UPLOAD_TTL_DAYS: u64 = 30;
/// Background-terminal logs are debug aids like traces. Their `.json` row
/// files are pruned by `agent_terminals` 24h after exit; the append-only
/// `.log` files had no bound at all before this.
const TERMINAL_LOG_TTL_DAYS: u64 = 7;
/// One record per scheduled-run execution, kept as run history.
const SCHEDULE_RUN_TTL_DAYS: u64 = 30;
/// A marketplace index cache outlives its usefulness when the marketplace is
/// no longer browsed; the 30-min freshness TTL only marks it stale.
const MARKETPLACE_TTL_DAYS: u64 = 30;
/// Crash litter: the atomic writers (`store::write_document`,
/// `plans::atomic_write`, …) leave a `*.tmp<pid>…` file behind only when the
/// process dies mid-write, so anything older than a day is debris.
const TMP_FILE_TTL_HOURS: u64 = 24;
/// A chat body can be written a moment before its index row lands (the
/// mid-stream heartbeat), so an unindexed chat dir is declared orphaned only
/// a day late — never while the write is still in flight.
const ORPHAN_GRACE_HOURS: u64 = 24;
/// Old Chrome-for-Testing builds (~150 MB apiece) must age a day before the
/// backstop sweep removes them, so a session running from the previous build
/// is not pulled out from under the user.
const OLD_BROWSER_GRACE_HOURS: u64 = 24;

/// Snapshots kept per chat, regardless of age.
///
/// The TTL above is keyed on the NEWEST file under a chat dir, so one recently
/// touched blob keeps every older snapshot in that chat alive forever. Measured
/// on a real data root: 223.8 MB across 2690 files, the oldest 433 hours (18
/// days) old, which the 14-day TTL had never removed. `appstate` applies the
/// same limit on restore, but a chat that is snapshotted and never restored
/// grows without one.
const CHECKPOINT_SEQS_PER_CHAT: usize = 50;

/// Global ceiling for `checkpoints/`. Deleting the oldest snapshots first keeps
/// recent undo history (the reason the feature exists) and drops only what
/// nobody is going to restore.
const CHECKPOINT_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// How often the janitor re-runs while the app stays open. The sweep is cheap
/// (a handful of directory listings plus a `stat` per trace file), so twice a
/// day costs nothing and keeps a long-running session honest.
const JANITOR_INTERVAL: Duration = Duration::from_secs(12 * 3600);

fn now() -> SystemTime {
    SystemTime::now()
}

/// Delete files under `dir` (non-recursive) whose mtime is older than `ttl`.
/// Returns the number of removed files. Missing dir is not an error.
fn sweep_files(dir: &std::path::Path, ttl: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| now().duration_since(m).map(|age| age > ttl).unwrap_or(false))
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Delete checkpoint chat dirs whose newest seq is older than `ttl`.
fn sweep_checkpoint_chats(dir: &std::path::Path, ttl: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let chat_dir = entry.path();
        if !chat_dir.is_dir() {
            continue;
        }
        // Newest mtime across the chat's seq dirs decides staleness.
        let newest = newest_mtime(&chat_dir);
        let stale = newest
            .map(|m| now().duration_since(m).map(|age| age > ttl).unwrap_or(false))
            .unwrap_or(false);
        if stale && std::fs::remove_dir_all(&chat_dir).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn newest_mtime(dir: &std::path::Path) -> Option<SystemTime> {
    let mut best: Option<SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        // Only CONTENTS count — the dir's own mtime updates whenever a
        // sibling is created, which would mask the real age of the data.
        let m = if entry.path().is_dir() {
            newest_mtime(&entry.path())
        } else {
            entry.metadata().and_then(|m| m.modified()).ok()
        };
        match (m, best) {
            (Some(m), Some(b)) if m > b => best = Some(m),
            (Some(m), None) => best = Some(m),
            _ => {}
        }
    }
    best
}

/// Cap one chat's snapshot count, regardless of age.
///
/// `appstate::prune_checkpoints` applies the same limit but only runs on
/// RESTORE, so a chat that is snapshotted and never restored accumulates
/// snapshots forever. Returns the number of seq dirs removed.
fn cap_checkpoint_seqs(chat_dir: &Path, keep: usize) -> (usize, u64) {
    let Ok(entries) = std::fs::read_dir(chat_dir) else {
        return (0, 0);
    };
    // Seq dirs are named `%06d`, so a numeric sort is chronological order.
    let mut seqs: Vec<(i64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let seq = name.parse::<i64>().ok()?;
            let path = e.path();
            path.is_dir().then_some((seq, path))
        })
        .collect();
    if seqs.len() <= keep {
        return (0, 0);
    }
    seqs.sort_unstable_by_key(|(seq, _)| *seq);
    let excess = seqs.len() - keep;
    let mut removed = 0;
    let mut freed = 0u64;
    for (_seq, path) in seqs.into_iter().take(excess) {
        // Measure BEFORE removing: the size has to be reported, or the sweep log
        // claims "0 MB freed" while deleting a hundred snapshots.
        let size = dir_size_bytes(&path);
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
            freed += size;
        }
    }
    (removed, freed)
}

/// Enforce [`CHECKPOINT_SEQS_PER_CHAT`] for every chat, and then the global
/// byte ceiling by deleting the OLDEST snapshots first.
///
/// Deleting oldest-first matters: recent undo history is what the feature is
/// for, so when the cap has to bite it should take the snapshots nobody is
/// going to restore. Returns (seq dirs removed, bytes freed).
fn cap_checkpoints(dir: &Path) -> (usize, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut removed = 0;
    let mut cap_freed = 0u64;
    // 1) Per-chat count cap.
    for entry in entries.flatten() {
        let chat_dir = entry.path();
        if chat_dir.is_dir() {
            let (n, bytes) = cap_checkpoint_seqs(&chat_dir, CHECKPOINT_SEQS_PER_CHAT);
            removed += n;
            cap_freed += bytes;
        }
    }

    // 2) Global byte ceiling.
    let mut total = dir_size_bytes(dir);
    if total <= CHECKPOINT_MAX_BYTES {
        return (removed, cap_freed);
    }
    // (mtime of the seq dir's newest file, seq dir path), oldest first.
    let mut seq_dirs: Vec<(SystemTime, PathBuf)> = Vec::new();
    if let Ok(chats) = std::fs::read_dir(dir) {
        for chat in chats.flatten() {
            let chat_dir = chat.path();
            if !chat_dir.is_dir() {
                continue;
            }
            if let Ok(seqs) = std::fs::read_dir(&chat_dir) {
                for seq in seqs.flatten() {
                    let seq_dir = seq.path();
                    if !seq_dir.is_dir() {
                        continue;
                    }
                    let newest = newest_mtime(&seq_dir).unwrap_or(SystemTime::UNIX_EPOCH);
                    seq_dirs.push((newest, seq_dir));
                }
            }
        }
    }
    seq_dirs.sort_by_key(|(at, _)| *at);
    let mut freed = cap_freed;
    for (_at, seq_dir) in seq_dirs {
        if total <= CHECKPOINT_MAX_BYTES {
            break;
        }
        let size = dir_size_bytes(&seq_dir);
        if std::fs::remove_dir_all(&seq_dir).is_ok() {
            total = total.saturating_sub(size);
            freed += size;
            removed += 1;
        }
    }
    // Drop chat dirs that the byte cap emptied, so the tree does not keep a
    // forest of empty directories.
    if let Ok(chats) = std::fs::read_dir(dir) {
        for chat in chats.flatten() {
            let chat_dir = chat.path();
            if chat_dir.is_dir() && dir_size_bytes(&chat_dir) == 0 {
                let _ = std::fs::remove_dir(&chat_dir);
            }
        }
    }
    (removed, freed)
}

/// Recursive byte size of `dir`. Missing paths are zero.
fn dir_size_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        total += match entry.metadata() {
            Ok(m) if m.is_dir() => dir_size_bytes(&path),
            Ok(m) => m.len(),
            Err(_) => 0,
        };
    }
    total
}

/// Delete trace files older than the TTL and trim any log that has grown past
/// the byte cap.
///
/// The write path already trims on append, but a log written by an older build
/// (before the cap existed) can still be sitting on disk at tens of MB, so the
/// sweep repairs it too — otherwise retention would only ever reclaim whole
/// files and a single hot chat could hold the disk.
fn sweep_traces(dir: &Path, ttl: Duration) -> usize {
    let removed = sweep_files(dir, ttl);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return removed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            crate::trace::trim_oversized(&path);
        }
    }
    removed
}

/// [`sweep_files`] restricted to one extension (e.g. only the terminal
/// `.log` files, leaving the row `.json` files to their own pruner).
fn sweep_files_ext(dir: &Path, ttl: Duration, ext: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| now().duration_since(m).map(|age| age > ttl).unwrap_or(false))
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// True when `name` matches the temp-file debris the atomic writers can leave
/// behind: `store.rs` writes `<name>.json.tmp<pid>.<nanos>` and
/// `plans.rs` writes `<name>.md.tmp<pid>-<seq>` — always `.tmp` followed by a
/// digit. A user-imported file merely NAMED `report.tmp` does not match.
fn is_tmp_debris(name: &str) -> bool {
    match name.find(".tmp") {
        Some(i) => name[i + 4..].chars().next().is_some_and(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// Remove stale temp-file debris from every tree the atomic writers touch,
/// recursively. `browser/` and `browser-profile/` are skipped: Chromium writes
/// plenty of its own legitimately-named temp files there, and a walk through
/// the profile costs more than it can ever reclaim.
fn sweep_stale_tmp_files(root: &Path, ttl: Duration) -> usize {
    fn walk(dir: &Path, depth: u8, ttl: Duration, removed: &mut usize) {
        if depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skip = path
                    .file_name()
                    .map(|n| n == "browser-profile" || n == "browser")
                    .unwrap_or(false);
                if !skip {
                    walk(&path, depth + 1, ttl, removed);
                }
            } else if is_tmp_debris(&entry.file_name().to_string_lossy()) {
                let stale = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|m| now().duration_since(m).map(|age| age > ttl).unwrap_or(false))
                    .unwrap_or(false);
                if stale && std::fs::remove_file(&path).is_ok() {
                    *removed += 1;
                }
            }
        }
    }
    let mut removed = 0;
    walk(root, 0, ttl, &mut removed);
    removed
}

/// The chats the settings index says exist: every spelling their ids can take
/// on disk (the body files, plan folders, media and artifacts dirs are
/// sanitized by two slightly different helpers) plus the relative body paths
/// the index rows name directly.
struct LiveIndex {
    ids: std::collections::HashSet<String>,
    dirs: std::collections::HashSet<String>,
}

impl LiveIndex {
    fn knows(&self, key: &str) -> bool {
        self.ids.contains(key)
    }
}

/// Read the live index straight from settings.json. The janitor thread has no
/// app handle, and the debounced writer keeps the file within a beat of truth.
///
/// A missing or unreadable `chats` array returns `None` and the caller skips
/// the orphan sweeps entirely: an unknown index must never read as "no chats
/// live", or one corrupt document would age out every chat on disk.
fn read_live_index(data_root: &Path) -> Option<LiveIndex> {
    let raw = std::fs::read_to_string(data_root.join("settings.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let rows = doc.get("chats")?.as_array()?;
    let mut idx = LiveIndex {
        ids: std::collections::HashSet::new(),
        dirs: std::collections::HashSet::new(),
    };
    for row in rows {
        if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
            idx.ids.insert(id.to_string());
            idx.ids.insert(crate::plans::safe_file(id, "chat"));
            idx.ids.insert(crate::store::safe_id(id));
        }
        if let Some(dir) = row.get("dir").and_then(|v| v.as_str()) {
            let dir = dir.trim().trim_start_matches("./");
            if !dir.is_empty() {
                idx.dirs.insert(dir.to_string());
            }
        }
    }
    Some(idx)
}

fn older_than(path: &Path, ttl: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(|m| now().duration_since(m).map(|age| age > ttl).unwrap_or(false))
        .unwrap_or(false)
}

fn dir_is_empty(dir: &Path) -> bool {
    std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
}

/// Chat body files whose index row is gone (the tombstone path removes the
/// body but the renderer can also drop rows) — removed after the grace, and
/// an emptied workspace dir is always reclaimable (a live workspace's dir is
/// re-created lazily on the next write).
fn sweep_orphan_chat_bodies(root: &Path, live: &LiveIndex, grace: Duration) -> usize {
    let mut removed = 0;
    let chats = root.join("chats");
    let Ok(ws_dirs) = std::fs::read_dir(&chats) else {
        return 0;
    };
    for ws in ws_dirs.flatten() {
        let ws_dir = ws.path();
        if !ws_dir.is_dir() {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(&ws_dir) {
            for f in files.flatten() {
                let path = f.path();
                if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let rel = format!("chats/{}/{}", ws.file_name().to_string_lossy(), f.file_name().to_string_lossy());
                if live.knows(stem) || live.dirs.contains(&rel) {
                    continue;
                }
                if older_than(&path, grace) && std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        if dir_is_empty(&ws_dir) {
            let _ = std::fs::remove_dir(&ws_dir);
        }
    }
    removed
}

/// Plan folders (`plan/<workspace>/<chat>/`) whose chat id no longer exists.
fn sweep_orphan_plans(root: &Path, live: &LiveIndex, grace: Duration) -> usize {
    let mut removed = 0;
    let Ok(ws_dirs) = std::fs::read_dir(root.join("plan")) else {
        return 0;
    };
    for ws in ws_dirs.flatten() {
        let ws_dir = ws.path();
        if !ws_dir.is_dir() {
            continue;
        }
        if let Ok(chats) = std::fs::read_dir(&ws_dir) {
            for chat in chats.flatten() {
                let chat_dir = chat.path();
                if !chat_dir.is_dir() {
                    continue;
                }
                let key = chat.file_name().to_string_lossy().to_string();
                if live.knows(&key) {
                    continue;
                }
                let stale = newest_mtime(&chat_dir)
                    .map(|m| now().duration_since(m).map(|age| age > grace).unwrap_or(false))
                    .unwrap_or(true);
                if stale && std::fs::remove_dir_all(&chat_dir).is_ok() {
                    removed += 1;
                }
            }
        }
        if dir_is_empty(&ws_dir) {
            let _ = std::fs::remove_dir(&ws_dir);
        }
    }
    removed
}

/// Per-chat folders under `media/` and `artifacts/` whose chat id no longer
/// exists (the tombstone delete path predates the media cascade, so deleted
/// chats leave both behind).
fn sweep_orphan_chat_dirs(root: &Path, sub: &str, live: &LiveIndex, grace: Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(root.join(sub)) else {
        return 0;
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let key = e.file_name().to_string_lossy().to_string();
        if live.knows(&key) {
            continue;
        }
        let stale = newest_mtime(&dir)
            .map(|m| now().duration_since(m).map(|age| age > grace).unwrap_or(false))
            .unwrap_or(true);
        if stale && std::fs::remove_dir_all(&dir).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Old Chrome-for-Testing builds (~150 MB apiece) are never removed when a new
/// version is installed. Keep the build the app would actually launch (the
/// highest `build_rank` — the same ordering `candidate_dirs` uses) and any
/// build younger than the grace, so a session running from the previous build
/// is not pulled out from under the user.
fn sweep_old_browsers(root: &Path, grace: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(root.join("browser")) else {
        return 0;
    };
    let mut builds: Vec<(u64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("chrome-for-testing"))
                    .unwrap_or(false)
        })
        .map(|p| (crate::browser::build_rank(&p), p))
        .collect();
    if builds.len() <= 1 {
        return 0;
    }
    builds.sort_by_key(|(rank, _)| *rank);
    let keep = builds.last().map(|(_, p)| p.clone());
    let mut removed = 0;
    for (_rank, path) in &builds {
        if keep.as_ref() == Some(path) {
            continue;
        }
        // Content mtime, not the dir's own: a dir's mtime updates whenever a
        // sibling file changes, masking the build's real age.
        let stale = newest_mtime(path)
            .map(|m| now().duration_since(m).map(|age| age > grace).unwrap_or(false))
            .unwrap_or(false);
        if stale && std::fs::remove_dir_all(path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The dead husks: `checkpoints/` has no writer anymore (the removed Python
/// sidecar wrote it; only this sweeper remains) and `vector-db/` was retired
/// outright. Removed only when EMPTY — legacy content still ages out through
/// the existing sweeps first.
fn sweep_dead_dirs(root: &Path) -> usize {
    let mut removed = 0;
    for name in ["checkpoints", "vector-db"] {
        let dir = root.join(name);
        if dir.is_dir() && dir_is_empty(&dir) && std::fs::remove_dir(&dir).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Run the full sweep once (background thread — never blocks startup).
/// Returns a short human-readable summary.
pub fn run_sweep(data_root: &Path) -> String {
    let trace_ttl = Duration::from_secs(TRACE_TTL_DAYS * 24 * 3600);
    let ckpt_ttl = Duration::from_secs(CHECKPOINT_TTL_DAYS * 24 * 3600);
    let upload_ttl = Duration::from_secs(UPLOAD_TTL_DAYS * 24 * 3600);
    let term_ttl = Duration::from_secs(TERMINAL_LOG_TTL_DAYS * 24 * 3600);
    let run_ttl = Duration::from_secs(SCHEDULE_RUN_TTL_DAYS * 24 * 3600);
    let cache_ttl = Duration::from_secs(MARKETPLACE_TTL_DAYS * 24 * 3600);
    let tmp_ttl = Duration::from_secs(TMP_FILE_TTL_HOURS * 3600);
    let grace = Duration::from_secs(ORPHAN_GRACE_HOURS * 3600);
    let browser_grace = Duration::from_secs(OLD_BROWSER_GRACE_HOURS * 3600);

    let traces = sweep_traces(&data_root.join("traces"), trace_ttl);
    let checkpoints = sweep_checkpoint_chats(&data_root.join("checkpoints"), ckpt_ttl);
    // TTL alone does not bound this tree (see CHECKPOINT_MAX_BYTES), so apply
    // the count and byte caps on every sweep as well.
    let (capped, freed) = cap_checkpoints(&data_root.join("checkpoints"));
    let uploads = sweep_files(&data_root.join("uploads"), upload_ttl);
    let tmp = sweep_stale_tmp_files(data_root, tmp_ttl);
    let term_logs = sweep_files_ext(&data_root.join("terminal-logs"), term_ttl, "log");
    let runs = sweep_files(&data_root.join("schedules").join("runs"), run_ttl);
    let market = sweep_files(&data_root.join("cache"), cache_ttl);
    let browsers = sweep_old_browsers(data_root, browser_grace);
    let dead = sweep_dead_dirs(data_root);
    // Orphan sweeps only run when the chat index is actually readable: an
    // unknown index must never read as "no chats live".
    let (chat_bodies, plans, chat_dirs) = match read_live_index(data_root) {
        Some(live) => (
            sweep_orphan_chat_bodies(data_root, &live, grace),
            sweep_orphan_plans(data_root, &live, grace),
            sweep_orphan_chat_dirs(data_root, "media", &live, grace)
                + sweep_orphan_chat_dirs(data_root, "artifacts", &live, grace),
        ),
        None => (0, 0, 0),
    };

    format!(
        "retention sweep: {traces} trace files, {checkpoints} checkpoint chats, \
{capped} capped checkpoints ({} MB freed), {uploads} uploads, {tmp} temp debris, \
{term_logs} terminal logs, {runs} schedule runs, {market} marketplace caches, \
{browsers} old browsers, {dead} dead dirs, \
{chat_bodies} orphan chat bodies, {plans} orphan plans, {chat_dirs} orphan chat dirs removed",
        freed / (1024 * 1024)
    )
}

/// Start the retention janitor: one sweep now, then one every
/// `JANITOR_INTERVAL` for as long as the app runs.
///
/// Called from the app's setup hook. It owns its thread, so boot is never
/// blocked, and it keeps running after the first pass — which is what actually
/// enforces the TTLs for a session that is never restarted.
pub fn start_janitor(data_root: PathBuf) {
    std::thread::spawn(move || loop {
        let summary = run_sweep(&data_root);
        println!("[{summary}]");
        std::thread::sleep(JANITOR_INTERVAL);
    });
}

#[cfg(test)]
mod tests;
