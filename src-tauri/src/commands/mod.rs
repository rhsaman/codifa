//! Tauri commands mirroring the Electron preload API (window.coder).
//!
//! Each command maps 1:1 to an ipcMain.handle channel the old Electron main
//! process exposed, so the renderer's tauriBridge shim can keep the exact
//! same surface.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state;

// --- shared types -----------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: String, // "file" | "dir" | "link"
    pub path: String,
}

#[derive(Clone, Serialize)]
pub struct SearchMatch {
    pub file: String,
    pub line: u64,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OpResult {
    fn ok() -> Self {
        OpResult { ok: true, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        OpResult { ok: false, error: Some(msg.into()) }
    }
}

// --- safe path resolution (mirrors electron/ipc/fs.ts resolveSafe) ----------

fn resolve_safe(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_real = root
        .canonicalize()
        .map_err(|e| format!("root missing: {e}"))?;
    let rel = rel.replace('\\', "/");
    let rel = rel.trim();
    if rel.is_empty() || rel == "/" {
        return Ok(root_real);
    }
    // An absolute path is taken as-is: the file viewer sends dir + basename for
    // absolute chips, and stripping the leading "/" made it root-relative
    // ("/Users/x/y.ts" -> "<root>/Users/x/y.ts") so every absolute chip failed
    // with "No file exists at this path". Containment is still enforced by the
    // canonicalized-anchor check below.
    let candidate = if rel.starts_with('/') {
        PathBuf::from(rel)
    } else {
        root_real.join(rel)
    };
    // Walk up to the nearest EXISTING ancestor and resolve THAT, so a
    // brand-new nested path can still be created inside the root.
    let mut anchor = candidate.clone();
    loop {
        if anchor.exists() {
            break;
        }
        match anchor.parent() {
            Some(p) if p != anchor => anchor = p.to_path_buf(),
            _ => return Err("path escapes project root".into()),
        }
    }
    let anchor_real = anchor
        .canonicalize()
        .map_err(|e| format!("anchor missing: {e}"))?;
    if anchor_real != root_real && !anchor_real.starts_with(&root_real) {
        return Err("path escapes project root".into());
    }
    // `join("")` appends a trailing separator, and `exists()` on "file/" is
    // false on Unix (ENOTDIR) — that made fs_read report EVERY existing file as
    // missing ("No file exists at this path"). Return the anchor itself when
    // there is no tail to append.
    let tail = candidate.strip_prefix(&anchor).unwrap_or(&candidate);
    Ok(if tail.as_os_str().is_empty() {
        anchor_real
    } else {
        anchor_real.join(tail)
    })
}

#[cfg(test)]
mod tests;

fn resolve_coder_safe(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let base = state::get_data_root(app);
    let rel = rel.replace('\\', "/");
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Ok(base);
    }
    let candidate = base.join(rel);
    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| e.to_string())?
    } else {
        candidate
    };
    if resolved != base && !resolved.starts_with(&base) {
        return Err("path escapes the data root".into());
    }
    Ok(resolved)
}

// --- directory listing / walk -----------------------------------------------


#[tauri::command]
pub async fn google_sign_in(
    _app: AppHandle,
    client_id: String,
    client_secret: String,
    scope: Option<String>,
) -> Result<serde_json::Value, String> {
    // Fully native now: no Python sidecar, no polling endpoint. The loopback
    // callback listener and the token exchange both live in `oauth.rs`.
    crate::oauth::sign_in(&client_id, &client_secret, scope).await
}

// --- dialogs (tauri-plugin-dialog) ------------------------------------------

#[tauri::command]
pub async fn select_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.dialog()
        .file()
        .set_title("Select folder")
        .pick_folder(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.recv().ok().flatten()
}

/// `start_dir` is the caller's workspace root: the picker opens there instead of
/// wherever the OS last left the user. Ignored when it is empty or gone.
#[tauri::command]
pub async fn select_file(app: AppHandle, start_dir: Option<String>) -> Option<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<String>>>();
    let mut builder = app.dialog().file().set_title("Select files");
    if let Some(dir) = start_dir.filter(|d| !d.trim().is_empty()) {
        if std::path::Path::new(&dir).is_dir() {
            builder = builder.set_directory(dir);
        }
    }
    builder.pick_files(move |paths| {
        let _ = tx.send(
            paths.map(|list| list.iter().map(|p| p.to_string()).collect()),
        );
    });
    rx.recv().ok().flatten()
}

/// Save ONE generated media file to a user-chosen location. The path is the
/// VIRTUAL media path (`media/<chat-slug>/<file>`) the UI carries; it is
/// resolved against the data root with the same containment rule the serving
/// route uses, so the dialog can never copy anything outside the media tree.
///
/// Alternatively the bytes may arrive inline as a `data:<mime>;base64,…` URL
/// (`data_url` — chat attachments only exist in the webview's memory): they
/// are parked in a temp file and served through the same dialog + copy flow,
/// so the temp file is always removed on every exit path below.
#[tauri::command]
pub async fn save_media_as(
    app: AppHandle,
    path: String,
    default_name: Option<String>,
    data_url: Option<String>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let tmp = data_url.as_deref().and_then(data_url_to_temp);
    let abs = match tmp {
        Some(ref p) => p.clone(),
        None => {
            let data_root = crate::state::current_data_root()?;
            crate::media_gen::resolve_media_virtual(&data_root.to_string_lossy(), &path).ok()?
        }
    };
    if !abs.is_file() {
        if let Some(ref p) = tmp {
            let _ = std::fs::remove_file(p);
        }
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    let mut builder = app.dialog().file().set_title("Save media as");
    let fallback_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = default_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback_name.as_str());
    if !name.is_empty() {
        builder = builder.set_file_name(name);
    }
    builder.save_file(move |dest| {
        let _ = tx.send(dest.map(|d| d.to_string()));
    });
    let dest = rx.recv().ok().flatten();
    let copied = match &dest {
        Some(dest) => std::fs::copy(&abs, dest).is_ok(),
        None => false,
    };
    if let Some(ref p) = tmp {
        let _ = std::fs::remove_file(p);
    }
    if copied {
        dest
    } else {
        None
    }
}

/// Decode a `data:<mime>;base64,…` URL into a uniquely named temp file. The
/// extension comes from the declared mime so the save dialog's default name
/// (set separately by the caller) pairs sensibly with it.
fn data_url_to_temp(data_url: &str) -> Option<PathBuf> {
    let (meta, payload) = data_url.split_once(',')?;
    let mime = meta
        .strip_prefix("data:")
        .and_then(|m| m.split(';').next())
        .unwrap_or_default();
    let ext = mime.rsplit('/').next().filter(|e| !e.is_empty())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let tmp = std::env::temp_dir().join(format!("codifa-save-{}.{}", nanos, ext));
    std::fs::write(&tmp, bytes).ok()?;
    Some(tmp)
}

// --- quit flush handshake ---------------------------------------------------

#[tauri::command]
pub fn flush_persist_done(app: AppHandle) {
    let _ = app.emit("flush-persist-done-ack", ());
}

// --- updater (GitHub releases + the user's own static feed) -----------------


mod fs;
mod search;
mod images;
mod system;
mod app;
mod launch;
mod updater;

pub use fs::*;
pub use search::*;
pub use images::*;
pub use system::*;
pub use app::*;
pub use launch::*;
pub use updater::*;

pub use fs::{coder_delete, coder_list, coder_read, coder_write, fs_copy, fs_delete, fs_list, fs_read, fs_rename, fs_walk, fs_write, skip_dirs};

pub use search::{search_content};

#[allow(unused_imports)] // original commands API surface, preserved verbatim
pub use images::{IMAGE_READ_MARK, computer_permissions, image_data_url, image_data_url_for, image_read_note, image_read_path, normalize_image, read_image, read_pdf_base64, request_screen_recording, sniff_image_mime};

pub use system::{capture_screen, copy_text, get_env, import_file, window_under_cursor};

pub use app::{get_data_path, has_settings_file, move_data_path, restart_app, secrets_get_key, sidecar_probe, sidecar_url};

pub use launch::{open_external, open_external_chrome, open_file_external, open_workspace_folder, open_workspace_terminal};

#[allow(unused_imports)] // original commands API surface, preserved verbatim
pub use updater::{UpdateInfo, check_for_updates, get_path_for_file, install_update, start_update, window_close, window_minimize, window_toggle_maximize};
