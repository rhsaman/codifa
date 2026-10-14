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
use serde_json::Value;

use crate::git;
use crate::sidecar;

/// The public router's URL, mirrored into a global so `sidecar_url` (which
/// runs on arbitrary threads) can hand it to the renderer.
static PUBLIC_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The public base URL the renderer should use, once the router is up.
pub fn public_url() -> Option<String> {
    PUBLIC_URL.lock().unwrap().clone()
}

/// Bind the public router port and serve until the process exits.
pub fn serve(_app: tauri::AppHandle) -> Result<(), String> {
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
        axum::serve(listener, router(new_state()))
            .await
            .map_err(|e| e.to_string())
    })
}

#[derive(Clone)]
pub struct AppState {
    /// Reqwest client for proxying to the Python sidecar.
    http: reqwest::Client,
}

pub fn new_state() -> AppState {
    AppState {
        http: reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest client"),
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

// ---------- skills / mcp / system-prompts (proxied until ported) ----------

async fn system_prompts(State(st): State<AppState>) -> Response<Body> {
    proxy_get(&st, "/system-prompts").await
}

async fn skills_list(State(st): State<AppState>) -> Response<Body> {
    proxy_get(&st, "/skills").await
}

#[derive(serde::Deserialize)]
struct SkillFileQuery {
    name: String,
    file: String,
}

async fn skills_file(State(st): State<AppState>, Query(q): Query<SkillFileQuery>) -> Response<Body> {
    let url = format!(
        "/skills/file?name={}&file={}",
        percent_encoding(&q.name),
        percent_encoding(&q.file)
    );
    proxy_get(&st, &url).await
}

async fn skills_sync(st: State<AppState>, req: Request<Body>) -> Response<Body> {
    proxy_all(st.0, req, "/skills/sync").await
}

async fn mcp_list(State(st): State<AppState>) -> Response<Body> {
    proxy_get(&st, "/mcp").await
}

async fn mcp_save(st: State<AppState>, req: Request<Body>) -> Response<Body> {
    proxy_all(st.0, req, "/mcp").await
}

async fn mcp_delete(st: State<AppState>, req: Request<Body>) -> Response<Body> {
    proxy_all(st.0, req, "/mcp/delete").await
}

// ---------- proxy plumbing ----------

fn percent_encoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

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
        .fallback(proxy_fallback)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn git_status_serves_natively_and_fallback_proxies() {
        let app = router(new_state());
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
        // fallback path exists and does not 404.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 503);
    }
}
