//! Full-app backup (Settings → Storage).
//!
//! Packs the ACTIVE data root into a single zip (`codifa-backup-<stamp>.zip`)
//! so settings, providers, chats, plugins (skills + connectors), plans,
//! schedules, artifacts and uploads all travel together. What is left out is
//! either data the user excluded or data the app can rebuild: traces,
//! checkpoints, memory, the browser profile, caches, logs and macOS sidecars.
//! The zip layout IS the data root (paths relative to it, plus a
//! `backup.json` manifest), so unzipping into a fresh data root restores.
//!
//! Default destination is the data root itself (`~/.codifa` unless moved);
//! `Settings → Storage` lets the user pick another folder. Because the default
//! means the archive lands INSIDE the folder it is packing, every
//! `codifa-backup-*.zip` is skipped while collecting — old backups never get
//! re-packed into new ones.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Base name of the archive file (a `-<timestamp>` suffix is appended so
/// repeated backups never overwrite each other).
const BACKUP_STEM: &str = "codifa-backup";

/// Data-root folders never packed: the user excluded trace / checkpoint /
/// memory, and the rest is re-creatable state (a fresh browser profile is
/// spawned on demand, the vector db re-indexes, `cache/` is a TTL cache).
const EXCLUDED_DIRS: &[&str] = &[
    "traces",
    "checkpoints",
    "memory",
    "cache",
    "browser-profile",
    "vector-db",
];

/// Data-root files never packed: logs (rebuilt on every run), the settings
/// safety copy (settings.json itself is packed), and macOS sidecars.
const EXCLUDED_FILES: &[&str] = &["rust.log", "panic.log", "settings.json.bak", ".DS_Store"];

/// Recursion cap: a symlinked cycle in the data root must not hang the walk.
/// Symlinks are skipped outright, so this is pure second-order insurance.
const MAX_DEPTH: usize = 64;

/// Managed run-state: the busy flag rejects a second concurrent backup, the
/// cancel flag is polled between files (a in-flight file always completes).
pub struct BackupState {
    busy: AtomicBool,
    cancel: AtomicBool,
}

impl BackupState {
    pub fn new() -> Self {
        BackupState {
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}

/// Clears the busy flag on every exit path, including a dropped future.
struct BusyGuard(AppHandle);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Some(s) = self.0.try_state::<BackupState>() {
            s.busy.store(false, Ordering::SeqCst);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

/// What `backup.json` in an archive says about it — shown before the user
/// commits to a restore.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub created: String,
    pub files: u64,
    pub bytes: u64,
    pub version: String,
    pub data_root: String,
    /// True when the archive carries the install key (`secrets.key`), i.e. the
    /// encrypted API keys will decrypt after a restore — on THIS machine or on
    /// any other one. Old archives predate the entry.
    pub secrets_key: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub files: u64,
    pub elapsed_ms: u64,
    /// True when the archive's install key was written to this machine's
    /// app-data dir (the restored provider keys are decryptable here).
    pub secrets_restored: bool,
}

/// Name of the archive entry that carries the install key — the AES key that
/// unlocks the `enc:v1:` API keys inside the packed settings.json. It lives in
/// the per-OS app-data dir, OUTSIDE the data root, so it must travel as its
/// own entry; a restore writes it back there (last step, after the data).
const SECRETS_ENTRY: &str = "secrets.key";

/// One file bound for the archive: where it is on disk and the path it takes
/// INSIDE the zip (always `/`-separated, relative to the data root).
struct PackFile {
    abs: PathBuf,
    rel: String,
    size: u64,
}

#[tauri::command]
pub async fn create_backup(app: AppHandle, dest_dir: String) -> Result<BackupResult, String> {
    if let Some(s) = app.try_state::<BackupState>() {
        if s.busy.swap(true, Ordering::SeqCst) {
            return Err("A backup is already running.".into());
        }
    }
    let _guard = BusyGuard(app.clone());
    if let Some(s) = app.try_state::<BackupState>() {
        s.cancel.store(false, Ordering::SeqCst);
    }
    let handle = app.clone();
    tokio::task::spawn_blocking(move || run_backup(&handle, &dest_dir))
        .await
        .map_err(|e| format!("backup task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_backup(app: AppHandle) {
    if let Some(s) = app.try_state::<BackupState>() {
        s.cancel.store(true, Ordering::SeqCst);
    }
}

/// Read the manifest of a backup archive WITHOUT extracting anything — the
/// picker hands back any zip, so this is also the validator that refuses
/// non-codifa archives before a restore can start.
#[tauri::command]
pub fn backup_info(path: String) -> Result<BackupInfo, String> {
    read_manifest(&expand_home(path.trim()))
}

/// The manifest out of an archive, or a precise error for anything that is not
/// a codifa backup (a random zip must be rejected, not restored).
fn read_manifest(path: &Path) -> Result<BackupInfo, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("cannot open the archive: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| "the file is not a zip archive".to_string())?;
    let mut entry = zip
        .by_name("backup.json")
        .map_err(|_| "this is not a codifa backup — the archive has no backup.json manifest".to_string())?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("cannot read the manifest: {e}"))?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("corrupt backup manifest: {e}"))?;
    if doc["app"].as_str() != Some("codifa") {
        return Err("this is not a codifa backup".into());
    }
    Ok(BackupInfo {
        created: doc["created"].as_str().unwrap_or_default().to_string(),
        files: doc["files"].as_u64().unwrap_or(0),
        bytes: doc["bytes"].as_u64().unwrap_or(0),
        version: doc["version"].as_str().unwrap_or_default().to_string(),
        data_root: doc["dataRoot"].as_str().unwrap_or_default().to_string(),
        secrets_key: doc["secretsKey"].as_bool().unwrap_or(false),
    })
}

/// Restore an archive over the ACTIVE data root. Shares the busy guard with
/// `create_backup` — a backup and a restore must never touch the root at once.
#[tauri::command]
pub async fn restore_backup(app: AppHandle, path: String) -> Result<RestoreResult, String> {
    if let Some(s) = app.try_state::<BackupState>() {
        if s.busy.swap(true, Ordering::SeqCst) {
            return Err("Another backup or restore is already running.".into());
        }
    }
    let _guard = BusyGuard(app.clone());
    if let Some(s) = app.try_state::<BackupState>() {
        s.cancel.store(false, Ordering::SeqCst);
    }
    let handle = app.clone();
    tokio::task::spawn_blocking(move || run_restore(&handle, &path))
        .await
        .map_err(|e| format!("restore task failed: {e}"))?
}

/// Restore = extract to a staging folder INSIDE the data root, then move every
/// file into place. The staging pass means a cancelled or failed restore (bad
/// zip, disk full, user panic-click) leaves the current data EXACTLY as it
/// was; only the fast move phase touches the live root. The renderer restarts
/// the app after a successful restore, because every in-memory reader (store,
/// skills, MCP) must re-load from disk.
fn run_restore(app: &AppHandle, path: &str) -> Result<RestoreResult, String> {
    let started = Instant::now();
    let dest = crate::state::get_data_root(app);
    let archive = expand_home(path.trim());
    // Validates the archive up front (a non-codifa zip must not get halfway).
    read_manifest(&archive)?;

    let cancel = || {
        app.try_state::<BackupState>()
            .is_some_and(|s| s.cancel.load(Ordering::SeqCst))
    };
    // Throttled like the backup events (~10/s, final event always passes).
    let mut last_emit = Instant::now() - Duration::from_secs(10);
    let on_progress = |label: &str, pct: u32, done: u64, total: u64| {
        let now = Instant::now();
        if done != total && now.duration_since(last_emit) < Duration::from_millis(100) {
            return;
        }
        last_emit = now;
        let _ = app.emit(
            "restore:progress",
            serde_json::json!({ "label": label, "pct": pct, "files": done, "total": total }),
        );
    };

    let outcome = restore_archive(
        &archive,
        &dest,
        Some(&crate::secrets::install_key_file(app)),
        cancel,
        on_progress,
    )?;
    // The written file is the source of truth — make the process-global cache
    // agree with it immediately (the restart will re-fetch it anyway).
    if outcome.secrets_restored {
        crate::secrets::refresh_cached_key(app);
    }
    Ok(RestoreResult {
        files: outcome.files,
        elapsed_ms: started.elapsed().as_millis() as u64,
        secrets_restored: outcome.secrets_restored,
    })
}

/// Build the archive. Runs on a blocking thread: hundreds of megabytes of
/// chats/uploads must never sit inside an async task that shares the UI's
/// runtime. Progress goes out as `backup:progress` events, throttled to
/// ~10/s (one event per file would flood the IPC bridge at thousands of files).
fn run_backup(app: &AppHandle, dest_dir: &str) -> Result<BackupResult, String> {
    let started = Instant::now();
    let src = crate::state::get_data_root(app);
    let dest = {
        let trimmed = dest_dir.trim();
        let expanded = expand_home(trimmed);
        if expanded.as_os_str().is_empty() {
            src.clone()
        } else {
            expanded
        }
    };
    let cancel = || {
        app.try_state::<BackupState>()
            .is_some_and(|s| s.cancel.load(Ordering::SeqCst))
    };
    // Throttled to ~10/s: one event per file would flood the IPC bridge when
    // the data root holds thousands of small chat files. The final event
    // (done == total) always passes.
    let mut last_emit = Instant::now() - Duration::from_secs(10);
    let on_progress = |label: &str, pct: u32, done: u64, total: u64| {
        let now = Instant::now();
        if done != total && now.duration_since(last_emit) < Duration::from_millis(100) {
            return;
        }
        last_emit = now;
        let _ = app.emit(
            "backup:progress",
            serde_json::json!({ "label": label, "pct": pct, "files": done, "total": total }),
        );
    };
    build_backup(&src, &dest, crate::secrets::read_install_key(app).as_deref(), cancel, on_progress).map(|mut res| {
        res.elapsed_ms = started.elapsed().as_millis() as u64;
        res
    })
}

/// The zip-building core, free of any Tauri types so the tests (and the
/// `backup_live` example) can drive it against a scratch data root. `cancel`
/// is polled between files (an in-flight file always completes); a cancelled
/// or failed run leaves NO partial archive behind.
///
/// `install_key` is the raw content of this install's `secrets.key` (the AES
/// key that unlocks the encrypted API keys in settings.json). It lives outside
/// the data root, so it travels as its own archive entry — without it a
/// restore on another machine or OS would leave every provider key
/// undecryptable. `None` packs an archive without it (still restorable on the
/// machine that owns the matching key).
pub fn build_backup(
    src: &Path,
    dest: &Path,
    install_key: Option<&[u8]>,
    cancel: impl Fn() -> bool,
    mut on_progress: impl FnMut(&str, u32, u64, u64),
) -> Result<BackupResult, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("cannot create the backup folder: {e}"))?;
    if !dest.is_dir() {
        return Err(format!("backup folder is not a directory: {}", dest.display()));
    }

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut out = dest.join(format!("{BACKUP_STEM}-{stamp}.zip"));
    let mut n = 1u32;
    while out.exists() {
        n += 1;
        out = dest.join(format!("{BACKUP_STEM}-{stamp}-{n}.zip"));
    }
    // Written under a `.part` name and renamed into place only when COMPLETE.
    // The manifest is the FIRST entry, so a truncated archive can still carry a
    // valid-looking manifest and pass `backup_info` — packing must never leave
    // a partial file under the real name (an error, a cancel, or a crash all
    // go through the same cleanup below).
    let part = out.with_extension("zip.part");

    let mut files: Vec<PackFile> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    collect(src, src, "", &mut files, &mut dirs, 0)
        .map_err(|e| format!("cannot read the data folder: {e}"))?;
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    let total_files = files.len() as u64;

    let packed = (|| -> Result<(), String> {
        let zip_file = std::fs::File::create(&part)
            .map_err(|e| format!("cannot create the archive: {e}"))?;
        let mut writer = zip::ZipWriter::new(zip_file);
        // `large_file` turns on zip64, so a single entry past 4 GiB cannot abort a
        // long-overdue backup.
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);

        let manifest = serde_json::json!({
            "app": "codifa",
            "version": env!("CARGO_PKG_VERSION"),
            "created": chrono::Local::now().to_rfc3339(),
            "dataRoot": src.to_string_lossy(),
            "files": total_files,
            "bytes": total_bytes,
            "excludedDirs": EXCLUDED_DIRS,
            "excludedFiles": EXCLUDED_FILES,
            "secretsKey": install_key.is_some(),
        });
        writer
            .start_file("backup.json", options.clone())
            .map_err(|e| format!("cannot write the manifest: {e}"))?;
        writer
            .write_all(manifest.to_string().as_bytes())
            .map_err(|e| format!("cannot write the manifest: {e}"))?;
        if let Some(key) = install_key {
            writer
                .start_file(SECRETS_ENTRY, options.clone())
                .map_err(|e| format!("cannot write the install key: {e}"))?;
            writer
                .write_all(key)
                .map_err(|e| format!("cannot write the install key: {e}"))?;
        }
        for d in &dirs {
            writer
                .add_directory(d, options.clone())
                .map_err(|e| format!("cannot add the folder {d}: {e}"))?;
        }

        let mut done_files = 0u64;
        let mut done_bytes = 0u64;
        for f in &files {
            if cancel() {
                return Err("Backup cancelled.".into());
            }
            writer
                .start_file(&f.rel, options.clone())
                .map_err(|e| format!("cannot add {} to the archive: {e}", f.rel))?;
            let mut src_file = std::fs::File::open(&f.abs)
                .map_err(|e| format!("cannot read {}: {e}", f.abs.display()))?;
            std::io::copy(&mut src_file, &mut writer)
                .map_err(|e| format!("cannot pack {}: {e}", f.rel))?;
            done_files += 1;
            done_bytes += f.size;
            let pct = if total_bytes > 0 {
                ((done_bytes as f64 / total_bytes as f64) * 100.0) as u32
            } else if total_files > 0 {
                ((done_files as f64 / total_files as f64) * 100.0) as u32
            } else {
                100
            };
            on_progress(&f.rel, pct.min(99), done_files, total_files);
        }
        writer
            .finish()
            .map_err(|e| format!("cannot finalize the archive: {e}"))?;
        Ok(())
    })();

    if let Err(e) = packed {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    // Complete and CRC-valid: publish under the final name.
    std::fs::rename(&part, &out)
        .map_err(|e| format!("cannot publish the archive: {e}"))?;

    on_progress("", 100, total_files, total_files);
    Ok(BackupResult {
        path: out.to_string_lossy().into_owned(),
        files: total_files,
        bytes: total_bytes,
        elapsed_ms: 0,
    })
}

/// Staging folder for a restore, INSIDE the destination root: extraction lands
/// here first, and only the (fast, same-volume) rename pass touches the live
/// data. Same volume is required for `fs::rename` — hence inside, not /tmp.
fn staging_dir(root: &Path) -> PathBuf {
    root.join(format!(
        ".restore-staging-{}",
        std::process::id()
    ))
}

/// What a completed restore applied: the file count plus whether the archive's
/// install key was written to this machine (`secrets_restored`) — the UI
/// reports the latter, because it decides whether the restored provider keys
/// will actually decrypt here.
#[derive(Debug)]
pub struct RestoreOutcome {
    pub files: u64,
    pub secrets_restored: bool,
}

/// Apply a codifa backup archive over `root`. Two phases:
///
/// 1. extract every entry into `<root>/.restore-staging-<pid>/` — cancel or
///    any failure here simply deletes the staging folder and the live data is
///    untouched;
/// 2. move every staged file onto its live path (overwrite) and remove the
///    staging folder.
///
/// The manifest (`backup.json`) is metadata, not data-root content, and is
/// never written into the root. The install key (`secrets.key`) is captured in
/// phase 1 and written to `secrets_target` — this machine's app-data dir — as
/// the LAST step, so the restored `enc:v1:` provider keys decrypt on this
/// install, whatever OS it is. `enclosed_name()` rejects archive entries that
/// try to escape (`../`), so a hand-tampered archive cannot write outside the
/// data root.
pub fn restore_archive(
    archive: &Path,
    root: &Path,
    secrets_target: Option<&Path>,
    cancel: impl Fn() -> bool,
    mut on_progress: impl FnMut(&str, u32, u64, u64),
) -> Result<RestoreOutcome, String> {
    // Cheap validity gate: no manifest, no restore (the command layer checks
    // its content; here we only require it to exist so a random zip cannot be
    // splattered over the data root).
    {
        let file = std::fs::File::open(archive)
            .map_err(|e| format!("cannot open the archive: {e}"))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|_| "the file is not a zip archive".to_string())?;
        if zip.by_name("backup.json").is_err() {
            return Err("this is not a codifa backup — the archive has no backup.json manifest".into());
        }
    }

    let staging = staging_dir(root);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("cannot create the staging folder: {e}"))?;

    // Phase 1 — extract into staging. Progress is byte-weighted across the
    // archive's uncompressed sizes (uploads dominate, chat files are tiny).
    let result = (|| -> Result<(u64, Option<Vec<u8>>), String> {
        let file = std::fs::File::open(archive)
            .map_err(|e| format!("cannot open the archive: {e}"))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|_| "the file is not a zip archive".to_string())?;
        let mut total_bytes = 0u64;
        let mut total_files = 0u64;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| format!("cannot read the archive: {e}"))?;
            total_bytes += entry.size();
            if !entry.is_dir() && !entry.name().is_ok_and(|n| is_meta_entry(&n)) {
                total_files += 1;
            }
        }
        let mut done_bytes = 0u64;
        let mut done_files = 0u64;
        let mut install_key: Option<Vec<u8>> = None;
        for i in 0..zip.len() {
            if cancel() {
                return Err("Restore cancelled.".into());
            }
            let mut entry =
                zip.by_index(i).map_err(|e| format!("cannot read the archive: {e}"))?;
            // `enclosed_name()` is the traversal guard: `None` = the entry
            // points outside the archive root, skip it.
            let Some(rel) = entry.enclosed_name() else { continue };
            if entry.name().is_ok_and(|n| is_meta_entry(&n)) {
                // The install key is captured, not staged: it belongs to the
                // app-data dir, never inside the data root.
                if entry.name().is_ok_and(|n| n == SECRETS_ENTRY) {
                    let mut bytes = Vec::new();
                    entry
                        .read_to_end(&mut bytes)
                        .map_err(|e| format!("cannot read the install key: {e}"))?;
                    install_key = Some(bytes);
                }
                continue;
            }
            let out = staging.join(&rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)
                    .map_err(|e| format!("cannot create {}: {e}", rel.display()))?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            let mut out_file = std::fs::File::create(&out)
                .map_err(|e| format!("cannot write {}: {e}", rel.display()))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("cannot extract {}: {e}", rel.display()))?;
            done_bytes += entry.size();
            done_files += 1;
            let pct = if total_bytes > 0 {
                ((done_bytes as f64 / total_bytes as f64) * 95.0) as u32
            } else {
                95
            };
            on_progress(
                &rel.to_string_lossy(),
                pct.min(95),
                done_files,
                total_files,
            );
        }
        Ok((done_files, install_key))
    })();
    if let Err(e) = result {
        // Nothing has touched the live root yet — a cancelled or failed
        // extraction must not leave staging behind either.
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    // The staged file count is recomputed from the live moves below; only the
    // install key survives this phase.
    let (_staged_files, install_key) = result.ok().unwrap_or_default();

    // Phase 2 — move every staged file onto its live path. Renames within the
    // same volume are atomic and fast; the cancel check between entries bounds
    // a cancel to a partially-applied restore. Staging never outlives the
    // restore, success or not.
    let outcome = (|| -> Result<u64, String> {
        let mut moved = 0u64;
        let mut dirs: Vec<PathBuf> = Vec::new();
        collect_staged(&staging, &staging, &mut dirs, &mut moved, root, &cancel)?;
        // Empty folders have no files to carry them — recreate explicitly.
        for d in &dirs {
            let rel = d.strip_prefix(&staging).unwrap_or(d);
            std::fs::create_dir_all(root.join(rel))
                .map_err(|e| format!("cannot create {}: {e}", rel.display()))?;
        }
        Ok(moved)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    let moved = outcome?;

    // The install key goes LAST: data and settings.json are already in place,
    // so any window where the key and the ciphertext disagree is closed
    // immediately after. A restore that runs with `secrets_target: None` (or
    // an archive without the entry) keeps this machine's current key.
    let mut secrets_restored = false;
    if let (Some(bytes), Some(target)) = (install_key, secrets_target) {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if write_secret_file_atomic(target, &bytes).is_ok() {
            secrets_restored = true;
        }
    }

    on_progress("", 100, moved, moved);
    Ok(RestoreOutcome {
        files: moved,
        secrets_restored,
    })
}

/// The two archive-root entries that are metadata, not data-root content.
fn is_meta_entry(name: &str) -> bool {
    name == "backup.json" || name == SECRETS_ENTRY
}

/// Atomic write for the install key: temp + fsync + rename, 0600 on unix.
fn write_secret_file_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension(format!("key.tmp{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("cannot write the install key: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("cannot write the install key: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("cannot write the install key: {e}"))?;
    }
    std::fs::rename(&tmp, target)
        .map_err(|e| format!("cannot publish the install key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Depth-first walk of the staging folder, renaming every file onto its live
/// path under `root` (paths relative to `staging`) and collecting directories
/// so empty ones survive the move.
fn collect_staged(
    staging: &Path,
    dir: &Path,
    dirs: &mut Vec<PathBuf>,
    moved: &mut u64,
    root: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read staging: {e}"))?;
    for entry in entries.flatten() {
        if cancel() {
            return Err("Restore cancelled.".into());
        }
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path.clone());
            collect_staged(staging, &path, dirs, moved, root, cancel)?;
        } else {
            let rel = path.strip_prefix(staging).unwrap_or(&path);
            let live = root.join(rel);
            if let Some(parent) = live.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            std::fs::rename(&path, &live)
                .map_err(|e| format!("cannot apply {}: {e}", rel.display()))?;
            *moved += 1;
        }
    }
    Ok(())
}

/// Depth-first walk of the data root collecting every packable file and every
/// directory (as zip entries, so empty folders survive a restore). `rel_dir`
/// carries the path prefix built so far — `""` at the root.
fn collect(
    base: &Path,
    dir: &Path,
    rel_dir: &str,
    files: &mut Vec<PackFile>,
    dirs: &mut Vec<String>,
    depth: usize,
) -> std::io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Ok(ft) = entry.file_type() else { continue };
        // A symlink is never packed: it can point anywhere (even out of the
        // data root or back into it, forming a cycle) and no data-root data
        // depends on one.
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        let path = entry.path();
        if ft.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            // A crashed restore's staging folder is not data (the restore
            // cleans it up; this is defense in depth for future backups).
            if name.starts_with(".restore-staging") {
                continue;
            }
            collect(base, &path, &rel, files, dirs, depth + 1)?;
            dirs.push(rel);
        } else if ft.is_file() {
            if EXCLUDED_FILES.contains(&name.as_str()) {
                continue;
            }
            // Any prior backup in the tree is skipped: with the default
            // destination equal to the data root, re-packing yesterday's zip
            // would double the archive on every run. `.part` covers a crashed
            // backup's staging file, which is not a restorable archive either.
            if name.starts_with(BACKUP_STEM)
                && (name.ends_with(".zip") || name.ends_with(".zip.part"))
            {
                continue;
            }
            // The archive-root `secrets.key` entry is reserved for the install
            // key — a data-root file of the same name would collide with it in
            // the zip, so it never packs.
            if rel == SECRETS_ENTRY {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(PackFile { abs: path, rel, size });
        }
    }
    Ok(())
}

/// Accept `~` and `~/…` exactly like the Data path field does; anything else is
/// taken verbatim (the picker always hands back absolute paths).
fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

#[cfg(test)]
mod tests;
