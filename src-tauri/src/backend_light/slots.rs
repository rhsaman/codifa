use super::*;

/// Resolve a Tool Models slot entry ("providerId/model" | bare model | "")
/// to (model, base_url, api_keys, provider_id) — shared by the compact and
/// sub-agent slots; mirrors graph.py resolve_subagent_model. The returned
/// provider id is the EFFECTIVE one (the provider actually called), so usage
/// events and the Model-usage panel attribute tokens to the right provider.
/// Split a Tool Models entry into `(provider_id, model)`.
///
/// A slash is a provider prefix ONLY when its head names a provider this
/// request actually configured. Model ids routinely carry a vendor namespace
/// ("oc/deepseek-v4.1-flash-free", "z-ai/glm-5.3", "deepseek-ai/DeepSeek-…"),
/// and splitting those at the first slash invented a provider ("oc") that does
/// not exist: `resolve_slot_target` then fell into its unknown-provider arm and
/// sent the REMAINDER ("deepseek-v4.1-flash-free") to the parent provider,
/// which answered `404 page not found` for a model it had never heard of — the
/// exact failure that made a working model look broken inside a tool.
///
/// With an unknown head the whole entry stays the model id and the call keeps
/// the parent provider.
pub fn split_slot_entry<'a>(
    entry: &'a str,
    providers: &std::collections::HashMap<String, Value>,
) -> (String, &'a str) {
    let entry = entry.trim();
    if let Some((head, rest)) = entry.split_once('/') {
        let head = head.trim();
        if !head.is_empty() {
            if providers.contains_key(head) {
                return (head.to_string(), rest.trim());
            }
            // Legacy KIND prefix ("custom/model"): the settings picker used to
            // store the endpoint kind instead of the provider id. Resolving it
            // keeps such a row on the provider it meant; otherwise the whole
            // string travels as a model id and the endpoint answers 404. Only an
            // UNAMBIGUOUS kind resolves — two rows of the same kind cannot be
            // told apart, so there the entry stays a model id.
            if let Some(id) = kind_owner(head, providers) {
                return (id, rest.trim());
            }
        }
    }
    // No known provider prefix: the whole entry IS the model id. A row written
    // before the pick carried its provider (or by hand) must still reach the
    // endpoint that serves it, so a model listed by exactly ONE configured
    // provider is attributed to that provider.
    (owner_of_model(entry, providers).to_string(), entry)
}

/// The id of the single configured provider whose `kind` is `kind` — `None`
/// when no row has that kind or when several share it (ambiguous).
pub(super) fn kind_owner(kind: &str, providers: &std::collections::HashMap<String, Value>) -> Option<String> {
    let mut owner: Option<&String> = None;
    for (id, cfg) in providers {
        let matches = cfg
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|k| k == kind);
        if !matches {
            continue;
        }
        if owner.is_some() {
            return None;
        }
        owner = Some(id);
    }
    owner.cloned()
}

/// The id of the single configured provider whose `/models` list contains
/// `model` — `""` when none does, or when several claim it (ambiguous, so the
/// parent provider stays in charge).
pub(super) fn owner_of_model<'a>(
    model: &str,
    providers: &'a std::collections::HashMap<String, Value>,
) -> &'a str {
    let mut owner = "";
    for (id, cfg) in providers {
        let listed = cfg
            .get("models")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .any(|m| m.trim() == model)
            });
        if !listed {
            continue;
        }
        if !owner.is_empty() {
            return "";
        }
        owner = id.as_str();
    }
    owner
}

pub fn resolve_slot_target(
    entry: &str,
    parent_model: &str,
    parent_base: &str,
    parent_keys: &[String],
    parent_provider_id: &str,
    providers: &std::collections::HashMap<String, Value>,
) -> (String, String, Vec<String>, String) {
    let entry = entry.trim();
    if entry.is_empty() || entry == "main" || entry == "main_model" || entry == "main model" {
        return (
            parent_model.to_string(),
            parent_base.to_string(),
            parent_keys.to_vec(),
            parent_provider_id.to_string(),
        );
    }
    let (provider_id, model) = split_slot_entry(entry, providers);
    if provider_id.is_empty() {
        return (
            model.to_string(),
            parent_base.to_string(),
            parent_keys.to_vec(),
            parent_provider_id.to_string(),
        );
    }
    let provider_id = provider_id.trim();
    match providers.get(provider_id) {
        Some(cfg) => {
            let base = cfg
                .get("baseUrl")
                .or_else(|| cfg.get("base_url"))
                .and_then(Value::as_str)
                .unwrap_or(parent_base)
                .to_string();
            // The renderer sends provider configs with camelCase keys
            // (`apiKeys`, `baseUrl`), while the sidecar's own contract used
            // snake_case. Reading only `apiKeys` left the key list EMPTY for
            // every cross-provider slot, so the title/compact call failed with
            // "no api key configured" and the chat stayed untitled.
            let mut keys: Vec<String> = cfg
                .get("apiKeys")
                .or_else(|| cfg.get("api_keys"))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if keys.is_empty() {
                if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
                    keys.push(k.to_string());
                }
            }
            // Borrowing the parent's keys is only sound when the request goes
            // to the SAME endpoint. Sending the chat provider's key to a
            // different provider's base URL is exactly how a slot turns into a
            // bare "Invalid API key" 401 with no clue which model produced it,
            // so a keyless provider on its own endpoint keeps an empty list and
            // reports "no api key configured" instead.
            if keys.is_empty() && base == parent_base {
                keys = parent_keys.to_vec();
            }
            (model.to_string(), base, keys, provider_id.to_string())
        }
        None => (
            model.to_string(),
            parent_base.to_string(),
            parent_keys.to_vec(),
            parent_provider_id.to_string(),
        ),
    }
}

/// The Tools → "Other" model group: `compact`, `web` and `title` share ONE
/// settings row, so the picked model may be stored under any of the three keys.
/// Returns the group's first explicit entry, or `""` when the group follows the
/// main model.
///
/// Every side-task consumer must resolve through this instead of reading a
/// single hardcoded key: reading only `compact` while the row had stored the
/// pick under `title`/`web` is exactly why the commit message and the chat
/// title silently kept running on the main chat model. Mirrors
/// `otherSlotModel` in `src/lib/toolSlots.ts`.
pub fn other_slot_entry(models: &std::collections::HashMap<String, String>) -> &str {
    for key in ["compact", "web", "title"] {
        let Some(v) = models.get(key) else { continue };
        let v = v.trim();
        if v.is_empty() || v == "main" || v == "main_model" || v == "main model" {
            continue;
        }
        return v;
    }
    ""
}

/// The Tools → "Other" group's reasoning effort: its first explicit level, or
/// `""` (which every caller maps to "none" — sell no reasoning parameter).
pub fn other_slot_level(levels: &std::collections::HashMap<String, String>) -> &str {
    for key in ["compact", "web", "title"] {
        let Some(v) = levels.get(key) else { continue };
        let v = v.trim();
        if !v.is_empty() {
            return v;
        }
    }
    ""
}

/// The provider KIND a Tool Models slot entry routes to.
///
/// `resolve_slot_target` returns the model/base/keys but not the kind, and the
/// kind is what selects the URL path + auth header (anthropic `/v1/messages`
/// vs the OpenAI-compatible `/chat/completions`). A cross-provider slot — an
/// anthropic decision/title model while the chat runs on openrouter — must not
/// inherit the parent's kind, or every call hits the wrong endpoint.
/// Falls back to the parent kind for a bare model or an unknown provider id.
pub fn resolve_slot_kind(
    entry: &str,
    parent_kind: &str,
    providers: &std::collections::HashMap<String, Value>,
) -> String {
    let (provider_id, _) = split_slot_entry(entry, providers);
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return parent_kind.to_string();
    }
    providers
        .get(provider_id)
        .and_then(|cfg| cfg.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or(parent_kind)
        .to_string()
}

/// Identity of a resolved slot target, used to drop duplicate rungs from a
/// fallback chain: the same provider + model pair reached twice must not be
/// tried twice.
pub(super) fn slot_target_key(
    provider_id: &str,
    model: &str,
    base_url: &str,
) -> (String, String, String) {
    (
        provider_id.trim().to_string(),
        model.trim().to_string(),
        base_url.trim().to_string(),
    )
}

/// The Tools → "Other" group's fallback list: the group's first non-empty list,
/// i.e. the same value the settings row displays. Mirrors `otherSlotFallbacks`
/// in `src/lib/toolSlots.ts` so the row and the call can never disagree about
/// which key holds the pick.
pub fn other_slot_fallbacks(
    fallbacks: &std::collections::HashMap<String, Vec<String>>,
) -> &[String] {
    for key in ["compact", "web", "title"] {
        if let Some(list) = fallbacks.get(key) {
            if list.iter().any(|e| !e.trim().is_empty()) {
                return list.as_slice();
            }
        }
    }
    &[]
}

/// Resolve a Tool Models slot into its ordered CALL CHAIN: the slot's OWN model
/// first, then that slot's fallback list (Settings → Tools → the tool's own
/// fallbacks) in the order the user arranged it.
///
/// The chain is rebuilt from scratch for every call and nothing about it is
/// remembered, which is what makes a fallback an escape hatch for ONE failing
/// call instead of a new default: the next call starts at the slot's own model
/// again. Every rung is resolved through `resolve_slot_target` /
/// `resolve_slot_kind`, so a fallback routes cross-provider (its own base URL,
/// keys and endpoint kind) exactly like the slot entry itself. Rungs that
/// resolve to the same provider+model are dropped, and a fallback list on an
/// EMPTY slot entry is ignored: an entry is required for the tool to be routed
/// anywhere, so its fallbacks only ever stand behind a real model.
pub fn resolve_slot_chain(
    entry: &str,
    slot_fallbacks: &[String],
    parent_model: &str,
    parent_base: &str,
    parent_keys: &[String],
    parent_provider_id: &str,
    parent_kind: &str,
    providers: &std::collections::HashMap<String, Value>,
) -> Vec<(String, String, Vec<String>, String, String)> {
    let primary = resolve_slot_target(
        entry,
        parent_model,
        parent_base,
        parent_keys,
        parent_provider_id,
        providers,
    );
    let primary_kind = resolve_slot_kind(entry, parent_kind, providers);
    let mut out: Vec<(String, String, Vec<String>, String, String)> = vec![(
        primary.0,
        primary.1,
        primary.2,
        primary.3,
        primary_kind,
    )];
    if entry.trim().is_empty() && slot_fallbacks.iter().all(|e| e.trim().is_empty()) {
        return out;
    }
    let mut seen = std::collections::HashSet::new();
    for step in &out {
        seen.insert(slot_target_key(&step.3, &step.0, &step.1));
    }
    for fb in slot_fallbacks {
        if fb.trim().is_empty() {
            continue;
        }
        let (model, base, keys, provider_id) = resolve_slot_target(
            fb,
            parent_model,
            parent_base,
            parent_keys,
            parent_provider_id,
            providers,
        );
        if model.trim().is_empty() {
            continue;
        }
        let key = slot_target_key(&provider_id, &model, &base);
        if !seen.insert(key) {
            continue;
        }
        let kind = resolve_slot_kind(fb, parent_kind, providers);
        out.push((model, base, keys, provider_id, kind));
    }
    out
}

