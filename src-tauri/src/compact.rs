// Phase 3-1: native /chat/compact — a Rust port of agents.py `_compact_history`
// (opencode-style compaction): token-budgeted verbatim tail, orphaned tool
// message cleanup, prior-summary merge, and the summarizer call via llm.rs.

use serde_json::Value;

use crate::llm::{self, LlmConfig};

// 4k (was 12k): the summarizer prompt is the whole serialized history — 12k
// chars per tool message made compaction a slow, huge-token LLM call.
const TOOL_OUTPUT_MAX_CHARS: usize = 4_000;

/// Wall-clock budget for ONE compaction, covering every attempt together.
/// Compaction is a side task the UI blocks on behind a "Compacting…" banner, so
/// it has to finish or fail inside a window a user will actually wait for.
/// Before this cap, "1 primary try + 2 fallback tries" at 300 s each could
/// stack into ~15 minutes of waiting for a summary that was never coming.
const COMPACT_TOTAL_BUDGET_SECS: u64 = 180;

/// How many times the WHOLE model list is walked top to bottom. After the last
/// fallback fails the walk starts over from the summariser's own model (a
/// provider that was down a minute ago is often back), still inside the shared
/// wall-clock budget. A one-model chain is rotated too — a transient failure
/// must not end a compaction the next pass could complete.
const COMPACT_MAX_CYCLES: usize = 3;

/// Pause between two passes over the list, so a list of dead rungs is not
/// hammered back to back. The ONLY pause in the walk: a failing rung hands the
/// call to the NEXT model immediately (no same-model retries), and this pause
/// is what separates one full pass from the next.
const COMPACT_CYCLE_PAUSE_SECS: u64 = 10;

/// Upper bound on ONE summarizer call. Without it the first rung could consume
/// the whole shared budget while accepting the request and never answering, so
/// the fallback list was never reached — the exact stall the ladder exists to
/// avoid. Bounded per rung, a stalled model hands over within 90 s and the
/// fallbacks still get their turn inside the shared budget.
const COMPACT_CALL_TIMEOUT_SECS: u64 = 90;

/// Do not start a rung with less than this left: a call needs room to answer.
const COMPACT_MIN_RUNG_SECS: u64 = 10;

/// One progress tick from a running compaction.
///
/// A model call reports nothing until it answers, so these ticks are NOT a
/// measured completion percentage: they carry the phase, which attempt is
/// running, and how much of the shared wall-clock budget is already spent. The
/// renderer keeps its own clock running between ticks, which is what lets it
/// show a truthful "42s / 180s" instead of an anonymous spinner.
#[derive(Debug, Clone)]
pub struct CompactProgress {
    /// Machine-readable phase: `"preparing"` (selecting the verbatim tail and
    /// serializing the head), `"summarizing"` (the model call) or `"merging"`.
    pub phase: &'static str,
    /// 1-based attempt counter across the primary + fallback chain. `0` on the
    /// opening tick, before any attempt has started.
    pub attempt: usize,
    /// How many attempts this run may still make in total (`0` when unknown).
    pub attempts_total: usize,
    /// Model running this attempt.
    pub model: String,
    /// Provider ROW the model is routed to. A kind cannot name what the user
    /// configured (every OpenAI-compatible endpoint is literally "custom"), so
    /// the banner resolves this id to the provider's display name.
    pub provider_id: String,
    /// Share of the total budget already spent, 0-100.
    pub percent: u8,
    /// Wall-clock budget for the WHOLE compaction, in seconds.
    pub budget_secs: u64,
    /// Seconds elapsed since the compaction started.
    pub elapsed_secs: u64,
}

/// Fill in the derived fields (elapsed + percent) and hand one tick to the
/// caller. Kept as a free function so every emit site reports the same clock.
fn progress_tick(
    on_progress: &mut (dyn FnMut(&CompactProgress) + Send),
    started: std::time::Instant,
    phase: &'static str,
    attempt: usize,
    attempts_total: usize,
    cfg: &LlmConfig,
) {
    let elapsed_secs = started.elapsed().as_secs();
    let percent = ((elapsed_secs as u128 * 100) / COMPACT_TOTAL_BUDGET_SECS.max(1) as u128)
        .min(100) as u8;
    on_progress(&CompactProgress {
        phase,
        attempt,
        attempts_total,
        model: cfg.model.clone(),
        provider_id: cfg.provider_id.clone(),
        percent,
        budget_secs: COMPACT_TOTAL_BUDGET_SECS,
        elapsed_secs,
    });
}
const SUMMARY_TEMPLATE: &str = r#"

Use this exact template for the summary (markdown, anchored to the conversation):

<summary>
1. Task and scope:
   What the user asked for, verbatim intent, constraints.
2. Decisions and approach:
   Key decisions made and why.
3. Work completed (DURABLE LEDGER — never drop an entry):
   One bullet per finished item, with the exact outcome and any concrete
   detail that actually appears in the conversation (file path, URL, number,
   command, commit hash, document, decision, etc.).
   This section is the ONLY record of finished work after compaction: an
   item missing here WILL be redone from scratch. Copy entries forward
   verbatim from a previous summary instead of re-summarizing them.
4. Current state:
   What exists right now — the live state of the task (finished items,
   open files/pages, running processes, held positions, current data,
   draft, etc.).
5. Next steps:
   What remains, in order, with any blockers.
6. Important context:
   Errors hit and fixes, user preferences, constraints, gotchas.
</summary>

Rules:
- This is a GENERAL-PURPOSE assistant: the conversation can be about any
  topic. Summarize what actually happened in its own domain, using its own
  vocabulary. Never force a coding, repository, trading, or any other
  framing onto it.
- Do NOT mention code, repositories, files, commits, tests, branches, or
  software unless they actually appear in the conversation.
- Only state facts present in the conversation. Do not invent domains,
  capabilities, limitations, actions, or user requests that did not occur.
- Do not include these instructions or any HTML comments in your output.
- Keep every section, even when empty (write "(none)").
- Respond in the same language as the conversation.
"#;

/// The marker the mid-turn caller puts in front of a folded summary.
const SUMMARY_MARKER: &str = "[Compacted earlier context]";

/// The body of a context summary, when `m` is one — either a manual
/// `/chat/compact` summary (a `system` message starting with `<summary>`) or
/// the mid-turn `[Compacted earlier context]` checkpoint (stored as `user`).
///
/// `None` for ordinary turns. Summaries must be MERGED into the new summary,
/// never treated as conversation text: the renderer appends them at the END of
/// the array, where the backward tail walk would otherwise swallow them into
/// the verbatim tail. That is why a repeated compact summarized only the one
/// message after the old summary and then replaced the old summary — dropping
/// the whole conversation from the new one.
fn summary_body(m: &Value) -> Option<String> {
    let content = content_of(m);
    let trimmed = content.trim();
    if let Some(rest) = trimmed.strip_prefix(SUMMARY_MARKER) {
        let body = rest.trim();
        if !body.is_empty() {
            return Some(body.to_string());
        }
    }
    if m["role"] == "system" && trimmed.starts_with("<summary>") {
        // Drop the template wrapper: the merge prompt already wraps the prior
        // summary in <prior-summary>, and nesting <summary> inside it invites
        // the model to emit duplicate tags in the new summary.
        let body = trimmed.strip_prefix("<summary>").unwrap_or(trimmed);
        let body = body.strip_suffix("</summary>").unwrap_or(body).trim();
        if !body.is_empty() {
            return Some(body.to_string());
        }
    }
    None
}

fn estimate_tokens(text: &str) -> usize {
    // Same heuristic family as agents.py: ~4 chars per token.
    text.len().div_ceil(4)
}

fn recent_tail_budget(ctx: usize, max_output: usize, reserved: Option<usize>) -> usize {
    let usable = usable_tokens(ctx, max_output, reserved);
    // opencode keeps roughly half the window for the verbatim tail.
    usable * 40 / 100
}

fn usable_tokens(ctx: usize, max_output: usize, reserved: Option<usize>) -> usize {
    let res = reserved.unwrap_or(0).max(max_output);
    ctx.saturating_sub(res).max(1024)
}

fn content_of(m: &Value) -> String {
    m.get("content").and_then(|c| c.as_str()).unwrap_or_default().to_string()
}

/// Remove orphaned tool messages from the tail and strip assistant tool_calls
/// whose results were dropped (agents.py steps 1-3) — providers 400 otherwise.
fn clean_tail(tail: &mut Vec<Value>) {
    let all_tc_ids: std::collections::HashSet<String> = tail
        .iter()
        .filter(|m| m["role"] == "assistant")
        .filter_map(|m| m["tool_calls"].as_array())
        .flatten()
        .filter_map(|tc| tc["id"].as_str().map(|s| s.to_string()))
        .collect();
    tail.retain(|m| !(m["role"] == "tool" && !all_tc_ids.contains(m["tool_call_id"].as_str().unwrap_or(""))));
    let kept_results: std::collections::HashSet<String> = tail
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["tool_call_id"].as_str().map(|s| s.to_string()))
        .collect();
    for m in tail.iter_mut() {
        if m["role"] == "assistant" {
            let own: Vec<String> = m["tool_calls"]
                .as_array()
                .map(|a| a.iter().filter_map(|tc| tc["id"].as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if !own.is_empty() && own.iter().any(|id| !kept_results.contains(id)) {
                m.as_object_mut().unwrap().remove("tool_calls");
            }
        }
    }
}

/// Floor to the nearest UTF-8 char boundary at or before `max` (byte index).
/// Byte slicing at a non-boundary panics — Persian text is multi-byte.
fn trunc_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Serialize one older turn for the summarizer (agents.py `_serialize`):
/// redact nothing here (app errors already rare in stored history), truncate
/// huge tool outputs, and append plan/tool-activity extras when present.
fn serialize(msg: &Value) -> String {
    let mut content = content_of(msg);
    if content.len() > TOOL_OUTPUT_MAX_CHARS {
        let cut = trunc_bytes(&content, TOOL_OUTPUT_MAX_CHARS).len();
        content.truncate(cut);
        content.push_str("\n[truncated]");
    }
    let mut extras: Vec<String> = Vec::new();
    if let Some(items) = msg["plan"].as_array() {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|it| {
                let text = it["content"].as_str()?.trim().to_string();
                if text.is_empty() {
                    return None;
                }
                let status = it["status"].as_str().unwrap_or("pending").to_lowercase();
                let status = if matches!(status.as_str(), "pending" | "in_progress" | "completed") {
                    status
                } else {
                    "pending".into()
                };
                Some(format!("- [{status}] {}", trunc_bytes(&text, 200)))
            })
            .collect();
        if !lines.is_empty() {
            extras.push(format!("Task checklist (statuses as of this turn):\n{}", lines.join("\n")));
        }
    }
    if let Some(acts) = msg["toolActivity"].as_array() {
        let lines: Vec<String> = acts
            .iter()
            .filter_map(|a| {
                let status = a["status"].as_str()?.to_lowercase();
                if status != "done" && status != "error" {
                    return None;
                }
                let tool = a["tool"].as_str()?.trim().to_string();
                if tool.is_empty() {
                    return None;
                }
                let mut line = format!("- {tool}()");
                if let Some(s) = a["summary"].as_str() {
                    line = format!("- {tool}() → {}", trunc_bytes(s, 240));
                }
                if status == "error" {
                    line.push_str(" [FAILED]");
                }
                Some(line)
            })
            .take(40)
            .collect();
        if !lines.is_empty() {
            extras.push(format!(
                "Tool calls already executed this conversation (do NOT list these as pending work):\n{}",
                lines.join("\n")
            ));
        }
    }
    if !extras.is_empty() {
        content.push_str("\n\n");
        content.push_str(&extras.join("\n\n"));
    }
    content
}

pub struct CompactOutcome {
    pub summary: String,
    pub keep: usize,
    pub usage: Option<Value>,
    /// Provider ROW of the rung that ACTUALLY answered, and its model id.
    ///
    /// Carried out of the walk because a later rung can be the one that
    /// answers: reporting the summariser slot's own provider/model there
    /// attributed the tokens to a provider that never served the request (a
    /// compaction that fell through to the user's fallback was billed to rung
    /// 0 in the Model-usage panel).
    pub provider_id: String,
    pub model: String,
}

/// Port of `_compact_history`. Returns Ok(None) when there is nothing to do.
///
/// Test-only: every live caller needs live progress (the `/chat/compact` route
/// streams it, the mid-turn auto-compaction emits `CompactProgress`), so both
/// use [`compact_history_with_progress`] directly. Keeping the no-progress
/// shape for the no-op test documents the "nothing to do" contract without
/// leaving an unused function in the shipped binary.
#[cfg(test)]
pub async fn compact_history(
    client: &reqwest::Client,
    model: &LlmConfig,
    fallbacks: &[LlmConfig],
    history: &[Value],
    ctx: usize,
    max_output: usize,
    force: bool,
) -> Result<Option<CompactOutcome>, String> {
    compact_history_with_progress(
        client, model, fallbacks, history, ctx, max_output, force, false, &mut |_| {},
    )
    .await
}

/// Full try order for one compaction: the summariser's own model first, then the
/// configured fallbacks in the user's order. The same target is kept ONCE
/// (a caller may list its chat model both ways), so no rung is asked twice and a
/// short list is not spent re-failing a model that already answered.
pub fn compact_chain<'a>(model: &'a LlmConfig, fallbacks: &'a [LlmConfig]) -> Vec<&'a LlmConfig> {
    let mut chain: Vec<&LlmConfig> = Vec::with_capacity(fallbacks.len() + 1);
    chain.push(model);
    for fb in fallbacks {
        let seen = chain.iter().any(|c| {
            c.provider == fb.provider && c.model == fb.model && c.base_url == fb.base_url
        });
        if !seen {
            chain.push(fb);
        }
    }
    chain
}

/// Same as [`compact_history`], but reports live progress (`CompactProgress`) so
/// the UI can show the phase, the attempt and the elapsed time instead of an
/// anonymous spinner. Used by the streaming `/chat/compact` route and by the
/// mid-turn auto-compaction.
///
/// `summarize_all` is for the MID-TURN caller only. This function normally
/// keeps a token-budgeted verbatim tail out of the summarizer — a tail the
/// `/chat/compact` route hands back to the renderer via `keep`, so it survives
/// on the wire. The mid-turn caller rebuilds the wire from the returned summary
/// plus its own in-flight step alone and never splices that tail back, so
/// excluding it from the summary dropped it from BOTH: traced on the Oct 29
/// corpus, a compaction at 64.8K tokens left 4 wire messages and a summary that
/// covered only the oldest quarter — the newest ~40% of the work history was in
/// neither (the model then re-read files it had already read, paying extra
/// round-trips to recover what the tail selection had silently discarded).
/// With `summarize_all` the whole foldable history is summarized instead:
/// nothing is dropped silently, and the wire still shrinks to the summary.
#[allow(clippy::too_many_arguments)]
pub async fn compact_history_with_progress(
    client: &reqwest::Client,
    model: &LlmConfig,
    fallbacks: &[LlmConfig],
    history: &[Value],
    ctx: usize,
    max_output: usize,
    force: bool,
    summarize_all: bool,
    on_progress: &mut (dyn FnMut(&CompactProgress) + Send),
) -> Result<Option<CompactOutcome>, String> {
    let started = std::time::Instant::now();
    progress_tick(on_progress, started, "preparing", 0, 0, model);
    // An unknown window must follow the same capacity rule as everything else
    // (models.dev → provider → DEFAULT_CONTEXT_WINDOW), not a private 8k literal:
    // an 8192 window put the verbatim tail at ~3.2k tokens and folded nearly the
    // whole history, which is why a compact could look like it fired far too
    // early.
    let ctx = if ctx == 0 { crate::agent::DEFAULT_CONTEXT_WINDOW } else { ctx };
    let tail_budget = recent_tail_budget(ctx, max_output, None);

    // Pull the prior summary out of the array BEFORE selecting the tail. It is
    // a checkpoint, not a turn: leaving it in place lets the backward walk
    // swallow it into `recent`, so the merge prompt never receives it and the
    // new summary replaces it with only the few messages after it. The manual
    // route appends the summary at the END and the mid-turn route inserts it as
    // a `user` note, so position is not a reliable signal — scan every message.
    let mut existing_summary = String::new();
    let mut conversation: Vec<Value> = Vec::with_capacity(history.len());
    for m in history {
        match summary_body(m) {
            // The newest summary wins: older ones (if a caller sends them) are
            // already folded into it.
            Some(body) => existing_summary = body,
            None => conversation.push(m.clone()),
        }
    }
    let history = conversation.as_slice();

    // Select the recent tail (whole messages, backward walk). Skipped entirely
    // when `summarize_all` is set — see the doc on
    // `compact_history_with_progress` for why the mid-turn caller must not
    // leave a verbatim tail behind that it will never splice back.
    let mut tail: Vec<Value> = Vec::new();
    let mut tail_tokens = 0usize;
    if !summarize_all {
        for m in history.iter().rev() {
            let est = estimate_tokens(&content_of(m));
            if !tail.is_empty() && tail_tokens + est > tail_budget {
                break;
            }
            tail.push(m.clone());
            tail_tokens += est;
        }
        tail.reverse();
        clean_tail(&mut tail);

        // Protect the in-flight step (assistant tool_calls + its tool results).
        let mut in_flight: Option<usize> = None;
        for i in (0..history.len()).rev() {
            if history[i]["role"] == "assistant" {
                if history[i + 1..].iter().any(|m| m["role"] == "tool") {
                    in_flight = Some(i);
                }
                break;
            }
        }
        if let Some(i) = in_flight {
            if i < history.len() - tail.len() {
                tail = history[i..].to_vec();
            }
        }
    }

    let mut recent = tail;
    let mut older: Vec<Value> = history[..history.len() - recent.len()].to_vec();
    if older.is_empty() {
        if !force {
            return Ok(None);
        }
        if history.len() > 1 {
            older = history[..history.len() - 1].to_vec();
            recent = history[history.len() - 1..].to_vec();
        } else {
            older = history.to_vec();
            recent = Vec::new();
        }
    }

    let older_turns = older;
    if older_turns.is_empty() {
        return Ok(None);
    }

    // Serialize + bound the head. The token estimate is summed incrementally:
    // re-joining and re-estimating the whole transcript on every iteration is
    // O(n²) and on a huge history stalled here for a long time BEFORE the
    // summarizer call, where the UI shows no progress at all.
    let mut texts: Vec<String> = older_turns.iter().map(serialize).collect();
    // The verbatim tail rides to the summarizer as context, not as head — cap
    // the head by what the tail ACTUALLY kept (not the full budget), so a
    // short tail leaves the room to the head. With `summarize_all` the tail is
    // empty and the whole budget goes to the head. A merged prior summary is
    // part of the prompt too, so its tokens must be reserved as well or a small
    // window can overflow on head + summary + template.
    let max_head_tokens = usable_tokens(ctx, max_output, None)
        .saturating_sub(tail_tokens + estimate_tokens(&existing_summary) + 512)
        .max(1024);
    // `join("\n\n")` contributes one separator per boundary — count it so the
    // incremental total matches what the joined string really costs.
    let sep_tokens = estimate_tokens("\n\n");
    let mut head_tokens: usize = texts.iter().map(|t| estimate_tokens(t)).sum::<usize>()
        + texts.len().saturating_sub(1) * sep_tokens;
    let mut dropped = 0usize;
    while head_tokens > max_head_tokens && texts.len() - dropped > 1 {
        head_tokens = head_tokens.saturating_sub(estimate_tokens(&texts[dropped]) + sep_tokens);
        dropped += 1;
    }
    let texts = texts.split_off(dropped);
    let head_text = texts.join("\n\n");

    let user_prompt = if existing_summary.is_empty() {
        format!(
            "Here is the conversation so far:\n\n<conversation>\n{head_text}\n</conversation>\n\n\
             Create a new anchored summary from the conversation history in the \
             <conversation> tags above so the assistant can continue the work.\n\n\
             {SUMMARY_TEMPLATE}"
        )
    } else {
        format!(
            "Here is the conversation so far:\n\n<conversation>\n{head_text}\n</conversation>\n\n\
             Here is the summary of the conversation before the <conversation> above:\n\n\
             <prior-summary>\n{existing_summary}\n</prior-summary>\n\n\
             Update the prior summary so it reflects the conversation so far, merging new \
             details into the template. The prior summary is discarded after this: anything \
             you do not carry into the new summary is lost. Where the conversation and the \
             prior summary conflict, the conversation wins.\n{SUMMARY_TEMPLATE}"
        )
    };
    const SYSTEM: &str = "You are a precise summarizer for a GENERAL-PURPOSE AI assistant. Produce the anchored summary exactly in the requested template. The conversation can be about any topic — coding, research, trading, writing, planning, everyday questions, or anything else. Stay anchored to the conversation's own domain and vocabulary; never invent or force a coding/repository framing. Keep concrete details that actually appear: goals, decisions, names, numbers, dates, URLs, paths, commands and identifiers, errors and their fixes, and the current state. Respond in the same language as the conversation.";

    // Summarize on the primary model, then once on the fallback. Every attempt
    // is bounded twice over: `llm::complete` honors the model's own timeout, and
    // the loop below stops at a shared wall-clock deadline. Without the shared
    // deadline the per-attempt timeouts added up, and a slow provider plus
    // fallback retries kept the "Compacting…" banner alive for many minutes
    // with no summary ever arriving.
    let mut outcome: Option<CompactOutcome> = None;
    // Every rung's reason, in try order. Reporting only the LAST failure is what
    // made a working fallback list look like it was never used: the banner
    // showed the chat model's 401 while the user's own fallbacks had already
    // been tried and rejected too.
    let mut tried: Vec<String> = Vec::new();
    let chain = compact_chain(model, fallbacks);
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(COMPACT_TOTAL_BUDGET_SECS);
    // Attempts this run may make in total: every rung may spend its own budget.
    // Reported so the UI can say "attempt 2 of 3" instead of guessing.
    // After the LAST fallback fails the walk goes back to the top and tries the
    // list again (see COMPACT_MAX_CYCLES), until the shared deadline.
    let chain_len = chain.len();
    // Every list is rotated, a one-model list included: after its only rung
    // fails the walk starts over at that same model. The old `len > 1` guard
    // meant a single configured model got exactly one try while a list was
    // retried — a transient 429/5xx ended the compaction for no reason.
    let cycles = COMPACT_MAX_CYCLES;
    let walk: Vec<&LlmConfig> = (0..cycles).flat_map(|_| chain.iter().copied()).collect();
    let attempts_total = walk.len();
    let mut attempt_no = 0usize;
    'rungs: for (pos, m) in walk.into_iter().enumerate() {
        if pos > 0 && pos % chain_len == 0 {
            // A new pass over the list: breathe first, and never start one the
            // deadline cannot finish.
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let pause = std::time::Duration::from_secs(COMPACT_CYCLE_PAUSE_SECS);
            if remaining <= pause {
                break 'rungs;
            }
            tokio::time::sleep(pause).await;
        }
        // ONE try per rung, whatever the failure: a rate limit, a 5xx or a
        // dropped stream moves the walk to the NEXT model immediately — asking
        // the same model again right away can only reproduce the same error,
        // and the walk comes back to this rung on the next pass anyway.
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < std::time::Duration::from_secs(COMPACT_MIN_RUNG_SECS) {
            break 'rungs;
        }
        // ONE rung may not eat the whole budget: a provider that takes the
        // request and stalls hands over to the next model instead of blocking
        // every fallback behind it.
        let rung_timeout =
            std::time::Duration::from_secs(COMPACT_CALL_TIMEOUT_SECS).min(remaining);
        attempt_no += 1;
        progress_tick(on_progress, started, "summarizing", attempt_no, attempts_total, m);
        let rung_err = match
            tokio::time::timeout(rung_timeout, llm::complete(client, m, SYSTEM, &user_prompt))
                .await
        {
            Ok(Ok(r)) if !r.text.trim().is_empty() => {
                // Attribute the answer to THIS rung, not to rung 0.
                outcome = Some(CompactOutcome {
                    summary: r.text.trim().to_string(),
                    keep: recent.len(),
                    usage: r.usage,
                    provider_id: m.provider_id.clone(),
                    model: m.model.clone(),
                });
                break 'rungs;
            }
            Ok(Ok(_)) => "returned an empty summary".to_string(),
            Ok(Err(e)) => e,
            Err(_) => format!("gave no answer within {}s", rung_timeout.as_secs()),
        };
        // Only the FIRST pass is reported: later passes repeat the same models,
        // and listing each one again would bury the reasons in the banner.
        if !rung_err.is_empty() && pos < chain_len {
            tried.push(format!("{}: {rung_err}", m.model));
            // This rung spent its one try without an answer, so the walk moves
            // on regardless of WHY it failed: the fallbacks sit on other
            // providers with other endpoints, and one unreachable or
            // rate-limited model must not strand the whole list. Only a success
            // or the shared deadline ends the walk early.
        }
    }
    match outcome {
        Some(o) => {
            progress_tick(on_progress, started, "merging", attempt_no, attempts_total, model);
            Ok(Some(o))
        }
        // The aggregate names every model that was tried, so a banner can no
        // longer hide a fallback list that did run and did fail.
        None => Err(if tried.is_empty() {
            "summarizer failed".to_string()
        } else {
            format!("every summarizer model failed — {}", tried.join("; "))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(role: &str, content: &str) -> Value {
        json!({ "role": role, "content": content })
    }

    #[test]
    fn token_estimate_matches_python_heuristic() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn tail_budget_is_fraction_of_window() {
        assert_eq!(recent_tail_budget(10_000, 0, None), usable_tokens(10_000, 0, None) * 40 / 100);
        assert!(recent_tail_budget(10_000, 0, None) < 10_000);
    }

    #[test]
    fn orphaned_tool_messages_are_removed() {
        let mut tail = vec![
            json!({ "role": "assistant", "content": "x", "tool_calls": [{ "id": "a" }] }),
            json!({ "role": "tool", "content": "res", "tool_call_id": "orphan" }),
            json!({ "role": "tool", "content": "res", "tool_call_id": "a" }),
            json!({ "role": "assistant", "content": "y", "tool_calls": [{ "id": "lost" }] }),
        ];
        clean_tail(&mut tail);
        // orphan tool removed; the "lost" assistant stays but its tool_calls
        // are stripped (Python keeps the message for its text content).
        assert_eq!(tail.len(), 3);
        assert!(tail.last().unwrap().get("tool_calls").is_none());
    }

    #[test]
    fn serialize_truncates_and_appends_extras() {
        let m = json!({
            "role": "user",
            "content": "x".repeat(TOOL_OUTPUT_MAX_CHARS + 10),
            "plan": [{ "content": "do it", "status": "completed" }],
            "toolActivity": [{ "tool": "read", "status": "done", "summary": "ok" }],
        });
        let s = serialize(&m);
        assert!(s.contains("[truncated]"));
        assert!(s.contains("- [completed] do it"));
        assert!(s.contains("- read() → ok"));
    }

    #[test]
    fn serialize_truncates_on_char_boundaries_persian() {
        // Persian text is multi-byte — byte slicing mid-char used to panic
        // ("end byte index 200 is not a char boundary").
        let m = json!({
            "role": "user",
            "content": "سلام دنیا ".repeat(TOOL_OUTPUT_MAX_CHARS),
            "plan": [{ "content": "بررسی وضعیت پروژه و مهاجرت به تائوری", "status": "completed" }],
            "toolActivity": [{ "tool": "grep", "status": "done", "summary": "جست‌وجوی الگو در فایل‌های پروژه انجام شد" }],
        });
        let s = serialize(&m);
        assert!(s.contains("[truncated]"));
        assert!(s.contains("بررسی وضعیت پروژه"));
        assert!(s.contains("جست‌وجوی الگو"));
    }

    #[test]
    fn compact_noop_when_history_fits_tail() {
        let client = llm::http_client();
        let model = LlmConfig {
            provider: "custom".into(),
            headers: Vec::new(),
            provider_id: "custom".into(),
            model: "m".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_keys: vec!["k".into()],
            temperature: None,
            max_tokens: None,
            timeout_secs: 1,
            reasoning_level: String::new(),
            model_reasoning: false,
            auto_think: false,
        };
        let hist: Vec<Value> = (0..3).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
            .block_on(compact_history(&client, &model, &[], &hist, 1_000_000, 0, false));
        assert!(matches!(out, Ok(None)));
    }

    // A summariser whose own model is rejected must FALL THROUGH the configured
    // fallback list, in order, and stop at the first rung that answers — the
    // behaviour a user expects from Settings → Tools (fallback used the moment a
    // call fails). The chain helper is what the retry loop walks, so this pins
    // the order and the duplicate handling the loop depends on.
    fn cfg(provider: &str, model: &str, base: &str) -> LlmConfig {
        LlmConfig {
            provider: provider.into(),
            headers: Vec::new(),
            provider_id: provider.into(),
            model: model.into(),
            base_url: base.into(),
            api_keys: vec!["k".into()],
            temperature: None,
            max_tokens: None,
            timeout_secs: 1,
            reasoning_level: String::new(),
            model_reasoning: false,
            auto_think: false,
        }
    }

    #[test]
    fn chain_tries_own_model_then_each_fallback_in_order() {
        let model = cfg("openai", "primary", "https://a.example");
        let fallbacks = vec![
            cfg("openai", "fb-1", "https://a.example"),
            cfg("custom", "fb-2", "http://127.0.0.1:9"),
        ];
        let chain = compact_chain(&model, &fallbacks);
        let ids: Vec<&str> = chain.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(ids, vec!["primary", "fb-1", "fb-2"]);
        // The whole list is walked, not just its first rung: a rejected key on
        // `primary` and a dead `fb-1` must still leave `fb-2` reachable.
        assert_eq!(chain.len(), 3);
    }

    #[test]
    fn chain_keeps_a_target_once() {
        let model = cfg("openai", "primary", "https://a.example");
        // The manual path can list the chat model as a fallback while the
        // summariser already runs on it: asking it twice would burn the budget
        // re-failing a model that already answered.
        let fallbacks = vec![
            cfg("openai", "primary", "https://a.example"),
            cfg("openai", "fb-1", "https://a.example"),
            cfg("openai", "fb-1", "https://a.example"),
        ];
        let chain = compact_chain(&model, &fallbacks);
        let ids: Vec<&str> = chain.iter().map(|c| c.model.as_str()).collect();
        assert_eq!(ids, vec!["primary", "fb-1"]);
    }

    #[test]
    fn chain_is_just_the_own_model_without_fallbacks() {
        let model = cfg("openai", "primary", "https://a.example");
        let chain = compact_chain(&model, &[]);
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].model, "primary");
    }

    /// A tiny OpenAI-compatible stub: answers the Nth request with the Nth
    /// scripted (status, body), repeating the LAST one if the walk needs more.
    /// Two requests are all it takes to prove a rejected key on one model hands
    /// the call to the next.
    fn stub_server(responses: Vec<(u16, String)>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for (i, conn) in listener.incoming().enumerate() {
                let Ok(mut conn) = conn else { break };
                // Drain the request head (and body) before replying, so the
                // client never sees a connection reset mid-send.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match conn.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let (status, body) = responses
                    .get(i)
                    .or_else(|| responses.last())
                    .cloned()
                    .unwrap_or((500, String::new()));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = conn.write_all(reply.as_bytes());
                let _ = conn.flush();
            }
        });
        format!("http://{addr}")
    }

    /// A CONNECTION failure still walks the user's own fallback list: that list
    /// IS the try order they arranged, and its rungs normally live on a
    /// DIFFERENT provider with a different endpoint — an unreachable primary
    /// says nothing about them. Stopping at the first transport error is what
    /// left a configured fallback unused and surfaced the primary's raw network
    /// error instead of a summary.
    #[tokio::test]
    async fn connection_failure_still_walks_the_users_fallback_list() {
        // Nothing listens on the discard port, so the primary cannot connect at
        // all — the transport error path, not a model rejection.
        let dead = "http://127.0.0.1:9";
        let healthy = stub_server(vec![(
            200,
            r#"{"choices":[{"message":{"content":"SUMMARY FROM FALLBACK"}}]}"#.to_string(),
        )]);
        let mut primary = cfg("custom", "primary-model", dead);
        primary.timeout_secs = 5;
        let mut fallback = cfg("custom", "healthy-fallback", &healthy);
        fallback.timeout_secs = 5;
        let hist: Vec<Value> = (0..4).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = compact_history_with_progress(
            &llm::http_client(),
            &primary,
            &[fallback],
            &hist,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("the fallback must answer when the primary cannot connect");
        let outcome = out.expect("the fallback answered, so the compaction ran");
        assert_eq!(outcome.summary, "SUMMARY FROM FALLBACK");
    }

    /// The user's field failure: the summariser's own provider answers
    /// `401 Invalid API key`. The configured fallback must be tried and answer
    /// the compaction instead of the whole call failing.
    #[tokio::test]
    async fn rejected_key_falls_through_to_the_next_fallback() {
        let url = stub_server(vec![
            (
                401,
                r#"{"error":{"message":"Invalid API key","type":"invalid_request_error"}}"#
                    .to_string(),
            ),
            (
                200,
                r#"{"choices":[{"message":{"content":"SUMMARY FROM FALLBACK"}}]}"#.to_string(),
            ),
        ]);
        let mut primary = cfg("custom", "dead-model", &url);
        primary.timeout_secs = 5;
        let mut fallback = cfg("custom", "good-model", &url);
        fallback.timeout_secs = 5;
        let hist: Vec<Value> = (0..4).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = compact_history_with_progress(
            &llm::http_client(),
            &primary,
            &[fallback],
            &hist,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await;
        let outcome = out
            .expect("a rejected key on the primary must not fail the compaction")
            .expect("the fallback rung answered, so a summary must exist");
        assert_eq!(outcome.summary, "SUMMARY FROM FALLBACK");
    }

    /// When every rung is rejected the call still fails — with the provider's
    /// real reason, because that text becomes the banner the user reads.
    #[tokio::test]
    async fn every_rung_rejected_surfaces_the_reason() {
        let url = stub_server(vec![(
            401,
            r#"{"error":{"message":"Invalid API key"}}"#.to_string(),
        )]);
        let mut primary = cfg("custom", "dead-model", &url);
        primary.timeout_secs = 5;
        let mut fallback = cfg("custom", "also-dead", &url);
        fallback.timeout_secs = 5;
        let hist: Vec<Value> = (0..4).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = compact_history_with_progress(
            &llm::http_client(),
            &primary,
            &[fallback],
            &hist,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await;
        match out {
            Ok(_) => panic!("every rung was rejected, so the call must fail"),
            Err(e) => {
                assert!(e.contains("401"), "expected the 401 reason, got: {e}");
                // The banner must be able to prove the fallback list RAN. Before
                // this only the last rung's reason survived, so a working list
                // that also failed was indistinguishable from one that was
                // never tried.
                assert!(e.contains("dead-model"), "the summariser's own model must be named, got: {e}");
                assert!(e.contains("also-dead"), "the fallback model must be named too, got: {e}");
            }
        }
    }

    /// A ONE-MODEL chain is rotated too. The old `len > 1` guard gave a single
    /// configured model exactly one try, so a transient 500 ended the
    /// compaction while the walk would have retried the same model one pass
    /// later. This pins that second pass.
    #[tokio::test]
    async fn a_single_model_chain_retries_after_a_transient_failure() {
        let url = stub_server(vec![
            (
                500,
                r#"{"error":{"message":"temporary overload"}}"#.to_string(),
            ),
            (
                200,
                r#"{"choices":[{"message":{"content":"SUMMARY ON RETRY"}}]}"#.to_string(),
            ),
        ]);
        let mut model = cfg("custom", "only-model", &url);
        model.timeout_secs = 5;
        let hist: Vec<Value> = (0..4).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &hist,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("a transient failure on a one-model chain must be retried");
        let outcome = out.expect("the retry answered, so a summary must exist");
        assert_eq!(outcome.summary, "SUMMARY ON RETRY");
        assert_eq!(outcome.model, "only-model");
    }

    /// A stub that ANSWERS like [`stub_server`] but also CAPTURES the request
    /// body, so a test can assert what the summarizer actually received.
    fn capturing_stub(captured: std::sync::Arc<std::sync::Mutex<String>>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Some(Ok(mut conn)) = listener.incoming().next() {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match conn.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                        let len: usize = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")?
                                    .trim()
                                    .parse()
                                    .ok()
                            })
                            .unwrap_or(0);
                        while buf.len() < pos + 4 + len {
                            match conn.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                        }
                        *captured.lock().unwrap() =
                            String::from_utf8_lossy(&buf[pos + 4..]).to_string();
                        break;
                    }
                }
                let body = r#"{"choices":[{"message":{"content":"SUMMARY"}}]}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = conn.write_all(reply.as_bytes());
                let _ = conn.flush();
            }
        });
        format!("http://{addr}")
    }

    /// The mid-turn caller rebuilds its wire from the returned summary plus its
    /// own in-flight tail ONLY — it never splices a verbatim tail back. With the
    /// default tail selection the newest messages therefore reached NEITHER the
    /// summary NOR the wire (traced Oct 29: a compaction at 64.8K tokens left
    /// the newest ~40% of the work history in both places' complement). With
    /// `summarize_all` every foldable message must reach the SUMMARIZER.
    #[tokio::test]
    async fn summarize_all_sends_the_whole_history_to_the_summarizer() {
        // ~300 est tokens per message against a 2_000-token tail budget (40% of
        // the 5_000 window): the default path keeps the newest SIX messages
        // verbatim (out of the summarizer) while the head cap keeps the front
        // intact; summarize_all must hand EVERY message over.
        let msgs: Vec<Value> = (0..10)
            .map(|i| msg("user", &format!("MARK-{i} {}", "x".repeat(1_200))))
            .collect();
        let mut model = cfg("custom", "summarizer", "");
        model.timeout_secs = 5;

        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let url = capturing_stub(captured.clone());
        model.base_url = url.clone();
        compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &msgs,
            5_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("the stub answers");
        let default_body = captured.lock().unwrap().clone();
        assert!(default_body.contains("MARK-0"), "the head is summarized");
        assert!(
            !default_body.contains("MARK-8") && !default_body.contains("MARK-9"),
            "the default path keeps the newest messages out of the summarizer"
        );

        let captured_all = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let url_all = capturing_stub(captured_all.clone());
        model.base_url = url_all;
        compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &msgs,
            5_000,
            0,
            true,
            true,
            &mut |_| {},
        )
        .await
        .expect("the stub answers");
        let all_body = captured_all.lock().unwrap().clone();
        assert!(
            all_body.contains("MARK-8") && all_body.contains("MARK-9"),
            "summarize_all must put the newest messages IN the summarizer prompt — \
             the mid-turn caller has no verbatim tail to keep them on the wire"
        );
    }

    #[test]
    fn summary_body_detects_manual_and_mid_turn_summaries() {
        assert_eq!(
            summary_body(&json!({
                "role": "system",
                "content": "<summary>\nMARK-PRIOR\n</summary>"
            }))
            .as_deref(),
            Some("MARK-PRIOR")
        );
        assert_eq!(
            summary_body(&json!({
                "role": "user",
                "content": "[Compacted earlier context]\n\nMARK-PRIOR"
            }))
            .as_deref(),
            Some("MARK-PRIOR")
        );
        assert!(summary_body(&json!({ "role": "user", "content": "hello" })).is_none());
        assert!(summary_body(&json!({ "role": "assistant", "content": "<summary>" })).is_none());
    }

    /// The user's field failure: a manual `/compact` appends its summary at the
    /// END of the transcript. A second compact used to swallow that summary into
    /// the verbatim tail, summarize only the one message after it, then replace
    /// the old summary — the new summary forgot the entire chat ("چرا بای؟"
    /// became the whole task). The prior summary must reach the merge prompt.
    #[tokio::test]
    async fn a_prior_manual_summary_at_the_tail_is_merged_not_summarized_alone() {
        let mut model = cfg("custom", "summarizer", "");
        model.timeout_secs = 5;
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        model.base_url = capturing_stub(captured.clone());
        let history = vec![
            msg("user", "MARK-USER: analyse the EURUSD chart"),
            msg("system", "<summary>\nMARK-PRIOR: the user asked for entry, stop and target levels\n</summary>"),
        ];
        let out = compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &history,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("the stub answers")
        .expect("there is a user message to summarize");
        let body = captured.lock().unwrap().clone();
        assert!(body.contains("MARK-PRIOR"), "the prior summary must be merged: {body}");
        assert!(body.contains("<prior-summary>"), "the merge prompt must mark the prior summary: {body}");
        assert!(body.contains("MARK-USER"), "the new turn must also be summarized: {body}");
        // The summary is a checkpoint, never a turn kept verbatim: keeping it
        // would make the renderer preserve the OLD summary next to the new one.
        assert_eq!(out.keep, 0);
    }

    /// The manual route now sends the FULL transcript, so a wrong summary from
    /// an earlier compaction can be repaired: every original turn must reach
    /// the summarizer, not just the tail after the bad checkpoint.
    #[tokio::test]
    async fn a_full_transcript_repairs_a_bad_prior_summary() {
        let mut model = cfg("custom", "summarizer", "");
        model.timeout_secs = 5;
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        model.base_url = capturing_stub(captured.clone());
        let history = vec![
            msg("user", "MARK-OLD-1: analyse the EURUSD chart"),
            msg("assistant", "MARK-OLD-2: here are the entry and stop levels"),
            msg("user", "MARK-NEW: what about today?"),
            msg("assistant", "MARK-ANSWER: today's fundamental and sentiment view"),
            msg("system", "<summary>\nMARK-BAD: no coding task, no repository\n</summary>"),
        ];
        let out = compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &history,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("the stub answers")
        .expect("there is a transcript to summarize");
        let body = captured.lock().unwrap().clone();
        assert!(body.contains("MARK-OLD-1"), "the oldest turn must be recovered: {body}");
        assert!(body.contains("MARK-OLD-2"), "the older answer must be recovered: {body}");
        assert!(body.contains("MARK-NEW"), "the newest turn must be included: {body}");
        assert!(body.contains("MARK-BAD"), "the bad summary must be offered for repair: {body}");
        assert_eq!(out.keep, 1);
    }

    /// Mid-turn compaction stores its checkpoint as a `user` message with the
    /// marker. It must be merged exactly like a manual summary; the old scan
    /// only looked at `system`, so this form was summarized as ordinary text.
    #[tokio::test]
    async fn a_mid_turn_marker_summary_at_the_tail_is_merged() {
        let mut model = cfg("custom", "summarizer", "");
        model.timeout_secs = 5;
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        model.base_url = capturing_stub(captured.clone());
        let history = vec![
            msg("user", "MARK-USER: analyse the market"),
            msg("assistant", "MARK-ANSWER: here is the analysis"),
            msg("user", "[Compacted earlier context]\n\nMARK-PRIOR: earlier chart work"),
        ];
        let out = compact_history_with_progress(
            &llm::http_client(),
            &model,
            &[],
            &history,
            1_000_000,
            0,
            true,
            false,
            &mut |_| {},
        )
        .await
        .expect("the stub answers")
        .expect("there is a user message to summarize");
        let body = captured.lock().unwrap().clone();
        assert!(body.contains("MARK-PRIOR"), "the mid-turn summary must be merged: {body}");
        assert!(body.contains("MARK-USER"), "the new turn must also be summarized: {body}");
        // Only the assistant answer stays verbatim; the summary itself does not
        // count toward `keep`.
        assert_eq!(out.keep, 1);
    }
}
