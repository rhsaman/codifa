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

/// Attempts ONE rung may spend before the walk moves down to the next model.
///
/// A rung that fails NON-fatally — a genuine rate limit, a 5xx, a dropped
/// stream — is worth one repeat on the SAME model. A model-side rejection (a
/// refused key, a model the provider does not serve, an exhausted allowance)
/// skips the rest of the rung's budget instead: asking that model again can
/// only produce the same error. The same budget exists in the sub-agent ladder
/// (`SUBAGENT_RUNG_ATTEMPTS`), so a tool behaves the same wherever it runs.
const COMPACT_RUNG_ATTEMPTS: usize = 2;

/// How many times the WHOLE model list is walked top to bottom. After the last
/// fallback fails the walk starts over from the summariser's own model (a
/// provider that was down a minute ago is often back), still inside the shared
/// wall-clock budget. A chain of one model is not rotated: its rung already
/// repeats on its own.
const COMPACT_MAX_CYCLES: usize = 3;

/// Pause between two passes over the list, so a list of dead rungs is not
/// hammered back to back.
const COMPACT_CYCLE_PAUSE_SECS: u64 = 4;

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
   <!-- What the user asked for, verbatim intent, constraints -->
2. Decisions and approach:
   <!-- Key technical decisions made and why -->
3. Work completed (DURABLE LEDGER — never drop an entry):
   <!-- One bullet per finished item, each with the EXACT path (and line/function
        when known), the commit hash when one was made, and the outcome.
        This section is the ONLY record of finished work after compaction: an
        item missing here WILL be redone from scratch. Copy entries forward
        verbatim from a previous summary instead of re-summarizing them. -->
4. Current state:
   <!-- What exists right now: files, branches, running processes -->
5. Next steps:
   <!-- What remains, in order, with any blockers -->
6. Important context:
   <!-- Errors hit and fixes, user preferences, gotchas -->
</summary>
"#;

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
        client, model, fallbacks, history, ctx, max_output, force, &mut |_| {},
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
#[allow(clippy::too_many_arguments)]
pub async fn compact_history_with_progress(
    client: &reqwest::Client,
    model: &LlmConfig,
    fallbacks: &[LlmConfig],
    history: &[Value],
    ctx: usize,
    max_output: usize,
    force: bool,
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

    // Select the recent tail (whole messages, backward walk).
    let mut tail: Vec<Value> = Vec::new();
    let mut tail_tokens = 0usize;
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

    // Separate any existing "[Compacted earlier context]" summary at the head.
    const MARKER: &str = "[Compacted earlier context]";
    let mut existing_summary = String::new();
    let mut older_turns: Vec<Value> = Vec::new();
    for t in &older {
        let content = content_of(t);
        if t["role"] == "system" {
            if let Some(idx) = content.find(MARKER) {
                existing_summary.push_str(content[idx + MARKER.len()..].trim_start_matches('\n'));
                continue;
            }
        }
        older_turns.push(t.clone());
    }
    if older_turns.is_empty() {
        return Ok(None);
    }

    // Serialize + bound the head. The token estimate is summed incrementally:
    // re-joining and re-estimating the whole transcript on every iteration is
    // O(n²) and on a huge history stalled here for a long time BEFORE the
    // summarizer call, where the UI shows no progress at all.
    let mut texts: Vec<String> = older_turns.iter().map(serialize).collect();
    let max_head_tokens = usable_tokens(ctx, max_output, None).saturating_sub(tail_budget + 512).max(1024);
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
             <conversation> tags above so another coding agent can continue the work.\n\n\
             {SUMMARY_TEMPLATE}"
        )
    } else {
        format!(
            "Here is the conversation so far:\n\n<conversation>\n{head_text}\n</conversation>\n\n\
             Here is the summary of the conversation before the <conversation> above:\n\n\
             <prior-summary>\n{existing_summary}\n</prior-summary>\n\n\
             Update the prior summary so it reflects the conversation so far, merging new \
             details into the template.\n{SUMMARY_TEMPLATE}"
        )
    };
    const SYSTEM: &str = "You are a precise summarizer for a coding agent. Produce the anchored summary exactly in the requested template. Keep concrete details: file paths, commands, errors and their fixes.";

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
    let cycles = if chain_len > 1 { COMPACT_MAX_CYCLES } else { 1 };
    let walk: Vec<&LlmConfig> = (0..cycles).flat_map(|_| chain.iter().copied()).collect();
    let attempts_total = walk.len().saturating_mul(COMPACT_RUNG_ATTEMPTS);
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
        // This rung's own failure. Kept per rung so the aggregated message can
        // name WHICH model said what.
        let mut rung_err = String::new();
        for _attempt in 0..COMPACT_RUNG_ATTEMPTS {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break 'rungs;
            }
            attempt_no += 1;
            progress_tick(
                on_progress,
                started,
                "summarizing",
                attempt_no,
                attempts_total,
                m,
            );
            match tokio::time::timeout(remaining, llm::complete(client, m, SYSTEM, &user_prompt))
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
                Ok(Ok(_)) => rung_err = "returned an empty summary".into(),
                Ok(Err(e)) => rung_err = e,
                Err(_) => {
                    rung_err =
                        format!("gave no answer within {COMPACT_TOTAL_BUDGET_SECS}s")
                }
            }
            // A model-side rejection will not answer better on a repeat, so the
            // rest of this rung's budget is skipped and the next model takes the
            // call immediately.
            if llm::should_fall_back(&rung_err) {
                break;
            }
        }
        // Only the FIRST pass is reported: later passes repeat the same models,
        // and listing each one again would bury the reasons in the banner.
        if !rung_err.is_empty() && pos < chain_len {
            tried.push(format!("{}: {rung_err}", m.model));
            // This rung spent its budget without an answer, so the walk moves on
            // regardless of WHY it failed: a rate limit that never clears must
            // not leave the user's own fallbacks unused, which is the entire
            // point of the list. Only a success or the shared deadline ends the
            // walk early.
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
}
