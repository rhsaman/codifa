//! Native desktop control — the `computer` tool.
//!
//! The platform calls (CoreGraphics capture/events, System Events windows) live
//! in `crate::screen`; this module owns the action vocabulary the model sees and
//! the wording of every error.
//!
//! The tool is only BOUND when the composer's Computer Use switch is on
//! (`allow_computer`), matching the documented behaviour: "OFF means the
//! `computer` tool is never bound — the agent cannot touch the desktop at all".
//!
//! A screenshot does NOT return a path by itself: the pixels come back as
//! `Outcome::shots`, which the turn loop turns into image blocks so the model
//! actually sees what it captured. A path-only result made the agent act blind —
//! it asked for a screenshot, got a filename, and guessed the rest.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::screen::{self, Button, Display};

/// Text the model and the tool card receive.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// Human/model-readable result of the action.
    pub text: String,
    /// Screenshots taken by this action, in the order they were captured.
    pub shots: Vec<Shot>,
}

/// One captured image plus everything the model needs to click in it.
#[derive(Debug, Clone)]
pub struct Shot {
    pub path: String,
    /// What this image shows, for the label above the picture.
    pub label: String,
    /// Width/height of the image the model receives.
    pub width: u32,
    pub height: u32,
    /// Screen points per image pixel, and where image (0,0) sits on screen.
    pub points_per_pixel: f64,
    pub origin_x: f64,
    pub origin_y: f64,
}

/// Largest edge an image sent to the model is reduced to.
///
/// Every vision endpoint downsizes what it receives (Claude's cap is 1568px
/// across, Gemini tiles at 768px), so shipping a 5120px capture only pays for
/// pixels nobody looks at. 2560 keeps small UI text legible while cutting the
/// base64 payload of a 5K screenshot to about a quarter.
const MAX_IMAGE_EDGE: u32 = 2560;

/// Monotonic counter for screenshot file names.
static SHOT_SEQ: AtomicU64 = AtomicU64::new(0);

/// What a direct `computer` call is about to do, in the user's words.
///
/// A model MAY pass its own `reason` (why this desktop action is needed); that
/// is used verbatim. Otherwise the act and its target are stated here:
/// "Take a screenshot of the `Chrome` window", "Type \"hello\" into an app".
/// The permission card needs something the user can answer, never an empty
/// "Control the desktop".
pub fn permission_reason(args: &Value) -> String {
    if let Some(reason) = args["reason"]
        .as_str()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        return reason.to_string();
    }
    let action = args["action"].as_str().unwrap_or("screenshot").trim();
    let window = args["window"]
        .as_str()
        .map(str::trim)
        .filter(|w| !w.is_empty());
    let point = match (args["x"].as_i64(), args["y"].as_i64()) {
        (Some(x), Some(y)) => format!(" at ({x}, {y})"),
        _ => String::new(),
    };
    match action {
        "screenshot" => match window {
            Some(w) => format!("Take a screenshot of the `{w}` window."),
            None => "Take a screenshot of the desktop.".to_string(),
        },
        "list_screens" => "List the displays and windows of the desktop.".to_string(),
        "click" => {
            let right = args["button"]
                .as_str()
                .is_some_and(|b| b.eq_ignore_ascii_case("right"));
            let verb = if right {
                "Right-click"
            } else if args["clicks"].as_i64().unwrap_or(1) > 1 {
                "Double-click"
            } else {
                "Click"
            };
            format!("{verb} the desktop{point}.")
        }
        "double_click" => format!("Double-click the desktop{point}."),
        "right_click" => format!("Right-click the desktop{point}."),
        "move" => format!("Move the mouse{point}."),
        "drag" => match (
            args["x"].as_i64(),
            args["y"].as_i64(),
            args["to_x"].as_i64(),
            args["to_y"].as_i64(),
        ) {
            (Some(x), Some(y), Some(to_x), Some(to_y)) => {
                format!("Drag the mouse from ({x}, {y}) to ({to_x}, {to_y}).")
            }
            _ => "Drag the mouse on the desktop.".to_string(),
        },
        "scroll" => {
            let amount = args["amount"].as_i64().unwrap_or(0);
            format!("Scroll the desktop by {amount} steps.")
        }
        "type" => {
            let text = args["text"].as_str().unwrap_or_default();
            let preview: String = text.chars().take(80).collect();
            if preview.trim().is_empty() {
                "Type text into an app.".to_string()
            } else {
                format!("Type {preview:?} into an app.")
            }
        }
        "key" => match args["key"].as_str().map(str::trim).filter(|k| !k.is_empty()) {
            Some(key) => format!("Press the `{key}` key on the desktop."),
            None => "Press a key on the desktop.".to_string(),
        },
        other => format!("Use the desktop ({other})."),
    }
}

/// Tool schema advertised to the model when desktop control is enabled.
pub fn schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "computer",
            "description": "Control the user's desktop: take a screenshot (any display or one window), \
move/click/double-click/right-click the mouse, drag, type text, press keys or scroll. A screenshot \
comes back as an actual image you can look at, and every CHANGING action (click, type, key, \
scroll, drag) already returns the screen AFTER it acted — only call action=screenshot for a \
fresh look when you changed nothing. Page work (including page screenshots) belongs to the \
browser, not here. Only available when the user enabled Computer Use in the composer, and the \
first action of a task asks the user for permission with the reason shown.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "screenshot", "click", "double_click", "right_click", "move", "drag",
                            "type", "key", "scroll", "list_screens"
                        ],
                        "description": "What to do."
                    },
                    "x": {"type": "integer", "description": "Screen X in points, top-left origin of the main display (click/move/drag start)."},
                    "y": {"type": "integer", "description": "Screen Y in points, top-left origin of the main display (click/move/drag start)."},
                    "to_x": {"type": "integer", "description": "Drag end X (action=drag)."},
                    "to_y": {"type": "integer", "description": "Drag end Y (action=drag)."},
                    "text": {"type": "string", "description": "Text to type (action=type)."},
                    "key": {"type": "string", "description": "Key name for action=key, e.g. return, tab, escape, up, down, space."},
                    "amount": {"type": "integer", "description": "Scroll steps for action=scroll (negative = up)."},
                    "display": {"type": "integer", "description": "1-based display index for action=screenshot (see list_screens). Default: the display under the mouse."},
                    "window": {"type": "string", "description": "App name or window title (substring, case-insensitive) for action=screenshot — captures just that window and raises it first."},
                    "button": {"type": "string", "description": "Mouse button for click/double_click: left (default) or right."},
                    "clicks": {"type": "integer", "description": "Click count for action=click (default 1; 2 is the same as double_click)."},
                    "reason": {"type": "string", "description": "WHY this desktop action is needed for the user's task, in one short sentence — shown in the permission prompt before the first action runs."}
                },
                "required": ["action"]
            }
        }
    })
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

fn point_arg(args: &Value, x: &str, y: &str) -> Result<(f64, f64), String> {
    match screen::point_arg(args, x, y) {
        Some(p) => Ok(p),
        None => Err(format!("`{x}` and `{y}` are required for this action")),
    }
}

/// The button an action uses, from an optional `button` argument.
fn button_arg(args: &Value) -> Result<Button, String> {
    match args
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left")
        .to_ascii_lowercase()
        .as_str()
    {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        other => Err(format!("`button` must be \"left\" or \"right\" (got {other:?})")),
    }
}

/// One path per capture, under the shared `codifa-computer` temp folder.
///
/// The name used to be `shot-<pid>.png`, so every capture overwrote the last
/// one: the image cache validates entries by `(mtime, len)`, and a history entry
/// re-read on the next turn showed a LATER screenshot than the one its message
/// was about — the model could look at the wrong picture while claiming to
/// verify its click.
fn shot_path() -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("codifa-computer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let n = SHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!(
        "shot-{}-{}-{n}.png",
        std::process::id(),
        crate::state::now_ms()
    )))
}

/// Save a capture and describe the coordinate mapping to the model.
fn save_shot(
    img: &image::DynamicImage,
    label: String,
    display: &Display,
    origin_x: f64,
    origin_y: f64,
) -> Result<Shot, String> {
    let path = shot_path()?;
    img.save(&path)
        .map_err(|e| format!("cannot save screenshot: {e}"))?;
    // Points spanned by the image. For a whole display this is its own size; for
    // a cropped window it is the window's box, which can hang off the display —
    // so the origin is taken from the capture, not from the display.
    let points_per_pixel = if img.width() > 0 {
        (display.width as f64) / (img.width() as f64)
    } else {
        1.0
    };
    Ok(Shot {
        path: path.to_string_lossy().into_owned(),
        label,
        width: img.width(),
        height: img.height(),
        points_per_pixel,
        origin_x,
        origin_y,
    })
}

/// Shrink a capture to `MAX_IMAGE_EDGE` and to the display's point size, so the
/// image the model sees is 1 pixel per screen point wherever possible.
fn prepare(img: image::DynamicImage, display: &Display) -> image::DynamicImage {
    let scale = if display.scale > 0.0 {
        display.scale as f64
    } else {
        1.0
    };
    // Points, then the absolute cap on top of it.
    let mut target = (img.width() as f64 / scale, img.height() as f64 / scale);
    let longest = target.0.max(target.1);
    if longest > MAX_IMAGE_EDGE as f64 {
        let k = MAX_IMAGE_EDGE as f64 / longest;
        target = (target.0 * k, target.1 * k);
    }
    let (w, h) = (target.0.round().max(1.0) as u32, target.1.round().max(1.0) as u32);
    if w >= img.width() && h >= img.height() {
        return img;
    }
    img.resize(w, h, image::imageops::FilterType::Lanczos3)
}

/// The display a screenshot should come from: an explicit 1-based index, else
/// the one the mouse is on, else the primary one.
fn pick_display(explicit: Option<i64>) -> Result<(usize, Vec<Display>), String> {
    let all = screen::displays()?;
    if let Some(n) = explicit {
        let index = n.checked_sub(1).filter(|i| (*i as usize) < all.len()).ok_or_else(|| {
            format!("no display {n}; there {} {}", if all.len() == 1 { "is" } else { "are" }, all.len())
        })?;
        return Ok((index as usize, all));
    }
    let cursor = screen::cursor().and_then(|(x, y)| screen::display_at(&all, x, y));
    Ok((cursor.unwrap_or(0), all))
}

/// `list_screens`: the displays and windows the model may aim at.
fn list_screens() -> Result<Outcome, String> {
    let all = screen::displays()?;
    let mut text = String::from("Displays:\n");
    for (i, d) in all.iter().enumerate() {
        text.push_str(&format!(
            "  {}: {}x{} points at ({}, {}){}{}\n",
            i + 1,
            d.width,
            d.height,
            d.x,
            d.y,
            if d.primary { " — main" } else { "" },
            if d.scale > 1.0 {
                format!(", {}x native pixels", d.scale)
            } else {
                String::new()
            }
        ));
    }
    match screen::windows() {
        Ok(windows) if !windows.is_empty() => {
            text.push_str("\nWindows (what `window` accepts):\n");
            for w in windows.iter().take(MAX_LISTED_WINDOWS) {
                let title = if w.title.is_empty() { "(untitled)" } else { &w.title };
                text.push_str(&format!(
                    "  \"{}\" — {} at ({}, {}) {}x{}\n",
                    w.app,
                    title,
                    w.x.round(),
                    w.y.round(),
                    w.width.round(),
                    w.height.round()
                ));
            }
            if windows.len() > MAX_LISTED_WINDOWS {
                text.push_str(&format!("  …and {} more\n", windows.len() - MAX_LISTED_WINDOWS));
            }
        }
        Ok(_) => text.push_str("\nNo visible windows found.\n"),
        Err(e) => text.push_str(&format!("\nWindow list unavailable: {e}\n")),
    }
    Ok(Outcome { text, shots: Vec::new() })
}

/// How many windows `list_screens` prints before summarising the rest.
const MAX_LISTED_WINDOWS: usize = 40;

/// Capture a whole display or one named window.
fn screenshot(args: &Value) -> Result<Outcome, String> {
    let wants_window = args
        .get("window")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // Capture without this permission does not fail — macOS hands back a
    // wallpaper with every other app's windows removed, so the model would look
    // at an empty desktop and conclude the app is not running.
    if !screen::screen_recording_allowed() {
        // Ask on the way out: macOS only shows its own prompt (and only then
        // adds the app to the System Settings list) when the API is called, so
        // without this the user is told to flip a switch that is not there yet.
        // The prompt is once per app — macOS ignores repeat requests.
        screen::request_screen_recording();
        return Err(
            "macOS is not giving Codifa the screen contents, so this capture would show only the \
             wallpaper (other apps' windows are removed). Enable Codifa in System Settings → \
             Privacy & Security → Screen Recording, then quit and reopen Codifa. \
             `list_screens` still works and needs only the Accessibility permission."
                .into(),
        );
    }
    if let Some(needle) = wants_window {
        let windows = screen::windows()?;
        let hit = windows
            .iter()
            .find(|w| {
                w.app.to_lowercase().contains(&needle.to_lowercase())
                    || w.title.to_lowercase().contains(&needle.to_lowercase())
            })
            .ok_or_else(|| {
                format!(
                    "no visible window matches {needle:?}; call list_screens to see what is open"
                )
            })?;
        // Raise first: a window behind another one is captured as covered.
        let raised = screen::raise(&hit.app, &hit.title).is_ok();
        std::thread::sleep(std::time::Duration::from_millis(RAISE_SETTLE_MS));
        let all = screen::displays()?;
        let centre_x = hit.x + hit.width / 2.0;
        let centre_y = hit.y + hit.height / 2.0;
        let index = screen::display_at(&all, centre_x, centre_y)
            .or_else(|| all.iter().position(|d| d.primary))
            .ok_or("no display available")?;
        let display = all[index];
        let shot = screen::capture_region(hit.x, hit.y, hit.width, hit.height)?;
        let img = prepare(shot, &display);
        let label = format!("{} — {}", hit.app, if hit.title.is_empty() { "(untitled)" } else { &hit.title });
        let shot = save_shot(&img, label.clone(), &display, hit.x, hit.y)?;
        let text = format!(
            "captured window {label:?} ({}{}) — {}x{} image covering screen ({}, {}) to ({}, {}). \
             Click coordinates: x = {} + image_x × {:.4}, y = {} + image_y × {:.4}.",
            hit.width.round(),
            hit.height.round(),
            shot.width,
            shot.height,
            hit.x.round(),
            hit.y.round(),
            (hit.x + hit.width).round(),
            (hit.y + hit.height).round(),
            shot.origin_x.round(),
            shot.points_per_pixel,
            shot.origin_y.round(),
            shot.points_per_pixel,
        );
        let text = if raised {
            text
        } else {
            format!("{text} (Note: the window could not be raised, so another window may cover it.)")
        };
        return Ok(Outcome { text, shots: vec![shot] });
    }

    let explicit = args.get("display").and_then(Value::as_i64);
    let (index, all) = pick_display(explicit)?;
    let display = all[index];
    let shot = screen::capture_display(index)?;
    let img = prepare(shot, &display);
    let label = format!(
        "Display {} ({}{})",
        index + 1,
        display.width,
        format_args!("x{}", display.height)
    );
    let shot = save_shot(&img, label, &display, display.x as f64, display.y as f64)?;
    let text = format!(
        "captured display {} ({}x{} points at ({}, {})) — {}x{} image. \
         Click coordinates: x = {} + image_x × {:.4}, y = {} + image_y × {:.4}.",
        index + 1,
        display.width,
        display.height,
        display.x,
        display.y,
        shot.width,
        shot.height,
        shot.origin_x.round(),
        shot.points_per_pixel,
        shot.origin_y.round(),
        shot.points_per_pixel,
    );
    Ok(Outcome { text, shots: vec![shot] })
}

/// How long to let a raised window paint before capturing it.
const RAISE_SETTLE_MS: u64 = 180;

/// Execute one `computer` action.
pub fn run(args: &Value) -> Result<Outcome, String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let text = match action.as_str() {
        "screenshot" | "capture" => return screenshot(args),
        "list_screens" | "screens" => return list_screens(),
        "click" => {
            let (x, y) = point_arg(args, "x", "y")?;
            let button = button_arg(args)?;
            let count = args.get("clicks").and_then(Value::as_u64).unwrap_or(1);
            screen::click_at(x, y, button, count as u32)?;
            format!("clicked at ({}, {})", x.round(), y.round())
        }
        "double_click" | "doubleclick" | "double-click" => {
            let (x, y) = point_arg(args, "x", "y")?;
            let button = button_arg(args)?;
            screen::click_at(x, y, button, 2)?;
            format!("double-clicked at ({}, {})", x.round(), y.round())
        }
        "right_click" | "rightclick" | "right-click" => {
            let (x, y) = point_arg(args, "x", "y")?;
            screen::click_at(x, y, Button::Right, 1)?;
            format!("right-clicked at ({}, {})", x.round(), y.round())
        }
        "move" => {
            let (x, y) = point_arg(args, "x", "y")?;
            screen::move_to(x, y)?;
            format!("moved the pointer to ({}, {})", x.round(), y.round())
        }
        "drag" => {
            let (x, y) = point_arg(args, "x", "y")?;
            let (tx, ty) = point_arg(args, "to_x", "to_y")?;
            screen::drag((x, y), (tx, ty), button_arg(args)?)?;
            format!(
                "dragged from ({}, {}) to ({}, {})",
                x.round(),
                y.round(),
                tx.round(),
                ty.round()
            )
        }
        "type" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or("`text` is required for action=type")?;
            // AppleScript keystroke "…" cannot carry a raw newline — the
            // source becomes a syntax error. So split the payload into lines and
            // emit a dedicated `keystroke return` between them. Each line is still
            // escaped through applescript_literal, so quotes/backslashes can't
            // leak out of the string.
            let normalized = text.replace("\r\n", "\n").replace("\r", "\n");
            let lines: Vec<&str> = normalized.split('\n').collect();
            let mut script = String::new();
            for (i, line) in lines.iter().enumerate() {
                if i > 0 {
                    if !script.is_empty() {
                        script.push('\n');
                    }
                    script.push_str("tell application \"System Events\" to keystroke return");
                }
                if line.is_empty() {
                    continue;
                }
                if !script.is_empty() {
                    script.push('\n');
                }
                script.push_str(&format!(
                    "tell application \"System Events\" to keystroke \"{}\"",
                    screen::applescript_literal(line)
                ));
            }
            if !script.is_empty() {
                screen::osascript(&script)?;
            }
            format!("typed {} characters", text.chars().count())
        }
        "key" => {
            let name = args
                .get("key")
                .and_then(Value::as_str)
                .ok_or("`key` is required for action=key")?;
            match key_code(name) {
                Some(code) => screen::press_key(code as u16)?,
                None => {
                    screen::osascript(&format!(
                        "tell application \"System Events\" to keystroke \"{}\"",
                        screen::applescript_literal(name)
                    ))?;
                }
            }
            format!("pressed {name}")
        }
        "scroll" => {
            let amount = int_arg(args, "amount")?;
            // An optional point first: a scroll event goes to whatever is under
            // the cursor, so aiming it needs the pointer moved there.
            if let Some((x, y)) = screen::point_arg(args, "x", "y") {
                screen::move_to(x, y)?;
            }
            screen::scroll(amount as i32)?;
            format!("scrolled {amount} steps")
        }
        other => {
            return Err(format!(
                "unknown computer action {other:?}; expected screenshot, list_screens, click, \
double_click, right_click, move, drag, type, key or scroll"
            ))
        }
    };
    // A mutating action CAPTURES THE SCREEN IT CHANGED: the result carries the
    // "after" picture in the same outcome (the turn loop attaches the pixels to
    // the next request), so `click → look at it` costs ONE model round instead
    // of two — the same round-elimination the browser driver's post-action
    // snapshot applies to page actions. `move` is excluded (nothing changed to
    // look at), and a failed capture must never fail a SUCCESSFUL action — the
    // model just falls back to calling action=screenshot itself.
    if POST_ACTION_SHOT_ACTIONS.contains(&action.as_str()) {
        match screenshot(&json!({})) {
            Ok(mut after) => {
                for s in after.shots.iter_mut() {
                    s.label = format!("screen after {action}");
                }
                return Ok(Outcome {
                    text,
                    shots: after.shots,
                });
            }
            Err(_) => {
                return Ok(Outcome {
                    text,
                    shots: Vec::new(),
                })
            }
        }
    }
    Ok(Outcome {
        text,
        shots: Vec::new(),
    })
}

/// Actions that CHANGE the screen, so the result carries the "after" capture.
const POST_ACTION_SHOT_ACTIONS: &[&str] = &[
    "click",
    "double_click",
    "doubleclick",
    "double-click",
    "right_click",
    "rightclick",
    "right-click",
    "drag",
    "type",
    "key",
    "scroll",
];

#[cfg(test)]
mod tests;
