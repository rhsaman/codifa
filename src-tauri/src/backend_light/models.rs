use super::*;

// --- model probe (native; replaces the sidecar's /models/test) --------------

/// Total budget for one probe (mirrors the sidecar's MODEL_TEST_TIMEOUT).
pub(super) const MODEL_TEST_TIMEOUT_SECS: u64 = 15;
/// Client-side cap, smaller than the budget so the real provider error wins.
pub(super) const MODEL_TEST_CLIENT_TIMEOUT_SECS: u64 = 12;
/// Chat-representative reservation so a provider's quota pre-check behaves
/// like a real turn: a tiny cap can pass while the chat's 32K reservation
/// fails with 402, producing a false tick. Actual burn stays ~1 token.
pub(super) const MODEL_TEST_MAX_TOKENS: u32 = 32_000;
/// Probes in flight per batch round (the sidecar used a semaphore of 10).
pub(super) const MODEL_TEST_BATCH_CONCURRENCY: usize = 10;

/// Body of POST /models/test and /models/test-batch.
#[derive(serde::Deserialize)]
pub struct ModelTestBody {
    #[serde(default = "default_provider")]
    pub(super) provider: String,
    #[serde(default)]
    pub(super) base_url: String,
    #[serde(default)]
    pub(super) api_keys: Vec<String>,
    #[serde(default)]
    pub(super) model: String,
    #[serde(default)]
    pub(super) models: Vec<String>,
    /// Extra request headers set on the provider row (sent verbatim).
    #[serde(default)]
    pub(super) headers: Option<Value>,
    /// The provider ROW the picker is testing against. A model can be listed by
    /// several providers, so without it the probe would run on whichever row
    /// happened to match the kind.
    #[serde(default)]
    pub(super) provider_id: String,
}

/// A unique suffix for the probe prompt. The prompt used to be the constant
/// "Reply with the single word: OK", which gateways cache: a probe kept
/// returning a cached "OK" from before the account ran out of credit while
/// every real chat was refused. A nonce forces one fresh call per test.
pub(super) fn probe_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

/// Size of the probe prompt, in bytes of neutral context. Free tiers gate on
/// PROMPT SIZE, not just token budget: Refuseless accepts a tiny prompt and
/// answers HTTP 402 `insufficient_credits` ("Free slots at capacity") from
/// roughly 2 000 chars up, so a tiny probe ticked while every real chat was
/// refused. A real turn is far larger than this; 2 000 is the smallest size
/// that reproduces the cap without wasting a provider's context.
pub(super) const MODEL_TEST_PROMPT_CHARS: usize = 2_000;

/// A chat-representative probe prompt: ~2 000 bytes of neutral context, then
/// the instruction. The filler is ordinary numbered prose so no provider can
/// reject it as malformed, and the instruction stays last so the model answers
/// it rather than the filler. The nonce keeps gateways from serving a cached
/// reply from before the account ran out of credit.
pub(super) fn probe_prompt() -> String {
    let mut prompt = String::with_capacity(MODEL_TEST_PROMPT_CHARS + 96);
    prompt.push_str("Context notes:\n");
    let mut line = 0usize;
    while prompt.len() < MODEL_TEST_PROMPT_CHARS {
        line += 1;
        prompt.push_str(&format!(
            "Note {line}: this line is neutral filler used only to size the request.\n"
        ));
    }
    prompt.push_str(&format!(
        "\nEnd of notes. Ignore them. Reply with the single word: OK. probe {}",
        probe_nonce()
    ));
    prompt
}

/// Probe one model; returns the reply or the reason.
///
/// Uses the same one-shot path as a real turn, so the probe exercises the
/// exact provider+model the picker shows.
pub(super) async fn probe_model(body: &ModelTestBody, model: &str) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("no model selected".into());
    }
    let mut keys = body.api_keys.clone();
    if keys.is_empty() {
        // Keyless local endpoints (ollama / llama.cpp) still answer; the
        // sidecar sent an empty key rather than refusing the probe.
        keys.push(String::new());
    }
    let (r_level, r_model, r_auto) = crate::llm::reasoning_fields(&body.provider, "", false);
    let cfg = LlmConfig {
        provider: body.provider.clone(),
        headers: crate::llm::header_pairs(body.headers.as_ref()),
        provider_id: if body.provider_id.is_empty() {
            body.provider.clone()
        } else {
            body.provider_id.clone()
        },
        model: model.to_string(),
        base_url: body.base_url.clone(),
        api_keys: keys,
        temperature: None,
        max_tokens: Some(MODEL_TEST_MAX_TOKENS),
        timeout_secs: MODEL_TEST_CLIENT_TIMEOUT_SECS,
        reasoning_level: r_level,
        model_reasoning: r_model,
        auto_think: r_auto,
    };
    let client = llm::http_client();
    let prompt = probe_prompt();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(MODEL_TEST_TIMEOUT_SECS),
        llm::complete(&client, &cfg, "", &prompt),
    )
    .await
    .map_err(|_| format!("timeout — model did not answer in {MODEL_TEST_TIMEOUT_SECS}s"))?;
    let text = res?.text.trim().to_string();
    if text.is_empty() {
        return Err(
            "empty reply — model returned no content (quota exhausted or route unavailable)"
                .into(),
        );
    }
    // Some gateways answer 200 with a billing/auth refusal as ordinary
    // CONTENT (Pollinations: "The account behind this API key doesn't have
    // enough credits…"). A non-empty check alone turned that into a green
    // tick while every real turn failed. `extract_completion` already rejects
    // this when usage is reported; this catches the shape without usage.
    if let Some(msg) = llm::content_error_message(&text) {
        return Err(msg.to_string());
    }
    Ok(text.chars().take(200).collect())
}

/// POST /models/test — probe one model with a tiny completion.
pub async fn models_test(Json(body): Json<ModelTestBody>) -> Response<Body> {
    match probe_model(&body, &body.model).await {
        Ok(reply) => Json(json!({ "ok": true, "reply": reply })).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "detail": err })),
        )
            .into_response(),
    }
}

/// POST /models/test-batch — probe many models, one HTTP round trip.
pub async fn models_test_batch(Json(body): Json<ModelTestBody>) -> Response<Body> {
    let models: Vec<String> = body
        .models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .take(100)
        .collect();
    if models.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "detail": "no models selected" })),
        )
            .into_response();
    }
    // Bounded concurrency: a 100-model group test must not open 100 sockets.
    let mut results: Vec<Value> = Vec::with_capacity(models.len());
    // Borrow the body once, outside the closures: an `async move` block would
    // otherwise capture `body` by value and the first iteration would move it
    // out of the FnMut closure.
    let body_ref = &body;
    for chunk in models.chunks(MODEL_TEST_BATCH_CONCURRENCY) {
        let part = futures_util::future::join_all(chunk.iter().map(|m| {
            // The async block outlives the loop body, so it must own its model
            // name instead of borrowing it from `chunk`.
            let model = m.clone();
            async move {
                match probe_model(body_ref, &model).await {
                    Ok(reply) => json!({ "model": model, "ok": true, "reply": reply }),
                    Err(error) => json!({ "model": model, "ok": false, "error": error }),
                }
            }
        }))
        .await;
        results.extend(part);
    }
    Json(json!({ "results": results })).into_response()
}

