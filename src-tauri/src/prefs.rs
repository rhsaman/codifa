//! Plain (non-secret) renderer preferences the BACKEND needs while it runs.
//!
//! The renderer persists its settings payload into `<data root>/settings.json`
//! via the `store_set` command; a few of those keys drive Rust-side behaviour
//! that has no renderer in the loop (a headless/native open, a pty spawn). This
//! module is the single reader for them, so the defaults and the file location
//! are written down once instead of in every caller.
//!
//! Mirrors the pattern already used by `skill_router::configured_catalog_max`:
//! anything missing, unreadable or of the wrong type falls back to a sane
//! default instead of failing the action.
use serde_json::Value;

/// The current settings document, or `Null` when it is absent/unreadable.
pub fn settings_json(app: &tauri::AppHandle) -> Value {
    let root = crate::state::get_data_root(app);
    std::fs::read_to_string(root.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null)
}

/// A trimmed string preference, `""` when unset.
///
/// Note: provider API keys are stored ENCRYPTED (`enc:v1:`) in this same file
/// and are deliberately not reachable through this helper — it only serves the
/// plain UI preferences below.
pub fn string_pref(app: &tauri::AppHandle, key: &str) -> String {
    settings_json(app)
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Key holding the SHELL the in-app terminal tabs run. Empty = `$SHELL`.
pub const TERMINAL_SHELL_KEY: &str = "terminalShell";

/// Shell used when the setting is missing/unreadable. zsh is the macOS login
/// shell — and the one the user's dotfiles/plugins configure — so an unset
/// preference must not silently degrade to `sh`. Mirrors
/// `DEFAULT_TERMINAL_SHELL` in src/lib/nvimTerminals.ts.
pub const DEFAULT_TERMINAL_SHELL: &str = "zsh";
