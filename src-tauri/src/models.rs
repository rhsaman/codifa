//! Native model-catalog endpoint: `GET /models`.
//!
//! Ported from `backend/providers.py::list_models`. The renderer needs four
//! things per model — `id`, `context`, `pricing`, `reasoning` — and the two
//! authoritative sources are the provider's own `/models` payload and the
//! community-maintained models.dev catalog (used to fill the gaps, and as the
//! PRIMARY source for gateways that under-report their context window).
//!
//! Rules kept from the Python original:
//!   * the provider's own `context_length` wins; models.dev only fills gaps —
//!     EXCEPT for opencode-compatible gateways, where models.dev is primary
//!     (their payload advertises a bogus 4096);
//!   * `auto_think` cloud gateways default to reasoning-capable when neither
//!     source says otherwise, instead of falling back to a name heuristic;
//!   * a 401 retries the request with each well-known agent-CLI User-Agent
//!     before giving up, and a dead first key falls through to the next;
//!   * no hardcoded context floor: an unknown model stays `null` so the UI
//!     shows a dash rather than a wrong number.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::providers::{resolve_keys, UA_LADDER};

const MODELS_DEV_API: &str = "https://models.dev/api.json";
const MODELS_DEV_CACHE_SECS: u64 = 3600;
const MODEL_CACHE_SECS: u64 = 120;
const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const OLLAMA_BASE: &str = "http://localhost:11434";
const NVIDIA_BASE: &str = "https://integrate.api.nvidia.com/v1";
const TOKENROUTER_BASE: &str = "https://api.tokenrouter.com/v1";
const GOOGLE_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
const CLOUDFLARE_ACCOUNTS_BASE: &str = "https://api.cloudflare.com/client/v4/accounts";

/// Which per-model fields the frontend consumes (the rest stay Python-only).
type ModelRow = serde_json::Map<String, Value>;

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub env_var: String,
    #[serde(default)]
    pub api_keys: Option<Value>,
}

/// Static per-kind metadata (mirrors providers.py `_PROVIDERS`).
struct Meta {
    env_vars: &'static [&'static str],
    base_url: &'static str,
    /// `models` = OpenAI `/models`, `tags` = ollama `/api/tags`,
    /// `cloudflare_search` = `/ai/models/search`.
    format: &'static str,
    models_url: &'static str,
    models_id_field: &'static str,
    models_query: &'static str,
    /// Google returns `models/<id>`; models.dev keys them bare.
    strip_models_prefix: bool,
    /// Cloud gateways that negotiate a reasoning effort for any model.
    auto_think: bool,
    editable_base_url: bool,
    models_timeout: u64,
}

impl Default for Meta {
    fn default() -> Self {
        Meta {
            env_vars: &[],
            base_url: "",
            format: "openai",
            models_url: "",
            models_id_field: "id",
            models_query: "",
            strip_models_prefix: false,
            auto_think: false,
            editable_base_url: true,
            models_timeout: 10,
        }
    }
}

/// Whether a provider KIND negotiates a reasoning effort for its models
/// (cloud gateways whose catalog mixes reasoning-capable models in). Exposed
/// for the LLM request layer, which gates the reasoning parameter on it
/// exactly like the old Python `auto_think` did.
pub fn auto_think_for(provider: &str) -> bool {
    meta(provider).auto_think
}

fn meta(provider: &str) -> Meta {
    match provider {
        "google" => Meta {
            env_vars: &["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
            base_url: GOOGLE_BASE,
            strip_models_prefix: true,
            ..Default::default()
        },
        "openrouter" => Meta {
            env_vars: &["OPENROUTER_API_KEY"],
            base_url: OPENROUTER_BASE,
            auto_think: true,
            models_timeout: 60,
            ..Default::default()
        },
        "ollama" => Meta {
            base_url: OLLAMA_BASE,
            format: "tags",
            ..Default::default()
        },
        "anthropic" => Meta {
            env_vars: &["ANTHROPIC_API_KEY"],
            ..Default::default()
        },
        "nvidia" => Meta {
            env_vars: &["NVIDIA_API_KEY"],
            base_url: NVIDIA_BASE,
            auto_think: true,
            ..Default::default()
        },
        "cloudflare" => Meta {
            env_vars: &["CLOUDFLARE_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN"],
            base_url: "",
            format: "cloudflare_search",
            models_id_field: "name",
            auto_think: true,
            ..Default::default()
        },
        "tokenrouter" => Meta {
            env_vars: &["TOKEN_ROUTER_API_KEY", "TOKENROUTER_API_KEY"],
            base_url: TOKENROUTER_BASE,
            models_query: "?limit=200",
            auto_think: true,
            ..Default::default()
        },
        _ => Meta::default(),
    }
}

fn is_opencode(base_url: &str) -> bool {
    base_url.contains("opencode.ai")
}

/// `{base}` normalized the same way `llm::normalize_base` does, plus the
/// Anthropic `/v1` strip the models list needs.
fn normalize_base(provider: &str, base_url: &str) -> String {
    crate::llm::normalize_base(provider, base_url)
}

/// Strip a trailing `/v1` so server-level endpoints (`/props`) resolve.
fn server_root(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    match base.strip_suffix("/v1") {
        Some(root) => root.trim_end_matches('/').to_string(),
        None => base.to_string(),
    }
}

fn expand_account(template: &str) -> String {
    // Cloudflare's endpoint is account-scoped: `{account}` comes from the env.
    let account = std::env::var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_default();
    template.replace("{account}", &account)
}

/// (url, format) for a provider's model list.
fn models_endpoint(provider: &str, base_url: &str) -> Result<(String, String), String> {
    let m = meta(provider);
    if !m.models_url.is_empty() {
        return Ok((expand_account(m.models_url), m.format.to_string()));
    }
    if provider == "anthropic" {
        let base = normalize_base(provider, base_url);
        return Ok((format!("{base}/v1/models"), "openai".to_string()));
    }
    if m.format == "tags" {
        // A custom base URL means a non-Ollama OpenAI-compatible server
        // (llama.cpp / LM Studio / vLLM): those list via /v1/models.
        let trimmed = base_url.trim().trim_end_matches('/');
        if provider == "ollama" && !trimmed.is_empty() && trimmed != OLLAMA_BASE {
            let base = normalize_base(provider, base_url);
            return Ok((format!("{base}/models"), "openai".to_string()));
        }
        let base = if trimmed.is_empty() { OLLAMA_BASE } else { trimmed };
        return Ok((format!("{base}/api/tags"), "tags".to_string()));
    }
    if provider == "cloudflare" {
        let base = CLOUDFLARE_ACCOUNTS_BASE.to_string();
        let account = std::env::var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_default();
        return Ok((
            format!("{base}/{account}/ai/models/search"),
            "cloudflare_search".to_string(),
        ));
    }
    let raw = if base_url.trim().is_empty() {
        m.base_url.to_string()
    } else {
        base_url.to_string()
    };
    let base = normalize_base(provider, &raw);
    if base.is_empty() {
        return Err(format!(
            "no base URL configured for provider {provider:?} — set one in Settings → Providers before fetching models"
        ));
    }
    Ok((format!("{base}/models{}", m.models_query), "openai".to_string()))
}

// ---------- /models entry parsing ----------

fn first_int(obj: &Value, keys: &[&str]) -> Option<i64> {
    let map = obj.as_object()?;
    for key in keys {
        let val = map.get(*key)?;
        if val.is_null() {
            continue;
        }
        if let Some(n) = val.as_i64() {
            return Some(n);
        }
        if let Some(n) = val.as_f64() {
            return Some(n as i64);
        }
        if let Some(s) = val.as_str() {
            if let Ok(n) = s.trim().parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

fn first_bool(obj: &Value, keys: &[&str]) -> Option<bool> {
    let map = obj.as_object()?;
    for key in keys {
        if let Some(b) = map.get(*key).and_then(Value::as_bool) {
            return Some(b);
        }
    }
    None
}

fn entry_context(entry: &Value) -> Option<i64> {
    let n = first_int(
        entry,
        &[
            "context_length",
            "max_context_length",
            "context_window",
            "contextWindow",
            "contextLength",
            "max_model_len",
            "context_len",
        ],
    );
    if n.is_some() {
        return n;
    }
    first_int(
        entry.get("capabilities").unwrap_or(&Value::Null),
        &[
            "contextWindow",
            "context_window",
            "contextLength",
            "context_length",
            "max_context_length",
            "maxContext",
            "max_context",
            "context_len",
        ],
    )
}

fn entry_max_output(entry: &Value) -> Option<i64> {
    let n = first_int(
        entry,
        &["max_completion_tokens", "max_output_tokens", "maxOutput", "output_tokens"],
    );
    if n.is_some() {
        return n;
    }
    let caps = first_int(
        entry.get("capabilities").unwrap_or(&Value::Null),
        &[
            "maxOutput",
            "max_output",
            "max_output_tokens",
            "max_completion_tokens",
            "maxCompletionTokens",
            "output_tokens",
        ],
    );
    if caps.is_some() {
        return caps;
    }
    first_int(
        entry.get("top_provider").unwrap_or(&Value::Null),
        &["max_completion_tokens"],
    )
}

/// USD per MILLION tokens (models.dev's unit), normalized from OpenRouter's
/// USD-per-token decimal strings. A price of exactly 0 is kept (free models).
fn entry_pricing(entry: &Value) -> Option<Value> {
    let pricing = entry.get("pricing")?.as_object()?;
    let prompt = pricing.get("prompt")?.as_str().unwrap_or("").trim().to_string();
    let completion = pricing.get("completion")?.as_str().unwrap_or("").trim().to_string();
    if prompt.is_empty() || completion.is_empty() {
        return None;
    }
    let inp: f64 = prompt.parse().ok()?;
    let out: f64 = completion.parse().ok()?;
    let mut map = serde_json::Map::new();
    map.insert("input".into(), json!(inp * 1_000_000.0));
    map.insert("output".into(), json!(out * 1_000_000.0));
    if let Some(cr) = pricing.get("cache_read_input_tokens").and_then(Value::as_str) {
        if let Ok(v) = cr.trim().parse::<f64>() {
            map.insert("cacheRead".into(), json!(v * 1_000_000.0));
        }
    }
    if let Some(cw) = pricing.get("cache_write_input_tokens").and_then(Value::as_str) {
        if let Ok(v) = cw.trim().parse::<f64>() {
            map.insert("cacheWrite".into(), json!(v * 1_000_000.0));
        }
    }
    Some(Value::Object(map))
}

fn entry_reasoning(entry: &Value) -> Option<bool> {
    let flag = first_bool(entry, &["reasoning", "supports_reasoning", "reasoning_supported"]);
    if flag.is_some() {
        return flag;
    }
    first_bool(
        entry.get("capabilities").unwrap_or(&Value::Null),
        &["reasoning", "supports_reasoning"],
    )
}

/// True when a custom gateway aggregates several vendors (ids like
/// `nvidia/…`, `groq/…`) — such a gateway negotiates reasoning upstream, so a
/// silent payload is treated as reasoning-capable.
fn is_multi_vendor_catalog(models: &[ModelRow]) -> bool {
    let mut prefixes = std::collections::HashSet::new();
    for m in models {
        let mid = m.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(idx) = mid.find('/') {
            if idx > 0 {
                prefixes.insert(mid[..idx].to_string());
            }
        }
    }
    prefixes.len() >= 2
}

// ---------- models.dev catalog ----------

fn models_dev_cache() -> &'static Mutex<Option<(Instant, Value)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Fetch (and cache) the models.dev catalog. Never fails: a network blip
/// returns the last good catalog or an empty object, so model listing still
/// works without metadata.
async fn models_dev_catalog(client: &reqwest::Client) -> Value {
    if let Ok(guard) = models_dev_cache().lock() {
        if let Some((at, data)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(MODELS_DEV_CACHE_SECS) {
                return data.clone();
            }
        }
    }
    if let Ok(res) = client
        .get(MODELS_DEV_API)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(data) = res.json::<Value>().await {
                if data.is_object() {
                    if let Ok(mut guard) = models_dev_cache().lock() {
                        *guard = Some((Instant::now(), data.clone()));
                    }
                    return data;
                }
            }
        }
    }
    models_dev_cache()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, d)| d.clone()))
        .unwrap_or_else(|| json!({}))
}

/// models.dev's key for a provider: gateway hosts map to their own catalog id
/// (opencode / cloudflare-workers-ai), everything else uses the kind.
fn models_dev_provider_key(provider: &str, base_url: &str) -> String {
    if is_opencode(base_url) {
        return "opencode".to_string();
    }
    if provider == "cloudflare" {
        return "cloudflare-workers-ai".to_string();
    }
    provider.to_string()
}

/// Normalize a model id to the form models.dev catalogs use.
fn models_dev_id(provider: &str, model_id: &str, base_url: &str) -> String {
    let mid = model_id;
    if meta(provider).strip_models_prefix {
        if let Some(rest) = mid.strip_prefix("models/") {
            return rest.to_string();
        }
    }
    if models_dev_provider_key(provider, base_url) == "opencode" {
        if let Some(rest) = mid.strip_prefix("opencode/") {
            return rest.to_string();
        }
    }
    mid.to_string()
}

/// Catalog keys to try, most specific first (a router gateway also tries the
/// model id's own vendor prefix, e.g. `openai/gpt-4o` → `openai`).
fn models_dev_keys(provider: &str, base_url: &str, model_id: &str) -> Vec<String> {
    let mut keys = vec![models_dev_provider_key(provider, base_url)];
    if let Some((prefix, _)) = model_id.split_once('/') {
        if !prefix.is_empty() && !keys.iter().any(|k| k == prefix) {
            keys.push(prefix.to_string());
        }
    }
    keys
}

/// Look up a model's catalog entry under any of `keys`.
fn models_dev_entry(catalog: &Value, keys: &[String], model_id: &str) -> Option<Value> {
    let lookup = |key: &str, id: &str| -> Option<Value> {
        let entry = catalog.get(key)?.get("models")?.get(id)?;
        if entry.is_null() {
            None
        } else {
            Some(entry.clone())
        }
    };
    for key in keys {
        if let Some(entry) = lookup(key, model_id) {
            return Some(entry);
        }
    }
    // Bare-id fallback: some catalogs key the model without its vendor prefix
    // (e.g. the UI holds `opencode/x` while the catalog stores `x`).
    if let Some(bare) = model_id.rsplit('/').next() {
        if bare != model_id {
            for key in keys {
                if let Some(entry) = lookup(key, bare) {
                    return Some(entry);
                }
            }
        }
    }
    None
}

fn models_dev_limit(catalog: &Value, keys: &[String], model_id: &str, field: &str) -> Option<i64> {
    let entry = models_dev_entry(catalog, keys, model_id)?;
    let val = entry.get("limit")?.get(field)?;
    if val.is_null() {
        return None;
    }
    val.as_i64().or_else(|| val.as_f64().map(|f| f as i64))
}

fn models_dev_reasoning(catalog: &Value, keys: &[String], model_id: &str) -> Option<bool> {
    let entry = models_dev_entry(catalog, keys, model_id)?;
    if let Some(b) = entry.get("reasoning").and_then(Value::as_bool) {
        return Some(b);
    }
    entry
        .get("limit")
        .and_then(|l| l.get("reasoning"))
        .and_then(Value::as_bool)
}

/// models.dev's `cost.*` is already USD per million tokens (no conversion).
fn models_dev_pricing(catalog: &Value, keys: &[String], model_id: &str) -> Option<Value> {
    let entry = models_dev_entry(catalog, keys, model_id)?;
    let cost = entry.get("cost")?;
    let inp = cost.get("input")?.as_f64()?;
    let out = cost.get("output")?.as_f64()?;
    let mut map = serde_json::Map::new();
    map.insert("input".into(), json!(inp));
    map.insert("output".into(), json!(out));
    if let Some(v) = cost.get("cache_read_input").and_then(Value::as_f64) {
        map.insert("cacheRead".into(), json!(v));
    }
    if let Some(v) = cost.get("cache_write_input").and_then(Value::as_f64) {
        map.insert("cacheWrite".into(), json!(v));
    }
    Some(Value::Object(map))
}

/// Real context window + max output for a local ollama model (`/api/show`).
/// The tags list carries neither.
async fn ollama_info(client: &reqwest::Client, base: &str, model_id: &str) -> (Option<i64>, Option<i64>) {
    let mut ctx = None;
    let mut out = None;
    let res = client
        .post(format!("{base}/api/show"))
        .json(&json!({ "model": model_id }))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    let Ok(res) = res else { return (None, None) };
    let Ok(data) = res.json::<Value>().await else {
        return (None, None);
    };
    if let Some(info) = data.get("model_info").and_then(Value::as_object) {
        for (key, val) in info {
            let Some(n) = val.as_i64().or_else(|| val.as_f64().map(|f| f as i64)) else {
                continue;
            };
            if key.ends_with(".context_length") && ctx.is_none() {
                ctx = Some(n);
            } else if key.ends_with(".max_tokens") && out.is_none() {
                out = Some(n);
            }
        }
    }
    // An explicit `num_ctx` override in the parameters block wins.
    match data.get("parameters") {
        Some(Value::String(params)) => {
            for line in params.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 2 && parts[0] == "num_ctx" {
                    if let Ok(n) = parts[1].parse::<i64>() {
                        ctx = Some(n);
                    }
                }
            }
        }
        Some(Value::Object(map)) => {
            if let Some(n) = map.get("num_ctx").and_then(Value::as_i64) {
                ctx = Some(n);
            }
        }
        _ => {}
    }
    (ctx, out)
}

// ---------- GET /models ----------

struct Row {
    id: String,
    context: Option<i64>,
    max_output: Option<i64>,
    pricing: Option<Value>,
    reasoning: Option<bool>,
}

impl Row {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "context": self.context,
            "max_output": self.max_output,
            "pricing": self.pricing,
            "reasoning": self.reasoning,
        })
    }
}

/// 120s per-(provider,url) cache, mirroring providers.py's `_model_cache`.
fn model_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bad_request(detail: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "detail": detail.into() })),
    )
        .into_response()
}

/// GET /models — the provider's model catalog with context / pricing /
/// reasoning, enriched from models.dev.
/// Apply the models.dev catalog to one row.
///
/// This is the FIRST tier of the capacity rule, so a catalog context window is
/// assigned unconditionally: a gateway's own payload is frequently a bogus
/// placeholder (opencode advertises 4k) and trusting it made auto-compaction
/// fire far below the model's real window. The row's existing `context` (the
/// provider's own metadata) survives only when the catalog has no entry.
///
/// Extracted from `list_models` so the precedence is unit-testable without an
/// HTTP harness — the merge order is the entire point of this function.
fn apply_models_dev(row: &mut Row, catalog: &Value, provider: &str, base_url: &str) {
    let dev_id = models_dev_id(provider, &row.id, base_url);
    let dev_keys: Vec<String> = models_dev_keys(provider, base_url, &dev_id)
        .into_iter()
        .collect();
    if let Some(ctx) = models_dev_limit(catalog, &dev_keys, &dev_id, "context") {
        row.context = Some(ctx);
    }
    // These only fill gaps: the provider's own payload already described them.
    if row.max_output.is_none() {
        if let Some(out) = models_dev_limit(catalog, &dev_keys, &dev_id, "output") {
            row.max_output = Some(out);
        }
    }
    if row.pricing.is_none() {
        row.pricing = models_dev_pricing(catalog, &dev_keys, &dev_id);
    }
    if row.reasoning.is_none() {
        row.reasoning = models_dev_reasoning(catalog, &dev_keys, &dev_id);
    }
}

pub async fn list_models(Query(q): Query<ModelsQuery>) -> Response {
    let provider = q.provider.trim().to_string();
    let (url, format) = match models_endpoint(&provider, &q.base_url) {
        Ok(v) => v,
        Err(e) => return bad_request(e),
    };
    let cache_key = format!("{provider}|{url}");
    if let Ok(guard) = model_cache().lock() {
        if let Some((at, data)) = guard.get(&cache_key) {
            if at.elapsed() < Duration::from_secs(MODEL_CACHE_SECS) {
                return Json(json!({ "models": data })).into_response();
            }
        }
    }

    let m = meta(&provider);
    let provider_env = if m.env_vars.is_empty() {
        None
    } else {
        Some(m.env_vars)
    };
    let mut keys = resolve_keys(&provider, &q.api_key, &q.env_var, q.api_keys.as_ref());
    if keys.is_empty() {
        // Provider-specific env chain before giving up (an unauthenticated
        // local endpoint legitimately needs no key).
        let env_fallback = provider_env
            .map(|names| {
                names
                    .iter()
                    .find_map(|n| std::env::var(n).ok().filter(|v| !v.is_empty()))
            })
            .flatten()
            .unwrap_or_default();
        keys.push(env_fallback);
    }
    if keys.is_empty() {
        keys.push(String::new());
    }

    let client = crate::llm::http_client();
    let timeout = Duration::from_secs(m.models_timeout);
    let auth_headers = |key: &str| -> Vec<(String, String)> {
        if provider == "anthropic" {
            vec![
                ("x-api-key".to_string(), key.to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ]
        } else if key.is_empty() {
            Vec::new()
        } else {
            vec![("Authorization".to_string(), format!("Bearer {key}"))]
        }
    };

    let headers = auth_headers(&keys[0]);
    let mut res = match send_list(&client, &url, &headers, timeout).await {
        Ok(r) => r,
        Err(e) => return bad_request(format!("failed to fetch models from {url}: {e}")),
    };
    // A gateway that blocks unknown HTTP clients by User-Agent answers 401 even
    // with a valid credential. Retry with each well-known agent CLI.
    if res.status().as_u16() == 401 && !is_opencode(&q.base_url) {
        for ua in UA_LADDER {
            let mut retry_headers = headers.clone();
            retry_headers.push(("User-Agent".to_string(), ua.to_string()));
            if let Ok(retry) = send_list(&client, &url, &retry_headers, timeout).await {
                if retry.status().as_u16() != 401 {
                    res = retry;
                    break;
                }
            }
        }
    }
    // Top-down key fallback: a dead first key falls through to the next.
    if matches!(res.status().as_u16(), 401 | 403 | 429) && keys.len() > 1 {
        for alt in keys.iter().skip(1) {
            let alt_headers = auth_headers(alt);
            if let Ok(retry) = send_list(&client, &url, &alt_headers, timeout).await {
                if !matches!(retry.status().as_u16(), 401 | 403 | 429) {
                    res = retry;
                    break;
                }
            }
        }
    }
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let cleaned = crate::media::strip_tags(&body);
        return bad_request(format!(
            "failed to fetch models from {url}: {}",
            if cleaned.is_empty() {
                format!("HTTP {}", status.as_u16())
            } else {
                cleaned.chars().take(300).collect()
            }
        ));
    }
    let data: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return bad_request(format!("failed to fetch models from {url}: {e}")),
    };

    let mut rows: Vec<Row> = Vec::new();
    if format == "tags" {
        let base = url.trim_end_matches("/api/tags").to_string();
        let entries = data
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for entry in entries {
            let Some(name) = entry.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) else {
                continue;
            };
            let id = match name.strip_suffix(":latest") {
                Some(rest) => rest.to_string(),
                None => name.to_string(),
            };
            let (ctx, out) = ollama_info(&client, &base, &id).await;
            rows.push(Row {
                id,
                context: ctx,
                max_output: out,
                pricing: None,
                reasoning: None,
            });
        }
    } else {
        let list_key = if format == "cloudflare_search" { "result" } else { "data" };
        let id_field = m.models_id_field;
        let entries = data
            .get(list_key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for entry in &entries {
            let Some(mid) = entry.get(id_field).and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                continue;
            };
            rows.push(Row {
                id: mid.to_string(),
                context: entry_context(entry),
                max_output: entry_max_output(entry),
                pricing: entry_pricing(entry),
                reasoning: entry_reasoning(entry),
            });
        }
        // Capacity rule for the context window: **models.dev → the provider's
        // own metadata → 200k** (the last tier is applied at the bottom of this
        // function). models.dev is the canonical, community-maintained catalog
        // and therefore the FIRST source: a gateway's own payload is often a
        // bogus placeholder (opencode advertises 4k), and trusting it made
        // auto-compaction fire far below the model's real window. So a catalog
        // window ALWAYS overrides the provider's value; the provider's number is
        // kept only when the catalog has no entry for that model.
        let catalog = models_dev_catalog(&client).await;
        if catalog.as_object().is_some_and(|o| !o.is_empty()) {
            for row in rows.iter_mut() {
                apply_models_dev(row, &catalog, &provider, &q.base_url);
            }
        }
        let _ = &m;
        // Cloud gateways negotiate a reasoning effort for any model id, so a
        // silent payload means "reasoning-capable" rather than "no reasoning".
        if meta(&provider).auto_think {
            for row in rows.iter_mut() {
                if row.reasoning.is_none() {
                    row.reasoning = Some(true);
                }
            }
        }
        // A custom gateway aggregating several vendors behaves the same way.
        if provider == "custom" && is_multi_vendor_catalog(&rows.iter().map(row_to_map).collect::<Vec<_>>()) {
            for row in rows.iter_mut() {
                if row.reasoning.is_none() {
                    row.reasoning = Some(true);
                }
            }
        }
        // Local servers (llama.cpp / LM Studio) expose their REAL window
        // directly — resolve it from the server, but only for rows nothing else
        // filled: models.dev and the provider payload both outrank a local probe
        // (neither is reached when this block runs, and a probe can fail).
        if meta(&provider).editable_base_url && rows.iter().any(|r| r.context.is_none()) {
            for row in rows.iter_mut() {
                if row.context.is_none() {
                    if let Some(ctx) = local_model_ctx(&client, &q.base_url, &row.id).await {
                        row.context = Some(ctx);
                    }
                }
            }
        }
    }

    // Tier 3 of the capacity rule: neither models.dev nor the provider reported a
    // window, so assume DEFAULT_CONTEXT_WINDOW (200k). Returning null here used to
    // push a 0 into the renderer's `contextMap`, the renderer then sent
    // `context_window: 0`, and the backend measured auto-compaction against its
    // own guess — the "compacts way before my setting" report.
    for row in rows.iter_mut() {
        if row.context.is_none_or(|c| c <= 0) {
            row.context = Some(crate::agent::DEFAULT_CONTEXT_WINDOW as i64);
        }
    }

    rows.sort_by(|a, b| a.id.cmp(&b.id));
    let out: Vec<Value> = rows.iter().map(|r| r.to_json()).collect();
    if let Ok(mut guard) = model_cache().lock() {
        guard.insert(cache_key, (Instant::now(), Value::Array(out.clone())));
    }
    Json(json!({ "models": out })).into_response()
}

fn row_to_map(row: &Row) -> ModelRow {
    let mut map = ModelRow::new();
    map.insert("id".to_string(), Value::String(row.id.clone()));
    map
}

async fn send_list(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let mut req = client.get(url).timeout(timeout);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req.send().await.map_err(|e| e.to_string())
}

/// Default `n_ctx` from llama.cpp's `/props`, then LM Studio's native API.
async fn local_model_ctx(client: &reqwest::Client, base_url: &str, model_id: &str) -> Option<i64> {
    let root = server_root(base_url);
    if let Ok(res) = client
        .get(format!("{root}/props"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        if let Ok(data) = res.json::<Value>().await {
            if let Some(n) = data
                .get("default_generation_settings")
                .and_then(|s| s.get("n_ctx"))
                .and_then(Value::as_i64)
            {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    let ctx_keys = ["context_length", "max_seq_len", "n_ctx"];
    let extract = |mut obj: Value| -> Option<i64> {
        if let Some(inner) = obj.get("data").cloned() {
            if inner.is_object() {
                obj = inner;
            }
        }
        if let Some(n) = first_int(&obj, &ctx_keys) {
            return Some(n);
        }
        first_int(obj.get("model_info").unwrap_or(&Value::Null), &ctx_keys)
    };
    if !model_id.is_empty() {
        if let Ok(res) = client
            .get(format!("{root}/api/v1/model"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(data) = res.json::<Value>().await {
                    if let Some(n) = extract(data) {
                        if n > 0 {
                            return Some(n);
                        }
                    }
                }
            }
        }
    }
    if let Ok(res) = client
        .get(format!("{root}/api/v1/models"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(data) = res.json::<Value>().await {
                let mut models = data.get("data").cloned().unwrap_or(Value::Null);
                if !models.is_array() {
                    models = Value::Array(vec![models]);
                }
                for m in models.as_array().cloned().unwrap_or_default() {
                    if !model_id.is_empty()
                        && m.get("id").and_then(Value::as_str) != Some(model_id)
                        && m.get("model_key").and_then(Value::as_str) != Some(model_id)
                    {
                        continue;
                    }
                    if let Some(n) = extract(m) {
                        if n > 0 {
                            return Some(n);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_prefers_provider_fields_then_capabilities() {
        let entry = json!({"context_length": 128000});
        assert_eq!(entry_context(&entry), Some(128000));
        let nested = json!({"capabilities": {"contextWindow": 200000}});
        assert_eq!(entry_context(&nested), Some(200000));
        assert_eq!(entry_context(&json!({})), None);
    }

    #[test]
    fn pricing_normalizes_to_usd_per_million() {
        let entry = json!({"pricing": {"prompt": "0.0000008", "completion": "0.000002"}});
        let out = entry_pricing(&entry).unwrap();
        let inp = out["input"].as_f64().unwrap();
        assert!((inp - 0.8).abs() < 1e-9, "got {inp}");
    }

    #[test]
    fn multi_vendor_detection_counts_prefixes() {
        let rows = vec![
            row("nvidia/llama"),
            row("groq/llama"),
            row("gemini/flash"),
        ];
        assert!(is_multi_vendor_catalog(&rows));
        assert!(!is_multi_vendor_catalog(&vec![row("llama3"), row("qwen2.5")]));
    }

    fn row(id: &str) -> ModelRow {
        let mut m = ModelRow::new();
        m.insert("id".to_string(), Value::String(id.to_string()));
        m
    }

    #[test]
    fn google_and_opencode_ids_are_normalized_for_the_catalog() {
        assert_eq!(models_dev_id("google", "models/gemini-2.5-flash", ""), "gemini-2.5-flash");
        assert_eq!(
            models_dev_id("custom", "opencode/deepseek-v4-flash-free", "https://opencode.ai/x"),
            "deepseek-v4-flash-free"
        );
        assert_eq!(models_dev_id("nvidia", "nvidia/llama", ""), "nvidia/llama");
    }

    /// Tier 1 of the capacity rule: models.dev WINS over the provider's own
    /// payload, even when the provider reports a different (smaller) number.
    ///
    /// This is the regression lock for the "it compacts way before my setting"
    /// report: trusting a gateway's placeholder window (opencode advertises 4k)
    /// made auto-compaction fire at a fraction of the model's real window. The
    /// provider value must only survive when the catalog has no entry at all.
    #[test]
    fn models_dev_context_wins_over_the_provider_payload() {
        let catalog = json!({
            "openai": {
                "models": {
                    "gpt-4o": { "limit": { "context": 128_000, "output": 16_384 } }
                }
            }
        });

        // Provider payload said 4000 (a placeholder); the catalog says 128k.
        let mut provider_says_4k = Row {
            id: "gpt-4o".into(),
            context: Some(4_000),
            max_output: Some(4_096),
            pricing: None,
            reasoning: None,
        };
        apply_models_dev(&mut provider_says_4k, &catalog, "openai", "");
        assert_eq!(
            provider_says_4k.context,
            Some(128_000),
            "the catalog window must override the provider's placeholder"
        );
        // max_output only fills a gap — the provider already knew its own.
        assert_eq!(provider_says_4k.max_output, Some(4_096));

        // No provider value at all: the catalog still fills it.
        let mut provider_says_nothing = Row {
            id: "gpt-4o".into(),
            context: None,
            max_output: None,
            pricing: None,
            reasoning: None,
        };
        apply_models_dev(&mut provider_says_nothing, &catalog, "openai", "");
        assert_eq!(provider_says_nothing.context, Some(128_000));
        assert_eq!(provider_says_nothing.max_output, Some(16_384));

        // A model the catalog does not know keeps the provider's number (tier 2).
        let mut unknown_to_catalog = Row {
            id: "some-proprietary-model".into(),
            context: Some(200_000),
            max_output: None,
            pricing: None,
            reasoning: None,
        };
        apply_models_dev(&mut unknown_to_catalog, &catalog, "openai", "");
        assert_eq!(
            unknown_to_catalog.context,
            Some(200_000),
            "without a catalog entry the provider's own value must survive"
        );
    }

    /// The provider-prefixed catalog key must be found too: NVIDIA-style
    /// gateways report `nvidia/<model>` while the catalog stores the bare id
    /// under the `nvidia` key (see `models_dev_keys`).
    #[test]
    fn models_dev_context_resolves_provider_prefixed_ids() {
        let catalog = json!({
            "nvidia": {
                "models": { "deepseek-v3": { "limit": { "context": 163_840 } } }
            }
        });
        let mut row = Row {
            id: "deepseek-ai/deepseek-v3".into(),
            context: Some(8_192),
            max_output: None,
            pricing: None,
            reasoning: None,
        };
        apply_models_dev(&mut row, &catalog, "nvidia", "https://integrate.api.nvidia.com/v1");
        assert_eq!(
            row.context,
            Some(163_840),
            "the prefixed id must resolve to the catalog entry, not fall through"
        );
    }
}
