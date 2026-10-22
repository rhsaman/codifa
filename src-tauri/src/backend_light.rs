//! The app's native HTTP API.
//!
//! Owns the loopback port the renderer talks to. Every endpoint is served by
//! Rust — there is no sidecar and no proxy: git, skills, mcp, chat streaming,
//! docs, media, plans, schedules, the browser session and the agent loop all
//! live in this process.

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{Request, Response, StatusCode};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::agent;
use crate::compact;
use crate::git;
use crate::llm::{self, LlmConfig};
use crate::skills;
use crate::state::get_data_root;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio_stream::wrappers::UnboundedReceiverStream;

/// The public router's URL, mirrored into a global so `sidecar_url` (which
/// runs on arbitrary threads) can hand it to the renderer.
static PUBLIC_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The public base URL the renderer should use, once the router is up.
pub fn public_url() -> Option<String> {
    PUBLIC_URL.lock().unwrap().clone()
}

/// Bind the public router port and serve until the process exits.
pub fn serve(app: tauri::AppHandle) -> Result<(), String> {
    let data_root = get_data_root(&app);
    // Bind inside the tokio runtime: registering a blocking std listener
    // with tokio panics (tokio#7172).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let url = format!("http://127.0.0.1:{port}");
        *PUBLIC_URL.lock().unwrap() = Some(url.clone());
        eprintln!("[router] public endpoint: {url}");
        axum::serve(listener, router(new_state(data_root)))
            .await
            .map_err(|e| e.to_string())
    })
}

#[derive(Clone)]
pub struct AppState {
    /// Resolved data root (~/.codifa) for the native file-backed endpoints.
    ///
    /// Kept in sync with a data-path move: the move command writes the new root
    /// through `state::set_data_root`, and every handler reads the live value
    /// via `Self::root()` instead of this snapshot.
    pub data_root: PathBuf,
}

impl AppState {
    /// The CURRENT data root.
    ///
    /// The router runs on its own tokio runtime with no `AppHandle`, so it
    /// cannot ask Tauri for the root. `state::current_data_root()` is the
    /// process-global mirror the app keeps updated (a Settings → Data path move
    /// changes it); this snapshot is only the fallback for the window between
    /// router startup and the first mirror write.
    pub fn root(&self) -> PathBuf {
        crate::state::current_data_root().unwrap_or_else(|| self.data_root.clone())
    }
}

pub fn new_state(data_root: PathBuf) -> AppState {
    AppState { data_root }
}

/// Native error body: JSON `{"detail": …}`, the shape the renderer reads
/// (`body.detail`). A plain-text body made the renderer fall back to a generic
/// "<op> failed (400)" and swallowed the real reason — e.g. the commit button
/// showed "autocommit failed (400)" instead of "nothing to commit" or the
/// provider's own rejection, so the cause was invisible to the user.
fn bad_request(msg: &str) -> Response<Body> {
    (StatusCode::BAD_REQUEST, Json(json!({ "detail": msg }))).into_response()
}

// --- model probe (native; replaces the sidecar's /models/test) --------------

/// Total budget for one probe (mirrors the sidecar's MODEL_TEST_TIMEOUT).
const MODEL_TEST_TIMEOUT_SECS: u64 = 15;
/// Client-side cap, smaller than the budget so the real provider error wins.
const MODEL_TEST_CLIENT_TIMEOUT_SECS: u64 = 12;
/// Chat-representative reservation so a provider's quota pre-check behaves
/// like a real turn: a tiny cap can pass while the chat's 32K reservation
/// fails with 402, producing a false tick. Actual burn stays ~1 token.
const MODEL_TEST_MAX_TOKENS: u32 = 32_000;
/// Probes in flight per batch round (the sidecar used a semaphore of 10).
const MODEL_TEST_BATCH_CONCURRENCY: usize = 10;

/// Body of POST /models/test and /models/test-batch.
#[derive(serde::Deserialize)]
pub struct ModelTestBody {
    #[serde(default = "default_provider")]
    provider: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_keys: Vec<String>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    models: Vec<String>,
}

/// Probe one model with a tiny completion; returns the reply or the reason.
///
/// Uses the same one-shot path as a real turn, so the probe exercises the
/// exact provider+model the picker shows.
async fn probe_model(body: &ModelTestBody, model: &str) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("no model selected".into());
    }
    let mut keys = body.api_keys.clone();
    if keys.is_empty() {
        // Keyless local endpoints (ollama / llama.cpp) still answer; the
        // sidecar sent an empty key rather than refusing the probe.
        keys.push(String::new());
    }
    let (r_level, r_model, r_auto) = crate::llm::reasoning_fields(&body.provider, "", false);
    let cfg = LlmConfig {
        provider: body.provider.clone(),
        model: model.to_string(),
        base_url: body.base_url.clone(),
        api_keys: keys,
        temperature: None,
        max_tokens: Some(MODEL_TEST_MAX_TOKENS),
        timeout_secs: MODEL_TEST_CLIENT_TIMEOUT_SECS,
        reasoning_level: r_level,
        model_reasoning: r_model,
        auto_think: r_auto,
    };
    let client = llm::http_client();
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(MODEL_TEST_TIMEOUT_SECS),
        llm::complete(&client, &cfg, "", "Reply with the single word: OK"),
    )
    .await
    .map_err(|_| format!("timeout — model did not answer in {MODEL_TEST_TIMEOUT_SECS}s"))?;
    let text = res?.text.trim().to_string();
    if text.is_empty() {
        return Err(
            "empty reply — model returned no content (quota exhausted or route unavailable)"
                .into(),
        );
    }
    Ok(text.chars().take(200).collect())
}

/// POST /models/test — probe one model with a tiny completion.
pub async fn models_test(Json(body): Json<ModelTestBody>) -> Response<Body> {
    match probe_model(&body, &body.model).await {
        Ok(reply) => Json(json!({ "ok": true, "reply": reply })).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "detail": err })),
        )
            .into_response(),
    }
}

/// POST /models/test-batch — probe many models, one HTTP round trip.
pub async fn models_test_batch(Json(body): Json<ModelTestBody>) -> Response<Body> {
    let models: Vec<String> = body
        .models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .take(100)
        .collect();
    if models.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "detail": "no models selected" })),
        )
            .into_response();
    }
    // Bounded concurrency: a 100-model group test must not open 100 sockets.
    let mut results: Vec<Value> = Vec::with_capacity(models.len());
    // Borrow the body once, outside the closures: an `async move` block would
    // otherwise capture `body` by value and the first iteration would move it
    // out of the FnMut closure.
    let body_ref = &body;
    for chunk in models.chunks(MODEL_TEST_BATCH_CONCURRENCY) {
        let part = futures_util::future::join_all(chunk.iter().map(|m| {
            // The async block outlives the loop body, so it must own its model
            // name instead of borrowing it from `chunk`.
            let model = m.clone();
            async move {
                match probe_model(body_ref, &model).await {
                    Ok(reply) => json!({ "model": model, "ok": true, "reply": reply }),
                    Err(error) => json!({ "model": model, "ok": false, "error": error }),
                }
            }
        }))
        .await;
        results.extend(part);
    }
    Json(json!({ "results": results })).into_response()
}

fn git_response(result: Result<Value, git::GitError>) -> Response<Body> {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(git::GitError(msg)) => bad_request(&msg),
    }
}

// ---------- git handlers ----------

#[derive(serde::Deserialize)]
struct RootQuery {
    root: String,
}

#[derive(serde::Deserialize)]
struct DiffQuery {
    root: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
}

#[derive(serde::Deserialize)]
struct LogQuery {
    root: String,
    #[serde(default = "default_log_limit")]
    limit: u32,
}

fn default_log_limit() -> u32 {
    20
}

#[derive(serde::Deserialize)]
struct ShowQuery {
    root: String,
    #[serde(default = "default_rev")]
    rev: String,
    #[serde(default)]
    path: String,
}

fn default_rev() -> String {
    "HEAD".into()
}

async fn git_status(Query(q): Query<RootQuery>) -> Response<Body> {
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

async fn git_diff(Query(q): Query<DiffQuery>) -> Response<Body> {
    // Same early trigger as `/git/status`: the renderer calls this on every chat
    // switch, so the language servers start loading before the turn does.
    crate::lsp::prewarm(&q.root);
    git_response(git::diff(&q.root, &q.path, q.staged))
}

async fn git_log(Query(q): Query<LogQuery>) -> Response<Body> {
    // Early trigger too — the renderer opens the log panel on a chat switch.
    crate::lsp::prewarm(&q.root);
    git_response(git::log(&q.root, q.limit))
}

async fn git_show(Query(q): Query<ShowQuery>) -> Response<Body> {
    git_response(git::show(&q.root, &q.rev, &q.path))
}

async fn git_commit(Json(body): Json<git::CommitBody>) -> Response<Body> {
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
}

/// Stage everything, ask the model for a Conventional-Commits message from the
/// real diff, and commit with it. Runs natively: the renderer's Commit button
/// called `/git/autocommit`, which had no route after the Python sidecar was
/// removed, so it always failed.
async fn git_autocommit(Json(body): Json<GitAutoCommitBody>) -> Response<Body> {
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
    let (r_level, r_model, r_auto) =
        crate::llm::reasoning_fields(&body.provider, body.thinking_level.trim(), body.model_reasoning);
    let cfg = LlmConfig {
        provider: body.provider.clone(),
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
    let mut summary = match llm::complete(&client, &cfg, SYSTEM, &user).await {
        Ok(r) if !r.text.trim().is_empty() => r,
        Ok(_) => {
            // Reasoning models can burn the whole budget on the thinking block
            // and return empty content; log it so rust.log shows the cause.
            eprintln!(
                "[git] empty commit message from {}/{}",
                cfg.provider, cfg.model
            );
            return bad_request("the model returned an empty commit message");
        }
        Err(e) => {
            eprintln!("[git] commit message failed ({}/{}): {e}", cfg.provider, cfg.model);
            return bad_request(&e);
        }
    };
    let usage = normalize_compact_usage(summary.usage.take(), &cfg.model, &body.provider_id);
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

async fn git_discard(Json(body): Json<git::CommitBody>) -> Response<Body> {
    let _ = body.message;
    git_response(git::discard(&body.root))
}

async fn git_branches(Query(q): Query<RootQuery>) -> Response<Body> {
    git_response(git::branches(&q.root))
}

async fn git_checkout(Json(body): Json<git::CheckoutBody>) -> Response<Body> {
    git_response(git::checkout(&body.root, &body.branch, body.create))
}

async fn git_push(Json(body): Json<git::PushBody>) -> Response<Body> {
    git_response(git::push(&body.root, &body.remote, &body.branch, body.set_upstream))
}

// ---------- skills / mcp (native) + system-prompts (native appstate) ----------

async fn skills_list(State(st): State<AppState>) -> Response<Body> {
    Json(skills::list_skills(&st.root())).into_response()
}

/// Every skill the agent can actually load: the standalone store PLUS the
/// skills of every ENABLED plugin (`skill_router::load_skills` — the same call
/// the prompt catalog is built from).
///
/// Kept off `/skills` on purpose: Settings edits and deletes whatever that
/// route returns, and a plugin's skill belongs to its bundle (it disappears
/// with the plugin). This route exists so the composer can offer a plugin skill
/// as its own `/`-command — the name the plugin's install message tells the
/// user to type.
async fn skills_available(State(st): State<AppState>) -> Response<Body> {
    let root = st.root();
    let rows = crate::skill_router::load_skills(&root.to_string_lossy());
    Json(json!({ "skills": rows })).into_response()
}

#[derive(serde::Deserialize)]
struct SkillFileQuery {
    name: String,
    file: String,
}

async fn skills_file(State(st): State<AppState>, Query(q): Query<SkillFileQuery>) -> Response<Body> {
    // A plugin's skills are served from the plugin folder, so resolve that first
    // — otherwise an extra file of a plugin skill 404s while its skill.md loads.
    let root = st.root();
    let read = match crate::plugins::plugin_of_skill(&root, &q.name)
        .and_then(|slug| crate::plugins::find_skill_dir(&root, &slug, &q.name))
    {
        Some(dir) => skills::read_extra_file(&dir, &q.name, &q.file),
        None => skills::read_skill_file(&root, &q.name, &q.file),
    };
    match read {
        Ok(v) => Json(v).into_response(),
        // JSON `detail` like every other native error: the renderer reads that
        // key, so a plain-text body would be replaced by a generic message.
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

async fn skills_sync(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::sync_skill(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn mcp_list(State(st): State<AppState>) -> Response<Body> {
    Json(skills::list_mcp(&st.root())).into_response()
}

async fn mcp_save(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::save_mcp(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn mcp_delete(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::delete_mcp(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

// ---------- plugins (skills + connectors as one switchable bundle) ----------

async fn plugins_list(State(st): State<AppState>) -> Response<Body> {
    Json(crate::plugins::list_plugins(&st.root())).into_response()
}

async fn plugins_create(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::create_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn plugins_update(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::update_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn plugins_toggle(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::toggle_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn plugins_delete(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match crate::plugins::delete_plugin(&st.root(), &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

/// Install a bundle from a repo. Reading the repo is blocking (git-less HTTP on
/// a plain thread), so the handler stays off the async worker.
async fn plugins_install(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match tokio::task::spawn_blocking(move || crate::plugins::install_plugin(&st.root(), &body))
        .await
    {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(msg)) => bad_request(&msg),
        Err(e) => bad_request(&format!("install failed: {e}")),
    }
}

/// Latest saved body of one artifact — the preview tab reads it after a restart
/// (the transcript only carries the card's id/title/kind/content).
async fn artifact_get(State(st): State<AppState>, Query(q): Query<ArtifactQuery>) -> Response<Body> {
    match crate::artifacts::read(&st.root(), &q.chat_id, &q.id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

/// Delete one artifact (every saved version) from the Artifacts page.
async fn artifact_delete(
    State(st): State<AppState>,
    Query(q): Query<ArtifactQuery>,
) -> Response<Body> {
    match crate::artifacts::delete(&st.root(), &q.chat_id, &q.id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ArtifactQuery {
    #[serde(default)]
    chat_id: String,
    id: String,
}

/// `/artifacts/list` takes `chat_id` alone (no `id`) — its own struct, so the
/// `id` requirement of `/artifacts/get` stays enforced there.
#[derive(serde::Deserialize)]
struct ArtifactListQuery {
    #[serde(default)]
    chat_id: String,
}

/// Every saved artifact (newest first) for the Artifacts page: one chat's when
/// `chat_id` is given, every chat's otherwise. Only the indexes are read — the
/// page lists titles, it does not load the documents.
async fn artifact_list(
    State(st): State<AppState>,
    Query(q): Query<ArtifactListQuery>,
) -> Response<Body> {
    match crate::artifacts::list(&st.root(), &q.chat_id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "detail": msg }))).into_response(),
    }
}

// ---------- native /chat/compact (phase 3-1) ----------

#[derive(serde::Deserialize)]
struct CompactBody {
    #[serde(default = "default_provider")]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    api_keys: Vec<String>,
    #[serde(default)]
    fallback_provider: String,
    #[serde(default)]
    fallback_model: String,
    #[serde(default)]
    fallback_base_url: String,
    #[serde(default)]
    fallback_api_key: String,
    /// The chat provider's ordered key list. The renderer sends this PLURAL form
    /// on every other route; without it declared here the field was silently
    /// dropped and the appended chat-model rung fell back to the summariser
    /// slot's keys — a different provider's key against the chat's endpoint,
    /// which is a guaranteed "Invalid API key" 401.
    #[serde(default)]
    fallback_api_keys: Vec<String>,
    /// Effective provider id of the chat's own provider — the 4th element of
    /// a resolved slot, so cross-provider usage is attributed correctly.
    #[serde(default)]
    provider_id: String,
    /// Main-model reasoning effort + capability flag, and the per-slot
    /// overrides (the "compact" entry wins when present).
    #[serde(default)]
    thinking_level: String,
    #[serde(default)]
    model_reasoning: bool,
    #[serde(default)]
    subagent_thinking: std::collections::HashMap<String, String>,
    #[serde(default)]
    history: Vec<Value>,
    #[serde(default)]
    context_window: usize,
    #[serde(default)]
    max_output: usize,
    /// Per-slot sub-agent model overrides (Tool Models settings); the
    /// "compact" slot routes the summarizer to that model/provider.
    #[serde(default)]
    subagent_models: std::collections::HashMap<String, String>,
    /// Per-tool fallback lists from Settings → Tools, keyed by the same slot
    /// names as `subagent_models`; the summariser retries down the "Other"
    /// group's own list when its model fails.
    #[serde(default)]
    tool_fallbacks: std::collections::HashMap<String, Vec<String>>,
    /// Full provider configs keyed by id for cross-provider slots.
    #[serde(default)]
    providers: std::collections::HashMap<String, Value>,
}

fn default_provider() -> String {
    "custom".into()
}

/// Resolve a Tool Models slot entry ("providerId/model" | bare model | "")
/// to (model, base_url, api_keys, provider_id) — shared by the compact and
/// sub-agent slots; mirrors graph.py resolve_subagent_model. The returned
/// provider id is the EFFECTIVE one (the provider actually called), so usage
/// events and the Model-usage panel attribute tokens to the right provider.
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
    let (provider_id, model) = match entry.split_once('/') {
        Some((pid, m)) => (pid.trim(), m.trim()),
        None => ("", entry),
    };
    if provider_id.is_empty() {
        return (
            model.to_string(),
            parent_base.to_string(),
            parent_keys.to_vec(),
            parent_provider_id.to_string(),
        );
    }
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
    let entry = entry.trim();
    let Some((provider_id, _)) = entry.split_once('/') else {
        return parent_kind.to_string();
    };
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
fn slot_target_key(
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

/// Normalize the raw provider usage object to the frontend's CompactUsage
/// shape. Providers use different key families (OpenAI: prompt_tokens /
/// completion_tokens, Anthropic: input_tokens / output_tokens, Gemini:
/// promptTokenCount / candidatesTokenCount) — the frontend reads
/// input_tokens/output_tokens, so unmapped keys accrued as 0/0 and the
/// Model usage panel showed nothing after a compact.
fn normalize_compact_usage(
    raw: Option<Value>,
    model: &str,
    provider_id: &str,
) -> Option<Value> {
    let obj = raw?.as_object()?.clone();
    let num = |k: &str| obj.get(k).and_then(|v| v.as_u64());
    let input = num("input_tokens")
        .or_else(|| num("prompt_tokens"))
        .or_else(|| num("promptTokenCount"));
    let output = num("output_tokens")
        .or_else(|| num("completion_tokens"))
        .or_else(|| num("candidatesTokenCount"));
    let cache_read = num("cache_read_tokens").or_else(|| num("cache_read_input_tokens"));
    let cache_write =
        num("cache_write_tokens").or_else(|| num("cache_creation_input_tokens"));
    let mut norm = serde_json::Map::new();
    norm.insert("input_tokens".into(), json!(input.unwrap_or(0)));
    norm.insert("output_tokens".into(), json!(output.unwrap_or(0)));
    if let Some(v) = cache_read {
        norm.insert("cache_read_tokens".into(), json!(v));
    }
    if let Some(v) = cache_write {
        norm.insert("cache_write_tokens".into(), json!(v));
    }
    // The model that ACTUALLY ran the summarizer (the compact slot may
    // route cross-provider) — the frontend groups usage under it. The
    // effective provider id rides along so the panel does not fall back to
    // the parent's chat provider for a cross-provider compact.
    norm.insert("model".into(), json!(model));
    if !provider_id.is_empty() {
        norm.insert("provider_id".into(), json!(provider_id));
    }
    Some(Value::Object(norm))
}

/// Stream one JSON payload as an SSE frame. A closed channel just means the
/// renderer aborted (Stop / timeout) — nothing to do.
fn send_compact_frame(
    tx: &tokio::sync::mpsc::UnboundedSender<Result<axum::body::Bytes, std::io::Error>>,
    payload: Value,
) {
    let _ = tx.send(Ok(axum::body::Bytes::from(format!("data: {payload}\n\n"))));
}

/// One progress frame. Tagged with `compact_progress` so the renderer can tell it
/// apart from the final result (`summary`), since both arrive on this stream.
fn compact_progress_frame(p: &crate::compact::CompactProgress) -> Value {
    json!({
        "compact_progress": true,
        "phase": p.phase,
        "attempt": p.attempt,
        "attempts": p.attempts_total,
        "model": p.model,
        "percent": p.percent,
        "budget_secs": p.budget_secs,
        "elapsed_secs": p.elapsed_secs,
    })
}

/// Manual `/compact`. Streams the summarizer's progress as SSE and finishes with
/// one result frame, so the renderer can show a live phase/elapsed bar instead of
/// waiting blindly on a JSON body that says nothing until the very end.
async fn chat_compact(Json(body): Json<CompactBody>) -> Response<Body> {
    let (tx, rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<axum::body::Bytes, std::io::Error>>();
    tokio::spawn(async move {
        compact_worker(body, &tx).await;
        // Dropping `tx` closes the stream: the renderer treats a closed stream
        // that never produced a result frame as a failed compact.
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "stream build failed").into_response()
        })
}

async fn compact_worker(
    body: CompactBody,
    tx: &tokio::sync::mpsc::UnboundedSender<Result<axum::body::Bytes, std::io::Error>>,
) {
    if body.history.is_empty() {
        send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": "no messages to compact" }),
        );
        return;
    }
    let client = llm::http_client();
    // The "Other" Tool Models group overrides the summarizer model ("compact",
    // "web" and "title" share one settings row, so the pick may live under any
    // of them; "providerId/model" routes cross-provider, empty = the chat
    // model). Reading only the `compact` key left the row's model unused.
    let other_entry = other_slot_entry(&body.subagent_models);
    let (model_name, base_url, api_keys, slot_provider_id) = resolve_slot_target(
        other_entry,
        &body.model,
        &body.base_url,
        &{
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
        &body.provider_id,
        &body.providers,
    );
    // The compact slot may carry its own reasoning level; an empty entry
    // inherits the main model's. The finding is derived from the slot's OWN
    // provider kind, so a cross-provider summarizer is invoked like a native
    // call to that provider would be.
    let compact_entry = other_entry;
    let slot_kind = resolve_slot_kind(compact_entry, &body.provider, &body.providers);
    let compact_level = other_slot_level(&body.subagent_thinking);
    let level = if compact_level.is_empty() {
        // Missing/empty slot level = OFF (send no reasoning param). Tool slots
        // do NOT inherit the main model's level — their default is none.
        "none"
    } else {
        compact_level
    };
    let (r_level, r_model, r_auto) =
        crate::llm::reasoning_fields(&slot_kind, level, body.model_reasoning);
    let model = LlmConfig {
        provider: slot_kind,
        model: model_name.clone(),
        base_url,
        api_keys,
        temperature: Some(0.2),
        max_tokens: Some(4096),
        timeout_secs: 90,
        reasoning_level: r_level.clone(),
        model_reasoning: r_model,
        auto_think: r_auto,
    };
    // The retry rungs this compaction may use after its own model fails. Which
    // one is handed to the summariser is decided by whether the caller sent a
    // chat-model fallback (an interactive turn always does; the mid-turn fold
    // and a headless scheduled run may not).
    let rungs: Vec<(String, String, Vec<String>, String, String)> = resolve_slot_chain(
        other_entry,
        other_slot_fallbacks(&body.tool_fallbacks),
        &body.model,
        &body.base_url,
        &{
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
        &body.provider_id,
        &body.provider,
        &body.providers,
    )
    .into_iter()
    .skip(1)
    .collect();
    // The full try order this compaction walks after its own model fails: the
    // "Other" group's own fallback list (Settings → Tools) first, in the user's
    // order, then the chat model as the last resort. `tool_fallbacks` is a
    // per-CALL list — nothing is remembered, so the next compaction starts at the
    // summariser's own model again. Every rung inherits the SLOT's reasoning
    // level: a fallback changes the model and its routing, never the effort the
    // user chose for the tool.
    let mut fallbacks: Vec<LlmConfig> = rungs
        .iter()
        .map(|(m, b, keys, pid, k)| LlmConfig {
            provider: k.clone(),
            model: m.clone(),
            base_url: b.clone(),
            api_keys: keys.clone(),
            temperature: Some(0.2),
            max_tokens: Some(4096),
            timeout_secs: 90,
            reasoning_level: model.reasoning_level.clone(),
            model_reasoning: crate::agent::provider_model_reasoning(&body.providers, pid, m),
            auto_think: crate::models::auto_think_for(k),
        })
        .collect();
    if !body.fallback_model.trim().is_empty() {
        let fb_kind = if body.fallback_provider.is_empty() {
            body.provider.clone()
        } else {
            body.fallback_provider.clone()
        };
        let (fb_level, fb_model, fb_auto) =
            crate::llm::reasoning_fields(&fb_kind, body.thinking_level.trim(), body.model_reasoning);
        fallbacks.push(LlmConfig {
            provider: fb_kind,
            model: body.fallback_model.clone(),
            base_url: if body.fallback_base_url.is_empty() { body.base_url.clone() } else { body.fallback_base_url.clone() },
            api_keys: if !body.fallback_api_keys.is_empty() {
                body.fallback_api_keys.clone()
            } else if !body.fallback_api_key.is_empty() {
                vec![body.fallback_api_key.clone()]
            } else if !body.api_keys.is_empty() {
                // The chat's OWN keys, not the summariser slot's: this rung calls
                // the chat model at the chat endpoint, so a slot key here is a
                // guaranteed 401 that looks like the fallback never ran.
                body.api_keys.clone()
            } else if !body.api_key.is_empty() {
                vec![body.api_key.clone()]
            } else {
                model.api_keys.clone()
            },
            temperature: Some(0.2),
            max_tokens: Some(4096),
            timeout_secs: 90,
            // The chat model keeps the level its own turn would use.
            reasoning_level: fb_level,
            model_reasoning: fb_model,
            auto_think: fb_auto,
        });
    }
    // The summarizer's token budget: the window the user sees, resolved through
    // the same capacity rule as the mid-turn trigger (a bare 0 must not fall back
    // to a private literal — see `resolve_compact_window`).
    let compact_ctx = crate::agent::resolve_compact_window(
        &body.providers,
        &body.provider_id,
        &body.model,
        body.context_window,
    );
    match compact::compact_history_with_progress(
        &client,
        &model,
        &fallbacks,
        &body.history,
        compact_ctx,
        body.max_output,
        true,
        &mut |p: &compact::CompactProgress| send_compact_frame(tx, compact_progress_frame(p)),
    )
    .await
    {
        Ok(Some(out)) => send_compact_frame(
            tx,
            json!({
                "summary": out.summary,
                "keep": out.keep,
                "usage": normalize_compact_usage(out.usage, &model_name, &slot_provider_id),
            }),
        ),
        Ok(None) => send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": "nothing to compact" }),
        ),
        Err(e) => send_compact_frame(
            tx,
            json!({ "summary": Value::Null, "keep": 0, "error": e }),
        ),
    }
}

// ---------- /chat/stream ----------
// Always the native Rust agent loop (agent.rs) — no Python fallback.

/// SSE heartbeat period. The client's stall watchdog reads an SSE stream that
/// goes silent for too long as a dead connection, so the Python sidecar kept
/// the stream alive with `: keepalive` comments every ~15s while the agent was
/// thinking or running a slow tool. The Rust router must do the same: without
/// a heartbeat a long silent stretch (much likelier when two chats share one
/// provider) was aborted as a connection loss.
const SSE_KEEPALIVE_SECS: u64 = 15;

async fn chat_stream_entry(
    State(st): State<AppState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    chat_stream_native(body, st.data_root).await
}

/// POST /chat/steer — deliver a message to a running turn for this chat.
/// Body: `{chat_id, id, prompt, ...}`. Answers `{ok: true}` when the message was
/// queued (a turn is running) and `{ok: false}` when nothing was running, so the
/// renderer re-sends it as the next turn instead of losing it.
async fn chat_steer(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    let id = body.get("id").and_then(Value::as_str).unwrap_or_default().trim();
    let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or_default().trim();
    if chat_id.is_empty() || id.is_empty() || prompt.is_empty() {
        return Json(json!({"ok": false})).into_response();
    }
    let ok = agent::push_steer(chat_id, id, prompt);
    Json(json!({"ok": ok})).into_response()
}

/// POST /chat/steer/cancel — drop a queued steer the user deleted first.
async fn chat_steer_cancel(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    let id = body.get("id").and_then(Value::as_str).unwrap_or_default().trim();
    if !chat_id.is_empty() && !id.is_empty() {
        agent::cancel_steer(chat_id, id);
    }
    Json(json!({"ok": true})).into_response()
}

/// POST /chat/retry_now — force the running explore retry ladder to retry NOW.
///
/// The banner's Retry button used to be a no-op on a LIVE sub-agent retry: the
/// parent turn is still streaming, so the renderer's `send()` is swallowed by
/// its own single-flight guard and the whole last user turn could never be
/// re-sent. Rebooting the turn is the wrong fix anyway — what the user wants is
/// "stop waiting and try that sub-agent call again". This skips the ladder's
/// backoff so the very next attempt runs immediately.
async fn chat_retry_now(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    if chat_id.is_empty() {
        return bad_request("chat_id is required");
    }
    // `ok` is TRUE only when a ladder is actually listening. The renderer shows
    // the click as accepted only then; otherwise it must not pretend the retry
    // happened (the banner outlives its ladder whenever the turn has ended, and
    // a click that nothing consumes is precisely what made the button look
    // dead while the UI still claimed "retrying now (requested)").
    let listening = agent::nudge_subagent_retry(chat_id);
    Json(json!({"ok": true, "listening": listening})).into_response()
}

/// POST /chat/slot_model — push a Tool Models change to the RUNNING turn.
///
/// The turn's request body carries `subagent_models` as a snapshot taken when
/// the renderer called `/chat/stream`, so changing the sub-agent model while it
/// is retrying never reached the ladder: it kept retrying the model the user
/// had just replaced. The renderer now posts every change here, and the ladder
/// re-resolves the slot before its next attempt.
async fn chat_slot_model(Json(body): Json<Value>) -> Response<Body> {
    let slot = body.get("slot").and_then(Value::as_str).unwrap_or_default().trim();
    if slot.is_empty() {
        return bad_request("slot is required");
    }
    // Absent/null model = "parent model", which an empty entry already means.
    let entry = body.get("model").and_then(Value::as_str).unwrap_or_default().trim();
    agent::set_live_slot_entry(slot, entry);
    Json(json!({"ok": true})).into_response()
}

/// Native Rust agent turn streamed as SSE `data: {"kind": ...}` lines —
/// the same event protocol the Python sidecar emits.
async fn chat_stream_native(body: Value, data_root: PathBuf) -> Response<Body> {
    let mut req = match serde_json::from_value::<agent::AgentRequest>(body) {
        Ok(r) => r,
        Err(e) => return bad_request(&format!("invalid agent request: {e}")),
    };
    // The skill store is a data-root directory, not a workspace one: hand the
    // resolved root to the agent so skill routing reads the real store.
    if req.data_root.is_empty() {
        req.data_root = data_root.to_string_lossy().to_string();
    }
    let (tx, rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<axum::body::Bytes, std::io::Error>>();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Watcher: when the client disconnects (Stop button closes the fetch),
    // the stream consumer drops the response body -> the sender side of the
    // last clone goes away. We detect it via a weak handle: once the strong
    // sender count hits zero (all clones dropped), flip the cancel flag so
    // the agent loop bails instead of burning provider tokens.
    let cancel_watcher = std::sync::Arc::clone(&cancel);
    // Weak handle: the watcher must NOT keep the channel alive — a strong
    // clone here meant the sender count never reached zero after run_turn
    // finished, so the SSE stream stayed open after `done` (curl/fetch hung
    // until its own timeout).
    let watch_tx = tx.downgrade();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    // When the client disconnects (Stop button aborts the fetch), the
    // response body — and with it the channel receiver — is dropped, which
    // flips the sender's is_closed(). strong_count() can NEVER reach zero
    // mid-turn (the turn task itself holds a sender), so the old check only
    // fired after the turn finished — Stop did not stop a running explore.
    // WeakUnboundedSender has no is_closed: upgrade temporarily (the turn
    // task keeps strong senders alive, so this succeeds mid-turn) and ask
    // the strong handle whether the receiver is gone.
    let receiver_gone = match watch_tx.upgrade() {
        Some(s) => {
            let closed = s.is_closed();
            drop(s);
            closed
        }
        None => true,
    };
    if receiver_gone {
        cancel_watcher.store(true, std::sync::atomic::Ordering::Relaxed);
        break;
    }
        }
    });
    // Heartbeat emitter. Uses a WEAK handle on purpose: the temporary upgrade
    // lives only inside one tick, so the heartbeat can never keep the body
    // open after the turn ends (a strong clone here left the SSE stream
    // hanging after `done`). `turn_done` is the deterministic exit for the
    // last tick after the turn finished.
    let turn_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ka_tx = tx.downgrade();
    let ka_done = std::sync::Arc::clone(&turn_done);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SSE_KEEPALIVE_SECS)).await;
            if ka_done.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            match ka_tx.upgrade() {
                Some(s) => {
                    let sent = s
                        .send(Ok(axum::body::Bytes::from_static(b": keepalive\n\n")))
                        .is_ok();
                    drop(s);
                    // Send error = the receiver is gone (client disconnected).
                    if !sent {
                        break;
                    }
                }
                // No strong senders left: the turn finished — nothing to keep
                // alive, so exit and let the body complete.
                None => break,
            }
        }
    });
    tokio::spawn(async move {
        let tx_err = tx.clone();
        let done_flag = turn_done;
        let mut emit = move |ev: &agent::AgentEvent| {
            let line = format!("data: {}\n\n", ev.to_json());
            let _ = tx.send(Ok(axum::body::Bytes::from(line)));
        };
        if let Err(e) = agent::run_turn(&req, &mut emit, &cancel).await {
            let payload = serde_json::json!({"kind": "error", "content": e});
            let _ = tx_err.send(Ok(axum::body::Bytes::from(format!(
                "data: {payload}\n\n"
            ))));
            // A fatal turn error is still a TERMINAL state: the protocol
            // requires `done` or the client reports "Connection lost mid-turn"
            // on top of the real error.
            let done = agent::AgentEvent::Done { aborted: false }.to_json();
            let _ = tx_err.send(Ok(axum::body::Bytes::from(format!("data: {done}\n\n"))));
        }
        done_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "stream build failed").into_response()
        })
}

// ---------- plans (native) ----------
// The Python sidecar wrote plan files from graph.py with no HTTP endpoints;
// the native agent owns the same on-disk layout now, and the renderer can
// reload a plan after restart via GET /plan.

#[derive(serde::Deserialize)]
struct PlanSaveBody {
    root: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
}

async fn plan_get(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    match crate::plans::get_plan(&st.root().to_string_lossy(), &ws, &q.chat_id) {
        Some(p) => Json(p).into_response(),
        None => (StatusCode::NOT_FOUND, "no plan").into_response(),
    }
}

async fn plan_save(State(st): State<AppState>, Json(body): Json<PlanSaveBody>) -> Response<Body> {
    if body.root.trim().is_empty() {
        return bad_request("root is required");
    }
    let ws = crate::plans::workspace_slug_for_root(&body.root);
    match crate::plans::save_plan(
        &st.root().to_string_lossy(),
        &ws,
        &body.title,
        &body.content,
        &body.chat_id,
    ) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad_request(&e),
    }
}

async fn plan_delete(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    let removed = crate::plans::delete_plan(&st.root().to_string_lossy(), &ws, &q.chat_id);
    Json(json!({"ok": true, "removed": removed})).into_response()
}

async fn plan_checklist_get(State(st): State<AppState>, Query(q): Query<PlanQuery>) -> Response<Body> {
    let ws = crate::plans::workspace_slug_for_root(&q.root);
    Json(json!({
        "items": crate::plans::get_checklist(&st.root().to_string_lossy(), &ws, &q.chat_id)
    }))
    .into_response()
}

async fn plan_checklist_save(
    State(st): State<AppState>,
    Json(body): Json<PlanChecklistBody>,
) -> Response<Body> {
    if body.root.trim().is_empty() {
        return bad_request("root is required");
    }
    let ws = crate::plans::workspace_slug_for_root(&body.root);
    crate::plans::save_checklist(
        &st.root().to_string_lossy(),
        &ws,
        &body.chat_id,
        &body.items,
    );
    Json(json!({"ok": true})).into_response()
}

/// POST /ask/respond — answer a pending `ask_user` gate.
///
/// The agent turn is parked on a oneshot inside `agent::await_answer`; this
/// resolves it and lets the turn continue. `answer` may be a chosen option or
/// free text. Every failure mode is a plain `{"ok": false}` — a stale or
/// duplicate answer must never break the renderer.
async fn ask_respond(Json(body): Json<Value>) -> Response<Body> {
    let id = body["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return bad_request("id is required");
    }
    let answer = body["answer"].as_str().unwrap_or("").trim().to_string();
    let ok = crate::agent::deliver_answer(&id, json!({ "answer": answer }));
    Json(json!({ "ok": ok })).into_response()
}

/// POST /permission/respond — approve/deny a pending confirm_action gate.
///
/// The action is NOT performed by the tool until `allowed` is true, so a denied
/// request returns a "do not do it" tool result to the model instead.
async fn permission_respond(Json(body): Json<Value>) -> Response<Body> {
    let id = body["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return bad_request("id is required");
    }
    let allowed = body["allowed"].as_bool().unwrap_or(false);
    let ok = crate::agent::deliver_answer(&id, json!({ "allowed": allowed }));
    Json(json!({ "ok": ok })).into_response()
}

#[derive(serde::Deserialize)]
struct PlanQuery {
    root: String,
    #[serde(default)]
    chat_id: String,
}

#[derive(serde::Deserialize)]
struct PlanChecklistBody {
    root: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    items: Value,
}

// ---------- (proxy removed: the Python sidecar is gone) ----------


/// Permissive CORS for the webview: the renderer origin (vite dev server or
/// tauri://localhost) is cross-origin to this loopback port and WKWebView
/// enforces CORS strictly — without these headers every renderer fetch fails
/// even though the proxy itself works (curl never notices the difference).
/// The Python sidecar used to send them directly (allow_origins=["*"]); the
/// proxy must behave the same now that all traffic flows through it.
async fn cors(req: Request<Body>, next: Next) -> Response<Body> {
    // Answer preflight here: the browser sends OPTIONS before any JSON POST
    // and must get the allow headers without a round trip to the sidecar.
    if req.method() == axum::http::Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_cors_headers(&mut res);
        return res;
    }
    let mut res = next.run(req).await;
    add_cors_headers(&mut res);
    res
}

fn add_cors_headers(res: &mut Response<Body>) {
    let h = res.headers_mut();
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        axum::http::HeaderValue::from_static("*"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("*"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_MAX_AGE,
        axum::http::HeaderValue::from_static("86400"),
    );
}

async fn health() -> Response<Body> {
    Json(json!({"status": "ok", "version": "1.0.0"})).into_response()
}

/// POST /doc/read — extract text or render styled HTML for the file viewer.
/// Ported from `backend/doc_tools.py`: the Python sidecar is no longer
/// involved in reading documents.
async fn doc_read(Json(body): Json<crate::docs::DocReadBody>) -> Response<Body> {
    // Parsing a PDF or a large spreadsheet is CPU-bound and can take seconds:
    // run it on the blocking pool so one big document never stalls the other
    // loopback requests (chat stream, settings, ...).
    match tokio::task::spawn_blocking(move || crate::docs::handle_doc_read(body)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => Json(json!({ "error": format!("document read failed: {e}") })).into_response(),
    }
}

// ---------- /browser/* (native in-app browser) ----------
//
// The panel sends `chat_id` as a query param on GET and inside the JSON body
// on POST (see BrowserPanel.sidecarFetch), so both are accepted here.

fn chat_id_of(body: &Value, query: &HashMap<String, String>) -> String {
    body.get("chat_id")
        .and_then(Value::as_str)
        .or_else(|| query.get("chat_id").map(String::as_str))
        .unwrap_or_default()
        .to_string()
}

async fn browser_status(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    Json(crate::browser::status(&chat)).into_response()
}

/// Start the one-click download of the app's own automation browser.
///
/// Returns immediately: the download and unpack run on a plain thread (see
/// `browser::install`), and the panel follows `/browser/install/status`.
async fn browser_install() -> Response<Body> {
    crate::browser::install();
    Json(crate::browser::install_status()).into_response()
}

/// Progress of the automation-browser install, plus whether the browser is
/// usable right now (the panel uses `available` to decide between the browser
/// UI and the install affordance only while there is no running session).
async fn browser_install_status() -> Response<Body> {
    Json(crate::browser::install_status()).into_response()
}

async fn browser_launch(Json(body): Json<Value>) -> Response<Body> {    let url = body["url"].as_str().unwrap_or("about:blank");
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::launch(url, &chat)).into_response()
}

/// Navigate an ALREADY running session (the panel's address bar).
async fn browser_navigate(Json(body): Json<Value>) -> Response<Body> {
    let url = body["url"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::navigate_to(url, &chat)).into_response()
}

async fn browser_screenshot(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    Json(crate::browser::screenshot(&chat)).into_response()
}

async fn browser_click(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    // A ref (or a selector) means the panel/agent is asking for a real element
    // click: run it through the native driver, which resolves and scrolls the
    // element. Raw x/y stays on the arm's coordinate path.
    if body.get("ref").is_some() || body.get("selector").is_some() {
        return Json(driver_json("click", &body, &chat)).into_response();
    }
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    Json(crate::browser::click(x, y, &chat)).into_response()
}

/// Run one `browser_driver` action and render it as the `{ok, text}` /
/// `{ok, error}` envelope the renderer already understands.
fn driver_json(action: &str, body: &Value, chat: &str) -> Value {
    match crate::browser_driver::run(action, body, chat) {
        Ok(text) => json!({"ok": true, "text": text}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

async fn browser_type(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    if body.get("ref").is_some() || body.get("selector").is_some() {
        return Json(driver_json("type", &body, &chat)).into_response();
    }
    let text = body["text"].as_str().unwrap_or_default();
    Json(crate::browser::type_text(text, &chat)).into_response()
}

async fn browser_scroll(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    if body.get("ref").is_some() || body.get("selector").is_some() {
        return Json(driver_json("scroll", &body, &chat)).into_response();
    }
    let dx = body["dx"].as_i64().unwrap_or_default();
    let dy = body["dy"].as_i64().unwrap_or_default();
    Json(crate::browser::scroll(dx, dy, &chat)).into_response()
}

/// `browser_snapshot` for the panel: the same ref list the agent sees, so a
/// user-driven click can be expressed as a ref instead of a pixel.
async fn browser_snapshot(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    Json(driver_json("snapshot", &body, &chat)).into_response()
}

async fn browser_move(Json(body): Json<Value>) -> Response<Body> {
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::move_mouse(x, y, &chat)).into_response()
}

async fn browser_key(Json(body): Json<Value>) -> Response<Body> {
    let key = body["key"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::press_key(key, &chat)).into_response()
}

async fn browser_viewport(Json(body): Json<Value>) -> Response<Body> {
    let w = body["width"].as_u64().unwrap_or(1280) as u32;
    let h = body["height"].as_u64().unwrap_or(800) as u32;
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::set_viewport(w, h, &chat)).into_response()
}

async fn browser_history(Json(body): Json<Value>) -> Response<Body> {
    let action = body["action"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::history(action, &chat)).into_response()
}

async fn browser_search(Json(body): Json<Value>) -> Response<Body> {
    let query = body["query"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::search(query, &chat)).into_response()
}

async fn browser_devtools_url(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    Json(crate::browser::devtools_url(&chat)).into_response()
}

async fn browser_close(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::close(&chat)).into_response()
}

/// Catch-all: no Python sidecar exists any more, so an unknown path is a real
/// 404. Naming the path (and pointing at the log) makes a stale renderer call
/// diagnosable instead of looking like a network failure.
async fn not_found(req: Request<Body>) -> Response<Body> {
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    eprintln!("[router] no route for {path}");
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": format!("no such endpoint: {path}") })),
    )
        .into_response()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/git/log", get(git_log))
        .route("/git/show", get(git_show))
        .route("/git/commit", post(git_commit))
        // AI-written commit message for the renderer's Commit button.
        .route("/git/autocommit", post(git_autocommit))
        .route("/git/discard", post(git_discard))
        .route("/git/branches", get(git_branches))
        .route("/git/checkout", post(git_checkout))
        .route("/git/push", post(git_push))
        .route("/system-prompts", get(crate::appstate::system_prompts_get))
        .route("/models", get(crate::models::list_models))
        .route("/models/test", post(models_test))
        .route("/models/test-batch", post(models_test_batch))
        // Provider account endpoints (migrated from the Python sidecar's
        // providers.py): plain HTTP + JSON, so the renderer no longer wakes
        // Python for a balance line or a realtime token.
        .route("/credits", get(crate::providers::credits))
        .route("/realtime/session", post(crate::providers::realtime_session))
        // Media (phase 5): STT/TTS are native now — the on-device sources are
        // gone, so both are plain forwards to the configured provider.
        .route("/transcribe", post(crate::media::transcribe))
        .route("/tts", post(crate::media::tts))
        .route("/skills", get(skills_list))
        .route("/skills/available", get(skills_available))
        .route("/skills/file", get(skills_file))
        .route("/skills/sync", post(skills_sync))
        .route("/mcp", get(mcp_list).post(mcp_save))
        .route("/mcp/delete", post(mcp_delete))
        // Plugins: one folder bundling skills + connectors behind a single
        // switch. Listed/edited from Settings; the agent writes them through
        // the `plugin` tool, which goes through the same module.
        .route("/plugins", get(plugins_list))
        .route("/plugins/create", post(plugins_create))
        .route("/plugins/install", post(plugins_install))
        .route("/plugins/update", post(plugins_update))
        .route("/plugins/toggle", post(plugins_toggle))
        .route("/plugins/delete", post(plugins_delete))
        .route("/artifacts/get", get(artifact_get))
        .route("/artifacts/list", get(artifact_list))
        .route("/artifacts", delete(artifact_delete))
        .route("/chat/compact", post(chat_compact))
        .route("/chat/stream", post(chat_stream_entry))
        // Mid-turn steer: inject a message into the RUNNING turn of a chat.
        .route("/chat/steer", post(chat_steer))
        .route("/chat/steer/cancel", post(chat_steer_cancel))
        // Banner Retry on a LIVE sub-agent retry: skip the ladder's backoff and
        // run the next attempt immediately (see `chat_retry_now`).
        .route("/chat/retry_now", post(chat_retry_now))
        // Tool Models changed mid-turn: the running sub-agent ladder must see it
        // (the request body only carries a snapshot — see `chat_slot_model`).
        .route("/chat/slot_model", post(chat_slot_model))
        // User answers to a blocking agent gate. The turn is parked on a
        // oneshot inside agent.rs (`await_answer`); these two routes resolve it
        // and let the turn continue. They MUST be native: the sidecar no longer
        // registers them, so the renderer's POST used to 404 through the proxy
        // while the agent stayed blocked forever.
        .route("/ask/respond", post(ask_respond))
        .route("/permission/respond", post(permission_respond))
        .route("/chats/:chat_id/traces", get(crate::trace::traces_list))
        .route("/chats/:chat_id/traces", delete(crate::trace::traces_clear))
        .route("/plan", get(plan_get))
        .route("/plan", post(plan_save))
        .route("/plan", delete(plan_delete))
        .route("/plan/checklist", get(plan_checklist_get))
        .route("/plan/checklist", post(plan_checklist_save))
        .route("/app/state", get(crate::appstate::app_state_get))
        .route("/app/state", post(crate::appstate::app_state_post))
        .route("/checkpoints/:chat_id", get(crate::appstate::checkpoints_list))
        .route("/checkpoints/:chat_id/:seq/restore", post(crate::appstate::checkpoints_restore))
        .route("/schedules", get(crate::appstate::schedules_list))
        .route("/schedules", post(crate::appstate::schedules_upsert))
        .route("/schedules/:id", delete(crate::appstate::schedules_delete))
        .route("/schedules/:id/run", post(crate::appstate::schedules_run))
        .route("/schedules/:id/runs", get(crate::appstate::schedule_runs_list))
        .route("/schedules/:id/runs", delete(crate::appstate::schedule_runs_clear))
        .route("/schedule-runs", get(crate::appstate::all_schedule_runs))
        .route("/schedule-runs/orphans", delete(crate::appstate::orphan_schedule_runs_clear))
        .route("/schedule-runs/:run_id", delete(crate::appstate::schedule_run_delete))
        .route("/chats/title", post(crate::appstate::chat_title))
        // In-app browser (migrated from the Python sidecar's browser_session):
        // the right-side panel polls frames and posts input here, while the
        // agent drives the same Chromium through the native `browser_driver`.
        .route("/browser/status", get(browser_status))
        .route("/browser/install", post(browser_install))
        .route("/browser/install/status", get(browser_install_status))
        .route("/browser/launch", post(browser_launch))
        .route("/browser/navigate", post(browser_navigate))
        .route("/browser/screenshot", get(browser_screenshot))
        .route("/browser/click", post(browser_click))
        .route("/browser/move", post(browser_move))
        .route("/browser/type", post(browser_type))
        .route("/browser/key", post(browser_key))
        .route("/browser/scroll", post(browser_scroll))
        .route("/browser/snapshot", post(browser_snapshot))
        .route("/browser/viewport", post(browser_viewport))
        .route("/browser/history", post(browser_history))
        .route("/browser/search", post(browser_search))
        .route("/browser/devtools-url", get(browser_devtools_url))
        .route("/browser/close", post(browser_close))
        // Native /doc/read (port of backend/doc_tools.py): text extraction and
        // styled-HTML rendering for the file viewer. Registered natively so the
        // path no longer needs the Python sidecar.
        .route("/doc/read", post(doc_read))
        .route("/health", get(health))
        .fallback(not_found)
        // The default axum body cap is 2 MB — the compact request carries the
        // FULL chat history (tool outputs included) and /chat/stream carries
        // image attachments, both far past 2 MB. hyper then closes the
        // connection mid-body and WKWebView surfaces it as "Load failed".
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::util::ServiceExt;

    /// Model id the live tests assert on: distinctive enough that a bug which
    /// sends the chat's model instead of the slot's can never pass by luck.
    const MOCK_MODEL: &str = "slot-mock/sentinel-model";

    #[test]
    fn slot_target_reads_the_renderer_camel_case_provider_config() {
        // The renderer sends provider configs as camelCase (`apiKeys`,
        // `baseUrl`). Reading only `apiKeys` left the key list empty for every
        // cross-provider slot, so /chats/title failed with "no api key
        // configured" and a new chat stayed untitled.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p1".to_string(),
            serde_json::json!({
                "kind": "openai",
                "baseUrl": "http://camel/v1",
                "apiKeys": ["sk-camel"],
            }),
        );
        let (model, base, keys, pid) =
            resolve_slot_target("p1/gpt-x", "parent", "http://parent/v1", &[], "parent-id", &providers);
        assert_eq!(model, "gpt-x");
        assert_eq!(base, "http://camel/v1");
        assert_eq!(keys, vec!["sk-camel".to_string()]);
        // The effective provider id rides along for usage attribution.
        assert_eq!(pid, "p1");

        // The sidecar's own snake_case contract keeps working.
        let mut snake = std::collections::HashMap::new();
        snake.insert(
            "p2".to_string(),
            serde_json::json!({"base_url": "http://snake/v1", "api_keys": ["sk-snake"]}),
        );
        let (_, base2, keys2, _) =
            resolve_slot_target("p2/m", "parent", "http://parent/v1", &[], "parent-id", &snake);
        assert_eq!(base2, "http://snake/v1");
        assert_eq!(keys2, vec!["sk-snake".to_string()]);

        // A single `apiKey` is honoured, and an unknown provider id falls back
        // to the parent's base + keys instead of losing them.
        let mut single = std::collections::HashMap::new();
        single.insert("p3".to_string(), serde_json::json!({"apiKey": "sk-one"}));
        let (_, base3, keys3, _) =
            resolve_slot_target("p3/m", "parent", "http://parent/v1", &["sk-parent".into()], "parent-id", &single);
        assert_eq!(base3, "http://parent/v1");
        assert_eq!(keys3, vec!["sk-one".to_string()]);
        let (_, base4, keys4, pid4) =
            resolve_slot_target("ghost/m", "parent", "http://parent/v1", &["sk-parent".into()], "parent-id", &single);
        assert_eq!(base4, "http://parent/v1");
        assert_eq!(keys4, vec!["sk-parent".to_string()]);
        // Unknown provider: falls back to the parent, id included.
        assert_eq!(pid4, "parent-id");
    }

    #[test]
    fn slot_target_never_lends_the_parents_key_to_another_endpoint() {
        // The user's 401: a slot (or fallback) whose provider is on a DIFFERENT
        // base URL but whose stored key list is empty. Borrowing the parent's
        // key there sends the chat provider's key to a foreign endpoint, and the
        // provider answers a bare "Invalid API key" that names no model — the
        // failure looks like the fallback never ran. An empty list is the honest
        // answer: llm::complete reports "no api key configured" instead.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "keyless".to_string(),
            serde_json::json!({"kind": "custom", "baseUrl": "http://other/v1"}),
        );
        let (_, base, keys, pid) = resolve_slot_target(
            "keyless/m",
            "parent",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            &providers,
        );
        assert_eq!(base, "http://other/v1");
        assert!(keys.is_empty(), "the parent's key must not cross endpoints, got {keys:?}");
        assert_eq!(pid, "keyless");

        // The SAME endpoint is a different story: there the parent's key is the
        // right key, and dropping it would break a slot that shares the chat's
        // provider but has no key list of its own.
        let mut shared = std::collections::HashMap::new();
        shared.insert(
            "same".to_string(),
            serde_json::json!({"kind": "custom", "baseUrl": "http://parent/v1"}),
        );
        let (_, _, keys, _) = resolve_slot_target(
            "same/m",
            "parent",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            &shared,
        );
        assert_eq!(keys, vec!["sk-parent".to_string()]);
    }

    #[test]
    fn other_slot_group_reads_whichever_key_holds_the_pick() {
        // Tools → "Other" writes ONE model for compact/web/title, but a stale
        // settings file can carry the pick under any single key. Reading only
        // "compact" is what made the commit message and the chat title run on
        // the main model while Settings showed the picked one.
        let mut m = std::collections::HashMap::new();
        m.insert("title".to_string(), "prov-b/side-model".to_string());
        m.insert("web".to_string(), "prov-b/side-model".to_string());
        assert_eq!(other_slot_entry(&m), "prov-b/side-model");
        // An explicit compact entry wins (it is the group's first key).
        m.insert("compact".to_string(), "prov-c/first".to_string());
        assert_eq!(other_slot_entry(&m), "prov-c/first");
        // Sentinels are ignored in favour of a real pick.
        let mut sentinels = std::collections::HashMap::new();
        sentinels.insert("compact".to_string(), "main model".to_string());
        sentinels.insert("web".to_string(), "prov-b/side-model".to_string());
        assert_eq!(other_slot_entry(&sentinels), "prov-b/side-model");
        // Nothing usable → the caller falls back to the main model.
        let mut none = std::collections::HashMap::new();
        none.insert("title".to_string(), "main".to_string());
        assert_eq!(other_slot_entry(&none), "");
        assert_eq!(other_slot_entry(&std::collections::HashMap::new()), "");

        let mut levels = std::collections::HashMap::new();
        levels.insert("title".to_string(), "low".to_string());
        assert_eq!(other_slot_level(&levels), "low");
        levels.insert("compact".to_string(), "high".to_string());
        assert_eq!(other_slot_level(&levels), "high");
        assert_eq!(other_slot_level(&std::collections::HashMap::new()), "");
    }

    #[test]
    fn slot_kind_follows_the_slot_provider_not_the_parent() {
        // A cross-provider slot (an anthropic decision/title model while the
        // chat runs on openrouter) must resolve to the SLOT's kind: the kind
        // selects the URL path + auth header, so inheriting the parent's kind
        // sent every call to the wrong endpoint and the slot silently failed.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p2".to_string(),
            serde_json::json!({"kind": "anthropic", "baseUrl": "http://a/v1"}),
        );
        assert_eq!(resolve_slot_kind("p2/claude-x", "openrouter", &providers), "anthropic");
        // Bare model, unknown provider id and an empty slot keep the parent.
        assert_eq!(resolve_slot_kind("claude-x", "openrouter", &providers), "openrouter");
        assert_eq!(resolve_slot_kind("ghost/m", "openrouter", &providers), "openrouter");
        assert_eq!(resolve_slot_kind("", "openrouter", &providers), "openrouter");
        // A provider entry without a kind also keeps the parent.
        providers.insert("p3".to_string(), serde_json::json!({"baseUrl": "http://b/v1"}));
        assert_eq!(resolve_slot_kind("p3/m", "openrouter", &providers), "openrouter");
    }

    #[tokio::test]
    async fn git_status_serves_natively_and_fallback_proxies() {
        let app = router(new_state(std::env::temp_dir()));
        let root = env!("CARGO_MANIFEST_DIR");

        // Native route: /git/status against this repo (a real git checkout).
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/git/status?root={root}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["branch"].is_string(), "branch missing: {body}");
        assert!(body["entries"].is_array());

        // Invalid root -> 400 with the same message as the Python layer.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/git/status?root=/nonexistent-xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        // /system-prompts is now NATIVE (appstate::system_prompts_get) — it
        // must return 200 with the canonical prompt keys.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/system-prompts")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn native_errors_are_json_detail_not_plain_text() {
        // The renderer reads `body.detail` on a non-ok response. A plain-text
        // body was swallowed into a generic "<op> failed (400)" — the reason
        // for a failed Commit stayed invisible. Every native error must carry
        // the message under `detail`.
        let app = router(new_state(std::env::temp_dir()));

        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/git/status?root=/nonexistent-xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["detail"], "invalid project root");

        // A missing repo must never be answered with an empty body either.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills/file?name=nope&file=skill.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["detail"].is_string(), "missing detail: {body}");
    }

    #[tokio::test]
    async fn cors_headers_on_every_response_and_preflight() {
        let app = router(new_state(std::env::temp_dir()));

        // Preflight: OPTIONS must be answered here with the allow headers —
        // the webview sends it before any JSON POST.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri("/chat/stream")
                    .header("origin", "tauri://localhost")
                    .header("access-control-request-method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 204);
        assert_eq!(
            res.headers()["access-control-allow-origin"],
            "*"
        );

        // Native route responses carry the headers too (the webview origin is
        // cross-origin to this port).
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills")
                    .header("origin", "http://localhost:5173")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn chat_stream_is_always_native() {
        // No Python fallback: an empty body fails native deserialization
        // with a 400 — never a sidecar 503.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/stream")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }

    #[tokio::test]
    async fn skills_and_mcp_serve_natively() {
        // Isolated data root so the test never touches the real ~/.codifa.
        let tmp = std::env::temp_dir().join(format!("codifa-test-{}", std::process::id()));
        let skills_dir = tmp.join("skills").join("learn-from-docs");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            skills_dir.join("skill.md"),
            "---\nname: Learn from Docs\ndescription: d\n---\n\n# Learn from Docs\nbody",
        )
        .unwrap();
        let app = router(new_state(tmp.clone()));

        // Native skills list.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["skills"][0]["name"], "Learn from Docs");
        // Frontmatter is stripped; the markdown body (incl. heading) remains.
        assert_eq!(
            body["skills"][0]["content"].as_str().unwrap().trim(),
            "# Learn from Docs\nbody"
        );

        // Native MCP save + list + delete round-trip.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"docker","cfg":{"command":"docker"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);

        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/mcp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["mcpServers"]["docker"]["command"], "docker");

        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/mcp/delete")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"docker"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert!(tmp.join("mcp").read_dir().unwrap().next().is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn normalize_compact_usage_maps_provider_key_families() {
        // OpenAI-compatible (the user's river provider): prompt_tokens family.
        let u = normalize_compact_usage(
            Some(json!({ "prompt_tokens": 120, "completion_tokens": 45 })),
            "zai-org/GLM-5.3-Flash",
            "river",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 120);
        assert_eq!(u["output_tokens"], 45);
        assert_eq!(u["model"], "zai-org/GLM-5.3-Flash");
        assert_eq!(u["provider_id"], "river");

        // Anthropic keys pass through; Gemini camelCase maps too.
        let u = normalize_compact_usage(
            Some(json!({ "input_tokens": 7, "output_tokens": 3 })),
            "m",
            "p",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 7);
        let u = normalize_compact_usage(
            Some(json!({ "promptTokenCount": 9, "candidatesTokenCount": 2 })),
            "m",
            "",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 9);
        assert_eq!(u["output_tokens"], 2);
        // An empty provider id is omitted, never stored as "".
        assert!(u.get("provider_id").is_none());

        // Missing/empty usage -> None (frontend skips accrual entirely).
        assert!(normalize_compact_usage(None, "m", "p").is_none());
        assert!(normalize_compact_usage(Some(json!(null)), "m", "p").is_none());
    }

    #[tokio::test]
    async fn model_probe_rejects_an_empty_selection() {
        // The probe moved native (it was the last live consumer of the
        // LangChain model factory); the 400 contract must survive the move.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"provider":"custom","model":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"provider":"custom","models":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }

    /// One live OpenAI-compatible upstream on 127.0.0.1: records every
    /// request body and answers a fixed completion + usage. Returns the base
    /// URL and a channel of the bodies it received.
    async fn spawn_mock_upstream() -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let resp = concat!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n",
                        "content-length: 96\r\nconnection: close\r\n\r\n",
                        "{\"choices\":[{\"message\":{\"content\":\"ok summary\"}}]",
                        ",\"usage\":{\"input_tokens\":21,\"output_tokens\":7}}"
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// An OpenAI-compatible upstream that answers 401 for one model and a
    /// completion for any other, recording `(model, authorization)` per request.
    /// Used to prove WHICH key each rung of a chain actually sent.
    async fn spawn_key_recording_upstream(
        reject_model: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<(String, String)>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let auth = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("authorization:"))
                        .map(|v| v.trim().to_string())
                        .unwrap_or_default();
                    let body = serde_json::from_slice::<Value>(&buf[head_end + 4..])
                        .unwrap_or(Value::Null);
                    let model = body["model"].as_str().unwrap_or_default().to_string();
                    let _ = tx.send((model.clone(), auth));
                    let (status, payload) = if model == reject_model {
                        (
                            "401 Unauthorized",
                            r#"{"error":{"message":"Invalid API key","type":"invalid_request_error"}}"#
                                .to_string(),
                        )
                    } else {
                        (
                            "200 OK",
                            r#"{"choices":[{"message":{"content":"ok summary"}}],"usage":{"input_tokens":21,"output_tokens":7}}"#
                                .to_string(),
                        )
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn compact_chat_rung_uses_the_chat_key_not_the_slot_key() {
        // The user's banner: `Compact failed — key rejected (401): Invalid API
        // key`. The summariser slot ran on provider B while the chat ran on
        // provider A, and the appended chat-model rung was built with the
        // SLOT's key against the CHAT's endpoint — a guaranteed 401 that looks
        // like the fallbacks were never tried. Each rung must carry the key of
        // the provider it actually calls.
        let (mock_base, mut rx) = spawn_key_recording_upstream("dead-model").await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-prov",
            "model": "chat-model",
            "base_url": format!("{mock_base}/v1"),
            "api_keys": ["sk-chat"],
            "fallback_provider": "custom",
            "fallback_model": "chat-model",
            "fallback_base_url": format!("{mock_base}/v1"),
            "fallback_api_keys": ["sk-chat"],
            "fallback_provider_id": "chat-prov",
            "subagent_models": { "compact": "slot-prov/dead-model" },
            "providers": {
                "slot-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-slot"] },
                "chat-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-chat"] }
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);

        let first = rx.recv().await.expect("the slot model was never called");
        assert_eq!(first.0, "dead-model");
        assert_eq!(first.1, "bearer sk-slot", "the slot model must use the SLOT's key");
        let second = rx.recv().await.expect("the chat-model rung was never reached");
        assert_eq!(second.0, "chat-model");
        assert_eq!(
            second.1, "bearer sk-chat",
            "the chat rung must use the CHAT's key — a slot key here is the 401 the user saw"
        );
        assert_eq!(out["summary"], "ok summary");
        assert!(out.get("error").is_none() || out["error"].is_null());
    }

    #[tokio::test]
    async fn model_probe_reports_a_failure_per_model_without_failing_the_batch() {
        // An unreachable provider must mark that model failed (no green tick)
        // while the batch itself still answers 200 — the UI ticks per model.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"provider":"custom","base_url":"http://127.0.0.1:1","api_keys":["k"],"models":["m"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let item = &body["results"][0];
        assert_eq!(item["model"], "m");
        assert_eq!(item["ok"], false);
        assert!(
            item["error"].as_str().is_some_and(|e| !e.is_empty()),
            "a failed probe must carry the reason: {body}"
        );
    }

    /// Split an SSE compaction body (`data: {json}\n\n`) into its progress ticks
    /// and the single result frame. `/chat/compact` streams both now, so a test
    /// can no longer read one plain JSON body.
    fn parse_compact_sse(bytes: &[u8]) -> (Vec<Value>, Value) {
        let text = String::from_utf8_lossy(bytes);
        let mut progress = Vec::new();
        let mut result = Value::Null;
        for frame in text.split("\n\n") {
            for line in frame.lines() {
                let Some(raw) = line.strip_prefix("data: ") else { continue };
                let Ok(v) = serde_json::from_str::<Value>(raw.trim()) else { continue };
                if v.get("compact_progress").and_then(|p| p.as_bool()) == Some(true) {
                    progress.push(v);
                } else {
                    result = v;
                }
            }
        }
        (progress, result)
    }

    #[tokio::test]
    async fn compact_live_uses_the_slot_model_provider_and_reasoning() {
        // A cross-provider compact slot must: (1) hit THAT provider's base URL
        // with the slot's model id, (2) apply the slot's own reasoning effort
        // (max), and (3) attribute the usage to the slot's provider id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "openrouter",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": format!("slot-prov/{MOCK_MODEL}") },
            "subagent_thinking": { "compact": "max" },
            "model_reasoning": true,
            "providers": {
                "slot-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-slot"] }
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);

        let sent = rx.recv().await.expect("mock upstream saw no request");
        assert_eq!(sent["model"], MOCK_MODEL, "the slot model must be sent, got {sent}");
        assert_eq!(sent["reasoning_effort"], "high", "slot thinking=max must map to the strongest accepted token, got {sent}");
        let usage = &out["usage"];
        assert_eq!(usage["model"], MOCK_MODEL);
        assert_eq!(usage["provider_id"], "slot-prov", "usage must be attributed to the effective provider, got {usage}");
        assert_eq!(usage["input_tokens"], 21);
        assert_eq!(out["summary"], "ok summary");
    }

    #[tokio::test]
    async fn compact_live_without_a_slot_uses_the_chat_model_and_provider() {
        // Empty slot = the chat's own model/provider, attributed to the chat's id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": MOCK_MODEL,
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (progress, out) = parse_compact_sse(&bytes);
        let sent = rx.recv().await.expect("mock upstream saw no request");
        let usage = &out["usage"];
        // The stream must report real work, not just the result: a run starts
        // with a preparing tick and reports the summarizer call itself.
        assert!(!progress.is_empty(), "no progress frames were streamed");
        assert_eq!(progress[0]["phase"], "preparing");
        assert!(
            progress.iter().any(|p| p["phase"] == "summarizing"),
            "no summarizing tick, got {progress:?}"
        );
        assert!(progress.iter().any(|p| p["budget_secs"].as_u64().unwrap_or(0) > 0));
        assert_eq!(sent["model"], MOCK_MODEL);
        assert_eq!(usage["provider_id"], "chat-provider");
    }

    #[tokio::test]
    async fn title_live_uses_the_title_slot_model_and_provider() {
        // The title slot routes cross-provider: the request must go to THAT
        // provider and the reported usage must carry ITS id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "openrouter",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "title": format!("title-prov/{MOCK_MODEL}") },
            "providers": {
                "title-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-title"] }
            },
            "text": "hello world this is the first message"
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chats/title")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        let sent = rx.recv().await.expect("mock upstream saw no request");
        assert_eq!(sent["model"], MOCK_MODEL, "title must run on the slot model, got {sent}");
        let usage = &out["usage"];
        assert_eq!(usage["provider_id"], "title-prov", "title usage must be attributed to the slot provider, got {usage}");
        assert_eq!(usage["model"], MOCK_MODEL);
        assert!(out["title"].as_str().is_some_and(|t| !t.is_empty()), "a title must come back: {out}");
    }

    #[test]
    fn slot_chain_keeps_the_arranged_order_without_repeats() {
        // The chain is what a tool's own model failure walks down: the tool's
        // model first, then its fallback list in the order the user arranged it
        // (the settings row has up/down buttons), with unreachable repeats
        // dropped so one dead model cannot be paid for twice.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p1".to_string(),
            serde_json::json!({"kind": "openai", "baseUrl": "http://one/v1", "apiKeys": ["sk-one"]}),
        );
        providers.insert(
            "p2".to_string(),
            serde_json::json!({"kind": "anthropic", "baseUrl": "http://two/v1", "apiKeys": ["sk-two"]}),
        );
        let fallbacks = vec![
            "p2/fb-a".to_string(),
            // Same provider+model as the slot's own model: dropped.
            "p1/gpt-x".to_string(),
            "p2/fb-b".to_string(),
            "".to_string(),
            // Unknown provider id: still routable (bare model on the parent),
            // so it survives as its own rung.
            "ghost/fb-c".to_string(),
        ];
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &fallbacks,
            "parent-model",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            "custom",
            &providers,
        );
        let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(models, vec!["gpt-x", "fb-a", "fb-b", "fb-c"]);
        // Each rung routes to ITS OWN provider — base URL, keys and endpoint
        // kind — exactly like the slot entry itself.
        assert_eq!(chain[1].1, "http://two/v1");
        assert_eq!(chain[1].2, vec!["sk-two".to_string()]);
        assert_eq!(chain[1].3, "p2");
        assert_eq!(chain[1].4, "anthropic");
        assert_eq!(chain[3].1, "http://parent/v1");
        assert_eq!(chain[3].3, "parent-id");
        assert_eq!(chain[3].4, "custom");

        // Re-arranging the list (what the up/down buttons do) re-orders the
        // chain: the try order is the LIST order, nothing else.
        let flipped = vec!["p2/fb-b".to_string(), "p2/fb-a".to_string()];
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &flipped,
            "parent-model",
            "http://parent/v1",
            &[],
            "parent-id",
            "custom",
            &providers,
        );
        let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(models, vec!["gpt-x", "fb-b", "fb-a"]);
    }

    #[test]
    fn slot_chain_starts_at_the_slot_model_every_call() {
        // Nothing about a chain survives the call it was built for: a fallback
        // is an escape hatch for ONE failing call, never a new default.
        let providers = std::collections::HashMap::new();
        let fallbacks = vec!["fb-x".to_string(), "fb-y".to_string()];
        for _ in 0..2 {
            let chain = resolve_slot_chain(
                "",
                &fallbacks,
                "parent-model",
                "http://parent/v1",
                &[],
                "parent-id",
                "custom",
                &providers,
            );
            assert_eq!(chain[0].0, "parent-model");
            assert_eq!(chain[0].3, "parent-id");
            let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
            assert_eq!(models, vec!["parent-model", "fb-x", "fb-y"]);
        }
        // A slot with no fallbacks is exactly one rung long.
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &[],
            "parent-model",
            "http://parent/v1",
            &[],
            "parent-id",
            "custom",
            &providers,
        );
        assert_eq!(chain.len(), 1);
    }

    #[test]
    fn other_slot_fallbacks_read_the_group_first_list() {
        // The "Other" row writes compact/web/title together, so its fallback
        // list lives under the same keys and is read with the same precedence
        // as its model.
        let mut m = std::collections::HashMap::new();
        m.insert("title".to_string(), vec!["p2/t".to_string()]);
        m.insert("web".to_string(), vec!["p2/w".to_string()]);
        assert_eq!(other_slot_fallbacks(&m), ["p2/w".to_string()]);
        m.insert("compact".to_string(), vec!["p2/c".to_string()]);
        assert_eq!(other_slot_fallbacks(&m), ["p2/c".to_string()]);
        // An empty list under the first key must not hide a real one.
        let mut sparse = std::collections::HashMap::new();
        sparse.insert("compact".to_string(), Vec::new());
        sparse.insert("title".to_string(), vec!["p2/t".to_string()]);
        assert_eq!(other_slot_fallbacks(&sparse), ["p2/t".to_string()]);
        assert!(other_slot_fallbacks(&std::collections::HashMap::new()).is_empty());
    }

    /// An OpenAI-compatible upstream that always rejects with 401 — the
    /// "provider refuses the key" failure a dead provider produces.
    async fn spawn_rejecting_upstream() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { break };
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = r#"{"error":{"message":"Invalid API key"}}"#;
                    let resp = format!(
                        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn compact_live_walks_the_other_slots_fallback_when_the_key_is_rejected() {
        // The live failure this fixes: the "Other" slot's own provider rejects
        // the key, and the compact used to die with
        // "Compact failed — key rejected (401)" even though the user had a
        // fallback configured. The fallback list must be walked automatically
        // and the compaction must finish on the fallback model.
        let dead_base = spawn_rejecting_upstream().await;
        let (good_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": format!("dead-prov/{MOCK_MODEL}") },
            "providers": {
                "dead-prov": { "kind": "custom", "baseUrl": format!("{dead_base}/v1"), "apiKeys": ["sk-dead"] },
                "good-prov": { "kind": "custom", "baseUrl": format!("{good_base}/v1"), "apiKeys": ["sk-good"] }
            },
            "tool_fallbacks": { "compact": [format!("good-prov/{MOCK_MODEL}")] },
            // The renderer ALWAYS sends the chat model as the summariser's
            // last resort. That used to be the only rung honoured, which threw
            // the Tools fallback list away — the exact bug this pins. Here the
            // chat model is broken too, so only the Tools list can answer.
            "fallback_provider": "custom",
            "fallback_model": "chat/last-resort",
            "fallback_base_url": format!("{dead_base}/v1"),
            "fallback_api_keys": ["sk-dead"],
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);
        // The GOOD provider is the one that must receive the summariser call —
        // and it must receive the slot's own model, resolved through the
        // fallback's OWN provider config (its keys and base URL).
        let sent = rx.recv().await.expect("the fallback provider saw no request");
        assert_eq!(sent["model"], MOCK_MODEL);
        assert_eq!(
            out["summary"], "ok summary",
            "the fallback must answer the compaction, got {out}"
        );
        assert!(
            out["error"].is_null(),
            "a walked chain must not report an error, got {out}"
        );
    }
}
