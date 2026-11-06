use super::*;

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
pub(super) fn grep_followup_hint(pattern: &str, result: &str) -> String {
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
pub(super) fn post_edit_diagnostics(root: &str, path: &str, permit: Option<&Value>) -> String {
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
pub(super) fn identifier_symbol_block(root: &str, pattern: &str, result: &str) -> String {
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
pub(super) fn grep_outline_block(root: &str, result: &str, permit: Option<&Value>) -> String {
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
pub(super) fn include_globs(include: &str) -> Vec<String> {
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

pub(super) fn clip_hint(hint: &str) -> String {
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
