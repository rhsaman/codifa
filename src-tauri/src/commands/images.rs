use super::*;

pub(super) fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Identify an image from its CONTENT (magic bytes) instead of its name.
///
/// The extension used to be the only source of the mime, so a screenshot pasted
/// from the clipboard (`blob`), an image whose suffix was stripped, or one saved
/// under the wrong name was silently dropped — `image_mime` returned `None` and
/// the picture never reached the model. The provider is told what the bytes
/// REALLY are, so a mislabelled file can no longer be rejected for its mime.
pub fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| data.starts_with(sig);
    if starts(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if starts(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("image/gif")
    } else if starts(b"BM") {
        Some("image/bmp")
    } else if data.len() >= 12 && starts(b"RIFF") && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.len() >= 12 && &data[4..8] == b"ftyp" && matches!(&data[8..12], b"avif" | b"avis") {
        Some("image/avif")
    } else {
        None
    }
}

/// Marker prefix of a `read` result that stands in for an image file.
///
/// The path follows on the SAME line (up to the first newline) so a path with
/// spaces in it survives the round trip; everything after is the description.
pub const IMAGE_READ_MARK: &str = "[image attached]";

/// A text stand-in for `read`ing an image file.
///
/// `read` answers with windowed TEXT and an image has none, so a screenshot in
/// the workspace used to come back as "file too large to read in one call" (or
/// as mojibake bytes). The marker carries the path instead, and the turn loop
/// turns that path into a real image block on the next request — the model sees
/// the picture rather than its file size.
///
/// Returns `None` for anything that is not a readable image, so the caller can
/// fall through to its normal text window.
pub fn image_read_note(abs_path: &str) -> Option<String> {
    let data = std::fs::read(abs_path).ok()?;
    if data.len() > IMAGE_READ_MAX_BYTES {
        return None;
    }
    let mime = sniff_image_mime(&data)?;
    let dims = match image::load_from_memory(&data) {
        Ok(img) => format!(", {}x{}", img.width(), img.height()),
        Err(_) => String::new(),
    };
    Some(format!(
        "{IMAGE_READ_MARK} {abs_path}\n{mime}{dims}. The picture itself is attached to this turn — look at it directly."
    ))
}

/// The image path carried by a `read` result, if it had one.
pub fn image_read_path(result: &str) -> Option<String> {
    let first = result.strip_prefix(IMAGE_READ_MARK)?;
    let path = first.lines().next()?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Cache of encoded image data URLs, keyed by `(downscale cap, absolute path)`.
///
/// The cap is part of the key because the same file is legitimately encoded at
/// two sizes (a full-size display copy and a model-bound copy).
///
/// A turn re-reads every image that is still in its history (the renderer sends
/// bare paths), so the same screenshot file was opened, base64-encoded and
/// shipped again on EVERY step — the vision pass and the main model both pay
/// that cost. The entry is validated against `(mtime, len)` so an edited file is
/// re-read, and the map is bounded so a long-running app cannot grow forever.
pub(super) fn image_cache() -> &'static Mutex<HashMap<String, (u64, u64, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, u64, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How many encoded data URLs to keep. Each entry is one base64 image, so the
/// cap is deliberately small: it only has to cover the images of the chat being
/// worked on.
pub(super) const IMAGE_CACHE_MAX: usize = 24;

#[tauri::command]
pub fn read_image(abs_path: String) -> Option<String> {
    image_data_url(&abs_path)
}

/// Whether macOS will let this build see the screen and inject input.
///
/// The renderer shows this next to the Computer Use switch: without Screen
/// Recording a capture silently comes back as a wallpaper with every other
/// app's windows missing, so the user has to be told BEFORE the agent takes a
/// look and reports an empty desktop.
#[tauri::command]
pub fn computer_permissions() -> serde_json::Value {
    serde_json::json!({
        "screen": crate::screen::screen_recording_allowed(),
        "accessibility": crate::screen::accessibility_allowed(),
        "identity": crate::screen::bundle_identity(),
    })
}

/// Put Codifa under Screen Recording in System Settings and return whether the
/// grant is already live.
///
/// macOS only ever shows its own prompt from the requesting API, and only a
/// fresh process picks the resulting grant up — so the renderer calls this when
/// the user presses Grant on the Computer Use card and re-checks afterwards
/// instead of demanding a restart.
#[tauri::command]
pub fn request_screen_recording() -> bool {
    crate::screen::request_screen_recording()
}

/// Read an image for a model whose provider IS known: the downscale cap follows
/// what that provider's vision encoder actually consumes (see `image_max_dim`).
pub fn image_data_url_for(abs_path: &str, provider: &str) -> Option<String> {
    image_data_url_capped(abs_path, image_max_dim(provider))
}

/// Read an image file and return it as a `data:<mime>;base64,…` URL.
///
/// Shared by the `read_image` Tauri command and the agent's image deserializer
/// (which turns a bare path from the renderer into bytes for the model). The
/// mime is sniffed from the BYTES and only falls back to the extension, so an
/// image whose name lost its suffix still reaches the model. Anything past the
/// cap is downscaled and re-encoded: these URLs are re-sent with EVERY turn of
/// the chat, so full-resolution pixels here are a repeated upload of detail no
/// vision encoder reads. Results are cached — see `image_cache`.
pub fn image_data_url(abs_path: &str) -> Option<String> {
    image_data_url_capped(abs_path, IMAGE_MAX_DIM)
}

pub(super) fn image_data_url_capped(abs_path: &str, max_dim: u32) -> Option<String> {
    // The cap is part of the cache key: one file can be read at two sizes.
    let key = format!("{max_dim}:{abs_path}");
    let p = PathBuf::from(abs_path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let meta = std::fs::metadata(&p).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let len = meta.len();
    if let Some(hit) = image_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if hit.0 == mtime && hit.1 == len {
            return Some(hit.2);
        }
    }
    let data = std::fs::read(&p).ok()?;
    if data.len() > IMAGE_READ_MAX_BYTES {
        return None;
    }
    let mime = sniff_image_mime(&data).or_else(|| image_mime(&ext))?;
    let url = match image::load_from_memory(&data) {
        Ok(img) if img.width() > max_dim || img.height() > max_dim => {
            let (bytes, mime) = encode_within_budget(&fit_within(img, max_dim), IMAGE_WIRE_BUDGET);
            data_url_of(&bytes, mime)
        }
        // Inside the cap already, or not decodable (a truncated file, a test
        // fixture): the original bytes go through untouched.
        _ => data_url_of(&data, mime),
    };
    if let Ok(mut c) = image_cache().lock() {
        if c.len() >= IMAGE_CACHE_MAX {
            // Drop an arbitrary older entry: any eviction is fine, the cache is
            // purely a round-trip saver and a miss simply re-reads the file.
            if let Some(k) = c.keys().next().cloned() {
                c.remove(&k);
            }
        }
        c.insert(key, (mtime, len, url.clone()));
    }
    Some(url)
}

/// Raw base64 of a PDF file, for the viewer's native PDF pane.
///
/// The renderer builds a `Blob` from this and hands the object URL to an
/// `<iframe>`: WKWebView renders PDFs itself, so no PDF rasterizer (pdfium/
/// mupdf, tens of MB of native code) has to be bundled just to show a page.
/// Capped so a huge PDF cannot balloon the JS heap — the file viewer shows an
/// error instead of hanging.
#[tauri::command]
pub fn read_pdf_base64(abs_path: String) -> Option<String> {
    const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
    let p = PathBuf::from(&abs_path);
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    if ext != "pdf" {
        return None;
    }
    let meta = std::fs::metadata(&p).ok()?;
    if meta.len() > MAX_PDF_BYTES {
        return None;
    }
    let data = std::fs::read(&p).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(data))
}

/// Largest edge an attached image is reduced to before it reaches a model.
/// Covers more than any vision model actually consumes, so this is not the
/// quality knob — the ENCODER is (see `encode_within_budget`).
pub(super) const IMAGE_MAX_DIM: u32 = 2048;

/// Largest edge an image is reduced to when it is re-read from the chat history
/// on every following turn — the repeated upload is the expensive one.
///
/// Largest file we will read from disk at all. Beyond this the file is not a
/// screenshot or a photo but a mistake, and base64 of it would blow up the
/// request (base64 is 4/3 of the bytes, so 8 MiB becomes ~11 MiB on the wire).
pub(super) const IMAGE_READ_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Wire-size ceiling for one encoded image before the lossless encoders are
/// abandoned for a lossy one (see `encode_within_budget`).
pub(super) const IMAGE_WIRE_BUDGET: usize = 1_200_000;

/// Quality for the lossy fallback. Visually identical at model resolution, and
/// several times smaller than the lossless encode of the same pixels.
pub(super) const IMAGE_LOSSY_QUALITY: u8 = 82;

/// Largest edge a provider's vision encoder actually consumes.
///
/// A longer edge is not extra detail: Anthropic's vision resizes to 1568 px on
/// the long edge before it even patches, so anything past that is paid for on
/// the wire and thrown away on arrival. OpenAI and Gemini take the larger size,
/// so the table is per-provider rather than one global cap.
pub(super) fn image_max_dim(provider: &str) -> u32 {
    match provider {
        "anthropic" => 1568,
        _ => IMAGE_MAX_DIM,
    }
}

/// Downscale so the LONGEST edge is at most `max_dim`, keeping the aspect
/// ratio. A no-op for an image already inside the cap.
///
/// Both edges come from ONE scale and are applied with `resize_exact`: `resize`
/// re-fits the image inside the box it is handed, so truncating the SHORT edge
/// silently charged the long edge too — a 3000x100 strip capped at 1568 was
/// resized to a 1560x52 box and came out 1560 wide, i.e. the whole cap spent on
/// rounding. Screen captures are exactly this shape (a wide, short menu bar or
/// banner), so the loss was systematic, not a corner case.
pub(super) fn fit_within(img: image::DynamicImage, max_dim: u32) -> image::DynamicImage {
    let longest = img.width().max(img.height());
    if longest <= max_dim {
        return img;
    }
    let scale = max_dim as f64 / longest as f64;
    let nw = ((img.width() as f64) * scale).round().max(1.0) as u32;
    let nh = ((img.height() as f64) * scale).round().max(1.0) as u32;
    img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
}

/// `data:<mime>;base64,…` for bytes that are already encoded.
pub(super) fn data_url_of(bytes: &[u8], mime: &str) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Monotonic counter for temp image names (see `temp_image_path`).
pub(super) static TEMP_IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// A fresh path in the temp dir for an image the model will be pointed at.
///
/// The counter guarantees uniqueness even for two images attached inside the
/// same millisecond (the previous name was `now_ms` + pid only, so a batched
/// multi-image attach could overwrite one file with another).
pub(super) fn temp_image_path(ext: &str) -> PathBuf {
    let n = TEMP_IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "coder-img-{}-{:x}-{n}.{ext}",
        state::now_ms(),
        std::process::id()
    ))
}

/// Lossless WebP and PNG of the same pixels, whichever is smaller.
///
/// Screenshots are what people attach, and PNG puts such a flat, text-heavy
/// image on the wire at several megabytes of base64 — which the agent then
/// re-uploads with every step and every history turn. Lossless WebP (VP8L) is
/// byte-for-byte the same picture and usually 2-5x smaller, so the model sees
/// identical pixels for a fraction of the request size and upload time.
///
/// PNG is kept as the answer whenever it wins (already-small images, some
/// photographic inputs), so this can never make a request BIGGER.
pub(super) fn encode_smallest_lossless(img: &image::DynamicImage) -> (Vec<u8>, &'static str) {
    let mut png: Vec<u8> = Vec::new();
    if image::DynamicImage::write_to(
        img,
        &mut std::io::Cursor::new(&mut png),
        image::ImageFormat::Png,
    )
    .is_err()
    {
        return (png, "image/png");
    }
    // The lossless encoder only takes Rgb8 / Rgba8; anything else (16-bit,
    // greyscale, palette) simply keeps the PNG we already produced.
    let (buf, width, height, color) = match img {
        image::DynamicImage::ImageRgba8(b) => {
            (b.as_raw().clone(), b.width(), b.height(), image::ExtendedColorType::Rgba8)
        }
        image::DynamicImage::ImageRgb8(b) => {
            (b.as_raw().clone(), b.width(), b.height(), image::ExtendedColorType::Rgb8)
        }
        _ => {
            let rgba = img.to_rgba8();
            (
                rgba.as_raw().clone(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
    };
    let mut webp: Vec<u8> = Vec::new();
    let encoded = image::codecs::webp::WebPEncoder::new_lossless(std::io::Cursor::new(&mut webp))
        .encode(&buf, width, height, color)
        .is_ok();
    if encoded && !webp.is_empty() && webp.len() < png.len() {
        (webp, "image/webp")
    } else {
        (png, "image/png")
    }
}

/// Encode for the wire: lossless first, lossy only when lossless misses the
/// budget.
///
/// Lossless WebP/PNG of a photographic attachment still lands in the megabytes
/// (a 5K screenshot stays ~1.5 MB however it is compressed), and that payload
/// is re-sent on every following turn. Past `budget` bytes the picture is
/// re-encoded as JPEG at `IMAGE_LOSSY_QUALITY`, which is visually identical at
/// model resolution and several times smaller. Something is ALWAYS returned: if
/// the lossy encoder fails or comes out bigger, the lossless bytes do, so this
/// can never lose an attachment.
pub(super) fn encode_within_budget(img: &image::DynamicImage, budget: usize) -> (Vec<u8>, &'static str) {
    let (lossless, lossless_mime) = encode_smallest_lossless(img);
    if lossless.len() <= budget {
        return (lossless, lossless_mime);
    }
    let rgb = img.to_rgb8();
    let mut jpeg: Vec<u8> = Vec::new();
    let encoded = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut jpeg),
        IMAGE_LOSSY_QUALITY,
    )
    .encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .is_ok();
    if encoded && !jpeg.is_empty() && jpeg.len() < lossless.len() {
        (jpeg, "image/jpeg")
    } else {
        (lossless, lossless_mime)
    }
}

/// Encode an image the composer can attach: downscale past `IMAGE_MAX_DIM`,
/// keep the smaller of lossless WebP/PNG, write it to a temp file and return the
/// `{path, dataUrl}` pair the renderer reads back.
///
/// Shared by `normalize_image` and `capture_screen` so a screenshot and an
/// attached photo take exactly the same path to the model (a raw 5K PNG would
/// otherwise reach the composer as a multi-megabyte base64 blob).
pub(super) fn image_attachment(img: image::DynamicImage, max_dim: u32) -> Option<serde_json::Value> {
    let (bytes, mime) = encode_within_budget(&fit_within(img, max_dim), IMAGE_WIRE_BUDGET);
    let tmp = temp_image_path(image_ext_of(mime));
    std::fs::write(&tmp, &bytes).ok()?;
    Some(serde_json::json!({
        "path": tmp.to_string_lossy(),
        // The temp file's suffix has to match the bytes: the agent re-reads this
        // path on later turns, and a mime sniffed from the content must agree
        // with the name it is stored under.
        "dataUrl": data_url_of(&bytes, mime),
    }))
}

/// File suffix for an encoded mime.
pub(super) fn image_ext_of(mime: &str) -> &'static str {
    match mime {
        "image/webp" => "webp",
        "image/jpeg" => "jpg",
        _ => "png",
    }
}

/// Normalize any attached image to a temp file the model can always read (like
/// screenshots), so formats such as HEIC or oversized files reach the model
/// regardless of source, and shrink what does reach it.
///
/// An image that is ALREADY a model-readable format within `IMAGE_MAX_DIM` is
/// passed through byte-for-byte: re-encoding it only burned CPU and changed
/// nothing the model would see.
#[tauri::command]
pub fn normalize_image(abs_path: String) -> Option<serde_json::Value> {
    let original = std::fs::read(&abs_path).ok()?;
    let ext = PathBuf::from(&abs_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // Formats every supported vision endpoint accepts, plus what the agent's
    // own deserializer can turn into a mime type.
    let passthrough = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif"
    ) && original.len() <= 8 * 1024 * 1024;
    let dims = if passthrough {
        image::ImageReader::new(std::io::Cursor::new(&original))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
    } else {
        None
    };
    if let (true, Some((w, h))) = (passthrough, dims) {
        if w <= IMAGE_MAX_DIM && h <= IMAGE_MAX_DIM {
            let mime = image_mime(&ext)?;
            // Copy instead of decode + re-encode: the model receives the
            // ORIGINAL bytes, so nothing can be lost, for the price of one file
            // write. The copy also keeps `path` stable when the user later moves
            // or deletes the original — the agent re-reads this path from the
            // history on every following turn.
            let tmp = temp_image_path(&ext);
            std::fs::write(&tmp, &original).ok()?;
            return Some(serde_json::json!({
                "path": tmp.to_string_lossy(),
                "dataUrl": format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&original)
                ),
            }));
        }
    }

    let img = image::open(&abs_path).ok()?;
    image_attachment(img, IMAGE_MAX_DIM)
}

// --- screen capture ---------------------------------------------------------

