//! Native media EDITING: everything `edit_video` and the manual Media Editor
//! panel do to EXISTING files, all through one ffmpeg/ffprobe pair.
//!
//! The binaries are provisioned into `<data_root>/bin` on first use (system
//! PATH wins when one already exists) via `ffmpeg-sidecar`'s download helpers —
//! its own `auto_download` unpacks next to the Rust executable, which a signed
//! app bundle may not allow, so the archive is downloaded and unpacked with
//! explicit target dirs here. Every path argument is workspace-relative and
//! goes through `tools::resolve_safe`, so the sandbox rules are identical to
//! the read/write tools.
//!
//! Concurrency note: these run blocking ffmpeg children, so callers must wrap
//! them in `tokio::task::spawn_blocking` (the tool arm and the HTTP route do).

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// One ffmpeg/ffprobe invocation may take this long (a full merge re-encodes
/// every input) before the caller reports a timeout.
pub const FFMPEG_TIMEOUT_SECS: u64 = 600;

/// Where the provisioned binaries live, under the data root the caller passes.
pub const BIN_SUBDIR: &str = "bin";

#[derive(Debug, Clone)]
pub struct FfmpegBin {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Where every operation reads and writes. Sources may be workspace files OR
/// the chat's generated media; OUTPUTS always land in the CHAT's media folder
/// under the data root (`<data_root>/media/<chat-slug>/`), so they die with
/// the chat and the workspace is never touched.
#[derive(Debug, Clone)]
pub struct MediaCtx {
    pub workspace_root: String,
    pub data_root: String,
    pub chat_id: String,
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Locate (or provision) the ffmpeg pair. Order: `<data_root>/bin`, then the
/// system PATH (a user who already installed ffmpeg keeps using their own —
/// the download only happens when NEITHER exists). Blocks while downloading
/// (~80MB, once); callers run it inside `spawn_blocking`.
pub fn ensure_ffmpeg(data_root: &str) -> Result<FfmpegBin, String> {
    let bin_dir = Path::new(data_root).join(BIN_SUBDIR);
    let local = FfmpegBin {
        ffmpeg: bin_dir.join(exe_name("ffmpeg")),
        ffprobe: bin_dir.join(exe_name("ffprobe")),
    };
    if local.ffmpeg.is_file() && local.ffprobe.is_file() {
        return Ok(local);
    }
    if binary_runs("ffmpeg") && binary_runs("ffprobe") {
        return Ok(FfmpegBin {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
        });
    }
    // Neither local nor system: download into the data root so the operation
    // is one-shot and survives app updates (the bundle directory does not).
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("cannot create {}: {e}", bin_dir.display()))?;
    let url = ffmpeg_sidecar::download::ffmpeg_download_url()
        .map_err(|e| format!("ffmpeg download url unavailable: {e}"))?;
    let archive = ffmpeg_sidecar::download::download_ffmpeg_package(url, &bin_dir)
        .map_err(|e| format!("ffmpeg download failed: {e}"))?;
    ffmpeg_sidecar::download::unpack_ffmpeg(&archive, &bin_dir)
        .map_err(|e| format!("ffmpeg unpack failed: {e}"))?;
    if !local.ffmpeg.is_file() || !local.ffprobe.is_file() {
        return Err("ffmpeg download completed but the binaries are missing".to_string());
    }
    Ok(local)
}

/// True when `name -version` exits 0 — the download check must not trust a
/// broken shim that merely exists on PATH.
fn binary_runs(name: &str) -> bool {
    Command::new(name)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run one ffmpeg invocation, timing it out and returning the LAST lines of
/// stderr on failure (ffmpeg writes every diagnosis there, the tail names the
/// actual cause). stderr goes to a temp FILE, not a pipe: ffmpeg's progress
/// output can fill a pipe buffer and deadlock a child nobody is reading while
/// we poll `try_wait`.
fn run_ffmpeg(bin: &Path, args: &[String], timeout: Duration) -> Result<(), String> {
    let err_file = std::env::temp_dir().join(format!("codifa-ffmpeg-{}.log", uuid::Uuid::new_v4()));
    let stderr = std::fs::File::create(&err_file).map_err(|e| format!("ffmpeg log create failed: {e}"))?;
    let mut child = Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;
    // No `wait_timeout` crate in the tree: poll with a deadline instead of
    // pulling another dependency for one use.
    let deadline = std::time::Instant::now() + timeout;
    let result = loop {
        match child.try_wait().map_err(|e| format!("ffmpeg wait failed: {e}"))? {
            Some(status) => {
                if status.success() {
                    break Ok(());
                }
                let buf = std::fs::read_to_string(&err_file).unwrap_or_default();
                let mut tail_lines: Vec<&str> = buf.lines().rev().take(6).collect();
                tail_lines.reverse();
                let tail = tail_lines.join("\n");
                break Err(format!(
                    "ffmpeg failed ({}):\n{}",
                    status.code().unwrap_or(-1),
                    tail
                ));
            }
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("ffmpeg timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    let _ = std::fs::remove_file(&err_file);
    result
}

/// `ffprobe -print_format json` for one file, parsed into a Value.
fn probe_json(bin: &Path, file: &Path) -> Result<Value, String> {
    let out = Command::new(bin)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .output()
        .map_err(|e| format!("ffprobe spawn failed: {e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let mut lines: Vec<&str> = tail.lines().rev().take(3).collect();
        lines.reverse();
        return Err(format!("ffprobe failed: {}", lines.join(" | ")));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe output unparsable: {e}"))
}

/// Workspace-relative path under `media/` for a new edit output.
fn edit_output_path(kind: &str, stem: &str, ext: &str) -> String {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let tag = &tag[..4];
    format!(
        "{}/{kind}-{}-{tag}.{ext}",
        crate::media_gen::MEDIA_DIR,
        stem.chars().take(24).collect::<String>()
    )
}

/// Resolve a workspace-relative media path to an absolute one. Kept as a
/// function so every arm states the sandbox rule in one place.
fn abs_media(ctx: &MediaCtx, rel: &str) -> Result<PathBuf, String> {
    crate::media_gen::resolve_media_input(&ctx.workspace_root, &ctx.data_root, &ctx.chat_id, rel)
}

/// Absolute path for an edit OUTPUT: always inside the CHAT's media folder;
/// an explicit `output` argument is honored as a FILE NAME only.
fn abs_output(
    ctx: &MediaCtx,
    output: Option<&str>,
    default_name: &str,
) -> Result<(PathBuf, String), String> {
    let virtual_path = crate::media_gen::media_virtual(
        &ctx.chat_id,
        output.filter(|o| !o.trim().is_empty()).unwrap_or(default_name),
    );
    let abs = crate::media_gen::resolve_media_virtual(&ctx.data_root, &virtual_path)?;
    Ok((abs, virtual_path))
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Trim one clip, re-encoded so the cut is frame-accurate AND the output
/// concatenates cleanly with other normalized clips (stream copy would keep
/// the source's keyframe alignment).
pub fn trim(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    path: &str,
    start: f64,
    end: f64,
    output: Option<&str>,
) -> Result<String, String> {
    let src = abs_media(ctx, path)?;
    if !(start >= 0.0) || end <= start {
        return Err(format!("invalid trim window: {start}..{end}"));
    }
    let dur = end - start;
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("clip")
        .to_string();
    let (out, out_rel) = abs_output(ctx, output, &edit_output_path("trim", &stem, "mp4"))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
    }
    // `-ss` BEFORE `-i` = fast seek; `-t` bounds the duration. Re-encode with
    // a fixed, widely-playable parameter set.
    let args = vec![
        "-y".into(),
        "-ss".into(), format!("{start:.3}"),
        "-i".into(), src.to_string_lossy().into_owned(),
        "-t".into(), format!("{dur:.3}"),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "veryfast".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-c:a".into(), "aac".into(),
        "-ar".into(), "44100".into(),
        "-ac".into(), "2".into(),
        out.to_string_lossy().into_owned(),
    ];
    run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
    Ok(out_rel)
}

/// Merge several clips in list order. Every input is re-encoded to the FIRST
/// clip's resolution and a common fps/pixel-format/audio layout, then the
/// concat demuxer stitches the normalized parts with stream copy — different
/// codecs/sizes would otherwise produce a broken or trimmed-at-shortest file.
pub fn merge(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    paths: &[String],
    output: Option<&str>,
) -> Result<String, String> {
    if paths.len() < 2 {
        return Err("merge needs at least two clips".to_string());
    }
    let first = abs_media(ctx, &paths[0])?;
    let info = crate::media_gen::ffprobe_parse(&probe_json(&bin.ffprobe, &first)?)?;
    let (w, h) = if info.width > 0 && info.height > 0 {
        // Even dimensions are an x264/yuv420p requirement — odd sizes fail.
        (info.width - info.width % 2, info.height - info.height % 2)
    } else {
        (1280, 720)
    };
    let fps = if info.fps > 0.0 { info.fps } else { 30.0 };

    let tmp = std::env::temp_dir().join(format!("codifa-merge-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create temp dir: {e}"))?;
    let result = (|| -> Result<String, String> {
        let mut parts: Vec<PathBuf> = Vec::new();
        for (i, rel) in paths.iter().enumerate() {
            let src = abs_media(ctx, rel)?;
            let part = tmp.join(format!("part-{i:03}.mp4"));
            let args = vec![
                "-y".into(),
                "-i".into(), src.to_string_lossy().into_owned(),
                "-vf".into(), format!(
                    "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.2},format=yuv420p"
                ),
                "-c:v".into(), "libx264".into(),
                "-preset".into(), "veryfast".into(),
                "-c:a".into(), "aac".into(),
                "-ar".into(), "44100".into(),
                "-ac".into(), "2".into(),
                part.to_string_lossy().into_owned(),
            ];
            run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
            parts.push(part);
        }
        let list = tmp.join("concat.txt");
        let mut body = String::new();
        for p in &parts {
            // Concat-demuxer escaping: single quotes doubled, path wrapped.
            let quoted = p.to_string_lossy().replace('\'', "'\\''");
            body.push_str(&format!("file '{quoted}'\n"));
        }
        std::fs::write(&list, body).map_err(|e| format!("cannot write concat list: {e}"))?;

        let stem = Path::new(&paths[0])
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("merged")
            .to_string();
        let (out, out_rel) = abs_output(ctx, output, &edit_output_path("merged", &stem, "mp4"))?;
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
        }
        let args = vec![
            "-y".into(),
            "-f".into(), "concat".into(),
            "-safe".into(), "0".into(),
            "-i".into(), list.to_string_lossy().into_owned(),
            "-c".into(), "copy".into(),
            out.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
        Ok(out_rel)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Build a short video from still images: every image shows `seconds` long.
/// All images are scaled into one frame with letterboxing, so mixed sizes work.
pub fn slideshow(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    image_paths: &[String],
    seconds: f64,
    output: Option<&str>,
) -> Result<String, String> {
    if image_paths.is_empty() {
        return Err("slideshow needs at least one image".to_string());
    }
    if !(seconds > 0.0) {
        return Err(format!("invalid seconds per image: {seconds}"));
    }
    let (out, out_rel) = abs_output(ctx, output, &edit_output_path("slideshow", "video", "mp4"))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
    }
    let tmp = std::env::temp_dir().join(format!("codifa-slides-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create temp dir: {e}"))?;
    let result = (|| -> Result<String, String> {
        // concat demuxer quirk: the LAST `duration` is ignored unless the last
        // file is listed twice — handled by repeating the final entry.
        let mut body = String::new();
        for rel in image_paths {
            let src = abs_media(ctx, rel)?;
            let quoted = src.to_string_lossy().replace('\'', "'\\''");
            body.push_str(&format!("file '{quoted}'\nduration {seconds:.3}\n"));
        }
        if let Some(last) = image_paths.last() {
            let src = abs_media(ctx, last)?;
            let quoted = src.to_string_lossy().replace('\'', "'\\''");
            body.push_str(&format!("file '{quoted}'\n"));
        }
        let list = tmp.join("slides.txt");
        std::fs::write(&list, body).map_err(|e| format!("cannot write slide list: {e}"))?;
        let args = vec![
            "-y".into(),
            "-f".into(), "concat".into(),
            "-safe".into(), "0".into(),
            "-i".into(), list.to_string_lossy().into_owned(),
            "-vf".into(),
            "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p".into(),
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "veryfast".into(),
            "-tune".into(), "stillimage".into(),
            out.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
        Ok(out_rel)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Extract still frames at the given timestamps into `media/frames/`. Returns
/// the created paths — exactly what an `edit_image` call then targets.
pub fn extract_frames(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    path: &str,
    at: &[f64],
) -> Result<Vec<String>, String> {
    if at.is_empty() {
        return Err("extract_frames needs at least one timestamp".to_string());
    }
    let src = abs_media(ctx, path)?;
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame")
        .to_string();
    // Frames live INSIDE the chat's own media folder (`media/<slug>/frames/`),
    // so they cascade-delete with the chat like every other generated file.
    let frames_rel = format!(
        "{}/{}/frames",
        crate::media_gen::MEDIA_DIR,
        crate::media_gen::chat_media_slug(&ctx.chat_id)
    );
    let frames_dir = crate::media_gen::resolve_media_virtual(&ctx.data_root, &frames_rel)?;
    std::fs::create_dir_all(&frames_dir).map_err(|e| format!("cannot create frames dir: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    for t in at {
        if *t < 0.0 {
            return Err(format!("negative timestamp: {t}"));
        }
        let name = format!("{stem}-t{:.2}.jpg", t);
        let out_rel = format!("{frames_rel}/{name}");
        let dest = crate::media_gen::resolve_media_virtual(&ctx.data_root, &out_rel)?;
        let args = vec![
            "-y".into(),
            "-ss".into(), format!("{t:.3}"),
            "-i".into(), src.to_string_lossy().into_owned(),
            "-frames:v".into(), "1".into(),
            "-q:v".into(), "2".into(),
            dest.to_string_lossy().into_owned(),
        ];
        run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
        out.push(out_rel);
    }
    Ok(out)
}

/// Convert one media file. The map is intentionally small: the formats a user
/// actually asks for, each with its canonical parameter set.
pub fn convert(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    path: &str,
    format: &str,
    output: Option<&str>,
) -> Result<String, String> {
    let src = abs_media(ctx, path)?;
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    let (ext, vcodec, acodec, extra): (&str, Option<&str>, Option<&str>, Vec<String>) = match format {
        "mp4" => ("mp4", Some("libx264"), Some("aac"), vec![]),
        "webm" => ("webm", Some("libvpx-vp9"), Some("libopus"), vec![]),
        "mov" => ("mov", Some("libx264"), Some("aac"), vec![]),
        "gif" => ("gif", None, None, vec!["-vf".into(), "fps=12,scale=480:-1:flags=lanczos".into()]),
        "mp3" => ("mp3", None, Some("libmp3lame"), vec![]),
        "wav" => ("wav", None, Some("pcm_s16le"), vec![]),
        other => return Err(format!("unsupported conversion target: {other} (use mp4, webm, mov, gif, mp3, wav)")),
    };
    let (out, out_rel) = abs_output(ctx, output, &edit_output_path("converted", &stem, ext))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
    }
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), src.to_string_lossy().into_owned()];
    args.extend(extra);
    if let Some(v) = vcodec {
        args.push("-c:v".into());
        args.push(v.into());
    }
    if let Some(a) = acodec {
        args.push("-c:a".into());
        args.push(a.into());
    }
    args.push(out.to_string_lossy().into_owned());
    run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
    Ok(out_rel)
}

/// Probe one file, returning the compact line the model reads plus the
/// structured info. `path` may also be an image: ffprobe reports dimensions
/// and codec, duration 0.
pub fn probe(ctx: &MediaCtx, bin: &FfmpegBin, path: &str) -> Result<(String, crate::media_gen::MediaInfo), String> {
    let src = abs_media(ctx, path)?;
    let info = crate::media_gen::ffprobe_parse(&probe_json(&bin.ffprobe, &src)?)?;
    let line = crate::media_gen::media_info_line(path, &info);
    Ok((line, info))
}

/// Crop a rectangular region out of an IMAGE (the manual editor's Save-crop
/// button). ffmpeg handles images fine and keeps the pipeline single-binary.
///
/// `coord_src` is the pixel space x/y/w/h arrive in (the displayed image's
/// natural size). The viewer sometimes shows a DOWNSCALED copy — an
/// out-of-workspace file can only be displayed through the capped data-URL
/// read — so the rectangle is rescaled to the file's true dimensions here,
/// where the real file is at hand. `None` means the coords are already true
/// pixels.
pub fn crop_image(
    ctx: &MediaCtx,
    bin: &FfmpegBin,
    path: &str,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    output: Option<&str>,
    coord_src: Option<(u32, u32)>,
) -> Result<String, String> {
    if w == 0 || h == 0 {
        return Err("crop region is empty".to_string());
    }
    let src = abs_media(ctx, path)?;
    let (x, y, w, h) = match coord_src {
        Some((sw, sh)) if sw > 0 && sh > 0 => {
            let true_dims = image::ImageReader::open(&src)
                .map_err(|e| format!("cannot open image for crop: {e}"))?
                .with_guessed_format()
                .map_err(|e| format!("cannot sniff image format: {e}"))?
                .into_dimensions()
                .map_err(|e| format!("cannot read image dimensions: {e}"))?;
            if (sw, sh) == true_dims {
                (x, y, w, h)
            } else {
                let sx = f64::from(true_dims.0) / f64::from(sw);
                let sy = f64::from(true_dims.1) / f64::from(sh);
                (
                    (f64::from(x) * sx).round() as u32,
                    (f64::from(y) * sy).round() as u32,
                    ((f64::from(w) * sx).round() as u32).max(1),
                    ((f64::from(h) * sy).round() as u32).max(1),
                )
            }
        }
        _ => (x, y, w, h),
    };
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "png".to_string());
    let (out, out_rel) = abs_output(ctx, output, &edit_output_path("crop", &stem, &ext))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
    }
    let args = vec![
        "-y".into(),
        "-i".into(), src.to_string_lossy().into_owned(),
        "-vf".into(), format!("crop={w}:{h}:{x}:{y}"),
        out.to_string_lossy().into_owned(),
    ];
    run_ffmpeg(&bin.ffmpeg, &args, Duration::from_secs(FFMPEG_TIMEOUT_SECS))?;
    Ok(out_rel)
}

#[cfg(test)]
mod tests;
