use super::*;

pub(super) const MAX_LINE_LENGTH: usize = 2000;

/// Directories never descended into during workspace scans.
pub(super) const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".venv", "venv",
    "__pycache__", ".next", ".cache", "release", ".codifa",
];

// ---------------------------------------------------------------------------
// Path sandboxing (resolve_safe)
// ---------------------------------------------------------------------------

/// The user's own PATH directories, canonicalised once.
///
/// MEASURED on the live traces: a plain `node script.js` was classified
/// OUTSIDE and asked for /opt/homebrew/bin or ~/.nvm/... because the sandbox
/// only knew the workspace, ~/.codifa and temp. Those are the very binaries
/// the terminal runs unasked, so they belong to the same trusted set.
/// Canonicalised because macOS /opt, /tmp and /var are all symlinks and a
/// lexical compare would miss.
pub(crate) fn tool_dirs() -> &'static [PathBuf] {
    static DIRS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    DIRS.get_or_init(|| {
        let path = crate::shell_env::shell_path();
        std::env::split_paths(std::ffi::OsStr::new(&path))
            .filter_map(|d| fs::canonicalize(&d).ok())
            .collect()
    })
}

/// The absolute, lexically-normalised target `rel` names under `root`, whether
/// or not it exists. `~` expands to the home dir and a relative path joins the
/// (already canonical) root. This is the ONE place that rule lives, so the
/// sandbox check and the outside-path classifier can never drift apart.
pub(super) fn absolute_target_from(root_real: &Path, raw: &str) -> Result<PathBuf, String> {
    let expanded = if raw.starts_with('~') {
        let home = dirs::home_dir().ok_or("cannot expand ~")?;
        PathBuf::from(raw.replacen('~', &home.to_string_lossy(), 1))
    } else {
        PathBuf::from(raw)
    };
    Ok(if expanded.is_absolute() {
        normalize_path(&expanded)
    } else {
        normalize_path(&root_real.join(raw.trim_start_matches(['/', '\\'])))
    })
}

/// `absolute_target_from` for callers that only hold the root string. A missing
/// root falls back to the lexical path: the caller is CLASSIFYING a path, and a
/// wrong answer here must not be an error.
pub fn absolute_target(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    absolute_target_from(&root_real, rel.trim())
}

pub fn resolve_safe(root: &str, rel: &str, allow_coder: bool, permit: Option<&Value>) -> Result<PathBuf, String> {
    let root_real = fs::canonicalize(root).map_err(|_| format!("root does not exist: {root}"))?;
    let target = absolute_target_from(&root_real, rel.trim())?;
    // Compare against the canonical root prefix (both sides through the same
    // /var -> /private/var resolution macOS applies).
    let target_canon = fs::canonicalize(&target).unwrap_or_else(|_| {
        // Non-existent tail: canonicalize the deepest existing ancestor and
        // re-attach the remainder lexically.
        let mut anc = target.clone();
        let mut tail = Vec::new();
        while !anc.exists() {
            tail.push(anc.file_name().map(|n| n.to_os_string()).unwrap_or_default());
            if !anc.pop() {
                break;
            }
        }
        let mut real = fs::canonicalize(&anc).unwrap_or(anc);
        for part in tail.iter().rev() {
            real.push(part);
        }
        real
    });

    if target_canon != root_real && !target_canon.starts_with(&root_real) {
        if allow_coder {
            if let Some(coder) = coder_dir() {
                // Compare (and return) the CANONICAL path. The check that sent
                // us here already compared `target_canon`, so testing the
                // lexical `target` was a symlink escape: a link created inside
                // ~/.codifa (which the agent itself can write) made
                // `~/.codifa/evil/etc/passwd` pass lexically while the real
                // file is /etc/passwd.
                if target_canon == coder || target_canon.starts_with(&coder) {
                    return Ok(target_canon);
                }
            }
            // The app's own data root (default `~/Library/Application
            // Support/com.codifa.app`) is the SAME class of trusted home as
            // ~/.codifa: schedules, terminal-logs and data-root.json live
            // here. Every native read/write of them was refused as "path
            // escapes project root" — a false round-trip on the app's OWN
            // data (traced: mvrxj97c r36, mvscczhm r26).
            if let Some(app_root) = crate::state::current_data_root() {
                if let Ok(app_canon) = app_root.canonicalize() {
                    if target_canon == app_canon || target_canon.starts_with(&app_canon) {
                        return Ok(target_canon);
                    }
                }
            }
        }
        // OS temp dirs are always accessible (background terminal logs,
        // throwaway test files). env::temp_dir() is the per-user tree on
        // macOS (/var/folders/.../T); /tmp and /private/tmp are separate
        // roots a user or tool may legitimately target, so allow them too.
        let mut tmp_roots: Vec<PathBuf> = vec![std::env::temp_dir()];
        tmp_roots.push(PathBuf::from("/tmp"));
        tmp_roots.push(PathBuf::from("/private/tmp"));
        for tmp in tmp_roots {
            let Ok(tmp) = tmp.canonicalize() else { continue };
            if target_canon == tmp || target_canon.starts_with(&tmp) {
                return Ok(target_canon);
            }
        }
        // The user's own PATH is not "outside": running `node`, `python3` or
        // `cargo` is exactly what the terminal does without asking, and the
        // login PATH is already trusted enough to launch every child process.
        // Without this, a plain `node script.js` asked for /opt/homebrew/bin
        // or ~/.nvm/... on every round. The lexical `target` counts too: a PATH
        // binary is often a SYMLINK into a versioned dir (homebrew's
        // /opt/homebrew/bin/node -> ../Cellar/node/x/bin/node), so the
        // canonical form no longer carries the trusted prefix — the link
        // itself was installed into the user's PATH dir, which is what the
        // trust is about.
        if target.is_absolute()
            && tool_dirs()
                .iter()
                .any(|d| target_canon.starts_with(d) || target.starts_with(d))
        {
            return Ok(target_canon);
        }
        if let Some(permit) = permit {
            if permit["outside"].as_bool().unwrap_or(false) {
                return Ok(target_canon);
            }
            if let Some(folders) = permit["folders"].as_array() {
                for f in folders {
                    if let Some(fstr) = f.as_str() {
                        if let Ok(freal) = fs::canonicalize(fstr) {
                            if target_canon == freal || target_canon.starts_with(&freal) {
                                return Ok(target_canon);
                            }
                        }
                    }
                }
            }
        }
        return Err(format!("path escapes project root: {rel}"));
    }
    Ok(target_canon)
}

/// Whether `rel` resolves INSIDE the workspace root — the one question the shell
/// gate asks, answered with the same expansion/`~`/normalisation rules as the
/// sandbox itself. A lexical `starts_with` on the raw argv was the bug that made
/// `~/.config/x` look like `<root>/~/.config/x` and refused a read the terminal
/// was the only way to perform.
pub fn is_inside_root(root: &str, rel: &str) -> bool {
    let Ok(root_real) = fs::canonicalize(root) else {
        return false;
    };
    let Ok(target) = absolute_target(root, rel) else {
        return false;
    };
    let canon = fs::canonicalize(&target).unwrap_or(target);
    canon == root_real || canon.starts_with(&root_real)
}

/// Whether a path is reachable WITHOUT asking the user, and — when it is not —
/// the folder a grant would cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathAccess {
    /// Workspace, the OS temp roots, or the app data root (`~/.codifa`).
    Free,
    /// Outside every allowed root: the nearest existing parent of the request,
    /// which is what a folder grant approves. Empty when the path cannot be
    /// expanded at all (a bad `~`) — then the tool itself reports the error.
    NeedsPermission(PathBuf),
}

/// Classify a path for the shell gate and the tool loop, using the SAME rules as
/// `resolve_safe` so a path can never be "allowed" by one and "refused" by the
/// other. Tmp and `~/.codifa` come back `Free`: they are the agent's own
/// scratch space (background logs, throwaway fixtures, its skill store), and
/// asking for them burned a whole round per traced call.
///
/// `permit` is the turn's own grant: a folder the user already approved comes
/// back `Free`, so the pre-flight gate never asks twice inside one turn.
pub fn path_access(root: &str, rel: &str, permit: Option<&Value>) -> PathAccess {
    if resolve_safe(root, rel, true, permit).is_ok() {
        return PathAccess::Free;
    }
    let Ok(target) = absolute_target(root, rel) else {
        return PathAccess::NeedsPermission(PathBuf::new());
    };
    let mut anc = target.clone();
    while !anc.exists() {
        if !anc.pop() {
            break;
        }
    }
    if anc.as_os_str().is_empty() {
        anc = target;
    }
    PathAccess::NeedsPermission(anc)
}

/// The paths a lookup call would touch, for the pre-flight access gate.
///
/// Only read-shaped tools appear here: a writer's `path` is a mutation with its
/// own gate, and gating it twice would make the same rule live in two places.
/// `read` takes its windows (each entry carries its own file), the rest one
/// `path`/`filePath`.
pub fn lookup_paths(name: &str, args: &Value) -> Vec<String> {
    if !matches!(
        name,
        "read"
            | "grep"
            | "glob"
            | "find_symbol"
            | "lsp_symbols"
            | "lsp_diagnostics"
            | "lsp_definition"
            | "lsp_references"
            | "lsp_hover"
    ) {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    if name == "read" {
        for (file, _, _) in read_windows_of(args) {
            if !file.is_empty() && !out.contains(&file) {
                out.push(file);
            }
        }
    } else {
        for k in ["path", "filePath"] {
            let p = args[k].as_str().unwrap_or_default().trim();
            if !p.is_empty() && !out.iter().any(|q| q == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// The path a WRITER or script-run call would touch, for the pre-flight access
/// gate. Kept apart from `lookup_paths` because the caller gates it on the
/// mode's write capability: a read-only mode refuses these calls outright, so
/// asking for a folder first would only show a popup whose answer changes
/// nothing.
///
/// Without this, an out-of-tree write was answered by its own `resolve_safe`
/// refusal AFTER the round was paid (traced: `edit_file` on
/// `~/local-models-server/stt-server.py` refused, the model re-attempted the
/// change through a shell one-liner, and THAT asked the popup the write should
/// have asked — one grant served two tools, one refusal served none).
pub fn writer_gate_paths(name: &str, args: &Value) -> Vec<String> {
    let one = |key: &str| -> Vec<String> {
        let p = args[key].as_str().unwrap_or_default().trim().to_string();
        if p.is_empty() {
            Vec::new()
        } else {
            vec![p]
        }
    };
    match name {
        "write_file" | "edit_file" => one("path"),
        // A script run with an explicit working folder reads and writes around
        // it; the DEFAULT (the bundle's own folder inside ~/.codifa) needs no
        // gate, an explicit one does. This is the plugin-side rule: the bundle
        // folder, ~/.codifa and the OS temp tree stay open, anything else asks.
        "plugin" => one("cwd"),
        _ => Vec::new(),
    }
}

/// Lexical normalization without requiring the path to exist: collapses `.`
/// and `..` components (realpath behavior for the non-existent tail).
pub(super) fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The user-level data folder (CODER_DATA_DIR or ~/.codifa) — readable AND
/// writable without a permission prompt when `allow_coder` is set: plugins and
/// skills LIVE here, so refusing writes burned a traced round on "path escapes
/// project root" for every plugin/skill update.
pub(super) fn coder_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CODER_DATA_DIR") {
        if !dir.is_empty() {
            return fs::canonicalize(&dir).ok();
        }
    }
    dirs::home_dir().map(|h| h.join(".codifa"))
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

