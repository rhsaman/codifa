use super::*;

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
pub(super) fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some((mime, payload))
}

/// Provider-specific wire shape of one inline image.
pub(super) fn image_part(kind: &str, data_url: &str) -> Option<Value> {
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
pub(super) fn map_content(kind: &str, content: &Value) -> Value {
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
pub(super) fn map_messages(kind: &str, messages: &[Value]) -> Vec<Value> {
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
pub(super) fn reasoning_active(cfg: &LlmConfig) -> Option<&'static str> {
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
pub(super) fn google_compat_effort(level: &str) -> Option<&'static str> {
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
pub(super) fn apply_reasoning(cfg: &LlmConfig, body: &mut Value, google_native: bool) {
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
pub(super) fn build_request_body(cfg: &LlmConfig, messages: &[Value], tools: Option<&[Value]>) -> Value {
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
            // OpenRouter's OWN usage-accounting switch: without this top-level
            // field its streams may omit `usage` (and with it the cache-hit
            // numbers the meter and the pricing math read) even though the
            // OpenAI-standard `stream_options.include_usage` above is set. The
            // payload shape itself is the SUBSET convention
            // (`prompt_tokens_details.cached_tokens` inside `prompt_tokens`),
            // which `llm::NormalizedUsage` already handles.
            if cfg.provider == "openrouter" {
                body["usage"] = json!({ "include": true });
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
pub(super) fn apply_prompt_cache(cfg: &LlmConfig, body: &mut Value) {
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
pub(super) fn cache_last_content(msg: &mut Value) {
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

