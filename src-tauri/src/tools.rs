// Phase 3-2: native core file tools mirroring backend/tools.py semantics —
// resolve_safe sandboxing, read (windows/batch), grep, glob, write, edit.
//! LSP-backed features (symbols=, symbol fast paths) run natively; the agent
//! loop falls back to grep for names the language server cannot resolve.

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
/// Hard depth cap for filesystem walks (`collect_files`) — a second belt next
/// to the canonical-path visited set, so a pathological tree cannot blow the
/// stack.
const MAX_WALK_DEPTH: usize = 64;

/// How many skill names a miss/ambiguity message may print. A store can hold
/// hundreds of skills, so echoing all of them would spend a transcript's worth
/// of tokens on a failed lookup.
const SKILL_LIST_MAX: usize = 30;

/// How many search hits `load_skill query=` lists before asking the model to
/// name one.
const SKILL_SEARCH_MAX: usize = 8;
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

/// Slice one line to the byte cap without splitting a UTF-8 character (a raw
/// byte slice panics on any multi-byte character crossing the boundary).
fn truncated_line(line: &str) -> String {
    if line.len() <= MAX_LINE_LENGTH {
        return line.to_string();
    }
    let mut end = MAX_LINE_LENGTH;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} …[truncated]", &line[..end])
}

/// One read window of a file: its lines, or the reason the window is empty.
enum Window {
    Lines(Vec<String>),
    Empty(String),
}

/// Read one window of a file (1-indexed offset, line count) with the same
/// truncation rules as tools.py: 2MB byte cap, 2000-char line cap.
fn file_window(abs: &Path, offset: usize, limit: usize) -> Result<Window, String> {
    let meta = fs::metadata(abs).map_err(|e| format!("file not found: {e}"))?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err(format!(
            "file too large to read in one call ({} bytes > {MAX_READ_BYTES}); use offset/limit windows",
            meta.len()
        ));
    }
    let content = fs::read_to_string(abs)
        .map_err(|_| format!("binary file (read skipped): {}", abs.display()))?;
    let total = content.lines().count();
    let lines: Vec<String> = content
        .lines()
        .skip(offset.saturating_sub(1))
        .take(limit)
        .map(truncated_line)
        .collect();
    if lines.is_empty() {
        // An empty window is never data: say WHY it is empty, otherwise the
        // caller burns another round guessing (a traced run read offset=100000
        // of a short file and got a silent blank).
        return Ok(Window::Empty(if total == 0 {
            format!("{} is empty (0 lines)", abs.display())
        } else {
            format!(
                "offset {offset} is past the end of {} ({total} lines) — read offset=1",
                abs.display()
            )
        }));
    }
    Ok(Window::Lines(lines))
}

/// Bare window text (no line numbers) — the shape non-agent callers expect.
pub fn read_window(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    if abs.is_dir() {
        return list_dir(abs, offset, limit);
    }
    match file_window(abs, offset, limit)? {
        Window::Lines(lines) => {
            let mut out = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
            for line in lines {
                out.push_str(&line);
                out.push('\n');
            }
            Ok(out)
        }
        Window::Empty(notice) => Ok(notice),
    }
}

/// Read one window for the agent loop: the same lines, each carrying its
/// 1-based number under a `<label> (lines a-b):` header, so the model can cite
/// a line instead of re-reading the file to pin its number down. Directory
/// listings keep their plain form.
pub fn read_window_block(abs: &Path, label: &str, offset: usize, limit: usize) -> Result<String, String> {
    if abs.is_dir() {
        return read_window(abs, offset, limit);
    }
    match file_window(abs, offset, limit)? {
        Window::Lines(lines) => Ok(numbered_window(label, offset.max(1), &lines)),
        Window::Empty(notice) => Ok(notice),
    }
}

/// Render one read window as numbered lines under a range header.
///
/// The raw window (bare lines, no numbers) cost the caller an extra round: a
/// traced explore re-read offsets 4730 and 222 in the very turn after they were
/// already delivered, because nothing in the output pinned a real line number
/// it could cite, and a multi-range read glued several windows together with no
/// marker for where each one started. The header states the file and the
/// inclusive line span; every line carries its 1-based number, right-aligned so
/// digits do not shift the code.
pub fn numbered_window(label: &str, first_line: usize, lines: &[String]) -> String {
    if lines.is_empty() {
        return format!("{label} (lines {first_line}+): (empty window)\n");
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    let mut out = format!("{label} (lines {first_line}-{last}):\n");
    for (i, line) in lines.iter().enumerate() {
        out.push_str(&format!("{:>width$}: {line}\n", first_line + i, width = width));
    }
    out
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
    let total = entries.len();
    let start = offset.saturating_sub(1);
    let page: Vec<String> = entries.into_iter().skip(start).take(limit).collect();
    if page.is_empty() {
        // Same rule as read_window: an empty listing must explain itself.
        return Ok(if total == 0 {
            format!("{} is empty (no entries)", abs.display())
        } else {
            format!(
                "offset {offset} is past the end of {} ({total} entries) — read offset=1",
                abs.display()
            )
        });
    }
    Ok(page.join("\n"))
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
    // Canonicalized ancestors, so a symlinked cycle (`ln -s .. up`) can never
    // recurse forever — `path.is_dir()` follows symlinks, and the MAX_FILES
    // bound never triggers on a cycle that adds no files.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    collect_files_inner(scope, out, &mut seen, 0);
}

fn collect_files_inner(
    scope: &Path,
    out: &mut Vec<PathBuf>,
    seen: &mut std::collections::HashSet<PathBuf>,
    depth: usize,
) {
    if out.len() >= MAX_FILES || depth > MAX_WALK_DEPTH {
        return;
    }
    let real = fs::canonicalize(scope).unwrap_or_else(|_| scope.to_path_buf());
    if !seen.insert(real) {
        return;
    }
    let Ok(entries) = fs::read_dir(scope) else { return };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    // Skip individual unreadable entries (a broken symlink, a permission-denied
    // file) but never fail the whole walk for them — this is a best-effort scan.
    for entry in entries.flatten() {
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
        collect_files_inner(&dir, out, seen, depth + 1);
        if out.len() >= MAX_FILES {
            return;
        }
    }
}

/// Compact project layout for the explore sub-agent's system prompt: a
/// breadth-first listing ("dir/: entries") of the workspace, hidden entries and
/// SKIP_DIRS pruned, capped per directory and by `budget` bytes (whole lines
/// only, so Persian names never get sliced). It hands the model REAL paths up
/// front instead of letting it guess with glob.
pub fn layout_snapshot(root: &str, budget: usize) -> String {
    const MAX_NAMES_PER_DIR: usize = 60;
    const MAX_DEPTH: usize = 3;
    let root_path = Path::new(root);
    let mut out = String::new();
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> = std::collections::VecDeque::new();
    queue.push_back((root_path.to_path_buf(), 0));
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<(String, bool)> = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let is_dir = entry.path().is_dir();
            if is_dir && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            names.push((name, is_dir));
        }
        names.sort();
        let rel = dir.strip_prefix(root_path).unwrap_or(&dir).to_string_lossy().to_string();
        let label = if rel.is_empty() { "./".to_string() } else { format!("{rel}/") };
        let total = names.len();
        let shown: Vec<String> = names
            .iter()
            .take(MAX_NAMES_PER_DIR)
            .map(|(n, d)| {
                let n: String = n.chars().take(60).collect();
                if *d { format!("{n}/") } else { n }
            })
            .collect();
        let mut line = format!("{label}: {}", shown.join(", "));
        if total > MAX_NAMES_PER_DIR {
            line.push_str(&format!(", … (+{} more)", total - MAX_NAMES_PER_DIR));
        }
        line.push('\n');
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
        if depth + 1 < MAX_DEPTH {
            for (n, d) in &names {
                if *d {
                    queue.push_back((dir.join(n), depth + 1));
                }
            }
        }
    }
    out
}

/// Locate the rg binary. The packaged macOS app inherits a minimal PATH
/// (no /opt/homebrew/bin), so probe the common install locations before
/// giving up — the agent's grep tool depends on ripgrep.
fn rg_binary() -> String {
    // Probed once per process: every grep used to spawn an extra `rg --version`.
    static RG: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RG.get_or_init(|| {
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
    })
    .clone()
}

/// Grep file contents via the ripgrep binary (rg) — parallel search,
/// .gitignore-aware, far faster than the in-process walker below.
/// No fallback (per user request): rg must be on PATH; a missing binary
/// surfaces as a clear error instead of silently degrading to the walker.
/// Output mirrors the walker's format: `rel:\n` headers, `>` marker on
/// the match line, ±`context` context lines (callers pass it; the sub-agent
/// default is 1), long lines truncated.
pub fn grep_scope(
    root: &Path,
    scope: &str,
    pattern: &str,
    include: &str,
    max_results: usize,
    context: usize,
    ignore_case: bool,
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
    // Context is a cost multiplier per hit: 3 was hardcoded, so every match
    // cost 7 lines of output — the single biggest source of grep tokens.
    // Callers now ask for what they need (the explore default is 1).
    let ctx = context.min(5);
    let mut cmd = std::process::Command::new(rg_binary());
    cmd.current_dir(&search_dir)
        .arg("--json")
        .arg("--line-number")
        .arg("--max-count")
        .arg(cap.to_string())
        .arg("--no-messages");
    if ctx > 0 {
        cmd.arg("--context").arg(ctx.to_string());
    }
    // Case-insensitive matching was forced ON, which inflates the match set
    // (and the output) for searches whose casing is already known. Opt in.
    if ignore_case {
        cmd.arg("--ignore-case");
    }
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
    // Index in `pending` of the first match dropped because the cap was reached.
    // Everything from there on belongs to that dropped match (its before/after
    // context), so the block is cut at that index. `--max-count` is per FILE,
    // so later files kept emitting context after the global cap was hit and the
    // output ended with blocks that had NO match in them — pure waste.
    let mut drop_from: Option<usize> = None;
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
            drop_from = None;
        } else if kind == "match" || kind == "context" {
            let text = ev["data"]["lines"]["text"]
                .as_str()
                .unwrap_or_default()
                .trim_end_matches('\n')
                .to_string();
            let line_no = ev["data"]["line_number"].as_u64().unwrap_or(0);
            if kind == "match" {
                if hits >= cap {
                    if drop_from.is_none() {
                        drop_from = Some(pending.len());
                    }
                    continue;
                }
                hits += 1;
            }
            pending.push((kind == "match", line_no, text));
        } else if kind == "end" {
            if let Some(cut) = drop_from {
                pending.truncate(cut);
            }
            // A block is worth printing only while it still CONTAINS a match:
            // context lines of a dropped match carry no information the model
            // can act on and cost tokens on every later step of the turn.
            let has_match = pending.iter().any(|(is_match, _, _)| *is_match);
            if has_match && !current_file.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&current_file);
                out.push_str(":\n");
                for (is_match, line_no, text) in &pending {
                    let marker = if *is_match { ">" } else { " " };
                    // Char-boundary-safe: a raw byte slice panics (and with
                    // panic=abort kills the app) on a multi-byte Persian char.
                    let body = truncated_line(text);
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

/// Translate a glob like `*.{ts,tsx}`, `**/*.test.py` or `src/**/mod.rs` into
/// a regex. `**/` matches ZERO or more directories (so `**/server.py` also
/// matches a root-level `server.py` — it used to demand at least one parent
/// dir and silently missed top-level files), `*` never crosses a `/`.
fn glob_to_regex(glob: &str) -> regex::Regex {
    let mut pat = String::from("^");
    let mut chars = glob.chars().peekable();
    let mut brace_depth = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        pat.push_str("(?:.*/)?");
                    } else {
                        pat.push_str(".*");
                    }
                } else {
                    pat.push_str("[^/]*");
                }
            }
            '?' => pat.push_str("[^/]"),
            '{' => {
                brace_depth += 1;
                pat.push_str("(?:");
            }
            '}' if brace_depth > 0 => {
                brace_depth -= 1;
                pat.push(')');
            }
            ',' if brace_depth > 0 => pat.push('|'),
            '.' | '(' | ')' | '[' | ']' | '^' | '$' | '+' | '|' | '\\' | '}' => {
                pat.push('\\');
                pat.push(c);
            }
            other => pat.push(other),
        }
    }
    pat.push('$');
    regex::Regex::new(&pat).unwrap_or_else(|_| regex::Regex::new("^$").unwrap())
}

/// A file matches when the glob hits its path relative to the glob SCOPE (what
/// the model naturally writes for `path=src-tauri, pattern=src/*`), its path
/// relative to the workspace root, or its bare file name (`*.ts` finds nested
/// files the way `**/*.ts` users expect).
fn glob_matches(re: &regex::Regex, rel_scope: &str, rel_root: &str, name: &str) -> bool {
    re.is_match(rel_scope) || re.is_match(rel_root) || re.is_match(name)
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
    // A missing scope used to fall through to an empty walk and answer a
    // plain "no matches" — the model then burned calls guessing path spellings.
    if !scope_abs.exists() {
        return Err(format!(
            "path does not exist: {scope} — use a real directory from the project layout in your prompt"
        ));
    }
    if scope_abs.is_file() {
        return Err(format!("path is a file, not a directory: {scope}"));
    }
    let re = glob_to_regex(pattern);
    let mut files = Vec::new();
    collect_files(&scope_abs, &mut files);
    let mut out = Vec::new();
    for file in files {
        let rel = file.strip_prefix(&root_real).unwrap_or(&file).to_string_lossy().to_string();
        let rel_scope = file.strip_prefix(&scope_abs).unwrap_or(&file).to_string_lossy().to_string();
        let name = file.file_name().unwrap_or_default().to_string_lossy().to_string();
        if glob_matches(&re, &rel_scope, &rel, &name) {
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

/// Read a file's current content for diffing before an edit. A missing or
/// unreadable file yields an empty string (a brand-new write_file then diffs
/// as pure additions).
pub fn read_pre_edit(root: &str, path: &str) -> Option<String> {
    let target = resolve_safe(root, path, false, None).ok()?;
    fs::read_to_string(target).ok()
}

/// Minimal unified diff (`--- a/…` / `+++ b/…` + one hunk with 3 context
/// lines). Not a minimal-edit LCS diff: the common prefix/suffix is trimmed
/// and the changed middle is emitted as -old/+new — exact, cheap, and enough
/// for the Review panel and the frontend's hunk parser.
pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut pre = 0usize;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < a.len() - pre
        && suf < b.len() - pre
        && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    if pre == a.len() && pre == b.len() {
        return String::new(); // identical content
    }
    const CTX: usize = 3;
    let head_start = pre.saturating_sub(CTX);
    let del = &a[pre..a.len() - suf];
    let add = &b[pre..b.len() - suf];
    let tail_end = (a.len() - suf + CTX).min(a.len());
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        head_start + 1,
        (pre - head_start) + del.len() + suf,
        head_start + 1,
        (pre - head_start) + add.len() + suf
    ));
    for l in &a[head_start..pre] {
        out.push(' ');
        out.push_str(l);
        out.push('\n');
    }
    for l in del {
        out.push('-');
        out.push_str(l);
        out.push('\n');
    }
    for l in add {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    for l in &a[a.len() - suf..tail_end] {
        out.push(' ');
        out.push_str(l);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    #[test]
    fn unified_diff_marks_changed_middle() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
        let new = "a\nb\nc\nD\ne\nf\ng\nh\ni\nj\nk\nl\n";
        let d = unified_diff("f.txt", old, new);
        assert!(d.starts_with("--- a/f.txt\n+++ b/f.txt\n"));
        assert!(d.contains("-d\n+D\n"));
        assert!(d.contains("@@ -"));
    }

    #[test]
    fn unified_diff_new_file_is_all_additions() {
        let d = unified_diff("n.txt", "", "hello\n");
        assert!(d.contains("+hello\n"));
        assert!(!d.contains("\n-"));
    }

    #[test]
    fn unified_diff_identical_is_empty() {
        assert_eq!(unified_diff("x.txt", "same\n", "same\n"), "");
    }
}

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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
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
    let cap = MAX_TERMINAL_OUTPUT * 2;
    let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let drained = Arc::new(AtomicUsize::new(0));
    let mut readers = 0usize;

    // Drain both pipes on their own threads. A blocking `read` on the child's
    // stdout used to keep the timeout check below unreachable: a command that
    // writes nothing (`sleep 100000`, a prompt waiting on stdin) never returned
    // from `read`, so `timeout_secs` was dead code and the turn hung forever
    // (blocking a tokio worker with it, since this runs inline in the agent
    // loop). The single shared cap covers BOTH streams — the stderr side
    // previously had no cap at all, so a noisy child grew this buffer without
    // bound until the timeout.
    if let Some(mut s) = child.stdout.take() {
        let sink = output.clone();
        let done = drained.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = sink.lock().unwrap_or_else(|e| e.into_inner());
                        if guard.len() >= cap {
                            break;
                        }
                        guard.extend_from_slice(&buf[..n]);
                    }
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        });
        readers += 1;
    }
    if let Some(mut s) = child.stderr.take() {
        let sink = output.clone();
        let done = drained.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = sink.lock().unwrap_or_else(|e| e.into_inner());
                        if guard.len() >= cap {
                            break;
                        }
                        guard.extend_from_slice(&buf[..n]);
                    }
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        });
        readers += 1;
    }

    let mut overflowed = false;
    let timed_out = loop {
        if start.elapsed() > deadline {
            break true;
        }
        match child.try_wait() {
            Ok(Some(_)) => break false,
            // Still running (or the wait itself failed) — keep polling.
            Ok(None) | Err(_) => {}
        }
        // Once either stream filled the cap there is nothing left to gain by
        // waiting: the child is killed below, which also closes the pipes.
        let full = output.lock().map(|o| o.len() >= cap).unwrap_or(false);
        if full {
            overflowed = true;
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    if timed_out || overflowed {
        // Kill on BOTH exits. The old code broke out of the read loop without
        // killing, then blocked in `wait()` on a child that could never exit
        // because nobody was draining its full pipe — a permanent hang plus an
        // orphaned `sh`/`yes`.
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;

    // Let the readers flush the tail, but never wait on them indefinitely: a
    // background grandchild (`sleep 100 &`) keeps the pipe open after `sh`
    // died, so a blocking join would reintroduce the hang. Detached reader
    // threads parked on such a pipe are bounded and harmless.
    let flush_deadline = Instant::now() + Duration::from_millis(300);
    while drained.load(Ordering::Relaxed) < readers && Instant::now() < flush_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }

    let output = output.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut text = String::from_utf8_lossy(&output).to_string();
    if text.len() > MAX_TERMINAL_OUTPUT {
        let mut cut = text.len() - MAX_TERMINAL_OUTPUT;
        // Move forward to a char boundary — slicing mid-char panics on
        // Persian / emoji / U+FFFD output.
        while cut < text.len() && !text.is_char_boundary(cut) {
            cut += 1;
        }
        text = format!("…[head truncated]\n{}", &text[cut..]);
    }
    if timed_out {
        // In-band timeout (Ok), exactly like before the fix, so the model can
        // react to it instead of seeing a tool error.
        return Ok(format!(
            "ERROR: command timed out after {timeout_secs}s\n{text}"
        ));
    }
    if overflowed {
        // The old code `break`ed out of the read loop without killing the child
        // and then parked in `wait()` on a child whose full pipe nobody was
        // draining — a permanent deadlock plus a leaked process.
        return Ok(format!(
            "ERROR: command output exceeded the {cap} byte limit and was killed\n{text}"
        ));
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
/// LSP-backed tools (lsp_*) and MCP connector tools are routed by the agent
/// loop before this dispatcher; unknown names reaching here are a real error.
pub fn dispatch(root: &str, name: &str, args: &Value, permit: Option<&Value>) -> Result<String, String> {
    dispatch_with_data_root(root, name, args, permit, None)
}

/// Same as [`dispatch`], but the skill and connector tools resolve their store
/// against `data_root` instead of the workspace root.
///
/// Both stores live in the DATA root (`~/.codifa/skills`, `~/.codifa/mcp`),
/// never in the workspace. The system-prompt catalog is built from the data
/// root, so resolving `load_skill` against the workspace listed an EMPTY store:
/// every on-demand load answered `skill not found: X. Available: (none)` even
/// though the catalog just above it advertised that very skill (found in a real
/// trace). The same root mismatch made `create_mcp` write connectors into
/// `<workspace>/mcp` where nothing reads them. `None` keeps the previous
/// behaviour, which the tool tests rely on (they build the store inside their
/// own temp root).
/// The body block for one skill, shared by the by-name and by-query paths.
fn skill_body(sk: &Value) -> String {
    let files: Vec<&str> = sk["files"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = format!(
        "===== SKILL: {} =====\nDescription: {}\n",
        sk["name"].as_str().unwrap_or_default(),
        sk["description"].as_str().unwrap_or_default()
    );
    if !files.is_empty() {
        out.push_str(&format!(
            "Extra files: {} — load a specific file with load_skill(file=<name>) only when needed.\n",
            files.join(", ")
        ));
    }
    out.push_str(&format!("\n{}\n", sk["content"].as_str().unwrap_or_default()));
    out
}

/// Skill names to suggest after a miss, bounded (`SKILL_LIST_MAX`) so a big
/// store cannot flood the turn that failed to find one skill.
fn available_hint(all: &[Value]) -> String {
    let names: Vec<&str> = all.iter().filter_map(|sk| sk["name"].as_str()).collect();
    if names.is_empty() {
        return "(none)".to_string();
    }
    if names.len() <= SKILL_LIST_MAX {
        return names.join(", ");
    }
    format!(
        "{} … (and {} more — load_skill with query=<words> searches all of them)",
        names[..SKILL_LIST_MAX].join(", "),
        names.len() - SKILL_LIST_MAX
    )
}

/// Everything about one skill a search query is matched against: name, slug,
/// description and the user's own `fa_keywords` — a Persian word has to find
/// its skill exactly as it does in the prompt catalog.
fn skill_haystack(sk: &Value) -> String {
    let mut hay = String::new();
    for key in ["name", "slug", "description", "plugin"] {
        if let Some(v) = sk[key].as_str() {
            hay.push_str(v);
            hay.push(' ');
        }
    }
    if let Some(kw) = sk["fa_keywords"].as_array() {
        for k in kw.iter().filter_map(Value::as_str) {
            hay.push_str(k);
            hay.push(' ');
        }
    }
    hay.to_lowercase()
}

/// Find a skill by words when the prompt's catalog does not cover the task.
///
/// The catalog is byte-capped, so a store with hundreds of skills cannot list
/// them all — this is the way in for everything it had to leave out: every
/// installed skill is scored against the query's words, and the best hit's body
/// comes back, so the model spends one call instead of guessing a name it was
/// never shown.
fn search_skills(store_base: &str, query: &str) -> Result<String, String> {
    // Word-boundary split (`is_alphanumeric` is Unicode-aware, so Persian words
    // survive whole). One-character words are dropped: they match everything.
    let terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 1)
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Err(format!("load_skill query {query:?} has no word to search for"));
    }
    let all = crate::skill_router::load_skills(store_base);
    let mut scored: Vec<(usize, &Value)> = all
        .iter()
        .filter_map(|sk| {
            let hay = skill_haystack(sk);
            let score = terms.iter().filter(|t| hay.contains(t.as_str())).count();
            (score > 0).then_some((score, sk))
        })
        .collect();
    // Best hit first; `sort_by` is stable, so ties keep the store's own order
    // and the same query always answers the same thing.
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    match scored.len() {
        0 => Err(format!(
            "no skill matches {query:?}. Available: {}",
            available_hint(&all)
        )),
        // Exactly one skill fits the words: returning its body saves the model
        // the second call it would have spent naming it.
        1 => Ok(skill_body(scored[0].1)),
        _ => {
            let mut out = String::from(
                "Several skills match — call load_skill again with the `name` of the right one:\n",
            );
            for (_, sk) in scored.iter().take(SKILL_SEARCH_MAX) {
                out.push_str(&format!(
                    "- {}: {}\n",
                    sk["name"].as_str().unwrap_or_default(),
                    sk["description"].as_str().unwrap_or_default().trim()
                ));
            }
            Ok(out)
        }
    }
}

pub fn dispatch_with_data_root(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
) -> Result<String, String> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    // Where the skill/connector store lives for THIS call: the data root when
    // the caller knows it, else the workspace root.
    let store_base = match data_root {
        Some(d) if !d.trim().is_empty() => d,
        _ => root,
    };
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
                    out.push_str(&read_window_block(&abs, &path, offset, limit)?);
                }
                return Ok(out);
            }
            let offset = args["offset"].as_u64().unwrap_or(1) as usize;
            // Windowed-read discipline: a whole-file read floods the context
            // and slows the agent down. Cap the default window; larger reads
            // must be explicit (offset/limit).
            let limit = args["limit"].as_u64().unwrap_or(400) as usize;
            read_window_block(&abs, &path, offset, limit)
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
                    "catch-all pattern {joined:?} refused — grep a real token instead \
(to read a file use read with offset/limit)"
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
            // Context lines per hit (default 1 — 3 was hardcoded and tripled the
            // output) and case sensitivity (case-SENSITIVE by default; opt in to
            // ignore_case). These two are grep's biggest token levers.
            let context = args["context"].as_u64().unwrap_or(1).min(5) as usize;
            let ignore_case = args["ignore_case"].as_bool().unwrap_or(false);
            grep_scope(
                Path::new(root),
                &s("path"),
                &joined,
                &s("include"),
                max,
                context,
                ignore_case,
            )
        }
        "find_symbol" => find_symbol(Path::new(root), &s("symbol"), &s("path"), &s("include")),
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
                Ok(format!(
                    "no matches for {pattern:?} under {scope:?}. glob lists FILES only (never directories), skips hidden dirs and node_modules/target/dist/build, and `**/` matches zero or more directories. This answer is final — do not retry variations: use grep, or read a directory path to list its entries."
                ))
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
                // Same size guard as the single-edit path below. Without it the
                // batch form read (and then copied 1-2 more times via
                // replace/replacen) an arbitrarily large file — a multi-GB
                // allocation that froze the UI, while the single-edit form
                // correctly refused with "file too large to edit safely".
                let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
                if meta.len() as usize > MAX_READ_BYTES {
                    return Err("file too large to edit safely".into());
                }
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
        // The schemas advertise `symbol=` (the model rarely knows line/column);
        // it used to be ignored, so position defaulted to 1:0 and every call
        // answered "No definition found". Resolve the symbol to a real position;
        // an explicit `line` is kept as a disambiguation hint.
        "lsp_definition" | "lsp_references" | "lsp_hover" => {
            let file = s("filePath");
            let symbol = s("symbol");
            let (line, character) = if !symbol.trim().is_empty() {
                crate::lsp::locate_symbol(root, &file, symbol.trim(), args["line"].as_i64())?
            } else if let Some(line) = args["line"].as_i64() {
                (line, args["character"].as_i64().unwrap_or(0))
            } else {
                return Err("pass filePath + symbol=<identifier> (preferred), or filePath + line + character".into());
            };
            match name {
                "lsp_definition" => crate::lsp::definition(root, &file, line, character),
                "lsp_references" => crate::lsp::references(root, &file, line, character),
                _ => crate::lsp::hover(root, &file, line, character),
            }
        }
        "lsp_symbols" => crate::lsp::symbols(root, &s("filePath"), &s("query")),
        "lsp_diagnostics" => crate::lsp::diagnostics(root, &s("filePath")),
        // Native memory store (JSONL layer of memory_manager.py).
        "delete_memory" => {
            // Accept both spellings: the schema advertises `memory_id`, but a
            // model copying an id out of a search result often writes `id`.
            let mid = {
                let m = s("memory_id");
                if m.is_empty() { s("id") } else { m }
            };
            let mid = mid.trim();
            if mid.is_empty() {
                return Err("delete_memory requires memory_id (the id from search_memory)".into());
            }
            Ok(if crate::memory::delete(mid) {
                format!("deleted memory {mid}")
            } else {
                format!("no memory with id {mid}")
            })
        }
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
        // Create or update a skill from a command (the Codex/Claude
        // `create_skill` flow). `fa_keywords` is what makes the skill findable
        // from a Persian request: the catalog line carries them, so the model
        // can match the user's own wording without any embedding or classifier.
        "create_skill" => {
            // A repo is an alternative SOURCE for the whole skill: read it first,
            // then hand it to `sync_skill` exactly like a model-written body, so
            // the frontmatter, slug and extra-file rules stay in one place
            // (the same trick `plugins::apply_parts` uses).
            let repo_spec = args["repo"].as_str().unwrap_or("").trim().to_string();
            let from_repo = if repo_spec.is_empty() {
                None
            } else {
                Some(crate::repo::read_skill(
                    &repo_spec,
                    args["repo_path"].as_str().unwrap_or(""),
                    args["repo_ref"].as_str().unwrap_or(""),
                    &s("name"),
                )?)
            };
            let name = if !s("name").trim().is_empty() {
                s("name")
            } else {
                from_repo
                    .as_ref()
                    .and_then(|r| r["name"].as_str())
                    .unwrap_or("")
                    .to_string()
            };
            if name.trim().is_empty() {
                return Err("create_skill requires name (or a repo that names the skill)".into());
            }
            // An empty body is allowed on purpose: `sync_skill` keeps the
            // stored body when one exists and fails only when a NEW skill would
            // be written with nothing in it. A delete, a rename, or a call that
            // only touches an extra file must not have to resend the whole
            // markdown — the old guard rejected exactly those calls.
            let mut content = s("content");
            if content.trim().is_empty() {
                if let Some(r) = &from_repo {
                    content = r["content"].as_str().unwrap_or("").to_string();
                }
            }
            let mut body = json!({
                "name": name,
                "previous_name": s("previous_name"),
                "content": content,
                // Pass the raw JSON through (not `s(...)`, which turns a
                // missing field into ""): `sync_skill` treats null/absent as
                // "keep whatever the file already has", so a model that omits
                // fa_keywords on an EDIT no longer wipes the existing ones.
                "description": args["description"].clone(),
                "fa_keywords": args["fa_keywords"].clone(),
            });
            if let Some(r) = &from_repo {
                // The repo fills only what the call left out.
                for key in ["description", "fa_keywords"] {
                    if body[key].is_null() {
                        body[key] = r[key].clone();
                    }
                }
                if let Some(files) = r["extra_files"].as_object() {
                    if !files.is_empty() {
                        body["extra_files"] = json!(files);
                    }
                }
            }
            if args["delete"].as_bool().unwrap_or(false) {
                body["delete"] = json!(true);
            }
            if let Some(extra) = args["extra_files"].as_object() {
                // Explicit files win over the ones that came with the repo.
                let mut merged = body["extra_files"].as_object().cloned().unwrap_or_default();
                for (k, v) in extra {
                    merged.insert(k.clone(), v.clone());
                }
                body["extra_files"] = json!(merged);
            }
            if let Some(del) = args["deleted_files"].as_array() {
                body["deleted_files"] = json!(del);
            }
            let res = crate::skills::sync_skill(Path::new(store_base), &body)?;
            let name_out = res["name"].as_str().unwrap_or(&name);
            // A skill the model just wrote is the USER's text: mark it so the
            // startup seeder cannot revert it behind their back.
            if let Some(dir) = crate::skills::find_skill_dir_pub(Path::new(store_base), name_out) {
                crate::skills::mark_user_edit(&dir);
            }
            // An empty keyword list leaves the catalog line English-only, so a
            // Persian request has no trigger to find the skill by: the model
            // must be told to fix it instead of believing the save was enough.
            let warning = if res["fa_keyword_count"].as_u64().unwrap_or(0) == 0 {
                "\nWARNING: this skill has NO fa_keywords, so a Persian request has \
                 nothing to find it by. Call create_skill again with fa_keywords set \
                 (comma-separated Persian phrases the user would actually say)."
            } else {
                ""
            };
            Ok(format!(
                "Skill saved: {name_out}\nThe catalog in the system prompt now lists it, so it can be \
                 loaded on demand in later turns.{warning}"
            ))
        }
        // Create or update an MCP connector from a command (the `/create-mcp`
        // flow). A connector is either a stdio server (command + args) or an
        // HTTP one (url), so both shapes are accepted and stored verbatim.
        // Editing an existing connector works two ways: pass the SAME name to
        // overwrite it in place, or pass previous_name to rename it (the old
        // file is removed so no stale duplicate is left behind).
        "create_mcp" => {
            let name = s("name");
            if name.trim().is_empty() {
                return Err("create_mcp requires name".into());
            }
            let mut cfg = serde_json::Map::new();
            let command = s("command");
            let url = s("url");
            if !command.trim().is_empty() {
                cfg.insert("command".into(), json!(command));
                if let Some(args) = args["args"].as_array() {
                    cfg.insert("args".into(), json!(args));
                }
            } else if !url.trim().is_empty() {
                cfg.insert("url".into(), json!(url));
            } else {
                return Err("create_mcp requires either command (stdio) or url (http)".into());
            }
            if let Some(env) = args["env"].as_object() {
                cfg.insert("env".into(), json!(env));
            }
            let prev = s("previous_name");
            if !prev.is_empty() && prev != name {
                let _ = crate::skills::delete_mcp(Path::new(store_base), &json!({"name": prev}));
            }
            let res = crate::skills::save_mcp(
                Path::new(store_base),
                &json!({"name": name, "cfg": Value::Object(cfg)}),
            )?;
            Ok(format!(
                "Connector saved: {}\nEnable it in the composer's MCP picker to use its tools.",
                res["name"].as_str().unwrap_or(&name)
            ))
        }
        // Plugins: one folder bundling skills + MCP connectors behind a single
        // on/off switch (see plugins.rs for the layout). Kept as ONE tool with
        // an `action` multiplexer so the catalog stays short.
        "plugin" => {
            let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            let store = Path::new(store_base);
            match action.as_str() {
                "list" => Ok(crate::plugins::list_plugins(store).to_string()),
                "install" => crate::plugins::install_plugin(store, args).map(|v| v.to_string()),
                "create" => crate::plugins::create_plugin(store, args).map(|v| v.to_string()),
                "update" => crate::plugins::update_plugin(store, args).map(|v| v.to_string()),
                "toggle" => crate::plugins::toggle_plugin(store, args).map(|v| {
                    let on = v["enabled"].as_bool().unwrap_or(false);
                    format!("{}\n{}", if on { "Plugin enabled" } else { "Plugin disabled" }, v)
                }),
                "delete" => crate::plugins::delete_plugin(store, args).map(|v| v.to_string()),
                other => Err(format!(
                    "plugin requires action one of list/install/create/update/toggle/delete (got {other:?})"
                )),
            }
        }
        // Schedules as data: the agent writes the task, the Schedule page only
        // displays it. A task carries its own skills/connectors so a headless
        // run gets the same context as a normal turn.
        "schedule" => {
            let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            let store_base_sched = data_root.ok_or("schedule needs a data root")?;
            let store = Path::new(store_base_sched);
            match action.as_str() {
                "list" => Ok(crate::appstate::list_schedules(store).to_string()),
                "create" | "update" => {
                    let id = s("id");
                    let existing: Option<Value> = if action == "create" {
                        None
                    } else {
                        if id.trim().is_empty() {
                            return Err("update requires the schedule id".into());
                        }
                        match crate::appstate::get_schedule(store, &id) {
                            Some(t) => Some(t),
                            None => return Err(format!("schedule not found: {id}")),
                        }
                    };
                    let mut task = existing.unwrap_or_else(|| json!({}));
                    let obj = task.as_object_mut().expect("task starts as an object");
                    for key in ["name", "prompt", "mode"] {
                        if let Some(v) = args[key].as_str() {
                            if !v.trim().is_empty() {
                                obj.insert(key.into(), json!(v));
                            }
                        }
                    }
                    let root_arg = args["root"].as_str().unwrap_or("").trim();
                    if !root_arg.is_empty() {
                        obj.insert("root".into(), json!(root_arg));
                    } else if action == "create" {
                        obj.insert("root".into(), json!(root));
                    }
                    if let Some(cron) = args["cron"].as_str() {
                        if !cron.trim().is_empty() && !crate::scheduler::is_valid_cron(cron) {
                            return Err(format!("invalid cron expression: {cron}"));
                        }
                        obj.insert("cron".into(), json!(cron.trim()));
                    }
                    if let Some(on) = args["enabled"].as_bool() {
                        obj.insert("enabled".into(), json!(on));
                    }
                    // The run context: skills are names, connectors are names,
                    // plugins are slugs whose skills + connectors are expanded
                    // at run time (see scheduler::execute_schedule).
                    for key in ["skills", "mcp_servers", "plugins"] {
                        if let Some(list) = args[key].as_array() {
                            obj.insert(key.into(), json!(list));
                        }
                    }
                    let saved = crate::appstate::save_schedule(store, task)?;
                    Ok(format!("Schedule saved:\n{saved}"))
                }
                "toggle" => {
                    let id = s("id");
                    let Some(mut task) = crate::appstate::get_schedule(store, &id) else {
                        return Err(format!("schedule not found: {id}"));
                    };
                    let on = args["enabled"]
                        .as_bool()
                        .unwrap_or_else(|| !task["enabled"].as_bool().unwrap_or(true));
                    task["enabled"] = json!(on);
                    let saved = crate::appstate::save_schedule(store, task)?;
                    Ok(format!(
                        "Schedule {}:\n{saved}",
                        if on { "resumed" } else { "paused" }
                    ))
                }
                "delete" => {
                    let id = s("id");
                    if id.trim().is_empty() {
                        return Err("delete requires the schedule id".into());
                    }
                    crate::appstate::delete_schedule(store, &id);
                    Ok(format!("Schedule deleted: {id}"))
                }
                other => Err(format!(
                    "schedule requires action one of list/create/update/toggle/delete (got {other:?})"
                )),
            }
        }
        // Load one stored skill's body on demand: the prompt lists only a slice
        // of the installed skills, so a body costs one tool call instead of
        // carrying all of them in the prompt. `file` reads an extra file of it;
        // `query` searches the WHOLE store, which is what keeps a store with
        // hundreds of skills reachable from a prompt that cannot list them.
        "load_skill" => {
            let name = s("name");
            if name.trim().is_empty() {
                let query = s("query");
                if query.trim().is_empty() {
                    return Err(
                        "load_skill requires name, or query to search the installed skills".into(),
                    );
                }
                return search_skills(store_base, &query);
            }
            let file = s("file");
            if !file.trim().is_empty() {
                // A skill lives either in the standalone store or inside an
                // ENABLED plugin folder, and only this branch needs the plugin
                // dir — so it is resolved here instead of on every call.
                let store = Path::new(store_base);
                let plugin_dir = crate::plugins::plugin_of_skill(store, &name)
                    .and_then(|slug| crate::plugins::find_skill_dir(store, &slug, &name));
                let read = match &plugin_dir {
                    Some(dir) => crate::skills::read_extra_file(dir, &name, &file),
                    None => crate::skills::read_skill_file(store, &name, &file),
                };
                return Ok(read?["content"].as_str().unwrap_or_default().to_string());
            }
            // Same list the catalog is built from (`skill_router::load_skills`),
            // so the NOT-FOUND hint names exactly what the model was shown.
            let all = crate::skill_router::load_skills(store_base);
            let wanted = name.trim().to_lowercase();
            let hit = all.iter().find(|sk| {
                let n = sk["name"].as_str().unwrap_or_default().trim().to_lowercase();
                let slug = sk["slug"].as_str().unwrap_or_default().trim().to_lowercase();
                n == wanted || slug == wanted
            });
            match hit {
                Some(sk) => Ok(skill_body(sk)),
                None => Err(format!(
                    "skill not found: {name}. Available: {}",
                    available_hint(&all)
                )),
            }
        }
        _ => Err(format!("tool {name:?} is not available")),
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
// find_symbol: definition + body + usages of an identifier in ONE call
// ---------------------------------------------------------------------------

const FIND_SYMBOL_MAX_DEFS: usize = 3;
const FIND_SYMBOL_BODY_LINES: usize = 40;
const FIND_SYMBOL_MAX_USAGES: usize = 25;

/// `(path, line, text)` rows from ONE rg run: no context, at most 6 matching
/// lines per file, workspace noise dirs excluded, paths relative to `search_dir`.
fn rg_rows(
    search_dir: &Path,
    target: &str,
    include: &str,
    extra: &[&str],
    pattern: &str,
    limit: usize,
) -> Result<Vec<(String, usize, String)>, String> {
    let mut cmd = std::process::Command::new(rg_binary());
    cmd.current_dir(search_dir)
        .stdin(std::process::Stdio::null())
        .args([
            "--line-number", "--no-heading", "--with-filename", "--color", "never",
            "--no-messages", "--max-count", "6",
        ])
        .args(extra);
    for d in SKIP_DIRS {
        cmd.arg("--glob").arg(format!("!{d}"));
    }
    if !include.is_empty() {
        cmd.arg("--glob").arg(include);
    }
    cmd.arg("-e").arg(pattern).arg("--").arg(target);
    let out = cmd
        .output()
        .map_err(|e| format!("ripgrep (rg) is required but could not be run: {e}"))?;
    // Any exit code 2 from ripgrep means a real failure (bad regex, unreadable
    // path). The main `grep_scope` tool already errors unconditionally on 2; this
    // variant used to swallow it whenever stdout had partial rows, so a broken
    // pattern silently looked like "no definition found".
    if out.status.code() == Some(2) {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "ripgrep failed (exit code 2)".to_string()
        } else {
            err
        });
    }
    let mut rows = Vec::new();
    for l in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = l.splitn(3, ':');
        let (Some(p), Some(n), Some(t)) = (it.next(), it.next(), it.next()) else { continue };
        let Ok(n) = n.parse::<usize>() else { continue };
        rows.push((p.trim_start_matches("./").to_string(), n, t.to_string()));
        if rows.len() >= limit {
            break;
        }
    }
    Ok(rows)
}

fn indent_width(line: &str) -> usize {
    line.chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

/// Last 0-based line of the definition that starts at `start`, found by
/// indentation (language-agnostic): everything deeper than the definition line
/// belongs to it, plus a closing `}` / `end` at the same indent. Signature
/// continuations at the base indent (`) -> T {`, `where`, `{`) are skipped.
fn definition_end(lines: &[&str], start: usize) -> usize {
    let base = indent_width(lines[start]);
    let mut end = start;
    let mut i = start + 1;
    while i < lines.len() {
        let l = lines[i];
        if l.trim().is_empty() {
            i += 1;
            continue;
        }
        let t = l.trim_start();
        let ind = indent_width(l);
        if ind > base {
            end = i;
        } else if ind == base && (t.starts_with(')') || t.starts_with(']') || t.starts_with("where") || t.starts_with('{')) {
            end = i;
        } else {
            if ind == base && (t.starts_with('}') || t == "end" || t.starts_with("end ")) {
                end = i;
            }
            break;
        }
        i += 1;
    }
    end
}

/// Definition(s) with their bodies plus the usages of ONE identifier, in a
/// single call — replaces the grep -> lsp_definition -> lsp_references chain
/// (three model round trips) and needs no language server, so it works for
/// every language. Case-sensitive, whole-word.
pub fn find_symbol(root: &Path, symbol: &str, scope: &str, include: &str) -> Result<String, String> {
    let symbol = symbol.trim();
    if symbol.is_empty() || !symbol.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') {
        return Err(format!(
            "find_symbol takes ONE bare identifier (letters, digits, _ or $), got {symbol:?} — use grep for patterns"
        ));
    }
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let scope_abs = if scope.is_empty() {
        root_real.clone()
    } else {
        resolve_safe(root.to_str().unwrap_or("."), scope, true, None)?
    };
    let (search_dir, target) = if scope_abs.is_file() {
        (
            scope_abs.parent().unwrap_or(&root_real).to_path_buf(),
            scope_abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into()),
        )
    } else {
        (scope_abs.clone(), ".".to_string())
    };

    let esc = regex::escape(symbol);
    let def_pat = format!(
        r"\b(fn|def|class|struct|enum|trait|type|interface|const|static|function|func|let|var|mod)\s+{esc}\b|func\s*\([^)]*\)\s*{esc}\b"
    );
    let (defs, uses) = std::thread::scope(|s| {
        let d = s.spawn(|| rg_rows(&search_dir, &target, include, &[], &def_pat, 20));
        let u = s.spawn(|| rg_rows(&search_dir, &target, include, &["-w", "--fixed-strings"], symbol, 120));
        (d.join().unwrap_or_else(|_| Err("search thread failed".into())), u.join().unwrap_or_else(|_| Err("search thread failed".into())))
    });
    let defs = defs?;
    let uses = uses?;

    let rel = |p: &str| -> String {
        let abs = search_dir.join(p).components().collect::<std::path::PathBuf>();
        abs.strip_prefix(&root_real).unwrap_or(&abs).to_string_lossy().to_string()
    };
    let defs: Vec<(String, usize, String)> = defs.into_iter().map(|(p, n, t)| (rel(&p), n, t)).collect();
    let usages: Vec<(String, usize, String)> = uses
        .into_iter()
        .map(|(p, n, t)| (rel(&p), n, t))
        .filter(|(p, n, _)| !defs.iter().any(|(dp, dn, _)| dp == p && dn == n))
        .collect();

    if defs.is_empty() && usages.is_empty() {
        return Ok(format!(
            "no matches for symbol `{symbol}` (case-sensitive, whole word). This answer is final for this spelling — try another spelling, or grep with a looser pattern."
        ));
    }

    let mut out = format!(
        "find_symbol `{symbol}`: {} definition(s), {} usage(s)\n",
        defs.len(),
        usages.len()
    );
    if !defs.is_empty() {
        out.push_str("\nDEFINITIONS\n");
        for (path, line, text) in defs.iter().take(FIND_SYMBOL_MAX_DEFS) {
            let abs = root_real.join(path);
            let Ok(src) = fs::read_to_string(&abs) else {
                out.push_str(&format!("{path}:{line}  {}\n", text.trim()));
                continue;
            };
            let lines: Vec<&str> = src.lines().collect();
            let start = line.saturating_sub(1).min(lines.len().saturating_sub(1));
            if lines.is_empty() {
                continue;
            }
            let full_end = definition_end(&lines, start);
            let end = full_end.min(start + FIND_SYMBOL_BODY_LINES - 1);
            out.push_str(&format!("{path}:{}-{}\n", start + 1, full_end + 1));
            for (i, l) in lines.iter().enumerate().take(end + 1).skip(start) {
                let shown: String = l.chars().take(200).collect();
                out.push_str(&format!("  {}: {shown}\n", i + 1));
            }
            if full_end > end {
                out.push_str(&format!(
                    "  … (+{} more lines — read {path} offset={} for the rest)\n",
                    full_end - end,
                    end + 2
                ));
            }
        }
        if defs.len() > FIND_SYMBOL_MAX_DEFS {
            out.push_str(&format!("(+{} more definitions, bodies omitted)\n", defs.len() - FIND_SYMBOL_MAX_DEFS));
            for (path, line, text) in defs.iter().skip(FIND_SYMBOL_MAX_DEFS) {
                let shown: String = text.trim().chars().take(140).collect();
                out.push_str(&format!("  {path}:{line}  {shown}\n"));
            }
        }
    }
    if !usages.is_empty() {
        out.push_str("\nUSAGES (definitions excluded; at most 6 per file)\n");
        for (path, line, text) in usages.iter().take(FIND_SYMBOL_MAX_USAGES) {
            let shown: String = text.trim().chars().take(160).collect();
            out.push_str(&format!("{path}:{line}  {shown}\n"));
        }
        if usages.len() > FIND_SYMBOL_MAX_USAGES {
            out.push_str(&format!("(+{} more usages — scope with path/include)\n", usages.len() - FIND_SYMBOL_MAX_USAGES));
        }
    }
    Ok(out)
}


// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;



    /// delete_memory must remove exactly one note by the id search_memory hands
    /// out, answer a plain miss for an unknown id, and refuse an empty id.
    #[test]
    fn delete_memory_dispatch_removes_one_note() {
        let _guard = crate::memory::tests::DATA_DIR_LOCK.lock();
        let data = std::env::temp_dir().join(format!("codifa-delmem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        fs::create_dir_all(&data).unwrap();
        let project = std::env::temp_dir().join(format!("codifa-delmem-proj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(&project).unwrap();
        let prev = std::env::var("CODER_DATA_DIR").ok();
        std::env::set_var("CODER_DATA_DIR", &data);
        let root = project.to_str().unwrap();

        let added = dispatch(root, "save_memory", &json!({"content": "keep this note"}), None).unwrap();
        let id = serde_json::from_str::<Value>(&added).unwrap()["memory"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(dispatch(root, "search_memory", &json!({"query": "note"}), None)
            .unwrap()
            .contains(&id));

        let del = dispatch(root, "delete_memory", &json!({"memory_id": &id}), None).unwrap();
        assert!(del.contains("deleted memory"), "{del}");
        assert_eq!(
            dispatch(root, "search_memory", &json!({"query": "note"}), None).unwrap(),
            "no matching memories"
        );
        // The bare `id` spelling (copied straight from a search hit) works too,
        // and an unknown id is a plain miss rather than an error.
        assert!(dispatch(root, "delete_memory", &json!({"id": "no-such-id"}), None)
            .unwrap()
            .contains("no memory with id"));
        // No id at all is a usage error, never a silent success.
        assert!(dispatch(root, "delete_memory", &json!({}), None).is_err());

        match prev {
            Some(v) => std::env::set_var("CODER_DATA_DIR", v),
            None => std::env::remove_var("CODER_DATA_DIR"),
        }
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&project);
    }

    fn find_symbol_fixture() -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("codifa-findsym-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::create_dir_all(tmp.join("backend")).unwrap();
        fs::create_dir_all(tmp.join("target")).unwrap();
        fs::write(tmp.join("src/compact.rs"), "// compact_history docs\npub async fn compact_history(\n    a: u8,\n) -> u8\nwhere\n    u8: Copy,\n{\n    let x = 1;\n    x\n}\n\nfn other() {}\n").unwrap();
        fs::write(tmp.join("src/main.rs"), "fn main() {\n    compact_history(1);\n    // سلام compact_history\n}\n").unwrap();
        fs::write(tmp.join("backend/srv.py"), "def compact_history(x):\n    y = x\n    return y\n\ndef other():\n    pass\n").unwrap();
        fs::write(tmp.join("backend/g.go"), "package b\nfunc (s *S) Handle(x int) int {\n\treturn x\n}\n").unwrap();
        fs::write(tmp.join("target/junk.rs"), "fn compact_history() {}\n").unwrap();
        tmp
    }

    #[test]
    fn definition_end_handles_rust_signatures_python_and_one_liners() {
        let rs: Vec<&str> = "pub fn f(\n    a: u8,\n) -> u8\nwhere\n    u8: Copy,\n{\n    a\n}\n\nfn g() {}".lines().collect();
        assert_eq!(definition_end(&rs, 0), 7);
        let py: Vec<&str> = "def f(x):\n    y = 1\n\n    return y\n\ndef g():\n    pass".lines().collect();
        assert_eq!(definition_end(&py, 0), 3);
        let one: Vec<&str> = "const A: u8 = 1;\nconst B: u8 = 2;".lines().collect();
        assert_eq!(definition_end(&one, 0), 0);
    }

    #[test]
    fn find_symbol_returns_definitions_with_bodies_and_usages_in_one_call() {
        let tmp = find_symbol_fixture();
        let out = find_symbol(&tmp, "compact_history", "", "").unwrap();
        assert!(out.contains("2 definition(s)") && out.contains("usage(s)"), "{out}");
        // Rust def: whole multi-line signature + body, found by indentation.
        assert!(out.contains("src/compact.rs:2-10"), "{out}");
        assert!(out.contains("  8:     let x = 1;") && out.contains("  10: }"), "{out}");
        // Python def too, and build output (target/) is never searched.
        assert!(out.contains("backend/srv.py:1-3") && !out.contains("target/"), "{out}");
        // Usages exclude the definition lines themselves and keep Persian text intact.
        assert!(out.contains("USAGES") && out.contains("src/main.rs:2  compact_history(1);"), "{out}");
        assert!(out.contains("src/main.rs:3  // سلام compact_history"), "{out}");
        assert!(!out.contains("src/compact.rs:2  "), "definition leaked into usages: {out}");
        // Scoped to one file.
        let one = find_symbol(&tmp, "compact_history", "backend/srv.py", "").unwrap();
        assert!(one.contains("1 definition(s)") && !one.contains("src/compact.rs"), "{one}");
        // Go method receivers count as definitions.
        let go = find_symbol(&tmp, "Handle", "", "*.go").unwrap();
        assert!(go.contains("backend/g.go:2-4"), "{go}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_symbol_rejects_patterns_and_reports_misses_as_final() {
        let tmp = find_symbol_fixture();
        assert!(find_symbol(&tmp, "a.*b", "", "").unwrap_err().contains("bare identifier"));
        assert!(find_symbol(&tmp, "", "", "").is_err());
        let miss = find_symbol(&tmp, "nothing_here_xyz", "", "").unwrap();
        assert!(miss.starts_with("no matches for symbol") && miss.contains("final"), "{miss}");
        assert!(find_symbol(&tmp, "x", "../../etc", "").is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn long_bodies_are_cut_with_a_pointer_to_the_rest() {
        let tmp = std::env::temp_dir().join(format!("codifa-findsym-long-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let mut body = String::from("fn big() {\n");
        for i in 0..100 { body.push_str(&format!("    let v{i} = {i};\n")); }
        body.push_str("}\n");
        fs::write(tmp.join("a.rs"), body).unwrap();
        let out = find_symbol(&tmp, "big", "", "").unwrap();
        assert!(out.contains("a.rs:1-102") && out.contains("more lines — read a.rs offset=41"), "{out}");
        assert!(!out.contains("v90"), "{out}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_window_past_the_end_explains_itself() {
        // A silent blank window made a traced run read offset=100000 of a short
        // file and burn a round guessing why it got nothing.
        let dir = std::env::temp_dir().join(format!("codifa-readwin-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let short = dir.join("short.txt");
        fs::write(&short, "a\nb\nc\n").unwrap();
        let out = read_window(&short, 100000, 400).unwrap();
        assert!(out.contains("past the end") && out.contains("3 lines"), "{out}");
        let empty = dir.join("empty.txt");
        fs::write(&empty, "").unwrap();
        assert!(read_window(&empty, 1, 400).unwrap().contains("is empty"));
        // A directory listing past the end explains itself the same way.
        assert!(list_dir(&dir, 999, 10).unwrap().contains("past the end"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dispatch_routes_find_symbol_with_its_own_args() {
        // The tool is only usable if the dispatcher knows the name AND reads
        // symbol/path/include (not the LSP filePath shape).
        let tmp = find_symbol_fixture();
        let root = tmp.to_str().unwrap();
        let out = dispatch(root, "find_symbol", &json!({"symbol": "compact_history"}), None).unwrap();
        assert!(out.contains("definition(s)") && out.contains("src/compact.rs"), "{out}");
        // path/include scope the search like every other search tool.
        let scoped = dispatch(
            root,
            "find_symbol",
            &json!({"symbol": "Handle", "path": "backend", "include": "*.go"}),
            None,
        )
        .unwrap();
        assert!(scoped.contains("backend/g.go") && !scoped.contains("src/compact.rs"), "{scoped}");
        // A regex is rejected with the bare-identifier hint, not a silent miss.
        let err = dispatch(root, "find_symbol", &json!({"symbol": "a.*b"}), None).unwrap_err();
        assert!(err.contains("bare identifier"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

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
    fn read_window_block_numbers_lines_under_a_range_header() {
            let dir = std::env::temp_dir().join("codifa_read_block_test");
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("sample.txt");
            fs::write(&file, "alpha\nbeta\ngamma\ndelta\n").unwrap();

            // Every line carries its 1-based number under the window's header, so
            // the caller can cite a line without re-reading the file.
            let block = read_window_block(&file, "sample.txt", 2, 2).unwrap();
            assert_eq!(block, "sample.txt (lines 2-3):\n2: beta\n3: gamma\n");

            // offset 0 reads the same first line as offset 1, and the header must
        // not announce a line 0 that no file has.
        let zero = read_window_block(&file, "sample.txt", 0, 1).unwrap();
        assert_eq!(zero, "sample.txt (lines 1-1):\n1: alpha\n");

        // A window past the end still explains itself instead of a blank.
            let past = read_window_block(&file, "sample.txt", 99, 5).unwrap();
            assert!(past.contains("past the end"), "{past}");

            // Long lines are cut at the byte cap without splitting a character.
            let long = format!("{}{}{}", "x".repeat(MAX_LINE_LENGTH - 10), "\u{1F600}", "y".repeat(20));
            fs::write(&file, format!("{long}\n")).unwrap();
            let block = read_window_block(&file, "sample.txt", 1, 1).unwrap();
            assert!(block.ends_with("[truncated]\n"), "{block}");
            assert!(block.contains('\u{1F600}'), "{block}");

            let plain = read_window(&file, 1, 1).unwrap();
            assert!(plain.starts_with("xxxx"), "{plain}");
            assert!(!plain.contains("1: "), "{plain}");

            let _ = fs::remove_dir_all(&dir);
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
    fn grep_scope_drops_context_past_the_cap() {
        // rg's --max-count is per FILE while the cap counts every match, so
        // later files kept emitting context lines after the cap was already
        // hit: the output ended with blocks that had no match marker at all.
        let tmp = std::env::temp_dir().join("codifa-grep-cap-test");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.rs"),
            "hit one\nalpha\nhit two\nbeta\nhit three\ngamma\n",
        )
        .unwrap();
        fs::write(tmp.join("b.rs"), "hit four\ndelta\nhit five\nepsilon\n").unwrap();
        let out = grep_scope(&tmp, "", "hit", "", 3, 1, false).unwrap();
        for block in out.split("\n\n") {
            let body: Vec<&str> = block.lines().skip(1).collect();
            assert!(
                body.is_empty() || body.iter().any(|l| l.starts_with('>')),
                "a context-only block leaked past the cap:\n{out}"
            );
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_scope_finds_matches_with_context() {
        // pid-unique + recreated: the fixture lives in the shared OS temp root,
        // which ripgrep's ignore/`--max-count` walker inspects — a leftover dir
        // from an interrupted run or a concurrent `cargo test` process sharing
        // the fixed name used to make this test flaky (rg reported no matches).
        let tmp = std::env::temp_dir().join(format!("codifa-grep-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub/a.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
        let out = grep_scope(&tmp, "sub", "alpha", "", 10, 1, false).unwrap();
        assert!(out.contains("a.rs"));
        assert!(out.contains(">1: fn alpha"));
        assert!(out.contains("2: fn beta"));
        assert_eq!(
            grep_scope(&tmp, "sub", "zzz_nothing", "", 10, 1, false).unwrap(),
            "no matches"
        );
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
        let out = grep_scope(&tmp, &file_scope, "alpha", "", 10, 1, false).unwrap();
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
    fn glob_double_star_matches_root_level_and_scope_relative() {
        let tmp = std::env::temp_dir().join("codifa-glob-root-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("backend")).unwrap();
        fs::create_dir_all(tmp.join("src-tauri/src")).unwrap();
        fs::write(tmp.join("backend/server.py"), "").unwrap();
        fs::write(tmp.join("src-tauri/src/agent.rs"), "").unwrap();
        // Regression: `**/` demanded a parent dir, so root-level paths never matched.
        let hits = glob_scope(&tmp, "", "**/backend/server.py", 10).unwrap();
        assert_eq!(hits, vec!["backend/server.py".to_string()]);
        // Pattern relative to the scope (path=src-tauri, pattern=src/*).
        let hits = glob_scope(&tmp, "src-tauri", "src/*", 10).unwrap();
        assert_eq!(hits, vec!["src-tauri/src/agent.rs".to_string()]);
        // A missing scope is an error, not a silent "no matches".
        let err = glob_scope(&tmp, "nope", "*.rs", 10).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn layout_snapshot_lists_real_paths_and_skips_noise() {
        let tmp = std::env::temp_dir().join("codifa-layout-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("backend/tests")).unwrap();
        fs::create_dir_all(tmp.join("node_modules/x")).unwrap();
        fs::create_dir_all(tmp.join(".git")).unwrap();
        fs::write(tmp.join("backend/server.py"), "").unwrap();
        fs::write(tmp.join("backend/tests/t.py"), "").unwrap();
        fs::write(tmp.join("package.json"), "").unwrap();
        let snap = layout_snapshot(tmp.to_str().unwrap(), 4000);
        assert!(snap.contains("./: backend/, package.json"), "{snap}");
        assert!(snap.contains("backend/: server.py, tests/"), "{snap}");
        assert!(snap.contains("backend/tests/: t.py"), "{snap}");
        assert!(!snap.contains("node_modules") && !snap.contains(".git"), "{snap}");
        assert!(layout_snapshot(tmp.to_str().unwrap(), 40).len() <= 40);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn lsp_tools_resolve_symbol_or_fail_fast_without_spawning_a_server() {
        let tmp = std::env::temp_dir().join("codifa-lsp-dispatch-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.rs"), "fn alpha() {}\n").unwrap();
        let root = tmp.to_str().unwrap();
        // Neither symbol nor line: clear error instead of a bogus 1:0 lookup.
        let err = dispatch(root, "lsp_definition", &json!({ "filePath": "a.rs" }), None).unwrap_err();
        assert!(err.contains("symbol"), "{err}");
        // Unknown symbol: reported before any language server is started.
        let err = dispatch(root, "lsp_hover", &json!({ "filePath": "a.rs", "symbol": "missing_fn" }), None).unwrap_err();
        assert!(err.contains("not found"), "{err}");
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
