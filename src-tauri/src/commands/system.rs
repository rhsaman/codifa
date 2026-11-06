use super::*;

/// Grab the primary display as a temp image the composer can attach.
///
/// `async` on purpose, and the grab itself runs on the blocking pool: this is
/// CoreGraphics capture plus an image encode, which takes seconds on a Retina
/// display. A non-`async` `#[tauri::command]` runs on the MAIN thread, so doing
/// it inline froze the event loop — macOS reported the app unresponsive and
/// terminated it while the capture was still running.
#[tauri::command]
pub async fn capture_screen() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let shots = screenshots::Screen::all().ok()?;
        let screen = shots.into_iter().next()?;
        let shot = screen.capture().ok()?;
        let img = image::DynamicImage::from(image::RgbaImage::from_raw(
            shot.width(),
            shot.height(),
            shot.into_raw(),
        )?);
        image_attachment(img, IMAGE_MAX_DIM)
    })
    .await
    .ok()
    .flatten()
}

// --- import / dialogs / clipboard / env -------------------------------------

/// Import an outside file into <data root>/uploads so the backend's read tools
/// can access it without a permission prompt.
#[tauri::command]
pub fn import_file(app: AppHandle, abs_path: String) -> Option<String> {
    let src = PathBuf::from(&abs_path);
    if !src.is_file() {
        return None;
    }
    let uploads = state::get_data_root(&app).join("uploads");
    let _ = std::fs::create_dir_all(&uploads);
    let base = src.file_name()?.to_string_lossy().into_owned();
    let mut dest = uploads.join(&base);
    if dest.exists() {
        let same = match (std::fs::metadata(&dest), std::fs::metadata(&src)) {
        (Ok(d), Ok(s)) => d.len() == s.len(),
        _ => false,
    };
        if !same {
            let stem = src
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = src
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            dest = uploads.join(format!("{stem}-{:x}{ext}", state::now_ms()));
        }
    }
    std::fs::copy(&src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn copy_text(text: String) -> bool {
    match arboard::Clipboard::new() {
        Ok(mut cb) => cb.set_text(text).is_ok(),
        Err(_) => false,
    }
}

/// Label of the app window under the cursor (physical-bounds hit-test).
/// macOS broadcasts the native drag event to EVERY app window, so the
/// renderer cannot tell which window the cursor is over from the
/// window-relative payload position. The shell resolves it here by
/// comparing the global cursor position against each window's physical
/// bounds (same coordinate space — no DPR conversion) and every window
/// receives the target label; only the targeted window shows the drag
/// overlay and attaches the dropped files.
#[tauri::command]
pub fn window_under_cursor(app: tauri::AppHandle) -> Option<String> {
    let cursor = app.cursor_position().ok()?;
    for (label, window) in app.webview_windows() {
        let Ok(pos) = window.outer_position() else { continue };
        let Ok(size) = window.outer_size() else { continue };
        let (px, py) = (f64::from(pos.x), f64::from(pos.y));
        let (w, h) = (f64::from(size.width), f64::from(size.height));
        if cursor.x >= px && cursor.x < px + w && cursor.y >= py && cursor.y < py + h {
            return Some(label);
        }
    }
    None
}

#[tauri::command]
pub fn get_env(key: String) -> Option<String> {
    // Only a strict env-var name shape is accepted; the value is returned to
    // the renderer which only ever surfaces a presence boolean (parity with
    // electron/main.ts env:get).
    let valid = !key.is_empty()
        && key.len() <= 128
        && key.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return None;
    }
    std::env::var(&key).ok()
}

// --- store / data path ------------------------------------------------------

