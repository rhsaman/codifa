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
use std::sync::{Arc, Mutex};

pub const MAX_READ_BYTES: usize = 2_000_000;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const MAX_FILES: usize = 10_000;
pub const MAX_TERMINAL_OUTPUT: usize = 10_000;

/// The ONE budget of a foreground tool wait — chat and scheduled alike.
///
/// The schema hands `timeout` to the MODEL, and nothing validated it: a prompt
/// that wanted a long-running monitor once sent a 5400-second foreground call
/// and the tool sat on it for the full 90 minutes while the turn (and the
/// scheduled run row) stayed `running` with no error anywhere. A long job is
/// what `background=true` is for, so a foreground call past this is clipped.
///
/// Deliberately ONE number: there is no second, larger "headless" budget. A paid
/// plugin script (article + image) legitimately takes minutes, and a run killed
/// mid-way pays for the same work twice, so the wait has to outlast the work in
/// both contexts.
pub const MAX_TERMINAL_TIMEOUT_SECS: u64 = 30 * 60;

/// Live-output sink for a RUNNING terminal command: called periodically with
/// the current tail of the combined output while the child is still alive.
/// The agent loop forwards it to the UI as `ToolOutput` events, so a long
/// download or build is visible in the chat while it runs instead of only
/// after the command returns.
pub type TailSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Minimum wall-clock gap between two `TailSink` calls for one command. The
/// poll loop ticks every 20 ms; without this gate a 30-minute command would
/// push a tail 90 000 times.
const TERMINAL_TAIL_EMIT_MS: u64 = 500;

/// Size of the live tail handed to `TailSink` — the LAST bytes of the output.
/// A curl progress refresh writes ~90 bytes per second, so this covers the
/// most recent minute or so of a typical download.
const TERMINAL_TAIL_BYTES: usize = 4096;
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

/// Score a hit must reach, and beat the runner-up by MORE THAN double, before
/// `load_skill query=` answers with its body instead of a candidate list.
///
/// Traced (`mvyy1qf7`): a query that named the right skill in several words
/// still listed it beside three skills matching one filler word, so the model
/// spent a SECOND call naming what the first call already knew — twice in one
/// turn. A strict 2× lead is what separates "this is the one" from "a tie".
const SKILL_DOMINANT_MIN_SCORE: usize = 2;
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
/// Marks a `read` block whose window was stretched to the end of the file (see
/// `file_window_upto`): the tail is already on the wire, so asking for it again
/// is a whole round trip for bytes the model is looking at.
const READ_TO_EOF_MARK: &str = "[read] extended ";
/// Marker of the outline `read` attaches to a window of a LARGE file, so the
/// model can jump straight to the lines it needs instead of walking the file.
const READ_OUTLINE_MARK: &str = "[read] outline ";
/// Shortest file that earns an outline. Below this a window IS the whole file,
/// so an outline would be pure overhead on every read of a small module.
const READ_OUTLINE_MIN_LINES: usize = 400;

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
            "\n[hint] No hit anywhere in that scope — spelling variants (snake/camel/Pascal) \
were already searched automatically, so the name itself is absent: do not re-read the file \
to confirm. Think of a DIFFERENT name (a sibling symbol, a call site, the type it flows into) \
or widen path/include once; if the concept is an identifier you can name, `find_symbol` also \
reports every USAGE.",
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
fn post_edit_diagnostics(root: &str, path: &str, permit: Option<&Value>) -> String {
    const POST_EDIT_DIAGNOSTICS_CAP: usize = 2_000;
    let Some(text) = crate::lsp::diagnostics_if_warm(root, path, permit) else {
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

/// Outline of the FIRST file a `grep` hit, attached to the SAME result.
///
/// MEASURED on trace `mvxsy14e`: of 7 lone `grep` rounds, the very next round
/// was a `read` in 5 — and the wider corpus says the same (53 of 118 main greps
/// were followed by a read of a file the grep had just listed). The follow-up
/// hint naming `find_symbol`/`lsp_symbols` was already on every one of those
/// results and moved the model zero times, so the map is ATTACHED here instead:
/// the round is spent either way, and an outline turns the next step into one
/// targeted window rather than a walk through the file.
///
/// Deliberately narrow, because this rides on a result the model already pays
/// for: the FIRST hit file only, only once per turn per file (see
/// [`outline_note_once`]), and only for a file large enough to earn an outline —
/// below [`READ_OUTLINE_MIN_LINES`] a window IS the outline.
fn grep_outline_block(root: &str, result: &str, permit: Option<&Value>) -> String {
    if result.starts_with("no matches") {
        return String::new();
    }
    // Same block-header shape `grep_followup_hint` parses: the file line ends
    // with ':' and carries no match/context indentation.
    let Some(file) = result
        .lines()
        .find(|l| !l.starts_with(' ') && !l.starts_with('>') && l.ends_with(':'))
        .map(|l| l.trim_end_matches(':'))
    else {
        return String::new();
    };
    let Ok(abs) = resolve_safe(root, file, true, permit) else {
        return String::new();
    };
    if !abs.is_file() {
        return String::new();
    }
    outline_note_once(&abs, file)
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
    // A grep whose first hit file carried its definition map: the follow-up read
    // that file would otherwise cost is already answered (see
    // `grep_outline_block`).
    if name == "grep" && result.contains(READ_OUTLINE_MARK) {
        out.push("grep_outline");
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
    if name == "read" && result.contains(READ_TO_EOF_MARK) {
        out.push("read_extended_to_eof");
    }
    out
}

/// Bound a `grep` follow-up hint, on a char boundary.
///
/// The hint rides on the tool result the model is already paying for, so a
/// pathological pattern (hundreds of alternations) must not be able to grow the
/// result past its own budget.
/// Glob filters from one `include` value: ONE `--glob` per entry.
///
/// MEASURED (trace `mvy0ausq`, 65 rounds): 12 of 27 greps returned a FALSE
/// "no matches" because the model wrote `include: "*.ts,*.tsx,*.rs"` — the
/// whole string went to a single `--glob`, where it means a filename containing
/// literal commas. ripgrep then matches nothing, the result says "no matches",
/// and the hint on it claims the NAME is absent, so the model abandoned a
/// correct idea and burned rounds guessing paths (`codifa/src`,
/// `codifa/codifa/src`) and spellings instead.
///
/// A comma or space separated list is exactly what that spelling means to the
/// model, so honour it here instead of failing silently. Brace groups
/// (`*.{ts,tsx}`) are valid rg syntax and stay intact.
fn include_globs(include: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut cur = String::new();
    for ch in include.chars() {
        match ch {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if depth == 0 && (ch == ',' || ch == ' ') {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
            continue;
        }
        cur.push(ch);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

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
    Lines {
        lines: Vec<String>,
        extended: bool,
        /// Lines in the WHOLE file, so the header can say "of N" — see
        /// [`numbered_window`].
        total: usize,
    },
    Empty(String),
}

/// Read one window of a file (1-indexed offset, line count) with the same
/// truncation rules as tools.py: 2MB byte cap, 2000-char line cap.
fn file_window(abs: &Path, offset: usize, limit: usize) -> Result<Window, String> {
    file_window_upto(abs, offset, limit, None)
}

/// `file_window`, allowed to stretch the window to the END of the file.
///
/// A short file read as a 400-line window ends a few lines before EOF, and the
/// model then spends a WHOLE round trip asking for the remainder — the single
/// largest source of extra round trips in the traced corpus: 78 of 80 reads in
/// one run stopped before EOF with a median of 7_951 unused chars left in the
/// result budget, and 106 rounds were a read chained onto another read of the
/// same file. Serving the tail NOW costs those same bytes once (they fit the
/// budget the result already has) and removes the follow-up round — the turn
/// gets shorter and cheaper without withholding a single line.
///
/// The stretch is deliberately conservative: only when the remainder is no
/// larger than the window the caller asked for AND the numbered rendering of the
/// whole thing still fits `budget`. Anything bigger keeps today's behaviour, so
/// a 20k-line file never turns one read into an unbounded payload.
fn file_window_upto(
    abs: &Path,
    offset: usize,
    limit: usize,
    budget: Option<usize>,
) -> Result<Window, String> {
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
    let content = read_viewable_text(abs)?;
    let total = content.lines().count();
    let mut lines: Vec<String> = content
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
    // Stretch to EOF when the tail is small enough to ride along for free (see
    // `file_window_upto`): the model would otherwise spend a whole round trip
    // asking for exactly these lines.
    let mut extended = false;
    if let Some(budget) = budget {
        let served_to = offset.saturating_sub(1) + lines.len();
        let rest_count = total.saturating_sub(served_to);
        if rest_count > 0 && rest_count <= limit {
            let rest: Vec<String> = content
                .lines()
                .skip(served_to)
                .map(truncated_line)
                .collect();
            if rest.len() == rest_count {
                let asked_cost = numbered_cost(offset.max(1), lines.iter().map(|l| l.len()).sum(), lines.len());
                let rest_cost = numbered_cost(served_to + 1, rest.iter().map(|l| l.len()).sum(), rest.len());
                if asked_cost + rest_cost + READ_TRUNCATION_RESERVE <= budget {
                    lines.extend(rest);
                    extended = true;
                }
            }
        }
    }
    Ok(Window::Lines {
        lines,
        extended,
        total,
    })
}

/// Char cost of rendering `count` numbered lines that begin at line `first` and
/// carry `sum_len` chars of text in total.
///
/// An estimate on purpose: it only decides whether a tail RIDES ALONG, and
/// `numbered_window_capped` remains the hard bound afterwards — so being a few
/// chars optimistic never breaks the budget, it just lets a window grow by one
/// line before the cut.
fn numbered_cost(first: usize, sum_len: usize, count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    let width = (first + count - 1).to_string().len();
    sum_len + count * (width + 2) + 40
}

/// Bare window text (no line numbers) — the shape non-agent callers expect.
pub fn read_window(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    if abs.is_dir() {
        return list_dir(abs, offset, limit);
    }
    match file_window(abs, offset, limit)? {
        Window::Lines { lines, .. } => {
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
    // Programmatic callers asked for exactly this window: never stretch it.
    read_window_block_capped(abs, label, offset, limit, usize::MAX, false)
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
/// The `ranges` entries of a `read`, tolerating the JSON-STRING spelling.
///
/// Traced (mvxqpye6 r0): the model sent `ranges` as a serialized JSON string
/// instead of an array. Every shape check missed, the call fell through to
/// `resolve_safe(root, "")` — the workspace ROOT — and came back as a directory
/// listing flagged `ok: true`, costing two more rounds to disprove. A string
/// that parses as an array of entries is the same request, so honour it.
fn ranges_of(args: &Value) -> Option<Vec<Value>> {
    let raw = &args["ranges"];
    if let Some(list) = raw.as_array() {
        return Some(list.clone());
    }
    let text = raw.as_str()?.trim();
    if !text.starts_with('[') {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(list)) => Some(list),
        _ => None,
    }
}

pub(crate) fn read_windows_of(args: &Value) -> Vec<(String, usize, usize)> {
    let top = args["filePath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| args["path"].as_str().unwrap_or_default())
        .to_string();
    let num = |v: &Value, fallback: usize| v.as_u64().map(|n| n as usize).unwrap_or(fallback);
    let mut out = Vec::new();
    if let Some(ranges) = ranges_of(args) {
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
fn merge_read_targets(targets: Vec<(String, usize, usize, bool)>) -> Vec<(String, usize, usize, bool)> {
    /// Largest gap between two windows of one file that still merges: adjacent
    /// (`(1,130)` then `(130,120)`) and near-adjacent windows are what a model
    /// emits when it walks a file top-down.
    const GAP: usize = 20;
    let mut order: Vec<String> = Vec::new();
    let mut by_file: std::collections::HashMap<String, Vec<(usize, usize, bool)>> =
        std::collections::HashMap::new();
    for (file, offset, limit, extend) in targets {
        // The span is offset+limit, with no normalisation: `dispatch` treats an
        // explicit `limit: 0` as zero lines, so inflating it here would serve
        // (and charge for) lines the caller did not ask for.
        let span = (offset, offset.saturating_add(limit), extend);
        if !by_file.contains_key(&file) {
            order.push(file.clone());
        }
        by_file.entry(file).or_default().push(span);
    }
    let mut out = Vec::new();
    for file in order {
        let mut spans = by_file.remove(&file).unwrap_or_default();
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize, bool)> = Vec::new();
        for (start, end, extend) in spans {
            match merged.last_mut() {
                // A union is only stretchable when EVERY window in it was the
                // default one: a deliberate narrow `limit` must never be widened
                // behind the model's back.
                Some(last) if start <= last.1 + GAP => {
                    last.1 = last.1.max(end);
                    last.2 &= extend;
                }
                _ => merged.push((start, end, extend)),
            }
        }
        for (start, end, extend) in merged {
            out.push((file.clone(), start, end - start, extend));
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
    extend_to_eof: bool,
) -> Result<String, String> {
    if abs.is_dir() {
        return read_window(abs, offset, limit);
    }
    // An unbounded call (`usize::MAX` budget) is the programmatic shape other
    // callers rely on: they asked for THAT window, so it is served exactly.
    let budget = Some(budget).filter(|b| *b != usize::MAX);
    match file_window_upto(abs, offset, limit, budget.filter(|_| extend_to_eof))? {
        Window::Lines {
            lines,
            extended,
            total,
        } => {
            let first = offset.max(1);
            let mut out = numbered_window_capped_of(
                label,
                first,
                &lines,
                budget.unwrap_or(usize::MAX),
                total,
            );
            if extended {
                // The stretch that saved the follow-up round must be VISIBLE, or
                // the model cannot tell a short window from the end of the file
                // and re-reads the tail anyway. The marker is also what the
                // repeat-guard reads to claim the whole served span.
                out.push_str(&format!(
                    "\n{READ_TO_EOF_MARK}{label} to line {} — the rest of the file is above, do NOT re-read it\n",
                    first + lines.len() - 1
                ));
            }
            Ok(out)
        }
        Window::Empty(notice) => Ok(notice),
    }
}

/// Line a `read` block reports having served, when it stretched to end-of-file.
///
/// `"[read] extended <file> to line <last>"` — the file is spelled exactly as
/// the model spelled it, so the caller can match it against the call's own
/// targets without guessing which block is which. A batched `read` emits one
/// marker per block, so every one is reported.
pub(crate) fn read_extended_spans(result: &str) -> Vec<(String, usize)> {
    result
        .split(READ_TO_EOF_MARK)
        .skip(1)
        .filter_map(|rest| {
            let (file, tail) = rest.split_once(" to line ")?;
            let last = tail
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .filter(|d| !d.is_empty())?
                .parse()
                .ok()?;
            Some((file.trim_end().to_string(), last))
        })
        .collect()
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
    numbered_window_of(label, first_line, lines, 0)
}

/// `label (lines a-b of N):` — the header every read block opens with.
///
/// The `of N` half is the cheapest round-trip lever in the whole read path: a
/// traced run walked `plugins.rs` FOURTEEN times, one 120-line window per round,
/// because nothing in the block said how long the file was — the model could not
/// know whether it was near the end or one tenth of the way in, so it stepped
/// blindly. Two extra words per block let it jump straight to the window it
/// needs instead of spending a model round trip per 120 lines.
fn window_header(label: &str, first_line: usize, last: usize, total: usize) -> String {
    if total > last {
        format!("{label} (lines {first_line}-{last} of {total}):\n")
    } else {
        format!("{label} (lines {first_line}-{last}):\n")
    }
}

/// `numbered_window` that also states the file's total line count.
fn numbered_window_of(label: &str, first_line: usize, lines: &[String], total: usize) -> String {
    if lines.is_empty() {
        return format!("{label} (lines {first_line}+): (empty window)\n");
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    let mut out = window_header(label, first_line, last, total);
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
    numbered_window_capped_of(label, first_line, lines, budget, 0)
}

/// `numbered_window_capped` that also states the file's total line count, so the
/// model knows how much of the file is still ahead of it.
fn numbered_window_capped_of(
    label: &str,
    first_line: usize,
    lines: &[String],
    budget: usize,
    total: usize,
) -> String {
    let full = numbered_window_of(label, first_line, lines, total);
    if full.chars().count() <= budget {
        return full;
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    // The header is kept even when the body is cut: without it the block reads
    // as "this file has nothing here", and the caller cannot even tell WHICH
    // window answered.
    let mut out = window_header(label, first_line, last, total);
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
                "… (window truncated at line {shown_to}{}: these lines did not fit the \
result budget. Read the rest with offset={} limit={} — do not re-read what is shown here)\n",
                if total > last { format!(" of {total}") } else { String::new() },
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

/// Char budget of the site list a failed AMBIGUOUS edit may carry.
///
/// Bounded like `NEAREST_HINT_BUDGET`: the window replaces a round-trip, so the
/// failure message itself must never trip the model-result cap.
const AMBIGUOUS_HINT_BUDGET: usize = 1_600;
/// How many sites the ambiguous message lists before it stops.
const AMBIGUOUS_HINT_MAX_SITES: usize = 3;
/// Lines of context printed at each ambiguous site.
const AMBIGUOUS_HINT_CONTEXT: usize = 2;

/// Each occurrence of an ambiguous `old_string`, with its line number and a
/// small window of the CURRENT text, for `edit_file`'s failure message.
///
/// MEASURED on traces `mvy0ausq` / `mvxsy14e`: 5 ambiguous edits failed and
/// every one cost 1-2 recovery rounds at 65-138K re-sent tokens each, because
/// the message named only a COUNT and the model then re-grepped or re-read the
/// file to find text that would make its string unique. The file is already
/// open in this function, so naming the sites costs one call's worth of chars
/// and lets the edit land on the very next attempt.
fn ambiguous_hint(content: &str, old_string: &str) -> String {
    if old_string.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = content.lines().collect();
    // 0-based line index of each occurrence, in file order.
    let mut sites: Vec<usize> = Vec::new();
    let mut from = 0usize;
    while sites.len() < AMBIGUOUS_HINT_MAX_SITES {
        let Some(off) = content[from..].find(old_string) else {
            break;
        };
        let abs = from + off;
        sites.push(content[..abs].matches('\n').count());
        // Always advance past what matched, so an empty-ish match cannot loop.
        from = abs + old_string.len().max(1);
    }
    if sites.is_empty() {
        return String::new();
    }
    let span = old_string.lines().count().max(1);
    let mut out = String::from(
        " Each site is shown with its neighbours: extend your old_string with ONE adjacent line \
         to make it unique — do NOT re-read the file or re-grep for the text below.",
    );
    // Windows already printed. Two occurrences on the SAME line ("foo foo") both
    // resolve to one line, and neighbouring sites can share context lines; the
    // same block twice reads as two different places and would send the model
    // looking for a distinction that does not exist. Overlap is TRIMMED, not
    // dropped, so a site still gets its own (file-accurate) line number.
    let mut printed_until = 0usize;
    for start in sites {
        let first = start.saturating_sub(AMBIGUOUS_HINT_CONTEXT).max(printed_until);
        let last = (start + span + AMBIGUOUS_HINT_CONTEXT).min(lines.len());
        if last <= first {
            continue;
        }
        printed_until = last;
        let numbered: Vec<String> = lines[first..last].iter().map(|l| (*l).to_string()).collect();
        let block = numbered_window_capped_of(
            &format!("site at line {}", start + 1),
            first + 1,
            &numbered,
            AMBIGUOUS_HINT_BUDGET,
            lines.len(),
        );
        if out.chars().count() + block.chars().count() > AMBIGUOUS_HINT_BUDGET {
            break;
        }
        out.push('\n');
        out.push_str(&block);
    }
    out
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

/// The message for a pattern whose alternatives exceed the cap with no scope.
///
/// MEASURED: the bare "refused" line named the LIMIT but never the way out, and
/// traces show the model answering it with a different over-broad spelling or an
/// unscoped retry — each one a full round at 65-138K re-sent tokens. The fix is
/// always one of two things, so state both, with a copy-ready shape: add a scope,
/// or split the alternatives into parallel greps of the same step.
pub fn broad_pattern_refusal(pattern: &str) -> String {
    format!(
        "broad pattern refused: {pattern:?} has {} top-level alternatives (max {MAX_GREP_ALTERNATIVES}) \
         and no path/include scope, so it would scan the whole tree once per alternative. Do NOT retry \
         the same pattern unscoped — either add a scope (path=\"src\" or include=\"*.rs\") or send the \
         alternatives as SEPARATE grep calls in ONE step, which is cheaper than one unscoped sweep.",
        count_grep_alternatives(pattern)
    )
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
        return Err(broad_pattern_refusal(pattern));
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
        // Per-FILE bound only: the global budget is applied at formatting time
        // (definition lines first, then a fair spread across files), so the
        // count has to be large enough that the selection sees the real mass
        // of a file instead of the first `cap` hits rg happens to emit.
        .arg(RG_PER_FILE_MATCH_CAP.to_string())
        .arg("--no-messages");
    if ctx > 0 {
        cmd.arg("--context").arg(ctx.to_string());
    }
    // Case-insensitive matching was forced ON, which inflates the match set
    // (and the output) for searches whose casing is already known. Opt in.
    if ignore_case {
        cmd.arg("--ignore-case");
    }
    for g in include_globs(include) {
        cmd.arg("--glob").arg(g);
    }
    cmd.arg("--").arg(pattern).arg(&search_target);

    let raw = cmd
        .output()
        .map_err(|e| format!("ripgrep (rg) is required but could not be run: {e}"))?;
    if raw.status.code() == Some(2) {
        return Err(String::from_utf8_lossy(&raw.stderr).trim().to_string());
    }

    let (out, shown, total_matches, files_with_matches) =
        format_rg_output(&raw.stdout, &search_dir, &root_real, cap, ctx);
    if total_matches == 0 {
        // A literal miss is often a SPELLING mismatch, not a wrong idea: the
        // model greps `script.json` and the code says `script_json`. Trace,
        // Oct 30: that exact refinement cost a second round-trip — the model
        // re-grepped with `script\.json|fa_keywords`, then again with
        // `script\.json|script_json|ScriptJson`. Run the convention variants
        // ONCE here, in the same call, and label them so the model knows the
        // literal itself has no hit. Fires only on a single identifier-ish
        // token (no regex metachars, no `|`), never replaces a real hit.
        if let Some(variants) = name_variant_pattern(pattern) {
            let mut vcmd = std::process::Command::new(rg_binary());
            vcmd.current_dir(&search_dir)
                .arg("--json")
                .arg("--line-number")
                .arg("--max-count")
                .arg(RG_PER_FILE_MATCH_CAP.to_string())
                .arg("--no-messages");
            if ctx > 0 {
                vcmd.arg("--context").arg(ctx.to_string());
            }
            if ignore_case {
                vcmd.arg("--ignore-case");
            }
            for g in include_globs(include) {
                vcmd.arg("--glob").arg(g);
            }
            vcmd.arg("--").arg(&variants).arg(&search_target);
            if let Ok(vraw) = vcmd.output() {
                if vraw.status.code() != Some(2) {
                    let (vout, _vshown, vtotal, _) =
                        format_rg_output(&vraw.stdout, &search_dir, &root_real, cap, ctx);
                    if vtotal > 0 {
                        return Ok(format!(
                            "[no literal hit for {pattern:?} in this scope — the matches below \
are SPELLING-VARIANT hits ({variants}); the exact string does not exist]\n\n{vout}"
                        ));
                    }
                }
            }
        }
        return Ok("no matches".into());
    }
    let _ = (shown, files_with_matches);
    Ok(out)
}

/// rg emits at most this many matches PER FILE; the global budget is applied
/// when formatting. Large enough to see a file's real mass, small enough that
/// a minified bundle cannot flood the parse.
const RG_PER_FILE_MATCH_CAP: usize = 400;
/// Hard bound on collected match/context rows across ALL files, so a huge
/// multi-file hit set stays a bounded parse (rows beyond it are simply not
/// candidates for display; the counts already collected still report).
const RG_COLLECT_ROW_CAP: usize = 20_000;

/// One file's parsed rg stream: every match/context row rg emitted for it, in
/// order, plus the indices of the match rows.
struct GrepFile {
    name: String,
    lines: Vec<(bool, u64, String)>,
    matches: Vec<usize>,
}

/// True when a line LOOKS like a code declaration — the thing a code search
/// is usually hunting. Definition lines are shown first inside the budget:
/// traced refinement chains (grep → weaker-than-hoped hits → re-grep with a
/// narrower pattern) almost always started from a cap that spent its lines on
/// call sites while the declaration the model needed sat past the cut.
fn looks_like_definition(line: &str) -> bool {
    let mut t = line.trim_start();
    if let Some(rest) = t.strip_prefix("pub ") {
        t = rest.trim_start();
    }
    if let Some(rest) = t.strip_prefix("export ") {
        t = rest.trim_start();
    }
    if let Some(rest) = t.strip_prefix("default ") {
        t = rest.trim_start();
    }
    if let Some(rest) = t.strip_prefix("async ") {
        t = rest.trim_start();
    }
    ["struct ", "enum ", "fn ", "impl ", "trait ", "const ", "static ", "type ", "mod ",
     "class ", "def ", "interface ", "function ", "func ", "macro_rules"]
        .iter()
        .any(|kw| t.starts_with(kw))
}

/// Parse `rg --json` output and build the display: per-file blocks, the global
/// budget of `cap` MATCH lines spent definition-lines-first and then spread
/// fairly across files, context windows around shown matches, and a one-line
/// mass signal for every matching file whose hits did not make the budget.
/// Returns (text, shown_matches, total_matches, files_with_matches).
fn format_rg_output(
    stdout: &[u8],
    search_dir: &std::path::Path,
    root_real: &std::path::Path,
    cap: usize,
    ctx: usize,
) -> (String, usize, usize, usize) {
    // ---- parse ------------------------------------------------------------
    let mut files: Vec<GrepFile> = Vec::new();
    let mut total_matches = 0usize;
    let mut rows = 0usize;
    {
        let mut current: Option<GrepFile> = None;
        for line in String::from_utf8_lossy(stdout).lines() {
            let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
            let kind = ev["type"].as_str().unwrap_or_default();
            if kind == "begin" {
                let path = ev["data"]["path"]["text"].as_str().unwrap_or_default();
                let abs = search_dir.join(path);
                let abs = abs.components().collect::<std::path::PathBuf>();
                let name = abs
                    .strip_prefix(root_real)
                    .unwrap_or(&abs)
                    .to_string_lossy()
                    .to_string();
                if let Some(f) = current.take() {
                    files.push(f);
                }
                current = Some(GrepFile { name, lines: Vec::new(), matches: Vec::new() });
            } else if (kind == "match" || kind == "context") && current.is_some() {
                if rows >= RG_COLLECT_ROW_CAP {
                    continue;
                }
                rows += 1;
                let text = ev["data"]["lines"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .trim_end_matches('\n')
                    .to_string();
                let line_no = ev["data"]["line_number"].as_u64().unwrap_or(0);
                let f = current.as_mut().unwrap();
                if kind == "match" {
                    f.matches.push(f.lines.len());
                    total_matches += 1;
                }
                f.lines.push((kind == "match", line_no, text));
            } else if kind == "end" {
                if let Some(f) = current.take() {
                    files.push(f);
                }
            }
        }
        if let Some(f) = current.take() {
            files.push(f);
        }
    }
    let files: Vec<GrepFile> = files.into_iter().filter(|f| !f.matches.is_empty()).collect();
    let files_with_matches = files.len();
    if total_matches == 0 || files.is_empty() {
        return (String::new(), 0, total_matches, 0);
    }

    // ---- select: definitions first, then a fair spread ---------------------
    let mut selected: Vec<Vec<usize>> = files.iter().map(|_| Vec::new()).collect();
    let mut taken = 0usize;
    // Declaration lines per file, computed once so both passes below agree on
    // what counts as a definition.
    let defs: Vec<Vec<usize>> = files
        .iter()
        .map(|f| {
            f.matches
                .iter()
                .copied()
                .filter(|i| looks_like_definition(&f.lines[*i].2))
                .collect()
        })
        .collect();
    // Pass 1 — ONE declaration per file. A single declaration-heavy file used to
    // spend the whole budget here (up to three per file, in rg's walk order), so
    // a later file's declaration never made the cut and the model re-grepped to
    // find it. A share each guarantees the file that DEFINES the thing is never
    // the one that gets cut.
    for (f, list) in defs.iter().enumerate() {
        if taken >= cap {
            break;
        }
        if let Some(&i) = list.first() {
            selected[f].push(i);
            taken += 1;
        }
    }
    // Pass 2 — the remaining declarations, still ahead of every call site.
    'defs: for (f, list) in defs.iter().enumerate() {
        for &i in list.iter().skip(1).take(2) {
            if taken >= cap {
                break 'defs;
            }
            selected[f].push(i);
            taken += 1;
        }
    }
    'fill: loop {
        let mut progressed = false;
        for f in 0..files.len() {
            if taken >= cap {
                break 'fill;
            }
            if let Some(i) = files[f].matches.iter().find(|i| !selected[f].contains(i)) {
                selected[f].push(*i);
                taken += 1;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    let shown = taken;

    // ---- format ------------------------------------------------------------
    let mut out = String::new();
    let mut shown_files = 0usize;
    for (f, file) in files.iter().enumerate() {
        if selected[f].is_empty() {
            continue;
        }
        shown_files += 1;
        // Expand each selected match to its context window over the file's
        // stream, merge overlaps, emit in stream order.
        let mut want = vec![false; file.lines.len()];
        for &i in &selected[f] {
            let lo = i.saturating_sub(ctx);
            let hi = (i + ctx).min(file.lines.len().saturating_sub(1));
            for w in lo..=hi {
                want[w] = true;
            }
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&file.name);
        out.push_str(":\n");
        let mut emitted_match = false;
        for (i, (is_match, line_no, text)) in file.lines.iter().enumerate() {
            if !want[i] {
                continue;
            }
            let marker = if *is_match { ">" } else { " " };
            if *is_match {
                emitted_match = true;
            }
            // Char-boundary-safe: a raw byte slice panics (and with
            // panic=abort kills the app) on a multi-byte Persian char.
            let body = truncated_line(text);
            out.push_str(&format!("{marker}{line_no}: {body}\n"));
        }
        debug_assert!(emitted_match);
    }
    // The files the budget could not reach still carry signal — the mass
    // tells the model where to read WITHOUT a second, narrowed grep.
    let silent: Vec<String> = files
        .iter()
        .enumerate()
        .filter(|(f, _)| selected[*f].is_empty())
        .map(|(_, file)| {
            format!(
                "{}: {} match(es) not shown",
                file.name,
                file.matches.len().min(RG_PER_FILE_MATCH_CAP)
            )
        })
        .collect();
    if !silent.is_empty() {
        out.push_str(&format!("\n{}\n", silent.join("\n")));
    }
    if total_matches > shown {
        out.push_str(&format!(
            "\n[truncated — {total_matches} matches in {files_with_matches} file(s), {shown} shown \
across {shown_files} file(s); narrow with path/include, or read a named file]\n"
        ));
    }
    (out, shown, total_matches, files_with_matches)
}

/// Split an identifier-ish token into its alpha segments across naming
/// conventions: `script.json` / `SCRIPT_TIMEOUT` / `scriptJson` / `script-json`
/// all split to ["script", "json"]. `None` when the token is not a plain name
/// (regex metachars, too long, empty) — a variant search only makes sense for
/// identifiers.
fn identifier_segments(token: &str) -> Option<Vec<String>> {
    if token.is_empty() || token.len() > 64 || token.contains('|') {
        return None;
    }
    // A model writes a literal dot as `\.` (traced miss: `script\.json`).
    // Strip the regex escapes — the remaining shape decides whether this is a
    // plain name worth re-spelling.
    let cleaned: String = token.chars().filter(|c| *c != '\\').collect();
    if cleaned.is_empty()
        || !cleaned
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return None;
    }
    let mut segs: Vec<String> = Vec::new();
    for part in cleaned.split(|c| c == '_' || c == '-' || c == '.') {
        if part.is_empty() {
            continue;
        }
        let chars: Vec<char> = part.chars().collect();
        let mut cur = String::new();
        for (i, &c) in chars.iter().enumerate() {
            // camelCase / PascalCase boundary: an uppercase that follows a
            // lowercase. ALL-CAPS parts rely on the `_`/`.`/`-` split above.
            if c.is_uppercase() && i > 0 && chars[i - 1].is_lowercase() {
                segs.push(std::mem::take(&mut cur));
            }
            cur.push(c);
        }
        if !cur.is_empty() {
            segs.push(cur);
        }
    }
    if segs.is_empty() {
        None
    } else {
        Some(segs.iter().map(|s| s.to_lowercase()).collect())
    }
}

/// The spelling variants of a segmented name as one alternation:
/// ["script","json"] → `script_json|scriptJson|ScriptJson|SCRIPT_JSON`.
/// `None` when the input has no segments or every variant equals the input
/// (nothing to learn from a re-spelling of itself).
fn name_variant_pattern(pattern: &str) -> Option<String> {
    let segs = identifier_segments(pattern)?;
    let cap_first = |s: &str| -> String {
        let mut cs = s.chars();
        match cs.next() {
            Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
            None => String::new(),
        }
    };
    let snake = segs.join("_");
    let camel = format!(
        "{}{}",
        segs[0],
        segs[1..].iter().map(|s| cap_first(s)).collect::<String>()
    );
    let pascal: String = segs.iter().map(|s| cap_first(s)).collect();
    let upper = snake.to_uppercase();
    let mut variants = vec![snake.clone(), camel, pascal, upper];
    let kebab = segs.join("-");
    if kebab != snake {
        variants.push(kebab);
    }
    variants.sort();
    variants.dedup();
    if variants.len() == 1 && variants[0] == pattern {
        return None;
    }
    Some(variants.join("|"))
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

/// Read a file for VIEWING: a real I/O cause is named, and invalid UTF-8 is
/// shown lossily with a marker instead of refused.
///
/// Same defect as `read_editable_text`: the old one-liner collapsed EACCES, a
/// directory, an I/O error and a genuine encoding mismatch into "binary file",
/// which told the model nothing and cost it a retry round. A read never rewrites
/// the file, so a lossy view is safe — refusing it threw away content the model
/// could otherwise use, and the marker keeps the substitution honest.
fn read_viewable_text(target: &Path) -> Result<String, String> {
    let bytes = fs::read(target)
        .map_err(|e| format!("cannot read {}: {e}", target.display()))?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(e) => {
            let at = e.utf8_error().valid_up_to();
            let text = String::from_utf8_lossy(e.as_bytes()).into_owned();
            Ok(format!(
                "[note] this file is not valid UTF-8 (first bad byte at offset {at}); the text below \
                 is shown with invalid sequences replaced. Do not edit it with `edit_file` — its \
                 bytes would be rewritten; use `run_terminal` for a byte-exact change.\n{text}"
            ))
        }
    }
}

/// Read a file's current text for an edit, naming the REAL cause when it fails.
///
/// MEASURED on the live traces: the previous one-liner
/// `fs::read_to_string(..).map_err(|_| "binary file (edit skipped)")` reported
/// EVERY failure — permission denied, a directory target, an I/O error mid-turn,
/// or genuinely invalid UTF-8 — as the same 26-char "binary file". Eight batch
/// edits in ONE turn died that way on files that were valid UTF-8 and readable in
/// the same process, so the model could not tell a real encoding problem from a
/// transient one: it re-read the file and re-sent the identical batch, losing 1-2
/// rounds at 65-138K re-sent tokens each. The message now carries the errno, or
/// for a real encoding failure the byte offset of the bad sequence.
///
/// UTF-8 stays enforced (not lossy): an edit rewrites the whole file through a
/// `String`, so a lossy round-trip would corrupt every byte it did not touch.
fn read_editable_text(target: &Path) -> Result<String, String> {
    let bytes = fs::read(target)
        .map_err(|e| format!("cannot read {} for editing: {e}", target.display()))?;
    String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        format!(
            "{} is not valid UTF-8 (first bad byte at offset {at}), so it cannot be edited in place — \
             an edit rewrites the whole file and would corrupt the bytes around it. Modify it with \
             `run_terminal` instead.",
            target.display()
        )
    })
}

/// Read a file's current content for diffing before an edit. A missing or
/// unreadable file yields an empty string (a brand-new write_file then diffs
/// as pure additions).
///
/// `permit` is the turn's out-of-workspace grant, the SAME one the writer itself
/// resolves with. Without it a write the user explicitly approved outside the
/// tree snapshotted as `None`, so no diff was ever emitted for it: the chat card
/// said only "Edited" and the Review panel had no hunk to show. Workspace, temp
/// and `~/.codifa` still pass with no permit at all.
pub fn read_pre_edit(root: &str, path: &str, permit: Option<&Value>) -> Option<String> {
    let target = resolve_safe(root, path, false, permit).ok()?;
    fs::read_to_string(target).ok()
}

/// One line of the merged edit script: ` ` kept, `-` deleted, `+` added.
/// `a` / `b` are how many OLD / NEW lines precede this op (for hunk headers).
struct DiffOp<'a> {
    tag: char,
    text: &'a str,
    a: usize,
    b: usize,
}

/// Myers O(ND) shortest edit script between two line slices: marks which lines
/// of `a` are deleted and which of `b` are added. Returns false (marks
/// untouched) when the edit distance passes the cap, so a pathological pair of
/// huge, unrelated files costs bounded time/memory and the caller falls back.
fn myers_marks(a: &[&str], b: &[&str], del: &mut [bool], add: &mut [bool]) -> bool {
    const MAX_D: isize = 1500;
    let n = a.len() as isize;
    let m = b.len() as isize;
    let limit = (n + m).min(MAX_D);
    let off = limit + 1;
    let mut v = vec![0isize; (2 * limit + 3) as usize];
    // trace[d] = the V frontier BEFORE round d, only diagonals -d..=d.
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found: Option<isize> = None;
    'search: for d in 0..=limit {
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let idx = (off + k) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) {
                v[idx + 1]
            } else {
                v[idx - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'search;
            }
            k += 2;
        }
    }
    let Some(dd) = found else {
        return false;
    };
    let (mut x, mut y) = (n, m);
    for d in (1..=dd).rev() {
        let vd = &trace[d as usize];
        let get = |kk: isize| vd[(kk + d) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && get(k - 1) < get(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        // Walk back along the diagonal (kept lines) to just after the edit.
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
        }
        if x == prev_x {
            add[prev_y as usize] = true; // moved down: an insertion
        } else {
            del[prev_x as usize] = true; // moved right: a deletion
        }
        x = prev_x;
        y = prev_y;
    }
    true
}

/// Deleted-flags for `a` and added-flags for `b`. A pure insert/delete needs no
/// search; when the search is capped, everything in the span counts as changed
/// (the old behaviour) rather than hanging on a giant rewrite.
fn line_marks(a: &[&str], b: &[&str]) -> (Vec<bool>, Vec<bool>) {
    let mut del = vec![false; a.len()];
    let mut add = vec![false; b.len()];
    if a.is_empty() || b.is_empty() || !myers_marks(a, b, &mut del, &mut add) {
        del.iter_mut().for_each(|f| *f = true);
        add.iter_mut().for_each(|f| *f = true);
    }
    (del, add)
}

/// Unified diff (`--- a/…` / `+++ b/…`) shaped like `git diff`: a real
/// line-level diff (Myers), split into hunks with 3 context lines. Only lines
/// that truly changed are `-`/`+`, so the +N/-M counters the UI derives from it
/// match `git diff --numstat` instead of counting the whole span between the
/// first and last edit (a 5-line change in a 130-line file used to read
/// +122/-110).
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

    // Merged edit script: kept prefix, the diffed middle, kept suffix.
    let (del, add) = line_marks(&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut ops: Vec<DiffOp> = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0usize, 0usize);
    for _ in 0..pre {
        ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
        i += 1;
        j += 1;
    }
    let (mut p, mut q) = (0usize, 0usize);
    while p < del.len() || q < add.len() {
        if p < del.len() && del[p] {
            ops.push(DiffOp { tag: '-', text: a[i], a: i, b: j });
            i += 1;
            p += 1;
        } else if q < add.len() && add[q] {
            ops.push(DiffOp { tag: '+', text: b[j], a: i, b: j });
            j += 1;
            q += 1;
        } else if p < del.len() && q < add.len() {
            ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
            i += 1;
            j += 1;
            p += 1;
            q += 1;
        } else {
            break;
        }
    }
    for _ in 0..suf {
        ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
        i += 1;
        j += 1;
    }

    // Group changes into hunks: two changes share a hunk when the unchanged gap
    // between them fits inside both their context windows.
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| o.tag != ' ')
        .map(|(n, _)| n)
        .collect();
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let mut s = 0usize;
    while s < changed.len() {
        let mut e = s;
        while e + 1 < changed.len() && changed[e + 1] - changed[e] <= 2 * CTX + 1 {
            e += 1;
        }
        let lo = changed[s].saturating_sub(CTX);
        let hi = (changed[e] + CTX).min(ops.len() - 1);
        let hunk = &ops[lo..=hi];
        let old_len = hunk.iter().filter(|o| o.tag != '+').count();
        let new_len = hunk.iter().filter(|o| o.tag != '-').count();
        // git convention: an empty side points at the line BEFORE the hunk.
        let old_start = if old_len == 0 { hunk[0].a } else { hunk[0].a + 1 };
        let new_start = if new_len == 0 { hunk[0].b } else { hunk[0].b + 1 };
        out.push_str(&format!(
            "@@ -{old_start},{old_len} +{new_start},{new_len} @@\n"
        ));
        for o in hunk {
            out.push(o.tag);
            out.push_str(o.text);
            out.push('\n');
        }
        s = e + 1;
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

    fn count_changes(d: &str) -> (usize, usize) {
        let adds = d.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
        let dels = d.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
        (adds, dels)
    }

    /// The reported bug: two small edits far apart used to be diffed as one
    /// block spanning everything between them (+122/-110 for a ~5 line change).
    #[test]
    fn unified_diff_counts_only_the_lines_that_really_changed() {
        let old: Vec<String> = (1..=130).map(|n| format!("line {n}")).collect();
        let mut new = old.clone();
        new[8] = "line 9 changed".to_string();
        new[120] = "line 121 changed".to_string();
        new.insert(60, "brand new line".to_string());
        let old_s = old.join("\n") + "\n";
        let new_s = new.join("\n") + "\n";
        let d = unified_diff("big.txt", &old_s, &new_s);
        assert_eq!(count_changes(&d), (3, 2), "diff was:\n{d}");
        // Three distant edits => three separate hunks, not one giant one.
        assert_eq!(d.matches("\n@@ -").count(), 3, "diff was:\n{d}");
    }

    #[test]
    fn unified_diff_close_edits_share_one_hunk() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nB\nc\nd\ne\nf\nG\nh\n";
        let d = unified_diff("f.txt", old, new);
        assert_eq!(count_changes(&d), (2, 2));
        assert_eq!(d.matches("\n@@ -").count(), 1, "diff was:\n{d}");
    }

    #[test]
    fn unified_diff_pure_insert_and_delete_in_the_middle() {
        let d = unified_diff("f.txt", "a\nb\nc\n", "a\nb\nX\nY\nc\n");
        assert_eq!(count_changes(&d), (2, 0));
        let d = unified_diff("f.txt", "a\nb\nX\nY\nc\n", "a\nb\nc\n");
        assert_eq!(count_changes(&d), (0, 2));
    }

    /// Applying the diff's own +/- lines to the old text must give the new text:
    /// the hunks are not just well counted, they are exact.
    #[test]
    fn unified_diff_hunks_reconstruct_the_new_text() {
        // Short enough that both edits land in ONE hunk (a hunk only carries
        // context around its changes, so a multi-hunk diff is not the full text).
        let old = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let new = "one\n2\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
        let d = unified_diff("f.txt", old, new);
        let rebuilt: Vec<&str> = d
            .lines()
            .skip(2)
            .filter(|l| !l.starts_with("@@") && !l.starts_with('-'))
            .map(|l| &l[1..])
            .collect();
        assert_eq!(rebuilt, new.lines().collect::<Vec<_>>());
    }

    #[test]
    fn a_non_utf8_file_names_the_real_cause_and_reads_as_lossy() {
        // MEASURED (trace `mvxsy14e`): every edit failure came back as the same
        // 26-char "binary file (edit skipped)" — 8 times in one turn — because the
        // read collapsed EACCES/EISDIR/encoding into one string. The model could
        // not tell a real encoding problem from a transient one, so it re-read and
        // re-sent the same batch for 1-2 rounds (65-138K re-sent tokens each).
        let tmp = std::env::temp_dir().join(format!("codifa-nonutf8-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("latin1.txt");
        // 0xFF is never valid UTF-8; the text around it must survive the view.
        fs::write(&file, b"alpha\n\xff\xfe beta\n").unwrap();
        let root = tmp.to_str().unwrap();

        let edit = edit_file(root, "latin1.txt", "alpha", "ALPHA", false, None).unwrap_err();
        assert!(!edit.contains("binary file"), "must not collapse the cause: {edit}");
        assert!(edit.contains("not valid UTF-8"), "names the real cause: {edit}");
        assert!(edit.contains("offset 6"), "points at the bad byte: {edit}");
        // A refused edit never rewrites bytes.
        assert_eq!(fs::read(&file).unwrap(), b"alpha\n\xff\xfe beta\n");

        // A READ still shows the content, marked as lossy — refusing it threw
        // away text the model could use.
        let view = read_window(&file, 1, 10).unwrap();
        assert!(view.contains("not valid UTF-8"), "marks the lossy view: {view}");
        assert!(view.contains("alpha") && view.contains("beta"), "keeps the text: {view}");
        fs::remove_dir_all(&tmp).ok();
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
    let content = read_editable_text(&target)?;

    let occurrences = content.matches(old_string).count();
    if occurrences == 0 {
        return Err(format!(
            "old_string not found in file.{}",
            nearest_hint(&content, old_string)
        ));
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_string appears {occurrences} times — include more surrounding lines to make it unique, or pass replace_all=true{}",
            ambiguous_hint(&content, old_string)
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

/// Group a batch `edits` list by the file each entry targets.
///
/// Entries without their own `path` inherit the call's top-level one. Files are
/// kept in first-appearance order so a batch still applies in the order the
/// model wrote it.
fn edits_by_path(edits: &[Value], default_path: &str) -> Vec<(String, Vec<Value>)> {
    let mut order: Vec<String> = Vec::new();
    let mut by_file: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for item in edits {
        let file = item["path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .unwrap_or(default_path)
            .to_string();
        if !by_file.contains_key(&file) {
            order.push(file.clone());
        }
        by_file.entry(file).or_default().push(item.clone());
    }
    order
        .into_iter()
        .map(|f| {
            let items = by_file.remove(&f).unwrap_or_default();
            (f, items)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// terminal (bounded, non-PTY — the interactive PTY stays in pty.rs)
// ---------------------------------------------------------------------------

/// Run a shell command in `root` with a timeout, returning combined output.
/// Mirrors tools.py run_terminal: kill on timeout, cap the output.
pub fn run_terminal(root: &str, command: &str, timeout_secs: u64) -> Result<String, String> {
    run_terminal_bounded(root, command, timeout_secs, MAX_TERMINAL_TIMEOUT_SECS)
}

/// Same as [`run_terminal`], with an explicit ceiling instead of the global
/// one.
///
/// A plugin-script run passes its own bound here: a paid article/image call
/// legitimately takes minutes, so the script's window is decided by the plugin
/// layer rather than inherited from the terminal default.
pub fn run_terminal_bounded(
    root: &str,
    command: &str,
    timeout_secs: u64,
    ceiling: u64,
) -> Result<String, String> {
    run_terminal_bounded_with(root, command, timeout_secs, ceiling, None)
}

/// The last `max` bytes of the combined output buffer, as lossy UTF-8 cut on a
/// char boundary (the buffer can end mid-char while a reader holds half of a
/// Persian/emoji codepoint).
fn combined_tail(output: &Mutex<Vec<u8>>, max: usize) -> String {
    let guard = output.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_empty() {
        return String::new();
    }
    let mut cut = guard.len().saturating_sub(max);
    // A byte position is a char boundary unless it lands INSIDE a multi-byte
    // UTF-8 sequence (a continuation byte: 0b10xxxxxx).
    while cut < guard.len() && (guard[cut] & 0xC0) == 0x80 {
        cut += 1;
    }
    String::from_utf8_lossy(&guard[cut..]).into_owned()
}

/// Same as [`run_terminal_bounded`], plus an optional [`TailSink`] that
/// receives the live output tail while the command is still running.
pub fn run_terminal_bounded_with(
    root: &str,
    command: &str,
    timeout_secs: u64,
    ceiling: u64,
    on_tail: Option<&TailSink>,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let start = Instant::now();
    // Second belt beside the dispatch-side clamp: EVERY caller of this
    // function is bounded by the caller's ceiling, so a future caller cannot
    // re-open the hole the dispatch clamp closed.
    //
    // TWO zeroes mean "wait for the child, however long it takes":
    //  * `timeout_secs == 0` — the caller wants no deadline (a plugin script,
    //    which must never be killed after it has already paid for its work);
    //  * `ceiling == 0` — the caller has no cap to impose, so its own value is
    //    used as given instead of being clipped.
    let timeout_secs = if timeout_secs == 0 {
        0
    } else if ceiling == 0 {
        timeout_secs
    } else {
        let clamped = timeout_secs.min(ceiling);
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

    // `None` = unbounded: the loop below then only exits on child exit or a
    // full output buffer.
    let deadline = (timeout_secs > 0).then(|| Duration::from_secs(timeout_secs));
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
                        // Past the cap the bytes are DISCARDED but the pipe keeps
                        // being drained: an unbounded child (a plugin script) that
                        // writes more than the buffer must never block on a full
                        // pipe, because there is no deadline left to rescue it.
                        if guard.len() < cap {
                            let room = cap - guard.len();
                            let take = n.min(room);
                            guard.extend_from_slice(&buf[..take]);
                        }
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
                        if guard.len() < cap {
                            let room = cap - guard.len();
                            let take = n.min(room);
                            guard.extend_from_slice(&buf[..take]);
                        }
                    }
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        });
        readers += 1;
    }

    let mut overflowed = false;
    // Live-output ticker: every TERMINAL_TAIL_EMIT_MS the current tail of the
    // combined output goes to `on_tail` while the child is still alive. Only a
    // GROWN buffer emits — a command sitting quiet (a build with no new
    // output) does not re-send the same bytes.
    let mut next_tail = Duration::from_millis(TERMINAL_TAIL_EMIT_MS);
    let mut last_tail_len = 0usize;
    let timed_out = loop {
        if deadline.map(|d| start.elapsed() > d).unwrap_or(false) {
            break true;
        }
        match child.try_wait() {
            Ok(Some(_)) => break false,
            // Still running (or the wait itself failed) — keep polling.
            Ok(None) | Err(_) => {}
        }
        // Once either stream filled the cap a BOUNDED call has nothing left to
        // gain by waiting: the child is killed below, which also closes the
        // pipes. An UNBOUNDED one (a plugin script) is never killed for talking
        // too much — it keeps running to completion and its output is truncated
        // at the end, since killing it after it already paid for its work is the
        // very bug this budget was introduced to stop.
        if deadline.is_some() {
            let full = output.lock().map(|o| o.len() >= cap).unwrap_or(false);
            if full {
                overflowed = true;
                break false;
            }
        }
        if let Some(sink) = on_tail {
            if start.elapsed() >= next_tail {
                next_tail = start.elapsed() + Duration::from_millis(TERMINAL_TAIL_EMIT_MS);
                let len = output.lock().map(|o| o.len()).unwrap_or(0);
                if len != last_tail_len {
                    last_tail_len = len;
                    let tail = combined_tail(&output, TERMINAL_TAIL_BYTES);
                    if !tail.is_empty() {
                        sink(&tail);
                    }
                }
            }
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

/// Warn when a bundle's scripts hard-code a `$HOME` path outside their own
/// folder.
///
/// Same shape as [`plugin_keyword_warning`]: the model writes the source, and a
/// literal home path looks perfectly fine until the bundle runs somewhere else —
/// or, worse, until a scheduled run (who nobody can answer a permission gate)
/// touches it. The warning rides AFTER the JSON so the reply stays
/// machine-readable up to the first newline.
fn plugin_detached_path_warning(store: &Path, view: &Value) -> String {
    let Some(slug) = view["slug"].as_str() else {
        return String::new();
    };
    let paths = crate::plugins::script_outside_paths(store, slug);
    if paths.is_empty() {
        return String::new();
    }
    format!(
        "\nWARNING: these absolute $HOME paths are hard-coded in the bundle's scripts but sit \
         OUTSIDE the bundle folder: {}. A bundle must resolve its own files relative to itself \
         (the runner starts a script with the bundle as its working directory) — a literal stops \
         being true when the bundle is installed elsewhere, and any other $HOME path is outside \
         every root a scheduled run may touch, which stalls the run on a permission gate nobody \
         can answer. Rewrite them with action=update.",
        paths.join(", ")
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
    // A CLEARLY dominant hit answers here: when the best score beats the runner-up
    // outright, listing candidates and waiting for a second call is a wasted
    // round. Traced (`mvyy1qf7`): `load_skill(query:"Test UI live browser harness
    // renderer")` listed Test UI beside three skills that matched one filler word,
    // and the model then spent the SECOND call naming it — twice in one turn.
    let dominant = scored
        .first()
        .map(|(best, _)| {
            *best >= SKILL_DOMINANT_MIN_SCORE
                && scored.get(1).map(|(next, _)| next * 2 < *best).unwrap_or(true)
        })
        .unwrap_or(false);
    match scored.len() {
        0 => Err(format!(
            "no skill matches {query:?}. Available: {}",
            available_hint(&all)
        )),
        // Exactly one skill fits the words: returning its body saves the model
        // the second call it would have spent naming it.
        1 => Ok(skill_body(&scored[0].1)),
        _ if dominant => Ok(skill_body(&scored[0].1)),
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
    dispatch_bounded(root, name, args, permit, data_root)
}

/// The dispatch every caller ends up in, whatever spawned it (main agent,
/// sub-agent, scheduler, HTTP route).
///
/// There is no headless/interactive distinction here on purpose: one budget
/// ([`MAX_TERMINAL_TIMEOUT_SECS`]) covers every foreground wait, so a scheduled
/// run and a chat turn can never disagree about how long work may take.
pub fn dispatch_bounded(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
) -> Result<String, String> {
    dispatch_bounded_with(root, name, args, permit, data_root, None)
}

/// Same as [`dispatch_bounded`], with an optional [`TailSink`] for the
/// `run_terminal` handler: while a dispatched command runs, its live output
/// tail flows to the sink (the agent loop turns it into UI events). Every
/// other handler ignores it. Callers that hold the sink keep the call alive —
/// the sink is `Option<&TailSink>`, borrowed for the dispatch's duration.
pub fn dispatch_bounded_with(
    root: &str,
    name: &str,
    args: &Value,
    permit: Option<&Value>,
    data_root: Option<&str>,
    on_tail: Option<&TailSink>,
) -> Result<String, String> {
    // One number for every wait this dispatch may block on.
    let ceiling = MAX_TERMINAL_TIMEOUT_SECS;
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
            let mut targets: Vec<(String, usize, usize, bool)> = Vec::new();
            if let Some(ranges) = ranges_of(args) {
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
                        // A window the model SIZED ITSELF is served exactly; only
                        // the default window may stretch to the file tail.
                        r["limit"].is_null(),
                    ));
                }
            } else if let Some(paths) = args["paths"].as_array() {
                if paths.is_empty() {
                    return Err("read: `paths` was empty — pass `ranges` entries instead".into());
                }
                let offset = args["offset"].as_u64().unwrap_or(DEFAULT_READ_OFFSET as u64) as usize;
                let limit = args["limit"].as_u64().unwrap_or(DEFAULT_READ_LIMIT as u64) as usize;
                for p in paths.iter().filter_map(Value::as_str) {
                    targets.push((p.to_string(), offset, limit, args["limit"].is_null()));
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
                for (file, offset, limit, extend) in targets {
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
                    out.push_str(&read_window_block_capped(
                        &abs, &file, offset, limit, per_block, extend,
                    )?);
                    // ONE map per file per turn, on the FIRST window taken from
                    // it — including when the model asks for ranges. MEASURED:
                    // all 205 read windows of a 234-round trace were 40-70 line
                    // peeks, so the single-path-only outline never fired and the
                    // model walked `agent.rs` 94 times blind.
                    out.push_str(&outline_note_once(&abs, &file));
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
            // An empty path resolves to the workspace ROOT, which answers every
            // window request with a directory listing marked `ok`. That is never
            // what a read meant, so say so instead of billing a useless round.
            if path.trim().is_empty() {
                return Err(
                    "read: no file named — pass `filePath`, or \
                     ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":400},…] for several windows".into(),
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
            let block = read_window_block_capped(
                &abs,
                &path,
                offset,
                limit,
                crate::agent::MODEL_RESULT_CAP,
                args["limit"].is_null(),
            )?;
            // A LARGE file gets its own outline in the same result. Traced
            // (mvxqpye6): the model walked a 16_861-line file in 120-line windows
            // — 98 reads, 73% of every byte it pulled in — because nothing told
            // it where anything was. The map is a few hundred bytes and turns
            // the rest of that walk into targeted windows.
            Ok(format!("{block}{}", outline_note_once(&abs, &path)))
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
                return Err(broad_pattern_refusal(&joined));
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
            // Order matters: the result cap is a TAIL cut, so what is appended
            // LAST survives. The follow-up hint keeps the final slot (it is the
            // instruction), and the symbol answer sits ABOVE it because a real
            // definition+usages payload is worth more than an outline when a
            // huge grep result forces one of them out.
            Ok(format!(
                "{result}{}{}{}",
                grep_outline_block(root, &result, permit),
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
        "write_file" => {
            // `write_file` plans a WHOLE file, so a call that arrives without one
            // is not a small write — it is the model having dropped the argument.
            // Answering it with `fs::write(.., "")` truncated the target to zero
            // bytes and still reported "Successfully wrote … (0 bytes)", which
            // reads as done. Traced in one chat: 16 identical calls to the same
            // path, each `{path}` only, each "0 bytes" — the model could not see
            // that its content never arrived, so it re-sent the same call until
            // the turn ran out. Refuse instead, and name the argument.
            // An EXPLICIT empty string stays legal (it empties a file on
            // purpose); only an ABSENT/short-circuited body is refused.
            let content = args["content"].as_str();
            let content = match content {
                Some(c) => c,
                None => {
                    return Err(format!(
                        "write_file needs `content` and this call sent none (path={:?}). For a brand-new file pass the WHOLE file as `content`; for an existing one use `edit_file` with the exact old_string/new_string instead of rewriting it.",
                        s("path")
                    ))
                }
            };
            write_file(root, &s("path"), content, permit)
        }
        "edit_file" => {
            let path = {
                let p = s("path");
                if p.is_empty() { s("filePath") } else { p }
            };
            // A batch may name its file ONLY per entry (`edits: [{path, …}]`, the
            // shape the schema advertises). The top-level `path` is then absent,
            // so resolving it landed on the workspace ROOT and the edit died with
            // "cannot read <root> for editing: Is a directory (os error 21)" — a
            // message that named no file at all. Correcting it therefore needed a
            // reinterpretation of the request rather than a retry, and it cost a
            // whole round.
            let path = if path.is_empty() {
                args["edits"]
                    .as_array()
                    .and_then(|edits| edits.first())
                    .and_then(|first| first["path"].as_str())
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .unwrap_or(path)
            } else {
                path
            };
            // A writer needs a FILE. When neither shape named one, the empty
            // path resolved to the workspace ROOT and died inside
            // `read_editable_text` as "cannot read <root> for editing: Is a
            // directory (os error 21)" — a message that names no file, so the
            // model had to reinterpret the whole call instead of correcting it.
            // Refuse at the boundary, in the words of the argument it lacked.
            if path.trim().is_empty() {
                return Err(
                    "edit_file: no file named — pass `path`, or a `path` on each entry of \
                     `edits` ({\"path\": \"src/a.ts\", \"old_string\": …, \"new_string\": …})"
                        .into(),
                );
            }
            // A batch may name a DIFFERENT file per entry (`edits: [{path, …}]`,
            // the shape the schema advertises). The single-file body below
            // presumes one target, so a multi-file batch is applied here, one
            // recursive call per file, and reported together.
            //
            // Without this the per-entry `path` was silently IGNORED and every
            // entry landed on the top-level path: a cross-file batch failed with
            // "old_string not found" on the wrong file, the model could not tell
            // which file had been edited, and it paid a re-read plus a retry
            // round per file (traced: 13 edits over 2 files took 11 rounds — the
            // exact "several round trips to edit one file" shape).
            if let Some(edits) = args["edits"].as_array() {
                let groups = edits_by_path(edits, &path);
                if groups.len() > 1 {
                    let mut done: Vec<String> = Vec::new();
                    let mut failed: Vec<String> = Vec::new();
                    for (file, items) in groups {
                        let sub = json!({ "path": file, "edits": Value::Array(items) });
                        match dispatch_bounded(root, "edit_file", &sub, permit, data_root) {
                            // Reuse the single-file result verbatim: it already
                            // carries the partial-success wording and the
                            // post-edit diagnostics for its own file.
                            Ok(msg) => done.push(msg),
                            Err(e) => failed.push(format!("{file}: {e}")),
                        }
                    }
                    if done.is_empty() {
                        return Err(format!("no edit applied to any file. {}", failed.join("; ")));
                    }
                    let mut out = done.join("\n");
                    if !failed.is_empty() {
                        out.push_str(&format!(
                            "\n{} file(s) FAILED and were NOT edited — fix ONLY these next: {}",
                            failed.len(),
                            failed.join("; ")
                        ));
                    }
                    return Ok(out);
                }
            }
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
                let mut content = read_editable_text(&target)?;
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
                        if hint.is_none() {
                            hint = Some(ambiguous_hint(&content, old));
                        }
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
                        post_edit_diagnostics(root, &path, permit)
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
                    post_edit_diagnostics(root, &path, permit)
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
            Ok(format!("{edit}{}", post_edit_diagnostics(root, &path, permit)))
        }
        "run_terminal" => {
            let requested = args["timeout"].as_u64().unwrap_or(120);
            // Validation at the boundary: the MODEL picks this number via the
            // schema, and an unclamped large value pinned a worker for the
            // whole of it (a scheduled monitor call ran 90 minutes with the
            // run row parked on "running" and not one line in rust.log).
            // Long jobs belong in `background=true` terminals, so anything
            // past the ceiling is CLAMPED, not failed.
            let timeout = requested.min(ceiling);
            if timeout != requested {
                eprintln!(
                    "[tool] run_terminal: requested timeout {requested}s exceeds the {ceiling}s \
ceiling; clamped to {timeout}s (long jobs must use background=true)"
                );
            }
            // The ceiling is passed through explicitly so the inner clamp
            // cannot re-open a smaller bound than the one this dispatch chose.
            run_terminal_bounded_with(root, &s("command"), timeout, ceiling, on_tail)
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
                crate::lsp::locate_symbol(root, &file, symbol.trim(), args["line"].as_i64(), permit)?
            } else if let Some(line) = args["line"].as_i64() {
                (line, args["character"].as_i64().unwrap_or(0))
            } else {
                return Err("pass filePath + symbol=<identifier> (preferred), or filePath + line + character".into());
            };
            match name {
                "lsp_definition" => {
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::definition(root, &file, line, character, permit)
                }
                "lsp_references" => {
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::references(root, &file, line, character, permit)
                }
                _ => {
                    // A hover with no warm server would cold-start rust-analyzer
                    // for one tooltip. Answer with the definition body instead:
                    // the same information, instantly, no index.
                    if !crate::lsp::is_warm(root, &file, permit) {
                        return find_symbol_in(Path::new(root), symbol.trim(), &file, "", permit);
                    }
                    crate::lsp::hover(root, &file, line, character, permit)
                }
            }
        }
        // Outline a file WITHOUT paying a cold language server: the native
        // outline answers instantly for every language, and a warm server gives
        // the exact LSP symbols. Only when neither exists does this start one
        // (see `lsp::symbols`), because that is the case a cheap outline cannot
        // cover — exact kinds and ranges from a real index.
        "lsp_symbols" => {
            let file = s("filePath");
            if let Some(found) = crate::lsp::symbols_if_warm(root, &file, &s("query"), permit) {
                return Ok(found);
            }
            match resolve_safe(root, &file, false, permit) {
                Ok(abs) if abs.is_file() => tools_outline(&abs, &s("query")),
                // A directory is a legitimate thing to name — the model has the
                // path but not a file in it. Refusing cost a whole round (traced
                // as `lsp_symbols "src"` → "outlines ONE file — src is a
                // directory") when the answer it wanted, that folder's entries,
                // was one read away. Answer it here instead, and name the one
                // call that DOES outline a file so the next round is exact.
                Ok(abs) if abs.is_dir() => {
                    let listing = list_dir(&abs, DEFAULT_READ_OFFSET, DEFAULT_READ_LIMIT)?;
                    let files: Vec<&str> = listing
                        .lines()
                        .filter(|e| !e.ends_with('/') && !e.starts_with('('))
                        .take(3)
                        .collect();
                    let named = if files.is_empty() {
                        "none of its entries is a file".to_string()
                    } else {
                        format!("pick one (`{}`) and call lsp_symbols on it", files.join("`, `"))
                    };
                    Ok(format!(
                        "{file}/ is a DIRECTORY — lsp_symbols outlines ONE file, so here are its \
                         entries instead:\n{listing}\n\n{named}, or pass a `query` with a glob-shaped \
                         `path` to `grep`."
                    ))
                }
                Ok(_) => crate::lsp::symbols(root, &file, &s("query"), permit),
                Err(e) => Err(e),
            }
        }
        "lsp_diagnostics" => crate::lsp::diagnostics(root, &s("filePath"), permit),
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
                    let detached = plugin_detached_path_warning(store, &v["plugin"]);
                    format!("{v}{warning}{detached}")
                }),
                // Creating and updating a bundle writes skills exactly like an
                // install does, so both say the same thing when they land bare.
                "create" => crate::plugins::create_plugin(store, args).map(|v| {
                    let warning = plugin_keyword_warning(store, &v);
                    let detached = plugin_detached_path_warning(store, &v);
                    format!("{v}{warning}{detached}")
                }),
                "update" => crate::plugins::update_plugin(store, args).map(|v| {
                    let warning = plugin_keyword_warning(store, &v);
                    let detached = plugin_detached_path_warning(store, &v);
                    format!("{v}{warning}{detached}")
                }),
                "toggle" => crate::plugins::toggle_plugin(store, args).map(|v| {
                    let on = v["enabled"].as_bool().unwrap_or(false);
                    format!("{}\n{}", if on { "Plugin enabled" } else { "Plugin disabled" }, v)
                }),
                "delete" => crate::plugins::delete_plugin(store, args).map(|v| v.to_string()),
                // The script's own window is decided by the plugin layer alone:
                // no plugin default and no caller ceiling, so a paid script is
                // never cut off mid-flight.
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

/// Keywords that START a declaration an outline reports, across the languages
/// this IDE edits (Rust, TypeScript/JS, Python, Go, Java/C#, shell, Ruby).
const OUTLINE_KEYWORDS: [&str; 15] = [
    "fn", "def", "class", "struct", "enum", "trait", "interface", "impl", "type", "function",
    "func", "mod", "macro_rules", "sub", "procedure",
];

/// Words that may precede a declaration keyword without being it.
const OUTLINE_MODIFIERS: [&str; 11] = [
    "export", "default", "async", "unsafe", "extern", "static", "abstract", "readonly",
    "override", "declare", "final",
];

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
    for g in include_globs(include) {
        cmd.arg("--glob").arg(g);
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

/// First real word of a declaration line, plus whether it was unindented.
///
/// Modifiers and a `pub(…)` visibility group are skipped, and the word is cut
/// at `(`, `<`, `!`, `:` and friends so `impl<T>`, `macro_rules!` and `fn(` all
/// reduce to the bare keyword. Comment and attribute lines answer `None`.
fn declaration_word(line: &str) -> Option<(&str, bool)> {
    let trimmed = line.trim_start();
    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with('*')
        || trimmed.starts_with("/*")
        || trimmed.starts_with('#')
    {
        return None;
    }
    let unindented = trimmed.len() == line.len();
    let mut rest = trimmed;
    if let Some(stripped) = rest.strip_prefix("pub(") {
        rest = stripped.find(')').map(|i| &stripped[i + 1..]).unwrap_or_default();
    } else if let Some(stripped) = rest.strip_prefix("pub ") {
        rest = stripped;
    }
    for tok in rest.split_whitespace() {
        let word = tok
            .split(|c: char| matches!(c, '<' | '!' | '(' | '{' | ':' | ';' | ',' | '='))
            .next()
            .unwrap_or_default();
        if word.is_empty() || OUTLINE_MODIFIERS.contains(&word) {
            continue;
        }
        return Some((word, unindented));
    }
    None
}

/// Whether this line declares something an outline should report.
///
/// A binding keyword (`const`/`let`/`var`) is reported only at column 0: at the
/// top level it IS a declaration (`export const Foo = () => {}`), while the same
/// word indented is a statement inside a body and would flood the outline.
fn is_outline_line(line: &str) -> bool {
    let Some((word, unindented)) = declaration_word(line) else {
        return false;
    };
    if matches!(word, "const" | "let" | "var") {
        return unindented;
    }
    OUTLINE_KEYWORDS.contains(&word)
}

/// Rows a landmark map may spend. A landmark map spans the whole file, so its
/// size is capped apart from the declaration cap: measured on this repo's
/// `global.css`, 120 rows came to 8.8K chars — too much to rider on a read
/// result, while 64 rows still name every ~470 lines.
const LANDMARK_MAP_ROWS: usize = 64;

/// A column-0 COMMENT: the strongest navigation landmark a stylesheet or markup
/// file has, because it names a whole section rather than one rule inside it.
fn is_section_banner(line: &str) -> bool {
    if line.chars().next().is_some_and(char::is_whitespace) {
        return false;
    }
    let t = line.trim_start();
    t.starts_with("/*") || t.starts_with("//") || t.starts_with("#")
}

/// Column-0 line that names WHERE the reader is: a comment banner, a stylesheet
/// selector, an `@rule`, a markup tag or a markdown heading.
///
/// This is the stylesheet/markup counterpart of a declaration line: such a file
/// has no functions to list, so the only thing a map can say about it is which
/// section starts where.
fn is_landmark_line(line: &str) -> bool {
    let Some(first) = line.chars().next() else {
        return false;
    };
    if first.is_whitespace() {
        return false;
    }
    let t = line.trim_start();
    is_section_banner(line) || t.starts_with('@') || t.starts_with('<') || t.ends_with('{')
}

/// A map for a file that declares NOTHING (stylesheets, markup, data files).
///
/// Advances in equal shares of the file and reports the first landmark inside
/// each, so the map SPANS the whole thing instead of naming its first 120 lines
/// and stopping. Returns the rows and the stride used, so the header can say how
/// coarse the map is.
fn landmark_rows(lines: &[&str], budget: usize, query: &str) -> (Vec<(usize, String)>, usize) {
    const ROW_CHARS: usize = 100;
    if lines.is_empty() || budget == 0 {
        return (Vec::new(), 0);
    }
    let stride = lines.len().div_ceil(budget).max(1);
    let mut rows = Vec::new();
    let mut start = 0usize;
    while start < lines.len() && rows.len() < budget {
        let stop = (start + stride).min(lines.len());
        let share = &lines[start..stop];
        // A share is named by its BANNER when it has one (a comment marks a new
        // section, a selector only marks one rule inside it); otherwise by its
        // first landmark, and failing that by its first non-blank line — so the
        // map never develops a hole it cannot name.
        let hit = share
            .iter()
            .position(|l| is_section_banner(l))
            .or_else(|| share.iter().position(|l| is_landmark_line(l)))
            .or_else(|| share.iter().position(|l| !l.trim().is_empty()));
        if let Some(i) = hit {
            let text: String = share[i].trim_end().chars().take(ROW_CHARS).collect();
            if query.is_empty() || text.to_lowercase().contains(query) {
                rows.push((start + i + 1, text));
            }
        }
        start = stop;
    }
    (rows, stride)
}

/// Definition lines of ONE file, without a language server.
///
/// `lsp_symbols` needs a WARM server, and on the languages that matter most here
/// it never has one: `rust-analyzer` measured 1921 MB and minutes of cold
/// indexing, so it is deliberately never pre-warmed. MEASURED on the traced
/// 91-round run (mvxqpye6): **zero** `lsp_symbols` calls while the model
/// hand-rolled the same thing with `grep '^pub fn|^fn |^pub\(crate\) fn'` and
/// then walked a 16_861-line file window by window — 98 read windows, 73% of
/// every byte it pulled into the context. This answers that grep in one call,
/// instantly, for every language at once.
pub(crate) fn native_outline(abs: &Path, query: &str) -> Result<String, String> {
    // A MAP, not the file. `agent.rs` in this very repo holds 424 declaration
    // lines (24K chars); the outline rides along with a read result, so it is
    // capped to the size of the window it accompanies. Past the cap the header
    // says so and `query` is the way to narrow it.
    const MAX_ROWS: usize = 120;
    const ROW_CHARS: usize = 100;
    let src = fs::read_to_string(abs)
        .map_err(|e| format!("cannot outline {}: {e}", abs.display()))?;
    let lines: Vec<&str> = src.lines().collect();
    let q = query.trim().to_lowercase();
    let mut rows: Vec<(usize, String)> = Vec::new();
    // Counts EVERY match, so the "+N more" line tells the truth instead of
    // reporting the cap it stopped at as if it were the total.
    let mut total_rows = 0usize;
    for (i, line) in lines.iter().enumerate() {
        if !is_outline_line(line) {
            continue;
        }
        let shown: String = line.trim_end().chars().take(ROW_CHARS).collect();
        if !q.is_empty() && !shown.to_lowercase().contains(&q) {
            continue;
        }
        total_rows += 1;
        if rows.len() < MAX_ROWS {
            rows.push((i + 1, shown));
        }
    }
    let name = abs.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    // A stylesheet or markup file declares no functions, so the scan above finds
    // nothing — yet those are exactly the files that get walked window by window.
    // MEASURED (trace `mvyy1qf7`): ONE turn took 30 separate `read` windows of
    // `src/styles/global.css` (67_639 chars) and the file never once carried a
    // map, because this outline answered "no definition lines". A landmark map
    // costs one call's worth of chars and spans the whole file.
    let mut stride = 0usize;
    let mut landmark = false;
    if rows.is_empty() {
        let (sampled, step) = landmark_rows(&lines, LANDMARK_MAP_ROWS, &q);
        if !sampled.is_empty() {
            rows = sampled;
            total_rows = rows.len();
            stride = step;
            landmark = true;
        }
    }
    if rows.is_empty() {
        return Ok(format!(
            "No definition lines in {name} ({} lines) — this outline sees no functions, types \
             or top-level bindings; read the window you need with `read` instead.",
            lines.len()
        ));
    }
    let mut out = if landmark {
        format!(
            "OUTLINE {name} — landmark map, one row per ~{stride} lines of {} total \
             (this file declares no functions, so there is no language-server outline)\n",
            lines.len()
        )
    } else {
        format!(
            "OUTLINE {name} — {} definition line(s) of {} total (native: no language server started)\n",
            rows.len(),
            lines.len()
        )
    };
    for (n, text) in &rows {
        out.push_str(&format!("{n}: {text}\n"));
    }
    if total_rows > rows.len() {
        out.push_str(&format!(
            "(+{} more declaration line(s) not shown — narrow with `query`, or `find_symbol` when \
             you can name the symbol)\n",
            total_rows - rows.len()
        ));
    }
    out.push_str(if landmark {
        "\nNow `read` the section you need by its line number (offset/limit) — a stylesheet is \
         navigated by section, not by declaration.\n"
    } else {
        "\nNow `read` ONLY the window you need (offset/limit) — do not walk the file. \
         `lsp_definition` still starts a language server when exact cross-file precision matters.\n"
    });
    Ok(out)
}

/// Alias used by the `lsp_symbols` dispatch arm (see [`native_outline`]).
pub(crate) fn tools_outline(abs: &Path, query: &str) -> Result<String, String> {
    native_outline(abs, query)
}

/// `read`'s map-request note: a big file gets its OUTLINE in the same result.
///
/// Without this a model that names a 16k-line file gets one 120-line window and
/// has no idea where anything is — exactly what the traced run did (98 windows
/// over `agent.rs`, 73% of every byte it pulled into its context). The outline is
/// a handful of lines and turns the next step into ONE targeted window read.
fn outline_note(abs: &Path, path_label: &str) -> String {
    let Ok(src) = fs::read_to_string(abs) else {
        return String::new();
    };
    let total = src.lines().count();
    if total <= READ_OUTLINE_MIN_LINES {
        return String::new();
    }
    let Ok(list) = native_outline(abs, "") else {
        return String::new();
    };
    // Header line, rows, and the two trailing notes are not definitions.
    if list.lines().count() <= 4 {
        return String::new();
    }
    format!(
        "\n\n[{READ_OUTLINE_MARK}{path_label} has {total} lines: this outline names them, so \
         read the NEXT window from the line numbers below — do not walk the file window by window]\n{list}"
    )
}

/// Files that already carried their outline in THIS turn (see
/// [`outline_note_once`]). Module-level so the claim and the reset act on the
/// SAME set — two function-local statics would be two unrelated variables.
static OUTLINE_CLAIMED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// The SAME outline, but once per file per turn.
///
/// MEASURED on a 234-round trace of this very repo: 205 read windows over 17
/// files, and the model walked `agent.rs` 94 times — 40/60/70-line peeks, never
/// a default-limit read. So `outline_note` (which only fired on default reads)
/// never once appeared in the whole run. Re-sending the map on every peek would
/// cost more than it saves, so this is claimed ONCE: the first window the turn
/// takes from a large file carries its definition map, and every later window
/// of that file stays a plain window. Claiming is keyed on the canonical path so
/// `./src/a.rs` and `/abs/src/a.rs` are the same file.
fn outline_note_once(abs: &Path, path_label: &str) -> String {
    let key = fs::canonicalize(abs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs.to_string_lossy().into_owned());
    if let Ok(seen) = OUTLINE_CLAIMED.lock() {
        if seen.iter().any(|s| s == &key) {
            return String::new();
        }
    }
    // Claim AFTER the map exists, never before. Traced (`mvyy1qf7`): one turn took
    // 30 `read` windows of `src/styles/global.css` and only the LAST one carried a
    // map — the earlier attempt returned an empty note (no declarations to name at
    // that moment) yet had already consumed the file's one claim, so every later
    // window of the largest file in the repo stayed blind for the rest of the turn.
    // An attempt that attached nothing must leave the claim open.
    let note = outline_note(abs, path_label);
    if note.is_empty() {
        return note;
    }
    if let Ok(mut seen) = OUTLINE_CLAIMED.lock() {
        // Another read of the same file may have won the race while this map was
        // being built; sending it twice is the cost this claim exists to avoid.
        if seen.iter().any(|s| s == &key) {
            return String::new();
        }
        seen.push(key);
    }
    note
}

/// Forgets which files already carried their outline.
///
/// Called by the turn loop when a NEW turn starts, so the map is re-sent to a
/// fresh transcript (which has no earlier copy of it) but never repeated inside
/// one turn. Best-effort: a poisoned lock only means the map is skipped.
pub(crate) fn reset_outline_claims() {
    if let Ok(mut seen) = OUTLINE_CLAIMED.lock() {
        seen.clear();
    }
}

/// Serializes the tests that mutate [`OUTLINE_CLAIMED`].
///
/// The set is process-global and production resets it per turn, so two tests
/// calling `reset_outline_claims` in parallel clear each other's claim mid-run —
/// MEASURED: `a_grep_hit_carries_the_outline_of_the_file_it_found` failed in 5
/// of 10 full-suite runs while passing alone every time. A shared guard makes
/// those tests observe their own claim; it costs nothing outside `cfg(test)`.
#[cfg(test)]
static OUTLINE_CLAIM_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Hold this for the whole body of any test that claims or resets an outline.
#[cfg(test)]
fn outline_claim_lock() -> std::sync::MutexGuard<'static, ()> {
    // A poisoned guard means an earlier claimant panicked; the state it guarded
    // is a plain set that the next `reset_outline_claims` clears, so recovering
    // is correct here and keeps one failure from cascading into the others.
    OUTLINE_CLAIM_GUARD.lock().unwrap_or_else(|e| e.into_inner())
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

    /// `grep` attaches the outline of the file it just hit, so the follow-up
    /// `read` that walk-the-file round used to cost is already answered.
    ///
    /// MEASURED on trace `mvxsy14e`: 5 of 7 lone `grep` rounds were followed by a
    /// `read`, and the hint naming `find_symbol`/`lsp_symbols` was already on
    /// those results and changed nothing. The block is what has to be there.
    ///
    /// Goes through `dispatch`, not the helper: a helper-only test passes even
    /// with the payload unwired from the grep arm, which is the "test that lies"
    /// shape this guards against.
    #[test]
    fn a_grep_hit_carries_the_outline_of_the_file_it_found() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-grep-outline-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Larger than READ_OUTLINE_MIN_LINES, or a window IS the outline.
        let mut big = String::from("pub fn first_entry() {}\n");
        for i in 0..READ_OUTLINE_MIN_LINES {
            big.push_str(&format!("fn filler_{i}() {{}}\n"));
        }
        big.push_str("pub fn last_entry() {}\n");
        fs::write(tmp.join("big.rs"), &big).unwrap();
        fs::write(tmp.join("small.rs"), "pub fn only() {}\n").unwrap();
        let root = tmp.to_str().unwrap();
        // `pub fn first` is not a bare identifier, so the symbol lever stays out
        // of this text and only the outline can put `READ_OUTLINE_MARK` there.
        let args = json!({"pattern": "pub fn first", "path": "big.rs"});

        reset_outline_claims();
        let out = dispatch(root, "grep", &args, None).unwrap();
        assert!(out.contains(READ_OUTLINE_MARK), "{out}");
        assert!(out.contains("first_entry"), "{out}");
        assert_eq!(levers_fired("grep", &out), vec!["grep_outline"]);

        // The same file again in the SAME turn is already on the wire.
        let again = dispatch(root, "grep", &args, None).unwrap();
        assert!(!again.contains(READ_OUTLINE_MARK), "{again}");

        // A small file earns no outline: an outline would be pure overhead.
        reset_outline_claims();
        let small = dispatch(root, "grep", &json!({"pattern": "pub fn only", "path": "small.rs"}), None)
            .unwrap();
        assert!(!small.contains(READ_OUTLINE_MARK), "{small}");

        // A miss has no file to outline (the miss hint covers that case).
        reset_outline_claims();
        let miss = dispatch(root, "grep", &json!({"pattern": "zzz_absent_zzz", "path": "big.rs"}), None)
            .unwrap();
        assert!(!miss.contains(READ_OUTLINE_MARK), "{miss}");
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
        let quiet = post_edit_diagnostics(root, "a.rs", None);
        assert!(quiet.is_empty(), "{quiet}");
        // An unusable path is silent too — diagnostics are a bonus, not a failure.
        assert!(post_edit_diagnostics(root, "missing.rs", None).is_empty());
        assert!(post_edit_diagnostics(root, "../escape.rs", None).is_empty());
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

    /// The native outline is what makes `lsp_symbols` instant: it must find real
    /// declarations across languages and never report a statement as one.
    #[test]
    fn native_outline_finds_declarations_and_ignores_statements() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let rs = tmp.join("a.rs");
        fs::write(
            &rs,
            "//! docs\n\n#[derive(Debug)]\npub struct Store {\n    n: u8,\n}\n\npub(crate) fn load(\n) -> u8 {\n    let n = 1;\n    n\n}\n\nimpl Store {\n    fn new() -> Self { Self { n: 0 } }\n}\n",
        )
        .unwrap();
        let out = native_outline(&rs, "").unwrap();
        assert!(out.contains("pub struct Store"), "{out}");
        assert!(out.contains("pub(crate) fn load"), "{out}");
        assert!(out.contains("fn new()"), "{out}");
        // A binding INSIDE a body is a statement, not a declaration.
        assert!(!out.contains("let n = 1"), "a body statement leaked: {out}");

        // `query` narrows by name, and a miss says so instead of lying.
        assert!(native_outline(&rs, "load").unwrap().contains("load"));
        assert!(!native_outline(&rs, "load").unwrap().contains("struct Store"));

        // TypeScript: export/default/async modifiers are skipped, not reported.
        let ts = tmp.join("a.ts");
        fs::write(&ts, "export default async function run() {}\nexport const VERSION = 1;\nfunction inner() { const x = 1; }\n").unwrap();
        let t = native_outline(&ts, "").unwrap();
        assert!(t.contains("function run()"), "{t}");
        assert!(t.contains("const VERSION"), "{t}");
        // A statement inside a body gets NO ROW of its own: exactly the two
        // declarations — and the `inner` row may still quote `const x` on its
        // own source line, which is not a row of its own.
        let rows = t.lines().filter(|l| l.starts_with(|c: char| c.is_ascii_digit())).count();
        assert_eq!(rows, 3, "only declarations get rows: {t}");

        fs::remove_dir_all(&tmp).ok();
    }

    /// A file that declares nothing still gets a map that SPANS it.
    ///
    /// Traced (`mvyy1qf7`): one turn took 30 separate `read` windows of
    /// `src/styles/global.css` because the outline answered "no definition
    /// lines" — the model had no map of a 30k-line stylesheet and walked it.
    #[test]
    fn native_outline_maps_a_stylesheet_by_landmarks() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-landmark-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let css = tmp.join("a.css");
        let mut body = String::from("/* \u{2500}\u{2500} tokens \u{2500}\u{2500} */\n:root {\n  --bg: #000;\n}\n");
        // Far more lines than the row budget, so the map must SAMPLE rather than
        // spend every row on the top of the file.
        for i in 0..2_000 {
            body.push_str(&format!(".rule-{i} {{\n  color: red;\n}}\n"));
        }
        body.push_str("/* \u{2500}\u{2500} the very last section \u{2500}\u{2500} */\n.tail {\n  color: blue;\n}\n");
        fs::write(&css, &body).unwrap();

        let out = native_outline(&css, "").unwrap();
        assert!(out.contains("landmark map"), "must say what kind of map: {out}");
        // Spans the file: a row near the end proves it is not the first-N cap.
        assert!(out.contains("the very last section"), "map stops early: {out}");
        let rows = out.lines().filter(|l| l.starts_with(|c: char| c.is_ascii_digit())).count();
        assert!(rows > 20, "too coarse to navigate: {rows} rows");

        // A real declaration file is unaffected: definitions win over landmarks.
        let rs = tmp.join("b.rs");
        fs::write(&rs, "pub fn only() {}\n").unwrap();
        let r = native_outline(&rs, "").unwrap();
        assert!(!r.contains("landmark map"), "{r}");

        fs::remove_dir_all(&tmp).ok();
    }

    /// The map is claimed ONCE per file per turn: the first window carries it,
    /// every later window of that same file stays plain.
    #[test]
    fn the_outline_is_sent_once_per_file_per_turn() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-once-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let big = tmp.join("big.rs");
        let body: String = (0..(READ_OUTLINE_MIN_LINES + 20))
            .map(|i| format!("pub fn f{i}() {{}}\n"))
            .collect();
        fs::write(&big, body).unwrap();

        reset_outline_claims();
        let first = outline_note_once(&big, "big.rs");
        assert!(first.contains(READ_OUTLINE_MARK), "first window must carry the map");
        assert!(first.contains("pub fn f0"), "{first}");
        // Same file, second window: nothing (the map is already above).
        assert!(outline_note_once(&big, "big.rs").is_empty());
        // A NEW turn re-sends it: the fresh transcript has no copy.
        reset_outline_claims();
        assert!(outline_note_once(&big, "big.rs").contains(READ_OUTLINE_MARK));

        // A small file never earns one — a window already IS the whole file.
        let small = tmp.join("small.rs");
        fs::write(&small, "pub fn only() {}\n").unwrap();
        reset_outline_claims();
        assert!(outline_note_once(&small, "small.rs").is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    /// An attempt that attaches NO map must leave the file's one claim open.
    ///
    /// Traced (`mvyy1qf7`): one turn took 30 windows of `src/styles/global.css`
    /// and only the last carried a map — the earlier attempt answered empty (the
    /// file declares nothing) but had already consumed the claim, so every window
    /// after it stayed blind for the rest of the turn.
    #[test]
    fn an_empty_outline_does_not_consume_the_file_claim() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-outline-claim-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _claim = outline_claim_lock();
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("blank.css");
        // Big enough to earn an outline, but nothing to name yet: the map is empty.
        let blank: String = (0..(READ_OUTLINE_MIN_LINES + 20)).map(|_| "\n").collect();
        fs::write(&f, blank).unwrap();

        reset_outline_claims();
        assert!(outline_note_once(&f, "blank.css").is_empty());
        // The file gains real sections. The claim must still be open, so THIS call
        // is the one that carries the map.
        let real: String = (0..(READ_OUTLINE_MIN_LINES + 20))
            .map(|i| format!(".rule-{i} {{\n  color: red;\n}}\n"))
            .collect();
        fs::write(&f, real).unwrap();
        let after = outline_note_once(&f, "blank.css");
        assert!(
            after.contains(READ_OUTLINE_MARK),
            "an empty attempt must not burn the claim: {after:?}"
        );
        // And the claim IS spent once a map actually went out.
        assert!(outline_note_once(&f, "blank.css").is_empty());

        fs::remove_dir_all(&tmp).ok();
    }

    /// A comma/space separated `include` is what the model actually writes
    /// (`*.ts,*.tsx,*.rs`), and passing it as ONE `--glob` matched nothing —
    /// 12 of 27 traced greps answered a FALSE "no matches". Each entry gets its
    /// own glob; a brace group stays intact.
    #[test]
    fn include_globs_splits_lists_and_keeps_brace_groups() {
        assert_eq!(include_globs("*.rs"), vec!["*.rs"]);
        assert_eq!(
            include_globs("*.ts,*.tsx,*.rs"),
            vec!["*.ts", "*.tsx", "*.rs"]
        );
        assert_eq!(
            include_globs("*.ts, *.tsx"),
            vec!["*.ts", "*.tsx"],
            "space after the comma must not leave a leading space in the glob"
        );
        assert_eq!(include_globs("*.{ts,tsx}"), vec!["*.{ts,tsx}"], "a brace group is one glob");
        assert_eq!(include_globs(""), Vec::<String>::new());
        assert_eq!(include_globs(" , "), Vec::<String>::new());
    }

    /// The end-to-end shape of the traced bug: a comma list must FIND the file,
    /// where it used to answer "no matches".
    #[test]
    fn grep_with_a_comma_include_finds_the_file() {
        let tmp = std::env::temp_dir().join(format!(
            "codifa-comma-include-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();
        fs::write(tmp.join("src/a.ts"), "const compact = 1;\n").unwrap();
        fs::write(tmp.join("src/b.rs"), "fn compact() {}\n").unwrap();

        let hit = grep_scope(&tmp, "src", "compact", "*.ts,*.tsx,*.rs", 20, 0, false).unwrap();
        assert!(hit.contains("a.ts"), "{hit}");
        assert!(hit.contains("b.rs"), "{hit}");

        fs::remove_dir_all(&tmp).ok();
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
            ("a.rs".into(), 100, 50, true),
            ("a.rs".into(), 120, 80, true),
            ("a.rs".into(), 9000, 20, true),
            ("b.rs".into(), 1, 400, true),
        ]);
        assert_eq!(
            merged,
            vec![
                ("a.rs".to_string(), 100, 100, true),
                ("a.rs".to_string(), 9000, 20, true),
                ("b.rs".to_string(), 1, 400, true),
            ]
        );
        // Adjacent windows (a top-down walk) join too — one header instead of
        // two, and no seam the model has to re-read.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 130, true),
                ("a.rs".into(), 130, 120, true),
            ]),
            vec![("a.rs".to_string(), 1, 249, true)]
        );
        // An exact duplicate collapses (the old dedupe behaviour is preserved).
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 400, true),
                ("a.rs".into(), 1, 400, true),
            ]),
            vec![("a.rs".to_string(), 1, 400, true)]
        );
        // Disjoint windows stay separate: a merge must never invent a range
        // that pulls in lines nobody asked for.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 10, true),
                ("a.rs".into(), 500, 10, true),
            ]),
            vec![
                ("a.rs".to_string(), 1, 10, true),
                ("a.rs".to_string(), 500, 10, true)
            ]
        );
        // A zero limit means the DEFAULT window only when it is ABSENT — an
        // explicit 0 selects no line, and the merge must not inflate it.
        assert_eq!(
            merge_read_targets(vec![("a.rs".into(), 5, 0, true)]),
            vec![("a.rs".to_string(), 5, 0, true)]
        );
        // A deliberate narrow window keeps `extend = false` through a union with
        // a default one: the stretch-to-EOF lever must never widen a window the
        // model sized on purpose.
        assert_eq!(
            merge_read_targets(vec![
                ("a.rs".into(), 1, 400, true),
                ("a.rs".into(), 395, 10, false),
            ]),
            vec![("a.rs".to_string(), 1, 404, false)]
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

        // `ranges` spelled as a serialized JSON STRING is the same request.
        // Traced (mvxqpye6 r0): the string form matched no shape check, fell
        // through to `resolve_safe(root, "")`, and answered with a directory
        // listing flagged `ok` — two extra rounds spent disproving it.
        let as_string = dispatch(
            &root,
            "read",
            &json!({
                "ranges": "[{\"path\":\"a.txt\",\"offset\":2,\"limit\":1}]"
            }),
            None,
        )
        .unwrap();
        assert!(as_string.contains("a2"), "string ranges must be honoured: {as_string}");
        assert!(
            !as_string.contains("b.txt"),
            "a string `ranges` must never degrade to a directory listing: {as_string}"
        );

        // A read that names NO file is an error, never the workspace root.
        let nameless = dispatch(&root, "read", &json!({}), None).unwrap_err();
        assert!(nameless.contains("no file named"), "{nameless}");

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
            // The header states the file's TOTAL too: without it the model cannot
            // tell a window near EOF from one near the top of a long file, and
            // walks the file one blind window per round trip.
            assert_eq!(block, "sample.txt (lines 2-3 of 4):\n2: beta\n3: gamma\n");

            // offset 0 reads the same first line as offset 1, and the header must
        // not announce a line 0 that no file has.
        let zero = read_window_block(&file, "sample.txt", 0, 1).unwrap();
        assert_eq!(zero, "sample.txt (lines 1-1 of 4):\n1: alpha\n");

        // A window that reaches EOF omits the `of N` (it would be redundant).
        let tail = read_window_block(&file, "sample.txt", 3, 99).unwrap();
        assert_eq!(tail, "sample.txt (lines 3-4):\n3: gamma\n4: delta\n");

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
    fn grep_budget_spends_definition_lines_first_and_spreads_across_files() {
        // Traced refinement chains started from a cap that spent its lines on
        // call-site hits in the FIRST file (rg's walk order) while the
        // declaration the model was hunting sat in a later file, past the cut
        // — the model then re-grepped with a narrower pattern (a wasted round
        // trip). The budget must buy definition lines FIRST and give every
        // matching file a share, with the unseen files' mass reported.
        let tmp = std::env::temp_dir().join("codifa-grep-fair-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Walk-order FIRST file: one declaration buried in noise.
        fs::write(
            tmp.join("a_noise.rs"),
            "token call 1\ntoken call 2\ntoken call 3\nstruct token_def { x: u8 }\ntoken call 4\ntoken call 5\ntoken call 6\ntoken call 7\n",
        )
        .unwrap();
        // A middle file with NO declarations: the fair spread must skip its
        // call sites first and report its mass instead of hiding it.
        fs::write(tmp.join("m_mid.rs"), "token mid 1
token mid 2
token mid 3
").unwrap();
        // Walk-order LAST file: the target declaration.
        fs::write(tmp.join("z_late.rs"), "let token = 1;\nstruct token_target;\n").unwrap();
        let out = grep_scope(&tmp, "", "token", "", 3, 0, false).unwrap();
        // rg's file walk order is NOT stable, so these assertions are written
        // order-independently: they hold whichever file rg emits first.
        //
        // Both declarations made the budget: one file carrying a declaration can
        // no longer spend the whole allowance and starve the file that DEFINES
        // the symbol the model is hunting.
        assert!(
            out.contains("struct token_def"),
            "definition line must beat call sites inside the budget:\n{out}"
        );
        assert!(
            out.contains("struct token_target"),
            "a later file's definition must not be eaten by the first file:\n{out}"
        );
        // Every matching file is ACCOUNTED FOR: it either shows a block or is
        // named with its hit count. A file silently dropped is a round trip the
        // model spends re-grepping to discover it existed.
        for name in ["a_noise.rs", "m_mid.rs", "z_late.rs"] {
            assert!(
                out.contains(name),
                "{name} vanished from the budget report:\n{out}"
            );
        }
        assert!(
            out.contains("not shown") || !out.contains("truncated"),
            "a truncated budget must say what it hid:\n{out}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// Whatever the budget cuts must still be NAMED with its hit count.
    ///
    /// A file silently dropped from the display is a round trip the model spends
    /// re-grepping to learn it existed. Cap 1 with two declaring files makes the
    /// cut unavoidable, so the announcement is asserted without depending on
    /// rg's file order.
    #[test]
    fn a_file_the_budget_cannot_reach_is_named_with_its_mass() {
        let tmp = std::env::temp_dir().join(format!("codifa-grep-mass-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("one.rs"), "struct token_one;\n").unwrap();
        fs::write(tmp.join("two.rs"), "struct token_two;\n").unwrap();
        let out = grep_scope(&tmp, "", "struct token_", "", 1, 0, false).unwrap();
        // Exactly one of the two fits; the other must be announced, not hidden.
        let hidden = out.matches("not shown").count();
        assert_eq!(hidden, 1, "exactly one file must be reported unseen:\n{out}");
        let shown = out.matches("struct token_").count();
        assert_eq!(shown, 1, "the budget of 1 must show exactly one hit:\n{out}");
        for name in ["one.rs", "two.rs"] {
            assert!(out.contains(name), "{name} vanished from the report:\n{out}");
        }
        fs::remove_dir_all(&tmp).ok();
    }

    /// One declaration-heavy file must not starve every other file's.
    ///
    /// Traced (`mvyy1qf7`, 74 rounds): refinement chains re-grepped with a
    /// narrower pattern because the first file's declarations filled the budget
    /// and the file defining the symbol was cut. Pass 1 now gives every
    /// declaring file a share before ANY file takes a second line.
    #[test]
    fn one_declaration_heavy_file_cannot_starve_the_others() {
        let tmp = std::env::temp_dir().join(format!("codifa-grep-starve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // Many declarations, so a per-file allowance of several would fill a
        // small budget with this file alone.
        let mut heavy = String::new();
        for i in 0..8 {
            heavy.push_str(&format!("struct token_heavy_{i} {{ x: u8 }}\n"));
        }
        fs::write(tmp.join("a_heavy.rs"), heavy).unwrap();
        fs::write(tmp.join("z_only.rs"), "struct token_only { y: u8 }\n").unwrap();
        let out = grep_scope(&tmp, "", "token_", "", 3, 0, false).unwrap();
        // Whichever file rg walked first, the single-declaration file keeps a
        // slot: the fair share is decided BEFORE any file gets a second line.
        assert!(
            out.contains("struct token_only"),
            "the only declaration of a second file must survive a heavy neighbour:\n{out}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn grep_miss_searches_spelling_variants_in_the_same_call() {
        // Traced: a literal miss (`script.json`) cost a second round-trip
        // before the model tried `script_json`. The variant pass runs HERE, in
        // the same call, labeled so the model knows the literal is absent.
        let tmp = std::env::temp_dir().join("codifa-grep-variant-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("m.rs"), "const SCRIPT_JSON_NAME: &str = \"script_json\";\n").unwrap();
        // The traced miss shape: the model writes the literal dot ESCAPED
        // (`script\.json`), which no longer matches `script_json` as a regex.
        let out = grep_scope(&tmp, "", "script\\.json", "", 10, 0, false).unwrap();
        assert!(
            out.contains("SPELLING-VARIANT"),
            "a literal miss must run the variant pass:\n{out}"
        );
        assert!(out.contains("script_json"), "{out}");
        // A miss whose variants also miss stays a plain miss.
        let miss = grep_scope(&tmp, "", "zzz_nothing", "", 10, 0, false).unwrap();
        assert_eq!(miss, "no matches");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn name_variants_cover_the_naming_conventions() {
        // `script.json` → the four code conventions; separators normalize to _.
        let v = name_variant_pattern("script.json").unwrap();
        assert!(v.contains("script_json") && v.contains("ScriptJson") && v.contains("scriptJson"), "{v}");
        assert!(v.contains("SCRIPT_JSON"), "{v}");
        // ALL-CAPS and kebab inputs split to the same segments.
        let v2 = name_variant_pattern("SCRIPT_TIMEOUT").unwrap();
        assert!(v2.contains("script_timeout") && v2.contains("ScriptTimeout"), "{v2}");
        let v3 = name_variant_pattern("my-var_name").unwrap();
        assert!(v3.contains("myVarName"), "{v3}");
        // A single lowercase word still gains its case variants (constants!).
        let v4 = name_variant_pattern("timeout").unwrap();
        assert!(v4.contains("TIMEOUT"), "{v4}");
        // Regex-ish or multi-alternative input never goes through variants.
        assert!(name_variant_pattern("a|b").is_none());
        assert!(name_variant_pattern("fn\\s+[a-z]+").is_none());
        assert!(name_variant_pattern("").is_none());
    }

    #[test]
    fn grep_refuses_unscoped_broad_patterns() {
        let tmp = std::env::temp_dir().join("codifa-grep-broad");
        fs::create_dir_all(&tmp).unwrap();
        let args = json!({ "pattern": "a|b|c|d" });
        let err = dispatch(tmp.to_str().unwrap(), "grep", &args, None).unwrap_err();
        // The refusal has to carry the way OUT, or the model spends a round
        // inventing another over-broad spelling (measured: 65-138K per round).
        assert!(err.contains("broad pattern refused"), "{err}");
        assert!(err.contains("add a scope"), "{err}");
        assert!(err.contains("SEPARATE grep calls in ONE step"), "{err}");
        assert!(err.contains("Do NOT retry"), "{err}");
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

    /// Naming a DIRECTORY to `lsp_symbols` answers with its entries instead of
    /// refusing. The model often has the folder but no file in it, and the old
    /// refusal ("outlines ONE file — src is a directory") spent a whole round
    /// teaching it nothing the listing does not say.
    #[test]
    fn lsp_symbols_on_a_directory_lists_its_entries() {
        let tmp = std::env::temp_dir().join(format!("codifa-lsp-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("one.rs"), "fn a() {}\n").unwrap();
        fs::write(tmp.join("two.rs"), "fn b() {}\n").unwrap();
        fs::write(tmp.join("sub/three.rs"), "fn c() {}\n").unwrap();
        let root = tmp.to_str().unwrap();

        let out = dispatch(root, "lsp_symbols", &json!({ "filePath": "" }), None)
            .err()
            .unwrap_or_default();
        // An empty filePath is still an error — this guards the arm below from
        // swallowing it.
        assert!(!out.contains("DIRECTORY"), "empty path is not a listing: {out}");

        let out = dispatch(root, "lsp_symbols", &json!({ "filePath": "." }), None).unwrap();
        assert!(out.contains("DIRECTORY"), "says what it is: {out}");
        assert!(out.contains("one.rs") && out.contains("two.rs"), "lists files: {out}");
        assert!(out.contains("sub/"), "marks subdirectories: {out}");
        // The next round must be exact: one of the files it just listed.
        assert!(out.contains("lsp_symbols on it"), "names the follow-up: {out}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A `write_file` that arrives WITHOUT `content` must not report success.
    ///
    /// `fs::write(.., "")` truncated the target to zero bytes and the answer was
    /// still "Successfully wrote … (0 bytes)", which reads as done. One traced
    /// chat sent the SAME bodiless call 16 times (each args object was `{path}`
    /// only) because nothing in the result said the body had never arrived.
    #[test]
    fn write_file_without_content_is_refused_not_a_silent_truncation() {
        let tmp = std::env::temp_dir().join(format!("codifa-wf-nocontent-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();
        let file = tmp.join("keep.txt");
        fs::write(&file, "original body\n").unwrap();

        let err = dispatch(root, "write_file", &json!({ "path": "keep.txt" }), None).unwrap_err();
        assert!(err.contains("content"), "names the missing argument: {err}");
        assert!(err.contains("keep.txt"), "names the file it refused: {err}");
        // The refusal must leave the file ALONE — a truncated file is the bug.
        assert_eq!(fs::read_to_string(&file).unwrap(), "original body\n");

        // An explicit empty body stays legal: it empties the file on purpose.
        let ok = dispatch(root, "write_file", &json!({ "path": "keep.txt", "content": "" }), None)
            .unwrap();
        assert!(ok.contains("(0 bytes)"), "{ok}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A write the user approved OUTSIDE the workspace can still be snapshotted,
    /// which is what makes its diff (and therefore the card + Review entry)
    /// possible.
    ///
    /// `read_pre_edit` used to resolve with no permit at all. Workspace, temp and
    /// `~/.codifa` never needed one, so this only ever bit a path in the user's
    /// HOME (traced: `edit_file ~/local-models-server/stt-server.py`, approved in
    /// the popup, then reported as a bare "Edited" with no +N/-M anywhere).
    #[cfg(unix)]
    #[test]
    fn a_permitted_out_of_tree_edit_can_still_be_snapshotted_for_its_diff() {
        // `/etc/hosts` is guaranteed to exist and to sit outside EVERY free root
        // (workspace, temp, ~/.codifa), so the permit is the only way in.
        let tmp = std::env::temp_dir().join("codifa-read-pre-edit-permit");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();

        // No permit: outside every free root, so there is nothing to snapshot.
        assert!(read_pre_edit(root, "/etc/hosts", None).is_none());

        // The user approved it: the snapshot now exists, which is what lets the
        // diff be computed at all.
        let permit = json!({ "outside": true, "folders": [] });
        let before = read_pre_edit(root, "/etc/hosts", Some(&permit));
        assert!(before.is_some(), "an approved path must be readable for diffing");
        let diff = unified_diff("/etc/hosts", &before.unwrap(), "only one line\n");
        assert!(!diff.is_empty(), "an approved edit must produce a diff");
        fs::remove_dir_all(&tmp).ok();
    }

    /// An `edit_file` that names NO file refuses in terms of the missing
    /// argument instead of trying to read the workspace root.
    #[test]
    fn edit_file_with_no_file_named_says_so() {
        let tmp = std::env::temp_dir().join("codifa-edit-no-path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap();

        let err = dispatch(
            root,
            "edit_file",
            &json!({ "edits": [{ "old_string": "a", "new_string": "b" }] }),
            None,
        )
        .unwrap_err();
        assert!(err.contains("no file named"), "says what is missing: {err}");
        // The old failure leaked the OS error and the ROOT path instead.
        assert!(!err.contains("Is a directory"), "no errno soup: {err}");
        assert!(err.contains("`path`"), "names the argument: {err}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A batch that names its file ONLY per entry must reach that file.
    ///
    /// The schema advertises `edits: [{path, old_string, new_string}]` with no
    /// top-level `path`, so a batch of same-file entries resolved the EMPTY
    /// path to the workspace ROOT and died with
    /// `cannot read <root> for editing: Is a directory (os error 21)` — a
    /// message naming no file, so recovering from it meant re-reading the whole
    /// request rather than fixing one argument. Reproduced on the live corpus
    /// (`agent/mod.rs`), where the model had obeyed the documented shape.
    #[test]
    fn a_batch_that_names_its_file_only_per_entry_reaches_that_file() {
        let tmp = std::env::temp_dir().join("codifa-edit-per-entry-path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "alpha\nbeta\n").unwrap();
        let root = tmp.to_str().unwrap();

        // No top-level `path` at all: exactly the advertised batch shape.
        let args = json!({
            "edits": [
                { "path": "f.txt", "old_string": "alpha", "new_string": "ALPHA" },
                { "path": "f.txt", "old_string": "beta", "new_string": "BETA" }
            ]
        });
        let msg = dispatch(root, "edit_file", &args, None).unwrap();
        assert!(msg.contains("Successfully edited f.txt"), "{msg}");
        let after = fs::read_to_string(&file).unwrap();
        assert_eq!(after, "ALPHA\nBETA\n");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn an_ambiguous_edit_names_each_site_instead_of_only_a_count() {
        // MEASURED (traces `mvy0ausq` / `mvxsy14e`): 5 ambiguous edits failed and
        // each cost 1-2 recovery rounds at 65-138K re-sent tokens, because the
        // error named only a COUNT and the model re-grepped or re-read the file
        // to find text that would make its string unique. The sites are already
        // open here, so they are shown with real line numbers.
        let tmp = std::env::temp_dir().join(format!("codifa-ambig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("f.txt");
        fs::write(&file, "alpha\none\nbeta\none\ngamma\n").unwrap();
        let root = tmp.to_str().unwrap();

        let err = edit_file(root, "f.txt", "one", "ONE", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        // Both occurrences are located, with their neighbours, so the fix needs
        // no extra call.
        assert!(err.contains("site at line 2"), "{err}");
        assert!(err.contains("site at line 4"), "{err}");
        assert!(err.contains("alpha"), "{err}");
        assert!(err.contains("gamma"), "{err}");
        assert!(!err.contains("\n\n\n"), "{err}");
        // Still a failure: nothing was written.
        assert_eq!(fs::read_to_string(&file).unwrap(), "alpha\none\nbeta\none\ngamma\n");

        // The batch path carries the same sites in its suffix.
        let args = json!({
            "path": "f.txt",
            "edits": [{ "old_string": "one", "new_string": "ONE" }]
        });
        let err = dispatch(root, "edit_file", &args, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        assert!(err.contains("site at line 2"), "{err}");

        // Two occurrences on the SAME line are one place in the file, so the
        // hint names it once: a duplicated window reads as two distinct sites.
        fs::write(&file, "alpha\nfoo foo\nbeta\n").unwrap();
        let err = edit_file(root, "f.txt", "foo", "FOO", false, None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{err}");
        assert_eq!(err.matches("site at line 2").count(), 1, "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn edit_batch_honours_a_path_per_entry() {
        // The schema advertises `edits: [{path, old_string, new_string}]`, but the
        // per-entry `path` used to be IGNORED: every entry was applied to the
        // top-level path, so a cross-file batch failed with "old_string not found"
        // on the WRONG file and the model re-read and retried once per file —
        // traced, 13 edits over 2 files took 11 rounds.
        let tmp = std::env::temp_dir().join(format!("codifa-editmulti-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let a = tmp.join("a.txt");
        let b = tmp.join("b.txt");
        fs::write(&a, "alpha\nbeta\n").unwrap();
        fs::write(&b, "gamma\ndelta\n").unwrap();
        let root = tmp.to_str().unwrap().to_string();

        // ONE call, two files, each entry naming its own path.
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "edits": [
                    {"path": "a.txt", "old_string": "alpha", "new_string": "ALPHA"},
                    {"path": "b.txt", "old_string": "delta", "new_string": "DELTA"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(fs::read_to_string(&a).unwrap().contains("ALPHA"), "{out}");
        assert!(fs::read_to_string(&b).unwrap().contains("DELTA"), "{out}");
        assert!(out.contains("a.txt") && out.contains("b.txt"), "{out}");

        // One file landing and one missing reports BOTH halves, naming the file
        // that still needs work (so the next call is one targeted edit, not a
        // blind re-read).
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "edits": [
                    {"path": "a.txt", "old_string": "ALPHA", "new_string": "alpha"},
                    {"path": "b.txt", "old_string": "absent", "new_string": "x"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("FAILED") && out.contains("b.txt"), "{out}");
        assert!(fs::read_to_string(&a).unwrap().contains("alpha"));
        assert!(fs::read_to_string(&b).unwrap().contains("DELTA"), "b must be untouched");

        // An entry without a `path` still inherits the top-level one, so the
        // single-file batch form keeps working unchanged.
        let out = dispatch(
            &root,
            "edit_file",
            &json!({
                "path": "b.txt",
                "edits": [
                    {"old_string": "DELTA", "new_string": "delta"},
                    {"old_string": "gamma", "new_string": "GAMMA"}
                ]
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("2") || out.contains("Successfully"), "{out}");
        let btext = fs::read_to_string(&b).unwrap();
        assert!(btext.contains("delta") && btext.contains("GAMMA"), "{btext}");
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

    #[test]
    fn terminal_streams_live_tail_while_running() {
        let tmp = std::env::temp_dir().join("codifa-term-tail-test");
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_str().unwrap().to_string();
        // A command that prints a progress-style line every ~200 ms for ~1.5 s:
        // the sink must fire SEVERAL times while the child is still alive,
        // each time with the newest line in the tail.
        let sink: TailSink = Arc::new(|tail: &str| {
            TAILS.with(|t| t.borrow_mut().push(tail.to_string()));
        });
        let out = run_terminal_bounded_with(
            &root,
            "for i in 1 2 3 4 5 6 7; do echo \"tick $i\"; sleep 0.2; done",
            15,
            MAX_TERMINAL_TIMEOUT_SECS,
            Some(&sink),
        )
        .unwrap();
        let tails = TAILS.with(|t| std::mem::take(&mut *t.borrow_mut()));
        assert!(out.contains("tick 7"), "{out}");
        // At least two mid-run emissions (the command runs ~1.4 s; the gate is
        // 500 ms), and the last one already saw a later tick than the first.
        assert!(tails.len() >= 2, "expected >=2 live tails, got {}", tails.len());
        assert!(!tails[0].contains("tick 7"), "first tail must be mid-run");
        assert!(tails.last().unwrap().contains("tick"), "{}", tails.last().unwrap());
        fs::remove_dir_all(&tmp).ok();
    }

    thread_local! {
        static TAILS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    }
}

