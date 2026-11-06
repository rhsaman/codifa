use super::*;

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    #[serde(rename = "latestVersion")]
    pub latest_version: String,
    pub notes: String,
    #[serde(rename = "assetName")]
    pub asset_name: Option<String>,
    #[serde(rename = "assetUrl")]
    pub asset_url: Option<String>,
    /// The sha256 the feed pins to the chosen asset, when it provides one —
    /// the downloaded installer must match it before it is ever launched.
    #[serde(rename = "assetSha256")]
    pub asset_sha256: Option<String>,
    #[serde(rename = "releaseUrl")]
    pub release_url: String,
}

pub(super) const REPO: &str = "rhsaman/codifa";

/// A version split into its numeric base and an optional prerelease id:
/// `v2.1.0-rc1` → base `[2, 1, 0]`, prerelease `Some("rc1")`. A tag with no
/// numbers (`nightly`) parses to base `[0]` and never wins a comparison.
pub(super) fn parse_version(v: &str) -> (Vec<u64>, Option<String>) {
    let v = v.trim().trim_start_matches('v');
    let (base, pre) = match v.split_once('-') {
        Some((b, p)) if !p.is_empty() => (b, Some(p.trim().to_ascii_lowercase())),
        _ => (v, None),
    };
    let nums = base.split('.').map(|n| n.trim().parse().unwrap_or(0)).collect();
    (nums, pre)
}

/// `rc10` → ("rc", 10) so rc10 sorts after rc9; a tail without digits ranks 0.
pub(super) fn pre_key(pre: &str) -> (&str, u64) {
    let digits = pre.len() - pre.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let (head, tail) = pre.split_at(digits);
    let num: u64 = tail.parse().unwrap_or(0);
    (head, num)
}

/// True when `candidate` should be OFFERED over the running `current`.
///
/// Numeric base parts compare first. A PRERELEASE is only offered when the
/// running build is itself a prerelease: publishing `v2.1.0-rc1` must never
/// prompt the whole stable base to "update" to an RC (the old comparison read
/// `2.1.0-rc1` as `[2,1,0]` and pushed it to every user). Same base: rc →
/// final release is always an upgrade; rc → newer rc compares by its trailing
/// number (`rc10` > `rc9`).
pub(super) fn is_newer(current: &str, candidate: &str) -> bool {
    let (cb, cpre) = parse_version(current);
    let (nb, npre) = parse_version(candidate);
    for i in 0..nb.len().max(cb.len()) {
        let x = nb.get(i).copied().unwrap_or(0);
        let y = cb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y && (npre.is_none() || cpre.is_some());
        }
    }
    match (&cpre, &npre) {
        (Some(_), None) => true,
        (Some(a), Some(b)) if a != b => pre_key(b) > pre_key(a),
        _ => false,
    }
}

/// The sha256 a feed pins to an asset: GitHub's `digest` field
/// (`sha256:<hex>`) or a site feed's `sha256`. Absent/malformed = no pin; the
/// download then falls back to the size check only.
pub(super) fn asset_sha256(a: &serde_json::Value) -> Option<String> {
    let hex64 = |s: &str| -> Option<String> {
        let s = s.trim().to_ascii_lowercase();
        (s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).then_some(s)
    };
    if let Some(d) = a.get("digest").and_then(|d| d.as_str()) {
        if let Some(hex) = d.strip_prefix("sha256:").and_then(hex64) {
            return Some(hex);
        }
    }
    a.get("sha256").and_then(|s| s.as_str()).and_then(hex64)
}

/// The optional update feed on the user's own site (`updateFeedUrl` in
/// settings.json): a static JSON file they publish next to the installers, so
/// a release can ship without a GitHub release. Read straight from disk — the
/// store's cache is not reachable from here.
pub(super) fn site_feed_url(app: &AppHandle) -> Option<String> {
    let root = crate::state::get_data_root(app);
    let raw = std::fs::read_to_string(root.join("settings.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let url = doc.get("updateFeedUrl").and_then(|v| v.as_str())?.trim().to_string();
    (url.len() > 8 && url.starts_with("http")).then_some(url)
}

/// Fetch the static JSON feed from the user's site and normalize it into the
/// GitHub-release shape the asset picker already understands:
///
/// ```json
/// { "version": "2.1.0", "notes": "…",
///   "assets": [ { "name": "Codifa_2.1.0_aarch64.dmg", "url": "https://…",
///                 "size": 98765432, "sha256": "<64 hex chars>" } ] }
/// ```
///
/// `sha256` is optional per asset (then only the size check applies), and
/// `name` follows the same conventions as GitHub assets (`-arm64.dmg`,
/// `Setup….exe`, `.AppImage`). Anything malformed → None → GitHub is tried.
pub(super) async fn fetch_site_feed(url: &str) -> Option<serde_json::Value> {
    let client = reqwest::Client::new();
    let res = client
        .get(url)
        .header("User-Agent", "codifa")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let doc: serde_json::Value = res.json().await.ok()?;
    let version = doc.get("version").and_then(|v| v.as_str())?.trim().to_string();
    if version.is_empty() {
        return None;
    }
    let assets: Vec<serde_json::Value> = doc
        .get("assets")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(|n| n.as_str())?.trim().to_string();
            let url = a.get("url").and_then(|u| u.as_str())?.trim().to_string();
            if name.is_empty() || !url.starts_with("http") {
                return None;
            }
            let sha = a.get("sha256").and_then(|s| s.as_str()).map(|s| s.trim().to_string());
            Some(serde_json::json!({
                "name": name,
                "browser_download_url": url,
                "size": a.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                "digest": sha.map(|s| format!("sha256:{s}")),
            }))
        })
        .collect();
    Some(serde_json::json!({
        "tag_name": version,
        "body": doc.get("notes").and_then(|n| n.as_str()).unwrap_or_default(),
        "html_url": doc
            .get("releaseUrl")
            .and_then(|u| u.as_str())
            .filter(|u| u.starts_with("http"))
            .unwrap_or(url),
        "assets": assets,
    }))
}

/// The GitHub fallback: normalized nothing — the raw release JSON the picker
/// already matches against. `None` on any network/HTTP error.
pub(super) async fn fetch_github_release() -> Option<serde_json::Value> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "codifa")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

/// Pick the installer asset for the current platform (same ordering rules as
/// electron/updater-core.ts pickAsset).
pub(super) fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String)> {
    let name = |a: &serde_json::Value| {
        a.get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_lowercase()
    };
    let url = |a: &serde_json::Value| {
        a.get("browser_download_url")
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let universal = |a: &serde_json::Value| name(a).contains("universal");
    if cfg!(target_os = "macos") {
        let find = |pred: &dyn Fn(&serde_json::Value) -> bool| {
            assets.iter().find(|a| pred(a)).map(|a| (name(a), url(a)))
        };
        return find(&|a| name(a).contains(&format!("-{arch}.dmg")))
            .or_else(|| find(&|a| universal(a) && name(a).ends_with(".dmg")))
            .or_else(|| find(&|a| name(a).contains(&format!("{arch}-mac.zip"))))
            .or_else(|| find(&|a| universal(a) && name(a).ends_with(".zip")))
            .or_else(|| find(&|a| name(a).ends_with(".dmg")))
            .or_else(|| find(&|a| name(a).ends_with("-mac.zip")));
    }
    if cfg!(target_os = "windows") {
        return assets
            .iter()
            .find(|a| name(a).ends_with(".exe") && (name(a).contains("setup") || name(a).contains("set up")))
            .or_else(|| assets.iter().find(|a| name(a).ends_with(".exe")))
            .map(|a| (name(a), url(a)));
    }
    if cfg!(target_os = "linux") {
        return assets
            .iter()
            .find(|a| name(a).ends_with(".appimage"))
            .map(|a| (name(a), url(a)));
    }
    None
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> UpdateInfo {
    let current_version = app.package_info().version.to_string();
    let empty = || UpdateInfo {
        available: false,
        current_version: current_version.clone(),
        latest_version: current_version.clone(),
        notes: String::new(),
        asset_name: None,
        asset_url: None,
        asset_sha256: None,
        release_url: format!("https://github.com/{REPO}/releases/latest"),
    };
    // The user's own feed is checked FIRST — a release can ship to the site
    // without a GitHub release. GitHub stays the fallback so an unset,
    // unreachable or malformed site feed never silences update checks.
    let release = match site_feed_url(&app) {
        Some(url) => match fetch_site_feed(&url).await {
            Some(r) => r,
            None => match fetch_github_release().await {
                Some(r) => r,
                None => return empty(),
            },
        },
        None => match fetch_github_release().await {
            Some(r) => r,
            None => return empty(),
        },
    };
    let latest_version = release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    let assets = release.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let asset = pick_asset(&assets);
    let asset_sha = asset
        .as_ref()
        .and_then(|(name, _)| assets.iter().find(|a| a.get("name").and_then(|n| n.as_str()) == Some(name.as_str())))
        .and_then(asset_sha256);
    UpdateInfo {
        available: is_newer(&current_version, &latest_version),
        current_version,
        latest_version: latest_version.clone(),
        notes: release.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
        asset_name: asset.as_ref().map(|(n, _)| n.clone()),
        asset_url: asset.as_ref().map(|(_, u)| u.clone()),
        asset_sha256: asset_sha,
        release_url: release
            .get("html_url")
            .and_then(|u| u.as_str())
            .unwrap_or(&format!("https://github.com/{REPO}/releases/latest"))
            .to_string(),
    }
}

#[tauri::command]
pub async fn start_update(app: AppHandle, window: tauri::WebviewWindow) -> OpResult {
    let info = check_for_updates(app.clone()).await;
    let (Some(asset_url), Some(asset_name)) = (info.asset_url, info.asset_name) else {
        return OpResult::err("No update available");
    };
    let expected_sha = info.asset_sha256.clone();
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("updates"),
        Err(e) => return OpResult::err(e.to_string()),
    };
    let _ = std::fs::create_dir_all(&dir);
    let dest = dir.join(&asset_name);
    // The download's receipt: its size AND its sha256. A previous download is
    // only reused when the file still matches what the feed pinned — a
    // size-match alone once launched any length-matching file as the installer.
    let meta_path = dir.join(format!("{asset_name}.meta"));
    let legacy_size_file = dir.join(format!("{asset_name}.size"));
    #[derive(serde::Deserialize)]
    struct DownloadMeta {
        size: u64,
        sha256: String,
    }
    let meta: Option<DownloadMeta> = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    if dest.is_file() {
        let md_len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        let reuse = match (&meta, &expected_sha) {
            (Some(m), Some(exp)) => {
                md_len == m.size
                    && m.sha256 == *exp
                    && file_sha256(&dest).map(|h| h == *exp).unwrap_or(false)
            }
            (Some(m), None) => {
                md_len == m.size
                    && (m.sha256.is_empty()
                        || file_sha256(&dest).map(|h| h == m.sha256).unwrap_or(false))
            }
            // No receipt, but the feed pins a hash: the hash itself is the
            // receipt — verify the file directly.
            (None, Some(exp)) => file_sha256(&dest).map(|h| h == *exp).unwrap_or(false),
            // No receipt, no pin: legacy `.size` behavior, size match only.
            (None, None) => {
                let legacy: Option<u64> = std::fs::read_to_string(&legacy_size_file)
                    .ok()
                    .and_then(|s| s.trim().parse().ok());
                legacy.map(|exp| md_len == exp).unwrap_or(false)
            }
        };
        if reuse {
            let _ = window.emit("updater:progress", serde_json::json!({"phase": "installing", "percent": 100}));
            return install_asset(&dest);
        }
        // Stale or tampered cache: throw it away and download fresh.
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_file(&meta_path);
        let _ = std::fs::remove_file(&legacy_size_file);
    }

    let _ = window.emit("updater:progress", serde_json::json!({"phase": "downloading", "percent": 0}));
    let client = reqwest::Client::new();
    let res = match client
        .get(&asset_url)
        .header("User-Agent", "codifa")
        .timeout(std::time::Duration::from_secs(30 * 60))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return OpResult::err(e.to_string()),
    };
    if !res.status().is_success() {
        return OpResult::err(format!("Download failed (HTTP {})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    use std::io::Write as _;
    // Stream straight to disk: buffering a ~350 MB installer in a Vec blew the
    // process up by gigabytes at peak (the biggest transient memory spike in
    // the app). The file is written to a temp path and only renamed into place
    // once the byte count matches, so a failed download never looks complete.
    let tmp = dest.with_extension("part");
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => return OpResult::err(e.to_string()),
    };
    // The hash accumulates AS the bytes stream in — verifying afterwards would
    // mean reading the whole ~350 MB installer a second time.
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let mut written: u64 = 0;
    let mut last_pct = 0u32;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return OpResult::err(e.to_string());
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&tmp);
            return OpResult::err(e.to_string());
        }
        hasher.update(&chunk);
        written += chunk.len() as u64;
        if total > 0 {
            let pct = ((written as f64 / total as f64) * 100.0) as u32;
            if pct != last_pct {
                last_pct = pct.min(99);
                let _ = window.emit("updater:progress", serde_json::json!({"phase": "downloading", "percent": last_pct}));
            }
        }
    }
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&tmp);
        return OpResult::err(e.to_string());
    }
    drop(file);
    if total > 0 && written != total {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&legacy_size_file);
        return OpResult::err(format!(
            "Download incomplete: got {written} of {total} bytes — click Retry to download again"
        ));
    }
    let got_sha = format!("{:x}", hasher.finalize());
    // THE integrity gate: a feed-pinned hash must match before the installer
    // is ever published, let alone launched. Without it a corrupted download,
    // a bad cache, or a swapped server file would run as "the update".
    if let Some(exp) = &expected_sha {
        if got_sha != *exp {
            let _ = std::fs::remove_file(&tmp);
            return OpResult::err(
                "Download failed the integrity check (sha256 mismatch) — the file on the server changed. Click Retry to download again.",
            );
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return OpResult::err(e.to_string());
    }
    let meta_doc = serde_json::json!({ "size": written, "sha256": got_sha });
    if let Err(e) = std::fs::write(&meta_path, meta_doc.to_string()) {
        return OpResult::err(e.to_string());
    }
    // The old size-only receipt has no integrity meaning left — drop it.
    let _ = std::fs::remove_file(&legacy_size_file);
    let _ = window.emit("updater:progress", serde_json::json!({"phase": "installing", "percent": 100}));
    install_asset(&dest)
}

/// Streaming sha256 of a file (hex). Cached installers are re-verified with
/// this before they are ever launched.
pub(super) fn file_sha256(path: &Path) -> Option<String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path).ok()?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match std::io::Read::read(&mut f, &mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return None,
        }
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Launch the downloaded installer for the current platform.
///
/// Linux, running FROM an AppImage: `APPIMAGE_EXTRACT_AND_RUN` merely ran the
/// new build once — the installed AppImage never changed, so "update" silently
/// never applied. When the APPIMAGE env var points at the running image (set
/// by the AppImage runtime), the verified download is copied over it instead:
/// renaming over a running binary is legal on Linux (the old inode lives until
/// the process exits), so the NEXT launch is the new version. Only when the
/// app is not AppImage-installed (dev build, .deb) does it fall back to
/// extracted-and-run.
pub(super) fn install_asset(dest: &Path) -> OpResult {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
        if let Ok(appimage) = std::env::var("APPIMAGE") {
            let target = PathBuf::from(appimage);
            if let Some(parent) = target.parent() {
                let tmp = parent.join(format!(".codifa-update-{}.AppImage", std::process::id()));
                if std::fs::copy(dest, &tmp).is_ok()
                    && std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).is_ok()
                    && std::fs::rename(&tmp, &target).is_ok()
                {
                    return OpResult::ok();
                }
                let _ = std::fs::remove_file(&tmp);
            }
        }
        return match std::process::Command::new(dest)
            .env("APPIMAGE_EXTRACT_AND_RUN", "1")
            .spawn()
        {
            Ok(child) => {
                reap_detached(child);
                OpResult::ok()
            }
            Err(e) => OpResult::err(e.to_string()),
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        match open::that(dest) {
            Ok(_) => OpResult::ok(),
            Err(e) => OpResult::err(e.to_string()),
        }
    }
}

// --- window drag region (macOS frameless) -----------------------------------

#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

// --- getPathForFile (drag & drop) -------------------------------------------

/// Tauri's drag-drop event already carries absolute file paths, so the
/// renderer bridge maps `getPathForFile` to the path recorded for the dropped
/// File object. This command is a no-op kept for API parity.
#[tauri::command]
pub fn get_path_for_file(_name: String) -> Option<String> {
    None
}

// --- unused-import guards ---------------------------------------------------

#[allow(dead_code)]
pub(super) fn _read_guard(mut r: impl Read) {
    let mut buf = [0u8; 1];
    let _ = r.read(&mut buf);
}
