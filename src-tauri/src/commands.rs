//! Tauri commands mirroring the Electron preload API (window.coder).
//!
//! Each command maps 1:1 to an ipcMain.handle channel in electron/main.ts so
//! the renderer's tauriBridge shim can expose the exact same surface.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::sidecar;
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
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Ok(root_real);
    }
    let candidate = root_real.join(rel);
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
    Ok(anchor_real.join(candidate.strip_prefix(&anchor).unwrap_or(&candidate)))
}

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

pub fn skip_dirs() -> HashSet<&'static str> {
    HashSet::from([
        "node_modules", ".git", ".venv", "venv", "__pycache__", ".next",
        ".nuxt", "dist", "dist-electron", "release", "build", "coverage",
        ".cache", ".idea", ".vscode", ".DS_Store", "target", "vendor",
        ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".github",
        ".playwright", ".playwright-mcp", "out", "bin", "obj",
    ])
}

#[tauri::command]
pub fn fs_list(root: String, rel: String) -> Vec<FileEntry> {
    let root = PathBuf::from(&root);
    if !root.exists() {
        return vec![];
    }
    let Ok(target) = resolve_safe(&root, &rel) else {
        return vec![];
    };
    let Ok(rd) = std::fs::read_dir(&target) else {
        return vec![];
    };
    let skip = skip_dirs();
    let mut entries: Vec<FileEntry> = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let md = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if md.is_dir() && skip.contains(name.as_str()) {
            continue;
        }
        if md.is_file() && name == ".DS_Store" {
            continue;
        }
        let kind = if md.is_symlink() {
            "link"
        } else if md.is_dir() {
            "dir"
        } else {
            "file"
        };
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        entries.push(FileEntry { name, kind: kind.into(), path });
    }
    entries.sort_by(|a, b| {
        b.kind.cmp(&a.kind).then_with(|| a.name.cmp(&b.name))
    });
    entries
}

const MAX_WALK_FILES: usize = 50_000;

#[tauri::command]
pub fn fs_walk(root: String) -> Vec<FileEntry> {
    let root = PathBuf::from(&root);
    if !root.exists() {
        return vec![];
    }
    let skip = skip_dirs();
    let mut out: Vec<FileEntry> = vec![];
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_WALK_FILES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            if out.len() >= MAX_WALK_FILES {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let full = e.path();
            if ft.is_dir() {
                if !skip.contains(name.as_str()) {
                    stack.push(full);
                }
            } else if ft.is_file() && name != ".DS_Store" {
                let Ok(rel) = full.strip_prefix(&root) else { continue };
                out.push(FileEntry {
                    name,
                    kind: "file".into(),
                    path: rel.to_string_lossy().replace('\\', "/"),
                });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[tauri::command]
pub fn fs_read(root: String, rel: String) -> Result<Option<serde_json::Value>, String> {
    let target = resolve_safe(Path::new(&root), &rel)?;
    if !target.exists() {
        return Ok(None);
    }
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    let content = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({ "content": content })))
}

#[tauri::command]
pub fn fs_write(root: String, rel: String, content: String) -> Result<bool, String> {
    let target = resolve_safe(Path::new(&root), &rel)?;
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn fs_delete(root: String, rel: String) -> bool {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return false;
    }
    let Ok(target) = resolve_safe(Path::new(&root), &rel) else {
        return false;
    };
    let Ok(root_real) = Path::new(&root).canonicalize() else {
        return false;
    };
    if target == root_real {
        return false; // never delete the root itself
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).is_ok()
    } else {
        std::fs::remove_file(&target).is_ok()
    }
}

// --- data-root file access (skills / mcp / plans) ---------------------------

#[tauri::command]
pub fn coder_list(app: AppHandle, rel: String) -> Vec<FileEntry> {
    let Ok(target) = resolve_coder_safe(&app, &rel) else {
        return vec![];
    };
    let Ok(rd) = std::fs::read_dir(&target) else {
        return vec![];
    };
    let mut entries: Vec<FileEntry> = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let kind = if ft.is_symlink() {
            "link"
        } else if ft.is_dir() {
            "dir"
        } else {
            "file"
        };
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel.trim().trim_start_matches('/'), name)
        };
        entries.push(FileEntry { name, kind: kind.into(), path });
    }
    entries.sort_by(|a, b| b.kind.cmp(&a.kind).then_with(|| a.name.cmp(&b.name)));
    entries
}

#[tauri::command]
pub fn coder_read(app: AppHandle, rel: String) -> Result<Option<serde_json::Value>, String> {
    let target = resolve_coder_safe(&app, &rel)?;
    if !target.exists() {
        return Ok(None);
    }
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    let content = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({ "content": content })))
}

#[tauri::command]
pub fn coder_write(app: AppHandle, rel: String, content: String) -> Result<bool, String> {
    let target = resolve_coder_safe(&app, &rel)?;
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn coder_delete(app: AppHandle, rel: String) -> bool {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return false;
    }
    let Ok(target) = resolve_coder_safe(&app, &rel) else {
        return false;
    };
    let base = state::get_data_root(&app);
    if target == base {
        return false;
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).is_ok()
    } else {
        std::fs::remove_file(&target).is_ok()
    }
}

// --- content search (ripgrep fast path + JS-parity fallback) ----------------

fn text_extensions() -> HashSet<&'static str> {
    HashSet::from([
        ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".yaml", ".yml",
        ".toml", ".md", ".mdx", ".txt", ".html", ".css", ".scss", ".less", ".vue",
        ".svelte", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".java",
        ".kt", ".swift", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql",
        ".xml", ".ini", ".cfg", ".conf", ".env", ".csv", ".tsv", ".gitignore",
    ])
}

const MAX_SEARCH_MATCHES: usize = 200;
const MAX_SEARCH_BYTES: u64 = 2_000_000;

#[tauri::command]
pub fn search_content(root: String, query: String) -> Vec<SearchMatch> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return vec![];
    }
    let root = PathBuf::from(&root);
    if !root.exists() {
        return vec![];
    }
    if let Some(matches) = rg_search(&root, &q) {
        return matches;
    }
    fallback_search(&root, &q)
}

fn rg_search(root: &Path, query: &str) -> Option<Vec<SearchMatch>> {
    let skip = skip_dirs();
    let mut args: Vec<String> = vec![
        "--json".into(), "-i".into(), "-F".into(), "--no-ignore".into(),
        "--hidden".into(), "--color".into(), "never".into(),
        "--max-filesize".into(), MAX_SEARCH_BYTES.to_string(),
    ];
    for ext in text_extensions() {
        args.push("-g".into());
        args.push(format!("**/*{ext}"));
    }
    for d in &skip {
        args.push("-g".into());
        args.push(format!("!**/{d}/**"));
        args.push("-g".into());
        args.push(format!("!**/{d}"));
    }
    args.push("-e".into());
    args.push(query.into());
    args.push(".".into());
    let out = std::process::Command::new("rg")
        .args(&args)
        .current_dir(root)
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut matches: Vec<SearchMatch> = vec![];
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if obj.get("type").and_then(|t| t.as_str()) == Some("match") {
            let data = obj.get("data")?;
            matches.push(SearchMatch {
                file: data
                    .pointer("/path/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .replace('\\', "/")
                    .trim_start_matches("./")
                    .to_string(),
                line: data.get("line_number").and_then(|v| v.as_u64()).unwrap_or(0),
                text: data
                    .pointer("/lines/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim_end_matches('\n')
                    .chars()
                    .take(300)
                    .collect(),
            });
            if matches.len() >= MAX_SEARCH_MATCHES {
                break;
            }
        }
    }
    Some(matches)
}

fn fallback_search(root: &Path, query: &str) -> Vec<SearchMatch> {
    let q = query.to_lowercase();
    let exts = text_extensions();
    let skip = skip_dirs();
    let mut matches: Vec<SearchMatch> = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if matches.len() >= MAX_SEARCH_MATCHES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if matches.len() >= MAX_SEARCH_MATCHES {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let full = e.path();
            if ft.is_dir() {
                if !skip.contains(name.as_str()) {
                    stack.push(full);
                }
                continue;
            }
            let ext = full
                .extension()
                .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if !exts.contains(ext.as_str()) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.len() > MAX_SEARCH_BYTES {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&full) else { continue };
            for (i, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&q) {
                    let rel = full
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    matches.push(SearchMatch {
                        file: rel,
                        line: (i + 1) as u64,
                        text: line.chars().take(300).collect(),
                    });
                    if matches.len() >= MAX_SEARCH_MATCHES {
                        break;
                    }
                }
            }
        }
    }
    matches
}

// --- images -----------------------------------------------------------------

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

#[tauri::command]
pub fn read_image(abs_path: String) -> Option<String> {
    let p = PathBuf::from(&abs_path);
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    let mime = image_mime(&ext)?;
    let data = std::fs::read(&p).ok()?;
    if data.len() > 8 * 1024 * 1024 {
        return None;
    }
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

/// Normalize any attached image to a temp PNG (like screenshots), so formats
/// such as HEIC or oversized files reach the model regardless of source.
#[tauri::command]
pub fn normalize_image(abs_path: String) -> Option<serde_json::Value> {
    let img = image::open(&abs_path).ok()?;
    let max_dim = 2048u32;
    let img = if img.width() > max_dim || img.height() > max_dim {
        let scale = max_dim as f32 / img.width().max(img.height()) as f32;
        img.resize(
            (img.width() as f32 * scale) as u32,
            (img.height() as f32 * scale) as u32,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };
    let mut png: Vec<u8> = Vec::new();
    image::DynamicImage::write_to(&img, &mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    let tmp = std::env::temp_dir().join(format!(
        "coder-img-{}-{:x}.png",
        state::now_ms(),
        std::process::id()
    ));
    std::fs::write(&tmp, &png).ok()?;
    Some(serde_json::json!({
        "path": tmp.to_string_lossy(),
        "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)),
    }))
}

// --- screen capture ---------------------------------------------------------

#[tauri::command]
pub fn capture_screen() -> Option<serde_json::Value> {
    let shots = screenshots::Screen::all().ok()?;
    let screen = shots.into_iter().next()?;
    let shot = screen.capture().ok()?;
    let mut png: Vec<u8> = Vec::new();
    let dyn_img = image::DynamicImage::from(
        image::RgbaImage::from_raw(shot.width(), shot.height(), shot.into_raw())?,
    );
    dyn_img
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    let tmp = std::env::temp_dir().join(format!("coder-shot-{}.png", state::now_ms()));
    std::fs::write(&tmp, &png).ok()?;
    Some(serde_json::json!({
        "path": tmp.to_string_lossy(),
        "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)),
    }))
}

/// Capture a user-selected region: a fullscreen overlay window shows the
/// screenshot; the user drags a rectangle which is cropped out of the shot.
#[tauri::command]
pub fn capture_region(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    use tauri::PhysicalPosition;
    let _ = PhysicalPosition { x: 0.0, y: 0.0 }; // keep import for future DIP math
    let shots = screenshots::Screen::all().map_err(|e| e.to_string())?;
    let screen = shots.into_iter().next().ok_or("no screen")?;
    let full = screen.capture().map_err(|e| e.to_string())?;
    let mut png: Vec<u8> = Vec::new();
    let dyn_full = image::DynamicImage::from(
        image::RgbaImage::from_raw(full.width(), full.height(), full.clone().into_raw())
            .ok_or("capture decode failed")?,
    );
    dyn_full
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );

    // Show the overlay window fullscreen and let the renderer pick the rect.
    let overlay = tauri::WebviewWindowBuilder::new(
        &app,
        "capture-overlay",
        tauri::WebviewUrl::App("capture.html".into()),
    )
    .title("Capture")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = overlay.set_fullscreen(true);
    let _ = window.set_focus();
    let _ = data_url; // reserved for the overlay page background

    // The overlay page emits `overlay:selected` with the rect (DIP coords) or
    // `overlay:cancel`. Wait bounded (2 min like Electron).
    let (tx, rx) = std::sync::mpsc::channel::<Option<(f64, f64, f64, f64)>>();
    {
        let tx_sel = tx.clone();
        let _ = app.listen("overlay:selected", move |evt| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(evt.payload()) {
                let g = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                let _ = tx_sel.send(Some((g("x"), g("y"), g("width"), g("height"))));
            }
        });
        let _ = app.listen("overlay:cancel", move |_evt| {
            let _ = tx.send(None);
        });
    }
    let rect = rx
        .recv_timeout(std::time::Duration::from_secs(120))
        .ok()
        .flatten();
    let _ = overlay.close();

    let Some((x, y, w, h)) = rect else {
        return Ok(None);
    };
    // Crop in physical pixels (the shot is device-resolution).
    let scale = 1.0f64; // screenshots crate returns physical pixels; overlay uses DIP
    let clamp = |v: f64, max: i64| -> i64 { (v.round() as i64).clamp(0, max) };
    let sx = clamp(x * scale, full.width() as i64);
    let sy = clamp(y * scale, full.height() as i64);
    let sw = clamp(w * scale, full.width() as i64 - sx);
    let sh = clamp(h * scale, full.height() as i64 - sy);
    if sw <= 0 || sh <= 0 {
        return Ok(None);
    }
    let cropped = dyn_full.crop_imm(sx as u32, sy as u32, sw as u32, sh as u32);
    let mut cropped_png: Vec<u8> = Vec::new();
    cropped
        .write_to(&mut std::io::Cursor::new(&mut cropped_png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join(format!("coder-shot-{}.png", state::now_ms()));
    std::fs::write(&tmp, &cropped_png).map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({
        "path": tmp.to_string_lossy(),
        "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(cropped_png)),
    })))
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
    // Restart the sidecar against the new root and tell the renderer.
    sidecar::stop_sidecar(&app, 5000);
    sidecar::start_sidecar(&app).map_err(|e| format!("sidecar restart after data move failed: {e}"))?;
    let _ = app.emit("sidecar:changed", ());
    Ok(moved.to_string_lossy().into_owned())
}

// --- sidecar ----------------------------------------------------------------

#[tauri::command]
pub fn sidecar_url(app: AppHandle) -> Option<String> {
    // The renderer always talks to the PUBLIC router port (phase 2): native
    // light endpoints are served there and everything else is proxied to the
    // Python sidecar on its private port.
    if let Some(public) = crate::backend_light::public_url() {
        return Some(public);
    }
    match sidecar::start_sidecar(&app) {
        Ok(_private_url) => crate::backend_light::public_url(),
        // Surface the failure on the app log — swallowing it here made
        // "Python agent not ready" undiagnosable in packaged builds.
        Err(e) => {
            eprintln!("[sidecar] sidecar_url failed: {e}");
            None
        }
    }
}

#[tauri::command]
pub fn sidecar_probe(app: AppHandle) -> bool {
    sidecar::probe_sidecar(&app)
}

// --- secrets ----------------------------------------------------------------

#[tauri::command]
pub fn secrets_get_key(app: AppHandle) -> String {
    crate::secrets::get_secrets_key(&app)
}

// --- open external ----------------------------------------------------------

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        open::that_detached(&url).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn open_external_chrome(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let ok = std::process::Command::new("open")
            .args(["-a", "Google Chrome", &url])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let roots = [
            std::env::var("PROGRAMFILES").ok(),
            std::env::var("PROGRAMW6432").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];
        for root in roots.into_iter().flatten() {
            let exe = PathBuf::from(root)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe");
            if exe.exists() {
                if std::process::Command::new(&exe)
                    .arg(&url)
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for bin in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
            if std::process::Command::new(bin)
                .arg(&url)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file_external(
    app: AppHandle,
    abs_path: String,
    editor: String,
) -> OpResult {
    let abs = PathBuf::from(abs_path.trim());
    if !abs.is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    match editor.as_str() {
        "default" => {
            // Office documents open in the OS-associated app.
            #[cfg(target_os = "macos")]
            {
                let lower = abs.to_string_lossy().to_lowercase();
                let s = lower.as_str();
                let app_name = if s.ends_with(".doc") || s.ends_with(".docx") {
                    Some("Microsoft Word")
                } else if s.ends_with(".xls") || s.ends_with(".xlsx") || s.ends_with(".xlsm") {
                    Some("Microsoft Excel")
                } else {
                    None
                };
                if let Some(name) = app_name {
                    let ok = std::process::Command::new("open")
                        .args(["-a", name])
                        .arg(&abs)
                        .status()
                        .map(|st| st.success())
                        .unwrap_or(false);
                    if ok {
                        return OpResult::ok();
                    }
                }
            }
            match open::that(&abs) {
                Ok(_) => OpResult::ok(),
                Err(e) => OpResult::err(e.to_string()),
            }
        }
        "vscode" => {
            // 1) `code` CLI on PATH.
            if spawn_detached("code", &[&abs.to_string_lossy()]) {
                return OpResult::ok();
            }
            // 2) The CLI inside well-known bundles (macOS).
            #[cfg(target_os = "macos")]
            {
                let home = dirs::home_dir().unwrap_or_default();
                for base in [PathBuf::from("/Applications"), home.join("Applications")] {
                    for name in [
                        "Visual Studio Code.app",
                        "Visual Studio Code - Insiders.app",
                    ] {
                        let cli = base
                            .join(name)
                            .join("Contents/Resources/app/bin/code");
                        if cli.exists()
                            && spawn_detached(&cli.to_string_lossy(), &[&abs.to_string_lossy()])
                        {
                            return OpResult::ok();
                        }
                    }
                }
                for args in [
                    vec!["-b", "com.microsoft.VSCode"],
                    vec!["-b", "com.microsoft.VSCode.Insiders"],
                    vec!["-a", "Visual Studio Code"],
                ] {
                    let mut cmd = std::process::Command::new("open");
                    cmd.args(&args).arg(&abs);
                    if cmd.status().map(|st| st.success()).unwrap_or(false) {
                        return OpResult::ok();
                    }
                }
            }
            // 3) The registered vscode:// handler.
            let url = format!("vscode://file{}", abs.to_string_lossy());
            if open::that_detached(&url).is_ok() {
                return OpResult::ok();
            }
            OpResult::err("Could not open VS Code — is it installed?")
        }
        "nvim" => {
            // Try a running nvim instance over its RPC socket, then a terminal.
            if open_in_running_nvim(&abs.to_string_lossy()) {
                return OpResult::ok();
            }
            let dir = abs.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            if launch_terminal(&["nvim".into(), abs.to_string_lossy().into_owned()], &dir) {
                return OpResult::ok();
            }
            OpResult::err("No running Neovim instance and no terminal found.")
        }
        other => OpResult::err(format!("Unknown editor: {other}")),
    }
    .pipe_result(&app)
}

impl OpResult {
    fn pipe_result(self, _app: &AppHandle) -> OpResult {
        self
    }
}

fn spawn_detached(bin: &str, args: &[&str]) -> bool {
    std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

/// `:edit` the file in the first running nvim instance over its RPC socket.
fn open_in_running_nvim(abs: &str) -> bool {
    let expr = format!("execute('edit ' . fnameescape('{}'))", abs.replace('\'', "''"));
    for sock in find_nvim_sockets() {
        let out = std::process::Command::new("nvim")
            .args(["--server", &sock, "--remote-expr", &expr])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                return true;
            }
        }
    }
    false
}

/// Unix sockets listening for nvim RPC, discovered by globbing nvim's socket
/// dirs (pid-liveness filtered).
fn find_nvim_sockets() -> Vec<String> {
    let mut found: Vec<String> = vec![];
    if let Ok(env_sock) = std::env::var("NVIM_LISTEN_ADDRESS") {
        let p = env_sock.replacen('~', &dirs::home_dir().unwrap_or_default().to_string_lossy(), 1);
        if p.starts_with('/') && Path::new(&p).exists() {
            found.push(p);
        } else if p.contains(':') {
            found.push(p);
        }
    }
    let mut roots: Vec<PathBuf> = vec![];
    if let Ok(tmp) = std::env::temp_dir().read_dir() {
        for e in tmp.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("nvim") {
                roots.push(e.path());
            }
        }
    }
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        roots.push(PathBuf::from(xdg).join("nvim"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library/Caches/nvim"));
    }
    for root in roots {
        walk_nvim_socket_dir(&root, 0, &mut found);
    }
    found.sort();
    found.dedup();
    found
}

fn walk_nvim_socket_dir(dir: &Path, depth: usize, acc: &mut Vec<String>) {
    if depth > 5 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let full = e.path();
        if full.is_dir() {
            walk_nvim_socket_dir(&full, depth + 1, acc);
            continue;
        }
        let leaf = e.file_name().to_string_lossy().into_owned();
        let pid: Option<u32> = if let Some(rest) = leaf.strip_prefix("nvim.").and_then(|r| r.strip_suffix(".0")) {
            rest.parse().ok()
        } else if leaf == "0" {
            full.parent()
                .and_then(|p| p.file_name())
                .and_then(|p| p.to_string_lossy().parse().ok())
        } else {
            None
        };
        let Some(pid) = pid else { continue };
        if pid_alive(pid) && full.exists() {
            acc.push(full.to_string_lossy().into_owned());
        }
    }
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Launch a platform terminal at `cwd`, optionally running `argv` inside it.
fn launch_terminal(argv: &[String], cwd: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        if argv.is_empty() {
            return std::process::Command::new("open")
                .args(["-a", "Terminal"])
                .arg(cwd)
                .spawn()
                .is_ok();
        }
        let q = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
        let shell_cmd = format!(
            "cd {} && {}",
            q(&cwd.to_string_lossy()),
            argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")
        );
        let as_escaped = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
        return std::process::Command::new("osascript")
            .args(["-e", &format!("tell application \"Terminal\" to do script \"{as_escaped}\"")])
            .status()
            .map(|st| st.success())
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "start", "cmd", "/k"]).args(argv).current_dir(cwd);
        return cmd.spawn().is_ok();
    }
    #[cfg(target_os = "linux")]
    {
        let exec_args: Vec<String> = argv.to_vec();
        let mut tries: Vec<(String, Vec<String>)> = vec![];
        if let Ok(t) = std::env::var("TERMINAL") {
            tries.push((t, exec_args.clone()));
        }
        let mut gnome = vec!["--working-directory".into(), cwd.to_string_lossy().into_owned()];
        if !exec_args.is_empty() {
            gnome.push("--".into());
            gnome.extend(exec_args.clone());
        }
        tries.push(("gnome-terminal".into(), gnome));
        let mut konsole = vec!["--workdir".into(), cwd.to_string_lossy().into_owned()];
        if !exec_args.is_empty() {
            konsole.push("-e".into());
            konsole.extend(exec_args.clone());
        }
        tries.push(("konsole".into(), konsole));
        tries.push(("x-terminal-emulator".into(), exec_args.clone()));
        tries.push(("kitty".into(), exec_args.clone()));
        let mut alacritty = vec![];
        if !exec_args.is_empty() {
            alacritty.push("-e".into());
            alacritty.extend(exec_args.clone());
        }
        tries.push(("alacritty".into(), alacritty));
        tries.push(("xterm".into(), exec_args));
        for (bin, args) in tries {
            if std::process::Command::new(&bin)
                .args(&args)
                .current_dir(cwd)
                .spawn()
                .is_ok()
            {
                return true;
            }
        }
        false
    }
}

#[tauri::command]
pub fn open_workspace_folder(dir: String) -> OpResult {
    let d = dir.trim();
    if !Path::new(d).is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    match open::that(d) {
        Ok(_) => OpResult::ok(),
        Err(e) => OpResult::err(e.to_string()),
    }
}

#[tauri::command]
pub fn open_workspace_terminal(dir: String) -> OpResult {
    let d = dir.trim();
    if !Path::new(d).is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    if launch_terminal(&[], Path::new(d)) {
        OpResult::ok()
    } else {
        OpResult::err("No supported terminal found.")
    }
}

// --- Google OAuth (sidecar-backed, mirrors electron/main.ts oauth:google) ---

#[tauri::command]
pub async fn google_sign_in(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    scope: Option<String>,
) -> Result<serde_json::Value, String> {
    let cid = client_id.trim().to_string();
    if cid.is_empty() {
        return Err("missing Google OAuth client id".into());
    }
    let sidecar_url = match sidecar::start_sidecar(&app) {
        Ok(url) => url,
        Err(_) => return Err("Python agent not ready — run `npm run setup`".into()),
    };
    let client = reqwest::Client::new();
    let start = client
        .post(format!("{sidecar_url}/oauth/google/start"))
        .json(&serde_json::json!({
            "client_id": cid,
            "client_secret": client_secret.trim(),
            "scope": scope.unwrap_or_default().trim().to_string(),
        }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !start.status().is_success() {
        let body: serde_json::Value = start.json().await.unwrap_or_default();
        return Err(body
            .get("detail")
            .and_then(|d| d.as_str())
            .unwrap_or("oauth start failed")
            .to_string());
    }
    let start_body: serde_json::Value = start.json().await.map_err(|e| e.to_string())?;
    let consent_url = start_body
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("oauth start returned no url")?;
    let state_token = start_body
        .get("state")
        .and_then(|s| s.as_str())
        .ok_or("oauth start returned no state")?;
    let _ = open::that_detached(consent_url);

    // Poll the sidecar for the completed exchange (5 min budget).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5 * 60);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(750));
        let res = client
            .get(format!(
                "{sidecar_url}/oauth/google/result?state={}",
                percent_encoding::utf8_percent_encode(state_token, percent_encoding::NON_ALPHANUMERIC)
            ))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .ok();
        let Some(res) = res else { continue };
        let status = res.status();
        let data: serde_json::Value = res.json().await.unwrap_or_default();
        if data.get("status").and_then(|s| s.as_str()) == Some("pending") {
            continue;
        }
        if !status.is_success() || data.get("status").and_then(|s| s.as_str()) == Some("error") {
            return Err(data
                .get("detail")
                .or_else(|| data.get("message"))
                .and_then(|d| d.as_str())
                .unwrap_or("Google sign-in failed")
                .to_string());
        }
        return Ok(serde_json::json!({
            "refreshToken": data.get("refresh_token").and_then(|v| v.as_str()).unwrap_or(""),
            "accessToken": data.get("access_token").and_then(|v| v.as_str()).unwrap_or(""),
            "expiresIn": data.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600),
        }));
    }
    Err("Google sign-in timed out".into())
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

#[tauri::command]
pub async fn select_file(app: AppHandle) -> Option<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<String>>>();
    app.dialog()
        .file()
        .set_title("Select files")
        .pick_files(move |paths| {
            let _ = tx.send(
                paths.map(|list| list.iter().map(|p| p.to_string()).collect()),
            );
        });
    rx.recv().ok().flatten()
}

// --- overlay region selection (called from the capture overlay page) --------

#[tauri::command]
pub fn overlay_selected(app: AppHandle, rect: serde_json::Value) {
    let _ = app.emit("overlay:selected", rect);
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    let _ = app.emit("overlay:cancel", ());
}

// --- quit flush handshake ---------------------------------------------------

#[tauri::command]
pub fn flush_persist_done(app: AppHandle) {
    let _ = app.emit("flush-persist-done-ack", ());
}

// --- updater (GitHub releases, mirrors electron/updater.ts) -----------------

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    #[serde(rename = "latestVersion")]
    pub latest_version: String,
    pub notes: String,
    #[serde(rename = "assetName")]
    pub asset_name: Option<String>,
    #[serde(rename = "assetUrl")]
    pub asset_url: Option<String>,
    #[serde(rename = "releaseUrl")]
    pub release_url: String,
}

const REPO: &str = "rhsaman/codifa";

fn parse_version(v: &str) -> Vec<u64> {
    v.trim_start_matches('v')
        .split('.')
        .map(|n| n.parse().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let a = parse_version(latest);
    let b = parse_version(current);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Pick the installer asset for the current platform (same ordering rules as
/// electron/updater-core.ts pickAsset).
fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String)> {
    let name = |a: &serde_json::Value| {
        a.get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_lowercase()
    };
    let url = |a: &serde_json::Value| {
        a.get("browser_download_url")
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let universal = |a: &serde_json::Value| name(a).contains("universal");
    if cfg!(target_os = "macos") {
        let find = |pred: &dyn Fn(&serde_json::Value) -> bool| {
            assets.iter().find(|a| pred(a)).map(|a| (name(a), url(a)))
        };
        return find(&|a| name(a).contains(&format!("-{arch}.dmg")))
            .or_else(|| find(&|a| universal(a) && name(a).ends_with(".dmg")))
            .or_else(|| find(&|a| name(a).contains(&format!("{arch}-mac.zip"))))
            .or_else(|| find(&|a| universal(a) && name(a).ends_with(".zip")))
            .or_else(|| find(&|a| name(a).ends_with(".dmg")))
            .or_else(|| find(&|a| name(a).ends_with("-mac.zip")));
    }
    if cfg!(target_os = "windows") {
        return assets
            .iter()
            .find(|a| name(a).ends_with(".exe") && (name(a).contains("setup") || name(a).contains("set up")))
            .or_else(|| assets.iter().find(|a| name(a).ends_with(".exe")))
            .map(|a| (name(a), url(a)));
    }
    if cfg!(target_os = "linux") {
        return assets
            .iter()
            .find(|a| name(a).ends_with(".appimage"))
            .map(|a| (name(a), url(a)));
    }
    None
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> UpdateInfo {
    let current_version = app.package_info().version.to_string();
    let empty = || UpdateInfo {
        available: false,
        current_version: current_version.clone(),
        latest_version: current_version.clone(),
        notes: String::new(),
        asset_name: None,
        asset_url: None,
        release_url: format!("https://github.com/{REPO}/releases/latest"),
    };
    let client = reqwest::Client::new();
    let res = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "codifa")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    let Ok(res) = res else { return empty() };
    if !res.status().is_success() {
        return empty();
    }
    let release: serde_json::Value = res.json().await.unwrap_or_default();
    let latest_version = release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    let assets = release.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let asset = pick_asset(&assets);
    UpdateInfo {
        available: is_newer(&latest_version, &current_version),
        current_version,
        latest_version: latest_version.clone(),
        notes: release.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
        asset_name: asset.as_ref().map(|(n, _)| n.clone()),
        asset_url: asset.as_ref().map(|(_, u)| u.clone()),
        release_url: release
            .get("html_url")
            .and_then(|u| u.as_str())
            .unwrap_or(&format!("https://github.com/{REPO}/releases/latest"))
            .to_string(),
    }
}

#[tauri::command]
pub async fn start_update(app: AppHandle, window: tauri::WebviewWindow) -> OpResult {
    let info = check_for_updates(app.clone()).await;
    let (Some(asset_url), Some(asset_name)) = (info.asset_url, info.asset_name) else {
        return OpResult::err("No update available");
    };
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("updates"),
        Err(e) => return OpResult::err(e.to_string()),
    };
    let _ = std::fs::create_dir_all(&dir);
    let dest = dir.join(&asset_name);
    let size_file = dir.join(format!("{asset_name}.size"));

    // Reuse a previously downloaded, size-verified installer.
    let expected: Option<u64> = std::fs::read_to_string(&size_file)
        .ok()
        .and_then(|s| s.trim().parse().ok());
    if dest.is_file() {
        if let (Ok(md), Some(exp)) = (std::fs::metadata(&dest), expected) {
            if md.len() == exp {
                let _ = window.emit("updater:progress", serde_json::json!({"phase": "installing", "percent": 100}));
                return install_asset(&dest);
            }
        }
    }

    let _ = window.emit("updater:progress", serde_json::json!({"phase": "downloading", "percent": 0}));
    let client = reqwest::Client::new();
    let res = match client
        .get(&asset_url)
        .header("User-Agent", "codifa")
        .timeout(std::time::Duration::from_secs(30 * 60))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return OpResult::err(e.to_string()),
    };
    if !res.status().is_success() {
        return OpResult::err(format!("Download failed (HTTP {})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut stream = res.bytes_stream();
    let mut chunks: Vec<u8> = vec![];
    use futures_util::StreamExt;
    let mut last_pct = 0u32;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return OpResult::err(e.to_string()),
        };
        chunks.extend_from_slice(&chunk);
        if total > 0 {
            let pct = ((chunks.len() as f64 / total as f64) * 100.0) as u32;
            if pct != last_pct {
                last_pct = pct.min(99);
                let _ = window.emit("updater:progress", serde_json::json!({"phase": "downloading", "percent": last_pct}));
            }
        }
    }
    if total > 0 && chunks.len() as u64 != total {
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_file(&size_file);
        return OpResult::err(format!(
            "Download incomplete: got {} of {} bytes — click Retry to download again",
            chunks.len(),
            total
        ));
    }
    if let Err(e) = std::fs::write(&dest, &chunks) {
        return OpResult::err(e.to_string());
    }
    if let Err(e) = std::fs::write(&size_file, chunks.len().to_string()) {
        return OpResult::err(e.to_string());
    }
    let _ = window.emit("updater:progress", serde_json::json!({"phase": "installing", "percent": 100}));
    install_asset(&dest)
}

/// Launch the downloaded installer for the current platform.
fn install_asset(dest: &Path) -> OpResult {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
        return match std::process::Command::new(dest)
            .env("APPIMAGE_EXTRACT_AND_RUN", "1")
            .spawn()
        {
            Ok(_) => OpResult::ok(),
            Err(e) => OpResult::err(e.to_string()),
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        match open::that(dest) {
            Ok(_) => OpResult::ok(),
            Err(e) => OpResult::err(e.to_string()),
        }
    }
}

// --- window drag region (macOS frameless) -----------------------------------

#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

// --- getPathForFile (drag & drop) -------------------------------------------

/// Tauri's drag-drop event already carries absolute file paths, so the
/// renderer bridge maps `getPathForFile` to the path recorded for the dropped
/// File object. This command is a no-op kept for API parity.
#[tauri::command]
pub fn get_path_for_file(_name: String) -> Option<String> {
    None
}

// --- unused-import guards ---------------------------------------------------

#[allow(dead_code)]
fn _read_guard(mut r: impl Read) {
    let mut buf = [0u8; 1];
    let _ = r.read(&mut buf);
}
