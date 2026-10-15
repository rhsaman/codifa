//! Startup retention sweep for on-disk artifacts that would otherwise grow
//! forever: chat traces (JSONL), undo checkpoints, and imported uploads.
//! Files older than their TTL are deleted once at app startup (cheap, no
//! background janitor needed — the app restarts far more often than the TTL).

use std::time::{Duration, SystemTime};

/// Retention windows (days). Traces are debug aids, checkpoints are undo
/// history, uploads are imported attachments — none need to outlive these.
const TRACE_TTL_DAYS: u64 = 14;
const CHECKPOINT_TTL_DAYS: u64 = 14;
const UPLOAD_TTL_DAYS: u64 = 30;

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

/// Run the full sweep once. Called from the app's setup hook (background
/// thread — never blocks startup). Returns a short human-readable summary.
pub fn run_startup_sweep(data_root: &std::path::Path) -> String {
    let trace_ttl = Duration::from_secs(TRACE_TTL_DAYS * 24 * 3600);
    let ckpt_ttl = Duration::from_secs(CHECKPOINT_TTL_DAYS * 24 * 3600);
    let upload_ttl = Duration::from_secs(UPLOAD_TTL_DAYS * 24 * 3600);

    let traces = sweep_files(&data_root.join("traces"), trace_ttl);
    let checkpoints = sweep_checkpoint_chats(&data_root.join("checkpoints"), ckpt_ttl);
    let uploads = sweep_files(&data_root.join("uploads"), upload_ttl);

    format!(
        "retention sweep: {traces} trace files, {checkpoints} checkpoint chats, {uploads} uploads removed"
    )
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
        let summary = run_startup_sweep(&root);
        assert!(summary.contains("0 trace files"));
        fs::remove_dir_all(&root).ok();
    }
}
