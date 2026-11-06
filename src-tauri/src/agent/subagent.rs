use super::*;

/// Fold one sub-agent event into its report / error buffers. Text streamed
/// BEFORE a search tool call is narration ("let me search…"), not the report:
/// it is dropped when the tool starts, so only the answer written after the
/// LAST search tool reaches the main agent (it used to receive every step's
/// chatter, resent on each later step). Memory tools are exempt so a report
/// written in the same step as save_memory survives.
/// Decide whether ONE sub-agent attempt produced a usable report.
///
/// `Ok(())` means "keep this report"; `Err(reason)` means "this attempt failed,
/// so the ladder must retry it" (the reason is what the banner shows).
///
/// The subtle case is an attempt that streamed some text and THEN died on a
/// provider error. Judging that by `report.is_empty()` alone reported it as a
/// SUCCESS: the parent received a truncated report as its tool result and the
/// retry ladder never fired — which is exactly "auto retry does not work on a
/// sub-agent error" (the user's report). A captured `AgentEvent::Error` is
/// always terminal for the attempt that produced it (see `run_turn`'s only
/// Error emit), so a non-empty `sub_error` always means the attempt failed,
/// with or without partial text.
pub(super) fn classify_subagent_attempt(res: &Result<(), String>, report: &str, sub_error: &str) -> Result<(), String> {
    // The idle guard already converted a hang into a real error.
    if let Err(e) = res {
        return Err(format!("sub-agent failed: {e}"));
    }
    let err = sub_error.trim();
    if !err.is_empty() {
        return Err(format!("explore failed: {err}"));
    }
    if report.trim().is_empty() {
        // The turn "succeeded" but produced no output — the parent must not
        // treat an empty report as data.
        return Err(
            "explore returned no findings: the sub-agent produced no output (empty model response)"
                .to_string(),
        );
    }
    Ok(())
}

pub(super) fn fold_subagent_event(report: &mut String, sub_error: &mut String, ev: &AgentEvent) {
    match ev {
        AgentEvent::Text { content } => report.push_str(content),
        // Capture the sub-agent's error so an empty report can say WHY it is
        // empty (provider 400/401, tool failure, …).
        AgentEvent::Error { content } => sub_error.push_str(content),
        AgentEvent::ToolStart { name, .. }
            if !matches!(
                name.as_str(),
                "save_memory" | "search_memory" | "delete_memory"
            ) =>
        {
            report.clear()
        }
        _ => {}
    }
}

/// Native tools that only READ state: no file write, no memory write, no shell.
///
/// Used twice, and the second use is a CORRECTNESS guard, not an optimisation:
/// the repeat-guard may only answer a lookup with a pointer while the workspace
/// is unchanged. Anything not in this list can change it — including
/// `run_terminal`, which runs arbitrary `sh -c` in the workspace root — so every
/// cached lookup body must be forgotten after one of them runs (see the `rest`
/// loop). A stale pointer would hand the model a file as it was before its own
/// edit: a silent quality loss that no token saving justifies.
pub(super) const READONLY_NATIVE_TOOLS: [&str; 13] = [
    "read",
    "grep",
    "glob",
    "find_symbol",
    "current_time",
    "system_stats",
    "search_memory",
    "load_skill",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_symbols",
    "lsp_diagnostics",
];

pub(super) fn is_readonly_native(name: &str) -> bool {
    READONLY_NATIVE_TOOLS.contains(&name)
}

/// Tool-name prefix under which a plugin sub-agent PROFILE is advertised.
///
/// The prefix keeps a bundle's `reviewer` from shadowing a native `read`, and it
/// is what `is_delegation` keys on — every delegation (builtin `explore` and
/// every installed profile) takes the same code path, so a second mechanism can
/// never drift from the first.
pub(crate) const DELEGATION_PREFIX: &str = "agent__";

/// The tool name a profile is advertised under (its frontmatter name, folded to
/// the charset providers accept).
pub(super) fn delegation_tool_name(profile: &str) -> String {
    let mut out = String::with_capacity(profile.len() + DELEGATION_PREFIX.len());
    out.push_str(DELEGATION_PREFIX);
    for c in profile.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c.to_ascii_lowercase());
        } else if c.is_whitespace() {
            out.push('_');
        }
    }
    out
}

/// True for any tool that runs a sub-agent: the builtin `explore`, or a plugin
/// profile advertised under [`DELEGATION_PREFIX`].
pub(super) fn is_delegation(name: &str) -> bool {
    name == "explore" || name.starts_with(DELEGATION_PREFIX)
}

/// True when this call can WRITE to the workspace — the only thing that makes a
/// cached read body stale.
///
/// MEASURED on the live corpus: the old blanket rule (`!is_readonly(name)`) wiped
/// the whole lookup cache 247 times, and 60 of those wipes came from calls that
/// cannot put a byte in a workspace file — `explore`(27), `web_search`(11),
/// `system_stats`(7), `fetch_url`(5), `save_memory`(4), `ask_user`(3),
/// `load_skill`(2), `confirm_action`(1) — plus every read-only `run_terminal`
/// (`ls`, `git status`, builds) on top. Each wipe threw away the read coverage
/// recorded one call earlier, which is why the coverage guard fired 6 times in a
/// corpus that re-asked 137 already-served windows.
pub(super) fn mutates_workspace(name: &str, _args: &Value) -> bool {
    match name {
        "write_file" | "edit_file" | "artifact" => true,
        // A batch carries the step's writers too: one write/edit/terminal op
        // inside it invalidates the file-body cache exactly like the same
        // call on its own would (conservative — a terminal op is a writer).
        "batch" => _args["ops"].as_array().is_some_and(|ops| {
            ops.iter().any(|op| {
                matches!(
                    op["tool"].as_str().unwrap_or_default(),
                    "write_file" | "edit_file" | "run_terminal"
                )
            })
        }),
        // A terminal command runs arbitrary `sh -c`: the workspace-file guard
        // refuses the workspace READ/dump forms, but a build, a test or a script
        // can still rewrite a file (`cargo` into `target/`, a generator into
        // `src/`, `python3 build.py`). Keeping the cache here measured the SAME
        // 84 pointers as the conservative rule while an "inspection verb" variant
        // measured 130 — the 46 extra pointers are not worth a stale body, so the
        // whole terminal stays a writer.
        "run_terminal" => true,
        // A connector may mutate anything on the far side of the wire.
        n if n.starts_with(crate::mcp::TOOL_PREFIX) => true,
        // The observation set cannot write the workspace: `explore` runs the
        // research tool set (no writer, no terminal), the web tools only fetch,
        // the memory tools write the MEMORY store, and ask/plan/skill-load merely
        // report. These were 60 of the 247 measured wipes.
        "explore" | "web_search" | "fetch_url" | "search_memory" | "save_memory"
        | "delete_memory" | "load_skill" | "ask_user" | "confirm_action"
        | "request_permission" | "current_time" | "system_stats" => false,
        // Everything else (create_skill, create_mcp, plugin, schedule, the
        // browser_* driver) counts as a writer: an unknown reach is not worth
        // handing the model a pointer to a file it can no longer trust.
        _ => !is_readonly_native(name),
    }
}

/// True when a `read` result had to cut a window short, so part of what it
/// asked for never reached the model. Such a read grants NO coverage: the
/// marker names the exact resume offset, and answering that follow-up with
/// "already returned above" would make the cut-off remainder unreachable.
pub(super) fn result_was_window_cut(result: &str) -> bool {
    result.contains("window truncated at line")
        || result.contains("window too large for the result budget")
}

/// Prefix of the coverage entries the repeat-guard keeps next to the exact
/// lookup keys: one per window a `read` actually served this turn.
///
/// The exact-key guard only recognises a LITERALLY identical call. Traced on the
/// real corpus it left 190_602 chars of bookkeeping on the table: 7 reads were
/// byte-identical repeats it should have caught, but 17 more asked for a window
/// already CONTAINED in a wider span served earlier (the model widens a window
/// it was told about, then narrows back onto the lines it actually needs). Those
/// windows are in the context already, so the payload is re-sent for nothing.
pub(super) const READ_COVERAGE_PREFIX: &str = "readcov|";

/// `(file, start, end)` of a coverage entry. The file goes LAST in the key so a
/// path containing `|` cannot be mis-split.
pub(super) fn coverage_span(key: &str) -> Option<(&str, usize, usize)> {
    let rest = key.strip_prefix(READ_COVERAGE_PREFIX)?;
    let mut parts = rest.rsplitn(3, '|');
    let end = parts.next()?.parse().ok()?;
    let start = parts.next()?.parse().ok()?;
    Some((parts.next()?, start, end))
}

/// The half-open line span a `read` window asks for.
///
/// No normalisation happens here on purpose: `dispatch` reads an ABSENT limit as
/// the default and an explicit `0` as zero lines, so a guard that turned 0 into
/// 400 would claim coverage of lines that were never delivered — exactly the
/// silent loss this guard exists to prevent.
pub(super) fn read_window_span(offset: usize, limit: usize) -> (usize, usize) {
    (offset, offset.saturating_add(limit))
}

/// The workspace file a WRITER targets, in the same spelling the reader side
/// records (`filePath`/`path`) — the two must agree character-for-character or
/// the same-file check below never fires.
/// The file a WRITER call targets, as the model spelled it.
///
/// A batch may name its file ONLY per entry (`edits: [{path, …}]`, the shape the
/// schema advertises) and leave the top level `path` absent. Reading just
/// `path`/`filePath` then answered `None`, so the pre-edit snapshot and the
/// post-edit diff were both taken from an EMPTY path — which resolves to the
/// workspace ROOT, fails to read as text, and yields `""` on both sides. The
/// unified diff came out empty, no `diff` event reached the UI, and the edit
/// card showed a bare "Edited" with no diff while the model got no
/// `applied change` block at all (traced: every `edits[]`-shaped edit).
pub(super) fn writer_target_path(name: &str, args: &Value) -> Option<String> {
    if !matches!(name, "edit_file" | "write_file") {
        return None;
    }
    let named = args["path"]
        .as_str()
        .or_else(|| args["filePath"].as_str())
        .map(str::to_string)
        .filter(|p| !p.trim().is_empty());
    if named.is_some() {
        return named;
    }
    // The schema's batch shape: one path per entry. The FIRST entry is the file
    // the diff is computed against; a multi-file batch is applied per file by
    // `edit_file` itself, and this snapshot covers the entry it reports first.
    args["edits"]
        .as_array()
        .and_then(|edits| edits.iter().find_map(|e| e["path"].as_str()))
        .map(str::to_string)
        .filter(|p| !p.trim().is_empty())
}

/// True when EVERY window of a `read` call is already inside a span served
/// earlier this turn — so its payload is in the context above and a pointer is
/// the whole answer. An empty window list is never "covered": a call naming no
/// file is an error the model must see.
pub(super) fn read_windows_covered(
    seen: &std::collections::HashSet<String>,
    windows: &[(String, usize, usize)],
) -> bool {
    if windows.is_empty() {
        return false;
    }
    let served: Vec<(&str, usize, usize)> = seen.iter().filter_map(|k| coverage_span(k)).collect();
    windows.iter().all(|(file, offset, limit)| {
        let (start, end) = read_window_span(*offset, *limit);
        served
            .iter()
            .any(|(f, s, e)| same_file(f, file) && *s <= start && end <= *e)
    })
}

/// True when two spellings of a path name the same file.
///
/// The model mixes spellings inside one turn (an absolute path from a tool
/// result, a workspace-relative one from its own head), and a character-for-
/// character comparison treated those as different files: traced, the same
/// `browser.rs` was read twice for two spellings, and the coverage the first
/// read had already granted was invisible to the second.
pub(super) fn same_file(a: &str, b: &str) -> bool {
    let a = a.trim_start_matches("./").trim_end_matches('/');
    let b = b.trim_start_matches("./").trim_end_matches('/');
    if a == b {
        return true;
    }
    // Same file under a longer prefix (workspace-relative vs absolute).
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    long.len() > short.len()
        && long.ends_with(short)
        && long[..long.len() - short.len()].ends_with('/')
}

/// Remember the spans a successful `read` served, so a later call for lines
/// inside them answers with a pointer instead of the same bytes again.
pub(super) fn record_read_coverage(
    seen: &mut std::collections::HashSet<String>,
    windows: &[(String, usize, usize)],
) {
    for (file, offset, limit) in windows {
        let (start, end) = read_window_span(*offset, *limit);
        seen.insert(format!("{READ_COVERAGE_PREFIX}{file}|{start}|{end}"));
    }
}

/// Record the span a `read` block ACTUALLY delivered when it was stretched to
/// the end of the file (see `tools::file_window_upto`).
///
/// Without this the extension would be invisible to the repeat-guard: the model
/// would be holding the tail and still get served it again, which is the very
/// round trip the extension exists to remove.
pub(super) fn record_extended_coverage(seen: &mut std::collections::HashSet<String>, result: &str) {
    for (file, last) in crate::tools::read_extended_spans(result) {
        seen.insert(format!("{READ_COVERAGE_PREFIX}{file}|1|{}", last + 1));
    }
}

/// Identity of a repeatable read-only lookup: a read window (file + offset +
/// limit) or a grep (pattern + scope). Two calls with the same key return the
/// same payload, so the second one is answered with a pointer instead of the
/// body — the content is already in the context above.
pub(super) fn lookup_key(name: &str, args: &Value) -> Option<String> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    match name {
        "read" => {
            // `path` rides as the alias the dispatch accepts (tools.rs read
            // arm) — a guard blind to the alias let the SAME file re-read at
            // full size three times inside one run (traced: 47,865 chars for
            // one fixture file) because its key resolved to None and the
            // repeat-guard never saw the call. Same alias resolution as the
            // dispatch, so the guard sees exactly the calls that run.
            let file = if args["filePath"].as_str().is_some_and(|v| !v.trim().is_empty()) {
                s("filePath")
            } else {
                s("path")
            };
            // `ranges` selects windows AND (since the bare path list was
            // dropped) the files themselves: a multi-file read has an EMPTY
            // filePath, so keying on the file alone would have returned None
            // and silently disabled the repeat-guard for exactly the calls that
            // carry the most bytes. The range body is the identity instead.
            let ranges = args["ranges"].to_string(); // "null" when absent
            if file.is_empty() {
                // A multi-entry read has no top-level filePath, yet it is the
                // call that moves the most bytes: `ranges` (and the legacy
                // `paths` list) IS its identity, so the repeat-guard still sees
                // it and two different lists never share a key.
                if args["ranges"].is_array() {
                    return Some(format!("read|ranges|{ranges}"));
                }
                if let Some(paths) = args["paths"].as_array() {
                    return Some(format!("read|paths|{paths:?}"));
                }
                return None;
            }
            let offset = args["offset"].as_u64().unwrap_or(1);
            let limit = args["limit"].as_u64().unwrap_or(400);
            // `ranges` selects other windows of the same file: without it in the
            // key, a second read of a DIFFERENT range was answered as a repeat.
            Some(format!("read|{file}|{offset}|{limit}|{ranges}"))
        }
        "grep" => {
            // The model sends either `pattern` or a `patterns` array.
            let mut pattern = s("pattern");
            if pattern.is_empty() {
                if let Some(list) = args["patterns"].as_array() {
                    pattern = list
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\u{1f}");
                }
            }
            if pattern.is_empty() {
                return None;
            }
            Some(format!("grep|{pattern}|{}|{}", s("path"), s("include")))
        }
        "find_symbol" => {
            let symbol = s("symbol");
            if symbol.is_empty() {
                return None;
            }
            Some(format!("find_symbol|{symbol}|{}|{}", s("path"), s("include")))
        }
        // The LSP family is a pure read of the file as it is on disk RIGHT NOW,
        // so identical arguments return an identical payload. These arms were
        // missing and the repeat guard never saw them: one traced explore run
        // called `lsp_symbols` on the SAME file three times at 12_880 model
        // chars each — a full variable-cost payload plus the round-trip that
        // carried it. "As it is right now" is only true while nothing has
        // changed the file: `run_terminal` can, which is why every mutating call
        // clears the guard (see READONLY_NATIVE_TOOLS).
        "batch" => {
            // The whole batch is its identity: an identical re-batch is
            // answered with a pointer (its results are already in context,
            // and re-running the same edits would fail their old_strings
            // anyway).
            Some(format!("batch|{}", args["ops"].to_string()))
        }
        "lsp_symbols" => {
            let file = s("filePath");
            if file.is_empty() {
                return None;
            }
            // `query` filters the symbol list: a different query is a different
            // answer.
            Some(format!("lsp_symbols|{file}|{}", s("query")))
        }
        "lsp_diagnostics" => {
            let file = s("filePath");
            if file.is_empty() {
                return None;
            }
            Some(format!("lsp_diagnostics|{file}"))
        }
        "lsp_definition" | "lsp_references" | "lsp_hover" => {
            let file = s("filePath");
            if file.is_empty() {
                return None;
            }
            let symbol = s("symbol");
            // A repeated identifier is disambiguated by the line hint, and a
            // bare position without a symbol is only valid with an explicit
            // line — both therefore belong in the key.
            let line = args["line"].as_i64().unwrap_or(0);
            let character = args["character"].as_i64().unwrap_or(0);
            if symbol.trim().is_empty() && line == 0 {
                return None;
            }
            // The tool NAME is part of the key: the definition of X and the
            // references of X are different answers.
            Some(format!(
                "{name}|{file}|{}|{line}|{character}",
                symbol.trim()
            ))
        }
        // `glob` output is a pure function of pattern + scope + max_results.
        // Like `grep`, the pattern may arrive as a `patterns` array.
        "glob" => {
            let mut pattern = s("pattern");
            if pattern.is_empty() {
                if let Some(list) = args["patterns"].as_array() {
                    pattern = list
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\u{1f}");
                }
            }
            if pattern.is_empty() {
                return None;
            }
            Some(format!(
                "glob|{pattern}|{}|{}",
                s("path"),
                args["max_results"].as_u64().unwrap_or(100)
            ))
        }
        // The SAME research question must never run twice in one turn: a second
        // explore costs a whole sub-agent (up to SUBAGENT_MAX_STEPS rounds ×
        // SUBAGENT_MAX_ATTEMPTS attempts), while the first report is already in
        // the context above. Keyed on the normalized PROMPT (the description is
        // only a UI label, so it must not split one identical question into two
        // keys). Whitespace and case are normalized so a re-worded-but-identical
        // prompt is caught too.
        "explore" => {
            let prompt = s("prompt");
            let norm = prompt
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if norm.is_empty() {
                return None;
            }
            Some(format!("explore|{norm}"))
        }
        _ => None,
    }
}

/// Batching reminder appended to the result of a step that issued a single
/// tool call. Read-only calls of one step run in parallel, so every extra step
/// costs seconds (one model round trip) for no extra information.
///
/// Three audiences, because the waste differs:
/// - the explore sub-agent: one lookup per step burns rounds;
/// - the MAIN agent, `explore`: one broad explore is slow and comes back
///   shallow, while the same step could have carried several focused explores
///   concurrently (a traced turn fired a single wide explore and got 4 rounds);
/// - the MAIN agent, native write/terminal tools: traced turns spent 72% of
///   their steps (219 of 301) on a SINGLE call — 125 `run_terminal`, 51
///   `edit_file`, 23 `write_file` — alternating one edit and one command per
///   step. Every step re-sends the whole conversation (~7.3K tokens on average
///   over those turns), so those steps alone cost ~1.3M uncached tokens.
///
/// The native tools are deliberately NOT described as parallel: only read-only
/// calls are batched, and these mutate the workspace, so the wording promises
/// ORDER instead. The hint rides on an already-sent tool result, so it costs no
/// extra request — unlike widening the tool SCHEMA, which is paid on every
/// single round-trip of every turn.
/// Whether a tool only LOCATES or reads — no write, no command, no side effect.
///
/// Drives the discovery-streak counter (see `discovery_streak_hint`). `explore`
/// counts: a delegated search is still research, and a round that fires one is
/// already paying the delegation price.
pub(super) fn is_discovery_tool(name: &str) -> bool {
    matches!(
        name,
        "read"
            | "grep"
            | "glob"
            | "find_symbol"
            | "lsp_symbols"
            | "lsp_definition"
            | "lsp_references"
            | "lsp_hover"
            | "lsp_diagnostics"
            | "explore"
    )
}

/// Nudge to hand a LONG research streak to `explore`, delivered ONCE per streak.
///
/// Measured on the live corpus: the main agent ran 91 discovery streaks, 31 of
/// them ≥3 rounds, and the 169 rounds past the third burned 1_548_556 uncached
/// tokens, with one streak reaching 23 consecutive rounds. That shape — "where
/// is this wired up, how does this area work" — is precisely what `explore`
/// answers in one delegation on its OWN short context. A late main round, by
/// contrast, re-sends the whole conversation (re-measured on the newest build:
/// median 79K input tokens per main round against 16K per explore round, so past
/// round 20 one main step costs about five explore rounds). The
/// per-round single-call hint could not catch it: it fires on the FIRST lone
/// call of every round (423 of 863 rounds carried it, 315 single-call rounds
/// followed it, i.e. no effect) so it reads as wallpaper.
///
/// `STREAK_NUDGE_AT` is the first boundary. Firing at round 3 of a streak leaves
/// the model its two bounded targeted checks (the prompt promises "at most 2-3
/// search batches") before it is asked to delegate, and the wording never
/// forbids a lookup — it names the cheaper path for a question that has already
/// outgrown the targeted-check budget.
pub(super) const STREAK_NUDGE_AT: usize = 3;

/// The second boundary, added because the first one was measured as too quiet.
///
/// Measured over the live corpus: 302 rounds sat inside a discovery streak of 3
/// or more, and the 240 rounds PAST the third carried 2_361_303 uncached tokens
/// — of which 1_443_180 (61%) sat at round SEVEN and beyond, where a
/// single-shot nudge at round 3 had long stopped being repeated. The waste
/// curve peaks at round 4 (460_405) and stays above 100K per round through
/// round 12, so a streak that reaches 7 is not a finishing move any more; it is
/// the search being done the expensive way. One reminder there costs a few
/// dozen tokens on a result already being sent.
pub(super) const STREAK_NUDGE_LATE: usize = 7;

pub(super) fn discovery_streak_hint(mode: &str, streak: usize) -> Option<&'static str> {
    // Sub-agents have no `explore` of their own and their budget is tiny.
    if mode == "subagent" {
        return None;
    }
    match streak {
        STREAK_NUDGE_AT => Some(
            "[hint] This step is the 3rd round of locating/reading in a row, and every round re-sends the whole conversation. A question this broad — where something is wired up, how an area works — is exactly what ONE `explore` answers in a single round-trip: give it the question (plus the file paths you already found) and work from its report. Only keep looking here when the very next call answers what you need.",
        ),
        STREAK_NUDGE_LATE => Some(
            "[hint] This step is the 7th round of locating/reading in a row: the search has outgrown targeted checks and each further round re-sends the whole conversation for one lookup. Hand the question to ONE `explore` now (question + the paths already found) and keep this transcript for the work that follows. If the answer is already in hand, stop looking and act on it.",
        ),
        _ => None,
    }
}

/// The ONE nudge a round may carry, or `None`.
///
/// The STREAK hint wins at its boundaries: it exists at two streak lengths only,
/// while the per-round hint was measured as wallpaper (423 of 863 rounds carried
/// it and single-call rounds kept following it). Traced, the per-round hint would
/// otherwise take the slot in 24 of the 72 rounds that sit exactly on a streak
/// boundary (17 at streak 3, 7 at streak 7). A round never carries both: two
/// post-hoc notes on the same result read as noise instead of one instruction.
pub(super) fn round_hint(
    mode: &str,
    calls: &[(String, String, String)],
    streak: usize,
    lone_rounds: usize,
    root: &str,
) -> Option<Cow<'static, str>> {
    discovery_streak_hint(mode, streak)
        .map(Cow::Borrowed)
        .or_else(|| single_call_hint(mode, calls, lone_rounds, root))
}

/// True when a lone `run_terminal` command is a pure READ, i.e. one the backend
/// already runs inside the CONCURRENT read-only batch (see the `is_shell_read_only`
/// split in the step runner).
///
/// Traced (`mvxsy14e`): 80 lone `run_terminal` rounds, 39 of them pure reads
/// (`git log`, `du`, `ls`, a `python3` script over trace JSON). The batching
/// levers skipped `run_terminal` wholesale on the "probe chain" argument, so
/// those 39 cost a full round-trip each and were never named. What makes a shell
/// round a chain is MUTATION, not the shell: a read-only command's arguments do
/// not come from the previous result, so it is exactly as batchable as a `grep`.
pub(super) fn shell_read_is_batchable(raw_args: &str, root: &str) -> bool {
    let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
    let cmd = args["command"].as_str().unwrap_or_default();
    !cmd.trim().is_empty() && is_shell_read_only(cmd, root)
}

pub(super) fn single_call_hint(
    mode: &str,
    calls: &[(String, String, String)],
    lone_rounds: usize,
    root: &str,
) -> Option<Cow<'static, str>> {
    if calls.len() != 1 {
        return None;
    }
    if mode == "subagent" {
        return Some(Cow::Borrowed(
            "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together (other greps, find_symbol, lsp_symbols, reads of the exact windows), then write the report.",
        ));
    }
    let name = calls[0].1.as_str();
    if name == "explore" {
        return Some(Cow::Borrowed(
            "[hint] That step had ONE explore. Explores of one step run CONCURRENTLY and cost a single round-trip, while one broad explore is slow and returns a shallow report: when the task spans several areas, fire 2-4 focused explores (one per area/file group) IN THE SAME STEP.",
        ));
    }
    // Read-only natives are the ONE group that really does run concurrently, so
    // they get the parallelism wording instead of the ordering one. In the last
    // traced corpus 6 lone `read`, 1 lone `fetch_url` (65_694 uncached tokens on
    // its own) and 1 lone `load_skill` round sat outside the whitelist, i.e. the
    // hint could not fire on any of them. `find_symbol` and `lsp_symbols` joined
    // the MAIN set for the same reason they belong here: both answer "where does
    // this live" WITHOUT a follow-up read, so a lone one is exactly a round that
    // could have carried the window reads it points at. `grep` and `glob` joined
    // on the Oct 30 corpus: 41 lone `grep` rounds sat outside the whitelist even
    // though grep runs in the concurrent batch phase (READONLY_NATIVE_TOOLS) —
    // 3rd-largest lone-call group behind read and run_terminal, all of it
    // batchable the moment the second lookup is foreseeable.
    if matches!(
        name,
        "read"
            | "grep"
            | "glob"
            | "fetch_url"
            | "load_skill"
            | "find_symbol"
            | "lsp_symbols"
            | "lsp_definition"
            | "lsp_references"
            | "lsp_hover"
            | "lsp_diagnostics"
    ) {
        if lone_rounds <= 1 {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call. Every step re-sends the whole conversation: these read-only calls run CONCURRENTLY, so fetch everything you already know you need IN THE SAME STEP — several `read` windows fit in ONE call via ranges:[{path,offset,limit}], and independent greps/finds go in the SAME step.",
            ));
        }
        return Some(Cow::Owned(format!(
            "[hint] {lone_rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation (tens of thousands of tokens per round on a long chat). Batch the lookups you already know you need into this next step: read-only calls run CONCURRENTLY, several `read` windows fit in ONE call as ranges:[{{path,offset,limit}}], and independent greps/finds go in the SAME step."
        )));
    }
    // Native write/terminal/browser tools. Traced main-agent turns spent 76% of
    // their steps on a SINGLE call (210 of 277, measured from tool rows) — 61 of
    // them a lone `run_terminal`, 54 a lone `browser_evaluate`, 43 a lone
    // `edit_file` — and every extra step re-sends the whole conversation. The
    // browser tools were the largest group MISSING from this list, so the hint
    // fired on only 2 of 280 main rounds and could not correct any of it. These
    // calls do NOT run concurrently (they mutate the workspace or act on one
    // shared page, in order), so the hint must say "in order", never "parallel".
    //
    // `run_terminal` and the browser act-then-observe tools are excluded: their
    // calls are a CHAIN, each one's arguments built from the previous result, so
    // there is nothing to batch and the hint is an instruction the model cannot
    // obey. Traced: 59 consecutive rounds of one chat were all lone
    // `run_terminal` (48 of them separate probes) and the hint fired on 50 for
    // ~350 chars each, all of which stayed in the re-sent history and moved the
    // model zero times. Left in the list only the shapes where a batch is
    // actually possible — the file writes, which are independent by nature.
    // A READ-ONLY shell command is the largest batchable group the whitelist
    // missed: it runs in the same concurrent batch as the lookups, yet the
    // "probe chain" rule silenced the hint for every `run_terminal` round. The
    // wording must therefore promise CONCURRENCY here, never ordering.
    if name == "run_terminal" && shell_read_is_batchable(&calls[0].2, root) {
        if lone_rounds <= 1 {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call. This command only READS, so it runs in the SAME concurrent batch as other lookups — and every step re-sends the whole conversation. Put the remaining commands you already know you need into ONE run_terminal call via commands=[\"cmd1\",\"cmd2\",…] (they run in order, one result block each), next to the reads and greps of the same step.",
            ));
        }
        return Some(Cow::Owned(format!(
            "[hint] {lone_rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation. Batch NOW: one run_terminal call with commands=[…] runs every inspection IN ORDER in this one call (one result block each); reads and greps ride the SAME step."
        )));
    }
    if matches!(name, "edit_file" | "write_file" | "artifact") {
        return Some(Cow::Owned(single_call_hint_text(lone_rounds)));
    }
    None
}

/// True when this round spent its whole round-trip on ONE call whose siblings
/// were already knowable. Main agent only: the sub-agent has its own wording.
///
/// Two families count, because BOTH run in one batch and both are rounds the
/// model could have merged:
///   - a file write (`edit_file` / `write_file` / `artifact`) — independent
///     siblings run IN ORDER in one step;
///   - a read-only native lookup (`read`, `grep`, `glob`, `find_symbol`, the five
///     `lsp_*` lookups, `fetch_url`, `load_skill`) — these run CONCURRENTLY, so a
///     lone one is the most common wasted round (measured: 54 of 65 rounds in
///     trace `mvy0ausq`, 91% of that turn's wire tokens).
///
/// Deliberately EXCLUDED: a lone `run_terminal` or browser act-then-observe
/// call is a probe CHAIN whose arguments come from the previous result — there
/// is nothing to batch, so counting it would grow the streak while the hint
/// stays silent and the field would report waste that was never addressable.
pub(super) fn single_call_is_serial(mode: &str, calls: &[(String, String, String)], root: &str) -> bool {
    if mode == "subagent" || calls.len() != 1 {
        return false;
    }
    // A shell round is a CHAIN only when it MUTATES. A read-only command shares
    // the concurrent lookup batch, so a lone one is as batchable as a lone
    // `grep` and must grow the streak (see `shell_read_is_batchable`).
    if calls[0].1 == "run_terminal" {
        return shell_read_is_batchable(&calls[0].2, root);
    }
    // The whole read-only family, because that is the set that really runs as one
    // concurrent batch (`READONLY_NATIVE_TOOLS`). The four LSP lookups were
    // missing: a lone `lsp_definition` could therefore spend a round on its own
    // and keep the streak counter at 0, so neither this lever nor the escalating
    // one fired — while the system prompt itself advertises the group as
    // batchable ("read, grep, glob, find_symbol, lsp_*"). Kept in sync with
    // that constant, not with a hand-written subset.
    matches!(
        calls[0].1.as_str(),
        "edit_file"
            | "write_file"
            | "artifact"
            | "read"
            | "grep"
            | "glob"
            | "find_symbol"
            | "lsp_symbols"
            | "lsp_definition"
            | "lsp_references"
            | "lsp_hover"
            | "lsp_diagnostics"
            | "fetch_url"
            | "load_skill"
    )
}

/// Prefix every hint block is appended with (`format!("{c}\n\n{hint}")` at the
/// delivery site), so a stale one can be cut back out exactly.
pub(super) const HINT_MARK: &str = "\n\n[hint] ";

/// Cut every `[hint]` block out of the history except the one on the NEWEST
/// tool result.
///
/// A hint rides on a tool result the model was already charged for, and from
/// then on EVERY later round re-sends it, because the whole conversation goes
/// on the wire each round trip. Measured on a live chat: 26 tool results carried
/// a hint (~350 chars each) while the model had long since acted on it or
/// refused it — every stale copy was pure re-billing. Only the freshest hint can
/// still change the NEXT step, so the older ones are elided before each request.
///
/// The tool result itself is untouched: only the appended note goes, so nothing
/// the model needs is lost.
pub(crate) fn strip_stale_hints(messages: &mut [Value]) {
    let newest = messages.iter().rposition(|m| {
        m["role"].as_str() == Some("tool")
            && m["content"].as_str().is_some_and(|c| c.contains(HINT_MARK))
    });
    let Some(newest) = newest else { return };
    for (i, m) in messages.iter_mut().enumerate() {
        if i == newest || m["role"].as_str() != Some("tool") {
            continue;
        }
        let Some(content) = m["content"].as_str() else {
            continue;
        };
        if !content.contains(HINT_MARK) {
            continue;
        }
        let head = content.split(HINT_MARK).next().unwrap_or(content);
        m["content"] = json!(head);
    }
}

/// Kept as a named constant so the trace field `lone_call_hints` still means
/// "deliveries of the escalating lone-call lever" — it is only a MEASUREMENT
/// now, no longer a cap. The cap that used to silence the lever after three
/// deliveries rested on a false premise: it assumed each delivery rides the
/// rest of the turn and is re-billed every round, but `strip_stale_hints`
/// elides every hint except the newest before each request. MEASURED on trace
/// `mvxsy14e`: the lever hit that cap at step 3 and the turn then ran 14 more
/// single-call rounds in silence. Do not reintroduce a hard cap here; the
/// every-third rhythm in the loop is what keeps the text from becoming
/// wallpaper.
pub(super) const LONE_CALL_HINT_MAX_PER_TURN: usize = 3;

/// The batching hint for the main agent's lone serial call, escalated by how
/// many rounds in a row have already been spent this way. A fixed string
/// repeated every round was measured as wallpaper (16 firings, 0 batches in one
/// fresh chat), so past the first delivery the text carries the price the model
/// is already paying instead of the same instruction a third time.
///
/// `run_terminal` is EXCLUDED from the escalation. Traced on the benchmark
/// corpus: 59 consecutive rounds of one chat were all lone `run_terminal`, and
/// the hint fired on 50 of them for ~350 chars each — every one of those
/// commands was a probe whose arguments came FROM the previous result (`ls` then
/// `cargo run --example` then `python3` over what it printed). Nothing in that
/// run was batchable, so the hint was an instruction the model could not obey,
/// and it stayed in the re-sent history. The hint speaks only where batching is
/// actually possible — file edits and the read-only lookups — and leaves the
/// shell loop alone.
pub(super) fn single_call_hint_text(rounds: usize) -> String {
    if rounds <= 1 {
        return SINGLE_CALL_HINT.to_string();
    }
    format!(
        "[hint] {rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation (tens of thousands of tokens per round on a long chat). Batch NOW: the `batch` tool runs your whole step (lookups + edits + the verify command) IN ORDER in ONE call as ops:[{{tool, args}},…] — or per-family: files:[{{path, content}}] on write_file, edits:[…] on edit_file, commands:[\"…\"] on run_terminal."
    )
}

/// The teaching form, delivered once at the start of a streak.
pub(super) const SINGLE_CALL_HINT: &str = "[hint] That step had ONE call. Every step re-sends the whole conversation, so a whole step belongs in ONE call: the `batch` tool runs up to 10 tool calls (lookups, edits, the verify command) IN ORDER in one round-trip as ops:[{tool, args},…]; several files also fit ONE write_file as files:[{path, content}]; several replacements ONE edit_file as edits:[{path, old_string, new_string, replace_all}]; several shell commands ONE run_terminal as commands:[\"…\"].";

/// Cap on the saved-plan body injected into the system prompt. A plan is
/// re-sent on EVERY round-trip of EVERY turn, so an uncapped body is a running
/// cost; a long plan is cut in the middle (head + tail survive, so the goal and
/// the latest items stay visible).
pub(super) const PLAN_SECTION_CAP: usize = 6_000;

/// Wrap the plan/checklist section as a TRAILING context message, or `None`
/// when there is nothing to inject.
///
/// The section is volatile — a single `update_plan` changes it — so it must not
/// live in `messages[0]`: the system prompt is the first byte a prefix cache
/// can reuse, and mutating it forced the whole request to be re-billed. Measured
/// before this change: main-agent system prompt 7_734 -> 9_439 -> 7_734 ->
/// 13_642 bytes across five turns, prefix cache 23.7%.
///
/// The label matters: the model reads this as context above the request, not as
/// something the user just typed, and the "NOT a new request" clause keeps an
/// unrelated turn from reacting to a stale checklist.
/// Opening line of the trailing plan/checklist context message.
///
/// Used both to BUILD that message and to RECOGNISE it when measuring the kept
/// window (see the `Compact` emit): the message exists only on the wire — the
/// renderer never stores it — so it must not inflate the renderer's fold
/// instruction. A string check keeps it out of the provider payload entirely
/// (an extra marker field on the message would ride along to the gateway).
pub(super) const PLAN_CONTEXT_HEAD: &str =
    "=== CONTEXT: current plan/checklist state (NOT a new request) ===";

/// Opening line of the trailing skills reminder message.
///
/// Wire-only like the plan context: the renderer never stores it, so it must not
/// count toward the fold instruction (see `plan_context_keep`).
pub(super) const SKILLS_CONTEXT_HEAD: &str =
    "=== REMINDER: load a matching skill first (NOT a new request) ===";

/// Opening line of the trailing plugin-context message (a hook's SessionStart
/// output: the guidance a bundle wants present for the whole conversation).
pub(super) const PLUGIN_CONTEXT_HEAD: &str =
    "=== CONTEXT: from an installed plugin (NOT a new request) ===";

/// True for a message that exists ONLY on the wire (the renderer never stores
/// it): the trailing plan/checklist context and the skills reminder. Both are
/// pushed after the user prompt to stay off the cached prefix, so the fold count
/// must ignore both.
pub(super) fn is_wire_only_context(content: &str) -> bool {
    content.starts_with(PLAN_CONTEXT_HEAD)
        || content.starts_with(SKILLS_CONTEXT_HEAD)
        || content.starts_with(PLUGIN_CONTEXT_HEAD)
}

/// Number of messages in a compaction tail that the RENDERER can actually fold.
///
/// Everything in the tail is stored by the renderer except the wire-only context
/// messages (`is_wire_only_context`). Passing `tail.len()` straight through made
/// the renderer keep one message too many verbatim — re-sending content the
/// summary already covers.
pub(super) fn plan_context_keep(tail: &[Value]) -> usize {
    tail.iter()
        .filter(|m| !m["content"].as_str().is_some_and(is_wire_only_context))
        .count()
}

pub(super) fn plan_context_message(section: &str) -> Option<Value> {
    trailing_context_message(PLAN_CONTEXT_HEAD, section)
}

pub(super) fn plugin_context_message(section: &str) -> Option<Value> {
    trailing_context_message(PLUGIN_CONTEXT_HEAD, section)
}

/// The per-turn skills reminder, pushed at the TAIL of the request.
///
/// The catalog cannot move out of the system prompt without re-billing the whole
/// cached prefix, and it is not the catalog the model is missing — it is the
/// DUTY. Real traces: an 11 KB catalog in `messages[0]`, 2 `load_skill` calls in
/// ~250 steps. Restating the duty immediately under the request is what makes a
/// weak model act, and the text is constant so it churns nothing it sits next
/// to. It never names a skill: picking one from the wording of the request was
/// removed on purpose (see `skill_router::build_section`).
pub(super) fn skills_context_message() -> Value {
    json!({
        "role": "user",
        "content": format!(
            "{SKILLS_CONTEXT_HEAD}\n\
             The `=== AVAILABLE SKILLS ===` catalog is in your system prompt. Before \
             your first tool call of this turn, check it: if the request falls under \
             one of those skills — a request in any language matches on the \
             description — call `load_skill` with that skill's name FIRST and follow its \
             instructions for the rest of the turn. If the catalog has no entry for \
             the task, do not read that as `no skill exists`: a large store cannot \
             all fit there, so call `load_skill` with a `query` of the task's words \
             and it searches every installed skill. Do not answer from memory when a \
             skill covers the task, and do not load a skill that does not apply.\n\
             --- end of reminder ---"
        ),
    })
}


/// Wrap a PER-TURN section as a trailing context message, or `None` when there
/// is nothing to send.
///
/// Any section that is recomputed from the current user message belongs here and
/// NOT in the system prompt: `system` is the cached prefix of every request in
/// the conversation, so per-turn churn there invalidates the cache for the whole
/// history (measured: one skill swap cost a 96 460-token miss). The trailing
/// position has the opposite property — it is the only place a message can
/// change without moving anything the previous call already cached.
pub(super) fn trailing_context_message(head: &str, section: &str) -> Option<Value> {
    if section.trim().is_empty() {
        return None;
    }
    Some(json!({
        "role": "user",
        "content": format!("{head}{section}\n--- end of context ---"),
    }))
}

/// The `=== SAVED PLAN` + `=== CHECKLIST` block injected as a trailing message
/// for the MAIN agent (never for the sub-agent). Returns an empty string when
/// there is no plan/checklist or no chat id to key them by. Free function (not
/// inline) so the mode gating and the size cap are testable without running a
/// turn.
pub(super) fn plan_section(data_root: &str, workspace: &str, chat_id: &str) -> String {
    if chat_id.trim().is_empty() {
        return String::new();
    }
    let mut out = String::new();
    if let Some(plan) = crate::plans::get_plan(data_root, workspace, chat_id) {
        let mut body = plan["content"].as_str().unwrap_or("").trim().to_string();
        if !body.is_empty() {
            if body.len() > PLAN_SECTION_CAP {
                let mut head_end = PLAN_SECTION_CAP / 2;
                while head_end > 0 && !body.is_char_boundary(head_end) {
                    head_end -= 1;
                }
                let mut tail_start = body.len() - PLAN_SECTION_CAP / 2;
                while tail_start < body.len() && !body.is_char_boundary(tail_start) {
                    tail_start += 1;
                }
                body = format!(
                    "{}\n… [{} chars omitted from the middle of the saved plan — read the plan file from disk if you need the omitted section]\n{}",
                    &body[..head_end],
                    body.len() - head_end - (body.len() - tail_start),
                    &body[tail_start..]
                );
            }
            out.push_str(&format!(
                "\n\n=== SAVED PLAN (from disk — follow it, do NOT re-plan) ===\n{body}\n"
            ));
        }
    }
    let checklist = crate::plans::get_checklist(data_root, workspace, chat_id);
    if let Some(items) = checklist.as_array() {
        if !items.is_empty() {
            let mut lines = String::new();
            for it in items {
                let status = it["status"].as_str().unwrap_or("pending");
                let mark = match status {
                    "completed" => "x",
                    "in_progress" => "~",
                    _ => " ",
                };
                lines.push_str(&format!(
                    "- [{mark}] {}\n",
                    it["content"].as_str().unwrap_or_default()
                ));
            }
            out.push_str(&format!(
                "\n\n=== CHECKLIST (from disk) ===\n{lines}\
                 Keep it current with update_plan as you finish items; never redo a \
                 completed one.\n"
            ));
        }
    }
    out
}

/// System prompt of the explore sub-agent: the research strategy plus a compact
/// project layout, so it starts from REAL paths instead of guessing with glob
/// (a traced run burned ~20 calls hunting for `backend/`), and explicit LSP
/// guidance (the old prompt never mentioned LSP, so the model never used it).
pub(super) fn explore_system_prompt(root: &str) -> String {
    let layout = tools::layout_snapshot(root, 3500);
    format!(
        "You are the explore sub-agent inside the workspace {root}. \
The main agent waits on you and cannot search itself, so be fast and precise. \
Every model round trip re-sends the WHOLE conversation: measured on real traces, \
an explore ROUND costs ~7.7K uncached tokens and an unfocused 9-round run paid \
~78K. ROUNDS are the price, not calls. So work in a fixed 3-step budget:\n\
STEP 1 - LOCATE (ONE step, many calls) — SKIP this step entirely when the \
question already names the files and line windows, or asks for verbatim code \
from given ranges: read those windows immediately in ONE step. A locate round \
then only re-discovers paths you were handed; on real traces the runs that \
located anyway paid 8.7K uncached tokens each against 6.7K for the ones that \
read straight away. Otherwise issue every search you can already foresee \
together — a grep per directory/keyword variant, lsp_symbols for likely files, \
find_symbol for the identifiers the question names. Do not read yet: you only \
need paths and line ranges.\n\
STEP 2 - READ (ONE step, many calls): read EVERY window step 1 pointed at, \
together — ONE `read` call carrying one `ranges` entry per window (several \
windows of the SAME file are separate entries, or one wider window; measuring a \
file with 3 separate read calls costs 3x the round-trips for the same bytes). \
Earlier results stay cached only while they remain an identical \
PREFIX of your next request, so a cheap read now costs almost nothing, while a \
later round to fetch the same window re-sends the whole conversation. When you \
already know a file, a symbol or a window you will need, read it NOW.\n\
STEP 3 - only for a genuine unknown discovered while reading, or a search that \
failed outright; otherwise stop and write the report.\n\n\
HARD RULE: never issue a step with a single call while you still have a \
question whose answer could change what you do next, and never spend a step on \
something you already have enough context to answer. Never read a file you have \
not located, and never guess an offset: read offset=1, or the window a result \
pointed you at — an offset past the end returns nothing and wastes a whole round.\n\
How to search — never blindly. First decide what the question gives you, enter at \
the matching step below, and move from the cheapest PRECISE tool to the next:\n\
1. Paths and directories come from PROJECT LAYOUT (below), never from guessing. \
glob lists FILES only (never directories) and matches the pattern against the \
path relative to `path`; `**/` matches zero or more directories. To list a \
directory, read its path. A 'no matches' answer is final: do NOT retry it with \
variations — switch tool, or re-read the layout.\n\
2. The question names a FILE (or the layout makes the file obvious): lsp_symbols \
on it (names + line ranges), then read ONLY the window you need. Never read a big \
file whole.\n\
3. The question names a SYMBOL / identifier: ONE find_symbol call with the bare \
identifier (scope it with path/include taken from the layout) — it returns the \
definition(s) with their bodies AND the usages together, so it replaces the \
grep -> lsp_definition -> lsp_references chain. Reach for lsp_definition / \
lsp_references only when you need type/signature info or the language server's \
view of a name find_symbol could not resolve.\n\
4. The question describes a BEHAVIOUR with no names: ONE grep scoped to the likely \
directory/include with 2-3 alternative keywords (a|b|c) — several such greps for \
different directories go in the same step; then continue from step 2 or 3 on what \
it found.\n\
5. If an lsp_* tool says the language server is unavailable, stop using LSP for \
that language and use grep + read.\n\
6. Before each step, for every call ask: which exact question does it answer, and \
what will I do differently depending on the result? Drop any call that cannot \
change your next action. Grep shows only a few lines around each hit — read the \
window you need, but never re-read what a result already showed and never repeat \
a search with the same pattern. Every search goes through `grep`/`find_symbol`/\
`glob`/`lsp_*` — you have no shell, and a search written as a shell line is not \
yours to make.\n\n\
FINAL REPORT (your only text output — write nothing between tool calls): the \
main agent edits files with exact-match strings and only re-reads the narrow \
windows you point at, so precision \
matters and padding costs it tokens on every later step. Format:\n\
(a) ANSWER: 2-4 lines that directly answer the question.\n\
(b) CODE: VERBATIM excerpts, each with path:start-end, ONLY for code it must edit \
or rely on — copy the exact text, never paraphrase code. `read` output has a \
`path (lines a-b):` header and an `N: ` prefix on every line: N is the line \
number, NOT file content — use it for start-end, but never copy the header or \
the prefix into CODE (the main agent edits by exact-match strings).\n\
(c) ALSO RELEVANT: other locations as `path:line — one line`.\n\
Leave out the search trail, dead ends, irrelevant files and any restating of the \
question. Aim for under ~6 KB.\n\
You have NO write tools: never modify files. When you learn a durable key point \
(decision, preference, gotcha), save it with save_memory — concise, under ~500 \
chars, never whole files or outputs. Report in English.\n\n\
PROJECT LAYOUT (dir: entries; hidden dirs and build output omitted):\n{layout}"
    )
}

/// Bumped by `POST /chat/retry_now`: the explore ladder watches it during its
/// backoff so the banner's Retry button can force the NEXT attempt immediately
/// instead of leaving a dead button on screen for the rest of the wait.
///
/// Deliberately global rather than per-chat: a ladder only ever runs inside one
/// live parent turn, so a bump can only be observed by the retry the user is
/// actually looking at.
pub(super) static RETRY_NUDGE: AtomicU64 = AtomicU64::new(0);

/// Chat ids whose sub-agent retry ladder is LIVE, ref-counted because parallel
/// explore calls in one turn can each be retrying at the same time.
///
/// `POST /chat/retry_now` answers from this: a banner can outlive the ladder
/// that produced it (the turn ended, the stream dropped), and a click that
/// nothing is listening for must not be reported as accepted — that is exactly
/// how the Retry button came to look broken.
pub(super) fn live_retries() -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Register (or drop, with `delta = -1`) one live ladder for a chat.
pub(super) fn mark_live(chat_id: &str, delta: i32) {
    let Ok(mut map) = live_retries().lock() else {
        return;
    };
    let entry = map.entry(chat_id.to_string()).or_insert(0);
    if delta > 0 {
        *entry += 1;
    } else if *entry > 1 {
        *entry -= 1;
    } else {
        map.remove(chat_id);
    }
}

/// Whether a sub-agent retry ladder is currently running for this chat.
pub fn retry_ladder_live(chat_id: &str) -> bool {
    live_retries()
        .lock()
        .map(|m| m.contains_key(chat_id))
        .unwrap_or(false)
}

/// Force the running explore ladder to retry immediately (banner Retry button).
///
/// Returns whether a ladder was actually listening, so the HTTP handler can
/// tell the renderer the truth instead of always claiming success.
pub fn nudge_subagent_retry(chat_id: &str) -> bool {
    RETRY_NUDGE.fetch_add(1, Ordering::Relaxed);
    retry_ladder_live(chat_id)
}

/// Ref-counted "this chat has a live retry ladder" registration, released on
/// EVERY exit path (success, give-up, cancel) by `Drop`. Without the guard the
/// map would leak an entry per abandoned retry and the endpoint would keep
/// promising that something is listening.
pub(super) struct RetryLive {
    chat_id: String,
    armed: bool,
}

impl RetryLive {
    pub(super) fn new(chat_id: &str) -> Self {
        Self {
            chat_id: chat_id.to_string(),
            armed: false,
        }
    }

    /// Mark live on the first retry this ladder actually announces.
    pub(super) fn arm(&mut self) {
        if !self.armed {
            self.armed = true;
            mark_live(&self.chat_id, 1);
        }
    }
}

impl Drop for RetryLive {
    fn drop(&mut self) {
        if self.armed {
            mark_live(&self.chat_id, -1);
        }
    }
}

/// Current nudge counter — see `RETRY_NUDGE`.
pub(super) fn retry_nudge() -> u64 {
    RETRY_NUDGE.load(Ordering::Relaxed)
}

/// Latest Tool Models entry the renderer reported per slot ("explore" →
/// "providerId/model", or "" for the parent model), with the sequence number at
/// which it was reported.
///
/// `subagent_models` arrives as a snapshot in the turn's request body, so a
/// model the user fixes WHILE a sub-agent is retrying was invisible to the
/// running ladder — it kept hammering the very model they had just replaced
/// ("I change the sub-agent model and it still retries with the old one"). The
/// renderer posts every change here; the ladder compares it against the entry
/// it last applied and re-resolves before the next attempt.
///
/// The sequence number matters: an entry reported BEFORE a ladder started is
/// already reflected in that turn's snapshot, so honouring it would only let a
/// stale value from an earlier turn clobber the current one.
pub(super) static LIVE_SLOT_ENTRIES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, u64)>>,
> = std::sync::OnceLock::new();

/// Monotonic clock for `LIVE_SLOT_ENTRIES`.
pub(super) static LIVE_SLOT_SEQ: AtomicU64 = AtomicU64::new(0);

pub(super) fn live_slot_entries() -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, u64)>> {
    LIVE_SLOT_ENTRIES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Current live-slot sequence — a ladder captures this when it starts.
pub(super) fn live_slot_seq() -> u64 {
    LIVE_SLOT_SEQ.load(Ordering::Relaxed)
}

/// Record a slot's CURRENT model — see `LIVE_SLOT_ENTRIES`.
pub fn set_live_slot_entry(slot: &str, entry: &str) {
    let Ok(mut map) = live_slot_entries().lock() else {
        return;
    };
    let slot = slot.trim();
    if slot.is_empty() {
        return;
    }
    let seq = LIVE_SLOT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    map.insert(slot.to_string(), (entry.trim().to_string(), seq));
}

/// The slot's entry if it was reported AFTER `since` — i.e. after the calling
/// ladder started, so it is genuinely newer than the turn's snapshot.
pub(super) fn live_slot_entry_since(slot: &str, since: u64) -> Option<String> {
    let map = live_slot_entries().lock().ok()?;
    match map.get(slot) {
        Some((entry, seq)) if *seq > since => Some(entry.clone()),
        _ => None,
    }
}

/// Whether a failed attempt means "THIS model cannot serve us" — the only case
/// where moving down to the next configured fallback is right.
///
/// The rule itself lives in [`crate::llm::should_fall_back`] and is shared by
/// every model chain (tools, compaction, titles, schedules), so the user sees
/// ONE rule no matter which call failed: a fallback replaces a model that does
/// not work — a refused key, an unknown model, an empty answer — and never a
/// transport problem. A dropped connection, a timeout, a 5xx or a 429 keeps the
/// SAME model, because another model cannot fix the network, and spending the
/// whole list on one provider hiccup hides the real reason behind the last
/// rung's error.
pub(super) fn subagent_error_is_fatal(err: &str) -> bool {
    crate::llm::should_fall_back(err)
}

pub(super) async fn run_subagent(
    parent: &AgentRequest,
    args: &Value,
    branch: u64,
    // The tool name that spawned this sub-agent: `explore`, or the name of a
    // plugin PROFILE (`plugins::find_plugin_agent`). Carried through to the
    // retry events so the banner can name the tool, not just the agent.
    tool: &str,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
) -> (String, bool) {
    let description = args["description"].as_str().unwrap_or_default().to_string();
    let prompt = args["prompt"].as_str().unwrap_or_default().to_string();
    if prompt.is_empty() {
        return (format!("{tool} requires a non-empty prompt"), false);
    }
    // A plugin sub-agent PROFILE supplies its own system prompt and narrows the
    // tool set; a name `explore` keeps the builtin research prompt. The MODEL is
    // deliberately NOT taken from the profile: every sub-agent — builtin or
    // installed — runs on the `explore` slot of Settings → Tools, so one row
    // controls what they all cost. A profile that names its own model is ignored.
    let profile = if tool == "explore" {
        None
    } else {
        crate::plugins::find_plugin_agent(
            std::path::Path::new(&parent.data_root),
            tool.strip_prefix(DELEGATION_PREFIX).unwrap_or(tool),
        )
    };

    // Every retry event of this ladder is stamped with ITS branch id. Parallel
    // explore calls share one stream, so without it the renderer cannot tell
    // WHICH sub-agent recovered: a sibling's tool call retired another's banner,
    // and the recovered branch's own banner stayed frozen until its whole tool
    // finished. The branch id is what lets the banner retire the moment ITS
    // sub-agent makes progress again.
    let emit_raw = emit;
    // The ladder's OWN trace rows: every retry of this run lands here under
    // ONE run id. A failed attempt never reaches run_turn's `llm` row (that is
    // only written after a successful stream), so without this the baseline
    // could not count the attempts a run actually burned — the mission's
    // instrumentation asks for exactly that. `kind:"retry"`; the reason and
    // model name the rung.
    let trace = crate::trace::TraceStore::new(parent.chat_id.clone())
        .with_run(TURN_SEQ.fetch_add(1, Ordering::Relaxed));
    let mut emit = |ev: &AgentEvent| match ev {
        ev @ (AgentEvent::Retry { attempt, max_attempts, reason, model, tool, provider_id, fallback, .. }
        | AgentEvent::RetryGiveup { attempt, max_attempts, reason, model, tool, provider_id, fallback, .. }) => {
            let giveup = matches!(ev, AgentEvent::RetryGiveup { .. });
            let reconnecting = matches!(ev, AgentEvent::Retry { reconnecting: true, .. });
            trace.record(crate::trace::TraceEntry {
                kind: "retry".into(),
                summary: format!(
                    "attempt {attempt}/{max_attempts}{}",
                    if giveup { " — gave up" } else { "" }
                ),
                model: Some(model.clone()),
                error: Some(reason.clone()),
                detail: Some(json!({
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "tool": tool,
                    "provider_id": provider_id,
                    "reconnecting": reconnecting,
                    "fallback": fallback,
                    "giveup": giveup,
                })),
                ..Default::default()
            });
            emit_raw(&AgentEvent::Branch {
                branch,
                sub: false,
                inner: Box::new(ev.clone()),
            })
        }
        _ => emit_raw(ev),
    };

    emit(&AgentEvent::Status {
        stage: "subagent".into(),
        content: description.clone(),
    });

    // Read-only sub-request: research-only system prompt. The model comes
    // from the Tool Models "subagent" slot (cross-provider aware), falling
    // back to the parent model when the slot is empty.
    let (sub_model, sub_base, sub_keys, sub_provider_id) = resolve_subagent_target(parent);
    // The explore slot may carry its own reasoning level; empty inherits the
    // main model's level. `resolve_subagent_target` already resolved the
    // effective provider, so its id (not the parent's) is what the usage
    // event must report.
    let sub_level = parent
        .subagent_thinking
        .get("explore")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    // The explore slot's reasoning level, applied to EVERY rung of the call
    // chain: a fallback model runs at the TOOL's effort, never a level of its
    // own. (`sub_level` itself is moved into the sub-request below.)
    let chain_level = sub_level.clone();
    let sub_model_reasoning =
        provider_model_reasoning(&parent.providers, &sub_provider_id, &sub_model);
    // The slot's OWN endpoint kind. `parent.provider` is the kind of the CHAT's
    // provider while rung 0 belongs to the SLOT: a slot on a different provider
    // kind (an Anthropic row while the chat runs on a custom gateway) must not
    // be called with the chat's URL shape and auth header.
    let slot_entry = parent
        .subagent_models
        .get("explore")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let sub_provider_kind =
        crate::backend_light::resolve_slot_kind(&slot_entry, &parent.provider, &parent.providers);
    let mut sub_req = AgentRequest {
        provider: sub_provider_kind,
        provider_id: sub_provider_id,
        model: sub_model,
        base_url: sub_base,
        api_key: parent.api_key.clone(),
        api_keys: sub_keys,
        root: parent.root.clone(),
        mode: "subagent".into(),
        prompt,
        history: Vec::new(),
        system_prompt: match profile.as_ref().and_then(|p| p["prompt"].as_str()) {
            Some(text) if !text.trim().is_empty() => text.to_string(),
            _ => explore_system_prompt(&parent.root),
        },
        // A sub-agent is read, not heard: never apply the live-voice rules.
        system_suffix: String::new(),
        skills: Vec::new(),
        // The profile's declared tools, intersected with the research set inside
        // the sub-turn (`retain_subagent_tools`): a profile can only NARROW what
        // its own sub-agent may call, never widen it.
        subagent_tools: profile
            .as_ref()
            .and_then(|p| p["tools"].as_array())
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        context_window: parent.context_window,
        chat_id: parent.chat_id.clone(),
        mcp_servers: Value::Null,
        // A sub-agent runs the research tool set (read/grep/find_symbol): it has
        // no connectors at all, so nothing is ever activated for it.
        mcp_active: Vec::new(),
        data_root: parent.data_root.clone(),
        subagent_models: parent.subagent_models.clone(),
        providers: parent.providers.clone(),
        // Sub-agents are research-only: desktop control is never delegated.
        allow_computer: false,
        // A research sub-agent has no business driving a page either.
        allow_browser: false,
        // Authoring tools are never delegated either.
        allow_create: false,
        // A read grant is inherited: the user widened THIS TURN's reach, and a
        // sub-agent the turn delegates to searches the same disk.
        allow_outside: parent.allow_outside,
        allow_outside_folders: parent.allow_outside_folders.clone(),
        // Web search IS research, so the sub-agent inherits the same engine
        // chain the user configured for the parent turn.
        search_plugins: parent.search_plugins.clone(),
        // Media slots ride along like the search chain above: a delegated turn
        // that generates a preview image uses the configured provider.
        image_provider_id: parent.image_provider_id.clone(),
        image_model: parent.image_model.clone(),
        image_fallbacks: parent.image_fallbacks.clone(),
        video_provider_id: parent.video_provider_id.clone(),
        video_model: parent.video_model.clone(),
        video_fallbacks: parent.video_fallbacks.clone(),
        // A sub-agent never folds its own history mid-turn — it has a separate,
        // much smaller budget (compact_subagent_messages, before its loop).
        compact_at_percent: parent.compact_at_percent,
        fallback_provider: String::new(),
        fallback_model: String::new(),
        fallback_base_url: String::new(),
        fallback_api_key: String::new(),
        fallback_api_keys: Vec::new(),
        thinking_level: if sub_level.is_empty() {
            // Missing explore-slot level = OFF: tool calls do not inherit the
            // main chat's reasoning effort (their default is none).
            String::new()
        } else {
            sub_level
        },
        model_reasoning: sub_model_reasoning,
        // The slot LEVELS flow through too: the web distiller this sub-agent's
        // `web_search`/`fetch_url` calls run through reads the "web" level from
        // THIS map, so an empty one silently dropped the Other row's effort to
        // "none" inside every exploration. The sub-agent's own effort is applied
        // via `thinking_level` above, and the mid-turn compact that also reads
        // this map never runs here (the `mode != "subagent"` gate), so no other
        // key changes behaviour.
        subagent_thinking: parent.subagent_thinking.clone(),
        // The explore sub-agent carries its OWN fallback ladder (a fresh copy:
        // the slot list is re-read per call from the parent request).
        tool_fallbacks: parent.tool_fallbacks.clone(),
        // A research sub-agent is text-only — images belong to the parent turn.
        images: Vec::new(),
        // A sub-agent inherits the parent's auto-fetch count.
        web_search_auto_fetch: parent.web_search_auto_fetch,
        // …and the headless contract: a scheduled run's explore must also
        // surface a mid-turn stream error instead of ending "successfully"
        // with a partial report (the parent's ladder handles Err already).
        headless: parent.headless,
        // …and its capabilities: a read-only parent must not become writable
        // just because it handed the work to a sub-agent.
        cap: parent.cap.clone(),
    };

    // Attempt ladder. A sub-agent runs INSIDE the parent turn, so the
    // frontend's reconnect ladder can never see it fail — a provider hiccup
    // (or a run that returned nothing) used to be final and the user just
    // watched a dead explore card while the turn stalled. Each attempt is
    // bounded by the model call itself, never by a wall-clock timer: a slow
    // but healthy provider is NOT a failure.
    let mut last: (String, bool) = (String::new(), false);
    // The explore slot's full call chain, rebuilt from scratch for EVERY explore
    // call (this function is called once per explore): the slot's own model
    // first, then `tool_fallbacks["explore"]` in the user's order. Nothing about
    // it survives the call, which is what keeps a fallback an escape hatch for
    // ONE failing call instead of a new default.
    let mut chain: Vec<(String, String, Vec<String>, String, String)> = vec![];
    // Index of the rung `sub_req` currently points at. 0 = the slot's own model.
    let mut chain_idx = 0usize;
    // Set once a rung BEYOND the slot's own model has been applied. Kept outside
    // the loop so the ladder can tell "the slot model is broken" from "the
    // fallback is broken too".
    let mut using_fallback = false;
    // How ONE attempt ended. A user-requested restart is distinct from both a
    // failure and a hang: nothing is wrong with the model, we simply stopped
    // waiting because the user asked us to.
    enum AttemptEnd {
        Finished(Result<(), String>),
        Hung,
        Nudged,
    }
    // Highest nudge value this ladder has already ACTED on.
    //
    // A click must be honoured exactly once, and it must be honoured whatever
    // the ladder happens to be doing at that moment: sitting in a backoff, OR
    // waiting on a model call that may not answer for minutes. Tracking what was
    // already consumed is what makes both possible. Comparing against a value
    // captured once before the loop made a single click fire forever; capturing
    // it again at each backoff (the original bug) threw away every click that
    // landed while an attempt was running.
    let mut consumed_nudge = retry_nudge();
    // The Tool Models entry this ladder last applied. The turn's request body
    // carries only a SNAPSHOT of Tool Models, so this is what lets the ladder
    // notice that the user replaced the slot's model WHILE it is retrying.
    let mut applied_slot = parent
        .subagent_models
        .get("explore")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    // Anything reported at or before this sequence is already part of the turn's
    // snapshot, so only a LATER entry can be a change made mid-turn.
    let slot_seq_at_start = live_slot_seq();
    // Ref-counted "a ladder is live for this chat" marker, dropped on EVERY exit
    // path below (success, give-up, break, cancel). It exists so the Retry
    // endpoint can answer honestly instead of always claiming it was accepted.
    let mut live = RetryLive::new(parent.chat_id.as_str());
    // Armed for the whole ladder, not only while a banner is on screen: the
    // nudge select watches from the FIRST attempt, so a click is honoured
    // wherever the ladder happens to be.
    live.arm();
    // Build the chain HERE, before the budget is derived from it. It used to be
    // built lazily inside the loop, which meant the budget was computed against
    // an EMPTY chain and always collapsed to SUBAGENT_MAX_ATTEMPTS — so a long
    // fallback list could never be walked, because the attempts ran out before
    // the tail was reached. The in-loop build below is kept for the mid-turn
    // slot change, which clears the chain and rebuilds it around the model the
    // user just picked.
    chain = crate::backend_light::resolve_slot_chain(
        applied_slot.as_str(),
        parent
            .tool_fallbacks
            .get("explore")
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        &parent.model,
        &parent.base_url,
        &parent.api_keys,
        &parent.provider_id,
        &parent.provider,
        &parent.providers,
    );
    // The ladder's attempt budget is DERIVED from the chain, not fixed at 10.
    // Every rung costs up to SUBAGENT_RUNG_ATTEMPTS attempts, so the budget
    // covers each rung plus one spare, and never drops below the old 10 so a
    // short chain keeps exactly the retry story it had.
    let max_attempts = SUBAGENT_MAX_ATTEMPTS
        .max(chain.len().saturating_add(1) * SUBAGENT_RUNG_ATTEMPTS);
    // Attempts spent on the rung `sub_req` currently points at, reset whenever
    // the rung changes. The budget belongs to ONE model, not to the ladder.
    let mut rung_attempts = 0usize;
    for attempt in 1..=max_attempts {
        let mut report = String::new();
        let mut sub_error = String::new();
        // Re-resolve the slot BEFORE every attempt. The user fixing the
        // sub-agent model while it retries expects the NEXT attempt to use it,
        // not the next turn — before this the ladder kept hammering the very
        // model they had just replaced, because the request body's snapshot
        // never changes mid-turn.
        if let Some(live) = live_slot_entry_since("explore", slot_seq_at_start) {
            if live != applied_slot {
                applied_slot = live.clone();
                let (m, base, keys, pid) = resolve_slot_target(parent, &live);
                sub_req.model = m;
                sub_req.base_url = base;
                sub_req.api_keys = keys;
                sub_req.provider_id = pid.clone();
                // The row the user just picked may live on a different provider
                // KIND: routing it with the old kind builds the wrong URL path
                // and the wrong auth header.
                sub_req.provider = crate::backend_light::resolve_slot_kind(
                    &live,
                    &parent.provider,
                    &parent.providers,
                );
                sub_req.model_reasoning =
                    provider_model_reasoning(&parent.providers, &pid, &sub_req.model);
                // A freshly chosen model deserves a clean ladder: the earlier
                // "the slot model is broken" verdict was about the OLD one.
                using_fallback = false;
                // …and the chain is rebuilt around the new model, so the
                // fallbacks follow the row the user just picked.
                chain.clear();
                chain_idx = 0;
                rung_attempts = 0;
            }
        }
        // Build the chain lazily, on the first attempt: `sub_req` already holds
        // rung 0 (the slot's own model, resolved above), and the fallback list is
        // re-read here so a mid-turn edit is picked up together with the swap
        // above.
        if chain.is_empty() {
            chain = crate::backend_light::resolve_slot_chain(
                applied_slot.as_str(),
                parent
                    .tool_fallbacks
                    .get("explore")
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                &parent.model,
                &parent.base_url,
                &parent.api_keys,
                &parent.provider_id,
                &parent.provider,
                &parent.providers,
            );
            chain_idx = 0;
        }
        // Liveness clock for the idle guard below: EVERY event this attempt
        // emits bumps it, so what the guard measures is real silence — a
        // blocking tool call that never returns, or a provider that accepted
        // the connection and stopped responding — never a slow-but-working
        // model.
        let pulse = std::sync::Arc::new(AtomicU64::new(1));
        let pulse_sink = std::sync::Arc::clone(&pulse);
        let (res, was_nudged) = {
            let mut sink = |ev: &AgentEvent| {
                pulse_sink.fetch_add(1, Ordering::Relaxed);
                fold_subagent_event(&mut report, &mut sub_error, ev);
                // Forward only structural sub-agent events (status/tool/usage/
                // thinking) to the parent stream so its tool calls stay visible
                // in the chat while explore works — the sub-agent's narration
                // (Text) and errors must never surface in the user's chat: the
                // report goes to the PARENT agent as the tool result only.
                match ev {
                    // The sub-run's own Done must not reach the parent stream
                    // (it would read as the PARENT turn finishing).
                    AgentEvent::Text { .. } | AgentEvent::Error { .. } | AgentEvent::Done { .. } => {}
                    // Tool calls are tagged with this explore's branch so they
                    // nest under its card instead of floating in the chat.
                    AgentEvent::ToolStart { .. } | AgentEvent::Tool { .. } => {
                        emit(&AgentEvent::Branch {
                            branch,
                            sub: true,
                            inner: Box::new(ev.clone()),
                        })
                    }
                    _ => emit(ev),
                }
            };
            // Race the WHOLE attempt against an idle guard. The failure this
            // catches is the one the ladder above cannot: a call that never
            // comes back. Dropping the future below ends the attempt, so the
            // hang becomes a REAL error and the ladder retries it exactly like
            // any other failure — instead of the turn freezing behind a
            // "tool running" pill until the user hits Stop.
            let guard_pulse = std::sync::Arc::clone(&pulse);
            let guard = async move {
                let mut seen = guard_pulse.load(Ordering::Relaxed);
                // LSP has its own heartbeat: a cold language server says nothing
                // for minutes while it builds its index, and that is progress,
                // not a wedge — aborting it would kill a healthy cold start.
                let mut seen_lsp = crate::lsp::activity();
                let mut silent_since = std::time::Instant::now();
                let started = std::time::Instant::now();
                // …but the heartbeat is GLOBAL, so LSP work that has nothing to
                // do with this attempt (another turn, a background pre-warm, a
                // wedged call from an earlier tool) resets the silence clock
                // forever and no amount of silence ever trips the guard. That is
                // how an explore attempt sat "Contacting model" for 11 minutes
                // while the retry banner counted up. So the heartbeat may only
                // EXTEND the attempt up to a hard ceiling; past it the attempt is
                // declared hung no matter how much unrelated LSP traffic there is.
                let cap = std::time::Duration::from_secs(subagent_idle_secs() + 120);
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if started.elapsed() >= cap {
                        return;
                    }
                    let now = guard_pulse.load(Ordering::Relaxed);
                    let now_lsp = crate::lsp::activity();
                    if now != seen || now_lsp != seen_lsp {
                        seen = now;
                        seen_lsp = now_lsp;
                        silent_since = std::time::Instant::now();
                    } else if silent_since.elapsed()
                        >= std::time::Duration::from_secs(subagent_idle_secs())
                    {
                        return;
                    }
                }
            };
            let fut = run_turn(&sub_req, &mut sink, cancel);
            tokio::pin!(fut);
            // The Retry button must be able to end an attempt that is already
            // RUNNING, not merely shorten the wait after it. The banner stays up
            // for the whole attempt, so a click almost always lands while the
            // model call is in flight — often on a provider that has accepted the
            // connection and gone quiet. Shortening only the backoff left the
            // button visibly "acknowledged" while nothing actually happened.
            let nudge_from = consumed_nudge;
            let nudge = async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    if retry_nudge() != nudge_from {
                        return;
                    }
                }
            };
            tokio::pin!(nudge);
            let end = tokio::select! {
                r = &mut fut => AttemptEnd::Finished(r),
                _ = guard => AttemptEnd::Hung,
                _ = &mut nudge => AttemptEnd::Nudged,
            };
            let was_nudged = matches!(end, AttemptEnd::Nudged);
            // Whatever ended this attempt, the nudge that did so is spent. Record
            // it BEFORE retrying, so one click can never cut the next attempt short
            // as well (that would burn the whole ladder in a single click).
            if was_nudged {
                consumed_nudge = retry_nudge();
            }
            let res = match end {
                AttemptEnd::Finished(r) => r,
                AttemptEnd::Hung => Err(format!(
                    "sub-agent hung: no activity for {}s (a \
stuck tool call or a provider that stopped responding) — attempt aborted",
                    subagent_idle_secs()
                )),
                AttemptEnd::Nudged => Err(String::new()),
            };
            (res, was_nudged)
        };
        // The user asked for this attempt to be REDONE. Nothing failed — we
        // simply stopped waiting — so retry immediately with no backoff, and
        // deliberately leave `last` untouched: if the ladder later gives up it
        // must still report the REAL failure reason, never an empty "requested".
        if was_nudged {
            // A manual retry is a fresh attempt at the SAME model: it must not
            // count against the rung's budget, or pressing the button twice
            // would jump to a fallback the user never asked for.
            rung_attempts = 0;
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if attempt == max_attempts {
                // A manual retry on the final attempt: nothing is left to try, so
                // end with a truthful reason instead of silently looping.
                last = (
                    "the last attempt was cut short for a manual retry and no attempts remained"
                        .into(),
                    false,
                );
                break;
            }
            emit(&AgentEvent::Retry {
                // NEXT attempt, not the one just abandoned: re-emitting the
                // current number left the badge frozen on the same "6/10" after
                // a click, which reads as "the button did nothing at all" even
                // though the ladder had already restarted.
                attempt: attempt + 1,
                // The REAL budget: a long fallback chain raises it above
                // SUBAGENT_MAX_ATTEMPTS, and quoting the constant here made
                // the badge jump between "6/10" and "7/14" after a click.
                max_attempts,
                delay_secs: 0,
                reason: "retrying now (requested)".into(),
                agent: "explore subagent".into(),
                tool: tool.to_string(),
                model: sub_req.model.clone(),
                provider_id: sub_req.provider_id.clone(),
                reconnecting: true,
                fallback: false,
            });
            continue;
        }
        let failed: (String, bool) = match classify_subagent_attempt(&res, &report, &sub_error) {
            Ok(()) => return (report, true),
            Err(reason) => (reason, false),
        };
        last = failed;
        // Attempts spent on the CURRENT rung; reset whenever the rung moves.
        rung_attempts = rung_attempts.saturating_add(1);
        // A rung gets ONE try per pass, whatever the failure: a refused key, a
        // rate limit, a 5xx or a dropped connection all hand the call to the
        // NEXT model in the user's list immediately — asking the same model
        // again right away can only reproduce the same error, and the walk
        // returns to this rung on the next pass anyway. The pause lives
        // between PASSES (the wrapped walk below), never between rungs.
        let rung_spent = rung_attempts >= SUBAGENT_RUNG_ATTEMPTS;
        let advance = attempt < max_attempts && (subagent_error_is_fatal(&last.0) || rung_spent);
        // Set when the walk ran off the END of the list and went back to rung 0:
        // the banner then says the whole list is being tried again.
        let mut wrapped = false;
        if advance {
            // The slot's own chain is the WHOLE try order. The chat model used to
            // be appended as a final rung, which meant a tool with an empty
            // fallback list silently kept trying a model the user never picked
            // for it — and a tool WITH fallbacks could still land on the chat
            // model instead of failing loudly.
            let next = chain_idx + 1;
            if next >= chain.len() && chain.len() > 1 {
                // Every rung has failed. The list is not the end of the road:
                // the walk goes back to the TOP — the tool's own model — and
                // tries the whole list again, until the attempt budget is spent.
                // (A provider that was down a minute ago is often back; giving
                // up after one pass is what left the turn dead while the first
                // model had already recovered.) The backoff below still applies,
                // so the walk never spins through dead rungs without pausing.
                wrapped = true;
                chain_idx = 0;
                rung_attempts = 0;
                if let Some((m, b, keys, pid, kind)) = chain.first() {
                    sub_req.model = m.clone();
                    sub_req.provider_id = pid.clone();
                    sub_req.base_url = b.clone();
                    sub_req.api_keys = keys.clone();
                    sub_req.provider = kind.clone();
                    sub_req.model_reasoning = provider_model_reasoning(&parent.providers, pid, m);
                    sub_req.thinking_level = chain_level.clone();
                }
            } else if next >= chain.len() {
                // A one-model chain: there is nothing to rotate through, so the
                // pass ends after THIS rung either way. The walk wraps to the
                // same model on the next pass (the pause below separates the
                // passes) — a fatal error is not an early exit any more: the
                // user's rule is uniform, every model gets its next pass until
                // the attempt budget is spent.
                rung_attempts = 0;
            } else {
                // Moving down the chain: the NEXT fallback model the user picked,
                // in their order. Each rung is applied with the SLOT's reasoning
                // level — a fallback changes the model and its routing, never
                // the effort the user chose.
                chain_idx = next;
                rung_attempts = 0;
                if let Some((m, b, keys, pid, kind)) = chain.get(next) {
                    using_fallback = true;
                    sub_req.model = m.clone();
                    sub_req.provider_id = pid.clone();
                    sub_req.base_url = b.clone();
                    sub_req.api_keys = keys.clone();
                    sub_req.provider = kind.clone();
                    sub_req.model_reasoning = provider_model_reasoning(&parent.providers, pid, m);
                    // The slot's level, unchanged: only the model moves down the
                    // list.
                    sub_req.thinking_level = chain_level.clone();
                }
                // Tell the renderer straight away, so the user sees WHICH model
                // stopped working instead of watching a silent 90s of retries.
                emit(&AgentEvent::Retry {
                    attempt,
                    max_attempts,
                    delay_secs: 0,
                    reason: format!("{} — trying the next model", last.0),
                    agent: "explore subagent".into(),
                    tool: tool.to_string(),
                    model: sub_req.model.clone(),
                    provider_id: sub_req.provider_id.clone(),
                    reconnecting: true,
                    fallback: true,
                });
                continue;
            }
        }
        // Stop aborts the ladder too: never spawn another sub-agent after the
        // user cancelled the turn.
        if attempt == max_attempts || cancel.load(Ordering::Relaxed) {
            break;
        }
        // Same ladder, same events, same banner as a main-model retry: the
        // renderer must not be able to tell a sub-agent hiccup from a main
        // agent one. `agent` is what labels WHICH model the user should change,
        // `tool` names the tool that owns the retry.
        let reason = if wrapped {
            format!("{} — every model failed, starting over from the first", last.0)
        } else {
            last.0.clone()
        };
        emit(&AgentEvent::Retry {
            attempt,
            max_attempts,
            delay_secs: SUBAGENT_RETRY_BACKOFF_MS / 1000,
            reason: reason.clone(),
            agent: "explore subagent".into(),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
            provider_id: sub_req.provider_id.clone(),
            reconnecting: true,
            fallback: false,
        });
        // The backoff is INTERRUPTIBLE: the banner's Retry button bumps
        // `RETRY_NUDGE` and the remaining wait is skipped. A click that landed
        // while the attempt was RUNNING normally ends the attempt outright (see
        // the nudge select above) and never reaches this loop — but the wait
        // must stay interruptible too, or a click during the countdown would be
        // dropped.
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(SUBAGENT_RETRY_BACKOFF_MS);
        let mut forced = false;
        while std::time::Instant::now() < deadline {
            if retry_nudge() != consumed_nudge {
                forced = true;
                consumed_nudge = retry_nudge();
                break;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            tokio::time::sleep(left.min(std::time::Duration::from_millis(250))).await;
        }
        if forced {
            // Instant feedback: restart the banner so the user sees the click
            // registered, then retry right away. The badge must report the
            // attempt that is about to START: re-emitting the number that was
            // just abandoned left the counter frozen on its old value, which
            // reads as "the button did nothing".
            emit(&AgentEvent::Retry {
                attempt: attempt + 1,
                max_attempts,
                delay_secs: 0,
                reason: "retrying now (requested)".into(),
                agent: "explore subagent".into(),
                tool: tool.to_string(),
                model: sub_req.model.clone(),
                provider_id: sub_req.provider_id.clone(),
                reconnecting: true,
                fallback: false,
            });
        }
    }
    // The ladder is exhausted (or the user cancelled): the failure is final,
    // so surface it as a give-up — the renderer keeps the banner and its Retry
    // button up instead of clearing them on `done`.
    if !cancel.load(Ordering::Relaxed) && !last.1 {
        emit(&AgentEvent::RetryGiveup {
            attempt: max_attempts,
            max_attempts,
            reason: last.0.clone(),
            agent: "explore subagent".into(),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
            provider_id: sub_req.provider_id.clone(),
            fallback: using_fallback,
        });
    }
    last
}

