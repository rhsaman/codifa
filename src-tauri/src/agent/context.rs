use super::*;

/// The explore sub-agent's round budget is `SUBAGENT_MAX_STEPS`; the MAIN agent
/// has no round cap at all.
///
/// A capped main turn was cut mid-work with `finish_reason: tool_calls` on every
/// round — no final answer and no "what is done / what remains" — so the user's
/// follow-up message paid another full-context round-trip just to continue the
/// same task, and the work was left half-finished. The main loop is bounded by
/// the model itself (it stops calling tools), by the Stop button, and by the
/// history fold/compaction that keeps the prompt inside the context window —
/// never by an arbitrary round count.
/// Main-agent wrap-up: how many steps before a step cap the wrap-up nudge
/// lands (once). Traced Oct 29: three of twenty runs ran into a cap and were
/// cut with `finish_reason: tool_calls` on every round — no final answer, no
/// "what is done / what remains", and the user's follow-up message paid another
/// full-context round-trip just to continue. The explore sub-agent already
/// gets the same treatment (its two budget nudges), and the wording asks for a
/// clean stop, not for quality to be traded away: finish what is in flight,
/// never start new work, and report.
pub(super) const MAIN_WRAPUP_STEPS_LEFT: usize = 5;
/// Mid-turn auto-compaction: how many times ONE turn may fold its history.
/// A single turn can run MAX_STEPS tool calls, so a fold has to be possible
/// while the agent works — but more than a handful would mean the summarizer
/// itself is thrashing.
pub(super) const MAX_COMPACTIONS_PER_TURN: usize = 4;
/// The context window a manual `/chat/compact` measures against: the renderer's
/// number when it has one, otherwise the provider's own metadata, otherwise
/// [`DEFAULT_CONTEXT_WINDOW`]. Never a private literal — an 8k window here meant
/// the verbatim tail was budgeted at ~3.2k tokens, so a manual compact folded
/// almost the entire history.
pub(crate) fn resolve_compact_window(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
    sent: usize,
) -> usize {
    if sent > 0 {
        return sent;
    }
    provider_context_window(providers, provider_id, model).unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// Context window assumed when neither models.dev nor the provider reports one
/// (a custom model without metadata sends 0).
///
/// The product rule for a model's capacity is: **models.dev → the provider's own
/// metadata → this default**. It is 200k (not the old 128k) because the 128k
/// fallback silently measured a 200k/1M-token model against a fraction of its
/// real window, so auto-compaction fired at 13–25% of it while the UI still
/// showed the user's percentage — the "it compacts way before my setting"
/// report. `pub(crate)` so `compact.rs` reuses the SAME number instead of its own
/// private 8192 fallback.
pub(crate) const DEFAULT_CONTEXT_WINDOW: usize = 200_000;

/// The context window a provider config knows for one model, resolved the same
/// way the renderer's `modelContextWindow` does: the manual override first, then
/// the map filled from `/models`, each keyed by the bare model id and then by
/// "providerId/model". `None` means nobody knows it.
pub(crate) fn provider_context_window(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
) -> Option<usize> {
    let lookup = |key: &str| -> Option<usize> {
        let cfg = providers.get(provider_id)?;
        let map = cfg.get(key)?;
        if let Some(n) = map.get(model).and_then(Value::as_u64) {
            if n > 0 {
                return Some(n as usize);
            }
        }
        if provider_id.is_empty() {
            return None;
        }
        map.get(&format!("{provider_id}/{model}"))
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .map(|n| n as usize)
    };
    lookup("manualContextMap").or_else(|| lookup("contextMap"))
}

/// The context window this turn measures against.
///
/// The renderer resolves it from the provider's `contextMap` (filled from the
/// provider's `/models` metadata, which already prefers models.dev) or the user's
/// `manualContextMap`, and sends 0 when it knows nothing about the model.
/// Falling back to a hardcoded number for a model whose real window is larger
/// made auto-compaction fire at a fraction of the REAL window while the UI still
/// showed the user's percentage — the "it compacts way before my threshold"
/// report. So the backend tries the same maps the renderer uses, then
/// [`DEFAULT_CONTEXT_WINDOW`].
pub(super) fn effective_context_window(req: &AgentRequest) -> usize {
    if req.context_window > 0 {
        return req.context_window as usize;
    }
    // Same resolution order as the renderer's `modelContextWindow`: the manual
    // override (custom models) first, then the map filled from `/models`.
    provider_context_window(&req.providers, &req.provider_id, &req.model)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// Output budget for the auto-compaction summary.
pub(super) const COMPACT_MAX_OUTPUT: usize = 4096;
/// Per-attempt deadline for the summarizer. Compact is a side call inside the
/// turn and `llm::complete` now honors this budget, so a hung provider fails the
/// attempt instead of freezing the very turn it is trying to shrink.
/// `compact::compact_history` additionally caps the TOTAL across all attempts
/// (`COMPACT_TOTAL_BUDGET_SECS`), so this per-attempt value can stay short.
pub(super) const COMPACT_TIMEOUT_SECS: u64 = 90;
/// The explore sub-agent must answer in seconds, not minutes — a much smaller
/// step budget than the main agent's, with a forced final report (below).
pub(super) const SUBAGENT_MAX_STEPS: usize = 12;

/// The step budget the explore prompt itself promises ("a fixed 3-step
/// budget"). The model overshoots it: in the last traced corpus 45 of 63
/// explore runs entered round 4, and those rounds alone cost 853_902 of the
/// 1_758_022 uncached explore tokens (48.6%) — every one of them re-sending a
/// conversation that was already large. The near-exhaustion nudge below only
/// fires at step 9 of 12, far too late to change the shape of a run, so the
/// reminder has to land where the promised budget actually runs out.
pub(super) const EXPLORE_BUDGET_STEPS: usize = 3;
/// How many times ONE explore sub-agent may be attempted before the parent
/// gives up on it.
///
/// Deliberately the SAME ladder as the main agent (10 attempts, 10s apart —
/// see MAX_RECONNECT_ATTEMPTS/RECONNECT_DELAY_MS in the renderer's api.ts):
/// a sub-agent runs INSIDE the parent turn on the parent's own stream, so the
/// frontend's reconnect ladder can never observe it failing. A failed attempt
/// must therefore look EXACTLY like a failed main-model attempt — same attempt
/// count, same delay, same `retry`/`retry_giveup` events, same UI banner — so
/// the user sees one consistent retry story no matter which model hiccuped.
/// How many attempts a rung may spend before the ladder's budget is used up.
///
/// ONE try per rung, whatever the failure: a refused key, a rate limit, a 5xx
/// or a dropped connection all hand the call to the NEXT model immediately —
/// asking the same model again right away can only reproduce the same error,
/// and the walk returns to this rung on the next pass anyway. The pause lives
/// between PASSES (a wrapped walk), not between retries of one model.
pub(super) const SUBAGENT_RUNG_ATTEMPTS: usize = 1;

pub(super) const SUBAGENT_MAX_ATTEMPTS: usize = 10;
/// Fixed backoff between explore attempts — mirrors the main agent's fixed
/// 10s cadence (RECONNECT_DELAY_MS in api.ts). The ATTEMPT COUNT, not a clock,
/// is what ends the ladder. Each attempt is still bounded by the model call
/// itself, never by a wall-clock timer: a slow but healthy provider is NOT a
/// failure.
pub(super) const SUBAGENT_RETRY_BACKOFF_MS: u64 = 10_000;
/// How long ONE sub-agent attempt may stay COMPLETELY silent — not a single
/// event from its own run (no tool call, no text, no usage) — before it is
/// treated as HUNG and the ladder above retries it.
///
/// The ladder only ever sees an attempt that RETURNS. A provider that accepts
/// the connection and stops talking, or a tool call that blocks forever, never
/// returns at all — so without this the parent turn froze on a
/// "tool running (590s)" pill with no error, and the whole retry story above
/// was unreachable ("explore sometimes just hangs").
///
/// This is an IDLE bound, NOT a deadline on the model. Two independent
/// heartbeats reset it: every event the attempt emits, AND the LSP layer's own
/// activity counter (`crate::lsp::activity`) — a cold language server says
/// nothing for minutes while it loads the project, and that is honest progress,
/// never a wedge. The budget is kept comfortably above the LSP's own budgets
/// (INITIALIZE_TIMEOUT + REQUEST_TIMEOUT) so a legitimate cold start is never
/// mistaken for a hang.
///
/// The default can be lowered with `CODIFA_SUBAGENT_IDLE_SECS` — a slow build
/// machine or a small/simple workspace does not need the full budget, and a
/// test can prove the guard fires without waiting five minutes.
pub(super) fn subagent_idle_secs() -> u64 {
    static V: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("CODIFA_SUBAGENT_IDLE_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(SUBAGENT_ATTEMPT_IDLE_SECS)
    })
}
pub(super) const SUBAGENT_ATTEMPT_IDLE_SECS: u64 = 300;
/// Cap on the tool result echoed to the UI (full result still goes to the LLM).
pub(super) const TOOL_RESULT_CAP: usize = 4000;

/// Cap on a model reply echoed into an `llm` trace row. The trace is a local
/// JSONL the panel reads on demand, so this only bounds one row's size — large
/// enough to read what the model actually said during that step.
pub(super) const LLM_TRACE_TEXT_CAP: usize = 4_000;

/// Cap on the wire prompt echoed into an `llm` trace row. The system message is
/// elided to a size marker there (the `prompt` row already carries it in full),
/// so this budget is spent on the conversation the model actually saw — which is
/// the thing the trace panel was silently missing.
pub(super) const LLM_TRACE_PROMPT_CAP: usize = 8_000;
/// Cap on the tool result forwarded to the MODEL: full multi-MB read/grep
/// outputs ballooned the context (76k-token turns) and made every LLM
/// round-trip crawl — the #1 cause of slow explore turns.
pub(crate) const MODEL_RESULT_CAP: usize = 16_000;

/// Cap on the unified diff appended to an edit's MODEL-facing result.
///
/// Measured over 125 traced `edit_file` calls: the diff p50 is 1_660 chars,
/// p75 2_586 and p90 5_397 — so 4_000 covers 88% of edits in full, and the rest
/// still carry the marker plus the changed lines nearest the edit, which is
/// exactly what the verification re-read was looking for.
pub(super) const EDIT_DIFF_CHARS: usize = 4_000;

/// Trailer appended after an edit's diff, so the model reads the diff as the
/// confirmation instead of spending a round-trip to re-read the file.
pub(super) const EDIT_DIFF_TRAILER: &str =
    "\n(that is the applied change — do NOT re-read the file to verify it)";

/// Cap on an explore/task report forwarded to the model.
///
/// A report is the main agent's ONLY view of the code — it has no read/grep
/// tools of its own — so a truncated report means the search results inside it
/// are simply lost and the agent re-delegates the same question. Reports get a
/// larger budget than a raw tool result, and are cut from the MIDDLE (see
/// finish_tool) so both the answer at the head and the details at the tail
/// survive.
pub(super) const EXPLORE_REPORT_CAP: usize = 40_000;

/// Per-result budget when a sub-agent runs out of steps and its gathered tool
/// results are folded into a report (see run_turn). A grep/read result IS the
/// finding, so this is far larger than a UI echo cap.
pub(super) const SUBAGENT_FOLD_RESULT_CHARS: usize = 4_000;

/// Slice of a tool's stored prose result (`resultText`) echoed into the history
/// recap for ordinary tools.
pub(super) const RECAP_RESULT_CHARS: usize = 400;
/// Same slice for an explore/task report. That report is the main agent's ONLY
/// view of the code, so the recap must carry it at (near) full length —
/// otherwise the next turn receives a short digest, cannot answer from it, and
/// re-delegates the very same question.
pub(super) const RECAP_EXPLORE_CHARS: usize = 8_000;

/// In-turn elision: rounds this fresh are NEVER touched by fold_stale_tool_results.
pub(super) const MAIN_FOLD_KEEP_ROUNDS: usize = 2;
/// In-turn elision: per-result budget for a stale explore report (the report is
/// the main agent's only view of that research; 8K mirrors RECAP_EXPLORE_CHARS).
pub(super) const MAIN_FOLD_EXPLORE_CHARS: usize = 8_000;
/// In-turn elision: per-result budget for a stale ordinary tool result (2K
/// mirrors what a targeted re-read costs, so pointing beats re-sending).
pub(super) const MAIN_FOLD_RESULT_CHARS: usize = 2_000;
/// In-turn elision: fold only once the wire history (system excluded) is
/// estimated past this many tokens. Fresh conversations and short turns must
/// not pay any elision cost.
pub(super) const MAIN_FOLD_MIN_TOKENS: usize = 20_000;

/// In-turn elision: the SMALLEST removal worth its prefix-cache break.
///
/// Folding rewrites an early tool result, so the provider's prefix cache
/// breaks at that depth and everything after it re-bills at miss price. The
/// 12:44 run measured the floor: a 226-token removal re-billed a ~40K-token
/// cached prefix. The cached part of DeepSeek-class prefixes grows roughly
/// linearly with history, and a mid-size turn re-bills 10-40K after one
/// rewrite — so a removal must clear a floor that one such re-bill would
/// dwarf. 4_000 tokens ≈ the smallest fold that still pays for one miss
/// event at DeepSeek's 5:1 miss-to-hit pricing; smaller folds wait for the
/// next round, where they either grown past this floor (they usually do —
/// the same stale results are still there) or the turn ends first.
pub(super) const MAIN_FOLD_MIN_REMOVAL: usize = 4_000;
/// A tool result this size alone is foldable without the turn-size gate:
/// traced 6 Nov, `read` results (n=344) averaged 5.4K chars with a p90 of
/// ~16K (~4K tokens) — 75% of every tool-result character the model received.
/// 8K chars ≈ 2K tokens is comfortably above the ordinary small result a
/// short turn must keep verbatim.
pub(super) const FOLD_OVERSIZED_RESULT_CHARS: usize = 8_000;
/// In-turn elision: marker appended to a folded tool-result stub. The model
/// reads it as a pointer (re-run with narrower args), not as data loss.
pub(super) const MAIN_FOLD_MARKER: &str = "[… result elided to save context. Only its beginning is kept — re-run the tool with a narrower pattern/range/file to see the rest again]";

/// Sub-agent in-turn elision: rounds this fresh are never touched. Same value
/// as the main agent — the model is actively reasoning over those results.
pub(super) const SUB_FOLD_KEEP_ROUNDS: usize = 2;
/// Sub-agent in-turn elision: per-result budget for a stale tool result. The
/// explore window is a fraction of the main one, so the budgets are too — and
/// unlike the main agent the sub-agent OWNS read/grep, so a targeted re-read
/// always recovers the body (the pointer is guaranteed resolvable).
pub(super) const SUB_FOLD_RESULT_CHARS: usize = 4_000;
/// Sub-agent in-turn elision: fold only past this estimated wire size.
///
/// Deliberately the SAME as the main threshold, not lower. Folding rewrites
/// OLD tool results, and an automatic prefix cache is a longest-prefix match:
/// changing an early message invalidates every cached token after it. Traces
/// show a median intra-run growth of only 7-10K tokens (short runs keep a
/// 65-80% cache hit), while the runaway runs reach 30-90K — those are the ones
/// worth the cache reset. A lower threshold would tax every short run for
/// almost nothing.
pub(super) const SUB_FOLD_MIN_TOKENS: usize = 20_000;

/// In-turn elision economics: do not fold once a run has fewer than this many
/// model calls left.
///
/// Folding rewrites OLD tool results, and an automatic prefix cache is a
/// longest-prefix match — so the request immediately after a fold is re-billed
/// from the first changed byte. Measured on real traces over 85 folds: the call
/// after a fold drops from an 89% cache hit to 61.7%, a fixed loss of roughly
/// `0.28 × prompt tokens`. That only pays back if enough round-trips REMAIN to
/// reuse the shorter prompt.
///
/// Net value of one fold, bucketed by the calls left after it (measured):
///     0-3 left : 31 folds, 0/31 profitable, **-172_630 tokens**
///     4-7 left : 32 folds, +12_778 total
///     8-15 left: 21 folds, +27_768 total
///     16+ left :  1 fold,  +1_583
/// A fold in the last three calls is therefore a pure loss, so it is skipped.
/// This does NOT weaken the elision: on the same traces the fold still takes
/// uncached explore input from 14.57M down to 5.56M (2.62x), and every fold of
/// the 54 measured in the 4+-calls-left buckets is kept.
pub(super) const FOLD_MIN_REMAINING_CALLS: usize = 3;

/// Whether the explore sub-agent folds stale tool results mid-run.
///
/// MEASURED `false`, and the measurement is the whole argument. An in-place
/// fold REWRITES the content of an old tool message; a prefix cache is a
/// longest-prefix match, so the cache falls back to the system prompt + tool
/// schemas and the entire history behind the fold is re-billed.
///
/// On the reference trace (236 explore calls, 1,375,702 uncached input):
///   cold first calls      124,974  ( 9%)  unavoidable
///   appended content      462,864  (33%)  the model actually read it
///   prefix-break re-bill  787,864  (57%)  the fold's doing
///
/// The folds behind that freed about 20K chars of history while throwing away
/// 253,824 already-cached tokens (the cache fell to ~4.5K = system + schemas on
/// every fold). Later calls hit the cache ~91% of the time, so the tokens a
/// fold “saves” are nearly free already: folding trades an expensive re-bill
/// for a worthless saving. Every measured fold was net negative — worst cases
/// (run 8, run 70, run 150) lost 17-26K tokens each.
///
/// Keeping it ON also costs QUALITY: the marker replaces real tool output with
/// a pointer the model has to spend a call to re-read. With it OFF the run's
/// prompt simply keeps growing, but each tool result is billed once and then
/// served from cache — cheaper AND lossless.
///
/// The code is kept (not deleted) so the decision stays visible and reversible:
/// a gateway without prefix caching would flip it back.
pub(super) const SUB_FOLD_ENABLED: bool = false;

/// Whether an in-turn fold still pays for its prefix-cache reset — see
/// `FOLD_MIN_REMAINING_CALLS` for the measurement behind the threshold.
///
/// `calls_left` includes the model call about to be made, so a run on its last
/// step has `calls_left == 1`. A pure function of the loop counter, so the rule
/// is testable without running a turn.
pub(super) fn fold_pays_off(calls_left: usize) -> bool {
    calls_left >= FOLD_MIN_REMAINING_CALLS
}

/// The main agent's wrap-up nudge, delivered once a few steps before a cap.
///
/// The main agent normally runs WITHOUT a cap (`max_steps == usize::MAX`), so
/// this is silent there; it stays for any caller that does bound the loop.///
/// Traced Oct 29: three of twenty runs ran into the 60-step cap and were cut
/// with `finish_reason: tool_calls` on every round — no final answer, no
/// done/remaining report, and the user's follow-up message paid another
/// full-context round-trip just to continue. The explore sub-agent already
/// gets budget nudges (see the loop); this mirrors them for the main turn.
/// The wording asks for a CLEAN stop — finish what is in flight, never start
/// new work, report — so quality goes up, not down. A pure function of the
/// loop state so the once-only rule is testable without running a turn.
pub(super) fn main_wrapup_message(
    step: usize,
    max_steps: usize,
    delivered: bool,
    mode: &str,
) -> Option<&'static str> {
    // A cap that does not exist cannot be "nearly exhausted": the main agent
    // runs to completion instead of being cut short (`max_steps` is
    // `usize::MAX` there).
    if mode == "subagent" || delivered || max_steps == usize::MAX {
        return None;
    }
    if step + MAIN_WRAPUP_STEPS_LEFT != max_steps {
        return None;
    }
    Some(
        "Step budget is nearly exhausted — wrap up this turn NOW: finish the operation \
         already in flight (or stop it cleanly), do NOT start new work, and give the user \
         a clear summary of what was completed and what remains. Only call a tool if it is \
         essential to leave the work in a consistent state.",
    )
}

/// Record one in-turn fold in the trace.
///
/// A fold used to leave NO trace at all (the only evidence was the marker text
/// inside a tool message), so every attempt to price it had to infer "a fold
/// happened here" from the prompt shrinking between two calls. That inference
/// cannot tell a fold from compaction and cannot measure the trade-off that
/// decides whether folding is worth anything: the prefix-cache re-bill it
/// causes (once, at the fold point) against the smaller prompt it buys on every
/// call after it.
///
/// Written as its own `kind: "fold"` row so the numbers travel with the run id
/// and can be joined against the `llm` rows before and after it.
///
/// `calls_left` is the number of model calls remaining INCLUDING the one about
/// to be made, which is exactly what decides the payoff. `None` means the role
/// has no step cap, so no payoff horizon exists to report.
#[allow(clippy::too_many_arguments)]
pub(super) fn record_fold(
    trace: &crate::trace::TraceStore,
    role: &str,
    step: usize,
    call_no: usize,
    calls_left: Option<usize>,
    before_tokens: usize,
    removed_chars: usize,
    folded: usize,
) {
    // A fold that touched nothing is not an event: it would only add noise to
    // the trace and to every later sum.
    if folded == 0 {
        return;
    }
    // `None` means the role has no step cap (the main agent runs to completion),
    // so there is no "calls left" to report. Storing the raw `usize::MAX - step`
    // sentinel printed `18446744073709551602 call(s) left` in the trace, which
    // read like an underflow bug and hid the real fold numbers behind it.
    trace.record(crate::trace::TraceEntry {
        kind: "fold".into(),
        summary: format!(
            "{role} fold: {folded} result(s), {removed_chars} chars out, {} left",
            match calls_left {
                Some(n) => format!("{n} call(s)"),
                None => "unbounded calls".to_string(),
            }
        ),
        detail: Some(serde_json::json!({
            "role": role,
            "step": step + 1,
            "call": call_no,
            "calls_left": calls_left,
            "before_tokens": before_tokens,
            "removed_chars": removed_chars,
            "removed_tokens_est": removed_chars.div_ceil(4),
            "folded": folded,
        })),
        ..Default::default()
    });
}

/// UI-echo budget for one tool result. The echo is also what the frontend stores
/// as `resultText`, i.e. the ONLY source the next turn's history recap is built
/// from. An explore report must therefore be echoed at least as long as
/// the recap reads it: with the flat 4 KB echo cap the report was cut before the
/// recap's 8 KB budget could apply, and its tail (later CODE blocks, ALSO
/// RELEVANT) was lost between turns.
pub(super) fn ui_echo_cap(tool: &str) -> usize {
    if is_delegation(tool) {
        RECAP_EXPLORE_CHARS
    } else {
        TOOL_RESULT_CAP
    }
}

/// Clip `s` to `cap` bytes on a UTF-8 char boundary and mark the cut.
/// Byte slicing mid-char panics on Persian text, so this is the only safe way
/// to bound a string that reaches the trace panel.
pub(super) fn clip_trace_text(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut end = cap;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &s[..end])
}

/// Render the wire messages of ONE model call as the text the trace panel shows
/// on that call's `llm` row.
///
/// This is what the model actually received (system + history + the current
/// user prompt + every tool result so far), as opposed to `req.prompt`, which is
/// only the newest user line. The system message is elided to a size marker: it
/// is stored in full on the turn's `prompt` row, and repeating it on every llm
/// row of a long turn would push the conversation itself out of the cap.
pub(super) fn trace_prompt_text(messages: &[Value]) -> String {
    let mut out = String::new();
    // Where the LAST message's block starts. `clip_trace_text` keeps the head,
    // so an over-cap row used to drop exactly the newest thing the model had to
    // act on — and because the per-step batching hint is appended to that last
    // message, the trace could not show whether a hint was delivered at all
    // (every before/after comparison of that lever had to be inferred from
    // round counts). The cap is therefore spent here as head + newest block.
    let mut last_block_start = 0usize;
    for (i, m) in messages.iter().enumerate() {
        last_block_start = out.len();
        let role = m.get("role").and_then(Value::as_str).unwrap_or("?");
        let content = match m.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(v) if !v.is_null() => serde_json::to_string(v).unwrap_or_default(),
            _ => String::new(),
        };
        if i == 0 && role == "system" {
            out.push_str(&format!(
                "[system] {} chars — full text on the `prompt` row of this turn\n\n",
                content.chars().count()
            ));
            continue;
        }
        out.push_str(&format!("[{role}]\n"));
        if !content.is_empty() {
            out.push_str(&content);
            out.push('\n');
        }
        if let Some(calls) = m.get("tool_calls").and_then(Value::as_array) {
            for c in calls {
                let name = c
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let args = c
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                out.push_str(&format!("→ {name}({args})\n"));
            }
        }
        out.push('\n');
    }
    let trimmed = out.trim_end().to_string();
    if trimmed.len() <= LLM_TRACE_PROMPT_CAP {
        return trimmed;
    }
    let tail = out.get(last_block_start..).unwrap_or_default().trim_end();
    bounded_trace_text(&trimmed, tail, LLM_TRACE_PROMPT_CAP)
}

/// Clip `s` to the LAST `cap` bytes, on a UTF-8 char boundary.
pub(super) fn tail_trace_text(s: &str, cap: usize) -> &str {
    if s.len() <= cap {
        return s;
    }
    let mut start = s.len() - cap;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Bound a trace body to `cap` bytes while KEEPING its newest block.
///
/// `clip_trace_text` truncates the tail, which for a wire-prompt echo is the
/// wrong end: the newest tool result (and any hint riding on it) is the part a
/// reader needs to explain the next call's tokens. The middle is what gets
/// elided instead, so the head still shows the conversation and the tail still
/// shows what the model was asked to do next.
pub(super) fn bounded_trace_text(full: &str, tail: &str, cap: usize) -> String {
    const MARK: &str = "\n… (elided middle) …\n";
    // Nothing to do when the body already fits: an unconditional elision would
    // rewrite a short prompt into "head + marker + duplicate tail".
    if full.len() <= cap {
        return full.to_string();
    }
    let tail_budget = tail.len().min(cap / 2);
    let head_budget = cap.saturating_sub(tail_budget + MARK.len());
    let mut end = head_budget.min(full.len());
    while end > 0 && !full.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{MARK}{}", &full[..end], tail_trace_text(tail, tail_budget))
}

/// Fold a history message's non-prose state into its content so the model can
/// see what already happened.
///
/// The frontend keeps the durable record of a turn on the message object
/// (`toolActivity`, `preservedToolSummary`, `plan`) and sends only `role` +
/// `content` in `history`. Without this recap the model saw prose alone, could
/// not tell which tools had already run, and re-searched the same files every
/// turn — the reported "context keeps shrinking and it re-searches" loop.
/// Mirrors graph.py's history projection (which rebuilt real tool_calls; a
/// textual recap is used here because it needs no synthetic tool-call ids).
pub(super) fn history_recap(m: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(acts) = m.get("toolActivity").and_then(Value::as_array) {
        let mut lines: Vec<String> = Vec::new();
        for a in acts {
            let tool = a.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let status = a.get("status").and_then(Value::as_str).unwrap_or("");
            if status == "running" {
                continue;
            }
            let mut line = format!("- {tool}");
            if let Some(args) = a.get("args") {
                let s = serde_json::to_string(args).unwrap_or_default();
                if !s.is_empty() && s != "{}" {
                    line.push_str(&format!(" {}", s.chars().take(200).collect::<String>()));
                }
            }
            if !status.is_empty() {
                line.push_str(&format!(" [{status}]"));
            }
            // The RESULT matters as much as the call. Listing only the tool
            // name tells the model a grep ran but not what it found, so it
            // re-runs the same search on the next turn — the reported
            // "it keeps searching again" loop. `summary` is the frontend's
            // one-line result digest; `results[].content` carries the payload
            // for tools that keep one.
            if let Some(sum) = a.get("summary").and_then(Value::as_str) {
                if !sum.trim().is_empty() {
                    line.push_str(&format!(
                        " → {}",
                        sum.chars().take(300).collect::<String>()
                    ));
                }
            }
            if let Some(results) = a.get("results").and_then(Value::as_array) {
                for r in results.iter().take(2) {
                    if let Some(c) = r.get("content").and_then(Value::as_str) {
                        if !c.trim().is_empty() {
                            line.push_str(&format!(
                                "\n    {}",
                                c.chars().take(400).collect::<String>()
                            ));
                        }
                    }
                }
            }
            // Native tool results arrive as `resultText` (the frontend keeps
            // the prose verbatim for prose-only tools). Without this the recap
            // showed the explore CALL but not a single finding, so the main
            // agent re-delegated research it had already paid for.
            if let Some(text) = a.get("resultText").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    let cap = if tool == "explore" {
                        RECAP_EXPLORE_CHARS
                    } else {
                        RECAP_RESULT_CHARS
                    };
                    line.push_str(&format!("\n    {}", text.chars().take(cap).collect::<String>()));
                }
            }
            lines.push(line);
        }
        if !lines.is_empty() {
            parts.push(format!(
                "\n[Tools already run in this turn — do NOT re-run them:\n{}]",
                lines.join("\n")
            ));
        }
    }
    if let Some(p) = m.get("preservedToolSummary").and_then(Value::as_str) {
        if !p.trim().is_empty() {
            parts.push(p.to_string());
        }
    }
    if let Some(items) = m.get("plan").and_then(Value::as_array) {
        let done = items
            .iter()
            .filter(|i| i.get("status").and_then(Value::as_str) == Some("completed"))
            .count();
        if done > 0 {
            parts.push(format!(
                "\n[Checklist progress {done}/{} — do NOT re-execute completed steps.]",
                items.len()
            ));
        }
    }
    parts.concat()
}
