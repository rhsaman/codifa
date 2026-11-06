use super::*;

/// One-shot completion. Tries each API key in order on key errors
/// (llm.py's resolve_keys + _is_key_error fallback chain).
pub async fn complete(client: &Client, cfg: &LlmConfig, system: &str, user: &str) -> Result<LlmResult, String> {
    complete_with_images(client, cfg, system, user, &[]).await
}

/// One-shot completion that ALSO sends inline images (data URLs) with the
/// user message. Used by the vision pass; `complete` is the text-only alias.
pub async fn complete_with_images(
    client: &Client,
    cfg: &LlmConfig,
    system: &str,
    user: &str,
    images: &[String],
) -> Result<LlmResult, String> {
    if cfg.api_keys.is_empty() && !kind_allows_keyless(&cfg.provider) {
        return Err("no api key configured".into());
    }
    // A keyless local endpoint runs ONE attempt with an empty key (no auth
    // header); cloud kinds never reach this with an empty list.
    let empty_key = [String::new()];
    let attempts: &[String] = if cfg.api_keys.is_empty() { &empty_key } else { &cfg.api_keys };
    // Build the payload ONCE: it does not depend on the key, and a vision call
    // is megabytes of base64 that used to be re-serialized for every attempt.
    let body = one_shot_body(cfg, system, user, images);
    let mut last_err = String::new();
    for key in key_attempt_order(attempts) {
        match complete_with_key(client, cfg, &key, &body).await {
            Ok(res) => {
                mark_key_ok(&key);
                return Ok(res);
            }
            Err((status, body)) if is_key_error(status, &body) => {
                mark_key_dead(&key);
                last_err = format!("key rejected ({status}): {body}");
                continue;
            }
            Err((_, body)) => return Err(body),
        }
    }
    Err(last_err)
}

/// Body of a ONE-SHOT (non-streaming) completion.
///
/// Split out of `complete_with_key` so the key-fallback loop serializes the
/// payload once instead of once per API-key attempt: a vision call carries
/// megabytes of base64, and `serde_json::json!` deep-copied all of it for every
/// retry.
pub(super) fn one_shot_body(cfg: &LlmConfig, system: &str, user: &str, images: &[String]) -> Value {
    let mut body = json!({});
    // The user message as neutral blocks: text + one block per image, each
    // translated to the provider's own shape just before it goes on the wire.
    let mut user_blocks: Vec<Value> = vec![json!({ "type": "text", "text": user })];
    for data_url in images {
        user_blocks.push(json!({ "type": IMAGE_BLOCK_TYPE, "data_url": data_url }));
    }
    // Text-only calls keep the exact plain-string shape they always had; only a
    // call that actually carries images switches to the block array.
    let content_for = |kind: &str| {
        if images.is_empty() {
            json!(user)
        } else {
            map_content(kind, &Value::Array(user_blocks.clone()))
        }
    };
    match cfg.provider.as_str() {
        "anthropic" => {
            body["model"] = json!(cfg.model);
            body["max_tokens"] = json!(cfg.max_tokens.unwrap_or(4096));
            body["system"] = json!(system);
            body["messages"] = json!([{
                "role": "user",
                "content": content_for("anthropic"),
            }]);
        }
        "google" => {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            let parts = if images.is_empty() {
                json!([{ "text": user }])
            } else {
                map_content("google", &Value::Array(user_blocks.clone()))
            };
            body["contents"] = json!([{ "role": "user", "parts": parts }]);
            if let Some(mt) = cfg.max_tokens {
                body["generationConfig"] = json!({ "maxOutputTokens": mt });
            }
        }
        _ => {
            body["model"] = json!(cfg.model);
            body["stream"] = json!(false);
            let mut wire = vec![json!({ "role": "system", "content": system })];
            wire.push(json!({ "role": "user", "content": content_for(cfg.provider.as_str()) }));
            body["messages"] = json!(wire);
            if let Some(t) = cfg.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = json!(mt);
            }
        }
    }
    // One-shot calls keep Google's NATIVE shape (systemInstruction/contents),
    // so they keep the native thinking budget too.
    apply_reasoning(cfg, &mut body, true);
    body
}

pub(super) async fn complete_with_key(
    client: &Client,
    cfg: &LlmConfig,
    key: &str,
    body: &Value,
) -> Result<LlmResult, (u16, String)> {
    let (url, header_name, header_value) = endpoint_and_auth(cfg, key);
    let mut req = client.post(&url).json(body);
    if !header_name.is_empty() && !has_header(&cfg.headers, header_name) {
        req = req.header(header_name, header_value);
    }
    for (name, value) in &cfg.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if cfg.provider == "anthropic" && !has_header(&cfg.headers, "anthropic-version") {
        req = req.header("anthropic-version", "2023-06-01");
    }
    // `timeout_secs` bounds the WHOLE one-shot request (headers + body). These
    // calls are background side tasks (compact / title / web summary / vision),
    // never the chat turn — that path is `stream_chat`, which stays deliberately
    // unbounded so a slow reasoning model is never cut off mid-answer. Before
    // this deadline existed, a provider that accepted the request and then
    // stalled kept the caller waiting forever: compaction retries on top of
    // that, so one hung call stacked into half-hour "Compacting…" banners with
    // no way out (Stop only aborts the streaming path).
    let budget = std::time::Duration::from_secs(cfg.timeout_secs.max(1));
    let attempt = async {
        // No separate header deadline: the budget above already covers the whole
        // request, including a reasoning model that needs minutes before its
        // first byte.
        let resp = req.send().await.map_err(|e| (0u16, e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| (status, e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err((status, nonempty_error_body(status, text)));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| (status, e.to_string()))?;
        extract_completion(&cfg.provider, &v)
    };
    match tokio::time::timeout(budget, attempt).await {
        Ok(result) => result,
        Err(_) => Err((
            0u16,
            format!(
                "provider sent no response within {}s",
                cfg.timeout_secs.max(1)
            ),
        )),
    }
}

// ---------------------------------------------------------------------------
// Usage normalization — one vocabulary for every provider, by PAYLOAD SHAPE
// ---------------------------------------------------------------------------

