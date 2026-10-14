//! Per-installation AES-256-GCM key for encrypting API keys / OAuth secrets at
//! rest in settings.json (mirrors electron/secrets.ts).
//!
//! The key never sits in plaintext on disk when the OS keychain is available:
//! it is stored wrapped by the OS credential store (macOS Keychain / Windows
//! Credential Manager / Linux secret service) under the `codifa` service. The
//! same key is handed to the renderer (via the `secrets_get_key` command) and
//! to the Python sidecar (via the `CODER_SECRET_KEY` env var).

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use rand::RngCore;
use tauri::Manager;

const PREFIX_PLAIN: &str = "raw:";

fn plain_key_file(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("secrets.key")
}

fn read_plain_fallback(app: &tauri::AppHandle) -> Option<String> {
    let raw = fs::read_to_string(plain_key_file(app)).ok()?;
    let raw = raw.trim();
    let b64 = raw.strip_prefix(PREFIX_PLAIN)?;
    if b64.len() >= 16 {
        Some(b64.to_string())
    } else {
        None
    }
}

/// Legacy Electron install key: the Electron build stored its plain-file key
/// under `<user-data>/codifa/secrets.key` while Tauri uses
/// `<user-data>/com.codifa.app/secrets.key`. Adopting the old key keeps the
/// encrypted providers/settings readable after the migration.
fn read_legacy_electron_key(app: &tauri::AppHandle) -> Option<String> {
    let legacy = app
        .path()
        .app_data_dir()
        .ok()?
        .parent()?
        .join("codifa")
        .join("secrets.key");
    let raw = fs::read_to_string(legacy).ok()?;
    let b64 = raw.trim().strip_prefix(PREFIX_PLAIN)?;
    if b64.len() >= 16 {
        Some(b64.to_string())
    } else {
        None
    }
}

fn write_plain_fallback(app: &tauri::AppHandle, b64: &str) {
    let file = plain_key_file(app);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&file, format!("{PREFIX_PLAIN}{b64}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
    }
}

/// The base64 32-byte AES key (lazily generated + keychain-wrapped once).
///
/// The plain-file cache (0600) is preferred over the keychain: unsigned dev
/// builds get a fresh code signature on every rebuild, so each keychain read
/// would re-trigger the macOS password prompt. We touch the keychain only
/// when the cache does not exist yet (first ever run).
pub fn get_secrets_key(app: &tauri::AppHandle) -> String {
    // 1) Plain-file cache written by an earlier run — no keychain access.
    if let Some(b64) = read_plain_fallback(app) {
        return b64;
    }
    // 1.5) Adopt the legacy Electron install key so encrypted data survives
    // the Electron -> Tauri migration. File-only: touching the keychain here
    // would re-trigger the macOS password prompt on every cache wipe.
    if let Some(b64) = read_legacy_electron_key(app) {
        write_plain_fallback(app, &b64);
        return b64;
    }
    // 2) Generate a fresh key. Deliberately no keychain access: unsigned dev
    // builds get a new code signature on every rebuild, so any keychain
    // read/write re-triggers the macOS password prompt. The 0600 plain file
    // is the single source of truth.
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    write_plain_fallback(app, &b64);
    b64
}
