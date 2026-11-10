// Phase 3-1: one-shot LLM client (non-streaming) mirroring the behavior of
// backend/llm.py `llm_complete` for the endpoints we serve natively
// (/chat/compact). Streaming chat stays on the Python sidecar until the
// agent loop (phase 3-2) moves over.

// Phase 3-2 WIP: streaming path is only called from agent.rs (not wired to a
// route yet). Silence dead-code on the streaming half until the route lands.
#![allow(dead_code)]

use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// Resolved per-call LLM configuration (mirrors llm.py's build_chat_model args).
#[derive(Debug, Clone)]
pub struct LlmConfig {
    /// The wire KIND ("custom", "anthropic", …): it selects the URL path and
    /// the auth header, nothing else.
    pub provider: String,
    /// The provider ROW this call is routed to — the Tool Models slot's own
    /// provider id, or the chat's. A kind cannot name what the user
    /// configured (every OpenAI-compatible endpoint is literally "custom"),
    /// so banners, error text and the usage panel must use this instead.
    pub provider_id: String,
    pub model: String,
    pub base_url: String,
    pub api_keys: Vec<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub timeout_secs: u64,
    /// Reasoning-effort level chosen for this call ("none" / "low" /
    /// "medium" / "high" / "xhigh" / "max"). `""` means "provider default"
    /// and sends no reasoning parameter. Mirrors the old Python
    /// `_THINKING_LEVELS` mapping that was lost in the Rust migration.
    pub reasoning_level: String,
    /// Whether the selected model is known to be reasoning-capable (the
    /// provider's `/models` `reasoning` flag, or the user's manual override).
    /// A local/custom provider without the cloud `auto_think` flag still gets
    /// a reasoning effort when this is true (e.g. ollama `deepseek-r1`).
    pub model_reasoning: bool,
    /// True for cloud gateway kinds that auto-route to reasoning-capable
    /// models (openrouter / nvidia / cloudflare).
    /// Gates the reasoning param the same way the Python `auto_think` did.
    pub auto_think: bool,
    /// Extra request headers configured on the provider ROW (Settings →
    /// provider form), sent verbatim after the auth header. A gateway that
    /// only answers its own client (OpenCode Zen and its `x-opencode-*`
    /// signature) needs them, and the kind alone cannot express that.
    pub headers: Vec<(String, String)>,
}

/// Read the `headers` list of one provider row out of the request's provider
/// map. Accepted shapes: an array of `{key, value}` pairs (what the form
/// saves) and a plain `{"k": "v"}` object. Blank names and rows without
/// headers yield an empty list, so every caller can pass it straight through.
pub fn custom_headers(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
) -> Vec<(String, String)> {
    header_pairs(providers.get(provider_id).and_then(|row| row.get("headers")))
}

/// Parse one `headers` value (array of `{key, value}` or plain `{"k": "v"}`)
/// into pairs, dropping blank names. Separate from [`custom_headers`] so paths
/// that carry no provider map (the model list, the probe) can reuse it.
///
/// A JSON **string** is decoded first: `GET /models` carries every argument
/// over the query string, where the renderer can only send the list as text
/// (`headers=[{"key":…}]`). Without this branch that path silently sent no
/// row headers at all while chat and the probe sent them.
pub fn header_pairs(raw: Option<&Value>) -> Vec<(String, String)> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    // Bind the decoded value outside the match so the borrowed slice below
    // outlives it; parse ONCE (a nested string is not decoded again).
    let decoded;
    let raw = match raw {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(v) => {
                decoded = v;
                &decoded
            }
            Err(_) => return Vec::new(),
        },
        other => other,
    };
    let pair = |k: Option<&Value>, v: Option<&Value>| -> Option<(String, String)> {
        let name = k.and_then(Value::as_str).map(str::trim)?;
        if name.is_empty() {
            return None;
        }
        let value = v.and_then(Value::as_str).unwrap_or("").trim();
        Some((name.to_string(), value.to_string()))
    };
    match raw {
        Value::Array(items) => items
            .iter()
            .filter_map(|it| pair(it.get("key"), it.get("value")))
            .collect(),
        Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| pair(Some(&Value::String(k.clone())), Some(v)))
            .collect(),
        _ => Vec::new(),
    }
}

/// True when the row already sets `name` itself. The auth header is derived
/// from the key, so a row that spells `Authorization` out must win instead of
/// being sent twice (reqwest appends, it does not replace).
pub fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name))
}


mod client;
mod complete;
mod request;
mod stream;

// Public re-exports reproduce the original llm surface — nothing new exposed.
pub use client::*;
pub use complete::*;
pub use request::*;
pub use stream::*;
pub(crate) use stream::provider_error_message;

#[cfg(test)]
mod tests;
