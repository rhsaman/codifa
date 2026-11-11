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
    /// The chat's workspace root, for the workspace fallback below. Optional —
    /// a stale renderer URL (or an inline chat image, which carries no root)
    /// still serves, with the data root as the fallback sandbox.
    #[serde(default)]
    root: String,
    path: String,
}

/// GET /media/file?path= — stream one generated media file to the renderer.
/// This is what the chat's `codifa-media://` markdown references resolve to:
/// the agent names a VIRTUAL path (`media/<chat-slug>/<file>`) relative to the
/// DATA root, the webview cannot read the disk, so the renderer rewrites the
/// scheme to this route.
///
/// A chat also names PLAIN filesystem paths — an absolute screenshot under
/// /var/folders, a workspace image the `read` tool attached. Those miss the
/// media sandbox, so the route falls back to `media_gen::resolve_media_input`
/// with the workspace root: the SAME containment the agent's own read tool
/// enforces (workspace, ~/.codifa, data root), so the route can never serve
/// anything the chat could not already read.
pub(super) async fn media_file(State(st): State<AppState>, Query(q): Query<MediaFileQuery>) -> Response<Body> {
    let data_root = st.root().to_string_lossy().into_owned();
    let ws_root = q.root.trim();
    let ws_root = if ws_root.is_empty() { data_root.as_str() } else { ws_root };
    // Virtual sandbox first (full bytes, the generated-media contract), then
    // the workspace file. Both legs containment-checked; whichever READS wins.
    let read_ok = |abs: std::path::PathBuf| {
        std::fs::read(&abs)
            .map(|bytes| (abs, bytes))
            .map_err(|e| e.to_string())
    };
    let served = crate::media_gen::resolve_media_virtual(&data_root, &q.path)
        .and_then(read_ok)
        .or_else(|_| {
            crate::media_gen::resolve_media_input(ws_root, &data_root, "", &q.path).and_then(read_ok)
        });
    let (abs, bytes) = match served {
        Ok(ok) => ok,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "detail": format!("cannot read {}: {e}", q.path) })),
            )
                .into_response()
        }
    };
    let mime = crate::media_gen::mime_for_path(&abs.to_string_lossy());
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
    /// The pixel space x/y/w/h are measured in — the DISPLAYED image's natural
    /// size. The viewer may show a downscaled copy (out-of-workspace files are
    /// read through the capped data-URL command), so the backend rescales the
    /// rectangle to the file's true dimensions before cropping. 0 = already in
    /// true pixels.
    #[serde(default)]
    src_w: u32,
    #[serde(default)]
    src_h: u32,
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
                    (b.src_w > 0 && b.src_h > 0).then_some((b.src_w, b.src_h)),
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

