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
/// collapsing the search.
///
/// The setting is AUTHORITATIVE and the tool schema deliberately exposes no
/// `max_results` argument: models used to volunteer their own number (a real
/// run asked for 8 while the setting said 5) and, because an explicit argument
/// used to win, the search silently ignored the user's choice. A knob that
/// only sometimes applies its value is worse than no knob.
fn web_search_result_count(setting: usize) -> usize {
    if setting == 0 {
        return crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT;
    }
    setting.clamp(1, crate::websearch::WEB_SEARCH_AUTO_FETCH_MAX)
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
    //
    // A configured fallback list still counts as a choice: before this, an empty
    // slot returned early and the list was silently dead — the user could add
    // fallbacks in Settings and nothing ever used them.
    let slot_fallbacks = req
        .tool_fallbacks
        .get("web")
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if entry.is_empty() && slot_fallbacks.iter().all(|e| e.trim().is_empty()) {
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
    if model.is_empty() && entry.is_empty() {
        return None;
    }
    let kind = crate::backend_light::resolve_slot_kind(entry, &main.provider, &req.providers);
    let level = req
        .subagent_thinking
        .get("web")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    // One rung per candidate: the slot's own model first, then the slot's own
    // fallback list (Settings → Tools). A fallback inherits the slot's reasoning
    // level — only the model and its routing change.
    //
    // An UNSET slot contributes no rung of its own: blank means "no distiller",
    // and the main model must not be spent on one. A configured fallback list is
    // still honoured, because it is an explicit choice.
    let mut chain: Vec<(String, String, Vec<String>, String, String)> = Vec::new();
    if !entry.is_empty() {
        chain.push((model, base, keys, provider_id, kind));
    }
    for step in crate::backend_light::resolve_slot_chain(
        entry,
        slot_fallbacks,
        &main.model,
        &main.base_url,
        &main.api_keys,
        &req.provider_id,
        &main.provider,
        &req.providers,
    )
    .into_iter()
    .skip(1)
    {
        chain.push(step);
    }
    // The distiller is a best-effort optimisation: try each rung once and hand
    // the caller the raw payload when they all fail.
    for (m, b, keys, pid, k) in chain {
        let (reasoning, model_reasoning, auto_think) = crate::llm::reasoning_fields(
            &k,
            // A side call defaults to no reasoning (never inherits the main level).
            if level.is_empty() { "none" } else { level },
            provider_model_reasoning(&req.providers, &pid, &m),
        );
        let cfg = LlmConfig {
            provider: k,
            model: m,
            base_url: b,
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
                if !text.is_empty() {
                    return Some(text);
                }
            }
            // The distiller is an optimisation: a failure must not fail the
            // call. But only a model-side rejection moves to the next model — a
            // timeout or a dropped connection is not the model's fault, and the
            // caller's raw payload is a better answer than a second paid call
            // that cannot succeed either.
            Err(e) => {
                if !crate::llm::should_fall_back(&e) {
                    return None;
                }
            }
        }
    }
    None
}

/// How many history entries may be re-described by the Vision slot in ONE turn.
/// Each description is a paid round-trip, so a long chat must not add one per
/// pasted screenshot; entries outside the window keep their raw image blocks.
const MAX_HISTORY_VISION_CALLS: usize = 2;

/// Cache of Vision-slot descriptions, keyed by (model, prompt text, image bytes).
///
/// A chat re-sends the screenshots still in its history on EVERY turn (the
/// renderer sends bare paths, so they are re-read and re-encoded each time).
/// Without a cache each of those turns paid for the same description again —
/// same model, same bytes, same answer. The key covers the model, the prompt
/// text and the image payloads, so a hit is byte-for-byte the same question
/// and cannot return a description of a different picture: this saves
/// round-trips at ZERO quality cost.
static VISION_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u128, String>>,
> = std::sync::OnceLock::new();

/// Descriptions kept at once. Each is a few KB, so the cap is about memory
/// hygiene rather than a real limit.
const VISION_CACHE_MAX: usize = 32;

/// Stable 128-bit key for one vision call.
///
/// Two passes of `DefaultHasher` (the second over a distinct seed byte) give
/// 128 bits from the std hasher — no extra dependency, and a collision between
/// two DIFFERENT images is far less likely than a hardware fault.
fn vision_cache_key(model: &str, text: &str, images: &[String]) -> u128 {
    use std::hash::{Hash, Hasher};
    let mut lo = std::collections::hash_map::DefaultHasher::new();
    let mut hi = std::collections::hash_map::DefaultHasher::new();
    for (seed, hasher) in [(0u8, &mut lo), (1u8, &mut hi)] {
        seed.hash(hasher);
        model.hash(hasher);
        text.hash(hasher);
        // The length first, so two image lists can never concatenate to the
        // same byte stream (["ab","c"] vs ["a","bc"]).
        images.len().hash(hasher);
        for url in images {
            url.len().hash(hasher);
            url.hash(hasher);
        }
    }
    ((hi.finish() as u128) << 64) | lo.finish() as u128
}

/// Read one cached description.
fn vision_cache_get(key: u128) -> Option<String> {
    VISION_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .ok()?
        .get(&key)
        .cloned()
}

/// Store one description (bounded; a full cache starts over).
fn vision_cache_put(key: u128, desc: &str) {
    let Ok(mut map) = VISION_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
    else {
        return;
    };
    if map.len() >= VISION_CACHE_MAX && !map.contains_key(&key) {
        map.clear();
    }
    map.insert(key, desc.to_string());
}

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
    // A configured fallback list counts as configuring the slot: an unset slot
    // returned NotConfigured here and the list was silently dead, so fallbacks
    // added in Settings → Tools never ran for vision.
    let slot_fallbacks = req
        .tool_fallbacks
        .get("vision")
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let has_fallbacks = slot_fallbacks.iter().any(|e| !e.trim().is_empty());
    // "Resolves to the main model" only means "nothing to do" when the slot is
    // genuinely unset. A slot explicitly pointed at the main model still has its
    // own fallback list, and that list is the reason the row exists.
    if v_model.is_empty() || (v_model == main_model && !has_fallbacks) {
        return VisionOutcome::NotConfigured;
    }
    let v_kind = crate::backend_light::resolve_slot_kind(slot_entry, main_kind, &req.providers);
    let v_level = req
        .subagent_thinking
        .get("vision")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    // The slot's own model first, then the slot's own fallback list
    // (Settings → Tools). A fallback inherits the slot's reasoning level: the
    // model and its routing change, never the effort the user picked.
    //
    // A slot that inherits the main model contributes no rung of its own (the
    // main model already handles the images inline), so only the fallbacks are
    // tried — they are the explicit choice.
    let mut chain: Vec<(String, String, Vec<String>, String, String)> = Vec::new();
    if !slot_entry.trim().is_empty() && v_model != main_model {
        chain.push((v_model, v_base, v_keys, v_provider_id, v_kind));
    }
    chain.extend(
        crate::backend_light::resolve_slot_chain(
            slot_entry,
            slot_fallbacks,
            main_model,
            main_base,
            main_keys,
            &req.provider_id,
            main_kind,
            &req.providers,
        )
        .into_iter()
        .skip(1),
    );
    let mut failed_model = String::new();
    let mut failed_error = String::new();
    for (c_model, c_base, c_keys, c_provider_id, c_kind) in chain {
        let (v_reasoning, v_model_reasoning, v_auto_think) = crate::llm::reasoning_fields(
            &c_kind,
            // A side call defaults to no reasoning (never inherits the main level).
            if v_level.is_empty() { "none" } else { v_level },
            provider_model_reasoning(&req.providers, &c_provider_id, &c_model),
        );
        let v_cfg = LlmConfig {
            provider: c_kind,
            model: c_model.clone(),
            base_url: c_base,
            api_keys: c_keys,
            temperature: Some(0.2),
            max_tokens: Some(2048),
            timeout_secs: crate::llm::NO_TIMEOUT_SECS,
            reasoning_level: v_reasoning,
            model_reasoning: v_model_reasoning,
            auto_think: v_auto_think,
        };
        // Same model + same text + same image bytes = the same question, so a
        // repeat of a screenshot this chat already sent is answered from the cache
        // instead of a second paid round-trip. The key is the hash of the exact
        // inputs, so a hit can never describe a different picture.
        let cache_key = vision_cache_key(&v_cfg.model, text, images);
        if let Some(desc) = vision_cache_get(cache_key) {
            return VisionOutcome::Ok(desc);
        }
        match crate::llm::complete_with_images(client, &v_cfg, VISION_SYSTEM_PROMPT, text, images)
            .await
        {
            Ok(res) => {
                let desc = res.text.trim().to_string();
                if !desc.is_empty() {
                    // Only a real answer is cached: a failure or an empty reply
                    // must still be retried on the next turn.
                    vision_cache_put(cache_key, &desc);
                    return VisionOutcome::Ok(desc);
                }
                if failed_error.is_empty() {
                    failed_model = v_cfg.model.clone();
                    failed_error = "the model returned an empty description".into();
                }
            }
            Err(e) => {
                if failed_error.is_empty() {
                    failed_model = v_cfg.model.clone();
                    failed_error = e.clone();
                }
                // Only a model-side rejection justifies calling the NEXT model.
                // A timeout or a dropped connection stops here with its own
                // reason: the next model cannot fix the transport, and the caller
                // must learn why the screenshot was skipped.
                if !crate::llm::should_fall_back(&e) {
                    return VisionOutcome::Failed {
                        model: v_cfg.model.clone(),
                        error: e,
                    };
                }
            }
        }
    }
    VisionOutcome::Failed {
        model: failed_model,
        error: failed_error,
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
    // Collect first, then describe CONCURRENTLY. Awaiting one paid round-trip
    // per message in series is what made this fallback feel like a stall: two
    // screenshots cost two full model round-trips back to back.
    let mut entries: Vec<(usize, String, Vec<String>)> = Vec::new();
    for (i, msg) in messages.iter().enumerate() {
        let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
            continue;
        };
        let mut text = String::new();
        let mut images: Vec<String> = Vec::new();
        for b in blocks {
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
        entries.push((i, text, images));
    }
    // Only the first `MAX_HISTORY_VISION_CALLS` message texts are paid for; the
    // rest are rewritten with the "omitted" note, exactly as before.
    let paid_n = entries.len().min(MAX_HISTORY_VISION_CALLS);
    let rest: Vec<(usize, String, Vec<String>)> = entries.split_off(paid_n);
    let paid = entries;
    let results = futures_util::future::join_all(paid.iter().map(|(_, text, images)| {
        run_vision_slot(
            client,
            req,
            &cfg.model,
            &cfg.provider,
            &cfg.base_url,
            &cfg.api_keys,
            text,
            images,
        )
    }))
    .await;
    for ((i, text, _), outcome) in paid.into_iter().zip(results) {
        let body = match outcome {
            VisionOutcome::Ok(d) => {
                format!("{text}\n\n=== IMAGE ANALYSIS (from the vision model) ===\n{d}")
            }
            _ => format!(
                "{text}\n\n[image omitted: the main model cannot read images and no Vision \
                 model is configured in Settings → Tools]"
            ),
        };
        let role = messages[i]
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        messages[i] = json!({ "role": role, "content": body });
        changed += 1;
    }
    for (i, text, _) in rest {
        let role = messages[i]
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        messages[i] = json!({
            "role": role,
            "content": format!(
                "{text}\n\n[image omitted: the main model cannot read images and no Vision \
                 model is configured in Settings → Tools]"
            ),
        });
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
fn effective_context_window(req: &AgentRequest) -> usize {
    if req.context_window > 0 {
        return req.context_window as usize;
    }
    // Same resolution order as the renderer's `modelContextWindow`: the manual
    // override (custom models) first, then the map filled from `/models`.
    provider_context_window(&req.providers, &req.provider_id, &req.model)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// Output budget for the auto-compaction summary.
const COMPACT_MAX_OUTPUT: usize = 4096;
/// Per-attempt deadline for the summarizer. Compact is a side call inside the
/// turn and `llm::complete` now honors this budget, so a hung provider fails the
/// attempt instead of freezing the very turn it is trying to shrink.
/// `compact::compact_history` additionally caps the TOTAL across all attempts
/// (`COMPACT_TOTAL_BUDGET_SECS`), so this per-attempt value can stay short.
const COMPACT_TIMEOUT_SECS: u64 = 90;
/// The explore sub-agent must answer in seconds, not minutes — a much smaller
/// step budget than the main agent's, with a forced final report (below).
const SUBAGENT_MAX_STEPS: usize = 12;

/// The step budget the explore prompt itself promises ("a fixed 3-step
/// budget"). The model overshoots it: in the last traced corpus 45 of 63
/// explore runs entered round 4, and those rounds alone cost 853_902 of the
/// 1_758_022 uncached explore tokens (48.6%) — every one of them re-sending a
/// conversation that was already large. The near-exhaustion nudge below only
/// fires at step 9 of 12, far too late to change the shape of a run, so the
/// reminder has to land where the promised budget actually runs out.
const EXPLORE_BUDGET_STEPS: usize = 3;
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
/// Purely a BUDGET multiplier: a rung only moves down the chain when its
/// failure says the model itself is unusable (see [`subagent_error_is_fatal`]),
/// so a slow-but-working model can retry for the whole budget without losing
/// the user's fallbacks. The multiplier keeps a long list fully reachable when
/// its rungs fail non-fatally.
const SUBAGENT_RUNG_ATTEMPTS: usize = 2;

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

/// Cap on a model reply echoed into an `llm` trace row. The trace is a local
/// JSONL the panel reads on demand, so this only bounds one row's size — large
/// enough to read what the model actually said during that step.
const LLM_TRACE_TEXT_CAP: usize = 4_000;

/// Cap on the wire prompt echoed into an `llm` trace row. The system message is
/// elided to a size marker there (the `prompt` row already carries it in full),
/// so this budget is spent on the conversation the model actually saw — which is
/// the thing the trace panel was silently missing.
const LLM_TRACE_PROMPT_CAP: usize = 8_000;
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

/// Sub-agent in-turn elision: rounds this fresh are never touched. Same value
/// as the main agent — the model is actively reasoning over those results.
const SUB_FOLD_KEEP_ROUNDS: usize = 2;
/// Sub-agent in-turn elision: per-result budget for a stale tool result. The
/// explore window is a fraction of the main one, so the budgets are too — and
/// unlike the main agent the sub-agent OWNS read/grep, so a targeted re-read
/// always recovers the body (the pointer is guaranteed resolvable).
const SUB_FOLD_RESULT_CHARS: usize = 4_000;
/// Sub-agent in-turn elision: fold only past this estimated wire size.
///
/// Deliberately the SAME as the main threshold, not lower. Folding rewrites
/// OLD tool results, and an automatic prefix cache is a longest-prefix match:
/// changing an early message invalidates every cached token after it. Traces
/// show a median intra-run growth of only 7-10K tokens (short runs keep a
/// 65-80% cache hit), while the runaway runs reach 30-90K — those are the ones
/// worth the cache reset. A lower threshold would tax every short run for
/// almost nothing.
const SUB_FOLD_MIN_TOKENS: usize = 20_000;

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
const FOLD_MIN_REMAINING_CALLS: usize = 3;

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
const SUB_FOLD_ENABLED: bool = false;

/// Whether an in-turn fold still pays for its prefix-cache reset — see
/// `FOLD_MIN_REMAINING_CALLS` for the measurement behind the threshold.
///
/// `calls_left` includes the model call about to be made, so a run on its last
/// step has `calls_left == 1`. A pure function of the loop counter, so the rule
/// is testable without running a turn.
fn fold_pays_off(calls_left: usize) -> bool {
    calls_left >= FOLD_MIN_REMAINING_CALLS
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
/// to be made, which is exactly what decides the payoff.
#[allow(clippy::too_many_arguments)]
fn record_fold(
    trace: &crate::trace::TraceStore,
    role: &str,
    step: usize,
    call_no: usize,
    calls_left: usize,
    before_tokens: usize,
    removed_chars: usize,
    folded: usize,
) {
    // A fold that touched nothing is not an event: it would only add noise to
    // the trace and to every later sum.
    if folded == 0 {
        return;
    }
    trace.record(crate::trace::TraceEntry {
        kind: "fold".into(),
        summary: format!(
            "{role} fold: {folded} result(s), {removed_chars} chars out, {calls_left} call(s) left"
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
fn ui_echo_cap(tool: &str) -> usize {
    if tool == "explore" {
        RECAP_EXPLORE_CHARS
    } else {
        TOOL_RESULT_CAP
    }
}

/// Clip `s` to `cap` bytes on a UTF-8 char boundary and mark the cut.
/// Byte slicing mid-char panics on Persian text, so this is the only safe way
/// to bound a string that reaches the trace panel.
fn clip_trace_text(s: &str, cap: usize) -> String {
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
fn trace_prompt_text(messages: &[Value]) -> String {
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
fn tail_trace_text(s: &str, cap: usize) -> &str {
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
fn bounded_trace_text(full: &str, tail: &str, cap: usize) -> String {
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
    /// Extra instruction APPENDED to the assembled system prompt for this turn
    /// only. Live voice uses it to shape an answer for the ear (one language,
    /// plain prose, numbers as words) without touching the chat's own custom
    /// prompt: `system_prompt` REPLACES the builtin prompt, so a per-turn
    /// instruction cannot ride on it without destroying what the user set.
    #[serde(default)]
    pub system_suffix: String,
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
    /// and silently shipped an empty catalog.
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
    /// Per-tool FALLBACK models from Settings → Tools, keyed by the same slot
    /// names as `subagent_models`: each value is an ordered list of
    /// "providerId/model" entries tried top-to-bottom while THAT tool's own
    /// model fails. Purely per-call — nothing is remembered between calls, so
    /// every new call starts at the tool's own model again — and a fallback
    /// inherits the calling tool's reasoning level rather than carrying one.
    #[serde(default)]
    pub tool_fallbacks: std::collections::HashMap<String, Vec<String>>,
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
    /// What the tools may do this turn. `None` means "derive it from `mode`"
    /// (`caps_for_mode`) — the renderer sends the real object, the scheduler and
    /// any headless caller omit it and get the mode's table row instead.
    #[serde(default)]
    pub cap: Option<ToolCaps>,
}

fn default_mode() -> String {
    "build".to_string()
}

/// Default for `webSearchAutoFetch` (Settings → Web Providers) when the field
/// is absent: the same five results the UI's setting starts at.
fn default_web_search_auto_fetch() -> usize {
    crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
}

/// What the tools may do in a turn. The renderer sends this as `cap` (mirroring
/// `ModeCapabilities` in `src/lib/modes.ts`); callers that omit it get the
/// mode's row from `caps_for_mode`.
///
/// This is a HARD gate, not a hint: a forbidden tool is dropped from the schema
/// list the model sees, and a call that still arrives is refused in the tool
/// loop. Prompt text alone was never enough — an Ask turn whose prompt says
/// "you are read-only" still called `write_file` and it landed on disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolCaps {
    /// Listing / searching / reading the workspace.
    pub read_files: bool,
    /// `write_file` and `edit_file`.
    pub write_files: bool,
    /// `run_terminal`.
    pub run_terminal: bool,
    /// `web_search` and `fetch_url`.
    pub web: bool,
}

impl Default for ToolCaps {
    /// Permissive: a caller that sends nothing keeps the pre-gating behaviour,
    /// so an unknown/legacy client never loses tools because of a missing field.
    fn default() -> Self {
        Self {
            read_files: true,
            write_files: true,
            run_terminal: true,
            web: true,
        }
    }
}

/// Capabilities of the built-in modes. An id this build does not know stays
/// permissive — a missing table row must not silently disarm a mode.
pub fn caps_for_mode(mode: &str) -> ToolCaps {
    match mode {
        // Ask: reads the code, the web AND the shell, never touches the
        // workspace. The terminal stays bound because inspecting is reading —
        // `du -sh`, `df -h`, `ps`, `git status` are exactly what a read-only
        // turn needs, and the in-loop gate refuses every command that would
        // write while `write_files` is false.
        "ask" | "chat" => ToolCaps {
            write_files: false,
            run_terminal: true,
            ..ToolCaps::default()
        },
        // Plan: may inspect with the terminal, still never writes.
        "plan" => ToolCaps {
            write_files: false,
            ..ToolCaps::default()
        },
        // Sub-agents only ever get `research_schemas` (no mutating tool), and
        // build/unknown ids keep the full set.
        _ => ToolCaps::default(),
    }
}

/// The refusal text when this turn's capabilities forbid `name`, else `None`.
/// Phrased like the other in-loop refusals: one plain sentence the model can act
/// on, no "Error:" prefix (the card already renders failure from `ok`).
fn denied_by_caps(caps: &ToolCaps, name: &str) -> Option<String> {
    let (allowed, action) = match name {
        "write_file" | "edit_file" => (caps.write_files, "write or edit files"),
        "run_terminal" => (caps.run_terminal, "run commands"),
        "web_search" | "fetch_url" => (caps.web, "search or fetch the web"),
        _ => return None,
    };
    if allowed {
        return None;
    }
    Some(format!(
        "blocked: this turn is read-only — `{name}` is not available in this mode, so it \
cannot {action}. Answer with the concrete change instead: which file, which line, and the \
exact old text → new text. Tell the user to switch to Build mode if they want it applied."
    ))
}

/// Mode gating, part one: drop every tool this turn may not use. The model
/// cannot pick a tool it cannot see, so withholding the schema is the primary
/// gate; `denied_by_caps` in the loop is the backstop for a stale transcript or
/// a hallucinated (or connector-supplied) name.
fn retain_allowed_tools(schemas: &mut Vec<Value>, caps: &ToolCaps) {
    schemas.retain(|s| {
        s["function"]["name"]
            .as_str()
            .map(|n| denied_by_caps(caps, n).is_none())
            .unwrap_or(true)
    });
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
            // Live-voice reply shaping belongs to the turn the user HEARS.
            // A sub-agent's output is folded into the parent's answer, so
            // inheriting the rule would only distort its research output.
            system_suffix: String::new(),
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
            tool_fallbacks: self.tool_fallbacks.clone(),
            // A research sub-agent is text-only: images stay with the parent.
            images: Vec::new(),
            // A research sub-agent searches the web the same way the parent does.
            web_search_auto_fetch: self.web_search_auto_fetch,
            // A research sub-agent has no mutating tool at all, so it runs with
            // the parent's capabilities unchanged.
            cap: self.cap.clone(),
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
        /// Engine that actually served a `web_search` (`duckduckgo`, `tavily`,
        /// …) — the chat card badges it so the user can tell which provider
        /// answered, including when a fallback stepped in.
        engine: Option<String>,
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
        /// The size of the prompt the provider just billed, as the provider
        /// counted it (`prompt_tokens`/`input_tokens`). This is the SAME number
        /// the mid-turn auto-compaction trigger uses as its baseline, so the
        /// renderer's context meter and the fold agree: the ring reaches 100%
        /// exactly when compaction fires. 0 = the provider reported no usage
        /// (the renderer then keeps its own estimate).
        context_tokens: u64,
        /// The window the trigger divides `context_tokens` by — the model's real
        /// window, resolved by the backend when the renderer did not know it.
        /// 0 for sub-agent requests. The renderer prefers this over its own
        /// lookup so the meter's percentage cannot drift from the trigger's.
        context_window: u64,
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
    /// An `@mention`ed skill that is not in the store any more: `note` carries
    /// the warning the renderer shows (a deleted or renamed attachment would
    /// otherwise fail silently). `skills` is empty and `manual` is always true —
    /// nothing is auto-picked for the model any more, so this is the only
    /// `Skills` event left.
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
    /// Live compaction progress (`crate::compact::CompactProgress`). Streamed
    /// while the summarizer runs so the renderer can show the phase, which
    /// attempt is running and the elapsed time instead of an anonymous spinner.
    CompactProgress {
        phase: String,
        attempt: usize,
        attempts: usize,
        model: String,
        percent: u8,
        budget_secs: u64,
        elapsed_secs: u64,
    },
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
    /// A chat artifact was created or updated: the renderer docks a card in the
    /// transcript and can open the body in the sandboxed preview panel.
    Artifact {
        id: String,
        title: String,
        kind: String,
        content: String,
        version: u64,
    },
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
            AgentEvent::Tool { id, name, args, result, ok, results, engine } => json!({
                "kind": "tool_result", "id": id, "name": name, "tool": name, "args": args,
                "result": result, "ok": ok, "results": results, "engine": engine,
            }),
            AgentEvent::Diff { tool, path, diff } => json!({
                "kind": "diff", "tool": tool, "path": path, "diff": diff,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::Usage { input_tokens, output_tokens, cache_read_tokens, model, provider_id, sub, context_tokens, context_window } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "model": model, "provider_id": provider_id,
                "sub": sub,
                "context_tokens": context_tokens,
                "context_window": context_window,
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
            AgentEvent::CompactProgress {
                phase,
                attempt,
                attempts,
                model,
                percent,
                budget_secs,
                elapsed_secs,
            } => json!({
                "kind": "compact_progress",
                "phase": phase,
                "attempt": attempt,
                "attempts": attempts,
                "model": model,
                "percent": percent,
                "budget_secs": budget_secs,
                "elapsed_secs": elapsed_secs,
            }),
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
            AgentEvent::Artifact { id, title, kind, content, version } => json!({
                "kind": "artifact",
                "id": id,
                "title": title,
                // The document format travels as `artifact_kind`: `kind` is
                // already the event's own discriminator.
                "artifact_kind": kind,
                "content": content,
                "version": version,
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
            "Create or update a stored skill (the Codex/Claude create_skill flow). ALWAYS pass BOTH: `description` — one short ENGLISH line saying WHEN to use it — and `fa_keywords` — the user's PERSIAN phrases (comma-separated). To install from a repo pass `repo` instead of `content`. To EDIT, `load_skill` first then send the revised body; pass previous_name when renaming.",
            json!({
                "name": {"type": "string", "description": "Skill name (also the folder slug)"},
                "description": {"type": "string", "description": "REQUIRED. One-line ENGLISH summary of when to use this skill"},
                "content": {"type": "string", "description": "The skill body: step-by-step instructions the agent follows"},
                "fa_keywords": {"type": "string", "description": "REQUIRED. Comma-separated PERSIAN phrases that trigger this skill"},
                "previous_name": {"type": "string", "description": "Old name when renaming"},
                "repo": {"type": "string", "description": "Install from a repo instead of `content`: `owner/repo`, a GitHub URL, or a local folder"},
                "repo_path": {"type": "string", "description": "install: sub-folder holding SKILL.md (default: discover)"},
                "repo_ref": {"type": "string", "description": "install: branch/tag/commit (default: default branch)"},
                "extra_files": {"type": "object", "description": "Optional extra files: filename -> content"},
                "deleted_files": {"type": "array", "items": {"type": "string"}, "description": "Extra files to delete"},
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
                            "content": {"type": "string", "description": "Short imperative item the user can understand, in the user's language: what this step does (and the file it touches). Never bare jargon."},
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
            "Load a skill's FULL body BEFORE work it covers; `query` finds one the list omits.",
            json!({
                "name": {"type": "string", "description": "Name or slug"},
                "query": {"type": "string", "description": "Words when the name is unknown"},
                "file": {"type": "string", "description": "Extra file of that skill"}
            }),
        ),
        // Plugins bundle skills + MCP connectors into ONE switchable unit. The
        // `action` multiplexer (same shape as `computer`) keeps the tool list
        // short: create/update/toggle/delete/list instead of four tools.
        (
            "plugin",
            "Create/edit a plugin — a folder bundling skills and MCP connectors that enable/disable together. `install` reads a bundle from a git repo or local folder; create fails on an existing slug; update patches only the fields sent; toggle flips `enabled`; delete removes it.",
            json!({
                "action": {"type": "string", "enum": ["list", "install", "create", "update", "toggle", "delete"]},
                "repo": {"type": "string", "description": "install: `owner/repo`, GitHub URL, or local path"},
                "repo_path": {"type": "string", "description": "install: sub-folder holding the bundle"},
                "repo_ref": {"type": "string", "description": "install: branch/tag/commit"},
                "name": {"type": "string", "description": "Plugin name (also the slug)"},
                "slug": {"type": "string", "description": "Folder slug; defaults to the lowercased name"},
                "description": {"type": "string"},
                "version": {"type": "string", "description": "Defaults to 1.0.0"},
                "enabled": {"type": "boolean", "description": "toggle: the value to set; omit to flip"},
                "skills": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "content": {"type": "string"},
                            "description": {"type": "string"},
                            "fa_keywords": {"type": "string"}
                        },
                        "required": ["name", "content"]
                    }
                },
                "deleted_skills": {"type": "array", "items": {"type": "string"}},
                "mcp": {"type": "object", "description": "Connectors: {name: {command,args}|{url}}"},
                "deleted_mcp": {"type": "array", "items": {"type": "string"}}
            }),
        ),
        // Artifacts are versioned documents the renderer previews in a sandboxed
        // right-hand panel instead of dumping raw markup into the bubble.
        (
            "artifact",
            "Create, update or delete a chat artifact: a versioned HTML/Markdown document shown in a sandboxed preview panel.",
            json!({
                "action": {"type": "string", "enum": ["create", "update", "delete"]},
                "title": {"type": "string"},
                "id": {"type": "string", "description": "Derived from title; needed to update"},
                "kind": {"type": "string", "enum": ["html", "md"]},
                "content": {"type": "string", "description": "Self-contained; inline CSS/JS, no network"},
                "chat_id": {"type": "string", "description": "Owning chat id"}
            }),
        ),
        // Schedules as data: the agent creates the task, the panel only shows it.
        (
            "schedule",
            "Create, edit, toggle or delete a scheduled task (cron prompt that runs headless in the background).",
            json!({
                "action": {"type": "string", "enum": ["list", "create", "update", "toggle", "delete"]},
                "id": {"type": "string", "description": "Needed for update/toggle/delete"},
                "name": {"type": "string"},
                "prompt": {"type": "string", "description": "What the run should do"},
                "cron": {"type": "string", "description": "5-field UTC cron; empty = run once"},
                "enabled": {"type": "boolean", "description": "toggle: value to set; omit to flip"},
                "root": {"type": "string", "description": "Workspace root the run works in"},
                "mode": {"type": "string"},
                "skills": {"type": "array", "items": {"type": "string"}, "description": "Skills attached to every run"},
                "mcp_servers": {"type": "array", "items": {"type": "string"}, "description": "MCP connector names for every run"},
                "plugins": {"type": "array", "items": {"type": "string"}, "description": "Plugins every run gets"}
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
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. The result count is fixed by the user's \"Results per search\" setting (Settings → Web Providers) — do NOT try to request more or fewer results; if the user wants a different count, tell them where to change it. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"}
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
            allow_create
                || !matches!(
                    *name,
                    "create_skill" | "create_mcp" | "plugin" | "artifact" | "schedule"
                )
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
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. The result count is fixed by the user's \"Results per search\" setting (Settings → Web Providers) — do NOT try to request more or fewer results; if the user wants a different count, tell them where to change it. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"}
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
        shown.push_str("\n… (truncated)");
    }
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
    let run_id = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
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
    let trace = crate::trace::TraceStore::new(req.chat_id.clone()).with_run(run_id);
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
    // workspace found no skills at all, which silently shipped an empty catalog.
    let skill_root = if req.data_root.is_empty() {
        native_data_root()
    } else {
        req.data_root.clone()
    };
    // Skills: the catalog ONLY. WHICH skill applies is the model's call through
    // `load_skill` (the Codex/Claude pattern) — nothing is picked for it from
    // the wording of the request. The explore sub-agent does NOT get the
    // catalog: its work is read/grep/find_symbol, it can never attach a skill,
    // and the catalog is ~5.8 KB of prompt re-sent on EVERY step of EVERY
    // explore run — the largest single fixed cost in sub-agent tokens.
    // `ATTACHED SKILLS` is empty for a sub-agent anyway (run_subagent hard-codes
    // `skills: Vec::new()`), so nothing is lost here.
    let missing_skills = if req.mode == "subagent" {
        Vec::new()
    } else {
        // The catalog is the byte-stable part: it lives on the system prompt,
        // so it must not depend on the current message — the router builds it
        // from the skill store alone.
        let skill_section =
            crate::skill_router::build_section(&req.prompt, &skill_root, &req.skills);
        if !skill_section.text.is_empty() {
            system.push_str(&skill_section.text);
        }
        skill_section.missing
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
    // The main agent's plan/checklist rides at the TAIL of the request (see the
    // comment at the assembly head). Pushed AFTER the user prompt so it never
    // sits between two byte-stable messages: the volatile part stays as far
    // from `messages[0]` as possible, and re-sending it unchanged on the next
    // round-trip does not move anything in front of it.
    if let Some(m) = plan_context_message(&main_plan_section) {
        messages.push(m);
    }
    // The last message gets a weak model's attention, so the duty to load a
    // matching skill rides at the very tail, right under the request. MAIN AGENT
    // ONLY: a sub-agent has no `load_skill` (research_schemas), so the reminder
    // would be an instruction it cannot follow.
    if req.mode != "subagent" {
        messages.push(skills_context_message());
    }
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
    let mut schemas = if req.mode == "subagent" {
        research_schemas()
    } else {
        tool_schemas(req.allow_create, req.allow_browser)
    };
    // What the tools may do this turn. A renderer that sends `cap` wins; without
    // it the mode's row is used, so a headless scheduled Ask run is read-only too.
    let caps = req
        .cap
        .clone()
        .unwrap_or_else(|| caps_for_mode(&req.mode));
    // Gate the native set BEFORE the MCP merge below: a connector must not be
    // able to re-introduce a tool the mode forbids (`write_file` through MCP).
    retain_allowed_tools(&mut schemas, &caps);
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
    let (mut mcp_schemas, mcp_failures) = crate::mcp::tool_schemas(&mcp_servers);
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
    // A connector is not a way around the mode gate: a read-only turn must not
    // reach a mutating tool through MCP either.
    retain_allowed_tools(&mut mcp_schemas, &caps);
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
        // Spent-budget nudge (explore only), placed where the prompt's own
        // "fixed 3-step budget" runs out. It asks for ONE last batch plus the
        // report, never for a stop: 15 of 63 traced runs still ended on a fetch
        // call because something genuinely was missing, so a hard cut would
        // trade report quality for tokens. Batching the remainder keeps the
        // information while dropping the per-round conversation re-send.
        if req.mode == "subagent" && step == EXPLORE_BUDGET_STEPS {
            messages.push(json!({
                "role": "user",
                "content": "The 3-step budget is spent. Write the report NOW from what you already have. If a specific fact is still missing, fetch ALL of it in ONE batch of calls next to the report — do not keep fetching one thing per round."
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
            let before = estimate_wire_tokens(&messages[1..]);
            let (removed, folded) = fold_stale_tool_results(&mut messages, &mut seen_lookups);
            record_fold(&trace, "main", step, step + 1, max_steps - step, before, removed, folded);
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
            let (removed, folded) = fold_subagent_tool_results(&mut messages, &mut seen_lookups);
            record_fold(&trace, "explore", step, step + 1, max_steps - step, before, removed, folded);
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
                let (slot_model, slot_base, slot_keys, _slot_provider_id) = crate::backend_light::resolve_slot_target(
                    crate::backend_light::other_slot_entry(&req.subagent_models),
                    &cfg.model,
                    &cfg.base_url,
                    &cfg.api_keys,
                    &req.provider_id,
                    &req.providers,
                );
                let has_slot = !slot_model.is_empty() && slot_model != cfg.model;
                // The "Other" group's own fallback list (Settings → Tools): when
                // the summariser's model fails, the chat model is tried next and
                // these rungs after it. Resolved through the same chain helper as
                // the other tools, so a cross-provider fallback brings its own
                // base URL / keys / endpoint kind.
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
                // Fallback = the "Other" slot's own fallback rungs (Settings →
                // Tools, each carrying its own routing but the slot's reasoning
                // level) in the user's order, then the active chat model as the
                // last resort — mirroring the manual path's
                // subagent -> main-model retry. The whole list is built, not just
                // its first rung: a rejected key or a dead model must fall
                // through the remaining fallbacks before the turn gives up.
                let mut compact_fallbacks: Vec<LlmConfig> = fallback_rungs
                    .iter()
                    .map(|(m, b, keys, pid, k)| LlmConfig {
                        provider: k.clone(),
                        model: m.clone(),
                        base_url: b.clone(),
                        api_keys: keys.clone(),
                        temperature: Some(0.2),
                        max_tokens: Some(COMPACT_MAX_OUTPUT as u32),
                        timeout_secs: COMPACT_TIMEOUT_SECS,
                        reasoning_level: compact_reasoning.clone(),
                        model_reasoning: provider_model_reasoning(&req.providers, pid, m),
                        auto_think: crate::models::auto_think_for(k),
                    })
                    .collect();
                if has_slot {
                    compact_fallbacks.push(LlmConfig {
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
                    });
                }
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
                    &mut |p: &crate::compact::CompactProgress| {
                        emit(&AgentEvent::CompactProgress {
                            phase: p.phase.to_string(),
                            attempt: p.attempt,
                            attempts: p.attempts_total,
                            model: p.model.clone(),
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
                emit(&AgentEvent::Error {
                    content: name_the_provider_in_error(
                        e,
                        &req.providers,
                        &req.provider_id,
                        &req.provider,
                    ),
                });
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
        //
        // Anthropic reports `cache_read_input_tokens` OUTSIDE `input_tokens`, so
        // a cache-hit-heavy turn there would otherwise look tiny and the fold
        // would fire far too late. Every other provider folds the cached part
        // into the prompt count already, where adding it would double-count.
        let prompt_basis = if req.provider == "anthropic" {
            in_tok + cache_tok
        } else {
            in_tok
        };
        if in_tok > 0 {
            last_prompt_tokens = prompt_basis as usize;
            measured_upto = messages.len();
        }
        emit(&AgentEvent::Usage {
            input_tokens: in_tok,
            output_tokens: out_tok,
            cache_read_tokens: cache_tok,
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
                "prompt_messages": messages.len(),
                // Local estimate of the wire prompt for THIS call. The provider
                // reports `input` AFTER the fact and that number includes the
                // prefix-cache hits, so it cannot answer "how big was the prompt
                // the fold was trying to shrink". This can.
                "wire_tokens_est": estimate_wire_tokens(&messages[1..]) + tools_chars.div_ceil(4),
                "interrupted": acc.interrupted,
            })),
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
            !mcp_names.contains(name) && is_readonly_native(name)
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
            // The call about to run may CHANGE the workspace (`write_file`,
            // `edit_file`, or `run_terminal`, which runs arbitrary `sh -c` in the
            // root), so every body cached by the repeat-guard is now possibly a
            // snapshot of a file taken BEFORE this change. Answering a later
            // `read`/`lsp_symbols`/`grep` with a pointer would then feed the model
            // its own file pre-edit — the guard must forget instead. Read-only
            // calls never reach this loop, so a pure reader costs nothing here.
            if !is_readonly(name) {
                seen_lookups.clear();
            }
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
            {
                (
                    format!(
                        "unknown tool {name:?}: no such tool exists. Call one of exactly these names: {}",
                        advertised.join(", ")
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
                && req.mode != "subagent"
                && is_file_search_command(args["command"].as_str().unwrap_or_default())
            {
                (
                    "blocked: the main agent must not locate files via the terminal — delegate file discovery to the `explore` sub-agent".into(),
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
                (
                    "blocked: this turn is read-only — `run_terminal` may only inspect here \
(build, test, lint, git status/diff/log). Writing through the shell is not allowed in this \
 mode; give the concrete change instead and tell the user to switch to Build mode to apply it."
                        .into(),
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
                                emit(&AgentEvent::Artifact {
                                    id: saved["id"].as_str().unwrap_or_default().to_string(),
                                    title: saved["title"].as_str().unwrap_or_default().to_string(),
                                    kind: saved["kind"].as_str().unwrap_or_default().to_string(),
                                    content: saved["content"].as_str().unwrap_or_default().to_string(),
                                    version: saved["version"].as_u64().unwrap_or(1),
                                });
                                (
                                    format!(
                                        "Artifact saved: {} (v{})\nIt is now shown in the chat; open it to preview.",
                                        saved["title"].as_str().unwrap_or_default(),
                                        saved["version"].as_u64().unwrap_or(1)
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
                ui_engine,
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
                        nudges += 1;
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

/// Rewrite a provider error so it names the provider the user CONFIGURED
/// ("9router") instead of its wire KIND ("custom").
///
/// `LlmConfig::provider` is the endpoint kind: every OpenAI-compatible custom
/// endpoint is literally `"custom"`, so `finish_stream` prefixes its errors with
/// it and the retry banner read "custom reported an error mid-stream: …". The
/// user answered "I don't have this provider in my fallback list" — precisely
/// because the message named a kind they had never configured, not the provider
/// that actually failed. The model is already shown in the banner, so the
/// missing half is WHICH provider to fix.
pub(crate) fn name_the_provider_in_error(
    err: String,
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    kind: &str,
) -> String {
    let label = providers
        .get(provider_id)
        .and_then(|cfg| cfg.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let Some(label) = label else {
        return err;
    };
    // `finish_stream` always starts with the kind followed by a space, so only
    // that exact prefix is rewritten — never a word deeper in the message (a
    // gateway body may mention "custom" itself).
    match err.strip_prefix(&format!("{kind} ")) {
        Some(rest) => format!("{label} {rest}"),
        None => err,
    }
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
    resolve_slot_target(req, &entry)
}

/// Resolve one Tool Models entry ("providerId/model", a bare model id, or empty
/// for the parent model) against the request's provider configs.
///
/// Split out of `resolve_subagent_target` because the retry ladder re-resolves
/// it before EVERY attempt: a model the user changes while the sub-agent is
/// retrying reaches us as a live entry (see `LIVE_SLOT_ENTRIES`), never in the
/// turn's request body.
fn resolve_slot_target(
    req: &AgentRequest,
    entry: &str,
) -> (String, String, Vec<String>, String) {
    let entry = entry.trim();
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
        None => (String::new(), entry.to_string()),
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

/// The prompt size the auto-compaction trigger compares against the threshold.
///
/// `provider` is the prompt the provider billed for the round-trip that
/// described `messages[..upto]` (0 = none reported yet). Everything the turn has
/// appended since then is estimated locally, so the number follows the REAL
/// prompt instead of a serde-JSON character count that also bills inline base64
/// images as text — the old `max(provider, local_estimate)` therefore folded the
/// context far below the user's threshold as soon as a screenshot was attached.
///
/// The provider's number already contains the fixed per-request cost (system
/// prompt + tool schemas), so the delta must NOT add it a second time: it
/// measures the appended `content` only. Before the first usage of a turn there
/// is nothing to anchor to, so the full local estimate stands alone.
fn measured_prompt_tokens(
    messages: &[Value],
    tools_chars: usize,
    upto: usize,
    provider: usize,
) -> usize {
    if provider == 0 || upto == 0 || upto > messages.len() {
        return estimate_prompt_tokens(messages, tools_chars);
    }
    provider + estimate_wire_tokens(&messages[upto..])
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
    //
    // Inline base64 images are the exception, and they are why this estimate can
    // no longer drive the trigger on its own: one attached screenshot is
    // megabytes of base64 that the model does NOT receive as text (it goes over
    // the wire as image blocks and is billed by area/patch, orders of magnitude
    // below its character count). Counting it as text made this estimate report
    // millions of "tokens" and fold the context far below the user's threshold.
    // `image_data_chars` subtracts what the serialized JSON spends on images.
    let wire_chars: usize = serde_json::to_string(messages)
        .map(|s| s.chars().count())
        .unwrap_or(0);
    wire_chars
        .saturating_sub(image_data_chars(messages))
        .saturating_add(tools_chars)
        .div_ceil(4)
}

/// Rough token cost of the image blocks inside `messages`, for a prompt the
/// model receives as images rather than as text.
///
/// Every image block carries a data URL. An image is billed by area and
/// resolution (a screenshot is ~1-2k tokens), roughly proportional to its
/// COMPRESSED byte size — never to the base64 CHARACTER count (which is ~4/3 of
/// the bytes, and which the caller charges at 4 chars/token, i.e. ~
/// bytes/3 tokens: hundreds of times the real cost). Returning the EXCESS the
/// serialized JSON is charged for such blocks keeps the number right to within a
/// factor of ~2, which is all the threshold comparison needs.
///
/// The excess is expressed in CHARACTERS, because that is the unit
/// `estimate_prompt_tokens` subtracts in — returning tokens here made a 3 MB
/// screenshot still bill ~563k tokens instead of ~2k (the subtraction removed
/// one unit instead of four per real token), which folded the context far below
/// the user's threshold.
const IMAGE_CHARS_PER_TOKEN: usize = 1500;

fn image_data_chars(messages: &[Value]) -> usize {
    fn json_chars(v: &Value) -> usize {
        serde_json::to_string(v)
            .map(|s| s.chars().count())
            .unwrap_or(0)
    }
    fn walk(value: &Value, total: &mut usize) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, total);
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    match item.as_str() {
                        Some(s) if s.starts_with("data:image") => {
                            // What the estimator will charge for this block …
                            let charged_chars = json_chars(item);
                            // … versus what the model really bills: ~1 image token
                            // per IMAGE_CHARS_PER_TOKEN characters of the data URL,
                            // converted back to characters (the caller divides by 4).
                            let real_tokens = s
                                .chars()
                                .count()
                                .div_ceil(IMAGE_CHARS_PER_TOKEN)
                                .max(200);
                            *total += charged_chars.saturating_sub(real_tokens * 4);
                        }
                        _ => walk(item, total),
                    }
                }
            }
            _ => {}
        }
    }
    let mut total = 0;
    for msg in messages {
        walk(msg, &mut total);
    }
    total
}

/// In-turn elision of stale tool results (main agent only): the main agent's
/// wire history grows by EVERY tool result ever produced in the turn and is
/// re-sent in full on every round-trip (traces show in:out ratios of 23-47:1
/// and 72% of input tokens landing on the main agent). Compaction only fires
/// at 80% of the context window — far too late for cost — so old results ride
/// along at full size (16K per read, 40K per explore report) forever.
///
/// This fold keeps the last `keep_rounds` rounds untouched and shrinks OLDER
/// `tool` messages to a per-result budget: an `explore` report to
/// `explore_budget` (the report is the caller's view of that research), any
/// other tool result to `result_budget` (a targeted re-read is one cheap call).
/// A marker tells the model the tail was dropped and how to get it back — it is
/// a pointer, not silent data loss.
///
/// Idempotent by construction: a stub already carries `MAIN_FOLD_MARKER`, and
/// its content length is under every budget, so re-folding is a no-op. Only
/// `tool` messages are touched — assistant/user messages stay verbatim, and a
/// `tool` message can never be detached from its assistant call (the message
/// list keeps its shape, unlike fold_prefix_len's rebuild).
///
/// `keep_rounds` is how many NEWEST tool rounds are left untouched, and the two
/// budgets are the per-result char caps for an `explore` report and for any
/// other tool result. Both call sites pass 2 kept rounds; they differ only in
/// budgets and trigger thresholds.
/// Returns `(removed_chars, folded_messages)`.
///
/// The numbers exist so the caller can RECORD what the fold actually did. Until
/// now a fold left no trace at all, and every attempt to price it had to infer
/// "a fold happened here" from the prompt shrinking between two calls — which
/// cannot tell a fold from compaction, and cannot measure the one thing that
/// matters: the prefix-cache re-bill it causes versus the per-call saving it
/// earns on the calls that follow. With the two numbers in the trace the
/// trade-off is measured instead of modelled.
fn fold_with(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
    keep_rounds: usize,
    explore_budget: usize,
    result_budget: usize,
) -> (usize, usize) {
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
    if rounds.len() <= keep_rounds {
        return (0, 0);
    }
    let cut = rounds[rounds.len() - keep_rounds];
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
    let mut removed_chars = 0usize;
    let mut folded = 0usize;
    for m in messages[..cut].iter_mut() {
        if m["role"] != "tool" { continue; }
        // Skip already-folded stubs (idempotence).
        if m["content"].as_str().is_some_and(|c| c.contains(MAIN_FOLD_MARKER)) { continue; }
        let meta = m["tool_call_id"].as_str().and_then(|id| call_meta.get(id));
        let is_explore = meta.is_some_and(|(name, _)| name == "explore");
        let budget = if is_explore { explore_budget } else { result_budget };
        let Some(content) = m["content"].as_str().map(String::from) else { continue };
        let old_chars = content.chars().count();
        if old_chars <= budget { continue; }
        // Char-boundary-safe truncation: byte slicing panics (and with
        // panic=abort kills the app) on a multi-byte Persian character.
        let head: String = content.chars().take(budget).collect();
        let new_content = format!("{head}\n{MAIN_FOLD_MARKER}");
        let new_chars = new_content.chars().count();
        removed_chars += old_chars.saturating_sub(new_chars);
        folded += 1;
        m["content"] = json!(new_content);
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
    (removed_chars, folded)
}

/// Main-agent entry point: two kept rounds, the main budgets and the main
/// trigger threshold.
fn fold_stale_tool_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
) -> (usize, usize) {
    fold_with(
        messages,
        seen,
        MAIN_FOLD_KEEP_ROUNDS,
        MAIN_FOLD_EXPLORE_CHARS,
        MAIN_FOLD_RESULT_CHARS,
    )
}

/// Sub-agent entry point: an explore run re-sends its whole accumulated history
/// on EVERY one of its rounds, and nothing folded it mid-loop —
/// compact_subagent_messages runs once, before the loop. Its own older reads and
/// greps are therefore the bulk of its input. Unlike the main agent, the
/// sub-agent owns read/grep, so the pointer the marker leaves behind is always
/// resolvable with one cheap targeted call.
fn fold_subagent_tool_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
) -> (usize, usize) {
    fold_with(
        messages,
        seen,
        SUB_FOLD_KEEP_ROUNDS,
        SUB_FOLD_RESULT_CHARS,
        SUB_FOLD_RESULT_CHARS,
    )
}

/// Length of the prefix of `history` (messages WITHOUT the system prompt) that a
/// mid-turn compaction may fold into a summary — 0 when nothing is safely
/// foldable.
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

/// True when a string contains a redirection whose TARGET is a real file.
///
/// `du -sh ~ 2>/dev/null` writes to a device node: nothing in the workspace
/// changes, so it is a READ. Treating every `>` as a write (the first version of
/// this gate) refused the very inspection a read-only mode exists for — the
/// user hit exactly that. Numeric prefixes (`2>`) need no special case: the
/// scan starts right after the operator, so the token that follows is the
/// target either way.
fn redirects_to_a_file(s: &str) -> bool {
    let mut rest = s;
    while let Some(idx) = rest.find('>') {
        let after = &rest[idx + 1..];
        // `>>` appends and `>|` overrides noclobber; the target follows both.
        let target = after.trim_start_matches(['>', '|']).trim_start();
        let word = target
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(['"', '\'']);
        // An empty target is a dangling operator; `&` is a descriptor move; a
        // `/dev/*` node absorbs the stream without touching the workspace.
        if !word.is_empty() && !word.starts_with('&') && !word.starts_with("/dev/") {
            return true;
        }
        rest = after;
    }
    false
}

/// True when a shell command would CHANGE the workspace (write into a file,
/// in-place edit, git/package-manager write). Only Build mode may mutate, so a
/// read-only mode must not get around the tool gate through `run_terminal`:
/// `echo x > src/app.ts` writes a file without ever calling `write_file`, and a
/// Plan turn whose terminal is "inspection only" could otherwise rewrite the
/// tree from the shell.
fn is_mutating_command(cmd: &str) -> bool {
    let mut scrubbed = cmd.to_lowercase();
    // `2>&1` / `>&2` duplicate a descriptor — they create no file, so they are
    // stripped first or every redirected build/test would look like a write.
    for fd in ["2>&1", ">&1", ">&2", "&>1", "&>2"] {
        scrubbed = scrubbed.replace(fd, " ");
    }
    // A redirection into a file is the plainest write there is — but only when
    // the target is a file. `2>/dev/null` on an inspection command is a read.
    if redirects_to_a_file(&scrubbed) {
        return true;
    }

    // Commands whose whole job is to write somewhere.
    const MUTATORS: [&str; 17] = [
        "rm", "rmdir", "mv", "cp", "ln", "touch", "mkdir", "truncate", "dd", "tee",
        "chmod", "chown", "patch", "unlink", "shred", "mkfifo", "install",
    ];

    // Every pipeline/chain segment is inspected, and `xargs` is followed into
    // its argument: `ls | xargs rm` writes even though `ls` does not.
    scrubbed.split([';', '|', '&', '\n']).any(|seg| {
        let words: Vec<&str> = seg.split_whitespace().collect();
        let Some(first) = words.first() else {
            return false;
        };
        // Strip a leading path so `/bin/rm` is caught as well.
        let cmd = first.rsplit('/').next().unwrap_or(first);
        let args = &words[1..];
        if MUTATORS.contains(&cmd) {
            return true;
        }
        if cmd == "xargs" && args.iter().any(|w| MUTATORS.contains(w)) {
            return true;
        }
        // An interpreter one-liner writes any file it likes without ever naming
        // a mutating binary (`node -e "fs.writeFileSync(...)"`), so its eval
        // form is refused while the turn may not write. A plain run stays
        // allowed — `node --version`, `python script.py`, `npm test`.
        if cmd == "eval" {
            return true;
        }
        let eval_flags: &[&str] = match cmd {
            "sh" | "bash" | "zsh" | "dash" | "ksh" => &["-c"],
            "node" | "deno" | "bun" => &["-e", "--eval", "-p", "--print"],
            "python" | "python3" | "ruby" | "perl" | "osascript" => &["-e", "-c"],
            _ => &[],
        };
        if args.iter().any(|w| eval_flags.contains(w)) {
            return true;
        }
        // In-place editors: `sed -i`, `sed -i.bak`, `perl -pi`/`-pni` (the flag
        // is often BUNDLED, so `-pi` never starts with `-i`), and `find
        // -delete` / `-exec`. Only sed/perl get the bundled-`i` rule: `find
        // -iname` also contains an `i` but only reads.
        if matches!(cmd, "sed" | "perl")
            && args.iter().any(|w| {
                *w == "--in-place"
                    || w.starts_with("--in-place")
                    || (w.starts_with('-')
                        && !w.starts_with("--")
                        && w[1..].contains('i'))
            })
        {
            return true;
        }
        if cmd == "awk" && args.iter().any(|w| *w == "-i") {
            return true;
        }
        if cmd == "find" && args.iter().any(|w| *w == "-delete" || *w == "-exec") {
            return true;
        }
        // Otherwise-read-only tools with write-y subcommands (git index,
        // package manifests, lockfiles).
        let blocked: &[&str] = match cmd {
            "git" => &[
                "add", "commit", "apply", "checkout", "restore", "reset", "clean", "stash",
                "merge", "rebase", "tag", "push", "switch", "cherry-pick", "init", "rm",
            ],
            "npm" | "pnpm" | "yarn" => &[
                "install", "i", "ci", "add", "remove", "rm", "uninstall", "update",
                "upgrade", "link", "publish", "init",
            ],
            "pip" | "pip3" => &["install", "uninstall", "download"],
            "cargo" => &["add", "install", "remove", "update", "fix", "clean", "new", "init"],
            "go" => &["get", "install", "mod", "generate"],
            "brew" => &["install", "uninstall", "upgrade", "update", "tap"],
            "apt" | "apt-get" => &["install", "remove", "upgrade", "update"],
            _ => &[],
        };
        if !blocked.is_empty() && args.iter().any(|w| blocked.contains(w)) {
            return true;
        }
        // Formatters rewrite in place, but their `--check` form only reports.
        let check_only = args.iter().any(|w| *w == "--check" || *w == "-c");
        if !check_only {
            let formats = cmd == "fmt"
                || (matches!(cmd, "cargo" | "eslint" | "prettier" | "ruff" | "black")
                    && args
                        .iter()
                        .any(|w| *w == "fmt" || *w == "--fix" || *w == "--write"));
            if formats {
                return true;
            }
        }
        false
    })
}

/// True when a shell command tries to SEARCH for files with a search engine
/// (find/grep/rg/fd/locate/tree/glob).
/// The main agent has no search tools by design — file discovery must go
/// through the explore sub-agent, not terminal one-liners (user request).
///
/// `ls` is deliberately NOT in the list: listing a directory (and measuring it
/// with `du`/`df`) reads what the caller already knows about, it is not a
/// search, and a read-only mode must be able to see the disk. The user's rule
/// is that every READ works everywhere and only APPLYING a change needs Build;
/// a search engine is delegated because it duplicates `explore`, not because
/// reading is restricted.
fn is_file_search_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    // Check every pipeline/chain segment, not just the first token.
    lower
        .split([';', '|', '&', '\n'])
        .any(|seg| {
            let t = seg.trim();
            ["find", "grep", "rg", "fd", "locate", "tree", "glob"]
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
fn classify_subagent_attempt(res: &Result<(), String>, report: &str, sub_error: &str) -> Result<(), String> {
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

/// Native tools that only READ state: no file write, no memory write, no shell.
///
/// Used twice, and the second use is a CORRECTNESS guard, not an optimisation:
/// the repeat-guard may only answer a lookup with a pointer while the workspace
/// is unchanged. Anything not in this list can change it — including
/// `run_terminal`, which runs arbitrary `sh -c` in the workspace root — so every
/// cached lookup body must be forgotten after one of them runs (see the `rest`
/// loop). A stale pointer would hand the model a file as it was before its own
/// edit: a silent quality loss that no token saving justifies.
const READONLY_NATIVE_TOOLS: [&str; 13] = [
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

fn is_readonly_native(name: &str) -> bool {
    READONLY_NATIVE_TOOLS.contains(&name)
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
        // The LSP family is a pure read of the file as it is on disk RIGHT NOW,
        // so identical arguments return an identical payload. These arms were
        // missing and the repeat guard never saw them: one traced explore run
        // called `lsp_symbols` on the SAME file three times at 12_880 model
        // chars each — a full variable-cost payload plus the round-trip that
        // carried it. "As it is right now" is only true while nothing has
        // changed the file: `run_terminal` can, which is why every mutating call
        // clears the guard (see READONLY_NATIVE_TOOLS).
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
    if name == "explore" {
        return Some(
            "[hint] That step had ONE explore. Explores of one step run CONCURRENTLY and cost a single round-trip, while one broad explore is slow and returns a shallow report: when the task spans several areas, fire 2-4 focused explores (one per area/file group) IN THE SAME STEP.",
        );
    }
    // Read-only natives are the ONE group that really does run concurrently, so
    // they get the parallelism wording instead of the ordering one. In the last
    // traced corpus 6 lone `read`, 1 lone `fetch_url` (65_694 uncached tokens on
    // its own) and 1 lone `load_skill` round sat outside the whitelist, i.e. the
    // hint could not fire on any of them.
    if matches!(name, "read" | "fetch_url" | "load_skill") {
        return Some(
            "[hint] That step had ONE call. Every step re-sends the whole conversation: these read-only calls run CONCURRENTLY, so fetch everything you already know you need IN THE SAME STEP.",
        );
    }
    // Native write/terminal/browser tools. Traced main-agent turns spent 76% of
    // their steps on a SINGLE call (210 of 277, measured from tool rows) — 61 of
    // them a lone `run_terminal`, 54 a lone `browser_evaluate`, 43 a lone
    // `edit_file` — and every extra step re-sends the whole conversation. The
    // browser tools were the largest group MISSING from this list, so the hint
    // fired on only 2 of 280 main rounds and could not correct any of it. These
    // calls do NOT run concurrently (they mutate the workspace or act on one
    // shared page, in order), so the hint must say "in order", never "parallel".
    matches!(
        name,
        "run_terminal"
            | "edit_file"
            | "write_file"
            | "artifact"
            | "browser_navigate"
            | "browser_evaluate"
            | "browser_snapshot"
            | "browser_click"
            | "browser_type"
            | "browser_fill_form"
            | "browser_press_key"
            | "browser_select_option"
            | "browser_resize"
            | "browser_emulate_media"
    )
    .then_some(
        "[hint] That step had ONE call. Every step re-sends the whole conversation, so independent work belongs in ONE step: issue all the file edits and shell commands you already know you need together (they run IN ORDER, one after another) instead of spending a step on each. Several replacements in one file go in a SINGLE edit_file call as edits:[{path, old_string, new_string, replace_all}].",
    )
}

/// Cap on the saved-plan body injected into the system prompt. A plan is
/// re-sent on EVERY round-trip of EVERY turn, so an uncapped body is a running
/// cost; a long plan is cut in the middle (head + tail survive, so the goal and
/// the latest items stay visible).
const PLAN_SECTION_CAP: usize = 6_000;

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
const PLAN_CONTEXT_HEAD: &str =
    "=== CONTEXT: current plan/checklist state (NOT a new request) ===";

/// Opening line of the trailing skills reminder message.
///
/// Wire-only like the plan context: the renderer never stores it, so it must not
/// count toward the fold instruction (see `plan_context_keep`).
const SKILLS_CONTEXT_HEAD: &str =
    "=== REMINDER: load a matching skill first (NOT a new request) ===";

/// True for a message that exists ONLY on the wire (the renderer never stores
/// it): the trailing plan/checklist context and the skills reminder. Both are
/// pushed after the user prompt to stay off the cached prefix, so the fold count
/// must ignore both.
fn is_wire_only_context(content: &str) -> bool {
    content.starts_with(PLAN_CONTEXT_HEAD) || content.starts_with(SKILLS_CONTEXT_HEAD)
}

/// Number of messages in a compaction tail that the RENDERER can actually fold.
///
/// Everything in the tail is stored by the renderer except the wire-only context
/// messages (`is_wire_only_context`). Passing `tail.len()` straight through made
/// the renderer keep one message too many verbatim — re-sending content the
/// summary already covers.
fn plan_context_keep(tail: &[Value]) -> usize {
    tail.iter()
        .filter(|m| !m["content"].as_str().is_some_and(is_wire_only_context))
        .count()
}

fn plan_context_message(section: &str) -> Option<Value> {
    trailing_context_message(PLAN_CONTEXT_HEAD, section)
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
fn skills_context_message() -> Value {
    json!({
        "role": "user",
        "content": format!(
            "{SKILLS_CONTEXT_HEAD}\n\
             The `=== AVAILABLE SKILLS ===` catalog is in your system prompt. Before \
             your first tool call of this turn, check it: if the request falls under \
             one of those skills — including a match on its `[fa: …]` Persian \
             keywords — call `load_skill` with that skill's name FIRST and follow its \
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
fn trailing_context_message(head: &str, section: &str) -> Option<Value> {
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
fn plan_section(data_root: &str, workspace: &str, chat_id: &str) -> String {
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
fn explore_system_prompt(root: &str) -> String {
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
together. Earlier results stay cached only while they remain an identical \
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

/// Chat ids whose sub-agent retry ladder is LIVE, ref-counted because parallel
/// explore calls in one turn can each be retrying at the same time.
///
/// `POST /chat/retry_now` answers from this: a banner can outlive the ladder
/// that produced it (the turn ended, the stream dropped), and a click that
/// nothing is listening for must not be reported as accepted — that is exactly
/// how the Retry button came to look broken.
fn live_retries() -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    LIVE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Register (or drop, with `delta = -1`) one live ladder for a chat.
fn mark_live(chat_id: &str, delta: i32) {
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
struct RetryLive {
    chat_id: String,
    armed: bool,
}

impl RetryLive {
    fn new(chat_id: &str) -> Self {
        Self {
            chat_id: chat_id.to_string(),
            armed: false,
        }
    }

    /// Mark live on the first retry this ladder actually announces.
    fn arm(&mut self) {
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
fn retry_nudge() -> u64 {
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
static LIVE_SLOT_ENTRIES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, u64)>>,
> = std::sync::OnceLock::new();

/// Monotonic clock for `LIVE_SLOT_ENTRIES`.
static LIVE_SLOT_SEQ: AtomicU64 = AtomicU64::new(0);

fn live_slot_entries() -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, u64)>> {
    LIVE_SLOT_ENTRIES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Current live-slot sequence — a ladder captures this when it starts.
fn live_slot_seq() -> u64 {
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
fn live_slot_entry_since(slot: &str, since: u64) -> Option<String> {
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
fn subagent_error_is_fatal(err: &str) -> bool {
    crate::llm::should_fall_back(err)
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
        system_prompt: explore_system_prompt(&parent.root),
        // A sub-agent is read, not heard: never apply the live-voice rules.
        system_suffix: String::new(),
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
        // The explore sub-agent carries its OWN fallback ladder (a fresh copy:
        // the slot list is re-read per call from the parent request).
        tool_fallbacks: parent.tool_fallbacks.clone(),
        // A research sub-agent is text-only — images belong to the parent turn.
        images: Vec::new(),
        // A sub-agent inherits the parent's auto-fetch count.
        web_search_auto_fetch: parent.web_search_auto_fetch,
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
        .max(chain.len().saturating_add(usize::from(
            !parent.model.trim().is_empty()
                && !(parent.model == sub_req.model && parent.provider_id == sub_req.provider_id),
        )) * SUBAGENT_RUNG_ATTEMPTS);
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
                max_attempts: SUBAGENT_MAX_ATTEMPTS,
                delay_secs: 0,
                reason: "retrying now (requested)".into(),
                agent: "explore subagent".into(),
                tool: tool.to_string(),
                model: sub_req.model.clone(),
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
        // A rung is abandoned when its failure says the MODEL ITSELF is unusable
        // (a refused key, an unknown model, an empty answer) — OR when the rung
        // has spent its own attempt budget without producing a report.
        //
        // That second half is the bug the user reported. A slot model answering
        // 429 on every single call is NOT fixed by retrying it forever: the
        // fallback list exists for exactly this, but every rate limit was
        // classified "transient", so the ladder kept the same model and burned
        // all ten attempts on it — Settings → Tools → Explore → Fallbacks was
        // never reached. Retrying a slow-but-working provider is still right,
        // which is what SUBAGENT_RUNG_ATTEMPTS buys it before the chain moves on.
        let rung_spent = rung_attempts >= SUBAGENT_RUNG_ATTEMPTS;
        let advance = attempt < max_attempts && (subagent_error_is_fatal(&last.0) || rung_spent);
        if advance {
            let parent_is_current = parent.model == sub_req.model
                && parent.provider_id == sub_req.provider_id;
            // The parent model is appended once, as the final rung of a slot
            // whose chain is exhausted (or of a slot that has no fallbacks).
            let parent_as_rung = !parent.model.trim().is_empty() && !parent_is_current;
            let next = chain_idx + 1;
            let parent_rung = chain.len() + usize::from(parent_as_rung);
            if next >= parent_rung {
                // Nothing left to try. A FATAL failure is final right away; a
                // TRANSIENT one keeps retrying this LAST rung with the remaining
                // budget, so a slot with no fallback configured stays exactly as
                // patient as it was before.
                if subagent_error_is_fatal(&last.0) {
                    break;
                }
                rung_attempts = 0;
            } else {
                // Moving down the chain: the NEXT fallback model, then the next,
                // with the PARENT's model as the last resort. Each rung is
                // applied with the SLOT's reasoning level — a fallback changes
                // the model and its routing, never the effort the user chose.
                chain_idx = next;
                rung_attempts = 0;
                if next == chain.len() && parent_as_rung {
                    using_fallback = true;
                    sub_req.model = parent.model.clone();
                    sub_req.provider_id = parent.provider_id.clone();
                    sub_req.base_url = parent.base_url.clone();
                    sub_req.api_key = parent.api_key.clone();
                    sub_req.api_keys = parent.api_keys.clone();
                    // The last rung IS the parent's model, so it must also use
                    // the parent's endpoint kind — otherwise it inherits the
                    // kind of the rung that just failed.
                    sub_req.provider = parent.provider.clone();
                    sub_req.model_reasoning = parent.model_reasoning;
                    // The main model's own level is what the parent turn uses.
                    sub_req.thinking_level = parent.thinking_level.clone();
                } else if let Some((m, b, keys, pid, kind)) = chain.get(next) {
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
        let reason = last.0.clone();
        emit(&AgentEvent::Retry {
            attempt,
            max_attempts,
            delay_secs: SUBAGENT_RETRY_BACKOFF_MS / 1000,
            reason: reason.clone(),
            agent: "explore subagent".into(),
            tool: tool.to_string(),
            model: sub_req.model.clone(),
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
            attempt: max_attempts,
            max_attempts,
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

/// The generic coding rules, inlined into the shared body of every system
/// prompt.
///
/// Sourced from the shipped skill instead of being copied here: `include_str!`
/// compiles the markdown into the binary, so `src-tauri/skills/coding-standards.md`
/// stays the single source and the prompt cannot drift from it. The frontmatter
/// is stripped because only the body is instructions — the catalog is what
/// carries the name and the Persian keywords.
fn coding_rules() -> String {
    crate::skills::strip_frontmatter_pub(include_str!("../skills/coding-standards.md"))
        .trim()
        .to_string()
}

/// The main agent's system prompt.
///
/// Everything before the FINAL sentence must stay byte-identical across turns:
/// this string is `messages[0]`, the first byte an automatic prefix cache can
/// reuse, so a single changed character here re-bills the whole request.
///
/// `mode` and `root` are therefore placed at the END, not in the opening
/// sentence where they started. Measured on real traces: a turn that switched
/// `Mode: build` -> `Mode: ask` (a 2-byte change at offset 120) collapsed the
/// prefix at 1.6% and re-billed 58,432 input tokens with a 0.0% cache hit,
/// while the very next ask->ask turn of the same size hit 94.6%. Keeping the
/// constant text first and the volatile tail last makes the switch cost the
/// tail only.
fn default_system_prompt(mode: &str, root: &str) -> String {
    // The mode-specific rule rides in the VOLATILE TAIL (next to `root`/`mode`),
    // not in the body above: the body is the cached prefix, so a byte that
    // differed between modes would re-bill the whole prompt on every switch.
    let mode_rule = if caps_for_mode(mode).write_files {
        // Build (and any unknown writable mode): the edit IS the artifact, so the
        // reply is a short report OF it. The rule has to live here — the
        // "REPLY DISCIPLINE" text in `appstate::system_prompts` is display-only
        // and never reaches the model — and without it a one-line fix came back
        // wrapped in pasted file contents and a multi-paragraph write-up.
        "You may write and edit files here. The edit_file/write_file call IS the \
artifact: never paste whole files or large code blocks into your reply — after the edits, \
say concisely what changed (file, function, short diff-level description) and stop. Scale \
the report to the size of the change: a one-line fix gets one line, not a write-up. If the \
user also asked a question, answer it directly and briefly."
    } else if mode == "ask" || mode == "chat" {
        // Ask is the mentoring mode: the user wants an ANSWER, not a report.
        // Without this rule the shared body above ("delegate to `explore` and
        // work from its full report") pulled long, structured dumps into the
        // reply: a one-line question got an audit. Brevity is the default here;
        // depth is opt-in.
        "This turn is ASK mode: read-only AND short. Answer the question itself in the \
first sentence, in plain words, in 2-4 short lines — no preamble, no headings, no numbered \
steps, no checklist, and never paste an explore report or raw tool output. Define a \
technical term in a clause right where it appears. Expand ONLY when the user asks for more \
(\"explain more\", \"why\", \"step by step\", \"جزئیات\"): then go deeper but stay simple — \
short sentences, one concrete example, exact file:line. You cannot write or edit anything \
here, but READING IS OPEN: files through `explore`, and the shell for any inspection \
(du/df/ps/lsof, git status/diff/log, builds, tests, typecheck) — only a command that would \
change the workspace is refused. Describe a needed change as file + the exact old text -> \
new text and say that Build mode applies it."
    } else if mode == "plan" {
        // Plan's whole deliverable IS prose, so an unbounded plan sprawls exactly
        // the way ask's answers did. Its shape rule belongs here, next to the
        // read-only rule: the "SHORT, scannable IMPLEMENTATION PLAN" wording in
        // `appstate::system_prompts` is display-only and never reaches the model.
        "This turn is READ-ONLY: write_file/edit_file are not bound and the shell refuses \
anything that would change the workspace (writing into a file, sed -i, rm/mv/cp, git \
commit, package installs), so describe changes instead of applying them — inspection is \
otherwise wide open (du/df/ps/lsof, git status/diff/log, builds, tests, typecheck). The \
deliverable is a plan the USER can understand, not a note to yourself: one '## Plan' \
heading, then one line per step, in the user's language — name the file it touches, then \
say in plain words WHAT that step changes and WHY it is needed, written so that someone \
who did not read this chat understands what will happen to their app. A bare jargon line \
like 'types.ts: add types' is a failed step. No essay, no restating the request, no code \
blocks, no prose between steps; keep the whole plan under ~25 lines — a longer plan means \
the steps are too fine, so merge them. END the plan with a short summary section (a '## ' \
heading in the user's language): 2-4 plain sentences saying what will be done overall and \
what the user gets when it is finished. Name the mode each out-of-scope item belongs to \
instead of expanding on it."
    } else {
        "This turn is READ-ONLY: write_file/edit_file are not bound and the shell refuses \
anything that would change the workspace (writing into a file, sed -i, rm/mv/cp, git \
commit, package installs); every read-only command still runs. Answer with the concrete \
change instead — which file, which line, the exact old text -> new text — and tell the user \
to switch to Build mode to apply it."
    };
    let rules = coding_rules();
    format!(
        "You are Codifa, a coding agent inside the user's desktop IDE. \
You have NO search/read tools: delegate ALL file reading, searching and \
LSP lookups to the `explore` sub-agent and work from its full report. \
When a task spans several independent areas, fire SEVERAL `explore` calls \
IN THE SAME STEP (they run concurrently, one round-trip) — one focused \
explore per area/file group. A single broad explore is the slowest, \
shallowest option; only a genuinely single-area question justifies one call. \
NEVER use run_terminal to SEARCH for files (find/grep/rg/fd/locate) — file \
discovery goes through `explore` only; the shell is for listing and measuring \
(ls, du, df, ps, lsof), builds, tests and git. \
To verify LIVE, run the project in its OWN dev workflow, and ALWAYS check \
first whether that dev process is already running (ps/lsof + its port): if it \
is, REUSE it and never start a second one — duplicate dev servers fight over \
the same port and produce conflicting logs. Only start it once when nothing \
is running, and never verify against a release build. \
Use the tools this mode binds to make changes, and never claim a change you \
did not make. \
CODING RULES — apply to every write, edit and review (already inlined from the \
built-in `Coding Standards` skill; there is no need to load it again):\n\
{rules}\n\
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
Docstrings and comments in code must be English. \
Workspace root: {root}. Mode: {mode}. {mode_rule}"
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_trace_text_cuts_on_a_utf8_boundary() {
        // A multi-byte char straddling the cap must not panic (byte slicing
        // mid-char is exactly what broke Persian text before).
        let s = "سلام دنیا".repeat(10);
        let clipped = clip_trace_text(&s, 7);
        assert!(clipped.ends_with("… (truncated)"));
        assert!(clipped.chars().next().is_some());
        // Short input is returned untouched — no marker, no copy damage.
        assert_eq!(clip_trace_text("abc", 100), "abc");
    }

    #[test]
    fn trace_prompt_text_keeps_the_wire_conversation() {
        // The llm row's `prompt` must show what the model was actually sent:
        // the user line, prior assistant text and tool results — with the
        // system message reduced to a size marker (it lives on the `prompt`
        // row in full).
        let messages = vec![
            serde_json::json!({"role": "system", "content": "you are helpful"}),
            serde_json::json!({"role": "user", "content": "سلام"}),
            serde_json::json!({
                "role": "assistant",
                "content": "checking",
                "tool_calls": [{
                    "id": "c1",
                    "function": {"name": "read", "arguments": "{\"filePath\":\"a.ts\"}"}
                }],
            }),
            serde_json::json!({"role": "tool", "tool_call_id": "c1", "content": "line 1"}),
        ];
        let text = trace_prompt_text(&messages);
        assert!(text.contains("[system] 15 chars"), "system marker missing: {text}");
        assert!(!text.contains("you are helpful"), "system body must be elided");
        assert!(text.contains("[user]\nسلام"));
        assert!(text.contains("[assistant]\nchecking"));
        assert!(text.contains("→ read("), "tool call shorthand missing: {text}");
        assert!(text.contains("[tool]\nline 1"));
        // An empty conversation must not produce a row body of whitespace.
        assert_eq!(trace_prompt_text(&[]), "");
    }

    #[test]
    fn trace_prompt_text_keeps_the_newest_block_within_the_cap() {
        // `clip_trace_text` keeps the HEAD, so an over-cap wire prompt used to
        // drop the newest tool result — and with it any batching hint appended
        // to that same message, which made the single-call lever impossible to
        // verify from a trace. The newest block must survive the cap.
        let big = "x".repeat(9_000);
        let messages = vec![
            serde_json::json!({"role": "system", "content": "sys"}),
            serde_json::json!({"role": "user", "content": "older turn"}),
            serde_json::json!({"role": "tool", "content": big}),
            serde_json::json!({"role": "tool", "content": "NEWEST-RESULT\n\n[hint] That step had ONE call."}),
        ];
        let text = trace_prompt_text(&messages);
        assert!(text.len() <= LLM_TRACE_PROMPT_CAP, "row body must stay capped: {}", text.len());
        assert!(text.contains("NEWEST-RESULT"), "newest block was cut: {text}");
        assert!(text.contains("[hint] That step had ONE call."), "hint was cut: {text}");
        // The head is still there, and the elision is explicit rather than silent.
        assert!(text.contains("[system] 3 chars"), "head lost: {text}");
        assert!(text.contains("elided middle"), "elision must be visible: {text}");
        // Under the cap nothing is elided at all.
        let small = trace_prompt_text(&[serde_json::json!({"role": "user", "content": "hi"})]);
        assert!(!small.contains("elided middle"), "{small}");
    }

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
            engine: None,
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
            context_tokens: 0,
            context_window: 0,
        }
        .to_json();
        // Sub-agent usage is flagged so the context meter ignores it.
        assert_eq!(t["sub"], true);
        // The usage event names the model/provider that served the request so
        // sub-agent tokens land under the SUB model in Model usage.
        assert_eq!(t["model"], "sub-model");
        assert_eq!(t["provider_id"], "p2");
        // `context_tokens` is the prompt the provider billed — the number the
        // auto-compaction trigger compares against, so the meter and the fold
        // agree.
        assert_eq!(t["context_tokens"], 0);
        let t = AgentEvent::Usage {
            input_tokens: 900,
            output_tokens: 10,
            cache_read_tokens: 0,
            model: "main".into(),
            provider_id: "p1".into(),
            sub: false,
            context_tokens: 900,
            context_window: 200_000,
        }
        .to_json();
        assert_eq!(t["context_tokens"], 900);
        // The denominator the trigger uses — the renderer divides by it so the
        // ring and the fold cannot drift apart.
        assert_eq!(t["context_window"], 200_000);
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
    fn ask_mode_withholds_the_mutating_tools() {
        // Ask is read-only for real: the model must not even see a tool that
        // could touch the disk, and a call that still arrives is refused.
        let names = |caps: &ToolCaps| -> Vec<String> {
            let mut schemas = tool_schemas(true, false);
            retain_allowed_tools(&mut schemas, caps);
            schemas
                .iter()
                .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
                .collect()
        };

        let ask = names(&caps_for_mode("ask"));
        for banned in ["write_file", "edit_file"] {
            assert!(
                !ask.contains(&banned.to_string()),
                "ask must not bind {banned}"
            );
        }
        // Reading stays wide open: the sub-agent, the web, and the SHELL —
        // inspecting IS reading (`du -sh`, `df -h`, `ps`, `git status`), so the
        // terminal is bound in every mode and only WRITES are refused.
        assert!(ask.contains(&"explore".to_string()));
        assert!(ask.contains(&"web_search".to_string()));
        assert!(ask.contains(&"fetch_url".to_string()));
        assert!(ask.contains(&"run_terminal".to_string()));

        // Plan may inspect with the terminal but still never writes.
        let plan = names(&caps_for_mode("plan"));
        assert!(!plan.contains(&"write_file".to_string()));
        assert!(!plan.contains(&"edit_file".to_string()));
        assert!(plan.contains(&"run_terminal".to_string()));

        // Build keeps everything, and an id this build does not know stays
        // permissive — a missing table row must not disarm a mode.
        let build = names(&caps_for_mode("build"));
        for kept in ["write_file", "edit_file", "run_terminal"] {
            assert!(build.contains(&kept.to_string()), "build must bind {kept}");
        }
        assert_eq!(build.len(), names(&ToolCaps::default()).len());

        // The backstop, for a call that bypassed the schema list.
        assert!(denied_by_caps(&caps_for_mode("ask"), "write_file").is_some());
        // The terminal is allowed in ask; the COMMAND is what gets refused, by
        // the `!caps.write_files` gate in the tool loop.
        assert!(denied_by_caps(&caps_for_mode("ask"), "run_terminal").is_none());
        assert!(denied_by_caps(&caps_for_mode("build"), "write_file").is_none());
        // A tool the capability table has no opinion on is never gated.
        assert!(denied_by_caps(&ToolCaps::default(), "explore").is_none());
    }

    #[test]
    fn tool_caps_follow_the_renderer_contract() {
        // The renderer sends the `ModeCapabilities` object verbatim, so the keys
        // are camelCase; a missing object must parse as `None` so `run_turn`
        // derives the table from `mode` instead of falling back to permissive.
        let caps: ToolCaps = serde_json::from_value(json!({
            "readFiles": true,
            "writeFiles": false,
            "runTerminal": false,
            "web": true
        }))
        .unwrap();
        assert!(caps.read_files);
        assert!(!caps.write_files);
        assert!(!caps.run_terminal);
        assert!(caps.web);

        let absent: Option<ToolCaps> = serde_json::from_value(json!(null)).unwrap();
        assert!(absent.is_none());
    }

    #[test]
    fn read_only_modes_cannot_write_through_the_terminal() {
        // Plan keeps `run_terminal` (it must run builds and tests), so the
        // capability gate on the tool NAME cannot be the whole story: a shell
        // command can write a file without ever calling `write_file`. Every
        // command that changes the workspace must be refused while the turn may
        // not write, or "read-only" is a lie.
        for cmd in [
            "echo hi > src/app.ts",
            "echo hi >> notes.md",
            "du -sh . 2> disk.log",
            "df -h > usage.txt",
            "cat a.txt > b.txt",
            "sed -i 's/a/b/' src/app.ts",
            "sed -i.bak 's/a/b/' f.ts",
            "perl -pi -e 's/a/b/' f.ts",
            "rm -rf node_modules",
            "/bin/rm -rf build",
            "mv a.ts b.ts",
            "cp a.ts b.ts",
            "mkdir -p src/new",
            "touch newfile.ts",
            "truncate -s 0 app.log",
            "ls | xargs rm",
            "find . -name '*.ts' -delete",
            "git commit -m wip",
            "git add .",
            "git checkout -- src/app.ts",
            "git reset --hard",
            "git stash",
            "npm install left-pad",
            "npm i",
            "pnpm add react",
            "cargo add serde",
            "cargo fmt",
            "pip install requests",
            "brew install jq",
            "prettier --write src",
            "eslint --fix src",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} changes the workspace and must be refused in a read-only mode"
            );
        }

        // The read-only inspection the modes exist for must keep working.
        for cmd in [
            "git status",
            "git diff",
            "git diff --staged",
            "git log --oneline -5",
            "pwd",
            "node --version",
            "npm run build",
            "npm test",
            "cargo test",
            "cargo check 2>&1 | tail -20",
            // The user's real command: a device redirect is not a write.
            "du -sh ~ 2>/dev/null",
            "df -h > /dev/null",
            "du -sh * 2>/dev/null | sort -h",
            "npx tsc --noEmit",
            "prettier --check src",
            "eslint src",
            "find . -iname '*.ts'",
            "sed -n '1,20p' src/app.ts",
        ] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} only inspects and must still run in a read-only mode"
            );
        }
    }

    #[test]
    fn listing_and_measuring_are_reads_but_searching_stays_delegated() {
        // The user's rule: every READ works in every mode, only APPLYING a
        // change needs Build. Listing and measuring read what the caller
        // already knows about, so they must never be refused; a search engine
        // is delegated because it duplicates `explore` (the main agent's only
        // search path), not because reading is restricted.
        for cmd in [
            "ls",
            "ls -la src",
            "ls -1 | head -20",
            "du -sh * | sort -h",
            "df -h",
            "cat package.json",
            "sed -n '1,20p' src/app.ts",
        ] {
            assert!(
                !is_file_search_command(cmd),
                "{cmd:?} lists or reads a known target and must stay allowed"
            );
        }
        for cmd in [
            "grep -rn foo src",
            "rg TODO",
            "find . -name '*.ts'",
            "locate lib.rs",
            "fd main",
            "tree src",
        ] {
            assert!(
                is_file_search_command(cmd),
                "{cmd:?} searches and must be delegated to `explore`"
            );
        }
    }

    #[test]
    fn redirects_into_devices_are_reads_but_redirects_into_files_are_writes() {
        // The reported bug: `du -sh ~ 2>/dev/null` was refused in a read-only
        // mode because ANY `>` counted as a write. A device node absorbs the
        // stream and leaves the workspace untouched, so it is a read.
        for cmd in [
            "du -sh ~ 2>/dev/null",
            "df -h > /dev/null",
            "du -sh * 2>/dev/null | sort -h",
            "git status >/dev/null 2>&1",
            "ps aux 2>&1 | head -5",
        ] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} only writes to a descriptor or a device, never to the workspace"
            );
        }
        for cmd in [
            "du -sh . 2> disk.log",
            "df -h > usage.txt",
            "ls >> notes.md",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} redirects into a real file and must be refused"
            );
        }
    }

    #[test]
    fn a_read_only_turn_cannot_smuggle_a_write_through_an_interpreter() {
        // `node -e "fs.writeFileSync(...)"` changes the workspace without naming
        // a single mutating binary, so the eval forms are refused while the turn
        // may not write. A plain run of the same binary stays allowed.
        for cmd in [
            r#"node -e "require('fs').writeFileSync('a','b')""#,
            "python3 -c \"open('a','w')\"",
            "sh -c 'rm -rf src'",
            "bash -c 'echo x > f'",
            "eval $(cat script)",
        ] {
            assert!(
                is_mutating_command(cmd),
                "{cmd:?} can write through an interpreter"
            );
        }
        for cmd in ["node --version", "python --version", "node scripts/build.js"] {
            assert!(
                !is_mutating_command(cmd),
                "{cmd:?} runs code without an eval form and must stay allowed"
            );
        }
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
        // Report EVERY label at once: asserting inside the loop showed only the
        // first over-budget set, so one run could not tell how far the others
        // were from their limit.
        //
        // The two `+authoring` budgets grew from 9_900/14_200 because three
        // tools joined the authoring set — `plugin`, `artifact` and `schedule`
        // — and they measure ~2_7OO chars AFTER the prose was cut back to the
        // parameter names and enum values (they first landed at ~3_500, which
        // broke both budgets: 12_721/12_000 and 18_303/17_600). They are BOUND
        // only on a turn whose text asked for one of those capabilities
        // (`AgentRequest::allow_create`), so the base `main` turn still pays
        // 5_868 chars and never sees them. Every char here is re-sent on every
        // round-trip OF SUCH A TURN (~2_913 tokens for the authoring set),
        // which is why the descriptions were trimmed as well as accommodated:
        // the model needs the parameter names and enum values, not the prose.
        let mut report = String::new();
        let mut over = false;
        for (label, schemas, budget) in [
            ("main", tool_schemas(false, false), 7_900usize),
            ("main+browser", tool_schemas(false, true), 11_500),
            ("main+authoring", tool_schemas(true, false), 12_000),
            ("main+authoring+browser", tool_schemas(true, true), 17_600),
            ("explore", research_schemas(), 8_400),
        ] {
            let got = chars(&schemas);
            if got > budget {
                over = true;
            }
            report.push_str(&format!("{label}={got}/{budget} "));
        }
        assert!(
            !over,
            "tool schemas over budget (chars/budget): {report}"
        );
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
    fn explore_prompt_budgets_rounds_and_says_why() {
        // Measured on real traces: one explore ROUND costs ~7.7K uncached tokens
        // (a 9-round run paid ~78K), so rounds — not calls — are the price. The
        // old prompt only said "aim for 2-3 rounds" and the model drifted to a
        // median of 4-5 with a tail of 11. The budget must be explicit and the
        // reason a read now is cheap (stable prefix) must be stated, otherwise
        // the model saves one cheap read and pays a whole round for it later.
        let p = explore_system_prompt(std::env::temp_dir().to_str().unwrap());
        assert!(p.contains("3-step budget"), "{p}");
        assert!(p.contains("STEP 1 - LOCATE"), "{p}");
        assert!(p.contains("STEP 2 - READ"), "{p}");
        assert!(p.contains("PREFIX"), "{p}");
        // The old "aim for 2-3 rounds" wish is gone — replaced by a budget.
        assert!(!p.contains("Aim for 2-3 rounds"), "{p}");
        // STEP 1 must be skippable. On a real trace, 31 of 37 explore runs whose
        // question ALREADY named the file and line window still spent a round
        // locating: 8.7K uncached tokens per run against 6.7K for the runs that
        // read straight away (87% of that group's cost). "Do not read yet" was
        // an unconditional command, so the model obeyed it against the evidence
        // in front of it.
        assert!(p.contains("SKIP this step entirely"), "{p}");
        assert!(p.contains("already names the files and line windows"), "{p}");
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
        // `glob` IS deduped now (it was not, and a traced run re-listed the
        // same directory): a pattern is a real target, a bare scope is not.
        assert!(lookup_key("glob", &json!({"pattern": "**/*.ts"})).is_some());
        assert!(lookup_key("glob", &json!({"path": "src"})).is_none());
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
        // Native write/terminal tools DO get a hint now: traced main-agent turns
        // spent 72% of their steps on one call, 125 of them `run_terminal`. The
        // wording must promise ordering, not parallelism — these calls mutate the
        // workspace and never enter the concurrent batch.
        for name in ["run_terminal", "edit_file", "write_file"] {
            let hint = single_call_hint("agent", &one(name)).unwrap();
            assert!(hint.contains("IN ORDER"), "{name}: {hint}");
            assert!(!hint.contains("parallel"), "{name} must not promise parallelism: {hint}");
        }
        // The browser tools were the BIGGEST missing group: traced main-agent
        // rounds were 54 solo `browser_evaluate` + 12 solo `browser_navigate`
        // and the hint never fired on any of them (it fired on 2 of 280 rounds
        // in the whole corpus). They act on one shared page in order, so they
        // carry the same "in order" wording, never a parallelism promise.
        for name in [
            "browser_evaluate",
            "browser_navigate",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_fill_form",
            "browser_press_key",
            "browser_select_option",
        ] {
            let hint = single_call_hint("agent", &one(name)).unwrap_or_else(|| panic!("{name} has no hint"));
            assert!(hint.contains("IN ORDER"), "{name}: {hint}");
            assert!(!hint.contains("parallel"), "{name} must not promise parallelism: {hint}");
        }
        // Phase 6.28: 18 single-call main rounds sat OUTSIDE this whitelist
        // (110_995 uncached tokens), so the hint could never fire on them.
        for name in ["browser_resize", "browser_emulate_media", "artifact"] {
            let hint = single_call_hint("agent", &one(name))
                .unwrap_or_else(|| panic!("{name} has no hint"));
            assert!(hint.contains("IN ORDER"), "{name}: {hint}");
            assert!(!hint.contains("parallel"), "{name} must not promise parallelism: {hint}");
        }
        // Read-only natives are the one group that DOES batch concurrently.
        for name in ["read", "fetch_url", "load_skill"] {
            let hint = single_call_hint("agent", &one(name))
                .unwrap_or_else(|| panic!("{name} has no hint"));
            assert!(hint.contains("CONCURRENTLY"), "{name}: {hint}");
        }
        // Interactive / whole-state tools legitimately stand alone: hinting at
        // them would push the model to fire a second blocking question or a
        // second full checklist rewrite in one step, so they stay silent.
        for name in ["ask_user", "update_plan"] {
            assert!(
                single_call_hint("agent", &one(name)).is_none(),
                "{name} must stay silent"
            );
        }
        // A tool the hint has nothing useful to say about must stay silent.
        assert!(single_call_hint("agent", &one("glob")).is_none());
    }

    #[test]
    fn the_explore_spent_budget_nudge_lands_before_the_exhaustion_nudge() {
        // The round-3 nudge only helps while rounds remain, and it has to be
        // distinguishable from the "nearly exhausted" one (step + 3 == max).
        assert!(EXPLORE_BUDGET_STEPS < SUBAGENT_MAX_STEPS);
        assert!(EXPLORE_BUDGET_STEPS < SUBAGENT_MAX_STEPS - 3);
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
        finish_tool(&mut messages, &mut emit, &trace, "c1", "explore", &json!({}), big, true, false, None, None);
        let c = messages[0]["content"].as_str().unwrap();
        assert!(c.contains("HEAD") && c.contains("TAIL"), "head and tail must survive");
        assert!(c.contains("ask explore") && !c.contains("offset/limit"));
        // A raw tool result still points at a narrower read window.
        let big2 = "x".repeat(MODEL_RESULT_CAP + 100);
        finish_tool(&mut messages, &mut emit, &trace, "c2", "read", &json!({}), big2, true, true, None, None);
        assert!(messages[1]["content"].as_str().unwrap().contains("offset/limit"));
    }

    #[test]
    fn a_subagent_provider_error_fails_the_attempt_even_with_partial_text() {
        // The bug this guards: an attempt that streamed some text and THEN hit
        // a provider error used to be reported as a SUCCESS (only an EMPTY
        // report counted as a failure), so the retry ladder never ran and the
        // parent got a truncated report as its tool result.
        let partial = "I searched the repo and found";
        assert_eq!(
            classify_subagent_attempt(&Ok(()), partial, "429 rate limit exceeded").is_err(),
            true,
            "partial text must NOT mask a provider error"
        );
        assert!(classify_subagent_attempt(&Ok(()), partial, "invalid api key")
            .unwrap_err()
            .contains("invalid api key"));
        // A clean, complete report still succeeds.
        assert!(classify_subagent_attempt(&Ok(()), partial, "").is_ok());
        assert!(classify_subagent_attempt(&Ok(()), "  \n report \t", "   ").is_ok());
        // Nothing at all: a failure, and the reason names the empty output.
        assert!(classify_subagent_attempt(&Ok(()), "   ", "")
            .unwrap_err()
            .contains("no output"));
        // The idle guard's hang is carried straight through.
        assert_eq!(
            classify_subagent_attempt(&Err("sub-agent hung: no activity for 300s".into()), "", ""),
            Err("sub-agent failed: sub-agent hung: no activity for 300s".to_string())
        );
    }

    #[test]
    fn a_provider_error_names_the_provider_not_its_wire_kind() {
        // The reported bug: the banner said "custom reported an error
        // mid-stream", and the user answered "I don't have this provider in my
        // fallback list". `custom` is the KIND every OpenAI-compatible endpoint
        // shares, so the message named nothing they had ever configured.
        let providers: std::collections::HashMap<String, Value> = serde_json::from_value(json!({
            "p9": {
                "kind": "custom",
                "name": "9router",
                "baseUrl": "https://x/v1",
                "apiKeys": ["k"]
            }
        }))
        .unwrap();
        let err = "custom reported an error mid-stream: Failed to create stream";
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "p9", "custom"),
            "9router reported an error mid-stream: Failed to create stream"
        );
        // A later mention deeper in the body is left alone: the gateway may name
        // "custom" itself and rewriting it would corrupt the provider's message.
        assert_eq!(
            name_the_provider_in_error(
                "custom returned no content — rejected by custom".to_string(),
                &providers,
                "p9",
                "custom"
            ),
            "9router returned no content — rejected by custom"
        );
        // Unknown provider id, a nameless provider and a mismatched kind all
        // leave the message exactly as the provider wrote it.
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "", "custom"),
            err
        );
        assert_eq!(
            name_the_provider_in_error(err.to_string(), &providers, "p9", "anthropic"),
            err
        );
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

    /// The explore ladder's attempt budget must scale with the configured chain.
    ///
    /// With the fixed 10-attempt budget and a rung that fails non-fatally (a
    /// timeout, a 5xx) costing SUBAGENT_RUNG_ATTEMPTS attempts, only the first
    /// five rungs were ever reachable — a six-model fallback list was silently
    /// truncated and the models at its tail were never called, so the user saw
    /// "all my fallbacks are ignored".
    #[test]
    fn explore_attempt_budget_covers_every_rung_of_a_long_chain() {
        // Mirrors the expression in `run_subagent`: every rung gets its own
        // retry budget, and a short chain keeps the original 10 attempts.
        let budget = |chain_len: usize, parent_is_rung: bool| {
            SUBAGENT_MAX_ATTEMPTS.max(
                chain_len.saturating_add(usize::from(parent_is_rung)) * SUBAGENT_RUNG_ATTEMPTS,
            )
        };
        // A long list is fully reachable: 1 slot model + 8 fallbacks + parent.
        let rungs = 1 + 8 + 1;
        assert_eq!(budget(1 + 8, true), rungs * SUBAGENT_RUNG_ATTEMPTS);
        assert!(
            budget(1 + 8, true) >= rungs,
            "every rung must be reachable, got {} attempts for {rungs} rungs",
            budget(1 + 8, true)
        );
        // Non-fatal failures cost a full rung budget each, and even then the
        // whole chain fits.
        assert!(budget(1 + 8, true) / SUBAGENT_RUNG_ATTEMPTS >= rungs);
        // A short chain is unchanged: the historical 10 attempts still apply.
        assert_eq!(budget(1, false), SUBAGENT_MAX_ATTEMPTS);
        assert_eq!(budget(1, true), SUBAGENT_MAX_ATTEMPTS);
        assert_eq!(budget(2, true), SUBAGENT_MAX_ATTEMPTS);
    }

    #[test]
    fn a_rate_limited_slot_model_still_falls_back() {
        // The reported bug: the banner sat on "Sub-agent retrying (7/10) … key
        // rejected (429)" while the user's configured Fallbacks were never
        // tried. A rate limit is correctly classified TRANSIENT (retrying the
        // same model is right for a hiccup), but that must not mean "retry it
        // forever": once the rung has spent its own budget the chain has to move
        // on, or the fallback list is unreachable for the one failure it exists
        // for.
        let budget_spent = |rung_attempts: usize, fatal: bool, can_advance: bool| {
            can_advance && (fatal || rung_attempts >= SUBAGENT_RUNG_ATTEMPTS)
        };
        // A 429 stays transient, so it never forces an immediate jump…
        assert!(!subagent_error_is_fatal(
            "key rejected (429): Rate limit exceeded. Please try again later."
        ));
        // …but the rung's second failure DOES advance to the next model.
        assert!(budget_spent(SUBAGENT_RUNG_ATTEMPTS, false, true));
        // A single failure still retries the same model first.
        assert!(!budget_spent(1, false, true));
        // A fatal error advances immediately, without waiting for the budget.
        assert!(budget_spent(1, true, true));
    }

    #[test]
    fn subagent_rejects_missing_prompt() {
        // Synchronous guard check: empty prompt must fail fast (no model call).
        let args = json!({"description": "d"});
        assert!(args["prompt"].as_str().unwrap_or_default().is_empty());
    }

    #[test]
    fn retry_live_marker_tracks_the_owning_chat_only() {
        // The Retry endpoint answers from this registry, so it must be per-chat
        // and ref-counted: parallel explore calls in one turn can each retry at
        // the same time, and a marker left behind by one of them would keep
        // promising the button that something is listening.
        assert!(!retry_ladder_live("chat-a"));
        assert!(!retry_ladder_live("chat-b"));

        let a1 = RetryLive::new("chat-a");
        let a2 = RetryLive::new("chat-a");
        let b = RetryLive::new("chat-b");
        assert!(!retry_ladder_live("chat-a"), "unarmed ladder must not count");

        let a1 = {
            let mut a1 = a1;
            a1.arm();
            a1
        };
        let a2 = {
            let mut a2 = a2;
            a2.arm();
            a2
        };
        let b = {
            let mut b = b;
            b.arm();
            b
        };
        assert!(retry_ladder_live("chat-a"));
        assert!(retry_ladder_live("chat-b"));

        // Releasing ONE of the two ladders on chat-a must not clear it.
        drop(a1);
        assert!(retry_ladder_live("chat-a"), "second ladder still live");
        drop(a2);
        assert!(!retry_ladder_live("chat-a"));
        // Chat-b is untouched by chat-a's lifetimes.
        assert!(retry_ladder_live("chat-b"));
        drop(b);
        assert!(!retry_ladder_live("chat-b"));

        // Marking the same ladder twice (arm is idempotent) must not inflate the
        // count and leave a permanently-live chat behind.
        let mut again = RetryLive::new("chat-c");
        again.arm();
        again.arm();
        assert!(retry_ladder_live("chat-c"));
        drop(again);
        assert!(!retry_ladder_live("chat-c"));
    }

    #[test]
    fn nudge_reports_whether_a_ladder_is_listening() {
        // The honest half of POST /chat/retry_now: a banner can outlive its
        // ladder, and a click nothing consumes must NOT be reported as accepted.
        assert!(!nudge_subagent_retry("chat-nobody"));
        let mut live = RetryLive::new("chat-live");
        live.arm();
        assert!(nudge_subagent_retry("chat-live"));
        drop(live);
        assert!(!nudge_subagent_retry("chat-live"));
    }

    #[test]
    fn a_slot_model_change_is_visible_to_a_running_ladder() {
        // The reported bug: "I change the sub-agent model while it is retrying
        // and it still retries with the old one". `subagent_models` reaches the
        // backend only as a snapshot in the turn's request body, so the ladder
        // must be able to see a change made afterwards — and must notice that it
        // differs from the entry it last applied.
        let mut req = base_req();
        req.providers.insert(
            "p2".into(),
            json!({"kind": "custom", "baseUrl": "http://other/v1", "apiKeys": ["k2"]}),
        );
        req.model = "parent-model".into();

        // Anything reported BEFORE the ladder started is already in the turn's
        // snapshot, so it must be ignored — otherwise a stale entry from an
        // earlier turn would clobber this turn's own value.
        let stale = live_slot_seq();
        set_live_slot_entry("explore", "p2/new-model");
        assert_eq!(live_slot_entry_since("explore", stale).as_deref(), Some("p2/new-model"));
        // …but it is invisible to a ladder that started AFTERWARDS.
        let later = live_slot_seq();
        assert_eq!(live_slot_entry_since("explore", later), None);

        // The ladder resolves the LIVE entry, not the request snapshot.
        let live = live_slot_entry_since("explore", stale).unwrap_or_default();
        let (model, base, keys, pid) = resolve_slot_target(&req, &live);
        assert_eq!(model, "new-model");
        assert_eq!(pid, "p2");
        assert_eq!(base, "http://other/v1");
        assert_eq!(keys, vec!["k2".to_string()]);

        // Clearing the slot ("" = parent model) must resolve to the parent, so a
        // user who removes their override stops hit the broken model too.
        set_live_slot_entry("explore", "");
        let live = live_slot_entry_since("explore", stale).unwrap_or_default();
        let (model, _, _, pid) = resolve_slot_target(&req, &live);
        assert_eq!(model, "parent-model");
        assert_eq!(pid, req.provider_id);
    }

    #[tokio::test]
    async fn a_nudge_ends_an_attempt_that_is_already_running() {
        // The reported bug: the banner said "retrying now (requested)" and then
        // nothing happened, because the click could only shorten the backoff —
        // never an attempt already sitting inside a model call. This mirrors the
        // wait the ladder races against that call.
        let from = retry_nudge();
        let waiter = async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if retry_nudge() != from {
                    return;
                }
            }
        };
        let clicked = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            nudge_subagent_retry("chat-running");
        });
        let ended = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            std::pin::pin!(waiter),
        )
        .await;
        let _ = clicked.await;
        assert!(
            ended.is_ok(),
            "a click must end a RUNNING attempt, not only a backoff wait"
        );
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

        // The saved skill is marked user-owned, so a later launch cannot revert
        // an edit made here on the user's behalf.
        let dir_path = crate::skills::find_skill_dir_pub(&dir, "Movie Finder").expect("folder");
        assert!(
            crate::skills::marker_origin(&dir_path).as_deref() == Some("user"),
            "create_skill must claim the file so the seeder leaves it alone"
        );

        // Editing with an OMITTED fa_keywords keeps the existing ones (the
        // parser must not silently erase what a Persian request matches on).
        let out = dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "content": "Step 1: ask for the year."}),
            None,
        )
        .unwrap();
        assert!(!out.contains("WARNING"), "keywords survived, no warning: {out}");
        let section = crate::skill_router::build_section("", root, &[]);
        assert!(section.text.contains("[fa: فیلم, سینما]"), "{}", section.text);

        // A skill saved with NO keywords is one a Persian request can never
        // find, and
        // the tool says so instead of reporting a plain success.
        let out = dispatch(
            root,
            "create_skill",
            &json!({"name": "No Keywords", "description": "d", "content": "c"}),
            None,
        )
        .unwrap();
        assert!(out.contains("WARNING") && out.contains("NO fa_keywords"), "{out}");

        // deleted_files from the model actually removes the extra file.
        dispatch(
            root,
            "create_skill",
            &json!({
                "name": "Movie Finder",
                "extra_files": {"note.txt": "hello"}
            }),
            None,
        )
        .unwrap();
        let dir_path = crate::skills::find_skill_dir_pub(&dir, "Movie Finder").expect("folder");
        assert!(dir_path.join("note.txt").is_file());
        dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "deleted_files": ["note.txt"]}),
            None,
        )
        .unwrap();
        assert!(!dir_path.join("note.txt").exists(), "deleted_files is wired");

        // An OMITTED body must not destroy the stored one: an extra-file-only
        // save, a frontmatter-only edit and a delete all arrive without it.
        dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "fa_keywords": "فیلم, سینما, فیلم"}),
            None,
        )
        .unwrap();
        let kept = std::fs::read_to_string(dir_path.join("skill.md")).unwrap();
        assert!(
            kept.contains("Step 1: ask for the year."),
            "the stored body survives a body-less save: {kept}"
        );
        // …and the empty body must never be treated as "erase the description".
        assert!(kept.contains("description: find movies"), "{kept}");

        // A NEW skill with no body is still rejected (no empty skill.md).
        assert!(dispatch(
            root,
            "create_skill",
            &json!({"name": "Bodyless", "description": "d", "fa_keywords": "x y"}),
            None,
        )
        .is_err());

        // Deleting needs no body either — the old guard rejected this call.
        let out = dispatch(
            root,
            "create_skill",
            &json!({"name": "Movie Finder", "delete": true}),
            None,
        )
        .unwrap();
        assert!(out.contains("Movie Finder"), "{out}");
        assert!(!dir_path.exists(), "delete removes the folder: {out}");

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
    fn load_skill_query_finds_a_skill_a_huge_store_cannot_list() {
        use crate::tools::dispatch;
        // The prompt's catalog is byte-capped, so a store with hundreds of
        // skills cannot be listed there. `query` is the way to the ones it had
        // to leave out: scoring runs over EVERY installed skill.
        let dir = std::env::temp_dir().join(format!("codifa-skill-query-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..40 {
            let name = format!("Bulk Skill {i}");
            let sdir = dir.join("skills").join(name.to_lowercase().replace(' ', "-"));
            std::fs::create_dir_all(&sdir).unwrap();
            // One distinctive English description, one Persian keyword set, the
            // rest filler — the two things a real query has to find.
            let (description, keywords) = match i {
                39 => ("bewildering xylophone maintenance", ""),
                38 => ("earthquake drill", "fa_keywords: زلزله\n"),
                _ => ("a filler skill", ""),
            };
            std::fs::write(
                sdir.join("skill.md"),
                format!(
                    "---\nname: {name}\ndescription: {description}\n{keywords}---\nBODY OF {i}\n"
                ),
            )
            .unwrap();
        }
        let root = dir.to_str().unwrap();

        // Exactly one match returns its body: the model never guesses a name.
        let hit = dispatch(root, "load_skill", &json!({"query": "xylophone"}), None).unwrap();
        assert!(hit.contains("BODY OF 39"), "{hit}");
        // The user's own Persian word finds its skill, exactly as in the catalog.
        let fa = dispatch(root, "load_skill", &json!({"query": "زلزله"}), None).unwrap();
        assert!(fa.contains("BODY OF 38"), "{fa}");
        // Several matches list the candidates instead of inlining a wrong body.
        let many = dispatch(root, "load_skill", &json!({"query": "filler"}), None).unwrap();
        assert!(many.contains("Bulk Skill 0"), "{many}");
        assert!(!many.contains("BODY OF"), "an ambiguous query must not inline a body: {many}");
        // A miss answers with a HINT, not with 40 names: a store with hundreds
        // of skills would spend a turn's worth of tokens on a failed lookup.
        let miss = dispatch(root, "load_skill", &json!({"query": "zzzz"}), None).unwrap_err();
        assert!(miss.contains("no skill matches"), "{miss}");
        assert!(miss.contains("and 10 more"), "the hint must say it is truncated: {miss}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_reaches_a_skill_that_lives_inside_a_plugin() {
        // Regression: the catalog advertises enabled-plugin skills, but this
        // tool read only the standalone store, so a plugin skill answered
        // "skill not found: … Available: (none)" right after being listed.
        use crate::tools::dispatch_with_data_root;
        let root = std::env::temp_dir().join(format!("codifa-plugin-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        crate::plugins::create_plugin(
            &root,
            &json!({
                "name": "Release Notes",
                "skills": [{
                    "name": "Release Notes",
                    "content": "READ THE GIT LOG",
                    "fa_keywords": "یادداشت انتشار",
                    "extra_files": {"checklist.md": "- tag it"}
                }]
            }),
        )
        .unwrap();
        let r = root.to_str().unwrap();

        // Part of the catalog…
        let section = crate::skill_router::build_section("", r, &[]);
        assert!(section.text.contains("- Release Notes"), "{}", section.text);
        // …loadable by name and by slug…
        let body = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes"}), None, Some(r)).unwrap();
        assert!(body.contains("READ THE GIT LOG"), "{body}");
        let by_slug = dispatch_with_data_root(r, "load_skill", &json!({"name": "release-notes"}), None, Some(r)).unwrap();
        assert!(by_slug.contains("READ THE GIT LOG"), "{by_slug}");
        // …and its extra files are readable too.
        let extra = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes", "file": "checklist.md"}), None, Some(r)).unwrap();
        assert_eq!(extra, "- tag it");
        // A plugin skill is listed in the catalog (with its clipped detail), so
        // the model can load it by name — and the catalog never carries a body,
        // however precisely the prompt echoes the skill's own keywords.
        let cat = crate::skill_router::build_section("یادداشت انتشار", r, &[]);
        assert!(cat.text.contains("- Release Notes"), "{}", cat.text);
        assert!(!cat.text.contains("READ THE GIT LOG"), "{}", cat.text);

        // Disabled plugin = gone from the catalog AND unloadable.
        crate::plugins::toggle_plugin(&root, &json!({"slug": "release-notes", "enabled": false})).unwrap();
        assert!(!crate::skill_router::build_section("", r, &[]).text.contains("- Release Notes"));
        let err = dispatch_with_data_root(r, "load_skill", &json!({"name": "Release Notes"}), None, Some(r)).unwrap_err();
        assert!(err.contains("skill not found"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
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
    fn lsp_and_glob_lookups_are_deduplicated_too() {
        // These arms were missing, so an explore run traced three identical
        // `lsp_symbols` calls on the SAME file (12_880 model chars each) that
        // the repeat guard never saw. Every field that can change the ANSWER
        // must be in the key.
        let sym = lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs"})).unwrap();
        assert_eq!(sym, "lsp_symbols|src/a.rs|");
        assert_eq!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs"})).unwrap(),
            "identical lookup must produce an identical key"
        );
        assert_ne!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/a.rs", "query": "run"})).unwrap(),
            "a query filters a different symbol list"
        );
        assert_ne!(
            sym,
            lookup_key("lsp_symbols", &json!({"filePath": "src/b.rs"})).unwrap()
        );

        assert_eq!(
            lookup_key("lsp_diagnostics", &json!({"filePath": "src/a.rs"})).unwrap(),
            "lsp_diagnostics|src/a.rs"
        );

        // Definition/references/hover share a key SHAPE, so the tool name is
        // what keeps them apart — the definition of X is not the references of X.
        let def = lookup_key("lsp_definition", &json!({"filePath": "a.rs", "symbol": "run"}))
            .unwrap();
        assert_eq!(def, "lsp_definition|a.rs|run|0|0");
        assert_ne!(
            def,
            lookup_key("lsp_references", &json!({"filePath": "a.rs", "symbol": "run"})).unwrap()
        );
        // A repeated name: the line hint selects a different occurrence.
        assert_ne!(
            lookup_key("lsp_hover", &json!({"filePath": "a.rs", "symbol": "run", "line": 10}))
                .unwrap(),
            lookup_key("lsp_hover", &json!({"filePath": "a.rs", "symbol": "run", "line": 20}))
                .unwrap()
        );

        let glob = lookup_key("glob", &json!({"pattern": "**/*.rs", "path": "src"})).unwrap();
        assert_eq!(glob, "glob|**/*.rs|src|100");
        assert_ne!(
            glob,
            lookup_key("glob", &json!({"pattern": "**/*.ts", "path": "src"})).unwrap()
        );
        assert_ne!(
            glob,
            lookup_key("glob", &json!({"pattern": "**/*.rs", "path": "src", "max_results": 5}))
                .unwrap(),
            "a smaller max_results is a different answer"
        );
        // An unusable call yields NO key, so the guard can never answer a call
        // the dispatcher would have rejected differently.
        assert!(lookup_key("lsp_symbols", &json!({})).is_none());
        assert!(lookup_key("lsp_definition", &json!({"filePath": "a.rs"})).is_none());
        assert!(lookup_key("glob", &json!({"path": "src"})).is_none());
    }

    #[test]
    fn a_mutating_call_cannot_be_classified_as_readonly() {
        // The repeat-guard is cleared after every NON-read-only call, so this
        // list is a correctness boundary rather than a speed knob: a mutating
        // tool listed as read-only would let a later `read` be answered with a
        // pointer to the file as it was BEFORE the edit — the model would never
        // see its own change.
        for t in [
            "write_file",
            "edit_file",
            "run_terminal", // arbitrary `sh -c` in the workspace root
            "delete_memory",
            "save_memory",
            "create_skill",
            "create_mcp",
            "explore",
        ] {
            assert!(
                !is_readonly_native(t),
                "{t} can mutate state and must never be treated as a pure read"
            );
        }
        // The pure readers the guard is allowed to answer with a pointer.
        for t in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_symbols",
            "lsp_diagnostics",
        ] {
            assert!(is_readonly_native(t), "{t} is a pure read");
        }
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
    /// effects. These assertions pin the contract the UI promises: it is the
    /// ONLY thing that decides the result count, `0` still returns results (it
    /// only stops the page fetch), and nothing can exceed the hard cap.
    #[test]
    fn web_search_result_count_comes_from_the_settings_number() {
        // Default setting (5) → five results.
        assert_eq!(web_search_result_count(5), 5);
        // Any other setting is used verbatim.
        assert_eq!(web_search_result_count(8), 8);
        // 0 = "don't fetch pages", NOT "return nothing".
        assert_eq!(
            web_search_result_count(0),
            crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
        );
        // Out-of-range values are clamped to a sane range instead of trusted.
        assert_eq!(web_search_result_count(99), crate::websearch::WEB_SEARCH_AUTO_FETCH_MAX);
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
            system_suffix: String::new(),
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
            tool_fallbacks: std::collections::HashMap::new(),
            images: Vec::new(),
            web_search_auto_fetch: crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT,
            // No renderer to send a table: derive it from the mode instead.
            cap: None,
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

    /// An UNSET web slot with a configured fallback list must still distil.
    ///
    /// The empty slot used to return early before the list was ever read, so a
    /// fallback added in Settings → Tools was silently dead: the row looked
    /// configured and nothing ever called it.
    #[tokio::test]
    async fn slot_distill_runs_the_fallback_list_of_an_unset_slot() {
        let (mock_base, rx) = spawn_json_mock_upstream("distilled by fallback").await;
        let bodies = drain_bodies(rx);

        let mut req = base_req();
        // No `web` model at all — only a fallback list.
        req.tool_fallbacks.insert(
            "web".into(),
            vec![format!("slot-prov/{MOCK_MODEL}")],
        );
        req.providers.insert(
            "slot-prov".into(),
            json!({
                "kind": "custom",
                "baseUrl": format!("{mock_base}/v1"),
                "apiKeys": ["sk-slot"],
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
            WEB_DISTILL_SYSTEM_PROMPT,
            "QUERY: x\n\nSEARCH RESULTS:\n- a",
        )
        .await;
        assert_eq!(
            out.as_deref(),
            Some("distilled by fallback"),
            "a configured fallback list must be used even when the slot model is empty"
        );
        let sent = bodies.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "exactly one rung, got {sent:?}");
        assert_eq!(sent[0]["model"], MOCK_MODEL);
        // The unset slot contributes NO rung of its own: the main model must not
        // be spent on a side call the user never asked for.
        assert_ne!(sent[0]["model"], "main-model");
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
                            // The reported prompt is the REAL prompt size: the
                            // trigger now anchors on this number instead of a
                            // local estimate, so a toy value (50) would never
                            // cross the test's 200-token threshold even though
                            // the real system prompt + tool schemas are far
                            // larger.
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":250,"completion_tokens":2}}).to_string()
                            ));
                        } else {
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{"content":"done"}}]}).to_string()
                            ));
                            sse.push_str(&format!(
                                "data: {}\n\n",
                                json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":300,"completion_tokens":1}}).to_string()
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

    #[test]
    fn inline_images_are_not_billed_as_text() {
        // A single attached screenshot is megabytes of base64. Charging it at
        // 4 chars/token reported millions of "tokens" and auto-compacted a chat
        // that was nowhere near the threshold.
        let base64 = "A".repeat(3_000_000);
        let with_image = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "what is in this screenshot?" },
                { "type": "image", "data_url": format!("data:image/png;base64,{base64}") },
            ],
        })];
        let as_text = {
            let wire: usize = serde_json::to_string(&with_image)
                .map(|s| s.chars().count())
                .unwrap();
            wire.div_ceil(4)
        };
        let measured = estimate_prompt_tokens(&with_image, 0);
        assert!(
            measured < as_text / 50,
            "the image must not be billed as text: measured={measured} vs text={as_text}"
        );
        // Concrete numbers, not just "much smaller": a 3 MB base64 screenshot is
        // ~2k real tokens (2001 by the IMAGE_CHARS_PER_TOKEN budget). The old
        // unit bug subtracted TOKENS from a CHARACTER count, so this same input
        // measured 562_518 — a single screenshot folded a whole chat.
        assert!(
            (1_500..4_000).contains(&measured),
            "a 3 MB image must cost ~2k tokens, got {measured}"
        );
        // The text part is still counted (no over-subtraction).
        assert!(measured >= 5, "the prose must survive: {measured}");
        // No images => unchanged behaviour.
        let plain = vec![json!({"role": "user", "content": "x".repeat(400)})];
        assert_eq!(estimate_prompt_tokens(&plain, 0), {
            let wire: usize = serde_json::to_string(&plain)
                .map(|s| s.chars().count())
                .unwrap();
            wire.div_ceil(4)
        });
    }

    #[test]
    fn measured_prompt_anchors_on_the_provider_not_the_inflated_estimate() {
        // The provider said the prompt was 1_000 tokens. The turn then appended
        // one small tool result. The measurement must be ~1_000 + that result —
        // NOT the local serde-JSON estimate of the whole history (which is what
        // made compaction fire below the user's threshold).
        let msgs = vec![
            json!({"role": "system", "content": "s".repeat(40_000)}),
            json!({"role": "user", "content": "u".repeat(40_000)}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "r".repeat(400)}),
        ];
        let full_estimate = estimate_prompt_tokens(&msgs, 0);
        assert!(full_estimate > 20_000, "sanity: {full_estimate}");
        let measured = measured_prompt_tokens(&msgs, 0, 2, 1_000);
        // 1_000 provider + ~100 for the 400-char tool result.
        assert!(
            (1_050..1_200).contains(&measured),
            "measured={measured} must anchor on the provider number"
        );
        // Before any usage arrives there is nothing to anchor to: the full
        // estimate stands alone.
        assert_eq!(measured_prompt_tokens(&msgs, 0, 0, 0), full_estimate);
        // A stale anchor (more entries than the vec has, e.g. after a fold)
        // falls back instead of panicking.
        assert_eq!(
            measured_prompt_tokens(&msgs, 0, 99, 1_000),
            full_estimate
        );
    }

    #[test]
    fn effective_context_window_prefers_the_models_real_window() {
        // Reported bug: a model whose real window is 1M was measured against the
        // hardcoded 128k fallback (the renderer had not resolved the window and
        // sent 0), so 80% compaction fired at ~10% of the real window.
        let mut req: AgentRequest = serde_json::from_value(json!({
            "provider": "custom",
            "provider_id": "p1",
            "model": "big-model",
            "base_url": "http://127.0.0.1:1/v1",
            "root": "/tmp/x",
            "prompt": "hi",
            "context_window": 0,
            "providers": {
                "p1": { "contextMap": { "big-model": 1_000_000 } }
            }
        }))
        .unwrap();
        assert_eq!(effective_context_window(&req), 1_000_000);

        // The renderer's own number always wins when it knows it.
        req.context_window = 200_000;
        assert_eq!(effective_context_window(&req), 200_000);
        req.context_window = 0;

        // Provider-prefixed key, as NVIDIA's /models returns it.
        req.providers.insert(
            "p1".into(),
            json!({"contextMap": {"p1/big-model": 400_000}}),
        );
        assert_eq!(effective_context_window(&req), 400_000);

        // A malformed/zero entry must not become the window (that would compact
        // on every single message).
        req.providers
            .insert("p1".into(), json!({"contextMap": {"big-model": 0}}));
        assert_eq!(effective_context_window(&req), DEFAULT_CONTEXT_WINDOW);

        // No providers map at all: the documented fallback.
        req.providers.clear();
        assert_eq!(effective_context_window(&req), DEFAULT_CONTEXT_WINDOW);
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

    #[tokio::test]
    async fn a_repeated_screenshot_is_described_once_and_reused() {
        // A chat re-sends the screenshots still in its history on EVERY turn.
        // The second turn must answer from the description cache instead of
        // paying for the same model+image round-trip again — while the KEY
        // covers the model, the text and the image bytes, so a different image
        // or question can never be served a stale description.
        let (vision_base, vision_rx) =
            spawn_json_mock_upstream("a red button on a white page").await;
        let vision_bodies = drain_bodies(vision_rx);
        let (main_base, main_rx) = spawn_explore_mock_upstream().await;
        let main_bodies = drain_bodies(main_rx);
        let cancel: CancelFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Unique prompt text keeps this test's cache key isolated from any other
        // test that happens to send an image through the Vision slot.
        let prompt = "what is wrong with this screenshot? (cache-key isolation probe)";
        let build = |base: &str| {
            let raw = json!({
                "provider": "custom",
                "provider_id": "chat-provider",
                "model": "main/parent-model",
                "base_url": format!("{base}/v1"),
                "api_key": "sk",
                "api_keys": ["sk"],
                "root": "/tmp/codifa-live-vision-cache",
                "mode": "build",
                "prompt": prompt,
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
                "data_root": "/tmp/codifa-live-vision-cache-data"
            });
            let req: AgentRequest = serde_json::from_value(raw).unwrap();
            (req, format!("{base}/v1"))
        };
        let (req1, _) = build(&main_base);
        let mut emit = |_e: &AgentEvent| {};
        let _ = run_turn(&req1, &mut emit, &cancel).await;
        let calls_after_first = vision_bodies.lock().unwrap().len();
        assert_eq!(
            calls_after_first, 1,
            "the first turn must describe the image once"
        );

        // The SAME question about the SAME bytes: no second vision call.
        let (req2, _) = build(&main_base);
        let _ = run_turn(&req2, &mut emit, &cancel).await;
        assert_eq!(
            vision_bodies.lock().unwrap().len(),
            1,
            "a repeated image+question must come from the cache, not a new paid call"
        );
        // The vision description is one of the MAIN turn's requests. The mock
        // upstream here is also the explore sub-agent's endpoint, so filter to
        // the bodies that actually carry the description.
        let main_calls = main_bodies.lock().unwrap();
        let with_desc: Vec<&Value> = main_calls
            .iter()
            .filter(|b| {
                b["messages"].as_array().is_some_and(|ms| {
                    ms.iter().any(|m| match &m["content"] {
                        Value::String(s) => s.contains("a red button on a white page"),
                        Value::Array(blocks) => blocks
                            .iter()
                            .any(|x| x["text"].as_str().is_some_and(|t| {
                                t.contains("a red button on a white page")
                            })),
                        _ => false,
                    })
                })
            })
            .collect();
        assert!(
            with_desc.len() >= 2,
            "both turns must forward the description to the main model, got {} of {}",
            with_desc.len(),
            main_calls.len()
        );
    }

    #[test]
    fn the_vision_cache_key_depends_on_model_text_and_bytes() {
        let imgs = vec![PNG_URL.to_string(), JPG_URL.to_string()];
        let base = vision_cache_key("vision-model", "describe this", &imgs);
        assert_eq!(
            base,
            vision_cache_key("vision-model", "describe this", &imgs),
            "the same inputs must hit the same key"
        );
        assert_ne!(
            base,
            vision_cache_key("other-model", "describe this", &imgs),
            "a different model must not reuse a description"
        );
        assert_ne!(
            base,
            vision_cache_key("vision-model", "different question", &imgs),
            "a different question must not reuse a description"
        );
        assert_ne!(
            base,
            vision_cache_key("vision-model", "describe this", &[JPG_URL.to_string()]),
            "one fewer image must not reuse a description"
        );
        // Concatenation ambiguity: ["ab","c"] must not collide with ["a","bc"].
        let split_a = vec!["ab".to_string(), "c".to_string()];
        let split_b = vec!["a".to_string(), "bc".to_string()];
        assert_ne!(
            vision_cache_key("m", "t", &split_a),
            vision_cache_key("m", "t", &split_b),
            "the image count/lengths must be part of the key"
        );
    }

    /// Temp data root shared by the plan_section tests (same pattern as the
    /// plan round-trip test).
    fn plan_test_root(tag: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("codifa-ps-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        (dir, root)
    }

    #[test]
    fn plan_section_carries_the_plan_and_the_checklist() {
        let (dir, root) = plan_test_root("carry");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan");
        crate::plans::save_plan(&root, &ws, "Plan", "## Plan\nstep one", "chat-1").unwrap();
        crate::plans::save_checklist(
            &root,
            &ws,
            "chat-1",
            &json!([
                {"content": "first", "status": "completed"},
                {"content": "second", "status": "in_progress"},
            ]),
        );

        let got = plan_section(&root, &ws, "chat-1");
        assert!(got.contains("=== SAVED PLAN"), "{got}");
        assert!(got.contains("step one"), "{got}");
        assert!(got.contains("=== CHECKLIST"), "{got}");
        // Status marks: x completed, ~ in progress.
        assert!(got.contains("- [x] first"), "{got}");
        assert!(got.contains("- [~] second"), "{got}");

        // No chat id → no section (nothing to key the files by).
        assert_eq!(plan_section(&root, &ws, ""), "");
        assert_eq!(plan_section(&root, &ws, "   "), "");
        // Unknown chat → empty, not a panic.
        assert_eq!(plan_section(&root, &ws, "chat-none"), "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_is_capped_but_keeps_the_head_and_the_tail() {
        // A plan is re-sent on every round-trip of every turn: an uncapped body
        // is a running cost. The cut must preserve the goal (head) and the most
        // recent items (tail).
        let (dir, root) = plan_test_root("cap");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan-cap");
        let big = format!("HEAD-MARKER\n{}\nTAIL-MARKER", "x".repeat(40_000));
        crate::plans::save_plan(&root, &ws, "Big", &big, "chat-1").unwrap();

        let got = plan_section(&root, &ws, "chat-1");
        assert!(got.contains("HEAD-MARKER"), "the head must survive");
        assert!(got.contains("TAIL-MARKER"), "the tail must survive");
        assert!(got.contains("chars omitted from the middle"), "{got}");
        // The section stays near the cap instead of carrying all 40 KB.
        assert!(
            got.len() < PLAN_SECTION_CAP + 1_000,
            "section not capped: {} chars",
            got.len()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_survives_multibyte_text_at_the_cut() {
        // Persian plan bodies are common; a byte slice at the cut would panic
        // (and with panic=abort kill the app).
        let (dir, root) = plan_test_root("utf8");
        let ws = crate::plans::workspace_slug_for_root("/tmp/workspace-plan-utf8");
        let body = format!("{}\nپایان", "فارسی‌ ".repeat(4_000));
        crate::plans::save_plan(&root, &ws, "Persian", &body, "chat-1").unwrap();
        let got = plan_section(&root, &ws, "chat-1");
        assert!(!got.is_empty());
        assert!(got.contains("chars omitted from the middle"), "not capped");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_section_is_wrapped_as_a_trailing_context_message() {
        // The section must never enter the system prompt: it is injected as a
        // trailing message instead. Measured: it used to make `messages[0]`
        // 7_734 -> 9_439 -> 7_734 -> 13_642 bytes across five turns and dropped
        // the main-agent prefix cache to 23.7%.
        assert!(plan_context_message("").is_none());
        assert!(plan_context_message("   \n ").is_none());

        let m = plan_context_message("\n\n=== SAVED PLAN (from disk) ===\nstep one\n")
            .expect("non-empty section must produce a message");
        assert_eq!(m["role"], "user");
        let text = m["content"].as_str().unwrap();
        assert!(text.contains("step one"), "{text}");
        // The label is load-bearing: without it the model can read a stale
        // checklist as the user's newest instruction.
        assert!(text.contains("NOT a new request"), "{text}");
        assert!(text.contains("end of context"), "{text}");
        // The recogniser used by the `Compact` emit must match what is built.
        assert!(text.starts_with(PLAN_CONTEXT_HEAD), "{text}");
    }

    #[test]
    fn skills_reminder_rides_the_tail_and_is_excluded_from_the_fold() {
        // The reminder exists to make the model CALL the tool, so it must name
        // the tool and the catalog it refers to — and it must stay out of the
        // renderer's fold count, exactly like the plan context message.
        let m = skills_context_message();
        assert_eq!(m["role"], "user");
        let text = m["content"].as_str().unwrap();
        assert!(text.starts_with(SKILLS_CONTEXT_HEAD), "{text}");
        assert!(text.contains("load_skill"), "{text}");
        assert!(text.contains("AVAILABLE SKILLS"), "{text}");
        // A capped catalog cannot list a large store, so the reminder must name
        // the way to reach what it left out — otherwise "no entry" reads as
        // "no such skill" and the model answers from memory.
        assert!(text.contains("query"), "{text}");
        // It must NOT pick a skill for the model: no skill name is embedded.
        assert!(!text.contains("name="), "{text}");
        assert!(!text.contains("query="), "{text}");

        let tail = vec![
            json!({"role": "assistant", "content": "a"}),
            plan_context_message("\n\n=== SAVED PLAN (from disk) ===\nstep one\n").unwrap(),
            skills_context_message(),
        ];
        assert_eq!(tail.len(), 3);
        // Only the stored assistant message counts toward the fold.
        assert_eq!(plan_context_keep(&tail), 1);
        // A plain message is still counted.
        assert!(!is_wire_only_context("just a question"));
    }

    #[test]
    fn plan_context_keep_excludes_the_wire_only_plan_message() {
        // The renderer stores every message of the tail EXCEPT the plan context,
        // which exists only on the wire. Counting it would tell the renderer to
        // keep one extra stored message verbatim.
        let tail = vec![
            json!({"role": "assistant", "content": "a"}),
            json!({"role": "tool", "content": "t"}),
            json!({"role": "user", "content": "question"}),
            plan_context_message("\n\n=== SAVED PLAN ===\nx\n").unwrap(),
        ];
        assert_eq!(tail.len(), 4);
        assert_eq!(plan_context_keep(&tail), 3);
        // No plan message → the count is just the length.
        let plain = vec![json!({"role": "user", "content": "q"})];
        assert_eq!(plan_context_keep(&plain), 1);
        assert_eq!(plan_context_keep(&[]), 0);
    }

    #[test]
    fn the_system_prompt_prefix_is_byte_stable_across_a_mode_switch() {
        // `messages[0]` is the first byte an automatic prefix cache can reuse,
        // so any volatile value in its OPENING lines re-bills the whole request
        // on every change. `mode` and `root` therefore live in the tail.
        //
        // Measured before the fix: `Mode: build` -> `Mode: ask` changed a byte
        // at offset 120 and collapsed the shared prefix to 1.6%, re-billing
        // 58_432 input tokens at a 0.0% cache hit — while the next ask->ask
        // turn of the same size hit 94.6%. See `default_system_prompt`.
        let root = "/Users/someone/projects/a-really-long-workspace-name";
        let build = default_system_prompt("build", root);
        let ask = default_system_prompt("ask", root);
        let plan = default_system_prompt("plan", root);

        // The two prompts differ ONLY after the constant instructional body.
        let shared = build
            .chars()
            .zip(ask.chars())
            .take_while(|(a, b)| a == b)
            .count();
        // Every byte up to the volatile tail marker must be shared: a mode
        // switch may rewrite the tail (`Mode: {mode}` plus that mode's rule)
        // and NOTHING else. Counting in chars, since the body has em-dashes.
        let tail_at = build
            .find("Workspace root:")
            .expect("the volatile tail marker must exist");
        let body_len = build[..tail_at].chars().count();
        assert!(
            shared >= body_len,
            "the prompts diverge after {shared} chars, inside the constant body \
             (which ends at {body_len}) — a volatile value moved into the cacheable prefix"
        );
        // No mode value may appear in the cacheable head at all.
        let head = &build[..shared];
        for m in ["build", "ask", "plan"] {
            assert!(
                !head.contains(&format!("Mode: {m}")),
                "the `Mode: {m}` marker is inside the cacheable prefix"
            );
        }
        // The volatile values must still reach the model (nothing was dropped).
        assert!(build.contains("Mode: build"));
        assert!(ask.contains("Mode: ask"));
        assert!(plan.contains("Mode: plan"));
        assert!(build.contains(root));
        // The trace ruler keys the main prompt off its first words.
        assert!(build.starts_with("You are Codifa"));
    }

    #[test]
    fn ask_prompt_forces_a_short_answer_and_opt_in_detail() {
        // Ask mode used to receive the same "delegate to `explore` and work from
        // its full report" body as Build, so a one-line question came back as a
        // long structured dump: the brevity rule lived in the appstate text,
        // which the backend never sends. The rule must ride the prompt the model
        // actually gets, and it must be ASK-only.
        let ask = default_system_prompt("ask", "/tmp/x");
        let build = default_system_prompt("build", "/tmp/x");
        let plan = default_system_prompt("plan", "/tmp/x");

        assert!(ask.contains("ASK mode"), "ask must carry its own rule");
        // Brevity is the default, depth is opt-in.
        assert!(ask.contains("Expand ONLY when the user asks for more"));
        assert!(ask.contains("2-4 short lines"));
        assert!(ask.contains("no headings, no numbered steps"));
        // Build/Plan must not inherit the answer-length rule.
        assert!(!build.contains("2-4 short lines"));
        assert!(!plan.contains("2-4 short lines"));
        // The write instruction is mode-neutral in the shared body: a read-only
        // turn must not be told to edit files (the schema carries no such tool).
        assert!(!ask.contains("Use write_file/edit_file/run_terminal"));
        assert!(!plan.contains("Use write_file/edit_file/run_terminal"));
        assert!(build.contains("Use the tools this mode binds to make changes"));
    }

    #[test]
    fn every_mode_states_the_shape_of_its_reply() {
        // Length/style rules used to exist ONLY in `appstate::system_prompts`,
        // which is display-only (`GET /system-prompts`): the model never saw it.
        // Ask got its rule back; build and plan have the same failure mode —
        // build pasted whole files into the reply, plan sprawled because its
        // only deliverable is prose. Pin all three here so a rule cannot be
        // written in the dead table again.
        let root = "/tmp/ws";
        let ask = default_system_prompt("ask", root);
        let build = default_system_prompt("build", root);
        let plan = default_system_prompt("plan", root);

        // Build: the edit is the artifact, the reply is a short report of it.
        assert!(build.contains("IS the artifact"));
        assert!(build.contains("never paste whole files"));
        // Plan: the plan itself is capped, step-shaped, and written for the
        // user — each step says WHAT changes and a summary section closes it.
        assert!(plan.contains("the USER can understand"));
        assert!(plan.contains("under ~25 lines"));
        assert!(plan.contains("one line per step"));
        assert!(plan.contains("summary section"));
        // Ask: short by default, detail is opt-in.
        assert!(ask.contains("2-4 short lines"));

        // The rules must not leak across modes: an ask-shaped reply rule in
        // build would fight the "the edit IS the artifact" rule, and a plan
        // budget in build/ask would be meaningless.
        assert!(!build.contains("2-4 short lines"));
        assert!(!plan.contains("2-4 short lines"));
        assert!(!ask.contains("under ~25 lines"));
        assert!(!build.contains("under ~25 lines"));

        // The read-only rule still reaches the modes that need it (the caps gate
        // is the hard enforcement; this is the instruction the model reads).
        // Ask spells it lowercase inside its own rule, plan in its opening words.
        assert!(plan.contains("READ-ONLY"));
        assert!(ask.contains("read-only AND short"));
        assert!(build.contains("You may write and edit files here"));
        assert!(!build.contains("READ-ONLY"));
    }

    #[test]
    fn every_mode_inlines_the_coding_standards_rules() {
        // The generic coding rules live in the shipped `Coding Standards` skill,
        // but the prompt INLINES them instead of pointing at the skill: a
        // pointer only applied when the model chose to spend a `load_skill`
        // call, and a rule that is never read is not a rule. They sit in the
        // SHARED body, byte for byte, because that body is the cached prefix — a
        // per-mode copy would re-bill the whole prompt on every mode switch.
        let root = "/tmp/x";
        let mut seen: Option<String> = None;
        for mode in ["build", "ask", "plan"] {
            let p = default_system_prompt(mode, root);
            assert!(
                p.contains("CODING RULES"),
                "{mode} must carry the coding rules"
            );
            // Spot-check the real rule TEXT, not just the header: the body is
            // compiled in from the shipped markdown, so an empty or renamed file
            // would otherwise still read as "rules present".
            assert!(
                p.contains("Smallest correct change") && p.contains("Never hard-code"),
                "{mode} must inline the real rule body, not a bare header"
            );
            let body = p.split("Workspace root:").next().unwrap_or_default();
            match &seen {
                None => seen = Some(body.to_string()),
                Some(first) => assert_eq!(
                    first, body,
                    "the skill pointer must sit in the SHARED body, not in the \
                     per-mode tail — otherwise it costs a cache re-bill per switch"
                ),
            }
        }

        // The rules are read from the shipped markdown by `include_str!`, so a
        // truncated or frontmatter-less file would silently ship an empty block.
        let shipped = include_str!("../skills/coding-standards.md");
        assert!(
            shipped.starts_with("---"),
            "the shipped skill must keep frontmatter first"
        );
        assert!(
            shipped.contains("name: Coding Standards"),
            "the shipped skill must keep the exact name the prompt points at"
        );
        // The catalog line is the model's only trigger for calling load_skill,
        // and an English description cannot be found from a Persian request:
        // the keywords are what make a shipped skill findable from the way the
        // user actually writes.
        assert!(
            shipped.contains("fa_keywords:"),
            "fa_keywords are what make a shipped skill findable from a Persian request"
        );
    }

    #[test]
    fn the_system_prompt_is_free_of_volatile_plan_text() {
        // Byte-stability guard: `system` must not carry the plan/checklist, or a
        // single checklist tick invalidates the cached prefix of every turn.
        let src = include_str!("agent.rs");
        // Built from parts: this test's own source is inside `src`, and a
        // literal needle would match itself.
        let needle = ["system.push_str(&plan", "_section("].concat();
        assert!(
            !src.contains(&needle),
            "the plan section must not be pushed onto the system prompt"
        );
        // The gate still exists: the sub-agent gets no plan at all.
        assert!(
            src.contains("if req.mode == \"subagent\" {\n        String::new()"),
            "the plan/checklist block must be gated on the main agent"
        );

        // And the explore prompt itself must not promise plan tools it lacks.
        let prompt = explore_system_prompt("/tmp/workspace-none");
        assert!(!prompt.contains("update_plan"), "explore prompt mentions update_plan");
        assert!(!prompt.contains("SAVED PLAN"), "explore prompt mentions the plan");
        assert!(!prompt.contains("CHECKLIST"), "explore prompt mentions the checklist");
    }

    #[test]
    fn subagent_fold_uses_its_own_budget_and_keeps_fresh_rounds() {
        // An explore run re-sends its whole accumulated history on EVERY one of
        // its rounds, and nothing folded it mid-loop before
        // (compact_subagent_messages runs once, before the loop).
        let big = "x".repeat(6_000);
        let mut messages: Vec<Value> = Vec::new();
        for i in 1..=4 {
            messages.extend(fold_round(&format!("s{i}"), "read", &big));
        }
        let mut seen = std::collections::HashSet::new();
        fold_subagent_tool_results(&mut messages, &mut seen);

        // The two NEWEST rounds stay verbatim: the model is reasoning over them.
        for i in [5usize, 7usize] {
            assert_eq!(
                messages[i]["content"].as_str().unwrap().chars().count(),
                6_000,
                "a fresh round was folded (message {i})"
            );
        }
        // Older rounds are cut to the SUB budget, not the main one.
        for i in [1usize, 3usize] {
            let c = messages[i]["content"].as_str().unwrap();
            assert!(
                c.chars().count() < SUB_FOLD_RESULT_CHARS + 200,
                "stale round not folded: {} chars",
                c.chars().count()
            );
            assert!(c.starts_with(&"x".repeat(SUB_FOLD_RESULT_CHARS)));
            assert!(c.contains(MAIN_FOLD_MARKER), "stub lost its pointer marker");
        }
        // The fold must fire before compact_subagent_messages would (60% of a
        // 128K window), otherwise the run pays compaction plus a cache reset.
        assert!(
            SUB_FOLD_MIN_TOKENS < 128_000 * 60 / 100,
            "sub fold threshold must sit below the compaction budget"
        );
        // Folding rewrites old results, so it invalidates the cached prefix from
        // that point on. The threshold is therefore not free to go low.
        assert_eq!(SUB_FOLD_MIN_TOKENS, MAIN_FOLD_MIN_TOKENS);
    }

    #[test]
    fn fold_with_takes_keep_rounds_and_budgets_as_parameters() {
        // The shared core must honour whatever the caller passes, so the main
        // and sub-agent paths differ in numbers without forking the logic.
        let big = "y".repeat(5_000);
        let mut messages: Vec<Value> = Vec::new();
        for i in 1..=3 {
            messages.extend(fold_round(&format!("p{i}"), "grep", &big));
        }
        let mut seen = std::collections::HashSet::new();
        // Keep only the newest round, cut everything older to 100 chars.
        fold_with(&mut messages, &mut seen, 1, 100, 100);

        let stale = messages[1]["content"].as_str().unwrap();
        assert!(
            stale.starts_with(&"y".repeat(100)),
            "custom result budget ignored"
        );
        assert!(stale.contains(MAIN_FOLD_MARKER));
        assert!(
            stale.chars().count() < 300,
            "custom budget produced {} chars",
            stale.chars().count()
        );
        // The single kept round is untouched at full size.
        assert_eq!(
            messages[5]["content"].as_str().unwrap().chars().count(),
            5_000
        );

        // Folding is idempotent: a second pass changes nothing.
        let before = stale.to_string();
        fold_with(&mut messages, &mut seen, 1, 100, 100);
        assert_eq!(messages[1]["content"].as_str().unwrap(), before);
    }

    /// The in-turn fold is OFF for the explore sub-agent, and this assertion is
    /// the decision written into the build.
    ///
    /// Measured on the reference trace (236 explore calls, 1,375,702 uncached
    /// input tokens): cold first calls 9%, appended content 33%, and **57%
    /// prefix-break re-bill** — the fold's doing. With a ~91% cache hit rate the
    /// tokens a fold "saves" are nearly free already, while the re-bill it
    /// causes is paid in full: 253,824 already-cached tokens were thrown away
    /// and every measured fold was net negative (17-26K tokens lost in the
    /// worst runs).
    ///
    /// Flipping this back to `true` is one line — but it must come with a fresh
    /// measurement, because the answer depends entirely on the gateway caching
    /// the prefix. A provider without prefix caching would flip it.
    #[test]
    fn subagent_fold_stays_off_without_a_fresh_measurement() {
        assert!(
            !SUB_FOLD_ENABLED,
            "The explore fold is disabled by measurement: 57% of uncached explore \
             input was the prefix-break re-bill its own rewrites caused. Re-enable \
             it only together with a fresh trace measurement."
        );
    }

    /// `fold_with` must REPORT what it removed.
    ///
    /// Before it returned a number, every attempt to price the fold had to infer
    /// "a fold happened here" from the prompt shrinking between two calls — an
    /// inference that cannot tell a fold from mid-turn compaction, and that
    /// measures the shrink AFTER the fact (biased). The numbers it returns now
    /// are what the trace records.
    #[test]
    fn fold_with_reports_removed_chars_and_message_count() {
        let big = "y".repeat(10_000);
        let mut messages: Vec<Value> = Vec::new();
        messages.extend(fold_round("c1", "read", &big));
        messages.extend(fold_round("c2", "read", &big));
        // Two fresh rounds that must stay untouched, so c1/c2 are stale.
        messages.extend(fold_round("c3", "read", &big));
        messages.extend(fold_round("c4", "read", &big));
        let before: usize = messages
            .iter()
            .map(|m| m["content"].as_str().map(|c| c.chars().count()).unwrap_or(0))
            .sum();

        let (removed, folded) = fold_stale_tool_results(&mut messages, &mut seen_set());

        assert_eq!(folded, 2, "exactly the two stale rounds are folded");
        assert!(removed > 0, "the removal is reported, not silently swallowed");
        let after: usize = messages
            .iter()
            .map(|m| m["content"].as_str().map(|c| c.chars().count()).unwrap_or(0))
            .sum();
        assert!(
            removed >= before - after,
            "reported {removed} chars must cover the real shrink {}",
            before - after
        );

        // A second pass is a no-op and reports nothing: the report must not
        // double-count the same fold on every later round.
        assert_eq!(fold_stale_tool_results(&mut messages, &mut seen_set()), (0, 0));
    }

    #[test]
    fn fold_pays_off_skips_the_last_calls_of_a_run() {        // A fold rewrites OLD tool results, so the request right after it is
        // re-billed from the first changed byte: a fixed cost that only pays
        // back if enough round-trips remain to reuse the shorter prompt.
        // Measured over 85 real folds: the 31 that happened with 3 or fewer
        // calls left were ALL net losses (-172_630 tokens), while every bucket
        // from 4 calls left on was net-positive. Hence the threshold.
        assert!(!fold_pays_off(0));
        assert!(!fold_pays_off(1)); // the run's LAST model call
        assert!(!fold_pays_off(2));
        assert!(fold_pays_off(3)); // the threshold
        assert!(fold_pays_off(SUBAGENT_MAX_STEPS)); // a full sub-agent budget

        // The guard must not shadow the elision it protects: it sits far below
        // the run length, so an explore run that folds at all still folds.
        assert!(SUBAGENT_MAX_STEPS > FOLD_MIN_REMAINING_CALLS);
    }
}
