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
    let uploads = sweep_files(&data_root.join("uploads"), upload_ttl);

    format!(
        "retention sweep: {traces} trace files, {checkpoints} checkpoint chats, {uploads} uploads removed"
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
}
