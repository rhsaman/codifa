use super::*;

// Turn loop
// ---------------------------------------------------------------------------

pub(super) static TURN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Source of sub-agent branch ids. Process-wide (not per step) because the
/// frontend matches `branch` across every card in a message — two explores in
/// different steps must never share an id or each would show the other's calls.
pub(super) static BRANCH_SEQ: AtomicU64 = AtomicU64::new(1);

/// The applied change, rendered for the MODEL, bounded on a char boundary.
///
/// `edit_file` answers with just "Successfully edited x (1 occurrence replaced)."
/// — 87 chars for a real change. Traced turns then spent their NEXT round-trip
/// on a lone read/grep of the very same file to confirm it (78 of 131 edits,
/// 975_031 chars of re-reading in total): a full conversation re-send to buy
/// back information the edit already had. The diff is computed for the Review
/// panel anyway, so handing it to the model too removes that round-trip.
///
/// The trailer matters: without it the model treats the diff as extra context
/// and still validates it by re-reading.
pub(super) fn applied_change_block(diff: &str) -> String {
    if diff.len() <= EDIT_DIFF_CHARS {
        return format!("\n\n=== applied change ===\n{diff}{EDIT_DIFF_TRAILER}");
    }
    let mut end = EDIT_DIFF_CHARS;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "\n\n=== applied change (first {EDIT_DIFF_CHARS} bytes of {}) ===\n{}{EDIT_DIFF_TRAILER}",
        diff.len(),
        &diff[..end]
    )
}

/// What the model is told above the screenshots it just took.
///
/// The coordinate line is the important part: the image is resized before it is
/// sent, so an x/y read off the picture is NOT a screen coordinate. Without the
/// mapping the model clicks at the pixel it saw in a 1440-wide image on a
/// 2880-wide screen — off by a factor of two, and it has no way to notice.
/// How many captures may stay in the conversation at once.
///
/// Every past capture is re-encoded as base64 and re-billed as vision tokens
/// on EVERY following step of the turn — a 2560px screenshot is thousands of
/// tokens per round, so a long computer-use turn re-sent its whole gallery
/// every round. The model aims at the LATEST capture and needs at most the one
/// before it to correct a missed click; anything older is dead weight.
pub(super) const MAX_HISTORY_SHOTS: usize = 2;

/// Elide stale screenshot images from the history, oldest first, until at most
/// `keep` image blocks remain across the shot messages (the ones whose first
/// text block is the `Screenshot taken:` summary — composer attachments and
/// `read`-returned images are content the model asked for and are never
/// touched). An elided block becomes a one-line text note, so the model knows
/// the picture existed and how to get it back.
pub(super) fn elide_stale_screenshots(messages: &mut [Value], keep: usize) {
    const SHOT_PREFIX: &str = "Screenshot taken:";
    let mut shot_msgs: Vec<(usize, Vec<usize>)> = Vec::new();
    for (mi, m) in messages.iter().enumerate() {
        if m["role"].as_str() != Some("user") {
            continue;
        }
        let Some(blocks) = m["content"].as_array() else {
            continue;
        };
        if !blocks
            .first()
            .and_then(|b| b["text"].as_str())
            .is_some_and(|t| t.starts_with(SHOT_PREFIX))
        {
            continue;
        }
        let imgs: Vec<usize> = blocks
            .iter()
            .enumerate()
            .filter(|(_, b)| b["type"] == crate::llm::IMAGE_BLOCK_TYPE)
            .map(|(i, _)| i)
            .collect();
        if !imgs.is_empty() {
            shot_msgs.push((mi, imgs));
        }
    }
    let total: usize = shot_msgs.iter().map(|(_, i)| i.len()).sum();
    let mut to_elide = total.saturating_sub(keep);
    for (mi, imgs) in &shot_msgs {
        if to_elide == 0 {
            break;
        }
        let Some(blocks) = messages[*mi]["content"].as_array_mut() else {
            continue;
        };
        for &bi in imgs {
            if to_elide == 0 {
                break;
            }
            blocks[bi] = json!({
                "type": "text",
                "text": "[older screenshot removed from the wire to save context — \
action=screenshot takes a fresh one]"
            });
            to_elide -= 1;
        }
    }
}

/// A cheap content digest of a captured file.
///
/// Used to detect a capture whose PIXELS did not change and to fold the
/// picture into the round's no-progress digest. Hashing the encoded file is
/// enough: the encoder is deterministic for identical pixels, and a file that
/// cannot be read returns `None` so the caller falls back to sending it.
pub(super) fn shot_file_digest(path: &str) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let bytes = std::fs::read(path).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Some(h.finish())
}

/// The identity of one ACTION for the repeat ceiling.
///
/// `reason` is narration for the permission card, never an execution
/// parameter. The traced desktop loop sent 56 `command+tab` calls whose ONLY
/// difference was the sentence explaining why (plus a few rephrasings), so a
/// raw-args key treated every spelling as a new action and the loop ran for
/// 31 minutes. Ignoring `reason` catches the loop at the 6th/12th repeat
/// (~1.5 and ~4.5 minutes in that trace). Every execution field still counts,
/// so legitimate work — a different file, a different command, a new click
/// target — stays distinct.
pub(super) fn repeat_action_key(name: &str, raw_args: &str) -> String {
    let mut key = name.to_string();
    key.push('\u{1f}');
    match serde_json::from_str::<Value>(raw_args) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.remove("reason");
            }
            key.push_str(&v.to_string());
        }
        // Unparseable arguments are the model's own bytes; compare them as-is.
        Err(_) => key.push_str(raw_args),
    }
    key
}

pub(super) fn shot_summary(shots: &[crate::computer::Shot]) -> String {
    let mut out = String::from("Screenshot taken:");
    for (i, s) in shots.iter().enumerate() {
        if shots.len() > 1 {
            out.push_str(&format!("\n[{}]", i + 1));
        }
        out.push_str(&format!("\n  {} — {}x{} px.", s.label, s.width, s.height));
        out.push_str(&format!(
            "\n  Screen point = ({:.0} + image_x × {:.4}, {:.0} + image_y × {:.4}).",
            s.origin_x, s.points_per_pixel, s.origin_y, s.points_per_pixel
        ));
    }
    out
}

/// Run the bundle `Stop` handlers and report their output as a trailing note.
///
/// Runs at EVERY terminal exit of a turn. It cannot change the answer — the
/// turn is already finished — so its only effect is what a bundle prints, and a
/// handler that fails must never turn a finished turn into an error.
pub(super) fn run_stop_hooks(
    hooks: &[crate::hooks::Active],
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
) {
    if hooks.is_empty() {
        return;
    }
    let done = crate::hooks::run_active(hooks, "Stop", "");
    if !done.output.is_empty() {
        emit(&AgentEvent::Text {
            content: format!("\n\n> hook: {}", done.output.replace('\n', "\n> ")),
        });
    }
}

/// What the "Working" pill names while a tool runs. `batch_search` is only a
/// wrapper, so the pill lists the tools it carries ("read ×2, grep") instead
/// of the tool's own name; every other tool keeps its own name.
pub(super) fn tool_status_label(name: &str, args: &Value) -> String {
    if !crate::tools::is_batch_tool(name) {
        return name.to_string();
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    if let Some(ops) = args["ops"].as_array() {
        for op in ops {
            let tool = op["tool"].as_str().unwrap_or_default().trim().to_string();
            if tool.is_empty() {
                continue;
            }
            if let Some(i) = counts.iter().position(|(t, _)| *t == tool) {
                counts[i].1 += 1;
            } else {
                counts.push((tool, 1));
            }
        }
    }
    if counts.is_empty() {
        return name.to_string();
    }
    counts
        .into_iter()
        .map(|(t, n)| if n > 1 { format!("{} ×{}", t, n) } else { t })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Cap the UI echo, record the trace row, emit the Tool event and push the
/// tool message — shared by the parallel (read-only batch) and sequential
/// tool paths so both produce identical cards/traces/model messages.
pub(super) fn finish_tool(
    messages: &mut Vec<Value>,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    trace: &crate::trace::TraceStore,
    id: &str,
    name: &str,
    args: &Value,
    result: String,
    ok: bool,
    sub: bool,
    ui_results: Option<Value>,
    ui_engine: Option<String>,
) {
    // UI echo is capped; cap on a UTF-8 char boundary — byte slicing
    // mid-char panics on Persian text.
    let echo_cap = ui_echo_cap(name);
    let mut shown = result.clone();
    if shown.len() > echo_cap {
        let mut end = echo_cap;
        while end > 0 && !shown.is_char_boundary(end) {
            end -= 1;
        }
        shown.truncate(end);
        shown.push_str("\n… (truncated in the panel only)");
    }
    // The model receives a capped copy too — a narrower re-read is one
    // cheap tool call; an unbounded context is seconds per round-trip.
    //
    // Which DETERMINISTIC levers fired, read off the ORIGINAL result: the cap
    // below can drop the tail that carries the marker.
    let levers = crate::tools::levers_fired(name, &result);
    let mut for_model = result;
    let is_report = is_delegation(name);
    let cap = if is_report { EXPLORE_REPORT_CAP } else { MODEL_RESULT_CAP };
    if for_model.len() > cap {
        if is_report {
            // Cut the MIDDLE, not the tail: the head holds the answer and the
            // tail holds the search results / file list, and the main agent
            // cannot re-read either on its own. Only the middle is dropped,
            // with an explicit pointer to ask for it again.
            let head_len = cap / 2;
            let mut head_end = head_len;
            while head_end > 0 && !for_model.is_char_boundary(head_end) {
                head_end -= 1;
            }
            let mut tail_start = for_model.len() - (cap - head_len);
            while tail_start < for_model.len() && !for_model.is_char_boundary(tail_start) {
                tail_start += 1;
            }
            let omitted = tail_start - head_end;
            for_model = format!(
                "{}\n… [{omitted} chars omitted from the middle of this report — the head and the tail are intact; ask explore for the omitted section if you need it]\n{}",
                &for_model[..head_end],
                &for_model[tail_start..]
            );
        } else {
            let mut end = cap;
            while end > 0 && !for_model.is_char_boundary(end) {
                end -= 1;
            }
            // Name the resume point in LINES, not just "use a narrower window":
            // the model cannot translate a cut character count back into an
            // offset, so a bare "truncated" was answered by re-reading the whole
            // file. Counting the newlines that survived gives the exact next
            // line, and for `read` the trailer is phrased as the next call.
            let kept_lines = for_model[..end].matches('\n').count();
            for_model.truncate(end);
            if name == "read" {
                for_model.push_str(&format!(
                    "\n… [only the first {kept_lines} lines fit the result budget — read the rest with offset={} (do NOT re-read what is shown above)]",
                    kept_lines + 1
                ));
            } else {
                for_model.push_str(
                    "\n… [truncated for the model — re-read a narrower offset/limit window if you need more]",
                );
            }
        }
    }
    let model_chars = for_model.chars().count();
    // Trace: one tool row per executed call (args + result).
    trace.record(crate::trace::TraceEntry {
        kind: "tool".into(),
        summary: name.to_string(),
        prompt: Some(serde_json::to_string(args).unwrap_or_default()),
        result: Some(shown.clone()),
        detail: Some(serde_json::json!({
            "name": name,
            "ok": ok,
            "sub": sub,
            // Size of the copy the MODEL actually received, in chars. The trace
            // `result` field above is the UI echo (capped at 4K/8K), so measuring
            // token cost from it was measuring the wrong thing. This is the
            // number any future read/grep budget decision must be based on.
            "model_chars": model_chars,
            // For a `batch` call: how many ops it carried (from the ARGS, not
            // the echo — a long batch result is echo-truncated and its labels
            // disappear, which under-counted the round-elimination metric).
            "batch_ops": if crate::tools::is_batch_tool(name) {
                crate::tools::batch_ops(&args).map(|a| a.len()).unwrap_or(0)
            } else {
                0
            },
            // Which DETERMINISTIC levers fired on this call. Both are decided in
            // the backend (never a model choice) and both attach their payload
            // to this result, so that payload is IN `model_chars` above. Without
            // this flag the only way to tell whether a lever fired was to infer
            // it from the round count, which cannot distinguish a lever that
            // fired from one that was never reached.
            "levers": levers,
        })),
        ..Default::default()
    });
    emit(&AgentEvent::Tool {
        id: id.to_string(),
        name: name.to_string(),
        args: args.clone(),
        result: shown,
        ok,
        results: ui_results,
        engine: ui_engine,
    });
    messages.push(json!({
        "role": "tool",
        "tool_call_id": id,
        "content": for_model,
    }));
}

/// One message on the explore fan-in channel.
///
/// `Done` is what lets each explore resolve its OWN card the instant it lands
/// (via `finish_tool`) while the others are still running. Without it the
/// parent could only tick the cards after every sibling had finished — a
/// finished explore kept its spinner for minutes and the whole batch ticked
/// together, which is exactly what the user saw.
pub(super) enum SubMsg {
    Ev(AgentEvent),
    Done { id: String, name: String, args: Value, result: String, ok: bool },
}

/// Make ONE connector's deferred tools callable in this turn.
///
/// The tool array must stay byte-identical across the rounds of a turn or the
/// prefix cache breaks, so a call cannot add schemas to the array it was made
/// with; appending here makes the tools callable from the NEXT round, which is
/// what both `use_mcp` and `load_plugin` rely on. Returns how many tools became
/// callable (0 when the connector was already active or has no tools).
fn activate_connector(
    server: &str,
    connectors: &[crate::mcp_index::ConnectorEntry],
    deferred: &[Value],
    activated: &mut std::collections::HashSet<String>,
    advertised: &mut Vec<String>,
    schemas: &mut Vec<Value>,
) -> usize {
    if !activated.insert(server.to_string()) {
        return 0;
    }
    let fresh: Vec<Value> = deferred
        .iter()
        .filter(|s| {
            s["function"]["name"]
                .as_str()
                .and_then(|n| crate::mcp_index::owner_of(connectors, n))
                == Some(server)
        })
        .cloned()
        .collect();
    advertised.extend(
        fresh
            .iter()
            .filter_map(|s| s["function"]["name"].as_str().map(str::to_string)),
    );
    advertised.sort();
    advertised.dedup();
    let count = fresh.len();
    schemas.extend(fresh);
    count
}

/// Run one full agent turn: stream the model, execute tool calls, repeat
/// until the model answers without tool calls or MAX_STEPS is reached.
/// Emits the same event protocol as the Python graph.
pub async fn run_turn(
    req: &AgentRequest,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
) -> Result<(), String> {
    let run_id = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    // Register this chat as "running" for the whole turn so `/chat/steer` can
    // inject a message into it, and guarantee the registry + inbox are cleared
    // however we exit (normal return, early return, or a panic unwinding).
    // A sub-agent must NOT register: it reuses the parent's chat id, so its own
    // Drop would un-register the parent turn that is still running.
    // The steer inbox is keyed by chat id, and a SUB-AGENT runs with the
    // PARENT's chat id — so the child must never touch it: a steer typed during
    // a delegation belongs to the PARENT's next step, not to the delegation's
    // own conversation. An empty key makes every deliver/drop call below a
    // no-op for the child; the parent delivers after the delegation returns.
    let steer_chat: &str = if req.mode == "subagent" {
        ""
    } else {
        req.chat_id.as_str()
    };
    let _steer_guard = SteerGuard::new(steer_chat);
    let root = req.root.clone();
    // Start the workspace's language servers in the background: the first LSP
    // call of a turn otherwise pays for the whole cold start (spawn + load the
    // crate graph + first didOpen), which on a large workspace is minutes with
    // no output at all. Pre-warming spends the model's thinking time instead,
    // so the first lsp_* call usually finds an already-loaded server. Runs
    // ONCE per project per process; cheap no-op afterwards.
    crate::lsp::prewarm(&root);
    let trace = crate::trace::TraceStore::new(req.chat_id.clone()).with_run(run_id);
    let cfg = LlmConfig {
        provider: req.provider.clone(),
        headers: crate::llm::custom_headers(&req.providers, &req.provider_id),
        provider_id: req.provider_id.clone(),
        model: req.model.clone(),
        base_url: req.base_url.clone(),
        api_keys: if req.api_key.is_empty() {
            req.api_keys.clone()
        } else {
            let mut keys = vec![req.api_key.clone()];
            keys.extend(req.api_keys.iter().cloned());
            keys
        },
        temperature: None,
        max_tokens: None,
        // No practical cap on a chat turn: the user explicitly does not want a
        // seconds-based error while a provider is still answering (slow
        // gateways and reasoning models can take many minutes). Stop still
        // aborts instantly via the cancel flag.
        timeout_secs: crate::llm::NO_TIMEOUT_SECS,
        reasoning_level: crate::llm::level_from_source(
            provider_model_thinking_levels(&req.providers, &req.provider_id, &req.model).as_deref(),
            &req.thinking_level,
        ),
        model_reasoning: req.model_reasoning,
        auto_think: crate::models::auto_think_for(&req.provider),
    };

    // Assemble the message list: system + history + current user prompt.
    let mut messages: Vec<Value> = Vec::new();
    let mut system = if req.system_prompt.is_empty() {
        default_system_prompt(&req.run_mode, &req.mode, &root)
    } else {
        req.system_prompt.clone()
    };
    // The schedule contract, in the prompt as well as in the loop: a headless
    // run has NOBODY to answer a question or approve an action. Stating it up
    // front keeps the run from spending a round discovering it (the ask/confirm
    // tools are withheld below and auto-answered if still called).
    if req.headless && req.mode != "subagent" {
        system.push_str(
            "\n\nSCHEDULED HEADLESS RUN: there is NO user here. Never try to ask a question or \
request approval — those tools are unavailable and return without an answer. Decide each \
fork yourself with the most reasonable default and state the assumption in your final \
output. Paths outside the workspace, the OS temp folder and ~/.codifa are REFUSED (never \
asked about): keep all reads and writes inside those roots or inside a folder the user has \
already approved with \"Always allow\".",
        );
    }
    // Skills: the system prompt carries a catalog of the installed skills and
    // the model loads the plugin it needs via `load_plugin` (one unit: every
    // skill body and every connector tool). Only attached plugins/skills are
    // inlined whole.
    // The skill store lives in the DATA root, not the workspace. A caller that
    // omits `data_root` (e.g. a scheduled run) must still find the store, so
    // fall back to the native data root rather than the workspace — reading the
    // workspace found no skills at all, which silently shipped an empty catalog.
    let skill_root = if req.data_root.is_empty() {
        native_data_root()
    } else {
        req.data_root.clone()
    };
    // Automatic delegation, in the prompt as well as in the tool table: every
    // reachable sub-agent (custom rows AND enabled bundle profiles) is listed
    // by NAME with the matching rule — use the fewest that cover the request,
    // never the whole list. A child turn gets no list (it cannot delegate).
    if req.mode != "subagent" {
        system.push_str(&delegation_prompt_hint(
            std::path::Path::new(&skill_root),
            &req.custom_subagents,
            req.allow_browser,
            req.allow_computer,
        ));
    }
    // Skills: the catalog ONLY. WHICH skill applies is the model's call through
    // `load_plugin` (the Codex/Claude pattern) — nothing is picked for it from
    // the wording of the request. A sub-agent gets the same catalog: it has
    // `load_plugin` too, so it can use any installed toolbox without anything
    // being assigned to it in Settings. Its own bundle / @mentions are inlined
    // on top, budgeted by the router.
    // The catalog is the byte-stable part: it lives on the system prompt,
    // so it must not depend on the current message — the router builds it
    // from the plugin store alone, and which plugin applies is the model's
    // call made from the catalog.
    //
    // An attached PLUGIN is ONE unit: every skill it carries is a candidate
    // with it, so `req.plugins` expands into its skill names here instead
    // of the model having to load them one by one. A sub-agent then narrows
    // that candidate list to its own role (a bundle can be a library).
    let missing_skills = {
        let mut attached = req.skills.clone();
        for name in crate::plugins::bundle_skill_names(
            std::path::Path::new(&skill_root),
            &req.plugins,
        ) {
            if !attached.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                attached.push(name);
            }
        }
        // A sub-agent gets the plugin CATALOG too: it has `load_plugin`, so it
        // can discover and use ANY toolbox the user installed without anything
        // being assigned to it in Settings → Sub-agents. Its own bundle /
        // @mentions are inlined on top of that catalog, but budgeted — a bundle
        // may carry dozens of skills, so the agent's own identity picks which
        // ones are inlined and the rest are indexed by path.
        let skill_section = if req.mode == "subagent" {
            let focus = if req.subagent_focus.trim().is_empty() {
                req.system_prompt.as_str()
            } else {
                req.subagent_focus.as_str()
            };
            crate::skill_router::build_subagent_section(&skill_root, &attached, focus)
        } else {
            crate::skill_router::build_section(&skill_root, &attached)
        };
        if !skill_section.text.is_empty() {
            system.push_str(&skill_section.text);
        }
        skill_section.missing
    };
    // A plugin-use turn must still feed the Todos panel. The CHECKLIST rule lives
    // in `default_system_prompt` only; the app's own mode prompt (or a custom one)
    // REPLACES that text, and an attached plugin inlines its own workflow on top —
    // so the model followed the plugin's steps and never called `update_plan`,
    // leaving the panel empty. Appended only when the prompt does not already
    // mention the tool, so the default prompt's wording is never doubled.
    if req.mode != "subagent" && !req.plugins.is_empty() && !system.contains("update_plan") {
        system.push_str(
            "\n\nCHECKLIST: a plugin workflow has several steps, so BEFORE the first action \
call update_plan with the COMPLETE list (short imperative items in the user's language), \
then keep it current: mark each item completed and the next one in_progress as you finish \
it. Put update_plan in the SAME step as your other tool calls, never alone.",
        );
    }
    // Plugin hooks: the SAME resolved list is used at all four lifecycle points
    // below, read ONCE from the bundles that are enabled. A sub-agent never runs
    // them: hooks belong to the turn the user started, and a nested explore
    // firing the user's shell guards would run them once per delegation.
    let hooks = if req.mode == "subagent" {
        Vec::new()
    } else {
        crate::hooks::active_in(&crate::plugins::active_hook_bundles(std::path::Path::new(
            &skill_root,
        )))
    };
    // Read the saved plan + live checklist BACK FROM DISK. The native loop only
    // ever wrote them (plans.rs), so after an app restart (or on the next turn)
    // the agent had forgotten the plan it was executing and re-planned from
    // scratch, redoing finished work. Both files are keyed by
    // workspace-slug + chat-id, exactly as plans.rs stores them.
    //
    // MAIN AGENT ONLY. The explore sub-agent inherits the parent's chat_id, so
    // this block used to fire for it too, and that was wrong three times over:
    // (1) it has no `update_plan` tool (research_schemas), yet the checklist
    // told it to "keep it current with update_plan" — an instruction it could
    // only answer with an unknown-tool error and a wasted round-trip;
    // (2) the plan body is uncapped and was re-sent on EVERY round of EVERY
    // explore run (one traced session had 112 runs), pure input waste;
    // (3) The plan + checklist do NOT go into the system prompt. They change
    // every time `update_plan` runs — inside almost every turn — and the system
    // prompt is `messages[0]`, the first byte a prefix cache can reuse. Measured
    // on real traces: the main-agent system prompt was 7_734 -> 9_439 -> 7_734 ->
    // 13_642 -> 7_734 bytes over five turns (the delta being exactly this
    // section), which collapsed the main-agent prefix cache to 23.7%
    // (649_116 uncached input tokens) while the explore sub-agent — whose
    // system prompt is a byte-stable 7_604 — sat at 85.9%.
    // The section is injected as a TRAILING message instead (see the push after
    // the user prompt): the model sees the identical content, it simply appears
    // as context above the request rather than inside `messages[0]`, so a
    // checklist tick can no longer invalidate the prefix.
    // The sub-agent does not get it at all: its task arrives as the user prompt,
    // and the main agent stays the owner of the plan.
    let main_plan_section = if req.mode == "subagent" {
        String::new()
    } else {
        plan_section(
            &skill_root,
            &crate::plans::workspace_slug_for_root(&root),
            &req.chat_id,
        )
    };
    if !missing_skills.is_empty() {
        emit(&AgentEvent::Skills {
            skills: Vec::new(),
            manual: true,
            note: Some(format!(
                "Attached skills not found — they may have been deleted or renamed: {}. The turn runs without them.",
                missing_skills.join(", ")
            )),
        });
    }
    // Per-turn extra instruction (live voice: shape the answer for the ear).
    // APPENDED, never substituted: `system_prompt` above replaces the builtin
    // prompt outright, so a caller cannot add a rule without wiping what the
    // user configured. Live turns send this on every request of the session —
    // a constant string, so it does not churn the prefix cache; typed turns
    // send nothing and `messages[0]` is byte-identical to what it was.
    if !req.system_suffix.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(req.system_suffix.trim());
    }
    messages.push(json!({"role": "system", "content": system}));
    // A history entry's images arrive as PATHS (historyPayload strips the inline
    // copies so a long chat does not re-serialize megabytes of base64 on every
    // round). Re-reading them is what keeps an older screenshot visible to the
    // model: without it a follow-up ("now fix it") referred to an image the
    // model had never received.
    let client = http_client();
    // Whether the images should reach the MAIN model as image blocks, or be
    // pre-digested by the "Vision" tool slot. The main model goes FIRST: it is
    // the model the user picked, and most flagship models read images natively.
    // Only a model the capability maps already KNOW to be text-only (or one that
    // refuses the images mid-turn — see the main loop) hands them to the slot.
    let main_can_vision =
        model_supports_vision(&req.providers, &req.provider_id, &cfg.model) != Some(false);
    // Describe the LAST few image-carrying entries: a follow-up refers to the
    // most recent screenshot, and every description is a paid round-trip.
    // Collected here, described CONCURRENTLY below — awaiting them one by one
    // inside the message loop made every turn start after N model round-trips.
    let mut describe_idx: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (i, m) in req.history.iter().enumerate().rev() {
        if m.get("images")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
        {
            describe_idx.insert(i);
            if describe_idx.len() >= MAX_HISTORY_VISION_CALLS {
                break;
            }
        }
    }
    let mut descriptions: std::collections::HashMap<usize, String> =
        std::collections::HashMap::new();
    if !main_can_vision && !describe_idx.is_empty() {
        let jobs: Vec<(usize, String, Vec<String>)> = describe_idx
            .iter()
            .filter_map(|&idx| {
                let m = req.history.get(idx)?;
                let text = m.get("content").and_then(Value::as_str)?;
                let recap = history_recap(m);
                let text = if recap.is_empty() {
                    text.to_string()
                } else {
                    format!("{text}{recap}")
                };
                let imgs = m
                    .get("images")
                    .and_then(Value::as_array)
                    .map(|a| resolve_image_entries(a.clone()))
                    .unwrap_or_default();
                if imgs.is_empty() {
                    return None;
                }
                Some((idx, text, imgs))
            })
            .collect();
        // Copy the shared handles out of `cfg` so the closures capture cheap
        // references instead of moving the config into the first future.
        let client_ref: &reqwest::Client = &client;
        let v_model = cfg.model.as_str();
        let v_provider = cfg.provider.as_str();
        let v_base_url = cfg.base_url.as_str();
        let v_api_keys: &[String] = &cfg.api_keys;
        let results = futures_util::future::join_all(jobs.into_iter().map(
            |(idx, text, imgs)| async move {
                let outcome = run_vision_slot(
                    client_ref,
                    req,
                    v_model,
                    v_provider,
                    v_base_url,
                    v_api_keys,
                    &text,
                    &imgs,
                )
                .await;
                (idx, outcome)
            },
        ))
        .await;
        for (idx, outcome) in results {
            if let VisionOutcome::Ok(desc) = outcome {
                descriptions.insert(idx, desc);
            }
        }
    }
    for (idx, m) in req.history.iter().enumerate() {
        if let (Some(role), Some(content)) = (
            m.get("role").and_then(Value::as_str),
            m.get("content").and_then(Value::as_str),
        ) {
            // A stored system message can only sit MID-LIST here — messages[0]
            // is the turn's own system prompt. Some providers reject any system
            // message that is not the first one: Cloudflare Workers AI answers
            // every such request with a hard 400 ("System message must be at
            // the beginning"), so a compacted chat on that provider could never
            // get an answer and the retry ladder burned itself out on the same
            // deterministic rejection. Demote the stored role to `user` on the
            // wire — the backend's own mid-turn compaction already writes its
            // summary as `user` for exactly this reason, and the content reads
            // as context either way.
            let role = if role == "system" { "user" } else { role };
            // Carry the turn's non-prose state (tools run, preserved summary,
            // checklist) into the content — see history_recap.
            let recap = history_recap(m);
            let text = if recap.is_empty() {
                content.to_string()
            } else {
                format!("{content}{recap}")
            };
            let hist_imgs = m
                .get("images")
                .and_then(Value::as_array)
                .map(|a| resolve_image_entries(a.clone()))
                .unwrap_or_default();
            if hist_imgs.is_empty() {
                messages.push(json!({"role": role, "content": text}));
                continue;
            }
            let described = if !main_can_vision && describe_idx.contains(&idx) {
                descriptions.get(&idx).cloned()
            } else {
                None
            };
            match described {
                // The description carries this message's image content now.
                Some(desc) => messages.push(json!({
                    "role": role,
                    "content": format!(
                        "{text}\n\n=== IMAGE ANALYSIS (from the vision model) ===\n{desc}"
                    ),
                })),
                // A model KNOWN to be text-only never receives raw image blocks:
                // when the Vision slot gave no description (out of the describe
                // window, or every rung failed) the image is replaced by a note.
                None if !main_can_vision => messages.push(json!({
                    "role": role,
                    "content": format!(
                        "{text}\n\n[image omitted: this model cannot read images and the Vision \
                         model (Settings → Tools → Vision) gave no description]"
                    ),
                })),
                None => {
                    let mut blocks: Vec<Value> = Vec::new();
                    if !text.is_empty() {
                        blocks.push(json!({"type": "text", "text": text}));
                    }
                    for url in &hist_imgs {
                        blocks
                            .push(json!({"type": crate::llm::IMAGE_BLOCK_TYPE, "data_url": url}));
                    }
                    messages.push(json!({"role": role, "content": blocks}));
                }
            }
        }
    }
    // --- Vision pass (fallback only) --------------------------------------
    // The images are already attached to the user message as blocks, so the
    // MAIN model sees them first. Only when the capability maps say it cannot
    // read images (`main_can_vision == false`) is the "Vision" tool slot used to
    // describe them once — the description then replaces the blocks as text.
    // When the maps are silent the blocks are sent and the main loop retries
    // with the Vision slot if the provider rejects them.
    // A leading `/name` that names an ENABLED bundle's command is that command:
    // its body replaces the typed line, with `$ARGUMENTS`/`$1..$9` substituted
    // from the words after it. Resolved BEFORE the vision pass and the message
    // assembly, so the model receives the command's INSTRUCTIONS as the user
    // turn — the shape Claude Code and Codex use. An unknown `/word` stays
    // literal: the composer's built-ins never reach the backend, so a stray
    // slash here is text the user typed.
    let mut final_prompt = req.prompt.clone();
    if req.mode != "subagent" {
        if let Some((expanded, name)) =
            crate::skill_router::expand_slash_command(&req.prompt, &skill_root)
        {
            trace.record(crate::trace::TraceEntry {
                kind: "command".into(),
                summary: format!(
                    "/{name}{}",
                    if expanded.len() > req.prompt.len() {
                        " (expanded)"
                    } else {
                        ""
                    }
                ),
                ..Default::default()
            });
            final_prompt = expanded;
        }
    }
    let mut inline_images: Vec<String> = req.images.clone();
    // Only a turn that actually CARRIES images needs the pass: calling the slot
    // with an empty list returns NotConfigured, and the old unguarded block then
    // stamped "[image omitted …]" onto every text-only sub-agent prompt even
    // when no image was attached.
    if !main_can_vision && !req.images.is_empty() {
        match run_vision_slot(
            &client,
            req,
            &cfg.model,
            &cfg.provider,
            &cfg.base_url,
            &cfg.api_keys,
            &req.prompt,
            &req.images,
        )
        .await
        {
            VisionOutcome::Ok(desc) => {
                final_prompt = format!(
                    "{}\n\n=== IMAGE ANALYSIS (from the vision model) ===\n{desc}",
                    req.prompt
                );
                // The description carries the image content now.
                inline_images.clear();
            }
            VisionOutcome::Failed { model, error } => {
                // The main model is known to be text-only, so the raw images are
                // NEVER sent to it: they are dropped and the model is told why.
                emit(&AgentEvent::Text {
                    content: format!(
                        "\n\n> The vision model ({model}) could not analyze the image ({error}); \
                         the image was skipped because this model cannot read images.\n"
                    ),
                });
                final_prompt = format!(
                    "{}\n\n[image omitted: this model cannot read images and the Vision model \
                     failed ({error})]",
                    req.prompt
                );
                inline_images.clear();
            }
            VisionOutcome::NotConfigured => {
                // No Vision model is set (Settings → Tools → Vision): a text-only
                // model still must not get image blocks it will reject.
                final_prompt = format!(
                    "{}\n\n[image omitted: this model cannot read images and no Vision model \
                     is configured in Settings → Tools → Vision]",
                    req.prompt
                );
                inline_images.clear();
            }
        }
    }

    // Plugin `UserPromptSubmit`: the last place to see the prompt BEFORE the
    // model does. A handler may rewrite it by printing the replacement text on
    // stdout, and may veto it outright (exit 2). Both are reported on the turn's
    // trace, so a turn whose prompt was rewritten can be explained afterwards.
    //
    // `SessionStart` runs FIRST, and only on a chat's opening turn (empty
    // history is the only signal a fresh conversation gives us). A bundle uses it
    // to inject standing guidance for the whole session — the real
    // `claude-model-advisor` bundle does exactly this and nothing else. Its
    // output rides as a trailing context message (the user's own text must stay
    // untouched), and it can never veto: there is nothing yet to veto.
    let mut session_note = String::new();
    if !hooks.is_empty() {
        if req.mode != "subagent" && req.history.is_empty() {
            let start = crate::hooks::run_active(&hooks, "SessionStart", &final_prompt);
            if start.ran > 0 {
                trace.record(crate::trace::TraceEntry {
                    kind: "hook".into(),
                    summary: if start.output.is_empty() {
                        format!("SessionStart ran {} handler(s)", start.ran)
                    } else {
                        format!("SessionStart → {}", start.output)
                    },
                    ..Default::default()
                });
                if !start.output.is_empty() && !start.output.trim_start().starts_with('{') {
                    session_note = start.output;
                }
            }
        }
        let submit = crate::hooks::run_active(&hooks, "UserPromptSubmit", &final_prompt);
        if submit.ran > 0 {
            let veto = submit.blocked;
            trace.record(crate::trace::TraceEntry {
                kind: "hook".into(),
                summary: if veto {
                    format!("UserPromptSubmit vetoed the turn: {}", submit.reason)
                } else if submit.output.is_empty() {
                    format!("UserPromptSubmit ran {} handler(s)", submit.ran)
                } else {
                    format!("UserPromptSubmit → {}", submit.output)
                },
                ..Default::default()
            });
            if veto {
                emit(&AgentEvent::Error {
                    content: format!("a plugin hook refused this prompt: {}", submit.reason),
                });
                drop_steers(steer_chat, emit);
                emit(&AgentEvent::Done { aborted: false });
                return Ok(());
            }
            // Non-empty stdout is the hook's REPLACEMENT prompt. Only the
            // output of a `{"decision":…}`/exit-2 style document is skipped:
            // that is a verdict, not instructions.
            if !submit.output.is_empty() && !submit.output.trim_start().starts_with('{') {
                final_prompt = submit.output;
            }
        }
    }
    // Composer FILE attachments arrive as paths and are unknown to the model
    // until they are named in the message: without this block a turn whose
    // prompt says "this file" reached the provider with no mention of the file
    // at all, so the model answered that nothing was attached (traced).
    let attachments: Vec<&str> = req
        .attachments
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .collect();
    if !final_prompt.is_empty() || !inline_images.is_empty() || !attachments.is_empty() {
        // Images ride WITH the user text as neutral content blocks; llm.rs
        // translates each one to the provider's own shape (OpenAI image_url /
        // Anthropic base64 source / Gemini inlineData) right before sending.
        if inline_images.is_empty() && attachments.is_empty() {
            messages.push(json!({"role": "user", "content": final_prompt}));
        } else {
            let mut blocks: Vec<Value> = Vec::new();
            if !final_prompt.is_empty() {
                blocks.push(json!({"type": "text", "text": final_prompt}));
            }
            if !attachments.is_empty() {
                blocks.push(json!({
                    "type": "text",
                    "text": format!("Attached files:\n{}", attachments.join("\n")),
                }));
            }
            for url in &inline_images {
                blocks
                    .push(json!({"type": crate::llm::IMAGE_BLOCK_TYPE, "data_url": url}));
            }
            messages.push(json!({"role": "user", "content": blocks}));
        }
    }
    // The main agent's plan/checklist rides at the TAIL of the request (see the
    // comment at the assembly head). Pushed AFTER the user prompt so it never
    // sits between two byte-stable messages: the volatile part stays as far
    // from `messages[0]` as possible, and re-sending it unchanged on the next
    // round-trip does not move anything in front of it.
    if let Some(m) = plan_context_message(&main_plan_section) {
        messages.push(m);
    }
    if let Some(m) = plugin_context_message(&session_note) {
        messages.push(m);
    }
    // The plugin the user attached (`/slug` / the open plugin-use session) is
    // already a loaded toolbox: its skills are inlined and its connectors ride
    // along, so the reminder must NOT ask the model to load it again (that was
    // the traced redundant `load_skill` round).
    if req.mode != "subagent" || !req.plugins.is_empty() {
        if let Some(m) = active_plugin_context_message(&crate::plugins::active_plugin_note(
            std::path::Path::new(&skill_root),
            &req.plugins,
        )) {
            messages.push(m);
        }
    }
    // The last message gets a weak model's attention, so the duty to load a
    // matching plugin rides at the very tail, right under the request. Every
    // turn gets it — a child is not exempt: the browser sub-agent is exactly
    // who must find a live-UI skill's plugin when the main agent delegates the
    // page work, and its own system-prompt catalog is easy to skim past. The
    // reminder is byte-stable for a given attachment set, so it rides the tail
    // without moving the cached prefix.
    messages.push(skills_context_message(&req.skills, &req.plugins));
    // Deterministic second door: if the request's own words name an installed
    // skill, hand the model the owning plugin and the exact `slug`+`skill`
    // call. This is what makes discovery automatic even when the user did not
    // @mention anything and the catalog is long enough to skim. It is skipped
    // when the user DID attach something — explicit intent wins — and it never
    // inlines a skill body or bypasses the plugin.
    if req.skills.is_empty() && req.plugins.is_empty() && final_prompt == req.prompt {
        if let Some(hint) = crate::skill_router::auto_match_hint(&skill_root, &final_prompt) {
            messages.push(json!({"role": "user", "content": hint}));
        }
    }
    // The Plan-Execute protocol (always-on, main AND sub): the first tool reply
    // must be one `batch` with the whole step — the model-INDEPENDENT
    // round-trip lever. Wire-only (see is_wire_only_context), and pushed BELOW
    // once the tool table is final: a turn without `batch` must not be told to
    // call it.
    // Separate context/autocompact for the explore sub-agent (user request):
    // its message list is compacted against its OWN budget — never the main
    // agent's history or window. An unresolved window follows the same capacity
    // rule (models.dev → provider → DEFAULT_CONTEXT_WINDOW) instead of
    // collapsing to the 4k floor, which used to fold the sub-agent's whole
    // history on its first tool call.
    if req.mode == "subagent" {
        // The window inherited from the parent wins when it is known; otherwise
        // resolve it through the same capacity rule.
        let sub_ctx = if req.context_window > 0 {
            req.context_window as usize
        } else {
            provider_context_window(&req.providers, &req.provider_id, &req.model)
                .unwrap_or(DEFAULT_CONTEXT_WINDOW)
        };
        compact_subagent_messages(&mut messages, sub_ctx);
    }

    let client = http_client();
    emit(&AgentEvent::Status {
        stage: "thinking".into(),
        content: "Contacting model".into(),
    });

    // The explore sub-agent gets the full read/search set; the main agent
    // deliberately has NO search tools and must delegate via `explore`.
    // A PROFILE (plugin `agents/*.md` or a Settings → Sub-agents row) may be
    // granted more than research: when it declares tools, it starts from the
    // whole sub-agent universe and the declaration narrows it. An undeclared
    // profile keeps its kind's classic set, and the builtin `explore` is always
    // read-only — its prompt promises research, never edits.
    //
    // OWNERSHIP: when a reachable Browser Navigator / Desktop Operator exists,
    // that sub-agent OWNS its driver for the turn. The parent then keeps only
    // `agent__<id>`; leaving the direct tools bound made the model choose the
    // shorter path (a traced "open digikala" called `browser_navigate` and the
    // profile never ran). The same id gates the dispatch arm, so a stale or
    // hallucinated direct call is refused with the delegation name.
    let browser_owner = if req.mode == "subagent" {
        None
    } else {
        reachable_subagent_id(
            &req.custom_subagents,
            "browser",
            req.allow_browser,
            req.allow_computer,
        )
    };
    let computer_owner = if req.mode == "subagent" {
        None
    } else {
        reachable_subagent_id(
            &req.custom_subagents,
            "computer",
            req.allow_browser,
            req.allow_computer,
        )
    };
    // Repeat the ownership at the TAIL. The system-prompt list sits before a
    // multi-kilobyte plugin catalog, and the traced failure was exactly a model
    // ignoring it; the last message before the first call is what a weak model
    // actually follows. The block is stable for the turn, so it churns nothing
    // the previous round cached.
    if browser_owner.is_some() || computer_owner.is_some() {
        let mut duty = String::new();
        if let Some(id) = browser_owner.as_deref() {
            duty.push_str(&format!(
                "- The browser is owned by the `{id}` sub-agent. Call `agent__{id}` for any page \
                 work; direct `browser_*` tools are NOT bound and are refused.\n"
            ));
        }
        if let Some(id) = computer_owner.as_deref() {
            duty.push_str(&format!(
                "- The desktop is owned by the `{id}` sub-agent. Call `agent__{id}` for desktop \
                 work; the direct `computer` tool is NOT bound and is refused.\n"
            ));
        }
        if let Some(m) = trailing_context_message(
            "=== SUB-AGENT OWNERSHIP (NOT A NEW REQUEST) ===\n",
            &duty,
        ) {
            messages.push(m);
        }
    }
    let mut schemas = if req.mode == "subagent" {
        let kind = req.subagent_kind.as_deref().unwrap_or("research");
        // A `browser` or `computer` sub-agent additionally binds its driver's
        // schemas. `allow_browser`/`allow_computer` were already gated in
        // `run_subagent` (parent switch AND kind), so reading them here is the
        // single source of truth: no switch-flip can widen a child.
        let add_driver = |tools: &mut Vec<Value>| {
            if kind == "browser" && req.allow_browser {
                tools.extend(crate::browser_driver::actions::entries().into_iter().map(
                    |(name, desc, params)| {
                        serde_json::json!({
                            "type": "function",
                            "function": { "name": name, "description": desc, "parameters": params }
                        })
                    },
                ));
            }
            if kind == "computer" && req.allow_computer {
                tools.push(crate::computer::schema());
                // The desktop is for apps that have NO command line. File
                // creation, conversion and export (pptx/docx/xlsx/pdf, a deck
                // built from data, a document converted to PDF) are ONE
                // `run_terminal` call with python-pptx/soffice — the traced
                // desktop run instead drove the PowerPoint UI for half an hour
                // and shipped nothing. A child with only `computer` + read-only
                // research tools could not even try the CLI: `run_terminal` was
                // not bound, so its two attempts were refused as unknown tools.
                // Bind it whenever the schema table does not already carry it;
                // the parent's caps still gate what the command may do.
                if !tools
                    .iter()
                    .any(|s| s["function"]["name"].as_str() == Some("run_terminal"))
                {
                    tools.extend(
                        crate::agent::schemas::tool_schemas(false, false)
                            .into_iter()
                            .filter(|s| {
                                s["function"]["name"].as_str() == Some("run_terminal")
                            }),
                    );
                }
            }
        };
        // What the builtin `explore` and an undeclared profile run on.
        let mut default_tools = research_schemas();
        add_driver(&mut default_tools);
        let declared = req.subagent_profile && !req.subagent_tools.is_empty();
        if declared {
            // A profile that names tools starts from the WHOLE sub-agent
            // universe, which is what lets a pack's `Bash`/`Edit`/`Write`
            // survive; the declaration then narrows it.
            let mut tools = subagent_schemas();
            add_driver(&mut tools);
            if retain_subagent_tools(&mut tools, &req.subagent_tools) {
                tools
            } else {
                // The list names nothing this sub-agent can run (`Task`,
                // `TodoWrite`, a typo). Keep the kind's default set: zero tools
                // is useless, and the whole work universe would be more reach
                // than the list asked for.
                default_tools
            }
        } else {
            default_tools
        }
    } else {
        // `browser_owner.is_none()` so the direct driver is withheld exactly
        // when the browser sub-agent owns it (see the ownership note above).
        let mut schemas = tool_schemas(
            req.allow_create,
            req.allow_browser && browser_owner.is_none(),
        );
        // Media generation rides ONLY on the main agent's turn: these tools
        // spend the user's provider credit and their results (an inline
        // markdown reference) are meant for the user's chat, not for a
        // sub-agent's research fold. The descriptions embed the slot's
        // DEFAULT model so the model knows what it will hit before calling.
        schemas.extend(media_tool_schemas(&req.image_model, &req.video_model));
        // Every installed sub-agent PROFILE joins the same delegation list as
        // `explore`: one mechanism, so a bundle cannot invent a second kind of
        // sub-agent that misses the depth limit, the model slot or the caps.
        schemas.extend(delegation_schemas(
            std::path::Path::new(&skill_root),
            &req.custom_subagents,
            req.allow_browser,
            req.allow_computer,
        ));
        schemas
    };
    // What the tools may do this turn. A renderer that sends `cap` wins; without
    // it the mode's row is used, so a headless scheduled Ask run is read-only too.
    let caps = req
        .cap
        .clone()
        .unwrap_or_else(|| caps_for_mode(&req.mode));
    // Gate the native set BEFORE the MCP merge below: a connector must not be
    // able to re-introduce a tool the mode forbids (`write_file` through MCP).
    retain_allowed_tools(&mut schemas, &caps, &req.mode);
    // The schedule contract at the SCHEMA level: a headless run has nobody to
    // answer a question or approve an action, so the ask/confirm tools are not
    // even advertised. The in-loop backstop below still auto-answers a stale
    // transcript that calls them anyway — the belt for the suspenders.
    if req.headless {
        schemas.retain(|s| {
            !matches!(
                s["function"]["name"].as_str().unwrap_or(""),
                "ask_user" | "confirm_action" | "request_permission"
            )
        });
    }
    // The plugin door is NOT narrowed by the mode either — same reasoning as
    // `schedule` below. A bundle lives under `~/.codifa/plugins/`, outside the
    // workspace, so `write_files` (the only thing that tells the modes apart)
    // has nothing to say about it. What actually gates authoring is the REQUEST
    // (`allow_create`, "the user asked for a bundle this turn"), already applied
    // to the schema in `tool_schemas` and re-checked on every call in the loop.
    // Narrowing by mode as well is what made an explicit "update the plugin"
    // show only `list`/`run` in a read-only chat and then refuse the call.
    // The authoring TOOLS still vanish outright in a read-only turn —
    // `denied_by_caps` dropped them above.
    // The schedule tool is NOT narrowed by the mode: its store is outside the
    // workspace, so a read-only turn may still create/update/toggle/delete a
    // task — "[Schedule: update …]" typed in Ask must work. Only an UNATTENDED
    // run narrows to list (nobody to approve a change there); the in-loop
    // backstop splits on the same flag.
    if req.headless {
        compact_schedule_schema(&mut schemas);
    }
    // MCP connectors switched on in the composer become extra tools named
    // `mcp__<server>__<tool>`; their schemas come from each server's
    // tools/list. An ENABLED plugin's connectors ride along without the user
    // adding each one in Settings → MCP: a plugin is ONE unit, so its connectors
    // come with its skills (scheduled runs already resolved them that way, so a
    // plugin that was "on" looked half-applied in a chat turn). A name the user
    // configured themselves wins over the bundle's.
    // A connector that fails to start contributes no tools — but the reason is
    // surfaced as a warning, so "the agent has no browser tool" is never a
    // silent mystery again.
    let mcp_servers = {
        let mut merged = crate::plugins::enabled_connectors(std::path::Path::new(&skill_root));
        if let Some(own) = req.mcp_servers.as_object() {
            for (name, cfg) in own {
                merged.insert(name.clone(), cfg.clone());
            }
        }
        Value::Object(merged)
    };
    // LAZY. Discovering the connectors is still needed every turn (the index
    // must name what is switched on), but their SCHEMAS are no longer inlined:
    // measured on a real trace, one enabled Proxmox connector shipped 391 tool
    // schemas (~59K tokens) on the FIRST call of a turn the user never asked to
    // touch Proxmox in. See `mcp_index` for the whole story.
    let discovered = crate::mcp::discover(&mcp_servers);
    for failure in discovered.failures {
        emit(&AgentEvent::Warn { content: failure });
    }
    let connectors = discovered.index;
    // Deferred schemas, filtered ONCE here so activation later is a cheap split
    // rather than a second round of name collision work. Two filters, applied in
    // the order the eager path applied them:
    //  1) a connector tool may not shadow a native name (native always wins);
    //  2) a connector is not a way around the mode gate.
    let native_names: std::collections::HashSet<String> = schemas
        .iter()
        .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
        .collect();
    let mut deferred = discovered.schemas;
    deferred.retain(|s| {
        s["function"]["name"]
            .as_str()
            .map(|n| !native_names.contains(n))
            .unwrap_or(false)
    });
    retain_allowed_tools(&mut deferred, &caps, &req.mode);
    // THE INDEX. A connector that is switched on but unused costs one prompt
    // line instead of its whole catalogue. The model reaches it through
    // `use_mcp`, which activates the connector for the rest of the turn.
    if req.mode != "subagent" {
        let index = crate::mcp_index::index_section(&connectors);
        if !index.is_empty() {
            system.push_str(&index);
        }
    }
    // A server name the turn declares it needs BEFORE the loop: the renderer
    // echoes back whatever `use_mcp` loaded in earlier turns, so a connector is
    // asked for ONCE per chat instead of once per turn. It is resolved here,
    // before the first model call, because the tool array must stay
    // byte-identical across the rounds of one turn or the prefix cache collapses
    // from round 2 (see `tool_schemas_serialize_byte_identically`).
    let mut activated: std::collections::HashSet<String> = req
        .mcp_active
        .iter()
        // A connector switched OFF since it was activated must not come back:
        // the enabled map is the source of truth, so activation is intersected
        // with it rather than trusted on its own.
        .filter(|s| connectors.iter().any(|c| &c.server == *s))
        .cloned()
        .collect();
    // An ATTACHED plugin is already a loaded toolbox: its connectors come with
    // its skills, so they are advertised from the FIRST request instead of
    // waiting for `use_mcp`. The trailing ACTIVE PLUGIN note promises exactly
    // that, and a deferred schema would make the promise false.
    for name in crate::plugins::mcp_of(std::path::Path::new(&skill_root), &req.plugins).keys() {
        if connectors.iter().any(|c| &c.server == name) {
            activated.insert(name.clone());
        }
    }
    // Append the schemas of everything activated so far. `deferred` was filtered
    // once above, so this is a partition, not a second collision pass.
    if !activated.is_empty() {
        let active: Vec<Value> = deferred
            .iter()
            .filter(|s| {
                s["function"]["name"]
                    .as_str()
                    .and_then(|n| crate::mcp_index::owner_of(&connectors, n))
                    .map(|owner| activated.contains(owner))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        schemas.extend(active);
    }
    // Desktop control is a hard on/off switch (composer → Computer Use): when
    // it is off the tool is never bound, so the model cannot even try.
    // The name is checked first because this push happens AFTER the MCP filter:
    // a connector exposing a tool literally named `computer` would otherwise
    // collide and the model would see the same name on two rows.
    if req.allow_computer && req.mode != "subagent" && computer_owner.is_none() {
        let taken = schemas
            .iter()
            .any(|s| s["function"]["name"].as_str() == Some("computer"));
        if !taken {
            schemas.push(crate::computer::schema());
        }
    }
    // Final guard: the model must never be advertised the same tool name twice.
    // Two rows sharing one name made the UI render duplicate tool cards (`read`
    // four times, `read_client` twice) and left the model guessing which schema
    // to follow. The FIRST occurrence wins — a native tool outranks a connector.
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        schemas.retain(|s| {
            s["function"]["name"]
                .as_str()
                .map(|n| seen.insert(n.to_string()))
                .unwrap_or(false)
        });
    }
    // The exact tool names this run advertised. A call to any other name is a
    // hallucination (a traced explore called a non-existent `read_client` 75
    // times, every one failing) — the error lists the real names so the model
    // self-corrects instead of retrying the same bad name.
    let mut advertised: Vec<String> = schemas
        .iter()
        .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
        .collect();
    advertised.sort();
    advertised.dedup();

    // What this turn really has bound. Every batching lever is gated on it, so a
    // `browser`/`computer` child or a profile narrowed by its own declaration
    // (`retain_subagent_tools`) is never told to call a tool it does not carry —
    // that instruction used to cost the whole round to the refusal.
    let batch_caps = super::subagent::BatchCapability::from_advertised(&advertised);
    // The Plan-Execute protocol rides the TAIL, once the tool table is final: the
    // directive must name only tools that exist here, and a turn without `batch`
    // gets none at all. Wire-only (see is_wire_only_context).
    if let Some(protocol) = super::subagent::batch_protocol_message(&batch_caps) {
        messages.push(protocol);
    }

    // Trace: the full system prompt of this turn, plus the serialized size of
    // the tool array that rides along on EVERY model call of the turn. The tool
    // schemas are a fixed per-round-trip cost, so they are measured here where
    // they are final — otherwise "the schemas are getting expensive" is a guess
    // rather than a number.
    let tools_chars = serde_json::to_string(&schemas)
        .map(|s| s.chars().count())
        .unwrap_or(0);
    trace.record(crate::trace::TraceEntry {
        kind: "prompt".into(),
        summary: format!(
            "prompt · {} chars · tools {} chars · {} tools",
            system.len(),
            tools_chars,
            schemas.len()
        ),
        prompt: Some(system.clone()),
        detail: Some(json!({
            "system_chars": system.len(),
            // The plan/checklist section is NOT part of `system` any more: it is
            // injected as a trailing message. Recorded separately so the ruler
            // can tell "the system prompt shrank" apart from "the section was
            // dropped", and so its size stays visible at all.
            "plan_chars": main_plan_section.len(),
            "tools_chars": tools_chars,
            "tools": schemas.len(),
            // WHOSE prompt this is. The ruler used to guess from the prompt's
            // first words ("You are Codifa" / "You are the explore sub-agent"),
            // but the app passes its own mode prompt via `req.system_prompt`,
            // whose text starts differently — so every app-driven main turn was
            // silently dropped and a file with four distinct main prefixes
            // reported "1 turn-prompt(s) · byte-stable 0/0". Record the truth
            // instead of guessing it downstream.
            "mode": req.mode,
        })),
        ..Default::default()
    });

    // No step cap for a sub-agent either: a hard budget cut traced browser
    // runs off mid-list and handed the parent `[Tool budget exhausted]` dumps
    // instead of an answer. The idle guard and the attempt ladder bound a
    // genuinely wedged provider; a healthy run finishes its task first.
    let max_steps = usize::MAX;
    // Lookups already executed in THIS turn. A repeat of the same read window
    // or grep is pure waste — the payload is already in the context above —
    // and the explore prompt forbids it, yet a traced run re-read three files
    // in round 3 that round 1 had returned and repeated a refused grep.
    let mut seen_lookups: std::collections::HashSet<String> = std::collections::HashSet::new();
    // A new turn starts a NEW transcript: the definition map of a large file is
    // worth re-sending once (nothing above carries it yet) but never twice in
    // the same turn.
    crate::tools::reset_outline_claims();
    // Files read or path-scoped-grepped EARLIER IN THIS STEP — the batch phase
    // always runs before the sequential writers, so a writer landing on one of
    // these has just invalidated the copy the model is quoting (traced: 4
    // failed edits off one pre-edit grep, run=106). Stamped via
    // `POST_EDIT_STALE_NOTE` below.
    let mut step_read_files: Vec<String> = Vec::new();
    // The turn's out-of-workspace reach: the renderer's own grants, WIDENED in
    // place whenever the user approves a new folder below. Built once, OUTSIDE
    // the step loop, so a grant given in round 3 is not asked for again in
    // round 4 — and so a whole round is never spent discovering that the
    // workspace, /tmp and ~/.codifa are already open.
    let mut permit = outside_permit(req);
    // First snapshot of every file this turn edited (path -> content BEFORE the
    // turn's first edit of it). Every later edit of the same file is diffed
    // against it too, so the Review panel can show the NET change of the turn
    // (what `git diff` would show) rather than the sum of each intermediate edit.
    let mut turn_base: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // Mid-turn auto-compaction state. `compact_rounds` bounds how many times a
    // single turn may fold its history (a turn can run MAX_STEPS tool calls, so
    // folding must be possible while the agent works — but the summarizer must
    // not thrash either).
    let mut compact_rounds: usize = 0;
    // Prompt tokens the provider reported for the LAST round-trip of this turn.
    // This is the baseline of the mid-turn auto-compaction trigger: the fold
    // fires once the measured prompt (baseline + what this turn appended, or a
    // local estimate before any usage arrives) crosses the threshold. 0 = the
    // provider has not reported usage yet this turn (fall back to the local
    // estimate alone).
    let mut last_prompt_tokens: usize = 0;
    // Index into `messages` up to which `last_prompt_tokens` describes the
    // prompt. Everything the turn appends AFTER the measured round-trip
    // (assistant tool calls, tool results, steers — all pushed at the end, so
    // indices stay stable) is counted as a local delta on top of the provider's
    // number. Measuring `max(provider, local_estimate)` instead let the crude
    // serde-JSON estimate (which bills inline base64 images as text) fire the
    // fold long before the meter reached the user's threshold.
    let mut measured_upto: usize = 0;
    // The context window this turn actually measures against. Resolved ONCE so
    // the compaction trigger and the number reported to the renderer (the
    // context meter's denominator) can never disagree.
    let effective_ctx = effective_context_window(req);

    // Single-call hints delivered so far this run. The hint rides on an
    // already-sent tool result, so it produced no row of its own and the lever
    // was invisible in the trace: whether it fired had to be inferred from
    // round counts. One counter makes "did the nudge reach the model" a fact.
    let mut nudges: usize = 0;
    // How many lone-call batching hints ONE turn may deliver. The lesson is
    // short; the history bill of repeating it is not (see the delivery site).
    const MAX_LONE_CALL_HINTS_PER_TURN: usize = 2;
    // Consecutive rounds this turn spent ONLY on locating/reading. Traced on the
    // live corpus, the main agent ran 91 discovery streaks, 31 of them 3 rounds
    // or longer, and the 169 rounds past the third cost 1_548_556 uncached
    // tokens — the single largest addressable block left, because a streak that
    // long is exactly the "how is this area wired up" question `explore` exists
    // for (its own 17 long streaks cost 303_316). The counter drives a nudge
    // that fires at the streak boundary only, so it cannot become wallpaper the
    // way the per-round single-call hint did (423 of 863 rounds carried it and
    // it changed nothing).
    let mut discovery_streak: usize = 0;
    // How many discovery rounds a turn may spend before further greps/globs
    // are rerouted to ONE explore delegation (see the classification gate).
    const DISCOVERY_DELEGATE_THRESHOLD: usize = 4;
    // Consecutive rounds whose ONLY call was a mutating/serial tool
    // (`run_terminal`, `edit_file`, …). The per-round batching hint fired on
    // every one of them and was measured as wallpaper (16 firings, 0 batches in
    // one fresh chat), so it now escalates off this counter instead of repeating.
    let mut lone_mutating_rounds: usize = 0;
    // Hints delivered by the ESCALATING lone-call lever alone. `nudges` counts
    // every hint including the discovery-streak one, so it could not answer
    // whether this lever fired (traced: it climbed on rounds the model had
    // actually batched). Kept separate so the trace measures one lever per row.
    let mut lone_call_hints: usize = 0;
    // Assistant prose this turn produced BEFORE its last round. Plan mode saves
    // the plan document at the end of the turn, and the plan is written in an
    // early round (read → plan text → update_plan) while the FINAL round often
    // carries only a closing note ("the plan is saved, switch to Build"). Saving
    // just the last round's text made plan.md a one-line summary — the panel had
    // nothing real to show. Kept in order, one entry per round, so
    // `plans::plan_text` can pick the rounds that carry the plan.
    let mut prior_text: Vec<String> = Vec::new();
    // A plan-mode turn that saved the plan as a markdown ARTIFACT: the body
    // never appears in `prior_text` (it rides on the tool call), so without
    // this the end-of-turn save kept only the closing summary as plan.md.
    // Only a plan-named artifact qualifies (see plan_document_from_artifact).
    let mut plan_artifact: Option<(String, String)> = None;
    // The main-agent wrap-up nudge is delivered once per turn (see
    // `main_wrapup_message`); the flag keeps a later step from re-sending it.
    let mut wrapup_delivered = false;
    // Desktop control is approved per TASK, not per mouse action: the first
    // direct `computer` call this turn asks (the card states the act), and an
    // allow covers the rest of the turn. Delegated desktop work has its own
    // gate at the delegation boundary in `run_subagent`, where the model
    // supplies a real reason; this latch is never set by that path.
    let mut desktop_approved = false;
    // Wall-clock budget for a SUB-AGENT attempt (see
    // `context::subagent_budget_secs`). The idle guard only catches silence;
    // this bounds a child that is busy but making no progress. `None` for a
    // normal turn — the user is present and can stop it.
    let turn_started = std::time::Instant::now();
    let sub_budget = (req.mode == "subagent")
        .then(|| crate::agent::context::subagent_budget_secs(
            req.subagent_kind.as_deref().unwrap_or("research"),
        ));
    let mut budget_nudged = false;
    // Digest of the last DISTINCT screenshot the model was sent. A mutating
    // computer action always captures the screen it changed, so a no-op action
    // produced a byte-identical PNG that was re-encoded and re-billed on every
    // following round. `None` until the first capture.
    let mut last_shot_digest: Option<u64> = None;
    // Digests of the last few rounds (tool calls + results + screenshot pixels).
    // A repeated digest means the same calls returned the same bytes: the child
    // is looping, not working. See the guard at the end of the loop.
    let mut round_hashes: Vec<u64> = Vec::new();
    let mut stall_nudges = 0usize;
    // How many times ONE exact call (name + raw args) has been issued this turn.
    // The round digest only catches a loop whose RESULT also repeats; a desktop
    // loop like `command+tab` changes the screen every round, so it looked like
    // progress. A per-action ceiling catches it regardless of the result.
    let mut action_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut repeated_action_nudged: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    // Consecutive rounds whose EVERY call named a tool that does not exist.
    let mut invalid_rounds = 0usize;
    for step in 0..max_steps {
        // Drain any mid-turn steer BEFORE this model call: the steer is appended
        // as an extra user message, so the model keeps the whole conversation
        // (every prior tool result and the original task) above it — a steer
        // refines the running work instead of restarting from the steer alone.
        // This fixes "steering made it forget everything and only do the steered
        // message, abandoning the work in progress".
        deliver_steers(&mut messages, steer_chat, emit);
        // Client disconnect (Stop button closes the SSE stream) flips the
        // cancel flag — bail out instead of burning provider tokens.
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            // The cancel flag is raised by Stop OR by the router noticing the SSE
            // receiver is gone; the renderer cannot tell the two apart, so log it.
            if req.mode != "subagent" {
                eprintln!("[turn-end] chat={} cancel flag set before step {}", req.chat_id, step + 1);
            }
            // A steer that arrived together with the Stop still belongs to the
            // user: hand it back so the renderer re-sends it as the next turn.
            drop_steers(steer_chat, emit);
            emit(&AgentEvent::Done { aborted: true });
            return Ok(());
        }
        // Sub-agent wall-clock budget. The idle guard in `run_subagent` only
        // fires on SILENCE; a child that keeps emitting events (the traced
        // desktop run: 56× `command+tab`, 165 LLM calls, 1_851 s) never trips
        // it. At the soft mark the child is told to stop exploring and report;
        // at the hard mark the loop breaks and the end-of-turn path below asks
        // for a final tools-off report, so the parent still receives the
        // evidence instead of a dead card. This is not a step cap: a child that
        // is genuinely progressing gets its full window.
        if let Some((soft, hard)) = sub_budget {
            let elapsed = turn_started.elapsed().as_secs();
            if elapsed >= hard {
                break;
            }
            if elapsed >= soft && !budget_nudged {
                budget_nudged = true;
                messages.push(json!({
                    "role": "user",
                    "content": format!(
                        "=== TIME BUDGET ===\n{elapsed}s of this sub-agent's window are used. \
Stop exploring and finish: use the results you already have and write the final report in \
your next reply. Do not start another search or another GUI flow unless it is required to \
answer the task."
                    ),
                }));
            }
        }
        // Wrap-up nudge (main agent only), once, a few steps before the cap.
        // Traced Oct 29: three of twenty runs hit MAX_STEPS and were cut with
        // `finish_reason: tool_calls` on every round — the turn ended mid-work
        // with no final answer, and the user's follow-up message re-read the
        // whole context just to continue. The nudge is a tail append (cache
        // safe) and asks for a clean stop, mirroring the sub-agent nudges.
        if let Some(text) = main_wrapup_message(step, max_steps, wrapup_delivered, req.mode.as_str())
        {
            wrapup_delivered = true;
            messages.push(json!({ "role": "user", "content": text }));
        }

        // --- In-turn stale-result elision -----------------------------------
        // The main agent re-sends the whole wire history on EVERY round-trip.
        // Old tool results (a 40K explore report from round 2 is still there
        // at full size in round 10) are the bulk of that re-send; traces show
        // in:out ratios of 23-47:1 on the main agent. Shrink them in place,
        // keeping the last MAIN_FOLD_KEEP_ROUNDS rounds untouched — the model
        // is actively reasoning over those. Below MAIN_FOLD_MIN_TOKENS the
        // whole thing is a no-op: short turns pay nothing.
        //
        // Two gates besides the token threshold (both traced on the 12:44 run,
        // where a 226-token fold re-billed the whole 40K cached prefix):
        // - `fold_pays_off`: no fold once too few model calls remain to reuse
        //   the savings — the same rule the sub-agent fold already honours.
        // - `MAIN_FOLD_MIN_REMOVAL`: a fold rewrites an EARLY result, so the
        //   cache breaks at that depth and everything after it re-bills at
        //   miss price. When the removal is a few hundred tokens, the reset
        //   costs an order of magnitude more than the fold saves — so the
        //   fold is DRY-RUNNED on a clone and only applied when the removal
        //   clears the floor.
        // The OVERSIZED pass runs FIRST and WITHOUT the turn gate: one stale
        // 16K `read` (~4K tokens) on a mid-size turn rode every following
        // round because the whole-prompt gate never reached 20K (traced 6 Nov:
        // read results were 56-75% of all tool-result characters the model
        // received). Same probe/floor economics as the gated fold — the pass
        // is only APPLIED when its removal clears MAIN_FOLD_MIN_REMOVAL, and
        // only while enough calls remain to reuse the saving.
        let wire_est = estimate_wire_tokens(&messages[1..]);
        // Cheap pre-filter BEFORE the probe clone (which copies the whole
        // history): a `tool` result can only fold when its text beats the
        // oversized floor, and bytes >= chars makes this filter impossible to
        // drop a true positive (the probe re-measures exactly).
        let has_oversized = messages.iter().any(|m| {
            m["role"] == "tool"
                && m["content"]
                    .as_str()
                    .is_some_and(|c| c.len() > FOLD_OVERSIZED_RESULT_CHARS && !c.contains(MAIN_FOLD_MARKER))
        });
        if req.mode != "subagent" && has_oversized && fold_pays_off(max_steps - step) {
            let mut probe = messages.clone();
            let mut probe_seen = seen_lookups.clone();
            let (probe_chars, folded) = fold_oversized_search_results(
                &mut probe,
                &mut probe_seen,
                MAIN_FOLD_KEEP_ROUNDS,
            );
            let probe_tokens = probe_chars.div_ceil(4);
            if folded > 0 && probe_tokens >= MAIN_FOLD_MIN_REMOVAL {
                let (removed, folded) = fold_oversized_search_results(
                    &mut messages,
                    &mut seen_lookups,
                    MAIN_FOLD_KEEP_ROUNDS,
                );
                record_fold(
                    &trace,
                    "main-oversized",
                    step,
                    step + 1,
                    (max_steps != usize::MAX).then(|| max_steps - step),
                    wire_est,
                    removed,
                    folded,
                );
            }
        }
        if req.mode != "subagent"
            && wire_est >= MAIN_FOLD_MIN_TOKENS
            && fold_pays_off(max_steps - step)
        {
            let before = wire_est;
            // The probe runs on clones of BOTH arguments: `fold_with` also
            // mutates `seen` (it retains/removes the lookups it folds), so
            // handing it the live set would corrupt the dedup state even when
            // the fold ends up rejected.
            let mut probe = messages.clone();
            let mut probe_seen = seen_lookups.clone();
            let (probe_chars, folded) =
                fold_stale_tool_results(&mut probe, &mut probe_seen);
            // `fold_with` reports CHARACTERS (that is what it removes from the
            // wire text), while the floor is in TOKENS — the same ~4 chars per
            // token estimate `record_fold` uses below. Comparing the raw char
            // count against a TOKEN floor was a 4x unit error: it let a
            // 1_947-token fold through (traced 01:09:58 on the 01:00 build,
            // `folded=2 removed_tokens_est=1947`) where the floor meant to
            // refuse everything under 4_000 tokens.
            let probe_tokens = probe_chars.div_ceil(4);
            if folded > 0 && probe_tokens >= MAIN_FOLD_MIN_REMOVAL {
                let (removed, folded) =
                    fold_stale_tool_results(&mut messages, &mut seen_lookups);
                record_fold(
                    &trace,
                    "main",
                    step,
                    step + 1,
                    (max_steps != usize::MAX).then(|| max_steps - step),
                    before,
                    removed,
                    folded,
                );
            } else if folded > 0 {
                emit(&AgentEvent::Warn {
                    content: format!(
                        "[fold] skipped: removal {probe_tokens} tok < {MAIN_FOLD_MIN_REMOVAL} floor — a prefix-cache reset would cost more than it saved"
                    ),
                });
            }
        }
        // Same elision for the explore sub-agent, on its own (much smaller)
        // budget. Its compaction only runs ONCE, before this loop, so without
        // this every round re-sent every read/grep the run had already made —
        // which is why explore input per call sits far above its window share.
        //
        // `fold_pays_off` skips the fold near the end of a run: measured over 85
        // real folds, the 31 that happened with 3 or fewer calls left were ALL
        // net losses (every one of them, -172_630 tokens total) because the
        // prompt shrank but no call remained to reuse it, while the cache reset
        // was still paid in full. See FOLD_MIN_REMAINING_CALLS.
        if SUB_FOLD_ENABLED
            && req.mode == "subagent"
            && estimate_wire_tokens(&messages[1..]) >= SUB_FOLD_MIN_TOKENS
            && fold_pays_off(max_steps - step)
        {
            let before = estimate_wire_tokens(&messages[1..]);
            // Same floor as the main path, for the same reason: a fold rewrites
            // an EARLY result, so the prefix cache breaks at that depth and
            // everything after it re-bills at miss price. Traced on the r5/r7
            // explorations: the sub-agent path had NO floor here, so a removal
            // of a few hundred tokens reset the whole cached prefix and the
            // round after it dropped to a 30-45% hit rate. Dry-run on clones of
            // BOTH arguments (`fold_with` also mutates `seen`).
            let mut probe = messages.clone();
            let mut probe_seen = seen_lookups.clone();
            let (probe_chars, folded) =
                fold_subagent_tool_results(&mut probe, &mut probe_seen);
            let probe_tokens = probe_chars.div_ceil(4);
            if folded > 0 && probe_tokens >= MAIN_FOLD_MIN_REMOVAL {
                let (removed, folded) = fold_subagent_tool_results(&mut messages, &mut seen_lookups);
                record_fold(&trace, "explore", step, step + 1, (max_steps != usize::MAX).then(|| max_steps - step), before, removed, folded);
            }
        }
        // The sub-agent's OWN oversized pass — same shape as the main one: an
        // explore run's older reads ARE its bulk input (its whole history is
        // re-sent every round), and its turn gate is the same 20K whole-prompt
        // threshold that mid-size runs never reach. Reports (explore results)
        // are excluded here the same way — the run's report is its deliverable.
        if SUB_FOLD_ENABLED
            && req.mode == "subagent"
            && fold_pays_off(max_steps - step)
        {
            let has_oversized = messages.iter().any(|m| {
                m["role"] == "tool"
                    && m["content"]
                        .as_str()
                        .is_some_and(|c| c.len() > FOLD_OVERSIZED_RESULT_CHARS && !c.contains(MAIN_FOLD_MARKER))
            });
            if has_oversized {
                let before = estimate_wire_tokens(&messages[1..]);
                let mut probe = messages.clone();
                let mut probe_seen = seen_lookups.clone();
                let (probe_chars, folded) = fold_oversized_search_results(
                    &mut probe,
                    &mut probe_seen,
                    SUB_FOLD_KEEP_ROUNDS,
                );
                let probe_tokens = probe_chars.div_ceil(4);
                if folded > 0 && probe_tokens >= MAIN_FOLD_MIN_REMOVAL {
                    let (removed, folded) = fold_oversized_search_results(
                        &mut messages,
                        &mut seen_lookups,
                        SUB_FOLD_KEEP_ROUNDS,
                    );
                    record_fold(
                        &trace,
                        "explore-oversized",
                        step,
                        step + 1,
                        (max_steps != usize::MAX).then(|| max_steps - step),
                        before,
                        removed,
                        folded,
                    );
                }
            }
        }

        // --- Mid-turn auto-compaction ---------------------------------------
        // The context can blow past the model's window DURING a turn: this loop
        // runs up to MAX_STEPS tool calls and every result is appended to
        // `messages`. Waiting for the next turn (the frontend-only behaviour)
        // meant a long turn kept growing until the provider hard-failed with
        // "context length exceeded". Fold the older part of the history here,
        // between model calls, so the running turn keeps a working context.
        // Only the main agent compacts: the explore sub-agent has its own
        // separate budget (compact_subagent_messages, run before the loop).
        if req.mode != "subagent" && compact_rounds < MAX_COMPACTIONS_PER_TURN {
            let ctx = effective_ctx;
            let threshold = ctx * req.compact_at_percent.clamp(1, 99) as usize / 100;
            // Measure what the provider actually bills as `prompt_tokens`: the
            // system prompt, the tool schemas and the whole wire history — not
            // just the history `content`. The content-only estimate misses the
            // fixed per-request overhead (system + schemas) and is additionally
            // capped by the in-turn elision above, so on a long turn it plateaus
            // well below the real prompt size and the trigger never fires even
            // when the context meter is far past the threshold ("mid-turn
            // auto-compact never fires at 20%"). When the provider reported
            // usage on the previous round-trip its number is ground truth — it
            // already includes system + schemas + tool-call arguments, so the
            // trigger and the meter agree.
            let measured = measured_prompt_tokens(
                &messages,
                tools_chars,
                measured_upto,
                last_prompt_tokens,
            );
            // messages[0] is the system prompt; the wire history is the rest.
            let fold_at = fold_prefix_len(&messages[1..]);
            if fold_at > 0 && measured >= threshold {
                compact_rounds += 1;
                // The provider number described the PRE-fold prompt; clear it so
                // the next round-trip re-measures instead of re-triggering.
                last_prompt_tokens = 0;
                measured_upto = 0;
                let older: Vec<Value> = messages[1..1 + fold_at].to_vec();
                let tail: Vec<Value> = messages[1 + fold_at..].to_vec();
                // The summarizer may be routed to the user's "compact" Tool
                // Models slot (empty entry = the active chat model), exactly
                // like the manual /chat/compact path.
                // The effective slot provider id is unused here: the in-turn
                // fold emits usage via the chat's own accounting path, not the
                // manual-compact usage event.
                let (slot_model, slot_base, slot_keys, slot_provider_id) = crate::backend_light::resolve_slot_target(
                    crate::backend_light::other_slot_entry(&req.subagent_models),
                    &cfg.model,
                    &cfg.base_url,
                    &cfg.api_keys,
                    &req.provider_id,
                    &req.providers,
                );
                let _ = &slot_provider_id;
                // The "Other" group's own fallback list (Settings → Tools): the
                // summariser's OWN models, top to bottom. Resolved through the
                // same chain helper as the other tools, so a cross-provider
                // fallback brings its own base URL / keys / endpoint kind.
                let fallback_rungs: Vec<(String, String, Vec<String>, String, String)> =
                    crate::backend_light::resolve_slot_chain(
                        crate::backend_light::other_slot_entry(&req.subagent_models),
                        crate::backend_light::other_slot_fallbacks(&req.tool_fallbacks),
                        &cfg.model,
                        &cfg.base_url,
                        &cfg.api_keys,
                        &req.provider_id,
                        &cfg.provider,
                        &req.providers,
                    )
                    .into_iter()
                    .skip(1)
                    .collect();
                // The summarizer may carry its own reasoning level; an empty
                // entry inherits the main model's level for this turn.
                let compact_level = crate::backend_light::other_slot_level(&req.subagent_thinking);
                let (compact_reasoning, compact_model_reasoning, compact_auto_think) =
                    crate::llm::reasoning_fields(
                        &cfg.provider,
                        &crate::llm::level_from_source(
                            provider_model_thinking_levels(
                                &req.providers,
                                &slot_provider_id,
                                &slot_model,
                            )
                            .as_deref(),
                            // Missing slot level = OFF (never inherit the main
                            // level): a side-task call's default is no reasoning.
                            if compact_level.is_empty() {
                                "none"
                            } else {
                                compact_level
                            },
                        ),
                        req.model_reasoning,
                    );
                let compact_model = LlmConfig {
                    provider: cfg.provider.clone(),
                    headers: crate::llm::custom_headers(&req.providers, &slot_provider_id),
                    provider_id: slot_provider_id.clone(),
                    model: slot_model.clone(),
                    base_url: slot_base,
                    api_keys: slot_keys,
                    temperature: Some(0.2),
                    max_tokens: Some(COMPACT_MAX_OUTPUT as u32),
                    // A side call keeps a real timeout: a hung summarizer must
                    // not freeze the turn it is trying to shrink.
                    timeout_secs: COMPACT_TIMEOUT_SECS,
                    reasoning_level: compact_reasoning.clone(),
                    model_reasoning: compact_model_reasoning,
                    auto_think: compact_auto_think,
                };
                // Fallback = the "Other" slot's own fallback rungs (Settings →
                // Tools, each carrying its own routing but the slot's reasoning
                // level), in the user's order — and NOTHING else. The chat model
                // used to be appended as a last resort, which meant the run
                // ignored an empty fallback list and spent the turn on a model
                // the user never picked for this tool.
                let compact_fallbacks: Vec<LlmConfig> = fallback_rungs
                    .iter()
                    .map(|(m, b, keys, pid, k)| LlmConfig {
                        provider: k.clone(),
                        headers: crate::llm::custom_headers(&req.providers, pid),
                        provider_id: pid.clone(),
                        model: m.clone(),
                        base_url: b.clone(),
                        api_keys: keys.clone(),
                        temperature: Some(0.2),
                        max_tokens: Some(COMPACT_MAX_OUTPUT as u32),
                        timeout_secs: COMPACT_TIMEOUT_SECS,
                        reasoning_level: crate::llm::level_from_source(
                            provider_model_thinking_levels(&req.providers, pid, m).as_deref(),
                            &compact_reasoning,
                        ),
                        model_reasoning: provider_model_reasoning(&req.providers, pid, m),
                        auto_think: crate::models::auto_think_for(k),
                    })
                    .collect();
                emit(&AgentEvent::CompactStart {});
                // Bind the result first: a temporary closure borrowing `emit`
                // would otherwise stay alive across the whole `match` and block
                // the `Compact`/`CompactFailed` emissions in its arms.
                let compact_result = crate::compact::compact_history_with_progress(
                    &client,
                    &compact_model,
                    compact_fallbacks.as_slice(),
                    &older,
                    ctx,
                    COMPACT_MAX_OUTPUT,
                    true,
                    // `summarize_all`: this caller rebuilds the wire from the
                    // returned summary plus its own in-flight tail ONLY — it
                    // never splices a verbatim tail back. Letting compact.rs
                    // exclude its 40% tail from the summary dropped that tail
                    // from BOTH the summary and the wire (traced Oct 29: a
                    // compaction at 64.8K tokens left the newest ~40% of the
                    // work history in neither, and the model paid extra
                    // round-trips re-reading what it had already read). Every
                    // foldable message must therefore reach the summarizer.
                    true,
                    &mut |p: &crate::compact::CompactProgress| {
                        emit(&AgentEvent::CompactProgress {
                            phase: p.phase.to_string(),
                            attempt: p.attempt,
                            attempts: p.attempts_total,
                            model: p.model.clone(),
                            provider_id: p.provider_id.clone(),
                            percent: p.percent,
                            budget_secs: p.budget_secs,
                            elapsed_secs: p.elapsed_secs,
                        });
                    },
                )
                .await;
                match compact_result
                {
                    Ok(Some(out)) if !out.summary.trim().is_empty() => {
                        // Keep the marker opencode/compact.rs uses so a later
                        // fold MERGES this summary instead of stacking a second
                        // heading — and so the model reads it as a checkpoint.
                        let mut summary_text = out.summary.trim().to_string();
                        if !summary_text
                            .to_lowercase()
                            .starts_with("[compacted earlier context]")
                        {
                            summary_text =
                                format!("[Compacted earlier context]\n\n{summary_text}");
                        }
                        // Rebuild the conversation: system + summary + the
                        // verbatim tail. The tail always starts at an assistant
                        // entry (see fold_prefix_len), so every `tool` result
                        // stays with the call that produced it.
                        let mut next: Vec<Value> = Vec::with_capacity(tail.len() + 2);
                        next.push(messages[0].clone());
                        next.push(json!({"role": "user", "content": summary_text}));
                        next.extend(tail.iter().cloned());
                        messages = next;
                        // The summarized `older` half is no longer on the wire,
                        // so every lookup it answered is unreachable now. The
                        // repeat-guard must FORGET them: a later read of a file
                        // the summary swallowed would otherwise be answered with
                        // a pointer to text the model can no longer see (silent
                        // data loss), and the coverage entries of my read-merge
                        // lever have exactly the same obligation.
                        seen_lookups.clear();
                        // `keep` is the renderer's fold instruction: it keeps the
                        // last N non-system messages verbatim and folds the rest,
                        // so the next turn stops re-sending what the summary
                        // already covers. `plan_context_keep` drops the wire-only
                        // plan message from that count (see its doc).
                        let keep = plan_context_keep(&tail);
                        emit(&AgentEvent::Compact {
                            content: summary_text,
                            keep,
                            usage: out.usage,
                        });
                        // Trace the fold so a later token audit can join it
                        // against the `llm` rows around it (the same contract
                        // `record_fold` serves for the in-turn elision). A
                        // compaction used to leave NO trace row at all: the only
                        // evidence was the summary bubble in the UI, so its
                        // re-bill was indistinguishable from a provider-side
                        // cache miss.
                        let after_est = estimate_prompt_tokens(&messages, tools_chars);
                        trace.record(crate::trace::TraceEntry {
                            kind: "compact".into(),
                            summary: format!(
                                "mid-turn compact: {} msg(s) folded, ~{} tok in, ~{} tok out",
                                older.len(),
                                measured,
                                after_est
                            ),
                            detail: Some(serde_json::json!({
                                "step": step + 1,
                                "folded_messages": older.len(),
                                "kept_messages": tail.len(),
                                "before_tokens_est": measured,
                                "after_tokens_est": after_est,
                                "summarize_all": true,
                            })),
                            ..Default::default()
                        });
                    }
                    Ok(_) => {
                        // Nothing foldable — keep the history as it is. Not an
                        // error: the turn continues either way.
                        emit(&AgentEvent::CompactFailed {
                            content: "nothing to compact".into(),
                        });
                    }
                    Err(e) => {
                        // NOTHING was dropped: the turn continues with the full
                        // history, and the renderer surfaces a retry banner.
                        emit(&AgentEvent::CompactFailed { content: e });
                    }
                }
            }
        }
        // stream_chat accumulates text/tool_calls itself; the single sink below
        // forwards the live signals to the SSE stream (text deltas plus the
        // thinking-state transitions the "Thinking" pill is driven by).
        let mut sink = |sig: StreamSignal| match sig {
            StreamSignal::Text(delta) => {
                if !delta.is_empty() {
                    emit(&AgentEvent::Text {
                        content: delta.to_string(),
                    });
                }
            }
            // The model started (or stopped) producing reasoning content. The
            // pill swaps "Working" for "Thinking", so a long reasoning pass no
            // longer looks like a frozen turn.
            StreamSignal::Thinking(active) => {
                emit(&AgentEvent::Thinking { active });
            }
        };
        // A hint only matters for the NEXT step: every older copy rides the whole
        // conversation on every later round trip for nothing (measured: 26
        // hinted tool results in one chat, all re-billed every round). Elide the
        // stale ones just before the request; the tool payloads stay intact.
        strip_stale_hints(&mut messages);
        let stream_started = std::time::Instant::now();
        let acc = match stream_chat(
            &client,
            &cfg,
            &messages,
            Some(&schemas),
            &mut sink,
            Some(cancel),
        )
        .await
        {
            Ok(acc) => acc,
            Err((status, e)) => {
                // Stop is not a provider failure: stream_chat reports it as
                // "aborted by user". Surfacing that as an error stacked a bogus
                // error banner on a deliberate cancel (and, inside explore, read as
                // a failed attempt). End the turn as aborted instead.
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    // The user hit Stop mid-stream: hand any queued steer back so
                    // it is re-sent as the next turn instead of being erased by
                    // `SteerGuard::drop`.
                    drop_steers(steer_chat, emit);
                    emit(&AgentEvent::Done { aborted: true });
                    return Ok(());
                }
                // The main model may simply not accept images, and the capability
                // maps cannot always answer that in advance (a gateway that hides
                // its catalog, a brand-new model). The images are stripped from
                // the message list and the SAME step is re-issued with the Vision
                // slot's description instead — main model first, Vision as the
                // fallback, exactly like the user asked. `0` means nothing
                // carried images, so the error below is the real one.
                if looks_like_image_error(&e) {
                    let client = crate::llm::http_client();
                    let changed =
                        degrade_images_to_text(&client, req, &cfg, &mut messages).await;
                    if changed > 0 {
                        emit(&AgentEvent::Text {
                            content: "\n\n> This model rejected the image; retrying with \
the Vision model's description instead.\n"
                                .to_string(),
                        });
                        continue;
                    }
                }
                // stream_chat reports the HTTP status and the raw body as a
                // tuple; run_turn used to throw the status away. Prefix it back
                // on (under the `{kind} ` convention so the provider-label
                // rewrite below still applies): "HTTP 429" is the difference
                // between "come back later" and a broken model, and an empty
                // body on its own made the whole error read as an empty string.
                let body = if status > 0 && !e.is_empty() {
                    format!("{} upstream HTTP {status}: {e}", req.provider)
                } else if status > 0 {
                    format!("{} upstream HTTP {status} (empty body)", req.provider)
                } else {
                    e
                };
                let named = name_the_provider_in_error(
                    body,
                    &req.providers,
                    &req.provider_id,
                    &req.provider,
                );
                // Log EVERY mid-turn stream failure to stderr (rust.log). This
                // path used to be completely silent for the scheduler: the error
                // was folded into `Ok(())` below and a half-finished turn was
                // recorded as a successful run whose "final answer" was the
                // first narration message, with nothing anywhere saying why the
                // rest of the turn never happened.
                eprintln!("[turn-end] chat={} step={} stream error: {named}", req.chat_id, step + 1);
                // The failed attempt IS a burned round: record it, or the
                // baseline counts successes only and every retry is invisible
                // (a stream that dies before any usage never reached the llm
                // row). `kind:"retry"` keeps one kind for all non-productive
                // attempts; the summary names the side. A sub-agent attempt
                // skips this row: its ladder records the SAME failure as its
                // own "attempt n/m" row, and two rows for one failure just
                // duplicated the noise in the trace panel.
                if req.mode != "subagent" {
                    trace.record(crate::trace::TraceEntry {
                        kind: "retry".into(),
                        summary: format!(
                            "main stream failed at step {} — {}",
                            step + 1,
                            &named.chars().take(160).collect::<String>()
                        ),
                        model: Some(req.model.clone()),
                        error: Some(named.clone()),
                        detail: Some(json!({
                            "step": step + 1,
                            "side": "main",
                            "status": status,
                            "duration_ms": stream_started.elapsed().as_millis() as u64,
                            "model": req.model.clone(),
                            "provider_id": req.provider_id.clone(),
                        })),
                        ..Default::default()
                    });
                }
                if req.headless {
                    // A headless caller (the scheduler) has no SSE client to
                    // receive the Error/Done protocol: it records the run and
                    // walks its own fallback chain, so the failure must come
                    // back as `Err` or it is invisible.
                    return Err(named);
                }
                emit(&AgentEvent::Error { content: named });
                // Terminal `done` after the error: the event protocol requires
                // it (the client treats an EOF without `done` as a dropped
                // connection). Without it the stream ended silently and the UI
                // stacked "Connection lost mid-turn" on top of the real
                // provider error — reported on one of two concurrent chats.
                // Emit BEFORE `done`: a steer that landed during the failed call
                // must survive as the next turn, and the renderer marks those
                // bubbles pending while processing `done`.
                drop_steers(steer_chat, emit);
                run_stop_hooks(&hooks, emit);
                emit(&AgentEvent::Done { aborted: false });
                return Ok(());
            }
        };
        // The usage payload normalized to ONE vocabulary by its own shape (see
        // `llm::NormalizedUsage`): additive (Anthropic-style) vs subset
        // (OpenAI/DeepSeek/Google-style) is read off the fields the payload
        // carries, so a custom Anthropic-compatible gateway is caught too —
        // the old provider-NAME check (`req.provider == "anthropic"`) missed
        // every custom endpoint and ignored the cache WRITE half entirely.
        let usage = crate::llm::NormalizedUsage::from_payload(
            acc.usage.as_ref().unwrap_or(&serde_json::Value::Null),
        );
        let (in_tok, out_tok, cache_tok, write_tok, read_rep, write_rep) = match &usage {
            Some(u) => (
                u.reported_input,
                u.output_tokens,
                u.cache_read,
                u.cache_write,
                u.cache_read_reported,
                u.cache_write_reported,
            ),
            None => (0, 0, 0, 0, false, false),
        };
        // The provider just told us how big the request it received was; that is
        // the ground truth the next round's mid-turn compaction trigger uses
        // (the local estimate cannot see the system prompt or the tool schemas).
        //
        // The basis is the INCLUSIVE input for EVERY provider: additive
        // payloads contribute input + read + write, subset payloads their
        // reported input. An Anthropic-shaped turn with input=2_000,
        // read=18_000, write=1_000 bills a 21_000-token prompt — the old
        // code (input alone, or read added only for provider=="anthropic")
        // made the compaction trigger fire far too late on exactly the turns
        // that were closest to their window.
        let prompt_basis = usage.as_ref().map(|u| u.input_total).unwrap_or(0);
        if prompt_basis > 0 {
            last_prompt_tokens = prompt_basis as usize;
            measured_upto = messages.len();
        }
        emit(&AgentEvent::Usage {
            // Inclusive billed input: the fresh-input cost math (input − read
            // − write) and the cache-hit denominator are correct for every
            // provider from this one number.
            input_tokens: usage.as_ref().map(|u| u.input_total).unwrap_or(0),
            output_tokens: out_tok,
            cache_read_tokens: cache_tok,
            cache_write_tokens: write_tok,
            cache_read_reported: read_rep,
            cache_write_reported: write_rep,
            model: req.model.clone(),
            provider_id: req.provider_id.clone(),
            sub: req.mode == "subagent",
            // The prompt the provider just billed — the same baseline the
            // auto-compaction trigger compares against (0 when unreported).
            context_tokens: if req.mode == "subagent" { 0 } else { prompt_basis },
            // The denominator the trigger divides by, so the renderer's ring
            // reaches 100% exactly when compaction fires even when it could not
            // resolve the model's window itself.
            context_window: if req.mode == "subagent" {
                0
            } else {
                effective_ctx as u64
            },
            // Ground truth for the reasoning capability: the renderer records
            // it against this provider+model (see the variant doc).
            reasoning_chars: acc.reasoning_len as u64,
        });
        // Trace: one llm row per model call (model + tokens), like the
        // Python sidecar's trace panel rows. The reply text and the step's
        // routing facts go in too — a row with only a token count expands to
        // an empty body, which reads as "the model did nothing".
        let reply_text = acc.text.trim().to_string();
        // The accumulator stores OpenAI-shaped slots — `{"function": {"name": …,
        // "arguments": …}}` (llm.rs:974) — so reading a TOP-LEVEL `name` here
        // matched nothing and every trace row recorded `tool_calls: []`. That
        // silently blinded the one metric the round-trip work is measured with
        // ("how many tools did this step batch?"): 376 of 376 explore rows and
        // 239 of 239 main rows came back empty. Read the real path.
        let tool_names: Vec<String> = acc
            .tool_calls
            .iter()
            .filter_map(|c| c["function"]["name"].as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .collect();
        trace.record(crate::trace::TraceEntry {
            kind: "llm".into(),
            model: Some(req.model.clone()),
            tokens: Some(crate::trace::Tokens {
                // INCLUSIVE billed input (see the Usage event above) — the
                // ruler's per-call cost math and its cold/warm split need the
                // real footprint, not a provider-dependent slice of it.
                input: usage.as_ref().map(|u| u.input_total).unwrap_or(0),
                output: out_tok,
                cache_read: cache_tok,
                cache_write: write_tok,
                cache_read_reported: read_rep,
                cache_write_reported: write_rep,
                total: usage.as_ref().map(|u| u.input_total).unwrap_or(0) + out_tok,
            }),
            summary: if cache_tok > 0 {
                format!(
                    "{} · {} tokens ({} cached)",
                    req.model,
                    in_tok + out_tok,
                    cache_tok
                )
            } else {
                format!("{} · {} tokens", req.model, in_tok + out_tok)
            },
            result: if reply_text.is_empty() {
                None
            } else {
                Some(clip_trace_text(&reply_text, LLM_TRACE_TEXT_CAP))
            },
            // The wire prompt of THIS call: system (elided) + history + the
            // user prompt + every tool result so far. Without it the row could
            // only say "N tokens" and the panel looked like the model had been
            // asked nothing at all.
            prompt: {
                // `trace_prompt_text` already bounds itself (keeping the newest
                // block); clipping again here would cut that block back off.
                let wire = trace_prompt_text(&messages);
                if wire.is_empty() {
                    None
                } else {
                    Some(wire)
                }
            },
            detail: Some(serde_json::json!({
                "provider": cfg.provider.clone(),
                "step": step + 1,
                "steps_max": max_steps,
                "finish_reason": acc.finish_reason.clone(),
                "reasoning_chars": acc.reasoning_len,
                "reply_chars": reply_text.chars().count(),
                "tool_calls": tool_names,
                // Hints actually delivered up to this call: the only direct
                // evidence that the single-call batching lever reached the
                // model (see `single_call_hint`). The counter is cumulative, so
                // a hint appended to step N's result shows on step N+1's row.
                "hints_delivered": nudges,
                "lone_call_hints": lone_call_hints,
                "prompt_messages": messages.len(),
                // Local estimate of the wire prompt for THIS call. The provider
                // reports `input` AFTER the fact and that number includes the
                // prefix-cache hits, so it cannot answer "how big was the prompt
                // the fold was trying to shrink". This can.
                "wire_tokens_est": estimate_wire_tokens(&messages[1..]) + tools_chars.div_ceil(4),
                // Wall-clock of THIS model call: the baseline's latency column
                // (round-elimination must show here as fewer calls, not slower
                // ones).
                "duration_ms": stream_started.elapsed().as_millis() as u64,
            })),
            ..Default::default()
        });

        let text = acc.text.clone();
        // Keep this round's prose: plan mode persists the whole turn's prose at
        // the end, and the round that holds the plan already scrolled past.
        if !text.trim().is_empty() {
            prior_text.push(text.clone());
        }
        let tool_calls: Vec<(String, String, String)> = acc
            .tool_calls
            .iter()
            .filter_map(|tc| {
                let raw_name = tc["function"]["name"].as_str().unwrap_or_default();
                let raw_args = tc["function"]["arguments"].as_str().unwrap_or_default();
                // A slot without a NAME is never dispatchable — either padding
                // grown by an out-of-order delta index, or a provider that sent
                // arguments before the name (or never sent it at all). It used
                // to reach the dispatch guard as `unknown tool ""` and burn a
                // whole round-trip while the model re-issued the call. Dropping
                // it here loses nothing: a nameless call cannot be executed.
                if raw_name.trim().is_empty() {
                    return None;
                }
                // Cross-agent aliases (`read_client`, `read_file`, `shell`,
                // `todos`…) are resolved HERE, before the unknown-tool guard,
                // so the model gets the tool it meant instead of an error it
                // retried 70+ times. Unresolvable names pass through unchanged
                // and still hit that guard.
                let name = canonical_tool_name(raw_name, &advertised)
                    .unwrap_or_else(|| raw_name.to_string());
                Some((
                    tc["id"].as_str().unwrap_or_default().to_string(),
                    name,
                    raw_args.to_string(),
                ))
            })
            .collect();

        // Discovery streak: a round is "discovery" when EVERY call in it only
        // locates or reads. The test looks THROUGH a `batch_search` wrapper
        // (`round_is_discovery`): judged by its raw name the wrapper matched no
        // lookup, so every batched search round RESET the streak and the
        // `explore` nudge never fired — traced, 21 real search rounds in a row
        // were counted as 1. A round that edits, writes or runs a command still
        // resets it: the agent has moved on to doing the work.
        if !tool_calls.is_empty() {
            if round_is_discovery(&tool_calls, &root) {
                discovery_streak += 1;
            } else {
                discovery_streak = 0;
            }
        }

        // A round made ONLY of names that are not in the advertised table is a
        // hallucination loop, not work. The unknown-tool reply already tells the
        // model the valid names; three rounds in a row that ignore it will not
        // recover on their own (a weak model keeps inventing the same family).
        // Tracked here, acted on at the end of the round.
        let round_all_invalid = !tool_calls.is_empty()
            && tool_calls.iter().all(|(_, n, _)| {
                !advertised.iter().any(|a| a == n)
                    && !n.starts_with(crate::mcp::TOOL_PREFIX)
                    && crate::mcp_index::owner_of(&connectors, n).is_none()
            });

        if tool_calls.is_empty() {
            // Plan mode: persist the plan document to disk (native plans.rs,
            // same layout the Python sidecar used) and emit plan_card so the
            // frontend collapses the streamed plan into its Plan card.
            if req.mode == "plan" {
                // `text` is only THIS round's reply, and the plan is written in
                // an early round (read → plan text → update_plan) while the last
                // round usually carries only a closing note. Save the whole
                // turn's prose in order, or plan.md becomes just that note:
                // `plan_text` joins the plan-carrying rounds and drops the
                // narration the model wrote next to the reads.
                let mut parts: Vec<&str> = prior_text.iter().map(String::as_str).collect();
                if !text.trim().is_empty() {
                    parts.push(text.as_str());
                }
                let full = crate::plans::plan_text(&parts);
                let data_root = native_data_root();
                let ws = crate::plans::workspace_slug_for_root(&root);
                // The artifact IS the plan when the turn saved one: the prose
                // rounds then only carry the closing summary, which must not
                // win over the document the planner actually wrote.
                let from_artifact = plan_artifact.is_some();
                let doc = plan_artifact
                    .clone()
                    .or_else(|| extract_plan_body(&full));
                let has_plan = crate::plans::get_plan(&data_root, &ws, &req.chat_id).is_some();
                let wrote_document = from_artifact
                    || doc
                        .as_ref()
                        .map(|(_, body)| crate::plans::has_heading(body))
                        .unwrap_or(false);
                // A plan-mode turn is not always a plan: the user asks a
                // question, answers the planner's clarification, or says "keep
                // the saved plan", and the turn then ends with a conversational
                // reply. Saving that reply as the plan overwrote the real
                // plan.md, which is why the Plan panel showed the answer instead
                // of the plan (and the answer left its own bubble for a card).
                // So only a document — a turn whose prose carries a heading —
                // replaces a saved plan; a chat with no plan yet still saves (a
                // first plan written as a bare list has no heading).
                if let Some((title, body)) = doc {
                    if wrote_document || !has_plan {
                        // Never swallow this: a failed write used to be silent,
                        // so the plan looked saved in the chat but was missing
                        // from disk after a restart. Surface it as a warn the
                        // renderer shows, and name the target path in the log.
                        if let Err(e) = crate::plans::save_plan(
                            &data_root,
                            &ws,
                            &title,
                            &body,
                            &req.chat_id,
                        ) {
                            eprintln!(
                                "[plan] save failed (root={data_root} ws={ws} chat={}): {e}",
                                req.chat_id
                            );
                            emit(&AgentEvent::Warn {
                                content: format!(
                                    "The plan was not saved to disk ({e}). It is still in this \
                                     chat, but a restart will not restore it."
                                ),
                            });
                        }
                        emit(&AgentEvent::PlanCard { title, body });
                    }
                } else if !has_plan {
                    // Plan mode with an empty reply and nothing on disk: say so
                    // instead of ending the turn with no card and no plan file.
                    emit(&AgentEvent::Warn {
                        content: "Plan mode produced no plan text — nothing was saved to disk."
                            .into(),
                    });
                }
            }
            // The model answered without tool calls, but the user steered while
            // it was answering. Ending the turn here would hand the steer to
            // `SteerGuard::drop` — it would be silently dropped and only
            // resurface as a brand-new turn, so the agent appeared to "queue"
            // the steer until everything had finished. Keep the same turn
            // running: record this answer FIRST (it was produced before the
            // steer) so the model can see what it already said, then continue
            // with the steer appended above it. (A sub-agent reads an empty
            // key here: the parent's inbox belongs to the parent's next step.)
            if !steer_chat.is_empty() && steer_pending(steer_chat) {
                messages.push(json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                }));
                deliver_steers(&mut messages, steer_chat, emit);
                continue;
            }
            // A turn that ends HERE ends because the model answered with no tool
            // call. Quiet by default: the reply (and any chat content) must
            // never reach the logs, and a one-line-per-turn entry is exactly
            // the noise a server log should not have — the chat's trace
            // already records the full turn. CODIFA_VERBOSE=1 restores a
            // STRUCTURAL line (chat/step/finish_reason — still no content).
            if req.mode != "subagent" && crate::webmode::verbose() {
                eprintln!(
                    "[turn-end] chat={} step={} finish_reason={:?} reasoning_chars={}",
                    req.chat_id,
                    step + 1,
                    acc.finish_reason,
                    acc.reasoning_len,
                );
            }
            // The end-of-turn deliver above ran a moment ago; a steer whose
            // POST landed in this tiny window would otherwise be erased by
            // `SteerGuard::drop` with NO event reaching the renderer — the
            // bubble stayed "steering…" forever because `push_steer` had already
            // answered ok. Report it like every other terminal exit, so the
            // post-turn drain re-sends it as the next turn.
            drop_steers(steer_chat, emit);
            run_stop_hooks(&hooks, emit);
            emit(&AgentEvent::Done { aborted: false });
            return Ok(());
        }

        // Record the assistant tool-call message, then execute each call.
        //
        // The replay must echo the call EXACTLY as the model emitted it.
        // Google's OpenAI-compatible endpoint binds Gemini 3's thought
        // signature to the call and rejects the next round with HTTP 400 when
        // it is missing, so `extra_content` (and the emitted name, which an
        // alias canonicalization may have changed) travels back with it. The
        // canonical name is still what gets executed.
        let emitted: std::collections::HashMap<&str, &Value> = acc
            .tool_calls
            .iter()
            .filter_map(|tc| tc["id"].as_str().map(|id| (id, tc)))
            .collect();
        let calls_json: Vec<Value> = tool_calls
            .iter()
            .map(|(id, name, args)| {
                let slot = emitted.get(id.as_str()).copied();
                let emitted_name = slot
                    .and_then(|s| s["function"]["name"].as_str())
                    .unwrap_or(name);
                let mut call = json!({"id": id, "type": "function",
                       "function": {"name": emitted_name, "arguments": args}});
                if let Some(extra) = slot.and_then(|s| s.get("extra_content")) {
                    if !extra.is_null() {
                        call["extra_content"] = extra.clone();
                    }
                }
                call
            })
            .collect();
        // First message this round. The no-progress guard below reads
        // `messages[round_msg_start..]` (this round's tool results) — the
        // assistant message is excluded from the digest by its role.
        let round_msg_start = messages.len();
        messages.push(json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { json!(text) },
            "tool_calls": calls_json,
        }));

        // Read-only tools are side-effect free: run the step's batch
        // concurrently (spawn_blocking + join) so N parallel greps cost one
        // round-trip instead of N sequential ones — the explore sub-agent's
        // wall time is dominated by these. Mutating tools and sub-agents
        // stay sequential (ordering + cancel semantics).
        let is_readonly = |name: &str| {
            // An MCP tool is never batched as read-only: it may mutate remote
            // state, and a bare connector name could otherwise shadow a native
            // tool of the same name. A DEFERRED connector tool is not in
            // `advertised` either, so the owner lookup is what identifies it.
            crate::mcp_index::owner_of(&connectors, name).is_none()
                && !name.starts_with(crate::mcp::TOOL_PREFIX)
                && is_readonly_native(name)
        };
        // Screenshots taken by THIS step's tools. They are attached to the next
        // request as image blocks, so the model looks at the picture it just
        // asked for instead of a file path.
        let mut step_shots: Vec<crate::computer::Shot> = Vec::new();
        // Images the step's `read` calls pointed at. A screenshot can already sit
        // in the workspace, and reading it used to answer "file too large" — the
        // path is collected here and attached exactly like a fresh capture.
        let mut step_read_images: Vec<String> = Vec::new();
        // A `run_terminal` that only READS is a lookup too, and it may share the
        // round: MEASURED on the live build, one chat spent 10 whole rounds on
        // shell reads (`ls`, `du`, `git status`) that could have run next to its
        // other reads, and every round costs the model ~6-8K uncached tokens.
        //
        // It stays SEQUENTIAL whenever the step also carries a writer, because
        // the batch runs before the sequential calls: batching a read in a step
        // that writes would run it BEFORE the write it depends on.
        let step_has_writer = tool_calls.iter().any(|(_, name, raw_args)| {
            if is_readonly(name) {
                return false;
            }
            if name != "run_terminal" {
                return true;
            }
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            !is_shell_read_only(args["command"].as_str().unwrap_or_default(), &root)
        });
        let mut batch: Vec<(String, String, Value)> = Vec::new();
        let mut sequential: Vec<(String, String, String)> = Vec::new();
        let mut repeats: Vec<(String, String, Value)> = Vec::new();
        // Out-of-workspace reads the user refused: answered with a clear denial
        // instead of a tool error, so the model neither retries the path nor
        // spends a round discovering it cannot.
        let mut denied: Vec<(String, String, Value, String)> = Vec::new();
        // SSH destinations the user approved for the rest of THIS turn ("Allow
        // once"). "Always allow" persists through trusted-hosts.json instead,
        // which the gate re-reads on every call.
        let mut ssh_approved: Vec<String> = Vec::new();
        for (id, name, raw_args) in &tool_calls {
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            // A call that reaches OUTSIDE every allowed root is asked about
            // BEFORE it runs, whatever the tool: an answer given now is served in
            // THIS round, instead of a refusal arriving after the round was
            // already billed and the model re-asking with another tool on the
            // SAME path (the old two-round dance this gate exists to end).
            //
            // The workspace, the OS temp roots and ~/.codifa never prompt — they
            // are already open — and nothing prompts when the renderer sent a
            // grant, so the common case costs nothing. A sub-agent never
            // prompts: it reports back and the parent turn owns the question.
            if req.mode != "subagent" && !name.starts_with(crate::mcp::TOOL_PREFIX) {
                if let Some(ask) = outside_target(name, &args, &root, permit.as_ref(), &caps) {
                    if ask_outside_access(emit, &req.chat_id, cancel, name, &ask, req.headless).await {
                        grant_folder(&mut permit, &ask.folder);
                    } else {
                        // The card must appear even when the call is refused:
                        // the renderer resolves it with the denial reason.
                        emit(&AgentEvent::ToolStart {
                            id: id.clone(),
                            name: name.clone(),
                            args: args.clone(),
                        });
                        denied.push((id.clone(), name.clone(), args, denied_outside(&ask.target)));
                        continue;
                    }
                }
                // An SSH connection is an outward-facing act the user owns:
                // every destination the command would reach is asked about
                // BEFORE anything runs — the whole line is held even when only
                // one of several servers in it is new, so a chain can never
                // connect somewhere unapproved halfway through. Approved hosts
                // (this turn's answers, plus persisted "Always allow") pass
                // silently; a denial answers the call without running it.
                if name == "run_terminal" {
                    let mut refused: Option<String> = None;
                    for dest in ssh_destinations(args["command"].as_str().unwrap_or_default()) {
                        if ssh_approved.iter().any(|h| h == &dest)
                            // "Always in this chat" grants ride the request —
                            // they live on the chat, not on disk, so they are
                            // merged here like the turn-local answers.
                            || req.allow_ssh_hosts.iter().any(|h| h == &dest)
                            || trusted_hosts(&skill_root).iter().any(|h| h == &dest)
                        {
                            continue;
                        }
                        if ask_ssh_access(emit, &req.chat_id, cancel, &dest, req.headless).await {
                            ssh_approved.push(dest);
                        } else {
                            refused = Some(dest);
                            break;
                        }
                    }
                    if let Some(dest) = refused {
                        emit(&AgentEvent::ToolStart {
                            id: id.clone(),
                            name: name.clone(),
                            args: args.clone(),
                        });
                        denied.push((id.clone(), name.clone(), args, denied_ssh(&dest)));
                        continue;
                    }
                }
            }
            let shell_read = {
                if name != "run_terminal" || step_has_writer {
                    false
                } else {
                    is_shell_read_only(args["command"].as_str().unwrap_or_default(), &root)
                }
            };
            // Plugin `PreToolUse`: the guard sees the tool NAME (its matcher) and
            // may refuse the call outright. It runs BEFORE the batch/sequential
            // split, so a vetoed read is not dispatched either. The denial goes
            // through `finish_tool` like any other refusal: a card, a trace row
            // and a message the model can act on.
            if !hooks.is_empty() {
                let guard = crate::hooks::run_active(&hooks, "PreToolUse", name);
                if guard.ran > 0 {
                    trace.record(crate::trace::TraceEntry {
                        kind: "hook".into(),
                        summary: if guard.blocked {
                            format!("PreToolUse refused {name}: {}", guard.reason)
                        } else {
                            format!("PreToolUse ran {} handler(s) for {name}", guard.ran)
                        },
                        ..Default::default()
                    });
                }
                if guard.blocked {
                    // The card must appear even though nothing ran.
                    emit(&AgentEvent::ToolStart {
                        id: id.clone(),
                        name: name.clone(),
                        args: args.clone(),
                    });
                    denied.push((
                        id.clone(),
                        name.clone(),
                        args,
                        format!(
                            "blocked by a plugin hook (`{}`): {}",
                            name, guard.reason
                        ),
                    ));
                    continue;
                }
            }
            // A background=true terminal is NEVER batch-dispatched: the batch
            // phase calls tools::dispatch directly and that has no background
            // branch — the call would run to its timeout in the foreground
            // (measured: `sleep 45` with background:true sat out its full 45 s
            // there, `sleep 300` hit the 120 s ceiling) and the Terminals
            // panel would never list it. The sequential arm is the only path
            // whose chain ends in agent_terminals::spawn (with the chat_id the
            // panel needs), so a background call must always land there.
            // LONG-SEARCH delegation gate (always-on): a turn that has already
            // spent 4 rounds on discovery must not keep grepping/globbing on
            // the MAIN context — every such round re-sends the whole
            // conversation (~79K tokens late in a turn vs ~16K inside an
            // explore). Reads of files the model can NAME stay direct; only the
            // open-ended discovery calls are rerouted.
            if req.mode != "subagent"
                && discovery_streak >= DISCOVERY_DELEGATE_THRESHOLD
                && matches!(name.as_str(), "grep" | "glob")
            {
                emit(&AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                });
                denied.push((
                    id.clone(),
                    name.clone(),
                    args,
                    format!(
                        "this turn has already spent {discovery_streak} rounds on search lookups \
on the main context (each one re-sends the whole conversation). Delegate the remaining \
search to ONE `explore` call — it runs on a short context and returns the full findings — \
and work from its report. Reads of files you can NAME stay direct."
                    ),
                ));
                continue;
            }
            let background_call = name == "run_terminal"
                && args["background"].as_bool().unwrap_or(false);
            if is_readonly(name) || (shell_read && !background_call) {
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: tool_status_label(name, &args),
                });
                emit(&AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                });
                // A repeat of an identical lookup answers with a pointer
                // instead of the payload again (see `seen_lookups`) — and so
                // does a `read` whose every window is already inside a span
                // served earlier this turn, even under a different spelling.
                let key = lookup_key(name, &args);
                let covered_read = name == "read"
                    && read_windows_covered(&seen_lookups, &tools::read_windows_of(&args));
                let is_repeat = covered_read || key.is_some_and(|k| !seen_lookups.insert(k));
                if is_repeat {
                    repeats.push((id.clone(), name.clone(), args));
                } else {
                    batch.push((id.clone(), name.clone(), args));
                }
            } else {
                sequential.push((id.clone(), name.clone(), raw_args.clone()));
            }
        }
        // Same-step reader targets for the STALE-SOURCE note: readers run in
        // the batch phase BEFORE the sequential writers, so this Vec is the
        // exact set whose returned text a writer below just invalidated.
        for (_, rname, rargs) in &batch {
            if let Some(f) = match rname.as_str() {
                "read" => rargs["filePath"].as_str().map(str::to_string),
                "grep" => rargs["path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .map(str::to_string),
                _ => None,
            } {
                step_read_files.push(f);
            }
        }
        if !batch.is_empty() {
            let root_c = root.clone();
            let permit_c = permit.clone();
            // Skills live in the DATA root, not the workspace: dispatch must
            // resolve `load_plugin` there, or every load answers
            // "Available: (none)" while the catalog above lists the skill.
            let skill_root_c = skill_root.clone();
            // A scheduled turn may block for minutes on a paid script, so the
            // batch hands each call to the blocking pool.
            //
            // Live output: every blocking task shares ONE tail channel; a task
            // whose tool streams (only `run_terminal` does) forwards its
            // command's output tail tagged with ITS call id. The pump below
            // drains the channel until EVERY sender is gone — the senders live
            // inside the blocking tasks, so a closed channel means every
            // dispatch has returned — which keeps the emit single-threaded and
            // preserves the ordered finish loop below unchanged.
            let (tail_tx, mut tail_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
            let handles: Vec<_> = batch
                .iter()
                .map(|(id, name, args)| {
                    let root = root_c.clone();
                    let skill_root = skill_root_c.clone();
                    let permit = permit_c.clone();
                    let name = name.clone();
                    let args = args.clone();
                    let id_tail = id.clone();
                    let tail_tx = tail_tx.clone();
                    let sink: tools::TailSink = Arc::new(move |tail: &str| {
                        let _ = tail_tx.send((id_tail.clone(), tail.to_string()));
                    });
                    tokio::task::spawn_blocking(move || {
                        let out = tools::dispatch_bounded_with(
                            &root,
                            &name,
                            &args,
                            permit.as_ref(),
                            Some(&skill_root),
                            Some(&sink),
                        );
                        drop(sink);
                        match out {
                            Ok(r) => (r, true),
                            Err(e) => (e, false),
                        }
                    })
                })
                .collect();
            // The map closure above moved a sender per task; drop OUR last
            // reference so the channel actually closes when the tasks do.
            drop(tail_tx);
            // Forward every tail until all tasks are done (channel closes).
            // 500 ms of gating happens inside the tool, not here.
            while let Some((id, tail)) = tail_rx.recv().await {
                emit(&AgentEvent::ToolOutput { id, tail });
            }
            for ((id, name, args), handle) in batch.into_iter().zip(handles) {
                let (result, ok) = handle
                    .await
                    .unwrap_or(("tool task failed".into(), false));
                // Headless error log — see the sequential arm below.
                if !ok && req.headless {
                    let brief: String = result.chars().take(200).collect();
                    eprintln!(
                        "[tool] {name} failed: {brief}"
                    );
                }
                if let Some(p) = crate::commands::image_read_path(&result) {
                    step_read_images.push(p);
                }
                // Only a read that HAPPENED counts towards coverage: a refused
                // or failed one must stay re-requestable. A window the result
                // budget CUT does not count either — its tail was never
                // delivered, so claiming those lines would answer the model's
                // legitimate follow-up with a pointer to text it never saw.
                if ok && name == "read" && !result_was_window_cut(&result) {
                    record_read_coverage(&mut seen_lookups, &tools::read_windows_of(&args));
                    if result.contains("[read] extended ") {
                        record_extended_coverage(&mut seen_lookups, &result);
                    }
                }
                finish_tool(
                    &mut messages,
                    emit,
                    &trace,
                    &id,
                    &name,
                    &args,
                    result,
                    ok,
                    req.mode == "subagent",
                    None,
                    None,
                );
            }
        }
        for (id, name, args, reason) in denied {
            finish_tool(
                &mut messages,
                emit,
                &trace,
                &id,
                &name,
                &args,
                reason,
                false,
                req.mode == "subagent",
                None,
                None,
            );
        }
        for (id, name, args) in repeats {
            finish_tool(
                &mut messages,
                emit,
                &trace,
                &id,
                &name,
                &args,
                "already returned above — these lines (or this exact lookup) are in your \
context; use what it showed, read a DIFFERENT window, or move on"
                    .into(),
                true,
                req.mode == "subagent",
                None,
                None,
            );
        }
        // Independent research sub-agents in one step run CONCURRENTLY
        // (join): the model often fires several research questions at once
        // and each takes seconds — sequential execution multiplies the wall
        // time. Browser/desktop agents are the exception: they share ONE page
        // / ONE desktop, so two of them in parallel would fight over the
        // driver. Those run serially below, in the order the model called
        // them. Mutating tools stay sequential too (ordering + cancel).
        let mut parallel_batch: Vec<(String, String, Value, u64)> = Vec::new();
        let mut serial_delegations: Vec<(String, String, Value, u64)> = Vec::new();
        let mut rest: Vec<(String, String, String)> = Vec::new();
        for call in sequential {
            if is_delegation(&call.1) {
                // Enforce MAX_SUBAGENT_DEPTH: a sub-agent must not fan out more
                // sub-agents (mirrors graph.py). `research_schemas()` never
                // advertises a delegation tool, so this only rejects a
                // hallucinated call — without it the depth limit was a dead
                // constant. Applies to `explore` and to every plugin profile
                // alike, because both go through this one branch.
                if req.mode == "subagent" {
                    let args: Value =
                        serde_json::from_str(&call.2).unwrap_or_else(|_| json!({}));
                    finish_tool(
                        &mut messages,
                        emit,
                        &trace,
                        &call.0,
                        &call.1,
                        &args,
                        "blocked: sub-agents cannot spawn further sub-agents (explore depth limit)"
                            .into(),
                        false,
                        true,
                        None,
                        None,
                    );
                    continue;
                }
                let args: Value =
                    serde_json::from_str(&call.2).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: delegation_display_name(req, &call.1),
                });
                let branch = BRANCH_SEQ.fetch_add(1, Ordering::Relaxed);
                // The card carries its branch id so the calls the sub-agent
                // makes (tagged with the same id) nest under it.
                emit(&AgentEvent::Branch {
                    branch,
                    sub: false,
                    inner: Box::new(AgentEvent::ToolStart {
                        id: call.0.clone(),
                        name: call.1.clone(),
                        args: args.clone(),
                    }),
                });
                // The identical question already ran in THIS turn: its report is
                // in the context above, so re-running it would buy the same
                // findings twice (a full sub-agent: many rounds × attempts).
                // Answer with a pointer instead. The key is registered BEFORE the
                // run, so two identical delegations in the SAME step cannot both
                // start.
                let key = lookup_key(&call.1, &args);
                if key.is_some_and(|k| !seen_lookups.insert(k)) {
                    finish_tool(
                        &mut messages,
                        emit,
                        &trace,
                        &call.0,
                        &call.1,
                        &args,
                        "this exact sub-agent task ALREADY ran in this turn — its report is in \
your context above. Use that report, or ask a DIFFERENT, narrower question"
                            .into(),
                        true,
                        req.mode == "subagent",
                        None,
                        None,
                    );
                } else if matches!(
                    delegation_kind(req, &call.1).as_str(),
                    "browser" | "computer"
                ) {
                    // One shared page / desktop: never run two drivers at once.
                    serial_delegations.push((call.0, call.1, args, branch));
                } else {
                    parallel_batch.push((call.0, call.1, args, branch));
                }
            } else {
                rest.push(call);
            }
        }
        // A steer that lands while this step's tools run stays QUEUED: the whole
        // batch is one unit of decided work and is never cut or skipped — the
        // steer is delivered at the top of the next step instead (see
        // `deliver_steers`). The Stop button is the path that aborts mid-batch.
        if !parallel_batch.is_empty() {
            // Concurrent sub-agents polled in THIS task via join_all — no
            // tokio::spawn, so no Send bound and the turn still blocks until
            // every report is back (delegation stays synchronous by design).
            // Structural events (tool cards/status/usage) flow through a
            // channel to the parent stream so parallel sub-agents stay VISIBLE
            // in the chat while they work; Text/Error stay inside each
            // sub-agent's own report (never surfaced in the chat).
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SubMsg>();
            let futures: Vec<_> = parallel_batch
                .iter()
                .map(|(id, name, args, branch)| {
                    let branch = *branch;
                    let req_c = req.subagent_snapshot();
                    let args_c = args.clone();
                    let id_c = id.clone();
                    let name_c = name.clone();
                    let name_t = name.clone();
                    let cancel_c = std::sync::Arc::clone(cancel);
                    let tx = tx.clone();
                    Box::pin(async move {
                        let tx_ev = tx.clone();
                        let mut sink = move |ev: &AgentEvent| {
                            let _ = tx_ev.send(SubMsg::Ev(ev.clone()));
                        };
                        // The delegation runs to completion even when a steer
                        // lands mid-run: the steer is delivered at the next
                        // step boundary, never by cutting the child short.
                        let (result, ok) =
                            run_subagent(&req_c, &args_c, branch, &name_t, &mut sink, &cancel_c)
                                .await;
                        // Each explore posts its OWN end marker, so the parent
                        // resolves this card the moment it lands — not after
                        // the slowest sibling in the batch finishes.
                        let _ = tx.send(SubMsg::Done {
                            id: id_c,
                            name: name_c,
                            args: args_c,
                            result,
                            ok,
                        });
                    })
                })
                .collect();
            // Drop our sender so rx.recv() returns None once every explore has
            // finished and its end marker has been drained.
            drop(tx);
            let sub_all = futures_util::future::join_all(futures);
            let forward = async {
                while let Some(msg) = rx.recv().await {
                    // Stop must also abort the concurrent explores: the shared
                    // cancel flag is checked on every forwarded message.
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    match msg {
                        // The sub-agent's narration and errors stay inside its
                        // own report — never in the user's chat.
                        SubMsg::Ev(AgentEvent::Text { .. })
                        | SubMsg::Ev(AgentEvent::Error { .. }) => {}
                        SubMsg::Ev(ev) => emit(&ev),
                        SubMsg::Done {
                            id,
                            name,
                            args,
                            result,
                            ok,
                        } => {
                            // Headless error log — see the sequential arm below.
                            if !ok && req.headless {
                                let brief: String = result.chars().take(200).collect();
                                eprintln!("[tool] {name} failed: {brief}");
                            }
                            finish_tool(
                                &mut messages,
                                emit,
                                &trace,
                                &id,
                                &name,
                                &args,
                                result,
                                ok,
                                req.mode == "subagent",
                                None,
                                None,
                            );
                        }
                    }
                }
            };
            let (_reports, _) = tokio::join!(sub_all, forward);
        }
        // Browser/desktop delegations run SERIALLY in the model's call order:
        // the whole point of a page/desktop driver is that there is one, and
        // two sub-agents in parallel would overwrite each other's page state.
        // They still belong to this step: the main agent does not pay another
        // model round-trip to run them.
        for (id, name, args, branch) in serial_delegations {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                if req.mode != "subagent" {
                    eprintln!(
                        "[turn-end] chat={} cancel flag set before serial delegation",
                        req.chat_id
                    );
                }
                drop_steers(steer_chat, emit);
                emit(&AgentEvent::Done { aborted: true });
                return Ok(());
            }
            let req_c = req.subagent_snapshot();
            let mut sink = |ev: &AgentEvent| emit(ev);
            // Boxed for the same reason the parallel arm is: run_turn calls
            // run_subagent, whose child turn calls run_turn again. The Box is
            // the indirection that keeps that cycle from being infinite-sized.
            let (result, ok) = Box::pin(run_subagent(
                &req_c,
                &args,
                branch,
                &name,
                &mut sink,
                cancel,
            ))
            .await;
            if !ok && req.headless {
                let brief: String = result.chars().take(200).collect();
                eprintln!("[tool] {name} failed: {brief}");
            }
            finish_tool(
                &mut messages,
                emit,
                &trace,
                &id,
                &name,
                &args,
                result,
                ok,
                req.mode == "subagent",
                None,
                None,
            );
        }
        for (id, name, raw_args) in &rest {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                // Stop mid-batch: the remaining tools are skipped, so anything
                // the user steered while they ran has no step left to ride on.
                if req.mode != "subagent" {
                    eprintln!("[turn-end] chat={} cancel flag set mid-batch", req.chat_id);
                }
                drop_steers(steer_chat, emit);
                emit(&AgentEvent::Done { aborted: true });
                return Ok(());
            }
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            // A steer that landed mid-batch stays queued: this call runs like
            // every sibling (the batch is one unit of decided work), and the
            // steer is delivered at the top of the next step.
            // The call about to run may CHANGE the workspace (`write_file`,
            // `edit_file`, or a `run_terminal` that really writes), so every body
            // cached by the repeat-guard is now possibly a snapshot of a file
            // taken BEFORE this change. Answering a later
            // `read`/`lsp_symbols`/`grep` with a pointer would then feed the model
            // its own file pre-edit — the guard must forget instead. A call that
            // reads, fetches or delegates leaves every file exactly as the cache
            // describes it, so it costs nothing (see `mutates_workspace`).
            if mutates_workspace(name, &args) {
                seen_lookups.clear();
            }
            emit(&AgentEvent::Status {
                stage: "tool".into(),
                content: tool_status_label(name, &args),
            });
            // Two-phase protocol (like the Python sidecar): the start event
            // mints a running card immediately, so long tools (explore) are
            // visible while they work and Stop leaves a visible card.
            emit(&AgentEvent::ToolStart {
                id: id.clone(),
                name: name.clone(),
                args: args.clone(),
            });
            // Capture the pre-edit content so a unified diff can be emitted
            // after the call — without it the Review panel answers "No changes
            // in this turn." for every edit. A missing file (brand-new
            // write_file) diffs as pure additions.
            let pre_edit: Vec<(String, String)> = if name == "edit_file" || name == "write_file" {
                // The SAME target resolution the writer itself uses. Reading a
                // bare `args["path"]` here made every `edits:[{path,…}]` batch
                // resolve to "" — the workspace root — so both snapshots were
                // empty and the edit produced no diff anywhere. A batch may
                // name a DIFFERENT file per entry, so EVERY target is
                // snapshotted: snapshotting only the first left each later
                // file of the same call with no diff, no Review row and no
                // `applied change` for the model.
                writer_target_paths(name, &args)
                    .into_iter()
                    .map(|p| {
                        let old =
                            crate::tools::read_pre_edit(&root, &p, permit.as_ref())
                                .unwrap_or_default();
                        (p, old)
                    })
                    .collect()
            } else {
                Vec::new()
            };
            // Structured rows for the tool card. Only the web tools fill it
            // (search hits / fetched page): the card renders those as links,
            // and a DISTILLED search answer no longer contains the link list.
            let mut ui_results: Option<Value> = None;
            // Web-search engine that actually answered (badged on the card).
            let mut ui_engine: Option<String> = None;
            let (result, ok) = if name.is_empty() {
                // The provider streamed the tool NAME in a separate delta that
                // never arrived (or was empty): the call reached here with no
                // name at all. Answer with a repairable message instead of the
                // generic unknown-tool listing, so the model re-issues the SAME
                // call with the name set instead of guessing another name.
                (
                    format!(
                        "this call arrived with an EMPTY tool name (the provider streamed the \
name in a separate delta or dropped it). Re-issue the same call with the tool name set. \
Valid names: {}",
                        advertised.join(", ")
                    ),
                    false,
                )
            } else if !name.starts_with(crate::mcp::TOOL_PREFIX)
                && !advertised.iter().any(|n| n == name)
                // A DEFERRED connector tool is deliberately not in `advertised`:
                // its schemas are not inlined, so the name never reaches this
                // list. It is still a real tool of a connector that is switched
                // ON, so it must dispatch — otherwise the whole lazy path would
                // be unusable the moment the model used a tool the index named.
                && crate::mcp_index::owner_of(&connectors, name).is_none()
            {
                // The listing names the NATIVE tools plus the batch/delegation
                // families by count, not every delegation agent's full id: a
                // hallucinated call paid ~1.3K chars for a 20-row agent list it
                // did not need (traced: `check_cwd_and_cargo`).
                let delegates = advertised
                    .iter()
                    .filter(|n| n.starts_with("agent__"))
                    .count();
                let listed: Vec<&str> = advertised
                    .iter()
                    .filter(|n| !n.starts_with("agent__"))
                    .map(String::as_str)
                    .collect();
                (
                    format!(
                        "unknown tool {name:?}: no such tool exists. Call one of exactly these names: {}{}",
                        listed.join(", "),
                        if delegates > 0 {
                            format!(
                                " — plus {delegates} installed agent__* delegation tools (explore-style, listed in your system prompt)"
                            )
                        } else {
                            String::new()
                        }
                    ),
                    false,
                )
            } else if let Some(refusal) = denied_by_caps(&caps, name) {
                // Second gate (the schema filter is the first): the tool is not
                // advertised this turn, so a call that still arrives is a stale
                // transcript or a hallucinated name — refuse it before anything
                // touches the disk. This is what makes Ask mode read-only for
                // real instead of trusting the prompt to be obeyed.
                (refusal, false)
            } else if name == "run_terminal"
                && is_file_search_command(args["command"].as_str().unwrap_or_default(), &root)
            {
                // The terminal is for work only the terminal can do (system
                // measures, builds, tests, git, out-of-workspace paths).
                // Locating files belongs to `grep`/`glob`/`find_symbol`, or to
                // ONE `explore` delegation — for the SUB-AGENT too (user rule:
                // no agent searches files through the shell; the search tools
                // exist for both). MEASURED: 63% of traced calls arrive as
                // `cd <path> && …`, so the gate reads the real statements, not
                // the first word.
                (
                    "blocked: the terminal does not locate files. Use `grep` (one token, with path= and include=), `glob` (file names), `find_symbol` (a symbol's definition AND every usage in ONE call), or ONE `explore` delegation for a broad hunt.".into(),
                    false,
                )
            } else if name == "run_terminal"
                && req.mode != "subagent"
                && workspace_file_read(args["command"].as_str().unwrap_or_default(), &root)
            {
                // A WORKSPACE file is read with `read`, which takes several
                // files and windows in ONE call and bounds its output, so a
                // truncated read continues by offset instead of a second shell
                // round-trip. Reading a log under /tmp stays a terminal job:
                // `read` is scoped to the workspace.
                (
                    "blocked: the terminal does not read workspace files. Use `read` with ranges=[{path,offset,limit}] — it takes SEVERAL files and windows in ONE call and its output is bounded, so continue it with offset= instead of dumping it with `cat`/`sed -n`.".into(),
                    false,
                )
            } else if name == "run_terminal"
                && !caps.write_files
                && is_mutating_command(args["command"].as_str().unwrap_or_default())
            {
                // A mode that may not write must not reach the disk through the
                // shell either: `echo x > f`, `sed -i`, `git commit` all change
                // the workspace without ever calling `write_file`, so gating the
                // tool NAME alone left Plan mode able to rewrite the whole tree.
                // A GUI-app launcher is NOT a workspace write, but it is not an
                // inspection either (traced mvrvau0r r63: MT5 launch in ask) —
                // it gets its own line in the refusal so the model does not
                // retry the SAME command and burn the round twice.
                let cmd = args["command"].as_str().unwrap_or_default();
                let mut msg = "blocked: this turn is read-only — `run_terminal` may only inspect here \
(build, test, lint, git status/diff/log). Writing through the shell is not allowed in this \
 mode; give the concrete change instead and tell the user to switch to Build mode to apply it."
                        .to_string();
                if !is_mutating_command(cmd) {
                    msg.push_str("\n(this command itself is not a workspace write — it launches or \
controls an outside app; switch to Build mode, or ask the user to run it)");
                }
                (msg, false)
            } else if name == "run_terminal" && args["background"].as_bool().unwrap_or(false) {
                // Background terminal — the agent's dev-server/watcher escape.
                // The command detaches, output streams into a log, and THIS
                // call returns at once, so a `vite` never burns the timeout on
                // the turn. Deliberately AFTER the read-only gate above: a
                // background command writes the world exactly like a
                // foreground one, so a read-only mode is still read-only here.
                // Attributed to req.chat_id so the right panel lists the
                // terminal under the chat that started it.
                match crate::agent_terminals::spawn(&root, &req.chat_id, args["command"].as_str().unwrap_or_default()) {
                    Ok(info) => (crate::agent_terminals::model_text(&info), true),
                    Err(e) => (format!("cannot start background terminal: {e}"), false),
                }
            } else if name == "plugin" {
                // The ONE door to a bundle's scripts. Binding the whole tool
                // behind the authoring flag meant a scheduled Build run — which
                // sends `allow_create: false` and has nobody to ask — could not
                // even LIST a bundle's scripts, so a plugin that ships one was
                // usable there only through a shell line written into a skill
                // body. Reading a bundle and running a script on disk are acts
                // like `run_terminal`, so they stay; only the write actions need
                // the flag, and the schema already hides them (this is the
                // backstop for a stale transcript).
                let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
                if plugin_action_needs_authoring(&action) && !req.allow_create {
                    (
                        format!(
                            "blocked: `plugin action={action}` saves a bundle, which needs the \
user to ask for it. Available this turn: `list` and `run`."
                        ),
                        false,
                    )
                } else if let Some(refusal) = plugin_mode_refusal(&action, &caps) {
                    // A bundle's script IS a command: it follows the terminal
                    // capability, not `write_files` (see plugin_mode_refusal).
                    (refusal, false)
                } else {
                    // Sequential dispatch must NOT park the async worker: these
                    // handlers block (terminal, plugin scripts — up to the tool
                    // budget). Same pattern as the read-only batch loop above.
                    let root_sb = root.clone();
                    let name_sb = name.to_string();
                    let args_sb = args.clone();
                    let permit_sb = permit.clone();
                    let skill_root_sb = skill_root.clone();
                    match tokio::task::spawn_blocking(move || {
                        tools::dispatch_bounded(
                            &root_sb,
                            &name_sb,
                            &args_sb,
                            permit_sb.as_ref(),
                            Some(&skill_root_sb),
                        )
                    })
                    .await
                    .unwrap_or(Err("tool task failed".into()))
                    {
                        Ok(r) => {
                            // Only an UPDATE pins the badge: a fresh install or
                            // create announces itself once and is done — the
                            // user never keeps working on what they merely built.
                            if action == "update" {
                                let data_root = if req.data_root.trim().is_empty() {
                                    native_data_root()
                                } else {
                                    req.data_root.clone()
                                };
                                let store = std::path::Path::new(&data_root);
                                let slug = crate::plugins::plugin_ref(&args);
                                let pin_name = {
                                    let n = args["name"].as_str().unwrap_or("").trim();
                                    if n.is_empty() {
                                        slug.clone()
                                    } else {
                                        n.to_string()
                                    }
                                };
                                let dir = crate::plugins::plugin_dir_pub(store, &slug);
                                emit(&AgentEvent::EditTarget {
                                    target: "plugin".into(),
                                    action: action.clone(),
                                    name: pin_name,
                                    path: dir.to_string_lossy().to_string(),
                                });
                            }
                            (r, true)
                        }
                        Err(e) => (e, false),
                    }
                }
            } else if name == "schedule" && req.headless {
                // The backstop next to the plugin gate, and the ONLY one left on
                // `schedule`: a user-invoked turn authors schedules in every mode
                // (the store is not the workspace, so `write_files` does not apply).
                // An unattended run has nobody to approve a write to that store, so
                // its schema is list-only (`compact_schedule_schema`) and any
                // create/update/toggle/delete that still arrives is a stale
                // transcript — refused before it reaches the store.
                let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
                match schedule_mode_refusal(&action, true) {
                    Some(refusal) => (refusal, false),
                    None => {
                        let root_sb = root.clone();
                        let name_sb = name.to_string();
                        let args_sb = args.clone();
                        let skill_root_sb = skill_root.clone();
                        match tokio::task::spawn_blocking(move || {
                            tools::dispatch_bounded(
                                &root_sb,
                                &name_sb,
                                &args_sb,
                                None,
                                Some(&skill_root_sb),
                            )
                        })
                        .await
                        .unwrap_or(Err("tool task failed".into()))
                        {
                            Ok(r) => (r, true),
                            Err(e) => (e, false),
                        }
                    }
                }
            } else if crate::tools::is_batch_tool(&name) {
                // Per-op caps gating happens HERE — the only place the turn's
                // caps live: an op the turn may not run is pre-marked
                // `refused` and comes back as an inline refusal while the rest
                // of the batch executes. Refusing the WHOLE batch would burn
                // the very round the batch exists to save; running a forbidden
                // op would break the mode's contract.
                let mut batch_args = args.clone();
                // Parse through the SAME tolerant reader the executor uses
                // (`tools::batch_ops`): reading `ops` with `as_array_mut` here
                // and with a bare `as_array` there let a stringified `ops` slip
                // PAST this gate — the array form was never found, so no op was
                // marked and the mode's read-only contract was bypassed by
                // malformed JSON. One parser, one verdict. An unusable shape is
                // left untouched for the executor to reject with its message.
                if let Ok(normalized) = tools::batch_ops(&batch_args) {
                    // The tools this turn really advertises. A delegation gate
                    // only redirects to `grep`/`read` when they are bound.
                    let bound: std::collections::HashSet<&str> = schemas
                        .iter()
                        .filter_map(|s| s["function"]["name"].as_str())
                        .collect();
                    let mut ops = normalized;
                    for op in ops.iter_mut() {
                        // Resolve the alias FIRST: the executor runs `run_command`
                        // as `run_terminal`, so gating on the raw name let a
                        // read-only turn slip a mutating shell op through this
                        // very gate and only discover it one level down.
                        let raw =
                            op["tool"].as_str().unwrap_or_default().trim().to_ascii_lowercase();
                        let tool = tools::batch_tool_name(&raw).unwrap_or(raw);
                        let reason = batch_op_refusal(
                            &caps,
                            &tool,
                            &op["args"],
                            &req.mode,
                            &root,
                            // The child's REAL tool list, not a guess: a profile
                            // narrowed to `read` has no `grep` to switch to.
                            bound.contains("grep"),
                            bound.contains("read"),
                        );
                        if let Some(reason) = reason {
                            op["refused"] = json!(reason);
                        }
                    }
                    if let Some(obj) = batch_args.as_object_mut() {
                        obj.insert("ops".into(), json!(ops));
                    }
                }
                // Sequential dispatch must NOT park the async worker (terminal
                // ops block) — same pattern as the plugin arm, with the live
                // tail so terminal output inside the batch still streams.
                let (tail_tx, mut tail_rx) =
                    tokio::sync::mpsc::unbounded_channel::<(String, String)>();
                let id_tail = id.clone();
                let tail_tx_sink = tail_tx.clone();
                let sink: tools::TailSink =
                    Arc::new(move |tail: &str| {
                        let _ = tail_tx_sink.send((id_tail.clone(), tail.to_string()));
                    });
                let root_sb = root.clone();
                let name_sb = name.to_string();
                let skill_root_sb = skill_root.clone();
                let permit_sb = permit.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    tools::dispatch_bounded_with(
                        &root_sb,
                        &name_sb,
                        &batch_args,
                        permit_sb.as_ref(),
                        Some(&skill_root_sb),
                        Some(&sink),
                    )
                });
                drop(tail_tx);
                while let Some((cid, tail)) = tail_rx.recv().await {
                    emit(&AgentEvent::ToolOutput { id: cid, tail });
                }
                match handle.await.unwrap_or(Err("tool task failed".into())) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else if name == "computer" && computer_owner.is_some() {
                // Same ownership rule as the browser: the profile is the only
                // door, so a direct call here is stale or hallucinated.
                let owner = computer_owner.as_deref().unwrap_or_default();
                (
                    format!(
                        "The desktop is owned by the `{owner}` sub-agent this turn. Do NOT call \
`computer` directly: call `agent__{owner}` with a description and the task as `prompt`."
                    ),
                    false,
                )
            } else if name == "computer" {
                // Bound only when the user enabled Computer Use; the schema is
                // withheld otherwise, so reaching here means it is allowed.
                // The SWITCH says the user is willing to allow desktop work in
                // principle — it is not a per-task grant, so the first action of
                // a task asks, with the act as the reason. An allow covers the
                // rest of THIS turn (a click, then a type, then a check is one
                // task, not three popups). A child turn was already approved at
                // the delegation boundary.
                let allowed = if desktop_approved
                    || req.mode == "subagent"
                    // "Always in this chat": the renderer re-sends the grant
                    // every turn, so the conversation never re-prompts. The
                    // composer switch alone (allow_computer) still asks per
                    // task — only the explicit chat grant skips the popup.
                    || req.allow_computer_chat
                {
                    true
                } else {
                    let why = crate::computer::permission_reason(&args);
                    let ok = ask_desktop_access(
                        emit,
                        &req.chat_id,
                        cancel,
                        "Control the desktop",
                        &why,
                        req.headless,
                    )
                    .await;
                    desktop_approved = ok;
                    ok
                };
                if !allowed {
                    (denied_desktop(&crate::computer::permission_reason(&args)), false)
                } else {
                    match crate::computer::run(&args) {
                        Ok(o) => {
                            // The capture must be HANDED to the model, not described
                            // to it: the result used to be the path alone, so the
                            // agent asked for a screenshot, received a filename and
                            // clicked blind. The pixels are attached to the next
                            // request instead (see `step_shots` after this phase).
                            for shot in o.shots {
                                emit(&AgentEvent::Tool {
                                    id: format!("{id}-shot"),
                                    name: "computer".into(),
                                    args: json!({"action": "screenshot", "path": shot.path}),
                                    result: shot.path.clone(),
                                    ok: true,
                                    results: None,
                                    engine: None,
                                });
                                step_shots.push(shot);
                            }
                            (o.text, true)
                        }
                        Err(e) => (e, false),
                    }
                }
            } else if crate::browser_driver::handles(name) {
                // Native browser driver. This arm MUST precede the MCP arm: the
                // MCP name set is captured before the native-wins filter, so a
                // tool this app advertises natively would otherwise be routed to
                // the connector it replaced.
                //
                // OWNERSHIP gate: a turn with a reachable Browser Navigator has
                // no browser_* schemas, so reaching here means a stale
                // transcript or a hallucinated name. Refuse it and name the
                // delegation tool instead of silently doing the work directly —
                // that would leave the profile unused and the chat without the
                // sub-agent's report.
                if let Some(owner) = browser_owner.as_deref() {
                    (
                        format!(
                            "The browser is owned by the `{owner}` sub-agent this turn. \
Do NOT call browser_* directly: call `agent__{owner}` with a description and the task as \
`prompt` — it drives the page and returns the result."
                        ),
                        false,
                    )
                } else if !req.allow_browser {
                    (
                        "The Browser is switched off for this turn (composer → MCP tools → Browser). \
                         Ask the user to enable it before browsing."
                            .to_string(),
                        false,
                    )
                } else {
                    let op = crate::browser_driver::action_of(name)
                        .unwrap_or_default()
                        .to_string();
                    let chat = req.chat_id.clone();
                    let args_for_call = args.clone();
                    match tokio::task::spawn_blocking(move || {
                        crate::browser_driver::run(&op, &args_for_call, &chat)
                    })
                    .await
                    {
                        Ok(Ok(r)) => (r, true),
                        Ok(Err(e)) => (e, false),
                        Err(e) => (format!("browser task failed: {e}"), false),
                    }
                }
            } else if name == "load_plugin" {
                // The plugin is ALWAYS the unit that gets loaded: `slug` alone
                // returns every skill body and activates its connectors.
                // `slug` + `skill` narrows to ONE body from INSIDE that plugin,
                // which is how a 24-skill library is used without paying for
                // all of it. A bare skill name never loads directly: it names
                // its owning plugin and asks the model to load that plugin.
                let store = std::path::Path::new(&skill_root);
                let slug = args["slug"].as_str().unwrap_or("").trim();
                let query = args["query"].as_str().unwrap_or("").trim();
                let skill = args["skill"].as_str().unwrap_or("").trim();
                let file = args["file"].as_str().unwrap_or("").trim();
                // An identical load is pure waste: the toolbox / skill body is
                // already in the context above (a full `instagram-api-less`
                // toolbox is ~9K chars, and traced runs loaded it again inside
                // a sub-agent). The key lives in `seen_lookups`, so a FOLD that
                // elides the earlier result removes it too — the model can
                // always re-read text it can no longer see. A `query` search is
                // not keyed: it is a cheap lookup whose result may differ.
                let load_key = lookup_key(name, &args);
                if load_key
                    .as_ref()
                    .is_some_and(|key| seen_lookups.contains(key))
                {
                    let what = if !skill.is_empty() {
                        "This skill text"
                    } else {
                        "This plugin/toolbox"
                    };
                    (
                        format!(
                            "{what} is ALREADY loaded in this turn — its text is in your context \
                             above. Do not load it again: use that text, or ask for a specific \
                             skill file you still need."
                        ),
                        true,
                    )
                } else {
                    let outcome = if !file.is_empty() && skill.is_empty() {
                        (
                            "load_plugin needs `skill` with `file`: the extra file belongs to one \
                             skill of the plugin."
                                .to_string(),
                            false,
                        )
                    } else if slug.is_empty() && !skill.is_empty() {
                        // No bare-skill shortcut: name the OWNING plugin and
                        // make the model load that plugin (optionally narrowed
                        // to this skill). This keeps discovery plugin-first —
                        // the catalog/search always lead to a plugin, and the
                        // skill is used from inside the toolbox that carries it.
                        match crate::plugins::plugin_of_skill(store, skill) {
                            Some(owner) => (
                                format!(
                                    "load_plugin needs the plugin `slug`: {skill:?} lives inside \
                                     {owner:?}. Call load_plugin with slug={owner} skill={skill} \
                                     to read that one body, or slug={owner} for the whole \
                                     toolbox (its connectors and every skill)."
                                ),
                                false,
                            ),
                            None => (
                                format!(
                                    "load_plugin needs the plugin `slug` — {skill:?} is not a \
                                     skill of any enabled plugin. Call load_plugin with `query` \
                                     to find the plugin that carries the skill you need."
                                ),
                                false,
                            ),
                        }
                    } else if slug.is_empty() && !query.is_empty() {
                        match crate::plugins::search_plugins(store, query) {
                            Ok(found) => (found, true),
                            Err(e) => (e, false),
                        }
                    } else if slug.is_empty() {
                        (
                            "load_plugin needs a plugin `slug` (or a `query` of the task's words \
                             to search every installed plugin)."
                                .to_string(),
                            false,
                        )
                    } else if !skill.is_empty() {
                        let read = if file.is_empty() {
                            crate::plugins::plugin_skill_body(store, slug, skill)
                        } else {
                            crate::plugins::plugin_skill_file(store, slug, skill, file)
                        };
                        match read {
                            Ok(body) => (body, true),
                            Err(e) => (e, false),
                        }
                    } else {
                        match crate::plugins::plugin_toolbox(store, slug) {
                            Ok(toolbox) => {
                                let mut loaded: Vec<String> = Vec::new();
                                let mut missing: Vec<String> = Vec::new();
                                for wanted in &toolbox.connectors {
                                    match crate::mcp_index::resolve_server(&connectors, wanted) {
                                        Some(server) => {
                                            let count = activate_connector(
                                                &server,
                                                &connectors,
                                                &deferred,
                                                &mut activated,
                                                &mut advertised,
                                                &mut schemas,
                                            );
                                            loaded.push(if count == 0 {
                                                format!("{server} (already loaded)")
                                            } else {
                                                format!("{server} ({count} tools)")
                                            });
                                        }
                                        None => missing.push(wanted.clone()),
                                    }
                                }
                                if !loaded.is_empty() {
                                    let mut all: Vec<String> = activated.iter().cloned().collect();
                                    all.sort();
                                    emit(&AgentEvent::McpLoaded { servers: all });
                                }
                                let mut out = toolbox.text;
                                if loaded.is_empty() {
                                    out.push_str("\nConnectors: none switched on.");
                                } else {
                                    out.push_str(&format!(
                                        "\nConnectors activated for your next step: {}.",
                                        loaded.join(", ")
                                    ));
                                }
                                if !missing.is_empty() {
                                    out.push_str(&format!(
                                        "\nConnectors that could not start: {} — tell the user to \
                                         check them in Settings → MCP.",
                                        missing.join(", ")
                                    ));
                                }
                                (out, true)
                            }
                            Err(e) => (e, false),
                        }
                    };
                    // Only a SUCCESS joins the guard: a bad slug must keep its
                    // real error, and a retry after a transient failure must
                    // still reach the store.
                    if outcome.1 {
                        if let Some(key) = load_key {
                            seen_lookups.insert(key);
                        }
                    }
                    outcome
                }
            } else if name == "use_mcp" {
                // Connectors are OFFERED as an index and loaded on demand: the
                // whole catalogue of every switched-on connector was 59K tokens
                // per round trip on a real trace, for connectors the turn never
                // touched. Activating here cannot add to `schemas` mid-turn —
                // the tool array must stay byte-identical across rounds or the
                // prefix cache breaks — so the call reports what is already
                // loaded and how to reach the rest, and the names it asks for
                // are recorded for the next turn's array.
                let asked = args["server"].as_str().unwrap_or_default().trim();
                if asked.is_empty() {
                    if connectors.is_empty() {
                        (
                            "No MCP connector is switched on in this chat. ".to_string(),
                            false,
                        )
                    } else {
                        let list: Vec<String> = connectors
                            .iter()
                            .map(|c| format!("{} ({} tools)", c.server, c.tools.len()))
                            .collect();
                        (format!("Connectors available: {}", list.join(", ")), true)
                    }
                } else if let Some(server) = crate::mcp_index::resolve_server(&connectors, asked) {
                    // Activated in THIS turn's array already? Then it is loaded
                    // and the tools are directly callable — say so instead of
                    // claiming a second round trip is needed.
                    if activated.contains(&server) {
                        (
                            format!("MCP connector {server:?} is already loaded in this turn."),
                            true,
                        )
                    } else {
                        let fresh_count = activate_connector(
                            &server,
                            &connectors,
                            &deferred,
                            &mut activated,
                            &mut advertised,
                            &mut schemas,
                        );
                        let tools = connectors
                            .iter()
                            .find(|c| c.server == server)
                            .map(|c| c.tools.join(", "))
                            .unwrap_or_default();
                        // Tell the renderer to persist the set: without the echo the
                        // model would ask again on the next turn, and the index
                        // would re-charge the round trip this module exists to save.
                        let mut all: Vec<String> = activated.iter().cloned().collect();
                        all.sort();
                        emit(&AgentEvent::McpLoaded { servers: all });
                        (
                            format!(
                                "MCP connector {server:?} is now loaded: its {fresh_count} tool(s) \
                                 are callable from your next step. Tools: {tools}"
                            ),
                            true,
                        )
                    }
                } else {
                    let list: Vec<&str> = connectors.iter().map(|c| c.server.as_str()).collect();
                    (
                        format!(
                            "no such MCP connector: {asked:?}. Switched on here: {}",
                            if list.is_empty() {
                                "(none)".to_string()
                            } else {
                                list.join(", ")
                            }
                        ),
                        false,
                    )
                }
            } else if crate::mcp_index::owner_of(&connectors, name).is_some()
                || name.starts_with(crate::mcp::TOOL_PREFIX)
            {
                // The SAME map whose schemas the model was shown: a connector that
                // only an enabled plugin provides is advertised here, so it must
                // also be executable. Passing `req.mcp_servers` made every such
                // call fail with "not enabled for this turn" — the tool was
                // visible and unusable at once.
                match crate::mcp::call_tool(&mcp_servers, name, &args) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else if name == "update_plan" {
                // Persist the checklist next to plan.md AND echo it back as the
                // authoritative list: the renderer replaces its Todos with it,
                // and the file survives a restart (read back into the prompt by
                // the SAVED PLAN / CHECKLIST blocks above).
                let data_root = if req.data_root.trim().is_empty() {
                    native_data_root()
                } else {
                    req.data_root.clone()
                };
                let ws = crate::plans::workspace_slug_for_root(&root);
                crate::plans::save_checklist(&data_root, &ws, &req.chat_id, &args["items"]);                let stored = crate::plans::get_checklist(&data_root, &ws, &req.chat_id);
                emit(&AgentEvent::Plan {
                    items: stored.clone(),
                    chat_id: req.chat_id.clone(),
                });
                let total = stored.as_array().map(|a| a.len()).unwrap_or(0);
                let done = stored
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|i| i["status"].as_str() == Some("completed"))
                            .count()
                    })
                    .unwrap_or(0);
                (
                    format!("Checklist saved: {done}/{total} items completed."),
                    true,
                )
            } else if name == "ask_user" {
                // A scheduled run has NO renderer and NO user: the Ask event is
                // dropped and `await_answer` (deliberately deadline-free) parks
                // the run FOREVER. Answer at once instead, so the run keeps
                // going and the model learns to decide on its own.
                if req.headless {
                    eprintln!("[tool] ask_user: auto-answered (scheduled run has no user)");
                    (
                        "ask_user returned immediately: this is a SCHEDULED run and NOBODY can \
answer. Do not retry it. Decide with the most reasonable default for the task, state the \
assumption in your final output, and continue."
                            .to_string(),
                        true,
                    )
                } else {
                // Blocking question: emit the popup request, then WAIT (no
                // deadline — the user may take as long as they need).
                let gate = next_gate_id();
                emit(&AgentEvent::Ask {
                    id: gate.clone(),
                    question: args["question"].as_str().unwrap_or_default().to_string(),
                    options: args["options"].clone(),
                    // The multi-part form rides through raw: the renderer
                    // coerces titles/options and drops malformed sections.
                    sections: args["sections"].clone(),
                });
                match await_answer(&gate, &req.chat_id, cancel).await {
                    Some(v) => (
                        format!(
                            "The user answered: {}",
                            v["answer"].as_str().unwrap_or_default()
                        ),
                        true,
                    ),
                    None => (
                        "The user did not answer (the turn was stopped).".to_string(),
                        false,
                    ),
                }
                }
            } else if name == "confirm_action" || name == "request_permission" {
                // Same schedule contract: nobody can approve a headless run, so
                // DENY at once instead of parking the run on an open gate.
                if req.headless {
                    eprintln!(
                        "[tool] {name}: auto-denied (scheduled run has no user to approve)"
                    );
                    (
                        "NOT approved: this is a SCHEDULED run and nobody can approve anything. \
Do NOT perform the action. Keep the work inside the workspace, the OS temp folder and \
~/.codifa, or skip the step and note it in your final output."
                            .to_string(),
                        false,
                    )
                } else if req.allow_confirm_chat {
                    // "Always in this chat": the user pre-approved the model's
                    // confirmation asks for the rest of THIS conversation, so
                    // no popup is raised. The grant deliberately covers future
                    // asks the model phrases differently — that is the point —
                    // and the Deny path stays one click away on the next card.
                    (
                        "The user has pre-approved confirmation asks for this chat \
(\"Always in this chat\") — proceed with the action without asking again."
                            .to_string(),
                        true,
                    )
                } else {
                // Blocking permission gate: the action is NOT performed until
                // the user approves it in the popup.
                let gate = next_gate_id();
                let scope = if name == "confirm_action" {
                    "confirm"
                } else {
                    "permission"
                };
                emit(&AgentEvent::Permission {
                    id: gate.clone(),
                    action: args["action"]
                        .as_str()
                        .or_else(|| args["command"].as_str())
                        .unwrap_or_default()
                        .to_string(),
                    // MEASURED on live popups: the model usually omits `path`
                    // and names the target only inside `command`, so the card
                    // rendered no path at all. Derive it from the command's own
                    // shell targets — the same parse the access gate uses — so
                    // the user always sees WHICH path is being requested.
                    path: {
                        let explicit = args["path"].as_str().unwrap_or_default().trim();
                        if !explicit.is_empty() {
                            explicit.to_string()
                        } else {
                            shell_targets(args["command"].as_str().unwrap_or_default())
                                .into_iter()
                                .next()
                                .unwrap_or_default()
                        }
                    },
                    reason: args["reason"].as_str().unwrap_or_default().to_string(),
                    scope: scope.to_string(),
                    // A model-driven request names no subtree; only the
                    // outside-workspace gate (`ask_outside_access`) computes one.
                    folder: String::new(),
                });
                match await_answer(&gate, &req.chat_id, cancel).await {
                    Some(v) if v["allowed"].as_bool().unwrap_or(false) => (
                        "The user APPROVED the action — proceed with it.".to_string(),
                        true,
                    ),
                    Some(_) => (
                        "The user DENIED the action. Do NOT perform it — find another \
                         approach or ask what to do instead."
                            .to_string(),
                        false,
                    ),
                    None => (
                        "The user did not answer (the turn was stopped).".to_string(),
                        false,
                    ),
                }
                }
            } else if name == "web_search" {
                // Native web search: the engine chain is the user's Settings →
                // Web Providers order, so this must run here (async) rather than
                // in the sync `tools::dispatch`.
                let query = args["query"].as_str().unwrap_or_default();
                let max = web_search_result_count(req.web_search_auto_fetch);
                // Search, then fetch the real page content of the top results
                // (Settings → Web Providers → Results per search). A snippet is
                // rarely enough to answer, and the distiller below can only work
                // with what it is given.
                match crate::websearch::search_with_pages(
                    &req.search_plugins,
                    query,
                    max,
                    req.web_search_auto_fetch,
                )
                .await
                {
                    Ok((hits, pages, engine)) => {
                        ui_engine = Some(engine);
                        let rows: Vec<Value> = hits
                            .iter()
                            .map(|h| {
                                let url = h["url"].as_str().unwrap_or_default();
                                json!({
                                    "title": h["title"],
                                    "url": h["url"],
                                    "snippet": h["snippet"],
                                    "fetched": pages.iter().any(|(u, _)| u == url),
                                })
                            })
                            .collect();
                        ui_results = Some(Value::Array(rows));
                        let raw = crate::websearch::search_answer(query, &hits, &pages);
                        // A dedicated Web slot model distils the results so the
                        // main agent's context stays lean (Claude-Code style).
                        // With no slot configured the raw results ARE the answer
                        // — which is exactly the old behaviour, so "no Other
                        // model set" is never a regression.
                        match run_slot_distill(
                            &client,
                            req,
                            &cfg,
                            WEB_DISTILL_SYSTEM_PROMPT,
                            &format!("QUERY: {query}\n\nSEARCH RESULTS:\n{raw}"),
                        )
                        .await
                        {
                            Some(distilled) => (
                                format!("WEB RESULTS for {query:?} (distilled)\n{distilled}"),
                                true,
                            ),
                            None => (raw, true),
                        }
                    }
                    Err(e) => (e, false),
                }
            } else if name == "fetch_url" {
                // Page fetch: the same call `web_search` uses internally, but
                // with the lifted cap and the offset paging the model needs to
                // read one specific document in full.
                let url = args["url"].as_str().unwrap_or_default();
                let full = args["full"].as_bool().unwrap_or(false);
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                // A raw/source URL (or an explicit full=true) is ALWAYS returned
                // whole: relying on the model to remember `full` made skill
                // installs come back as a tiny excerpt and the agent re-fetch
                // the same file.
                let cap = if full || looks_like_source_url_agent(url) {
                    crate::websearch::MAX_FETCH_BYTES
                } else {
                    crate::websearch::FETCH_EXCERPT_CHARS
                };
                match crate::websearch::fetch_page(&client, url, cap, offset).await {
                    Ok(page) => {
                        // ALWAYS an array: the tool card's shared renderer
                        // (`WebResultLinks`) maps over `results`, and a single
                        // object made `fetch_url` show no links at all (and left a
                        // latent `.map is not a function` one refactor away).
                        ui_results = Some(json!([{
                            "title": page.title,
                            "url": page.url,
                            "snippet": String::new(),
                            "fetched": true,
                        }]));
                        let next = offset + page.content.chars().count();
                        let note = if page.total_chars > next {
                            format!(
                                "\n\n[truncated: showing chars {offset}..{next} of {}; 
call fetch_url again with offset={next} for the rest]",
                                page.total_chars
                            )
                        } else {
                            String::new()
                        };
                        let heading = if page.title.is_empty() {
                            page.url.clone()
                        } else {
                            format!("{}\n{}", page.title, page.url)
                        };
                        // The page is distilled by the "Other" (web) slot model
                        // — the SAME model that answers `web_search`. A raw page
                        // is up to MAX_FETCH_BYTES (1 MB) and would flood the main
                        // agent's context; the slot keeps it lean. Skipped for a
                        // short page (nothing to gain) and whenever the slot is
                        // unset, in which case the page is returned verbatim —
                        // exactly the previous behaviour.
                        // Only PROSE is distilled. A raw source file / explicit
                        // full read, and any paged continuation (offset > 0),
                        // must stay verbatim: distilling code destroys the very
                        // identifiers the model fetched it for, and distilling
                        // each page of a continuation makes the chunks impossible
                        // to concatenate.
                        let distillable = !full && offset == 0 && !looks_like_source_url_agent(url);
                        let body = if distillable
                            && page.content.chars().count() > FETCH_DISTILL_MIN_CHARS
                        {
                            match run_slot_distill(
                                &client,
                                req,
                                &cfg,
                                FETCH_DISTILL_SYSTEM_PROMPT,
                                &format!("URL: {}\n\nPAGE:\n{heading}\n\n{}", page.url, page.content),
                            )
                            .await
                            {
                                Some(distilled) => format!("{heading}\n\n{distilled}"),
                                None => format!("{heading}\n\n{}", page.content),
                            }
                        } else {
                            format!("{heading}\n\n{}", page.content)
                        };
                        (format!("{body}{note}"), true)
                    }
                    Err(e) => (format!("ERROR fetching {url}: {e}"), false),
                }
            } else if name == "generate_image" || name == "edit_image" || name == "generate_video" {
                // Media GENERATION through the user's configured provider slot
                // (Settings → Media Providers). Async provider HTTP, so this is
                // an in-loop arm like web_search; the fallback ladder is the
                // slot's own ordered fallbacks, walked per call.
                let prompt = args["prompt"].as_str().unwrap_or_default().trim().to_string();
                if prompt.is_empty() && name != "generate_video" {
                    (format!("{name} needs a `prompt`"), false)
                } else if name == "generate_video" && prompt.is_empty() {
                    ("generate_video needs a `prompt`".to_string(), false)
                } else {
                    let (slot_provider, slot_model, slot_fallbacks, slot_word) = if name == "generate_video" {
                        (
                            req.video_provider_id.as_str(),
                            req.video_model.as_str(),
                            req.video_fallbacks.clone(),
                            "video",
                        )
                    } else {
                        (
                            req.image_provider_id.as_str(),
                            req.image_model.as_str(),
                            req.image_fallbacks.clone(),
                            "image",
                        )
                    };
                    // The SLOT default model is the only model reachable here:
                    // the schema exposes no per-call `model` argument, so a
                    // tool-supplied override is impossible by construction
                    // (model choice is a user setting, never an agent lever).
                    let ladder = crate::media_gen::media_ladder(
                        slot_provider,
                        slot_model,
                        &slot_fallbacks,
                        &req.providers,
                    );
                    if ladder.is_empty() {
                        (
                            crate::media_gen::not_configured_error(&format!("{slot_word} generation")),
                            false,
                        )
                    } else {
                        let size = args["size"].as_str();
                        // Read-only modes (Ask/Plan) may generate media but may
                        // not AIM the write: `output` is ignored there, so the
                        // file always lands on the minted unique chat-media
                        // name and can never overwrite anything by name.
                        let output = if caps.write_files { args["output"].as_str() } else { None };
                        // Generated media lives under the DATA ROOT, scoped to
                        // THIS chat (`~/.codifa/media/<chat>/…`) — never in the
                        // workspace. The workspace root stays available as a
                        // SOURCE for edit inputs (the user's own pictures).
                        let data_root = if req.data_root.trim().is_empty() {
                            native_data_root()
                        } else {
                            req.data_root.trim().to_string()
                        };
                        let chat_id = req.chat_id.trim().to_string();
                        let mut rung_errors: Vec<String> = Vec::new();
                        let mut done: Option<crate::media_gen::GeneratedMedia> = None;
                        for rung in &ladder {
                            let attempt = if name == "generate_image" {
                                crate::media_gen::generate_image(
                                    &data_root,
                                    &chat_id,
                                    rung,
                                    &prompt,
                                    size,
                                    output,
                                )
                                .await
                            } else if name == "edit_image" {
                                let path = args["path"].as_str().unwrap_or_default().trim();
                                if path.is_empty() {
                                    Err("edit_image needs the `path` of the image to edit".to_string())
                                } else {
                                    let mask = crate::media_gen::MaskRegion::from_args(&args["mask_region"]);
                                    crate::media_gen::edit_image(
                                        req.root.trim(),
                                        &data_root,
                                        &chat_id,
                                        rung,
                                        path,
                                        &prompt,
                                        mask,
                                        size,
                                        output,
                                    )
                                    .await
                                }
                            } else {
                                let seconds = args["seconds"].as_u64();
                                let image = args["image"].as_str();
                                crate::media_gen::generate_video(
                                    req.root.trim(),
                                    &data_root,
                                    &chat_id,
                                    rung,
                                    &prompt,
                                    seconds,
                                    size,
                                    image,
                                    output,
                                )
                                .await
                            };
                            match attempt {
                                Ok(m) => {
                                    done = Some(m);
                                    break;
                                }
                                Err(e) => {
                                    rung_errors.push(format!(
                                        "{} generation failed on {} (model {}): {e}",
                                        slot_word, rung.kind, rung.model
                                    ));
                                }
                            }
                        }
                        match done {
                            Some(m) => {
                                // A ROW ARRAY, like every other tool card's
                                // `results` (web_search rows, file links) —
                                // the renderer's resultRows only maps arrays.
                                ui_results = Some(json!([crate::media_gen::media_file_row(
                                    &m.rel_path,
                                    m.bytes,
                                    &m.mime,
                                )]));
                                (
                                    crate::media_gen::generated_summary(slot_word, &m, &ladder[0].kind),
                                    true,
                                )
                            }
                            // Join EVERY rung's error: previously only the last
                            // rung's failure survived, so earlier rungs that
                            // were actually tried looked like they never ran.
                            None => (rung_errors.join(" | "), false),
                        }
                    }
                }
            } else if name == "edit_video" {
                // LOCAL ffmpeg editing — no provider, no credit, just the
                // provisioned binary. Blocking children, so spawn_blocking;
                // the first call may download ffmpeg (~80MB, once).
                let action = args["action"].as_str().unwrap_or_default().trim().to_string();
                // Sources may be workspace files; OUTPUTS land in the chat's
                // media folder under the data root (never the workspace).
                let media_ctx = crate::media_edit::MediaCtx {
                    workspace_root: req.root.trim().to_string(),
                    data_root: if req.data_root.trim().is_empty() {
                        native_data_root()
                    } else {
                        req.data_root.trim().to_string()
                    },
                    chat_id: req.chat_id.trim().to_string(),
                };
                // Owned copy for the blocking closure — `args` itself must stay
                // put (the loop re-initializes it every step).
                let edit_args = args.clone();
                // Read-only modes may run local edits but may not aim the
                // write at a named path (same rule as the provider arm above).
                let write_ok = caps.write_files;
                let result = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, String), String> {
                    let bin = crate::media_edit::ensure_ffmpeg(&media_ctx.data_root)?;
                    let args = &edit_args;
                    let output_arg = if write_ok { args["output"].as_str() } else { None };
                    let mut files: Vec<String> = Vec::new();
                    let line = match action.as_str() {
                        "probe" => {
                            let path = args["path"].as_str().unwrap_or_default().trim().to_string();
                            if path.is_empty() {
                                return Err("edit_video probe needs `path`".into());
                            }
                            let (line, _info) = crate::media_edit::probe(&media_ctx, &bin, &path)?;
                            line
                        }
                        "trim" => {
                            let path = args["path"].as_str().unwrap_or_default().trim().to_string();
                            let (Some(start), Some(end)) = (
                                args["start"].as_f64(),
                                args["end"].as_f64(),
                            ) else {
                                return Err("edit_video trim needs `start` and `end` (seconds)".into());
                            };
                            let rel = crate::media_edit::trim(
                                &media_ctx,
                                &bin,
                                &path,
                                start,
                                end,
                                output_arg,
                            )?;
                            files.push(rel.clone());
                            format!("Trimmed {path} [{start:.2}s–{end:.2}s] → {rel}")
                        }
                        "merge" => {
                            let paths: Vec<String> = args["paths"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default();
                            let rel = crate::media_edit::merge(
                                &media_ctx,
                                &bin,
                                &paths,
                                output_arg,
                            )?;
                            files.push(rel.clone());
                            format!(
                                "Merged {} clips ({}) → {rel}",
                                paths.len(),
                                paths.join(", ")
                            )
                        }
                        "slideshow" => {
                            let paths: Vec<String> = args["paths"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default();
                            let seconds = args["seconds"].as_f64().unwrap_or(3.0);
                            let rel = crate::media_edit::slideshow(
                                &media_ctx,
                                &bin,
                                &paths,
                                seconds,
                                output_arg,
                            )?;
                            files.push(rel.clone());
                            format!(
                                "Slideshow from {} images ({seconds:.2}s each) → {rel}",
                                paths.len()
                            )
                        }
                        "frames" => {
                            let path = args["path"].as_str().unwrap_or_default().trim().to_string();
                            let at: Vec<f64> = args["at"]
                                .as_array()
                                .map(|a| a.iter().filter_map(Value::as_f64).collect())
                                .unwrap_or_default();
                            let rels = crate::media_edit::extract_frames(&media_ctx, &bin, &path, &at)?;
                            files.extend(rels.iter().cloned());
                            format!(
                                "Extracted {} frame(s) from {path}: {}\n\
                                 Feed one of these paths to edit_image to re-generate a moment.",
                                rels.len(),
                                rels.join(", ")
                            )
                        }
                        "convert" => {
                            let path = args["path"].as_str().unwrap_or_default().trim().to_string();
                            let format = args["format"].as_str().unwrap_or_default().trim().to_string();
                            let rel = crate::media_edit::convert(
                                &media_ctx,
                                &bin,
                                &path,
                                &format,
                                output_arg,
                            )?;
                            files.push(rel.clone());
                            format!("Converted {path} → {format}: {rel}")
                        }
                        other => {
                            return Err(format!(
                                "edit_video: unknown action `{other}` (probe | trim | merge | slideshow | frames | convert)"
                            ))
                        }
                    };
                    Ok((files, line))
                })
                .await
                .map_err(|e| format!("edit_video join failed: {e}"));
                match result {
                    Ok(Ok((files, line))) => {
                        if !files.is_empty() {
                            // Row array, same contract as the provider arm above.
                            ui_results = Some(json!(files.iter().map(|f| {
                                crate::media_gen::media_file_row(f, 0, crate::media_gen::mime_for_path(f))
                            }).collect::<Vec<_>>() ));
                        }
                        // The display contract rides on EVERY success: the
                        // model must copy the reference into its reply.
                        let markdown = files
                            .iter()
                            .map(|f| format!("![{f}]({})", crate::media_gen::codifa_media_ref(f)))
                            .collect::<Vec<_>>()
                            .join("\n");
                        let line = if markdown.is_empty() {
                            line
                        } else {
                            format!("{line}\n{markdown}")
                        };
                        (line, true)
                    }
                    Ok(Err(e)) => (e, false),
                    Err(e) => (e, false),
                }
            } else if name == "artifact" {
                // Artifacts must emit an event so the transcript grows a card
                // while the turn is still running — that is why this one is
                // handled inline instead of in `tools::dispatch`.
                let action = args["action"].as_str().unwrap_or("").trim().to_ascii_lowercase();
                let data_root = if req.data_root.trim().is_empty() {
                    native_data_root()
                } else {
                    req.data_root.clone()
                };
                let store = std::path::Path::new(&data_root);
                let chat_id = if req.chat_id.trim().is_empty() {
                    args["chat_id"].as_str().unwrap_or_default()
                } else {
                    req.chat_id.as_str()
                };
                match action.as_str() {
                    // Delete removes the document instead of saving a version:
                    // the caller names an existing id, and the artifact tool is
                    // the only writer of this folder tree.
                    "delete" => {
                        let id = args["id"].as_str().unwrap_or("").trim();
                        if id.is_empty() {
                            ("artifact delete requires id".to_string(), false)
                        } else {
                            match crate::artifacts::delete(store, chat_id, id) {
                                Ok(_) => (format!("Artifact deleted: {id}"), true),
                                Err(e) => (e, false),
                            }
                        }
                    }
                    "create" | "update" => {
                        let create = action == "create";
                        match crate::artifacts::save(store, chat_id, &args, create) {
                            Ok(saved) => {
                                // Plan mode may save the plan as a markdown
                                // artifact instead of writing it in prose.
                                if req.mode == "plan" && saved["kind"].as_str() == Some("md") {
                                    let title =
                                        saved["title"].as_str().unwrap_or_default();
                                    let content =
                                        saved["content"].as_str().unwrap_or_default();
                                    if let Some(doc) =
                                        plan_document_from_artifact(title, content)
                                    {
                                        // A plan is a Plan-tab document, not an
                                        // artifact: tag it so the Artifacts page
                                        // stops listing it. The transcript card
                                        // still opens it from the chat.
                                        let _ = crate::artifacts::mark_plan(
                                            store,
                                            chat_id,
                                            saved["id"].as_str().unwrap_or_default(),
                                        );
                                        plan_artifact = Some(doc);
                                    }
                                }
                                // Only an update pins the editor badge: a fresh
                                // create announces itself once and is done.
                                if !create {
                                    let dir = crate::artifacts::chat_dir_pub(
                                        store,
                                        chat_id,
                                        saved["id"].as_str().unwrap_or_default(),
                                    );
                                    emit(&AgentEvent::EditTarget {
                                        target: "artifact".into(),
                                        action: action.clone(),
                                        name: saved["title"]
                                            .as_str()
                                            .unwrap_or_default()
                                            .to_string(),
                                        path: dir.to_string_lossy().to_string(),
                                    });
                                }
                                emit(&AgentEvent::Artifact {
                                    id: saved["id"].as_str().unwrap_or_default().to_string(),
                                    title: saved["title"].as_str().unwrap_or_default().to_string(),
                                    kind: saved["kind"].as_str().unwrap_or_default().to_string(),
                                    content: saved["content"].as_str().unwrap_or_default().to_string(),
                                    version: saved["version"].as_u64().unwrap_or(1),
                                    assets: saved["assets"]
                                        .as_array()
                                        .map(|list| {
                                            list.iter()
                                                .filter_map(|v| v.as_str().map(str::to_string))
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                });
                                let attached = saved["assets"]
                                    .as_array()
                                    .map(|list| list.len())
                                    .unwrap_or(0);
                                (
                                    format!(
                                        "Artifact saved: {} (v{}, {} supporting file(s))\nIt is now shown in the chat; open it to preview.",
                                        saved["title"].as_str().unwrap_or_default(),
                                        saved["version"].as_u64().unwrap_or(1),
                                        attached
                                    ),
                                    true,
                                )
                            }
                            Err(e) => (e, false),
                        }
                    }
                    other => (
                        format!("artifact requires action create, update or delete (got {other:?})"),
                        false,
                    ),
                }
            } else {
                // Generic sequential handlers (terminal-capable skills,
                // connectors) block too, so they run on the blocking pool.
                //
                // Live output: the blocking task streams its command's tail
                // through a channel while it runs (only `run_terminal` sends);
                // the pump forwards every tail to the UI and ends exactly when
                // the task drops the sender — so the emit stays single-threaded
                // and the await below sees the final result as before.
                let (tail_tx, mut tail_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
                let id_tail = id.clone();
                let tail_tx_sink = tail_tx.clone();
                let sink: tools::TailSink = Arc::new(move |tail: &str| {
                    let _ = tail_tx_sink.send((id_tail.clone(), tail.to_string()));
                });
                let root_sb = root.clone();
                let name_sb = name.to_string();
                let args_sb = args.clone();
                let skill_root_sb = skill_root.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    let out = tools::dispatch_bounded_with(
                        &root_sb,
                        &name_sb,
                        &args_sb,
                        None,
                        Some(&skill_root_sb),
                        Some(&sink),
                    );
                    drop(sink);
                    out
                });
                drop(tail_tx);
                while let Some((cid, tail)) = tail_rx.recv().await {
                    emit(&AgentEvent::ToolOutput { id: cid, tail });
                }
                match handle
                    .await
                    .unwrap_or(Err("tool task failed".into()))
                {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            };
            // Emit the unified diff while the card is still "running" — the
            // frontend folds it into the card (and the Review panel) before
            // the Tool result resolves the card to done.
            // The diff serves TWO consumers now. The panel gets it as an event
            // while the card is still "running"; the MODEL gets it appended to
            // the tool result, which is what removes the verification round-trip
            // (measured: 78 of 131 edits spent their next round on a lone
            // read/grep of the same file, because the plain result said nothing
            // about what changed).
            let mut applied_diff: Option<String> = None;
            // EVERY file the call named gets its own snapshot pair, so a batch
            // naming a different file per entry emits a diff per file. The loop
            // runs on failure too: a multi-file write whose LATER entry failed
            // still changed the earlier ones, and a failed edit leaves old ==
            // new — the empty diff skips itself below.
            for (p, old) in &pre_edit {
                // `permit` again: an approved out-of-tree write must produce its
                // diff too, and `resolve_safe(.., false, None)` refused exactly
                // the paths the user had just said yes to.
                if let Ok(target) = crate::tools::resolve_safe(&root, p, false, permit.as_ref()) {
                    let newc = std::fs::read_to_string(target).unwrap_or_default();
                    let diff = crate::tools::unified_diff(p, old, &newc);
                    if !diff.is_empty() {
                        // Net change since the turn's first snapshot of this
                        // file; sent BEFORE `Diff`, while the card is still
                        // "running", so the frontend attaches it to the same card.
                        let base = turn_base.entry(p.clone()).or_insert_with(|| old.clone());
                        let net = crate::tools::unified_diff(p, base, &newc);
                        emit(&AgentEvent::TurnDiff {
                            path: p.clone(),
                            diff: net,
                        });
                        emit(&AgentEvent::Diff {
                            tool: name.clone(),
                            path: p.clone(),
                            diff: diff.clone(),
                        });
                        applied_diff
                            .get_or_insert_with(String::new)
                            .push_str(&diff);
                    }
                }
            }
            let mut applied = match applied_diff {
                Some(diff) => result + &applied_change_block(&diff),
                None => result,
            };
            // Stamp the STALE-SOURCE note on a SUCCESSFUL writer whose file was
            // read/greped EARLIER IN THIS STEP (batch readers always run before
            // these sequential writers): that earlier result still carries the
            // pre-edit text on the wire, and the model rebuilds old_string from
            // exactly it — the measured 4-round edit-fail loop (run=106). One
            // appended line; writer results are short, so the cap can never cut
            // it, and `levers_fired` records the lever in the trace.
            if ok {
                if let Some(target) = writer_target_path(name, &args) {
                    if step_read_files.iter().any(|f| f == &target) {
                        applied.push_str(tools::POST_EDIT_STALE_NOTE);
                    }
                }
            }
            if let Some(p) = crate::commands::image_read_path(&applied) {
                step_read_images.push(p);
            }
            // Headless error log: a scheduled run has no chat panel, so a
            // failed tool card had NO trace in rust.log — the run row flipped
            // to `error` at the end carrying a reason nobody could trace back
            // to its step. One line per real failure; the interactive path is
            // untouched (its failure is already visible on its own card).
            if !ok && req.headless {
                let brief: String = applied.chars().take(200).collect();
                eprintln!("[tool] {name} failed: {brief}");
            }
            finish_tool(
                &mut messages,
                emit,
                &trace,
                id,
                name,
                &args,
                applied,
                ok,
                req.mode == "subagent",
                ui_results,
                ui_engine,
            );
            // Plugin `PostToolUse`: the call already happened, so this cannot veto
            // it — a handler's stdout is shipped back as extra information about
            // what just ran (a linter, a formatter, a policy note). Only a
            // non-empty print is appended, so a quiet handler costs nothing.
            if ok && !hooks.is_empty() {
                let after = crate::hooks::run_active(&hooks, "PostToolUse", name);
                if after.ran > 0 {
                    trace.record(crate::trace::TraceEntry {
                        kind: "hook".into(),
                        summary: format!("PostToolUse ran {} handler(s) for {name}", after.ran),
                        ..Default::default()
                    });
                }
                if !after.output.is_empty() {
                    messages.push(json!({
                        "role": "user",
                        "content": format!(
                            "=== POST-TOOL HOOK ({name}) ===\n{}",
                            after.output
                        ),
                    }));
                }
            }
        }

        // A step with a single call is a wasted model round trip when more
        // lookups were foreseeable. The hint rides on that call's own result,
        // so it costs no extra request and never cuts a report. The STREAK hint
        // takes the slot first at its two boundaries (see `round_hint`).
        //
        // For the MAIN agent's lone serial call the hint ESCALATES off
        // `lone_mutating_rounds` instead of repeating: a fixed string fired on
        // 16 consecutive rounds of one fresh chat and the model batched on ZERO
        // of them (wallpaper, exactly as the 423-of-863 corpus measurement
        // predicted). Sub-agent and explore shapes are unchanged — they are
        // already rare and correctly worded.
        if single_call_is_serial_with(&batch_caps, &tool_calls, &root) {
            lone_mutating_rounds += 1;
        } else {
            lone_mutating_rounds = 0;
        }
        // Deliver the escalating form on the first lone round and then every
        // third; on the rounds in between the streak hint still gets its turn.
        //
        // The old code ALSO went permanently silent past
        // `LONE_CALL_HINT_MAX_PER_TURN` deliveries, justified by "a delivered
        // hint rides the rest of the turn and is re-billed every round". That
        // premise is false: `strip_stale_hints` elides every hint but the newest
        // before each request, so a delivery costs its own round only. MEASURED
        // on trace `mvxsy14e`: the lever hit its cap at step 3 and the chat then
        // ran 14 more single-call rounds in total silence (16 of 19 rounds were
        // lone). So the cap is gone; the every-third rhythm below is what keeps
        // it from becoming wallpaper.
        let hints_are_quiet = lone_mutating_rounds > 1 && lone_mutating_rounds % 3 != 0;
        // The streak hint yields the slot, but it must not silence the round:
        // traced, a chat sat 34 lone-serial rounds deep and the quiet rounds
        // delivered nothing at all, because `discovery_streak_hint` returns
        // `None` whenever the discovery streak is below its boundary — which is
        // the normal state of a chat whose rounds are shell commands. Falling
        // back to the escalating text keeps the lever audible exactly where the
        // counter proves it is needed.
        // The streak nudge is resolved ONCE and reused, so "did the streak lever
        // speak" is answered by the value rather than re-derived.
        let streak_hint = discovery_streak_hint(&req.mode, discovery_streak);
        let hint: Option<Cow<'_, str>> = if hints_are_quiet {
            streak_hint
                .map(Cow::Borrowed)
                .or_else(|| {
                    single_call_hint_with(
                        &batch_caps,
                        &req.mode,
                        &tool_calls,
                        lone_mutating_rounds,
                        &root,
                    )
                })
        } else {
            // The escalating form keeps this slot for the WHOLE turn. It used to
            // yield to `discovery_streak_hint` once its cap was spent — and that
            // hint returns `None` unless the streak sits exactly on 3 or 7, so
            // the round went silent in the one state the counter proves is
            // wasteful: a long run of lone shell rounds.
            round_hint_with(
                &batch_caps,
                &req.mode,
                &tool_calls,
                discovery_streak,
                lone_mutating_rounds,
                &root,
            )
        };
        // Which lever spoke, counted apart: `hints_delivered` sums both, so it
        // rose on rounds where the model had in fact batched (traced:
        // `hints_after=24` on a two-call round) and could no longer tell whether
        // the escalating lever had fired at all. `lone_call_hints` counts only
        // this one — and `MAX_LONE_CALL_HINTS_PER_TURN` gates only this one.
        let lone_hint_str = hint.as_deref().map(str::to_string);
        let hint_lever = lone_hint_str
            .as_deref()
            .map(|h| hint_lever(&req.mode, discovery_streak, h))
            .unwrap_or(HintLever::Other);
        let hint_is_lone = hint_lever == HintLever::LoneCall;
        if let Some(hint) = hint {
            // The batching hint is a LESSON, not wallpaper: traced 6 Nov, one
            // session on a model that answers with exactly one tool call per
            // reply delivered it 103 times while batching stayed at zero —
            // every delivery rode the tool result and was re-sent on every
            // following round of the turn (pure cost, zero behavior change).
            // Two deliveries per turn is the whole lesson: the first teaches
            // the batch forms, the second escalates. A model that batches
            // after two needs no third; a model that does not, never will —
            // and every further copy only taxes the history.
            if !hint_is_lone || lone_call_hints < MAX_LONE_CALL_HINTS_PER_TURN {
                if let Some(last) = messages.last_mut() {
                    if last["role"].as_str() == Some("tool") {
                        if let Some(c) = last["content"].as_str() {
                            last["content"] = json!(format!("{c}\n\n{hint}"));
                            nudges += 1;
                            // Both generators carry the lone-call wording: the
                            // escalating lever (`single_call_hint`) AND the quiet-round
                            // fallback (`single_call_hint_text`, reached when the
                            // streak lever is silent). Counting on the text alone keeps
                            // ONE counter for both paths.
                            if hint_is_lone {
                                lone_call_hints += 1;
                            }
                        }
                    }
                }
            }
        }

        // Hand the captures to the model. A tool result may only carry TEXT, so
        // a screenshot rides into the next request as an image block on a user
        // message — the same shape the composer's own attachments use, which
        // `llm.rs` already translates per provider.
        //
        // Drop a capture whose PIXELS are identical to the previous one first.
        // Every mutating computer action captures the screen it changed, so an
        // action that did nothing (a `command+tab` swallowed by the window
        // manager, a click on a dead control) produced a byte-identical PNG
        // that was re-encoded and re-billed as vision tokens on that step and
        // every following one. The previous picture is still in history; a
        // one-line note is all the model needs.
        let mut unchanged_shots = 0usize;
        if !step_shots.is_empty() {
            let mut kept = Vec::with_capacity(step_shots.len());
            for shot in step_shots.drain(..) {
                match shot_file_digest(&shot.path) {
                    Some(d) if last_shot_digest == Some(d) => unchanged_shots += 1,
                    Some(d) => {
                        last_shot_digest = Some(d);
                        kept.push(shot);
                    }
                    // Unreadable: let the encoder report it as before.
                    None => kept.push(shot),
                }
            }
            step_shots = kept;
        }
        if !step_shots.is_empty() || !step_read_images.is_empty() || unchanged_shots > 0 {
            // One encoder, one cap, per provider: `image_data_url_for` picks the
            // largest edge this provider's vision pass actually reads, so a 5K
            // capture is not re-uploaded at full size on every following turn.
            let mut paths: Vec<String> = step_shots.iter().map(|s| s.path.clone()).collect();
            paths.extend(step_read_images);
            let urls: Vec<String> = paths
                .iter()
                .filter_map(|p| crate::commands::image_data_url_for(p, &cfg.provider))
                .collect();
            let mut blocks: Vec<Value> = Vec::new();
            if unchanged_shots > 0 {
                blocks.push(json!({
                    "type": "text",
                    "text": format!(
                        "{} capture(s) were pixel-identical to the previous screen — image \
                         omitted because nothing changed. If the action was supposed to change \
                         the screen, it did not take effect; try a different action instead of \
                         repeating it.",
                        unchanged_shots
                    ),
                }));
            }
            // A text-only model (main agent OR a sub-agent — sub-agents run this
            // same loop with their own model) must never get the raw screenshot:
            // the Vision slot describes it and only the description is sent.
            //
            // `Some(true)` = the model reads images: send them inline.
            // `Some(false)` = text-only: the Vision slot is mandatory.
            // `None` = unknown. A MAIN turn keeps the historical "try the model
            // first" behavior (a configured slot must not preempt a flagship
            // model), but a SUB-AGENT runs unattended: sending raw bytes to a
            // gateway that silently drops them left the traced desktop agent
            // blind for 30 minutes. So an unknown sub-agent capability asks the
            // configured Vision slot first; when the slot is not configured the
            // raw blocks still go through (the model may see them after all).
            let mut urls = urls;
            let mut described = false;
            // How the vision pass resolved, for the trace row below: raw images
            // are cleared from `urls` BEFORE it is recorded, so the plain
            // `urls.len()` used to log "0 image(s) sent" on the very turns a
            // screenshot WAS seen — by the Vision slot.
            let raw_count = urls.len();
            let mut vision_note = String::new();
            let vision = model_supports_vision(&req.providers, &req.provider_id, &cfg.model);
            let try_slot =
                vision == Some(false) || (vision.is_none() && req.mode == "subagent");
            if !urls.is_empty() && try_slot {
                let summary = if step_shots.is_empty() {
                    "Image(s) read by the agent.".to_string()
                } else {
                    shot_summary(&step_shots)
                };
                let vclient = crate::llm::http_client();
                match run_vision_slot(
                    &vclient,
                    req,
                    &cfg.model,
                    &cfg.provider,
                    &cfg.base_url,
                    &cfg.api_keys,
                    &summary,
                    &urls,
                )
                .await
                {
                    VisionOutcome::Ok(desc) => {
                        let note = format!(
                            "{summary}\n\n=== IMAGE ANALYSIS (from the vision model) ===\n{desc}"
                        );
                        blocks.push(json!({"type": "text", "text": note}));
                        urls.clear();
                        described = true;
                        vision_note = "described by the Vision slot".into();
                    }
                    VisionOutcome::NotConfigured if vision == Some(false) => {
                        blocks.push(json!({
                            "type": "text",
                            "text": format!(
                                "{summary}\n\n[image omitted: this model cannot read images and no \
                                 Vision model is configured in Settings → Tools]"
                            ),
                        }));
                        urls.clear();
                        described = true;
                        vision_note = "omitted: no Vision model configured".into();
                    }
                    VisionOutcome::Failed { .. } if vision == Some(false) => {
                        blocks.push(json!({
                            "type": "text",
                            "text": format!(
                                "{summary}\n\n[image omitted: this model cannot read images and the \
                                 Vision model (Settings → Tools → Vision) gave no description]"
                            ),
                        }));
                        urls.clear();
                        described = true;
                        vision_note = "omitted: the Vision model failed".into();
                    }
                    // Unknown capability and no usable slot: keep the raw
                    // blocks and let the model try.
                    _ => {}
                }
            }
            if described {
                // The description already carries the image content.
            } else if urls.is_empty() && unchanged_shots == 0 {
                // Unreadable file or a format the encoder refused: tell the
                // model the capture failed instead of leaving it to guess.
                blocks.push(json!({
                    "type": "text",
                    "text": "A screenshot was taken but could not be read back from disk.",
                }));
            } else {
                if !step_shots.is_empty() {
                    blocks.push(json!({"type": "text", "text": shot_summary(&step_shots)}));
                }
                for url in &urls {
                    blocks.push(json!({"type": crate::llm::IMAGE_BLOCK_TYPE, "data_url": url}));
                }
            }
            // Trace what the vision pass actually pays: a screenshot is re-sent
            // as base64 on every following step of the turn, so the wire size
            // here is the one number a downscale/codec change has to move. When
            // the Vision slot described the capture, the raw bytes never reach
            // the main model — `images` is then 0 and `vision_images` carries
            // what the slot received, so the row cannot read as if NO model
            // ever saw the screenshot.
            trace.record(crate::trace::TraceEntry {
                kind: "images".into(),
                summary: if vision_note.is_empty() {
                    format!("{} image(s) sent to {}", urls.len(), cfg.provider)
                } else {
                    format!(
                        "{raw_count} image(s) {vision_note} — 0 raw sent to {}",
                        cfg.provider
                    )
                },
                detail: Some(json!({
                    "provider": cfg.provider,
                    "images": urls.len(),
                    "base64_chars": urls.iter().map(String::len).sum::<usize>(),
                    "vision_images": raw_count,
                    "vision": vision_note,
                })),
                ..Default::default()
            });
            messages.push(json!({"role": "user", "content": blocks}));
            // The captures just pushed are the freshest view of the world;
            // older ones now cost vision tokens on every following step while
            // describing a screen that no longer exists. Keep at most
            // MAX_HISTORY_SHOTS captures in the conversation (see the const).
            elide_stale_screenshots(&mut messages, MAX_HISTORY_SHOTS);
        }

        // --- No-progress and hallucinated-tool guards -----------------------
        // A digest of EVERYTHING this round produced: the calls (name + raw
        // args), the text of every tool result (already capped by
        // `finish_tool`, so the digest is consistent) and the PIXELS of this
        // round's captures. Equal digests across rounds mean the same calls
        // returned the same bytes: the child is looping, not working. Kept
        // cheap on purpose — the point is to save far more than it costs.
        let round_hash = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            for (_, n, a) in &tool_calls {
                // Same identity as the repeat ceiling: a reworded `reason`
                // must not make a repeated no-op look like new work.
                repeat_action_key(n, a).hash(&mut h);
            }
            for m in &messages[round_msg_start..] {
                if m["role"].as_str() == Some("tool") {
                    // A batching hint is APPENDED to the tool result after the
                    // call (and stripped again before the next request). It is
                    // harness text, not a new result: hashing it made two
                    // identical no-op rounds look different because the hint's
                    // round counter changed.
                    let content = m["content"].as_str().unwrap_or_default();
                    content
                        .split("\n\n[hint]")
                        .next()
                        .unwrap_or(content)
                        .hash(&mut h);
                }
            }
            for s in &step_shots {
                shot_file_digest(&s.path).hash(&mut h);
            }
            h.finish()
        };
        let repeats = round_hashes
            .iter()
            .rev()
            .take(5)
            .filter(|h| **h == round_hash)
            .count();
        round_hashes.push(round_hash);
        if round_hashes.len() > 8 {
            round_hashes.remove(0);
        }
        // One earlier occurrence = the same state reached twice: a nudge that
        // NAMES the loop. Two or more (the same round-state reached a THIRD
        // time within five rounds) = the child cannot get out; stop it and let
        // the end-of-turn report carry the evidence to the parent. Main turns
        // are only nudged: the user is present and can decide.
        if repeats >= 1 && req.mode == "subagent" {
            if repeats == 1 && stall_nudges == 0 {
                stall_nudges += 1;
                messages.push(json!({
                    "role": "user",
                    "content": "=== NO PROGRESS ===\nThe last rounds repeated the same tool \
calls and returned the same results (the screen did not change either). Repeating them \
cannot change the outcome. If the task is not finished, CHANGE approach — a different \
action or tool, or a different window/element — otherwise write the final report now with \
what you already have.",
                }));
            } else if repeats >= 2 {
                break;
            }
        }
        // A repeated ACTION, independent of its result. The traced desktop loop
        // pressed `command+tab` 56 times: every round produced a DIFFERENT
        // screenshot, so neither the idle guard nor the digest below saw a
        // stall. Six identical calls earn a nudge; twelve end the attempt with
        // the forced report. Legitimate work varies its arguments (a different
        // file, a different line window, the next command), so this only fires
        // on a genuine loop.
        let mut too_many_repeats = false;
        if req.mode == "subagent" {
            for (_, n, a) in &tool_calls {
                let key = repeat_action_key(n, a);
                let count = action_counts.entry(key.clone()).or_insert(0);
                *count += 1;
                if *count == 6 && repeated_action_nudged.insert(key.clone()) {
                    let shown: String = a.chars().take(180).collect();
                    messages.push(json!({
                        "role": "user",
                        "content": format!(
                            "=== REPEATED ACTION ===\n`{n}` has now been called {count} times \
with the exact same arguments ({shown}). Even if its result keeps changing, the task is not \
progressing. Stop repeating it: use a different action or a different target, or write the \
final report with what you already have."
                        ),
                    }));
                } else if *count >= 12 {
                    too_many_repeats = true;
                }
            }
        }
        if too_many_repeats {
            break;
        }
        // A round whose EVERY call named a tool that does not exist is a
        // hallucination loop: the unknown-tool reply already lists the valid
        // names, and a model that ignores it for three rounds in a row will not
        // recover on its own.
        if round_all_invalid {
            invalid_rounds += 1;
        } else {
            invalid_rounds = 0;
        }
        if invalid_rounds >= 3 {
            if req.mode == "subagent" {
                break;
            }
            emit(&AgentEvent::Warn {
                content: "The model kept calling tools that do not exist, so the turn was \
stopped instead of spending more rounds on the same mistakes. Check the selected model's \
tool-call support."
                    .into(),
            });
            // Terminal exit with no model call left to carry a queued steer:
            // report it, or `SteerGuard::drop` erases it silently.
            drop_steers(steer_chat, emit);
            run_stop_hooks(&hooks, emit);
            emit(&AgentEvent::Done { aborted: false });
            return Ok(());
        }
    }

    // Budget exhausted. A sub-agent must still hand the parent a REPORT, not a
    // dump of raw tool results. The old fallback folded the newest tool outputs
    // into `[Tool budget exhausted] Findings gathered so far:` and returned
    // them; traced browser runs then handed the parent 11K of page text that
    // answered nothing, and the parent re-delegated the same question. Ask the
    // SAME model once more with tools omitted: a tools-off turn cannot spend
    // another step, and it turns the data already in context into the answer the
    // parent can act on. If the provider fails or returns nothing, the bounded
    // raw findings below remain the last resort.
    if req.mode == "subagent" {
        messages.push(json!({
            "role": "user",
            "content": "The work window is over. Do NOT call any tools. Write your \
final report now from the tool results above: what you saw, what you did, and what you \
could not verify. Be concise and factual, and answer the task as it was given."
        }));
        let mut forced = String::new();
        let mut sink = |sig: StreamSignal| {
            if let StreamSignal::Text(delta) = sig {
                if !delta.is_empty() {
                    // Forward the deltas to the turn's own stream: this closure
                    // is a LOCAL accumulator, not the turn sink above, so
                    // without this the forced report never reached `emit` —
                    // the parent ladder folded nothing and reported the raw
                    // tool entries instead of the answer that was just written.
                    forced.push_str(&delta);
                    emit(&AgentEvent::Text {
                        content: delta.to_string(),
                    });
                }
            }
        };
        let forced_res = stream_chat(
            &client,
            &cfg,
            &messages,
            None,
            &mut sink,
            Some(cancel),
        )
        .await;
        if let Ok(acc) = forced_res {
            // The sink above already emitted the deltas; only emit the
            // accumulator when a provider (unusually) did not delta at all.
            if forced.trim().is_empty() && !acc.text.trim().is_empty() {
                forced = acc.text;
                emit(&AgentEvent::Text {
                    content: forced.clone(),
                });
            }
        }
        // Even a partial forced report beats a raw tool dump; only an empty one
        // falls through to the bounded-findings fallback below.
        if !forced.trim().is_empty() {
            run_stop_hooks(&hooks, emit);
            emit(&AgentEvent::Done { aborted: false });
            return Ok(());
        }
    }
    if req.mode == "subagent" {
        let mut report =
            String::from("[Tool budget exhausted] Findings gathered so far:\n");
        // Newest first: the most recent searches are the ones the report was
        // building toward, so they must survive the cap below.
        for m in messages.iter().rev() {
            if m["role"].as_str() != Some("tool") {
                continue;
            }
            let c = m["content"].as_str().unwrap_or_default();
            if c.trim().is_empty() {
                continue;
            }
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            // The per-result budget is generous because a grep/read result IS
            // the finding: cutting it to a few hundred chars dropped the very
            // search hits the parent asked for, and it re-delegated the same
            // question. The whole report is capped by EXPLORE_REPORT_CAP, the
            // same budget a normal report gets.
            let mut end = SUBAGENT_FOLD_RESULT_CHARS.min(c.len());
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            report.push_str("- ");
            report.push_str(&c[..end]);
            if end < c.len() {
                report.push_str("…");
            }
            report.push('\n');
            if report.len() > EXPLORE_REPORT_CAP {
                break;
            }
        }
        emit(&AgentEvent::Text { content: report });
        run_stop_hooks(&hooks, emit);
        emit(&AgentEvent::Done { aborted: false });
        return Ok(());
    }
    // Plugin `Stop` runs from `run_stop_hooks` at every terminal exit below.
    emit(&AgentEvent::Warn {
        content: format!("turn stopped after {max_steps} steps"),
    });
    // The budget ran out with steers possibly still queued: report them so the
    // renderer can start them as the next turn (this exit has no model call
    // left to carry them, and `SteerGuard::drop` would erase them silently).
    drop_steers(steer_chat, emit);
    emit(&AgentEvent::Done { aborted: false });
    Ok(())
}

