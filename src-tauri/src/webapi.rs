//! The web-mode surface: the browser-only endpoints a desktop renderer never
//! needs because Tauri's IPC covers them.
//!
//! Three endpoints, all token-gated by the auth layer in `backend_light`:
//!
//! - `POST /web/call`    — a dispatcher over the SAME functions the Tauri
//!   commands wrap (fs, store, secrets, backups…). One auditable chokepoint
//!   instead of a sprawling per-command route table; the command list is the
//!   security boundary and each arm only forwards to an existing command fn.
//! - `POST /web/upload`  — a browser `File` (no server-side path) lands in the
//!   uploads dir through the same `import_file` convention drag-drop uses.
//! - `GET  /ws/terminal` — pty sessions over one WebSocket: the Tauri event
//!   pairs (`terminal:data` / `terminal:exit`) plus the create/write/resize/
//!   kill commands, multiplexed per session id.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Multipart;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::webmode;

use tokio::io::AsyncWriteExt;

/// `POST /web/call` — `{cmd, args}` dispatch. The async command arms (store,
/// backups — they use `tauri::async_runtime` internally) run inline; the
/// blocking fs/backup arms go through `spawn_blocking` so a slow directory
/// walk never stalls the router's two worker threads.
pub async fn web_call(Json(body): Json<Value>) -> axum::response::Response {
    let cmd = body
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args = body.get("args").cloned().unwrap_or(Value::Null);
    let app = || webmode::app().map(|a| a.clone());
    let arg = |name: &str| args.get(name).cloned().unwrap_or(Value::Null);
    let s = |name: &str| -> String {
        args.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
    };

    let result: Result<Value, String> = match cmd.as_str() {
        "store_get" => {
            let Some(app) = app() else { return unavailable() };
            Ok(json!(crate::store::store_get(app, s("key")).await))
        }
        "store_set" => {
            let Some(app) = app() else { return unavailable() };
            Ok(json!(crate::store::store_set(app, s("key"), arg("value")).await))
        }
        "chat_get" => {
            let Some(app) = app() else { return unavailable() };
            Ok(json!(crate::store::chat_get(app, s("id")).await))
        }
        "create_backup" => {
            let Some(app) = app() else { return unavailable() };
            crate::backup::create_backup(app, s("dest_dir"))
                .await
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        }
        "restore_backup" => {
            let Some(app) = app() else { return unavailable() };
            crate::backup::restore_backup(app, s("path"))
                .await
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        }
        _ => {
            let Some(app) = app() else { return unavailable() };
            let result = tokio::task::spawn_blocking(move || dispatch_sync(app, &cmd, args))
                .await
                .unwrap_or_else(|e| Err(format!("dispatch join failed: {e}")));
            result
        }
    };

    match result {
        Ok(value) => Json(json!({ "ok": true, "result": value })).into_response(),
        Err(e) => Json(json!({ "ok": false, "error": e })).into_response(),
    }
}

fn unavailable() -> axum::response::Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": "app not initialized yet" })),
    )
        .into_response()
}

/// The synchronous command arms. Each returns whatever shape the renderer's
/// `window.coder` contract expects (see src/types/coderApi.ts).
fn dispatch_sync(app: tauri::AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    let arg = |name: &str| -> Value { args.get(name).cloned().unwrap_or(Value::Null) };
    let s = |name: &str| -> String { arg(name).as_str().unwrap_or_default().to_string() };

    match cmd {
        // --- files (workspace + arbitrary absolute paths, like the commands) ---
        "fs_list" => serde_json::to_value(crate::commands::fs_list(s("root"), s("rel")))
            .map_err(|e| e.to_string()),
        "fs_walk" => serde_json::to_value(crate::commands::fs_walk(s("root")))
            .map_err(|e| e.to_string()),
        "fs_read" => Ok(json!(crate::commands::fs_read(s("root"), s("rel"))
            .map_err(|e| e.to_string())?)),
        "fs_write" => Ok(json!(crate::commands::fs_write(s("root"), s("rel"), s("content"))
            .map_err(|e| e.to_string())?)),
        "fs_delete" => Ok(json!(crate::commands::fs_delete(s("root"), s("rel")))),
        "fs_copy" => Ok(json!(crate::commands::fs_copy(s("root"), s("from"), s("to"))
            .map_err(|e| e.to_string())?)),
        "fs_rename" => Ok(json!(crate::commands::fs_rename(s("root"), s("from"), s("to"))
            .map_err(|e| e.to_string())?)),
        "search_content" => serde_json::to_value(crate::commands::search_content(s("root"), s("query")))
            .map_err(|e| e.to_string()),
        // --- data-root files ---
        "coder_list" => serde_json::to_value(crate::commands::coder_list(app.clone(), s("rel")))
            .map_err(|e| e.to_string()),
        "coder_read" => Ok(json!(crate::commands::coder_read(app.clone(), s("rel"))
            .map_err(|e| e.to_string())?)),
        "coder_write" => Ok(json!(crate::commands::coder_write(app.clone(), s("rel"), s("content"))
            .map_err(|e| e.to_string())?)),
        "coder_delete" => Ok(json!(crate::commands::coder_delete(app.clone(), s("rel")))),
        // --- viewers / images ---
        "read_image" => Ok(json!(crate::commands::read_image(s("abs_path")))),
        "read_pdf_base64" => Ok(json!(crate::commands::read_pdf_base64(s("abs_path")))),
        "normalize_image" => Ok(json!(crate::commands::normalize_image(s("abs_path")))),
        // --- misc surface ---
        "get_data_path" => Ok(json!(crate::commands::get_data_path(app.clone()))),
        "has_settings_file" => Ok(json!(crate::commands::has_settings_file(app.clone()))),
        "secrets_get_key" => Ok(json!(crate::commands::secrets_get_key(app.clone()))),
        "get_env" => Ok(json!(crate::commands::get_env(s("key")))),
        "import_file" => Ok(json!(crate::commands::import_file(app.clone(), s("abs_path")))),
        "copy_text" => Ok(json!(crate::commands::copy_text(s("text")))),
        "move_data_path" => Ok(json!(crate::commands::move_data_path(app.clone(), s("p"))
            .map_err(|e| e.to_string())?)),
        "backup_info" => Ok(json!(crate::backup::backup_info(s("path"))
            .map_err(|e| e.to_string())?)),
        "cancel_backup" => {
            crate::backup::cancel_backup(app.clone());
            Ok(json!(null))
        }
        other => Err(format!("unknown web command: {other}")),
    }
}

/// `POST /web/upload` — multipart single-file upload for the web composer's
/// drag-drop attachments. The bytes are written to a temp file and pushed
/// through `import_file`, so the uploads-dir naming/dedup convention stays
/// identical to the desktop app's.
pub async fn web_upload(mut multipart: Multipart) -> axum::response::Response {
    let Some(app) = webmode::app().map(|a| a.clone()) else {
        return unavailable();
    };
    while let Ok(Some(mut field)) = multipart.next_field().await {
        let raw_name = field.file_name().unwrap_or("upload.bin").to_string();
        // A browser never sends a path in the filename, but a hostile client
        // can put "../" there — keep the bare file name only.
        let name = raw_name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("upload.bin")
            .replace(['\0', ':', '?', '*'], "_");
        let dir = std::env::temp_dir().join("codifa-web-upload");
        let _ = std::fs::create_dir_all(&dir);
        let tmp = dir.join(format!("{}-{name}", uuid::Uuid::new_v4()));
        let mut file = match tokio::fs::File::create(&tmp).await {
            Ok(f) => f,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("temp write failed: {e}"),
                )
                    .into_response()
            }
        };
        // axum's multipart Field is a Stream, not an AsyncRead — drain chunks.
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(e) = file.write_all(&chunk).await {
                        let _ = tokio::fs::remove_file(&tmp).await;
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("upload write failed: {e}"),
                        )
                            .into_response();
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return (StatusCode::BAD_REQUEST, format!("upload read failed: {e}"))
                        .into_response();
                }
            }
        }
        drop(file);
        let tmp_str = tmp.to_string_lossy().into_owned();
        // import_file copies into <data_root>/uploads with the desktop app's
        // dedup convention and returns the server path the renderer expects.
        let app2 = app.clone();
        let path = tokio::task::spawn_blocking(move || {
            crate::commands::import_file(app2, tmp_str.clone())
        })
        .await
        .ok()
        .flatten();
        let _ = tokio::fs::remove_file(&tmp).await;
        if let Some(p) = path {
            return Json(json!({ "ok": true, "path": p })).into_response();
        }
    }
    (StatusCode::BAD_REQUEST, "no file field in upload").into_response()
}

/// `GET /ws/terminal` — the browser's pty channel.
///
/// One socket carries EVERY session (the client routes by id, exactly like the
/// desktop renderer routes the `terminal:data` broadcasts by payload id), so
/// reconnecting one panel never disturbs another. Requests are id-tagged
/// (`req`) because `create`/`kill` complete out of band.
pub async fn terminal_ws(ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(terminal_socket)
}

#[derive(serde::Deserialize)]
struct TermReq {
    #[serde(default)]
    req: Value,
    t: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    data: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    requested_id: Option<String>,
    #[serde(default)]
    cols: u16,
    #[serde(default)]
    rows: u16,
}

async fn terminal_socket(mut socket: WebSocket) {
    let Some(app) = webmode::app().map(|a| a.clone()) else {
        let _ = socket
            .send(Message::Text(
                json!({"t":"error","message":"app not initialized"}).to_string(),
            ))
            .await;
        return;
    };
    let mut bus = crate::pty::subscribe_bus();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    // Bus → socket. A Lagged receiver means this client was too slow for the
    // 1024-slot buffer: skip what was lost (terminal output is a live stream;
    // the missed scrollback is gone either way) instead of tearing down.
    let forward = tokio::spawn(async move {
        loop {
            match bus.recv().await {
                Ok(ev) => {
                    let Ok(text) = serde_json::to_string(&ev) else { continue };
                    if out_tx.send(Message::Text(text)).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    loop {
        let msg = tokio::select! {
            m = socket.recv() => m,
            Some(out) = out_rx.recv() => {
                if socket.send(out).await.is_err() {
                    break;
                }
                continue;
            }
        };
        let Some(Ok(Message::Text(text))) = msg else { break };
        let Ok(req) = serde_json::from_str::<TermReq>(&text) else {
            let _ = socket
                .send(Message::Text(json!({"t":"error","message":"bad request json"}).to_string()))
                .await;
            continue;
        };
        match req.t.as_str() {
            "create" => {
                let app2 = app.clone();
                let (cwd, program, args, shell, requested_id) = (
                    req.cwd.clone(),
                    req.program.clone(),
                    req.args.clone(),
                    req.shell.clone(),
                    req.requested_id.clone(),
                );
                let handle = tokio::task::spawn_blocking(move || {
                    crate::pty::terminal_create(app2, &cwd, program, args, shell, requested_id)
                })
                .await;
                let value = handle.unwrap_or_else(|e| Err(format!("create join failed: {e}")));
                let payload = match value {
                    Ok(info) => json!({"req": req.req, "t": "created", "info": info}),
                    Err(e) => json!({"req": req.req, "t": "error", "message": e}),
                };
                let _ = socket.send(Message::Text(payload.to_string())).await;
            }
            "write" => {
                let ok = crate::pty::terminal_write(app.clone(), &req.id, &req.data);
                let _ = socket
                    .send(Message::Text(
                        json!({"req": req.req, "t": "ok", "id": req.id, "ok": ok}).to_string(),
                    ))
                    .await;
            }
            "resize" => {
                let ok = crate::pty::terminal_resize(app.clone(), &req.id, req.cols, req.rows);
                let _ = socket
                    .send(Message::Text(
                        json!({"req": req.req, "t": "ok", "id": req.id, "ok": ok}).to_string(),
                    ))
                    .await;
            }
            "kill" => {
                let app2 = app.clone();
                let id = req.id.clone();
                let ok = tokio::task::spawn_blocking(move || crate::pty::terminal_kill(app2, &id))
                    .await
                    .unwrap_or(false);
                let _ = socket
                    .send(Message::Text(
                        json!({"req": req.req, "t": "ok", "id": req.id, "ok": ok}).to_string(),
                    ))
                    .await;
            }
            "list" => {
                let sessions = crate::pty::terminal_list(app.clone());
                let _ = socket
                    .send(Message::Text(
                        json!({"req": req.req, "t": "list", "sessions": sessions}).to_string(),
                    ))
                    .await;
            }
            "ping" => {
                let _ = socket
                    .send(Message::Text(json!({"t": "pong"}).to_string()))
                    .await;
            }
            _ => {
                let _ = socket
                    .send(Message::Text(
                        json!({"t": "error", "message": format!("unknown terminal op: {}", req.t)})
                            .to_string(),
                    ))
                    .await;
            }
        }
    }
    forward.abort();
}
