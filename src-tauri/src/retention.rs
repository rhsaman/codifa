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

/// Run the full sweep once (background thread — never blocks startup).
/// Returns a short human-readable summary.
pub fn run_sweep(data_root: &Path) -> String {
    let trace_ttl = Duration::from_secs(TRACE_TTL_DAYS * 24 * 3600);
    let ckpt_ttl = Duration::from_secs(CHECKPOINT_TTL_DAYS * 24 * 3600);
    let upload_ttl = Duration::from_secs(UPLOAD_TTL_DAYS * 24 * 3600);

    let traces = sweep_traces(&data_root.join("traces"), trace_ttl);
    let checkpoints = sweep_checkpoint_chats(&data_root.join("checkpoints"), ckpt_ttl);
    // TTL alone does not bound this tree (see CHECKPOINT_MAX_BYTES), so apply
    // the count and byte caps on every sweep as well.
    let (capped, freed) = cap_checkpoints(&data_root.join("checkpoints"));
    let uploads = sweep_files(&data_root.join("uploads"), upload_ttl);

    format!(
        "retention sweep: {traces} trace files, {checkpoints} checkpoint chats, \
{capped} capped checkpoints ({} MB freed), {uploads} uploads removed",
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
mod tests {
    use super::*;
    use std::fs;
    use std::time::UNIX_EPOCH;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("codifa-retention-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn backdate(path: &std::path::Path, days: u64) {
        let old = UNIX_EPOCH
            + Duration::from_secs(
                now().duration_since(UNIX_EPOCH).unwrap().as_secs().saturating_sub(days * 24 * 3600),
            );
        // std::fs::FileTimes (Rust 1.75+) — no extra dependency needed.
        let f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
    }

    #[test]
    fn sweep_removes_only_stale_files() {
        let dir = tmp_dir("files");
        let fresh = dir.join("fresh.jsonl");
        let stale = dir.join("stale.jsonl");
        fs::write(&fresh, "x").unwrap();
        fs::write(&stale, "x").unwrap();
        backdate(&stale, 20);

        let removed = sweep_files(&dir, Duration::from_secs(14 * 24 * 3600));
        assert_eq!(removed, 1);
        assert!(fresh.exists());
        assert!(!stale.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_checkpoint_chats_uses_newest_seq() {
        let dir = tmp_dir("ckpt");
        // Chat A: one old seq dir -> removed. Chat B: old + fresh seq -> kept.
        let a = dir.join("chat-a").join("000001");
        let b_old = dir.join("chat-b").join("000001");
        let b_new = dir.join("chat-b").join("000002");
        for p in [&a, &b_old, &b_new] {
            fs::create_dir_all(p).unwrap();
            fs::write(p.join("manifest.json"), "{}").unwrap();
        }
        backdate(&a.join("manifest.json"), 20);
        backdate(&b_old.join("manifest.json"), 20);

        let removed = sweep_checkpoint_chats(&dir, Duration::from_secs(14 * 24 * 3600));
        assert_eq!(removed, 1);
        assert!(!dir.join("chat-a").exists());
        assert!(dir.join("chat-b").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_missing_dirs_is_noop() {
        let root = tmp_dir("missing");
        let summary = run_sweep(&root);
        assert!(summary.contains("0 trace files"));
        fs::remove_dir_all(&root).ok();
    }

    /// The sweep must also shrink an oversized log, not just delete old files:
    /// a log written before the byte cap existed has to be repaired on disk.
    #[test]
    fn sweep_trims_an_oversized_trace_log() {
        let root = tmp_dir("trim");
        let traces = root.join("traces");
        fs::create_dir_all(&traces).unwrap();
        let log = traces.join("chat.jsonl");
        // Comfortably past the cap.
        let row = format!(r#"{{"id":"x","kind":"prompt","prompt":"{}"}}"#, "y".repeat(400));
        let mut text = String::new();
        for _ in 0..30_000 {
            text.push_str(&row);
            text.push('\n');
        }
        fs::write(&log, &text).unwrap();
        assert!(fs::metadata(&log).unwrap().len() > crate::trace::TRACE_MAX_BYTES);

        let summary = run_sweep(&root);
        assert!(summary.contains("0 trace files"), "fresh file is not expired: {summary}");
        assert!(
            fs::metadata(&log).unwrap().len() <= crate::trace::TRACE_KEEP_BYTES,
            "log trimmed under the keep budget"
        );
        fs::remove_dir_all(&root).ok();
    }

    /// A chat that is snapshotted but never restored must still be bounded.
    ///
    /// The TTL alone could not do it: staleness is measured from the NEWEST file
    /// under a chat dir, so one recently touched blob kept every older snapshot
    /// alive. Measured on a real data root, 223.8 MB across 2690 files survived
    /// 18 days of sweeps that way.
    #[test]
    fn checkpoint_cap_bounds_every_chat() {
        let dir = tmp_dir("ckptcap");
        // One chat with far more snapshots than the per-chat cap allows.
        let over = CHECKPOINT_SEQS_PER_CHAT + 7;
        for seq in 0..over {
            let seq_dir = dir.join("chat-a").join(format!("{seq:06}"));
            fs::create_dir_all(&seq_dir).unwrap();
            fs::write(seq_dir.join("manifest.json"), "{}").unwrap();
        }

        let (removed, _freed) = cap_checkpoints(&dir);
        assert_eq!(removed, 7, "only the excess snapshots are dropped");
        let left = fs::read_dir(dir.join("chat-a")).unwrap().count();
        assert_eq!(left, CHECKPOINT_SEQS_PER_CHAT);
        // The cap keeps the NEWEST snapshots: recent undo history is the point.
        assert!(dir.join("chat-a").join(format!("{:06}", over - 1)).is_dir());
        assert!(!dir.join("chat-a").join("000000").exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// A small tree is left completely alone (the byte ceiling must not be a
    /// tax on every sweep).
    #[test]
    fn checkpoint_cap_keeps_a_small_tree() {
        let dir = tmp_dir("ckptsmall");
        for seq in 0..3 {
            let seq_dir = dir.join("chat-a").join(format!("{seq:06}"));
            fs::create_dir_all(&seq_dir).unwrap();
            fs::write(seq_dir.join("manifest.json"), "{}").unwrap();
        }
        assert_eq!(cap_checkpoints(&dir), (0, 0));
        assert_eq!(fs::read_dir(dir.join("chat-a")).unwrap().count(), 3);
        fs::remove_dir_all(&dir).ok();
    }
}
