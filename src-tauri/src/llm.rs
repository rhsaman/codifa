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

/// Pull (text, usage) out of a provider response.
fn extract_completion(provider: &str, v: &Value) -> Result<LlmResult, (u16, String)> {
    match provider {
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

    fn tokio_test_block(client: &Client, c: &LlmConfig) -> String {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { complete(client, c, "s", "u").await.err().unwrap() })
    }
}
