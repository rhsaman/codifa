use super::*;

/// Chrome-for-Testing publishes every build it has ever made, with a per-platform
/// download index. Reading that index (instead of hard-coding a version) means
/// the install cannot rot when a build is rotated out of the bucket.
pub(super) const CFT_INDEX: &str =
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/// Progress of a running install, polled by the Browser panel.
///
/// `Mutex<Install>` (not a lazy cell) so the static stays `const`-constructible.
pub(super) struct Install {
    running: bool,
    percent: u32,
    /// `downloading` | `extracting` | `done` | `failed` | empty when idle.
    phase: String,
    error: String,
}

pub(super) static INSTALL: Mutex<Install> = Mutex::new(Install {
    running: false,
    percent: 0,
    phase: String::new(),
    error: String::new(),
});

/// The Chrome-for-Testing platform key for this machine.
pub(super) fn cft_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else if cfg!(target_os = "windows") {
        "win64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux64"
    }
}

/// The full Chrome-for-Testing download for this platform, as `(url, version)`.
///
/// The FULL browser is the right artifact, not the headless shell: the new
/// headless mode keeps the real GPU stack (ANGLE/Metal), so heavy pages
/// rasterize on the GPU instead of SwiftShader software rendering, and the
/// WebGL fingerprint reports a genuine Apple GPU — the shell's SwiftShader
/// string is exactly what Google's "may not be secure" sign-in gate reads as
/// "not a real browser". It still lives inside the app's own data root, so
/// the system-Chrome hijacking concerns in `chromium_candidates` never apply.
pub(super) fn cft_browser_url() -> Result<(String, String), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let index: Value = client
        .get(CFT_INDEX)
        .send()
        .map_err(|e| format!("cannot read the browser index: {e}"))?
        .json()
        .map_err(|e| format!("browser index is not json: {e}"))?;
    let want = cft_platform();
    let stable = &index["channels"]["Stable"];
    let version = stable["version"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let url = stable["downloads"]["chrome"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|d| d["platform"].as_str() == Some(want))
                .and_then(|d| d["url"].as_str())
        })
        .map(str::to_string)
        .ok_or_else(|| format!("chrome-for-testing has no chrome build for {want}"))?;
    Ok((url, version))
}

pub(super) fn set_progress(phase: &str, percent: u32) {
    if let Ok(mut st) = INSTALL.lock() {
        st.phase = phase.to_string();
        st.percent = percent;
    }
}

/// Start the install in the background. Idempotent: a second call while one is
/// running is a no-op, so a double click cannot download the archive twice.
pub fn install() {
    {
        let Ok(mut st) = INSTALL.lock() else {
            return;
        };
        if st.running {
            return;
        }
        st.running = true;
        st.percent = 0;
        st.error.clear();
        st.phase = "downloading".to_string();
    }
    // `reqwest::blocking` builds its own runtime and panics when called from
    // inside an async context, and the HTTP route that starts this is async — so
    // the whole install runs on a plain thread (same rule as `mcp.rs`).
    std::thread::spawn(|| {
        let result = install_blocking();
        if let Ok(mut st) = INSTALL.lock() {
            st.running = false;
            match result {
                Ok(()) => {
                    st.phase = "done".to_string();
                    st.percent = 100;
                }
                Err(e) => {
                    st.phase = "failed".to_string();
                    st.error = e;
                }
            }
        }
    });
}

/// The install status the panel polls.
pub fn install_status() -> Value {
    let (running, percent, phase, error) = match INSTALL.lock() {
        Ok(st) => (
            st.running,
            st.percent,
            st.phase.clone(),
            st.error.clone(),
        ),
        Err(_) => (false, 0, String::new(), "install lock poisoned".to_string()),
    };
    json!({
        "ok": true,
        "available": is_available(),
        "installing": running,
        "percent": percent,
        "phase": phase,
        "error": error,
    })
}

pub(super) fn install_blocking() -> Result<(), String> {
    let (url, version) = cft_browser_url()?;
    let root = data_root().join("browser");
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let pid = std::process::id();
    let zip_path = std::env::temp_dir().join(format!("codifa-browser-{pid}.zip"));
    let staging = std::env::temp_dir().join(format!("codifa-browser-unpack-{pid}"));
    let _ = std::fs::remove_dir_all(&staging);

    let result = (|| -> Result<(), String> {
        download_to(&url, &zip_path)?;
        set_progress("extracting", 92);
        std::fs::create_dir_all(&staging).map_err(|e| format!("cannot stage: {e}"))?;
        extract_zip(&zip_path, &staging)?;
        let unpacked = single_child_dir(&staging)?;
        // The zip's own top-level name (`chrome-mac-arm64`) is NOT a shape
        // `candidate_dirs` filters on; rehouse it under the versioned
        // chrome-for-testing name so the numeric rank orders it and the
        // layout probes find the binary.
        let dest = root.join(format!("chrome-for-testing-{version}"));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&unpacked, &dest).map_err(|e| {
            format!("cannot move the browser into {}: {e}", dest.display())
        })?;
        make_executable(&dest);
        if find_chromium().is_none() {
            return Err("the browser was unpacked but its binary was not found".to_string());
        }
        Ok(())
    })();

    // One build is enough: the retention backstop only removes superseded
    // builds a day late, so the install reclaims the ~150 MB apiece right now.
    if result.is_ok() {
        let keep = root.join(format!("chrome-for-testing-{version}"));
        prune_other_browser_builds(&root, &keep);
    }
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Delete every `chrome-for-testing-*` build under `root` except `keep`.
/// Best-effort: a build still running (locked on Windows) simply survives and
/// is picked up by the retention backstop later.
pub(super) fn prune_other_browser_builds(root: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("chrome-for-testing")
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Stream `url` to `dest`, reporting progress over the first 90% so the
/// extraction phase has its own visible slice.
pub(super) fn download_to(url: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut res = client
        .get(url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download failed (HTTP {})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last = u32::MAX;
    loop {
        let n = res.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("cannot write the download: {e}"))?;
        written += n as u64;
        if total > 0 {
            let pct = ((written as f64 / total as f64) * 90.0) as u32;
            if pct != last {
                last = pct;
                set_progress("downloading", pct);
            }
        }
    }
    file.sync_all().map_err(|e| format!("cannot flush: {e}"))?;
    if total > 0 && written != total {
        return Err(format!(
            "download incomplete: got {written} of {total} bytes"
        ));
    }
    Ok(())
}

/// Unpack every entry of `archive` under `dest`.
///
/// `enclosed_name()` rejects entries that try to escape the target directory
/// (`../`), so a hostile archive cannot write outside `dest`.
///
/// The archive's stored Unix mode is applied: the Chrome-for-Testing zips mark
/// every binary 0755, and dropping that bit breaks the browser's INTERNAL
/// spawns (crashpad's handler, the Helper apps) even though the main binary is
/// chmod'ed afterwards — the missing bit made macOS pop a crash dialog on
/// every launch (see `make_executable`).
pub(super) fn extract_zip(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("cannot open the download: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("the download is not a zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("cannot read the archive: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut writer = std::fs::File::create(&out)
            .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut writer)
            .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A mode-less archive means a plain file; a stored mode with any
            // permission bit set is honoured as-is so 0755 binaries stay 0755.
            let mode = entry.unix_mode().unwrap_or(0o644) & 0o7777;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// The single directory an archive unpacks into (both the app's own download
/// and every Chrome-for-Testing zip use exactly one).
pub(super) fn single_child_dir(root: &std::path::Path) -> Result<PathBuf, String> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| format!("cannot read the unpacked archive: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.len() == 1 {
        return Ok(dirs.remove(0));
    }
    Err("the archive did not unpack into a single directory".to_string())
}

/// True when `file` starts with a Mach-O (or shebang) header — something
/// `exec()` would run. Chrome's bundle carries executables far beyond the main
/// binary: `Helpers/chrome_crashpad_handler`, `app_mode_loader` and every
/// `Helper (...).app/Contents/MacOS/*`. A missing +x on any of them makes the
/// browser's internal spawns fail with EACCES — crashpad's handler spawn then
/// leaves a fork child that dies pre-exec, and macOS pops a "quit
/// unexpectedly" dialog on EVERY launch even though the browser itself works.
pub(super) fn is_executable_image(file: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(file) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok()
        && matches!(
            magic,
            [0xCA, 0xFE, 0xBA, 0xBE]   // fat/universal binary
                | [0xCE, 0xFA, 0xED, 0xFE] // Mach-O 32-bit LE
                | [0xFE, 0xED, 0xFA, 0xCE] // Mach-O 32-bit BE
                | [0xCF, 0xFA, 0xED, 0xFE] // Mach-O 64-bit LE
                | [0xFE, 0xED, 0xFA, 0xCF] // Mach-O 64-bit BE
                | [b'#', b'!', _, _]   // shebang script
        )
}

/// Grant the executable bit to every executable image under `dir`.
///
/// ZIP archives do not always carry the executable bit through, and a browser
/// binary without it fails with a bare permission error. The probe walks the
/// unpacked build itself — NOT `find_chromium()`, which until this fix lands
/// still resolves to the previous install and once made it skip the chmod
/// entirely (`Permission denied` on the very next launch).
///
/// `binaries_under` alone only reaches the MAIN binary; the same install also
/// unpacked `chrome_crashpad_handler` and the Helper apps without their exec
/// bit, and every launch then died in crashpad's handler spawn — visible to
/// the user as a repeating macOS crash-report dialog. The deep walk below
/// fixes every Mach-O in the tree, and the same walk is run over ALREADY
/// installed builds from `spawn_browser`, so existing installs self-heal on
/// the next launch without a re-download.
pub(super) fn make_executable(dir: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The known main binaries first: the deep walk below would cover them,
        // but this also reaches launcher shapes the layout list knows that the
        // magic sniffing cannot (and the layout list is the documented path).
        for bin in binaries_under(dir) {
            if bin.is_file() {
                if let Ok(meta) = std::fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    if perms.mode() & 0o111 == 0 {
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&bin, perms);
                    }
                }
            }
        }
        // Then the whole tree, so the bundle's internal helpers — crashpad's
        // handler and every Helper app — end up executable too.
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.is_file() && is_executable_image(&p) {
                    if let Ok(meta) = std::fs::metadata(&p) {
                        let mut perms = meta.permissions();
                        if perms.mode() & 0o111 == 0 {
                            perms.set_mode(0o755);
                            let _ = std::fs::set_permissions(&p, perms);
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Current page URL of a tab, or "" when it cannot be read.
pub(super) fn current_url(tab: &Tab) -> String {
    let res = cdp_calls(
        tab,
        vec![(
            "Runtime.evaluate",
            json!({"expression": "location.href", "returnByValue": true}),
        )],
    );
    match res {
        Ok(out) => out
            .into_iter()
            .next()
            .unwrap_or(Value::Null)["result"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        Err(_) => String::new(),
    }
}

