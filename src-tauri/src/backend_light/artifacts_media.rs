use super::*;

/// Latest saved body of one artifact — the preview tab reads it after a restart
/// (the transcript only carries the card's id/title/kind/content).
pub(super) async fn artifact_get(State(st): State<AppState>, Query(q): Query<ArtifactQuery>) -> Response<Body> {
    match crate::artifacts::read(&st.root(), &q.chat_id, &q.id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

/// Supporting files (backend source, data, config) of one artifact, for the
/// preview panel. The document itself comes from `/artifacts/get`.
pub(super) async fn artifact_assets(
    State(st): State<AppState>,
    Query(q): Query<ArtifactQuery>,
) -> Response<Body> {
    match crate::artifacts::read_assets(&st.root(), &q.chat_id, &q.id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

/// Delete one artifact (every saved version) from the Artifacts page.
pub(super) async fn artifact_delete(
    State(st): State<AppState>,
    Query(q): Query<ArtifactQuery>,
) -> Response<Body> {
    match crate::artifacts::delete(&st.root(), &q.chat_id, &q.id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(json!({ "detail": msg }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct ArtifactQuery {
    #[serde(default)]
    chat_id: String,
    id: String,
}

/// `/artifacts/list` takes `chat_id` alone (no `id`) — its own struct, so the
/// `id` requirement of `/artifacts/get` stays enforced there.
#[derive(serde::Deserialize)]
pub(super) struct ArtifactListQuery {
    #[serde(default)]
    chat_id: String,
}

/// Every saved artifact (newest first) for the Artifacts page: one chat's when
/// `chat_id` is given, every chat's otherwise. Only the indexes are read — the
/// page lists titles, it does not load the documents.
pub(super) async fn artifact_list(
    State(st): State<AppState>,
    Query(q): Query<ArtifactListQuery>,
) -> Response<Body> {
    match crate::artifacts::list(&st.root(), &q.chat_id) {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "detail": msg }))).into_response(),
    }
}

// ---------- media serving + manual editing (generated images / videos) ------

#[derive(serde::Deserialize)]
pub(super) struct MediaFileQuery {
    /// Legacy param from the workspace-storage era; accepted and ignored so a
    /// stale renderer URL still serves instead of 400ing.
    #[serde(default)]
    #[allow(dead_code)]
    root: String,
    path: String,
}

/// GET /media/file?path= — stream one generated media file to the renderer.
/// This is what the chat's `codifa-media://` markdown references resolve to:
/// the agent only ever names a VIRTUAL path (`media/<chat-slug>/<file>`)
/// relative to the DATA root, the webview cannot read the disk, so the
/// renderer rewrites the scheme to this route. Resolution goes through
/// `media_gen::resolve_media_virtual` — containment inside
/// `<data_root>/media/` — so the route can never be walked out of it.
pub(super) async fn media_file(State(st): State<AppState>, Query(q): Query<MediaFileQuery>) -> Response<Body> {
    let abs = match crate::media_gen::resolve_media_virtual(&st.root().to_string_lossy(), &q.path) {
        Ok(abs) => abs,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "detail": e })),
            )
                .into_response()
        }
    };
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "detail": format!("cannot read {}: {e}", q.path) })),
            )
                .into_response()
        }
    };
    let mime = crate::media_gen::mime_for_path(&q.path);
    (
        [
            (
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static(mime),
            ),
            // Never cache: a regenerated file with the same name must show up.
            (
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            ),
        ],
        bytes,
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub(super) struct MediaEditBody {
    /// The workspace root — sources the user picked from the workspace.
    root: String,
    /// The chat that OWNS the media folder these operations write into.
    #[serde(default)]
    chat_id: String,
    /// crop | trim | merge | slideshow | probe
    action: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    x: u32,
    #[serde(default)]
    y: u32,
    #[serde(default)]
    w: u32,
    #[serde(default)]
    h: u32,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    seconds: f64,
    #[serde(default)]
    output: Option<String>,
}

/// POST /media/edit — the MANUAL editor's local operations (Media Viewer
/// panel). Same ffmpeg helpers the `edit_video` tool uses, so the tool and the
/// panel can never drift apart on how a cut or a merge is performed.
pub(super) async fn media_edit(Json(b): Json<MediaEditBody>) -> Response<Body> {
    let data_root = crate::state::current_data_root()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
    // The editor only touches THIS chat's media folder.
    let ctx = crate::media_edit::MediaCtx {
        workspace_root: b.root.clone(),
        data_root: data_root.clone(),
        chat_id: b.chat_id.clone(),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, String), String> {
        let bin = crate::media_edit::ensure_ffmpeg(&data_root)?;
        let mut files: Vec<String> = Vec::new();
        let line = match b.action.as_str() {
            "crop" => {
                let rel = crate::media_edit::crop_image(
                    &ctx,
                    &bin,
                    &b.path,
                    b.x,
                    b.y,
                    b.w,
                    b.h,
                    b.output.as_deref(),
                )?;
                files.push(rel.clone());
                format!("Cropped {rel}")
            }
            "trim" => {
                let rel = crate::media_edit::trim(
                    &ctx,
                    &bin,
                    &b.path,
                    b.start,
                    b.end,
                    b.output.as_deref(),
                )?;
                files.push(rel.clone());
                format!("Trimmed {rel}")
            }
            "merge" => {
                let rel = crate::media_edit::merge(
                    &ctx,
                    &bin,
                    &b.paths,
                    b.output.as_deref(),
                )?;
                files.push(rel.clone());
                format!("Merged {} clips → {rel}", b.paths.len())
            }
            "slideshow" => {
                let rel = crate::media_edit::slideshow(
                    &ctx,
                    &bin,
                    &b.paths,
                    if b.seconds > 0.0 { b.seconds } else { 3.0 },
                    b.output.as_deref(),
                )?;
                files.push(rel.clone());
                format!("Slideshow → {rel}")
            }
            "probe" => {
                let (line, _) = crate::media_edit::probe(&ctx, &bin, &b.path)?;
                line
            }
            other => return Err(format!("unknown media edit action: {other}")),
        };
        Ok((files, line))
    })
    .await
    .map_err(|e| format!("media edit join failed: {e}"));
    match result {
        Ok(Ok((files, line))) => Json(json!({ "ok": true, "files": files, "message": line }))
            .into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(json!({ "detail": e }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "detail": e })),
        )
            .into_response(),
    }
}

// ---------- native /chat/compact (phase 3-1) ----------

