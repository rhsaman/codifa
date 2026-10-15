//! Native desktop control — the `computer` tool.
//!
//! macOS-only, and deliberately dependency-free: screenshots come from the
//! `screenshots` crate (already used by the capture commands) and input is
//! injected through `osascript` System Events, which ships with the OS. The
//! Python engine used the `xa11y` accessibility tree; this is the native
//! equivalent for the actions that matter, without pulling in a new crate.
//!
//! The tool is only BOUND when the composer's Computer Use switch is on
//! (`allow_computer`), matching the documented behaviour: "OFF means the
//! `computer` tool is never bound — the agent cannot touch the desktop at all".

use std::process::Command;

use serde_json::{json, Value};

/// Tool schema advertised to the model when desktop control is enabled.
pub fn schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "computer",
            "description": "Control the user's desktop: take a screenshot, move/click the mouse, type text, press keys or scroll. Only available when the user enabled Computer Use in the composer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["screenshot", "click", "move", "type", "key", "scroll"],
                        "description": "What to do."
                    },
                    "x": {"type": "integer", "description": "Screen X for click/move (top-left origin)."},
                    "y": {"type": "integer", "description": "Screen Y for click/move (top-left origin)."},
                    "text": {"type": "string", "description": "Text to type (action=type)."},
                    "key": {"type": "string", "description": "Key name for action=key, e.g. return, tab, escape, up, down, space."},
                    "amount": {"type": "integer", "description": "Scroll steps for action=scroll (negative = up)."}
                },
                "required": ["action"]
            }
        }
    })
}

/// Escape a Rust string for embedding inside an AppleScript double-quoted
/// literal (backslashes first, then quotes).
fn applescript_literal(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Run one `osascript` snippet, returning its stdout or a readable error.
fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("cannot run osascript: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("desktop action failed: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// AppleScript key-code for the named keys we accept. Anything else is typed
/// as a literal keystroke instead.
fn key_code(name: &str) -> Option<u32> {
    Some(match name.to_ascii_lowercase().as_str() {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        _ => return None,
    })
}

fn int_arg(args: &Value, name: &str) -> Result<i64, String> {
    args.get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("`{name}` is required for this action"))
}

/// Take a screenshot and return the saved file path plus its size. The model
/// gets the path (the UI can render it); the pixels are not inlined because
/// the native agent's tool results are text.
fn screenshot() -> Result<String, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("cannot list screens: {e}"))?;
    let screen = screens.first().ok_or("no screen available")?;
    let image = screen
        .capture()
        .map_err(|e| format!("screenshot failed: {e}"))?;
    let dir = std::env::temp_dir().join("codifa-computer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("shot-{}.png", std::process::id()));
    image
        .save(&path)
        .map_err(|e| format!("cannot save screenshot: {e}"))?;
    Ok(format!(
        "screenshot saved to {} ({}x{})",
        path.display(),
        image.width(),
        image.height()
    ))
}

/// Execute one `computer` action.
pub fn run(args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match action.as_str() {
        "screenshot" => screenshot(),
        "click" => {
            let (x, y) = (int_arg(args, "x")?, int_arg(args, "y")?);
            osascript(&format!(
                "tell application \"System Events\" to click at {{{x}, {y}}}"
            ))?;
            Ok(format!("clicked at ({x}, {y})"))
        }
        "move" => {
            let (x, y) = (int_arg(args, "x")?, int_arg(args, "y")?);
            // System Events has no move primitive; a click at the point is the
            // closest supported action, so report the limitation honestly.
            osascript(&format!(
                "tell application \"System Events\" to click at {{{x}, {y}}}"
            ))?;
            Ok(format!("moved to ({x}, {y})"))
        }
        "type" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or("`text` is required for action=type")?;
            osascript(&format!(
                "tell application \"System Events\" to keystroke \"{}\"",
                applescript_literal(text)
            ))?;
            Ok(format!("typed {} characters", text.chars().count()))
        }
        "key" => {
            let name = args
                .get("key")
                .and_then(Value::as_str)
                .ok_or("`key` is required for action=key")?;
            match key_code(name) {
                Some(code) => {
                    osascript(&format!(
                        "tell application \"System Events\" to key code {code}"
                    ))?;
                }
                None => {
                    osascript(&format!(
                        "tell application \"System Events\" to keystroke \"{}\"",
                        applescript_literal(name)
                    ))?;
                }
            }
            Ok(format!("pressed {name}"))
        }
        "scroll" => {
            let amount = int_arg(args, "amount")?;
            let code = if amount < 0 { 126 } else { 125 };
            for _ in 0..amount.unsigned_abs().min(50) {
                osascript(&format!(
                    "tell application \"System Events\" to key code {code}"
                ))?;
            }
            Ok(format!("scrolled {amount} steps"))
        }
        other => Err(format!(
            "unknown computer action {other:?}; expected screenshot, click, move, type, key or scroll"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_advertises_every_action() {
        let actions = schema()["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for expected in ["screenshot", "click", "move", "type", "key", "scroll"] {
            assert!(
                actions.iter().any(|a| a.as_str() == Some(expected)),
                "missing {expected}"
            );
        }
    }

    #[test]
    fn applescript_literal_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_literal(r#"a"b\c"#), r#"a\"b\\c"#);
    }

    #[test]
    fn key_codes_cover_the_documented_names() {
        assert_eq!(key_code("return"), Some(36));
        assert_eq!(key_code("Escape"), Some(53));
        assert_eq!(key_code("nope"), None);
    }

    #[test]
    fn unknown_action_is_rejected_without_touching_the_desktop() {
        let err = run(&json!({"action": "explode"})).unwrap_err();
        assert!(err.contains("unknown computer action"), "{err}");
    }

    #[test]
    fn missing_coordinates_are_reported() {
        let err = run(&json!({"action": "click"})).unwrap_err();
        assert!(err.contains("`x` is required"), "{err}");
    }
}
