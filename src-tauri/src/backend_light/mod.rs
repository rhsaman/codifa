//! The app's native HTTP API.
//!
//! Owns the loopback port the renderer talks to. Every endpoint is served by
//! Rust — there is no sidecar and no proxy: git, skills, mcp, chat streaming,
//! docs, media, plans, schedules, the browser session and the agent loop all
//! live in this process.

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
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
///
/// Desktop: loopback on an OS-assigned port (the renderer learns it through
/// `sidecar_url`). Serve mode: the address `codifa serve` asked for, plus the
/// web surface (`/web/*`, `/ws/terminal`) and the built frontend.
pub fn serve(app: tauri::AppHandle) -> Result<(), String> {
    let data_root = get_data_root(&app);
    let (host, port) = match crate::webmode::active() {
        Some(cfg) => (cfg.host.clone(), cfg.port),
        None => ("127.0.0.1".to_string(), 0),
    };
    // Bind inside the tokio runtime: registering a blocking std listener
    // with tokio panics (tokio#7172).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|e| e.to_string())?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?;
        let url = format!("http://{bound}");
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


mod artifacts_media;
mod browser_routes;
mod chat_stream;
mod compact_routes;
mod events;
mod git_routes;
mod models;
mod plan_routes;
mod plugins_routes;
mod slots;
mod web;

// Private glob re-imports: the route table below names every handler exactly
// as before, and sibling parts see each other's items. `pub use` reproduces
// the original backend_light surface — nothing new is exposed.
use artifacts_media::*;
use browser_routes::*;
use chat_stream::*;
use compact_routes::*;
use events::*;
use git_routes::*;
use models::*;
use plan_routes::*;
use plugins_routes::*;
use web::*;

pub use slots::{split_slot_entry, resolve_slot_target, resolve_slot_kind, other_slot_entry,
                other_slot_level, other_slot_fallbacks, resolve_slot_chain};

pub fn router(state: AppState) -> Router {
    let router = Router::new()
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
        .route("/ws/events", get(events_ws))
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
        // Plugins: one folder bundling skills + connectors behind a single
        // switch. Listed/edited from Settings; the agent writes them through
        // the `plugin` tool, which goes through the same module.
        .route("/plugins", get(plugins_list))
        .route("/plugins/marketplace", get(plugins_marketplace))
        // Live progress of the install in flight: the chat's progress bubble
        // polls this while the blocking `POST /plugins/install` runs, so the
        // user sees the install move instead of a silent request.
        .route("/plugins/install-progress", get(plugins_install_progress))
        .route("/plugins/create", post(plugins_create))
        .route("/plugins/install", post(plugins_install))
        .route("/plugins/update", post(plugins_update))
        .route("/plugins/toggle", post(plugins_toggle))
        .route("/plugins/delete", post(plugins_delete))
        // What is INSIDE the bundles: Settings lists and edits a plugin's own
        // skills and connectors, enabled or not.
        .route("/plugins/skills", get(plugins_skills))
        .route("/plugins/scripts", get(plugins_scripts))
        .route("/plugins/commands", get(plugins_commands))
        .route("/plugins/agents", get(plugins_agents))
        .route("/plugins/mcp", get(plugins_mcp))
        .route("/plugins/mcp/save", post(plugins_mcp_save))
        .route("/plugins/mcp/delete", post(plugins_mcp_delete))
        // Run one MCP tool from a trusted surface (the artifact panel's page
        // channel). Bounded like any other connector call.
        .route("/mcp/call", post(mcp_call))
        // Run one of a bundle's scripts. Blocking (a `rustc` build on first use),
        // so it stays off the async worker like the install route.
        .route("/plugins/run", post(plugins_run))
        .route("/artifacts/get", get(artifact_get))
        .route("/artifacts/assets", get(artifact_assets))
        .route("/artifacts/list", get(artifact_list))
        .route("/artifacts", delete(artifact_delete))
        // Generated media: the chat's `codifa-media://` markdown resolves to
        // /media/file, and the manual Media Editor's local operations (crop,
        // trim, merge, slideshow) run through /media/edit — the SAME helpers
        // the `edit_video` tool uses.
        .route("/media/file", get(media_file))
        .route("/media/edit", post(media_edit))
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
        .route("/permission/trust", post(permission_trust))
        .route("/permission/trust-host", post(permission_trust_host))
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
        .route("/schedules/:id/stop", post(crate::appstate::schedules_stop))
        .route("/schedules/:id/runs", get(crate::appstate::schedule_runs_list))
        .route("/schedules/:id/runs", delete(crate::appstate::schedule_runs_clear))
        .route("/schedule-runs", get(crate::appstate::all_schedule_runs))
        .route("/schedule-runs/orphans", delete(crate::appstate::orphan_schedule_runs_clear))
        .route("/schedule-runs/:run_id", delete(crate::appstate::schedule_run_delete))
        .route("/chats/title", post(crate::appstate::chat_title))
        // Agent background terminals: the right panel's Terminals section
        // polls the list for the active chat and posts a Stop here.
        .route("/agent-terminals", get(agent_terminals_list))
        .route("/agent-terminals/stop", post(agent_terminals_stop))
        // In-app browser (migrated from the Python sidecar's browser_session):
        // the right-side panel polls frames and posts input here, while the
        // agent drives the same Chromium through the native `browser_driver`.
        .route("/browser/status", get(browser_status))
        .route("/browser/install", post(browser_install))
        .route("/browser/install/status", get(browser_install_status))
        .route("/browser/launch", post(browser_launch))
        .route("/browser/navigate", post(browser_navigate))
        .route("/browser/screenshot", get(browser_screenshot))
        .route("/browser/frame", get(browser_frame))
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
        .route("/browser/cookies/import", post(browser_cookies_import))
        .route("/browser/close", post(browser_close))
        // Native /doc/read (port of backend/doc_tools.py): text extraction and
        // styled-HTML rendering for the file viewer. Registered natively so the
        // path no longer needs the Python sidecar.
        .route("/doc/read", post(doc_read))
        .route("/health", get(health))
        .fallback(mode_fallback);

    // Web-mode-only surface: the browser bridge (fs/store/terminals a desktop
    // renderer reaches through Tauri IPC). Registered ONLY in serve mode, so
    // the desktop app's loopback drive-by surface never grows.
    let mut app = router;
    if crate::webmode::active().is_some() {
        app = app
            .route("/web/call", post(crate::webapi::web_call))
            .route("/web/upload", post(crate::webapi::web_upload))
            .route("/ws/terminal", get(crate::webapi::terminal_ws));
    }

    app
        // The default axum body cap is 2 MB — the compact request carries the
        // FULL chat history (tool outputs included) and /chat/stream carries
        // image attachments, both far past 2 MB. hyper then closes the
        // connection mid-body and WKWebView surfaces it as "Load failed".
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        // Order matters: cors outermost so a preflight OPTIONS is answered
        // before auth looks for a token, then the token check, then routes.
        .layer(middleware::from_fn(web_auth))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

#[cfg(test)]
mod tests;
