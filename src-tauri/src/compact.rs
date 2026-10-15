// Phase 3-1: native /chat/compact — a Rust port of agents.py `_compact_history`
// (opencode-style compaction): token-budgeted verbatim tail, orphaned tool
// message cleanup, prior-summary merge, and the summarizer call via llm.rs.

use serde_json::Value;

use crate::llm::{self, LlmConfig};

// 4k (was 12k): the summarizer prompt is the whole serialized history — 12k
// chars per tool message made compaction a slow, huge-token LLM call.
const TOOL_OUTPUT_MAX_CHARS: usize = 4_000;
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
}

/// Port of `_compact_history`. Returns Ok(None) when there is nothing to do.
pub async fn compact_history(
    client: &reqwest::Client,
    model: &LlmConfig,
    fallback: Option<&LlmConfig>,
    history: &[Value],
    ctx: usize,
    max_output: usize,
    force: bool,
) -> Result<Option<CompactOutcome>, String> {
    let ctx = if ctx == 0 { 8192 } else { ctx };
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

    // Serialize + bound the head.
    let mut texts: Vec<String> = older_turns.iter().map(serialize).collect();
    let max_head_tokens = usable_tokens(ctx, max_output, None).saturating_sub(tail_budget + 512).max(1024);
    while estimate_tokens(&texts.join("\n\n")) > max_head_tokens && texts.len() > 1 {
        texts.remove(0);
    }
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

    // Summarize on the primary model, then up to 2 retries on the fallback.
    // Each attempt is bounded by the model's own timeout (llm::complete), so a
    // slow primary cannot stack with slow fallback retries into minutes of
    // waiting — the UI's Compacting spinner stays bounded.
    let mut outcome: Option<CompactOutcome> = None;
    let mut last_err = String::new();
    let fallbacks: Vec<&LlmConfig> = if std::ptr::eq(model, fallback.unwrap_or(model)) {
        Vec::new()
    } else {
        fallback.iter().copied().collect()
    };
    for m in std::iter::once(model).chain(fallbacks.into_iter()) {
        let attempts = if std::ptr::eq(m, model) { 1 } else { 2 };
        for _attempt in 0..attempts {
            match llm::complete(client, m, SYSTEM, &user_prompt).await {
                Ok(r) if !r.text.trim().is_empty() => {
                    outcome = Some(CompactOutcome { summary: r.text.trim().to_string(), keep: recent.len(), usage: r.usage });
                    break;
                }
                Ok(_) => last_err = "summarizer returned an empty summary".into(),
                Err(e) => last_err = e,
            }
        }
        if outcome.is_some() {
            break;
        }
    }
    match outcome {
        Some(o) => Ok(Some(o)),
        None => Err(if last_err.is_empty() { "summarizer failed".into() } else { last_err }),
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
            model: "m".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_keys: vec!["k".into()],
            temperature: None,
            max_tokens: None,
            timeout_secs: 1,
        };
        let hist: Vec<Value> = (0..3).map(|i| msg("user", &format!("m{i}"))).collect();
        let out = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
            .block_on(compact_history(&client, &model, None, &hist, 1_000_000, 0, false));
        assert!(matches!(out, Ok(None)));
    }
}
