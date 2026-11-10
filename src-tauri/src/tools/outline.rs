use super::*;

pub(super) const FIND_SYMBOL_MAX_DEFS: usize = 3;
pub(super) const FIND_SYMBOL_BODY_LINES: usize = 40;
pub(super) const FIND_SYMBOL_MAX_USAGES: usize = 25;

/// Keywords that START a declaration an outline reports, across the languages
/// this app edits (Rust, TypeScript/JS, Python, Go, Java/C#, shell, Ruby).
pub(super) const OUTLINE_KEYWORDS: [&str; 15] = [
    "fn", "def", "class", "struct", "enum", "trait", "interface", "impl", "type", "function",
    "func", "mod", "macro_rules", "sub", "procedure",
];

/// Words that may precede a declaration keyword without being it.
pub(super) const OUTLINE_MODIFIERS: [&str; 11] = [
    "export", "default", "async", "unsafe", "extern", "static", "abstract", "readonly",
    "override", "declare", "final",
];

/// `(path, line, text)` rows from ONE rg run: no context, at most 6 matching
/// lines per file, workspace noise dirs excluded, paths relative to `search_dir`.
pub(super) fn rg_rows(
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

pub(super) fn indent_width(line: &str) -> usize {
    line.chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

/// Last 0-based line of the definition that starts at `start`, found by
/// indentation (language-agnostic): everything deeper than the definition line
/// belongs to it, plus a closing `}` / `end` at the same indent. Signature
/// continuations at the base indent (`) -> T {`, `where`, `{`) are skipped.
pub(super) fn definition_end(lines: &[&str], start: usize) -> usize {
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
pub(super) fn declaration_word(line: &str) -> Option<(&str, bool)> {
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
pub(super) fn is_outline_line(line: &str) -> bool {
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
pub(super) const LANDMARK_MAP_ROWS: usize = 64;

/// A column-0 COMMENT: the strongest navigation landmark a stylesheet or markup
/// file has, because it names a whole section rather than one rule inside it.
pub(super) fn is_section_banner(line: &str) -> bool {
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
pub(super) fn is_landmark_line(line: &str) -> bool {
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
pub(super) fn landmark_rows(lines: &[&str], budget: usize, query: &str) -> (Vec<(usize, String)>, usize) {
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
pub(super) fn outline_note(abs: &Path, path_label: &str) -> String {
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
pub(super) static OUTLINE_CLAIMED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

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
pub(super) fn outline_note_once(abs: &Path, path_label: &str) -> String {
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
pub(super) static OUTLINE_CLAIM_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Hold this for the whole body of any test that claims or resets an outline.
#[cfg(test)]
pub(super) fn outline_claim_lock() -> std::sync::MutexGuard<'static, ()> {
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

