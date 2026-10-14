//! Phase 2 native HTTP router.
//!
//! Owns the public loopback port the renderer talks to. Light endpoints
//! (git, skills, mcp, system-prompts) are served natively; everything else
//! is transparently proxied to the Python sidecar on its private port, so
//! the frontend keeps a single base URL and unchanged HTTP semantics.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{Request, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::agent;
use crate::compact;
use crate::git;
use crate::llm::{self, LlmConfig};
use crate::sidecar;
use crate::skills;
use crate::state::get_data_root;
use std::path::PathBuf;

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
    /// Reqwest client for proxying to the Python sidecar.
    http: reqwest::Client,
    /// Resolved data root (~/.codifa) for the native file-backed endpoints.
    data_root: PathBuf,
}

pub fn new_state(data_root: PathBuf) -> AppState {
    AppState {
        http: reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest client"),
        data_root,
    }
}

fn bad_request(msg: &str) -> Response<Body> {
    (StatusCode::BAD_REQUEST, msg.to_string()).into_response()
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

// ---------- skills / mcp (native) + system-prompts (proxied) ----------

async fn system_prompts(State(st): State<AppState>) -> Response<Body> {
    proxy_get(&st, "/system-prompts").await
}

async fn skills_list(State(st): State<AppState>) -> Response<Body> {
    Json(skills::list_skills(&st.data_root)).into_response()
}

#[derive(serde::Deserialize)]
struct SkillFileQuery {
    name: String,
    file: String,
}

async fn skills_file(State(st): State<AppState>, Query(q): Query<SkillFileQuery>) -> Response<Body> {
    match skills::read_skill_file(&st.data_root, &q.name, &q.file) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
    }
}

async fn skills_sync(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::sync_skill(&st.data_root, &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn mcp_list(State(st): State<AppState>) -> Response<Body> {
    Json(skills::list_mcp(&st.data_root)).into_response()
}

async fn mcp_save(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::save_mcp(&st.data_root, &body) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => bad_request(&msg),
    }
}

async fn mcp_delete(State(st): State<AppState>, Json(body): Json<Value>) -> Response<Body> {
    match skills::delete_mcp(&st.data_root, &body) {
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
}

fn default_provider() -> String {
    "custom".into()
}

async fn chat_compact(Json(body): Json<CompactBody>) -> Response<Body> {
    if body.history.is_empty() {
        return Json(json!({ "summary": Value::Null, "keep": 0, "error": "no messages to compact" }))
            .into_response();
    }
    let client = llm::http_client();
    let model = LlmConfig {
        provider: body.provider.clone(),
        model: body.model.clone(),
        base_url: body.base_url.clone(),
        api_keys: {
            let mut k = body.api_keys.clone();
            if k.is_empty() && !body.api_key.is_empty() {
                k.push(body.api_key.clone());
            }
            k
        },
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
        Ok(Some(out)) => Json(json!({ "summary": out.summary, "keep": out.keep, "usage": out.usage })).into_response(),
        Ok(None) => Json(json!({ "summary": Value::Null, "keep": 0, "error": "nothing to compact" })).into_response(),
        Err(e) => Json(json!({ "summary": Value::Null, "keep": 0, "error": e })).into_response(),
    }
}

// ---------- native /chat/stream (phase 3-2) ----------

async fn chat_stream(Json(body): Json<Value>) -> Response<Body> {
    let Ok(req) = serde_json::from_value::<agent::AgentRequest>(body) else {
        return bad_request("invalid agent request");
    };
    // Unbounded channel: the event callback is a sync FnMut called from
    // inside the tokio runtime, so blocking_send would panic; unbounded
    // send is non-blocking and the SSE consumer drains it as fast as the
    // client reads.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Vec<u8>, std::io::Error>>();
    tokio::spawn(async move {
        let tx = tx;
        let _ = agent::run_turn(&req, &|ev: &agent::AgentEvent| {
            let line = format!("data: {}\n\n", ev.to_json());
            let _ = tx.send(Ok(line.into_bytes()));
        })
        .await;
    });
    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "stream build failed").into_response())
}

// ---------- proxy plumbing ----------

async fn sidecar_base() -> Option<String> {
    // The sidecar state lives in Tauri's managed state; the router runs on a
    // plain tokio runtime, so read it through the global accessor.
    sidecar::current_url().map(|u| u.trim_end_matches('/').to_string())
}

async fn proxy_get(st: &AppState, path: &str) -> Response<Body> {
    let Some(base) = sidecar_base().await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "sidecar not ready").into_response();
    };
    match st.http.get(format!("{base}{path}")).send().await {
        Ok(res) => convert_response(res).await,
        Err(e) => (StatusCode::BAD_GATEWAY, format!("proxy error: {e}")).into_response(),
    }
}

async fn proxy_all(st: AppState, req: Request<Body>, path: &str) -> Response<Body> {
    let Some(base) = sidecar_base().await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "sidecar not ready").into_response();
    };
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return bad_request(&format!("body read failed: {e}")),
    };
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .unwrap_or(reqwest::Method::POST);
    let mut out = st.http.request(method, format!("{base}{path}"));
    for (k, v) in parts.headers.iter() {
        if k.as_str() != "host" {
            out = out.header(k.as_str(), v.to_str().unwrap_or_default());
        }
    }
    match out.body(bytes.to_vec()).send().await {
        Ok(res) => convert_response(res).await,
        Err(e) => (StatusCode::BAD_GATEWAY, format!("proxy error: {e}")).into_response(),
    }
}

async fn convert_response(res: reqwest::Response) -> Response<Body> {
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = res.headers().clone();
    let bytes = res.bytes().await.unwrap_or_default();
    let mut builder = Response::builder().status(status);
    for (k, v) in headers.iter() {
        if matches!(k.as_str(), "content-type" | "content-disposition" | "cache-control") {
            builder = builder.header(k, v);
        }
    }
    builder.body(Body::from(bytes)).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
    })
}

/// Catch-all: every non-native path is proxied to the Python sidecar.
async fn proxy_fallback(st: State<AppState>, req: Request<Body>) -> Response<Body> {
    let uri: &Uri = req.uri();
    let path = uri.path_and_query().map(|pq| pq.as_str().to_string()).unwrap_or_default();
    proxy_all(st.0, req, &path).await
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/git/log", get(git_log))
        .route("/git/show", get(git_show))
        .route("/git/commit", post(git_commit))
        .route("/git/discard", post(git_discard))
        .route("/git/branches", get(git_branches))
        .route("/git/checkout", post(git_checkout))
        .route("/git/push", post(git_push))
        .route("/system-prompts", get(system_prompts))
        .route("/skills", get(skills_list))
        .route("/skills/file", get(skills_file))
        .route("/skills/sync", post(skills_sync))
        .route("/mcp", get(mcp_list).post(mcp_save))
        .route("/mcp/delete", post(mcp_delete))
        .route("/chat/compact", post(chat_compact))
        .route("/chat/stream", post(chat_stream))
        .fallback(proxy_fallback)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::util::ServiceExt;

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

        // Fallback proxy: sidecar is not running in tests -> 503, proving the
        // fallback path exists and does not 404. /system-prompts is still
        // proxied (prompts live in the Python agent engine).
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/system-prompts")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 503);
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
}
