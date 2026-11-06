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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

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

/// Resolve the reasoning trio (`reasoning_level`, `model_reasoning`,
/// `auto_think`) for a call. `level` is the UI thinking level for this slot —
/// empty means "inherit the main model's level", in which case the caller
/// passes the main level instead. `auto_think` is derived from the provider
/// KIND so no caller has to remember the gateway list.
///
/// Returns `(reasoning_level, model_reasoning, auto_think)` ready to spread
/// into an `LlmConfig` literal.
pub fn reasoning_fields(
    provider_kind: &str,
    level: &str,
    model_reasoning: bool,
) -> (String, bool, bool) {
    (
        level.trim().to_string(),
        model_reasoning,
        crate::models::auto_think_for(provider_kind),
    )
}

/// The level a call may actually send: the level itself when a SOURCE
/// enumerated it for this model, otherwise nothing.
///
/// `None` means no source described the model, and a level nobody described is a
/// guess about the wire — the composer never offers one, so a stored level from
/// before the model changed (or one picked for a different model in Settings)
/// must not be sent either. `"none"` and `""` both mean "no reasoning
/// parameter", so neither needs a token to be legal.
pub fn level_from_source(allowed: Option<&[String]>, level: &str) -> String {
    let level = level.trim();
    if level.is_empty() || level == "none" {
        return String::new();
    }
    // `max` and `xhigh` are one option in the UI, so either spelling counts.
    let wanted = if level == "max" { "xhigh" } else { level };
    match allowed {
        Some(levels) if levels.iter().any(|l| l == wanted) => level.to_string(),
        _ => String::new(),
    }
}

/// Map a UI thinking level to the OpenAI-standard `reasoning_effort` token.
/// Returns None when reasoning is off or the level is unknown.
///
/// The token is passed through verbatim: the composer only ever offers levels a
/// SOURCE enumerated for the model (its `/models` payload or models.dev), so a
/// level that cannot be guessed never reaches this function. Collapsing `xhigh`
/// onto `high` here is what made an enumerated gateway answer 400.
pub fn reasoning_effort_for(level: &str) -> Option<&'static str> {
    match level.trim() {
        "none" => None,
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("xhigh"),
        // "minimal" is a valid OpenAI token but not exposed in the UI today.
        _ => None,
    }
}

/// Like `reasoning_effort_for`, but the level is only sent when the KIND has an
/// effort wire at all. Budget providers (Anthropic / Google) carry their scale
/// in a token budget instead, so they return None here.
///
/// Every token is passed through verbatim: the level reaching this function was
/// enumerated by a source for that model (see `models::resolve_thinking_levels`),
/// so renaming it would send a token the gateway never offered.
///
/// The UI exposes ONE top option ("Max", stored as `xhigh`); the legacy `max`
/// value is an exact alias, so BOTH fold to `xhigh` — a stored `max` and a
/// stored `xhigh` must never produce different requests.
pub fn reasoning_effort_for_kind(kind: &str, level: &str) -> Option<&'static str> {
    match kind {
        "anthropic" | "google" => None,
        _ => reasoning_effort_for(level),
    }
}

/// Map a UI thinking level to a Google Gemini `thinkingBudget` (in tokens).
/// Returns None when reasoning is off. Mirrors the Python `google_thinking`
/// table (low=4096, medium=12288, high=32768) plus the UI-only top levels.
pub fn thinking_budget_for(level: &str) -> Option<u32> {
    match level.trim() {
        "minimal" => Some(1024),
        "low" => Some(4096),
        "medium" => Some(12288),
        "high" => Some(32768),
        "xhigh" | "max" => Some(32768),
        _ => None,
    }
}

/// Anthropic's own thinking-budget table, in tokens.
///
/// Anthropic requires `max_tokens` to stay strictly ABOVE `budget_tokens`,
/// which is why this table is smaller than Google's — and why the old flat
/// `budget.min(2048)` was a bug: it collapsed Low / Medium / High / Max onto
/// the exact same request, so the slider changed nothing on the wire.
pub fn anthropic_budget_for(level: &str) -> Option<u32> {
    match level.trim() {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(4096),
        "high" => Some(8192),
        "xhigh" | "max" => Some(16384),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Multimodal (images)
// ---------------------------------------------------------------------------

/// Neutral image block the agent attaches to a message:
/// `{"type":"image","data_url":"data:image/png;base64,..."}`.
///
/// The agent never picks a provider shape: the three endpoints disagree about
/// how an inline image looks, so the translation lives here, right before the
/// bytes go on the wire.
pub const IMAGE_BLOCK_TYPE: &str = "image";

/// Split `data:<mime>;base64,<payload>` into `(mime, payload)`.
fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some((mime, payload))
}

/// Provider-specific wire shape of one inline image.
fn image_part(kind: &str, data_url: &str) -> Option<Value> {
    // A malformed / truncated data URL is dropped instead of poisoning the
    // whole request: the text of the turn still gets through.
    let (mime, payload) = split_data_url(data_url).or_else(|| {
        // Bare base64 (a caller that already stripped the prefix).
        if data_url.starts_with("data:") || data_url.len() < 32 {
            None
        } else {
            Some(("image/png", data_url))
        }
    })?;
    Some(match kind {
        // Anthropic takes raw base64 + a media type, never a data URL.
        "anthropic" => json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": payload },
        }),
        // Gemini inlines the bytes under `inlineData` (camelCase, like the
        // `generationConfig` / `thinkingBudget` keys this file already writes).
        "google" => json!({ "inlineData": { "mimeType": mime, "data": payload } }),
        // OpenAI-compatible endpoints take the data URL verbatim.
        _ => json!({ "type": "image_url", "image_url": { "url": data_url } }),
    })
}

/// Rewrite one message's content for `kind`. String content passes through
/// untouched (the common case); an array of neutral blocks keeps its text
/// blocks and has its image blocks translated.
fn map_content(kind: &str, content: &Value) -> Value {
    let Value::Array(blocks) = content else {
        return content.clone();
    };
    let mut out: Vec<Value> = Vec::with_capacity(blocks.len());
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some(IMAGE_BLOCK_TYPE) => {
                if let Some(part) = b
                    .get("data_url")
                    .and_then(Value::as_str)
                    .and_then(|u| image_part(kind, u))
                {
                    out.push(part);
                }
            }
            _ => out.push(b.clone()),
        }
    }
    Value::Array(out)
}

/// Map every message of a request body to the provider's own content shape.
fn map_messages(kind: &str, messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let mut m = m.clone();
            m["content"] = map_content(kind, &m["content"]);
            m
        })
        .collect()
}

/// Whether a reasoning param should be sent at all: the model must be
/// explicitly reasoning-capable OR the gateway kind auto-thinks, and the
/// level must map to something (i.e. not empty / "none"). Mirrors the old
/// Python `_thinking_kwargs` gate. Kind-aware so gateways that accept
/// `xhigh` keep it while OpenAI-family endpoints get the collapsed token.
fn reasoning_active(cfg: &LlmConfig) -> Option<&'static str> {
    if !(cfg.auto_think || cfg.model_reasoning) {
        return None;
    }
    reasoning_effort_for_kind(&cfg.provider, &cfg.reasoning_level)
}

/// The `reasoning_effort` token Google's OpenAI-compatible endpoint accepts.
///
/// It knows the standard `minimal`/`low`/`medium`/`high` tokens and REJECTS
/// `xhigh` (the UI's one top level, stored as either `xhigh` or `max`), so the
/// top level folds onto `high` here. The native endpoint keeps using its
/// token-budget table instead (see [`thinking_budget_for`]).
fn google_compat_effort(level: &str) -> Option<&'static str> {
    match level.trim() {
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" => Some("high"),
        _ => None,
    }
}

/// Inject the reasoning parameter into a request body: `reasoning_effort`
/// for OpenAI-compatible kinds (including Google's compat endpoint),
/// `generationConfig.thinkingBudget` for Google's NATIVE shape, and
/// `thinking.budget_tokens` for Anthropic. No-op when reasoning is off or the
/// model/gateway isn't reasoning-capable.
///
/// `google_native` picks the Google wire shape: streaming chat uses the
/// OpenAI-compatible endpoint (which 400s on `generationConfig`), while the
/// one-shot title/compact/vision calls keep the native `generateContent` body.
fn apply_reasoning(cfg: &LlmConfig, body: &mut Value, google_native: bool) {
    if !(cfg.auto_think || cfg.model_reasoning) {
        return;
    }
    match cfg.provider.as_str() {
        "anthropic" => {
            // Anthropic needs `max_tokens` strictly ABOVE `budget_tokens`, so
            // the budget comes from Anthropic's own table and the cap is only
            // ever RAISED to fit it. Capping the budget instead (the old
            // `budget.min(2048)`) made every level above Low identical.
            if let Some(budget) = anthropic_budget_for(&cfg.reasoning_level) {
                let max_tokens = cfg.max_tokens.unwrap_or(4096).max(budget + 1024);
                body["max_tokens"] = json!(max_tokens);
                body["thinking"] = json!({
                    "type": "enabled",
                    "budget_tokens": budget,
                });
            }
        }
        "google" if google_native => {
            if let Some(budget) = thinking_budget_for(&cfg.reasoning_level) {
                // Preserve any generationConfig already set (e.g. maxOutputTokens).
                match body.get_mut("generationConfig").and_then(Value::as_object_mut) {
                    Some(obj) => {
                        obj.insert(
                            "thinkingConfig".into(),
                            json!({ "thinkingBudget": budget }),
                        );
                    }
                    None => {
                        body["generationConfig"] =
                            json!({ "thinkingConfig": { "thinkingBudget": budget } });
                    }
                }
            }
        }
        "google" => {
            // OpenAI-compatible wire: the native `generationConfig` is an
            // unknown field here and fails the whole request with a 400.
            if let Some(effort) = google_compat_effort(&cfg.reasoning_level) {
                body["reasoning_effort"] = json!(effort);
            }
        }
        _ => {
            if let Some(effort) = reasoning_active(cfg) {
                body["reasoning_effort"] = json!(effort);
            }
        }
    }
}

/// Build the wire body for a streaming chat call. A free function on purpose:
/// the four `serde_json` shapes below are the one place where a provider-facing
/// mistake is silent (the provider just returns 400), so they have to be unit
/// testable — the async `stream_with_key` around them is not.
fn build_request_body(cfg: &LlmConfig, messages: &[Value], tools: Option<&[Value]>) -> Value {
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
                .map(|m| {
                    let mut m = m.clone();
                    m["content"] = map_content("anthropic", &m["content"]);
                    m
                })
                .collect::<Vec<_>>());
            body["stream"] = json!(true);
        }
        // Google streams through its OpenAI-compatible endpoint (see
        // `gemini_openai_api`). The native shape this arm used to build has no
        // `tools` field, so the model was told to call tools that were never
        // declared and answered with `MALFORMED_FUNCTION_CALL`. Its compat
        // endpoint speaks the exact OpenAI message/tool shape built below —
        // images included (`image_url`, never Gemini's `inlineData`).
        _ => {
            let google = cfg.provider == "google";
            body["model"] = json!(if google {
                google_model_name(&cfg.model)
            } else {
                cfg.model.as_str()
            });
            body["stream"] = json!(true);
            body["messages"] = json!(map_messages(
                if google { "openai" } else { cfg.provider.as_str() },
                messages
            ));
            if let Some(t) = cfg.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = json!(mt);
            }
            if let Some(t) = tools {
                body["tools"] = json!(t);
            }
            // Opt into usage reporting on the stream. This is the OpenAI
            // standard way to ask; without it most OpenAI-compatible gateways
            // omit `usage` from EVERY frame (NVIDIA NIM and the gateways behind
            // it), so a call that really billed tokens arrived with none and
            // the Model-usage panel showed a flat zero. Measured against NIM:
            // 0 of 25 frames carried `usage` without this field, exactly one
            // did with it. A gateway that rejects the field instead of
            // ignoring it gets one retry without it (`stream_with_key`).
            // Google rejects unknown extras (incl. stream_options) with a 400,
            // so only OpenAI-compatible receivers get the field — its absence
            // there just costs one retry via `stream_with_key`.
            if !google {
                body["stream_options"] = json!({ "include_usage": true });
            }
            // Ask the model to emit INDEPENDENT tool calls in ONE assistant
            // message instead of serialising one call per round trip.
            //
            // MEASURED (trace `mvxsy14e`, 59 rows): 16 of 19 rounds carried a
            // single call while the model demonstrably COULD have batched — the
            // same turn opened with three 2-call rounds. Prompt guidance alone
            // (the system prompt's "BATCH EVERYTHING ALREADY DETERMINED") did
            // not hold, because the OpenAI-compatible protocol DEFAULT here is
            // provider-defined and several gateways serialise unless told
            // otherwise. Every extra round re-sends the whole conversation, so
            // one call per round is the single largest wire-token cost. This
            // flag is the protocol-level twin of that prompt rule.
            //
            // Sent only where the wire format defines it (the tool-carrying
            // OpenAI-compatible arm); a server that rejects the field gets one
            // retry without it, exactly like `stream_options`.
            if tools.is_some_and(|t| !t.is_empty()) {
                body["parallel_tool_calls"] = json!(true);
            }
        }
    }
    apply_prompt_cache(cfg, &mut body);
    // Streaming chat: Google speaks the compat wire (no generationConfig).
    apply_reasoning(cfg, &mut body, false);
    body
}

/// Anthropic explicit prompt caching.
///
/// Every round-trip of a turn resends the SAME system prompt and the same tool
/// array, and each round only appends a few messages to the end. Without a
/// cache marker the provider re-bills that whole prefix on every call: a 20-step
/// turn pays for the ~2-8 KB system prompt and the ~5 KB tool array twenty
/// times. Marking the stable prefix `ephemeral` lets the provider reuse it and
/// bill only the delta.
///
/// Only the `anthropic` arm takes `cache_control` — the OpenAI-compatible and
/// Google arms either cache their prefix automatically or would reject an
/// unknown field, so this is a strict no-op for them.
fn apply_prompt_cache(cfg: &LlmConfig, body: &mut Value) {
    if cfg.provider != "anthropic" {
        return;
    }
    const EPHEMERAL: &str = "ephemeral";
    // 1) The system prompt: the most stable and highest-value block. Anthropic
    //    takes it as a plain string, which cannot carry a marker — wrap it in a
    //    one-block array (the array form is what the API accepts markers on).
    if let Some(sys) = body.get("system").and_then(Value::as_str) {
        let sys = sys.to_string();
        body["system"] = json!([{
            "type": "text",
            "text": sys,
            "cache_control": { "type": EPHEMERAL },
        }]);
    }
    // 2) The tool array (absent on this arm today, but kept correct so a future
    //    Anthropic tool conversion gets the cache for free).
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        if let Some(last) = tools.last_mut() {
            last["cache_control"] = json!({ "type": EPHEMERAL });
        }
    }
    // 3) The last message: everything up to and including it is the prefix the
    //    NEXT round-trip will resend, so this is what makes the cache grow with
    //    the turn instead of being re-bought each round.
    if let Some(msgs) = body.get_mut("messages").and_then(Value::as_array_mut) {
        if let Some(last) = msgs.last_mut() {
            cache_last_content(last);
        }
    }
}

/// Attach `cache_control` to a message's trailing content. A string content is
/// promoted to a one-block array, because only blocks can carry the marker.
/// Returns without touching anything when the content is neither a string nor
/// an array (a tool-call-only message), which is not a cache-able prefix anyway.
fn cache_last_content(msg: &mut Value) {
    let marked = match msg.get("content") {
        Some(Value::String(text)) => json!([{
            "type": "text",
            "text": text,
            "cache_control": { "type": "ephemeral" },
        }]),
        Some(Value::Array(blocks)) => {
            let mut blocks = blocks.clone();
            if let Some(last) = blocks.last_mut() {
                last["cache_control"] = json!({ "type": "ephemeral" });
            }
            Value::Array(blocks)
        }
        _ => return,
    };
    msg["content"] = marked;
}

pub struct LlmResult {
    pub text: String,
    pub usage: Option<Value>,
}

/// Sentinel meaning "no practical timeout" for `LlmConfig::timeout_secs`.
/// reqwest requires a concrete duration, so this is 24 hours — long enough
/// that a chat turn is never cut off while the provider is still answering,
/// however slow it is (the user's explicit requirement).
pub const NO_TIMEOUT_SECS: u64 = 24 * 60 * 60;

/// Wait this long for the provider to start answering (response headers).
/// A user-visible error after N seconds is NEVER wanted: some providers and
/// large reasoning models legitimately take many minutes — even half an hour —
/// before the first byte, and cutting that off surfaced as a bogus "provider
/// did not respond" error while the model was still thinking. This budget is
/// 24 hours precisely so it never fires in practice; a genuinely dead
/// connection still aborts through the transport's own TCP errors, and the
/// user can always hit Stop (the cancel flag is checked every step).
pub const HEADER_TIMEOUT_SECS_DEFAULT: u64 = 24 * 60 * 60;

/// Abort a stream after this much TOTAL silence (not a pause between chunks —
/// total, since the last byte of any kind). A long thinking pause is not a
/// failure, so this is far above any legitimate gap, but it is finite on
/// purpose: a provider that answers HTTP 200 and then keeps the socket open with
/// keep-alive chatter and never sends an event or EOF would otherwise hang the
/// turn forever, with no error and a Stop button that has nothing to cancel.
/// Override with `CODIFA_STREAM_IDLE_SECS`.
pub const IDLE_TIMEOUT_SECS_DEFAULT: u64 = 600;

/// Wait this long for a STREAMING request to flush its response headers
/// before giving up and reporting an error. This bounds ONLY the connect+
/// TTFB phase, never the answer: headers carry no payload, so a provider
/// that has them ready will return them in seconds. The SSE idle guard
/// below arms only AFTER the headers arrive, so without this ceiling a
/// black-holed connection (sleep/wake, NAT rebinding — days of silent TCP
/// retransmit with NO transport error) parks a headless run at "running"
/// forever: no trace row, no log line, no timeout anywhere in the chain.
/// Override with `CODIFA_HEADER_WAIT_SECS`.
pub const HEADER_WAIT_SECS_DEFAULT: u64 = 60;

/// Resolve the stream idle budget, allowing an env override for long-running
/// local models that emit nothing while they compute.
fn stream_idle_secs() -> u64 {
    std::env::var("CODIFA_STREAM_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(IDLE_TIMEOUT_SECS_DEFAULT)
}

/// Resolve the wait for a streaming request's response HEADERS. Headers carry
/// no answer payload, so this can be far tighter than the idle budget: a
/// provider that accepts the request but cannot flush headers within this
/// budget has a dead connection (sleep/wake black-hole), not a slow model.
/// Override with `CODIFA_HEADER_WAIT_SECS`.
fn header_wait_secs() -> u64 {
    std::env::var("CODIFA_HEADER_WAIT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(HEADER_WAIT_SECS_DEFAULT)
}

/// The process-wide provider HTTP client.
///
/// Built ONCE. reqwest owns the connection pool and the TLS session cache, so a
/// fresh client per call forced a new TCP handshake AND a new TLS handshake for
/// every single request: every tool-slot call (title / compact / vision), every
/// step of a turn and every retried key paid for it. One client still talks to
/// however many providers are configured — the pool is keyed by origin.
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Shared provider HTTP client (no proxy, like the sidecar). Cloning is cheap:
/// the handle is reference-counted and shares the pool.
pub fn http_client() -> Client {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .connect_timeout(std::time::Duration::from_secs(15))
                // TCP keepalive is NOT a deadline on the model: a slow-but-connected
                // provider keeps answering the probes and is never cut off. It only lets
                // the OS notice a half-open connection (VPN/proxy switch, a gateway that
                // died without a FIN) and surface a transport error, which the retry
                // path then handles. Without it such a socket stayed silent forever.
                .tcp_keepalive(Some(std::time::Duration::from_secs(30)))
                // Hold idle sockets open between steps and turns so a follow-up
                // call reuses the established connection instead of re-dialing.
                // The idle cap MUST stay below the SERVER's own keep-alive
                // window (node's http server closes idle sockets after ~5s,
                // nginx after 75s): a reused socket the server already closed
                // is a black hole — the request is written into the void and
                // sits until the header budget expires. Measured on the local
                // 9router gateway: the first turn after a pause paid a ~50s
                // dead wait, then the retry on a fresh connection answered in
                // 4s. Re-dialing costs ~0ms on a localhost gateway, so a short
                // idle window keeps the reuse benefit and never hands a request
                // a corpse. 4s sits strictly BELOW node's default
                // keepAliveTimeout (5s) — the 9router gateway closes idle
                // sockets there, and a socket idle 5-8s was still being reused
                // and hung.
                .pool_idle_timeout(std::time::Duration::from_secs(4))
                .pool_max_idle_per_host(4)
                .build()
                .expect("reqwest client")
        })
        .clone()
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

/// Gemini's native root: the configured base with a trailing `/openai` (the
/// OpenAI-compat suffix the old Google default carried) or `/v1beta` removed,
/// so `{root}/v1beta/models/…` is the same URL whichever way the base was
/// written. A path prefix in front of those suffixes (`https://proxy/gemini/v1beta`)
/// survives, which is what lets the same code drive a Gemini-compatible gateway.
pub fn gemini_native_root(base: &str) -> String {
    let mut root = base.trim().trim_end_matches('/').to_string();
    // `/openai` first: the legacy default ends in `/v1beta/openai`.
    for suffix in ["/openai", "/v1beta"] {
        if let Some(head) = root.strip_suffix(suffix) {
            root = head.trim_end_matches('/').to_string();
        }
    }
    root
}

/// Gemini's native API prefix — `{gemini_native_root}/v1beta` — which every
/// native call (`:generateContent`, `:predictLongRunning`, operations) hangs
/// off. Chat and the media tools must agree on it, so the saved base URL can
/// stay the OpenAI-compat one (`…/v1beta/openai`) while both wire shapes still
/// resolve to `…/v1beta/models/…`.
pub fn gemini_native_api(base: &str) -> String {
    format!("{}/v1beta", gemini_native_root(base))
}

/// Gemini's OpenAI-compatible API prefix (`{root}/v1beta/openai`).
///
/// Chat streams through this endpoint instead of the native
/// `streamGenerateContent` shape. The native body has no `tools` field in this
/// client, while the system prompt tells the model to call `load_skill`,
/// `use_mcp`, `read`, … — so Gemini tried to emit function calls nobody had
/// declared and ended the turn with `finishReason: MALFORMED_FUNCTION_CALL`.
/// Google's compat endpoint takes the SAME OpenAI messages/tools this agent
/// loop already speaks, returns real tool-call ids and Gemini 3 thought
/// signatures, and is maintained by Google. It is the same URL the saved
/// Google base already carries (`…/v1beta/openai`), normalized here so a root
/// base works too.
pub fn gemini_openai_api(base: &str) -> String {
    format!("{}/v1beta/openai", gemini_native_root(base))
}

/// The bare model id every Gemini URL path expects.
///
/// Google's own `/v1beta/models` listing (and older saved selections) hands
/// out ids prefixed `models/` (`models/gemini-flash-latest`), while every URL
/// builder already interpolates into a literal `models/…` segment — the verbatim
/// id produced `…/v1beta/models/models/gemini-flash-latest:generateContent`,
/// a 404 with an EMPTY body, so every Google call failed without saying why.
/// Stripping any number of leading `models/` segments (and stray slashes) here
/// makes chat, one-shot and media URLs agree whatever spelling was saved —
/// the same normalization `models.rs` already applies for the catalog lookup.
pub fn google_model_name(model: &str) -> &str {
    let mut name = model.trim();
    loop {
        if let Some(rest) = name.strip_prefix("models/") {
            name = rest;
        } else if let Some(rest) = name.strip_prefix('/') {
            name = rest;
        } else {
            return name;
        }
    }
}

/// Resolve the chat-completions endpoint + auth header style for a kind.
/// Returns (url, header_name, header_value_prefix). An empty header_name
/// means "send no auth header" — the keyless local-endpoint case.
fn endpoint_and_auth(cfg: &LlmConfig, key: &str) -> (String, &'static str, String) {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    // Use the key of THIS attempt, not always the first one: the caller's
    // key-fallback loop retried a key the provider had just rejected, so a
    // rejected first key failed the whole call instead of falling through.
    let key = if key.is_empty() {
        cfg.api_keys.first().cloned().unwrap_or_default()
    } else {
        key.to_string()
    };
    let (url, header_name, header_value) = match cfg.provider.as_str() {
        "anthropic" => (
            format!("{base}/v1/messages"),
            "x-api-key",
            key.clone(),
        ),
        // Native shape: the saved base may carry the OpenAI-compat suffix
        // (`…/v1beta/openai`), and appending `/v1beta` to THAT produced
        // `…/v1beta/openai/v1beta/models/…` — a 404 for every Google chat call.
        // The root is normalized so both spellings of the base resolve here.
        "google" => (
            format!(
                "{}/models/{model}:generateContent",
                gemini_native_api(&cfg.base_url),
                model = google_model_name(&cfg.model)
            ),
            "x-goog-api-key",
            key.clone(),
        ),
        // OpenAI-compatible kinds (openrouter/ollama/custom/nvidia/...)
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    };
    // An EMPTY key is "no credential" (a keyless local endpoint): send no auth
    // header at all — a bare `Bearer ` is a malformed credential some servers
    // reject, and the model-list path (models.rs `auth_headers`) omits the
    // header for the same reason. The caller skips a header with an empty NAME.
    if key.is_empty() {
        return (url, "", String::new());
    }
    (url, header_name, header_value)
}

/// The provider telling us the MODEL's upstream endpoint is gone.
///
/// The status code cannot be trusted for this one: a gateway may carry it on a
/// 429 (observed body: `Upstream request failed: Endpoint is unavailable.` with
/// `"code":"rate_limit_exceeded"`), which reads like "come back later" and
/// keeps a model that cannot serve the request at all. The body names the
/// failure, so the body decides.
const UPSTREAM_DOWN: [&str; 8] = [
    "upstream request failed",
    "endpoint is unavailable",
    "endpoint unavailable",
    "no available endpoint",
    "upstream is unavailable",
    // LiteLLM-style routers answer "No ready deployment" / "No deployments
    // available for selected model" when every backend of a model is down. The
    // model itself cannot serve us, so the next rung must take the call instead
    // of the same dead model being retried for the whole budget.
    "no ready deployment",
    "no healthy deployment",
    "no deployment",
];

/// Whether a provider response says the model's upstream endpoint is down.
fn upstream_is_down(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    UPSTREAM_DOWN.iter().any(|needle| t.contains(needle))
}

fn is_key_error(status: u16, body: &str) -> bool {
    // A dead upstream endpoint is not a key problem: walking the key list would
    // only repeat the same doomed call with every configured key. Returning
    // `false` fails immediately and hands the raw provider error upward, where
    // it is classified as a model-side failure and the next configured model
    // gets the call.
    if upstream_is_down(body) {
        return false;
    }
    matches!(status, 401 | 402 | 403 | 429)
        || body.to_ascii_lowercase().contains("invalid api key")
        || body.to_ascii_lowercase().contains("unauthorized")
        || body.to_ascii_lowercase().contains("quota")
}

/// An error body that always SAYS something. A rejected request can come back
/// with a status and no body at all (a Google 404 for a malformed model path
/// is empty) — surfacing the bare string then read as `failed: ` with nothing
/// after it, and the user saw a failure with no reason. The synthetic text is
/// status-only, so it cannot flip `is_key_error` or `upstream_is_down`.
fn nonempty_error_body(status: u16, text: String) -> String {
    if text.trim().is_empty() {
        format!("HTTP {status} (empty body)")
    } else {
        text
    }
}

// ---------- per-key cooldowns ----------
//
// Free-tier keys recover on their own: the quota resets (a minute, an hour, a
// day later) and the SAME key works again. The key ladder itself has no
// memory, so while one key sits exhausted every request still pays a doomed
// attempt on it before reaching the next one. Marking a rejected key cold for
// a while removes that tax, and the key rejoins the ladder once the window
// passes — the "test the dead key again later" behavior a rotating pool of
// free keys needs.

/// Process-global registry: key string → the Instant its cooldown expires.
/// In memory only (the key already lives in the config structs); never
/// persisted, never logged.
static KEY_COOLDOWNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn cooldowns() -> &'static Mutex<HashMap<String, Instant>> {
    KEY_COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the map, recovering from a poisoned lock: a panic in one thread must
/// not take key rotation down with it.
fn cooldown_lock() -> MutexGuard<'static, HashMap<String, Instant>> {
    cooldowns().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How long a rejected key sits out. The default is HOURS because the common
/// death on a rotating pool of free-tier keys is a daily cap: re-probing every
/// few minutes only buys each dead key a doomed attempt per probe, while a
/// multi-hour bench makes it nearly free until its quota day rolls over. The
/// price is that a merely RATE-LIMITED key (a 429 that a minute of waiting
/// would fix) also sits out the window — acceptable while other keys carry
/// the load, and moot when every key is cooling (they all run anyway).
/// `CODIFA_KEY_COOLDOWN_SECS` overrides it (a tiny value ≈ the old
/// always-retry-first behavior).
fn key_cooldown() -> Duration {
    const DEFAULT_SECS: u64 = 4 * 60 * 60;
    let secs = std::env::var("CODIFA_KEY_COOLDOWN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SECS);
    Duration::from_secs(secs.max(1))
}

/// A key the provider just refused on a key error: off the ladder until the
/// cooldown expires. A second refusal while still cold RE-ARMS the window
/// (it failed again, so its clock restarts).
fn mark_key_dead(key: &str) {
    cooldown_lock().insert(key.to_string(), Instant::now() + key_cooldown());
}

/// A key that just served a successful call: drop any cooldown it earned
/// earlier, so a key whose quota came back early is used again at once.
fn mark_key_ok(key: &str) {
    cooldown_lock().remove(key);
}

fn key_is_cooling(key: &str, now: Instant) -> bool {
    cooldown_lock()
        .get(key)
        .map_or(false, |until| *until > now)
}

/// The ladder order for one request: keys NOT on cooldown first (the user's
/// own order preserved), then the cooling ones as a last resort — a request
/// must not die with "all keys rejected" while one of the cold keys may have
/// recovered early. When EVERY key is cooling the original order runs
/// unchanged, so an all-cold request attempts the same keys it always did.
fn key_attempt_order(keys: &[String]) -> Vec<String> {
    let now = Instant::now();
    let mut live = Vec::new();
    let mut cold = Vec::new();
    for key in keys {
        if key_is_cooling(key, now) {
            cold.push(key.clone());
        } else {
            live.push(key.clone());
        }
    }
    if live.is_empty() {
        keys.to_vec()
    } else {
        live.extend(cold);
        live
    }
}

/// Whether a rejected request is complaining about the optional
/// `stream_options` field specifically.
///
/// Some strict OpenAI-compatible servers reject an unknown field instead of
/// ignoring it. That is not a broken model — dropping the field still gets the
/// answer, only the token accounting is lost — so the request is retried once
/// without it rather than failing the step.
fn rejects_stream_options(status: u16, body: &str) -> bool {
    status == 400 && body.to_ascii_lowercase().contains("stream_options")
}

/// Whether a gateway refused `parallel_tool_calls` as an unknown field.
///
/// Same contract as [`rejects_stream_options`]: a strict OpenAI-compatible
/// server can 400 on the field instead of ignoring it. Dropping it only costs
/// the batching hint the model would have got — the answer is still served — so
/// the request is retried once without it rather than failing the step.
fn rejects_parallel_tool_calls(status: u16, body: &str) -> bool {
    status == 400 && body.to_ascii_lowercase().contains("parallel_tool_calls")
}

/// Whether a failed model call means "THIS model cannot serve us", i.e. the only
/// case where trying the next configured fallback is the right move.
///
/// The rule is deliberately narrow. A fallback is an escape hatch for a model
/// that does not work — NOT a retry for the network. Only a provider REJECTING
/// the request in a way another model could fix qualifies:
///
/// * the key or account is refused (401 / 402 / 403, "invalid api key",
///   "forbidden", "insufficient credit", "permission denied");
/// * the provider does not serve this model ("model not found", "unknown
///   model", "not supported", "does not exist");
/// * the provider's upstream endpoint for the model is unavailable — some
///   gateways report that on a 429, so [`upstream_is_down`] is checked BEFORE
///   the rate-limit gate and the body wins over the status;
/// * the account's allowance for the model is EXHAUSTED ("usage limit
///   reached", `insufficient_quota`) — also checked BEFORE the rate-limit gate,
///   because a 429 carrying it means "this will never answer", not "come back
///   later";
/// * the model answered with nothing usable (an empty summary/title/description)
///   — the model itself is not working, which is not a transport problem.
///
/// Everything else stays on the SAME model: a dropped connection, a timeout, a
/// 5xx, a genuine 429/rate limit (one that does not name a broken endpoint), an
/// idle stream or a user abort. Falling back there
/// would spend the user's whole fallback list on a provider hiccup, hide the
/// real reason behind the last rung's error, and pay for calls that could never
/// have succeeded.
pub fn should_fall_back(err: &str) -> bool {
    let e = err.trim().to_ascii_lowercase();
    if e.is_empty() {
        return false;
    }
    // Transport-level first. A gateway body can contain "invalid" or "model" by
    // accident, so these must never reach the model needles below.
    const TRANSPORT: [&str; 13] = [
        "no response within",
        "no data for",
        "aborted by user",
        "error sending request",
        "connect",
        "timed out",
        "timeout",
        "dns",
        "tls",
        "broken pipe",
        "reset by peer",
        "incomplete message",
        "unexpected eof",
    ];
    if TRANSPORT.iter().any(|needle| e.contains(needle)) {
        return false;
    }
    // Checked BEFORE the rate-limit gate: a gateway can carry "this model's
    // endpoint is gone" on a 429, and that status alone would read as "come
    // back later" and keep the broken model for the rest of the attempts.
    if upstream_is_down(&e) {
        return true;
    }
    // An EXHAUSTED allowance is not "come back later". The account or the model
    // has no quota left and no number of repeats will change that, while the
    // next configured model may live on an entirely different account. The
    // observed body is opencode's `FreeUsageLimitError` ("Free usage limit
    // reached. Subscribe to OpenCode Go to keep going") carried on a 429: the
    // rate-limit gate below reads that as a temporary hiccup, keeps the same
    // model and leaves the user's whole fallback list unused.
    const EXHAUSTED: [&str; 5] = [
        "usage limit",
        "insufficient_quota",
        "exceeded your current quota",
        "quota has been exceeded",
        "credit balance",
    ];
    if EXHAUSTED.iter().any(|needle| e.contains(needle)) {
        return true;
    }
    // The provider asking us to come back later is not a broken model: retrying
    // the SAME model is exactly right, so a genuine 429 must never consume a
    // fallback.
    if e.contains("rate limit") || e.contains("429") || e.contains("too many requests") {
        return false;
    }
    // "key rejected (NNN): …" carries the status. 401/402/403 mean the account
    // or key is refused; anything else that reached this branch is a request
    // problem, not a model problem.
    if let Some(rest) = e.split("key rejected (").nth(1) {
        let status: u16 = rest
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        return matches!(status, 401 | 402 | 403);
    }
    // A model that answered with nothing usable is not working either.
    if e.contains("returned an empty summary")
        || e.contains("returned an empty title")
        || e.contains("returned an empty description")
        || e.contains("empty model response")
        || e.contains("returned no content")
    {
        return true;
    }
    const REJECTED: [&str; 20] = [
        "invalid api key",
        "incorrect api key",
        "invalid_api_key",
        "api key not valid",
        "no api key configured",
        // A gateway that holds no credential for its own UPSTREAM can never
        // serve this model — asking again is pure waste, so it must fall
        // through to the next rung. (Observed from a 9router gateway:
        // "No active credentials for provider: openrouter" on every `oc/*`
        // model. The message is the GATEWAY's, not ours — we only classify it.)
        "credential",
        "unauthorized",
        "unauthenticated",
        "authentication",
        "model not found",
        "model_not_found",
        "unknown model",
        "no such model",
        "not a valid model",
        "does not exist",
        "forbidden",
        "permission",
        "insufficient",
        "no credit",
        "not supported",
    ];
    if REJECTED.iter().any(|needle| e.contains(needle)) {
        return true;
    }
    // "model `gpt-x` not found" / "model `gpt-x` is unavailable": the model NAME
    // sits between the two halves, so no single substring can ever match. Pair
    // the halves instead — every provider words this one differently, but they
    // all name the model AND say it is missing.
    let names_a_model = e.contains("model");
    let says_missing = [
        "not found",
        "not available",
        "unavailable",
        "unknown",
        "invalid",
        "unsupported",
        "rejected",
    ]
    .iter()
    .any(|needle| e.contains(needle));
    names_a_model && says_missing
}

/// Kinds that may be called with NO api key at all: the `ollama` kind (the
/// local OpenAI-compatible servers — Ollama, llama.cpp, LM Studio) and any
/// `custom` base_url, which is how every localhost gateway (vLLM, a proxy) is
/// wired. For these a keyless attempt is the RULE, not an error: the model
/// list (models.rs `auth_headers`) and the sidecar probe (backend_light.rs)
/// already send an empty key to exactly such endpoints. Cloud kinds keep the
/// up-front refusal — spending a network round trip to learn a key is missing
/// tells the user far less than "no api key configured".
fn kind_allows_keyless(kind: &str) -> bool {
    matches!(kind, "ollama" | "custom")
}

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
fn one_shot_body(cfg: &LlmConfig, system: &str, user: &str, images: &[String]) -> Value {
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

async fn complete_with_key(
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

/// One provider usage payload, normalized to ONE vocabulary.
///
/// The two conventions a usage object can follow, told apart by the fields the
/// payload itself carries (never by the provider's NAME — a custom gateway that
/// speaks Anthropic's wire format is caught by its shape):
///
/// - **Additive** (Anthropic and Anthropic-compatible endpoints): the cache
///   fields sit BESIDE `input_tokens`, so the input the provider actually
///   processed is `input + cache_read + cache_creation`.
/// - **Subset** (OpenAI / DeepSeek / Google / OpenAI-compatible gateways): the
///   reported input ALREADY covers the cached part
///   (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`,
///   `cachedContentTokenCount`), so adding it would double-count.
///
/// `input_total` is the one inclusive number every consumer wants: the
/// compaction trigger's baseline, the context meter and the cost math all
/// treat input as "everything the model read this call".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NormalizedUsage {
    /// Inclusive billed input (see the type doc).
    pub input_total: u64,
    pub output_tokens: u64,
    /// The reported cache read, 0 when absent.
    pub cache_read: u64,
    /// The reported cache write (Anthropic `cache_creation_input_tokens`), 0
    /// when absent — OpenAI-style payloads have no such field.
    pub cache_write: u64,
    /// The payload carried a cache-read field at all. "Unknown" (a gateway
    /// that reports nothing) must stay distinguishable from a REAL zero (the
    /// cache genuinely missed), or the ruler's hit rate lies.
    pub cache_read_reported: bool,
    pub cache_write_reported: bool,
    /// The provider's own input number, BEFORE normalization — exclusive for
    /// additive payloads. Kept for consumers that echo the raw figure.
    pub reported_input: u64,
}

impl NormalizedUsage {
    /// `None` when the payload is not an object or carries no recognizable
    /// input field at all.
    pub fn from_payload(u: &Value) -> Option<NormalizedUsage> {
        let obj = u.as_object()?;
        let num = |keys: &[&str]| -> Option<u64> {
            keys.iter()
                .find_map(|k| obj.get(*k).and_then(Value::as_u64))
        };
        let output =
            num(&["output_tokens", "completion_tokens", "candidatesTokenCount"]).unwrap_or(0);
        // ADDITIVE shape: the Anthropic cache fields beside the input.
        let a_read = obj.get("cache_read_input_tokens").and_then(Value::as_u64);
        let a_write = obj
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64);
        if a_read.is_some() || a_write.is_some() {
            let input = num(&["input_tokens", "prompt_tokens"]).unwrap_or(0);
            let read = a_read.unwrap_or(0);
            let write = a_write.unwrap_or(0);
            return Some(NormalizedUsage {
                input_total: input + read + write,
                output_tokens: output,
                cache_read: read,
                cache_write: write,
                cache_read_reported: a_read.is_some(),
                cache_write_reported: a_write.is_some(),
                reported_input: input,
            });
        }
        // SUBSET shape: the reported input already includes the cached part.
        let input = num(&["prompt_tokens", "input_tokens", "promptTokenCount"])?;
        let read_direct = num(&[
            "prompt_cache_hit_tokens",
            "cached_tokens",
            "cachedContentTokenCount",
        ]);
        let read_nested = obj
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64);
        let read = read_direct.or(read_nested).unwrap_or(0);
        Some(NormalizedUsage {
            input_total: input,
            output_tokens: output,
            cache_read: read,
            cache_write: 0,
            cache_read_reported: read_direct.is_some() || read_nested.is_some(),
            cache_write_reported: false,
            reported_input: input,
        })
    }
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
    /// Provider failure carried INSIDE the stream: an `error`/`detail` object on
    /// an HTTP 200 response. The read loop cannot raise it as an `Err` the moment
    /// it arrives without discarding the text already streamed, so it is latched
    /// here and promoted to a real error by [`finish_stream`] once it closes.
    pub error: Option<String>,
    /// Bytes of REASONING ("thinking") content seen so far. The reasoning text
    /// itself is deliberately never streamed — rendering it token by token made
    /// the UI crawl — but its arrival has to be observable, otherwise the pill
    /// can only ever say "Working" while the model is clearly thinking. Counting
    /// it here lets the read loop detect a reasoning-only payload without
    /// sniffing the raw JSON.
    pub reasoning_len: usize,
    /// Raise counter of the interrupt signal when this stream started reading.
    /// The stream treats the signal as "mine" ONLY when its generation is now
    /// greater than this stamp, so a raise meant for an earlier window (already
    /// consumed, or landing before this request) can never cancel a request the
    /// user never steered. Together with `interrupted` this is what makes a
    /// mid-turn steer deterministic instead of a coin flip.
    pub interrupt_base: u64,
    /// True when the stream was dropped early because a mid-turn steer landed.
    /// The agent loop then re-issues the same step with the steer appended
    /// instead of waiting for a model answer the user already superseded.
    pub interrupted: bool,
}

/// One live signal from a streaming model call.
///
/// Text and the reasoning state travel through ONE callback on purpose: the
/// agent loop hands `stream_chat` a single closure, because two closures would
/// both need a mutable borrow of its event emitter at the same time.
pub enum StreamSignal<'a> {
    /// A text delta to append to the assistant bubble.
    Text(&'a str),
    /// The model started (`true`) or stopped (`false`) producing reasoning
    /// content. Only the state change is reported, never the reasoning text.
    Thinking(bool),
}

/// Callback fired for every live stream signal.
pub type SignalSink<'a> = &'a mut (dyn FnMut(StreamSignal<'_>) + Send + 'a);

/// Event-driven "drop this stream now" signal for mid-turn steers.
///
/// The steer inbox is only read BETWEEN model calls, so a steer typed while a
/// request was already streaming had to wait for that whole request to finish —
/// exactly the reported "steer behaves like a queued message". `push_steer`
/// raises this signal and the read loop below selects on it, so the in-flight
/// request is dropped at once and re-issued with the steer appended.
///
/// There is deliberately no timer anywhere in this path: a raise is an event, so
/// detection is instant, and a merely slow model is never mistaken for failure.
#[derive(Debug, Default)]
pub struct InterruptSignal {
    /// Monotonic raise counter.
    ///
    /// A plain bool is NOT enough here. A stream only learns about a raise when
    /// its read loop is parked on `wait()`, so a raise that lands while no
    /// stream is parked (the moment between two model calls, when the agent is
    /// executing a tool, or in the gap right after the previous stream was
    /// dropped) used to be either swallowed by `reset()` or consumed by the
    /// WRONG iteration — the reported "sometimes the steer goes through, and
    /// sometimes it just waits for the whole turn". Counting raises lets each
    /// stream spot exactly the raises that happened AFTER it started, so a raise
    /// is never lost and never mis-attributed.
    generation: AtomicU64,
    notify: Notify,
}

impl InterruptSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Raise the signal and wake an in-flight stream waiting on it.
    /// Returns the new generation (the stamp a consuming stream compares to).
    pub fn raise(&self) -> u64 {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify.notify_waiters();
        gen
    }

    /// The raise counter as it stands now. A stream captures this BEFORE it
    /// starts reading and treats any larger value as "a steer landed on me".
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// True when a raise happened after `since`.
    pub fn interrupted_since(&self, since: u64) -> bool {
        self.generation() > since
    }

    /// Resolve once the counter is greater than `since` (immediately when it
    /// already is), then return the value it reached.
    pub async fn wait_for(&self, since: u64) -> u64 {
        loop {
            // Register interest BEFORE re-checking the counter: a raise landing
            // between the check and the wait would otherwise be lost forever.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let now = self.generation();
            if now > since {
                return now;
            }
            notified.await;
        }
    }
}

/// Message carried by a provider error object. Failures do not all arrive with a
/// non-2xx status, and every provider words them differently, so the shape — not
/// the provider name — decides: OpenAI-style `{"error": {"message": …}}`, a plain
/// `{"error": "…"}`, FastAPI-style `{"detail": "…"}`, Anthropic's
/// `{"type": "error", "message": …}` frame, and Google's message-less
/// `{"error": {"code": …, "status": "…"}}`.
pub(crate) fn provider_error_message(v: &Value) -> Option<String> {
    let err = &v["error"];
    // Anthropic reports a mid-stream failure as `{"type":"error","message":…}`:
    // there is no `error` object at all. The top-level `message` is read ONLY
    // when the body declares itself an error envelope, so a healthy delta (which
    // carries `type` too, but never `message`) cannot be mistaken for a failure.
    let envelope = (v["type"].as_str() == Some("error"))
        .then(|| v["message"].as_str())
        .flatten();
    let named = err["message"]
        .as_str()
        .or_else(|| err["detail"].as_str())
        .or_else(|| err["type"].as_str())
        .or_else(|| err.as_str())
        .or_else(|| v["detail"].as_str())
        .or(envelope);
    let msg = match named {
        Some(m) => m.trim().to_string(),
        // Google sends no message at all — the status/code pair is the whole
        // reason, and without it the failure would read as an empty answer.
        None => match (
            err["status"].as_str().unwrap_or_default().trim(),
            err["code"].as_i64(),
        ) {
            ("", None) => return None,
            ("", Some(code)) => format!("error code {code}"),
            (status, None) => status.to_string(),
            (status, Some(code)) => format!("{status} (code {code})"),
        },
    };
    (!msg.is_empty()).then(|| msg.to_string())
}

/// Span of the next SSE event terminator in `buf`, as `(start, end)`.
///
/// The SSE spec ends an event with a blank line, and the line ending may be
/// LF, CRLF or CR. Splitting only on `"\n\n"` silently skipped every frame of
/// a CRLF stream — Google's native `streamGenerateContent` endpoint sends
/// CRLF, so the whole Gemini answer arrived, was never parsed, and the turn
/// ended at EOF with an empty accumulator (`returned no content — the
/// provider closed the stream without finishing`).
fn sse_frame_end(buf: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for terminator in ["\r\n\r\n", "\n\n", "\r\r"] {
        if let Some(start) = buf.find(terminator) {
            let end = start + terminator.len();
            // The EARLIEST terminator closes this frame; the longest spelling
            // wins an exact tie so a CRLF pair is never read as two CR frames.
            best = Some(match best {
                Some((b, e)) if b < start || (b == start && e >= end) => (b, e),
                _ => (start, end),
            });
        }
    }
    best
}

/// Parse one SSE `data:` payload into accumulator updates, forwarding text
/// deltas to `on_delta` as they arrive. Returns true when the payload ends the
/// read loop: the `[DONE]` marker, or an error frame — whose reason is latched
/// into [`StreamAcc::error`] for [`finish_stream`] to raise.
fn apply_sse_payload(
    provider: &str,
    payload: &str,
    acc: &mut StreamAcc,
    on_delta: &mut dyn FnMut(&str),
) -> bool {
    let payload = payload.trim();
    if payload == "[DONE]" {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return false;
    };
    // The request failed even though the transport did not. Reading on would
    // hang on a provider that holds the socket open, and ignoring the frame is
    // what made a dead model look like a silent success.
    if let Some(msg) = provider_error_message(&v) {
        acc.error = Some(msg);
        return true;
    }
    match provider {
        "anthropic" => {
            match v["type"].as_str() {
                Some("content_block_delta") => {
                    if v["delta"]["type"].as_str() == Some("thinking_delta") {
                        // Extended thinking: the reasoning text is measured, not
                        // streamed — the UI only needs to know it is happening.
                        if let Some(t) = v["delta"]["thinking"].as_str() {
                            acc.reasoning_len += t.len();
                        }
                    } else if let Some(t) = v["delta"]["text"].as_str() {
                        if latch_content_error(acc, t) {
                            return true;
                        }
                        acc.text.push_str(t);
                        on_delta(t);
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
        _ => {
            let choice = &v["choices"][0];
            // Reasoning deltas: providers name them differently (OpenRouter and
            // DeepSeek: `reasoning`; several gateways: `reasoning_content`;
            // Anthropic-compatible shims: `thinking`). They are measured, never
            // streamed: forwarding the reasoning text token by token slowed the
            // UI to a crawl, so only the arrival of reasoning is signalled.
            if let Some(r) = choice["delta"]["reasoning"]
                .as_str()
                .or_else(|| choice["delta"]["reasoning_content"].as_str())
                .or_else(|| choice["delta"]["thinking"].as_str())
            {
                acc.reasoning_len += r.len();
            }
            if let Some(t) = choice["delta"]["content"].as_str() {
                if latch_content_error(acc, t) {
                    return true;
                }
                acc.text.push_str(t);
                on_delta(t);
            }
            if let Some(tcs) = choice["delta"]["tool_calls"].as_array() {
                for tc in tcs {
                    // Deterministic slot target. OpenAI always sends `index`;
                    // when a provider omits it, a delta that OPENS a call (it
                    // carries an id or a name) gets its own slot instead of
                    // being merged into slot 0 — the old `unwrap_or(0)` folded
                    // every streamed call into the first one and left the rest
                    // nameless, which surfaced as `unknown tool ""`.
                    let idx = match tc["index"].as_u64() {
                        Some(i) => i as usize,
                        None => {
                            let opens_new = tc["id"].as_str().is_some()
                                || tc["function"]["name"]
                                    .as_str()
                                    .map(|n| !n.is_empty())
                                    .unwrap_or(false);
                            if opens_new || acc.tool_calls.is_empty() {
                                acc.tool_calls.len()
                            } else {
                                acc.tool_calls.len() - 1
                            }
                        }
                    };
                    // Every slot is a structurally complete call, never a bare
                    // `{}`: reading `tc["function"]["name"]` off an empty object
                    // produced `""`, which the dispatch guard reported as
                    // `unknown tool ""` and burned a whole round-trip.
                    while acc.tool_calls.len() <= idx {
                        acc.tool_calls
                            .push(json!({"function": {"name": "", "arguments": ""}}));
                    }
                    let slot = &mut acc.tool_calls[idx];
                    if let Some(id) = tc["id"].as_str() {
                        slot["id"] = json!(id);
                    }
                    // Never let an EMPTY name overwrite a good one. Some
                    // providers stream the name once and then send `"name":""`
                    // on every following delta; the blind overwrite erased it,
                    // so the call reached the dispatch guard as `unknown tool ""`
                    // and burned a whole round-trip re-issuing it.
                    if let Some(name) = tc["function"]["name"].as_str() {
                        if !name.is_empty() {
                            slot["function"]["name"] = json!(name);
                        }
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        let cur = slot["function"]["arguments"].as_str().unwrap_or_default();
                        slot["function"]["arguments"] = json!(format!("{cur}{args}"));
                    }
                    // Google's OpenAI-compatible endpoint returns Gemini's
                    // thought signature beside every tool call under
                    // `extra_content.google.thought_signature`. It is REQUIRED
                    // on the next round: replaying the assistant tool call
                    // without it is rejected with HTTP 400 ("Function call is
                    // missing a thought_signature"). Keep the whole provider-
                    // namespaced object, not the one field, so another gateway
                    // with its own extra data is covered too.
                    if !tc["extra_content"].is_null() {
                        slot["extra_content"] = tc["extra_content"].clone();
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

/// Promote a finished stream to a real error when it produced nothing usable.
///
/// A provider does not have to fail on the transport to fail the request: it can
/// answer 200 and then close the socket, or close a stream that only ever
/// carried reasoning. Both used to end the turn as a silent success — an empty
/// bubble, no banner, nothing logged — which is exactly what a model that cannot
/// serve the request looked like from the outside. Every other case keeps the
/// streamed text.
fn finish_stream(provider: &str, acc: StreamAcc) -> Result<StreamAcc, (u16, String)> {
    if let Some(msg) = acc.error.as_deref() {
        return Err((
            0u16,
            format!("{provider} reported an error mid-stream: {msg}"),
        ));
    }
    // A mid-turn steer drops this request on purpose: the agent loop re-issues
    // the step with the steer appended, so an empty accumulator is the expected
    // outcome here and not a failure.
    if acc.interrupted {
        return Ok(acc);
    }
    // A 200 stream whose whole CONTENT is a billing/auth refusal (Pollinations
    // does this for a drained account): zero usage plus the wording. Without
    // this the turn "succeeds" and the refusal is stored as the assistant's
    // answer, while the model test — which only checks non-empty — shows a
    // green tick. Tool calls are exempt: a model may discuss billing and then
    // call a tool.
    if acc.tool_calls.is_empty() && usage_is_zero(acc.usage.as_ref()) {
        if let Some(msg) = content_error_message(&acc.text) {
            return Err((0u16, format!("{provider} refused the request: {msg}")));
        }
    }
    if !acc.text.trim().is_empty() || !acc.tool_calls.is_empty() {
        return Ok(acc);
    }
    let ending = if acc.finish_reason.is_empty() {
        "the provider closed the stream without finishing".to_string()
    } else {
        format!("the stream finished with '{}'", acc.finish_reason)
    };
    if acc.reasoning_len > 0 {
        return Err((
            0u16,
            format!(
                "{provider} returned no content after streaming reasoning — {ending} \
                 (the thinking block may have used the whole budget)"
            ),
        ));
    }
    Err((0u16, format!("{provider} returned no content — {ending}")))
}

/// Resolves once the Stop flag is raised; never resolves when there is no flag.
///
/// This is a poll of the user's own cancel request, not a deadline on the
/// model: it lets Stop win while the request is parked waiting for response
/// headers or for the next chunk (the plain flag check below only runs AFTER a
/// chunk arrives, so a silent provider made Stop a no-op).
async fn wait_cancel(cancel: Option<&std::sync::atomic::AtomicBool>) {
    match cancel {
        Some(c) => {
            while !c.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// Stream one chat completion, invoking `on_delta` for every text chunk.
/// Returns the accumulated result (text, tool_calls, finish_reason, usage).
pub async fn stream_chat(
    client: &Client,
    cfg: &LlmConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    on_event: SignalSink<'_>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    steer_interrupt: Option<&InterruptSignal>,
) -> Result<StreamAcc, (u16, String)> {
    if cfg.api_keys.is_empty() && !kind_allows_keyless(&cfg.provider) {
        return Err((0, "no api key configured".into()));
    }
    // A keyless local endpoint runs ONE attempt with an empty key (no auth
    // header); cloud kinds never reach this with an empty list.
    let empty_key = [String::new()];
    let attempts: &[String] = if cfg.api_keys.is_empty() { &empty_key } else { &cfg.api_keys };
    // Build the payload ONCE (it is key-independent): the previous code rebuilt
    // and re-cloned the whole message array — base64 images included — for every
    // API-key attempt.
    let body = build_request_body(cfg, messages, tools);
    let mut last_err = String::new();
    for key in key_attempt_order(attempts) {
        match stream_with_key(client, cfg, &key, &body, on_event, cancel, steer_interrupt)
            .await
        {
            Ok(acc) => {
                mark_key_ok(&key);
                return Ok(acc);
            }
            Err((status, body)) if is_key_error(status, &body) => {
                mark_key_dead(&key);
                last_err = format!("key rejected ({status}): {body}");
                continue;
            }
            // Keep the real status: the headless caller (the scheduler) prefixes
            // "upstream HTTP {status}" onto the body so the run record names the
            // failure. Zeroing it here made a 429/500 indistinguishable from a
            // transport drop.
            Err((status, body)) => return Err((status, body)),
        }
    }
    Err((0, last_err))
}

async fn stream_with_key(
    client: &Client,
    cfg: &LlmConfig,
    key: &str,
    body: &Value,
    on_event: SignalSink<'_>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    steer_interrupt: Option<&InterruptSignal>,
) -> Result<StreamAcc, (u16, String)> {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    let (url, header_name, header_value) = match cfg.provider.as_str() {
        "anthropic" => (format!("{base}/v1/messages"), "x-api-key", key.to_string()),
        // Google's OpenAI-compatible endpoint: standard messages + tools, so
        // the agent loop's advertised schemas actually reach the model. The
        // native streaming shape cannot express them (see
        // `gemini_openai_api`), and its absence caused MALFORMED_FUNCTION_CALL.
        "google" => (
            format!("{}/chat/completions", gemini_openai_api(&cfg.base_url)),
            "Authorization",
            format!("Bearer {key}"),
        ),
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    };
    // An EMPTY key is "no credential" (a keyless local endpoint): send no auth
    // header at all — the same rule `endpoint_and_auth` applies for one-shot
    // calls. The caller skips a header with an empty NAME.
    let (header_name, header_value): (&'static str, String) = if key.is_empty() {
        ("", String::new())
    } else {
        (header_name, header_value)
    };

    // Set only after a gateway refused a field, and each strip is applied to
    // what was ACTUALLY sent last. Two independent `Option`s picked with `or`
    // were wrong the moment a server rejected both: the more-stripped copy lost
    // and the request looped back with the field it just rejected. Cumulative
    // and capped, so a strict gateway always converges on a body it accepts.
    let mut retry_body: Option<Value> = None;
    let mut retries_left: u8 = 2;
    // Bound ONLY the wait for the response headers — never the answer. After a
    // sleep/wake or a NAT rebinding a dead connection can sit in TCP
    // retransmit for tens of minutes reporting NO error, which defeats the
    // "the transport surfaces a dead connection instantly" assumption below;
    // the SSE idle guard only arms AFTER `break resp`, so a headless run
    // parked right here forever: trace silent, log silent, run row stuck at
    // "running". A provider that cannot flush HEADERS within this budget will
    // not answer either; the env override covers an exotic queued gateway.
    let header_wait = std::time::Duration::from_secs(header_wait_secs());
    let resp = loop {
        let send_body = retry_body.as_ref().unwrap_or(body);
        let mut req = client.post(&url).json(send_body);
        // The row's own header list goes FIRST, and the key-derived auth header
        // is skipped when the row already spells that name out — reqwest
        // appends instead of replacing, so sending both would duplicate it.
        for (name, value) in &cfg.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        if !header_name.is_empty() && !has_header(&cfg.headers, header_name) {
            req = req.header(header_name, header_value.as_str());
        }
        if cfg.provider == "anthropic" && !has_header(&cfg.headers, "anthropic-version") {
            req = req.header("anthropic-version", "2023-06-01");
        }
        let resp = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Err((0u16, "aborted by user".into())),
            _ = tokio::time::sleep(header_wait) => {
                return Err((
                    0u16,
                    format!(
                        "provider sent no response headers within {}s (connection black-holed; raise CODIFA_HEADER_WAIT_SECS if your gateway is slower)",
                        header_wait_secs()
                    ),
                ))
            }
            r = req.send() => r.map_err(|e| (0u16, e.to_string()))?,
        };
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            break resp;
        }
        let text = resp.text().await.unwrap_or_default();
        // Both fields below are OPTIONAL niceties: dropping one still gets the
        // answer. Strip whichever the gateway named, cumulatively, and retry —
        // but only twice, because a third rejection is a real error.
        let reject_stream = rejects_stream_options(status, &text);
        let reject_parallel = rejects_parallel_tool_calls(status, &text);
        if retries_left > 0 && (reject_stream || reject_parallel) {
            let mut stripped = send_body.clone();
            let mut changed = false;
            if let Some(obj) = stripped.as_object_mut() {
                if reject_stream && obj.remove("stream_options").is_some() {
                    changed = true;
                }
                if reject_parallel && obj.remove("parallel_tool_calls").is_some() {
                    changed = true;
                }
            }
            if changed {
                retries_left -= 1;
                retry_body = Some(stripped);
                continue;
            }
        }
        return Err((status, nonempty_error_body(status, text)));
    };

    let mut acc = StreamAcc::default();
    // Stamp this request with the signal's current generation: only a raise that
    // happens AFTER this point is meant for THIS stream. Without the stamp a
    // raise landing between two requests was consumed by the next one (or lost),
    // which is why a mid-turn steer only went through sometimes.
    if let Some(sig) = steer_interrupt {
        acc.interrupt_base = sig.generation();
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // Live thinking state, reported only on a REAL transition: a payload that
    // carries neither reasoning nor text (usage / role deltas) must not flicker
    // the pill off and on.
    let mut thinking_on = false;
    use futures_util::StreamExt;
    // Idle timeout: a stalled provider stream (no DATA for this long) must abort
    // the turn with a clear error instead of hanging it forever. Deliberately
    // generous, because some providers stay silent for many minutes while a
    // large model thinks before the first token, and cutting that off looked
    // like "the model errored after 60 seconds". It is still finite on purpose:
    // a provider that answers 200 and then keeps the socket open with keep-alive
    // comments, never sending an event or EOF, would otherwise hang the turn with
    // no error at all. The deadline is refreshed only by a real SSE `data:`
    // frame, so keep-alive chatter cannot keep a dead stream alive; an aborted
    // connection still surfaces instantly as a transport `Err`.
    let idle_secs = stream_idle_secs();
    let mut idle_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(idle_secs);
    loop {
        // Stop button: the cancel flag is checked on every chunk read, so a
        // running stream (including one inside an explore sub-agent) aborts
        // immediately instead of finishing the whole model call first.
        if let Some(c) = cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                return Err((0u16, "aborted by user".into()));
            }
        }
        // A mid-turn steer drops this request instantly instead of letting the
        // model finish an answer the user already superseded. `biased` makes the
        // interrupt win every tie, so a steer is never delayed by a ready chunk.
        // Stop and a mid-turn steer are both EVENTS raced against the next chunk,
        // so neither waits for a silent provider to speak first.
        let chunk = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Err((0u16, "aborted by user".into())),
            _ = async {
                match steer_interrupt {
                    Some(sig) => sig.wait_for(acc.interrupt_base).await,
                    None => std::future::pending::<u64>().await,
                }
            } => {
                acc.interrupted = true;
                return finish_stream(&cfg.provider, acc);
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                return Err((
                    0u16,
                    format!("provider stream sent no data for {idle_secs}s"),
                ));
            }
            next = stream.next() => next,
        };
        let chunk = match chunk {
            Some(chunk) => chunk.map_err(|e| (0u16, e.to_string()))?,
            None => break,
        };
        let before_text = acc.text.len();
        let before_reasoning = acc.reasoning_len;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line; the terminator may be LF,
        // CRLF (Gemini) or CR. `lines()` strips a trailing `\r`, and the
        // explicit replace also handles a CR-only stream.
        while let Some((_, end)) = sse_frame_end(&buf) {
            let frame: String = buf.drain(..end).collect();
            for line in frame.replace('\r', "\n").lines() {
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.strip_prefix(' ').unwrap_or(payload);
                // The parser keeps its text-only sink; this thin adapter is
                // what lets the caller receive BOTH kinds of signal from one
                // closure (and keeps the parser's unit tests untouched).
                // A real frame is progress: push the idle deadline out.
                idle_deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_secs(idle_secs);
                let mut text_sink = |t: &str| on_event(StreamSignal::Text(t));
                // A terminal frame — the `[DONE]` marker or a stream error:
                // either way this step's outcome is decided here.
                if apply_sse_payload(&cfg.provider, payload, &mut acc, &mut text_sink) {
                    return finish_stream(&cfg.provider, acc);
                }
            }
        }
        if acc.reasoning_len > before_reasoning && !thinking_on {
            thinking_on = true;
            on_event(StreamSignal::Thinking(true));
        }
        if acc.text.len() > before_text && thinking_on {
            thinking_on = false;
            on_event(StreamSignal::Thinking(false));
        }
    }
    // The last frame may close without its trailing blank line (some gateways
    // end the socket right after the payload). Parse whatever is left so the
    // final text/reasoning chunk is not lost; a truncated JSON frame simply
    // fails to parse and is ignored.
    if !buf.trim().is_empty() {
        for line in buf.replace('\r', "\n").lines() {
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.strip_prefix(' ').unwrap_or(payload);
            let mut text_sink = |t: &str| on_event(StreamSignal::Text(t));
            if apply_sse_payload(&cfg.provider, payload, &mut acc, &mut text_sink) {
                break;
            }
        }
    }
    // The socket closed without a terminal frame. Only now can the outcome be
    // judged, because everything streamed before the close is accumulated.
    finish_stream(&cfg.provider, acc)
}

/// A provider that answers HTTP 200 and puts its refusal in the assistant
/// CONTENT instead of an error envelope. Pollinations does this for a drained
/// account: the reply is "The account behind this API key doesn't have enough
/// credits…", usage is all zeros, and a model test that only checks
/// "non-empty" therefore shows a green tick while every real turn is refused.
///
/// Only strong, billing/auth-shaped phrases count, and callers additionally
/// require zero usage, so a model that legitimately DISCUSSES credits is not
/// misread as a failed call.
pub fn content_error_message(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.is_empty() || t.len() > 800 {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "have enough credits",
        "not enough credit",
        "insufficient credit",
        "credit balance is too low",
        "exceeded your current quota",
        "insufficient_quota",
        "free usage limit reached",
        "free tier limit",
        "out of credits",
        "no credits",
        "please top up",
        "top up or",
        "account is suspended",
        "account has been suspended",
        "payment required",
        "invalid api key",
        "incorrect api key",
    ];
    NEEDLES
        .iter()
        .any(|needle| lower.contains(needle))
        .then_some(t)
}

/// True when a provider reported usage and every token count is zero. A
/// content-level refusal (see [`content_error_message`]) is only trusted in
/// that case; a real answer always bills at least one token.
fn usage_is_zero(usage: Option<&Value>) -> bool {
    let Some(u) = usage else {
        return false;
    };
    let keys = [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
    ];
    let mut seen = false;
    for key in keys {
        if let Some(n) = u.get(key).and_then(Value::as_i64) {
            seen = true;
            if n != 0 {
                return false;
            }
        }
    }
    seen
}

/// Latch a provider refusal that arrived as ordinary CONTENT before it is
/// forwarded to the UI. Pollinations answers a drained account with a normal
/// 200 chunk whose `delta.content` is the billing message; streaming it made
/// the transcript fill with that text on every retry. Only a complete-looking
/// first chunk (≥60 chars) is treated this way — a real model's first delta is
/// a few tokens, so this cannot swallow a normal answer.
fn latch_content_error(acc: &mut StreamAcc, t: &str) -> bool {
    if acc.text.is_empty() && t.trim().len() >= 60 {
        if let Some(msg) = content_error_message(t) {
            acc.error = Some(msg.to_string());
            return true;
        }
    }
    false
}

/// Pull (text, usage) out of a provider response.
fn extract_completion(provider: &str, v: &Value) -> Result<LlmResult, (u16, String)> {
    // A 200 carrying an error object is a failure, not an empty answer: the body
    // names the reason, so every one-shot caller (title, compact, model test)
    // reports that instead of a blank "empty reply".
    if let Some(msg) = provider_error_message(v) {
        return Err((0u16, msg));
    }
    let (text, usage) = match provider {
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
            (text, Some(v["usage"].clone()))
        }
        "google" => {
            // Gemini may split the answer across several parts (and can carry
            // thought/signature parts first); concatenate every text part that
            // is not reasoning instead of reading only `parts[0]`.
            let text: String = v["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|p| p["thought"].as_bool() != Some(true))
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            (text, Some(v["usageMetadata"].clone()))
        }
        _ => {
            let choice = &v["choices"][0];
            let text = choice["message"]["content"].as_str().unwrap_or_default().to_string();
            let usage = v["usage"].as_object().map(|_| v["usage"].clone());
            (text, usage)
        }
    };
    // A 200 whose CONTENT is a billing/auth refusal: the provider used the
    // normal completion shape, so only zero usage + the wording can tell it
    // apart from a real answer. Without this a title/compact call would store
    // the refusal as its result and a model probe would show a green tick.
    if usage_is_zero(usage.as_ref()) {
        if let Some(msg) = content_error_message(&text) {
            return Err((0u16, msg.to_string()));
        }
    }
    Ok(LlmResult { text, usage })
}

#[cfg(test)]
mod tests;
