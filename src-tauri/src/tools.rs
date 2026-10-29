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

/// Hard ceiling for a foreground terminal call, whichever side asks for it.
///
/// The schema hands `timeout` to the MODEL, and nothing validated it: a prompt
/// that wanted a long-running monitor once sent a 5400-second foreground call
/// and the tool sat on it for the full 90 minutes while the turn (and the
/// scheduled run row) stayed `running` with no error anywhere. A long job is
/// what `background=true` is for — the schema says so — so a foreground call
/// longer than this is clipped to the ceiling, mirroring the plugin-script
/// ceiling (`SCRIPT_TIMEOUT_MAX` in plugins.rs).
pub const MAX_TERMINAL_TIMEOUT_SECS: u64 = 600;
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

/// Identifiers are what `find_symbol` takes; anything else is grep-only.
///
/// Kept in sync with `find_symbol`'s own input check (bare letters, digits, `_`
/// or `$`), so the hint never sends the model to a tool that would refuse it.
fn is_bare_identifier(sym: &str) -> bool {
    !sym.is_empty() && sym.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// Upper bound on the follow-up hint `grep` appends to its own result.
const GREP_HINT_MAX: usize = 420;

/// Marker prefix of the diagnostics payload `post_edit_diagnostics` appends.
const POST_EDIT_DIAGNOSTICS_MARK: &str = "[language server]";
/// Marker prefix of the `find_symbol` payload `identifier_symbol_block` appends.
const IDENTIFIER_SYMBOL_MARK: &str = "[find_symbol ";
/// Notes the two read-side levers append to their own result, so the ruler can
/// count them as FACT instead of inferring them from the round count.
const READ_MERGED_MARK: &str = "[read] merged ";
const READ_COVERED_MARK: &str = "already returned above";

/// The one line `grep` appends when its own result shows a cheaper next step.
///
/// MEASURED on the traced corpus (118 main grep calls): 53 were followed by a
/// `read` of a file the grep had just listed — 18 of them a window that already
/// included a printed hit line, i.e. a whole round to re-fetch what the model
/// was looking at — and 12 rounds were spent on a pattern that matched NOTHING,
/// with the only two answers being another grep or a read. Both cases come from
/// the result itself, so the hint costs no extra call and rides on the result
/// the model is already reading.
///
/// 23% of those patterns were pure identifier alternations (`TracePanel`,
/// `LLM|TOOL|FOLD`), which `find_symbol` answers in ONE call with definitions,
/// bodies and usages, and which it refuses for anything else — hence the
/// identifier-only guard before naming it.
fn grep_followup_hint(pattern: &str, result: &str) -> String {
    // A miss is the loudest signal: the file does not contain it, so the next
    // guess must be a different NAME, not a wider window of the same file.
    if result.starts_with("no matches") {
        return clip_hint(
            "\n[hint] No hit anywhere in that scope — do not re-read the file to confirm. \
Name the token differently (a sibling symbol, a call site, the type it flows into) or widen \
path/include once; if the name is one identifier, `find_symbol` also reports every USAGE, \
which a grep on a single spelling misses.",
        );
    }
    let alts: Vec<&str> = pattern.split('|').map(str::trim).filter(|p| !p.is_empty()).collect();
    if !alts.is_empty() && alts.iter().all(|a| is_bare_identifier(a)) {
        return clip_hint(&format!(
            "\n[hint] This was a plain identifier search. `find_symbol` answers it in ONE call \
with the definition bodies AND every usage (`symbol`: `{}`), and `lsp_symbols` outlines a file \
instead of reading it — cheaper than following these hits with a read.",
            alts.join("` / `")
        ));
    }
    // Many files hit at once: the cheap move is an outline, not one read each.
    let files: Vec<&str> = result
        .lines()
        .filter(|l| !l.starts_with(' ') && !l.starts_with('>') && l.ends_with(':'))
        .map(|l| l.trim_end_matches(':'))
        .collect();
    if files.len() >= 4 {
        let shown = files.iter().take(3).copied().collect::<Vec<_>>().join(", ");
        return clip_hint(&format!(
            "\n[hint] {} files matched: {shown}. Read only the one the task names — \
`lsp_symbols` outlines it first (or `find_symbol` if you can name the symbol) instead of \
reading several of them.",
            files.len()
        ));
    }
    String::new()
}

/// Diagnostics that ride along with a successful edit, or an empty string.
///
/// MEASURED: `lsp_diagnostics` was NEVER called in the traced corpus (0 of
/// 1_035 tool calls) while the model ran 37 manual typecheck/build commands,
/// 12 of them in the round right after an edit — each one a whole round-trip
/// on a question a warm language server already knows. Asking the model to
/// pick the tool did not work, so the cheap case is decided HERE: a LIVE
/// server for the file's language answers inline, and a cold one is skipped
/// entirely (starting rust-analyzer would turn a cheap edit into a stall).
///
/// Bounded like every other tool result: the window it rides on is small, and
/// a server that lists dozens of errors must not blow the edit's own budget.
fn post_edit_diagnostics(root: &str, path: &str) -> String {
    const POST_EDIT_DIAGNOSTICS_CAP: usize = 2_000;
    let Some(text) = crate::lsp::diagnostics_if_warm(root, path) else {
        return String::new();
    };
    // "No diagnostics" is worth saying: it is the answer that saves the
    // typecheck round. The "did not answer in time" text is NOT — the model
    // cannot act on it better than on silence, and it would nag on every edit.
    let useful = !text.contains("No diagnostics report arrived within");
    if !useful || text.trim().is_empty() {
        return String::new();
    }
    let shown: String = text.chars().take(POST_EDIT_DIAGNOSTICS_CAP).collect();
    let cut = if shown.chars().count() < text.chars().count() { "…" } else { "" };
    format!("\n\n{POST_EDIT_DIAGNOSTICS_MARK} {shown}{cut}")
}

/// The `find_symbol` answer for a pure-identifier grep, appended to the result.
///
/// MEASURED: 53 of 118 traced main greps were followed by a `read` of a file
/// the grep itself had just listed, and 19 of the grep patterns were pure
/// identifiers — the exact question `find_symbol` answers with definition
/// bodies AND every usage, without a language server. Naming the tool in prose
/// was already tried and refuted (423 of 863 rounds carried the hint text and
/// the following rounds stayed single-call), so the cheap answer is fetched
/// HERE: the round is spent either way, and this one hands the model the
/// usages a single-spelling grep cannot see.
///
/// Skipped on a miss (the hint covers that case) and bounded, because this
/// rides on a result the model is already paying for.
fn identifier_symbol_block(root: &str, pattern: &str, result: &str) -> String {
    const SYMBOL_BLOCK_CAP: usize = 2_500;
    if result.starts_with("no matches") {
        return String::new();
    }
    let alts: Vec<&str> = pattern.split('|').map(str::trim).filter(|p| !p.is_empty()).collect();
    // Several alternatives mean several different questions; only a single
    // identifier has one definite answer to fetch.
    if alts.len() != 1 || !is_bare_identifier(alts[0]) {
        return String::new();
    }
    let Ok(text) = find_symbol(Path::new(root), alts[0], "", "") else {
        return String::new();
    };
    if text.starts_with("no matches") {
        return String::new();
    }
    let shown: String = text.chars().take(SYMBOL_BLOCK_CAP).collect();
    let cut = if shown.chars().count() < text.chars().count() { "\n…(truncated)" } else { "" };
    format!("\n\n{IDENTIFIER_SYMBOL_MARK}{0} — same round, no extra call]\n{shown}{cut}", alts[0])
}

/// Which DETERMINISTIC levers fired on this call, for the trace row.
///
/// Every lever attaches its payload to the result the model already pays for, so
/// the marker is right there in the text and reading it back is exact. Inferring
/// "the hint probably fired" from the round count is what the corpus REFUTED:
/// 423 of 863 rounds carried the single-call hint and the following rounds were
/// single-call anyway.
pub(crate) fn levers_fired(name: &str, result: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    if matches!(name, "edit_file" | "write_file") && result.contains(POST_EDIT_DIAGNOSTICS_MARK) {
        out.push("post_edit_diagnostics");
    }
    // A writer that landed on a file read earlier in the same step: its result
    // carries the stale-source note steering the model off the pre-edit copy.
    if matches!(name, "edit_file" | "write_file") && result.contains(POST_EDIT_STALE_NOTE) {
        out.push("stale_source_note");
    }
    if name == "grep" && result.contains(IDENTIFIER_SYMBOL_MARK) {
        out.push("identifier_grep_symbol");
    }
    // Read-side levers: several windows of one file collapsed into their union
    // before a byte was read, and a read whose windows were already on the wire
    // answered with a pointer instead of the same lines again.
    if name == "read" && result.contains(READ_MERGED_MARK) {
        out.push("read_windows_merged");
    }
    if name == "read" && result.contains(READ_COVERED_MARK) {
        out.push("read_already_served");
    }
    out
}

/// Bound a `grep` follow-up hint, on a char boundary.
///
/// The hint rides on the tool result the model is already paying for, so a
/// pathological pattern (hundreds of alternations) must not be able to grow the
/// result past its own budget.
fn clip_hint(hint: &str) -> String {
    if hint.chars().count() <= GREP_HINT_MAX {
        return hint.to_string();
    }
    let cut = hint
        .char_indices()
        .nth(GREP_HINT_MAX)
        .map(|(i, _)| i)
        .unwrap_or(hint.len());
    format!("{}…", &hint[..cut])
}
const MAX_LINE_LENGTH: usize = 2000;

/// Directories never descended into during workspace scans.
const SKIP_DIRS: &[&str] = &[
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
fn absolute_target_from(root_real: &Path, raw: &str) -> Result<PathBuf, String> {
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

/// The user-level data folder (CODER_DATA_DIR or ~/.codifa) — readable AND
/// writable without a permission prompt when `allow_coder` is set: plugins and
/// skills LIVE here, so refusing writes burned a traced round on "path escapes
/// project root" for every plugin/skill update.
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
    let meta = fs::metadata(abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // A guessed filename returning a bare ENOENT made the model retry
            // blind (traced: 2 rounds on a typo'd/guessed path). Name the
            // siblings so the retry lands first try.
            let dir = abs.parent().map(|p| p.display().to_string()).unwrap_or_default();
            let listing = read_window(abs.parent().unwrap_or(Path::new(".")), 0, 30)
                .unwrap_or_else(|_| "(directory not readable)".into());
            format!(
                "file not found: {} (no such file)\nreal files in {dir}:\n{listing}",
                abs.file_name().and_then(|p| p.to_str()).unwrap_or("?")
            )
        } else {
            format!("file not found: {e}")
        }
    })?;
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
    read_window_block_capped(abs, label, offset, limit, usize::MAX)
}

/// Smallest useful share one window gets inside a batch. Below this a block is
/// only a header, which reads as "nothing here" and costs a round trip to
/// disprove — so a batch that cannot afford a real window says so instead.
const READ_BLOCK_MIN: usize = 1_200;

/// Default window of a `read` that names no offset/limit. One definition, used
/// by the dispatch arm AND by the repeat-guard's coverage check, so the two can
/// never disagree about which lines a call actually asked for.
pub(crate) const DEFAULT_READ_OFFSET: usize = 1;
pub(crate) const DEFAULT_READ_LIMIT: usize = 400;

/// The (file, offset, limit) entries a `read` call asks for, with the same
/// defaults the dispatch arm applies.
///
/// `ranges` is the batch spelling (an entry without `path` inherits the
/// top-level one), `paths` is the legacy list that shares one window, and a
/// bare `filePath` is the single-window form. Empty when the call names no file
/// at all — the caller decides whether that is an error or simply no coverage.
pub(crate) fn read_windows_of(args: &Value) -> Vec<(String, usize, usize)> {
    let top = args["filePath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| args["path"].as_str().unwrap_or_default())
        .to_string();
    let num = |v: &Value, fallback: usize| v.as_u64().map(|n| n as usize).unwrap_or(fallback);
    let mut out = Vec::new();
    if let Some(ranges) = args["ranges"].as_array() {
        for r in ranges {
            let file = r["path"].as_str().unwrap_or(top.as_str());
            if file.is_empty() {
                continue;
            }
            out.push((
                file.to_string(),
                num(&r["offset"], DEFAULT_READ_OFFSET),
                num(&r["limit"], DEFAULT_READ_LIMIT),
            ));
        }
        return out;
    }
    if let Some(paths) = args["paths"].as_array() {
        for p in paths.iter().filter_map(Value::as_str) {
            out.push((
                p.to_string(),
                num(&args["offset"], DEFAULT_READ_OFFSET),
                num(&args["limit"], DEFAULT_READ_LIMIT),
            ));
        }
        return out;
    }
    if !top.is_empty() {
        out.push((
            top,
            num(&args["offset"], DEFAULT_READ_OFFSET),
            num(&args["limit"], DEFAULT_READ_LIMIT),
        ));
    }
    out
}

/// Collapse a `read` batch into the non-overlapping union of its windows, one
/// span per file, keeping the order the model asked in.
///
/// A batch is one model call and one prompt re-send, so overlapping entries are
/// paid twice for lines the model asked for once: traced on the real corpus, 42
/// batches carried overlapping windows of the SAME file (6_928 lines — ~381K
/// chars — delivered twice inside a single call), because the model stitches a
/// file together from the pieces a precedent grep or report named. Merging is
/// lossless — the union contains every requested line, and each line is sent
/// exactly once — and it needs no state, so nothing can go stale.
///
/// Windows separated by no more than `GAP` lines merge too: the joined block
/// costs a few unrequested lines but saves a second header and, on the corpus,
/// the extra round the model spent reading the seam between two adjacent spans.
fn merge_read_targets(targets: Vec<(String, usize, usize)>) -> Vec<(String, usize, usize)> {
    /// Largest gap between two windows of one file that still merges: adjacent
    /// (`(1,130)` then `(130,120)`) and near-adjacent windows are what a model
    /// emits when it walks a file top-down.
    const GAP: usize = 20;
    let mut order: Vec<String> = Vec::new();
    let mut by_file: std::collections::HashMap<String, Vec<(usize, usize)>> =
        std::collections::HashMap::new();
    for (file, offset, limit) in targets {
        // The span is offset+limit, with no normalisation: `dispatch` treats an
        // explicit `limit: 0` as zero lines, so inflating it here would serve
        // (and charge for) lines the caller did not ask for.
        let span = (offset, offset.saturating_add(limit));
        if !by_file.contains_key(&file) {
            order.push(file.clone());
        }
        by_file.entry(file).or_default().push(span);
    }
    let mut out = Vec::new();
    for file in order {
        let mut spans = by_file.remove(&file).unwrap_or_default();
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in spans {
            match merged.last_mut() {
                Some(last) if start <= last.1 + GAP => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        for (start, end) in merged {
            out.push((file.clone(), start, end - start));
        }
    }
    out
}

/// `read_window_block` with a char budget for THIS block.
///
/// The turn loop caps every tool result at `agent::MODEL_RESULT_CAP` before it
/// reaches the model, and that cap is a flat TAIL cut. A batched `read` merges
/// several windows into one string, so any batch of 4+ windows silently lost
/// its last windows: traced on the real corpus, 4 of the 5 capped reads were
/// followed by the SAME file again (10, 7, 6 and 3 extra reads on
/// backend_light.rs, plugins.ts, repo.rs and TVKit.mq5) — the batch defeated
/// itself and bought a round trip instead of saving one. Spending the budget
/// per window keeps every window represented and tells the model exactly how to
/// fetch the remainder.
pub fn read_window_block_capped(
    abs: &Path,
    label: &str,
    offset: usize,
    limit: usize,
    budget: usize,
) -> Result<String, String> {
    if abs.is_dir() {
        return read_window(abs, offset, limit);
    }
    match file_window(abs, offset, limit)? {
        Window::Lines(lines) => Ok(numbered_window_capped(label, offset.max(1), &lines, budget)),
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

/// `numbered_window` that never exceeds `budget` chars, and says so when it
/// cannot show everything.
///
/// Without the marker a cut window is indistinguishable from a short file and
/// the model re-reads it to find out. The marker names the exact next offset, so
/// the remainder is one cheap call instead of a guess.
fn numbered_window_capped(label: &str, first_line: usize, lines: &[String], budget: usize) -> String {
    let full = numbered_window(label, first_line, lines);
    if full.chars().count() <= budget {
        return full;
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    // The header is kept even when the body is cut: without it the block reads
    // as "this file has nothing here", and the caller cannot even tell WHICH
    // window answered.
    let mut out = format!("{label} (lines {first_line}-{last}):\n");
    let header_len = out.chars().count();
    for (i, line) in lines.iter().enumerate() {
        let next = format!("{:>width$}: {line}\n", first_line + i, width = width);
        // Reserve room for the trailer so the marker itself is never the part
        // that gets cut: it is the only thing telling the model where to resume.
        if header_len + out.chars().count() + next.chars().count() + READ_TRUNCATION_RESERVE > budget {
            let shown_to = first_line + i - 1;
            // A budget too small for even one line must still say why.
            if i == 0 {
                return format!(
                    "{label} (lines {first_line}-{last}): (window too large for the result budget — \
read it with a smaller limit, e.g. offset={first_line} limit=80)\n"
                );
            }
            out.push_str(&format!(
                "… (window truncated at line {shown_to} of {last}: these lines did not fit the \
result budget. Read the rest with offset={} limit={} — do not re-read what is shown here)\n",
                shown_to + 1,
                last - shown_to + 1
            ));
            return out;
        }
        out.push_str(&next);
    }
    out
}

/// Room kept back for the truncation marker in `numbered_window_capped`.
const READ_TRUNCATION_RESERVE: usize = 160;

/// Char budget of the current-text window a failed edit may carry.
///
/// The window replaces a round-trip, so it must stay small enough that the
/// failure message itself never trips the model-result cap.
const NEAREST_HINT_BUDGET: usize = 1_200;

/// Lines of context printed on each side of the closest match.
const NEAREST_HINT_CONTEXT: usize = 4;

/// Marker stamped on a successful writer's result when a `read`/`grep` of the
/// SAME file ran EARLIER IN THE SAME STEP (batch readers run before the
/// sequential writers). Measured in trace `mvpk9qxx` run=106: that pre-edit
/// lookup kept its pre-edit text on the wire, the model rebuilt `old_string`
/// from it and the edit failed 4 rounds in a row. The note tells the model its
/// copy is stale NOW — one line, no content removed.
pub(crate) const POST_EDIT_STALE_NOTE: &str =
    "\n[stale-source note] a `read`/`grep` of this SAME file ran earlier IN THIS STEP, before \
this edit landed; the text it returned is outdated. Treat only the post-edit state (or a \
fresh `grep`/window read) as truth, never that earlier result.";

/// Minimum shared-word ratio for showing a window at all. MEASURED at 0.5 the
/// window kept a stale-edit loop alive: a traced run failed the same edit 4
/// times because the "closest match" it was pointed at (score ~0.6) was the
/// wrong neighbourhood — the model's copy came from a pre-edit grep elsewhere
/// in the file. Only a near-exact line is copyable text; anything weaker means
/// the model's copy is stale and it needs the current text from a tool call.
const NEAREST_HINT_FLOOR: f64 = 0.75;

/// Whitespace-insensitive form of a line: runs of whitespace become one space.
fn squeeze(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A window of the file's CURRENT text around the place a missing `old_string`
/// was probably taken from, for `edit_file`'s failure message.
///
/// MEASURED: of 25 traced edit failures, 20 sent text the file no longer had
/// (the model was working from a stale copy) and the bare "old_string not found"
/// gave it nothing to work with — 4 answered by re-reading the whole file, and
/// the rest by re-sending the same stale batch, at a median of 2 extra rounds
/// per failure. A small window of the real text costs one call's worth of chars
/// and lets the model fix the string in place.
///
/// Matching is deliberately cheap and local: the first non-blank line of the
/// missing text is compared with every line (whitespace-normalised, then by
/// shared-word ratio) and the best line above the floor is shown with its
/// neighbours under real line numbers. Below the floor the copy the model
/// holds is stale, so no window is printed — a sentence instead names the
/// staleness and points at a cheap `grep`/window read, which is what breaks
/// the measured retry loop (4 failed edits off one pre-edit grep).
fn nearest_hint(content: &str, old_string: &str) -> String {
    let probe = match old_string.lines().find(|l| !l.trim().is_empty()) {
        Some(l) => squeeze(l),
        None => return String::new(),
    };
    if probe.is_empty() {
        return String::new();
    }
    let probe_words: Vec<&str> = probe.split_whitespace().collect();
    let lines: Vec<&str> = content.lines().collect();
    let mut best: Option<(f64, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let norm = squeeze(line);
        if norm.is_empty() {
            continue;
        }
        let score = if norm == probe {
            1.0
        } else {
            let line_words: Vec<&str> = norm.split_whitespace().collect();
            let shared = probe_words.iter().filter(|w| line_words.contains(w)).count();
            shared as f64 / probe_words.len().max(line_words.len()) as f64
        };
        if score >= NEAREST_HINT_FLOOR && best.is_none_or(|(b, _)| score > b) {
            best = Some((score, i));
        }
    }
    let Some((_, hit)) = best else {
        // No confident match means the string was rebuilt from a stale copy
        // (the pre-edit read/grep still in the context above): pointing at any
        // window would anchor the model to ANOTHER wrong neighbourhood, which
        // is exactly the measured 4-round loop. Steer to the current text
        // instead — one cheap lookup, then the edit lands.
        return " Your copy of this file is STALE — it predates an edit above this turn. \
Do NOT resend this old_string and do NOT reconstruct it from the earlier `read`/`grep` \
result: `grep` for its distinctive token with path= the file (or `read` a narrow window \
with ranges), and build old_string from THAT output."
            .to_string();
    };
    let start = hit.saturating_sub(NEAREST_HINT_CONTEXT);
    let end = (hit + NEAREST_HINT_CONTEXT + 1).min(lines.len());
    let numbered: Vec<String> = lines[start..end].iter().map(|l| (*l).to_string()).collect();
    let window = numbered_window_capped("current text", start + 1, &numbered, NEAREST_HINT_BUDGET);
    format!(
        " The text you sent is not in the file any more — your earlier `read`/`grep` of it is \
out of date now. Copy the exact string from the CURRENT text below \
(do NOT re-read the whole file: a small window covers it):\n{window}"
    )
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
        const CANDIDATES: &[&str] = &[
            "rg",
            "/opt/homebrew/bin/rg",
            "/usr/local/bin/rg",
            // The login shell's PATH (where the app-bundle PATH misses Homebrew
            // et al.) — the same source the terminal inherits, so `grep` cannot
            // die with ENOENT while `run_terminal` finds the same binary.
            // Measured: a live grep failed "No such file or directory" while
            // /opt/homebrew/bin/rg existed (mvscczhm r40).
        ];
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
        // Last resort: the merged login-shell PATH (the same source the
        // terminal inherits), so `grep` cannot die with ENOENT while
        // `run_terminal` finds the same binary. Measured: a live grep failed
        // "No such file or directory" while /opt/homebrew/bin/rg existed
        // (mvscczhm r40).
        for dir in crate::shell_env::shell_path().split(':') {
            if dir.is_empty() {
                continue;
            }
            let cand = std::path::Path::new(dir).join("rg");
            if std::process::Command::new(&cand)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return cand.to_string_lossy().into_owned();
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
    grep_scope_in(root, scope, pattern, include, max_results, context, ignore_case, None)
}

/// `grep_scope` with the turn's out-of-workspace permit: a scope the user
/// approved has to be searchable, or the grant is a promise the backend breaks.
#[allow(clippy::too_many_arguments)]
pub fn grep_scope_in(
    root: &Path,
    scope: &str,
    pattern: &str,
    include: &str,
    max_results: usize,
    context: usize,
    ignore_case: bool,
    permit: Option<&Value>,
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
        resolve_safe(root.to_str().unwrap_or("."), scope, true, permit)?
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
    glob_scope_in(root, scope, pattern, max_results, None)
}

/// `glob_scope` with the turn's out-of-workspace permit (see `grep_scope_in`).
pub fn glob_scope_in(
    root: &Path,
    scope: &str,
    pattern: &str,
    max_results: usize,
    permit: Option<&Value>,
) -> Result<Vec<String>, String> {
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let scope_abs = if scope.is_empty() {
        root_real.clone()
    } else {
        resolve_safe(root.to_str().unwrap_or("."), scope, true, permit)?
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
    // `true`: ~/.codifa (plugins, skills) is the agent's own store — writing it
    // without a popup is the same trust reading already has.
    let target = resolve_safe(root, path, true, permit)?;
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
    let target = resolve_safe(root, path, true, permit)?;
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
        return Err(format!(
            "old_string not found in file.{}",
            nearest_hint(&content, old_string)
        ));
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
    // Second belt beside the dispatch-side clamp: EVERY caller of this
    // function (plugin scripts included) is bounded by the same ceiling, so a
    // future caller cannot re-open the hole the dispatch clamp closed.
    let timeout_secs = {
        let clamped = timeout_secs.min(MAX_TERMINAL_TIMEOUT_SECS);
        if clamped != timeout_secs {
            eprintln!(
                "[tool] run_terminal: caller asked for {timeout_secs}s; bounded to {clamped}s"
            );
        }
        clamped
    };
    // The app bundle's PATH misses the user's tool dirs (cargo lived outside
    // it), so `cargo`-class calls died with `command not found` and each one
    // billed a repair round. Inherit the LOGIN-shell PATH, probed once.
    static LOGIN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let login_path = LOGIN_PATH.get_or_init(crate::shell_env::shell_path);
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(root)
        .env("PATH", login_path)
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
    // An empty body is a dead end, not an answer: a traced round ran
    // `cargo run … 2>/dev/null` with `cargo` off PATH, the redirect threw the
    // only diagnostic away, and the model spent a whole round-trip (18 160
    // input tokens, 17 152 cached) to learn nothing. Say so in-band, and name
    // the redirect as the likely culprit so the next round fixes the command.
    if text.trim().is_empty() && !timed_out && !overflowed {
        if status.success() {
            return Ok(format!(
                "The command exited successfully but produced NO output (stdout and stderr were both empty). Do not repeat it unchanged: if you redirected a stream (`2>/dev/null`, `>/dev/null`), drop the redirect so the error or result is visible, and check the binary is on PATH."
            ));
        }
        return Ok(format!(
            "EXIT CODE: {}\nThe command FAILED but produced no output — its stderr was redirected away or empty. Re-run it WITHOUT `2>/dev/null` so the real error is visible.",
            status.code().unwrap_or(-1)
        ));
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

/// Warn when a bundle was written with skills no Persian request can reach.
///
/// A skill's trigger is its `fa_keywords`, and the model only sees a JSON blob of
/// names — it cannot tell a bundle that routes from one that does not. So EVERY
/// write says it outright (install, create AND update), so a bundle made in chat
/// is as findable as one installed from a marketplace. The warning rides AFTER
/// the JSON so the reply stays machine-readable up to the first newline.
fn plugin_keyword_warning(store: &Path, view: &Value) -> String {
    let Some(slug) = view["slug"].as_str() else {
        return String::new();
    };
    let bare: Vec<String> = view["skills"]
        .as_array()
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| crate::plugins::skill_keyword_count(store, slug, name) == 0)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if bare.is_empty() {
        return String::new();
    }
    format!(
        "\nWARNING: these skills have NO fa_keywords, so a Persian request has nothing to find \
         them by: {}. Send another plugin call with action=update and fa_keywords per skill (the \
         user's own Persian phrases), or set fa_keywords on the plugin itself so a skill with \
         none of its own still triggers through the bundle.",
        bare.join(", ")
    )
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
    // Bounded discovery — the ONE place every search passes through, so no
    // caller (main agent, sub-agent, MCP) can flood a context by accident.
    //
    // Measured on the traced corpus: 67% of all tool calls are raw search, and
    // the explore sub-agent re-sends every result on each of its ~4 rounds, so
    // 14.98M result chars (~3.74M tokens) were paid again and again. Two of the
    // three search verbs also default to a WIDER window than any agent needs:
    // `grep` handed back 50 hits with a context line each, `glob` up to 100
    // paths. The model asked for none of that — it asked for one hit list.
    //
    // Only the DEFAULT shrinks. An explicit bigger `max_results` still wins, so
    // nothing becomes impossible; the model pays for size only when it says so.
    let search = |k: &str, fallback: u64| -> usize {
        args[k].as_u64().unwrap_or(fallback) as usize
    };
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
            // Batching lives in `ranges`: every entry carries its own file AND
            // its own window, so several KNOWN files still cost ONE call (a main
            // round re-sends the whole conversation for ~7.7K uncached tokens
            // against ~26K for a narrow `explore` delegation) — and no file can
            // be named twice with one shared window forced on all of them.
            //
            // `paths` is a legacy spelling that is NOT advertised any more. It
            // is normalised here rather than refused: a stale transcript must
            // not burn a round trip, and the shared dedupe below removes the
            // repeated file the old form allowed.
            let mut targets: Vec<(String, usize, usize)> = Vec::new();
            if let Some(ranges) = args["ranges"].as_array() {
                for r in ranges {
                    let file = r["path"].as_str().unwrap_or(path.as_str()).to_string();
                    if file.is_empty() {
                        return Err(
                            "read: a `ranges` entry names no file — give every entry a `path` (or pass one top-level filePath)".into(),
                        );
                    }
                    targets.push((
                        file,
                        r["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize,
                        r["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize,
                    ));
                }
            } else if let Some(paths) = args["paths"].as_array() {
                if paths.is_empty() {
                    return Err("read: `paths` was empty — pass `ranges` entries instead".into());
                }
                let offset = args["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize;
                let limit = args["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize;
                for p in paths.iter().filter_map(Value::as_str) {
                    targets.push((p.to_string(), offset, limit));
                }
            }
            if !targets.is_empty() {
                // A batch whose top-level `filePath` names a DIRECTORY resolves
                // each RELATIVE `ranges` entry against it. MEASURED
                // (mvrv45fv r0+r29): `filePath=<src dir>` with
                // `path:"secrets.rs"` fell back to the workspace root, every
                // window died with ENOENT, and each one cost a retry round.
                if !path.is_empty() {
                    if let Ok(abs_dir) = resolve_safe(root, &path, true, permit) {
                        if abs_dir.is_dir() {
                            let base = abs_dir.to_string_lossy().trim_end_matches('/').to_string();
                            for t in targets.iter_mut() {
                                if !t.0.starts_with('/') && !t.0.starts_with('~') && !t.0.is_empty() {
                                    t.0 = format!("{base}/{}", t.0);
                                }
                            }
                        }
                    }
                }
                // Overlapping windows of one file collapse into their union
                // (see `merge_read_targets`) before a single byte is read, so
                // the model never pays twice for lines it asked for once.
                let asked = targets.len();
                let targets = merge_read_targets(targets);
                let collapsed = asked.saturating_sub(targets.len());
                let mut out = String::new();
                // Every window gets an equal share of the one budget the turn
                // loop will enforce anyway (`MODEL_RESULT_CAP`): a flat tail cut
                // would drop the last windows of any 4+ entry batch, which is
                // what made a traced batch re-read its own file 10 times.
                let per_block = (crate::agent::MODEL_RESULT_CAP / targets.len().max(1))
                    .max(READ_BLOCK_MIN);
                for (file, offset, limit) in targets {
                    let abs = resolve_safe(root, &file, true, permit)?;
                    // An image has no text window: hand back a marker the turn
                    // loop turns into a real image block, instead of the byte-cap
                    // refusal this read used to end in.
                    if let Some(note) = crate::commands::image_read_note(&abs.to_string_lossy()) {
                        if !out.is_empty() {
                            out.push_str("\n\n");
                        }
                        out.push_str(&note);
                        continue;
                    }
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                    out.push_str(&read_window_block_capped(&abs, &file, offset, limit, per_block)?);
                }
                // The note rides on the result the model already pays for: it
                // says the collapse happened (so the ruler counts it as FACT) and
                // stops the model from re-asking for a window it just received.
                if collapsed > 0 {
                    out.push_str(&format!(
                        "\n{READ_MERGED_MARK}{collapsed} overlapping window(s) of the same file \
into one union — those lines are all above; do NOT re-read them]"
                    ));
                }
                return Ok(out);
            }
            // `filePaths` is the oldest batch spelling; it points at `ranges`.
            if path.is_empty() && args["filePaths"].is_array() {
                return Err(
                    "read takes one filePath — to read several files or several windows in ONE call pass ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":400},…]".into(),
                );
            }
            let offset = args["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize;
            // Windowed-read discipline: a whole-file read floods the context
            // and slows the agent down. Cap the default window; larger reads
            // must be explicit (offset/limit).
            let limit = args["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize;
            let abs = resolve_safe(root, &path, true, permit)?;
            // Same as the batch path above: an image file is described, never
            // windowed.
            if let Some(note) = crate::commands::image_read_note(&abs.to_string_lossy()) {
                return Ok(note);
            }
            // A single window gets the same budget as one batch entry: a file
            // window larger than the model cap used to be cut by the turn loop
            // with no marker at all (the traced TVKit.mq5 read came back as
            // 16_086 of 17_534 chars, and the model re-read it 3 times).
            read_window_block_capped(&abs, &path, offset, limit, crate::agent::MODEL_RESULT_CAP)
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
            let max = search("max_results", 20);
            // Context lines per hit (default 1 — 3 was hardcoded and tripled the
            // output) and case sensitivity (case-SENSITIVE by default; opt in to
            // ignore_case). These two are grep's biggest token levers.
            let context = args["context"].as_u64().unwrap_or(1).min(5) as usize;
            let ignore_case = args["ignore_case"].as_bool().unwrap_or(false);
            let result = grep_scope_in(
                Path::new(root),
                &s("path"),
                &joined,
                &s("include"),
                max,
                context,
                ignore_case,
                permit,
            )?;
            Ok(format!(
                "{result}{}{}",
                identifier_symbol_block(root, &joined, &result),
                grep_followup_hint(&joined, &result)
            ))
        }
        "find_symbol" => {
            find_symbol_in(Path::new(root), &s("symbol"), &s("path"), &s("include"), permit)
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
            let max = search("max_results", 40);
            let hits = glob_scope_in(Path::new(root), &scope, &pattern, max, permit)?;
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
                // `true`: plugin trees live under ~/.codifa — traced batch edits
                // there died on "path escapes project root".
                let target = resolve_safe(root, &path, true, permit)?;
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
                // ONE bad entry must not throw away the good ones. Measured on
                // the live corpus: 8 of 84 batch edits failed this way and each
                // cost a median of 2 extra rounds (18 rounds total, 4 of them a
                // blind re-read of the same file) — the model had no idea which
                // edits had landed, so it re-sent the whole batch. Apply what
                // applies, write it, and name exactly what did not.
                let mut applied = 0usize;
                let mut failures: Vec<String> = Vec::new();
                // The current-text window rides on the FIRST missing entry only.
                // One window is what the model needs (it fixes one string at a
                // time), and keeping the other failures bare bounds the whole
                // message at ~one window instead of one per failure.
                let mut hint: Option<String> = None;
                for (idx, item) in edits.iter().enumerate() {
                    let old = item["old_string"].as_str().unwrap_or_default();
                    let new = item["new_string"].as_str().unwrap_or_default();
                    let all = item["replace_all"].as_bool().unwrap_or(false);
                    if old.is_empty() {
                        failures.push(format!("edit {}/{}: old_string is empty", idx + 1, edits.len()));
                        continue;
                    }
                    if old == new {
                        failures.push(format!(
                            "edit {}/{}: old_string and new_string are identical",
                            idx + 1,
                            edits.len()
                        ));
                        continue;
                    }
                    let occ = content.matches(old).count();
                    if occ == 0 {
                        failures.push(format!("edit {}/{}: old_string not found", idx + 1, edits.len()));
                        if hint.is_none() {
                            hint = Some(nearest_hint(&content, old));
                        }
                        continue;
                    }
                    if occ > 1 && !all {
                        failures.push(format!(
                            "edit {}/{}: old_string appears {occ} times — make it unique",
                            idx + 1,
                            edits.len()
                        ));
                        continue;
                    }
                    content = if all { content.replace(old, new) } else { content.replacen(old, new, 1) };
                    applied += 1;
                }
                if applied > 0 {
                    fs::write(&target, &content).map_err(|e| format!("cannot write file: {e}"))?;
                }
                let suffix = hint.unwrap_or_default();
                if failures.is_empty() {
                    return Ok(format!(
                        "Successfully edited {path} ({} edits applied).{}",
                        edits.len(),
                        post_edit_diagnostics(root, &path)
                    ));
                }
                if applied == 0 {
                    return Err(format!("no edit applied to {path}. {}{suffix}", failures.join("; ")));
                }
                return Ok(format!(
                    "PARTIAL edit of {path}: {applied}/{} edits were applied and WRITTEN; {} failed and were NOT applied — send ONLY the failed one(s) next, copying the text as it is in the file AFTER these edits: {}{suffix}{}",
                    edits.len(),
                    failures.len(),
                    failures.join("; "),
                    post_edit_diagnostics(root, &path)
                ));
            }
            let edit = edit_file(
                root,
                &path,
                &s("old_string"),
                &s("new_string"),
                args["replace_all"].as_bool().unwrap_or(false),
                permit,
            )?;
            Ok(format!("{edit}{}", post_edit_diagnostics(root, &path)))
        }
        "run_terminal" => {
            let requested = args["timeout"].as_u64().unwrap_or(120);
            // Validation at the boundary: the MODEL picks this number via the
            // schema, and an unclamped large value pinned a worker for the
            // whole of it (a scheduled monitor call ran 90 minutes with the
            // run row parked on "running" and not one line in rust.log).
            // Long jobs belong in `background=true` terminals, so anything
            // past the ceiling is CLAMPED, not failed.
            let timeout = requested.min(crate::tools::MAX_TERMINAL_TIMEOUT_SECS);
            if timeout != requested {
                eprintln!(
                    "[tool] run_terminal: requested timeout {requested}s exceeds the {}s ceiling; \
clamped to {timeout}s (long jobs must use background=true)",
                    crate::tools::MAX_TERMINAL_TIMEOUT_SECS
                );
            }
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
            // A delete is answered by the bundle writer: the skill's folder is
            // removed, and a bundle that held ONLY that skill goes with it.
            if body["delete"].as_bool().unwrap_or(false) {
                return crate::plugins::delete_bundle_skill(Path::new(store_base), &name)
                    .map(|_| format!("Skill deleted: {name}"));
            }
            let res = crate::plugins::save_bundle_skill(Path::new(store_base), body.clone())?;
            let name_out = body["name"].as_str().unwrap_or(&name).to_string();
            // A skill the model just wrote is the USER's text: mark it so the
            // startup seeder cannot revert it behind their back.
            if let Some(dir) = crate::plugins::skill_dir_for(Path::new(store_base), &name_out) {
                crate::skills::mark_user_edit(&dir);
            }
            // An empty keyword list leaves the catalog line English-only, so a
            // Persian request has no trigger to find the skill by: the model
            // must be told to fix it instead of believing the save was enough.
            //
            // The count is read from the REPLY — it is measured off the file that
            // was actually written. Reading the request instead warned about an
            // edit that omits `fa_keywords` on purpose (which KEEPS the stored
            // list), so the model was told to "fix" a skill that was fine.
            let warning = if res["fa_keyword_count"].as_u64().unwrap_or(0) == 0 {
                "\nWARNING: this skill has NO fa_keywords, so a Persian request has \
                 nothing to find it by. Call create_skill again with fa_keywords set \
                 (comma-separated Persian phrases the user would actually say)."
            } else {
                ""
            };
            Ok(format!(
                "Skill saved: {name_out} (bundle: {})\nThe catalog in the system prompt now lists \
                 it, so it can be loaded on demand in later turns.{warning}",
                res["slug"].as_str().unwrap_or("")
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
            let res = crate::plugins::save_bundle_connector(
                Path::new(store_base),
                &json!({"name": name, "previous_name": prev, "cfg": Value::Object(cfg)}),
            )?;
            Ok(format!(
                "Connector saved: {} (bundle: {})\nIt reaches the agent while that bundle is on.",
                name,
                res["slug"].as_str().unwrap_or("")
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
                "install" => crate::plugins::install_plugin(store, args).map(|v| {
                    let warning = plugin_keyword_warning(store, &v["plugin"]);
                    format!("{v}{warning}")
                }),
                // Creating and updating a bundle writes skills exactly like an
                // install does, so both say the same thing when they land bare.
                "create" => crate::plugins::create_plugin(store, args).map(|v| {
                    let warning = plugin_keyword_warning(store, &v);
                    format!("{v}{warning}")
                }),
                "update" => crate::plugins::update_plugin(store, args).map(|v| {
                    let warning = plugin_keyword_warning(store, &v);
                    format!("{v}{warning}")
                }),
                "toggle" => crate::plugins::toggle_plugin(store, args).map(|v| {
                    let on = v["enabled"].as_bool().unwrap_or(false);
                    format!("{}\n{}", if on { "Plugin enabled" } else { "Plugin disabled" }, v)
                }),
                "delete" => crate::plugins::delete_plugin(store, args).map(|v| v.to_string()),
                "run" => crate::plugins::run_plugin_script(store, args).map(|v| v.to_string()),
                other => Err(format!(
                    "plugin requires action one of list/install/create/update/toggle/delete/run \
                     (got {other:?})"
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
                    // plugins are slugs whose skills + scripts + connectors are
                    // expanded at run time (see scheduler::execute_schedule).
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
    find_symbol_in(root, symbol, scope, include, None)
}

/// `find_symbol` with the turn's out-of-workspace permit (see `grep_scope_in`).
pub fn find_symbol_in(
    root: &Path,
    symbol: &str,
    scope: &str,
    include: &str,
    permit: Option<&Value>,
) -> Result<String, String> {
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
        resolve_safe(root.to_str().unwrap_or("."), scope, true, permit)?
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

    #[test]
    fn terminal_timeout_is_clamped_to_the_ceiling() {
        // The MODEL picks `timeout` via the schema; a monitor-style prompt once
        // sent 5400 and the foreground call sat on it for 90 minutes with the
        // run row parked on "running". The clamp (not the model) decides.
        assert_eq!(
            run_terminal("/tmp", "echo ok", MAX_TERMINAL_TIMEOUT_SECS + 3_600)
                .unwrap()
                .trim(),
            "ok"
        );
    }

    /// Every `plugin` action that WRITES a bundle must say when it landed bare.
    ///
    /// A skill's Persian trigger is its `fa_keywords`, and the model only sees a
    /// JSON blob of names — so a bundle built by `action=create` (which is what
    /// `/plugin create` hands to the agent) was written and reported as a plain
    /// success, leaving a bundle no Persian request could ever reach. The warning
    /// is what makes the model fill them in the same turn.
    #[test]
    fn every_plugin_write_warns_about_skills_left_without_keywords() {
        let root = std::env::temp_dir().join(format!("codifa-plugin-warn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let base = root.to_str().unwrap();

        // create: a skill with a description and NO keywords is exactly the case
        // the model must be told about.
        let made = dispatch_with_data_root(
            base,
            "plugin",
            &json!({
                "action": "create",
                "name": "Bare Bundle",
                "skills": [{"name": "Bare Skill", "content": "BODY"}]
            }),
            None,
            Some(base),
        )
        .unwrap();
        assert!(made.contains("WARNING"), "create must warn: {made}");
        assert!(made.contains("Bare Skill"), "the bare skill must be named: {made}");
        // The reply stays machine-readable: the JSON comes FIRST, the warning after.
        let first_line = made.lines().next().unwrap();
        let parsed: Value = serde_json::from_str(first_line).expect("line 1 is still JSON");
        assert_eq!(parsed["slug"], json!("bare-bundle"));

        // update: fixing the skill through the tool must clear the warning.
        let fixed = dispatch_with_data_root(
            base,
            "plugin",
            &json!({
                "action": "update",
                "name": "Bare Bundle",
                "skills": [{"name": "Bare Skill", "fa_keywords": "مهارت لخت"}]
            }),
            None,
            Some(base),
        )
        .unwrap();
        assert!(!fixed.contains("WARNING"), "keywords now present: {fixed}");

        // A read-only action answers plainly — no warning to react to.
        let listed = dispatch_with_data_root(
            base,
            "plugin",
            &json!({"action": "list"}),
            None,
            Some(base),
        )
        .unwrap();
        assert!(!listed.contains("WARNING"), "list writes nothing: {listed}");

        let _ = fs::remove_dir_all(&root);
    }

    /// A grep result must name the cheaper next step when its own output shows one.
    ///
    /// MEASURED: 53 of 118 main greps were followed by a read of a file the grep
    /// had just listed (18 of them re-fetching a window that already contained a
    /// printed hit line) and 12 rounds were spent on a pattern that matched
    /// nothing. The three cases below are exactly those, and the fourth pins the
    /// silent case so a plain word search never grows a hint it cannot pay for.
    #[test]
    fn grep_appends_a_followup_hint_only_when_it_pays() {
        // A miss: never answer with a re-read of the same file.
        let miss = grep_followup_hint("no_such_token_xyz", "no matches");
        assert!(miss.contains("do not re-read"), "{miss}");

        // Identifier-only patterns are what `find_symbol` takes.
        let ident = grep_followup_hint("TracePanel", "src/a.ts:\n 12: class TracePanel {}\n");
        assert!(ident.contains("find_symbol"), "{ident}");
        let alt = grep_followup_hint("LLM|TOOL|FOLD", "src/a.rs:\n 3: const LLM: u8 = 1;\n");
        assert!(alt.contains("find_symbol"), "{alt}");

        // A regex/word pattern is grep-only: no identifier hint, but a many-file
        // result still points at an outline instead of one read per file.
        let many = "a.rs:\n 1: x\nb.rs:\n 2: x\nc.rs:\n 3: x\nd.rs:\n 4: x\ne.rs:\n 5: x\n";
        let wide = grep_followup_hint("fn\\s+[a-z]+", many);
        assert!(wide.contains("5 files matched"), "{wide}");
        assert!(!wide.contains("plain identifier"), "{wide}");

        // A small scoped result needs no advice at all.
        let quiet = grep_followup_hint("fn\\s+x", "a.rs:\n 1: fn x() {}\n");
        assert!(quiet.is_empty(), "{quiet}");

        // The hint can never outgrow its budget, whatever the pattern looks like.
        let huge: String = (0..400).map(|i| format!("sym{i}|")).collect();
        let clipped = grep_followup_hint(&huge, "a.rs:\n 1: x\n");
        assert!(clipped.chars().count() <= GREP_HINT_MAX + 1, "{}", clipped.chars().count());
    }

    /// An identifier grep must arrive WITH its `find_symbol` answer attached.
    ///
    /// MEASURED: 53 of 118 main greps were followed by a read of a file the grep
    /// had just listed, and 19 patterns were bare identifiers — one `find_symbol`
    /// answers those. Naming the tool in prose was refuted (423 of 863 rounds
    /// carried the hint and the next rounds stayed single-call), so the answer is
    /// fetched IN the grep round. The guards below pin why it stays silent for
    /// everything else: a multi-alternative pattern asks several questions, a
    /// miss is already covered by the miss hint, and a regex is not an identifier.
    #[test]
    fn identifier_grep_carries_the_symbol_answer_in_the_same_round() {
        let tmp = std::env::temp_dir().join("codifa-ident-block-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.rs"),
            "pub fn resolve_slot_chain() {}\nfn other() { resolve_slot_chain(); }\n",
        )
        .unwrap();
        let root = tmp.to_str().unwrap();
        let hits = "a.rs:\n 1: pub fn resolve_slot_chain() {}\n";

        // A bare identifier with hits: the block carries definitions AND usages.
        let block = identifier_symbol_block(root, "resolve_slot_chain", hits);
        assert!(block.contains("find_symbol resolve_slot_chain"), "{block}");
        assert!(block.contains("USAGES"), "{block}");

        // A miss is the miss-hint's job — never fetch a symbol twice.
        assert!(identifier_symbol_block(root, "resolve_slot_chain", "no matches").is_empty());
        // Several alternatives ask several questions; only one has a definite answer.
        assert!(identifier_symbol_block(root, "LLM|TOOL", hits).is_empty());
        // A regex/word pattern is grep-only.
        assert!(identifier_symbol_block(root, r"fn\s+x", hits).is_empty());
        // A symbol the workspace does not contain adds nothing.
        assert!(identifier_symbol_block(root, "no_such_symbol_xyz", hits).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The trace flag must name EXACTLY the levers whose payload is in the text.
    ///
    /// The lever was previously judged by the round count alone, and that is how
    /// the textual single-call hint looked effective for eight phases (423 of
    /// 863 rounds carried it and nothing changed). The flag makes "did it fire"
    /// a recorded fact, so it must track the marker, not the tool name.
    #[test]
    fn levers_fired_reads_the_marker_not_the_tool_name() {
        let diag = format!("Successfully edited a.rs (1 edits applied).\n\n{POST_EDIT_DIAGNOSTICS_MARK} a.rs:1:1 error: nope");
        assert_eq!(levers_fired("edit_file", &diag), vec!["post_edit_diagnostics"]);
        // A silent edit (cold server, clean file) must NOT claim the lever.
        assert!(levers_fired("edit_file", "Successfully edited a.rs").is_empty());
        // The stale-source lever: a writer landing on a file read earlier in
        // the same step records it, so the trace can count the loop off
        // `detail.levers` without re-parsing messages.
        let stamped = format!("Successfully edited a.rs{}", POST_EDIT_STALE_NOTE);
        assert_eq!(
            levers_fired("edit_file", &stamped),
            vec!["stale_source_note"]
        );
        assert!(levers_fired("grep", &stamped).is_empty());
        // The marker in the WRONG tool's result is not that tool's lever.
        assert!(levers_fired("read", &diag).is_empty());

        let sym = format!("a.rs:\n 1: fn x() {{}}\n\n{IDENTIFIER_SYMBOL_MARK}x — same round, no extra call]\nUSAGES\n 2: x();");
        assert_eq!(levers_fired("grep", &sym), vec!["identifier_grep_symbol"]);
        // The two read-side levers are counted from their own markers, so the
        // ruler sees "merged N windows" / "already served" as a recorded fact.
        let merged = format!("a.rs (lines 1-400):\n1: x\n{READ_MERGED_MARK}2 overlapping window(s)");
        assert_eq!(levers_fired("read", &merged), vec!["read_windows_merged"]);
        let served = "already returned above — these lines are in your context";
        assert_eq!(levers_fired("read", served), vec!["read_already_served"]);
        // The marker in the WRONG tool's result is not that tool's lever.
        assert!(levers_fired("grep", &merged).is_empty());
        // `find_symbol` in the schema is the MODEL calling it — a different
        // thing from the backend attaching the answer to a grep.
        assert!(levers_fired("grep", "no matches").is_empty());
    }

    /// Post-edit diagnostics must NEVER start a language server.
    ///
    /// A cold `rust-analyzer` (1921 MB, minutes of indexing) would turn a cheap
    /// edit into a stall, so the helper returns silence unless a server is
    /// already warm. This test pins that silence — and the bound, so a server
    /// that lists hundreds of errors cannot blow the edit's own budget.
    #[test]
    fn post_edit_diagnostics_stays_silent_without_a_warm_server() {
        let tmp = std::env::temp_dir().join("codifa-post-edit-diag-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.rs"), "fn a() {}\n").unwrap();
        let root = tmp.to_str().unwrap();

        // No server has ever run for this throwaway project, so this must return
        // the empty string instead of spawning one.
        let quiet = post_edit_diagnostics(root, "a.rs");
        assert!(quiet.is_empty(), "{quiet}");
        // An unusable path is silent too — diagnostics are a bonus, not a failure.
        assert!(post_edit_diagnostics(root, "missing.rs").is_empty());
        assert!(post_edit_diagnostics(root, "../escape.rs").is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A failed edit must hand the model the CURRENT text, not just a line number.
    ///
    /// MEASURED: 20 of 25 traced edit failures sent text the file no longer had,
    /// and the bare "old_string not found" left the model to answer with a full
    /// re-read (4 cases) or a re-sent stale batch (median 2 extra rounds per
    /// failure). Both halves are pinned here: a NEAR-EXACT miss comes back as a
    /// numbered window of the real text, and a weaker miss prints NO window —
    /// pointing at one anchored the model to another wrong neighbourhood (the
    /// traced 4-round loop, run=106) and instead names the staleness and the
    /// cheap lookup that finds the current text.
    #[test]
    fn a_missed_edit_shows_the_current_text_window() {
        let content = "fn alpha() {}\n\n    let total = compute_total(items);\n";

        // A drifted copy of line 3: same start, different wording later on.
        let hint = nearest_hint(content, "let total = compute_sum(items);");
        assert!(hint.contains("current text"), "expected a window, got: {hint}");
        assert!(hint.contains("compute_total"), "expected the real text, got: {hint}");
        assert!(hint.contains("3:"), "expected line numbers, got: {hint}");
        assert!(
            hint.contains("do NOT re-read the whole file"),
            "the window must forbid the re-read it replaces, got: {hint}"
        );

        // Whitespace-only drift: the text IS there, so the real line comes back.
        let ws = nearest_hint(content, "        let total = compute_total(items);");
        assert!(
            ws.contains("compute_total") && ws.contains("current text"),
            "expected the current text for a whitespace drift, got: {ws}"
        );

        // The traced loop, re-created: the model's copy carries the real head
        // of the line and invents the rest (4 of 7 words shared = 0.57, under
        // the 0.75 floor). Pointing at that window is what let the model fail
        // the SAME edit 4 rounds in a row — so only the stale-copy guidance
        // may come back, never a window.
        let half = nearest_hint(
            content,
            "let total = compute_total(items) and then log_the_result_with_a_note;",
        );
        assert!(
            half.contains("STALE") && !half.contains("current text"),
            "a half-matching copy must get the stale guidance, not a window, got: {half}"
        );

        // Nothing recognisable in the file: the model's copy is stale, so NO
        // window is printed — pointing at one would anchor it to another wrong
        // neighbourhood (the measured 4-round edit-fail loop). The guidance
        // instead sends the model to the CURRENT text with a cheap lookup.
        let none = nearest_hint(content, "a_completely_unrelated_statement_xyz");
        assert!(
            none.contains("STALE") && none.contains("grep") && none.contains("old_string"),
            "expected stale-copy guidance, got: {none}"
        );
        assert!(
            !none.contains("current text"),
            "no window must be printed below the floor, got: {none}"
        );
    }


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
    fn a_big_batch_keeps_every_window_instead_of_dropping_the_last_ones() {
        // Measured on the real corpus: 5 of 61 `read` calls hit the flat 16_000
        // char model cap, and 4 of those were followed by the SAME file again
        // (backend_light.rs 10x, plugins.ts 7x, repo.rs 6x, TVKit.mq5 3x). The
        // batch merged several windows into one string and the tail cut removed
        // the last files outright, so the model re-read what it had just asked
        // for — a batch that costs a round trip instead of saving one.
        let dir = std::env::temp_dir().join(format!("codifa-readbig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 8 files x 120 lines of ~60 chars => ~60K chars, far past the 16K cap.
        let mut ranges = Vec::new();
        for i in 0..8 {
            let name = format!("f{i}.txt");
            let body: String = (1..=120).map(|l| format!("file{i} line{l} {}\n", "x".repeat(40))).collect();
            fs::write(dir.join(&name), body).unwrap();
            ranges.push(json!({"path": name, "offset": 1, "limit": 120}));
        }
        let root = dir.to_str().unwrap().to_string();
        let out = dispatch(&root, "read", &json!({"ranges": ranges}), None).unwrap();

        // Every one of the 8 windows is represented — none silently vanished.
        for i in 0..8 {
            assert!(
                out.contains(&format!("f{i}.txt (lines")),
                "window {i} was dropped from the batch"
            );
        }
        // The whole result still respects the one budget the turn loop enforces.
        assert!(
            out.chars().count() <= crate::agent::MODEL_RESULT_CAP,
            "batch produced {} chars, over the model cap",
            out.chars().count()
        );
        // What had to be cut says exactly where to resume.
        assert!(
            out.contains("window truncated at line") && out.contains("offset="),
            "a cut window must name its resume offset, got: {out}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overlapping_windows_of_one_file_merge_into_their_union() {
        // Traced on the real corpus: 42 batches carried overlapping windows of
        // the SAME file (6_928 lines ~ 381K chars delivered twice inside one
        // call), because the model stitches a file together from the pieces a
        // precedent grep or report named. The union is lossless.
        let merged = merge_read_targets(vec![
            ("a.rs".into(), 100, 50),
            ("a.rs".into(), 120, 80),
            ("a.rs".into(), 9000, 20),
            ("b.rs".into(), 1, 400),
        ]);
        assert_eq!(
            merged,
            vec![
                ("a.rs".to_string(), 100, 100),
                ("a.rs".to_string(), 9000, 20),
                ("b.rs".to_string(), 1, 400),
            ]
        );
        // Adjacent windows (a top-down walk) join too — one header instead of
        // two, and no seam the model has to re-read.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 130),
                ("a.rs".into(), 130, 120),
            ]),
            vec![("a.rs".to_string(), 1, 249)]
        );
        // An exact duplicate collapses (the old dedupe behaviour is preserved).
        assert_eq!(
            merge_read_targets(vec![("a.rs".into(), 1, 400), ("a.rs".into(), 1, 400)]),
            vec![("a.rs".to_string(), 1, 400)]
        );
        // Disjoint windows stay separate: a merge must never invent a range
        // that pulls in lines nobody asked for.
        assert_eq!(
            merge_read_targets(vec![("a.rs".into(), 1, 10), ("a.rs".into(), 500, 10)]),
            vec![("a.rs".to_string(), 1, 10), ("a.rs".to_string(), 500, 10)]
        );
        // A zero limit means the DEFAULT window only when it is ABSENT — an
        // explicit 0 selects no line, and the merge must not inflate it.
        assert_eq!(
            merge_read_targets(vec![("a.rs".into(), 5, 0)]),
            vec![("a.rs".to_string(), 5, 0)]
        );
    }

    #[test]
    fn read_ranges_carry_the_file_and_never_repeat_it() {
        // A bare `paths` list forced ONE window on every file and could name the
        // same file twice — the same bytes sent to the model twice. Batches now
        // live in `ranges`, where every entry carries its own file AND window,
        // so several known files still cost ONE call with nothing read twice.
        let dir = std::env::temp_dir().join(format!("codifa-readranges-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "a1\na2\n").unwrap();
        fs::write(dir.join("b.txt"), "b1\nb2\n").unwrap();
        let root = dir.to_str().unwrap().to_string();

        // ONE call, two files, a different window each.
        let out = dispatch(
            &root,
            "read",
            &json!({"ranges": [
                {"path": "a.txt", "offset": 1, "limit": 1},
                {"path": "b.txt", "offset": 2, "limit": 1}
            ]}),
            None,
        )
        .unwrap();
        assert!(out.contains("a1") && out.contains("b2"), "{out}");
        assert!(!out.contains("a2") && !out.contains("b1"), "{out}");

        // A repeated entry collapses, so identical bytes never go twice. The
        // collapse is ANNOUNCED (the marker the ruler counts) — strip it before
        // comparing, so this assertion stays about the payload, not the note.
        let once = dispatch(&root, "read", &json!({"ranges": [{"path": "a.txt"}]}), None).unwrap();
        let twice = dispatch(
            &root,
            "read",
            &json!({"ranges": [{"path": "a.txt"}, {"path": "a.txt"}]}),
            None,
        )
        .unwrap();
        let body = |s: &str| {
            s.split(READ_MERGED_MARK).next().unwrap_or(s).trim_end().to_string()
        };
        assert_eq!(body(&once), body(&twice), "a duplicate range must collapse");
        assert!(
            twice.contains(READ_MERGED_MARK),
            "the collapse is recorded in the result: {twice}"
        );

        // An entry without `path` inherits the top-level filePath, so a
        // single-file multi-window read stays short.
        let inherited = dispatch(
            &root,
            "read",
            &json!({"filePath": "b.txt", "ranges": [{"offset": 2, "limit": 1}]}),
            None,
        )
        .unwrap();
        assert!(inherited.contains("b2") && !inherited.contains("b1"), "{inherited}");

        // The legacy list form still WORKS (a stale transcript must not burn a
        // round trip) but is no longer advertised, and the shared dedupe
        // collapses the repeated file the old shape allowed.
        let legacy = dispatch(
            &root,
            "read",
            &json!({"paths": ["a.txt", "a.txt", "b.txt"]}),
            None,
        )
        .unwrap();
        assert_eq!(
            legacy.matches("a1").count(),
            1,
            "the legacy list form must not read a file twice: {legacy}"
        );
        assert!(legacy.contains("b1"), "{legacy}");

        // A range entry that names no file at all is an explicit error.
        let err = dispatch(&root, "read", &json!({"ranges": [{"offset": 1}]}), None).unwrap_err();
        assert!(err.contains("names no file"), "{err}");
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
        // PARTIAL, not all-or-nothing: the good edit is WRITTEN and the bad one
        // is named. Traced on the live corpus, the old atomic form made 8 of 84
        // batch edits throw away their good half, and each recovery cost a median
        // of 2 extra rounds (18 rounds, 4 of them a blind re-read of the file).
        let msg = dispatch(root, "edit_file", &args, None).unwrap();
        assert!(msg.contains("PARTIAL"), "{msg}");
        assert!(msg.contains("1/2"), "{msg}");
        assert!(msg.contains("edit 2/2: old_string not found"), "{msg}");
        assert!(msg.contains("send ONLY the failed one"), "{msg}");
        assert!(fs::read_to_string(&file).unwrap().contains("uno"));

        // A batch where NOTHING applies still fails, so the caller sees an error.
        let args = json!({
            "path": "f.txt",
            "edits": [{ "old_string": "nope", "new_string": "x" }]
        });
        let err = dispatch(root, "edit_file", &args, None).unwrap_err();
        assert!(err.contains("no edit applied"), "{err}");
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

