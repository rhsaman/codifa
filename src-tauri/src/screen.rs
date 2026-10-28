//! macOS screen, window and input primitives for the `computer` tool.
//!
//! Split out of `computer.rs` so the platform calls live in one place: the tool
//! module owns the ACTION vocabulary and the error wording, this module owns the
//! CoreGraphics / System Events calls.
//!
//! Three things the old implementation could not do, and why they need
//! CoreGraphics rather than plain `osascript`:
//!
//! * `screens.first()` was always the primary display. Picking the display the
//!   user is actually looking at needs the cursor position.
//! * Capture without the Screen Recording permission does not fail — macOS
//!   returns a wallpaper-only image with every other app's windows removed. Only
//!   `CGPreflightScreenCaptureAccess` can tell us that in advance.
//! * System Events has no drag, no right-click and no scroll wheel; `key code`
//!   presses were the old stand-in for scrolling.

use image::DynamicImage;
use serde_json::Value;

/// Escape a Rust string for embedding inside an AppleScript double-quoted
/// literal (backslashes first, then quotes).
pub fn applescript_literal(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// One display, in POINTS (the coordinate space events and window geometry use)
/// plus the scale factor needed to turn a screenshot pixel back into a point.
#[derive(Debug, Clone, Copy)]
pub struct Display {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub primary: bool,
}

/// One on-screen window of any application.
#[derive(Debug, Clone)]
pub struct Window {
    pub app: String,
    pub title: String,
    /// Bounds in global points, top-left origin.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Which mouse button an input action uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
}

/// All displays, primary first.
pub fn displays() -> Result<Vec<Display>, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("cannot list displays: {e}"))?;
    if screens.is_empty() {
        return Err("no display available".into());
    }
    let mut out: Vec<Display> = screens
        .iter()
        .map(|s| Display {
            x: s.display_info.x,
            y: s.display_info.y,
            width: s.display_info.width,
            height: s.display_info.height,
            scale: s.display_info.scale_factor,
            primary: s.display_info.is_primary,
        })
        .collect();
    // `Screen::all` order is a CoreGraphics detail; the primary display is the
    // one a caller means when it asks for "the screen" with no argument.
    out.sort_by_key(|d| !d.primary);
    Ok(out)
}

/// Capture one display at native resolution.
///
/// `screenshots` depends on image 0.24 while this crate is on 0.25, so the
/// pixels are copied through raw bytes: the two `RgbaImage` types are different
/// types even though they describe the same buffer.
pub fn capture_display(index: usize) -> Result<DynamicImage, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("cannot list displays: {e}"))?;
    let screen = screens
        .get(index)
        .ok_or_else(|| format!("no display at index {index}; there are {}", screens.len()))?;
    let image = screen
        .capture()
        .map_err(|e| format!("screenshot failed: {e}"))?;
    let (w, h) = (image.width(), image.height());
    let rgba = image::RgbaImage::from_raw(w, h, image.into_raw())
        .ok_or_else(|| format!("screenshot buffer is not {w}x{h} RGBA"))?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

/// Index of the display containing a point, if any.
pub fn display_at(displays: &[Display], x: f64, y: f64) -> Option<usize> {
    displays.iter().position(|d| {
        x >= d.x as f64
            && y >= d.y as f64
            && x < (d.x as f64 + d.width as f64)
            && y < (d.y as f64 + d.height as f64)
    })
}

/// Crop a rectangle given in GLOBAL points out of whichever display holds it.
///
/// The screenshot is captured at native resolution, so the crop is scaled by
/// the display's factor: a window at (100, 200) with size (800, 600) on a 2x
/// display is pixels (200, 400) through (1800, 1600).
pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<DynamicImage, String> {
    let all = displays()?;
    let cx = x + width / 2.0;
    let cy = y + height / 2.0;
    let index = display_at(&all, cx, cy)
        .or_else(|| all.iter().position(|d| d.primary))
        .ok_or("no display available")?;
    let display = all[index];
    let shot = capture_display(index)?;
    let scale = if display.scale > 0.0 {
        display.scale as f64
    } else {
        1.0
    };
    let px = ((x - display.x as f64) * scale).round().max(0.0) as u32;
    let py = ((y - display.y as f64) * scale).round().max(0.0) as u32;
    let pw = (width * scale).round().max(1.0) as u32;
    let ph = (height * scale).round().max(1.0) as u32;
    // Clamp to the frame we actually got: a window may hang off the edge or
    // report bounds from before a resolution change.
    let pw = pw.min(shot.width().saturating_sub(px)).max(1);
    let ph = ph.min(shot.height().saturating_sub(py)).max(1);
    Ok(DynamicImage::ImageRgba8(
        image::imageops::crop_imm(&shot, px, py, pw, ph).to_image(),
    ))
}

/// Cursor position in global points, if it can be read.
pub fn cursor() -> Option<(f64, f64)> {
    let point = current_cursor_point()?;
    // A failed read gives (0, 0) — the top-left corner of the first display,
    // which is a real place. Treat it as unknown so the caller falls back to the
    // primary display instead of silently cropping the wrong monitor.
    if point.0 == 0.0 && point.1 == 0.0 {
        return None;
    }
    Some(point)
}

/// Whether macOS will hand this process the REAL pixels of other apps' windows.
pub fn screen_recording_allowed() -> bool {
    preflight_screen_capture()
}

/// Ask macOS to list this app under Screen Recording (it shows the prompt once
/// per app; the user still has to flip the switch in System Settings).
pub fn request_screen_recording() -> bool {
    request_screen_capture()
}

/// Whether this process may inject input into OTHER applications.
pub fn accessibility_allowed() -> bool {
    accessibility_trusted()
}

/// Identity macOS used to key this build's TCC grant.
///
/// TCC remembers a permission against the code SIGNATURE, not the app name, so
/// an ad-hoc signed build (which Tauri produces without a signing identity)
/// gets a fresh grant on every compile. Showing this on the card is the only
/// way the user can tell which entry in System Settings is really theirs.
#[cfg(target_os = "macos")]
pub fn bundle_identity() -> serde_json::Value {
    serde_json::json!({
        "id": main_bundle_id(),
        "name": main_bundle_name(),
        "path": main_executable_path(),
        "adhoc": main_bundle_is_adhoc(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn bundle_identity() -> serde_json::Value {
    serde_json::Value::Null
}

// CoreFoundation's `CFBundle` accessors, the only bundle API reachable without
// pulling in the objc2 crates. Keys are `CFString`s and both calls are
// `Get Rule` — the returned reference is owned by the bundle, so it is read
// and released through `cf_string` rather than retained here.
#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFBundleGetMainBundle() -> *const std::ffi::c_void;
    fn CFBundleGetIdentifier(bundle: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CFBundleGetValueForInfoDictionaryKey(
        bundle: *const std::ffi::c_void,
        key: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    fn CFBundleCopyExecutableURL(bundle: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CFStringCreateWithCString(
        alloc: *const std::ffi::c_void,
        c_str: *const std::ffi::c_char,
        encoding: u32,
    ) -> *const std::ffi::c_void;
    fn CFURLCopyFileSystemPath(
        url: *const std::ffi::c_void,
        path_style: isize,
    ) -> *const std::ffi::c_void;
    fn CFStringGetCString(
        s: *const std::ffi::c_void,
        buffer: *mut std::ffi::c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
    fn CFStringGetLength(s: *const std::ffi::c_void) -> isize;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
#[cfg(target_os = "macos")]
const K_CF_URL_POSIX_PATH_STYLE: isize = 0;
/// `kCFAllocatorDefault`, i.e. let CoreFoundation allocate.
#[cfg(target_os = "macos")]
const CF_ALLOC_DEFAULT: *const std::ffi::c_void = std::ptr::null();

/// Copy a `CFStringRef` into a Rust `String`.
///
/// The buffer is sized from `CFStringGetLength` (UTF-16 units, an upper bound
/// for UTF-8 bytes only up to 3x) so a path with non-ASCII characters is not
/// silently truncated: the first call measures, the second fills.
#[cfg(target_os = "macos")]
unsafe fn cf_string(cf: *const std::ffi::c_void) -> String {
    if cf.is_null() {
        return String::new();
    }
    let units = CFStringGetLength(cf) as usize;
    if units == 0 {
        return String::new();
    }
    // Worst case UTF-8: 3 bytes per UTF-16 unit, plus the NUL terminator.
    let mut buf = vec![0i8; units * 3 + 1];
    let ok = CFStringGetCString(
        cf,
        buf.as_mut_ptr(),
        buf.len() as isize,
        K_CF_STRING_ENCODING_UTF8,
    );
    if ok == 0 {
        return String::new();
    }
    let bytes: Vec<u8> = buf
        .into_iter()
        .take_while(|b| *b != 0)
        .map(|b| b as u8)
        .collect();
    String::from_utf8(bytes).unwrap_or_default()
}

/// Read a top-level `Info.plist` key out of the main bundle.
#[cfg(target_os = "macos")]
unsafe fn bundle_info_string(key: &str) -> String {
    let bundle = CFBundleGetMainBundle();
    if bundle.is_null() {
        return String::new();
    }
    let Ok(c_key) = std::ffi::CString::new(key) else {
        return String::new();
    };
    let cf_key = CFStringCreateWithCString(CF_ALLOC_DEFAULT, c_key.as_ptr(), K_CF_STRING_ENCODING_UTF8);
    if cf_key.is_null() {
        return String::new();
    }
    let value = CFBundleGetValueForInfoDictionaryKey(bundle, cf_key);
    let out = cf_string(value);
    CFRelease(cf_key);
    out
}

#[cfg(target_os = "macos")]
fn main_bundle_id() -> String {
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return String::new();
        }
        cf_string(CFBundleGetIdentifier(bundle))
    }
}

#[cfg(target_os = "macos")]
fn main_bundle_name() -> String {
    unsafe { bundle_info_string("CFBundleName") }
}

#[cfg(target_os = "macos")]
fn main_executable_path() -> String {
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return String::new();
        }
        // `CFBundleCopyExecutableURL` is a Copy Rule function: this reference
        // IS owned, so release it once the path has been extracted.
        let url = CFBundleCopyExecutableURL(bundle);
        if url.is_null() {
            return String::new();
        }
        let path = CFURLCopyFileSystemPath(url, K_CF_URL_POSIX_PATH_STYLE);
        let out = cf_string(path);
        if !path.is_null() {
            CFRelease(path);
        }
        CFRelease(url);
        out
    }
}

/// Whether the running binary is ad-hoc signed.
///
/// An ad-hoc signature's Designated Requirement is its cdhash, which changes on
/// every build — that is exactly why the switch resets itself each time.
#[cfg(target_os = "macos")]
fn main_bundle_is_adhoc() -> bool {
    let path = main_executable_path();
    if path.is_empty() {
        return false;
    }
    let Ok(data) = std::fs::read(&path) else {
        return false;
    };
    adhoc_in_signature(&data)
}

/// Whether a Mach-O was signed ad-hoc (no certificate chain).
///
/// An ad-hoc signature's Designated Requirement is its cdhash, which changes on
/// every compile — that is exactly why the System Settings switch has to be
/// flipped again after each build. The signature blob sits past the code, so
/// only the tail needs scanning; a Developer ID build carries a `CSSL` blob
/// whose inner structures reference a CMS signature the ad-hoc one lacks.
#[cfg(target_os = "macos")]
fn adhoc_in_signature(macho: &[u8]) -> bool {
    const MAGIC: &[u8] = b"CSSL";
    // CSMAGIC_EMBEDDED_SIGNATURE superblob: magic (4) + length (4) + count (4),
    // then that many 8-byte (type, offset) index entries. An ad-hoc blob is a
    // CodeDirectory with no CMS (type 0x10000) slot; a signed one always has it.
    let tail = macho.len().saturating_sub(1 << 20);
    let Some(pos) = macho[tail..]
        .windows(MAGIC.len())
        .rposition(|w| w == MAGIC)
    else {
        return false;
    };
    let at = tail + pos;
    let Some(count) = macho
        .get(at + 8..at + 12)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    else {
        return false;
    };
    // CMS_SIGNATURE blob type in the embedded-signature superblob index.
    const CSSL_TYPE_CMS_SIGNATURE: u32 = 0x0001_0000;
    (0..count.min(64)).all(|i| {
        let Some(entry) = macho.get(at + 12 + i * 8..at + 20 + i * 8) else {
            return true;
        };
        let kind = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
        kind != CSSL_TYPE_CMS_SIGNATURE
    })
}

/// Every on-screen window, across all applications.
pub fn windows() -> Result<Vec<Window>, String> {
    let script = concat!(
        "set out to \"\"\n",
        "tell application \"System Events\"\n",
        "  repeat with p in (every process whose visible is true)\n",
        "    try\n",
        "      set pname to name of p\n",
        "      repeat with w in (every window of p)\n",
        "        try\n",
        "          set pos to position of w\n",
        "          set sz to size of w\n",
        "          set wt to name of w\n",
        "          set out to out & pname & tab & wt & tab & (item 1 of pos) & tab & ",
        "(item 2 of pos) & tab & (item 1 of sz) & tab & (item 2 of sz) & return\n",
        "        end try\n",
        "      end repeat\n",
        "    end try\n",
        "  end repeat\n",
        "end tell\n",
        "return out",
    );
    let raw = osascript(script).map_err(|e| {
        format!(
            "{e} — listing windows needs the Accessibility permission \
             (System Settings → Privacy & Security → Accessibility)"
        )
    })?;
    Ok(parse_windows(&raw))
}

/// Parse the tab/return separated rows `windows()` asks System Events for.
fn parse_windows(raw: &str) -> Vec<Window> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut f = line.split('\t');
        let (Some(app), Some(title), Some(x), Some(y), Some(w), Some(h)) = (
            f.next(),
            f.next(),
            f.next(),
            f.next(),
            f.next(),
            f.next(),
        ) else {
            continue;
        };
        let (Ok(x), Ok(y), Ok(w), Ok(h)) = (
            x.trim().parse::<f64>(),
            y.trim().parse::<f64>(),
            w.trim().parse::<f64>(),
            h.trim().parse::<f64>(),
        ) else {
            continue;
        };
        // A zero-sized "window" is a menu bar / status item, not something the
        // model could look at or click meaningfully.
        if w < 1.0 || h < 1.0 {
            continue;
        }
        // A row whose box lies ENTIRELY outside the desktop is not a window the
        // model can use: there are no pixels to capture and no point to click.
        // This is the menu-bar strip System Events reports above the display
        // (y = -h), and any window pushed off an edge.
        if x + w <= 0.0 || y + h <= 0.0 {
            continue;
        }
        out.push(Window {
            app: app.trim().to_string(),
            title: title.trim().to_string(),
            x,
            y,
            width: w,
            height: h,
        });
    }
    out
}

/// Bring a window to the front so its pixels are not covered by whatever the
/// user had on top. Best effort: a window that refuses to raise is still worth
/// cropping, so the caller reports rather than fails.
pub fn raise(app: &str, title: &str) -> Result<(), String> {
    let app = applescript_literal(app);
    let title = applescript_literal(title);
    let script = format!(
        "tell application \"System Events\"\n\
         \x20 set p to first process whose name is \"{app}\"\n\
         \x20 set frontmost of p to true\n\
         \x20 try\n\
         \x20   perform action \"AXRaise\" of (first window of p whose name contains \"{title}\")\n\
         \x20 end try\n\
         end tell",
    );
    osascript(&script).map(|_| ())
}

/// Move the cursor.
pub fn move_to(x: f64, y: f64) -> Result<(), String> {
    post_mouse(x, y, MousePhase::Move, Button::Left)
}

/// Click once (or twice) at a point, in global points.
pub fn click_at(x: f64, y: f64, button: Button, count: u32) -> Result<(), String> {
    for i in 0..count.max(1) {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(DOUBLE_CLICK_GAP_MS));
        }
        post_mouse(x, y, MousePhase::Down, button)?;
        std::thread::sleep(std::time::Duration::from_millis(CLICK_HOLD_MS));
        post_mouse(x, y, MousePhase::Up, button)?;
    }
    Ok(())
}

/// Press, glide and release — the one gesture System Events cannot express.
pub fn drag(from: (f64, f64), to: (f64, f64), button: Button) -> Result<(), String> {
    post_mouse(from.0, from.1, MousePhase::Move, button)?;
    post_mouse(from.0, from.1, MousePhase::Down, button)?;
    // Intermediate points matter: a single jump reads as a teleport and drag
    // targets (sliders, reorder handles, canvas tools) drop the gesture.
    for step in 1..=DRAG_STEPS {
        let t = step as f64 / DRAG_STEPS as f64;
        let x = from.0 + (to.0 - from.0) * t;
        let y = from.1 + (to.1 - from.1) * t;
        post_mouse(x, y, MousePhase::Drag, button)?;
        std::thread::sleep(std::time::Duration::from_millis(DRAG_STEP_MS));
    }
    post_mouse(to.0, to.1, MousePhase::Up, button)
}

/// Scroll the wheel under the cursor. Negative scrolls up.
pub fn scroll(lines: i32) -> Result<(), String> {
    let steps = lines.unsigned_abs().min(MAX_SCROLL_STEPS as u32) as i32;
    let direction = if lines < 0 { 1 } else { -1 };
    for _ in 0..steps {
        post_scroll(direction)?;
        std::thread::sleep(std::time::Duration::from_millis(SCROLL_STEP_MS));
    }
    Ok(())
}

/// Press and release one virtual key code.
#[cfg(target_os = "macos")]
pub fn press_key(code: u16) -> Result<(), String> {
    let source = event_source()?;
    for down in [true, false] {
        core_graphics::event::CGEvent::new_keyboard_event(source.clone(), code, down)
            .map_err(|_| format!("cannot create a keyboard event for key code {code}"))?
            .post(core_graphics::event::CGEventTapLocation::HID);
    }
    Ok(())
}

/// Run one `osascript` snippet, returning its stdout or a readable error.
pub fn osascript(script: &str) -> Result<String, String> {
    let out = std::process::Command::new("osascript")
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

/// A point named by `x`/`y` in a tool call, or `None` when either is absent.
pub fn point_arg(args: &Value, x: &str, y: &str) -> Option<(f64, f64)> {
    let x = args.get(x).and_then(Value::as_f64)?;
    let y = args.get(y).and_then(Value::as_f64)?;
    Some((x, y))
}

// --- tunables ---------------------------------------------------------------

/// Gap between the two clicks of a double click. Below ~40ms macOS does not
/// pair them, above ~150ms it sees two single clicks.
const DOUBLE_CLICK_GAP_MS: u64 = 80;
/// How long a synthetic button stays down between press and release.
const CLICK_HOLD_MS: u64 = 25;
/// Steps a drag is interpolated into.
const DRAG_STEPS: u32 = 12;
const DRAG_STEP_MS: u64 = 12;
const SCROLL_STEP_MS: u64 = 8;
/// Wheel lines one `scroll` action may send, matching the old key-press cap.
const MAX_SCROLL_STEPS: usize = 50;

// --- macOS implementation ---------------------------------------------------

#[cfg(target_os = "macos")]
enum MousePhase {
    Move,
    Down,
    Up,
    Drag,
}

#[cfg(target_os = "macos")]
fn event_source() -> Result<core_graphics::event_source::CGEventSource, String> {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "cannot create a CoreGraphics event source".to_string())
}

#[cfg(target_os = "macos")]
fn post_mouse(x: f64, y: f64, phase: MousePhase, button: Button) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton};
    use core_graphics::geometry::CGPoint;

    let (kind, cg_button) = match (phase, button) {
        (MousePhase::Move, _) => (CGEventType::MouseMoved, CGMouseButton::Left),
        (MousePhase::Drag, Button::Right) => (CGEventType::RightMouseDragged, CGMouseButton::Right),
        (MousePhase::Drag, Button::Left) => (CGEventType::LeftMouseDragged, CGMouseButton::Left),
        (MousePhase::Down, Button::Right) => (CGEventType::RightMouseDown, CGMouseButton::Right),
        (MousePhase::Down, Button::Left) => (CGEventType::LeftMouseDown, CGMouseButton::Left),
        (MousePhase::Up, Button::Right) => (CGEventType::RightMouseUp, CGMouseButton::Right),
        (MousePhase::Up, Button::Left) => (CGEventType::LeftMouseUp, CGMouseButton::Left),
    };
    let source = event_source()?;
    CGEvent::new_mouse_event(source, kind, CGPoint { x, y }, cg_button)
        .map_err(|_| "cannot create a mouse event".to_string())?
        .post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "macos")]
fn post_scroll(direction: i32) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventTapLocation, ScrollEventUnit};
    let source = event_source()?;
    CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 1, direction, 0, 0)
        .map_err(|_| "cannot create a scroll event".to_string())?
        .post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_cursor_point() -> Option<(f64, f64)> {
    let source = event_source().ok()?;
    let event = core_graphics::event::CGEvent::new(source).ok()?;
    let p = event.location();
    Some((p.x, p.y))
}

#[cfg(target_os = "macos")]
fn preflight_screen_capture() -> bool {
    core_graphics::access::ScreenCaptureAccess.preflight()
}

#[cfg(target_os = "macos")]
fn request_screen_capture() -> bool {
    core_graphics::access::ScreenCaptureAccess.request()
}

#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Carbon `Boolean` is an `unsigned char`, not a Rust `bool`.
        fn AXIsProcessTrusted() -> u8;
    }
    unsafe { AXIsProcessTrusted() != 0 }
}

// --- other platforms --------------------------------------------------------
//
// The app still builds (and `computer` still answers) away from macOS; only the
// desktop primitives report that they need it. Screen/window listing keeps
// working through System Events where that exists.

#[cfg(not(target_os = "macos"))]
enum MousePhase {
    Move,
    Down,
    Up,
    Drag,
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> String {
    "desktop input needs macOS (CoreGraphics event injection)".to_string()
}

#[cfg(not(target_os = "macos"))]
fn post_mouse(
    _x: f64,
    _y: f64,
    _phase: MousePhase,
    _button: Button,
) -> Result<(), String> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn post_scroll(_direction: i32) -> Result<(), String> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
pub fn press_key(_code: u16) -> Result<(), String> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn current_cursor_point() -> Option<(f64, f64)> {
    None
}

#[cfg(not(target_os = "macos"))]
fn preflight_screen_capture() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn request_screen_capture() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn accessibility_trusted() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_literal_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_literal(r#"a"b\c"#), r#"a\"b\\c"#);
    }

    #[test]
    fn windows_parser_keeps_only_real_windows() {
        // Third row has a bogus size (menu bar item) and must be dropped; the
        // last row is truncated and must not panic.
        let raw = "Finder\ttabs\t10\t20\t800\t600\nSafari\tDocs\t0\t0\t1440\t900\n\
                   SystemUIServer\t\t0\t-22\t1440\t22\nSafari\tbroken\t5\n";
        let got = parse_windows(raw);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].app, "Finder");
        assert_eq!(got[0].width, 800.0);
        assert_eq!(got[1].title, "Docs");
    }

    #[test]
    fn display_at_matches_the_display_holding_the_point() {
        let screens = [
            Display { x: 0, y: 0, width: 1440, height: 900, scale: 1.0, primary: true },
            Display { x: 1440, y: 0, width: 1920, height: 1080, scale: 2.0, primary: false },
        ];
        assert_eq!(display_at(&screens, 100.0, 100.0), Some(0));
        assert_eq!(display_at(&screens, 1500.0, 500.0), Some(1));
        // The right edge is exclusive: 2880 belongs to no display.
        assert_eq!(display_at(&screens, 3400.0, 500.0), None);
    }
}
