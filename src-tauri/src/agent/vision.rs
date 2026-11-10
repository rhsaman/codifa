use super::*;

/// System prompt for the one-shot vision pass. The model's ONLY job is to
/// describe the attached images factually; it is a side call, so it must not
/// try to answer the user or call tools.
pub(super) const VISION_SYSTEM_PROMPT: &str = "You are a vision analyst. Describe the attached images precisely and factually: \
what they show, all visible text (transcribe it verbatim), UI elements, layout, colours, errors and any detail \
a developer would need. Never speculate about information that is not visible.";

/// System prompt for the web-search distiller (the "Other" / web slot).
///
/// It answers ONLY from the quoted results and cites the URLs inline, so the
/// main agent gets a lean answer plus real sources instead of ten raw pages.
pub(super) const WEB_DISTILL_SYSTEM_PROMPT: &str = "You are a web-search reader. Read the quoted search results \
and answer the user's query with a CONCISE summary (under 150 words) that cites the most relevant \
result URLs inline. If the results cannot answer the query, say so.";

/// Whether a URL points at a raw text/source file.
///
/// `fetch_url` returns such a URL WHOLE (like codex's `webfetch`): a skill
/// install or a docs page that came back as a 100k-char excerpt made the agent
/// re-fetch the same file, so the cap is auto-lifted instead of trusting the
/// model to pass `full=true`.
pub(super) fn looks_like_source_url_agent(url: &str) -> bool {
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
pub(super) fn web_search_result_count(setting: usize) -> usize {
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
pub(super) const FETCH_DISTILL_SYSTEM_PROMPT: &str = "You are a web-page reader. Read the quoted page and extract the \
information the request needs in under 300 words: keep facts, names, numbers, code identifiers, file paths and \
the exact commands or snippets that matter, and cite the page URL once. Never invent anything that is not on \
the page.";

/// A fetched page shorter than this is handed over verbatim: distilling a
/// snippet costs a round-trip and can only lose detail.
pub(super) const FETCH_DISTILL_MIN_CHARS: usize = 6_000;

/// Distil a side payload (raw web-search results, a fetched page) with the web
/// slot's model (the "Other" row in Settings → Tools).
///
/// Returns `None` when the slot is unset OR the call fails — the caller then
/// hands the model the RAW payload, which is the pre-existing behaviour, so a
/// missing or broken distiller can never lose the tool result itself.
pub(super) async fn run_slot_distill(
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
    // The slot's own try order, and NOTHING else. A tool falls back only to the
    // models the user picked for it, in the order they arranged them: the chat
    // model used to be appended as a last resort, which padded the list with a
    // model the user never chose for this tool and made the visible fallback
    // list a lie ("it says it tried my fallbacks; it actually tried the chat").
    // With nothing configured the call simply fails, which is what an empty
    // fallback list means.
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
    // The distiller walks the slot's chain in PASSES — the same ladder every
    // tool slot follows: ONE try per rung, whatever the failure, then the next
    // model immediately; after the last rung fails the walk starts over from
    // the first model, pausing between passes. A single silent pass was why a
    // dead first rung read as "web/fetch never use the Other model": the
    // distiller gave up and the raw payload went out with no trace of the
    // configured list.
    const DISTILL_MAX_CYCLES: usize = 3;
    const DISTILL_CYCLE_PAUSE_SECS: u64 = 10;
    let cycles = if chain.len() > 1 { DISTILL_MAX_CYCLES } else { 1 };
    for pass in 0..cycles {
        if pass > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(DISTILL_CYCLE_PAUSE_SECS)).await;
        }
        for (m, b, keys, pid, k) in chain.iter() {
            let (reasoning, model_reasoning, auto_think) = crate::llm::reasoning_fields(
                k,
                &crate::llm::level_from_source(
                    provider_model_thinking_levels(&req.providers, pid, m).as_deref(),
                    if level.is_empty() { "none" } else { level },
                ),
                provider_model_reasoning(&req.providers, pid, m),
            );
            let cfg = LlmConfig {
                provider: k.clone(),
                headers: crate::llm::custom_headers(&req.providers, pid),
                provider_id: pid.clone(),
                model: m.clone(),
                base_url: b.clone(),
                api_keys: keys.clone(),
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
                // This chain IS the user's own list: a rung that did not answer
                // hands the work to the NEXT model they picked, whatever the
                // reason. Its rungs normally live on another provider with
                // another endpoint, so an unreachable or rate-limited first rung
                // says nothing about the ones behind it.
                Err(_) => {}
            }
        }
    }
    None
}

/// How many history entries may be re-described by the Vision slot in ONE turn.
/// Each description is a paid round-trip, so a long chat must not add one per
/// pasted screenshot; entries outside the window keep their raw image blocks.
pub(super) const MAX_HISTORY_VISION_CALLS: usize = 2;

/// Cache of Vision-slot descriptions, keyed by (model, prompt text, image bytes).
///
/// A chat re-sends the screenshots still in its history on EVERY turn (the
/// renderer sends bare paths, so they are re-read and re-encoded each time).
/// Without a cache each of those turns paid for the same description again —
/// same model, same bytes, same answer. The key covers the model, the prompt
/// text and the image payloads, so a hit is byte-for-byte the same question
/// and cannot return a description of a different picture: this saves
/// round-trips at ZERO quality cost.
pub(super) static VISION_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u128, String>>,
> = std::sync::OnceLock::new();

/// Descriptions kept at once. Each is a few KB, so the cap is about memory
/// hygiene rather than a real limit.
pub(super) const VISION_CACHE_MAX: usize = 32;

/// Stable 128-bit key for one vision call.
///
/// Two passes of `DefaultHasher` (the second over a distinct seed byte) give
/// 128 bits from the std hasher — no extra dependency, and a collision between
/// two DIFFERENT images is far less likely than a hardware fault.
pub(super) fn vision_cache_key(model: &str, text: &str, images: &[String]) -> u128 {
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
pub(super) fn vision_cache_get(key: u128) -> Option<String> {
    VISION_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .ok()?
        .get(&key)
        .cloned()
}

/// Store one description (bounded; a full cache starts over).
pub(super) fn vision_cache_put(key: u128, desc: &str) {
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
pub(super) enum VisionOutcome {
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
pub(super) async fn run_vision_slot(
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
    // Passes over the slot's chain. ONE try per rung, whatever the failure —
    // a rate limit, a 5xx or a dropped stream hands the images to the NEXT
    // model immediately. After the last rung fails the walk starts over from
    // the first model (a provider that was down a minute ago is often back),
    // pausing between passes so dead rungs are not hammered — the same ladder
    // semantics every tool slot follows.
    const VISION_MAX_CYCLES: usize = 3;
    const VISION_CYCLE_PAUSE_SECS: u64 = 10;
    let cycles = if chain.len() > 1 { VISION_MAX_CYCLES } else { 1 };
    for pass in 0..cycles {
        if pass > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(VISION_CYCLE_PAUSE_SECS)).await;
        }
        for (c_model, c_base, c_keys, c_provider_id, c_kind) in chain.iter() {
            let (v_reasoning, v_model_reasoning, v_auto_think) = crate::llm::reasoning_fields(
                c_kind,
                // A side call defaults to no reasoning (never inherits the main level).
                &crate::llm::level_from_source(
                    provider_model_thinking_levels(&req.providers, c_provider_id, c_model)
                        .as_deref(),
                    if v_level.is_empty() { "none" } else { v_level },
                ),
                provider_model_reasoning(&req.providers, c_provider_id, c_model),
            );
            let v_cfg = LlmConfig {
                provider: c_kind.clone(),
                headers: crate::llm::custom_headers(&req.providers, c_provider_id),
                provider_id: c_provider_id.clone(),
                model: c_model.clone(),
                base_url: c_base.clone(),
                api_keys: c_keys.clone(),
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
            match crate::llm::complete_with_images(
                client,
                &v_cfg,
                VISION_SYSTEM_PROMPT,
                text,
                images,
            )
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
                    // The FIRST error is the one reported, so the caller still
                    // learns why the slot model failed. The rung itself is done:
                    // the next model in the list takes the call, whatever this
                    // one named as its reason.
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
pub(super) fn model_supports_vision(
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
pub(super) fn looks_like_image_error(err: &str) -> bool {
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
pub(super) async fn degrade_images_to_text(
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
                "{text}\n\n[image omitted: this model cannot read images and no Vision \
                 model is configured in Settings → Tools → Vision]"
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
                "{text}\n\n[image omitted: this model cannot read images and no Vision \
                 model is configured in Settings → Tools → Vision]"
            ),
        });
        changed += 1;
    }
    changed
}

