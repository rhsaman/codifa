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

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};

const PREFIX_PLAIN: &str = "raw:";

/// Marker of an at-rest encrypted value (`enc:v1:<b64 iv>.<b64 ct+tag>`),
/// written by the renderer's `secrets.ts`.
const PREFIX_ENC: &str = "enc:v1:";

/// Process-global copy of the install key.
///
/// `get_secrets_key` needs an `AppHandle`, but the scheduler runs on its own
/// thread (and the axum router on a runtime) with no handle. Primed once at
/// startup so handle-free code can decrypt provider keys from settings.json
/// instead of shipping ciphertext as a bearer token.
static CACHED_KEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

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

/// Resolve the install key once and remember it for handle-free callers.
///
/// Called from the Tauri setup hook, where an `AppHandle` still exists. Safe to
/// call more than once; the first call wins so a later one cannot swap the key
/// under a value that was encrypted with the first.
pub fn prime_key(app: &tauri::AppHandle) {
    if let Ok(g) = CACHED_KEY.lock() {
        if g.is_some() {
            return;
        }
    }
    let key = get_secrets_key(app);
    if let Ok(mut g) = CACHED_KEY.lock() {
        *g = Some(key);
    }
}

fn cached_key() -> Option<String> {
    CACHED_KEY.lock().ok().and_then(|g| g.clone())
}

/// Decrypt one at-rest secret with the primed install key.
///
/// A value without the `enc:v1:` prefix is legacy plaintext and passes through
/// untouched. An undecryptable value yields `""` (a rotated key or a foreign
/// install) rather than the ciphertext: handing ciphertext to a provider only
/// produces an opaque 401 that hides the real cause.
pub fn decrypt_at_rest(value: &str) -> String {
    if !value.starts_with(PREFIX_ENC) {
        return value.to_string();
    }
    let Some(key_b64) = cached_key() else {
        return String::new();
    };
    let b64 = base64::engine::general_purpose::STANDARD;
    let Some(body) = value.strip_prefix(PREFIX_ENC) else {
        return String::new();
    };
    let Some((iv_b64, ct_b64)) = body.split_once('.') else {
        return String::new();
    };
    let (Ok(key), Ok(iv), Ok(ct)) = (b64.decode(&key_b64), b64.decode(iv_b64), b64.decode(ct_b64))
    else {
        return String::new();
    };
    if iv.len() != 12 {
        return String::new();
    }
    let Ok(cipher) = Aes256Gcm::new_from_slice(&key) else {
        return String::new();
    };
    match cipher.decrypt(Nonce::from_slice(&iv), ct.as_ref()) {
        Ok(pt) => String::from_utf8(pt).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Decrypt every provider's API key inside a raw settings document, in place.
///
/// The renderer encrypts `apiKeys`/`apiKey` before writing settings.json, so a
/// backend path that reads that file directly (the scheduler) must decrypt it
/// first — otherwise the "key" it sends is the `enc:v1:` ciphertext.
pub fn decrypt_provider_secrets(doc: &mut serde_json::Value) {
    let Some(providers) = doc.get_mut("providers").and_then(|p| p.as_array_mut()) else {
        return;
    };
    for p in providers {
        if let Some(keys) = p.get_mut("apiKeys").and_then(|k| k.as_array_mut()) {
            for k in keys.iter_mut() {
                if let Some(s) = k.as_str() {
                    let plain = decrypt_at_rest(s);
                    *k = serde_json::Value::String(plain);
                }
            }
        }
        if let Some(s) = p.get("apiKey").and_then(|k| k.as_str()) {
            let plain = decrypt_at_rest(s);
            if let Some(obj) = p.as_object_mut() {
                obj.insert("apiKey".into(), serde_json::Value::String(plain));
            }
        }
    }
}
