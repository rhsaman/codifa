//! App data root resolution (Settings -> Data path).
//!
//! Mirrors electron/store-db.ts: a pointer file in the OS user-data dir names
//! the active data root (default ~/.codifa); the legacy ~/.coder root is
//! copied into the default non-destructively on first launch.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::Manager;

const DEFAULT_DATA_DIR: &str = ".codifa";
const LEGACY_DATA_DIR: &str = ".coder";

pub struct DataRoot(Mutex<Option<PathBuf>>);

impl DataRoot {
    pub fn new() -> Self {
        DataRoot(Mutex::new(None))
    }
}

/// Process-global mirror of the active data root.
///
/// The axum router runs on a tokio runtime with no `AppHandle`, and several
/// agent helpers run on threads that have no handle either — yet all of them
/// must see a Settings → Data path move. `get_data_root`/`set_data_root`
/// (which do have a handle) write this mirror, and everything else reads it.
static CURRENT_DATA_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The active data root without an `AppHandle`, if it has been resolved yet.
pub fn current_data_root() -> Option<PathBuf> {
    CURRENT_DATA_ROOT
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

fn set_current_data_root(root: &Path) {
    if let Ok(mut g) = CURRENT_DATA_ROOT.lock() {
        *g = Some(root.to_path_buf());
    }
}

fn pointer_file(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data-root.json")
}

/// The active data root (default ~/.codifa unless the user moved it).
pub fn get_data_root(app: &tauri::AppHandle) -> PathBuf {
    let state = app.state::<DataRoot>();
    let mut cached = state.0.lock().unwrap();
    if let Some(root) = cached.as_ref() {
        return root.clone();
    }
    let root = resolve(app);
    let _ = fs::create_dir_all(&root);
    *cached = Some(root.clone());
    // Mirror for the components without an AppHandle (router, agent threads).
    set_current_data_root(&root);
    root
}

fn resolve(app: &tauri::AppHandle) -> PathBuf {
    let pf = pointer_file(app);
    if let Ok(raw) = fs::read_to_string(&pf) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
                if !p.trim().is_empty() {
                    return PathBuf::from(p);
                }
            }
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let root = home.join(DEFAULT_DATA_DIR);
    migrate_legacy_root_once(&root, &home);
    root
}

/// One-time, non-destructive copy of the legacy ~/.coder root into the new
/// default (~/.codifa) when the new root does not exist yet.
fn migrate_legacy_root_once(root: &Path, home: &Path) {
    if root.exists() {
        return;
    }
    let legacy = home.join(LEGACY_DATA_DIR);
    if legacy == root || !legacy.exists() {
        return;
    }
    let _ = copy_tree(&legacy, root);
}

pub fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else if from.is_file() && !to.exists() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Persist the new data root so the next launch finds the same DB.
pub fn set_data_root(app: &tauri::AppHandle, root: &Path) -> PathBuf {
    let abs = root.to_path_buf();
    let _ = fs::create_dir_all(&abs);
    *app.state::<DataRoot>().0.lock().unwrap() = Some(abs.clone());
    // Keep the handle-less readers (router handlers, agent helpers) on the new
    // root — a data-path move must not leave them writing to the old folder.
    set_current_data_root(&abs);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(
            pointer_file(app),
            serde_json::json!({ "path": abs.to_string_lossy() }).to_string(),
        );
    }
    abs
}

/// Whether a settings file already exists in the data root (settings-wipe guard).
pub fn has_settings_file(app: &tauri::AppHandle) -> bool {
    get_data_root(app).join("settings.json").exists()
}

/// Copy the whole data root to `dest` with progress callbacks (Data path move).
pub fn move_data_root(
    app: &tauri::AppHandle,
    dest: &Path,
    on_progress: impl Fn(&str, u32),
) -> std::io::Result<PathBuf> {
    let src = get_data_root(app);
    fs::create_dir_all(dest)?;
    let total = count_files(&src);
    let mut done = 0u64;
    copy_with_progress(&src, dest, total, &mut done, &on_progress)?;
    set_data_root(app, dest);
    Ok(dest.to_path_buf())
}

fn count_files(dir: &Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += count_files(&p);
            } else if p.is_file() {
                n += 1;
            }
        }
    }
    n
}

fn copy_with_progress(
    src: &Path,
    dest: &Path,
    total: u64,
    done: &mut u64,
    on_progress: &impl Fn(&str, u32),
) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_with_progress(&from, &to, total, done, on_progress)?;
        } else if from.is_file() {
            fs::copy(&from, &to)?;
            *done += 1;
            on_progress(
                &entry.file_name().to_string_lossy(),
                if total > 0 {
                    ((*done as f64 / total as f64) * 100.0) as u32
                } else {
                    100
                },
            );
        }
    }
    Ok(())
}

/// Recursively delete a directory tree, ignoring missing paths.
#[allow(dead_code)]
pub fn remove_tree(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// Best-effort recursive copy used by the data move (kept for parity with the
/// Electron implementation's non-destructive copy semantics).
#[allow(dead_code)]
pub fn copy_dir_nondestructive(src: &Path, dest: &Path) {
    let _ = copy_tree(src, dest);
}

/// Small helper used by the sidecar health wait loop.
#[allow(dead_code)]
pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Current unix time in milliseconds.
pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
