// Phase 3-1: one-shot LLM client (non-streaming) mirroring the behavior of
// backend/llm.py `llm_complete` for the endpoints we serve natively
// (/chat/compact). Streaming chat stays on the Python sidecar until the
// agent loop (phase 3-2) moves over.

use reqwest::Client;
use serde_json::{json, Value};

/// Resolved per-call LLM configuration (mirrors llm.py's build_chat_model args).
#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_keys: Vec<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub timeout_secs: u64,
}

pub struct LlmResult {
    pub text: String,
    pub usage: Option<Value>,
}

/// Build a plain HTTP client for provider calls (no proxy, like the sidecar).
pub fn http_client() -> Client {
    Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

/// Normalize the base URL the same way providers.py does:
/// - strip a trailing slash
/// - anthropic: strip a trailing `/v1` (the SDK re-appends `/v1/messages`)
/// - ollama: append `/v1` unless already present
pub fn normalize_base(provider: &str, base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    match provider {
        "anthropic" => {
            if base.ends_with("/v1") {
                base.truncate(base.len() - 3);
            }
        }
        "ollama" => {
            if !base.ends_with("/v1") {
                base.push_str("/v1");
            }
        }
        _ => {}
    }
    base
}

/// Resolve the chat-completions endpoint + auth header style for a kind.
/// Returns (url, header_name, header_value_prefix).
fn endpoint_and_auth(cfg: &LlmConfig) -> (String, &'static str, String) {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    let key = cfg.api_keys.first().cloned().unwrap_or_default();
    match cfg.provider.as_str() {
        "anthropic" => (
            format!("{base}/v1/messages"),
            "x-api-key",
            key,
        ),
        "google" => (
            format!("{base}/v1beta/models/{model}:generateContent", model = cfg.model),
            "x-goog-api-key",
            key,
        ),
        // OpenAI-compatible kinds (openrouter/ollama/custom/nvidia/...)
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    }
}

fn is_key_error(status: u16, body: &str) -> bool {
    matches!(status, 401 | 402 | 403 | 429)
        || body.to_ascii_lowercase().contains("invalid api key")
        || body.to_ascii_lowercase().contains("unauthorized")
        || body.to_ascii_lowercase().contains("quota")
}

/// One-shot completion. Tries each API key in order on key errors
/// (llm.py's resolve_keys + _is_key_error fallback chain).
pub async fn complete(client: &Client, cfg: &LlmConfig, system: &str, user: &str) -> Result<LlmResult, String> {
    if cfg.api_keys.is_empty() {
        return Err("no api key configured".into());
    }
    let mut last_err = String::new();
    for key in &cfg.api_keys {
        match complete_with_key(client, cfg, key, system, user).await {
            Ok(res) => return Ok(res),
            Err((status, body)) if is_key_error(status, &body) => {
                last_err = format!("key rejected ({status}): {body}");
                continue;
            }
            Err((_, body)) => return Err(body),
        }
    }
    Err(last_err)
}

async fn complete_with_key(
    client: &Client,
    cfg: &LlmConfig,
    _key: &str,
    system: &str,
    user: &str,
) -> Result<LlmResult, (u16, String)> {
    let (url, header_name, header_value) = endpoint_and_auth(cfg);
    let mut body = json!({});
    match cfg.provider.as_str() {
        "anthropic" => {
            body["model"] = json!(cfg.model);
            body["max_tokens"] = json!(cfg.max_tokens.unwrap_or(4096));
            body["system"] = json!(system);
            body["messages"] = json!([{ "role": "user", "content": user }]);
        }
        "google" => {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            body["contents"] = json!([{ "role": "user", "parts": [{ "text": user }] }]);
            if let Some(mt) = cfg.max_tokens {
                body["generationConfig"] = json!({ "maxOutputTokens": mt });
            }
        }
        _ => {
            body["model"] = json!(cfg.model);
            body["stream"] = json!(false);
            body["messages"] = json!([
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ]);
            if let Some(t) = cfg.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = json!(mt);
            }
        }
    }

    let mut req = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .header(header_name, header_value)
        .json(&body);
    if cfg.provider == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
    }
    let resp = req.send().await.map_err(|e| (0u16, e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| (status, e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err((status, text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| (status, e.to_string()))?;
    extract_completion(&cfg.provider, &v)
}

// ---------------------------------------------------------------------------
// Streaming (SSE) — phase 3-2: the agent loop consumes deltas + tool_calls.
// ---------------------------------------------------------------------------

/// One streamed step's accumulated output.
#[derive(Debug, Default, Clone)]
pub struct StreamAcc {
    pub text: String,
    /// OpenAI-style tool calls accumulated across deltas: {id, name, arguments}.
    pub tool_calls: Vec<Value>,
    pub finish_reason: String,
    pub usage: Option<Value>,
}

/// Callback fired for every text delta (the agent loop forwards these live).
pub type DeltaSink<'a> = &'a mut (dyn FnMut(&str) + 'a);

/// Parse one SSE `data:` payload into accumulator updates. Returns true when
/// the payload was a terminal `[DONE]` marker.
fn apply_sse_payload(provider: &str, payload: &str, acc: &mut StreamAcc) -> bool {
    let payload = payload.trim();
    if payload == "[DONE]" {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return false;
    };
    match provider {
        "anthropic" => {
            match v["type"].as_str() {
                Some("content_block_delta") => {
                    if let Some(t) = v["delta"]["text"].as_str() {
                        acc.text.push_str(t);
                    }
                }
                Some("message_delta") => {
                    acc.finish_reason = v["delta"]["stop_reason"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    if v["usage"].is_object() {
                        let merged = match acc.usage.take() {
                            Some(u) => {
                                let mut m = u;
                                for (k, val) in v["usage"].as_object().unwrap() {
                                    m[k] = val.clone();
                                }
                                m
                            }
                            None => v["usage"].clone(),
                        };
                        acc.usage = Some(merged);
                    }
                }
                Some("message_start") => {
                    if v["message"]["usage"].is_object() {
                        acc.usage = Some(v["message"]["usage"].clone());
                    }
                }
                _ => {}
            }
        }
        "google" => {
            if let Some(t) = v["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                acc.text.push_str(t);
            }
            if v["usageMetadata"].is_object() {
                acc.usage = Some(v["usageMetadata"].clone());
            }
            if v["candidates"][0]["finishReason"].is_string() {
                acc.finish_reason = v["candidates"][0]["finishReason"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
            }
        }
        _ => {
            let choice = &v["choices"][0];
            if let Some(t) = choice["delta"]["content"].as_str() {
                acc.text.push_str(t);
            }
            if let Some(tcs) = choice["delta"]["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                    if acc.tool_calls.len() <= idx {
                        acc.tool_calls.resize_with(idx + 1, || json!({}));
                    }
                    let slot = &mut acc.tool_calls[idx];
                    if let Some(id) = tc["id"].as_str() {
                        slot["id"] = json!(id);
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        slot["function"]["name"] = json!(name);
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        let cur = slot["function"]["arguments"].as_str().unwrap_or_default();
                        slot["function"]["arguments"] = json!(format!("{cur}{args}"));
                    }
                }
            }
            if let Some(fr) = choice["finish_reason"].as_str() {
                acc.finish_reason = fr.to_string();
            }
            if v["usage"].is_object() {
                acc.usage = Some(v["usage"].clone());
            }
        }
    }
    false
}

/// Stream one chat completion, invoking `on_delta` for every text chunk.
/// Returns the accumulated result (text, tool_calls, finish_reason, usage).
pub async fn stream_chat(
    client: &Client,
    cfg: &LlmConfig,
    messages: &[Value],
    on_delta: DeltaSink<'_>,
) -> Result<StreamAcc, (u16, String)> {
    if cfg.api_keys.is_empty() {
        return Err((0, "no api key configured".into()));
    }
    let mut last_err = String::new();
    for key in &cfg.api_keys {
        match stream_with_key(client, cfg, key, messages, on_delta).await {
            Ok(acc) => return Ok(acc),
            Err((status, body)) if is_key_error(status, &body) => {
                last_err = format!("key rejected ({status}): {body}");
                continue;
            }
            Err((_, body)) => return Err((0, body)),
        }
    }
    Err((0, last_err))
}

async fn stream_with_key(
    client: &Client,
    cfg: &LlmConfig,
    key: &str,
    messages: &[Value],
    on_delta: DeltaSink<'_>,
) -> Result<StreamAcc, (u16, String)> {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    let (url, header_name, header_value) = match cfg.provider.as_str() {
        "anthropic" => (format!("{base}/v1/messages"), "x-api-key", key.to_string()),
        "google" => (
            format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse", model = cfg.model),
            "x-goog-api-key",
            key.to_string(),
        ),
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    };

    let mut body = json!({});
    match cfg.provider.as_str() {
        "anthropic" => {
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m["role"] == "system")
                .filter_map(|m| m["content"].as_str())
                .collect();
            body["model"] = json!(cfg.model);
            body["max_tokens"] = json!(cfg.max_tokens.unwrap_or(4096));
            if !system.is_empty() {
                body["system"] = json!(system.join("\n\n"));
            }
            body["messages"] = json!(messages
                .iter()
                .filter(|m| m["role"] != "system")
                .collect::<Vec<_>>());
            body["stream"] = json!(true);
        }
        "google" => {
            if let Some(sys) = messages.iter().find(|m| m["role"] == "system") {
                body["systemInstruction"] = json!({ "parts": [{ "text": sys["content"] }] });
            }
            body["contents"] = json!(messages
                .iter()
                .filter(|m| m["role"] != "system")
                .collect::<Vec<_>>());
        }
        _ => {
            body["model"] = json!(cfg.model);
            body["stream"] = json!(true);
            body["messages"] = json!(messages);
            if let Some(t) = cfg.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = json!(mt);
            }
        }
    }

    let mut req = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .header(header_name, header_value)
        .json(&body);
    if cfg.provider == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
    }
    let resp = req.send().await.map_err(|e| (0u16, e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err((status, text));
    }

    let mut acc = StreamAcc::default();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| (0u16, e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line.
        while let Some(pos) = buf.find("\n\n") {
            let frame: String = buf.drain(..pos + 2).collect();
            for line in frame.lines() {
                if let Some(payload) = line.strip_prefix("data: ") {
                    let mut sink = |t: &str| on_delta(t);
                    let _ = &mut sink;
                    if apply_sse_payload(&cfg.provider, payload, &mut acc) {
                        return Ok(acc);
                    }
                }
            }
        }
    }
    Ok(acc)
}

/// Pull (text, usage) out of a provider response.
fn extract_completion(provider: &str, v: &Value) -> Result<LlmResult, (u16, String)> {    match provider {
        "anthropic" => {
            let text: String = v["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            Ok(LlmResult { text, usage: Some(v["usage"].clone()) })
        }
        "google" => {
            let text = v["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            Ok(LlmResult { text, usage: Some(v["usageMetadata"].clone()) })
        }
        _ => {
            let choice = &v["choices"][0];
            let text = choice["message"]["content"].as_str().unwrap_or_default().to_string();
            Ok(LlmResult { text, usage: v["usage"].as_object().map(|_| v["usage"].clone()) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str, base: &str, keys: &[&str]) -> LlmConfig {
        LlmConfig {
            provider: provider.into(),
            model: "m".into(),
            base_url: base.into(),
            api_keys: keys.iter().map(|s| s.to_string()).collect(),
            temperature: None,
            max_tokens: None,
            timeout_secs: 30,
        }
    }

    #[test]
    fn base_normalization_matches_providers_py() {
        assert_eq!(normalize_base("anthropic", "https://api.anthropic.com/v1/"), "https://api.anthropic.com");
        assert_eq!(normalize_base("ollama", "http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("ollama", "http://localhost:11434/v1"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("custom", "https://x.example/v1/"), "https://x.example/v1");
    }

    #[test]
    fn key_error_detection_mirrors_llm_py() {
        assert!(is_key_error(401, ""));
        assert!(is_key_error(429, ""));
        // Python's _is_key_error also matches key-flavored messages on any status.
        assert!(is_key_error(400, "invalid api key"));
        assert!(is_key_error(500, "Invalid API Key provided"));
        assert!(!is_key_error(500, "context overflow"));
    }

    #[test]
    fn extract_openai_completion() {
        let v = json!({
            "choices": [{ "message": { "content": "hello" } }],
            "usage": { "input_tokens": 3, "output_tokens": 5 }
        });
        let r = extract_completion("custom", &v).unwrap();
        assert_eq!(r.text, "hello");
        assert_eq!(r.usage.unwrap()["input_tokens"], 3);
    }

    #[test]
    fn extract_anthropic_completion() {
        let v = json!({
            "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }],
            "usage": { "input_tokens": 1 }
        });
        let r = extract_completion("anthropic", &v).unwrap();
        assert_eq!(r.text, "ab");
    }

    #[test]
    fn complete_requires_a_key() {
        let c = http_client();
        let c0 = cfg("custom", "http://127.0.0.1:1", &[]);
        assert!(tokio_test_block(&c, &c0).contains("no api key"));
    }

    #[test]
    fn sse_payloads_accumulate_openai_deltas() {
        let mut acc = StreamAcc::default();
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"he"}}]}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"llo"}}]}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\"file"}]}}]}]}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"filePath\":\"a\"}"}}]}}]}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":2}}"#,
            &mut acc
        ));
        assert_eq!(acc.text, "hello");
        assert_eq!(acc.finish_reason, "tool_calls");
        assert_eq!(acc.tool_calls.len(), 1);
        assert_eq!(acc.tool_calls[0]["function"]["name"], "read");
        assert_eq!(acc.tool_calls[0]["function"]["arguments"].as_str().unwrap(), r#"{"filePath":"a"}"#);
        assert_eq!(acc.usage.clone().unwrap()["input_tokens"], 2);
        // Terminal marker.
        assert!(apply_sse_payload("custom", "[DONE]", &mut acc));
    }

    #[test]
    fn sse_payloads_accumulate_anthropic_deltas() {
        let mut acc = StreamAcc::default();
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_start","message":{"usage":{"input_tokens":7}}}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut acc
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
            &mut acc
        ));
        assert_eq!(acc.text, "hi");
        assert_eq!(acc.finish_reason, "end_turn");
        let usage = acc.usage.unwrap();
        assert_eq!(usage["input_tokens"], 7);
        assert_eq!(usage["output_tokens"], 3);
    }

    fn tokio_test_block(client: &Client, c: &LlmConfig) -> String {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { complete(client, c, "s", "u").await.err().unwrap() })
    }
}
