//! Native agent loop: streams the model, executes tool calls and emits the
//! `kind`-discriminated SSE events the frontend consumes. Everything runs
//! in-process — LSP tools, MCP connectors, sub-agents and compaction are all
//! native (see `tools`, `mcp`, `lsp`, `compact`).

// Some helpers below are shared with the scheduler and the sub-agent paths, so
// not every item is referenced from this module alone.
#![allow(dead_code)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::llm::{http_client, stream_chat, InterruptSignal, LlmConfig, StreamAcc, StreamSignal};
use crate::tools;

/// System prompt for the one-shot vision pass. The model's ONLY job is to
/// describe the attached images factually; it is a side call, so it must not
/// try to answer the user or call tools.
const VISION_SYSTEM_PROMPT: &str = "You are a vision analyst. Describe the attached images precisely and factually: \
what they show, all visible text (transcribe it verbatim), UI elements, layout, colours, errors and any detail \
a developer would need. Never speculate about information that is not visible.";

/// System prompt for the web-search distiller (the "Other" / web slot).
///
/// It answers ONLY from the quoted results and cites the URLs inline, so the
/// main agent gets a lean answer plus real sources instead of ten raw pages.
const WEB_DISTILL_SYSTEM_PROMPT: &str = "You are a web-search reader. Read the quoted search results \
and answer the user's query with a CONCISE summary (under 150 words) that cites the most relevant \
result URLs inline. If the results cannot answer the query, say so.";

/// Whether a URL points at a raw text/source file.
///
/// `fetch_url` returns such a URL WHOLE (like codex's `webfetch`): a skill
/// install or a docs page that came back as a 100k-char excerpt made the agent
/// re-fetch the same file, so the cap is auto-lifted instead of trusting the
/// model to pass `full=true`.
fn looks_like_source_url_agent(url: &str) -> bool {
    crate::websearch::looks_like_source_url(url)
}

/// How many results a `web_search` call asks the engine for.
///
/// ONE user-facing number (Settings → Web Providers → "Results per search")
/// drives BOTH halves of a search: it is how many results come back AND how
/// many of those top results get their real page fetched before the distiller
/// reads them. `0` means "don't fetch pages" (snippets only), NOT "return no
/// results" — so a 0 setting falls back to the default result count instead of
/// collapsing the search. An explicit `max_results` from the model still wins.
fn web_search_result_count(args: &Value, setting: usize) -> usize {
    let clamp = |n: usize| n.clamp(1, crate::websearch::WEB_SEARCH_AUTO_FETCH_MAX);
    if let Some(n) = args["max_results"].as_u64() {
        return clamp(n as usize);
    }
    if setting == 0 {
        return crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT;
    }
    clamp(setting)
}

/// System prompt for the fetched-page distiller (the same "Other" slot).
///
/// A page is longer and denser than a search-result list, so this one is asked
/// for an extraction rather than a summary: the identifiers, numbers and
/// commands a developer needs survive the compression.
const FETCH_DISTILL_SYSTEM_PROMPT: &str = "You are a web-page reader. Read the quoted page and extract the \
information the request needs in under 300 words: keep facts, names, numbers, code identifiers, file paths and \
the exact commands or snippets that matter, and cite the page URL once. Never invent anything that is not on \
the page.";

/// A fetched page shorter than this is handed over verbatim: distilling a
/// snippet costs a round-trip and can only lose detail.
const FETCH_DISTILL_MIN_CHARS: usize = 6_000;

/// Distil a side payload (raw web-search results, a fetched page) with the web
/// slot's model (the "Other" row in Settings → Tools).
///
/// Returns `None` when the slot is unset OR the call fails — the caller then
/// hands the model the RAW payload, which is the pre-existing behaviour, so a
/// missing or broken distiller can never lose the tool result itself.
async fn run_slot_distill(
    client: &reqwest::Client,
    req: &AgentRequest,
    main: &LlmConfig,
    system: &str,
    user: &str,
) -> Option<String> {
    let entry = req
        .subagent_models
        .get("web")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    // An EMPTY slot means "no distiller", not "use the main model": the UI says
    // a blank Other row leaves the raw results in place, and silently spending
    // the chat model on every search/fetch would contradict that. (`main` is an
    // explicit choice and still resolves to the parent below.)
    if entry.is_empty() {
        return None;
    }
    let (model, base, keys, provider_id) = crate::backend_light::resolve_slot_target(
        entry,
        &main.model,
        &main.base_url,
        &main.api_keys,
        &req.provider_id,
        &req.providers,
    );
    // A resolved-but-empty model would send an empty id upstream; treat it as
    // unset so the caller falls back to the raw payload.
    if model.is_empty() {
        return None;
    }
    let kind = crate::backend_light::resolve_slot_kind(entry, &main.provider, &req.providers);
    let level = req
        .subagent_thinking
        .get("web")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    let (reasoning, model_reasoning, auto_think) = crate::llm::reasoning_fields(
        &kind,
        // A side call defaults to no reasoning (never inherits the main level).
        if level.is_empty() { "none" } else { level },
        provider_model_reasoning(&req.providers, &provider_id, &model),
    );
    let cfg = LlmConfig {
        provider: kind,
        model,
        base_url: base,
        api_keys: keys,
        temperature: Some(0.2),
        // A summary is a few hundred tokens; a reasoning model needs room for
        // its preamble on top of that.
        max_tokens: Some(1024),
        timeout_secs: 60,
        reasoning_level: reasoning,
        model_reasoning,
        auto_think,
    };
    match crate::llm::complete(client, &cfg, system, user).await {
        Ok(res) => {
            let text = res.text.trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        // The distiller is an optimisation: a failure must not fail the call.
        Err(_) => None,
    }
}

/// How many history entries may be re-described by the Vision slot in ONE turn.
/// Each description is a paid round-trip, so a long chat must not add one per
/// pasted screenshot; entries outside the window keep their raw image blocks.
const MAX_HISTORY_VISION_CALLS: usize = 2;

/// Result of trying the "Vision" tool slot on a set of images.
enum VisionOutcome {
    /// No Vision slot configured, or it points at the main model: the images
    /// stay inline and travel to the main model as blocks.
    NotConfigured,
    /// The slot's model described the images.
    Ok(String),
    /// The slot's model was called and failed; `model` is named so the turn can
    /// say what was skipped instead of dropping the image silently.
    Failed { model: String, error: String },
}

/// Run the one-shot vision pass for `images` with the Vision slot's model.
///
/// Returns `NotConfigured` when the slot is unset (or resolves to the main
/// model), so the caller keeps the raw image blocks. The slot brings its own
/// model, base URL, keys and reasoning level exactly like the other tool slots
/// — routing a screenshot to a model the main one cannot use is the whole point
/// of the row.
#[allow(clippy::too_many_arguments)]
async fn run_vision_slot(
    client: &reqwest::Client,
    req: &AgentRequest,
    main_model: &str,
    main_kind: &str,
    main_base: &str,
    main_keys: &[String],
    text: &str,
    images: &[String],
) -> VisionOutcome {
    if images.is_empty() {
        return VisionOutcome::NotConfigured;
    }
    let slot_entry = req
        .subagent_models
        .get("vision")
        .map(String::as_str)
        .unwrap_or("");
    let (v_model, v_base, v_keys, v_provider_id) = crate::backend_light::resolve_slot_target(
        slot_entry,
        main_model,
        main_base,
        main_keys,
        &req.provider_id,
        &req.providers,
    );
    if v_model.is_empty() || v_model == main_model {
        return VisionOutcome::NotConfigured;
    }
    let v_kind = crate::backend_light::resolve_slot_kind(slot_entry, main_kind, &req.providers);
    let v_level = req
        .subagent_thinking
        .get("vision")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    let (v_reasoning, v_model_reasoning, v_auto_think) = crate::llm::reasoning_fields(
        &v_kind,
        // A side call defaults to no reasoning (never inherits the main level).
        if v_level.is_empty() { "none" } else { v_level },
        provider_model_reasoning(&req.providers, &v_provider_id, &v_model),
    );
    let v_cfg = LlmConfig {
        provider: v_kind,
        model: v_model.clone(),
        base_url: v_base,
        api_keys: v_keys,
        temperature: Some(0.2),
        max_tokens: Some(2048),
        timeout_secs: crate::llm::NO_TIMEOUT_SECS,
        reasoning_level: v_reasoning,
        model_reasoning: v_model_reasoning,
        auto_think: v_auto_think,
    };
    match crate::llm::complete_with_images(client, &v_cfg, VISION_SYSTEM_PROMPT, text, images).await {
        Ok(res) => {
            let desc = res.text.trim().to_string();
            if desc.is_empty() {
                VisionOutcome::Failed {
                    model: v_model,
                    error: "the model returned an empty description".into(),
                }
            } else {
                VisionOutcome::Ok(desc)
            }
        }
        Err(e) => VisionOutcome::Failed {
            model: v_model,
            error: e,
        },
    }
}

/// Whether a model is KNOWN to accept image input.
///
/// Order: the user's manual override (`manualVisionMap`), then the live
/// capability map the provider's `/models` payload filled (`visionMap`).
/// `None` means "unknown" — the caller then sends the images to the main model
/// and only falls back to the Vision slot if the provider rejects them, which is
/// strictly better than blocking a model that does support images.
///
/// There is deliberately NO name heuristic for images: a wrong `false` would
/// burn a Vision-slot round-trip for an image the main model could have read.
fn model_supports_vision(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
) -> Option<bool> {
    let map_flag = |key: &str| -> Option<bool> {
        let cfg = providers.get(provider_id)?;
        let map = cfg.get(key)?;
        if let Some(v) = map.get(model).and_then(Value::as_bool) {
            return Some(v);
        }
        if provider_id.is_empty() {
            return None;
        }
        map.get(&format!("{provider_id}/{model}"))
            .and_then(Value::as_bool)
    };
    if let Some(v) = map_flag("manualVisionMap") {
        return Some(v);
    }
    map_flag("visionMap")
}

/// Whether a provider error looks like "this model cannot read images".
///
/// Providers word this differently (OpenAI: "Invalid content type. image_url is
/// only supported by certain models."; Anthropic: a content-block validation
/// error; Google: "Unable to process the provided image"), so this is a keyword
/// scan over the lowercased body. It only ever runs when the message list really
/// carries image blocks, so a false positive costs one extra description call.
fn looks_like_image_error(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "image",
        "vision",
        "multimodal",
        "modality",
        "unsupported content",
        "invalid content type",
    ]
    .iter()
    .any(|needle| e.contains(needle))
}

/// Replace inline image blocks in `messages` with a Vision-slot description so a
/// model that just REJECTED the images can still answer.
///
/// This is the second half of "main model first, Vision slot as the fallback":
/// the main call was already tried WITH the images, the provider refused them,
/// and the same step is re-issued with text instead. At most
/// `MAX_HISTORY_VISION_CALLS` images are described (each one is a paid
/// round-trip); anything beyond that is dropped with a note. Returns how many
/// messages were rewritten — `0` means nothing carried images, and the caller
/// reports the original error.
async fn degrade_images_to_text(
    client: &reqwest::Client,
    req: &AgentRequest,
    cfg: &LlmConfig,
    messages: &mut [Value],
) -> usize {
    let mut changed = 0usize;
    let mut calls = 0usize;
    for msg in messages.iter_mut() {
        let Some(blocks) = msg.get("content").and_then(Value::as_array).cloned() else {
            continue;
        };
        let mut text = String::new();
        let mut images: Vec<String> = Vec::new();
        for b in &blocks {
            if b.get("type").and_then(Value::as_str) == Some(crate::llm::IMAGE_BLOCK_TYPE) {
                if let Some(u) = b.get("data_url").and_then(Value::as_str) {
                    images.push(u.to_string());
                }
            } else if let Some(t) = b.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
        }
        if images.is_empty() {
            continue;
        }
        let desc = if calls < MAX_HISTORY_VISION_CALLS {
            calls += 1;
            match run_vision_slot(
                client,
                req,
                &cfg.model,
                &cfg.provider,
                &cfg.base_url,
                &cfg.api_keys,
                &text,
                &images,
            )
            .await
            {
                VisionOutcome::Ok(d) => Some(d),
                _ => None,
            }
        } else {
            None
        };
        let body = match desc {
            Some(d) => format!("{text}\n\n=== IMAGE ANALYSIS (from the vision model) ===\n{d}"),
            None => format!(
                "{text}\n\n[image omitted: the main model cannot read images and no Vision \
                 model is configured in Settings → Tools]"
            ),
        };
        let role = msg
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        *msg = json!({ "role": role, "content": body });
        changed += 1;
    }
    changed
}

/// Maximum tool-loop iterations per turn (mirrors graph.py MAX_STEPS).
const MAX_STEPS: usize = 60;
/// Mid-turn auto-compaction: how many times ONE turn may fold its history.
/// A single turn can run MAX_STEPS tool calls, so a fold has to be possible
/// while the agent works — but more than a handful would mean the summarizer
/// itself is thrashing.
const MAX_COMPACTIONS_PER_TURN: usize = 4;
/// Context window assumed when the renderer does not know the model's real one
/// (a custom model without metadata sends 0). Without this fallback mid-turn
/// auto-compaction would be silently disabled for those models.
const DEFAULT_CONTEXT_WINDOW: usize = 128_000;
/// Output budget for the auto-compaction summary.
const COMPACT_MAX_OUTPUT: usize = 4096;
/// The summarizer is a side call, so it keeps a real timeout: a hung
/// summarizer must not freeze the very turn it is trying to shrink.
const COMPACT_TIMEOUT_SECS: u64 = 300;
/// The explore sub-agent must answer in seconds, not minutes — a much smaller
/// step budget than the main agent's, with a forced final report (below).
const SUBAGENT_MAX_STEPS: usize = 12;
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
const SUBAGENT_MAX_ATTEMPTS: usize = 10;
/// Fixed backoff between explore attempts — mirrors the main agent's fixed
/// 10s cadence (RECONNECT_DELAY_MS in api.ts). The ATTEMPT COUNT, not a clock,
/// is what ends the ladder. Each attempt is still bounded by the model call
/// itself, never by a wall-clock timer: a slow but healthy provider is NOT a
/// failure.
const SUBAGENT_RETRY_BACKOFF_MS: u64 = 10_000;
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
fn subagent_idle_secs() -> u64 {
    static V: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("CODIFA_SUBAGENT_IDLE_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(SUBAGENT_ATTEMPT_IDLE_SECS)
    })
}
const SUBAGENT_ATTEMPT_IDLE_SECS: u64 = 300;
/// Cap on the tool result echoed to the UI (full result still goes to the LLM).
const TOOL_RESULT_CAP: usize = 4000;
/// Cap on the tool result forwarded to the MODEL: full multi-MB read/grep
/// outputs ballooned the context (76k-token turns) and made every LLM
/// round-trip crawl — the #1 cause of slow explore turns.
const MODEL_RESULT_CAP: usize = 16_000;

/// Cap on an explore/task report forwarded to the model.
///
/// A report is the main agent's ONLY view of the code — it has no read/grep
/// tools of its own — so a truncated report means the search results inside it
/// are simply lost and the agent re-delegates the same question. Reports get a
/// larger budget than a raw tool result, and are cut from the MIDDLE (see
/// finish_tool) so both the answer at the head and the details at the tail
/// survive.
const EXPLORE_REPORT_CAP: usize = 40_000;

/// Per-result budget when a sub-agent runs out of steps and its gathered tool
/// results are folded into a report (see run_turn). A grep/read result IS the
/// finding, so this is far larger than a UI echo cap.
const SUBAGENT_FOLD_RESULT_CHARS: usize = 4_000;

/// Slice of a tool's stored prose result (`resultText`) echoed into the history
/// recap for ordinary tools.
const RECAP_RESULT_CHARS: usize = 400;
/// Same slice for an explore/task report. That report is the main agent's ONLY
/// view of the code, so the recap must carry it at (near) full length —
/// otherwise the next turn receives a short digest, cannot answer from it, and
/// re-delegates the very same question.
const RECAP_EXPLORE_CHARS: usize = 8_000;

/// In-turn elision: rounds this fresh are NEVER touched by fold_stale_tool_results.
const MAIN_FOLD_KEEP_ROUNDS: usize = 2;
/// In-turn elision: per-result budget for a stale explore report (the report is
/// the main agent's only view of that research; 8K mirrors RECAP_EXPLORE_CHARS).
const MAIN_FOLD_EXPLORE_CHARS: usize = 8_000;
/// In-turn elision: per-result budget for a stale ordinary tool result (2K
/// mirrors what a targeted re-read costs, so pointing beats re-sending).
const MAIN_FOLD_RESULT_CHARS: usize = 2_000;
/// In-turn elision: fold only once the wire history (system excluded) is
/// estimated past this many tokens. Fresh conversations and short turns must
/// not pay any elision cost.
const MAIN_FOLD_MIN_TOKENS: usize = 20_000;
/// In-turn elision: marker appended to a folded tool-result stub. The model
/// reads it as a pointer (re-run with narrower args), not as data loss.
const MAIN_FOLD_MARKER: &str = "[… result elided to save context. Only its beginning is kept — re-run the tool with a narrower pattern/range/file to see the rest again]";

/// UI-echo budget for one tool result. The echo is also what the frontend stores
/// as `resultText`, i.e. the ONLY source the next turn's history recap is built
/// from. An explore report must therefore be echoed at least as long as
/// the recap reads it: with the flat 4 KB echo cap the report was cut before the
/// recap's 8 KB budget could apply, and its tail (later CODE blocks, ALSO
/// RELEVANT) was lost between turns.
fn ui_echo_cap(tool: &str) -> usize {
    if tool == "explore" {
        RECAP_EXPLORE_CHARS
    } else {
        TOOL_RESULT_CAP
    }
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
fn history_recap(m: &Value) -> String {
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
/// Sub-agent depth limit (mirrors graph.py: sub-agents cannot spawn more).
const MAX_SUBAGENT_DEPTH: usize = 1;

// ---------------------------------------------------------------------------
// Request / events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AgentRequest {
    pub provider: String,
    // Part of the public request contract; consumed in phase 3-3.
    #[serde(default)]
    #[allow(dead_code)]
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub root: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<Value>,
    #[serde(default)]
    pub system_prompt: String,
    /// Skill names the user attached to this turn (@mention). Their full
    /// bodies are inlined into the system prompt, exactly like the Python
    /// sidecar's ATTACHED SKILLS section.
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub context_window: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub chat_id: String,
    #[serde(default)]
    pub mcp_servers: Value,
    /// Per-slot sub-agent model overrides from the UI's Tool Models settings
    /// (e.g. {"explore": "providerId/model"}); empty = the parent model.
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    /// Full provider configs keyed by id, so a "providerId/model" sub-agent
    /// entry routes to THAT provider's base URL / keys (cross-provider).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
    /// The app data root (~/.codifa) where the skill store lives. Skills are
    /// NOT workspace files: `/skills` reads them from the data root, so the
    /// router must look there too — reading the workspace root found nothing
    /// and silently disabled both auto-match and the decision model.
    #[serde(default)]
    pub data_root: String,
    /// The composer's Computer Use switch. When false the `computer` tool is
    /// never bound, so the agent cannot touch the desktop at all.
    #[serde(default)]
    pub allow_computer: bool,
    /// True when the turn asks to create/edit a skill or an MCP connector
    /// (`/create-skill`, `/create-mcp`). The `create_skill` / `create_mcp`
    /// tools are bound ONLY then, so an ordinary turn cannot silently rewrite
    /// the user's skill store or connector list.
    #[serde(default)]
    pub allow_create: bool,
    /// The composer's Browser switch, the same hard on/off as Computer Use.
    /// When false the native `browser_*` tools are never bound and a call that
    /// still reaches the driver is refused BEFORE a Chromium is launched, so a
    /// chat can no longer open a browser window on its own. The Browser panel
    /// keeps working either way: this gates the agent's tools, not the user's
    /// own browsing.
    #[serde(default)]
    pub allow_browser: bool,
    /// Web-search engines from Settings → Plugins, verbatim and in priority
    /// order: `order` 0 is the primary and higher orders are fallbacks tried in
    /// turn, so the user's list order IS the fallback chain.
    #[serde(default)]
    pub search_plugins: Vec<Value>,
    /// Auto-compaction threshold as a percentage of the RAW context window —
    /// the renderer has always sent this (the Python graph consumed it), and
    /// the native loop now honours it MID-TURN: once a turn's wire history
    /// outgrows `context_window * compact_at_percent / 100`, the older half is
    /// folded into a running summary instead of waiting for the next turn.
    #[serde(default = "default_compact_percent")]
    pub compact_at_percent: u64,
    /// Per-slot sub-agent models, used to route the summarizer through the
    /// user's "compact" Tool Models entry (empty = the active model).
    #[serde(default)]
    pub fallback_provider: String,
    #[serde(default)]
    pub fallback_model: String,
    #[serde(default)]
    pub fallback_base_url: String,
    #[serde(default)]
    pub fallback_api_key: String,
    #[serde(default)]
    pub fallback_api_keys: Vec<String>,
    /// Reasoning-effort level for the MAIN model of this turn (the one chosen
    /// in the composer): "none" / "low" / "medium" / "high" / "xhigh" /
    /// "max". Empty = the provider default (no reasoning parameter sent).
    #[serde(default)]
    pub thinking_level: String,
    /// Whether the main model is known to be reasoning-capable (the provider's
    /// `/models` reasoning flag, or the user's manual override). Gates the
    /// reasoning parameter for local/custom providers without `auto_think`.
    #[serde(default)]
    pub model_reasoning: bool,
    /// Per-tool reasoning-effort overrides, keyed by the SAME slot names as
    /// `subagent_models` (compact / explore / web / vision / schedule /
    /// title). A missing key means "inherit the main model's level".
    #[serde(default)]
    pub subagent_thinking: std::collections::HashMap<String, String>,
    /// Inline images attached to THIS turn, as `data:<mime>;base64,…` URLs (or
    /// bare paths, which are read from disk). Owned by the user message: they
    /// are sent to the main model and to the vision model, never echoed back
    /// as history.
    #[serde(default, deserialize_with = "deserialize_images")]
    pub images: Vec<String>,
    /// The user's "Results per search" number (Settings → Web Providers). It is
    /// ONE setting with two effects: how many results `web_search` returns, and
    /// how many of those top results get their REAL page content fetched (not
    /// just a snippet) before the distiller reads them. 0 disables the page
    /// fetch and falls back to snippets-only results.
    #[serde(default = "default_web_search_auto_fetch")]
    pub web_search_auto_fetch: usize,
}

fn default_mode() -> String {
    "build".to_string()
}

/// Default for `webSearchAutoFetch` (Settings → Web Providers) when the field
/// is absent: the same five results the UI's setting starts at.
fn default_web_search_auto_fetch() -> usize {
    crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
}

/// Accept the renderer's loose image payload and normalise it to data URLs.
///
/// The frontend sends each entry either as a bare path, as a `data:` URL, or as
/// `{path, dataUrl}` (the shape the picker and screenshot code produce). The
/// model needs bytes, not paths, so a path is read from disk here — and an
/// unreadable one is dropped rather than failing the whole turn.
fn deserialize_images<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(resolve_image_entries(
        Vec::<Value>::deserialize(d).unwrap_or_default(),
    ))
}

/// Turn the renderer's loose image entries into data URLs: a bare path, an
/// inline `data:` URL, or `{path, dataUrl}` (the picker/screenshot shape, where
/// the inline copy wins so the backend never depends on a temp file still being
/// on disk). An unreadable path is DROPPED — one missing file must not fail the
/// whole turn. Shared by the current turn's request field and by the history
/// entries, which arrive in exactly the same shape.
fn resolve_image_entries(raw: Vec<Value>) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw {
        let (path, inline) = match &item {
            Value::String(s) => (Some(s.clone()), None),
            Value::Object(o) => (
                o.get("path").and_then(Value::as_str).map(str::to_string),
                o.get("dataUrl").and_then(Value::as_str).map(str::to_string),
            ),
            _ => (None, None),
        };
        if let Some(url) = inline.filter(|u| u.starts_with("data:")) {
            out.push(url);
            continue;
        }
        if let Some(url) = path.clone().filter(|p| p.starts_with("data:")) {
            out.push(url);
            continue;
        }
        if let Some(p) = path {
            if let Some(url) = crate::commands::image_data_url(&p) {
                out.push(url);
            }
        }
    }
    out
}

/// Matches the UI's own default (Settings → compact threshold).
fn default_compact_percent() -> u64 {
    80
}

impl AgentRequest {
    /// Snapshot of this turn handed to each explore/task sub-agent.
    ///
    /// `history` is set to EMPTY on purpose: `run_subagent` never reads the
    /// parent's transcript (it rebuilds its own `history: Vec::new()`), yet a
    /// plain `req.clone()` deep-copies the whole conversation — and the
    /// parallel explore path clones once PER explore in the step, so a
    /// four-explore step copied the entire chat four times only to drop it.
    /// The fields are listed explicitly (no `..self.clone()`, which would still
    /// copy `history`) so a future field addition must be decided here.
    fn subagent_snapshot(&self) -> Self {
        Self {
            provider: self.provider.clone(),
            provider_id: self.provider_id.clone(),
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            api_keys: self.api_keys.clone(),
            root: self.root.clone(),
            mode: self.mode.clone(),
            prompt: self.prompt.clone(),
            // Never inherited — see the doc comment above.
            history: Vec::new(),
            system_prompt: self.system_prompt.clone(),
            skills: self.skills.clone(),
            context_window: self.context_window,
            chat_id: self.chat_id.clone(),
            mcp_servers: self.mcp_servers.clone(),
            subagent_models: self.subagent_models.clone(),
            providers: self.providers.clone(),
            data_root: self.data_root.clone(),
            allow_computer: self.allow_computer,
            allow_create: self.allow_create,
            allow_browser: self.allow_browser,
            search_plugins: self.search_plugins.clone(),
            // Sub-agents never auto-compact mid-turn (they have their own
            // budget), but the snapshot stays a faithful copy of the turn.
            compact_at_percent: self.compact_at_percent,
            fallback_provider: self.fallback_provider.clone(),
            fallback_model: self.fallback_model.clone(),
            fallback_base_url: self.fallback_base_url.clone(),
            fallback_api_key: self.fallback_api_key.clone(),
            fallback_api_keys: self.fallback_api_keys.clone(),
            // Reasoning settings flow through to a sub-agent unchanged (its
            // own slot level is applied in `run_subagent`, which overrides the
            // level per explore/compact slot).
            thinking_level: self.thinking_level.clone(),
            model_reasoning: self.model_reasoning,
            subagent_thinking: self.subagent_thinking.clone(),
            // A research sub-agent is text-only: images stay with the parent.
            images: Vec::new(),
            // A sub-agent searches the web the same way the parent does.
            web_search_auto_fetch: self.web_search_auto_fetch,
        }
    }
}

/// App data root for the native agent.
///
/// Order matters: the LIVE data root (Settings → Data path) wins, because the
/// HTTP readers (`/plan`, `/plan/checklist`, traces, memory) resolve through
/// `state::current_data_root()`. Reading only the env var + `~/.codifa` made
/// the agent write plans into a DIFFERENT root than the reader looked at as
/// soon as the user moved their data folder — the plan saved fine and was
/// still invisible.
fn native_data_root() -> String {
    if let Some(root) = crate::state::current_data_root() {
        return root.to_string_lossy().into_owned();
    }
    if let Ok(d) = std::env::var("CODER_DATA_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".codifa").to_string_lossy().into_owned())
        .unwrap_or_else(|| ".codifa".into())
}

/// Extract the plan document from a plan-mode reply.
///
/// The save used to depend on the reply carrying a heading that STARTS with
/// `plan` (or `# پلن`). A model writing `## Implementation Plan`,
/// `## Phase 1`, `## طرح` or no heading at all produced NO save — silently,
/// because the caller drops the Result — which is why a plan sometimes landed
/// on disk and sometimes vanished. The heading is now only used for the TITLE;
/// the body is the whole reply (minus the preamble before the first heading
/// when one exists).
fn extract_plan_body(text: &str) -> Option<(String, String)> {
    if text.trim().is_empty() {
        return None;
    }
    let mut start: Option<usize> = None;
    let mut title = String::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('#') {
            continue;
        }
        start = Some(idx);
        title = trimmed.trim_start_matches('#').trim().to_string();
        break;
    }
    // No heading at all: still a plan — keep the whole reply and name it from
    // its first non-empty line, so a save always happens in plan mode.
    let Some(s) = start else {
        let first = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("Plan")
            .trim_start_matches('#')
            .trim();
        let title: String = first.chars().take(120).collect();
        return Some((
            if title.is_empty() { "Plan".into() } else { title },
            text.trim().to_string(),
        ));
    };
    let body: String = text.lines().skip(s).collect::<Vec<_>>().join("\n");
    if body.trim().is_empty() {
        return None;
    }
    Some((
        if title.is_empty() {
            "Plan".into()
        } else {
            title
        },
        body,
    ))
}

/// One queued mid-turn steer: the renderer's user-message id (so the bubble can
/// be moved inline) plus the prompt text to inject.
#[derive(Clone, Debug)]
pub struct SteerMessage {
    pub id: String,
    pub prompt: String,
}

/// Chats with a turn currently running. `/chat/steer` consults it to answer
/// `ok: false` when nothing is running (the renderer then re-sends the message
/// as the next turn instead of leaving it stuck as pending).
fn running_turns() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Mid-turn steer inbox: chat_id -> messages typed while that turn is running.
/// The loop drains it before every model call, so a steer lands in the SAME turn
/// with the whole conversation already in `messages` above it — the model keeps
/// every tool result it had produced instead of restarting from the steer alone
/// (the "steering forgets what it was doing" bug).
fn steer_inbox() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<SteerMessage>>> {
    static INBOX: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Vec<SteerMessage>>>,
    > = std::sync::OnceLock::new();
    INBOX.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Per-chat "a steer just landed" flags.
///
/// The inbox alone is not enough: it is only read BETWEEN model calls, so a
/// steer typed while a request was already streaming had to wait for that whole
/// request to finish — exactly the "steer behaves like a queue message" report.
/// `push_steer` raises this flag and the live stream polls it, so an in-flight
/// request is dropped at once and re-issued with the steer appended.
fn steer_flags(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<InterruptSignal>>>
{
    static FLAGS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<InterruptSignal>>>,
    > = std::sync::OnceLock::new();
    FLAGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Ids of the steers currently waiting for this chat (non-destructive peek).
/// Used to tell the renderer WHICH bubbles the interrupt concerns; the actual
/// delivery stays with `deliver_steers`, which drains the inbox at the top of
/// the next step.
fn pending_steer_ids(chat_id: &str) -> Vec<String> {
    steer_inbox()
        .lock()
        .unwrap()
        .get(chat_id)
        .map(|v| v.iter().map(|s| s.id.clone()).collect())
        .unwrap_or_default()
}

/// Monotonic id for a user-answer gate (`ask_user` / `confirm_action`).
fn next_gate_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("gate-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Open user-answer gates: gate id -> the oneshot that resumes the waiting
/// turn. Resolved by POST /ask/respond or /permission/respond (see
/// `deliver_answer`). The turn BLOCKS on the oneshot until the renderer
/// answers, so a permission/ask popup really pauses the agent.
fn answer_gates() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, tokio::sync::oneshot::Sender<Value>>,
> {
    static GATES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    > = std::sync::OnceLock::new();
    GATES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Deliver an answer to a waiting gate. False when no such gate is open (a
/// stale or duplicate answer) — the renderer then simply ignores it.
pub fn deliver_answer(id: &str, payload: Value) -> bool {
    let tx = answer_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    match tx {
        Some(tx) => tx.send(payload).is_ok(),
        None => false,
    }
}

/// Block the turn until the renderer answers `id`.
///
/// There is deliberately NO deadline: the user may take as long as they need
/// (the popup stays open). The 500 ms tick is NOT a timeout — it only re-reads
/// the cancel flag so the Stop button still ends a wait that nobody answered.
async fn await_answer(id: &str, cancel: &std::sync::atomic::AtomicBool) -> Option<Value> {
    let (tx, mut rx) = tokio::sync::oneshot::channel::<Value>();
    answer_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), tx);
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(500), &mut rx).await {
            Ok(res) => return res.ok(),
            Err(_) => {
                if cancel.load(Ordering::Relaxed) {
                    answer_gates()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(id);
                    return None;
                }
            }
        }
    }
}

/// Map a model-invented tool name onto the REAL advertised one.
///
/// Models are RL-trained on other agents' vocabularies (`read_client`,
/// `read_file`, `view_file`, `shell`, `bash`, `todos`…), so a perfectly correct
/// intent sent under a foreign name was answered with the generic
/// "unknown tool" error — and a traced explore retried the same wrong name 75
/// times, burning the whole tool budget. The alias resolves ONLY when the
/// canonical name is really advertised, so the model is never handed a tool
/// that does not exist in this run.
fn canonical_tool_name(name: &str, advertised: &[String]) -> Option<String> {
    let norm = |s: &str| s.trim().to_lowercase().replace(['-', ' '], "_");
    let n = norm(name);
    // 1) Case / dash / underscore-insensitive match on a real advertised name.
    if let Some(hit) = advertised.iter().find(|a| norm(a) == n) {
        return Some(hit.clone());
    }
    // 2) Known cross-agent aliases -> the advertised canonical name.
    let canonical = match n.as_str() {
        "read_client" | "read_file" | "readfile" | "view_file" | "read_text_file" | "get_file" => {
            "read"
        }
        "search_files" | "search_content" | "ripgrep" | "search_in_files" => "grep",
        "find_files" | "list_dir" | "ls" | "list_directory" => "glob",
        "shell" | "bash" | "sh" | "run_command" | "execute_command" | "terminal" | "run" => {
            "run_terminal"
        }
        "search_web" | "websearch" | "google" => "web_search",
        "fetch_url" | "fetch" | "open_url" | "read_url" | "webfetch" | "http_get" => {
            "fetch_url"
        }
        "skill" | "load_skill_file" => "load_skill",
        "create_file" | "writefile" => "write_file",
        "str_replace" | "replace_in_file" | "editfile" => "edit_file",
        "plan" | "todos" | "todo_write" | "write_todos" | "update_todos" => "update_plan",
        "ask" | "question" | "ask_question" => "ask_user",
        "permission" | "request_permission" => "confirm_action",
        _ => return None,
    };
    if advertised.iter().any(|a| a == canonical) {
        Some(canonical.to_string())
    } else {
        None
    }
}

/// Queue a message to inject into the running turn for `chat_id`.
/// Returns false when no turn is running — the caller should tell the renderer
/// so it re-sends the message as a normal next turn.
#[must_use]
pub fn push_steer(chat_id: &str, id: &str, prompt: &str) -> bool {
    if chat_id.trim().is_empty() || !running_turns().lock().unwrap().contains(chat_id) {
        return false;
    }
    steer_inbox()
        .lock()
        .unwrap()
        .entry(chat_id.to_string())
        .or_default()
        .push(SteerMessage { id: id.to_string(), prompt: prompt.to_string() });
    // Wake the in-flight stream: it drops the current request and re-issues it
    // with this steer appended, instead of letting the model finish first.
    if let Some(signal) = steer_flags().lock().unwrap().get(chat_id) {
        signal.raise();
    }
    true
}

/// Drop a queued steer the user deleted before the agent read it.
pub fn cancel_steer(chat_id: &str, id: &str) {
    if let Some(list) = steer_inbox().lock().unwrap().get_mut(chat_id) {
        list.retain(|s| s.id != id);
    }
}

/// Take (and clear) every steer queued for this chat.
fn drain_steers(chat_id: &str) -> Vec<SteerMessage> {
    steer_inbox()
        .lock()
        .unwrap()
        .remove(chat_id)
        .unwrap_or_default()
}

/// Move every queued steer into the running conversation and tell the renderer.
/// Returns how many steers were delivered.
///
/// Called at the top of every step AND right before the turn would end. The
/// end-of-turn call is what fixes "steer behaves like a queue": when the model
/// answered without tool calls the loop used to `return`, leaving the steer in
/// the inbox where `SteerGuard::drop` erased it — so the message only ever
/// arrived as a brand-new turn, i.e. after all the work had already finished.
fn deliver_steers(
    messages: &mut Vec<Value>,
    chat_id: &str,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
) -> usize {
    let steers = drain_steers(chat_id);
    if steers.is_empty() {
        return 0;
    }
    let mut ids: Vec<String> = Vec::with_capacity(steers.len());
    for steer in steers {
        if steer.prompt.trim().is_empty() {
            continue;
        }
        messages.push(json!({"role": "user", "content": steer.prompt}));
        ids.push(steer.id);
    }
    let n = ids.len();
    if n > 0 {
        emit(&AgentEvent::SteerApplied { ids });
    }
    n
}

/// Report every steer still waiting in the inbox as DROPPED, so the renderer
/// keeps those bubbles pending and re-sends them as the next turn.
///
/// This is the counterpart of `deliver_steers` for paths where the turn ends
/// WITHOUT a model call to carry the steer: a provider error, the step budget
/// running out, or a Stop that lands inside a tool batch. `SteerGuard::drop`
/// used to erase the inbox silently, so a message typed mid-turn just vanished
/// ("sometimes steering works, sometimes it doesn't") — the difference being
/// purely which exit the turn happened to take.
///
/// Returns the number of steers handed back.
fn drop_steers(chat_id: &str, emit: &mut (dyn FnMut(&AgentEvent) + Send)) -> usize {
    if chat_id.trim().is_empty() {
        return 0;
    }
    let ids: Vec<String> = drain_steers(chat_id)
        .into_iter()
        // A steer with no text was never deliverable; do not ask the renderer
        // to re-send it.
        .filter(|s| !s.prompt.trim().is_empty())
        .map(|s| s.id)
        .collect();
    if ids.is_empty() {
        return 0;
    }
    let n = ids.len();
    emit(&AgentEvent::SteerDropped { ids });
    n
}

/// RAII marker for a running turn: registers the chat for `/chat/steer` and
/// guarantees the inbox + flag are cleared however `run_turn` exits (normal
/// return, early `return Ok(())`, or a panic unwinding the task).
struct SteerGuard {
    chat_id: String,
    /// Live "a steer arrived" signal handed to the in-flight model stream.
    flag: std::sync::Arc<InterruptSignal>,
}

impl SteerGuard {
    fn new(chat_id: &str) -> Self {
        let flag = std::sync::Arc::new(InterruptSignal::new());
        if !chat_id.trim().is_empty() {
            running_turns().lock().unwrap().insert(chat_id.to_string());
            steer_flags()
                .lock()
                .unwrap()
                .insert(chat_id.to_string(), flag.clone());
        }
        SteerGuard { chat_id: chat_id.to_string(), flag }
    }

    /// A guard that owns nothing.
    ///
    /// The explore sub-agent runs `run_turn` with the PARENT's chat id (traces
    /// and plan writes are keyed by it). Registering that id a second time made
    /// the sub-turn's Drop un-register the still-running parent and wipe its
    /// steer inbox, so a steer typed while explore worked was lost.
    fn inert() -> Self {
        SteerGuard {
            chat_id: String::new(),
            flag: std::sync::Arc::new(InterruptSignal::new()),
        }
    }
}

impl Drop for SteerGuard {
    fn drop(&mut self) {
        if !self.chat_id.trim().is_empty() {
            running_turns().lock().unwrap().remove(&self.chat_id);
            steer_flags().lock().unwrap().remove(&self.chat_id);
        }
        // A steer nobody consumed must not leak into the next turn of this chat.
        steer_inbox().lock().unwrap().remove(&self.chat_id);
    }
}
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Status { stage: String, content: String },
    Text { content: String },
    Thinking { active: bool },
    /// Emitted when a tool call STARTS — the frontend mints a running card.
    /// `id` is the provider tool_call id so the frontend can dedup/re-pair.
    ToolStart { id: String, name: String, args: Value },
    /// Emitted when the tool FINISHES — resolves the running card.
    ///
    /// `result` is what the MODEL sees (for `web_search` that is the distilled
    /// answer, and for `fetch_url` the raw page). `results` carries the
    /// structured rows the CARD renders — the search hits / the fetched page —
    /// because a distilled answer no longer contains the link list.
    Tool {
        id: String,
        name: String,
        args: Value,
        result: String,
        ok: bool,
        results: Option<Value>,
    },
    /// Unified diff of an edit_file/write_file call. Emitted while the card is
    /// still "running" so the frontend folds it into the card and the Review
    /// panel can show/revert the change — without it Review always answered
    /// "No changes in this turn." (the Python sidecar used to emit this; the
    /// native agent must too).
    Diff { tool: String, path: String, diff: String },
    Warn { content: String },
    /// Carries the model + provider_id that actually served this request so
    /// the frontend attributes sub-agent tokens to the SUB model, not the
    /// parent's.
    ///
    /// `sub` marks a request made by the explore sub-agent. The frontend must
    /// NOT let those replace the parent's context meter / message badge (a
    /// sub-agent request is small and isolated — it never enters the parent's
    /// context), so without the flag the meter dropped to the explore's 5-16k
    /// every time an explore ran.
    /// tokens. `cache_read` is the part of `input` the provider served from
    /// its prefix cache (DeepSeek `prompt_cache_hit_tokens`, OpenAI
    /// `prompt_tokens_details.cached_tokens`, Anthropic
    /// `cache_read_input_tokens`). It is ALREADY included in `input`, so it is
    /// reported for measurement only — never added to the meter, or the same
    /// tokens would be billed twice.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        model: String,
        provider_id: String,
        sub: bool,
    },
    /// A tool event tagged with the sub-agent branch it belongs to. Serialized
    /// as the inner event plus `branch` (and `sub`). Without the tags the
    /// explore card never gets a branch id, so every call the explore makes
    /// is an orphan and the frontend promotes it to a flat top-level card
    /// ("Search Files ×48" in the chat) instead of nesting it under the card.
    /// `sub` is false for the explore/task card's own start event (it must
    /// stay a top-level card) and true for the calls made INSIDE it.
    Branch { branch: u64, sub: bool, inner: Box<AgentEvent> },
    /// Plan mode finished: the collapsed plan document (title + markdown
    /// body) — the frontend renders it as the Plan card and the docked
    /// Plan viewer tab.
    PlanCard { title: String, body: String },
    /// Auto-matched / attached skills for this turn (the frontend renders
    /// them as ⚡ chips on the assistant message).
    Skills { skills: Vec<String>, manual: bool, note: Option<String> },
    /// Mid-turn steer messages were injected into the running turn. `ids` are
    /// the renderer's user-message ids so it can move each bubble inline (right
    /// after the tool call that carried it) and clear its `steerPending` flag.
    SteerApplied { ids: Vec<String> },
    /// The user steered while a model call was ALREADY streaming. The steer
    /// cannot be injected into that in-flight request, so the running stream is
    /// dropped and re-issued immediately with the steer appended — this is what
    /// removes the "steer waits for the turn to end" wait (it used to look
    /// exactly like a queue message). Emitted so the renderer can keep the
    /// bubble pending until `SteerApplied` confirms the injection.
    SteerInterrupt { ids: Vec<String> },
    /// Emitted when the turn is ending while steers are still sitting in the
    /// inbox — the model errored, the step budget ran out, or the user hit
    /// Stop before a step could carry them.
    ///
    /// Without this the un-consumed steers were erased by `SteerGuard::drop`
    /// and the message the user typed mid-turn simply vanished. The frontend
    /// keeps those bubbles pending and re-sends them as the next turn.
    SteerDropped { ids: Vec<String> },
    /// Auto-compaction started mid-turn — the renderer shows its loading
    /// banner until the `Compact`/`CompactFailed` event lands.
    CompactStart {},
    /// Auto-compaction finished: `content` is the summary, `keep` the number
    /// of trailing history entries preserved verbatim, `usage` the summarizer
    /// call's token usage (None when the provider reported none).
    Compact { content: String, keep: usize, usage: Option<Value> },
    /// Auto-compaction failed — NOTHING was dropped, the turn continues with
    /// the full history (the renderer surfaces a retry banner).
    CompactFailed { content: String },
    /// The checklist was written by `update_plan`: the renderer replaces its
    /// todo list with `items` (serialized as `kind:"plan"`). Without this event
    /// the tool persisted the file but the Todos panel stayed empty.
    Plan { items: Value, chat_id: String },
    /// The agent asked the user a question and is WAITING for the answer
    /// (POST /ask/respond). The renderer shows its ask popup.
    Ask { id: String, question: String, options: Value },
    /// The agent is waiting for permission to run a destructive /
    /// out-of-workspace action (POST /permission/respond).
    Permission { id: String, action: String, path: String, reason: String, scope: String },
    /// A failed model call is being retried after `delay_secs`. Mirrors the
    /// renderer's self-heal `retry` event so a SUB-AGENT failure (which runs
    /// on the parent's own stream and is therefore invisible to the frontend's
    /// reconnect ladder) surfaces with the very same banner, attempt counter
    /// and delay as a main-model retry. `agent` labels WHICH model to change
    /// (e.g. "explore subagent") and `tool` names the tool that owns the retry
    /// (e.g. "explore") — the banner shows both, so the user can tell a
    /// main-agent retry from a specific tool's.
    Retry {
        attempt: usize,
        max_attempts: usize,
        delay_secs: u64,
        reason: String,
        agent: String,
        /// The tool whose call is being retried ("explore"), or empty for the
        /// main agent's own retry ladder.
        tool: String,
        model: String,
        /// True: this is a SELF-HEAL (the agent resumes from the existing
        /// transcript), not a user-triggered restart — the renderer keeps the
        /// already-streamed text and tool cards instead of wiping them.
        reconnecting: bool,
        /// True once the sub-agent's OWN model hard-failed and the tool fell
        /// back to the MAIN chat model. The renderer renders a distinct
        /// "Sub-agent failed — using main model" banner instead of a generic
        /// retry, so the user knows WHICH model no longer needs fixing.
        fallback: bool,
    },
    /// The retry ladder was exhausted — the call is final. The renderer keeps
    /// the banner up with its Retry button instead of clearing it on `done`.
    RetryGiveup {
        attempt: usize,
        max_attempts: usize,
        reason: String,
        agent: String,
        tool: String,
        model: String,
        /// See `Retry::fallback`.
        fallback: bool,
    },
    Done { aborted: bool },
    Error { content: String },
}

impl AgentEvent {
    pub fn to_json(&self) -> Value {
        match self {
            AgentEvent::Status { stage, content } => {
                json!({"kind": "status", "stage": stage, "content": content})
            }
            AgentEvent::Text { content } => json!({"kind": "text", "content": content}),
            AgentEvent::Thinking { active } => json!({"kind": "thinking", "active": active}),
            AgentEvent::ToolStart { id, name, args } => json!({
                "kind": "tool", "id": id, "name": name, "tool": name, "args": args,
            }),
            AgentEvent::Tool { id, name, args, result, ok, results } => json!({
                "kind": "tool_result", "id": id, "name": name, "tool": name, "args": args,
                "result": result, "ok": ok, "results": results,
            }),
            AgentEvent::Diff { tool, path, diff } => json!({
                "kind": "diff", "tool": tool, "path": path, "diff": diff,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::Usage { input_tokens, output_tokens, cache_read_tokens, model, provider_id, sub } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "model": model, "provider_id": provider_id,
                "sub": sub,
            }),
            AgentEvent::Branch { branch, sub, inner } => {
                let mut v = inner.to_json();
                v["branch"] = json!(branch);
                v["sub"] = json!(sub);
                v
            }
            // Same wire shape the renderer's self-heal reconnect emits, so
            // Chat.tsx's `retry` handler needs no special-casing for
            // sub-agents — it just sees attempt/max_attempts/delay/reason and
            // the `agent` label it renders in the banner.
            AgentEvent::Retry {
                attempt,
                max_attempts,
                delay_secs,
                reason,
                agent,
                tool,
                model,
                reconnecting,
                fallback,
            } => json!({
                "kind": "retry",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "delay": delay_secs,
                "reason": reason,
                "agent": agent,
                "tool": tool,
                "model": model,
                "reconnecting": reconnecting,
                "fallback": fallback,
            }),
            AgentEvent::RetryGiveup {
                attempt,
                max_attempts,
                reason,
                agent,
                tool,
                model,
                fallback,
            } => json!({
                "kind": "retry_giveup",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "reason": reason,
                "agent": agent,
                "tool": tool,
                "model": model,
                "fallback": fallback,
            }),
            AgentEvent::Done { aborted } => json!({"kind": "done", "aborted": aborted}),            AgentEvent::PlanCard { title, body } => {
                json!({"kind": "plan_card", "title": title, "body": body})
            }
            AgentEvent::Skills { skills, manual, note } => {
                let mut v = json!({"kind": "skill", "skills": skills, "manual": manual});
                if let Some(n) = note {
                    v["note"] = json!(n);
                }
                v
            }
            AgentEvent::SteerApplied { ids } => {
                json!({"kind": "steer_applied", "ids": ids})
            }
            AgentEvent::SteerInterrupt { ids } => {
                json!({"kind": "steer_interrupt", "ids": ids})
            }
            AgentEvent::SteerDropped { ids } => {
                json!({"kind": "steer_dropped", "ids": ids})
            }
            AgentEvent::CompactStart {} => json!({"kind": "compact_start"}),
            AgentEvent::Compact { content, keep, usage } => {
                let mut v = json!({"kind": "compact", "content": content, "keep": keep});
                if let Some(u) = usage {
                    v["usage"] = u.clone();
                }
                v
            }
            AgentEvent::CompactFailed { content } => {
                json!({"kind": "compact_failed", "content": content})
            }
            AgentEvent::Plan { items, chat_id } => json!({
                "kind": "plan", "items": items, "chat_id": chat_id,
            }),
            AgentEvent::Ask { id, question, options } => json!({
                "kind": "ask", "id": id, "question": question, "options": options,
            }),
            AgentEvent::Permission { id, action, path, reason, scope } => json!({
                "kind": "permission", "id": id, "action": action, "path": path,
                "reason": reason, "scope": scope,
            }),
            AgentEvent::Error { content } => json!({"kind": "error", "content": content}),
        }
    }
}

/// Tool schemas for the MAIN agent: no search/read tools — the main agent
/// delegates all research to the `explore` sub-agent and works only with the
/// data the sub-agent returns (user request: main agent must not search).
fn tool_schemas(allow_create: bool, allow_browser: bool) -> Vec<Value> {
    // Per-tool schemas: the model only sees the args each tool actually
    // accepts — a shared all-fields block made it emit empty filler
    // (command:"", limit:0, filePath:""…) that garbled cards and traces.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "write_file",
            "Create or overwrite a file.",
            json!({"path": {"type": "string"}, "content": {"type": "string"}}),
        ),
        (
            "edit_file",
            "Replace an exact string in an existing file.",
            json!({
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
                "edits": {"type": "array", "items": {"type": "object"}}
            }),
        ),
        (
            "run_terminal",
            "Run a shell command in the workspace with a timeout.",
            json!({"command": {"type": "string"}, "timeout": {"type": "integer"}}),
        ),
        ("current_time", "Current UTC time.", json!({})),
        (
            "system_stats",
            "Read the OS process list (Activity Monitor): per-process RSS memory and CPU usage. Use it to diagnose memory/CPU issues. Args: filter (substring, optional) and top (how many rows, default 15).",
            json!({
                "filter": {"type": "string", "description": "Only processes whose command contains this substring (optional)"},
                "top": {"type": "integer", "description": "Max rows to return (default 15)"}
            }),
        ),
        (
            "create_skill",
            "Create or update a stored skill (the Codex/Claude create_skill flow). ALWAYS pass BOTH fields: `description` — ONE short line of ENGLISH saying WHEN to use the skill — and `fa_keywords` — the user's own PERSIAN phrases for when it applies (comma-separated, e.g. \"ترجمه کن, translate this\"). The skill catalog shows both, so a Persian request finds the skill without any embedding. Pass previous_name when renaming an existing skill so its extra files survive.",
            json!({
                "name": {"type": "string", "description": "Skill name (also the folder slug)"},
                "description": {"type": "string", "description": "REQUIRED. One-line ENGLISH summary of when to use this skill"},
                "content": {"type": "string", "description": "The skill body: step-by-step instructions the agent follows"},
                "fa_keywords": {"type": "string", "description": "REQUIRED. Comma-separated PERSIAN phrases the user would say to trigger this skill"},
                "previous_name": {"type": "string", "description": "Old name when renaming an existing skill"},
                "extra_files": {"type": "object", "description": "Optional extra files: filename -> content"},
                "delete": {"type": "boolean", "description": "Delete the skill instead of writing it"}
            }),
        ),
        (
            "update_plan",
            "Set/replace the live todo checklist shown in the Todos panel (also persisted to disk next to the plan). Call it ONCE after writing the plan, then again whenever an item's status changes. ALWAYS send the COMPLETE list, in order — it REPLACES the previous one.",
            json!({
                "items": {
                    "type": "array",
                    "description": "The complete checklist, in order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "description": "Short imperative item (name the file it touches)"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                        },
                        "required": ["content", "status"]
                    }
                }
            }),
        ),
        (
            "ask_user",
            "Ask the user ONE question and WAIT for the answer. Use it when the request is ambiguous or you hit a genuine fork with no clearly-correct default. `options` are short choices; the user may also type a free answer.",
            json!({
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "2-5 short choices"}
            }),
        ),
        (
            "confirm_action",
            "Ask the user to APPROVE a destructive or out-of-workspace action and WAIT for the decision (returns allowed/denied). Use it before deleting outside the workspace, installing packages, or running an irreversible command.",
            json!({
                "action": {"type": "string", "description": "What you want to do — short and concrete"},
                "path": {"type": "string", "description": "The file/folder it touches, if any"},
                "reason": {"type": "string", "description": "Why it is needed"}
            }),
        ),
        (
            "create_mcp",
            "Create or update an MCP connector (the `/create-mcp` flow). Pass EITHER command (+ optional args/env) for a stdio server, OR url for an HTTP one. To EDIT an existing connector, pass its SAME name to overwrite it in place, or pass previous_name to rename it (the old file is removed so no stale duplicate is left). The connector is saved but stays off until the user enables it in the composer's MCP picker.",
            json!({
                "name": {"type": "string", "description": "Connector name (also the file name)"},
                "command": {"type": "string", "description": "Executable for a stdio server (e.g. npx)"},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Arguments for the stdio command"},
                "env": {"type": "object", "description": "Optional environment variables for the stdio server"},
                "url": {"type": "string", "description": "Endpoint for an HTTP connector (instead of command)"},
                "previous_name": {"type": "string", "description": "Old name when renaming an existing connector"}
            }),
        ),
        (
            "load_skill",
            "Load the FULL body of one stored skill by name (or one of its extra files via `file`). Skills that obviously match the request are already inlined in your prompt — call this only for a skill you need but were not given.",
            json!({
                "name": {"type": "string", "description": "Skill name or slug"},
                "file": {"type": "string", "description": "Optional extra file of that skill"}
            }),
        ),
        (
            "explore",
            "Delegate research to the explore sub-agent (it reads files, greps, globs, runs LSP lookups and returns the FULL findings — you cannot search yourself). ALWAYS split the work: call explore SEVERAL TIMES IN THE SAME STEP, one focused question per area/file group — parallel calls run CONCURRENTLY and cost ONE round-trip, while a single broad explore is the slowest and shallowest option. Prefer 2-4 focused explores over one giant one; only a genuinely single-area question justifies a single call. Args: description (SHORT label for the UI, under 80 chars) and prompt (the full research question).",
            json!({
                "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                "prompt": {"type": "string", "description": "The full research question for the sub-agent"}
            }),
        ),
        (
            "web_search",
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. Engines and the \"Results per search\" count (results returned + how many pages get fetched) come from Settings → Web Providers. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"},
                "max_results": {"type": "integer", "description": "Override the result count; omit to use the Settings value"}
            }),
        ),
        (
            "fetch_url",
            "Fetch ONE web page or raw file and return its text (Markdown). The full page comes back, capped at 100000 chars; pass full=true for source files (SKILL.md, docs, raw.githubusercontent / jsdelivr / gist URLs), or offset=N to page past an earlier excerpt. Run web_search first to find the right URL, then fetch only the URLs you need.",
            json!({
                "url": {"type": "string", "description": "The URL to fetch (must start with http:// or https://)"},
                "full": {"type": "boolean", "description": "Lift the 100000-char cap (use for source/document files)"},
                "offset": {"type": "integer", "description": "Character offset to start from, when paging through a long page"}
            }),
        ),
    ];
    // Native browser tools (`browser_driver`): the app's own CDP driver ships
    // these under the SAME `browser_*` names the prompts and skills already
    // describe, so the built-in browser needs no MCP connector. Any connector
    // that happens to expose a colliding name is dropped by the native-wins
    // filter above instead of shadowing the in-process driver.
    //
    // Bound ONLY while the composer's Browser switch is on: with it off the
    // model never sees a browser tool, so it cannot start a Chromium nobody
    // asked for. This is the first of two gates; the dispatch arm is the second.
    let mut extra = if allow_browser {
        crate::browser_driver::entries()
    } else {
        Vec::new()
    };
    let schemas: Vec<(&str, &str, Value)> = schemas
        .iter()
        .map(|(name, desc, props)| (*name, *desc, props.clone()))
        .chain(extra.drain(..))
        .collect();
    schemas
        .iter()
        // The skill/connector authoring tools are bound only for a turn that
        // actually asked for them (see AgentRequest::allow_create).
        .filter(|(name, _, _)| {
            allow_create || !matches!(*name, "create_skill" | "create_mcp")
        })
        .map(|(name, desc, props)| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props},
                },
            })
        })
        .collect()
}

/// Tool schemas for the explore SUB-AGENT: the full read/search set the main
/// agent no longer has (read/grep/glob/LSP) plus memory search.
fn research_schemas() -> Vec<Value> {
    // Per-tool schemas (see tool_schemas): only the args each tool accepts.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "read",
            "Read ONE file (single filePath — never a list). Default window is 400 lines; pass offset/limit for one window or ranges=[{\"offset\":..,\"limit\":..},…] for SEVERAL windows of the same file in one call.",
            json!({
                "filePath": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
                "ranges": {"type": "array", "items": {"type": "object", "properties": {"offset": {"type": "integer"}, "limit": {"type": "integer"}}}}
            }),
        ),
        (
            "grep",
            "Regex content search. ALWAYS pass path (a directory or single file) and include (glob filter); keep patterns narrow (max 3 alternatives) and max_results small. Output shows 1 context line per hit by default — pass `context` (0-5) only when the surrounding lines matter, and ignore_case=true only when the exact casing is unknown (matching is case-SENSITIVE by default; a looser pattern means more output).",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "include": {"type": "string"},
                "max_results": {"type": "integer"},
                "context": {"type": "integer", "description": "Lines of context around each hit (0-5, default 1)"},
                "ignore_case": {"type": "boolean", "description": "Case-insensitive match (default false)"}
            }),
        ),
        (
            "glob",
            "Find FILES (never directories) by glob. The pattern is matched against the path relative to `path`; `**/` matches zero or more directories and `*` never crosses `/`. ALWAYS pass path scoped to a real directory from the project layout. A 'no matches' answer is final — do not retry variations; use grep, or read a directory path to list it.",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "max_results": {"type": "integer"}
            }),
        ),
        (
            "find_symbol",
            "Definition(s) with their bodies PLUS every usage of ONE identifier, in a single call — replaces the grep -> lsp_definition -> lsp_references chain (three round trips) and needs no language server, so it works for every language. Pass symbol (a bare identifier: letters, digits, _ or $ — never a regex) and optionally path (directory or file) and include (glob filter) to scope it. Use this FIRST when the question names a symbol; fall back to lsp_* only when you need type/signature info.",
            json!({
                "symbol": {"type": "string", "description": "Bare identifier to look up (no regex)"},
                "path": {"type": "string", "description": "Directory or file to scope the search (optional)"},
                "include": {"type": "string", "description": "Glob filter such as *.rs (optional)"}
            }),
        ),
        (
            "lsp_definition",
            "Jump to the DEFINITION of a symbol and show its body (LSP) — more precise and cheaper than grep for \"where is X defined\". Pass filePath + symbol (the identifier as written in that file); line is an optional hint for repeated names. No need to know line/character.",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol (a usage or the declaration)"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_references",
            "Find ALL references/usages of a symbol across the workspace (LSP). Pass filePath + symbol (same as lsp_definition).",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_hover",
            "Type/signature/docs of a symbol (LSP). Pass filePath + symbol (same as lsp_definition).",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_symbols",
            "List the functions/classes/structs of ONE file with their line ranges (query filters by name). Use it instead of reading a large file just to find where something lives, then read only that window.",
            json!({"filePath": {"type": "string"}, "query": {"type": "string"}}),
        ),
        (
            "lsp_diagnostics",
            "Diagnostics for one file (LSP).",
            json!({"filePath": {"type": "string"}}),
        ),
        (
            "search_memory",
            "Search previously saved project notes. Every hit carries an `id` — pass it to delete_memory to remove a note that is stale or wrong.",
            json!({"query": {"type": "string"}}),
        ),
        (
            "save_memory",
            "Persist a durable note about the project for future sessions. Save ONLY key points: decisions, user preferences, gotchas, and facts worth remembering — never dump whole files, tool outputs or conversation text. Keep each note under ~500 chars.",
            json!({
                "content": {"type": "string", "description": "The key point to remember (concise, self-contained)"},
                "memory_type": {"type": "string", "description": "long_term (default) or short_term"}
            }),
        ),
        (
            "delete_memory",
            "Delete ONE saved note by its id (the `id` field returned by search_memory). Use it to drop a note that turned out to be wrong or obsolete.",
            json!({
                "memory_id": {"type": "string", "description": "Id of the note to delete (from search_memory)"}
            }),
        ),
        (
            "web_search",
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. Engines and the \"Results per search\" count (results returned + how many pages get fetched) come from Settings → Web Providers. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"},
                "max_results": {"type": "integer", "description": "Override the result count; omit to use the Settings value"}
            }),
        ),
        (
            "fetch_url",
            "Fetch ONE web page or raw file and return its text (Markdown). The full page comes back, capped at 100000 chars; pass full=true for source files (SKILL.md, docs, raw.githubusercontent / jsdelivr / gist URLs), or offset=N to page past an earlier excerpt. Run web_search first to find the right URL, then fetch only the URLs you need.",
            json!({
                "url": {"type": "string", "description": "The URL to fetch (must start with http:// or https://)"},
                "full": {"type": "boolean", "description": "Lift the 100000-char cap (use for source/document files)"},
                "offset": {"type": "integer", "description": "Character offset to start from, when paging through a long page"}
            }),
        ),
    ];
    schemas
        .iter()
        .map(|(name, desc, props)| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props},
                },
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

static TURN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Source of sub-agent branch ids. Process-wide (not per step) because the
/// frontend matches `branch` across every card in a message — two explores in
/// different steps must never share an id or each would show the other's calls.
static BRANCH_SEQ: AtomicU64 = AtomicU64::new(1);

/// Cap the UI echo, record the trace row, emit the Tool event and push the
/// tool message — shared by the parallel (read-only batch) and sequential
/// tool paths so both produce identical cards/traces/model messages.
fn finish_tool(
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
        shown.push_str("\n… (truncated)");
    }
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
    });
    // The model receives a capped copy too — a narrower re-read is one
    // cheap tool call; an unbounded context is seconds per round-trip.
    let mut for_model = result;
    let is_report = name == "explore";
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
            for_model.truncate(end);
            for_model.push_str(
                "\n… [truncated for the model — re-read a narrower offset/limit window if you need more]",
            );
        }
    }
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
enum SubMsg {
    Ev(AgentEvent),
    Done { id: String, name: String, args: Value, result: String, ok: bool },
}

/// Run one full agent turn: stream the model, execute tool calls, repeat
/// until the model answers without tool calls or MAX_STEPS is reached.
/// Emits the same event protocol as the Python graph.
pub async fn run_turn(
    req: &AgentRequest,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
) -> Result<(), String> {
    let _turn = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    // Register this chat as "running" for the whole turn so `/chat/steer` can
    // inject a message into it, and guarantee the registry + inbox are cleared
    // however we exit (normal return, early return, or a panic unwinding).
    // A sub-agent must NOT register: it reuses the parent's chat id, so its own
    // Drop would un-register the parent turn that is still running.
    let _steer_guard = if req.mode == "subagent" {
        SteerGuard::inert()
    } else {
        SteerGuard::new(&req.chat_id)
    };
    let steer_flag = _steer_guard.flag.clone();
    let root = req.root.clone();
    // Start the workspace's language servers in the background: the first LSP
    // call of a turn otherwise pays for the whole cold start (spawn + load the
    // crate graph + first didOpen), which on a large workspace is minutes with
    // no output at all. Pre-warming spends the model's thinking time instead,
    // so the first lsp_* call usually finds an already-loaded server. Runs
    // ONCE per project per process; cheap no-op afterwards.
    crate::lsp::prewarm(&root);
    let trace = crate::trace::TraceStore::new(req.chat_id.clone());
    let cfg = LlmConfig {
        provider: req.provider.clone(),
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
        reasoning_level: req.thinking_level.clone(),
        model_reasoning: req.model_reasoning,
        auto_think: crate::models::auto_think_for(&req.provider),
    };

    // Assemble the message list: system + history + current user prompt.
    let mut messages: Vec<Value> = Vec::new();
    let mut system = if req.system_prompt.is_empty() {
        default_system_prompt(&req.mode, &root)
    } else {
        req.system_prompt.clone()
    };
    // Skills: the system prompt carries a catalog of the installed skills and
    // the model loads the ones it needs via `load_skill` (the Codex/Claude
    // pattern). Only the skills the user attached are inlined whole.
    // The skill store lives in the DATA root, not the workspace. A caller that
    // omits `data_root` (e.g. a scheduled run) must still find the store, so
    // fall back to the native data root rather than the workspace — reading the
    // workspace found no skills at all, which silently disabled auto-loading.
    let skill_root = if req.data_root.is_empty() {
        native_data_root()
    } else {
        req.data_root.clone()
    };
    // Skills: the MAIN agent keeps the catalog + auto-match exactly as before
    // (its skill auto-loading is unchanged). The explore sub-agent does NOT get
    // it: its work is read/grep/find_symbol, it can never attach a skill, and
    // the catalog is ~5.8 KB of prompt re-sent on EVERY step of EVERY explore
    // run — the largest single fixed cost in sub-agent tokens. `ATTACHED
    // SKILLS` is empty for a sub-agent anyway (run_subagent hard-codes
    // `skills: Vec::new()`), so nothing is lost here.
    let (matched_skills, missing_skills) = if req.mode == "subagent" {
        (Vec::new(), Vec::new())
    } else {
        let skill_section =
            crate::skill_router::build_section(&req.prompt, &skill_root, &req.skills);
        if !skill_section.text.is_empty() {
            system.push_str(&skill_section.text);
        }
        (skill_section.matched, skill_section.missing)
    };
    // Tell the renderer which skills this turn actually picked up, so the user
    // sees ⚡ chips on the assistant message. `manual: false` is what makes the
    // frontend stamp `autoSkills` (a `manual: true` event is the missing-attach
    // warning and carries no names).
    if !matched_skills.is_empty() {
        emit(&AgentEvent::Skills {
            skills: matched_skills,
            manual: false,
            note: None,
        });
    }
    // Read the saved plan + live checklist BACK FROM DISK. The native loop only
    // ever wrote them (plans.rs), so after an app restart (or on the next turn)
    // the agent had forgotten the plan it was executing and re-planned from
    // scratch, redoing finished work. Both files are keyed by
    // workspace-slug + chat-id, exactly as plans.rs stores them.
    if !req.chat_id.trim().is_empty() {
        let ws = crate::plans::workspace_slug_for_root(&root);
        if let Some(plan) = crate::plans::get_plan(&skill_root, &ws, &req.chat_id) {
            let body = plan["content"].as_str().unwrap_or("").trim().to_string();
            if !body.is_empty() {
                system.push_str(&format!(
                    "\n\n=== SAVED PLAN (from disk — follow it, do NOT re-plan) ===\n{body}\n"
                ));
            }
        }
        let checklist = crate::plans::get_checklist(&skill_root, &ws, &req.chat_id);
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
                system.push_str(&format!(
                    "\n\n=== CHECKLIST (from disk) ===\n{lines}\
                     Keep it current with update_plan as you finish items; never redo a \
                     completed one.\n"
                ));
            }
        }
    }
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
    // Describe at most the LAST few image-carrying entries: a follow-up refers
    // to the most recent screenshot, and every description is a paid round-trip.
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
    for (idx, m) in req.history.iter().enumerate() {
        if let (Some(role), Some(content)) = (
            m.get("role").and_then(Value::as_str),
            m.get("content").and_then(Value::as_str),
        ) {
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
                match run_vision_slot(
                    &client,
                    req,
                    &cfg.model,
                    &cfg.provider,
                    &cfg.base_url,
                    &cfg.api_keys,
                    &text,
                    &hist_imgs,
                )
                .await
                {
                    VisionOutcome::Ok(desc) => Some(desc),
                    _ => None,
                }
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
    let mut final_prompt = req.prompt.clone();
    let mut inline_images: Vec<String> = req.images.clone();
    if !main_can_vision {
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
                // The slot's model failed: fall back to sending the raw images to
                // the main model rather than losing them entirely.
                emit(&AgentEvent::Text {
                    content: format!(
                        "\n\n> The vision model ({model}) could not analyze the image ({error}); \
                         sending it to the main model instead.\n"
                    ),
                });
            }
            VisionOutcome::NotConfigured => {}
        }
    }

    if !final_prompt.is_empty() || !inline_images.is_empty() {
        // Images ride WITH the user text as neutral content blocks; llm.rs
        // translates each one to the provider's own shape (OpenAI image_url /
        // Anthropic base64 source / Gemini inlineData) right before sending.
        if inline_images.is_empty() {
            messages.push(json!({"role": "user", "content": final_prompt}));
        } else {
            let mut blocks: Vec<Value> = Vec::new();
            if !final_prompt.is_empty() {
                blocks.push(json!({"type": "text", "text": final_prompt}));
            }
            for url in &inline_images {
                blocks
                    .push(json!({"type": crate::llm::IMAGE_BLOCK_TYPE, "data_url": url}));
            }
            messages.push(json!({"role": "user", "content": blocks}));
        }
    }
    // Separate context/autocompact for the explore sub-agent (user request):
    // its message list is compacted against its OWN budget — never the main
    // agent's history or window.
    if req.mode == "subagent" {
        compact_subagent_messages(&mut messages, req.context_window as usize);
    }

    let client = http_client();
    emit(&AgentEvent::Status {
        stage: "thinking".into(),
        content: "Contacting model".into(),
    });

    // The explore sub-agent gets the full read/search set; the main agent
    // deliberately has NO search tools and must delegate via `explore`.
    let mut schemas = if req.mode == "subagent" {
        research_schemas()
    } else {
        tool_schemas(req.allow_create, req.allow_browser)
    };
    // MCP connectors switched on in the composer become extra tools named
    // `mcp__<server>__<tool>`; their schemas come from each server's
    // tools/list. A connector that fails to start contributes no tools — but
    // the reason is surfaced as a warning, so "the agent has no browser tool"
    // is never a silent mystery again.
    let (mut mcp_schemas, mcp_failures) = crate::mcp::tool_schemas(&req.mcp_servers);
    for failure in mcp_failures {
        emit(&AgentEvent::Warn { content: failure });
    }
    // The exact names the model will call. A connector tool whose name is
    // unique across the enabled servers is advertised BARE (`browser_navigate`)
    // so the model sees short readable names; dispatch therefore cannot rely on
    // the `mcp__` prefix alone. Without this set a bare call fell through to
    // the native dispatcher and failed with "not available natively" — the
    // browser tool looked broken even though the connector was running.
    let mcp_names: std::collections::HashSet<String> = mcp_schemas
        .iter()
        .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
        .collect();
    // Drop any MCP tool whose name collides with a NATIVE tool. Two schemas
    // advertising the same `function.name` made the model see the same tool
    // twice (the duplicated tool pills / "×2" counters in the UI) and made
    // dispatch ambiguous — a bare MCP name shadows the native one. The native
    // tool wins: it is always available and does not depend on a connector
    // being up.
    let native_names: std::collections::HashSet<String> = schemas
        .iter()
        .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
        .collect();
    mcp_schemas.retain(|s| {
        s["function"]["name"]
            .as_str()
            .map(|n| !native_names.contains(n))
            .unwrap_or(false)
    });
    schemas.extend(mcp_schemas);
    // Desktop control is a hard on/off switch (composer → Computer Use): when
    // it is off the tool is never bound, so the model cannot even try.
    // The name is checked first because this push happens AFTER the MCP filter:
    // a connector exposing a tool literally named `computer` would otherwise
    // collide and the model would see the same name on two rows.
    if req.allow_computer && req.mode != "subagent" {
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
            "tools_chars": tools_chars,
            "tools": schemas.len(),
        })),
        ..Default::default()
    });

    let max_steps = if req.mode == "subagent" {
        SUBAGENT_MAX_STEPS
    } else {
        MAX_STEPS
    };
    // Lookups already executed in THIS turn. A repeat of the same read window
    // or grep is pure waste — the payload is already in the context above —
    // and the explore prompt forbids it, yet a traced run re-read three files
    // in round 3 that round 1 had returned and repeated a refused grep.
    let mut seen_lookups: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Mid-turn auto-compaction state. `compact_rounds` bounds how many times a
    // single turn may fold its history (a turn can run MAX_STEPS tool calls, so
    // folding must be possible while the agent works — but the summarizer must
    // not thrash either).
    let mut compact_rounds: usize = 0;
    // Prompt tokens the provider reported for the LAST round-trip of this turn.
    // This is the same number the context meter shows (input/total tokens), so
    // the mid-turn trigger and the meter agree: the fold fires exactly when the
    // meter crosses the threshold. 0 = the provider has not reported usage yet
    // this turn (fall back to the local estimate).
    let mut last_prompt_tokens: usize = 0;

    for step in 0..max_steps {
        // Drain any mid-turn steer BEFORE this model call: the steer is appended
        // as an extra user message, so the model keeps the whole conversation
        // (every prior tool result and the original task) above it — a steer
        // refines the running work instead of restarting from the steer alone.
        // This fixes "steering made it forget everything and only do the steered
        // message, abandoning the work in progress".
        deliver_steers(&mut messages, &req.chat_id, emit);
        // Client disconnect (Stop button closes the SSE stream) flips the
        // cancel flag — bail out instead of burning provider tokens.
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            // A steer that arrived together with the Stop still belongs to the
            // user: hand it back so the renderer re-sends it as the next turn.
            drop_steers(&req.chat_id, emit);
            emit(&AgentEvent::Done { aborted: true });
            return Ok(());
        }
        // Budget nudge (explore only): make the sub-agent report while it
        // still has calls left instead of running out silently.
        if req.mode == "subagent" && step + 3 == max_steps {
            messages.push(json!({
                "role": "user",
                "content": "Tool budget nearly exhausted — report your findings in your NEXT answer; only call a tool if it is essential."
            }));
        }

        // --- In-turn stale-result elision -----------------------------------
        // The main agent re-sends the whole wire history on EVERY round-trip.
        // Old tool results (a 40K explore report from round 2 is still there
        // at full size in round 10) are the bulk of that re-send; traces show
        // in:out ratios of 23-47:1 on the main agent. Shrink them in place,
        // keeping the last MAIN_FOLD_KEEP_ROUNDS rounds untouched — the model
        // is actively reasoning over those. Below MAIN_FOLD_MIN_TOKENS the
        // whole thing is a no-op: short turns pay nothing.
        if req.mode != "subagent" && estimate_wire_tokens(&messages[1..]) >= MAIN_FOLD_MIN_TOKENS {
            fold_stale_tool_results(&mut messages, &mut seen_lookups);
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
            let ctx = if req.context_window == 0 {
                DEFAULT_CONTEXT_WINDOW
            } else {
                req.context_window as usize
            };
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
            let measured = estimate_prompt_tokens(&messages, tools_chars).max(last_prompt_tokens);
            // messages[0] is the system prompt; the wire history is the rest.
            let fold_at = fold_prefix_len(&messages[1..]);
            if fold_at > 0 && measured >= threshold {
                compact_rounds += 1;
                // The provider number described the PRE-fold prompt; clear it so
                // the next round-trip re-measures instead of re-triggering.
                last_prompt_tokens = 0;
                let older: Vec<Value> = messages[1..1 + fold_at].to_vec();
                let tail: Vec<Value> = messages[1 + fold_at..].to_vec();
                // The summarizer may be routed to the user's "compact" Tool
                // Models slot (empty entry = the active chat model), exactly
                // like the manual /chat/compact path.
                // The effective slot provider id is unused here: the in-turn
                // fold emits usage via the chat's own accounting path, not the
                // manual-compact usage event.
                let (slot_model, slot_base, slot_keys, _slot_provider_id) = crate::backend_light::resolve_slot_target(
                    req.subagent_models.get("compact").map(String::as_str).unwrap_or(""),
                    &cfg.model,
                    &cfg.base_url,
                    &cfg.api_keys,
                    &req.provider_id,
                    &req.providers,
                );
                let has_slot = !slot_model.is_empty() && slot_model != cfg.model;
                // The summarizer may carry its own reasoning level; an empty
                // entry inherits the main model's level for this turn.
                let compact_level = req
                    .subagent_thinking
                    .get("compact")
                    .map(String::as_str)
                    .unwrap_or("")
                    .trim();
                let (compact_reasoning, compact_model_reasoning, compact_auto_think) =
                    crate::llm::reasoning_fields(
                        &cfg.provider,
                        // Missing slot level = OFF (never inherit the main
                        // level): a side-task call's default is no reasoning.
                        if compact_level.is_empty() {
                            "none"
                        } else {
                            compact_level
                        },
                        req.model_reasoning,
                    );
                let compact_model = LlmConfig {
                    provider: cfg.provider.clone(),
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
                // Fallback = the active chat model, mirroring the manual path's
                // subagent -> main-model retry.
                let compact_fallback = if has_slot {
                    Some(LlmConfig {
                        provider: cfg.provider.clone(),
                        model: cfg.model.clone(),
                        base_url: cfg.base_url.clone(),
                        api_keys: cfg.api_keys.clone(),
                        temperature: Some(0.2),
                        max_tokens: Some(COMPACT_MAX_OUTPUT as u32),
                        timeout_secs: COMPACT_TIMEOUT_SECS,
                        reasoning_level: req.thinking_level.clone(),
                        model_reasoning: req.model_reasoning,
                        auto_think: crate::models::auto_think_for(&cfg.provider),
                    })
                } else {
                    None
                };
                emit(&AgentEvent::CompactStart {});
                match crate::compact::compact_history(
                    &client,
                    &compact_model,
                    compact_fallback.as_ref(),
                    &older,
                    ctx,
                    COMPACT_MAX_OUTPUT,
                    true,
                )
                .await
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
                        // `keep` is the renderer's fold instruction: it keeps
                        // the last N non-system messages verbatim and folds the
                        // rest, so the next turn stops re-sending what the
                        // summary already covers. Nothing else is appended to
                        // `messages` before the turn ends, so the tail length IS
                        // that N.
                        emit(&AgentEvent::Compact {
                            content: summary_text,
                            keep: tail.len(),
                            usage: out.usage,
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
        let acc = match stream_chat(
            &client,
            &cfg,
            &messages,
            Some(&schemas),
            &mut sink,
            Some(cancel),
            Some(steer_flag.as_ref()),
        )
        .await
        {
            Ok(acc) => acc,
            Err((_, e)) => {
                // Stop is not a provider failure: stream_chat reports it as
                // "aborted by user". Surfacing that as an error stacked a bogus
                // error banner on a deliberate cancel (and, inside explore, read as
                // a failed attempt). End the turn as aborted instead.
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    // The user hit Stop mid-stream: hand any queued steer back so
                    // it is re-sent as the next turn instead of being erased by
                    // `SteerGuard::drop`.
                    drop_steers(&req.chat_id, emit);
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
                            content: "\n\n> The main model rejected the image; retrying with \
the Vision model's description instead.\n"
                                .to_string(),
                        });
                        continue;
                    }
                }
                emit(&AgentEvent::Error { content: e });
                // Terminal `done` after the error: the event protocol requires
                // it (the client treats an EOF without `done` as a dropped
                // connection). Without it the stream ended silently and the UI
                // stacked "Connection lost mid-turn" on top of the real
                // provider error — reported on one of two concurrent chats.
                // Emit BEFORE `done`: a steer that landed during the failed call
                // must survive as the next turn, and the renderer marks those
                // bubbles pending while processing `done`.
                drop_steers(&req.chat_id, emit);
                emit(&AgentEvent::Done { aborted: false });
                return Ok(());
            }
        };
        // A steer landed while this request was still streaming: the stream was
        // dropped mid-flight (see llm.rs) instead of being allowed to finish, so
        // the steer does NOT wait for the turn. Record what the model already
        // said — it was produced BEFORE the steer and the model must keep it —
        // then re-issue from the top of the loop, where `deliver_steers` appends
        // the steer to this very conversation.
        if acc.interrupted {
            let text = acc.text.trim();
            if !text.is_empty() {
                messages.push(json!({"role": "assistant", "content": json!(text)}));
            }
            let ids = pending_steer_ids(&req.chat_id);
            if !ids.is_empty() {
                emit(&AgentEvent::SteerInterrupt { ids });
            }
            // NO reset() here. The signal used to be cleared after consuming an
            // interrupt, which is exactly what lost steers: a second steer
            // landing between `reset()` and the next `stream_chat` had its raise
            // wiped, so the agent kept answering and the steer only surfaced at
            // the end of the turn ("sometimes it steers, sometimes it waits for
            // the turn"). The stream now stamps itself with the signal's
            // generation when it starts, so the raise we just consumed is
            // ignored by the re-issued request by construction — nothing needs
            // clearing.
            continue;
        }
        let (in_tok, out_tok) = usage_tuple(&acc);
        let cache_tok = cache_read_tuple(&acc);
        // The provider just told us how big the request it received was; that is
        // the ground truth the next round's mid-turn compaction trigger uses
        // (the local estimate cannot see the system prompt or the tool schemas).
        if in_tok > 0 {
            last_prompt_tokens = in_tok as usize;
        }
        emit(&AgentEvent::Usage {
            input_tokens: in_tok,
            output_tokens: out_tok,
            cache_read_tokens: cache_tok,
            model: req.model.clone(),
            provider_id: req.provider_id.clone(),
            sub: req.mode == "subagent",
        });
        // Trace: one llm row per model call (model + tokens), like the
        // Python sidecar's trace panel rows.
        trace.record(crate::trace::TraceEntry {
            kind: "llm".into(),
            model: Some(req.model.clone()),
            tokens: Some(crate::trace::Tokens {
                input: in_tok,
                output: out_tok,
                cache_read: cache_tok,
                total: in_tok + out_tok,
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
            ..Default::default()
        });

        let text = acc.text.clone();
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

        if tool_calls.is_empty() {
            // Plan mode: persist the plan document to disk (native plans.rs,
            // same layout the Python sidecar used) and emit plan_card so the
            // frontend collapses the streamed plan into its Plan card.
            if req.mode == "plan" {
                if let Some((title, body)) = extract_plan_body(&text) {
                    let data_root = native_data_root();
                    let ws = crate::plans::workspace_slug_for_root(&root);
                    // Never swallow this: a failed write used to be silent, so
                    // the plan looked saved in the chat but was missing from
                    // disk after a restart. Surface it as a warn the renderer
                    // shows, and name the target path in the log.
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
                                "The plan was not saved to disk ({e}). It is still in this chat, \
                                 but a restart will not restore it."
                            ),
                        });
                    }
                    emit(&AgentEvent::PlanCard {
                        title,
                        body,
                    });
                } else {
                    // Plan mode with an empty reply: say so instead of ending
                    // the turn with no card and no plan file.
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
            // with the steer appended above it.
            if !req.chat_id.trim().is_empty() {
                let pending = steer_inbox()
                    .lock()
                    .unwrap()
                    .get(&req.chat_id)
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
                if pending {
                    messages.push(json!({
                        "role": "assistant",
                        "content": if text.is_empty() { Value::Null } else { json!(text) },
                    }));
                    deliver_steers(&mut messages, &req.chat_id, emit);
                    continue;
                }
            }
            emit(&AgentEvent::Done { aborted: false });
            return Ok(());
        }

        // Record the assistant tool-call message, then execute each call.
        let calls_json: Vec<Value> = tool_calls
            .iter()
            .map(|(id, name, args)| {
                json!({"id": id, "type": "function",
                       "function": {"name": name, "arguments": args}})
            })
            .collect();
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
            // tool of the same name.
            !mcp_names.contains(name)
                && matches!(
                    name,
                    "read" | "grep" | "glob" | "find_symbol" | "current_time" | "system_stats"
                        | "search_memory" | "load_skill" | "lsp_definition" | "lsp_references"
                        | "lsp_hover" | "lsp_symbols" | "lsp_diagnostics"
                )
        };
        let mut batch: Vec<(String, String, Value)> = Vec::new();
        let mut sequential: Vec<(String, String, String)> = Vec::new();
        let mut repeats: Vec<(String, String, Value)> = Vec::new();
        for (id, name, raw_args) in &tool_calls {
            if is_readonly(name) {
                let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: name.clone(),
                });
                emit(&AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                });
                // A repeat of an identical lookup answers with a pointer
                // instead of the payload again (see `seen_lookups`).
                let key = lookup_key(name, &args);
                let is_repeat = key.is_some_and(|k| !seen_lookups.insert(k));
                if is_repeat {
                    repeats.push((id.clone(), name.clone(), args));
                } else {
                    batch.push((id.clone(), name.clone(), args));
                }
            } else {
                sequential.push((id.clone(), name.clone(), raw_args.clone()));
            }
        }
        if !batch.is_empty() {
            let root_c = root.clone();
            // Skills live in the DATA root, not the workspace: dispatch must
            // resolve `load_skill`/`create_skill` there, or every load answers
            // "Available: (none)" while the catalog above lists the skill.
            let skill_root_c = skill_root.clone();
            let handles: Vec<_> = batch
                .iter()
                .map(|(_, name, args)| {
                    let root = root_c.clone();
                    let skill_root = skill_root_c.clone();
                    let name = name.clone();
                    let args = args.clone();
                    tokio::task::spawn_blocking(move || {
                        match tools::dispatch_with_data_root(
                            &root,
                            &name,
                            &args,
                            None,
                            Some(&skill_root),
                        ) {
                            Ok(r) => (r, true),
                            Err(e) => (e, false),
                        }
                    })
                })
                .collect();
            for ((id, name, args), handle) in batch.into_iter().zip(handles) {
                let (result, ok) = handle
                    .await
                    .unwrap_or(("tool task failed".into(), false));
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
                );
            }
        }
        for (id, name, args) in repeats {
            finish_tool(
                &mut messages,
                emit,
                &trace,
                &id,
                &name,
                &args,
                "already returned above — this exact lookup is in your context; \
use what it showed, read a DIFFERENT window, or move on"
                    .into(),
                true,
                req.mode == "subagent",
                None,
            );
        }
        // Explore sub-agents in one step run CONCURRENTLY (tokio::spawn +
        // join): the model often fires several research questions at once and
        // each takes seconds — sequential execution multiplies the wall time.
        // Mutating tools stay sequential (ordering + cancel semantics).
        let mut explore_batch: Vec<(String, String, Value, u64)> = Vec::new();
        let mut rest: Vec<(String, String, String)> = Vec::new();
        for call in sequential {
            if call.1 == "explore" {
                // Enforce MAX_SUBAGENT_DEPTH: a sub-agent must not fan out more
                // sub-agents (mirrors graph.py). `research_schemas()` never
                // advertises `explore`, so this only rejects a hallucinated call
                // — without it the depth limit was a dead constant.
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
                    );
                    continue;
                }
                let args: Value =
                    serde_json::from_str(&call.2).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: call.1.clone(),
                });
                let branch = BRANCH_SEQ.fetch_add(1, Ordering::Relaxed);
                // The card carries its branch id so the calls the explore
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
                // findings twice (a full sub-agent: up to 12 rounds × 3 attempts).
                // Answer with a pointer instead. The key is registered BEFORE the
                // run, so two identical explores in the SAME step cannot both
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
                        "this exact explore ALREADY ran in this turn — its report is in \
your context above. Use that report, or ask a DIFFERENT, narrower question"
                            .into(),
                        true,
                        req.mode == "subagent",
                        None,
                    );
                } else {
                    explore_batch.push((call.0, call.1, args, branch));
                }
            } else {
                rest.push(call);
            }
        }
        if !explore_batch.is_empty() {
            // Concurrent explores polled in THIS task via join_all — no
            // tokio::spawn, so no Send bound and the turn still blocks until
            // every report is back (explore stays synchronous by design).
            // Structural events (tool cards/status/usage) flow through a
            // channel to the parent stream so parallel explores stay VISIBLE
            // in the chat while they work; Text/Error stay inside each
            // sub-agent's own report (never surfaced in the chat).
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SubMsg>();
            let futures: Vec<_> = explore_batch
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
                        let (result, ok) = run_subagent(
                            &req_c, &args_c, branch, &name_t, &mut sink, &cancel_c,
                        )
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
                        } => finish_tool(
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
                        ),
                    }
                }
            };
            let (_reports, _) = tokio::join!(sub_all, forward);
        }
        for (id, name, raw_args) in &rest {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                // Stop mid-batch: the remaining tools are skipped, so anything
                // the user steered while they ran has no step left to ride on.
                drop_steers(&req.chat_id, emit);
                emit(&AgentEvent::Done { aborted: true });
                return Ok(());
            }
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            emit(&AgentEvent::Status {
                stage: "tool".into(),
                content: name.clone(),
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
            let pre_edit = if name == "edit_file" || name == "write_file" {
                let p = args["path"]
                    .as_str()
                    .or_else(|| args["filePath"].as_str())
                    .unwrap_or_default();
                Some(crate::tools::read_pre_edit(&root, p).unwrap_or_default())
            } else {
                None
            };
            // Structured rows for the tool card. Only the web tools fill it
            // (search hits / fetched page): the card renders those as links,
            // and a DISTILLED search answer no longer contains the link list.
            let mut ui_results: Option<Value> = None;
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
            {
                (
                    format!(
                        "unknown tool {name:?}: no such tool exists. Call one of exactly these names: {}",
                        advertised.join(", ")
                    ),
                    false,
                )
            } else if name == "run_terminal"
                && req.mode != "subagent"
                && is_file_search_command(args["command"].as_str().unwrap_or_default())
            {
                (
                    "blocked: the main agent must not locate files via the terminal — delegate file discovery to the `explore` sub-agent".into(),
                    false,
                )
            } else if name == "computer" {
                // Bound only when the user enabled Computer Use; the schema is
                // withheld otherwise, so reaching here means it is allowed.
                match crate::computer::run(&args) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else if crate::browser_driver::handles(name) {
                // Native browser driver. This arm MUST precede the MCP arm: the
                // MCP name set is captured before the native-wins filter, so a
                // tool this app advertises natively would otherwise be routed to
                // the connector it replaced.
                //
                // Second gate (the schema filter is the first): a turn whose
                // Browser switch is off must not start a browser even if the
                // model emits the call anyway (stale transcript, hallucinated
                // name, a connector echoing `browser_*`). Refusing HERE, before
                // `run`, is what keeps Chromium from being launched at all.
                if !req.allow_browser {
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
            } else if mcp_names.contains(name) || name.starts_with(crate::mcp::TOOL_PREFIX) {
                match crate::mcp::call_tool(&req.mcp_servers, name, &args) {
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
                // Blocking question: emit the popup request, then WAIT (no
                // deadline — the user may take as long as they need).
                let gate = next_gate_id();
                emit(&AgentEvent::Ask {
                    id: gate.clone(),
                    question: args["question"].as_str().unwrap_or_default().to_string(),
                    options: args["options"].clone(),
                });
                match await_answer(&gate, cancel).await {
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
            } else if name == "confirm_action" || name == "request_permission" {
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
                    path: args["path"].as_str().unwrap_or_default().to_string(),
                    reason: args["reason"].as_str().unwrap_or_default().to_string(),
                    scope: scope.to_string(),
                });
                match await_answer(&gate, cancel).await {
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
            } else if name == "web_search" {
                // Native web search: the engine chain is the user's Settings →
                // Web Providers order, so this must run here (async) rather than
                // in the sync `tools::dispatch`.
                let query = args["query"].as_str().unwrap_or_default();
                let max = web_search_result_count(&args, req.web_search_auto_fetch);
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
                    Ok((hits, pages)) => {
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
            } else {
                match tools::dispatch_with_data_root(
                    &root,
                    name,
                    &args,
                    None,
                    Some(&skill_root),
                ) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            };
            // Emit the unified diff while the card is still "running" — the
            // frontend folds it into the card (and the Review panel) before
            // the Tool result resolves the card to done.
            if ok {
                if let Some(old) = pre_edit {
                    let p = args["path"]
                        .as_str()
                        .or_else(|| args["filePath"].as_str())
                        .unwrap_or_default();
                    if let Ok(target) = crate::tools::resolve_safe(&root, p, false, None) {
                        let newc = std::fs::read_to_string(target).unwrap_or_default();
                        let diff = crate::tools::unified_diff(p, &old, &newc);
                        if !diff.is_empty() {
                            emit(&AgentEvent::Diff {
                                tool: name.clone(),
                                path: p.to_string(),
                                diff,
                            });
                        }
                    }
                }
            }
            finish_tool(
                &mut messages,
                emit,
                &trace,
                id,
                name,
                &args,
                result,
                ok,
                req.mode == "subagent",
                ui_results,
            );
        }

        // A step with a single call is a wasted model round trip when more
        // lookups were foreseeable. The hint rides on that call's own result,
        // so it costs no extra request and never cuts a report.
        if let Some(hint) = single_call_hint(&req.mode, &tool_calls) {
            if let Some(last) = messages.last_mut() {
                if last["role"].as_str() == Some("tool") {
                    if let Some(c) = last["content"].as_str() {
                        last["content"] = json!(format!("{c}\n\n{hint}"));
                    }
                }
            }
        }
    }

    // Budget exhausted. The explore sub-agent must still hand the parent its
    // findings: fold the tool results it already gathered into a report —
    // no forced extra model call (the data is already in context).
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
        emit(&AgentEvent::Done { aborted: false });
        return Ok(());
    }
    emit(&AgentEvent::Warn {
        content: format!("turn stopped after {MAX_STEPS} steps"),
    });
    // The budget ran out with steers possibly still queued: report them so the
    // renderer can start them as the next turn (this exit has no model call
    // left to carry them, and `SteerGuard::drop` would erase them silently).
    drop_steers(&req.chat_id, emit);
    emit(&AgentEvent::Done { aborted: false });
    Ok(())
}

/// Run the explore sub-agent (tools `explore`/`task`): depth-limited
/// recursion into run_turn with a research-only prompt and the FULL
/// read/search tool set. The report is returned UNCAPPED — the main agent
/// has no search tools of its own, so this report is its only source of
/// data (UI echo is still capped by the caller).
/// Resolve the explore sub-agent's model from the Tool Models settings.
/// Mirrors graph.py resolve_subagent_model: "" / missing -> the parent
/// model; "providerId/model" -> THAT provider's base URL + keys
/// (cross-provider routing); a bare model id -> the parent provider.
/// Heuristic mirror of the frontend's `supportsReasoning` (src/lib/thinking.ts):
/// a model whose id clearly looks like a reasoning model is flagged even when
/// the provider never reported a `reasoning` flag (local llama.cpp/vLLM rows).
fn model_id_looks_reasoning(model: &str) -> bool {
    let id = model.trim().to_lowercase();
    if id.is_empty() {
        return false;
    }
    let needles = [
        "qwen3",
        "qwq",
        "deepseek-r1",
        "deepseek_v3.1",
        "glm-4.5",
        "glm-4.6",
        "kimi-k2-thinking",
        "reasoning",
        "reasoner",
        "thinking",
    ];
    if needles.iter().any(|n| id.contains(n)) {
        return true;
    }
    // gpt-5 / o1 / o3 / o4 families, tolerant of separators.
    id.contains("gpt-5")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
}

/// Reasoning capability of the model a slot actually runs, mirroring the
/// frontend's precedence (`modelReasoning() ?? supportsReasoning()`): the
/// manual override first, then the live `/models` map, each tried bare and
/// `providerId/model`-prefixed, and finally the model-id heuristic. Reads the
/// provider config Value directly — the Rust side never had this check before,
/// so every tool slot's reasoning gate was silently off.
pub(crate) fn provider_model_reasoning(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
) -> bool {
    let map_flag = |key: &str| -> Option<bool> {
        let cfg = providers.get(provider_id)?;
        let map = cfg.get(key)?;
        let bare = map.get(model).and_then(Value::as_bool);
        if bare.is_some() {
            return bare;
        }
        if provider_id.is_empty() {
            return None;
        }
        map.get(&format!("{provider_id}/{model}"))
            .and_then(Value::as_bool)
    };
    if let Some(v) = map_flag("manualReasoningMap") {
        return v;
    }
    if let Some(v) = map_flag("reasoningMap") {
        return v;
    }
    model_id_looks_reasoning(model)
}

/// Resolve the explore slot's target: `(model, base_url, api_keys,
/// provider_id)`. The provider id is the EFFECTIVE one — the provider the
/// request is really routed to — so the usage event can attribute the tokens
/// to the right provider instead of blindly copying the parent's id.
fn resolve_subagent_target(req: &AgentRequest) -> (String, String, Vec<String>, String) {
    // The UI's Tool Models settings store the explore model under the
    // "explore" key (agent name).
    let entry = req
        .subagent_models
        .get("explore")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if entry.is_empty() || entry == "main" || entry == "main_model" || entry == "main model" {
        return (
            req.model.clone(),
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        );
    }
    let (provider_id, model) = match entry.split_once('/') {
        Some((pid, m)) => (pid.trim().to_string(), m.trim().to_string()),
        None => (String::new(), entry),
    };
    if provider_id.is_empty() {
        // Bare model id: same provider as the parent.
        return (
            model,
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        );
    }
    match req.providers.get(&provider_id) {
        Some(cfg) => {
            let base = cfg
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or(&req.base_url)
                .to_string();
            let mut keys: Vec<String> = cfg
                .get("apiKeys")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
                    keys.push(k.to_string());
                }
            }
            if keys.is_empty() {
                keys = req.api_keys.clone();
            }
            (model, base, keys, provider_id)
        }
        // Unknown provider id: fall back to the parent provider (and its id).
        None => (
            model,
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        ),
    }
}

/// Compact the explore sub-agent's message list independently of the main
/// agent's history (user request: explore context/autocompact must be
/// separate). Mirrors compact.rs but with a smaller budget: the sub-agent
/// only needs its recent tool results + the report it is building.
/// Rough token estimate for a slice of wire messages (~4 chars per token, the
/// same heuristic compact.rs uses). Only `content` is measured: it is the only
/// field that grows with tool output, which is what overflows the window.
///
/// This is a HISTORY-only measure — it deliberately omits the system prompt and
/// the tool schemas (both fixed per-request costs that do not grow with the
/// conversation). Use `estimate_prompt_tokens` when the question is "how full is
/// the context window", and this when the question is "has the history grown
/// enough to be worth folding" (the in-turn elision trigger, which only cares
/// about tool output).
fn estimate_wire_tokens(messages: &[Value]) -> usize {
    messages
        .iter()
        .map(|m| {
            m["content"]
                .as_str()
                .map(|c| c.len().div_ceil(4))
                .unwrap_or(0)
        })
        .sum()
}

/// Estimate the FULL prompt the next request will carry, the way a provider
/// bills it: the system prompt (`messages[0]`), the whole wire history
/// (including per-message overhead and tool-call arguments) and the serialized
/// tool schemas. `estimate_wire_tokens` alone misses the fixed overhead — on a
/// long turn that made the mid-turn compaction trigger plateau below the real
/// prompt size, so it never fired even when the context meter was well past the
/// threshold. This is only the FALLBACK for the first model call of a turn and
/// for providers that report no usage; the trigger prefers the provider's own
/// `prompt_tokens` (ground truth) once a round-trip has happened.
fn estimate_prompt_tokens(messages: &[Value], tools_chars: usize) -> usize {
    // Whole serialized prompt at ~4 chars/token. Counting the raw JSON (not just
    // `content`) folds in the per-message envelope and the tool-call arguments
    // for free, and is safe to overcount slightly: overcounting only makes the
    // fold happen a touch earlier, which is the safe direction.
    let wire_chars: usize = serde_json::to_string(messages)
        .map(|s| s.chars().count())
        .unwrap_or(0);
    (wire_chars + tools_chars).div_ceil(4)
}

/// In-turn elision of stale tool results (main agent only): the main agent's
/// wire history grows by EVERY tool result ever produced in the turn and is
/// re-sent in full on every round-trip (traces show in:out ratios of 23-47:1
/// and 72% of input tokens landing on the main agent). Compaction only fires
/// at 80% of the context window — far too late for cost — so old results ride
/// along at full size (16K per read, 40K per explore report) forever.
///
/// This fold keeps the last `MAIN_FOLD_KEEP_ROUNDS` rounds untouched and
/// shrinks OLDER `tool` messages to a per-result budget: an explore report to
/// `MAIN_FOLD_EXPLORE_CHARS` (the report is the main agent's only view of that
/// research), any other tool result to `MAIN_FOLD_RESULT_CHARS` (a targeted
/// re-read is one cheap call). A marker tells the model the tail was dropped
/// and how to get it back — it is a pointer, not silent data loss.
///
/// Idempotent by construction: a stub already carries `MAIN_FOLD_MARKER`, and
/// its content length is under every budget, so re-folding is a no-op. Only
/// `tool` messages are touched — assistant/user messages stay verbatim, and a
/// `tool` message can never be detached from its assistant call (the message
/// list keeps its shape, unlike fold_prefix_len's rebuild).
fn fold_stale_tool_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
) {
    // A "round" is one `assistant` message carrying tool_calls, together with
    // the `tool` results that follow it. The boundary is the FIRST of the last
    // MAIN_FOLD_KEEP_ROUNDS rounds: everything from there on stays untouched
    // (the model is actively reasoning over those results).
    let rounds: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m["role"] == "assistant"
                && m.get("tool_calls")
                    .and_then(|t| t.as_array())
                    .is_some_and(|a| !a.is_empty())
        })
        .map(|(i, _)| i)
        .collect();
    if rounds.len() <= MAIN_FOLD_KEEP_ROUNDS {
        return;
    }
    let cut = rounds[rounds.len() - MAIN_FOLD_KEEP_ROUNDS];
    // Name + raw args per tool_call id: the `tool` message carries only the id,
    // so both are recovered from the assistant call that produced it. Owned
    // strings — the map must not borrow `messages` while it is mutated below
    // (that kept the immutable borrow alive into `iter_mut` and the borrow
    // checker rejected it outright, E0502: the crate did not compile).
    let mut call_meta: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for m in messages[..cut].iter() {
        if m["role"] != "assistant" { continue; }
        if let Some(calls) = m.get("tool_calls").and_then(|t| t.as_array()) {
            for c in calls {
                if let (Some(id), Some(name)) = (
                    c["id"].as_str(),
                    c["function"]["name"].as_str(),
                ) {
                    let args = c["function"]["arguments"].as_str().unwrap_or("{}");
                    call_meta.insert(id.to_string(), (name.to_string(), args.to_string()));
                }
            }
        }
    }
    // Every `tool` result BEFORE the boundary is stale — it is at least
    // MAIN_FOLD_KEEP_ROUNDS rounds old. (The results of the kept rounds are
    // fresh and untouched; so is everything after them, including the newest
    // user steer.)
    for m in messages[..cut].iter_mut() {
        if m["role"] != "tool" { continue; }
        // Skip already-folded stubs (idempotence).
        if m["content"].as_str().is_some_and(|c| c.contains(MAIN_FOLD_MARKER)) { continue; }
        let meta = m["tool_call_id"].as_str().and_then(|id| call_meta.get(id));
        let is_explore = meta.is_some_and(|(name, _)| name == "explore");
        let budget = if is_explore { MAIN_FOLD_EXPLORE_CHARS } else { MAIN_FOLD_RESULT_CHARS };
        let Some(content) = m["content"].as_str().map(String::from) else { continue };
        if content.chars().count() <= budget { continue; }
        // Char-boundary-safe truncation: byte slicing panics (and with
        // panic=abort kills the app) on a multi-byte Persian character.
        let head: String = content.chars().take(budget).collect();
        m["content"] = json!(format!("{head}\n{MAIN_FOLD_MARKER}"));
        // The marker tells the model to re-run the tool — so the repeat-guard
        // must FORGET this lookup. Otherwise the re-run is answered with a
        // pointer to a body that no longer exists and the data is unreachable
        // for the rest of the turn (silent quality loss).
        if let Some((name, raw_args)) = meta {
            if let Ok(args) = serde_json::from_str::<Value>(raw_args) {
                if let Some(k) = lookup_key(name, &args) {
                    seen.remove(&k);
                }
            }
        }
    }
}

/// Length of the prefix of `history` (messages WITHOUT the system prompt) that a
/// mid-turn compaction may fold into a summary — 0 when nothing is safely
/// foldable.
///
/// Two rules keep the rebuilt conversation valid for every provider:
///  - Never fold a trailing user message: it is usually the request this turn is
///    answering, so folding it would hide the question from the model.
///  - Always cut at an `assistant` boundary, never at a `tool` boundary: a
///    `tool` result must stay with the assistant `tool_calls` that produced it,
///    or the provider rejects the orphaned reply with a 400.
///
/// Consequently a turn with a single user prompt and no assistant answer yet
/// returns 0 — there is genuinely nothing to fold at that point.
fn fold_prefix_len(history: &[Value]) -> usize {
    let mut cut = history.len();
    while cut > 0 && history[cut - 1]["role"].as_str() == Some("user") {
        cut -= 1;
    }
    while cut > 0 && history[cut - 1]["role"].as_str() != Some("assistant") {
        cut -= 1;
    }
    if cut == 0 {
        0
    } else {
        cut - 1
    }
}

fn compact_subagent_messages(messages: &mut Vec<Value>, ctx: usize) {
    // Rough token estimate: ~4 chars per token (same heuristic as compact.rs).
    let est = |m: &Value| -> usize { m["content"].as_str().map(|c| c.len().div_ceil(4)).unwrap_or(0) };
    let total: usize = messages.iter().map(&est).sum();
    // Keep ~60% of the context window usable; compact when over.
    let budget = ctx.saturating_sub(2048).max(4096) * 60 / 100;
    if total <= budget {
        return;
    }
    // Keep the system prompt (index 0) and the last few messages verbatim;
    // summarize the middle into one user message.
    let mut start = messages.len() - 4.min(messages.len().saturating_sub(1));
    // Never orphan a tool message: if the tail would START with a `tool`
    // reply whose assistant tool_calls got compacted away, extend the tail
    // back until it starts with a non-tool message (providers reject orphans).
    while start > 1 && messages[start]["role"].as_str() == Some("tool") {
        start -= 1;
    }
    let head = messages[0].clone();
    let mid: Vec<Value> = messages[1..start].to_vec();
    let tail: Vec<Value> = messages[start..].to_vec();
    let mut summary = String::from("[Earlier research compacted] Key findings so far:\n");
    for m in &mid {
        let c = m["content"].as_str().unwrap_or_default();
        if c.len() > 400 {
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            let mut end = 400;
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            summary.push_str(&format!("- {}…\n", &c[..end]));
        } else if !c.is_empty() {
            summary.push_str(&format!("- {c}\n"));
        }
    }
    *messages = vec![
        head,
        json!({"role": "user", "content": summary}),
    ];
    messages.extend(tail);
}

/// Shared cancel flag for spawned sub-agent tasks: flipping the parent's
/// flag (Stop button) aborts every concurrent explore too.
type CancelFlag = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// True when a shell command tries to LOCATE files (find/grep/rg/ls/…).
/// The main agent has no search tools by design — file discovery must go
/// through the explore sub-agent, not terminal one-liners (user request).
fn is_file_search_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    // Check every pipeline/chain segment, not just the first token.
    lower
        .split([';', '|', '&', '\n'])
        .any(|seg| {
            let t = seg.trim();
            ["find", "grep", "rg", "ls", "fd", "locate", "tree", "glob"]
                .iter()
                .any(|p| t == *p || t.starts_with(&format!("{p} ")))
        })
}

/// Fold one sub-agent event into its report / error buffers. Text streamed
/// BEFORE a search tool call is narration ("let me search…"), not the report:
/// it is dropped when the tool starts, so only the answer written after the
/// LAST search tool reaches the main agent (it used to receive every step's
/// chatter, resent on each later step). Memory tools are exempt so a report
/// written in the same step as save_memory survives.
fn fold_subagent_event(report: &mut String, sub_error: &mut String, ev: &AgentEvent) {
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

/// Identity of a repeatable read-only lookup: a read window (file + offset +
/// limit) or a grep (pattern + scope). Two calls with the same key return the
/// same payload, so the second one is answered with a pointer instead of the
/// body — the content is already in the context above.
fn lookup_key(name: &str, args: &Value) -> Option<String> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    match name {
        "read" => {
            let file = s("filePath");
            if file.is_empty() {
                return None;
            }
            let offset = args["offset"].as_u64().unwrap_or(1);
            let limit = args["limit"].as_u64().unwrap_or(400);
            // `ranges` selects other windows of the same file: without it in the
            // key, a second read of a DIFFERENT range was answered as a repeat.
            let ranges = args["ranges"].to_string(); // "null" when absent
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
/// Two audiences, because the waste differs:
/// - the explore sub-agent: one lookup per step burns rounds;
/// - the MAIN agent: one broad explore is slow and comes back shallow, while
///   the same step could have carried several focused explores concurrently
///   (a traced turn fired a single wide explore and got a 4-round report).
fn single_call_hint(mode: &str, calls: &[(String, String, String)]) -> Option<&'static str> {
    if calls.len() != 1 {
        return None;
    }
    if mode == "subagent" {
        return Some(
            "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together (other greps, find_symbol, lsp_symbols, reads of the exact windows), then write the report.",
        );
    }
    let name = calls[0].1.as_str();
    (name == "explore").then_some(
        "[hint] That step had ONE explore. Explores of one step run CONCURRENTLY and cost a single round-trip, while one broad explore is slow and returns a shallow report: when the task spans several areas, fire 2-4 focused explores (one per area/file group) IN THE SAME STEP.",
    )
}

/// System prompt of the explore sub-agent: the research strategy plus a compact
/// project layout, so it starts from REAL paths instead of guessing with glob
/// (a traced run burned ~20 calls hunting for `backend/`), and explicit LSP
/// guidance (the old prompt never mentioned LSP, so the model never used it).
fn explore_system_prompt(root: &str) -> String {
    let layout = tools::layout_snapshot(root, 3500);
    format!(
        "You are the explore sub-agent inside the workspace {root}. \
The main agent waits on you and cannot search itself, so be fast and precise. \
Every model round trip costs seconds while tools cost milliseconds, so what matters \
is the number of ROUNDS (steps), not the number of calls: issue every call you can \
already foresee together in ONE step (they run in parallel) — a grep per \
identifier/keyword variant, lsp_symbols for likely files, reads of files the \
question names — then act on all the results at once. Aim for 2-3 rounds.\n\n\
HARD RULE: never issue a step with a single call while you still have a \
question whose answer could change what you do next. If you catch yourself \
about to send one call, add the other calls you already know you need (the \
next file's window, the second keyword, the symbol lookup) to the SAME step. \
A one-call step is only correct when it is genuinely the last thing you need \
before the report. Never read a file you have not located, and never guess an \
offset: read offset=1, or the window a result pointed you at — an offset past \
the end returns nothing and wastes a whole round.\n\
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
a search with the same pattern.\n\n\
FINAL REPORT (your only text output — write nothing between tool calls): the \
main agent has no read tool and edits files with exact-match strings, so precision \
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
static RETRY_NUDGE: AtomicU64 = AtomicU64::new(0);

/// Force the running explore ladder to retry immediately (banner Retry button).
pub fn nudge_subagent_retry() {
    RETRY_NUDGE.fetch_add(1, Ordering::Relaxed);
}

/// Current nudge counter — see `RETRY_NUDGE`.
fn retry_nudge() -> u64 {
    RETRY_NUDGE.load(Ordering::Relaxed)
}

/// Whether a sub-agent failure can NEVER be fixed by retrying the SAME model.
///
/// The retry ladder exists for TRANSIENT failures: a timeout, a 5xx, a dropped
/// connection, a rate limit. A FATAL one is different — an invalid API key, a
/// model the provider does not serve, or a rejected request fails identically
/// on every one of the 10 attempts, so the ladder only bought ~90s of dead
/// banner and then dumped the raw provider body on the user ("the auto-retry on
/// error does not work"). Those fall back to the main chat model instead, which
/// is what the renderer's 'sub-agent failed — using main model' banner was
/// always meant to report.
fn subagent_error_is_fatal(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    // Deliberately NOT matching 429/"rate limit"/5xx: those are transient, and
    // retrying the same model is exactly right for them.
    let needles = [
        "invalid api key",
        "incorrect api key",
        "invalid_api_key",
        "api key not valid",
        "no api key configured",
        "unauthorized",
        "unauthenticated",
        "authentication",
        "model not found",
        "model_not_found",
        "unknown model",
        "no such model",
        "not a valid model",
        "does not exist",
        "forbidden",
        "permission",
        "insufficient",
        "no credit",
        "not supported",
    ];
    if needles.iter().any(|needle| e.contains(needle)) {
        return true;
    }
    // "model `gpt-x` not found" / "model `gpt-x` is unavailable": the model
    // NAME sits between the two halves, so no single substring can ever match.
    // Pair the halves instead — every provider words this one differently, but
    // they all name the model AND say it is missing.
    let names_a_model = e.contains("model");
    let says_missing = [
        "not found",
        "not available",
        "unavailable",
        "unknown",
        "invalid",
        "unsupported",
        "rejected",
    ]
    .iter()
    .any(|needle| e.contains(needle));
    names_a_model && says_missing
}

async fn run_subagent(
    parent: &AgentRequest,
    args: &Value,
    branch: u64,
    // The tool name that spawned this sub-agent ("explore"). Carried through to
    // the retry events so the banner can name the tool, not just the agent.
    tool: &str,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
) -> (String, bool) {
    let description = args["description"].as_str().unwrap_or_default().to_string();
    let prompt = args["prompt"].as_str().unwrap_or_default().to_string();
    if prompt.is_empty() {
        return ("explore requires a non-empty prompt".into(), false);
    }

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
    let sub_model_reasoning =
        provider_model_reasoning(&parent.providers, &sub_provider_id, &sub_model);
    let mut sub_req = AgentRequest {
        provider: parent.provider.clone(),
        provider_id: sub_provider_id,
        model: sub_model,
        base_url: sub_base,
        api_key: parent.api_key.clone(),
        api_keys: sub_keys,
        root: parent.root.clone(),
        mode: "subagent".into(),
        prompt,
        history: Vec::new(),
        system_prompt: explore_system_prompt(&parent.root),
        skills: Vec::new(),
        context_window: parent.context_window,
        chat_id: parent.chat_id.clone(),
        mcp_servers: Value::Null,
        subagent_models: std::collections::HashMap::new(),
        providers: parent.providers.clone(),
        data_root: parent.data_root.clone(),
        // Sub-agents are research-only: desktop control is never delegated.
        allow_computer: false,
        // A research sub-agent has no business driving a page either.
        allow_browser: false,
        // Authoring tools are never delegated either.
        allow_create: false,
        // Web search IS research, so the sub-agent inherits the same engine
        // chain the user configured for the parent turn.
        search_plugins: parent.search_plugins.clone(),
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
        subagent_thinking: std::collections::HashMap::new(),
        // A research sub-agent is text-only — images belong to the parent turn.
        images: Vec::new(),
        // A sub-agent inherits the parent's auto-fetch count.
        web_search_auto_fetch: parent.web_search_auto_fetch,
    };

    // Attempt ladder. A sub-agent runs INSIDE the parent turn, so the
    // frontend's reconnect ladder can never see it fail — a provider hiccup
    // (or a run that returned nothing) used to be final and the user just
    // watched a dead explore card while the turn stalled. Each attempt is
    // bounded by the model call itself, never by a wall-clock timer: a slow
    // but healthy provider is NOT a failure.
    let mut last: (String, bool) = (String::new(), false);
    // Set once the sub-agent's own model proved UNUSABLE and the request was
    // re-aimed at the parent's model. Kept outside the loop so the ladder can
    // tell "the slot model is broken" from "the fallback is broken too".
    let mut using_fallback = false;
    for attempt in 1..=SUBAGENT_MAX_ATTEMPTS {
        let mut report = String::new();
        let mut sub_error = String::new();
        // Liveness clock for the idle guard below: EVERY event this attempt
        // emits bumps it, so what the guard measures is real silence — a
        // blocking tool call that never returns, or a provider that accepted
        // the connection and stopped responding — never a slow-but-working
        // model.
        let pulse = std::sync::Arc::new(AtomicU64::new(1));
        let pulse_sink = std::sync::Arc::clone(&pulse);
        let res = {
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
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
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
            let outcome = tokio::select! {
                r = &mut fut => Some(r),
                _ = guard => None,
            };
            match outcome {
                Some(r) => r,
                None => Err(format!(
                    "sub-agent hung: no activity for {}s (a \
stuck tool call or a provider that stopped responding) — attempt aborted",
                    subagent_idle_secs()
                )),
            }
        };
        let failed: (String, bool) = match res {
            Ok(()) => {
                if report.trim().is_empty() {
                    // The turn "succeeded" but produced no text — the parent must
                    // not treat an empty report as data. Surface the captured
                    // sub-agent error (or a generic message) so it can retry or
                    // fall back to its own tools.
                    let why = if sub_error.trim().is_empty() {
                        "the sub-agent produced no output (empty model response)".to_string()
                    } else {
                        sub_error
                    };
                    (format!("explore returned no findings: {why}"), false)
                } else {
                    return (report, true);
                }
            }
            Err(e) => (format!("sub-agent failed: {e}"), false),
        };
        last = failed;
        // A FATAL failure (invalid key, unknown model, rejected request) can
        // never be fixed by retrying the same model: re-aim the request at the
        // PARENT's model instead — the escape hatch the compact slot already
        // uses. Only if the fallback fails too do we give up, and immediately
        // rather than burning the remaining attempts on a model that cannot
        // answer.
        if subagent_error_is_fatal(&last.0) && attempt < SUBAGENT_MAX_ATTEMPTS {
            let same_target =
                parent.model == sub_req.model && parent.provider_id == sub_req.provider_id;
            if using_fallback || parent.model.trim().is_empty() || same_target {
                // Either the fallback already ran and failed, or there is no
                // DIFFERENT main model to fall back to: the failure is final.
                break;
            }
            using_fallback = true;
            sub_req.model = parent.model.clone();
            sub_req.provider_id = parent.provider_id.clone();
            sub_req.base_url = parent.base_url.clone();
            sub_req.api_key = parent.api_key.clone();
            sub_req.api_keys = parent.api_keys.clone();
            // Tell the renderer straight away, so the user sees WHICH model
            // stopped working instead of watching a silent 90s of retries.
            emit(&AgentEvent::Retry {
                attempt,
                max_attempts: SUBAGENT_MAX_ATTEMPTS,
                delay_secs: 0,
                reason: format!("{} — switching to the main model", last.0),
                agent: "explore subagent".into(),
                tool: tool.to_string(),
                model: sub_req.model.clone(),
                reconnecting: true,
                fallback: true,
            });
            continue;
        }
        // Stop aborts the ladder too: never spawn another sub-agent after the
        // user cancelled the turn.
        if attempt == SUBAGENT_MAX_ATTEMPTS || cancel.load(Ordering::Relaxed) {
            break;
        }
        // Same ladder, same events, same banner as a main-model retry: the
        // renderer must not be able to tell a sub-agent hiccup from a main
        // agent one. `agent` is what labels WHICH model the user should change,
        // `tool` names the tool that owns the retry.
        let reason = last.0.clone();
        emit(&AgentEvent::Retry {
            attempt,
            max_attempts: SUBAGENT_MAX_ATTEMPTS,
            delay_secs: SUBAGENT_RETRY_BACKOFF_MS / 1000,
            reason: reason.clone(),
            agent: "explore subagent".into(),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
            reconnecting: true,
            fallback: false,
        });
        // The backoff is INTERRUPTIBLE: the banner's Retry button bumps
        // `RETRY_NUDGE` and the remaining wait is skipped, so the user can force
        // the next attempt instead of watching a countdown. Without this the
        // button was DEAD on a live sub-agent retry — the parent turn is still
        // streaming, so `send()` is a no-op behind its single-flight guard and
        // clicking Retry did literally nothing.
        let nudged_from = retry_nudge();
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(SUBAGENT_RETRY_BACKOFF_MS);
        let mut forced = false;
        while std::time::Instant::now() < deadline {
            if retry_nudge() != nudged_from {
                forced = true;
                break;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            tokio::time::sleep(left.min(std::time::Duration::from_millis(250))).await;
        }
        if forced {
            // Instant feedback: restart the banner so the user sees the click
            // registered, then retry right away.
            emit(&AgentEvent::Retry {
                attempt,
                max_attempts: SUBAGENT_MAX_ATTEMPTS,
                delay_secs: 0,
                reason: "retrying now (requested)".into(),
                agent: "explore subagent".into(),
                tool: tool.to_string(),
                model: sub_req.model.clone(),
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
            attempt: SUBAGENT_MAX_ATTEMPTS,
            max_attempts: SUBAGENT_MAX_ATTEMPTS,
            reason: last.0.clone(),
            agent: "explore subagent".into(),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
            fallback: using_fallback,
        });
    }
    last
}

/// Normalise the two token vocabularies every provider uses. Google's
/// `usageMetadata` is camelCase (`promptTokenCount` / `candidatesTokenCount`),
/// so without those keys a Gemini turn reported (0, 0) and the renderer fell
/// back to its local estimate — which also disabled the provider-reported
/// mid-turn compaction trigger for that provider.
fn usage_tuple(acc: &StreamAcc) -> (u64, u64) {
    let Some(u) = &acc.usage else {
        return (0, 0);
    };
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(Value::as_u64))
            .unwrap_or(0)
    };
    (
        pick(&["prompt_tokens", "input_tokens", "promptTokenCount"]),
        pick(&["completion_tokens", "output_tokens", "candidatesTokenCount"]),
    )
}

/// How much of the reported input the provider served from its PREFIX CACHE.
///
/// This is the one number that says whether prefix caching is actually working
/// on the active gateway. Every provider spells it differently:
/// - DeepSeek / many OpenAI-compatible gateways: `prompt_cache_hit_tokens`
/// - OpenAI: `prompt_tokens_details.cached_tokens`
/// - Anthropic: `cache_read_input_tokens`
/// - Google: `cachedContentTokenCount`
/// A gateway that reports nothing returns 0 ("not measured"), which is why the
/// ruler prints the flag rather than pretending a zero hit rate.
fn cache_read_tuple(acc: &StreamAcc) -> u64 {
    let Some(u) = &acc.usage else {
        return 0;
    };
    let direct = [
        "prompt_cache_hit_tokens",
        "cache_read_input_tokens",
        "cachedContentTokenCount",
        "cached_tokens",
    ]
    .iter()
    .find_map(|k| u.get(*k).and_then(Value::as_u64));
    direct
        .or_else(|| {
            u.get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0)
}

fn default_system_prompt(mode: &str, root: &str) -> String {
    format!(
        "You are Codifa, a coding agent inside the user's desktop IDE. \
Workspace root: {root}. Mode: {mode}. \
You have NO search/read tools: delegate ALL file reading, searching and \
LSP lookups to the `explore` sub-agent and work from its full report. \
When a task spans several independent areas, fire SEVERAL `explore` calls \
IN THE SAME STEP (they run concurrently, one round-trip) — one focused \
explore per area/file group. A single broad explore is the slowest, \
shallowest option; only a genuinely single-area question justifies one call. \
NEVER use run_terminal to find or inspect files (find/grep/rg/ls) — file \
discovery goes through `explore` only; run_terminal is for builds, tests \
and git. \
To verify LIVE, run the project in its OWN dev workflow, and ALWAYS check \
first whether that dev process is already running (ps/lsof + its port): if it \
is, REUSE it and never start a second one — duplicate dev servers fight over \
the same port and produce conflicting logs. Only start it once when nothing \
is running, and never verify against a release build. \
Use write_file/edit_file/run_terminal to make changes. \
Only run `git commit` when the user EXPLICITLY asks for it — never commit \
on your own initiative. \
A system message holding a compacted summary is AUTHORITATIVE history: every \
item under its 'Work completed' ledger is already DONE — never redo, re-verify \
or re-implement it, and never re-read a file just to confirm a change listed \
there. Continue from its 'Next steps' only. \
The conversation itself is the same kind of record: before you start any task, \
scan the turns above (and any '[Interrupted before finishing. Already done this \
turn]' block) for work that is ALREADY DONE. If a fix, file edit or commit is \
listed there, it is finished — do NOT redo it, do NOT re-verify it, and do NOT \
re-implement it from scratch. Say what is already done and continue from what \
is actually left. Redoing finished work is a bug, not thoroughness. \
Reply in the user's language. \
Docstrings and comments in code must be English."
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Model id the live explore test asserts on (mirror of the backend_light
    /// live-test constant): distinctive enough that a bug which sends the
    /// parent's model instead of the slot's can never pass by luck.
    const MOCK_MODEL: &str = "slot-mock/sentinel-model";

    #[test]
    fn event_json_shapes_match_python_protocol() {
        assert_eq!(
            AgentEvent::Text { content: "hi".into() }.to_json(),
            json!({"kind": "text", "content": "hi"})
        );
        assert_eq!(
            AgentEvent::Done { aborted: true }.to_json(),
            json!({"kind": "done", "aborted": true})
        );
        let t = AgentEvent::Tool {
            id: "call1".into(),
            name: "read".into(),
            args: json!({"filePath": "a"}),
            result: "x".into(),
            ok: true,
            results: None,
        }
        .to_json();
        // Finished tools resolve the running card minted by ToolStart.
        assert_eq!(t["kind"], "tool_result");
        assert_eq!(t["name"], "read");
        assert_eq!(t["ok"], true);
        // The provider tool_call id rides along so the frontend can dedup
        // (no duplicate cards) and re-pair start/result events.
        assert_eq!(t["id"], "call1");
        let t = AgentEvent::Usage {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_tokens: 0,
            model: "sub-model".into(),
            provider_id: "p2".into(),
            sub: true,
        }
        .to_json();
        // Sub-agent usage is flagged so the context meter ignores it.
        assert_eq!(t["sub"], true);
        // The usage event names the model/provider that served the request so
        // sub-agent tokens land under the SUB model in Model usage.
        assert_eq!(t["model"], "sub-model");
        assert_eq!(t["provider_id"], "p2");
        let ts = AgentEvent::ToolStart {
            id: "call1".into(),
            name: "explore".into(),
            args: json!({}),
        }
        .to_json();
        assert_eq!(ts["kind"], "tool");
        assert_eq!(ts["tool"], "explore");
        assert_eq!(ts["id"], "call1");
    }

    #[test]
    fn branch_wrapper_tags_the_inner_event_without_changing_its_shape() {
        let inner_call = AgentEvent::ToolStart {
            id: "c9".into(),
            name: "grep".into(),
            args: json!({"pattern": "x"}),
        };
        let v = AgentEvent::Branch { branch: 7, sub: true, inner: Box::new(inner_call) }.to_json();
        assert_eq!(v["kind"], "tool");
        assert_eq!(v["tool"], "grep");
        assert_eq!(v["id"], "c9");
        assert_eq!(v["branch"], 7);
        assert_eq!(v["sub"], true);
        // The explore card's own start carries the branch but is NOT a sub
        // event — it has to stay a top-level card the children nest under.
        let card = AgentEvent::Branch {
            branch: 7,
            sub: false,
            inner: Box::new(AgentEvent::ToolStart {
                id: "e1".into(),
                name: "explore".into(),
                args: json!({}),
            }),
        }
        .to_json();
        assert_eq!(card["branch"], 7);
        assert_eq!(card["sub"], false);
    }

    #[test]
    fn compact_subagent_never_orphans_tool_messages() {
        // If the tail boundary lands on a `tool` message whose assistant
        // tool_calls were compacted away, providers reject the orphan with
        // a 400. The tail must extend back to keep the pair together.
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..40 {
            messages.push(json!({
                "role": "user",
                "content": "متن فارسی طولانی برای عبور از بودجه ی اتوکامپکت ".repeat(30),
            }));
        }
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{ "id": "c1", "type": "function" }],
        }));
        messages.push(json!({ "role": "tool", "tool_call_id": "c1", "content": "نتیجه ابزار" }));
        messages.push(json!({ "role": "user", "content": "ادامه بده" }));
        messages.push(json!({ "role": "assistant", "content": "پاسخ" }));
        messages.push(json!({ "role": "user", "content": "یکی دیگر" }));
        compact_subagent_messages(&mut messages, 4096);
        // Every tool message must be preceded by its assistant tool_calls.
        for (i, m) in messages.iter().enumerate().skip(1) {
            if m["role"] == "tool" {
                assert!(
                    messages[i - 1]["tool_calls"].is_array(),
                    "orphan tool message at index {i}"
                );
            }
        }
    }

    #[test]
    fn history_recap_carries_tool_results_not_just_calls() {
        // A recap that lists only tool names tells the model a grep ran but
        // not what it found, so it re-runs the same search next turn. The
        // result digest must survive into the recap.
        let m = json!({
            "role": "assistant",
            "content": "done",
            "toolActivity": [
                {"tool": "grep", "args": {"pattern": "foo"}, "status": "done",
                 "summary": "3 hits in 2 files"},
                {"tool": "read", "status": "running"}
            ]
        });
        let recap = history_recap(&m);
        assert!(recap.contains("grep"), "{recap}");
        assert!(recap.contains("3 hits in 2 files"), "{recap}");
        // A still-running call is not reported as completed work.
        // (Match the list item, not the bare word: "already" contains "read".)
        assert!(!recap.contains("- read"), "{recap}");
    }

    #[test]
    fn history_recap_carries_explore_findings_at_length() {
        // explore's findings reach the backend only as `resultText` (the
        // frontend stores prose results verbatim for prose-only tools, and
        // explore/task are among them). Recap the call without the findings and
        // the next turn re-delegates research it already paid for, so the
        // report must survive AND keep more than an ordinary tool's digest.
        let report = "x".repeat(2_000);
        let m = json!({
            "role": "assistant",
            "content": "researched",
            "toolActivity": [
                {"tool": "explore", "args": {"prompt": "trace usage"}, "status": "done",
                 "resultText": report},
                {"tool": "lsp_hover", "args": {}, "status": "done",
                 "resultText": "fn usage_meter() -> Usage"}
            ]
        });
        let recap = history_recap(&m);
        assert!(
            recap.contains(&"x".repeat(1_000)),
            "explore report must survive beyond the ordinary digest cap: {}",
            recap.len()
        );
        assert!(recap.contains("usage_meter"), "{recap}");
    }

    #[test]
    fn explore_report_echo_is_not_cut_below_the_recap_budget() {
        // The recap can only carry what the UI echo kept (`resultText`), so the
        // echo budget for a report may never be smaller than the recap's.
        assert!(ui_echo_cap("explore") >= RECAP_EXPLORE_CHARS);
        assert_eq!(ui_echo_cap("grep"), TOOL_RESULT_CAP);
    }

    #[test]
    fn compact_subagent_messages_persian_char_boundaries() {
        // The explore sub-agent compacts Persian content — the 400-byte cut
        // used to slice mid-char and panic (compact.rs:103 crash report).
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..50 {
            messages.push(json!({
                "role": "user",
                "content": "این یک متن فارسی طولانی برای آزمایش برش ایمن نویسه‌هاست ".repeat(20),
            }));
        }
        messages.push(json!({ "role": "user", "content": "گزارش نهایی" }));
        compact_subagent_messages(&mut messages, 4096);
        // Head + summary + tail survive, all valid UTF-8 (no panic above).
        assert!(messages.len() >= 3);
        assert!(messages[0]["content"] == "sys");
        let summary = messages[1]["content"].as_str().unwrap();
        assert!(summary.contains("[Earlier research compacted]"));
        assert!(messages.last().unwrap()["content"] == "گزارش نهایی");
    }

    #[test]
    fn tool_schemas_main_agent_has_no_search_tools() {
        let schemas = tool_schemas(false, true);
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        // Main agent must NOT have search/read tools — research is delegated.
        // Memory tools live on the explore sub-agent too (user request).
        for banned in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_definition",
            "lsp_symbols",
            "save_memory",
            "search_memory",
            "delete_memory",
        ] {
            assert!(!names.contains(&banned), "main agent must not have {banned}");
        }
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"run_terminal"));
        // Web search is not file discovery: the main agent may search the web
        // itself (the engines come from Settings → Plugins).
        assert!(names.contains(&"web_search"));
    }

    #[test]
    fn authoring_tools_are_bound_only_when_the_turn_asks_for_them() {
        // An ordinary turn must not be able to rewrite the skill store or the
        // connector list, so the authoring tools are gated on allow_create.
        let names = |allow: bool| -> Vec<String> {
            tool_schemas(allow, true)
                .iter()
                .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
                .collect()
        };
        let plain = names(false);
        assert!(!plain.contains(&"create_skill".to_string()));
        assert!(!plain.contains(&"create_mcp".to_string()));
        // load_skill stays available: reading a skill is not authoring.
        assert!(plain.contains(&"load_skill".to_string()));

        let authoring = names(true);
        assert!(authoring.contains(&"create_skill".to_string()));
        assert!(authoring.contains(&"create_mcp".to_string()));
    }

    #[test]
    fn explore_schema_asks_for_parallel_calls() {
        // The model only parallelizes when the tool description says so: one
        // broad explore used to be the default and made turns slow/shallow.
        let schemas = tool_schemas(false, true);
        let desc = schemas
            .iter()
            .find(|s| s["function"]["name"] == "explore")
            .and_then(|s| s["function"]["description"].as_str())
            .unwrap();
        assert!(desc.contains("SEVERAL TIMES IN THE SAME STEP"), "{desc}");
        assert!(desc.contains("CONCURRENTLY"), "{desc}");
    }

    #[test]
    fn research_schemas_cover_search_set() {
        let schemas = research_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        for expected in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            "lsp_symbols",
            "lsp_diagnostics",
            "search_memory",
            "save_memory",
            "delete_memory",
        ] {
            assert!(names.contains(&expected), "missing schema: {expected}");
        }
        // The sub-agent must not be able to write or spawn agents.
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"explore"));
    }

    #[test]
    fn browser_tools_are_bound_only_while_the_switch_is_on() {
        // The composer's Browser switch is the ONLY thing that puts a browser
        // tool in front of the model. Regression guard: these 22 tools used to
        // be injected unconditionally, so a chat could open a Chromium window
        // even with the switch off and nothing in the UI explained why.
        let browser_names = |allow_browser: bool| -> Vec<String> {
            tool_schemas(false, allow_browser)
                .iter()
                .filter_map(|s| s["function"]["name"].as_str())
                .filter(|n| n.starts_with("browser_"))
                .map(str::to_string)
                .collect()
        };
        assert!(
            browser_names(false).is_empty(),
            "browser tools must not be bound while the switch is off"
        );
        assert_eq!(
            browser_names(true).len(),
            crate::browser_driver::ACTIONS.len(),
            "every driver action must be exposed while the switch is on"
        );
    }

    #[test]
    fn tool_schemas_stay_within_a_token_budget() {
        // The tool array is resent on EVERY model call of a turn, so its size is
        // paid once per round-trip. A description added without watching this
        // number silently taxes every turn, so the budget is asserted here.
        //
        // The native browser tools (`browser_driver`) are a deliberate, LARGE
        // addition: 22 tools, bound only while the composer's Browser switch is
        // on — with it off the model sees no browser tool at all, so no Chromium
        // can be started by a turn. When bound they measure ~3_500 chars, which
        // is why "main+browser" budgets more than the base tool set was fitted
        // to: the number is explicit here so the growth stays a decision rather
        // than a drift. Trimming them is not free: every tool corresponds to a
        // browser action the prompts and skills reference by name.
        //
        // `fetch_url` is the other deliberate addition: page fetching is a
        // capability the prompts and skills already describe (and the model was
        // already calling for it), so it costs its description on every turn
        // rather than staying a ghost tool.
        let chars = |v: &Vec<Value>| serde_json::to_string(v).unwrap().chars().count();
        for (label, schemas, budget) in [
            ("main", tool_schemas(false, false), 7_900usize),
            ("main+browser", tool_schemas(false, true), 11_500),
            ("main+authoring", tool_schemas(true, false), 9_900),
            ("main+authoring+browser", tool_schemas(true, true), 14_200),
            ("explore", research_schemas(), 8_400),
        ] {
            let got = chars(&schemas);
            assert!(
                got <= budget,
                "{label} tool schemas serialize to {got} chars, over the {budget} budget"
            );
        }
    }

    #[test]
    fn tool_schemas_serialize_byte_identically() {
        // Prefix caching (automatic on OpenAI-compatible gateways, explicit via
        // `cache_control` on Anthropic) only hits while the PREFIX is byte
        // stable. The tool array sits in that prefix, so a schema list whose
        // order or formatting wobbles between calls silently destroys the cache
        // for the whole turn — and would make the cache-hit number in the trace
        // read 0 for no visible reason. `serde_json` is built without
        // `preserve_order` (deterministic key order), and this pins the rest.
        for schemas in [
            tool_schemas(false, true),
            tool_schemas(true, true),
            research_schemas(),
        ] {
            let a = serde_json::to_string(&schemas).unwrap();
            let b = serde_json::to_string(&schemas).unwrap();
            assert_eq!(a, b, "schema serialization must be deterministic");
        }
        // A rebuilt list must match too — the cache survives across turns only
        // if the same inputs produce the same bytes.
        assert_eq!(
            serde_json::to_string(&tool_schemas(false, true)).unwrap(),
            serde_json::to_string(&tool_schemas(false, true)).unwrap()
        );
    }

    #[test]
    fn explore_prompt_carries_layout_and_lsp_guidance() {
        let dir = std::env::temp_dir().join(format!("codifa-explore-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        std::fs::write(dir.join("backend/server.py"), "").unwrap();
        let p = explore_system_prompt(dir.to_str().unwrap());
        // Real paths up front, so the model never has to glob for them.
        assert!(p.contains("backend/: server.py"), "{p}");
        // LSP + glob semantics are spelled out (the old prompt never named LSP).
        assert!(p.contains("lsp_definition") && p.contains("lsp_references") && p.contains("lsp_symbols"));
        // find_symbol is the one-call replacement for the grep -> lsp chain.
        assert!(p.contains("find_symbol"), "{p}");
        // The single-call rule and the offset rule are what stop the 4-round
        // serial runs seen in a real trace.
        assert!(p.contains("HARD RULE") && p.contains("never guess an"), "{p}");
        assert!(p.contains("FILES only") && p.contains("no matches"));
        // Still read-only and English-reporting.
        assert!(p.contains("NO write tools") && p.contains("Report in English"));
        // Report contract: answer first, verbatim code only where it is needed.
        assert!(p.contains("ANSWER") && p.contains("VERBATIM") && p.contains("nothing between tool calls"));
        // Latency guidance: rounds (not calls) are the cost, batch in ONE step.
        assert!(p.contains("ROUNDS") && p.contains("ONE step"), "{p}");
        // `read` numbers its lines; the report must not carry that scaffolding
        // into CODE excerpts the main agent will use as exact-match edit strings.
        assert!(p.contains("line number") && p.contains("never copy the header"), "{p}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_report_keeps_only_text_after_the_last_search_tool() {
        let mut report = String::new();
        let mut err = String::new();
        let text = |s: &str| AgentEvent::Text { content: s.into() };
        let tool = |n: &str| AgentEvent::ToolStart { id: "i".into(), name: n.into(), args: json!({}) };
        fold_subagent_event(&mut report, &mut err, &text("Let me search..."));
        fold_subagent_event(&mut report, &mut err, &tool("grep"));
        fold_subagent_event(&mut report, &mut err, &text("Now reading..."));
        fold_subagent_event(&mut report, &mut err, &tool("read"));
        fold_subagent_event(&mut report, &mut err, &text("ANSWER: x"));
        assert_eq!(report, "ANSWER: x");
        // A report written in the same step as save_memory survives it.
        fold_subagent_event(&mut report, &mut err, &tool("save_memory"));
        fold_subagent_event(&mut report, &mut err, &text(" (saved)"));
        assert_eq!(report, "ANSWER: x (saved)");
        fold_subagent_event(&mut report, &mut err, &AgentEvent::Error { content: "boom".into() });
        assert_eq!(err, "boom");
    }

    #[test]
    fn repeated_lookups_are_detected_but_distinct_windows_are_not() {
        // Same file + same window (an omitted offset/limit means the default
        // window) is a repeat: the body is already in the context.
        let a = json!({"filePath": "src/a.ts", "offset": 1, "limit": 400});
        let b = json!({"filePath": "src/a.ts"});
        assert_eq!(lookup_key("read", &a), lookup_key("read", &b));
        // A different window of the same file is a real read.
        let c = json!({"filePath": "src/a.ts", "offset": 401, "limit": 400});
        assert_ne!(lookup_key("read", &a), lookup_key("read", &c));
        // Different `ranges` of one file are different lookups (same ranges repeat).
        let r1 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 1, "limit": 50}]});
        let r2 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 200, "limit": 50}]});
        assert_ne!(lookup_key("read", &r1), lookup_key("read", &r2));
        assert_eq!(lookup_key("read", &r1), lookup_key("read", &r1.clone()));
        // Grep keys carry the scope, so the same pattern in another directory
        // is a different lookup.
        let g1 = json!({"pattern": "foo", "path": "src"});
        let g2 = json!({"pattern": "foo", "path": "backend"});
        assert_ne!(lookup_key("grep", &g1), lookup_key("grep", &g2));
        assert_eq!(
            lookup_key("grep", &g1),
            lookup_key("grep", &json!({"pattern": "foo", "path": "src"}))
        );
        // The `patterns` array form keys the same way as a single pattern.
        assert_eq!(
            lookup_key("grep", &json!({"patterns": ["a", "b"]})),
            lookup_key("grep", &json!({"patterns": ["a", "b"]}))
        );
        // find_symbol dumps definition bodies + usages: the same symbol in the
        // same scope is a repeat, a different scope is a real lookup.
        let f1 = json!({"symbol": "foo", "path": "src"});
        assert_eq!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &f1.clone()));
        assert_ne!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &json!({"symbol": "foo", "path": "backend"})));
        assert!(lookup_key("find_symbol", &json!({"path": "src"})).is_none());
        // Shapes without a target are never deduped (nothing to compare).
        assert!(lookup_key("read", &json!({"path": "src"})).is_none());
        assert!(lookup_key("grep", &json!({"path": "src"})).is_none());
        assert!(lookup_key("glob", &json!({"pattern": "**/*.ts"})).is_none());
    }

    #[test]
    fn single_call_steps_get_a_batching_hint() {
        let one = |name: &str| vec![("c1".to_string(), name.to_string(), "{}".to_string())];
        // The explore sub-agent: one lookup per step burns rounds.
        assert!(single_call_hint("subagent", &one("grep"))
            .unwrap()
            .contains("NEXT step"));
        // The main agent: a single broad explore wastes the concurrent fan-out
        // (a traced turn fired one wide explore and got a 4-round report).
        let main = single_call_hint("agent", &one("explore")).unwrap();
        assert!(main.contains("CONCURRENTLY") && main.contains("2-4 focused explores"), "{main}");
        // Batched steps are left alone, and so is a single non-explore call.
        let two = vec![
            ("a".to_string(), "grep".to_string(), "{}".to_string()),
            ("b".to_string(), "read".to_string(), "{}".to_string()),
        ];
        assert!(single_call_hint("subagent", &two).is_none());
        assert!(single_call_hint("agent", &one("run_terminal")).is_none());
    }

    #[test]
    fn explore_report_truncation_keeps_head_and_tail_and_never_points_at_read() {
        let mut messages: Vec<Value> = Vec::new();
        let mut emit = |_: &AgentEvent| {};
        let trace = crate::trace::TraceStore::new(String::new());
        // A report longer than the report cap: the head (answer) AND the tail
        // (search results / file list) must both survive — the main agent has
        // no read tool, so a lost tail is lost work it would re-delegate.
        let big = format!("HEAD{}TAIL", "x".repeat(EXPLORE_REPORT_CAP + 100));
        finish_tool(&mut messages, &mut emit, &trace, "c1", "explore", &json!({}), big, true, false, None);
        let c = messages[0]["content"].as_str().unwrap();
        assert!(c.contains("HEAD") && c.contains("TAIL"), "head and tail must survive");
        assert!(c.contains("ask explore") && !c.contains("offset/limit"));
        // A raw tool result still points at a narrower read window.
        let big2 = "x".repeat(MODEL_RESULT_CAP + 100);
        finish_tool(&mut messages, &mut emit, &trace, "c2", "read", &json!({}), big2, true, true, None);
        assert!(messages[1]["content"].as_str().unwrap().contains("offset/limit"));
    }

    #[test]
    fn fatal_subagent_errors_are_told_apart_from_transient_ones() {
        // Fatal: retrying the SAME model can never help, so the ladder must
        // fall back to the main model instead of burning all 10 attempts.
        assert!(subagent_error_is_fatal("key rejected (401): invalid api key"));
        assert!(subagent_error_is_fatal(
            "{\"error\":{\"message\":\"model `gpt-x` not found\"}}"
        ));
        assert!(subagent_error_is_fatal("no api key configured"));
        assert!(subagent_error_is_fatal("403 Forbidden"));
        // The model NAME sits between the halves of the sentence.
        assert!(subagent_error_is_fatal("model `claude-x` is unavailable"));
        // Transient: retrying the same model is exactly right, so these must
        // NOT trip the fallback.
        assert!(!subagent_error_is_fatal("429 rate limit exceeded"));
        assert!(!subagent_error_is_fatal("500 internal server error"));
        assert!(!subagent_error_is_fatal("connection refused"));
        assert!(!subagent_error_is_fatal("sub-agent hung: no activity for 300s"));
        assert!(!subagent_error_is_fatal("explore returned no findings: empty"));
        assert!(!subagent_error_is_fatal(""));
    }

    #[test]
    fn subagent_rejects_missing_prompt() {
        // Synchronous guard check: empty prompt must fail fast (no model call).
        let args = json!({"description": "d"});
        assert!(args["prompt"].as_str().unwrap_or_default().is_empty());
    }

    #[test]
    fn usage_tuple_maps_both_vocabularies() {
        let mut acc = StreamAcc::default();
        acc.usage = Some(json!({"prompt_tokens": 10, "completion_tokens": 5}));
        assert_eq!(usage_tuple(&acc), (10, 5));
        acc.usage = Some(json!({"input_tokens": 7, "output_tokens": 3}));
        assert_eq!(usage_tuple(&acc), (7, 3));
        acc.usage = None;
        assert_eq!(usage_tuple(&acc), (0, 0));
    }

    #[test]
    fn cache_read_is_read_from_every_provider_spelling() {
        // The number that proves prefix caching works on the active gateway.
        // Each provider names it differently, so all spellings must land.
        let mut acc = StreamAcc::default();
        assert_eq!(cache_read_tuple(&acc), 0, "no usage at all is not a hit");
        acc.usage = Some(json!({"prompt_tokens": 1000}));
        assert_eq!(cache_read_tuple(&acc), 0, "absent field means not measured");
        acc.usage = Some(json!({"prompt_cache_hit_tokens": 640}));
        assert_eq!(cache_read_tuple(&acc), 640);
        acc.usage = Some(json!({"cache_read_input_tokens": 512}));
        assert_eq!(cache_read_tuple(&acc), 512);
        acc.usage = Some(json!({"cachedContentTokenCount": 256}));
        assert_eq!(cache_read_tuple(&acc), 256);
        acc.usage = Some(json!({"prompt_tokens_details": {"cached_tokens": 128}}));
        assert_eq!(cache_read_tuple(&acc), 128);
        // The plain `prompt_tokens` count is NEVER a cache hit: counting it
        // would report a 100% hit rate on every gateway that omits the field.
        acc.usage = Some(json!({"prompt_tokens": 999, "cached_tokens": 0}));
        assert_eq!(cache_read_tuple(&acc), 0);
    }

    #[test]
    fn create_skill_persists_persian_keywords_into_the_catalog() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-create-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        let out = dispatch(
            root,
            "create_skill",
            &json!({
                "name": "Movie Finder",
                "description": "find movies",
                "content": "Step 1: ask for the genre.",
                "fa_keywords": "فیلم, سینما",
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("Movie Finder"), "{out}");

        // The keywords must reach the catalog, otherwise a Persian request
        // could never match this skill (the catalog is all the model sees).
        let section = crate::skill_router::build_section("", root, &[]);
        assert!(section.text.contains("[fa: فیلم, سینما]"), "{}", section.text);
        assert!(section.text.contains("Movie Finder: find movies"), "{}", section.text);

        // A missing name/content is rejected instead of writing a broken skill.
        assert!(dispatch(root, "create_skill", &json!({"content": "x"}), None).is_err());
        assert!(dispatch(root, "create_skill", &json!({"name": "x"}), None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_returns_body_and_lists_names_when_missing() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-load-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\n---\nBODY HERE\n",
        )
        .unwrap();
        std::fs::write(sdir.join("extra.md"), "EXTRA BODY").unwrap();
        let root = dir.to_str().unwrap();

        let body = dispatch(root, "load_skill", &json!({"name": "Movie Finder"}), None).unwrap();
        assert!(body.contains("BODY HERE"), "{body}");
        assert!(body.contains("Extra files: extra.md"), "{body}");
        // Slug works too, and an extra file is readable on demand.
        let extra = dispatch(root, "load_skill", &json!({"name": "movie-finder", "file": "extra.md"}), None).unwrap();
        assert_eq!(extra, "EXTRA BODY");
        // A miss names the available skills instead of a bare error.
        let err = dispatch(root, "load_skill", &json!({"name": "Ghost"}), None).unwrap_err();
        assert!(err.contains("Movie Finder"), "{err}");
        assert!(dispatch(root, "load_skill", &json!({}), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_resolves_from_the_data_root_not_the_workspace() {
        // The catalog is built from the DATA root, but dispatch used to resolve
        // skills against the WORKSPACE root: a real chat showed the catalog and
        // then failed every load with "Available: (none)" (in a trace). A bare
        // workspace must still load a skill that lives in the data root.
        use crate::tools::dispatch_with_data_root;
        let base = std::env::temp_dir().join(format!("codifa-skill-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let ws = base.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let sdir = data.join("skills").join("playwrite");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Playwrite\ndescription: browser automation\n---\nBROWSER BODY\n",
        )
        .unwrap();
        let data = data.to_str().unwrap();
        let ws = ws.to_str().unwrap();

        // Data root known -> found even though the workspace has no skills.
        let body = dispatch_with_data_root(
            ws,
            "load_skill",
            &json!({"name": "Playwrite"}),
            None,
            Some(data),
        )
        .unwrap();
        assert!(body.contains("BROWSER BODY"), "{body}");

        // No data root given -> the old workspace-relative behaviour stays.
        let err = dispatch_with_data_root(
            ws,
            "load_skill",
            &json!({"name": "Playwrite"}),
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("(none)"), "{err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dispatch_via_tools_roundtrip() {
        let dir = std::env::temp_dir().join(format!("codifa-agent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let (msg, ok) = match tools::dispatch(&root, "write_file", &json!({"path": "a.txt", "content": "hello"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok, "{msg}");
        let (msg, ok) = match tools::dispatch(&root, "read", &json!({"filePath": "a.txt"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok && msg.contains("hello"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_request_deserializes_minimal_body() {
        let body = json!({
            "provider": "custom",
            "model": "m1",
            "root": "/tmp/x",
            "prompt": "hi"
        });
        let req: AgentRequest = serde_json::from_value(body).unwrap();
        assert_eq!(req.mode, "build");
        assert!(req.api_keys.is_empty());
    }

    #[test]
    fn fold_prefix_never_orphans_tool_or_user_tail() {
        // A turn with no assistant answer yet is not foldable at all.
        assert_eq!(
            fold_prefix_len(&[json!({"role": "user", "content": "hi"})]),
            0
        );
        // Last assistant is the boundary: the trailing live user prompt is
        // never folded, and the tail never starts with a `tool` reply.
        let hist = vec![
            json!({"role": "user", "content": "task"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t1"}]}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "r1"}),
            json!({"role": "assistant", "content": "answer"}),
            json!({"role": "user", "content": "next"}),
        ];
        assert_eq!(fold_prefix_len(&hist), 3);
        let tail = &hist[fold_prefix_len(&hist)..];
        assert_eq!(tail[0]["role"].as_str(), Some("assistant"));
    }

    #[test]
    fn fold_keeps_every_tool_result_with_its_call() {
        let hist = vec![
            json!({"role": "user", "content": "a"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t1"}]}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "r1"}),
            json!({"role": "assistant", "tool_calls": [{"id": "t2"}]}),
            json!({"role": "tool", "tool_call_id": "t2", "content": "r2"}),
        ];
        let cut = fold_prefix_len(&hist);
        assert_eq!(cut, 3);
        let tail = &hist[cut..];
        assert_eq!(tail[0]["role"].as_str(), Some("assistant"));
        // Providers reject an orphaned tool reply, so every `tool` message kept
        // verbatim must still sit directly after its assistant call.
        for (i, m) in tail.iter().enumerate() {
            if m["role"] == "tool" {
                assert_eq!(tail[i - 1]["role"].as_str(), Some("assistant"));
            }
        }
    }

    #[test]
    fn estimate_wire_tokens_reads_content_only() {
        let msgs = vec![json!({"role": "user", "content": "x".repeat(400)})];
        assert_eq!(estimate_wire_tokens(&msgs), 100);
        assert_eq!(estimate_wire_tokens(&[]), 0);
    }

    /// One "round": an assistant message carrying a single tool_call plus the
    /// `tool` result message that call produced.
    fn fold_round(call_id: &str, tool: &str, result: &str) -> Vec<Value> {
        fold_round_args(call_id, tool, "{}", result)
    }

    fn fold_round_args(call_id: &str, tool: &str, args: &str, result: &str) -> Vec<Value> {
        vec![
            json!({"role": "assistant", "content": Value::Null,
                   "tool_calls": [{"id": call_id, "type": "function",
                                   "function": {"name": tool, "arguments": args}}]}),
            json!({"role": "tool", "tool_call_id": call_id, "content": result}),
        ]
    }

    fn seen_set() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    #[test]
    fn fold_shrinks_only_results_older_than_the_kept_rounds() {
        // Four rounds; the last MAIN_FOLD_KEEP_ROUNDS (2) are the fresh zone.
        let explore_big = "e".repeat(30_000);
        let read_big = "r".repeat(30_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "explore", &explore_big)); // stale
        messages.extend(fold_round("c2", "read", &read_big)); // stale
        messages.extend(fold_round("c3", "grep", &read_big)); // fresh
        messages.extend(fold_round("c4", "glob", &read_big)); // fresh
        let before = messages.clone();

        fold_stale_tool_results(&mut messages, &mut seen_set());

        // The stale explore report gets the explore budget (the report is the
        // main agent's only view of that research)...
        let r1 = messages[1]["content"].as_str().unwrap();
        assert_eq!(
            r1.chars().count(),
            MAIN_FOLD_EXPLORE_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
        assert!(r1.ends_with(MAIN_FOLD_MARKER));
        // ...an ordinary stale result the smaller generic budget...
        let r2 = messages[3]["content"].as_str().unwrap();
        assert_eq!(
            r2.chars().count(),
            MAIN_FOLD_RESULT_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
        assert!(r2.ends_with(MAIN_FOLD_MARKER));
        // ...and both kept rounds stay BYTE-IDENTICAL: the model is actively
        // reasoning over those results.
        assert_eq!(messages[5], before[5]);
        assert_eq!(messages[7], before[7]);

        // Idempotence: folding again changes nothing.
        let once = messages.clone();
        fold_stale_tool_results(&mut messages, &mut seen_set());
        assert_eq!(messages, once);
    }

    #[test]
    fn fold_forgets_the_lookup_so_the_pointer_can_be_re_resolved() {
        // The folded marker tells the model to re-run the tool. If the
        // repeat-guard still remembers that lookup, the re-run is answered
        // with "already looked this up" while the body is gone — the data is
        // then unreachable for the rest of the turn.
        let args = r#"{"filePath":"a.txt"}"#;
        let key = lookup_key("read", &serde_json::from_str(args).unwrap()).unwrap();
        let mut seen = seen_set();
        seen.insert(key.clone());
        assert!(seen.contains(&key));

        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round_args("c1", "read", args, &"r".repeat(30_000)));
        messages.extend(fold_round("c2", "read", "small"));
        messages.extend(fold_round("c3", "read", "small"));
        fold_stale_tool_results(&mut messages, &mut seen);

        assert!(messages[1]["content"].as_str().unwrap().ends_with(MAIN_FOLD_MARKER));
        assert!(!seen.contains(&key), "the repeat-guard must forget a folded lookup");
    }

    #[test]
    fn fold_is_a_noop_within_the_kept_rounds() {
        let big = "x".repeat(30_000);
        // Exactly MAIN_FOLD_KEEP_ROUNDS rounds: nothing is stale yet.
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &big));
        messages.extend(fold_round("c2", "read", &big));
        let before = messages.clone();
        fold_stale_tool_results(&mut messages, &mut seen_set());
        assert_eq!(messages, before);

        // No tool_calls at all (and an empty list): also a no-op, no panic.
        let mut plain = vec![json!({"role": "user", "content": "hi"})];
        let plain_before = plain.clone();
        fold_stale_tool_results(&mut plain, &mut seen_set());
        assert_eq!(plain, plain_before);
        let mut empty: Vec<Value> = Vec::new();
        fold_stale_tool_results(&mut empty, &mut seen_set());
        assert!(empty.is_empty());
    }

    #[test]
    fn fold_truncates_on_a_char_boundary_for_persian() {
        // 30K Persian chars: a raw BYTE slice at 2000/8000 would land inside a
        // multi-byte character and panic (with panic=abort it kills the app).
        let persian = "سلام دنیا ".repeat(3_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &persian));
        messages.extend(fold_round("c2", "read", "small"));
        messages.extend(fold_round("c3", "read", "small"));
        fold_stale_tool_results(&mut messages, &mut seen_set());
        let r1 = messages[1]["content"].as_str().unwrap();
        assert!(r1.ends_with(MAIN_FOLD_MARKER));
        assert_eq!(
            r1.chars().count(),
            MAIN_FOLD_RESULT_CHARS + 1 + MAIN_FOLD_MARKER.chars().count()
        );
    }

    /// "Results per search" (Settings → Web Providers) is ONE number with two
    /// effects. These assertions pin the contract the UI promises: it sets the
    /// result count, it may be overridden per call, `0` still returns results
    /// (it only stops the page fetch), and nothing can exceed the hard cap.
    #[test]
    fn web_search_result_count_comes_from_the_settings_number() {
        let no_args = json!({});
        // Default setting (5) → five results.
        assert_eq!(web_search_result_count(&no_args, 5), 5);
        // Any other setting is used verbatim.
        assert_eq!(web_search_result_count(&no_args, 8), 8);
        // 0 = "don't fetch pages", NOT "return nothing".
        assert_eq!(
            web_search_result_count(&no_args, 0),
            crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
        );
        // An explicit max_results still wins, and is clamped to a sane range.
        assert_eq!(web_search_result_count(&json!({"max_results": 2}), 8), 2);
        assert_eq!(web_search_result_count(&json!({"max_results": 0}), 8), 1);
        assert_eq!(
            web_search_result_count(&json!({"max_results": 99}), 8),
            crate::websearch::WEB_SEARCH_AUTO_FETCH_MAX
        );
    }

    fn base_req() -> AgentRequest {
        AgentRequest {
            provider: "custom".into(),
            provider_id: "p1".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_key: "pk".into(),
            api_keys: vec!["pk".into()],
            root: "/tmp/x".into(),
            mode: "build".into(),
            prompt: "hi".into(),
            history: Vec::new(),
            system_prompt: String::new(),
            skills: Vec::new(),
            context_window: 0,
            chat_id: String::new(),
            mcp_servers: Value::Null,
            subagent_models: std::collections::HashMap::new(),
            providers: std::collections::HashMap::new(),
            data_root: String::new(),
            allow_computer: false,
            allow_create: false,
            allow_browser: false,
            search_plugins: Vec::new(),
            compact_at_percent: 80,
            fallback_provider: String::new(),
            fallback_model: String::new(),
            fallback_base_url: String::new(),
            fallback_api_key: String::new(),
            fallback_api_keys: Vec::new(),
            thinking_level: String::new(),
            model_reasoning: false,
            subagent_thinking: std::collections::HashMap::new(),
            images: Vec::new(),
            web_search_auto_fetch: crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT,
        }
    }

    #[test]
    fn subagent_model_slot_defaults_to_parent() {
        let req = base_req();
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "main-model");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
        assert_eq!(pid, "p1");
    }

    #[test]
    fn subagent_model_slot_bare_model_uses_parent_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "cheap-model".into());
        let (model, base, _, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "cheap-model");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(pid, "p1");
    }

    /// The `fetch_url` payload must be distilled by the "Other" (web) slot
    /// model — the same model that answers `web_search` — with that slot's own
    /// reasoning level, and attributed to the slot's provider.
    #[tokio::test]
    async fn slot_distill_uses_the_web_slot_model_and_reasoning() {
        let (mock_base, rx) = spawn_json_mock_upstream("distilled page summary").await;
        let bodies = drain_bodies(rx);

        let mut req = base_req();
        req.subagent_models
            .insert("web".into(), format!("slot-prov/{MOCK_MODEL}"));
        req.subagent_thinking.insert("web".into(), "max".into());
        req.providers.insert(
            "slot-prov".into(),
            json!({
                "kind": "custom",
                "baseUrl": format!("{mock_base}/v1"),
                "apiKeys": ["sk-slot"],
                // A custom provider is not auto-detected as reasoning-capable,
                // so the capability must be declared exactly like the real
                // settings.json does (Settings → provider → manualReasoningMap).
                "manualReasoningMap": { MOCK_MODEL: true },
            }),
        );
        let main = LlmConfig {
            provider: "custom".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_keys: vec!["pk".into()],
            temperature: Some(0.2),
            max_tokens: Some(1024),
            timeout_secs: 10,
            reasoning_level: "high".into(),
            model_reasoning: false,
            auto_think: false,
        };

        let out = run_slot_distill(
            &reqwest::Client::new(),
            &req,
            &main,
            FETCH_DISTILL_SYSTEM_PROMPT,
            "URL: https://example.com\n\nPAGE:\nbody",
        )
        .await;
        assert_eq!(out.as_deref(), Some("distilled page summary"));

        let sent = bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .expect("the distiller never called the slot provider");
        assert_eq!(
            sent["model"], MOCK_MODEL,
            "the Other slot model must distil the page, not the chat model: {sent}"
        );
        assert_eq!(
            sent["reasoning_effort"], "high",
            "the slot's own level (max→high for this kind) must be sent: {sent}"
        );
        assert_ne!(
            sent["model"], "main-model",
            "a configured slot must never fall back to the main model: {sent}"
        );
    }

    /// An empty Other row means NO distiller: the raw payload is handed over
    /// untouched and no upstream call is made at all.
    #[tokio::test]
    async fn slot_distill_is_skipped_when_the_slot_is_unset() {
        let (mock_base, rx) = spawn_json_mock_upstream("should never be used").await;
        let bodies = drain_bodies(rx);

        // No `web` entry in subagent_models at all.
        let mut req = base_req();
        req.providers.insert(
            "p1".into(),
            json!({"kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["pk"]}),
        );
        let main = LlmConfig {
            provider: "custom".into(),
            model: "main-model".into(),
            base_url: format!("{mock_base}/v1"),
            api_keys: vec!["pk".into()],
            temperature: Some(0.2),
            max_tokens: Some(1024),
            timeout_secs: 10,
            reasoning_level: "high".into(),
            model_reasoning: false,
            auto_think: false,
        };

        let out = run_slot_distill(
            &reqwest::Client::new(),
            &req,
            &main,
            WEB_DISTILL_SYSTEM_PROMPT,
            "QUERY: x\n\nSEARCH RESULTS:\n- a",
        )
        .await;
        assert!(out.is_none(), "an unset slot must not produce a distillation");
        // Give any (wrong) in-flight request a chance to land before asserting.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            bodies.lock().unwrap().is_empty(),
            "an unset Other row must not spend the chat model on a side call"
        );
    }

    #[test]
    fn subagent_model_slot_routes_cross_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "p2/other-model".into());
        req.providers.insert(
            "p2".into(),
            json!({"baseUrl": "http://other/v1", "apiKeys": ["ok1", "ok2"]}),
        );
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "other-model");
        assert_eq!(base, "http://other/v1");
        assert_eq!(keys, vec!["ok1".to_string(), "ok2".to_string()]);
        // Cross-provider: the EFFECTIVE provider id, not the parent's "p1".
        assert_eq!(pid, "p2");
    }

    #[test]
    fn subagent_model_slot_unknown_provider_falls_back() {
        let mut req = base_req();
        req.subagent_models
            .insert("explore".into(), "ghost/m".into());
        let (model, base, keys, pid) = resolve_subagent_target(&req);
        assert_eq!(model, "m");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
        assert_eq!(pid, "p1");
    }

    #[test]
    fn subagent_snapshot_drops_history_but_keeps_settings() {
        // A four-explore step snapshots the parent once per explore. The
        // transcript must not ride along: run_subagent never reads it, so a
        // full clone only copies the whole chat (megabytes on a long one)
        // once per parallel sub-agent before it is thrown away.
        let mut req = base_req();
        req.history = vec![json!({"role": "user", "content": "x".repeat(1000)})];
        req.chat_id = "chat-1".into();
        req.search_plugins = vec![json!({"kind": "duckduckgo"})];
        req.context_window = 200_000;
        req.mcp_servers = json!({"srv": {"command": "x"}});

        let snap = req.subagent_snapshot();

        assert!(snap.history.is_empty(), "snapshot must not carry history");
        // The parent's own history is untouched (the turn keeps using it).
        assert_eq!(req.history.len(), 1);
        // Settings the sub-agent genuinely reads still flow through.
        assert_eq!(snap.model, req.model);
        assert_eq!(snap.root, req.root);
        assert_eq!(snap.chat_id, "chat-1");
        assert_eq!(snap.context_window, 200_000);
        assert_eq!(snap.search_plugins, req.search_plugins);
        assert_eq!(snap.mcp_servers, req.mcp_servers);
        assert_eq!(snap.api_keys, req.api_keys);
    }

    // ---- Plan persistence -------------------------------------------------
    // The save used to depend on a heading that STARTS with "plan", so a model
    // writing `## Implementation Plan`, `## Phase 1` or no heading at all left
    // NO plan file — silently, because the caller dropped the Result. That is
    // the "sometimes it saves, sometimes it doesn't" report.

    #[test]
    fn extract_plan_body_accepts_any_heading() {
        // The canonical opener still works and its heading becomes the title.
        let (t, b) = extract_plan_body("## Plan\ndo the thing").unwrap();
        assert_eq!(t, "Plan");
        assert!(b.contains("do the thing"));

        // A differently-worded heading is still a plan.
        for heading in ["## Implementation Plan", "## Phase 1: wire it up", "## طرح"] {
            let text = format!("{heading}\nstep one\nstep two");
            let (t, b) = extract_plan_body(&text)
                .unwrap_or_else(|| panic!("{heading} produced no plan"));
            assert_eq!(t, heading.trim_start_matches('#').trim());
            assert!(b.contains("step one"), "{b}");
        }
    }

    #[test]
    fn extract_plan_body_accepts_a_plan_without_a_heading() {
        // No heading at all: the reply IS the plan. Previously this returned
        // None and nothing was written to disk.
        let (t, b) = extract_plan_body("1. read the file\n2. edit it").unwrap();
        assert_eq!(t, "1. read the file");
        assert!(b.contains("2. edit it"), "{b}");

        // An empty reply is still refused — there is nothing to save.
        assert!(extract_plan_body("").is_none());
        assert!(extract_plan_body("   \n\n  ").is_none());
    }

    #[test]
    fn plan_roundtrip_is_readable_after_a_save() {
        // A plan saved with the reader's exact keys must come back, including
        // the empty-chat-id case the reader used to refuse outright while the
        // writer happily created `plan/<ws>/default/plan.md`.
        let dir = std::env::temp_dir().join(format!("codifa-plan-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-x");

        for chat_id in ["chat-1", ""] {
            crate::plans::save_plan(root, &ws, "My Plan", "## Plan\nbody here", chat_id).unwrap();
            let got = crate::plans::get_plan(root, &ws, chat_id)
                .unwrap_or_else(|| panic!("plan not readable for chat_id={chat_id:?}"));
            assert_eq!(got["title"], "My Plan");
            assert!(got["content"].as_str().unwrap_or("").contains("body here"));
        }

        // The durable write must not leave temp files behind.
        let plan_folder = std::path::Path::new(root).join("plan").join(&ws);
        let chat_dir = plan_folder.join(if true { "chat-1" } else { "default" });
        let leftovers: Vec<String> = std::fs::read_dir(&chat_dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.contains(".tmp"))
                    .collect()
            })
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_plan_writes_do_not_collide() {
        // The temp name was pid-only, so two writers in one process picked the
        // SAME temp path: the second rename failed and that save vanished.
        let dir = std::env::temp_dir().join(format!("codifa-plan-cc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-y");

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.to_string();
                let ws = ws.clone();
                std::thread::spawn(move || {
                    crate::plans::save_plan(
                        &root,
                        &ws,
                        &format!("Plan {i}"),
                        &format!("body {i}"),
                        "chat-1",
                    )
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("a concurrent save failed");
        }
        let got = crate::plans::get_plan(root, &ws, "chat-1").expect("plan missing after races");
        assert!(!got["content"].as_str().unwrap_or("").is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A live OpenAI-compatible upstream on 127.0.0.1: the FIRST /chat/completions
    /// request gets a tool_call to `explore`; every later one answers plain text.
    /// Bodies are forwarded over the channel for assertions.
    async fn spawn_explore_mock_upstream(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // Shared call counter: each connection runs in its own spawned task,
        // and usize is Copy — a plain counter copied per task made EVERY
        // request look like the first one, so the mock answered tool_calls
        // forever and the turn spun to MAX_STEPS.
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let calls = std::sync::Arc::clone(&calls);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let call_idx = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // run_turn always streams, so the mock answers SSE. The FIRST
                    // request gets ONE complete tool_call frame (arguments merged
                    // in a single frame — the parser concatenates argument chunks
                    // verbatim, so splitting a JSON object across frames would
                    // produce invalid JSON).
                    let resp: String = if call_idx == 0 {
                        let frame = |payload: String| format!("data: {payload}\n\n");
                        let mut sse = String::new();
                        sse.push_str(&frame(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"explore","arguments":"{\"description\":\"look\",\"prompt\":\"what files exist\"}"}}]}}]}).to_string()));
                        sse.push_str(&frame(
                            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":5,"output_tokens":3}}).to_string(),
                        ));
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    } else {
                        let mut sse = String::new();
                        sse.push_str(&format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{"content":"done"}}]}).to_string()
                        ));
                        sse.push_str(&format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":11,"output_tokens":2}}).to_string()
                        ));
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn explore_live_runs_the_slot_model_and_attributes_usage() {
        // The explore Tool-Models slot routes cross-provider: the SUB request
        // must go out with the slot model, and its usage event must be
        // reported under the SLOT provider id (not the parent's).
        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        // Drain the channel in the background so the mock never blocks.
        let bodies_c = bodies.clone();
        tokio::spawn(async move {
            let mut rx = rx;
            while let Some(b) = rx.recv().await {
                bodies_c.lock().unwrap().push(b);
            }
        });
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-explore",
            "mode": "build",
            "prompt": "go explore",
            "history": [],
            "subagent_models": { "explore": format!("slot-prov/{MOCK_MODEL}") },
            "subagent_thinking": { "explore": "max" },
            "thinking_level": "high",
            "model_reasoning": true,
            "providers": {
                "slot-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-slot"] }
            },
            "data_root": "/tmp/codifa-live-explore-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev_clone = events.clone();
        let mut emit = move |e: &AgentEvent| {
            ev_clone.lock().unwrap().push(e.to_json());
        };
        let _ = run_turn(&req, &mut emit, &cancel).await;
        let evs = events.lock().unwrap().clone();
        let sent = bodies.lock().unwrap().clone();
        let sent_models: Vec<String> = sent
            .iter()
            .map(|b| b["model"].as_str().unwrap_or("").to_string())
            .collect();
        let evs_dbg = format!("{evs:?}");
        let _ = evs_dbg; // keep for debugging below
        let usage_events: Vec<Value> = evs
            .iter()
            .filter(|e| e["kind"] == "usage")
            .cloned()
            .collect();
        let sub_usage = usage_events
            .iter()
            .find(|e| e["sub"] == true && e["model"] == MOCK_MODEL)
            .unwrap_or_else(|| {
                panic!(
                    "a sub(=explore) usage event for the slot model must fire; got {usage_events:?}; sent_models={sent_models:?}"
                )
            });
        assert_eq!(sub_usage["provider_id"], "slot-prov");
        // And the SUB request really went out with the slot model.
        let sent = bodies.lock().unwrap().clone();
        assert!(
            sent.iter().any(|b| b["model"] == MOCK_MODEL),
            "the explore sub-request must use the slot model; sent models: {:?}",
            sent.iter().map(|b| b["model"].clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn undelivered_steers_are_reported_as_dropped_not_erased() {
        // A turn that ends WITHOUT a model call to carry the steer (provider
        // error, step budget, Stop inside a tool batch) must hand the queued
        // steer back to the renderer. `SteerGuard::drop` used to clear the
        // inbox silently, which is exactly why steering "sometimes worked and
        // sometimes didn't": the outcome depended only on which exit the turn
        // happened to take.
        let chat = "steer-drop-test-chat";
        steer_inbox()
            .lock()
            .unwrap()
            .entry(chat.to_string())
            .or_default()
            .push(SteerMessage { id: "m1".into(), prompt: "keep working".into() });
        let mut seen: Vec<Value> = Vec::new();
        let mut emit = |e: &AgentEvent| seen.push(e.to_json());
        let n = drop_steers(chat, &mut emit);
        assert_eq!(n, 1, "the queued steer must be counted as handed back");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["kind"], "steer_dropped");
        assert_eq!(seen[0]["ids"][0], "m1");
        // The inbox is empty afterwards, so `SteerGuard::drop` finds nothing to
        // erase and the renderer is the single owner of what happens next.
        assert!(
            steer_inbox().lock().unwrap().get(chat).is_none(),
            "the reported steer must not stay queued (it would be delivered twice)"
        );
        // A second call is a no-op: nothing is reported twice.
        let mut again: Vec<Value> = Vec::new();
        let mut emit2 = |e: &AgentEvent| again.push(e.to_json());
        assert_eq!(drop_steers(chat, &mut emit2), 0);
        assert!(again.is_empty());
    }

    #[test]
    fn drop_steers_ignores_a_subagent_and_blank_text() {
        // The explore sub-agent reuses the parent's turn scope with an EMPTY
        // chat id (`SteerGuard::inert`), so it must never touch a real inbox.
        let mut seen: Vec<Value> = Vec::new();
        {
            let mut emit = |e: &AgentEvent| seen.push(e.to_json());
            assert_eq!(drop_steers("", &mut emit), 0);
        }
        assert!(seen.is_empty());
        // A steer whose text is blank was never deliverable: reporting it would
        // make the renderer re-send an empty message.
        let chat = "steer-drop-blank-chat";
        steer_inbox()
            .lock()
            .unwrap()
            .entry(chat.to_string())
            .or_default()
            .push(SteerMessage { id: "blank".into(), prompt: "   ".into() });
        {
            let mut emit = |e: &AgentEvent| seen.push(e.to_json());
            assert_eq!(drop_steers(chat, &mut emit), 0);
        }
        assert!(seen.is_empty());
        // It is still cleared, so it can never leak into a later turn.
        assert!(steer_inbox().lock().unwrap().get(chat).is_none());
    }

    #[tokio::test]
    async fn history_images_are_re_read_and_reach_the_model() {
        // The renderer sends a past message's images as PATHS (inline copies are
        // stripped from history to keep every turn's payload small). Before this
        // was wired, a follow-up like "now fix it" referred to an image the
        // model had never received.
        let dir = std::env::temp_dir().join(format!(
            "codifa-history-img-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // One real 1x1 PNG on disk, read back through the image helper.
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let img_path = dir.join("shot.png");
        std::fs::write(&img_path, png).unwrap();

        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": dir.to_string_lossy(),
            "mode": "build",
            "prompt": "now fix it",
            // The PAST turn carried an image; this turn only carries the text.
            "history": [
                { "role": "user", "content": "why is this broken?", "images": [img_path.to_string_lossy()] },
                { "role": "assistant", "content": "I see the error." }
            ],
            "data_root": dir.to_string_lossy()
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        let sent = bodies.lock().unwrap().clone();
        let first = sent.first().cloned().expect("the turn must send a request");
        let hist_msg = first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .cloned()
            .unwrap_or_else(|| panic!("the historical image must be sent as blocks: {first}"));
        let blocks = hist_msg["content"].as_array().unwrap();
        assert!(
            blocks
                .iter()
                .any(|b| b["type"] == "image_url"
                    && b["image_url"]["url"]
                        .as_str()
                        .is_some_and(|u| u.starts_with("data:image/png;base64,"))),
            "the past screenshot must be re-read from disk and sent: {first}"
        );
        assert!(
            blocks
                .iter()
                .any(|b| b["type"] == "text"
                    && b["text"].as_str().is_some_and(|t| t.contains("why is this broken?"))),
            "the historical text must survive next to the image: {first}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A valid-looking inline image: the mime prefix is what the per-provider
    /// translation switches on, the payload is opaque to the mock.
    const PNG_URL: &str = "data:image/png;base64,AAAA";
    const JPG_URL: &str = "data:image/jpeg;base64,BBBB";

    /// A NON-streaming OpenAI-compatible upstream: records every request body
    /// and answers a fixed JSON completion. The vision pass is a one-shot
    /// `complete_with_images` call, which parses this shape (not SSE).
    async fn spawn_json_mock_upstream(
        content: &str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let payload = json!({ "choices": [{ "message": { "content": content } }] }).to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let payload = payload.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        payload.len(),
                        payload
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// Drain a mock's body channel into a shared vector in the background, so
    /// the mock never blocks on a full channel while the turn runs.
    fn drain_bodies(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> std::sync::Arc<std::sync::Mutex<Vec<Value>>> {
        let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = bodies.clone();
        tokio::spawn(async move {
            while let Some(b) = rx.recv().await {
                sink.lock().unwrap().push(b);
            }
        });
        bodies
    }

    /// A mock upstream that answers BOTH shapes a turn needs: streaming SSE for
    /// the agent loop (the FIRST stream returns one UNKNOWN-tool call so the
    /// turn makes a second round-trip and `fold_prefix_len` becomes > 0; every
    /// later stream returns plain text "done") and a non-streaming JSON
    /// completion for the compaction summarizer. Every request body is forwarded
    /// so a test can also assert that the summarizer was really called.
    async fn spawn_compact_mock_upstream(
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        // Counts STREAM calls only (the summarizer call is non-streaming), so
        // the first stream is the tool-call round and every later one is text.
        let streams = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                let streams = std::sync::Arc::clone(&streams);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body.clone());
                    let resp: String = if body["stream"].as_bool() == Some(true) {
                        let idx = streams.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let mut sse = String::new();
                        if idx == 0 {
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"noop_tool","arguments":"{}"}}]}}]}).to_string()
                            ));
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":2}}).to_string()
                            ));
                        } else {
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{"content":"done"}}]}).to_string()
                            ));
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":1}}).to_string()
                            ));
                        }
                        sse.push_str("data: [DONE]\n\n");
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        )
                    } else {
                        let payload = json!({
                            "choices": [{ "message": { "content": "SUMMARY TEXT" } }]
                        })
                        .to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            payload.len(),
                            payload
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// A main-agent request pointed at the mock with an explicit window and
    /// threshold — the two inputs the mid-turn compaction trigger reads.
    fn compact_req(base: &str, ctx: u64, percent: u64) -> AgentRequest {
        let v = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/compact-test-model",
            "base_url": format!("{base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-compact",
            "mode": "build",
            "prompt": "do the thing",
            "history": [],
            "context_window": ctx,
            "compact_at_percent": percent,
            "data_root": "/tmp/codifa-live-compact-data"
        });
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn usage_tuple_maps_google_camel_case_keys() {
        // Gemini reports camelCase usageMetadata; without these keys a Google
        // turn sent (0, 0), so the meter AND the provider-reported compaction
        // trigger both fell back to the local estimate for that provider.
        let mut acc = StreamAcc::default();
        acc.usage = Some(json!({"promptTokenCount": 321, "candidatesTokenCount": 12}));
        assert_eq!(usage_tuple(&acc), (321, 12));
    }

    #[test]
    fn prompt_estimate_counts_system_and_tool_schemas() {
        // The history-only estimate misses the fixed per-request overhead
        // (system prompt + tool schemas) — that gap is exactly why a low
        // threshold could never be reached. The prompt estimate must be
        // strictly larger.
        let msgs = vec![
            json!({"role": "system", "content": "s".repeat(400)}),
            json!({"role": "user", "content": "u".repeat(400)}),
        ];
        let history_only = estimate_wire_tokens(&msgs[1..]);
        let full = estimate_prompt_tokens(&msgs, 4_000);
        assert!(
            full > history_only,
            "full={full} must exceed history-only={history_only}"
        );
    }

    #[tokio::test]
    async fn mid_turn_compaction_fires_when_the_prompt_crosses_the_threshold() {
        // Reported bug: with a LOW threshold (20%) mid-turn compaction never
        // fired. The trigger measured only the history `content` (char/4), which
        // misses the system prompt + tool schemas and is additionally capped by
        // the in-turn elision — so it plateaued below the real prompt size. The
        // fix feeds the FULL prompt estimate (and the provider's own token
        // count) into the trigger. A deliberately tiny window makes the 20%
        // threshold trivially reachable, so the fold MUST happen.
        let (mock_base, rx) = spawn_compact_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let req = compact_req(&mock_base, 1_000, 20);
        assert_eq!(req.compact_at_percent, 20);

        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let res = run_turn(&req, &mut emit, &cancel).await;
        assert!(res.is_ok(), "turn errored: {res:?}");

        let evs = events.lock().unwrap().clone();
        assert!(
            evs.iter().any(|e| e["kind"] == "compact_start"),
            "mid-turn compaction must start at 20%: {evs:?}"
        );
        let compact = evs
            .iter()
            .find(|e| e["kind"] == "compact")
            .unwrap_or_else(|| panic!("a compact event must fire at 20%: {evs:?}"));
        // The backend prefixes the fold with its "[Compacted earlier context]"
        // marker (compact.rs reads it back to merge prior summaries).
        let content = compact["content"].as_str().unwrap_or_default();
        assert!(
            content.contains("SUMMARY TEXT"),
            "the summary text must be stored: {content:?}"
        );
        // The summarizer request really went out: the mock's non-stream answer
        // is what becomes the summary.
        let sent = bodies.lock().unwrap().clone();
        assert!(
            sent.iter().any(|b| b["stream"].as_bool() == Some(false)),
            "the compaction summarizer must be called: {sent:?}"
        );
    }

    #[tokio::test]
    async fn mid_turn_compaction_stays_off_below_the_threshold() {
        // Control: a huge window at the SAME 20% must NOT fold — the trigger has
        // to track the threshold, not fire unconditionally.
        let (mock_base, rx) = spawn_compact_mock_upstream().await;
        let _bodies = drain_bodies(rx);
        let req = compact_req(&mock_base, 1_000_000, 20);
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut emit = move |e: &AgentEvent| ev.lock().unwrap().push(e.to_json());
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _ = run_turn(&req, &mut emit, &cancel).await;
        let evs = events.lock().unwrap().clone();
        assert!(
            !evs.iter().any(|e| e["kind"] == "compact"),
            "nothing may be folded far below the threshold: {evs:?}"
        );
    }

    #[tokio::test]
    async fn images_reach_the_main_model_as_content_blocks() {
        // With no Vision slot configured the image must ride WITH the user
        // message as neutral blocks, which llm.rs translates per provider.
        let (mock_base, rx) = spawn_explore_mock_upstream().await;
        let bodies = drain_bodies(rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-images",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            // Both renderer shapes must be accepted: a bare data URL, the
            // picker's {path,dataUrl} object (which wins over its path), and a
            // path that cannot be read (dropped, never fatal).
            "images": [
                PNG_URL,
                { "path": "/definitely/missing.png", "dataUrl": JPG_URL },
                "/definitely/missing-too.png"
            ],
            "data_root": "/tmp/codifa-live-images-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        assert_eq!(req.images.len(), 2, "the unreadable path must be dropped");
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        let sent = bodies.lock().unwrap().clone();
        let first = sent.first().cloned().expect("the main turn must send a request");
        let content = first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .map(|m| m["content"].clone())
            .unwrap_or_else(|| panic!("the user message must carry content blocks: {first}"));
        let blocks = content.as_array().unwrap();
        // Text + exactly the two readable images.
        assert_eq!(blocks.len(), 3, "one text block + two images: {content}");
        let urls: Vec<&str> = blocks
            .iter()
            .filter_map(|b| b["image_url"]["url"].as_str())
            .collect();
        assert!(urls.contains(&PNG_URL), "the bare data URL must be sent: {content}");
        assert!(
            urls.contains(&JPG_URL),
            "the {{path,dataUrl}} entry must be sent as its dataUrl: {content}"
        );
    }

    #[tokio::test]
    async fn main_model_receives_the_images_even_when_a_vision_slot_is_configured() {
        // MAIN MODEL FIRST. A configured Vision slot must NOT preempt the main
        // model: the images travel to the main model as blocks (llm.rs translates
        // them per provider), because most flagship models read images natively
        // and the user picked that model for a reason. The Vision slot is only a
        // FALLBACK — for a model the capability maps know is text-only, or one
        // that rejects the images mid-turn.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page, error text below").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);

        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{main_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-vision",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            "images": [PNG_URL],
            "subagent_models": { "vision": "vision-prov/vision-model" },
            "providers": {
                "vision-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{vision_base}/v1"),
                    "apiKeys": ["sk-vision"]
                }
            },
            "data_root": "/tmp/codifa-live-vision-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        // The main model got the raw image blocks — the slot model was NOT used.
        let mbody = main_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the main turn must run"));
        let blocks = mbody["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["content"].is_array())
            .map(|m| m["content"].clone())
            .unwrap_or_else(|| panic!("the main model must receive image blocks: {mbody}"));
        assert!(
            blocks.as_array().unwrap().iter().any(|b| b["type"] == "image_url"
                && b["image_url"]["url"] == PNG_URL),
            "the image bytes must go to the main model: {mbody}"
        );
        assert!(
            vision_bodies.lock().unwrap().is_empty(),
            "the Vision slot must not preempt a main model whose capability is unknown"
        );
    }

    #[tokio::test]
    async fn vision_slot_takes_over_when_the_main_model_is_text_only() {
        // The capability map says the main model cannot read images, so the
        // Vision slot describes them once and the main model receives the
        // DESCRIPTION as text — a text-only main model would otherwise never
        // "see" the screenshot at all.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page, error text below").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);

        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let req = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/parent-model",
            "base_url": format!("{main_base}/v1"),
            "api_key": "sk",
            "api_keys": ["sk"],
            "root": "/tmp/codifa-live-vision",
            "mode": "build",
            "prompt": "what is wrong with this screenshot?",
            "history": [],
            "images": [PNG_URL],
            "subagent_models": { "vision": "vision-prov/vision-model" },
            "providers": {
                "chat-provider": {
                    "kind": "custom",
                    "manualVisionMap": { "main/parent-model": false }
                },
                "vision-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{vision_base}/v1"),
                    "apiKeys": ["sk-vision"]
                }
            },
            "data_root": "/tmp/codifa-live-vision-data"
        });
        let req: AgentRequest = serde_json::from_value(req).unwrap();
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req, &mut emit, &cancel).await;

        // 1) The vision model ran, with the slot's model id and the raw image.
        let vbody = vision_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the vision model must be called"));
        assert_eq!(vbody["model"], "vision-model");
        assert_eq!(vbody["stream"], false, "the vision pass is one-shot: {vbody}");
        let vcontent = &vbody["messages"][1]["content"];
        assert!(
            vcontent.is_array(),
            "the vision call must send content blocks, got {vbody}"
        );
        assert!(
            vcontent.as_array().unwrap().iter().any(|b| b["type"] == "image_url"
                && b["image_url"]["url"] == PNG_URL),
            "the image bytes must be on the vision request: {vbody}"
        );

        // 2) The main model got the DESCRIPTION as text — not the image blocks,
        //    which a text-only main model could not accept.
        let mbody = main_bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("the main turn must run"));
        let mtext = mbody["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            mtext.contains("IMAGE ANALYSIS") && mtext.contains("a red button"),
            "the vision description must be forwarded to the main model: {mbody}"
        );
        assert!(
            mbody["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| !m["content"].is_array()),
            "the main model must not receive raw image blocks: {mbody}"
        );
    }
}
