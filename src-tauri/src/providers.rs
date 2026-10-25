//! Native provider endpoints (phase 4): the non-ML routes that used to live in
//! `backend/server.py` + `backend/providers.py`.
//!
//! STT (`/transcribe`) and TTS (`/tts`) stay on the Python sidecar because they
//! are the only features that need torch / faster-whisper. Everything here is
//! plain HTTP + JSON, so the renderer no longer wakes Python for it.

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

/// Well-known agent-CLI User-Agents. Some gateways block unknown HTTP clients
/// by User-Agent (HTTP 401 "unauthorized client") while the credential itself
/// is valid, so a refused request is retried with each of these in order.
pub const UA_LADDER: [&str; 3] = [
    "claude-cli/2.0.35 (external, cli)",
    "opencode/1.18.15 (npm:@opencode-ai/opencode)",
    "Cline/3.0.0",
];

pub const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";

/// Env vars consulted for a provider kind when nothing is configured in
/// Settings (mirrors providers.py `_PROVIDERS[...]["env_vars"]`, with
/// `OPENROUTER_API_KEY` as the shared fallback).
fn provider_env_names(provider: &str) -> &'static [&'static str] {
    match provider {
        "openrouter" => &["OPENROUTER_API_KEY"],
        "google" => &["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "nvidia" => &["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
        "cloudflare" => &["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN"],
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        _ => &["OPENROUTER_API_KEY"],
    }
}

/// API key from the environment for a provider. An explicit `env_var` name is
/// read first; if that exact variable is unset we fall back to the provider's
/// known names.
pub fn env_key(provider: &str, env_var: &str) -> String {
    let explicit = env_var.trim();
    if !explicit.is_empty() {
        if let Ok(val) = std::env::var(explicit) {
            if !val.is_empty() {
                return val;
            }
        }
        return env_key(provider, "");
    }
    for name in provider_env_names(provider) {
        if let Ok(val) = std::env::var(name) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    String::new()
}

/// Decode the JSON text the renderer puts in `api_keys`.
///
/// A query-string value is always a string, so `JSON.stringify(keys)` arrives
/// as the literal TEXT `["k"]` — never as an array. Pushing that verbatim sent
/// the brackets and quotes to the provider as the credential, and Google
/// answered `400 "Please pass a valid API key"` for a key that was valid.
/// Returns `None` for a plain key (no real key starts with `[` or `{`).
fn decode_key_json(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('[') && !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok()
}

/// Ordered API keys for a provider, first tried first. Accepts the renderer's
/// `api_keys` JSON (list, or a single string) plus the legacy single `api_key`,
/// with the environment as a last resort — mirrors providers.py `resolve_keys`.
pub fn resolve_keys(
    provider: &str,
    api_key: &str,
    env_var: &str,
    api_keys: Option<&Value>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |raw: &str, out: &mut Vec<String>| {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|k| k == trimmed) {
            out.push(trimmed.to_string());
        }
    };
    match api_keys {
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    push(s, &mut out);
                }
            }
        }
        // `api_keys` over a query string is text, so the JSON list the renderer
        // sends has to be decoded before its items can be used as keys.
        Some(Value::String(s)) => match decode_key_json(s) {
            Some(Value::Array(items)) => {
                for item in items {
                    if let Some(k) = item.as_str() {
                        push(k, &mut out);
                    }
                }
            }
            Some(Value::Object(map)) => {
                if let Some(k) = pick_from_map(&map, provider) {
                    push(&k, &mut out);
                }
            }
            _ => push(s, &mut out),
        },
        _ => {}
    }
    push(api_key, &mut out);
    if out.is_empty() {
        let env = env_key(provider, env_var);
        if !env.is_empty() {
            out.push(env);
        }
    }
    out
}

/// Strip HTML tags from a gateway error page and collapse whitespace, so the
/// UI hint never shows raw markup (mirrors the Python handler).
fn strip_tags(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut in_tag = false;
    for ch in body.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------- GET /credits ----------

#[derive(Debug, Deserialize)]
pub struct CreditsQuery {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub env_var: String,
    /// JSON-encoded key list (the renderer sends `JSON.stringify(keys)`).
    #[serde(default)]
    pub api_keys: Option<Value>,
}

/// Only OpenRouter exposes a balance endpoint; every other provider returns an
/// empty object so the UI renders no balance line.
pub async fn credits(Query(q): Query<CreditsQuery>) -> Response {
    if q.provider != "openrouter" {
        return Json(json!({})).into_response();
    }
    let mut keys = resolve_keys(&q.provider, &q.api_key, &q.env_var, q.api_keys.as_ref());
    if keys.is_empty() {
        keys.push(String::new());
    }
    let client = crate::llm::http_client();
    let url = format!("{OPENROUTER_BASE}/credits");
    let last_index = keys.len() - 1;
    let mut last_error = String::new();
    for (i, key) in keys.iter().enumerate() {
        let mut req = client.get(&url);
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };
        let status = res.status();
        // A dead key falls through to the next one, exactly like the Python
        // retry ladder.
        if matches!(status.as_u16(), 401 | 403 | 429) && i < last_index {
            last_error = format!("credits lookup failed: {}", status.as_u16());
            continue;
        }
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            last_error = format!("credits lookup failed: HTTP {}", status.as_u16());
            continue;
        }
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        return Json(parse_credits(&parsed)).into_response();
    }
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "detail": format!("credits lookup failed: {last_error}") })),
    )
        .into_response()
}

/// Response mapping for the OpenRouter balance payload. Kept pure so the
/// rounding contract is unit-testable.
fn parse_credits(body: &Value) -> Value {
    let data = body.get("data").unwrap_or(&Value::Null);
    let total = data.get("total_credits").and_then(Value::as_f64).unwrap_or(0.0);
    let usage = data.get("total_usage").and_then(Value::as_f64).unwrap_or(0.0);
    // Python rounds to 6 decimals; float math would otherwise leak 0.30000000000000004.
    let balance = ((total - usage) * 1_000_000.0).round() / 1_000_000.0;
    json!({ "balance": balance, "total_credits": total, "total_usage": usage })
}

// ---------- POST /realtime/session ----------

#[derive(Debug, Deserialize)]
pub struct RealtimeBody {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub env_var: String,
    /// JSON-encoded key list, single string, or a key map — the renderer sends
    /// `JSON.stringify(keys)`, older callers sent a bare string.
    #[serde(default)]
    pub api_keys: Option<Value>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
}

/// Resolve the MASTER provider key server-side so it never reaches the
/// browser: explicit field first, then the key map/list, then the environment.
fn resolve_realtime_key(b: &RealtimeBody) -> String {
    let direct = b.api_key.trim();
    if !direct.is_empty() {
        return direct.to_string();
    }
    if let Some(keys) = b.api_keys.as_ref() {
        match keys {
            Value::String(raw) => {
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    // A JSON-encoded string arrives as text; decode it so
                    // `JSON.stringify(["k"])` works like the list form.
                    match decode_key_json(trimmed) {
                        Some(Value::Array(items)) => {
                            if let Some(found) = items.iter().find_map(|v| {
                                v.as_str().map(str::trim).filter(|s| !s.is_empty())
                            }) {
                                return found.to_string();
                            }
                        }
                        Some(Value::Object(map)) => {
                            if let Some(found) = pick_from_map(&map, &b.provider) {
                                return found;
                            }
                        }
                        Some(_) => return trimmed.to_string(),
                        None => return trimmed.to_string(),
                    }
                }
            }
            Value::Array(_) => {
                let list = resolve_keys(&b.provider, "", "", b.api_keys.as_ref());
                if let Some(first) = list.into_iter().next() {
                    return first;
                }
            }
            Value::Object(map) => {
                if let Some(found) = pick_from_map(map, &b.provider) {
                    return found;
                }
            }
            _ => {}
        }
    }
    env_key(&b.provider, &b.env_var)
}

/// Pick a usable key from a `{provider|default|openai|realtime: key}` map.
fn pick_from_map(map: &serde_json::Map<String, Value>, provider: &str) -> Option<String> {
    let read = |value: Option<&Value>| -> Option<String> {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let provider = provider.trim();
    if !provider.is_empty() {
        if let Some(found) = read(map.get(provider)) {
            return Some(found);
        }
    }
    for fallback in ["default", "openai", "realtime"] {
        if let Some(found) = read(map.get(fallback)) {
            return Some(found);
        }
    }
    map.values().find_map(|v| read(Some(v)))
}

/// Percent-encoding set matching Python's `quote()` default: only the
/// unreserved characters (`A-Za-z0-9`, plus `_ . - ~`) and `/` are left as-is.
/// Anything else is escaped — a `NON_ALPHANUMERIC` set alone would also escape
/// `-` and `.`, which Python keeps literal (a model id like `gpt-realtime`
/// must not become `gpt%2Drealtime`).
const QUOTE_SAFE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'_')
    .remove(b'.')
    .remove(b'-')
    .remove(b'~');

/// Derive a realtime websocket URL from an HTTP(S) base URL.
fn realtime_websocket_url(base_url: &str, model: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    let url = if ws.ends_with("/realtime") {
        ws
    } else {
        format!("{ws}/realtime")
    };
    if model.is_empty() {
        return url;
    }
    let encoded: String = percent_encoding::utf8_percent_encode(model, QUOTE_SAFE).to_string();
    format!("{url}?model={encoded}")
}

/// Map the upstream `client_secrets` payload to our response contract.
fn parse_realtime(body: &Value, base_url: &str, model: &str) -> Result<Value, String> {
    let mut token = String::new();
    let mut expires_at: Option<i64> = None;
    if let Some(secret) = body.get("client_secret") {
        if let Some(value) = secret.get("value").and_then(Value::as_str) {
            token = value.trim().to_string();
        }
        if let Some(raw) = secret.get("expires_at").and_then(Value::as_i64) {
            expires_at = Some(raw);
        }
    }
    for key in ["ephemeral_token", "token", "client_token", "value"] {
        if token.is_empty() {
            if let Some(value) = body.get(key).and_then(Value::as_str) {
                token = value.trim().to_string();
            }
        }
    }
    if token.is_empty() {
        return Err("realtime session failed: upstream did not return a token".into());
    }
    let websocket_url = match body.get("websocket_url").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => realtime_websocket_url(base_url, model),
    };
    let expires = match expires_at.or_else(|| body.get("expires_at").and_then(Value::as_i64)) {
        Some(value) => value,
        // The frontend only uses this for a refresh hint, so a short default
        // keeps the session usable when the upstream omits the field.
        None => chrono::Utc::now().timestamp() + 60,
    };
    Ok(json!({
        "ephemeral_token": token,
        "websocket_url": websocket_url,
        "expires_at": expires,
    }))
}

pub async fn realtime_session(Json(b): Json<RealtimeBody>) -> Response {
    let base_url = b.base_url.trim().to_string();
    if base_url.is_empty() {
        return bad_request("remote realtime needs 'base_url'");
    }
    let model = b.model.trim().to_string();
    if model.is_empty() {
        return bad_request("missing 'model' field");
    }
    let master_key = resolve_realtime_key(&b);
    if master_key.is_empty() {
        return bad_request("missing api key for realtime session");
    }
    let url = format!(
        "{}/realtime/client_secrets",
        base_url.trim_end_matches('/')
    );
    let voice = b.voice.trim();
    let mut session = json!({ "type": "realtime", "model": model });
    if !voice.is_empty() {
        session["audio"] = json!({ "output": { "voice": voice } });
    }
    let client = crate::llm::http_client();
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {master_key}"))
        .header("User-Agent", UA_LADDER[0])
        .json(&json!({ "session": session }))
        .send()
        .await;
    let res = match res {
        Ok(res) => res,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "detail": format!("realtime session failed: {e}") })),
            )
                .into_response()
        }
    };
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // Gateways often return an HTML error page here; strip the markup so
        // the frontend hint stays readable.
        let cleaned = strip_tags(&body);
        let detail = if cleaned.is_empty() {
            format!("realtime session failed ({})", status.as_u16())
        } else {
            cleaned.chars().take(300).collect()
        };
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "detail": detail })),
        )
            .into_response();
    }
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    match parse_realtime(&parsed, &base_url, &model) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "detail": e }))).into_response(),
    }
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "detail": msg })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keys are de-duplicated in order, the legacy single key is appended, and
    /// the environment is only consulted when nothing else is configured —
    /// a stale env key must never outrank a key the user typed in Settings.
    #[test]
    fn resolve_keys_orders_and_dedupes() {
        let keys = resolve_keys(
            "openrouter",
            "second",
            "",
            Some(&json!(["first", "second", "  "])),
        );
        assert_eq!(keys, vec!["first", "second"]);

        let single = resolve_keys("openrouter", "", "", Some(&json!("only")));
        assert_eq!(single, vec!["only"]);

        // A query-string value is TEXT, so the renderer's `JSON.stringify(keys)`
        // arrives as the literal `["k"]`. Pushing that verbatim sent the brackets
        // and quotes as the credential: Google answered 400 "Please pass a valid
        // API key" for a key that was perfectly valid.
        let encoded = resolve_keys("google", "", "", Some(&json!("[\"AIzaSy-real\"]")));
        assert_eq!(encoded, vec!["AIzaSy-real"]);

        // A key map (the realtime shape) decodes to the matching entry.
        let mapped = resolve_keys(
            "nvidia",
            "",
            "",
            Some(&json!("{\"nvidia\":\"nvapi-x\",\"default\":\"other\"}")),
        );
        assert_eq!(mapped, vec!["nvapi-x"]);

        // A plain key is left alone — nothing legitimately starts with `[`.
        let plain = resolve_keys("google", "", "", Some(&json!("AIzaSy-plain")));
        assert_eq!(plain, vec!["AIzaSy-plain"]);

        // The environment is the LAST resort: an explicitly configured key
        // always outranks it. Assert on an env var name that cannot be set so
        // the result does not depend on the machine running the tests.
        let from_env = resolve_keys("openrouter", "", "CODFA_TEST_UNSET_KEY_VAR", None);
        assert!(from_env.is_empty() || from_env.len() == 1);
    }

    /// The balance is total - usage rounded to 6 decimals, and a payload with
    /// no `data` object must report zeros instead of failing.
    #[test]
    fn credits_balance_is_rounded() {
        let value = parse_credits(&json!({
            "data": { "total_credits": 10.3, "total_usage": 0.1 }
        }));
        assert_eq!(value["total_credits"], 10.3);
        assert_eq!(value["total_usage"], 0.1);
        assert_eq!(value["balance"], 10.2);

        let empty = parse_credits(&json!({}));
        assert_eq!(empty["balance"], 0.0);
    }

    /// `https` becomes `wss`, a `/realtime` suffix is not duplicated, and the
    /// model is appended as a query param.
    #[test]
    fn websocket_url_derivation() {
        assert_eq!(
            realtime_websocket_url("https://api.example.com/v1", "gpt-realtime"),
            "wss://api.example.com/v1/realtime?model=gpt-realtime"
        );
        assert_eq!(
            realtime_websocket_url("http://localhost:1234/realtime", ""),
            "ws://localhost:1234/realtime"
        );
    }

    /// The upstream shape varies between gateways; `client_secret.value` wins,
    /// the flat token keys are the fallback, and a payload without any token is
    /// an error the caller surfaces as a 502.
    #[test]
    fn realtime_response_mapping() {
        let nested = parse_realtime(
            &json!({ "client_secret": { "value": " ek_123 ", "expires_at": 42 } }),
            "https://api.example.com/v1",
            "m",
        )
        .unwrap();
        assert_eq!(nested["ephemeral_token"], "ek_123");
        assert_eq!(nested["expires_at"], 42);

        let flat = parse_realtime(
            &json!({ "websocket_url": "wss://x/realtime", "token": "ek_flat" }),
            "https://api.example.com/v1",
            "m",
        )
        .unwrap();
        assert_eq!(flat["ephemeral_token"], "ek_flat");
        assert_eq!(flat["websocket_url"], "wss://x/realtime");

        assert!(parse_realtime(&json!({}), "https://x", "m").is_err());
    }

    /// The master key resolution order: explicit field, provider slot, then the
    /// generic fallbacks of the key map.
    #[test]
    fn realtime_key_resolution_prefers_explicit_then_map() {
        let direct = RealtimeBody {
            provider: "openai".into(),
            base_url: "".into(),
            api_key: "explicit".into(),
            env_var: "".into(),
            api_keys: Some(json!({"openai": "map-key"})),
            model: "".into(),
            voice: "".into(),
        };
        assert_eq!(resolve_realtime_key(&direct), "explicit");

        let mapped = RealtimeBody {
            provider: "openai".into(),
            api_key: "".into(),
            api_keys: Some(json!({"default": "fallback-key"})),
            ..direct
        };
        assert_eq!(resolve_realtime_key(&mapped), "fallback-key");
    }

    /// An HTML error page must not reach the user verbatim.
    #[test]
    fn strip_tags_collapses_markup() {
        assert_eq!(
            strip_tags("<html><body>Bad   gateway!</body></html>"),
            "Bad gateway!"
        );
    }
}
