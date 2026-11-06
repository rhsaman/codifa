use super::*;

#[tauri::command]
pub fn get_data_path(app: AppHandle) -> String {
    state::get_data_root(&app).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn has_settings_file(app: AppHandle) -> bool {
    state::has_settings_file(&app)
}

#[tauri::command]
pub fn move_data_path(
    app: AppHandle,
    p: String,
) -> Result<String, String> {
    let dest = PathBuf::from(&p);
    let moved = state::move_data_root(&app, &dest, |label, pct| {
        let _ = app.emit("migrate:progress", serde_json::json!({ "label": label, "pct": pct }));
    })
    .map_err(|e| e.to_string())?;
    // The renderer is pointed at the native router, which resolves the data
    // root through `state::current_data_root()` on every request — so the move
    // is picked up with no restart. Tell the renderer so it can re-read paths.
    let _ = app.emit("sidecar:changed", ());
    Ok(moved.to_string_lossy().into_owned())
}

// --- local backend endpoint (native router) ---------------------------------

#[tauri::command]
pub fn sidecar_url(_app: AppHandle) -> Option<String> {
    // Kept under its historical name for the renderer's `window.coder` surface:
    // it returns the native router's loopback URL (there is no Python sidecar
    // any more). `None` while the router is still binding, which the renderer
    // treats as "not ready yet".
    crate::backend_light::public_url()
}

#[tauri::command]
pub fn sidecar_probe(_app: AppHandle) -> bool {
    // Same probe surface as before, now answered by the native router.
    crate::backend_light::public_url().is_some()
}

// --- secrets ----------------------------------------------------------------

#[tauri::command]
pub fn secrets_get_key(app: AppHandle) -> String {
    crate::secrets::get_secrets_key(&app)
}

// --- restart (Settings → Storage → Restore) ----------------------------------

/// Restart the whole app: the only way every reader (renderer store, skills
/// router, MCP index, caches) re-loads data a restore just wrote to disk. Goes
/// through the normal exit events, so the quit-flush handshake runs — but the
/// renderer suspends persistence when the restore starts, so that flush cannot
/// clobber the restored files with the stale pre-restore state.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.request_restart();
}

// --- open external ----------------------------------------------------------

