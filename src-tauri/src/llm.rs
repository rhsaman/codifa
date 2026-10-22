// Phase 3-1: one-shot LLM client (non-streaming) mirroring the behavior of
// backend/llm.py `llm_complete` for the endpoints we serve natively
// (/chat/compact). Streaming chat stays on the Python sidecar until the
// agent loop (phase 3-2) moves over.

// Phase 3-2 WIP: streaming path is only called from agent.rs (not wired to a
// route yet). Silence dead-code on the streaming half until the route lands.
#![allow(dead_code)]

use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::sync::Notify;

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
    /// models (openrouter / nvidia / cloudflare / tokenrouter).
    /// Gates the reasoning param the same way the Python `auto_think` did.
    pub auto_think: bool,
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

/// Map a UI thinking level to the OpenAI-standard `reasoning_effort` token.
/// Returns None when reasoning is off or the level is unknown.
/// Note: `xhigh` / `max` are UI-only levels — OpenAI-family endpoints 400 on
/// them, so they are mapped to the strongest accepted token ("high").
pub fn reasoning_effort_for(level: &str) -> Option<&'static str> {
    match level.trim() {
        "none" => None,
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        // UI-only levels collapse to the strongest token the API accepts.
        "xhigh" | "max" => Some("high"),
        // "minimal" is a valid OpenAI token but not exposed in the UI today.
        _ => None,
    }
}

/// Like `reasoning_effort_for`, but the top UI level is passed through
/// verbatim for the kinds whose endpoints accept it, and collapsed to `high`
/// for the OpenAI-family kinds that reject it with 400.
///
/// The UI exposes ONE top option ("Max", stored as `xhigh`); the legacy `max`
/// value is an exact alias, so BOTH fold to the same token per kind — a stored
/// `max` and a stored `xhigh` must never produce different requests.
/// - OpenRouter / TokenRouter / Nvidia / Cloudflare forward the token to the
///   upstream model and accept `xhigh`.
/// - OpenAI itself (`gpt-5`, `o*`) accepts only low/medium/high/minimal, so
///   both top values collapse to "high" (the strongest defined token).
/// - Anthropic and Google use budget mappings (see `thinking_budget_for`),
///   where xhigh/max already map to the same budget.
pub fn reasoning_effort_for_kind(kind: &str, level: &str) -> Option<&'static str> {
    let level = level.trim();
    // UI merge: 'max' and 'xhigh' are the same level.
    let level = if level == "max" { "xhigh" } else { level };
    match kind {
        // Token-budget providers: no `reasoning_effort` token is sent at all.
        "anthropic" | "google" => None,
        // Gateways that forward the effort string upstream accept `xhigh`.
        "openrouter" | "tokenrouter" | "nvidia" | "cloudflare" => match level {
            "xhigh" => Some("xhigh"),
            _ => reasoning_effort_for(level),
        },
        // OpenAI-family and everything else: top UI levels collapse to "high".
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

/// Convert OpenAI-style messages into Gemini `contents` (+ an optional
/// `systemInstruction`).
///
/// Gemini names the assistant role `model` and needs every message shaped as
/// `{role, parts:[{text|inlineData}]}`. The old code dumped OpenAI messages
/// straight into `contents`, so ANY google call was malformed — images or not.
fn google_contents(messages: &[Value]) -> (Value, Option<Value>) {
    let mut contents: Vec<Value> = Vec::new();
    let mut sys_parts: Vec<Value> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        let parts: Vec<Value> = match m.get("content") {
            Some(Value::String(text)) => vec![json!({ "text": text })],
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some(IMAGE_BLOCK_TYPE) => b
                        .get("data_url")
                        .and_then(Value::as_str)
                        .and_then(|u| image_part("google", u)),
                    // Gemini parts are bare `{text}` objects — the neutral
                    // `{type:"text",text}` block is NOT a valid part.
                    Some("text") => b.get("text").map(|t| json!({ "text": t })),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        if parts.is_empty() {
            continue;
        }
        if role == "system" {
            sys_parts.extend(parts);
            continue;
        }
        contents.push(json!({
            "role": if role == "assistant" { "model" } else { "user" },
            "parts": parts,
        }));
    }
    let sys = if sys_parts.is_empty() {
        None
    } else {
        Some(json!({ "parts": sys_parts }))
    };
    (Value::Array(contents), sys)
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

/// Inject the reasoning parameter into a request body: `reasoning_effort`
/// for OpenAI-compatible kinds, `generationConfig.thinkingBudget` for Google
/// and `thinking.budget_tokens` for Anthropic. No-op when reasoning is off or
/// the model/gateway isn't reasoning-capable.
fn apply_reasoning(cfg: &LlmConfig, body: &mut Value) {
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
        "google" => {
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
        "google" => {
            let (contents, sys) = google_contents(messages);
            if let Some(sys) = sys {
                body["systemInstruction"] = sys;
            }
            body["contents"] = contents;
        }
        _ => {
            body["model"] = json!(cfg.model);
            body["stream"] = json!(true);
            body["messages"] = json!(map_messages(cfg.provider.as_str(), messages));
            if let Some(t) = cfg.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = json!(mt);
            }
            if let Some(t) = tools {
                body["tools"] = json!(t);
            }
        }
    }
    apply_prompt_cache(cfg, &mut body);
    apply_reasoning(cfg, &mut body);
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

/// Resolve the stream idle budget, allowing an env override for long-running
/// local models that emit nothing while they compute.
fn stream_idle_secs() -> u64 {
    std::env::var("CODIFA_STREAM_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(IDLE_TIMEOUT_SECS_DEFAULT)
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
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                .pool_max_idle_per_host(16)
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

/// Resolve the chat-completions endpoint + auth header style for a kind.
/// Returns (url, header_name, header_value_prefix).
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

/// The provider telling us the MODEL's upstream endpoint is gone.
///
/// The status code cannot be trusted for this one: a gateway may carry it on a
/// 429 (observed body: `Upstream request failed: Endpoint is unavailable.` with
/// `"code":"rate_limit_exceeded"`), which reads like "come back later" and
/// keeps a model that cannot serve the request at all. The body names the
/// failure, so the body decides.
const UPSTREAM_DOWN: [&str; 5] = [
    "upstream request failed",
    "endpoint is unavailable",
    "endpoint unavailable",
    "no available endpoint",
    "upstream is unavailable",
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
    const REJECTED: [&str; 19] = [
        "invalid api key",
        "incorrect api key",
        "invalid_api_key",
        "api key not valid",
        "no api key configured",
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
    if cfg.api_keys.is_empty() {
        return Err("no api key configured".into());
    }
    // Build the payload ONCE: it does not depend on the key, and a vision call
    // is megabytes of base64 that used to be re-serialized for every attempt.
    let body = one_shot_body(cfg, system, user, images);
    let mut last_err = String::new();
    for key in &cfg.api_keys {
        match complete_with_key(client, cfg, key, &body).await {
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
    apply_reasoning(cfg, &mut body);
    body
}

async fn complete_with_key(
    client: &Client,
    cfg: &LlmConfig,
    key: &str,
    body: &Value,
) -> Result<LlmResult, (u16, String)> {
    let (url, header_name, header_value) = endpoint_and_auth(cfg, key);
    let mut req = client
        .post(&url)
        .header(header_name, header_value)
        .json(body);
    if cfg.provider == "anthropic" {
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
            return Err((status, text));
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
        "google" => {
            // Gemini reports reasoning as a part flagged `thought: true`.
            let part = &v["candidates"][0]["content"]["parts"][0];
            if part["thought"].as_bool() == Some(true) {
                if let Some(t) = part["text"].as_str() {
                    acc.reasoning_len += t.len();
                }
            } else if let Some(t) = part["text"].as_str() {
                acc.text.push_str(t);
                on_delta(t);
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
    if cfg.api_keys.is_empty() {
        return Err((0, "no api key configured".into()));
    }
    // Build the payload ONCE (it is key-independent): the previous code rebuilt
    // and re-cloned the whole message array — base64 images included — for every
    // API-key attempt.
    let body = build_request_body(cfg, messages, tools);
    let mut last_err = String::new();
    for key in &cfg.api_keys {
        match stream_with_key(client, cfg, key, &body, on_event, cancel, steer_interrupt)
            .await
        {
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
    body: &Value,
    on_event: SignalSink<'_>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    steer_interrupt: Option<&InterruptSignal>,
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

    let mut req = client
        .post(&url)
        .header(header_name, header_value)
        .json(body);
    if cfg.provider == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
    }
    // No header deadline — see the one-shot path above. The transport reports a
    // genuinely dead connection (TCP error) immediately; the clock never does.
    let resp = tokio::select! {
        biased;
        _ = wait_cancel(cancel) => return Err((0u16, "aborted by user".into())),
        r = req.send() => r.map_err(|e| (0u16, e.to_string()))?,
    };
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err((status, text));
    }

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
        // SSE frames are separated by a blank line.
        while let Some(pos) = buf.find("\n\n") {
            let frame: String = buf.drain(..pos + 2).collect();
            for line in frame.lines() {
                if let Some(payload) = line.strip_prefix("data: ") {
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
    // The socket closed without a terminal frame. Only now can the outcome be
    // judged, because everything streamed before the close is accumulated.
    finish_stream(&cfg.provider, acc)
}

/// Pull (text, usage) out of a provider response.
fn extract_completion(provider: &str, v: &Value) -> Result<LlmResult, (u16, String)> {
    // A 200 carrying an error object is a failure, not an empty answer: the body
    // names the reason, so every one-shot caller (title, compact, model test)
    // reports that instead of a blank "empty reply".
    if let Some(msg) = provider_error_message(v) {
        return Err((0u16, msg));
    }
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
            reasoning_level: String::new(),
            model_reasoning: false,
            auto_think: false,
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
    fn anthropic_body_caches_the_stable_prefix() {
        let mut c = cfg("anthropic", "https://api.anthropic.com", &["k"]);
        c.max_tokens = Some(8192);
        c.temperature = Some(0.5);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["model"], "m");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["stream"], true);
        // The system prompt is promoted to ONE cached text block (a bare string
        // cannot carry a cache marker).
        assert_eq!(body["system"][0]["text"], "SYS");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        // The last message is the prefix the NEXT round-trip resends.
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        // System is lifted out of `messages` and no OpenAI-only key leaks in.
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openai_compatible_body_keeps_tools_and_has_no_cache_control() {
        let c = cfg("custom", "http://localhost:20128/v1", &["k"]);
        let tools = vec![json!({"type": "function", "function": {"name": "grep"}})];
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, Some(&tools));
        // The tool array IS sent on this arm, untouched and unmarked — an
        // OpenAI-compatible gateway caches its own prefix and an unknown field
        // would be rejected.
        assert_eq!(body["tools"][0]["function"]["name"], "grep");
        assert!(body["tools"][0].get("cache_control").is_none());
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert!(!body.to_string().contains("cache_control"));
    }

    #[test]
    fn google_body_uses_contents_and_has_no_cache_control() {
        let c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "SYS");
        assert!(body["contents"].is_array());
        assert!(!body.to_string().contains("cache_control"));
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
        let mut deltas: Vec<String> = Vec::new();
        let mut sink = |d: &str| deltas.push(d.to_string());
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"he"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"llo"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "read", "arguments": "{\"file"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "Path\":\"a\"}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":2}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.text, "hello");
        assert_eq!(deltas, vec!["he".to_string(), "llo".to_string()]);
        assert_eq!(acc.finish_reason, "tool_calls");
        assert_eq!(acc.tool_calls.len(), 1);
        assert_eq!(acc.tool_calls[0]["function"]["name"], "read");
        assert_eq!(acc.tool_calls[0]["function"]["arguments"].as_str().unwrap(), r#"{"filePath":"a"}"#);
        assert_eq!(acc.usage.clone().unwrap()["input_tokens"], 2);
        // Terminal marker.
        {
            let mut sink = |_: &str| {};
            assert!(apply_sse_payload("custom", "[DONE]", &mut acc, &mut sink));
        }
    }

    #[test]
    fn empty_streamed_name_never_wipes_a_good_one() {
        // Some providers send the tool NAME in the first delta and then
        // `"name":""` on every later delta. The accumulator used to overwrite
        // blindly, erasing the good name: the call then reached the dispatch
        // guard as `unknown tool ""` and burned a whole round-trip.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"grep","arguments":"{\"pat"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        // Args-only delta: no `name` key at all — must keep the good name.
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\":\"x\"}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        // Explicit empty name — must STILL keep the good name.
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":""}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.tool_calls[0]["function"]["name"], "grep");
        assert_eq!(
            acc.tool_calls[0]["function"]["arguments"].as_str().unwrap(),
            r#"{"pattern":"x"}"#
        );
    }

    #[test]
    fn sse_payloads_accumulate_anthropic_deltas() {
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_start","message":{"usage":{"input_tokens":7}}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.text, "hi");
        assert_eq!(acc.finish_reason, "end_turn");
        let usage = acc.usage.unwrap();
        assert_eq!(usage["input_tokens"], 7);
        assert_eq!(usage["output_tokens"], 3);
    }

    #[test]
    fn missing_index_opens_new_slots_and_slots_are_well_formed() {
        // A provider that omits `index` used to fold EVERY streamed call into
        // slot 0 (the `unwrap_or(0)`), leaving the following calls nameless —
        // which the dispatch guard reported as `unknown tool ""`. Each
        // id/name-bearing delta must open its own slot instead.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read","arguments":"{}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"c2","function":{"name":"grep","arguments":"{}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.tool_calls.len(), 2);
        assert_eq!(acc.tool_calls[0]["function"]["name"], "read");
        assert_eq!(acc.tool_calls[1]["function"]["name"], "grep");

        // A slot created by an out-of-order index is structurally complete
        // (`function.name`/`arguments` exist), never a bare `{}` — so a reader
        // can never hit `unknown tool ""` from a missing key.
        let mut acc2 = StreamAcc::default();
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"glob","arguments":"{}"}}]}}]}"#,
            &mut acc2,
            &mut sink
        ));
        assert_eq!(acc2.tool_calls.len(), 3);
        assert!(acc2.tool_calls[0]["function"]["name"].is_string());
        assert!(acc2.tool_calls[1]["function"]["name"].is_string());
        assert_eq!(acc2.tool_calls[2]["function"]["name"], "glob");
    }

    #[test]
    fn reasoning_effort_for_kind_merges_max_into_xhigh() {
        // The UI exposes ONE top option (stored as `xhigh`); a legacy stored
        // `max` must produce the EXACT same token for every kind — otherwise
        // the same visible "Max" level sends different requests.
        for kind in ["openrouter", "tokenrouter", "nvidia", "cloudflare", "custom", "ollama", "openai"] {
            assert_eq!(
                reasoning_effort_for_kind(kind, "xhigh"),
                reasoning_effort_for_kind(kind, "max"),
                "xhigh and max must map identically for kind {kind}"
            );
        }
        // Gateways that forward the token send the strongest verbatim.
        assert_eq!(reasoning_effort_for_kind("openrouter", "xhigh"), Some("xhigh"));
        // OpenAI-family collapses both to the strongest defined token.
        assert_eq!(reasoning_effort_for_kind("custom", "max"), Some("high"));
        // Budget providers carry no effort token at all.
        assert_eq!(reasoning_effort_for_kind("anthropic", "xhigh"), None);
        assert_eq!(reasoning_effort_for_kind("google", "max"), None);
        // Budgets for the two spellings are identical too.
        assert_eq!(thinking_budget_for("xhigh"), thinking_budget_for("max"));
    }

    #[test]
    fn reasoning_deltas_are_measured_not_streamed() {
        // A reasoning model emits its "thinking" tokens before the answer does.
        // They must NOT be forwarded as visible text (that is what crawled the
        // UI), but their ARRIVAL has to be observable — otherwise the pill can
        // only ever say "Working" while the model is plainly thinking.
        let mut acc = StreamAcc::default();
        let mut streamed: Vec<String> = Vec::new();
        {
            let mut sink = |d: &str| streamed.push(d.to_string());
            // OpenRouter / DeepSeek family name it `reasoning`.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"reasoning":"let me think"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, "let me think".len());
            // Several gateways use `reasoning_content`.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"reasoning_content":"more"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, "let me thinkmore".len());
            // The real answer still streams normally.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"content":"done"}}]}"#,
                &mut acc,
                &mut sink
            ));
            // A payload with neither (usage / role) must not change the count,
            // so the pill cannot be flickered off by them.
            let before = acc.reasoning_len;
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"role":"assistant"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, before);
        }
        assert_eq!(acc.text, "done");
        assert_eq!(acc.reasoning_len, "let me thinkmore".len());
        // Nothing but the real answer ever reached the delta sink: reasoning is
        // measured for the pill, never rendered as visible text.
        assert_eq!(streamed, vec!["done".to_string()]);
    }

    #[test]
    fn anthropic_thinking_deltas_are_measured_not_streamed() {
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.reasoning_len, 3);
        assert!(acc.text.is_empty());
    }

    #[test]
    fn a_stream_error_frame_on_a_200_is_a_real_error() {
        // A gateway can answer 200 and report the failure INSIDE the stream. The
        // parser only ever read `choices`, so that frame was ignored outright and
        // the turn finished as a silent success with an empty bubble — exactly
        // what a model that cannot serve the request looked like.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(apply_sse_payload(
            "nvidia",
            r#"{"error":{"message":"Upstream request failed: Endpoint is unavailable."}}"#,
            &mut acc,
            &mut sink
        ));
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("Upstream request failed"), "{err}");
        // The class matters end to end: a dead endpoint is a MODEL-side
        // rejection, so the next configured model takes the call instead of the
        // same one being retried, and no key is blamed for it.
        assert!(should_fall_back(&err));
        assert!(!is_key_error(0, &err));

        // FastAPI-shaped error bodies name the reason in `detail`.
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "custom",
            r#"{"detail":"no available endpoint"}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(
            finish_stream("custom", acc).unwrap_err().1,
            "custom reported an error mid-stream: no available endpoint"
        );
    }

    #[test]
    fn provider_error_shapes_are_recognized_without_naming_the_provider() {
        // Every provider words a failure differently, so the guard keys on the
        // SHAPE, never on the provider name — the same call has to work for a
        // gateway added tomorrow.
        for provider in [
            "nvidia",
            "openrouter",
            "tokenrouter",
            "cloudflare",
            "custom",
            "ollama",
            "anthropic",
            "google",
        ] {
            let mut acc = StreamAcc::default();
            let mut sink = |_: &str| {};
            assert!(
                apply_sse_payload(
                    provider,
                    r#"{"error":{"message":"boom"}}"#,
                    &mut acc,
                    &mut sink
                ),
                "{provider} missed an OpenAI-shaped error frame"
            );
            let err = finish_stream(provider, acc).unwrap_err().1;
            assert!(err.contains("boom"), "{err}");
        }

        // Anthropic reports a mid-stream failure with no `error` object at all.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(apply_sse_payload(
            "anthropic",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(finish_stream("anthropic", acc)
            .unwrap_err()
            .1
            .contains("Overloaded"));
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "anthropic",
            r#"{"type":"error","message":"Overloaded"}"#,
            &mut acc,
            &mut sink
        ));
        assert!(finish_stream("anthropic", acc)
            .unwrap_err()
            .1
            .contains("Overloaded"));

        // Google sends no message at all: the status/code pair is the reason.
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "google",
            r#"{"error":{"code":400,"status":"INVALID_ARGUMENT"}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(
            finish_stream("google", acc).unwrap_err().1,
            "google reported an error mid-stream: INVALID_ARGUMENT (code 400)"
        );

        // The one-shot path (title, compact, model test) reads the same shapes.
        assert!(extract_completion(
            "google",
            &json!({"error": {"code": 403, "status": "PERMISSION_DENIED"}})
        )
        .err()
        .unwrap()
        .1
        .contains("PERMISSION_DENIED"));
        assert_eq!(
            extract_completion(
                "anthropic",
                &json!({"type": "error", "message": "Overloaded"})
            )
            .err()
            .unwrap()
            .1,
            "Overloaded"
        );

        // HEALTHY frames of every provider shape keep flowing as text, and a
        // `null` error key (several APIs always send it) is not a failure: a
        // false positive here would kill a working turn.
        let mut acc = StreamAcc::default();
        let mut out = String::new();
        let mut sink = |t: &str| out.push_str(t);
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "google",
            r#"{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"error":null,"choices":[{"delta":{"content":"!"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(out, "hihihi!");
        assert!(finish_stream("custom", acc).is_ok());
    }

    #[test]
    fn a_stream_with_no_output_is_not_a_silent_success() {
        let mut acc = StreamAcc::default();
        acc.finish_reason = "stop".into();
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("returned no content"), "{err}");
        assert!(err.contains("'stop'"), "{err}");
        assert!(should_fall_back(&err));

        // Reasoning that never reached an answer: same verdict, and the hint
        // says where the budget went.
        let mut acc = StreamAcc::default();
        acc.reasoning_len = 42;
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("streaming reasoning"), "{err}");

        // Whitespace-only output is an empty answer, not content.
        let mut acc = StreamAcc::default();
        acc.text = "\n".into();
        assert!(finish_stream("nvidia", acc).is_err());

        // Real output — text or a tool call — stays a success.
        let mut acc = StreamAcc::default();
        acc.text = "hi".into();
        assert!(finish_stream("nvidia", acc).is_ok());
        let mut acc = StreamAcc::default();
        acc.tool_calls
            .push(json!({"function": {"name": "read", "arguments": "{}"}}));
        assert!(finish_stream("nvidia", acc).is_ok());

        // A mid-turn steer ended the request on purpose: the agent re-issues the
        // step, so an empty accumulator is the expected outcome.
        let mut acc = StreamAcc::default();
        acc.interrupted = true;
        assert!(finish_stream("nvidia", acc).is_ok());
    }

    #[test]
    fn a_one_shot_error_body_reports_its_reason() {
        // 200 + `{"error": …}` on the non-streaming path used to come back as an
        // empty text SUCCESS, so every caller (title, compact, model test) showed
        // a blank result instead of the provider's own message.
        let v = json!({"error": {"message": "quota exhausted", "type": "insufficient_quota"}});
        assert_eq!(
            extract_completion("custom", &v).err().unwrap().1,
            "quota exhausted"
        );
        let v = json!({"detail": "no available endpoint"});
        assert_eq!(
            extract_completion("custom", &v).err().unwrap().1,
            "no available endpoint"
        );
        // A healthy response is untouched.
        let v = json!({"choices": [{"message": {"content": "ok"}}]});
        assert_eq!(extract_completion("custom", &v).unwrap().text, "ok");
    }

    #[test]
    fn interrupt_signal_wakes_a_parked_waiter_and_stamps_generations() {
        // Mid-turn steer: the stream read loop selects on this signal, so a raise
        // must wake a waiter that is ALREADY parked (a lost wakeup would put the
        // steer back to "waits for the whole model reply" — the reported bug).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let sig = InterruptSignal::new();
            let base = sig.generation();
            assert!(!sig.interrupted_since(base));
            let waiter = async {
                sig.wait_for(base).await;
                true
            };
            let raiser = async {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                sig.raise();
            };
            let (woke, _) = tokio::join!(waiter, raiser);
            assert!(woke, "a parked waiter must be woken by raise()");
            assert!(sig.interrupted_since(base));
        });
    }

    #[test]
    fn a_raise_from_an_earlier_window_never_cancels_a_new_request() {
        // The bug behind "sometimes the steer works, sometimes it waits": a raise
        // that landed while NO stream was parked used to leak into the next
        // request (or be wiped by reset()). The generation stamp makes each
        // stream see only raises that happened AFTER it started.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let sig = InterruptSignal::new();
            // A steer lands while the agent is between model calls.
            sig.raise();
            // The NEXT request starts: it stamps the current generation, so that
            // older raise is NOT its own — it must not be interrupted.
            let base = sig.generation();
            assert!(!sig.interrupted_since(base));
            // A second steer lands while this request is live: that one IS its
            // own and must fire immediately.
            sig.raise();
            assert!(sig.interrupted_since(base));
            // wait_for resolves without parking (counter already ahead).
            let gen = sig.wait_for(base).await;
            assert_eq!(gen, base + 1);
        });
    }

    fn tokio_test_block(client: &Client, c: &LlmConfig) -> String {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { complete(client, c, "s", "u").await.err().unwrap() })
    }

    /// A tiny valid inline image: the mime prefix is what the per-provider
    /// translation switches on, the payload is opaque.
    const PNG_URL: &str = "data:image/png;base64,AAAA";

    #[test]
    fn anthropic_thinking_budget_distinguishes_every_level() {
        // Every slider step must change the wire request. The old flat
        // `budget.min(2048)` collapsed Low..Max onto the same body, so the
        // slider was cosmetic on Anthropic.
        let low = anthropic_budget_for("low").unwrap();
        let medium = anthropic_budget_for("medium").unwrap();
        let high = anthropic_budget_for("high").unwrap();
        let top = anthropic_budget_for("xhigh").unwrap();
        assert!(
            low < medium && medium < high && high < top,
            "budgets must grow with the level: {low} {medium} {high} {top}"
        );
        // `max` is an exact alias of `xhigh` — one UI option, one request.
        assert_eq!(anthropic_budget_for("max"), Some(top));
        assert_eq!(anthropic_budget_for("none"), None);
        assert_eq!(anthropic_budget_for(""), None);
    }

    #[test]
    fn anthropic_body_carries_the_budget_and_raises_max_tokens() {
        let mut c = cfg("anthropic", "https://api.anthropic.com", &["k"]);
        c.model_reasoning = true;
        c.reasoning_level = "high".into();
        c.max_tokens = Some(4096);
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        let body = build_request_body(&c, &msgs, None);
        let budget = anthropic_budget_for("high").unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], budget);
        // Anthropic rejects the call unless max_tokens > budget_tokens, so the
        // cap must be RAISED to fit the budget instead of the budget lowered.
        assert!(
            body["max_tokens"].as_u64().unwrap() > budget as u64,
            "max_tokens must exceed the thinking budget: {body}"
        );
    }

    #[test]
    fn reasoning_is_gated_by_the_model_capability_flag() {
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        // A level alone is not enough: a model that is not flagged
        // reasoning-capable gets NO parameter (the same gate the Python
        // sidecar had).
        let mut c = cfg("custom", "https://x.example/v1", &["k"]);
        c.reasoning_level = "high".into();
        assert!(build_request_body(&c, &msgs, None)
            .get("reasoning_effort")
            .is_none());
        c.model_reasoning = true;
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "high");
        // The top UI level is UI-only for the OpenAI family: it collapses to
        // the strongest token those endpoints accept.
        c.reasoning_level = "xhigh".into();
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "high");
        // Gateways that FORWARD the effort string keep it verbatim.
        let mut g = cfg("openrouter", "https://openrouter.ai/api/v1", &["k"]);
        g.auto_think = true;
        g.reasoning_level = "xhigh".into();
        assert_eq!(build_request_body(&g, &msgs, None)["reasoning_effort"], "xhigh");
        // None / empty send nothing at all.
        g.reasoning_level = "none".into();
        assert!(build_request_body(&g, &msgs, None)
            .get("reasoning_effort")
            .is_none());
        g.reasoning_level = String::new();
        assert!(build_request_body(&g, &msgs, None)
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn google_body_gets_a_thinking_budget() {
        let mut c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        c.model_reasoning = true;
        c.reasoning_level = "medium".into();
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            thinking_budget_for("medium").unwrap()
        );
        // A budget provider must never ALSO send the OpenAI-only token.
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn an_image_block_renders_in_each_provider_shape() {
        // The agent emits ONE neutral block shape; the three endpoints each get
        // their own wire shape from here.
        let blocks = json!([
            { "type": "text", "text": "what is this" },
            { "type": IMAGE_BLOCK_TYPE, "data_url": PNG_URL },
        ]);
        // OpenAI-compatible: the data URL rides verbatim.
        let openai = map_content("custom", &blocks);
        assert_eq!(openai[1]["type"], "image_url");
        assert_eq!(openai[1]["image_url"]["url"], PNG_URL);
        // Anthropic: raw base64 plus a media type, never a data URL.
        let anthropic = map_content("anthropic", &blocks);
        assert_eq!(anthropic[1]["type"], "image");
        assert_eq!(anthropic[1]["source"]["type"], "base64");
        assert_eq!(anthropic[1]["source"]["media_type"], "image/png");
        assert_eq!(anthropic[1]["source"]["data"], "AAAA");
        // Gemini: inlineData.
        let google = map_content("google", &blocks);
        assert_eq!(google[1]["inlineData"]["mimeType"], "image/png");
        assert_eq!(google[1]["inlineData"]["data"], "AAAA");
        // A malformed / truncated data URL is DROPPED (the turn's text still
        // gets through) instead of poisoning the whole request with a 400.
        for bad in ["data:image/png;base64,", "data:;base64,AAAA", "not-an-image"] {
            let blocks = json!([{ "type": IMAGE_BLOCK_TYPE, "data_url": bad }]);
            assert!(
                map_content("custom", &blocks).as_array().unwrap().is_empty(),
                "a malformed data URL must be dropped, got {bad}"
            );
        }
    }

    #[test]
    fn a_text_only_turn_keeps_the_plain_string_content_shape() {
        // Regression guard: the multimodal translation must not touch a
        // text-only conversation — every provider path is byte-compared.
        let c = cfg("custom", "https://x.example/v1", &["k"]);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["messages"][1]["content"], "hi");
    }

    #[test]
    fn google_contents_translate_blocks_into_parts() {
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": [
                { "type": "text", "text": "what is this" },
                { "type": IMAGE_BLOCK_TYPE, "data_url": PNG_URL },
            ]}),
            json!({"role": "assistant", "content": "a button"}),
        ];
        let (contents, sys) = google_contents(&msgs);
        // Gemini spells the assistant role "model" and takes bare {text} parts
        // (the neutral {type:"text"} block is not a valid part).
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[0]["parts"][0]["text"], "what is this");
        assert_eq!(contents[0]["parts"][1]["inlineData"]["data"], "AAAA");
        assert_eq!(contents[1]["parts"][0]["text"], "a button");
        // The system prompt becomes systemInstruction, never a content turn.
        assert_eq!(sys.unwrap()["parts"][0]["text"], "SYS");
    }

    #[test]
    fn google_body_switches_to_contents_for_images() {
        let c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": [
                { "type": "text", "text": "describe" },
                { "type": IMAGE_BLOCK_TYPE, "data_url": PNG_URL },
            ]}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["contents"][0]["parts"][1]["inlineData"]["data"], "AAAA");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "SYS");
    }

    /// A dead upstream endpoint must not be mistaken for a key problem: the key
    /// loop would spend every configured key on the same doomed call.
    #[test]
    fn an_unavailable_endpoint_is_not_a_key_error() {
        assert!(!is_key_error(
            429,
            "{\"error\":{\"message\":\"Upstream request failed: Endpoint is \
             unavailable.\"}}"
        ));
        // A genuine rate limit still tries the next key: another key has its own
        // quota.
        assert!(is_key_error(429, "429 Too Many Requests"));
    }

    /// The fallback rule: ONLY a model that cannot serve us may be replaced.
    #[test]
    fn fallback_only_for_a_model_side_rejection() {
        // A refused key/account or a model the provider does not serve: another
        // model can work, so the next fallback must be tried.
        assert!(should_fall_back(
            "key rejected (401): {\"error\":{\"message\":\"Invalid API key\"}}"
        ));
        assert!(should_fall_back("key rejected (403): forbidden"));
        assert!(should_fall_back("no api key configured"));
        assert!(should_fall_back("model `gpt-x` not found"));
        // A model that answers with nothing usable is not working either.
        assert!(should_fall_back("the model returned an empty description"));
        assert!(should_fall_back("returned an empty summary"));
        // A stream that ended with no output, and a gateway error carried INSIDE
        // a 200 stream: both name a model that cannot serve the request.
        assert!(should_fall_back(
            "nvidia returned no content — the stream finished with 'stop'"
        ));
        assert!(should_fall_back(
            "nvidia reported an error mid-stream: \"Upstream request failed: Endpoint is \
             unavailable.\""
        ));

        // Everything else stays on the SAME model: another model cannot fix the
        // network, and spending the whole list on one hiccup hides the reason.
        assert!(!should_fall_back("provider sent no response within 90s"));
        assert!(!should_fall_back(
            "error sending request for url (http://x/v1/chat/completions): \
             error trying to connect: tcp connect error: Connection refused (os error 61)"
        ));
        assert!(!should_fall_back("provider stream sent no data for 60s"));
        assert!(!should_fall_back("aborted by user"));
        assert!(!should_fall_back("429 Too Many Requests"));
        // The real one from the field: a gateway answers 429 for an upstream
        // failure. The status says "rate limit", the body says the model's
        // endpoint is gone — the body wins, because retrying that model cannot
        // help and the user's fallbacks sat unused.
        assert!(should_fall_back(
            "{\"error\":{\"message\":\"[429]: Upstream request failed: \
             Endpoint is unavailable.\",\"code\":\"rate_limit_exceeded\"}}"
        ));
        // The SAME gateway failure carried on a 503, in the exact shape the
        // renderer shows it (observed in the field): `[503]` plus
        // `service_unavailable` reads like a provider hiccup, but the body names
        // the model's dead upstream endpoint, so the next fallback must take the
        // call instead of retrying a model that cannot serve it.
        assert!(should_fall_back(
            r#"explore failed: {"error":{"message":"[503]: {\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}","type":"server_error","code":"service_unavailable"}}"#
        ));
        // A BARE 5xx with no such body is the provider breaking, not the model:
        // it keeps the SAME model and retries it.
        assert!(!should_fall_back("503 Service Unavailable"));
        assert!(!should_fall_back(
            "{\"error\":{\"message\":\"Internal server error\"}}"
        ));
        // A 5xx key rejection is the PROVIDER breaking, not the model.
        assert!(!should_fall_back("key rejected (500): upstream exploded"));
        assert!(!should_fall_back(""));
    }
}
