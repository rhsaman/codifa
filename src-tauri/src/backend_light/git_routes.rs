use super::*;

pub(super) fn git_response(result: Result<Value, git::GitError>) -> Response<Body> {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(git::GitError(msg)) => bad_request(&msg),
    }
}

// ---------- git handlers ----------

#[derive(serde::Deserialize)]
pub(super) struct RootQuery {
    root: String,
}

#[derive(serde::Deserialize)]
pub(super) struct DiffQuery {
    root: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
    /// Lift the diff byte cap — the Review panel needs every file's diff; a
    /// capped aggregate strands the tail files as +0 -0 ghosts.
    #[serde(default)]
    full: bool,
}

#[derive(serde::Deserialize)]
pub(super) struct LogQuery {
    root: String,
    #[serde(default = "default_log_limit")]
    limit: u32,
}

pub(super) fn default_log_limit() -> u32 {
    20
}

#[derive(serde::Deserialize)]
pub(super) struct ShowQuery {
    root: String,
    #[serde(default = "default_rev")]
    rev: String,
    #[serde(default)]
    path: String,
    /// Lift the byte cap for the Review panel's committed view (same reason
    /// as DiffQuery::full).
    #[serde(default)]
    full: bool,
}

pub(super) fn default_rev() -> String {
    "HEAD".into()
}

pub(super) async fn git_status(Query(q): Query<RootQuery>) -> Response<Body> {
    // The renderer hits this route the moment a chat is opened (and on every
    // workspace switch), long before the first tool call. Starting the language
    // servers here moves the whole cold start — spawn + `initialize` + crate
    // graph load, minutes on a large workspace — into the user's own typing
    // time, so the first `lsp_*` call of the turn usually finds a warm server.
    // Pre-warming at turn start was too late to ever be warm. Cheap no-op after
    // the first call per project (see `lsp::prewarm`).
    crate::lsp::prewarm(&q.root);
    git_response(git::status(&q.root))
}

pub(super) async fn git_diff(Query(q): Query<DiffQuery>) -> Response<Body> {
    // Same early trigger as `/git/status`: the renderer calls this on every chat
    // switch, so the language servers start loading before the turn does.
    crate::lsp::prewarm(&q.root);
    git_response(if q.full {
        git::diff_full(&q.root, &q.path, q.staged)
    } else {
        git::diff(&q.root, &q.path, q.staged)
    })
}

pub(super) async fn git_log(Query(q): Query<LogQuery>) -> Response<Body> {
    // Early trigger too — the renderer opens the log panel on a chat switch.
    crate::lsp::prewarm(&q.root);
    git_response(git::log(&q.root, q.limit))
}

pub(super) async fn git_show(Query(q): Query<ShowQuery>) -> Response<Body> {
    git_response(if q.full {
        git::show_full(&q.root, &q.rev, &q.path)
    } else {
        git::show(&q.root, &q.rev, &q.path)
    })
}

pub(super) async fn git_commit(Json(body): Json<git::CommitBody>) -> Response<Body> {
    git_response(git::commit(&body.root, &body.message, body.add_all))
}

// ---------- native /git/autocommit ----------

/// Body of a "commit with an AI-written message" request. The renderer sends
/// `provider` as the provider KIND (custom/anthropic/openai/…), matching the
/// other provider-scoped endpoints.
#[derive(serde::Deserialize)]
pub struct GitAutoCommitBody {
    #[serde(default)]
    pub root: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// Main-model reasoning effort + capability flag (the commit message is a
    /// main-model-quality call, so it uses the chat's level, not a slot's).
    #[serde(default)]
    pub thinking_level: String,
    #[serde(default)]
    pub model_reasoning: bool,
    /// Provider rows, so the level is checked against the list a source really
    /// enumerated for this model before it is sent.
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
    /// The chat's OWN model identity — what a "Main model" rung in the tool's
    /// fallback list stands for. `provider`/`model`/… above carry the commit's
    /// PRIMARY pick (the Other group's model), which is not the chat model when
    /// the group names one. Empty `main_model` = the primary pick IS the chat's.
    #[serde(default)]
    pub main_provider: String,
    #[serde(default)]
    pub main_provider_id: String,
    #[serde(default)]
    pub main_model: String,
    #[serde(default)]
    pub main_base_url: String,
    #[serde(default)]
    pub main_api_keys: Vec<String>,
    /// Tool Models + per-tool fallback lists (Settings → Tools). The commit
    /// message runs on the "Other" group, so it walks that group's own list when
    /// its model fails — same chain the title and compact calls use.
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub tool_fallbacks: std::collections::HashMap<String, Vec<String>>,
}

/// How many times the WHOLE commit-message model list is walked top to bottom.
/// After the last fallback fails the walk starts over from the first model (a
/// provider that was down a minute ago is often back). A list of one model is
/// not rotated. Mirrors `COMPACT_MAX_CYCLES` in compact.rs.
pub(super) const COMMIT_MAX_CYCLES: usize = 3;

/// Pause between two passes over the list, so dead rungs are not hammered.
/// The ONLY pause in the walk — a failing rung hands the call to the next
/// model immediately.
pub(super) const COMMIT_CYCLE_PAUSE_SECS: u64 = 10;

/// Stage everything, ask the model for a Conventional-Commits message from the
/// real diff, and commit with it. Runs natively: the renderer's Commit button
/// called `/git/autocommit`, which had no route after the Python sidecar was
/// removed, so it always failed.
pub(super) async fn git_autocommit(Json(body): Json<GitAutoCommitBody>) -> Response<Body> {
    let root = body.root.trim().to_string();
    if root.is_empty() {
        return bad_request("root is required");
    }
    // Stage first so the prompt describes exactly what will be committed.
    if let Err(git::GitError(msg)) = git::stage_all(&root) {
        return bad_request(&msg);
    }
    let status = match git::status(&root) {
        Ok(v) => v,
        Err(git::GitError(msg)) => return bad_request(&msg),
    };
    if status["entries"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        return bad_request("nothing to commit");
    }
    let diff = match git::diff(&root, "", true) {
        Ok(v) => v["diff"].as_str().unwrap_or("").to_string(),
        Err(git::GitError(msg)) => return bad_request(&msg),
    };
    if body.model.trim().is_empty() {
        return bad_request(
            "no model selected for the commit message (Settings → Tools → Compact model)",
        );
    }
    let mut keys = body.api_keys.clone();
    if keys.is_empty() && !body.api_key.trim().is_empty() {
        keys.push(body.api_key.clone());
    }
    // Mirror the CHAT path exactly: no temperature, no max_tokens. Sending
    // `temperature: 0.2` + `max_tokens: 512` here was the reason the Commit
    // button returned 400 while chatting worked fine — a reasoning model
    // rejects a non-default temperature, and with a 512-token cap it spends
    // the whole budget on its thinking block and returns EMPTY content, which
    // this handler then reports as "the model returned an empty commit
    // message". The chat path passes both as None (see agent.rs's LlmConfig),
    // so the provider's own defaults apply.
    let (r_level, r_model, r_auto) = crate::llm::reasoning_fields(
        &body.provider,
        &crate::llm::level_from_source(
            crate::agent::provider_model_thinking_levels(
                &body.providers,
                &body.provider_id,
                &body.model,
            )
            .as_deref(),
            &body.thinking_level,
        ),
        body.model_reasoning,
    );
    let cfg = LlmConfig {
        provider: body.provider.clone(),
        headers: crate::llm::custom_headers(&body.providers, &body.provider_id),
        provider_id: body.provider_id.clone(),
        model: body.model.clone(),
        base_url: body.base_url.clone(),
        api_keys: keys,
        temperature: None,
        max_tokens: None,
        // Inert today (llm.rs applies no request timeout on purpose); kept so
        // the struct stays fully populated.
        timeout_secs: crate::llm::NO_TIMEOUT_SECS,
        reasoning_level: r_level,
        model_reasoning: r_model,
        auto_think: r_auto,
    };
    const SYSTEM: &str = "You write git commit messages. Reply with ONLY the commit message: \
a Conventional-Commits subject line (type(scope): summary), at most 72 characters, \
then an optional blank line and 1-4 bullet points. Describe what the diff ACTUALLY does. \
No code fences, no quotes, no preamble, no trailing explanation.";
    let client = llm::http_client();
    let user = format!(
        "Staged changes (git status --porcelain):\n{status}\n\nDiff:\n{diff}",
        status = serde_json::to_string(&status["entries"]).unwrap_or_default()
    );
    // Try order: the commit's own model (rung 0, exactly what the renderer
    // picked), then the "Other" group's fallback list (Settings → Tools) in the
    // order the user arranged it — and NOTHING else, like title/compact. Rebuilt
    // per call, so the next commit starts at the first model again. The chain is
    // resolved through `resolve_slot_chain`, so a fallback routes cross-provider
    // (its own base URL, keys and endpoint kind); a rung that resolves to a model
    // already in the list is dropped.
    let (p_kind, p_model, p_base, p_keys, p_pid) = if body.main_model.trim().is_empty() {
        (
            body.provider.clone(),
            body.model.clone(),
            body.base_url.clone(),
            cfg.api_keys.clone(),
            body.provider_id.clone(),
        )
    } else {
        (
            if body.main_provider.trim().is_empty() {
                body.provider.clone()
            } else {
                body.main_provider.clone()
            },
            body.main_model.clone(),
            body.main_base_url.clone(),
            body.main_api_keys.clone(),
            body.main_provider_id.clone(),
        )
    };
    let slot_rungs = resolve_slot_chain(
        other_slot_entry(&body.subagent_models),
        other_slot_fallbacks(&body.tool_fallbacks),
        &p_model,
        &p_base,
        &p_keys,
        &p_pid,
        &p_kind,
        &body.providers,
    );
    let mut chain: Vec<LlmConfig> = vec![cfg];
    for (m, b, k, pid, kind) in slot_rungs {
        if m.trim().is_empty() || chain.iter().any(|c| c.provider_id == pid && c.model == m) {
            continue;
        }
        // Each rung inherits the commit's reasoning level, re-checked against
        // ITS OWN model's enumerated levels: a fallback changes the model and
        // its routing, never the effort the user chose.
        let (lvl, mr, auto) = crate::llm::reasoning_fields(
            &kind,
            &crate::llm::level_from_source(
                crate::agent::provider_model_thinking_levels(&body.providers, &pid, &m)
                    .as_deref(),
                &body.thinking_level,
            ),
            crate::agent::provider_model_reasoning(&body.providers, &pid, &m),
        );
        chain.push(LlmConfig {
            provider: kind,
            headers: crate::llm::custom_headers(&body.providers, &pid),
            provider_id: pid,
            model: m,
            base_url: b,
            api_keys: k,
            temperature: None,
            max_tokens: None,
            timeout_secs: crate::llm::NO_TIMEOUT_SECS,
            reasoning_level: lvl,
            model_reasoning: mr,
            auto_think: auto,
        });
    }
    // Walk the list top to bottom; after the last rung fails, start over from the
    // first (see COMMIT_MAX_CYCLES). No wall-clock cap: a model that is thinking
    // must never be cut off, so only a real failure moves the walk on.
    let cycles = if chain.len() > 1 { COMMIT_MAX_CYCLES } else { 1 };
    let mut first_error = String::new();
    let mut tried: Vec<String> = Vec::new();
    let mut done = None;
    'walk: for cycle in 0..cycles {
        if cycle > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(COMMIT_CYCLE_PAUSE_SECS)).await;
        }
        for c in &chain {
            let why = match llm::complete(&client, c, SYSTEM, &user).await {
                Ok(r) if !r.text.trim().is_empty() => {
                    done = Some((r, c));
                    break 'walk;
                }
                // Reasoning models can burn the whole budget on the thinking
                // block and return empty content; log it so rust.log shows the
                // cause.
                Ok(_) => "the model returned an empty commit message".to_string(),
                Err(e) => e,
            };
            let label = if c.provider_id.is_empty() {
                c.model.clone()
            } else {
                format!("{}/{}", c.provider_id, c.model)
            };
            eprintln!("[git] commit message failed ({label}): {why}");
            // Only the FIRST pass is reported: later passes repeat the same
            // models and would bury the reasons.
            if cycle == 0 {
                if first_error.is_empty() {
                    first_error = why.clone();
                }
                tried.push(format!("{label}: {why}"));
            }
        }
    }
    let Some((mut summary, used)) = done else {
        // One model: its own reason, unchanged. A list: name every model that
        // was tried, so a banner can no longer hide a fallback list that ran
        // and failed.
        return bad_request(&if chain.len() > 1 {
            format!("every commit-message model failed — {}", tried.join("; "))
        } else {
            first_error
        });
    };
    // Attribute the usage to the rung that ACTUALLY answered, not to rung 0.
    let usage = normalize_compact_usage(summary.usage.take(), &used.model, &used.provider_id);
    let summary = summary.text.trim().to_string();
    // Strip a code fence if the model wrapped the message anyway.
    let message = summary
        .trim()
        .trim_start_matches("```")
        .trim_start_matches(|c: char| c.is_alphabetic())
        .trim()
        .trim_end_matches("```")
        .trim()
        .to_string();
    let message = if message.is_empty() { summary } else { message };
    match git::commit(&root, &message, false) {
        Ok(v) => {
            let mut out = v;
            out["message"] = json!(message);
            // Token usage of the message call, so the renderer's usage accrual
            // (sidebar → Model usage) sees it, exactly like /chat/compact.
            out["usage"] = usage.unwrap_or(Value::Null);
            Json(out).into_response()
        }
        Err(git::GitError(msg)) => bad_request(&msg),
    }
}

pub(super) async fn git_discard(Json(body): Json<git::CommitBody>) -> Response<Body> {
    let _ = body.message;
    git_response(git::discard(&body.root))
}

pub(super) async fn git_branches(Query(q): Query<RootQuery>) -> Response<Body> {
    git_response(git::branches(&q.root))
}

pub(super) async fn git_checkout(Json(body): Json<git::CheckoutBody>) -> Response<Body> {
    git_response(git::checkout(&body.root, &body.branch, body.create))
}

pub(super) async fn git_push(Json(body): Json<git::PushBody>) -> Response<Body> {
    git_response(git::push(&body.root, &body.remote, &body.branch, body.set_upstream))
}

// ---------- /ws/events: live git + file-change push ----------
//
// The client registers the roots it renders (review panel, code-file
// viewers, files tree) by sending {"roots":[..]} on the socket. A 1.5s beat
// hashes `git status --porcelain` per root and pushes ONE event when the
// fingerprint changes:
//   {"kind":"change","root":"..","files":["a.ts", ..]}
// `files` lists every path porcelain reported (tracked changes + untracked
// files), which covers both the git views and open code-file viewers. No
// `notify` crate: the fingerprint IS the change detector.

