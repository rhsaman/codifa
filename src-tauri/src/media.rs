//! Native media endpoints (phase 5): STT (`/transcribe`) and TTS (`/tts`).
//!
//! These were the last two features that needed the Python sidecar (torch /
//! faster-whisper / pocket-tts-farsi-v2 for on-device models). The renderer now
//! targets configured EXTERNAL providers only — the on-device "local" source
//! was removed from Settings — so both endpoints are plain HTTP forwards:
//!
//!   * `/transcribe` → `POST {base_url}/audio/transcriptions` (multipart)
//!   * `/tts`        → `POST {base_url}/audio/speech` (JSON, streamed back)
//!
//! Ported from `backend/server.py`'s `_transcribe_remote` and the remote branch
//! of `text_to_speech`, including the audio magic-byte sniffing (gateways pick
//! their decoder from the filename) and the HTML-error-page guards.

use axum::body::Body;
use axum::extract::Multipart;
use axum::http::{header, Response, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

/// Same UA ladder head the chat path sends for custom gateways: some
/// OpenAI-compatible routers 401 an "unknown" client while allowing the
/// well-known agent CLIs.
const UA_AGENT_CLI: &str = "claude-cli/2.0.35 (external, cli)";

/// Upstream budget for one media request (dictation / one sentence of speech).
const MEDIA_TIMEOUT_SECS: u64 = 120;

fn error_response(status: StatusCode, detail: impl Into<String>) -> Response<Body> {
    (status, Json(json!({ "detail": detail.into() }))).into_response()
}

/// Strip HTML tags and collapse whitespace — a gateway that answers with an
/// error PAGE must never surface raw markup (or land in the composer).
pub fn strip_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when a provider answered `200` but handed back an HTML page instead of
/// a transcript — the gateway's error page must become an error, never text.
fn looks_like_html_error(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    !text.is_empty()
        && (lowered.contains("<link")
            || lowered.contains("/_next/")
            || lowered.contains("&lt;")
            || lowered.contains("<html"))
}

// ---------------------------------------------------------------------------
// STT — POST /transcribe (multipart in, JSON out)
// ---------------------------------------------------------------------------

/// Pick a filename + MIME matching the recorded bytes. Browsers emit
/// webm/opus, but the upload carries no reliable name, and some STT gateways
/// choose their decoder from the extension (`clip.wav` holding webm bytes is
/// rejected with "could not process file").
fn sniff_audio_upload(data: &[u8]) -> (&'static str, &'static str) {
    let head: &[u8] = &data[..data.len().min(12)];
    if head.starts_with(b"\x1a\x45\xdf\xa3") {
        return ("clip.webm", "audio/webm");
    }
    if head.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WAVE" {
        return ("clip.wav", "audio/wav");
    }
    if head.starts_with(b"OggS") {
        return ("clip.ogg", "audio/ogg");
    }
    if head.starts_with(b"fLaC") {
        return ("clip.flac", "audio/flac");
    }
    if head.starts_with(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        return ("clip.mp3", "audio/mpeg");
    }
    if data.len() >= 8 && &data[4..8] == b"ftyp" {
        return ("clip.mp4", "audio/mp4");
    }
    ("clip.wav", "application/octet-stream")
}

async fn read_transcribe_form(mut mp: Multipart) -> Result<(Vec<u8>, Value), String> {
    let mut audio: Vec<u8> = Vec::new();
    let mut form: serde_json::Map<String, Value> = serde_json::Map::new();
    while let Some(field) = mp.next_field().await.map_err(|e| e.to_string())? {
        let name = field.name().unwrap_or_default().to_string();
        if name == "audio" {
            audio = field.bytes().await.map_err(|e| e.to_string())?.to_vec();
            continue;
        }
        // Every other field is a short text value.
        let text = field.text().await.unwrap_or_default();
        form.insert(name, Value::String(text));
    }
    Ok((audio, Value::Object(form)))
}

fn form_str<'a>(form: &'a Value, key: &str) -> &'a str {
    form.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// POST /transcribe — forward a recorded clip to an OpenAI-compatible
/// `/audio/transcriptions` endpoint and return `{"text": "..."}`.
pub async fn transcribe(mp: Multipart) -> Response<Body> {
    let (data, form) = match read_transcribe_form(mp).await {
        Ok(v) => v,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("bad upload: {e}")),
    };
    if data.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "empty audio");
    }
    let provider_kind = form_str(&form, "provider").trim().to_string();
    if provider_kind.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing 'provider' — no on-device STT anymore, configure an STT provider in Settings → Media Providers",
        );
    }
    let base_url = form_str(&form, "base_url").trim().to_string();
    if base_url.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "remote STT needs 'base_url'");
    }
    let model = {
        let m = form_str(&form, "model").trim();
        if m.is_empty() {
            "whisper-1".to_string()
        } else {
            m.to_string()
        }
    };
    let lang = form_str(&form, "lang").trim().to_lowercase();
    // The user's glossary is BIASING CONTEXT for the model, never a sentence
    // instructing it (see buildSttPrompt): an instruction came back as the
    // transcript instead of the audio.
    let prompt = form_str(&form, "prompt").trim().to_string();
    // Decoding temperature, forwarded only when it is a real 0..=1 number: the
    // renderer pins greedy decoding so the same clip cannot transcribe to a
    // different word, but a malformed value must never reach the provider.
    let mut temperature = form_str(&form, "temperature").trim().to_string();
    if temperature
        .parse::<f32>()
        .map(|t| !(0.0..=1.0).contains(&t))
        .unwrap_or(true)
    {
        temperature.clear();
    }
    let mut key = form_str(&form, "api_key").trim().to_string();
    if key.is_empty() {
        // The renderer sends the whole key ring as a JSON array; use the first
        // entry so multi-key providers work instead of silently going unauthed.
        if let Some(first) = form
            .get("api_keys")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .and_then(|keys| keys.into_iter().find(|k| !k.trim().is_empty()))
        {
            key = first.trim().to_string();
        }
    }
    if key.is_empty() {
        key = crate::providers::env_key(&provider_kind, form_str(&form, "env_var").trim());
    }

    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let (filename, mime) = sniff_audio_upload(&data);
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(filename.to_string())
        .mime_str(mime)
        .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));
    let out_form = reqwest::multipart::Form::new().part("file", part).text("model", model);
    let mut out_form = out_form;
    if !lang.is_empty() {
        out_form = out_form.text("language", lang);
    }
    if !prompt.is_empty() {
        out_form = out_form.text("prompt", prompt);
    }
    if !temperature.is_empty() {
        out_form = out_form.text("temperature", temperature);
    }
    let client = crate::llm::http_client();
    let mut req = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(MEDIA_TIMEOUT_SECS))
        .multipart(out_form);
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let res = match req.send().await {
        Ok(res) => res,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("remote transcription failed: {e}"),
            )
        }
    };
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let cleaned = strip_tags(&body);
        let detail: String = if cleaned.is_empty() {
            format!("remote transcription failed ({})", status.as_u16())
        } else {
            cleaned.chars().take(300).collect()
        };
        return error_response(StatusCode::BAD_GATEWAY, detail);
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("remote transcription bad response: {e}"),
            )
        }
    };
    let text = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if looks_like_html_error(&text) {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "remote transcription returned an error page — please try again",
        );
    }
    Json(json!({ "text": text })).into_response()
}

// ---------------------------------------------------------------------------
// TTS — POST /tts (JSON in, audio stream out)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TtsBody {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub env_var: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
}

/// POST /tts — synthesize through an OpenAI-compatible `/audio/speech`
/// endpoint, streaming the audio bytes back as they arrive so playback can
/// start on the first chunk.
pub async fn tts(Json(b): Json<TtsBody>) -> Response<Body> {
    let text = b.text.trim().to_string();
    if text.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "missing 'text' field");
    }
    let provider_kind = b.provider.trim().to_string();
    if provider_kind.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing 'provider' — no on-device TTS anymore, configure a TTS provider in Settings → Media Providers",
        );
    }
    let base_url = b.base_url.trim().to_string();
    if base_url.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "remote TTS needs 'base_url'");
    }
    let mut key = b.api_key.trim().to_string();
    if key.is_empty() {
        key = crate::providers::env_key(&provider_kind, b.env_var.trim());
    }
    // Skip empty model/voice: some providers reject unknown extra fields.
    let mut payload = json!({ "input": text });
    let model = b.model.trim();
    if !model.is_empty() {
        payload["model"] = json!(model);
    }
    let voice = b.voice.trim();
    if !voice.is_empty() {
        payload["voice"] = json!(voice);
    }

    let url = format!("{}/audio/speech", base_url.trim_end_matches('/'));
    let client = crate::llm::http_client();
    let mut req = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(MEDIA_TIMEOUT_SECS))
        .header("User-Agent", UA_AGENT_CLI)
        .json(&payload);
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    // `send()` (not `.json()`) keeps the body as a stream we can forward.
    let res = match req.send().await {
        Ok(res) => res,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("remote speech synthesis failed: {e}"),
            )
        }
    };
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let cleaned = strip_tags(&body);
        let detail: String = if cleaned.is_empty() {
            format!("remote speech synthesis failed ({})", status.as_u16())
        } else {
            cleaned.chars().take(500).collect()
        };
        return error_response(StatusCode::BAD_GATEWAY, detail);
    }
    let media_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("audio/mpeg")
        .to_string();
    let stream = res
        .bytes_stream()
        .map(|chunk| chunk.map_err(|e| std::io::Error::other(e.to_string())));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media_type)
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "stream failed"))
}
