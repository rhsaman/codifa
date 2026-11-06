use super::*;

/// Run the explore sub-agent (tools `explore`/`task`): depth-limited
/// recursion into run_turn with a research-only prompt and the FULL
/// read/search tool set. The report is returned UNCAPPED — the main agent
/// has no search tools of its own, so this report is its only source of
/// data (UI echo is still capped by the caller).
/// Resolve the explore sub-agent's model from the Tool Models settings.
/// Mirrors graph.py resolve_subagent_model: "" / missing -> the parent
/// model; "providerId/model" -> THAT provider's base URL + keys
/// (cross-provider routing); a bare model id -> the parent provider.
/// Heuristic mirror of the frontend's `supportsReasoning` (src/lib/thinking.ts):
/// a model whose id clearly looks like a reasoning model is flagged even when
/// the provider never reported a `reasoning` flag (local llama.cpp/vLLM rows).
pub(super) fn model_id_looks_reasoning(model: &str) -> bool {
    let id = model.trim().to_lowercase();
    if id.is_empty() {
        return false;
    }
    let needles = [
        "qwen3",
        "qwq",
        "deepseek-r1",
        "deepseek_v3.1",
        "glm-4.5",
        "glm-4.6",
        "kimi-k2-thinking",
        "reasoning",
        "reasoner",
        "thinking",
    ];
    if needles.iter().any(|n| id.contains(n)) {
        return true;
    }
    // gpt-5 / o1 / o3 / o4 families, tolerant of separators.
    id.contains("gpt-5")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
}

/// Thinking levels a model was described with, read from the same provider row
/// `provider_model_reasoning` reads its capability flags from (the renderer
/// stores `/models`' `thinking_levels` as `thinkingLevelsMap`).
///
/// `None` = no source described the model, so no level may be sent for it;
/// `Some(vec![])` = a source described it, and it has no level to offer.
pub(crate) fn provider_model_thinking_levels(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
) -> Option<Vec<String>> {
    let cfg = providers.get(provider_id)?;
    let map = cfg.get("thinkingLevelsMap")?;
    let pick = |key: String| -> Option<Vec<String>> {
        map.get(&key).and_then(Value::as_array).map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
    };
    let bare = pick(model.to_string());
    if bare.is_some() {
        return bare;
    }
    if provider_id.is_empty() {
        return None;
    }
    pick(format!("{provider_id}/{model}"))
}

/// Reasoning capability of the model a slot actually runs, mirroring the
/// frontend's precedence (`modelReasoning() ?? supportsReasoning()`): the
/// manual override first, then the live `/models` map, each tried bare and
/// `providerId/model`-prefixed, and finally the model-id heuristic. Reads the
/// provider config Value directly — the Rust side never had this check before,
/// so every tool slot's reasoning gate was silently off.
pub(crate) fn provider_model_reasoning(
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    model: &str,
) -> bool {
    let map_flag = |key: &str| -> Option<bool> {
        let cfg = providers.get(provider_id)?;
        let map = cfg.get(key)?;
        let bare = map.get(model).and_then(Value::as_bool);
        if bare.is_some() {
            return bare;
        }
        if provider_id.is_empty() {
            return None;
        }
        map.get(&format!("{provider_id}/{model}"))
            .and_then(Value::as_bool)
    };
    if let Some(v) = map_flag("manualReasoningMap") {
        return v;
    }
    // Evidence the model itself produced reasoning outranks a reported flag:
    // the renderer records it after a response streamed reasoning content
    // (`observedReasoningMap`), which is the only capability signal a gateway
    // with a bare `/models` payload ever yields.
    if let Some(v) = map_flag("observedReasoningMap") {
        return v;
    }
    if let Some(v) = map_flag("reasoningMap") {
        return v;
    }
    model_id_looks_reasoning(model)
}

/// Rewrite a provider error so it names the provider the user CONFIGURED
/// ("9router") instead of its wire KIND ("custom").
///
/// `LlmConfig::provider` is the endpoint kind: every OpenAI-compatible custom
/// endpoint is literally `"custom"`, so `finish_stream` prefixes its errors with
/// it and the retry banner read "custom reported an error mid-stream: …". The
/// user answered "I don't have this provider in my fallback list" — precisely
/// because the message named a kind they had never configured, not the provider
/// that actually failed. The model is already shown in the banner, so the
/// missing half is WHICH provider to fix.
pub(crate) fn name_the_provider_in_error(
    err: String,
    providers: &std::collections::HashMap<String, Value>,
    provider_id: &str,
    kind: &str,
) -> String {
    let label = providers
        .get(provider_id)
        .and_then(|cfg| cfg.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let Some(label) = label else {
        return err;
    };
    // `finish_stream` always starts with the kind followed by a space, so only
    // that exact prefix is rewritten — never a word deeper in the message (a
    // gateway body may mention "custom" itself).
    match err.strip_prefix(&format!("{kind} ")) {
        Some(rest) => format!("{label} {rest}"),
        None => err,
    }
}

/// Resolve the explore slot's target: `(model, base_url, api_keys,
/// provider_id)`. The provider id is the EFFECTIVE one — the provider the
/// request is really routed to — so the usage event can attribute the tokens
/// to the right provider instead of blindly copying the parent's id.
pub(super) fn resolve_subagent_target(req: &AgentRequest) -> (String, String, Vec<String>, String) {
    // The UI's Tool Models settings store the explore model under the
    // "explore" key (agent name).
    let entry = req
        .subagent_models
        .get("explore")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    resolve_slot_target(req, &entry)
}

/// Resolve one Tool Models entry ("providerId/model", a bare model id, or empty
/// for the parent model) against the request's provider configs.
///
/// Split out of `resolve_subagent_target` because the retry ladder re-resolves
/// it before EVERY attempt: a model the user changes while the sub-agent is
/// retrying reaches us as a live entry (see `LIVE_SLOT_ENTRIES`), never in the
/// turn's request body.
pub(super) fn resolve_slot_target(
    req: &AgentRequest,
    entry: &str,
) -> (String, String, Vec<String>, String) {
    let entry = entry.trim();
    if entry.is_empty() || entry == "main" || entry == "main_model" || entry == "main model" {
        return (
            req.model.clone(),
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        );
    }
    // A slash is a provider prefix ONLY when its head is a configured provider:
    // "oc/deepseek-v4.1-flash-free" is a MODEL id, not `oc` + a model.
    let (provider_id, model) = crate::backend_light::split_slot_entry(entry, &req.providers);
    let model = model.to_string();
    if provider_id.is_empty() {
        // Bare model id: same provider as the parent.
        return (
            model,
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        );
    }
    match req.providers.get(&provider_id) {
        Some(cfg) => {
            let base = cfg
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or(&req.base_url)
                .to_string();
            let mut keys: Vec<String> = cfg
                .get("apiKeys")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
                    keys.push(k.to_string());
                }
            }
            if keys.is_empty() {
                keys = req.api_keys.clone();
            }
            (model, base, keys, provider_id)
        }
        // Unknown provider id: fall back to the parent provider (and its id).
        None => (
            model,
            req.base_url.clone(),
            req.api_keys.clone(),
            req.provider_id.clone(),
        ),
    }
}

