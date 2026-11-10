use super::*;

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
pub(super) fn collect_files(scope: &Path, out: &mut Vec<PathBuf>) {
    // Canonicalized ancestors, so a symlinked cycle (`ln -s .. up`) can never
    // recurse forever — `path.is_dir()` follows symlinks, and the MAX_FILES
    // bound never triggers on a cycle that adds no files.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    collect_files_inner(scope, out, &mut seen, 0);
}

pub(super) fn collect_files_inner(
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
pub(super) fn rg_binary() -> String {
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
        // re-grepped with a two-name alternation, then again with all three
        // spellings. Run the convention variants
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
pub(super) const RG_PER_FILE_MATCH_CAP: usize = 400;
/// Hard bound on collected match/context rows across ALL files, so a huge
/// multi-file hit set stays a bounded parse (rows beyond it are simply not
/// candidates for display; the counts already collected still report).
pub(super) const RG_COLLECT_ROW_CAP: usize = 20_000;

/// One file's parsed rg stream: every match/context row rg emitted for it, in
/// order, plus the indices of the match rows.
pub(super) struct GrepFile {
    name: String,
    lines: Vec<(bool, u64, String)>,
    matches: Vec<usize>,
}

/// True when a line LOOKS like a code declaration — the thing a code search
/// is usually hunting. Definition lines are shown first inside the budget:
/// traced refinement chains (grep → weaker-than-hoped hits → re-grep with a
/// narrower pattern) almost always started from a cap that spent its lines on
/// call sites while the declaration the model needed sat past the cut.
pub(super) fn looks_like_definition(line: &str) -> bool {
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
pub(super) fn format_rg_output(
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
pub(super) fn identifier_segments(token: &str) -> Option<Vec<String>> {
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
pub(super) fn name_variant_pattern(pattern: &str) -> Option<String> {
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
pub(super) fn glob_to_regex(glob: &str) -> regex::Regex {
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
pub(super) fn glob_matches(re: &regex::Regex, rel_scope: &str, rel_root: &str, name: &str) -> bool {
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

