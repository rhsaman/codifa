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
            let pin = expected_sha
                .clone()
                .or_else(|| meta.as_ref().map(|m| m.sha256.clone()).filter(|s| !s.is_empty()));
            return mark_ready(&window, dest, pin);
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
    prune_stale_downloads(&dir, &asset_name);
    mark_ready(&window, dest, Some(got_sha))
}

/// The verified installer waiting for the user's "restart now" answer: its
/// path and the sha256 it must still match when it is finally launched.
static READY_INSTALLER: Mutex<Option<(PathBuf, Option<String>)>> = Mutex::new(None);

/// Download finished and verified: remember it and tell the renderer, which
/// answers with the restart confirmation popup (see `install_update`).
fn mark_ready(window: &tauri::WebviewWindow, dest: PathBuf, sha: Option<String>) -> OpResult {
    if let Ok(mut slot) = READY_INSTALLER.lock() {
        *slot = Some((dest, sha));
    }
    let _ = window.emit("updater:progress", serde_json::json!({"phase": "ready", "percent": 100}));
    OpResult::ok()
}

/// Old installers pile up (a macOS .dmg is ~350 MB): after a fresh download
/// keep only the files that belong to the current asset.
fn prune_stale_downloads(dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && !e.file_name().to_string_lossy().starts_with(keep) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// The user confirmed the restart popup: apply the downloaded update and
/// relaunch. A detached helper waits for THIS process to exit, swaps the app
/// in place (it cannot be replaced while it runs — the "item is in use"
/// error of a manual drag-install) and starts the new version. The window is
/// then closed through the normal CloseRequested path so the quit-flush
/// handshake persists the renderer's state first.
#[tauri::command]
pub async fn install_update(app: AppHandle, window: tauri::WebviewWindow) -> OpResult {
    let ready = READY_INSTALLER.lock().ok().and_then(|slot| slot.clone());
    let Some((path, sha)) = ready else {
        return OpResult::err("No downloaded update to install — download it first");
    };
    let prepared = tokio::task::spawn_blocking(move || {
        if !path.is_file() {
            return Err("The downloaded installer is missing — download the update again".to_string());
        }
        // Re-verified at the last moment: the file sat on disk since download.
        if let Some(exp) = &sha {
            if file_sha256(&path).as_deref() != Some(exp.as_str()) {
                return Err("The downloaded installer no longer matches its checksum — download the update again".to_string());
            }
        }
        spawn_installer(&path)
    })
    .await;
    match prepared {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return OpResult::err(e),
        Err(e) => return OpResult::err(e.to_string()),
    }
    let _ = window.close();
    // Safety net: if the close handshake stalls, exit anyway — the helper is
    // already waiting for this process to end.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        app.exit(0);
    });
    OpResult::ok()
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

/// Start a process that outlives this one: own session (so the parent's exit
/// and teardown never touch it), no stdio, reaped while we are still alive.
#[cfg(unix)]
fn spawn_detached(mut cmd: std::process::Command) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    reap_detached(child);
    Ok(())
}

/// Find the `.app` bundle at the top of a mounted image / unzipped archive.
/// The image's `Applications` shortcut has no `.app` extension, so it never matches.
#[cfg(target_os = "macos")]
fn find_app_bundle(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.is_dir()
            && p.extension().map(|x| x == "app").unwrap_or(false)
            && p.join("Contents").join("Info.plist").is_file()
    })
}

/// macOS: mount the .dmg (or unzip the -mac.zip), validate the new bundle, then
/// hand a detached script the swap: wait for this process to exit, replace the
/// installed .app by rename (ditto to a sibling first, so a failed copy leaves
/// the old app untouched), unmount, and `open` the result.
#[cfg(target_os = "macos")]
fn spawn_installer(asset: &Path) -> Result<(), String> {
    use std::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let Some(target) = exe
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .filter(|p| p.extension().map(|x| x == "app").unwrap_or(false))
    else {
        return Err("Codifa is not running from an .app bundle (dev build) — install the update manually".into());
    };
    let parent = target.parent().ok_or("The app has no parent folder")?.to_path_buf();
    // A drag-install into /Applications needs write access to it; probe BEFORE
    // quitting so a read-only location never ends in a half-applied update.
    let probe = parent.join(format!(".codifa-write-test-{}", std::process::id()));
    if std::fs::create_dir(&probe).is_err() {
        let _ = open::that(asset);
        return Err(format!(
            "Codifa cannot write to {} — the installer was opened instead; drag Codifa into Applications and replace it",
            parent.display()
        ));
    }
    let _ = std::fs::remove_dir(&probe);

    let pid = std::process::id();
    let tmp = std::env::temp_dir();
    let is_dmg = asset.extension().map(|e| e.eq_ignore_ascii_case("dmg")).unwrap_or(false);
    let (stage, mount, cleanup) = if is_dmg {
        let mnt = tmp.join(format!("codifa-update-mnt-{pid}"));
        let _ = std::fs::create_dir_all(&mnt);
        let out = Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-noverify", "-noautoopen", "-readonly", "-mountpoint"])
            .arg(&mnt)
            .arg(asset)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let _ = std::fs::remove_dir(&mnt);
            return Err(format!(
                "Could not open the update image: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        (mnt.clone(), mnt.to_string_lossy().into_owned(), String::new())
    } else {
        let ex = tmp.join(format!("codifa-update-x-{pid}"));
        let _ = std::fs::remove_dir_all(&ex);
        let _ = std::fs::create_dir_all(&ex);
        let ok = Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(asset)
            .arg(&ex)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_dir_all(&ex);
            return Err("Could not unpack the update archive".into());
        }
        (ex.clone(), String::new(), ex.to_string_lossy().into_owned())
    };
    let detach = |mount: &str, stage: &Path| {
        if !mount.is_empty() {
            let _ = Command::new("/usr/bin/hdiutil").args(["detach", mount, "-force"]).output();
        }
        let _ = std::fs::remove_dir_all(stage);
    };
    let Some(new_app) = find_app_bundle(&stage) else {
        detach(&mount, &stage);
        return Err("The update does not contain a Codifa app".into());
    };

    const SWAP: &str = r#"pid="$1"; src="$2"; target="$3"; mnt="$4"; cleanup="$5"
n=0
while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 300 ]; do sleep 0.2; n=$((n+1)); done
stage="$target.codifa-new"; old="$target.codifa-old"
rm -rf "$stage" "$old"
if /usr/bin/ditto "$src" "$stage" && mv "$target" "$old" && mv "$stage" "$target"; then
  rm -rf "$old"
else
  rm -rf "$stage"
  if [ ! -e "$target" ] && [ -e "$old" ]; then mv "$old" "$target"; fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
if [ -n "$mnt" ]; then /usr/bin/hdiutil detach "$mnt" -force >/dev/null 2>&1; rmdir "$mnt" 2>/dev/null; fi
if [ -n "$cleanup" ]; then rm -rf "$cleanup"; fi
/usr/bin/open "$target"
"#;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(SWAP)
        .arg("sh")
        .arg(pid.to_string())
        .arg(&new_app)
        .arg(&target)
        .arg(&mount)
        .arg(&cleanup);
    if let Err(e) = spawn_detached(cmd) {
        detach(&mount, &stage);
        return Err(e);
    }
    Ok(())
}

/// Windows: the NSIS `Setup.exe` cannot replace a running app, so a hidden
/// PowerShell waits for this process to exit, runs the installer silently
/// (`/S`) and starts the installed app again.
#[cfg(target_os = "windows")]
fn spawn_installer(asset: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    const FLAGS: u32 = 0x0800_0000 | 0x0000_0200;
    const SCRIPT: &str = "$ErrorActionPreference='SilentlyContinue'; try { Wait-Process -Id ([int]$env:CODIFA_PID) -Timeout 60 } catch {}; Start-Process -FilePath $env:CODIFA_INSTALLER -ArgumentList '/S' -Wait; Start-Process -FilePath $env:CODIFA_EXE";
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("CODIFA_PID", std::process::id().to_string())
        .env("CODIFA_INSTALLER", asset)
        .env("CODIFA_EXE", exe)
        .creation_flags(FLAGS)
        .spawn()
        .map_err(|e| e.to_string())?;
    reap_detached(child);
    Ok(())
}

/// Linux, running FROM an AppImage: the verified download is copied over the
/// running image (renaming over a running binary is legal — the old inode
/// lives until the process exits) and a detached shell starts it once this
/// process is gone. Not AppImage-installed (dev build, .deb): the downloaded
/// AppImage is run extracted instead.
#[cfg(target_os = "linux")]
fn spawn_installer(asset: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let exec_mode = std::fs::Permissions::from_mode(0o755);
    let (launch, extract_and_run) = match std::env::var("APPIMAGE") {
        Ok(appimage) => {
            let target = PathBuf::from(appimage);
            let parent = target.parent().ok_or("The AppImage has no parent folder")?;
            let tmp = parent.join(format!(".codifa-update-{}.AppImage", std::process::id()));
            let ok = std::fs::copy(asset, &tmp).is_ok()
                && std::fs::set_permissions(&tmp, exec_mode).is_ok()
                && std::fs::rename(&tmp, &target).is_ok();
            if !ok {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "Could not replace {} — check write permission on its folder",
                    target.display()
                ));
            }
            (target, false)
        }
        Err(_) => {
            let _ = std::fs::set_permissions(asset, exec_mode);
            (asset.to_path_buf(), true)
        }
    };
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(r#"n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 300 ]; do sleep 0.2; n=$((n+1)); done; exec "$2""#)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(&launch)
        // The old image's runtime variables would mislead the new one.
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("ARGV0")
        .env_remove("OWD");
    if extract_and_run {
        cmd.env("APPIMAGE_EXTRACT_AND_RUN", "1");
    }
    spawn_detached(cmd)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn spawn_installer(_asset: &Path) -> Result<(), String> {
    Err("Automatic update is not supported on this platform".into())
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
