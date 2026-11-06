use super::*;

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

pub(super) const MAX_WALK_FILES: usize = 50_000;

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

