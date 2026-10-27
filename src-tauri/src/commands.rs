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
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-rs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Launching a program for the user must not leave a zombie behind.
    ///
    /// The `open`-style helpers only spawn; nothing waits. Three `<defunct>`
    /// children were still listed after eight hours of uptime. `reap_detached`
    /// must collect the exit status instead.
    #[test]
    fn a_detached_child_is_reaped() {
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("spawn");
        let pid = child.id();
        assert!(reap_detached(child));
        // The reaper runs on its own thread, so poll briefly: a reaped pid stops
        // existing, and `kill(pid, 0)` then fails with ESRCH.
        let mut reaped = false;
        for _ in 0..200 {
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                reaped = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(reaped, "pid {pid} was never reaped — it would show as <defunct>");
    }

    #[test]
    fn image_attachment_downscales_past_the_model_limit() {
        let big = image::DynamicImage::from(image::RgbaImage::new(IMAGE_MAX_DIM + 512, 64));
        let got = image_attachment(big, IMAGE_MAX_DIM).expect("attachment");
        let path = got["path"].as_str().expect("path").to_owned();
        assert!(got["dataUrl"].as_str().expect("dataUrl").starts_with("data:image/"));
        let decoded = image::open(&path).expect("decode");
        assert!(
            decoded.width() <= IMAGE_MAX_DIM && decoded.height() <= IMAGE_MAX_DIM,
            "{}x{}",
            decoded.width(),
            decoded.height()
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn resolve_safe_accepts_absolute_path_inside_root() {
        let root = temp_root("abs-in");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let file = root.join("sub/a.ts");
        std::fs::write(&file, "x").unwrap();
        let got = resolve_safe(&root, &file.to_string_lossy()).unwrap();
        assert_eq!(got, file.canonicalize().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_safe_rejects_absolute_path_outside_root() {
        let root = temp_root("abs-out");
        let outside = std::env::temp_dir().join(format!("codifa-rs-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let err = resolve_safe(&root, &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("escapes"), "{err}");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(&outside).ok();
    }

    #[test]
    fn resolve_safe_keeps_relative_paths_root_scoped() {
        let root = temp_root("rel");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        let got = resolve_safe(&root, "src/a.ts").unwrap();
        assert_eq!(got, root.join("src/a.ts").canonicalize().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fs_read_serves_relative_and_absolute_paths() {
        let root = temp_root("read");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/a.ts");
        std::fs::write(&file, "hello").unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let rel = fs_read(root_s.clone(), "src/a.ts".into()).unwrap().unwrap();
        assert_eq!(rel["content"].as_str(), Some("hello"));
        let abs = fs_read(root_s, file.to_string_lossy().into_owned())
            .unwrap()
            .unwrap();
        assert_eq!(abs["content"].as_str(), Some("hello"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_data_url_is_cached_and_re_reads_a_changed_file() {
        let root = temp_root("imgcache");
        let src = root.join("a.png");
        std::fs::write(&src, b"\x89PNG-one").unwrap();
        let path = src.to_string_lossy().into_owned();
        let first = image_data_url(&path).unwrap();
        // The agent re-reads the images of every turn's history; the second read
        // must not touch the disk again at all.
        assert_eq!(first, image_data_url(&path).unwrap(), "repeat read must hit the cache");
        // A changed file must never be served the stale entry. A different LENGTH
        // guarantees a different (mtime, len) key regardless of clock granularity.
        std::fs::write(&src, b"\x89PNG-two-longer").unwrap();
        let third = image_data_url(&path).unwrap();
        assert_ne!(first, third, "a changed file must be re-read");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_image_passes_a_small_png_through_untouched() {
        let root = temp_root("passthrough");
        let src = root.join("small.png");
        let img = image::RgbImage::from_pixel(16, 16, image::Rgb([10u8, 20, 30]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&src, image::ImageFormat::Png)
            .unwrap();
        let original = std::fs::read(&src).unwrap();
        let out = normalize_image(src.to_string_lossy().into_owned()).unwrap();
        // Nothing to encode: a readable format inside the size cap is copied
        // byte-for-byte, so re-encoding it only burned CPU for no gain.
        let path = out["path"].as_str().unwrap();
        assert_ne!(
            path,
            src.to_string_lossy(),
            "the image must be copied so the history keeps a stable path"
        );
        assert!(
            path.ends_with(".png"),
            "the copy must keep the original format: {path}"
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            original,
            "an already-valid small image must not be re-encoded"
        );
        let url = out["dataUrl"].as_str().unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(bytes, original, "the model must receive the ORIGINAL bytes");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_image_shrinks_to_the_cap_losslessly_and_never_grows() {
        let root = temp_root("shrink");
        let src = root.join("big.png");
        // A solid colour is the clearest losslessness probe: a LOSSY encoder
        // (JPEG-style) shifts the value, a lossless one returns it exactly.
        let color = image::Rgb([200u8, 60, 30]);
        let img = image::RgbImage::from_pixel(4096, 64, color);
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&src, image::ImageFormat::Png)
            .unwrap();

        let out = normalize_image(src.to_string_lossy().into_owned()).unwrap();
        let url = out["dataUrl"].as_str().unwrap();
        assert!(
            url.starts_with("data:image/webp;base64,") || url.starts_with("data:image/png;base64,"),
            "unexpected mime in {url}"
        );
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 2048, "must shrink to the largest edge cap");
        assert_eq!(decoded.height(), 32, "the aspect ratio must be preserved");
        assert_eq!(
            decoded.to_rgb8().get_pixel(5, 5),
            &color,
            "the encode must be LOSSLESS: the model must see the same pixels"
        );

        // Independently encoded PNG of the same resized image: the chosen bytes
        // may never exceed it, so making screenshots smaller can never make any
        // request bigger.
        let resized = image::open(&src)
            .unwrap()
            .resize(2048, 32, image::imageops::FilterType::Lanczos3);
        let mut png: Vec<u8> = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert!(
            bytes.len() <= png.len(),
            "the encode must not grow the payload: {} > {}",
            bytes.len(),
            png.len()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_mime_is_sniffed_from_the_bytes_not_the_name() {
        // A screenshot saved WITHOUT a suffix (or under the wrong one) used to be
        // dropped, because the extension was the only mime source.
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a"), Some("image/gif"));
        let mut webp = Vec::from(*b"RIFF____WEBP");
        assert_eq!(sniff_image_mime(&mut webp), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"not an image"), None);

        let root = temp_root("sniff");
        let src = root.join("screenshot"); // no extension at all
        image::DynamicImage::from(image::RgbImage::from_pixel(
            20,
            10,
            image::Rgb([9u8, 9, 9]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let url = image_data_url(&src.to_string_lossy()).expect("sniffed mime must read");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_cap_follows_the_provider_and_the_cache_keeps_both_sizes() {
        let root = temp_root("cap");
        let src = root.join("big.png");
        image::DynamicImage::from(image::RgbImage::from_pixel(
            3000,
            100,
            image::Rgb([30u8, 90, 200]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let path = src.to_string_lossy().into_owned();
        let anthropic = image_data_url_for(&path, "anthropic").expect("url");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(anthropic.split_once(',').unwrap().1)
            .unwrap();
        // Claude resizes to 1568 px before patching, so shipping more is upload
        // time for pixels the encoder never reads.
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1568);
        // The other cap must not be served the anthropic entry from the cache.
        let other = image_data_url_for(&path, "openai").expect("url");
        assert_ne!(other, anthropic, "the cap is part of the cache key");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_steps_sees_a_marker_path_and_nothing_for_a_text_file() {
        let root = temp_root("readimg");
        let src = root.join("shot.png");
        image::DynamicImage::from(image::RgbImage::from_pixel(
            8,
            8,
            image::Rgb([1u8, 2, 3]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let text = root.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();

        let note = image_read_note(&src.to_string_lossy()).expect("an image has a note");
        assert_eq!(image_read_path(&note).as_deref(), Some(src.to_string_lossy().as_ref()));
        assert!(note.contains("image/png"), "{note}");
        assert!(
            image_read_note(&text.to_string_lossy()).is_none(),
            "a text file must fall through to the normal window"
        );
        assert_eq!(image_read_path("plain text"), None);
        std::fs::remove_dir_all(&root).ok();
    }
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
        ".nuxt", "dist", "release", "build", "coverage",
        ".cache", ".idea", ".vscode", ".DS_Store", "target", "vendor",
        ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".github",
        ".playwright", ".playwright-mcp", "out", "bin", "obj",
    ])
}

#[tauri::command]
pub fn fs_list(root: String, rel: String) -> Vec<FileEntry> {
    // The renderer lists a workspace's files as soon as a chat/folder is opened
    // — the earliest point the backend learns which project is active. Starting
    // the language servers here moves the cold start (spawn + `initialize` +
    // crate-graph load) into the user's typing time instead of the first tool
    // call, which is what makes `lsp_*` fast instead of perpetually cold.
    crate::lsp::prewarm(&root);
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
    crate::lsp::prewarm(&root);
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

/// Copy a workspace file or folder to a new path. Used by the explorer's
/// right-click "Copy" (it pastes with a fresh name in the SAME folder), so a
/// folder copy must be recursive. Never overwrites: an existing destination is
/// an error instead of a silent data loss.
#[tauri::command]
pub fn fs_copy(root: String, from: String, to: String) -> Result<bool, String> {
    let src = resolve_safe(Path::new(&root), &from)?;
    let dst = resolve_safe(Path::new(&root), &to)?;
    if !src.exists() {
        return Err("path does not exist".into());
    }
    let Ok(root_real) = Path::new(&root).canonicalize() else {
        return Err("root missing".into());
    };
    if dst == root_real || src == dst {
        return Err("invalid destination".into());
    }
    if dst.exists() {
        return Err("destination already exists".into());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if src.is_dir() {
        crate::state::copy_tree(&src, &dst).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Rename (or move within the workspace) a file or folder: both paths resolve
/// through `resolve_safe`, so neither can leave the workspace root.
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> Result<bool, String> {
    let src = resolve_safe(Path::new(&root), &from)?;
    let dst = resolve_safe(Path::new(&root), &to)?;
    if !src.exists() {
        return Err("path does not exist".into());
    }
    let Ok(root_real) = Path::new(&root).canonicalize() else {
        return Err("root missing".into());
    };
    if src == root_real || dst == root_real || src == dst {
        return Err("invalid destination".into());
    }
    if dst.exists() {
        return Err("destination already exists".into());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(true)
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

/// Identify an image from its CONTENT (magic bytes) instead of its name.
///
/// The extension used to be the only source of the mime, so a screenshot pasted
/// from the clipboard (`blob`), an image whose suffix was stripped, or one saved
/// under the wrong name was silently dropped — `image_mime` returned `None` and
/// the picture never reached the model. The provider is told what the bytes
/// REALLY are, so a mislabelled file can no longer be rejected for its mime.
pub fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| data.starts_with(sig);
    if starts(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if starts(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("image/gif")
    } else if starts(b"BM") {
        Some("image/bmp")
    } else if data.len() >= 12 && starts(b"RIFF") && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.len() >= 12 && &data[4..8] == b"ftyp" && matches!(&data[8..12], b"avif" | b"avis") {
        Some("image/avif")
    } else {
        None
    }
}

/// Marker prefix of a `read` result that stands in for an image file.
///
/// The path follows on the SAME line (up to the first newline) so a path with
/// spaces in it survives the round trip; everything after is the description.
pub const IMAGE_READ_MARK: &str = "[image attached]";

/// A text stand-in for `read`ing an image file.
///
/// `read` answers with windowed TEXT and an image has none, so a screenshot in
/// the workspace used to come back as "file too large to read in one call" (or
/// as mojibake bytes). The marker carries the path instead, and the turn loop
/// turns that path into a real image block on the next request — the model sees
/// the picture rather than its file size.
///
/// Returns `None` for anything that is not a readable image, so the caller can
/// fall through to its normal text window.
pub fn image_read_note(abs_path: &str) -> Option<String> {
    let data = std::fs::read(abs_path).ok()?;
    if data.len() > IMAGE_READ_MAX_BYTES {
        return None;
    }
    let mime = sniff_image_mime(&data)?;
    let dims = match image::load_from_memory(&data) {
        Ok(img) => format!(", {}x{}", img.width(), img.height()),
        Err(_) => String::new(),
    };
    Some(format!(
        "{IMAGE_READ_MARK} {abs_path}\n{mime}{dims}. The picture itself is attached to this turn — look at it directly."
    ))
}

/// The image path carried by a `read` result, if it had one.
pub fn image_read_path(result: &str) -> Option<String> {
    let first = result.strip_prefix(IMAGE_READ_MARK)?;
    let path = first.lines().next()?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Cache of encoded image data URLs, keyed by `(downscale cap, absolute path)`.
///
/// The cap is part of the key because the same file is legitimately encoded at
/// two sizes (a full-size display copy and a model-bound copy).
///
/// A turn re-reads every image that is still in its history (the renderer sends
/// bare paths), so the same screenshot file was opened, base64-encoded and
/// shipped again on EVERY step — the vision pass and the main model both pay
/// that cost. The entry is validated against `(mtime, len)` so an edited file is
/// re-read, and the map is bounded so a long-running app cannot grow forever.
fn image_cache() -> &'static Mutex<HashMap<String, (u64, u64, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, u64, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How many encoded data URLs to keep. Each entry is one base64 image, so the
/// cap is deliberately small: it only has to cover the images of the chat being
/// worked on.
const IMAGE_CACHE_MAX: usize = 24;

#[tauri::command]
pub fn read_image(abs_path: String) -> Option<String> {
    image_data_url(&abs_path)
}

/// Whether macOS will let this build see the screen and inject input.
///
/// The renderer shows this next to the Computer Use switch: without Screen
/// Recording a capture silently comes back as a wallpaper with every other
/// app's windows missing, so the user has to be told BEFORE the agent takes a
/// look and reports an empty desktop.
#[tauri::command]
pub fn computer_permissions() -> serde_json::Value {
    serde_json::json!({
        "screen": crate::screen::screen_recording_allowed(),
        "accessibility": crate::screen::accessibility_allowed(),
        "identity": crate::screen::bundle_identity(),
    })
}

/// Put Codifa under Screen Recording in System Settings and return whether the
/// grant is already live.
///
/// macOS only ever shows its own prompt from the requesting API, and only a
/// fresh process picks the resulting grant up — so the renderer calls this when
/// the user presses Grant on the Computer Use card and re-checks afterwards
/// instead of demanding a restart.
#[tauri::command]
pub fn request_screen_recording() -> bool {
    crate::screen::request_screen_recording()
}

/// Read an image for a model whose provider IS known: the downscale cap follows
/// what that provider's vision encoder actually consumes (see `image_max_dim`).
pub fn image_data_url_for(abs_path: &str, provider: &str) -> Option<String> {
    image_data_url_capped(abs_path, image_max_dim(provider))
}

/// Read an image file and return it as a `data:<mime>;base64,…` URL.
///
/// Shared by the `read_image` Tauri command and the agent's image deserializer
/// (which turns a bare path from the renderer into bytes for the model). The
/// mime is sniffed from the BYTES and only falls back to the extension, so an
/// image whose name lost its suffix still reaches the model. Anything past the
/// cap is downscaled and re-encoded: these URLs are re-sent with EVERY turn of
/// the chat, so full-resolution pixels here are a repeated upload of detail no
/// vision encoder reads. Results are cached — see `image_cache`.
pub fn image_data_url(abs_path: &str) -> Option<String> {
    image_data_url_capped(abs_path, IMAGE_MAX_DIM)
}

fn image_data_url_capped(abs_path: &str, max_dim: u32) -> Option<String> {
    // The cap is part of the cache key: one file can be read at two sizes.
    let key = format!("{max_dim}:{abs_path}");
    let p = PathBuf::from(abs_path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let meta = std::fs::metadata(&p).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();
    if let Some(hit) = image_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if hit.0 == mtime && hit.1 == len {
            return Some(hit.2);
        }
    }
    let data = std::fs::read(&p).ok()?;
    if data.len() > IMAGE_READ_MAX_BYTES {
        return None;
    }
    let mime = sniff_image_mime(&data).or_else(|| image_mime(&ext))?;
    let url = match image::load_from_memory(&data) {
        Ok(img) if img.width() > max_dim || img.height() > max_dim => {
            let (bytes, mime) = encode_within_budget(&fit_within(img, max_dim), IMAGE_WIRE_BUDGET);
            data_url_of(&bytes, mime)
        }
        // Inside the cap already, or not decodable (a truncated file, a test
        // fixture): the original bytes go through untouched.
        _ => data_url_of(&data, mime),
    };
    if let Ok(mut c) = image_cache().lock() {
        if c.len() >= IMAGE_CACHE_MAX {
            // Drop an arbitrary older entry: any eviction is fine, the cache is
            // purely a round-trip saver and a miss simply re-reads the file.
            if let Some(k) = c.keys().next().cloned() {
                c.remove(&k);
            }
        }
        c.insert(key, (mtime, len, url.clone()));
    }
    Some(url)
}

/// Raw base64 of a PDF file, for the viewer's native PDF pane.
///
/// The renderer builds a `Blob` from this and hands the object URL to an
/// `<iframe>`: WKWebView renders PDFs itself, so no PDF rasterizer (pdfium/
/// mupdf, tens of MB of native code) has to be bundled just to show a page.
/// Capped so a huge PDF cannot balloon the JS heap — the file viewer shows an
/// error instead of hanging.
#[tauri::command]
pub fn read_pdf_base64(abs_path: String) -> Option<String> {
    const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
    let p = PathBuf::from(&abs_path);
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    if ext != "pdf" {
        return None;
    }
    let meta = std::fs::metadata(&p).ok()?;
    if meta.len() > MAX_PDF_BYTES {
        return None;
    }
    let data = std::fs::read(&p).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(data))
}

/// Largest edge an attached image is reduced to before it reaches a model.
/// Covers more than any vision model actually consumes, so this is not the
/// quality knob — the ENCODER is (see `encode_within_budget`).
const IMAGE_MAX_DIM: u32 = 2048;

/// Largest edge an image is reduced to when it is re-read from the chat history
/// on every following turn — the repeated upload is the expensive one.
///
/// Largest file we will read from disk at all. Beyond this the file is not a
/// screenshot or a photo but a mistake, and base64 of it would blow up the
/// request (base64 is 4/3 of the bytes, so 8 MiB becomes ~11 MiB on the wire).
const IMAGE_READ_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Wire-size ceiling for one encoded image before the lossless encoders are
/// abandoned for a lossy one (see `encode_within_budget`).
const IMAGE_WIRE_BUDGET: usize = 1_200_000;

/// Quality for the lossy fallback. Visually identical at model resolution, and
/// several times smaller than the lossless encode of the same pixels.
const IMAGE_LOSSY_QUALITY: u8 = 82;

/// Largest edge a provider's vision encoder actually consumes.
///
/// A longer edge is not extra detail: Anthropic's vision resizes to 1568 px on
/// the long edge before it even patches, so anything past that is paid for on
/// the wire and thrown away on arrival. OpenAI and Gemini take the larger size,
/// so the table is per-provider rather than one global cap.
fn image_max_dim(provider: &str) -> u32 {
    match provider {
        "anthropic" => 1568,
        _ => IMAGE_MAX_DIM,
    }
}

/// Downscale so the LONGEST edge is at most `max_dim`, keeping the aspect
/// ratio. A no-op for an image already inside the cap.
///
/// Both edges come from ONE scale and are applied with `resize_exact`: `resize`
/// re-fits the image inside the box it is handed, so truncating the SHORT edge
/// silently charged the long edge too — a 3000x100 strip capped at 1568 was
/// resized to a 1560x52 box and came out 1560 wide, i.e. the whole cap spent on
/// rounding. Screen captures are exactly this shape (a wide, short menu bar or
/// banner), so the loss was systematic, not a corner case.
fn fit_within(img: image::DynamicImage, max_dim: u32) -> image::DynamicImage {
    let longest = img.width().max(img.height());
    if longest <= max_dim {
        return img;
    }
    let scale = max_dim as f64 / longest as f64;
    let nw = ((img.width() as f64) * scale).round().max(1.0) as u32;
    let nh = ((img.height() as f64) * scale).round().max(1.0) as u32;
    img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
}

/// `data:<mime>;base64,…` for bytes that are already encoded.
fn data_url_of(bytes: &[u8], mime: &str) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Monotonic counter for temp image names (see `temp_image_path`).
static TEMP_IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// A fresh path in the temp dir for an image the model will be pointed at.
///
/// The counter guarantees uniqueness even for two images attached inside the
/// same millisecond (the previous name was `now_ms` + pid only, so a batched
/// multi-image attach could overwrite one file with another).
fn temp_image_path(ext: &str) -> PathBuf {
    let n = TEMP_IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "coder-img-{}-{:x}-{n}.{ext}",
        state::now_ms(),
        std::process::id()
    ))
}

/// Lossless WebP and PNG of the same pixels, whichever is smaller.
///
/// Screenshots are what people attach, and PNG puts such a flat, text-heavy
/// image on the wire at several megabytes of base64 — which the agent then
/// re-uploads with every step and every history turn. Lossless WebP (VP8L) is
/// byte-for-byte the same picture and usually 2-5x smaller, so the model sees
/// identical pixels for a fraction of the request size and upload time.
///
/// PNG is kept as the answer whenever it wins (already-small images, some
/// photographic inputs), so this can never make a request BIGGER.
fn encode_smallest_lossless(img: &image::DynamicImage) -> (Vec<u8>, &'static str) {
    let mut png: Vec<u8> = Vec::new();
    if image::DynamicImage::write_to(
        img,
        &mut std::io::Cursor::new(&mut png),
        image::ImageFormat::Png,
    )
    .is_err()
    {
        return (png, "image/png");
    }
    // The lossless encoder only takes Rgb8 / Rgba8; anything else (16-bit,
    // greyscale, palette) simply keeps the PNG we already produced.
    let (buf, width, height, color) = match img {
        image::DynamicImage::ImageRgba8(b) => {
            (b.as_raw().clone(), b.width(), b.height(), image::ExtendedColorType::Rgba8)
        }
        image::DynamicImage::ImageRgb8(b) => {
            (b.as_raw().clone(), b.width(), b.height(), image::ExtendedColorType::Rgb8)
        }
        _ => {
            let rgba = img.to_rgba8();
            (
                rgba.as_raw().clone(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
    };
    let mut webp: Vec<u8> = Vec::new();
    let encoded = image::codecs::webp::WebPEncoder::new_lossless(std::io::Cursor::new(&mut webp))
        .encode(&buf, width, height, color)
        .is_ok();
    if encoded && !webp.is_empty() && webp.len() < png.len() {
        (webp, "image/webp")
    } else {
        (png, "image/png")
    }
}

/// Encode for the wire: lossless first, lossy only when lossless misses the
/// budget.
///
/// Lossless WebP/PNG of a photographic attachment still lands in the megabytes
/// (a 5K screenshot stays ~1.5 MB however it is compressed), and that payload
/// is re-sent on every following turn. Past `budget` bytes the picture is
/// re-encoded as JPEG at `IMAGE_LOSSY_QUALITY`, which is visually identical at
/// model resolution and several times smaller. Something is ALWAYS returned: if
/// the lossy encoder fails or comes out bigger, the lossless bytes do, so this
/// can never lose an attachment.
fn encode_within_budget(img: &image::DynamicImage, budget: usize) -> (Vec<u8>, &'static str) {
    let (lossless, lossless_mime) = encode_smallest_lossless(img);
    if lossless.len() <= budget {
        return (lossless, lossless_mime);
    }
    let rgb = img.to_rgb8();
    let mut jpeg: Vec<u8> = Vec::new();
    let encoded = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut jpeg),
        IMAGE_LOSSY_QUALITY,
    )
    .encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .is_ok();
    if encoded && !jpeg.is_empty() && jpeg.len() < lossless.len() {
        (jpeg, "image/jpeg")
    } else {
        (lossless, lossless_mime)
    }
}

/// Encode an image the composer can attach: downscale past `IMAGE_MAX_DIM`,
/// keep the smaller of lossless WebP/PNG, write it to a temp file and return the
/// `{path, dataUrl}` pair the renderer reads back.
///
/// Shared by `normalize_image` and `capture_screen` so a screenshot and an
/// attached photo take exactly the same path to the model (a raw 5K PNG would
/// otherwise reach the composer as a multi-megabyte base64 blob).
fn image_attachment(img: image::DynamicImage, max_dim: u32) -> Option<serde_json::Value> {
    let (bytes, mime) = encode_within_budget(&fit_within(img, max_dim), IMAGE_WIRE_BUDGET);
    let tmp = temp_image_path(image_ext_of(mime));
    std::fs::write(&tmp, &bytes).ok()?;
    Some(serde_json::json!({
        "path": tmp.to_string_lossy(),
        // The temp file's suffix has to match the bytes: the agent re-reads this
        // path on later turns, and a mime sniffed from the content must agree
        // with the name it is stored under.
        "dataUrl": data_url_of(&bytes, mime),
    }))
}

/// File suffix for an encoded mime.
fn image_ext_of(mime: &str) -> &'static str {
    match mime {
        "image/webp" => "webp",
        "image/jpeg" => "jpg",
        _ => "png",
    }
}

/// Normalize any attached image to a temp file the model can always read (like
/// screenshots), so formats such as HEIC or oversized files reach the model
/// regardless of source, and shrink what does reach it.
///
/// An image that is ALREADY a model-readable format within `IMAGE_MAX_DIM` is
/// passed through byte-for-byte: re-encoding it only burned CPU and changed
/// nothing the model would see.
#[tauri::command]
pub fn normalize_image(abs_path: String) -> Option<serde_json::Value> {
    let original = std::fs::read(&abs_path).ok()?;
    let ext = PathBuf::from(&abs_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // Formats every supported vision endpoint accepts, plus what the agent's
    // own deserializer can turn into a mime type.
    let passthrough = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif"
    ) && original.len() <= 8 * 1024 * 1024;
    let dims = if passthrough {
        image::ImageReader::new(std::io::Cursor::new(&original))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
    } else {
        None
    };
    if let (true, Some((w, h))) = (passthrough, dims) {
        if w <= IMAGE_MAX_DIM && h <= IMAGE_MAX_DIM {
            let mime = image_mime(&ext)?;
            // Copy instead of decode + re-encode: the model receives the
            // ORIGINAL bytes, so nothing can be lost, for the price of one file
            // write. The copy also keeps `path` stable when the user later moves
            // or deletes the original — the agent re-reads this path from the
            // history on every following turn.
            let tmp = temp_image_path(&ext);
            std::fs::write(&tmp, &original).ok()?;
            return Some(serde_json::json!({
                "path": tmp.to_string_lossy(),
                "dataUrl": format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&original)
                ),
            }));
        }
    }

    let img = image::open(&abs_path).ok()?;
    image_attachment(img, IMAGE_MAX_DIM)
}

// --- screen capture ---------------------------------------------------------

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
                if let Ok(child) = std::process::Command::new(&exe).arg(&url).spawn() {
                    reap_detached(child);
                    return Ok(());
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for bin in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
            if let Ok(child) = std::process::Command::new(bin).arg(&url).spawn() {
                reap_detached(child);
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
        // Neovim NEVER leaves the app: the renderer opens a terminal tab and
        // runs `nvim +<line> <file>` in its own pty. A stale renderer build can
        // still send this, though, and killing its menu row with "Unknown
        // editor" was the old failure — so reuse a running nvim when one exists,
        // and otherwise open the file the OS way rather than silently dropping
        // the request. There is no external-terminal target any more.
        "nvim" | "inapp" => {
            if open_in_running_nvim(&abs.to_string_lossy()) {
                return OpResult::ok();
            }
            match open::that(&abs) {
                Ok(_) => OpResult::ok(),
                Err(_) => OpResult::err(
                    "Open this file from the in-app terminal tab (Open with → Neovim).",
                ),
            }
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

/// Spawn a child and reap it on a background thread.
///
/// These helpers only LAUNCH a program for the user (open a terminal, an app, a
/// file); nothing ever calls `wait` on the result, so every such child stayed in
/// the process table as `<defunct>` for the rest of the session — three were
/// still listed after eight hours of uptime. Waiting on a detached thread keeps
/// the launch non-blocking AND hands the pid back to the OS.
fn reap_detached(child: std::process::Child) -> bool {
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    true
}

fn spawn_detached(bin: &str, args: &[&str]) -> bool {
    match std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => reap_detached(child),
        Err(_) => false,
    }
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

/// Open a terminal AT `dir` — always the caller's own in-app terminal tab.
///
/// Kept as a command because the renderer asks through the same bridge as the
/// other workspace actions, but there is no external terminal anymore: the tab
/// itself is a pty spawned by src-tauri/src/pty.rs, so the request is complete
/// once the renderer knows which directory to open.
#[tauri::command]
pub fn open_workspace_terminal(dir: String) -> OpResult {
    let d = dir.trim();
    if !Path::new(d).is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    OpResult::ok()
}

// --- Google OAuth (native: loopback callback + token exchange in Rust) ------

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
    use futures_util::StreamExt;
    use std::io::Write as _;
    // Stream straight to disk: buffering a ~350 MB installer in a Vec blew the
    // process up by gigabytes at peak (the biggest transient memory spike in
    // the app). The file is written to a temp path and only renamed into place
    // once the byte count matches, so a failed download never looks complete.
    let tmp = dest.with_extension("part");
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => return OpResult::err(e.to_string()),
    };
    let mut written: u64 = 0;
    let mut last_pct = 0u32;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return OpResult::err(e.to_string());
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&tmp);
            return OpResult::err(e.to_string());
        }
        written += chunk.len() as u64;
        if total > 0 {
            let pct = ((written as f64 / total as f64) * 100.0) as u32;
            if pct != last_pct {
                last_pct = pct.min(99);
                let _ = window.emit("updater:progress", serde_json::json!({"phase": "downloading", "percent": last_pct}));
            }
        }
    }
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&tmp);
        return OpResult::err(e.to_string());
    }
    drop(file);
    if total > 0 && written != total {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&size_file);
        return OpResult::err(format!(
            "Download incomplete: got {written} of {total} bytes — click Retry to download again"
        ));
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return OpResult::err(e.to_string());
    }
    if let Err(e) = std::fs::write(&size_file, written.to_string()) {
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
            Ok(child) => {
                reap_detached(child);
                OpResult::ok()
            }
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
