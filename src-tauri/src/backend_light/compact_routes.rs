use super::*;

#[derive(serde::Deserialize)]
pub(super) struct CompactBody {
    #[serde(default = "default_provider")]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    api_keys: Vec<String>,
    // The renderer still sends its chat-level fallback pair (`fallback_*`). It
    // is deliberately NOT declared: a tool falls back only to the models the
    // user picked for it in Settings, so the field is accepted and ignored
    // rather than plumbed into the chain.
    /// Effective provider id of the chat's own provider — the 4th element of
    /// a resolved slot, so cross-provider usage is attributed correctly.
    #[serde(default)]
    provider_id: String,
    /// Main-model reasoning capability flag, and the per-slot overrides (the
    /// "Other" group's entry wins when present).
    #[serde(default)]
    model_reasoning: bool,
    #[serde(default)]
    subagent_thinking: std::collections::HashMap<String, String>,
    // The renderer also sends `thinking_level` for the chat model. It is NOT
    // declared on purpose: a side-task call takes its effort from
    // `subagent_thinking` (missing = OFF) and must never inherit the chat's.
    #[serde(default)]
    history: Vec<Value>,
    #[serde(default)]
    context_window: usize,
    #[serde(default)]
    max_output: usize,
    /// Per-slot sub-agent model overrides (Tool Models settings); the
    /// "compact" slot routes the summarizer to that model/provider.
    #[serde(default)]
    subagent_models: std::collections::HashMap<String, String>,
    /// Per-tool fallback lists from Settings → Tools, keyed by the same slot
    /// names as `subagent_models`; the summariser retries down the "Other"
    /// group's own list when its model fails.
    #[serde(default)]
    tool_fallbacks: std::collections::HashMap<String, Vec<String>>,
    /// Full provider configs keyed by id for cross-provider slots.
    #[serde(default)]
    providers: std::collections::HashMap<String, Value>,
}

pub(super) fn default_provider() -> String {
    "custom".into()
}

/// Normalize the raw provider usage object to the frontend's CompactUsage
/// shape. Providers use different key families (OpenAI: prompt_tokens /
/// completion_tokens, Anthropic: input_tokens / output_tokens, Gemini:
/// promptTokenCount / candidatesTokenCount) — the frontend reads
/// input_tokens/output_tokens, so unmapped keys accrued as 0/0 and the
/// Model usage panel showed nothing after a compact.
pub(super) fn normalize_compact_usage(
    raw: Option<Value>,
    model: &str,
    provider_id: &str,
) -> Option<Value> {
    // The shared shape-based normalizer (see `llm::NormalizedUsage`):
    // `input_tokens` leaves here INCLUSIVE of the cache share, so the
    // frontend's cost math (fresh = input − read − write) and its cache-hit
    // denominator are right for additive (Anthropic-style) payloads too —
    // passing the raw exclusive input through made every Anthropic-shaped
    // call undercount its real footprint.
    let u = crate::llm::NormalizedUsage::from_payload(raw.as_ref().unwrap_or(&Value::Null))?;
    let mut norm = serde_json::Map::new();
    norm.insert("input_tokens".into(), json!(u.input_total));
    norm.insert("output_tokens".into(), json!(u.output_tokens));
    if u.cache_read_reported {
        norm.insert("cache_read_tokens".into(), json!(u.cache_read));
    }
    if u.cache_write_reported {
        norm.insert("cache_write_tokens".into(), json!(u.cache_write));
    }
    // The model that ACTUALLY ran the summarizer (the compact slot may
    // route cross-provider) — the frontend groups usage under it. The
    // effective provider id rides along so the panel does not fall back to
    // the parent's chat provider for a cross-provider compact.
    norm.insert("model".into(), json!(model));
    if !provider_id.is_empty() {
        norm.insert("provider_id".into(), json!(provider_id));
    }
    Some(Value::Object(norm))
}

/// Stream one JSON payload as an SSE frame. A closed channel just means the
/// renderer aborted (Stop / timeout) — nothing to do.
pub(super) fn send_compact_frame(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<axum::body::Bytes, std::io::Error>>,
    payload: Value,
) {
    let _ = tx.send(Ok(axum::body::Bytes::from(format!("data: {payload}\n\n"))));
}

/// One progress frame. Tagged with `compact_progress` so the renderer can tell it
/// apart from the final result (`summary`), since both arrive on this stream.
pub(super) fn compact_progress_frame(p: &crate::compact::CompactProgress) -> Value {
    json!({
        "compact_progress": true,
        "phase": p.phase,
        "attempt": p.attempt,
        "attempts": p.attempts_total,
        "model": p.model,
        "provider_id": p.provider_id,
        "percent": p.percent,
        "budget_secs": p.budget_secs,
        "elapsed_secs": p.elapsed_secs,
    })
}

/// Manual `/compact`. Streams the summarizer's progress as SSE and finishes with
/// one result frame, so the renderer can show a live phase/elapsed bar instead of
/// waiting blindly on a JSON body that says nothing until the very end.
pub(super) async fn chat_compact(Json(body): Json<CompactBody>) -> Response<Body> {
    let (tx, rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<axum::body::Bytes, std::io::Error>>();
    tokio::spawn(async move {
        compact_worker(body, &tx).await;
        // Dropping `tx` closes the stream: the renderer treats a closed stream
        // that never produced a result frame as a failed compact.
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "stream build failed").into_response()
        })
}

pub(super) async fn compact_worker(
    body: CompactBody,
    tx: &tokio::sync::mpsc::UnboundedSender<Result<axum::body::Bytes, std::io::Error>>,
) {
    if body.history.is_empty() {
        send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": "no messages to compact" }),
        );
        return;
    }
    let client = llm::http_client();
    // The "Other" Tool Models group overrides the summarizer model ("compact",
    // "web" and "title" share one settings row, so the pick may live under any
    // of them; "providerId/model" routes cross-provider, empty = the chat
    // model). Reading only the `compact` key left the row's model unused.
    let other_entry = other_slot_entry(&body.subagent_models);
    let (model_name, base_url, api_keys, slot_provider_id) = resolve_slot_target(
        other_entry,
        &body.model,
        &body.base_url,
        &{
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
        &body.provider_id,
        &body.providers,
    );
    // The compact slot may carry its own reasoning level; an empty entry
    // inherits the main model's. The finding is derived from the slot's OWN
    // provider kind, so a cross-provider summarizer is invoked like a native
    // call to that provider would be.
    let compact_entry = other_entry;
    let slot_kind = resolve_slot_kind(compact_entry, &body.provider, &body.providers);
    let compact_level = other_slot_level(&body.subagent_thinking);
    let level = if compact_level.is_empty() {
        // Missing/empty slot level = OFF (send no reasoning param). Tool slots
        // do NOT inherit the main model's level — their default is none.
        "none"
    } else {
        compact_level
    };
    let (r_level, r_model, r_auto) = crate::llm::reasoning_fields(
        &slot_kind,
        &crate::llm::level_from_source(
            crate::agent::provider_model_thinking_levels(
                &body.providers,
                &slot_provider_id,
                &model_name,
            )
            .as_deref(),
            level,
        ),
        body.model_reasoning,
    );
    let model = LlmConfig {
        provider: slot_kind,
        headers: crate::llm::custom_headers(&body.providers, &slot_provider_id),
        provider_id: slot_provider_id.clone(),
        model: model_name.clone(),
        base_url,
        api_keys,
        temperature: Some(0.2),
        max_tokens: Some(4096),
        timeout_secs: 90,
        reasoning_level: r_level.clone(),
        model_reasoning: r_model,
        auto_think: r_auto,
    };
    // The retry rungs this compaction may use after its own model fails. Which
    // one is handed to the summariser is decided by whether the caller sent a
    // chat-model fallback (an interactive turn always does; the mid-turn fold
    // and a headless scheduled run may not).
    let rungs: Vec<(String, String, Vec<String>, String, String)> = resolve_slot_chain(
        other_entry,
        other_slot_fallbacks(&body.tool_fallbacks),
        &body.model,
        &body.base_url,
        &{
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
        &body.provider_id,
        &body.provider,
        &body.providers,
    )
    .into_iter()
    .skip(1)
    .collect();
    // The full try order this compaction walks after its own model fails: the
    // "Other" group's own fallback list (Settings → Tools), in the user's order,
    // and NOTHING else — the chat model is never appended. `tool_fallbacks` is a
    // per-CALL list — nothing is remembered, so the next compaction starts at the
    // summariser's own model again. Every rung inherits the SLOT's reasoning
    // level: a fallback changes the model and its routing, never the effort the
    // user chose for the tool.
    // The chat's own fallback pair (`fallback_*` on the wire) is deliberately
    // IGNORED: a tool falls back only to the models picked for it in Settings,
    // top to bottom. Appending the chat model padded every compaction with a
    // model the user never chose for this tool — and made the visible fallback
    // list a lie whenever the user's list was empty.
    let fallbacks: Vec<LlmConfig> = rungs
        .iter()
        .map(|(m, b, keys, pid, k)| LlmConfig {
            provider: k.clone(),
            headers: crate::llm::custom_headers(&body.providers, pid),
            provider_id: pid.clone(),
            model: m.clone(),
            base_url: b.clone(),
            api_keys: keys.clone(),
            temperature: Some(0.2),
            max_tokens: Some(4096),
            timeout_secs: 90,
            reasoning_level: model.reasoning_level.clone(),
            model_reasoning: crate::agent::provider_model_reasoning(&body.providers, pid, m),
            auto_think: crate::models::auto_think_for(k),
        })
        .collect();
    // The summarizer's token budget: the window the user sees, resolved through
    // the same capacity rule as the mid-turn trigger (a bare 0 must not fall back
    // to a private literal — see `resolve_compact_window`).
    let compact_ctx = crate::agent::resolve_compact_window(
        &body.providers,
        &body.provider_id,
        &body.model,
        body.context_window,
    );
    match compact::compact_history_with_progress(
        &client,
        &model,
        &fallbacks,
        &body.history,
        compact_ctx,
        body.max_output,
        true,
        // The manual route hands `keep` back to the renderer, which keeps the
        // verbatim tail on the wire — the tail must stay out of the summary.
        false,
        &mut |p: &compact::CompactProgress| send_compact_frame(tx, compact_progress_frame(p)),
    )
    .await
    {
        Ok(Some(out)) => send_compact_frame(
            tx,
            json!({
                "summary": out.summary,
                "keep": out.keep,
                "usage": normalize_compact_usage(out.usage, &out.model, &out.provider_id),
            }),
        ),
        Ok(None) => send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": "nothing to compact" }),
        ),
        Err(e) => send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": e }),
        ),
    }
}

// ---------- /chat/stream ----------
// Always the native Rust agent loop (agent.rs) — no Python fallback.

