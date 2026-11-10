//! Native media GENERATION: the `generate_image` / `edit_image` /
//! `generate_video` tools.
//!
//! The slots (Settings → Media Providers → Image / Video) name a provider from
//! the user's own list plus a default model and ordered fallbacks; this module
//! resolves that slot into a ladder of rungs and drives each rung's API shape:
//!
//!   * images, OpenAI-compatible → `POST {base}/images/generations` and
//!     `POST {base}/images/edits` (multipart, PNG mask built with `image`)
//!   * images, Google            → `POST {base}/models/{model}:generateContent`
//!     (prompt + optional `inlineData` reference, response carries `inlineData`)
//!   * video,  OpenAI (Sora)     → `POST {base}/videos` → poll `GET
//!     {base}/videos/{id}` → download `GET {base}/videos/{id}/content`
//!   * video,  Google (Veo)      → `POST {base}/models/{model}:predictLongRunning`
//!     → poll the returned operation → download the sample's `uri`
//!
//! Everything lands in the workspace `media/` folder and comes back as a
//! `codifa-media://` markdown reference the renderer rewrites to a local URL.
//! Payload builders and response parsers are pure so the provider contracts
//! stay unit-tested without any HTTP.

use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Upstream budget for one image request (generation OR edit).
pub const IMAGE_TIMEOUT_SECS: u64 = 300;

/// Wall-clock budget for ONE video rung: creation plus polling. A provider
/// that stays `in_progress` past this fails the rung and the ladder moves on.
pub const VIDEO_POLL_BUDGET_SECS: u64 = 900;

/// Pause between video job polls.
pub const VIDEO_POLL_INTERVAL_SECS: u64 = 5;

/// `media/` — the VIRTUAL root of every generated file: `<data_root>/media/<chat-slug>/<file>`.
/// Generated media NEVER lands in the workspace: it lives under the app's own
/// data root, scoped per chat, so a chat's folder dies with the chat (the
/// delete cascade in appstate.rs) and the user's project stays untouched.
pub const MEDIA_DIR: &str = "media";

/// The data-root folder holding ONE chat's generated media.
pub fn chat_media_dir(data_root: &str, chat_id: &str) -> PathBuf {
    let slug = chat_media_slug(chat_id);
    Path::new(data_root).join(MEDIA_DIR).join(slug)
}

/// The sanitized per-chat path component under `media/`.
pub fn chat_media_slug(chat_id: &str) -> String {
    crate::skills::safe_file(if chat_id.trim().is_empty() { "scratch" } else { chat_id.trim() }, "chat")
}

/// The VIRTUAL path tool results and `codifa-media://` refs carry:
/// `media/<chat-slug>/<file>`. The renderer resolves it against the data root
/// via `GET /media/file?path=…` — no workspace root, no chat id on the wire.
pub fn media_virtual(chat_id: &str, file_name: &str) -> String {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    format!("{MEDIA_DIR}/{}/{}", chat_media_slug(chat_id), name)
}

/// Resolve a VIRTUAL media path against the data root, containment-checked:
/// the normalized path must stay inside `<data_root>/media/`. `..` traversal
/// and absolute escapes are refused, exactly like the workspace sandbox.
pub fn resolve_media_virtual(data_root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err("empty media path".to_string());
    }
    let base = Path::new(data_root);
    if !base.exists() {
        return Err(format!("data root does not exist: {data_root}"));
    }
    let media_root = base.join(MEDIA_DIR);
    let target = media_root.join(rel.trim_start_matches(&format!("{MEDIA_DIR}/")[..]));
    // Lexical normalization WITHOUT touching the filesystem: `..` may only
    // cancel components inside the media root, never climb out of it.
    let mut clean = media_root.clone();
    for comp in target.components().skip(media_root.components().count()) {
        match comp {
            std::path::Component::ParentDir => {
                if !clean.pop() {
                    return Err(format!("media path escapes the media folder: {rel}"));
                }
            }
            std::path::Component::CurDir => {}
            c => clean.push(c.as_os_str()),
        }
    }
    if !clean.starts_with(&media_root) || clean == media_root {
        return Err(format!("media path escapes the media folder: {rel}"));
    }
    Ok(clean)
}

/// Resolve an INPUT file that may be (a) a virtual media path under the data
/// root or (b) a workspace file the user already had. Media paths win; the
/// workspace sandbox (with its data-root allowance) is the fallback, and a
/// bare filename gets one try inside the chat's media folder before failing.
pub fn resolve_media_input(
    workspace_root: &str,
    data_root: &str,
    chat_id: &str,
    rel: &str,
) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err("empty media path".to_string());
    }
    if trimmed.starts_with(&format!("{MEDIA_DIR}/")) {
        let p = resolve_media_virtual(data_root, trimmed)?;
        if p.exists() {
            return Ok(p);
        }
        return Err(format!("no such media file: {trimmed}"));
    }
    if let Ok(ws) = crate::tools::resolve_safe(workspace_root, trimmed, true, None) {
        if ws.exists() {
            return Ok(ws);
        }
    }
    let in_chat = chat_media_dir(data_root, chat_id)
        .join(trimmed.trim_start_matches('/'));
    if in_chat.exists() {
        return Ok(in_chat);
    }
    Err(format!("no such file: {rel}"))
}

/// One resolved rung of a media slot's fallback ladder: where to call, with
/// which credential, under which API shape (the provider `kind` decides).
#[derive(Debug, Clone, PartialEq)]
pub struct MediaTarget {
    pub kind: String,
    pub base_url: String,
    pub keys: Vec<String>,
    pub model: String,
}

/// Build one rung from a provider config Value (the renderer's camelCase
/// ProviderConfig: `kind`, `baseUrl`, `apiKeys`, legacy `apiKey`). Returns
/// `None` for a config without a usable base URL — a slot row pointing at a
/// deleted provider must fail loudly per-rung, not panic.
pub fn target_from_cfg(cfg: &Value, model: &str) -> Option<MediaTarget> {
    let base_url = cfg
        .get("baseUrl")
        .or_else(|| cfg.get("base_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .trim_end_matches('/')
        .to_string();
    let kind = cfg
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("custom")
        .to_string();
    let mut keys: Vec<String> = cfg
        .get("apiKeys")
        .or_else(|| cfg.get("api_keys"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if keys.is_empty() {
        if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
            if !k.trim().is_empty() {
                keys.push(k.to_string());
            }
        }
    }
    if keys.is_empty() {
        // Environment last, mirroring the chat path's resolution order: an
        // explicitly configured key always outranks it, and a provider kind
        // with no key at all still RUNS (some gateways are keyless).
        let env = crate::providers::env_key(&kind, "");
        if !env.is_empty() {
            keys.push(env);
        }
    }
    Some(MediaTarget {
        kind,
        base_url,
        keys,
        model: model.trim().to_string(),
    })
}

/// Resolve one media slot into its ordered rung ladder: the primary target
/// first (the slot's own default model — the model is a user setting, never a
/// per-call argument), then every configured fallback with its own model. A rung whose provider
/// id names nothing in `providers` is skipped — the caller fails with a
/// "not configured" message only when the WHOLE ladder came out empty.
pub fn media_ladder(
    provider_id: &str,
    model: &str,
    fallbacks: &[Value],
    providers: &std::collections::HashMap<String, Value>,
) -> Vec<MediaTarget> {
    let mut out: Vec<MediaTarget> = Vec::new();
    let id = provider_id.trim();
    if !id.is_empty() {
        if let Some(cfg) = providers.get(id) {
            if let Some(t) = target_from_cfg(cfg, model) {
                out.push(t);
            }
        }
    }
    for fb in fallbacks {
        let fid = fb["providerId"].as_str().unwrap_or_default().trim();
        if fid.is_empty() {
            continue;
        }
        let fmodel = fb["model"].as_str().unwrap_or_default();
        if let Some(cfg) = providers.get(fid) {
            if let Some(t) = target_from_cfg(cfg, fmodel) {
                out.push(t);
            }
        }
    }
    out
}

/// The refusal when a media tool has no rung to try at all. Named once so the
/// tool arms stay identical in wording.
pub fn not_configured_error(slot: &str) -> String {
    format!(
        "no {slot} provider configured — pick one in Settings → Media Providers (Image / Video) and set its model"
    )
}

// ---------------------------------------------------------------------------
// File naming + markdown
// ---------------------------------------------------------------------------

/// Extension for a returned MIME type (falls back to the request's default).
pub fn ext_for_mime(mime: &str, default: &'static str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim();
    match base {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => default,
    }
}

/// Workspace-relative path for a new generated file: `media/<kind>-<stamp>-<tag>.<ext>`.
/// The stamp keeps the listing chronological; the 4-char tag absorbs the
/// several-files-in-one-second case (parallel tool calls).
pub fn new_media_path(kind: &str, ext: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    let stamp = now.format("%Y%m%d-%H%M%S");
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let tag = &tag[..4];
    format!("{MEDIA_DIR}/{kind}-{stamp}-{tag}.{ext}")
}

/// The markdown reference the MODEL writes back to the user. The renderer
/// rewrites the `codifa-media://` scheme to a local serving URL; the model
/// never sees hostnames or ports.
pub fn codifa_media_ref(rel_path: &str) -> String {
    format!("codifa-media://{rel_path}")
}

/// Structured row for the tool card (`AgentEvent::Tool.results.files[]`).
pub fn media_file_row(rel_path: &str, bytes: usize, mime: &str) -> Value {
    json!({
        "path": rel_path,
        "url": codifa_media_ref(rel_path),
        "bytes": bytes,
        "mime": mime,
    })
}

/// Save bytes into the CHAT's media folder under the data root. `file_name`
/// is a bare name (any directory component is stripped). Returns the virtual
/// path (`media/<chat-slug>/<name>`) plus the byte count.
pub fn save_media(
    data_root: &str,
    chat_id: &str,
    file_name: &str,
    data: &[u8],
) -> Result<(String, usize), String> {
    let virtual_path = media_virtual(chat_id, file_name);
    let abs = resolve_media_virtual(data_root, &virtual_path)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create the chat media folder: {e}"))?;
    }
    std::fs::write(&abs, data).map_err(|e| format!("cannot write {virtual_path}: {e}"))?;
    Ok((virtual_path, data.len()))
}

// ---------------------------------------------------------------------------
// Images — OpenAI-compatible
// ---------------------------------------------------------------------------

/// Body for `POST {base}/images/generations`. `size` is forwarded only when the
/// model call named one — providers reject unknown sizes for their defaults.
pub fn openai_images_request(model: &str, prompt: &str, size: Option<&str>) -> Value {
    let mut body = json!({ "prompt": prompt, "model": model, "n": 1 });
    if let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) {
        body["size"] = json!(s);
    }
    // b64 keeps the bytes out of a second fetch (some gateways answer with a
    // signed URL that expires before the download).
    body["response_format"] = json!("b64_json");
    body
}

/// Text fields of the `POST {base}/images/edits` multipart form. The image and
/// (optional) mask file parts are appended by the caller.
pub fn openai_edit_fields(model: &str, prompt: &str, size: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("model".to_string(), model.to_string()),
        ("prompt".to_string(), prompt.to_string()),
    ];
    if let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) {
        fields.push(("size".to_string(), s.to_string()));
    }
    fields
}

/// Extract the image bytes out of an `/images` response. Every shape a gateway
/// answers with is handled: `data[].b64_json`, `data[].url` (fetched here so
/// the tool result is the file, not a link that dies), or a bare top-level
/// `b64_json` (some proxies flatten the payload). Pure for the structural
/// cases; the URL branch returns the url for the caller to download.
pub enum ImagePayload {
    /// Decoded image bytes + the MIME to name them with.
    Bytes(Vec<u8>, &'static str),
    /// A URL the caller must fetch (signed CDN links).
    Url(String),
}

impl std::fmt::Debug for ImagePayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImagePayload::Bytes(b, mime) => write!(f, "Bytes({} bytes, {mime})", b.len()),
            ImagePayload::Url(u) => write!(f, "Url({u})"),
        }
    }
}

pub fn openai_images_parse(body: &Value) -> Result<ImagePayload, String> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "image response has no `data` array".to_string())?;
    let first = data
        .first()
        .ok_or_else(|| "image response `data` is empty".to_string())?;
    if let Some(b64) = first.get("b64_json").and_then(Value::as_str) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("image b64_json decode failed: {e}"))?;
        // A 200 whose payload decodes to NOTHING is a dead upstream, not an
        // image: counting it as success would save a 0-byte file and the
        // fallback ladder would never be walked.
        if bytes.is_empty() {
            return Err("image b64_json decoded to zero bytes".to_string());
        }
        return Ok(ImagePayload::Bytes(bytes, "image/png"));
    }
    if let Some(url) = first.get("url").and_then(Value::as_str) {
        if !url.trim().is_empty() {
            return Ok(ImagePayload::Url(url.trim().to_string()));
        }
    }
    Err("image response carried neither b64_json nor url".to_string())
}

// ---------------------------------------------------------------------------
// Images — Google Gemini
// ---------------------------------------------------------------------------

/// Body for `POST {base}/models/{model}:generateContent` (image generation).
/// `reference` rides along as an `inlineData` part for image-to-image edits —
/// Gemini's image models edit by conditioning on the input picture, there is
/// no separate edits endpoint.
pub fn gemini_image_body(prompt: &str, reference: Option<(&[u8], &str)>) -> Value {
    let mut parts = vec![json!({ "text": prompt })];
    if let Some((bytes, mime)) = reference {
        parts.push(json!({
            "inlineData": {
                "mimeType": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        }));
    }
    json!({ "contents": [{ "parts": parts }] })
}

/// Pull the first `inlineData` image out of a generateContent response. A text
/// part can accompany it (safety notes etc.) — that text is the error surface
/// when NO image came back, so it is carried in the Err.
pub fn gemini_image_parse(body: &Value) -> Result<ImagePayload, String> {
    let parts = body["candidates"]
        .get(0)
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array);
    let mut note = String::new();
    if let Some(parts) = parts {
        for p in parts {
            if let Some(b64) = p["inlineData"]["data"].as_str() {
                let mime = p["inlineData"]["mimeType"]
                    .as_str()
                    .unwrap_or("image/png")
                    .to_string();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .map_err(|e| format!("gemini inlineData decode failed: {e}"))?;
                // Empty inline bytes are a dead upstream (a 200 with no
                // picture), not an image: rejecting here is what sends the
                // ladder on to the next rung instead of saving a 0-byte file.
                if bytes.is_empty() {
                    return Err("gemini inlineData decoded to zero bytes".to_string());
                }
                let static_mime: &'static str = match mime.as_str() {
                    "image/jpeg" | "image/jpg" => "image/jpeg",
                    "image/webp" => "image/webp",
                    _ => "image/png",
                };
                return Ok(ImagePayload::Bytes(bytes, static_mime));
            }
            if let Some(t) = p["text"].as_str() {
                if note.is_empty() {
                    note = t.to_string();
                }
            }
        }
    }
    Err(if note.is_empty() {
        "gemini response carried no image".to_string()
    } else {
        format!("gemini returned no image: {}", note.chars().take(200).collect::<String>())
    })
}

// ---------------------------------------------------------------------------
// Video — OpenAI (Sora) / videos API
// ---------------------------------------------------------------------------

/// Body for `POST {base}/videos` (text-to-video JSON form). The image-to-video
/// variant is multipart (`input_reference` file part) and built by the caller.
pub fn sora_create_body(model: &str, prompt: &str, seconds: Option<u64>, size: Option<&str>) -> Value {
    let mut body = json!({ "model": model, "prompt": prompt });
    if let Some(s) = seconds {
        body["seconds"] = json!(s.to_string());
    }
    if let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) {
        body["size"] = json!(s);
    }
    body
}

/// The two states a poll answer can be in. `Err` carries the provider's own
/// failure text when it named one.
pub enum VideoJobState {
    Running,
    Done,
    Failed(String),
}

pub fn sora_status_parse(body: &Value) -> VideoJobState {
    // OpenAI's native API answers with `status`; OpenRouter's /v1/videos also
    // documents `state`. Both are read, plus the success spellings either may
    // pick ("succeeded"), so one poll loop serves both providers.
    let status = body["status"]
        .as_str()
        .or_else(|| body["state"].as_str())
        .unwrap_or("");
    match status {
        "completed" | "succeeded" => VideoJobState::Done,
        "failed" | "error" => VideoJobState::Failed(
            body["error"]["message"]
                .as_str()
                .or_else(|| body["error"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "video generation failed".to_string()),
        ),
        _ => VideoJobState::Running,
    }
}

// ---------------------------------------------------------------------------
// Video — Google Veo
// ---------------------------------------------------------------------------

/// Body for `POST {base}/models/{model}:predictLongRunning`. The reference
/// image (image-to-video) rides as the instance's `image`. Aspect ratio is
/// derived from the requested `size` ("WxH") when given — Veo has no free-form
/// resolution.
pub fn veo_predict_body(prompt: &str, reference: Option<(&[u8], &str)>, seconds: Option<u64>, size: Option<&str>) -> Value {
    let mut instance = json!({ "prompt": prompt });
    if let Some((bytes, mime)) = reference {
        instance["image"] = json!({
            "bytesBase64Encoded": base64::engine::general_purpose::STANDARD.encode(bytes),
            "mimeType": mime,
        });
    }
    let mut parameters = json!({});
    if let Some(s) = seconds {
        parameters["durationSeconds"] = json!(s.min(8));
    }
    if let Some(size) = size.map(str::trim).filter(|s| !s.is_empty()) {
        let aspect = if let Some((w, h)) = size.split_once('x') {
            let (w, h): (f64, f64) = match (w.parse(), h.parse()) {
                (Ok(w), Ok(h)) if w > 0.0 && h > 0.0 => (w, h),
                _ => (16.0, 9.0),
            };
            if w / h > 1.05 { "16:9" } else if h / w > 1.05 { "9:16" } else { "1:1" }
        } else {
            "16:9"
        };
        parameters["aspectRatio"] = json!(aspect);
    }
    json!({ "instances": [instance], "parameters": parameters })
}

/// Extract the downloadable video URI from a DONE operation. Veo has shipped
/// two shapes (`generatedSamples[].video.uri` and newer `videos[].gcsUri` /
/// `video.uri`); both are read here.
pub fn veo_operation_video_uri(body: &Value) -> Result<Option<String>, String> {
    if body["error"].is_object() {
        let msg = body["error"]["message"]
            .as_str()
            .unwrap_or("operation failed");
        return Err(msg.to_string());
    }
    if body["done"].as_bool() != Some(true) {
        return Ok(None);
    }
    let resp = &body["response"];
    let sample_uri = resp["generateVideoResponse"]["generatedSamples"]
        .get(0)
        .and_then(|s| s["video"]["uri"].as_str());
    let videos_uri = resp["videos"].get(0).and_then(|v| {
        v["gcsUri"].as_str().or_else(|| v["video"]["uri"].as_str())
    });
    Ok(sample_uri
        .or(videos_uri)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string))
}

// ---------------------------------------------------------------------------
// Images — OpenRouter (chat-completions image output)
// ---------------------------------------------------------------------------

/// OpenRouter has no `/images` endpoint: image-capable models (gemini image,
/// gpt-image…) generate through `POST {base}/chat/completions` when the
/// request carries `modalities: ["image", "text"]`, and the pictures come
/// back INSIDE the assistant message. The reference image (edit flow) rides
/// as an `image_url` content part, exactly like an input picture.
pub fn openrouter_image_body(model: &str, prompt: &str, reference: Option<(&[u8], &str)>) -> Value {
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    if let Some((bytes, mime)) = reference {
        content.push(json!({
            "type": "image_url",
            "image_url": {
                "url": format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            }
        }));
    }
    // `model` is NOT optional on the wire: gateways answer `Missing model`
    // without it, and OpenRouter itself routes by it.
    json!({
        "model": model,
        "modalities": ["image", "text"],
        "messages": [{ "role": "user", "content": content }]
    })
}

/// Decode a `data:` URL into (bytes, mime). Returns `None` for a non-data URL
/// (the caller then fetches it over HTTP).
pub fn parse_data_url(url: &str) -> Option<(Vec<u8>, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?.trim().to_string();
    if mime.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()?;
    Some((bytes, mime))
}

/// Pull the first image out of a chat-completions response that carried the
/// `modalities` parameter. `message.images[].image_url.url` is usually a data
/// URL; an https URL is handed back for the caller to download. A text-only
/// answer means the model refused or the gateway ignored `modalities` — the
/// text becomes the error so the model can react to it.
pub fn openrouter_image_parse(body: &Value) -> Result<ImagePayload, String> {
    let msg = body["choices"].get(0).map(|c| &c["message"]);
    if let Some(msg) = msg {
        if let Some(images) = msg["images"].as_array() {
            for img in images {
                let url = img["image_url"]["url"].as_str().unwrap_or_default().trim();
                if url.is_empty() {
                    continue;
                }
                if let Some((bytes, mime)) = parse_data_url(url) {
                    // A data URL that decodes to nothing is the gateway's own
                    // "upstream died" answer: skip it so the next image (or the
                    // no-image error below) is what decides this rung.
                    if bytes.is_empty() {
                        continue;
                    }
                    let static_mime: &'static str = match mime.as_str() {
                        "image/jpeg" | "image/jpg" => "image/jpeg",
                        "image/webp" => "image/webp",
                        _ => "image/png",
                    };
                    return Ok(ImagePayload::Bytes(bytes, static_mime));
                }
                return Ok(ImagePayload::Url(url.to_string()));
            }
        }
        if let Some(t) = msg["content"].as_str() {
            if !t.trim().is_empty() {
                return Err(format!(
                    "openrouter returned no image: {}",
                    t.trim().chars().take(200).collect::<String>()
                ));
            }
        }
    }
    Err("openrouter response carried no image".to_string())
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

/// The one-line media summary `edit_video(action=probe)` returns: what the
/// model needs to pick trim bounds, merge orders and conversions without
/// dumping a whole JSON tree into the transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaInfo {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: String,
}

pub fn ffprobe_parse(body: &Value) -> Result<MediaInfo, String> {
    let format = body
        .get("format")
        .ok_or_else(|| "ffprobe response has no `format`".to_string())?;
    let duration_secs = format["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0f64;
    let mut video_codec = String::new();
    let mut audio_codec = String::new();
    for stream in body["streams"].as_array().unwrap_or(&Vec::new()) {
        match stream["codec_type"].as_str() {
            Some("video") => {
                if video_codec.is_empty() {
                    width = stream["width"].as_u64().unwrap_or(0) as u32;
                    height = stream["height"].as_u64().unwrap_or(0) as u32;
                    video_codec = stream["codec_name"].as_str().unwrap_or("").to_string();
                    let rate = stream["avg_frame_rate"].as_str().unwrap_or("0/1");
                    let (n, d) = rate.split_once('/').unwrap_or((rate, "1"));
                    fps = n.trim().parse::<f64>().ok().unwrap_or(0.0)
                        / d.trim().parse::<f64>().ok().unwrap_or(1.0).max(1.0);
                }
            }
            Some("audio") => {
                if audio_codec.is_empty() {
                    audio_codec = stream["codec_name"].as_str().unwrap_or("").to_string();
                }
            }
            _ => {}
        }
    }
    Ok(MediaInfo {
        duration_secs,
        width,
        height,
        fps,
        video_codec,
        audio_codec,
    })
}

/// The probe answer the MODEL sees: one compact line, numbers rounded so the
/// transcript stays readable.
pub fn media_info_line(rel_path: &str, info: &MediaInfo) -> String {
    format!(
        "{}: {:.2}s, {}x{} @ {:.2} fps, video={}, audio={}",
        rel_path,
        info.duration_secs,
        info.width,
        info.height,
        info.fps,
        if info.video_codec.is_empty() { "none" } else { &info.video_codec },
        if info.audio_codec.is_empty() { "none" } else { &info.audio_codec },
    )
}

// ---------------------------------------------------------------------------
// Async execution — the actual HTTP round trips
// ---------------------------------------------------------------------------

/// A finished generation: where it was saved and what it is.
#[derive(Debug, Clone)]
pub struct GeneratedMedia {
    pub rel_path: String,
    pub bytes: usize,
    pub mime: String,
}

/// Rectangle to re-generate inside an existing picture (the `edit_image`
/// `mask_region`, and the manual editor's selection), in source pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaskRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl MaskRegion {
    pub fn from_args(v: &Value) -> Option<MaskRegion> {
        let get = |k: &str| -> Option<u32> {
            v[k].as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .map(|n| n as u32)
        };
        // A `[x, y, w, h]` array spelling is accepted too — the model draws
        // both shapes in practice.
        if let Some(arr) = v.as_array() {
            if arr.len() == 4 {
                let nums: Vec<u32> = arr
                    .iter()
                    .map(|n| n.as_u64().unwrap_or(0).min(u32::MAX as u64) as u32)
                    .collect();
                return MaskRegion::from_parts(nums[0], nums[1], nums[2], nums[3]);
            }
        }
        MaskRegion::from_parts(get("x")?, get("y")?, get("w")?, get("h")?)
    }

    /// `None` when the rectangle has no area — an empty selection must be
    /// refused here instead of reaching a provider as a zero-size mask.
    fn from_parts(x: u32, y: u32, w: u32, h: u32) -> Option<MaskRegion> {
        (w > 0 && h > 0).then_some(MaskRegion { x, y, w, h })
    }
}

/// MIME for a workspace file by extension — what the multipart uploads and the
/// `data:` URLs name the bytes with.
pub fn mime_for_path(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// True for the kinds that speak Gemini's own wire format (`:generateContent`
/// / `:predictLongRunning`). Everything else is OpenAI-compatible at heart —
/// including the `custom` rows (9router-style gateways) — with OpenRouter as
/// its own image special case below.
fn is_google(kind: &str) -> bool {
    kind.eq_ignore_ascii_case("google") || kind.eq_ignore_ascii_case("gemini")
}

/// One Google media URL — `:generateContent`, `:predictLongRunning` or an
/// operation poll — hung off the SAME native API prefix chat uses.
///
/// The saved base is the OpenAI-compat one (`…/v1beta/openai`), so appending
/// `/models/…` to it produced `…/v1beta/openai/models/…`: a 404 for every
/// Google image/video call. `gemini_native_api` strips the compat suffix first,
/// which is what keeps one provider row serving chat AND media.
fn gemini_media_url(base_url: &str, tail: &str) -> String {
    format!(
        "{}/{}",
        crate::llm::gemini_native_api(base_url),
        tail.trim_start_matches('/')
    )
}

fn auth_headers(
    req: reqwest::RequestBuilder,
    keys: &[String],
    key_index: usize,
    google: bool,
) -> reqwest::RequestBuilder {
    let key = keys.get(key_index).map(|s| s.trim()).unwrap_or("");
    if google {
        if key.is_empty() {
            req
        } else {
            req.header("x-goog-api-key", key)
        }
    } else if key.is_empty() {
        req
    } else {
        req.header("Authorization", format!("Bearer {key}"))
    }
}

/// POST one JSON body, trying every configured key in order on the auth-shaped
/// rejections (401/403/429 — same retry class the chat ladder uses). Returns
/// the parsed body or the LAST provider error with its status.
async fn post_json(
    url: &str,
    keys: &[String],
    body: &Value,
    google: bool,
    timeout: Duration,
) -> Result<Value, String> {
    let client = crate::llm::http_client();
    let attempts = keys.len().max(1);
    let mut last = String::new();
    for i in 0..attempts {
        let res = auth_headers(client.post(url), keys, i, google)
            .timeout(timeout)
            .json(body)
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => return Err(format!("request failed: {e}")),
        };
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if status.is_success() {
            return serde_json::from_str(&text)
                .map_err(|e| format!("response unparsable: {e} — {}", head(&text)));
        }
        last = format!("HTTP {}: {}", status.as_u16(), head(&text));
        if matches!(status.as_u16(), 401 | 403 | 429) && i + 1 < attempts {
            continue;
        }
        return Err(last);
    }
    Err(last)
}

/// POST a multipart form (image bytes + optional mask + text fields) with the
/// same key ladder as `post_json`.
async fn post_multipart(
    url: &str,
    keys: &[String],
    fields: &[(String, String)],
    file_field: &str,
    file_name: &str,
    file_mime: &str,
    file_bytes: Vec<u8>,
    mask: Option<(String, Vec<u8>)>,
    timeout: Duration,
) -> Result<Value, String> {
    let client = crate::llm::http_client();
    let attempts = keys.len().max(1);
    let mut last = String::new();
    for i in 0..attempts {
        let mut form = reqwest::multipart::Form::new();
        for (k, v) in fields {
            form = form.text(k.clone(), v.clone());
        }
        form = form.part(
            file_field.to_string(),
            reqwest::multipart::Part::bytes(file_bytes.clone())
                .file_name(file_name.to_string())
                .mime_str(file_mime)
                .unwrap_or_else(|_| reqwest::multipart::Part::bytes(file_bytes.clone())),
        );
        if let Some((mask_name, mask_bytes)) = &mask {
            form = form.part(
                "mask".to_string(),
                reqwest::multipart::Part::bytes(mask_bytes.clone())
                    .file_name(mask_name.clone())
                    .mime_str("image/png")
                    .unwrap_or_else(|_| reqwest::multipart::Part::bytes(mask_bytes.clone())),
            );
        }
        let res = auth_headers(client.post(url), keys, i, false)
            .timeout(timeout)
            .multipart(form)
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => return Err(format!("request failed: {e}")),
        };
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if status.is_success() {
            return serde_json::from_str(&text)
                .map_err(|e| format!("response unparsable: {e} — {}", head(&text)));
        }
        last = format!("HTTP {}: {}", status.as_u16(), head(&text));
        if matches!(status.as_u16(), 401 | 403 | 429) && i + 1 < attempts {
            continue;
        }
        return Err(last);
    }
    Err(last)
}

/// GET raw bytes (the image/video download legs), returning the bytes and the
/// upstream Content-Type when the server named one.
async fn get_bytes(url: &str, keys: &[String], google: bool, timeout: Duration) -> Result<(Vec<u8>, String), String> {
    let client = crate::llm::http_client();
    let attempts = keys.len().max(1);
    let mut last = String::new();
    for i in 0..attempts {
        let res = auth_headers(client.get(url), keys, i, google)
            .timeout(timeout)
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => return Err(format!("download failed: {e}")),
        };
        let status = res.status();
        if status.is_success() {
            let mime = res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            let bytes = res.bytes().await.map_err(|e| format!("download read failed: {e}"))?;
            return Ok((bytes.to_vec(), mime));
        }
        last = format!("HTTP {}", status.as_u16());
        if matches!(status.as_u16(), 401 | 403 | 429) && i + 1 < attempts {
            continue;
        }
        return Err(last);
    }
    Err(last)
}

/// First 300 chars of a body, HTML stripped — the error surface every arm
/// hands back so a gateway error page never reaches the transcript verbatim.
fn head(text: &str) -> String {
    let cleaned = crate::media::strip_tags(text);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "(empty body)".to_string()
    } else {
        cleaned.chars().take(300).collect()
    }
}

async fn payload_bytes(payload: ImagePayload, keys: &[String]) -> Result<(Vec<u8>, &'static str), String> {
    let (bytes, mime) = match payload {
        ImagePayload::Bytes(b, mime) => (b, mime),
        ImagePayload::Url(url) => {
            let (bytes, mime) = get_bytes(&url, keys, false, Duration::from_secs(IMAGE_TIMEOUT_SECS)).await?;
            let static_mime: &'static str = if mime.starts_with("image/jpeg") {
                "image/jpeg"
            } else if mime.starts_with("image/webp") {
                "image/webp"
            } else {
                "image/png"
            };
            (bytes, static_mime)
        }
    };
    // A signed URL that downloads to NOTHING is a provider failure, not a
    // picture: the fallback ladder must see the rung as failed. (Same rule as
    // the TTS chain's empty-audio check.)
    if bytes.is_empty() {
        return Err("provider returned an empty image (0 bytes)".to_string());
    }
    Ok((bytes, mime))
}

/// Build a PNG mask for `POST /images/edits` from a rectangle: opaque black
/// everywhere EXCEPT the region, which is fully transparent — OpenAI's
/// convention (transparent = "edit here"). The input is re-encoded to PNG as
/// well, because the edits endpoint requires image and mask to match in size
/// and the mask must be a PNG.
pub fn build_edit_pngs(
    input: &[u8],
    region: MaskRegion,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let img = image::load_from_memory(input).map_err(|e| format!("input image unparsable: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut mask = image::RgbaImage::from_pixel(w, h, image::Rgba([0, 0, 0, 255]));
    let x1 = region.x.min(w);
    let y1 = region.y.min(h);
    let x2 = region.x.saturating_add(region.w).min(w);
    let y2 = region.y.saturating_add(region.h).min(h);
    for y in y1..y2 {
        for x in x1..x2 {
            mask.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
        }
    }
    let mut input_png = Vec::new();
    rgba.write_to(
        &mut std::io::Cursor::new(&mut input_png),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("input re-encode failed: {e}"))?;
    let mut mask_png = Vec::new();
    mask
        .write_to(
            &mut std::io::Cursor::new(&mut mask_png),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("mask encode failed: {e}"))?;
    Ok((input_png, mask_png))
}

/// Generate one image with the rung's API shape and save it into the CHAT's
/// media folder under the data root. `output` (when the mode allows one) is
/// honored as a FILE NAME inside that folder — never a workspace path.
/// Returns the model-facing summary line.
pub async fn generate_image(
    data_root: &str,
    chat_id: &str,
    target: &MediaTarget,
    prompt: &str,
    size: Option<&str>,
    output: Option<&str>,
) -> Result<GeneratedMedia, String> {
    let timeout = Duration::from_secs(IMAGE_TIMEOUT_SECS);
    let google = is_google(&target.kind);
    let payload = if google {
        let url = gemini_media_url(
            &target.base_url,
            &format!("models/{}:generateContent", crate::llm::google_model_name(&target.model)),
        );
        let body = gemini_image_body(prompt, None);
        let resp = post_json(&url, &target.keys, &body, true, timeout).await?;
        gemini_image_parse(&resp)?
    } else if target.kind.eq_ignore_ascii_case("openrouter") {
        let url = format!("{}/chat/completions", target.base_url);
        let body = openrouter_image_body(&target.model, prompt, None);
        let resp = post_json(&url, &target.keys, &body, false, timeout).await?;
        openrouter_image_parse(&resp)?
    } else {
        let url = format!("{}/images/generations", target.base_url);
        let body = openai_images_request(&target.model, prompt, size);
        let resp = post_json(&url, &target.keys, &body, false, timeout).await;
        match resp {
            Ok(v) => openai_images_parse(&v)?,
            // 9router-style custom gateways may expose image models ONLY
            // through chat-completions output. A failed native attempt gets
            // ONE second shape before giving up; on double failure the
            // NATIVE error is the one reported (it names the primary shape).
            Err(native_err) => {
                let url = format!("{}/chat/completions", target.base_url);
                let body = openrouter_image_body(&target.model, prompt, None);
                let resp = post_json(&url, &target.keys, &body, false, timeout).await?;
                match openrouter_image_parse(&resp) {
                    Ok(p) => p,
                    Err(_) => return Err(native_err),
                }
            }
        }
    };
    let (bytes, mime) = payload_bytes(payload, &target.keys).await?;
    let rel = output_to_virtual(chat_id, output, || {
        new_media_path("image", ext_for_mime(mime, "png"), chrono::Utc::now())
    });
    let (rel, len) = save_media(data_root, chat_id, &rel, &bytes)?;
    Ok(GeneratedMedia {
        rel_path: rel,
        bytes: len,
        mime: mime.to_string(),
    })
}

/// The save name for an explicit `output` argument: only the FILE NAME is
/// honored — the file always lands inside the CHAT's media folder, so no call
/// can aim a write at a workspace path or outside the app's own data.
fn output_to_virtual(
    chat_id: &str,
    output: Option<&str>,
    default: impl FnOnce() -> String,
) -> String {
    match output.map(str::trim).filter(|s| !s.is_empty()) {
        Some(o) => {
            let fallback = default();
            let name = Path::new(o)
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| fallback.as_str());
            media_virtual(chat_id, name)
        }
        None => media_virtual(chat_id, &default()),
    }
}

/// Paste `patch` into `base` at (x, y) with a LINEAR alpha ramp of `feather`
/// px on every edge, so the seam blends into the original instead of leaving
/// a hard rectangle. Everything outside the patch stays BIT-IDENTICAL — this
/// is what makes a region edit exact for providers without a native mask.
fn composite_region(base: &mut image::RgbaImage, patch: image::RgbaImage, x: u32, y: u32, feather: u32) {
    let (bw, bh) = base.dimensions();
    let (pw, ph) = patch.dimensions();
    for py in 0..ph {
        let by = y + py;
        if by >= bh {
            break;
        }
        for px in 0..pw {
            let bx = x + px;
            if bx >= bw {
                break;
            }
            // Distance to the nearest patch edge drives the blend: 0 at the
            // rim (fully original), 1 at `feather` inward (fully edited).
            let d_edge = px.min(py).min(pw - 1 - px).min(ph - 1 - py);
            let t = if feather == 0 {
                255
            } else {
                (d_edge.min(feather) * 255 / feather) as u8
            };
            if t == 0 {
                continue;
            }
            let p = patch.get_pixel(px, py);
            let a = (p.0[3] as u16 * t as u16 / 255) as u8;
            if a == 0 {
                continue;
            }
            let b = base.get_pixel_mut(bx, by);
            let inv = 255u16 - a as u16;
            for c in 0..3 {
                b.0[c] = ((b.0[c] as u16 * inv + p.0[c] as u16 * a as u16) / 255) as u8;
            }
            // Union of coverages, clamped — keeps the base opaque.
            b.0[3] = ((a as u16 + b.0[3] as u16 * inv / 255).min(255)) as u8;
        }
    }
}

/// Crop `rect` (clamped) out of an RGBA image with a context margin so the
/// model sees the surroundings it must blend into. Returns the crop and the
/// clamped crop rect actually used.
fn crop_with_context(
    img: &image::RgbaImage,
    rect: MaskRegion,
    pad: u32,
) -> (image::RgbaImage, MaskRegion) {
    let (w, h) = img.dimensions();
    let x0 = rect.x.min(w).saturating_sub(pad);
    let y0 = rect.y.min(h).saturating_sub(pad);
    let x1 = (rect.x.saturating_add(rect.w).min(w)).min(w);
    let y1 = (rect.y.saturating_add(rect.h).min(h)).min(h);
    let crop_w = (x1 - x0).max(1);
    let crop_h = (y1 - y0).max(1);
    let crop = image::imageops::crop_imm(img, x0, y0, crop_w, crop_h).to_image();
    (
        crop,
        MaskRegion {
            x: x0,
            y: y0,
            w: crop_w,
            h: crop_h,
        },
    )
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut out),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(out)
}

/// Edit an existing image (full-frame prompt, or a rectangle-only
/// re-generation through a mask). The input may be a virtual media path
/// (a generated file) or a workspace file; the EDITED copy is saved as a NEW
/// file in the chat's media folder — the original is never overwritten.
pub async fn edit_image(
    workspace_root: &str,
    data_root: &str,
    chat_id: &str,
    target: &MediaTarget,
    input_rel: &str,
    prompt: &str,
    mask_region: Option<MaskRegion>,
    size: Option<&str>,
    output: Option<&str>,
) -> Result<GeneratedMedia, String> {
    let abs = resolve_media_input(workspace_root, data_root, chat_id, input_rel)?;
    let input = std::fs::read(&abs).map_err(|e| format!("cannot read {input_rel}: {e}"))?;
    let timeout = Duration::from_secs(IMAGE_TIMEOUT_SECS);
    let google = is_google(&target.kind);
    let chat_output = target.kind.eq_ignore_ascii_case("openrouter");

    // REGION PRECISION. Google and chat-output rungs have NO mask concept —
    // asking them to "only change x,y,w,h" over the WHOLE picture lets the
    // model drift over every pixel. So the region is enforced LOCALLY:
    // only the crop (region + a small context ring) travels to the model,
    // the answer is pasted back with a feathered seam, and everything
    // outside the crop stays BIT-IDENTICAL. OpenAI-compatible rungs keep
    // the native edits-mask instead (the provider honors it itself).
    let native_mask = !google && !chat_output;
    let composite: Option<(
        image::RgbaImage,   // full base picture
        image::RgbaImage,   // the crop that goes to the model
        MaskRegion,         // the crop rect in base coordinates
        u32,                // feather width
    )> = match mask_region {
        Some(r) if !native_mask => {
            let base = image::load_from_memory(&input)
                .map_err(|e| format!("input image unparsable: {e}"))?
                .to_rgba8();
            let (crop, crop_rect) = crop_with_context(&base, r, 24);
            let feather = 24.min(crop_rect.w / 2).min(crop_rect.h / 2).max(1);
            Some((base, crop, crop_rect, feather))
        }
        _ => None,
    };

    let region_prompt = |p: &str| match &composite {
        // The crop IS the scope; the ring around the region is context only.
        Some(_) => format!(
            "Edit this image: {p}. The CENTER of the picture is the area to change; keep the outer margin as-is."
        ),
        None => p.to_string(),
    };

    let result_bytes: Vec<u8>;
    let mut result_mime: &'static str;
    if google {
        let url = gemini_media_url(
            &target.base_url,
            &format!("models/{}:generateContent", crate::llm::google_model_name(&target.model)),
        );
        let reference = match &composite {
            Some((_, crop, _, _)) => Some((crop.as_raw().as_slice(), "image/png")),
            None => Some((&input[..], mime_for_path(input_rel))),
        };
        let body = gemini_image_body(&region_prompt(prompt), reference);
        let resp = post_json(&url, &target.keys, &body, true, timeout).await?;
        let (b, m) = payload_bytes(gemini_image_parse(&resp)?, &target.keys).await?;
        result_bytes = b;
        result_mime = m;
    } else if chat_output {
        let url = format!("{}/chat/completions", target.base_url);
        let reference = match &composite {
            Some((_, crop, _, _)) => Some((crop.as_raw().as_slice(), "image/png")),
            None => Some((&input[..], mime_for_path(input_rel))),
        };
        let body = openrouter_image_body(&target.model, &region_prompt(prompt), reference);
        let resp = post_json(&url, &target.keys, &body, false, timeout).await?;
        let (b, m) = payload_bytes(openrouter_image_parse(&resp)?, &target.keys).await?;
        result_bytes = b;
        result_mime = m;
    } else {
        let url = format!("{}/images/edits", target.base_url);
        let fields = openai_edit_fields(&target.model, prompt, size);
        let (image_png, mask_png) = match mask_region {
            Some(r) => {
                let pair = build_edit_pngs(&input, r)?;
                (pair.0, Some(("mask.png".to_string(), pair.1)))
            }
            None => (input.clone(), None),
        };
        let attempt = post_multipart(
            &url,
            &target.keys,
            &fields,
            "image",
            "input.png",
            "image/png",
            image_png,
            mask_png,
            timeout,
        )
        .await;
        match attempt {
            Ok(v) => {
                let (b, m) = payload_bytes(openai_images_parse(&v)?, &target.keys).await?;
                result_bytes = b;
                result_mime = m;
            }
            // 9router-style custom gateways expose image models ONLY through
            // chat-completions output (no /images/edits route at all). One
            // second shape before giving up; on double failure the NATIVE
            // error is the one reported.
            Err(native_err) => {
                let chat_url = format!("{}/chat/completions", target.base_url);
                let reference = match &composite {
                    Some((_, crop, _, _)) => Some((crop.as_raw().as_slice(), "image/png")),
                    None => Some((&input[..], mime_for_path(input_rel))),
                };
                let body = openrouter_image_body(&target.model, &region_prompt(prompt), reference);
                let resp = post_json(&chat_url, &target.keys, &body, false, timeout).await?;
                match openrouter_image_parse(&resp) {
                    Ok(p) => {
                        let (b, m) = payload_bytes(p, &target.keys).await?;
                        result_bytes = b;
                        result_mime = m;
                    }
                    Err(_) => return Err(native_err),
                }
            }
        }
    }

    // Paste the edited crop back: the ONLY pixels that can change are inside
    // the crop rect, and the rim ramps to the original — the rest of the
    // picture is byte-for-byte the input.
    let (bytes, mime) = match composite {
        Some((mut base, _crop, crop_rect, feather)) => {
            let edited = image::load_from_memory(&result_bytes)
                .map_err(|e| format!("edited image unparsable: {e}"))?
                .to_rgba8();
            // The model may answer at any resolution: normalize to the crop's
            // exact size before pasting.
            let patch = if edited.dimensions() == (crop_rect.w, crop_rect.h) {
                edited
            } else {
                image::imageops::resize(
                    &edited,
                    crop_rect.w,
                    crop_rect.h,
                    image::imageops::FilterType::Lanczos3,
                )
            };
            composite_region(&mut base, patch, crop_rect.x, crop_rect.y, feather);
            result_mime = "image/png";
            (encode_png(&base)?, result_mime)
        }
        None => (result_bytes, result_mime),
    };
    let rel = output_to_virtual(chat_id, output, || {
        new_media_path("image-edit", ext_for_mime(mime, "png"), chrono::Utc::now())
    });
    let (rel, len) = save_media(data_root, chat_id, &rel, &bytes)?;
    Ok(GeneratedMedia {
        rel_path: rel,
        bytes: len,
        mime: mime.to_string(),
    })
}

/// Poll one job URL until it completes, fails, or the budget runs out.
/// Shared by the Sora and Veo shapes — the caller decides what "done" means.
async fn poll_until<F>(
    url: &str,
    keys: &[String],
    google: bool,
    mut done: F,
) -> Result<Value, String>
where
    F: FnMut(&Value) -> Result<bool, String>,
{
    let deadline =
        std::time::Instant::now() + Duration::from_secs(VIDEO_POLL_BUDGET_SECS);
    loop {
        tokio::time::sleep(Duration::from_secs(VIDEO_POLL_INTERVAL_SECS)).await;
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "video job still running after {}s — try again or pick a shorter clip",
                VIDEO_POLL_BUDGET_SECS
            ));
        }
        let client = crate::llm::http_client();
        let res = auth_headers(client.get(url), keys, 0, google)
            .timeout(Duration::from_secs(60))
            .send()
            .await;
        let res = res.map_err(|e| format!("video poll failed: {e}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("video poll failed: HTTP {} {}", status.as_u16(), head(&text)));
        }
        let body: Value = serde_json::from_str(&text)
            .map_err(|e| format!("video poll unparsable: {e} — {}", head(&text)))?;
        if done(&body)? {
            return Ok(body);
        }
    }
}

/// Generate one video and save it into the CHAT's media folder under the data
/// root. Google rungs speak Veo's long-running-operation shape; everything
/// else — OpenAI native AND OpenRouter's `/v1/videos`, plus 9router-style
/// gateways that proxy either — speaks the Sora shape.
pub async fn generate_video(
    workspace_root: &str,
    data_root: &str,
    chat_id: &str,
    target: &MediaTarget,
    prompt: &str,
    seconds: Option<u64>,
    size: Option<&str>,
    image_rel: Option<&str>,
    output: Option<&str>,
) -> Result<GeneratedMedia, String> {
    let timeout = Duration::from_secs(IMAGE_TIMEOUT_SECS);
    let reference = match image_rel.map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => {
            let abs = resolve_media_input(workspace_root, data_root, chat_id, rel)?;
            let bytes = std::fs::read(&abs).map_err(|e| format!("cannot read {rel}: {e}"))?;
            Some((bytes, mime_for_path(rel)))
        }
        None => None,
    };

    let (video_bytes, mime) = if is_google(&target.kind) {
        let url = gemini_media_url(
            &target.base_url,
            &format!("models/{}:predictLongRunning", crate::llm::google_model_name(&target.model)),
        );
        let body = {
            let reference_ref = reference.as_ref().map(|(b, m)| (b.as_slice(), *m));
            veo_predict_body(prompt, reference_ref, seconds, size)
        };
        let started = post_json(&url, &target.keys, &body, true, timeout).await?;
        let op_name = started["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "veo returned no operation name".to_string())?
            .trim()
            .trim_start_matches('/')
            .to_string();
        let poll_url = gemini_media_url(&target.base_url, &op_name);
        let done = poll_until(&poll_url, &target.keys, true, |b| {
            // Err = the operation itself failed; Ok(false) = still running.
            match veo_operation_video_uri(b) {
                Err(e) => Err(e),
                Ok(None) => Ok(false),
                Ok(Some(_)) => Ok(true),
            }
        })
        .await?;
        let uri = veo_operation_video_uri(&done)?
            .ok_or_else(|| "veo operation completed without a video".to_string())?;
        let (bytes, mime) = get_bytes(&uri, &target.keys, true, timeout).await?;
        (bytes, mime)
    } else {
        // Sora shape. The image-to-video variant is multipart with an
        // `input_reference` file part; plain text-to-video is JSON.
        let create_url = format!("{}/videos", target.base_url);
        let created = match &reference {
            Some((bytes, mime)) => {
                let mut fields: Vec<(String, String)> = vec![
                    ("model".to_string(), target.model.clone()),
                    ("prompt".to_string(), prompt.to_string()),
                ];
                if let Some(s) = seconds {
                    fields.push(("seconds".to_string(), s.to_string()));
                }
                if let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) {
                    fields.push(("size".to_string(), s.to_string()));
                }
                post_multipart(
                    &create_url,
                    &target.keys,
                    &fields,
                    "input_reference",
                    "reference.png",
                    mime,
                    bytes.clone(),
                    None,
                    timeout,
                )
                .await?
            }
            None => {
                let body = sora_create_body(&target.model, prompt, seconds, size);
                post_json(&create_url, &target.keys, &body, false, timeout).await?
            }
        };
        let job_id = created["id"]
            .as_str()
            .or_else(|| created["job_id"].as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("video create returned no job id — {}", head(&created.to_string())))?
            .trim()
            .to_string();
        let poll_url = format!("{create_url}/{job_id}");
        // A FAILED job must stop the poll immediately with its own message —
        // only a Done state proceeds to the content download.
        poll_until(&poll_url, &target.keys, false, |b| match sora_status_parse(b) {
            VideoJobState::Done => Ok(true),
            VideoJobState::Failed(e) => Err(e),
            VideoJobState::Running => Ok(false),
        })
        .await?;
        let content_url = format!("{create_url}/{job_id}/content");
        let (bytes, mime) = get_bytes(&content_url, &target.keys, false, timeout).await?;
        (bytes, mime)
    };

    let ext = ext_for_mime(&mime, "mp4");
    // A completed job that hands back zero bytes is a provider failure, not a
    // clip: failing the rung is what walks the fallback ladder.
    if video_bytes.is_empty() {
        return Err("provider returned an empty video (0 bytes)".to_string());
    }
    let rel = output_to_virtual(chat_id, output, || new_media_path("clip", ext, chrono::Utc::now()));
    let (rel, len) = save_media(data_root, chat_id, &rel, &video_bytes)?;
    Ok(GeneratedMedia {
        rel_path: rel,
        bytes: len,
        mime: if mime.is_empty() { format!("video/{ext}") } else { mime },
    })
}

/// The model-facing summary line for one generated file — what the tool result
/// carries: the markdown reference first (the model copies it into its reply),
/// then the facts.
pub fn generated_summary(kind_word: &str, media: &GeneratedMedia, target_kind: &str) -> String {
    format!(
        "Saved {kind_word}: ![{rel}]({ref_url}) ({bytes} bytes, {mime}, via {provider}).\n\
         Show it to the user by including that markdown line in your reply VERBATIM.",
        rel = media.rel_path,
        ref_url = codifa_media_ref(&media.rel_path),
        bytes = media.bytes,
        mime = media.mime,
        provider = target_kind,
    )
}

#[cfg(test)]
mod tests;
