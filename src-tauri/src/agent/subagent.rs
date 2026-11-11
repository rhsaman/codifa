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
        return Err(format!("sub-agent failed: {err}"));
    }
    if report.trim().is_empty() {
        // The turn "succeeded" but produced no output — the parent must not
        // treat an empty report as data.
        return Err(
            "sub-agent returned no findings: it produced no output (empty model response)"
                .to_string(),
        );
    }
    if report_is_garbled(report) {
        // A model that breaks mid tool-call can end the turn with a few tokens
        // of leaked call markup (`analysis激光 </rfl:parameter>`). That is not a
        // report: treat it as a failed attempt so the ladder moves on at once.
        return Err(
            "sub-agent returned malformed output (broken tool-call markup)".to_string(),
        );
    }
    Ok(())
}

/// Whether a SHORT report is just leaked tool-call markup. Deliberately narrow:
/// only a tiny reply that carries a call-markup marker counts, so a real report
/// that merely quotes such a tag in its body is never rejected.
pub(super) fn report_is_garbled(report: &str) -> bool {
    let t = report.trim();
    if t.chars().count() > 160 {
        return false;
    }
    const MARKERS: [&str; 7] = [
        "</parameter>",
        ":parameter>",
        "</tool_call>",
        "<tool_call>",
        "<function_calls>",
        "<|",
        "antml:",
    ];
    MARKERS.iter().any(|m| t.contains(m))
}

/// How much of a previous attempt's progress is carried into the next model.
/// Enough to continue a browser/research run without re-sending the whole
/// transcript; a `load_plugin` toolbox keeps its full body because re-loading
/// it costs the same round-trip and the same ~9K chars again.
const SUBAGENT_CONTINUATION_MAX_CHARS: usize = 12_000;
const SUBAGENT_PROGRESS_ENTRY_CHARS: usize = 600;
const SUBAGENT_TOOLBOX_ENTRY_CHARS: usize = 9_000;
const SUBAGENT_PROGRESS_ENTRIES: usize = 40;

/// A compact one-line description of a tool call's arguments, for the
/// continuation block. It deliberately names the fields that matter to a
/// browser/research task and drops the rest: the point is "what did the
/// previous attempt already do", not a full replay of every argument.
pub(super) fn progress_args(args: &Value) -> String {
    const KEYS: [&str; 14] = [
        "url",
        "selector",
        "ref",
        "text",
        "path",
        "command",
        "query",
        "description",
        "slug",
        "skill",
        "expression",
        "pattern",
        "action",
        "paths",
    ];
    let mut out = String::new();
    for key in KEYS {
        let Some(value) = args.get(key) else { continue };
        let text = match value {
            Value::String(s) => s.trim().to_string(),
            Value::Null => continue,
            other => other.to_string(),
        };
        if text.is_empty() {
            continue;
        }
        let text: String = text.chars().take(180).collect();
        out.push_str(&format!("{key}={text:?} "));
    }
    out.trim().to_string()
}

fn clip_chars(text: &str, cap: usize) -> String {
    let mut out: String = text.chars().take(cap).collect();
    if out.chars().count() < text.chars().count() {
        out.push('…');
    }
    out
}

/// Keep the continuation window bounded: newest entries win, and a single
/// `load_plugin` body gets a much larger budget than a normal tool result.
pub(super) fn trim_progress(progress: &mut Vec<String>) {
    if progress.len() > SUBAGENT_PROGRESS_ENTRIES {
        let drop = progress.len() - SUBAGENT_PROGRESS_ENTRIES;
        progress.drain(0..drop);
    }
    let mut total: usize = progress.iter().map(|line| line.chars().count() + 1).sum();
    while total > SUBAGENT_CONTINUATION_MAX_CHARS && progress.len() > 1 {
        let removed = progress.remove(0);
        total = total.saturating_sub(removed.chars().count() + 1);
    }
    if total > SUBAGENT_CONTINUATION_MAX_CHARS {
        if let Some(last) = progress.last_mut() {
            // Leave room for the ellipsis `clip_chars` appends, so the joined
            // block never exceeds the budget by one char.
            *last = clip_chars(last, SUBAGENT_CONTINUATION_MAX_CHARS.saturating_sub(1));
        }
    }
}

/// The prompt prefix for a retried attempt that already did real work.
///
/// A sub-agent runs its own loop, so restarting it from scratch after a provider
/// hiccup repeats every side effect: traced live, a browser attempt published an
/// Instagram post, hung on the verification step, and the next model was handed
/// the original prompt — so it opened the composer and tried to publish again.
/// The block below is the generic fix: keep the task, carry the completed steps,
/// and make "verify before repeating an irreversible action" explicit.
pub(super) fn continuation_block(progress: &[String]) -> String {
    if progress.is_empty() {
        return String::new();
    }
    format!(
        "\n\n=== CONTINUATION — A PREVIOUS ATTEMPT WAS CUT OFF (NOT A NEW REQUEST) ===\n\
The task above is unchanged. A previous attempt made the progress below, then stopped \
(provider error or hang). Continue from that point instead of starting over.\n\
- Do NOT repeat an action that already completed.\n\
- The progress log is EVIDENCE, not live session state: a toolbox/connector listed as loaded \
may need `load_plugin` once in THIS attempt before its tools are callable (re-loading a toolbox \
is safe and is NOT an irreversible action).\n\
- Before repeating an IRREVERSIBLE action (publish, send, upload, delete, pay), VERIFY the \
resulting state and whether it already happened.\n\
- If the previous attempt stopped while a tool was running, that tool MAY have completed — \
check the page/state before calling it again.\n\
- If the work is already done, report the evidence (counts, URLs, text) and finish.\n\n\
PROGRESS FROM THE PREVIOUS ATTEMPT:\n{}\n=== END CONTINUATION ===",
        progress.join("\n")
    )
}

/// The tool result when the ladder gives up AFTER real work. `None` means the
/// attempt produced neither progress nor text, so the normal failure reason is
/// the whole truth.
///
/// This must never be "no findings": the parent decides its next step from this
/// result, and an empty answer invites it to repeat a side effect the child
/// already performed (the traced duplicate Instagram publish).
pub(super) fn partial_subagent_report(
    progress: &[String],
    best_partial: &str,
    reason: &str,
) -> Option<String> {
    if progress.is_empty() && best_partial.trim().is_empty() {
        return None;
    }
    let mut partial = String::from(
        "SUB-AGENT STOPPED BEFORE FINISHING. Do not treat this as \"nothing happened\": \
         the attempt below performed real work before it failed. Use the evidence, and \
         VERIFY the current state before repeating any action — especially anything \
         irreversible (publish, send, upload, delete).\n",
    );
    if !progress.is_empty() {
        partial.push_str("\nPROGRESS THAT ALREADY HAPPENED:\n");
        partial.push_str(&progress.join("\n"));
    }
    if !best_partial.trim().is_empty() {
        partial.push_str("\n\nLAST MODEL OUTPUT BEFORE THE FAILURE:\n");
        partial.push_str(best_partial.trim());
    }
    partial.push_str("\n\nSTOP REASON: ");
    partial.push_str(reason);
    Some(partial)
}

/// A clean attempt that performed real tool work but wrote no closing text.
///
/// The report buffer is cleared by every tool start, so a model that ends right
/// after a tool call leaves it empty. Retrying such an attempt is how a finished
/// publish got attempted a second time; the evidence below is a usable result,
/// so the ladder hands it to the parent instead of replaying the job.
pub(super) fn finished_with_evidence_but_no_report(
    res: &Result<(), String>,
    sub_error: &str,
    report: &str,
    entries: &[String],
) -> bool {
    res.is_ok() && sub_error.trim().is_empty() && report.trim().is_empty() && !entries.is_empty()
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
pub(super) const READONLY_NATIVE_TOOLS: [&str; 12] = [
    "read",
    "grep",
    "glob",
    "find_symbol",
    "current_time",
    "system_stats",
    "search_memory",
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
///
/// Uses the SAME slug as `plugins::find_agent` resolution — a profile named
/// "Code Reviewer" is advertised as `agent__code_reviewer` and found again from
/// that exact key, instead of silently falling back to the builtin explore run.
pub(super) fn delegation_tool_name(profile: &str) -> String {
    format!(
        "{DELEGATION_PREFIX}{}",
        crate::subagents::agent_slug(profile)
    )
}

/// True for any tool that runs a sub-agent: the builtin `explore`, or a plugin
/// profile advertised under [`DELEGATION_PREFIX`].
pub(super) fn is_delegation(name: &str) -> bool {
    name == "explore" || name.starts_with(DELEGATION_PREFIX)
}

/// Resolve the profile behind one delegation tool. The user's own Settings row
/// wins a name collision with a plugin profile, matching both the advertised
/// description and the dispatcher below.
pub(super) fn resolve_delegation_profile(parent: &AgentRequest, tool: &str) -> Option<Value> {
    if tool == "explore" {
        return None;
    }
    let key = tool.strip_prefix(DELEGATION_PREFIX).unwrap_or(tool).trim();
    parent
        .custom_subagents
        .iter()
        // The tool name carries the SLUG of the row id (`delegation_tool_name`),
        // so a row whose stored id is not already slug-safe (hand-edited
        // settings, an import) must still be found by its slug — an exact-id
        // match alone silently ran such an agent as the builtin `explore`.
        .find(|row| {
            let id = row["id"].as_str().map(str::trim).unwrap_or_default();
            id == key || (!id.is_empty() && crate::subagents::agent_slug(id) == key)
        })
        .cloned()
        .or_else(|| {
            crate::plugins::find_plugin_agent(std::path::Path::new(&parent.data_root), key)
        })
}

/// The capability a profile runs as. An explicit `kind` (Settings rows) wins;
/// otherwise the declared TOOLS decide, the same rule Settings applies on save:
/// `computer` → desktop, any `browser_*` → browser, everything else research.
/// A plugin profile has no kind field, so its declared tools are the only
/// signal it has — without this a bundle agent that ships `browser_*` tools
/// silently ran as a research agent and never received them.
pub(super) fn profile_kind(profile: Option<&Value>) -> String {
    let Some(row) = profile else {
        return "research".to_string();
    };
    if let Some(kind) = row["kind"]
        .as_str()
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
    {
        return kind.to_ascii_lowercase();
    }
    let tools: Vec<String> = row["tools"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|tool| tool.trim().to_ascii_lowercase().replace([' ', '-'], "_"))
                .collect()
        })
        .unwrap_or_default();
    if tools.iter().any(|tool| tool == "computer") {
        "computer".to_string()
    } else if tools.iter().any(|tool| tool.starts_with("browser_")) {
        "browser".to_string()
    } else {
        "research".to_string()
    }
}

/// Capability of the agent a delegation tool starts, used to schedule the step:
/// browser/desktop agents share one page/desktop and must run serially, while
/// independent research agents can run together.
pub(super) fn delegation_kind(parent: &AgentRequest, tool: &str) -> String {
    let profile = resolve_delegation_profile(parent, tool);
    profile_kind(profile.as_ref())
}

/// Human name of a delegation tool, for the chat's Working pill and cards.
///
/// The model calls `agent__<id>`; the user should see the profile's own name
/// ("Browser Navigator"), never the raw tool id. A custom row wins, then a
/// bundle profile, then a readable form of the id. `explore` stays "Explore".
pub(super) fn delegation_display_name(parent: &AgentRequest, tool: &str) -> String {
    if tool == "explore" {
        return "Explore".to_string();
    }
    let key = tool.strip_prefix(DELEGATION_PREFIX).unwrap_or(tool).trim();
    if let Some(name) = resolve_delegation_profile(parent, tool)
        .and_then(|row| row["name"].as_str().map(str::to_string))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
    {
        return name;
    }
    let pretty = key
        .split(['_', '-'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if pretty.is_empty() {
        "Sub-agent".to_string()
    } else {
        pretty
    }
}

/// True when this call can WRITE to the workspace — the only thing that makes a
/// cached read body stale.
///
/// MEASURED on the live corpus: the old blanket rule (`!is_readonly(name)`) wiped
/// the whole lookup cache 247 times, and 60 of those wipes came from calls that
/// cannot put a byte in a workspace file — `explore`(27), `web_search`(11),
/// `system_stats`(7), `fetch_url`(5), `save_memory`(4), `ask_user`(3),
/// `load_plugin`(2), `confirm_action`(1) — plus every read-only `run_terminal`
/// (`ls`, `git status`, builds) on top. Each wipe threw away the read coverage
/// recorded one call earlier, which is why the coverage guard fired 6 times in a
/// corpus that re-asked 137 already-served windows.
/// One batch op that writes the workspace (see [`mutates_workspace`]).
///
/// The name is resolved through the executor's alias table first: a `run_command`
/// op runs as `run_terminal`, so matching the raw name would let a writing shell
/// command keep a stale file body alive.
fn batch_writes(op: &Value) -> bool {
    let raw = op["tool"].as_str().unwrap_or_default().trim().to_ascii_lowercase();
    let tool = crate::tools::batch_tool_name(&raw).unwrap_or(raw);
    matches!(tool.as_str(), "write_file" | "edit_file" | "run_terminal")
}

pub(super) fn mutates_workspace(name: &str, _args: &Value) -> bool {
    match name {
        "write_file" | "edit_file" | "artifact" => true,
        // A batch carries the step's writers too: one write/edit/terminal op
        // inside it invalidates the file-body cache exactly like the same
        // call on its own would (conservative — a terminal op is a writer).
        // Parsed through `tools::batch_ops` like the executor: a shape this
        // reader did not recognise (a stringified ops array) counted as ZERO
        // writers, i.e. a stale body could outlive a batch that rewrote it.
        // Unparseable is treated as a WRITER — the safe direction.
        name if crate::tools::is_batch_tool(name) => crate::tools::batch_ops(_args)
            .map(|ops| ops.iter().any(batch_writes))
            .unwrap_or(true),
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
        | "delete_memory" | "load_plugin" | "ask_user" | "confirm_action"
        | "request_permission" | "current_time" | "system_stats" => false,
        // Everything else (plugin authoring, schedule, the
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

/// The files a WRITER call targets, as the model spelled them.
///
/// A batch may name its file ONLY per entry and leave the top level `path`
/// absent: `edit_file` uses `edits: [{path, …}]`, `write_file` uses
/// `files: [{path, content}]` — both advertised by the schema. Reading just
/// `path`/`filePath` then answered `None`, so the pre-edit snapshot and the
/// post-edit diff were both taken from an EMPTY path — which resolves to the
/// workspace ROOT, fails to read as text, and yields `""` on both sides. The
/// unified diff came out empty, no `diff` event reached the UI, and the card
/// showed no filename and no diff while the model got no `applied change`
/// block at all (traced: every `edits[]`- and `files[]`-shaped write).
///
/// ALL entry paths are collected (first-appearance order, deduplicated): a
/// batch legitimately names DIFFERENT files per entry, and a snapshot/diff
/// for only the first entry left every later file of the same call with no
/// diff event, no Review row and no `applied change` for the model.
pub(super) fn writer_target_paths(name: &str, args: &Value) -> Vec<String> {
    if !matches!(name, "edit_file" | "write_file") {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: Option<&str>| {
        if let Some(p) = p.filter(|p| !p.trim().is_empty()) {
            if !out.iter().any(|s| s == p) {
                out.push(p.to_string());
            }
        }
    };
    push(args["path"]
        .as_str()
        .or_else(|| args["filePath"].as_str()));
    // The schema's batch shapes: one path per entry either way. A top-level
    // `path` plus per-entry paths is also legal (edit_file inherits the top
    // level for entries without one) — the tool applies each entry to its own
    // file, so every named file belongs in the snapshot.
    for key in ["edits", "files"] {
        if let Some(items) = args[key].as_array() {
            for e in items {
                push(e["path"].as_str());
            }
        }
    }
    out
}

/// The FIRST file a writer call targets — enough for callers that only need
/// "some" target (the stale-source note), not the full per-file set.
pub(super) fn writer_target_path(name: &str, args: &Value) -> Option<String> {
    writer_target_paths(name, args).into_iter().next()
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
        name if crate::tools::is_batch_tool(name) => {
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
        // One loaded toolbox / skill body is enough for a turn. The key lives
        // in the SAME guard the fold consults, so when a fold elides the text
        // the key is forgotten and the model may re-read it.
        "load_plugin" => {
            let slug = s("slug");
            let skill = s("skill");
            let file = s("file");
            if !slug.is_empty() {
                Some(format!("load_plugin|{slug}|{skill}|{file}"))
            } else if !skill.is_empty() {
                Some(format!("load_plugin|skill|{skill}|{file}"))
            } else {
                // A `query` search is cheap and its result may change with the
                // store; no repeat-guard.
                None
            }
        }
        // The SAME research question must never run twice in one turn: a second
        // delegation costs a whole sub-agent (many rounds × SUBAGENT_MAX_ATTEMPTS
        // attempts), while the first report is already in the context above.
        // Keyed on the normalized PROMPT (the description is only a UI label, so
        // it must not split one identical question into two keys). Whitespace
        // and case are normalized so a re-worded-but-identical prompt is caught
        // too. The TOOL name stays in the key: two different agents may
        // legitimately answer the same question, and the builtin `explore` key
        // keeps its historical form.
        _ if is_delegation(name) => {
            let prompt = s("prompt");
            let norm = prompt
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if norm.is_empty() {
                return None;
            }
            Some(format!("{name}|{norm}"))
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

/// Whether a WHOLE round only locates or reads — the unit the discovery streak
/// counts.
///
/// A round whose single call is `batch_search` must be judged by the OPS it
/// carries, never by the wrapper: `batch_search` is not a lookup name itself, so
/// the raw-name test failed it and RESET the streak on every batched round.
///
/// Traced (`mwbn4lhu`, 60 rounds): the counter reported a longest streak of 1
/// while the real run held 21 consecutive search rounds — 39 rounds sat at
/// streak >= 3 and 27 at >= 7, exactly the waste the `explore` nudge exists to
/// stop, and it fired ZERO times. `expand_batch` is the same look-through the two
/// batching levers already do, so all three levers now measure one thing.
pub(super) fn round_is_discovery(calls: &[(String, String, String)]) -> bool {
    if calls.is_empty() {
        return false;
    }
    match expand_batch(calls) {
        Some(ops) => ops.iter().all(|(_, n, _)| is_discovery_tool(n)),
        None => {
            // A lone `batch_search` whose ops cannot be read is still a SEARCH
            // round — the composer never writes (writers are refused inside it).
            // Counting it as work would let malformed JSON hide a long streak,
            // which is the same blind spot this function was written to close.
            if calls.len() == 1 && crate::tools::is_batch_tool(&calls[0].1) {
                return true;
            }
            calls.iter().all(|(_, n, _)| is_discovery_tool(n))
        }
    }
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
    round_hint_with(&BatchCapability::FULL, mode, calls, streak, lone_rounds, root)
}

pub(super) fn round_hint_with(
    caps: &BatchCapability,
    mode: &str,
    calls: &[(String, String, String)],
    streak: usize,
    lone_rounds: usize,
    root: &str,
) -> Option<Cow<'static, str>> {
    discovery_streak_hint(mode, streak)
        .map(Cow::Borrowed)
        .or_else(|| single_call_hint_with(caps, mode, calls, lone_rounds, root))
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

/// Expand a lone `batch` call into the ops it actually carries.
///
/// `batch` is the tool the model actually prefers — traced (`mwab8nku`): 125 of
/// 125 tool rows were `batch`, averaging 2.4 ops. Both levers keyed on the CALL
/// name and `batch` is in neither whitelist, so `single_call_hint` and
/// `single_call_is_serial` returned early on EVERY one of those rounds: the
/// lever fired 0 times in 129 rounds while 121 of them were "lone" by call
/// count. Looking THROUGH the wrapper is the fix, and it is the honest measure:
/// a batch carrying ONE op really is a lone call, while a batch carrying several
/// is already the batching the hint would have asked for.
///
/// Op names are resolved through the same alias table the executor uses, so a
/// `run_command` op is judged as `run_terminal` (see `canonical_tool_name`).
fn expand_batch(calls: &[(String, String, String)]) -> Option<Vec<(String, String, String)>> {
    if calls.len() != 1 || !crate::tools::is_batch_tool(&calls[0].1) {
        return None;
    }
    let args: Value = serde_json::from_str(&calls[0].2).ok()?;
    // `crate::tools::batch_ops` and NOT a bare `args["ops"].as_array()`: the
    // executor accepts a stringified ops array, so a parser that only knew the
    // array form made a real multi-op round look like a zero-op one — the
    // batching levers then stayed silent on exactly the rounds that DID batch.
    let ops = crate::tools::batch_ops(&args).ok()?;
    let advertised: Vec<String> = crate::tools::BATCH_TOOLS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    Some(
        ops.iter()
            .map(|op| {
                let raw = op["tool"].as_str().unwrap_or_default().trim();
                let name = canonical_tool_name(raw, &advertised)
                    .unwrap_or_else(|| raw.to_string());
                (String::new(), name, op["args"].to_string())
            })
            .collect(),
    )
}

/// What a turn ACTUALLY has bound.
///
/// Both batching levers are only obeyable when the tool they NAME exists: the
/// `batch` wrapper for "one call carries the whole step", and a lookup family
/// for "issue the lookups together". A `browser`/`computer` child has no file
/// search, and a custom profile is narrowed by its own declaration
/// (`retain_subagent_tools` drops `batch` when the list does not name it), so a
/// hard-coded hint names a tool the child cannot call — the traced model then
/// answers by calling the missing name and loses the round to the refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct BatchCapability {
    /// The batch composer is advertised this turn.
    pub has_batch: bool,
    /// At least one read/search lookup is advertised this turn.
    pub has_lookup: bool,
    /// At least one of `write_file`/`edit_file` is advertised this turn. A child
    /// with no writer must never be handed the per-family WRITE wording: it would
    /// name a tool the child cannot call, and the traced model answers by calling
    /// the missing name and losing the round to the refusal.
    pub has_writer: bool,
}

impl BatchCapability {
    /// The full set (the main agent, and what the plain entry points assume).
    pub(super) const FULL: Self = Self {
        has_batch: true,
        has_lookup: true,
        has_writer: true,
    };

    /// Derive the capability from the exact tool names this run advertised — the
    /// same list the error path uses, so the hint can never drift from the
    /// schema table the model was actually given.
    pub(super) fn from_advertised(advertised: &[String]) -> Self {
        // `run_terminal` is deliberately NOT a lookup here: a computer child is
        // granted it (it needs the CLI for the work the desktop is bad at), and
        // counting it would hand that child the "issue your greps and finds
        // together" wording it cannot obey. A read-only shell round keeps its
        // own branch in `single_call_hint`.
        let has_lookup = advertised.iter().any(|a| {
            matches!(
                a.as_str(),
                "read"
                    | "grep"
                    | "glob"
                    | "find_symbol"
                    | "lsp_symbols"
                    | "lsp_definition"
                    | "lsp_references"
                    | "lsp_hover"
                    | "lsp_diagnostics"
                    | "fetch_url"
            )
        });
        Self {
            has_batch: advertised
                .iter()
                .any(|a| crate::tools::is_batch_tool(a)),
            has_lookup,
            has_writer: advertised
                .iter()
                .any(|a| matches!(a.as_str(), "write_file" | "edit_file")),
        }
    }
}

pub(super) fn single_call_hint(
    mode: &str,
    calls: &[(String, String, String)],
    lone_rounds: usize,
    root: &str,
) -> Option<Cow<'static, str>> {
    single_call_hint_with(&BatchCapability::FULL, mode, calls, lone_rounds, root)
}

/// [`single_call_hint`], but only advising what this turn can actually do.
pub(super) fn single_call_hint_with(
    caps: &BatchCapability,
    mode: &str,
    calls: &[(String, String, String)],
    lone_rounds: usize,
    root: &str,
) -> Option<Cow<'static, str>> {
    // Measure a lone `batch` by the ops it carries, not by the wrapper.
    let expanded = expand_batch(calls);
    let calls = expanded.as_deref().unwrap_or(calls);
    if calls.len() != 1 {
        return None;
    }
    if mode == "subagent" {
        let name = calls[0].1.as_str();
        // Browser/desktop calls are SERIAL: every action returns the page or
        // screen it produced, so "batch the next calls" is impossible advice.
        // The waste in a traced browser run was different: it re-snapshotted
        // after every navigate (the navigate result already carried the page),
        // then burned the budget probing the same post with `browser_evaluate`
        // long after the caption was in the result above. Point at the data
        // instead of at batching.
        if name.starts_with("browser_") {
            if name == "browser_evaluate" {
                return Some(Cow::Borrowed(
                    "[hint] If this evaluate returned null/[] or a value you already had, do NOT repeat the probe: the page text above is the source. Use browser_find, or report that the page does not expose what was asked for.",
                ));
            }
            if lone_rounds <= 1 {
                return Some(Cow::Borrowed(
                    "[hint] The result above already carries the page summary and fresh refs — read it before calling anything else; do NOT re-snapshot the same page. For a list or grid, collect the item hrefs with ONE browser_evaluate, then navigate to the exact URLs you still need instead of clicking tiles one by one.",
                ));
            }
            return Some(Cow::Borrowed(
                "[hint] Several lone browser calls in a row: stop re-reading the same page. Take the text from the result you already have, open only the URLs still missing by direct navigation, and after two empty evaluates stop probing and report what the page exposes.",
            ));
        }
        if name == "computer" {
            return Some(Cow::Borrowed(
                "[hint] Desktop actions are serial: act on the screen you already have, and do not screenshot again immediately after an action that returned the new screen. Finish the smallest sequence, then report.",
            ));
        }
        // A child binds whatever its kind and its own declaration allow, so the
        // wording names only what it really has. Naming `grep`/`find_symbol` to
        // a browser child (or to a profile narrowed to `read`) is an instruction
        // it cannot obey.
        if caps.has_batch && caps.has_lookup {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together (other greps, find_symbol, lsp_symbols, reads of the exact windows), then write the report.",
            ));
        }
        if matches!(name, "edit_file" | "write_file" | "artifact") {
            // A WRITE is never a batch op, so it must be answered BEFORE the
            // generic `has_batch` wording below — otherwise a child that owns
            // `batch_search` is told to put its writer inside it, which is
            // exactly what the executor refuses (no snapshot, no permit, no
            // diff). The per-family shape is the fix and costs the same round.
            // A child with NO writer at all gets no wording naming one.
            if !caps.has_writer {
                return None;
            }
            return Some(Cow::Owned(single_call_hint_text(lone_rounds, false)));
        }
        if caps.has_batch {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call. Every step costs a model round trip, so put the whole SEARCH phase in ONE `batch_search` call as ops:[{tool, args},…] — every lookup you can already foresee, in order — and keep the report for the step after. Writes never ride it.",
            ));
        }
        if caps.has_lookup {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together, then write the report.",
            ));
        }
        // Neither a batch wrapper nor a combinable lookup: this child's calls are
        // a serial driver chain, so there is nothing to merge and silence is the
        // only honest answer.
        return None;
    }
    let name = calls[0].1.as_str();
    if is_delegation(name) {
        return Some(Cow::Borrowed(
            "[hint] That step had ONE sub-agent. Independent sub-agents called in the SAME step run CONCURRENTLY and cost a single round-trip: when the request genuinely splits into independent pieces that need different agents, fire them together. Never call two agents for the same piece, and browser/desktop agents still run one at a time over their shared page/desktop.",
        ));
    }
    // Read-only natives are the ONE group that really does run concurrently, so
    // they get the parallelism wording instead of the ordering one. In the last
    // traced corpus 6 lone `read`, 1 lone `fetch_url` (65_694 uncached tokens on
    // its own) and 1 lone `load_plugin` round sat outside the whitelist, i.e. the
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
    // `run_terminal` is back in the lever, worded for INDEPENDENT commands.
    // It used to be gated on a read-only command, which excluded the largest
    // traced group: a lone `cargo test`/build round is independent of the `git
    // status` that follows it, yet neither is a pure read, so the hint stayed
    // silent on 30 of 131 rounds in trace `mvxsy14e`. The exclusion argument
    // ("every shell round is a probe chain") only holds when a command's
    // ARGUMENTS come from the previous result — build → test — and the model is
    // the only one who knows that. So the lever speaks on every lone shell round
    // and names the boundary itself, instead of guessing it from the command.
    if name == "run_terminal" {
        if shell_read_is_batchable(&calls[0].2, root) {
            if lone_rounds <= 1 {
                return Some(Cow::Borrowed(
                    "[hint] That step had ONE call. This command only READS, so it runs in the SAME concurrent batch as other lookups — and every step re-sends the whole conversation. Put the remaining commands you already know you need into ONE run_terminal call via commands=[\"cmd1\",\"cmd2\",…] (they run in order, one result block each), next to the reads and greps of the same step.",
                ));
            }
            return Some(Cow::Owned(format!(
                "[hint] {lone_rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation. Batch NOW: one run_terminal call with commands=[…] runs every inspection IN ORDER in this one call (one result block each); reads and greps ride the SAME step."
            )));
        }
        if lone_rounds <= 1 {
            return Some(Cow::Borrowed(
                "[hint] That step had ONE call, and every step re-sends the whole conversation. A command that does NOT need the previous result belongs in the SAME call as the others: one run_terminal takes several INDEPENDENT commands as commands:[\"cmd1\",\"cmd2\"] (in order, one result block each). Keep a command on its own only when its arguments come from the last result — build → test, then a probe over what it printed.",
            ));
        }
        return Some(Cow::Owned(format!(
            "[hint] {lone_rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation. Batch NOW: one run_terminal call with commands=[…] runs every INDEPENDENT command IN ORDER in this one call (one result block each). Only a command whose arguments come from the previous result — build → test, then a probe over its output — keeps a step of its own."
        )));
    }
    if matches!(name, "edit_file" | "write_file" | "artifact") {
        // A WRITE is never a batch op, so this branch must never send it into
        // `batch_search`: the loop only snapshots the file, asks for an
        // out-of-workspace permit and emits a diff when the call's OWN name is a
        // writer. The per-family shape is the fix, and it costs the same round.
        return Some(Cow::Owned(single_call_hint_text(lone_rounds, false)));
    }
    None
}

/// True when this round spent its whole round-trip on ONE call whose siblings
/// were already knowable. Main agent only: the sub-agent has its own wording.
///
/// Two families count, because BOTH are rounds the model could have merged:
///   - a file write (`edit_file` / `write_file` / `artifact`) — a whole family
///     fits ONE call as `files:[…]` / `edits:[…]`, so a lone one is a wasted
///     round even though the write itself never rides `batch`;
///   - a read-only native lookup (`read`, `grep`, `glob`, `find_symbol`, the five
///     `lsp_*` lookups, `fetch_url`) — these run CONCURRENTLY, so a
///     lone one is the most common wasted round (measured: 54 of 65 rounds in
///     trace `mvy0ausq`, 91% of that turn's wire tokens).
///
/// Deliberately EXCLUDED: a lone `run_terminal` or browser act-then-observe
/// call is a probe CHAIN whose arguments come from the previous result — there
/// is nothing to batch, so counting it would grow the streak while the hint
/// stays silent and the field would report waste that was never addressable.
pub(super) fn single_call_is_serial(mode: &str, calls: &[(String, String, String)], root: &str) -> bool {
    let _ = mode;
    single_call_is_serial_with(&BatchCapability::FULL, calls, root)
}

/// [`single_call_is_serial`], capability-gated.
///
/// The blanket `mode == "subagent" => false` guard is GONE: it meant a custom
/// profile granted `batch` + lookups never grew the streak, so the escalating
/// lever could not fire on the one child shape it was written for. Nothing
/// unsafe rides on that: the whitelist below names only MERGEABLE shapes, and a
/// driver call (`browser_*`, `computer`) is not in it, so a serial child still
/// never grows the counter — and a turn with neither `batch` nor a lookup has
/// nothing to merge at all.
pub(super) fn single_call_is_serial_with(
    caps: &BatchCapability,
    calls: &[(String, String, String)],
    root: &str,
) -> bool {
    if !caps.has_batch && !caps.has_lookup {
        return false;
    }
    // Same look-through as `single_call_hint`: a one-op `batch` is a lone call.
    let expanded = expand_batch(calls);
    let calls = expanded.as_deref().unwrap_or(calls);
    if calls.len() != 1 {
        return false;
    }
    // A lone shell round grows the streak whatever it does: the hint now asks
    // only for commands that do not need each other's output, so it can speak on
    // a build/test round too. Whether the command is a pure READ still decides
    // the WORDING (a read rides the concurrent lookup phase), never whether the
    // lever fires.
    if calls[0].1 == "run_terminal" {
        let _ = root;
        return true;
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
/// actually possible — the read-only lookups — and leaves the shell loop alone.
///
/// A WRITE is never sent into `batch`: the loop only snapshots the file, asks
/// for an out-of-workspace permit and emits a diff when the call's OWN name is a
/// writer, so a nested one would land silently. The per-family shape carries a
/// whole family in one call instead, which costs the same round.
pub(super) fn single_call_hint_text(rounds: usize, has_batch: bool) -> String {
    if rounds <= 1 {
        return if has_batch {
            SINGLE_CALL_HINT.to_string()
        } else {
            SINGLE_CALL_HINT_ONLY_FAMILIES.to_string()
        };
    }
    if !has_batch {
        return format!(
            "[hint] {rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation. Merge them per family: several files fit ONE write_file as files:[{{path, content}}], several independent replacements ONE edit_file as edits:[{{path, old_string, new_string, replace_all}}]."
        );
    }
    format!(
        "[hint] {rounds} rounds in a row have now delivered ONE call each, and every round re-sends the whole conversation (tens of thousands of tokens per round on a long chat). Batch NOW: `batch_search` runs every LOOKUP of your step (reads, greps, finds, lsp, read-only shell commands) IN ORDER in ONE call as ops:[{{tool, args}},…]. Writes stay OUT of it — they take their whole family in ONE call of their own: files:[{{path, content}}] on write_file, edits:[…] on edit_file — so the diff, the Review row and the out-of-workspace permit still happen."
    )
}

/// The teaching form, delivered once at the start of a streak.
pub(super) const SINGLE_CALL_HINT: &str = "[hint] That step had ONE call. Every step re-sends the whole conversation, so a whole SEARCH phase belongs in ONE call: `batch_search` runs up to 10 lookups (reads, greps, finds, lsp, read-only shell commands) IN ORDER in one round-trip as ops:[{tool, args},…]. Writes are NOT batch ops — they take their whole family in one call of their own: several files ONE write_file as files:[{path, content}], several replacements ONE edit_file as edits:[{path, old_string, new_string, replace_all}], several shell commands ONE run_terminal as commands:[\"…\"].";

/// The same teaching for a turn that has NO `batch` bound: only the per-family
/// shapes remain, because naming a wrapper the model cannot call costs a round.
pub(super) const SINGLE_CALL_HINT_ONLY_FAMILIES: &str = "[hint] That step had ONE call. Every step re-sends the whole conversation, so merge what you can into ONE call: several files fit ONE write_file as files:[{path, content}], several independent replacements ONE edit_file as edits:[{path, old_string, new_string, replace_all}], and several shell commands ONE run_terminal as commands:[\"…\"].";

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
    "=== REMINDER: load a matching plugin first (NOT a new request) ===";

/// Opening line of the trailing plugin-context message (a hook's SessionStart
/// output: the guidance a bundle wants present for the whole conversation).
pub(super) const PLUGIN_CONTEXT_HEAD: &str =
    "=== CONTEXT: from an installed plugin (NOT a new request) ===";

/// Opening line of the trailing ACTIVE PLUGIN message: the plugin the user
/// attached (`/slug`) is already loaded as one toolbox.
pub(super) const ACTIVE_PLUGIN_CONTEXT_HEAD: &str =
    "=== CONTEXT: active plugin, already loaded as one unit (NOT a new request) ===";

/// Opening line of the trailing Plan-Execute protocol message: the model's
/// FIRST tool-carrying reply of the turn must be ONE `batch` with the whole
/// step. This is the model-INDEPENDENT round-trip lever — the reply SHAPE is
/// dictated by the loop, not requested from the model.
pub(super) const BATCH_PROTOCOL_HEAD: &str =
    "=== PROTOCOL: your first tool reply is ONE batch_search with the whole search phase (NOT a new request) ===";

/// True for a message that exists ONLY on the wire (the renderer never stores
/// it): the trailing plan/checklist context, the skills reminder, the plugin
/// context and the step protocol. All are pushed after the user prompt to stay
/// off the cached prefix, so the fold count must ignore all of them.
pub(super) fn is_wire_only_context(content: &str) -> bool {
    content.starts_with(PLAN_CONTEXT_HEAD)
        || content.starts_with(SKILLS_CONTEXT_HEAD)
        || content.starts_with(crate::skill_router::AUTO_MATCH_HEAD)
        || content.starts_with(PLUGIN_CONTEXT_HEAD)
        || content.starts_with(ACTIVE_PLUGIN_CONTEXT_HEAD)
        || content.starts_with(BATCH_PROTOCOL_HEAD)
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

pub(super) fn active_plugin_context_message(section: &str) -> Option<Value> {
    trailing_context_message(ACTIVE_PLUGIN_CONTEXT_HEAD, section)
}

/// The per-turn plugin reminder, pushed at the TAIL of the request.
///
/// The catalog cannot move out of the system prompt without re-billing the whole
/// cached prefix, and it is not the catalog the model is missing — it is the
/// DUTY. Restating it immediately under the request is what makes a weak model
/// act. The text is constant for a given turn so it churns nothing it sits next
/// to. It never names a plugin from the wording of the request: picking one is
/// the model's call, made from the catalog.
///
/// `attached` and `plugins` are what the user already attached. Naming them
/// explicitly is the fix for the traced bug where the reminder told the model to
/// call `load_plugin` for a plugin the `/plugin` command had ALREADY inlined — the
/// model obeyed the tail and spent a round on a redundant load.
pub(super) fn skills_context_message(attached: &[String], plugins: &[String]) -> Value {
    let already = if !plugins.is_empty() {
        format!(
            "The plugin(s) {} are ALREADY attached as one toolbox: their skills are available \
             now (inlined, or indexed by path in a large bundle) and their connector tools are \
             switched on. Do NOT call `load_plugin` for them again unless you need to re-read \
             one body. ",
            plugins.join(", ")
        )
    } else if !attached.is_empty() {
        format!(
            "These skills are ATTACHED to this turn and MANDATORY: follow each one's steps and \
             run the verification it requires before reporting done — do NOT substitute your \
             own approach: {}. Their bodies are already in your system prompt, so do NOT call \
             `load_plugin` for them. ",
            attached.join(", ")
        )
    } else {
        String::new()
    };
    json!({
        "role": "user",
        "content": format!(
            "{SKILLS_CONTEXT_HEAD}\n\
             {already}The `=== AVAILABLE PLUGINS ===` catalog is in your system prompt. The user \
             does NOT have to @mention a skill: finding the plugin that carries it is YOUR \
             responsibility. Before your first tool call of this turn, check it: if the request \
             falls under one of those plugins — match its description OR one of its skill names, \
             in any language — call `load_plugin` with that plugin's `slug` IN THE SAME STEP as \
             your other tool calls (never as a solo round). Add `skill=<name>` when you need ONE \
             skill body from it; load just the `slug` for the whole toolbox (every skill body \
             and every connector tool). Never load a bare skill name — always name the plugin \
             that owns it. If the catalog has no entry for the task, do not read that as \
             `nothing exists`: a large store cannot all fit there, so call `load_plugin` with a \
             `query` of the task's words and it searches every installed plugin AND skill, then \
             names the owning plugin. Do not answer from memory when a plugin covers the task, \
             and do not load one that does not apply.\n\
             --- end of reminder ---"
        ),
    })
}


/// The Plan-Execute protocol, pushed at the tail of the FIRST request.
///
/// The model-INDEPENDENT round-trip lever: a weak model answers with exactly
/// one tool call per reply (traced: nemotron 38/43 rounds solo) no matter how
/// many batching tools exist. Dictating the REPLY SHAPE closes that gap — the
/// first tool-carrying reply must be one `batch` carrying the whole step, the
/// loop executes all of it in one round-trip, and a dependent second wave goes
/// in the next reply. Replanning stays free (mission rule 6): an unexpected
/// result simply shapes the second wave.
///
/// Returns `None` when this turn has no `batch` bound: the directive would name
/// a tool the model cannot call, and the traced cost of that is a whole round
/// spent on the refusal. A child with `batch` but no lookup gets a shorter
/// directive that names only the families it really has.
pub(super) fn batch_protocol_message(caps: &BatchCapability) -> Option<Value> {
    if !caps.has_batch {
        return None;
    }
    let content = if caps.has_lookup {
        format!(
            "{BATCH_PROTOCOL_HEAD}\n\
             For this task, your FIRST reply that makes tool calls must be ONE `batch_search` \
             call carrying EVERY lookup you expect to need — grep/glob/read/\
             find_symbol/lsp_*, the files to open, the read-only commands to check — as \
             ops:[{{\"tool\":\"grep\",\"args\":{{...}}}},…] (max 10). Every result comes back \
             together in one round-trip; a dependent second wave (calls that needed a \
             result you just got) goes in your NEXT reply. A reply with a single \
             independent tool call wastes a whole round-trip — never send one. \
             `edit_file` and `write_file` are NOT batch ops: they carry their whole \
             family in ONE call of their own (files:[{{path, content}}], \
             edits:[{{path, old_string, new_string, replace_all}}]) so the diff, the \
             Review row and the out-of-workspace permit still happen. `load_plugin`, the \
             `browser_*` tools and MCP connector tools are NOT batchable either: they \
             change the tool set or act on one shared page in order, so call them \
             directly in your next reply."
        )
    } else {
        format!(
            "{BATCH_PROTOCOL_HEAD}\n\
             For this task, your FIRST reply that makes tool calls must be ONE `batch_search` \
             call carrying EVERY lookup you expect to need, as ops:[{{\"tool\":\"run_terminal\",\"args\":{{...}}}},…] \
             (max 10). Every result comes back together in one round-trip; a dependent \
             second wave goes in your NEXT reply. A reply with a single independent tool \
             call wastes a whole round-trip — never send one."
        )
    };
    Some(json!({ "role": "user", "content": content }))
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
5. The question is EXTERNAL — docs, a package, an API, or anything current — or the \
layout has nothing to search: use web_search. It already fetches the top results; \
use fetch_url only for one specific URL those results did not cover. Cite the URLs \
you used. Never answer external facts from memory, and never use the web as a \
substitute for reading the workspace when the question is about this codebase.\n\
6. If an lsp_* tool says the language server is unavailable, stop using LSP for \
that language and use grep + read.\n\
7. Before each step, for every call ask: which exact question does it answer, and \
what will I do differently depending on the result? Drop any call that cannot \
change your next action. Grep shows only a few lines around each hit — read the \
window you need, but never re-read what a result already showed and never repeat \
a search with the same pattern. Every workspace search goes through `grep`/\
`find_symbol`/`glob`/`lsp_*` — you have no shell, and a search written as a shell \
line is not yours to make. Web lookups go through `web_search`/`fetch_url`.\n\n\
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

/// Capabilities a sub-agent inherits from the turn that delegated to it.
///
/// The renderer usually sends the table, but a request without it (scheduler,
/// legacy client) still has a MODE, so the row is derived instead of falling
/// through to the permissive default in `caps_for_mode("subagent")`. That
/// fallback is what let a read-only Ask turn hand write access to a child.
pub(super) fn inherited_caps(parent: &AgentRequest) -> ToolCaps {
    parent
        .cap
        .clone()
        .unwrap_or_else(|| caps_for_mode(&parent.mode))
}

fn push_plugin_slug(out: &mut Vec<String>, raw: &str) {
    let slug = raw.trim();
    if !slug.is_empty() && !out.iter().any(|s| s == slug) {
        out.push(slug.to_string());
    }
}

/// Plugin slugs a sub-agent PROFILE carries.
///
/// A bundle agent ALWAYS carries its owning bundle (`plugin_slug` is stamped by
/// `find_plugin_agent`), because the pack's skills are what make it useful at
/// all; a legacy custom row may still carry checked bundles. These are INLINED
/// at startup — but they are no longer the only toolbox: every sub-agent has
/// `load_plugin` and the full plugin catalog, so it can load anything the user
/// installed on its own (Settings → Sub-agents no longer assigns plugins).
pub(super) fn attached_plugin_slugs(profile: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(profile) = profile else {
        return out;
    };
    if let Some(slug) = profile["plugin_slug"].as_str() {
        push_plugin_slug(&mut out, slug);
    }
    for slug in profile["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        push_plugin_slug(&mut out, slug);
    }
    out
}

/// Skills a sub-agent inherits from the parent turn.
///
/// The user's `@` attachment is a statement about the WHOLE task, not only the
/// main agent's half of it. A browser child does the actual page work on a
/// live-UI request, so dropping the attached harness here meant the parent was
/// told to follow Test UI while the delegation ran without it. Inherited skills
/// ride through the child's own router, which budgets/inlines them exactly like
/// a bundle's skills (and keeps the child's context bounded).
pub(super) fn inherited_skills(parent: &AgentRequest) -> Vec<String> {
    parent.skills.clone()
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
    // The task is fixed for the whole ladder; only the continuation prefix
    // below changes between attempts.
    let original_prompt = prompt.clone();
    // What the last attempt already did. On a retry this becomes part of the
    // child's task, so a provider hiccup can never replay a completed action
    // (the traced duplicate Instagram post). It is also the fallback report if
    // every model fails after real work: a parent must never receive "no
    // findings" when the child already changed the world.
    let mut progress: Vec<String> = Vec::new();
    let mut best_partial = String::new();
    // A sub-agent PROFILE supplies its own system prompt and narrows the tool
    // set. Two sources: a plugin bundle's `agents/*.md`, and a custom profile
    // from Settings → Sub-agents (settings.json). A bare `explore` keeps the
    // builtin research prompt. The MODEL is deliberately NOT taken from the
    // profile: every sub-agent — builtin, plugin or custom — runs on the
    // `explore` slot of Settings → Tools (labelled "Sub-agent"), so one row
    // controls what they all cost. A profile that names its own model is ignored.
    let profile = resolve_delegation_profile(parent, tool);
    // Which tool set this sub-agent gets. An explicit `kind` wins; a plugin
    // profile derives it from the tools it declared. The kind is the REQUEST,
    // not the grant: `allow_browser`/`allow_computer` below still require the
    // parent turn's own switch to be on.
    let kind = profile_kind(profile.as_ref());

    // Name this run for the user: the chat's Working pill and the sub-agent
    // card say WHO is working ("Browser Navigator"), not the raw `agent__id`
    // the model called. The pill is emitted below, before the first model
    // round, and the ladder's own retry lines keep naming it.
    let display_name = profile
        .as_ref()
        .and_then(|p| p["name"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| delegation_display_name(parent, tool));

    // DESKTOP GATE: a delegation to a `computer` profile is still desktop
    // control, and the composer switch alone does not approve it. Ask BEFORE
    // the child starts, and carry the model's OWN `reason` (the delegation
    // schema requires it) so the popup says why the desktop is needed. An
    // approved child then runs its whole task without re-prompting: its
    // `allow_computer` below is set, and `req.mode == "subagent"` skips the
    // per-action gate in `turn.rs`.
    if kind == "computer" && parent.allow_computer {
        let reason = args["reason"]
            .as_str()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| prompt.chars().take(300).collect());
        let action = if description.trim().is_empty() {
            format!("Use the desktop via {display_name}")
        } else {
            description.trim().to_string()
        };
        if !ask_desktop_access(
            emit,
            &parent.chat_id,
            cancel,
            &action,
            &reason,
            parent.headless,
        )
        .await
        {
            return (denied_desktop(&reason), false);
        }
    }

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
    // model name the rung. This is the ONE row per retry — run_turn's own
    // stream-failure row is skipped for sub-agent mode (see turn.rs), so the
    // panel shows a single line carrying the model, the reason and the
    // counters instead of two half-empty rows for the same failure.
    let trace = crate::trace::TraceStore::new(parent.chat_id.clone())
        .with_run(TURN_SEQ.fetch_add(1, Ordering::Relaxed));
    // Wall-clock (epoch ms) of the RUNNING attempt, refreshed at the top of
    // the loop and stamped onto every retry row: a 60s provider timeout reads
    // as `duration_ms: 60002` without opening the row. An atomic (not a Cell)
    // because the emit closure is cast to a Send sink inside run_turn.
    let attempt_started_ms = AtomicU64::new(0);
    let mut emit = |ev: &AgentEvent| match ev {
        ev @ (AgentEvent::Retry { attempt, max_attempts, reason, model, tool, provider_id, fallback, .. }
        | AgentEvent::RetryGiveup { attempt, max_attempts, reason, model, tool, provider_id, fallback, .. }) => {
            let giveup = matches!(ev, AgentEvent::RetryGiveup { .. });
            let reconnecting = matches!(ev, AgentEvent::Retry { reconnecting: true, .. });
            // The reason IS the failure (provider 429, hang, empty report …) —
            // it belongs in the row title, not buried behind the expander. A
            // manual "retrying now (requested)" is not a failure: leaving the
            // `error` unset keeps the red ERROR chip off that row.
            let informational = reason == "retrying now (requested)";
            trace.record(crate::trace::TraceEntry {
                kind: "retry".into(),
                summary: format!(
                    "attempt {attempt}/{max_attempts}{} — {}",
                    if giveup { " — gave up" } else { "" },
                    &reason.chars().take(160).collect::<String>()
                ),
                model: Some(model.clone()),
                error: (!informational).then(|| reason.clone()),
                detail: Some(json!({
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "tool": tool,
                    "provider_id": provider_id,
                    "reconnecting": reconnecting,
                    "fallback": fallback,
                    "giveup": giveup,
                    "duration_ms": (crate::state::now_ms() as u64)
                        .saturating_sub(attempt_started_ms.load(Ordering::Relaxed)),
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

    // The chore rides in the footer's Working pill. It must NAME the
    // sub-agent (user request: the chat says which sub-agent is working) and
    // may append the model's own short task label — the description alone
    // used to replace the name, so the pill never showed WHO was running.
    let status_label = {
        let desc = description.trim();
        if desc.is_empty() {
            display_name.clone()
        } else if desc.contains(display_name.as_str()) {
            desc.to_string()
        } else {
            format!("{display_name} — {desc}")
        }
    };
    emit(&AgentEvent::Status {
        stage: "subagent".into(),
        content: status_label,
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
    // Plugins this sub-agent carries. A bundle agent ALWAYS gets its own
    // bundle (the pack's skills are what make it useful at all), and a legacy
    // custom row may name additional bundles. These are inlined, but they are
    // not the only door: `load_plugin` + the catalog let the sub-agent load any
    // enabled toolbox on its own.
    let attached_plugins = attached_plugin_slugs(profile.as_ref());
    // Identity for skill matching. A bundle may carry a LIBRARY of skills (82
    // in the trading pack, ~820 KB); a sub-agent gets only the ones that name
    // its own role inlined, and the rest as a path index it can `read` on
    // demand. Name first, then the description, then the prompt head — that is
    // the order in which a skill would name the same job.
    let focus = profile
        .as_ref()
        .map(|p| {
            let head: String = p["prompt"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(3_000)
                .collect();
            format!(
                "{} {} {}",
                p["name"].as_str().unwrap_or_default(),
                p["description"].as_str().unwrap_or_default(),
                head
            )
        })
        .map(|text| text.trim().to_string())
        .unwrap_or_default();

    let mut sub_req = AgentRequest {
        provider: sub_provider_kind,
        provider_id: sub_provider_id,
        model: sub_model,
        base_url: sub_base,
        api_key: parent.api_key.clone(),
        api_keys: sub_keys,
        root: parent.root.clone(),
        mode: "subagent".into(),
        // A child runs the same persona as the turn that spawned it: an explore
        // child of a chat turn must not turn into a coding agent.
        run_mode: parent.run_mode.clone(),
        prompt,
        history: Vec::new(),
        system_prompt: match profile.as_ref().and_then(|p| p["prompt"].as_str()) {
            Some(text) if !text.trim().is_empty() => text.to_string(),
            _ => explore_system_prompt(&parent.root),
        },
        // A sub-agent is read, not heard: never apply the live-voice rules.
        system_suffix: String::new(),
        // A skill the user attached to this turn is MANDATORY for the work,
        // including the part a child does. Dropping it here (the request used
        // to pass `Vec::new()`) let a browser child run a live-UI task without
        // the Test UI harness the parent was told to follow: the body stayed in
        // the parent's context while the actual page work happened in the
        // child. The child's router budgets/inlines it like its own bundle.
        skills: inherited_skills(parent),
        // The profile's attached bundles: a bundle agent always carries its
        // own plugin, a legacy custom row may carry the bundles it was saved
        // with. Their skills are inlined and their connectors activated by
        // `turn.rs`. This is NOT a limit: `load_plugin` + the catalog let the
        // child load any other enabled toolbox on its own.
        plugins: attached_plugins,
        // The profile's declared tools. When present, `turn.rs` starts from the
        // full sub-agent universe so a pack's `Bash`/`Edit`/`Write` survive;
        // when empty, the kind's default set applies.
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
        // Marks this child as a PROFILE, so `turn.rs` can start it from the
        // full sub-agent universe when it declares tools. The builtin
        // `explore` has no profile and keeps the read-only research set.
        subagent_profile: profile.is_some(),
        // What the skill selector compares bundle skills against. Empty for
        // `explore`, which has no attached bundles anyway.
        subagent_focus: focus,
        context_window: parent.context_window,
        chat_id: parent.chat_id.clone(),
        mcp_servers: Value::Null,
        // No pre-activated connectors: the child starts from its attached
        // bundles (activated by `turn.rs` from `plugins` above) and can load
        // any other enabled plugin with `load_plugin`, which activates that
        // bundle's connectors in the child's own schema list.
        mcp_active: Vec::new(),
        data_root: parent.data_root.clone(),
        subagent_models: parent.subagent_models.clone(),
        providers: parent.providers.clone(),
        // The custom sub-agent list rides along so a nested delegation from the
        // child can still resolve a custom profile by id.
        custom_subagents: parent.custom_subagents.clone(),
        // The chosen kind is what `turn.rs` binds the tool set from. It is a
        // REQUEST only: the two grants below still gate it on the parent turn.
        subagent_kind: Some(kind.clone()),
        // Desktop control is delegated ONLY to a `computer` sub-agent, and ONLY
        // while the user's own Computer Use switch is on for this turn. Off ⇒
        // the sub-agent degrades to research: same run, narrower reach.
        allow_computer: parent.allow_computer && kind == "computer",
        // The chat's desktop grant narrows the same way: only a `computer`
        // child may use it (the child skips the popup gate by MODE anyway;
        // this keeps the request honest about what was granted).
        allow_computer_chat: parent.allow_computer_chat && kind == "computer",
        // The model-confirmation grant is parent-only: a child cannot call
        // `confirm_action`, and the SSH grant is irrelevant (children never
        // reach the SSH gate).
        allow_confirm_chat: false,
        allow_ssh_hosts: Vec::new(),
        // Likewise the browser: a `browser` sub-agent drives a page only when
        // the parent turn already has Browser Use on.
        allow_browser: parent.allow_browser && kind == "browser",
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
        // …and so do the composer's file attachments: the child's prompt already
        // names any file it must open.
        attachments: Vec::new(),
        // A sub-agent inherits the parent's auto-fetch count.
        web_search_auto_fetch: parent.web_search_auto_fetch,
        // …and the headless contract: a scheduled run's explore must also
        // surface a mid-turn stream error instead of ending "successfully"
        // with a partial report (the parent's ladder handles Err already).
        headless: parent.headless,
        // …and its capabilities: a read-only parent must not become writable
        // just because it handed the work to a sub-agent.
        cap: Some(inherited_caps(parent)),
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
        attempt_started_ms.store(crate::state::now_ms() as u64, Ordering::Relaxed);
        let mut report = String::new();
        let mut sub_error = String::new();
        // Per-attempt progress feeds the NEXT attempt's continuation. Text is
        // buffered until the next tool call: streamed chunks are narration, not
        // a report, and logging every token would make the continuation huge.
        let mut attempt_entries: Vec<String> = Vec::new();
        let mut pending_text = String::new();
        let mut active_tool: std::collections::HashMap<String, (String, String)> =
            std::collections::HashMap::new();
        // Re-state the task around the accumulated progress. A first attempt
        // sees the user's prompt byte-for-byte; a retry sees the same task plus
        // what already happened.
        sub_req.prompt = format!("{original_prompt}{}", continuation_block(&progress));
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
        // SUBSTANTIVE progress (text or a tool call), distinct from status
        // pings. The global LSP heartbeat may extend a cold start only while
        // this is still zero: once the sub-agent has actually done something,
        // unrelated LSP work must not mask a wedge.
        let progress_pulse = std::sync::Arc::new(AtomicU64::new(0));
        let progress_sink = std::sync::Arc::clone(&progress_pulse);
        let (res, was_nudged) = {
            let mut sink = |ev: &AgentEvent| {
                pulse_sink.fetch_add(1, Ordering::Relaxed);
                if matches!(
                    ev,
                    AgentEvent::Text { .. }
                        | AgentEvent::ToolStart { .. }
                        | AgentEvent::Tool { .. }
                ) {
                    progress_sink.fetch_add(1, Ordering::Relaxed);
                }
                fold_subagent_event(&mut report, &mut sub_error, ev);
                // Progress for the NEXT attempt. Tool results are kept short
                // (only a load_plugin toolbox keeps its body), because this is
                // a "what happened" log, not a second copy of the transcript.
                match ev {
                    AgentEvent::Text { content } => {
                        if pending_text.chars().count() < 2_000 {
                            pending_text.push_str(content);
                        }
                    }
                    AgentEvent::ToolStart { id, name, args, .. } => {
                        if !pending_text.trim().is_empty() {
                            attempt_entries.push(format!(
                                "said: {}",
                                clip_chars(pending_text.trim(), SUBAGENT_PROGRESS_ENTRY_CHARS)
                            ));
                            pending_text.clear();
                        }
                        active_tool.insert(id.clone(), (name.clone(), progress_args(args)));
                    }
                    AgentEvent::Tool {
                        id,
                        name,
                        args,
                        result,
                        ok,
                        ..
                    } => {
                        // Parallel calls in one step each keep their own slot:
                        // a sibling finishing is not "this call may have run".
                        active_tool.remove(id);
                        let args_text = progress_args(args);
                        let cap = if name == "load_plugin" {
                            SUBAGENT_TOOLBOX_ENTRY_CHARS
                        } else {
                            SUBAGENT_PROGRESS_ENTRY_CHARS
                        };
                        let result_text = clip_chars(result, cap);
                        attempt_entries.push(format!(
                            "{name}({args_text}) -> {}{}",
                            if *ok { "ok" } else { "FAILED" },
                            if result_text.trim().is_empty() {
                                String::new()
                            } else {
                                format!(": {result_text}")
                            }
                        ));
                    }
                    _ => {}
                }
                // Forward structural events AND narration, but tag narration as
                // a sub-agent branch so the renderer can show it INSIDE the
                // explore card. It never enters the parent's model history, so
                // a chatty child cannot cause a parent round-trip.
                match ev {
                    // The sub-run's own Done/Error must not reach the parent
                    // stream (Done would read as the PARENT turn finishing).
                    AgentEvent::Error { .. } | AgentEvent::Done { .. } => {}
                    // Text is the child's own narration ("now opening the
                    // profile…"). The renderer attaches it to this branch's
                    // card; it is UI-only.
                    AgentEvent::Text { .. }
                    | AgentEvent::ToolStart { .. }
                    | AgentEvent::Tool { .. } => emit(&AgentEvent::Branch {
                        branch,
                        sub: true,
                        inner: Box::new(ev.clone()),
                    }),
                    // Retry/usage/thinking/status stay top-level so the Working
                    // pill and token meter keep seeing them.
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
            let guard_progress = std::sync::Arc::clone(&progress_pulse);
            let guard = async move {
                let mut seen = guard_pulse.load(Ordering::Relaxed);
                // LSP has its own heartbeat: a cold language server says nothing
                // for minutes while it builds its index, and that is progress,
                // not a wedge — aborting it would kill a healthy cold start.
                let mut seen_lsp = crate::lsp::activity();
                let mut silent_since = std::time::Instant::now();
                let started = std::time::Instant::now();
                // An attempt's OWN events are real progress: a browser agent
                // working a multi-minute flow emits tool starts/results steadily,
                // and an absolute cap killed healthy runs at four minutes (the
                // traced Instagram verification). Only SILENCE may trip the
                // guard; a busy attempt is never aged out.
                let mut substantive = false;
                // The LSP heartbeat is GLOBAL, so unrelated work could otherwise
                // keep a wedged cold start alive forever. It may only extend the
                // pre-first-progress window, and only up to this ceiling.
                let cold_start_cap =
                    std::time::Duration::from_secs(subagent_idle_secs() + 120);
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let now = guard_pulse.load(Ordering::Relaxed);
                    if now != seen {
                        seen = now;
                        silent_since = std::time::Instant::now();
                    }
                    if !substantive && guard_progress.load(Ordering::Relaxed) > 0 {
                        substantive = true;
                    }
                    // The cold-start allowance has a hard end: past it, even a
                    // heartbeating (but unrelated) LSP call no longer buys time.
                    if !substantive && started.elapsed() >= cold_start_cap {
                        return;
                    }
                    let now_lsp = crate::lsp::activity();
                    if !substantive && now_lsp != seen_lsp {
                        seen_lsp = now_lsp;
                        if started.elapsed() < cold_start_cap {
                            silent_since = std::time::Instant::now();
                        }
                    }
                    if silent_since.elapsed()
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
        // Fold this attempt's work into the running progress BEFORE the ladder
        // decides what to do next. A nudged attempt is included too: the user
        // asked for a restart, not a replay, so whatever already happened must
        // still be carried forward. An interrupted tool is called out as
        // "may have completed" because the future was dropped mid-call and the
        // side effect may already be on the page/disk. Active calls are keyed
        // by tool id, so parallel siblings are all captured — and a completed
        // sibling was already removed above.
        for (_, (name, args_text)) in active_tool.drain() {
            attempt_entries.push(format!(
                "{name}({args_text}) was still running when the attempt stopped — it MAY have \
                 completed; verify the current state before repeating it."
            ));
        }
        if !pending_text.trim().is_empty() {
            attempt_entries.push(format!(
                "said: {}",
                clip_chars(pending_text.trim(), SUBAGENT_PROGRESS_ENTRY_CHARS)
            ));
        }
        if !report.trim().is_empty() {
            best_partial = report.clone();
        }
        // A clean run that did work but wrote no closing text is FINISHED, not
        // empty: retrying it can repeat the side effect it just performed. Hand
        // the evidence to the parent and stop.
        if finished_with_evidence_but_no_report(&res, &sub_error, &report, &attempt_entries) {
            let summary = format!(
                "Sub-agent finished its tool work but wrote no closing summary. The actions it \
                 performed are listed below — use them as the result, and verify the current \
                 state before repeating anything.\n\n{}",
                attempt_entries.join("\n")
            );
            return (summary, true);
        }
        if !attempt_entries.is_empty() {
            progress.extend(attempt_entries);
            trim_progress(&mut progress);
        }
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
                agent: format!("{display_name} subagent"),
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
                // The badge reports the attempt that is about to START (this
                // move is immediate): re-emitting the failed attempt froze the
                // counter, so a long fallback list and a wrap back to the first
                // model looked like no auto-retry step had happened at all.
                emit(&AgentEvent::Retry {
                    attempt: attempt + 1,
                    max_attempts,
                    delay_secs: 0,
                    reason: format!("{} — trying the next model", last.0),
                    agent: format!("{display_name} subagent"),
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
        // `tool` names the tool that owns the retry. `attempt + 1` is the
        // attempt the countdown is for — the auto-retry step must visibly move
        // on a wrap back to the first model, not repeat the number that failed.
        let reason = if wrapped {
            format!("{} — every model failed, starting over from the first", last.0)
        } else {
            last.0.clone()
        };
        emit(&AgentEvent::Retry {
            attempt: attempt + 1,
            max_attempts,
            delay_secs: SUBAGENT_RETRY_BACKOFF_MS / 1000,
            reason: reason.clone(),
            agent: format!("{display_name} subagent"),
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
                agent: format!("{display_name} subagent"),
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
            agent: format!("{display_name} subagent"),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
            provider_id: sub_req.provider_id.clone(),
            fallback: using_fallback,
        });
    }
    // Giving up after real work must NOT read as "no findings". The parent is
    // about to decide the next step from this result: it needs the evidence the
    // child already produced (and a warning that an interrupted call may have
    // landed), otherwise it repeats the side effect — the traced duplicate
    // Instagram publish. The give-up banner keeps the short failure reason
    // above; only the tool result becomes the partial report.
    if !last.1 {
        if let Some(partial) = partial_subagent_report(&progress, &best_partial, &last.0) {
            return (partial, false);
        }
    }
    last
}

