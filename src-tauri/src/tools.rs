// Phase 3-2: native core file tools mirroring backend/tools.py semantics —
// resolve_safe sandboxing, read (windows/batch), grep, glob, write, edit.
// LSP-backed features (symbols=, symbol fast paths) stay on the Python
// sidecar until phase 4; the agent loop falls back to grep for names.

// Phase 3-2 WIP: native core tools are only called from agent.rs, which is
// not wired to a route yet. Silence dead-code until the route lands.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_READ_BYTES: usize = 2_000_000;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const MAX_FILES: usize = 10_000;
pub const MAX_TERMINAL_OUTPUT: usize = 10_000;
const MAX_GREP_ALTERNATIVES: usize = 3;
const MAX_LINE_LENGTH: usize = 2000;

/// Directories never descended into during workspace scans.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".venv", "venv",
    "__pycache__", ".next", ".cache", "release", ".codifa",
];

// ---------------------------------------------------------------------------
// Path sandboxing (resolve_safe)
// ---------------------------------------------------------------------------

/// Resolve `rel` against `root`, rejecting any escape outside the sandbox.
/// Mirrors tools.py resolve_safe: absolute paths inside root are fine, the OS
/// temp dir is always allowed, and `permit["folders"]` grants extra folders.
pub fn resolve_safe(root: &str, rel: &str, allow_coder: bool, permit: Option<&Value>) -> Result<PathBuf, String> {
    let root_real = fs::canonicalize(root).map_err(|_| format!("root does not exist: {root}"))?;
    let raw = rel.trim();
    let expanded = if raw.starts_with('~') {
        let home = dirs::home_dir().ok_or("cannot expand ~")?;
        PathBuf::from(raw.replacen('~', &home.to_string_lossy(), 1))
    } else {
        PathBuf::from(raw)
    };
    let target = if expanded.is_absolute() {
        normalize_path(&expanded)
    } else {
        normalize_path(&root_real.join(raw.trim_start_matches(['/', '\\'])))
    };
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
                if target == coder || target.starts_with(&coder) {
                    return Ok(target);
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
                return Ok(target);
            }
        }
        if let Some(permit) = permit {
            if permit["outside"].as_bool().unwrap_or(false) {
                return Ok(target);
            }
            if let Some(folders) = permit["folders"].as_array() {
                for f in folders {
                    if let Some(fstr) = f.as_str() {
                        if let Ok(freal) = fs::canonicalize(fstr) {
                            if target_canon == freal || target_canon.starts_with(&freal) {
                                return Ok(target);
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

/// Lexical normalization without requiring the path to exist: collapses `.`
/// and `..` components (realpath behavior for the non-existent tail).
fn normalize_path(p: &Path) -> PathBuf {
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

/// The user-level data folder (CODER_DATA_DIR or ~/.codifa) — readable without
/// a permission prompt when `allow_coder` is set.
fn coder_dir() -> Option<PathBuf> {
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

/// Read one window of a file (1-indexed offset, line count) with the same
/// truncation rules as tools.py: 2MB byte cap, 2000-char line cap.
pub fn read_window(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    if abs.is_dir() {
        return list_dir(abs, offset, limit);
    }
    let meta = fs::metadata(abs).map_err(|e| format!("file not found: {e}"))?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err(format!(
            "file too large to read in one call ({} bytes > {MAX_READ_BYTES}); use offset/limit windows",
            meta.len()
        ));
    }
    let content = fs::read_to_string(abs)
        .map_err(|_| format!("binary file (read skipped): {}", abs.display()))?;
    let start = offset.saturating_sub(1);
    let mut out = String::new();
    for line in content.lines().skip(start).take(limit) {
        if line.len() > MAX_LINE_LENGTH {
            out.push_str(&line[..MAX_LINE_LENGTH]);
            out.push_str(" …[truncated]");
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    Ok(out)
}

/// Directory listing (one entry per line, subdirs marked with `/`).
fn list_dir(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    let mut entries: Vec<String> = fs::read_dir(abs)
        .map_err(|e| format!("cannot list directory: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .collect();
    entries.sort();
    let start = offset.saturating_sub(1);
    Ok(entries
        .into_iter()
        .skip(start)
        .take(limit)
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Parse `ranges` entries ("path:offset:limit", "start:end", "[start,end]")
/// against an optional single target file — the tolerant parser from read_tool.
pub fn parse_ranges(ranges: &[String], single_target: &str) -> (Vec<(String, usize, usize)>, Vec<String>) {
    let mut jobs = Vec::new();
    let mut bad = Vec::new();
    for spec in ranges {
        let s = spec.trim();
        if s.starts_with('[') {
            // "[start,end]" inclusive window on the single target.
            let pair: Vec<&str> = s
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(str::trim)
                .collect();
            if pair.len() == 2 {
                if let (Ok(a), Ok(b)) = (pair[0].parse::<usize>(), pair[1].parse::<usize>()) {
                    if b >= a && !single_target.is_empty() {
                        jobs.push((single_target.to_string(), a, b - a + 1));
                        continue;
                    }
                }
            }
            bad.push(s.to_string());
            continue;
        }
        let parts: Vec<&str> = s.split(':').map(str::trim).collect();
        match parts.len() {
            3 => {
                if let (Ok(o), Ok(l)) = (parts[1].parse::<usize>(), parts[2].parse::<usize>()) {
                    if !parts[0].is_empty() {
                        jobs.push((parts[0].to_string(), o, l));
                        continue;
                    }
                }
                bad.push(s.to_string());
            }
            2 => {
                if let (Ok(a), Ok(b)) = (parts[0].parse::<usize>(), parts[1].parse::<usize>()) {
                    if !single_target.is_empty() {
                        // end >= start: inclusive range; else offset:count.
                        if b >= a {
                            jobs.push((single_target.to_string(), a, b - a + 1));
                        } else {
                            jobs.push((single_target.to_string(), a, b));
                        }
                        continue;
                    }
                }
                bad.push(s.to_string());
            }
            _ => bad.push(s.to_string()),
        }
    }
    (jobs, bad)
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

/// Count top-level `|` alternatives (pipes inside (...) groups count as one).
pub fn count_grep_alternatives(pattern: &str) -> usize {
    let mut depth = 0i32;
    let mut count = 1usize;
    let mut escaped = false;
    for ch in pattern.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '(' => depth += 1,
            ')' => depth -= 1,
            '|' if depth == 0 => count += 1,
            _ => {}
        }
    }
    count
}

/// Walk a scope directory collecting candidate files (hidden dirs and
/// SKIP_DIRS pruned, depth-first).
fn collect_files(scope: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(scope) else { return };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir() {
            if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                dirs.push(entry.path());
            }
        } else if !name.starts_with('.') {
            files.push(entry.path());
        }
    }
    out.extend(files);
    for dir in dirs {
        collect_files(&dir, out);
        if out.len() >= MAX_FILES {
            return;
        }
    }
}

/// Locate the rg binary. The packaged macOS app inherits a minimal PATH
/// (no /opt/homebrew/bin), so probe the common install locations before
/// giving up — the agent's grep tool depends on ripgrep.
fn rg_binary() -> String {
    const CANDIDATES: &[&str] = &["rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg"];
    for c in CANDIDATES {
        if std::process::Command::new(c)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return (*c).to_string();
        }
    }
    "rg".to_string()
}

/// Grep file contents via the ripgrep binary (rg) — parallel search,
/// .gitignore-aware, far faster than the in-process walker below.
/// No fallback (per user request): rg must be on PATH; a missing binary
/// surfaces as a clear error instead of silently degrading to the walker.
/// Output mirrors the walker's format: `rel:\n` headers, `>` marker on
/// the match line, ±3 context lines, long lines truncated.
pub fn grep_scope(
    root: &Path,
    scope: &str,
    pattern: &str,
    include: &str,
    max_results: usize,
) -> Result<String, String> {
    // Enforcement lives here (not just in dispatch) so direct callers get the
    // same guard: unscoped multi-alternative patterns are refused.
    if scope.is_empty()
        && include.is_empty()
        && count_grep_alternatives(pattern) > MAX_GREP_ALTERNATIVES
    {
        return Err(format!(
            "broad pattern refused: {pattern:?} has {} top-level alternatives (max {MAX_GREP_ALTERNATIVES}) and no path/include scope",
            count_grep_alternatives(pattern)
        ));
    }
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let scope_abs = if scope.is_empty() {
        root_real.clone()
    } else {
        resolve_safe(root.to_str().unwrap_or("."), scope, true, None)?
    };
    // A file scope (grep inside one file) cannot be current_dir — spawning rg
    // there fails with ENOTDIR ("Not a directory"). Search from the file's
    // parent directory, targeting the file itself.
    let (search_dir, search_target) = if scope_abs.is_file() {
        (
            scope_abs.parent().unwrap_or(&root_real).to_path_buf(),
            scope_abs
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".to_string()),
        )
    } else {
        (scope_abs.clone(), ".".to_string())
    };

    let cap = max_results.min(MAX_SEARCH_RESULTS);
    let mut cmd = std::process::Command::new(rg_binary());
    cmd.current_dir(&search_dir)
        .arg("--json")
        .arg("--line-number")
        .arg("--max-count")
        .arg(cap.to_string())
        .arg("--context")
        .arg("3")
        .arg("--ignore-case")
        .arg("--no-messages");
    if !include.is_empty() {
        cmd.arg("--glob").arg(include);
    }
    cmd.arg("--").arg(pattern).arg(&search_target);

    let raw = cmd
        .output()
        .map_err(|e| format!("ripgrep (rg) is required but could not be run: {e}"))?;
    if raw.status.code() == Some(2) {
        return Err(String::from_utf8_lossy(&raw.stderr).trim().to_string());
    }

    // Parse rg --json events and rebuild the walker's header+marker format.
    let mut out = String::new();
    let mut hits = 0usize;
    let mut current_file = String::new();
    let mut pending: Vec<(bool, u64, String)> = Vec::new(); // (is_match, line_no, text)
    for line in String::from_utf8_lossy(&raw.stdout).lines() {
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let kind = ev["type"].as_str().unwrap_or_default();
        if kind == "begin" {
            let path = ev["data"]["path"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            // Join against search_dir (the scope's PARENT when the scope is a
            // single file) — joining against scope_abs itself doubled the
            // path (file/filename), producing unopenable chips.
            let abs = search_dir.join(&path);
            let abs = abs.components().collect::<std::path::PathBuf>();
            current_file = abs
                .strip_prefix(&root_real)
                .unwrap_or(&abs)
                .to_string_lossy()
                .to_string();
        } else if kind == "match" || kind == "context" {
            let text = ev["data"]["lines"]["text"]
                .as_str()
                .unwrap_or_default()
                .trim_end_matches('\n')
                .to_string();
            let line_no = ev["data"]["line_number"].as_u64().unwrap_or(0);
            if kind == "match" {
                if hits >= cap {
                    continue;
                }
                hits += 1;
            }
            pending.push((kind == "match", line_no, text));
        } else if kind == "end" {
            if !pending.is_empty() && !current_file.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&current_file);
                out.push_str(":\n");
                for (is_match, line_no, text) in &pending {
                    let marker = if *is_match { ">" } else { " " };
                    let body = if text.len() > MAX_LINE_LENGTH {
                        format!("{} …[truncated]", &text[..MAX_LINE_LENGTH])
                    } else {
                        text.clone()
                    };
                    out.push_str(&format!("{marker}{line_no}: {body}\n"));
                }
                pending.clear();
            }
        }
    }
    if hits >= cap {
        out.push_str(&format!(
            "\n[truncated — {hits}+ matches; read the shown files instead of re-grepping]\n"
        ));
    }
    if hits == 0 {
        return Ok("no matches".into());
    }
    Ok(out)
}

/// Translate a glob like `*.{ts,tsx}` or `*.test.py` into a regex.
fn glob_to_regex(glob: &str) -> regex::Regex {
    let mut pat = String::from("^");
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    pat.push_str(".*");
                } else {
                    pat.push_str("[^/]*");
                }
            }
            '?' => pat.push('.'),
            '{' => pat.push_str("(?:"),
            '}' => pat.push(')'),
            ',' => pat.push('|'),
            '.' | '(' | ')' | '[' | ']' | '^' | '$' | '+' | '|' | '\\' => {
                pat.push('\\');
                pat.push(c);
            }
            other => pat.push(other),
        }
    }
    pat.push('$');
    regex::Regex::new(&pat).unwrap_or_else(|_| regex::Regex::new("^$").unwrap())
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/// Find files by glob pattern within a scope; returns relative paths.
pub fn glob_scope(root: &Path, scope: &str, pattern: &str, max_results: usize) -> Result<Vec<String>, String> {
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let scope_abs = if scope.is_empty() {
        root_real.clone()
    } else {
        resolve_safe(root.to_str().unwrap_or("."), scope, true, None)?
    };
    let re = glob_to_regex(pattern);
    let mut files = Vec::new();
    collect_files(&scope_abs, &mut files);
    let mut out = Vec::new();
    for file in files {
        let rel = file.strip_prefix(&root_real).unwrap_or(&file).to_string_lossy().to_string();
        // Match the relative path AND the bare file name (so `*.ts` also hits
        // nested files the way `**/*.ts` users expect).
        let name = file.file_name().unwrap_or_default().to_string_lossy().to_string();
        if re.is_match(&rel) || re.is_match(&name) {
            out.push(rel);
            if out.len() >= max_results.min(MAX_SEARCH_RESULTS) {
                break;
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// write / edit
// ---------------------------------------------------------------------------

/// Overwrite a file with new content (brand-new files or full rewrites).
pub fn write_file(root: &str, path: &str, content: &str, permit: Option<&Value>) -> Result<String, String> {
    let target = resolve_safe(root, path, false, permit)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create parent dir: {e}"))?;
    }
    fs::write(&target, content).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(format!("Successfully wrote {path} ({} bytes).", content.len()))
}

/// One old_string -> new_string replacement (byte-exact match, uniqueness
/// enforced unless replace_all). Returns a summary or an error message.
pub fn edit_file(
    root: &str,
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    permit: Option<&Value>,
) -> Result<String, String> {
    if old_string == new_string {
        return Err("old_string and new_string are identical".into());
    }
    let target = resolve_safe(root, path, false, permit)?;
    if !target.exists() {
        return Err("file not found".into());
    }
    if target.is_dir() {
        return Err("path is a directory".into());
    }
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err("file too large to edit safely".into());
    }
    let content = fs::read_to_string(&target).map_err(|_| "binary file (edit skipped)".to_string())?;

    let occurrences = content.matches(old_string).count();
    if occurrences == 0 {
        return Err("old_string not found in file — re-read the file and copy the exact current text".into());
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_string appears {occurrences} times — include more surrounding lines to make it unique, or pass replace_all=true"
        ));
    }
    let new_content = if replace_all {
        content.replace(old_string, new_string)
    } else {
        content.replacen(old_string, new_string, 1)
    };
    fs::write(&target, &new_content).map_err(|e| format!("cannot write file: {e}"))?;
    let n = if replace_all { occurrences } else { 1 };
    Ok(format!(
        "Successfully edited {path} ({n} occurrence{} replaced).",
        if n == 1 { "" } else { "s" }
    ))
}

// ---------------------------------------------------------------------------
// terminal (bounded, non-PTY — the interactive PTY stays in pty.rs)
// ---------------------------------------------------------------------------

/// Run a shell command in `root` with a timeout, returning combined output.
/// Mirrors tools.py run_terminal: kill on timeout, cap the output.
pub fn run_terminal(root: &str, command: &str, timeout_secs: u64) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let start = Instant::now();
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot spawn: {e}"))?;

    let deadline = Duration::from_secs(timeout_secs);
    let mut output = Vec::new();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut buf = [0u8; 8192];
    loop {
        if start.elapsed() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(format!(
                "ERROR: command timed out after {timeout_secs}s\n{}",
                String::from_utf8_lossy(&output)
            ));
        }
        let mut read_any = false;
        if let Some(s) = stdout.as_mut() {
            match s.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    read_any = true;
                    output.extend_from_slice(&buf[..n]);
                    if output.len() > MAX_TERMINAL_OUTPUT * 2 {
                        break;
                    }
                }
                Err(_) => {}
            }
        }
        if let Some(s) = stderr.as_mut() {
            match s.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    read_any = true;
                    output.extend_from_slice(&buf[..n]);
                }
                Err(_) => {}
            }
        }
        if !read_any {
            // Both pipes closed (or absent) — the child is done producing.
            if child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&output).to_string();
    if text.len() > MAX_TERMINAL_OUTPUT {
        let cut = text.len() - MAX_TERMINAL_OUTPUT;
        text = format!("…[head truncated]\n{}", &text[cut..]);
    }
    if !status.success() {
        return Ok(format!("EXIT CODE: {}\n{text}", status.code().unwrap_or(-1)));
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// JSON tool-call dispatch (used by the agent loop)
// ---------------------------------------------------------------------------

/// Execute one tool call by name with JSON args; returns the ToolMessage text.
/// LSP-backed tools (lsp_*) and MCP stay proxied to the Python sidecar in
/// phase 3-2; the agent loop routes unknown names there.
pub fn dispatch(root: &str, name: &str, args: &Value, permit: Option<&Value>) -> Result<String, String> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    match name {
        "read" => {
            let path = {
                let p = s("filePath");
                if p.is_empty() { s("path") } else { p }
            };
            // Single-path discipline: the batch form (filePaths: [...]) is no
            // longer accepted — several windows of ONE file go through
            // ranges=[{offset,limit},…] instead (user request).
            if path.is_empty() && args["filePaths"].is_array() {
                return Err(
                    "read takes a single filePath — to read several windows of one file pass ranges=[{\"offset\":1,\"limit\":400},…]".into(),
                );
            }
            let abs = resolve_safe(root, &path, true, permit)?;
            // Multi-RANGE: several windows of the same file in one call.
            if let Some(ranges) = args["ranges"].as_array() {
                let mut out = String::new();
                for r in ranges {
                    let offset = r["offset"].as_u64().unwrap_or(1) as usize;
                    let limit = r["limit"].as_u64().unwrap_or(400) as usize;
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                    out.push_str(&read_window(&abs, offset, limit)?);
                }
                return Ok(out);
            }
            let offset = args["offset"].as_u64().unwrap_or(1) as usize;
            // Windowed-read discipline: a whole-file read floods the context
            // and slows the agent down. Cap the default window; larger reads
            // must be explicit (offset/limit).
            let limit = args["limit"].as_u64().unwrap_or(400) as usize;
            read_window(&abs, offset, limit)
        }
        "grep" => {
            let mut patterns = vec![s("pattern")];
            if let Some(extra) = args["patterns"].as_array() {
                patterns.extend(extra.iter().filter_map(|p| p.as_str().map(String::from)));
            }
            let combined: Vec<&str> = patterns.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
            if combined.is_empty() {
                return Err("empty pattern: pass pattern='...' or patterns=[...]".into());
            }
            let joined = combined.join("|");
            // Catch-all patterns (".", ".*", …) match every line of every file —
            // a whole-tree scan disguised as a grep. Refuse them outright.
            if matches!(joined.trim(), "." | ".*" | ".+" | "^" | "$" | "^$") {
                return Err(format!(
                    "catch-all pattern {joined:?} refused — grep a real token instead"
                ));
            }
            if count_grep_alternatives(&joined) > MAX_GREP_ALTERNATIVES
                && s("path").is_empty()
                && s("include").is_empty()
            {
                return Err(format!(
                    "broad pattern refused: {joined:?} has {} top-level alternatives (max {MAX_GREP_ALTERNATIVES}) and no path/include scope",
                    count_grep_alternatives(&joined)
                ));
            }
            let max = args["max_results"].as_u64().unwrap_or(50) as usize;
            grep_scope(Path::new(root), &s("path"), &joined, &s("include"), max)
        }
        "glob" => {
            let mut patterns = vec![s("pattern")];
            if let Some(extra) = args["patterns"].as_array() {
                patterns.extend(extra.iter().filter_map(|p| p.as_str().map(String::from)));
            }
            let pattern = patterns.into_iter().find(|p| !p.is_empty()).unwrap_or_default();
            if pattern.is_empty() {
                return Err("empty pattern: pass pattern='...' or patterns=[...]".into());
            }
            let scope = s("path");
            if scope.is_empty() {
                return Err("Workspace-wide glob is not allowed. Provide path=... to scope the search".into());
            }
            let max = args["max_results"].as_u64().unwrap_or(100) as usize;
            let hits = glob_scope(Path::new(root), &scope, &pattern, max)?;
            if hits.is_empty() {
                Ok("no matches".into())
            } else {
                Ok(hits.join("\n"))
            }
        }
        "write_file" => write_file(root, &s("path"), &s("content"), permit),
        "edit_file" => {
            let path = {
                let p = s("path");
                if p.is_empty() { s("filePath") } else { p }
            };
            // Batch edits apply sequentially in list order.
            if let Some(edits) = args["edits"].as_array() {
                if edits.is_empty() {
                    return Err("edits must be a non-empty list".into());
                }
                let target = resolve_safe(root, &path, false, permit)?;
                let mut content =
                    fs::read_to_string(&target).map_err(|_| "binary file (edit skipped)".to_string())?;
                for (idx, item) in edits.iter().enumerate() {
                    let old = item["old_string"].as_str().unwrap_or_default();
                    let new = item["new_string"].as_str().unwrap_or_default();
                    let all = item["replace_all"].as_bool().unwrap_or(false);
                    if old.is_empty() {
                        return Err(format!("edit {}/{}: old_string is empty", idx + 1, edits.len()));
                    }
                    if old == new {
                        return Err(format!(
                            "edit {}/{}: old_string and new_string are identical",
                            idx + 1,
                            edits.len()
                        ));
                    }
                    let occ = content.matches(old).count();
                    if occ == 0 {
                        return Err(format!("edit {}/{}: old_string not found", idx + 1, edits.len()));
                    }
                    if occ > 1 && !all {
                        return Err(format!(
                            "edit {}/{}: old_string appears {occ} times — make it unique",
                            idx + 1,
                            edits.len()
                        ));
                    }
                    content = if all { content.replace(old, new) } else { content.replacen(old, new, 1) };
                }
                fs::write(&target, &content).map_err(|e| format!("cannot write file: {e}"))?;
                return Ok(format!("Successfully edited {path} ({} edits applied).", edits.len()));
            }
            edit_file(
                root,
                &path,
                &s("old_string"),
                &s("new_string"),
                args["replace_all"].as_bool().unwrap_or(false),
                permit,
            )
        }
        "run_terminal" => {
            let timeout = args["timeout"].as_u64().unwrap_or(120);
            run_terminal(root, &s("command"), timeout)
        }
        "current_time" => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            Ok(json!({ "unix_ms": now.as_millis() as u64 }).to_string())
        }
        // Activity Monitor for the agent: per-process RSS/CPU so it can
        // diagnose memory/CPU issues itself (read-only, all modes).
        "system_stats" => system_stats(&s("filter"), args["top"].as_u64().unwrap_or(15) as usize),
        // LSP-backed tools (phase 3-3 parity with tools.py) — served by the
        // native stdio JSON-RPC client in lsp.rs.
        "lsp_definition" => crate::lsp::definition(
            root,
            &s("filePath"),
            args["line"].as_i64().unwrap_or(1),
            args["character"].as_i64().unwrap_or(0),
        ),
        "lsp_references" => crate::lsp::references(
            root,
            &s("filePath"),
            args["line"].as_i64().unwrap_or(1),
            args["character"].as_i64().unwrap_or(0),
        ),
        "lsp_hover" => crate::lsp::hover(
            root,
            &s("filePath"),
            args["line"].as_i64().unwrap_or(1),
            args["character"].as_i64().unwrap_or(0),
        ),
        "lsp_symbols" => crate::lsp::symbols(root, &s("filePath"), &s("query")),
        "lsp_diagnostics" => crate::lsp::diagnostics(root, &s("filePath")),
        // Native memory store (JSONL layer of memory_manager.py).
        "save_memory" => {
            let t = s("memory_type");
            let mtype: &str = if t.is_empty() { "long_term" } else { &t };
            let rec = crate::memory::add(&s("content"), mtype, root);
            Ok(rec.to_string())
        }
        "search_memory" => {
            let limit = args["max_results"].as_u64().unwrap_or(15) as usize;
            let hits = crate::memory::search(&s("query"), root, limit);
            if hits.is_empty() {
                Ok("no matching memories".into())
            } else {
                Ok(serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into()))
            }
        }
        _ => Err(format!("tool {name:?} is not available natively (proxied to the sidecar)")),
    }
}

/// Activity Monitor for the agent: per-process RSS/CPU via `ps` (read-only,
/// available in every mode so the agent can diagnose memory/CPU issues).
fn system_stats(filter: &str, top: usize) -> Result<String, String> {
    let out = std::process::Command::new("ps")
        .args(["-axo", "rss,pcpu,comm"])
        .output()
        .map_err(|e| format!("ps failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("ps exited with {}", out.status));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows: Vec<(f64, f64, String)> = Vec::new();
    for line in text.lines().skip(1) {
        let mut it = line.split_whitespace();
        let (Some(rss), Some(cpu)) = (it.next(), it.next()) else { continue };
        let comm = it.collect::<Vec<_>>().join(" ");
        let rss_mb: f64 = rss.parse().unwrap_or(0.0);
        let cpu: f64 = cpu.parse().unwrap_or(0.0);
        let f = filter.to_lowercase();
        if !f.is_empty() && !comm.to_lowercase().contains(&f) {
            continue;
        }
        rows.push((rss_mb / 1024.0, cpu, comm));
    }
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = rows.iter().map(|r| r.0).sum();
    let mut s = format!("total RSS of listed processes: {total:.0} MB\n");
    for (rss, cpu, comm) in rows.iter().take(top.max(1)) {
        s.push_str(&format!("{rss:8.0} MB  {cpu:5.1}%  {comm}\n"));
    }
    Ok(s)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_stats_lists_processes() {
        let out = system_stats("", 5).expect("system_stats should work");
        assert!(out.contains("total RSS"), "missing header: {out}");
        assert!(out.lines().count() > 1, "no rows: {out}");
    }

    #[test]
    fn system_stats_filters_by_name() {
        let out = system_stats("codifa", 10).expect("system_stats should work");
        for line in out.lines().skip(1) {
            assert!(
                line.to_lowercase().contains("codifa") || line.trim().is_empty(),
                "non-matching row leaked: {line}"
            );
        }
    }

    #[test]
    fn resolve_safe_rejects_escapes() {
        let tmp = std::env::temp_dir().join("codifa-tools-test");
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();
        assert!(resolve_safe(root, "src/a.ts", false, None).is_ok());
        assert!(resolve_safe(root, "/etc/passwd", false, None).is_err());
        assert!(resolve_safe(root, "../../outside.txt", false, None).is_err());
        // Temp dir is always allowed.
        let t = std::env::temp_dir().join("codifa-allowed.txt");
        assert!(resolve_safe(root, &t.to_string_lossy(), false, None).is_ok());
        // The shared /tmp root is allowed too (Unix; skipped where absent).
        #[cfg(unix)]
        {
            fs::write("/tmp/codifa-tmp-allowed.txt", "x").unwrap();
            assert!(resolve_safe(root, "/tmp/codifa-tmp-allowed.txt", false, None).is_ok());
            let _ = fs::remove_file("/tmp/codifa-tmp-allowed.txt");
        }
        // permit folders grant only their subtree.
        let permit = json!({ "folders": [tmp.parent().unwrap().to_str().unwrap()] });
        assert!(resolve_safe(root, "/etc/passwd", false, Some(&permit)).is_err());
        let granted = tmp.join("sub/x");
        assert!(resolve_safe(root, &granted.to_string_lossy(), false, Some(&permit)).is_ok());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_window_truncates_long_lines() {
        let tmp = std::env::temp_dir().join("codifa-read-test.txt");
        let long = "x".repeat(3000);
        fs::write(&tmp, format!("short\n{long}\n")).unwrap();
        let out = read_window(&tmp, 1, 100).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "short");
        assert!(lines[1].contains("…[truncated]"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn parse_ranges_handles_all_forms() {
        let (jobs, bad) = parse_ranges(&["a.py:10:5".into()], "");
        assert_eq!(jobs, vec![("a.py".into(), 10, 5)]);
        assert!(bad.is_empty());
        let (jobs, _) = parse_ranges(&["30:40".into()], "x.ts");
        assert_eq!(jobs, vec![("x.ts".into(), 30, 11)]);
        let (jobs, _) = parse_ranges(&["[7,9]".into()], "x.ts");
        assert_eq!(jobs, vec![("x.ts".into(), 7, 3)]);
        let (_, bad) = parse_ranges(&["nope".into()], "x.ts");
        assert_eq!(bad, vec!["nope".to_string()]);
    }

    #[test]
    fn grep_alternative_counting_ignores_grouped_pipes() {
        assert_eq!(count_grep_alternatives("foo|bar|baz"), 3);
        assert_eq!(count_grep_alternatives("(a|b)|c"), 2);
        assert_eq!(count_grep_alternatives("function\\s+\\w+"), 1);
    }

    #[test]
    fn grep_scope_finds_matches_with_context() {
        let tmp = std::env::temp_dir().join("codifa-grep-test");
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub/a.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
        let out = grep_scope(&tmp, "sub", "alpha", "", 10).unwrap();
        assert!(out.contains("a.rs"));
        assert!(out.contains(">1: fn alpha"));
        assert!(out.contains("2: fn beta"));
        assert_eq!(grep_scope(&tmp, "sub", "zzz_nothing", "", 10).unwrap(), "no matches");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_scope_accepts_single_file_scope() {
        // A file (not a directory) as the scope: rg cannot current_dir into a
        // file (ENOTDIR, "Not a directory") — the scope must resolve to the
        // file's parent with the file as the search target.
        let tmp = std::env::temp_dir().join("codifa-grep-file-test");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("one.rs"), "fn alpha() {}\n").unwrap();
        let file_scope = tmp.join("one.rs").to_string_lossy().into_owned();
        let out = grep_scope(&tmp, &file_scope, "alpha", "", 10).unwrap();
        assert!(out.contains("alpha"), "file-scope grep failed: {out}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_refuses_unscoped_broad_patterns() {
        let tmp = std::env::temp_dir().join("codifa-grep-broad");
        fs::create_dir_all(&tmp).unwrap();
        let args = json!({ "pattern": "a|b|c|d" });
        let err = dispatch(tmp.to_str().unwrap(), "grep", &args, None).unwrap_err();
        assert!(err.contains("broad pattern refused"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn glob_scope_matches_nested_and_flat() {
        let tmp = std::env::temp_dir().join("codifa-glob-test");
        fs::create_dir_all(tmp.join("deep/nest")).unwrap();
        fs::write(tmp.join("deep/nest/x.test.ts"), "").unwrap();
        fs::write(tmp.join("top.py"), "").unwrap();
        let hits = glob_scope(&tmp, "deep", "**/*.test.ts", 10).unwrap();
        assert_eq!(hits, vec!["deep/nest/x.test.ts".to_string()]);
        let hits = glob_scope(&tmp, "", "*.py", 10).unwrap();
        assert_eq!(hits, vec!["top.py".to_string()]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn edit_enforces_uniqueness_and_batch_order() {
        let tmp = std::env::temp_dir().join("codifa-edit-test");
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "one\ntwo\none\n").unwrap();
        let root = tmp.to_str().unwrap();

        let err = edit_file(root, "f.txt", "one", "ONE", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"));
        let msg = edit_file(root, "f.txt", "one", "ONE", true, None).unwrap();
        assert!(msg.contains("2 occurrences"));

        let args = json!({
            "path": "f.txt",
            "edits": [
                { "old_string": "ONE", "new_string": "uno", "replace_all": true },
                { "old_string": "missing", "new_string": "x" }
            ]
        });
        let err = dispatch(root, "edit_file", &args, None).unwrap_err();
        assert!(err.contains("edit 2/2: old_string not found"));
        // Batch is atomic: a failed edit leaves the file untouched.
        assert!(!fs::read_to_string(&file).unwrap().contains("uno"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_rejects_paths_outside_root() {
        let tmp = std::env::temp_dir().join("codifa-write-test");
        fs::create_dir_all(&tmp).unwrap();
        let err = write_file(tmp.to_str().unwrap(), "/etc/codifa-evil.txt", "x", None).unwrap_err();
        assert!(err.contains("escapes project root"));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn terminal_captures_output_and_exit_codes() {
        let tmp = std::env::temp_dir().join("codifa-term-test");
        fs::create_dir_all(&tmp).unwrap();
        let out = run_terminal(tmp.to_str().unwrap(), "echo hello", 10).unwrap();
        assert!(out.contains("hello"));
        let out = run_terminal(tmp.to_str().unwrap(), "exit 3", 10).unwrap();
        assert!(out.contains("EXIT CODE: 3"));
        fs::remove_dir_all(&tmp).ok();
    }
}
