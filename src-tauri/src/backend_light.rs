//! Phase 2 native HTTP router.
//!
//! Owns the public loopback port the renderer talks to. Light endpoints
//! (git, skills, mcp, system-prompts) are served natively; everything else
//! is transparently proxied to the Python sidecar on its private port, so
//! the frontend keeps a single base URL and unchanged HTTP semantics.

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

fn bad_request(msg: &str) -> Response<Body> {
    (StatusCode::BAD_REQUEST, msg.to_string()).into_response()
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
    let cfg = LlmConfig {
        provider: body.provider.clone(),
        model: model.to_string(),
        base_url: body.base_url.clone(),
        api_keys: keys,
        temperature: None,
        max_tokens: Some(MODEL_TEST_MAX_TOKENS),
        timeout_secs: MODEL_TEST_CLIENT_TIMEOUT_SECS,
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
    git_response(git::status(&q.root))
}

async fn git_diff(Query(q): Query<DiffQuery>) -> Response<Body> {
    git_response(git::diff(&q.root, &q.path, q.staged))
}

async fn git_log(Query(q): Query<LogQuery>) -> Response<Body> {
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
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
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
    let mut keys = body.api_keys.clone();
    if keys.is_empty() && !body.api_key.trim().is_empty() {
        keys.push(body.api_key.clone());
    }
    let cfg = LlmConfig {
        provider: body.provider.clone(),
        model: body.model.clone(),
        base_url: body.base_url.clone(),
        api_keys: keys,
        temperature: Some(0.2),
        max_tokens: Some(512),
        // A commit message is a short one-shot; a real budget is fine here
        // (this is not the chat stream, which has no timeout on purpose).
        timeout_secs: 120,
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
    let summary = match llm::complete(&client, &cfg, SYSTEM, &user).await {
        Ok(r) if !r.text.trim().is_empty() => r.text.trim().to_string(),
        Ok(_) => return bad_request("the model returned an empty commit message"),
        Err(e) => return bad_request(&e),
    };
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

#[derive(serde::Deserialize)]
struct SkillFileQuery {
    name: String,
    file: String,
}

async fn skills_file(State(st): State<AppState>, Query(q): Query<SkillFileQuery>) -> Response<Body> {
    match skills::read_skill_file(&st.root(), &q.name, &q.file) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
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
    /// Full provider configs keyed by id for cross-provider slots.
    #[serde(default)]
    providers: std::collections::HashMap<String, Value>,
}

fn default_provider() -> String {
    "custom".into()
}

/// Resolve a Tool Models slot entry ("providerId/model" | bare model | "")
/// to (model, base_url, api_keys) — shared by the compact and sub-agent
/// slots; mirrors graph.py resolve_subagent_model.
pub fn resolve_slot_target(
    entry: &str,
    parent_model: &str,
    parent_base: &str,
    parent_keys: &[String],
    providers: &std::collections::HashMap<String, Value>,
) -> (String, String, Vec<String>) {
    let entry = entry.trim();
    if entry.is_empty() || entry == "main" || entry == "main_model" || entry == "main model" {
        return (parent_model.to_string(), parent_base.to_string(), parent_keys.to_vec());
    }
    let (provider_id, model) = match entry.split_once('/') {
        Some((pid, m)) => (pid.trim(), m.trim()),
        None => ("", entry),
    };
    if provider_id.is_empty() {
        return (model.to_string(), parent_base.to_string(), parent_keys.to_vec());
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
            if keys.is_empty() {
                keys = parent_keys.to_vec();
            }
            (model.to_string(), base, keys)
        }
        None => (model.to_string(), parent_base.to_string(), parent_keys.to_vec()),
    }
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

/// Normalize the raw provider usage object to the frontend's CompactUsage
/// shape. Providers use different key families (OpenAI: prompt_tokens /
/// completion_tokens, Anthropic: input_tokens / output_tokens, Gemini:
/// promptTokenCount / candidatesTokenCount) — the frontend reads
/// input_tokens/output_tokens, so unmapped keys accrued as 0/0 and the
/// Model usage panel showed nothing after a compact.
fn normalize_compact_usage(raw: Option<Value>, model: &str) -> Option<Value> {
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
    // route cross-provider) — the frontend groups usage under it.
    norm.insert("model".into(), json!(model));
    Some(Value::Object(norm))
}

async fn chat_compact(Json(body): Json<CompactBody>) -> Response<Body> {
    if body.history.is_empty() {
        return Json(json!({ "summary": Value::Null, "keep": 0, "error": "no messages to compact" }))
            .into_response();
    }
    let client = llm::http_client();
    // The "compact" Tool Models slot overrides the summarizer model
    // ("providerId/model" routes cross-provider; empty = the chat model).
    let (model_name, base_url, api_keys) = resolve_slot_target(
        body.subagent_models.get("compact").map(|s| s.as_str()).unwrap_or(""),
        &body.model,
        &body.base_url,
        &{
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
        &body.providers,
    );
    let model = LlmConfig {
        provider: body.provider.clone(),
        model: model_name.clone(),
        base_url,
        api_keys,
        temperature: Some(0.2),
        max_tokens: Some(4096),
        timeout_secs: 300,
    };
    let fallback = if body.fallback_model.is_empty() {
        None
    } else {
        Some(LlmConfig {
            provider: if body.fallback_provider.is_empty() { body.provider.clone() } else { body.fallback_provider.clone() },
            model: body.fallback_model.clone(),
            base_url: if body.fallback_base_url.is_empty() { body.base_url.clone() } else { body.fallback_base_url.clone() },
            api_keys: if body.fallback_api_key.is_empty() { model.api_keys.clone() } else { vec![body.fallback_api_key.clone()] },
            temperature: Some(0.2),
            max_tokens: Some(4096),
            timeout_secs: 300,
        })
    };
    match compact::compact_history(&client, &model, fallback.as_ref(), &body.history, body.context_window, body.max_output, true).await {
        Ok(Some(out)) => Json(json!({
            "summary": out.summary,
            "keep": out.keep,
            "usage": normalize_compact_usage(out.usage, &model_name),
        }))
        .into_response(),
        Ok(None) => Json(json!({ "summary": Value::Null, "keep": 0, "error": "nothing to compact" })).into_response(),
        Err(e) => Json(json!({ "summary": Value::Null, "keep": 0, "error": e })).into_response(),
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

async fn browser_launch(Json(body): Json<Value>) -> Response<Body> {
    let url = body["url"].as_str().unwrap_or("about:blank");
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
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::click(x, y, &chat)).into_response()
}

async fn browser_move(Json(body): Json<Value>) -> Response<Body> {
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::move_mouse(x, y, &chat)).into_response()
}

async fn browser_type(Json(body): Json<Value>) -> Response<Body> {
    let text = body["text"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::type_text(text, &chat)).into_response()
}

async fn browser_key(Json(body): Json<Value>) -> Response<Body> {
    let key = body["key"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::press_key(key, &chat)).into_response()
}

async fn browser_scroll(Json(body): Json<Value>) -> Response<Body> {
    let dx = body["dx"].as_i64().unwrap_or_default();
    let dy = body["dy"].as_i64().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    Json(crate::browser::scroll(dx, dy, &chat)).into_response()
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
        .route("/skills/file", get(skills_file))
        .route("/skills/sync", post(skills_sync))
        .route("/mcp", get(mcp_list).post(mcp_save))
        .route("/mcp/delete", post(mcp_delete))
        .route("/chat/compact", post(chat_compact))
        .route("/chat/stream", post(chat_stream_entry))
        // Mid-turn steer: inject a message into the RUNNING turn of a chat.
        .route("/chat/steer", post(chat_steer))
        .route("/chat/steer/cancel", post(chat_steer_cancel))
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
        .route("/schedules/:id/runs", get(crate::appstate::schedule_runs_list))
        .route("/schedules/:id/runs", delete(crate::appstate::schedule_runs_clear))
        .route("/schedule-runs", get(crate::appstate::all_schedule_runs))
        .route("/schedule-runs/orphans", delete(crate::appstate::orphan_schedule_runs_clear))
        .route("/schedule-runs/:run_id", delete(crate::appstate::schedule_run_delete))
        .route("/chats/title", post(crate::appstate::chat_title))
        // In-app browser (migrated from the Python sidecar's browser_session):
        // the right-side panel polls frames and posts input here, and the
        // agent's Playwright MCP attaches to the same Chromium via /browser/cdp.
        .route("/browser/status", get(browser_status))
        .route("/browser/launch", post(browser_launch))
        .route("/browser/navigate", post(browser_navigate))
        .route("/browser/screenshot", get(browser_screenshot))
        .route("/browser/click", post(browser_click))
        .route("/browser/move", post(browser_move))
        .route("/browser/type", post(browser_type))
        .route("/browser/key", post(browser_key))
        .route("/browser/scroll", post(browser_scroll))
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
        let (model, base, keys) =
            resolve_slot_target("p1/gpt-x", "parent", "http://parent/v1", &[], &providers);
        assert_eq!(model, "gpt-x");
        assert_eq!(base, "http://camel/v1");
        assert_eq!(keys, vec!["sk-camel".to_string()]);

        // The sidecar's own snake_case contract keeps working.
        let mut snake = std::collections::HashMap::new();
        snake.insert(
            "p2".to_string(),
            serde_json::json!({"base_url": "http://snake/v1", "api_keys": ["sk-snake"]}),
        );
        let (_, base2, keys2) =
            resolve_slot_target("p2/m", "parent", "http://parent/v1", &[], &snake);
        assert_eq!(base2, "http://snake/v1");
        assert_eq!(keys2, vec!["sk-snake".to_string()]);

        // A single `apiKey` is honoured, and an unknown provider id falls back
        // to the parent's base + keys instead of losing them.
        let mut single = std::collections::HashMap::new();
        single.insert("p3".to_string(), serde_json::json!({"apiKey": "sk-one"}));
        let (_, base3, keys3) =
            resolve_slot_target("p3/m", "parent", "http://parent/v1", &["sk-parent".into()], &single);
        assert_eq!(base3, "http://parent/v1");
        assert_eq!(keys3, vec!["sk-one".to_string()]);
        let (_, base4, keys4) =
            resolve_slot_target("ghost/m", "parent", "http://parent/v1", &["sk-parent".into()], &single);
        assert_eq!(base4, "http://parent/v1");
        assert_eq!(keys4, vec!["sk-parent".to_string()]);
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
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 120);
        assert_eq!(u["output_tokens"], 45);
        assert_eq!(u["model"], "zai-org/GLM-5.3-Flash");

        // Anthropic keys pass through; Gemini camelCase maps too.
        let u = normalize_compact_usage(
            Some(json!({ "input_tokens": 7, "output_tokens": 3 })),
            "m",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 7);
        let u = normalize_compact_usage(
            Some(json!({ "promptTokenCount": 9, "candidatesTokenCount": 2 })),
            "m",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 9);
        assert_eq!(u["output_tokens"], 2);

        // Missing/empty usage -> None (frontend skips accrual entirely).
        assert!(normalize_compact_usage(None, "m").is_none());
        assert!(normalize_compact_usage(Some(json!(null)), "m").is_none());
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
}
