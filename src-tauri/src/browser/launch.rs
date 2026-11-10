use super::*;

/// Does this command line belong to the browser THIS app launched?
///
/// Used by the startup orphan sweep, which must never touch a browser the user
/// started themselves: our own profile directory is the marker, because nobody
/// else points a browser at `~/.codifa/browser-profile`.
///
/// The helper processes Chromium forks for itself (`--type=renderer`, `=gpu`,
/// `=utility`, …) carry the SAME profile flag, so they match here too — and they
/// must. The main process spawns them in its own process group, but a browser
/// killed with SIGKILL (the app crashed, or the reaper took it down) never gets
/// to clean them up, and an ORPHANED renderer keeps its whole heap alive. The
/// old trailing `!args.contains("--type=")` excluded exactly the processes that
/// leaked, which is how an abandoned browser left its renderer tree behind.
pub(super) fn is_our_driver(args: &str, profile: &std::path::Path) -> bool {
    args.contains(profile.to_string_lossy().as_ref())
}

/// Launch flags for `bin` on `port` against `profile`.
///
/// Split out from the spawn so the flag set is unit-testable: the flags carry
/// real decisions (see the comments), and a wrong one either loses the frame
/// or drags the user's own Chrome settings into the automation session.
/// `ua` pins the USER-AGENT at the process level: a popup's first document
/// request leaves the browser BEFORE any CDP session can attach and override
/// the UA per-session, and that one request used to say `HeadlessChrome` —
/// exactly what Google's sign-in gate reads as "not a real browser".
pub(super) fn launch_args(
    bin: &std::path::Path,
    port: u16,
    profile: &std::path::Path,
    ua: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        format!("--remote-debugging-port={port}"),
        format!(
            "--remote-allow-origins=http://127.0.0.1:{port},https://chrome-devtools-frontend.appspot.com"
        ),
        // The frames are captured over CDP, so the window is never shown. Plain
        // `--headless` IS the new headless mode on Chrome 112+; the
        // `--headless=new` spelling was dropped in later releases and made
        // Chromium exit before opening the debugging port.
        "--headless".to_string(),
        // A dedicated profile keeps this browser completely separate from the
        // user's own Chrome (cookies, extensions, crashpad database).
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-blink-features=AutomationControlled".to_string(),
        "--window-size=1280,800".to_string(),
        // The panel is shown on a Retina display, and `Page.startScreencast`
        // captures at the browser's device scale. Without this flag the frame
        // is 1x CSS pixels and the webview upscales it 2x — every page looked
        // soft no matter how high the emulated viewport was. The emulated CSS
        // viewport stays 1x (`deviceScaleFactor: 1`), so page layout and input
        // coordinates are unchanged; only rasterization gets the extra pixels.
        "--force-device-scale-factor=2".to_string(),
    ];
    if let Some(ua) = ua {
        args.push(format!("--user-agent={ua}"));
    }
    // `--disable-gpu` is only needed by the desktop builds, which rasterize on
    // the GPU. The headless shell has no GPU stack at all, and passing the flag
    // there made startup dump `CVDisplayLinkCreateWithCGDisplay failed` into the
    // log on every frame — noise that buried the real errors.
    if !is_headless_shell(bin) {
        // The full build still runs its OUTPUT on SwiftShader: a GPU process
        // cannot be hosted from a daemon context (launch failure 1003), and
        // both failure modes around that are worse than software rendering —
        // Chromium used to EXIT ("GPU process isn't usable. Goodbye.") and
        // with the crash limit lifted it crash-LOOPS at a full CPU core. What
        // the full build buys over the headless shell is the rest of the
        // fingerprint: real PDF plugins, a real `window.chrome`, the desktop
        // binary's font/codec stack — and the SwiftShader WebGL string is
        // covered by the consistency script.
        args.push("--disable-gpu".to_string());
        // Chrome 139+ gates software WebGL behind an explicit opt-in.
        args.push("--enable-unsafe-swiftshader".to_string());
        for flag in [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-features=MediaRouter,OptimizationHints,Translate",
            "--disable-sync",
            "--metrics-recording-only",
            "--no-service-autorun",
            "--disable-crash-reporter",
        ] {
            args.push(flag.to_string());
        }
        // The full build wants "Chromium Safe Storage" in the user's LOGIN
        // KEYCHAIN on every launch (a password prompt over the user's work).
        // The mock keychain keeps cookie encryption inside our own profile
        // and never asks — cookies here are disposable automation state.
        if cfg!(target_os = "macos") {
            args.push("--use-mock-keychain".to_string());
        }
    }
    args
}

/// True for the Chrome-for-Testing headless shell, which lacks the flags and
/// background services only a full browser build has.
pub(super) fn is_headless_shell(bin: &std::path::Path) -> bool {
    bin.file_name()
        .map(|n| n.to_string_lossy().contains("chrome-headless-shell"))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Minimal CDP transport
// ---------------------------------------------------------------------------

/// Raw HTTP GET returning the parsed JSON body. Uses a plain socket rather than
/// `reqwest::blocking`, which panics when called from inside a runtime.
///
/// The body is read by `Content-Length` instead of `read_to_end`: Chrome's
/// DevTools HTTP server keeps the socket open after the response, so
/// `read_to_end` would block until the read timeout and report a failure even
/// though the reply had already arrived.
pub(super) fn http_get_json(port: u16, path: &str) -> Result<Value, String> {
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "bad cdp address".to_string())?;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("cdp http connect: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("cdp http write: {e}"))?;

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let mut want: Option<usize> = None;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let head = String::from_utf8_lossy(&buf[..pos]);
                        want = head.lines().find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        });
                    }
                }
                if let (Some(h), Some(w)) = (header_end, want) {
                    if buf.len() >= h + w {
                        break;
                    }
                }
            }
            // Read timeout: fall through with whatever arrived so far.
            Err(_) => break,
        }
    }
    let start = header_end.ok_or_else(|| "cdp http: no response headers".to_string())?;
    serde_json::from_slice(&buf[start..]).map_err(|e| format!("cdp http body: {e}"))
}

/// WebSocket URL of the BROWSER-level endpoint (`/json/version`). All work then
/// happens through `Target.attachToTarget{flatten:true}` + `sessionId`, which is
/// what lets one WebSocket drive many tabs — one per chat — side by side.
pub(super) fn browser_ws_url(port: u16) -> Result<String, String> {
    let info = http_get_json(port, "/json/version")?;
    info["webSocketDebuggerUrl"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no browser websocket endpoint".to_string())
}

/// Pick a free ephemeral port for Chromium's debugging endpoint.
pub(super) fn pick_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("cannot pick a cdp port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

/// Remove a stale Chromium profile lock left behind by a crashed run.
/// Chromium refuses to open its debugging port (or silently hands the command
/// to a dead instance) while `SingletonLock` still points at a gone process.
pub(super) fn clear_stale_profile_lock(profile: &std::path::Path) {
    for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
}

/// Last meaningful lines of the captured Chromium stderr, for error messages.
/// Chrome spawns its updater/crashpad helpers on the same stream, so their
/// noise is filtered out and only lines that look like real failures survive.
pub(super) fn stderr_tail(profile: &std::path::Path) -> String {
    let text = std::fs::read_to_string(profile.join("chromium-stderr.log")).unwrap_or_default();
    let interesting: Vec<&str> = text
        .lines()
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            !l.trim().is_empty()
                && (low.contains("devtools listening")
                    || low.contains("failed")
                    || low.contains("cannot")
                    || low.contains("singleton")
                    || low.contains("profile"))
        })
        .collect();
    let tail = interesting[interesting.len().saturating_sub(3)..].join(" / ");
    if tail.is_empty() {
        "no diagnostic output".to_string()
    } else {
        tail
    }
}

/// The UA to pin at launch, from the binary's own `--version` output
/// ("Google Chrome for Testing 156.0.8078.80" → the last token), so the pinned
/// version always matches the binary — and with it its own client hints.
/// `None` when the binary does not answer (Windows GUI builds sometimes print
/// nothing): the per-session override then stays the only UA fix.
pub(super) fn chrome_user_agent(bin: &std::path::Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text.trim().rsplit(' ').next()?.trim();
    if version.is_empty() || !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    let platform = if cfg!(target_os = "macos") {
        // Chrome freezes the macOS UA at 10_15_7 even on newer releases.
        "Macintosh; Intel Mac OS X 10_15_7"
    } else if cfg!(target_os = "windows") {
        "Windows NT 10.0; Win64; x64"
    } else {
        "X11; Linux x86_64"
    };
    Some(format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36"
    ))
}

/// The REAL macOS version for high-entropy client hints: Chrome freezes the
/// UA string at 10_15_7 but reports the true OS version in `platformVersion` —
/// a hardcoded old value there is itself a mismatch Google can read.
pub(super) fn macos_platform_version() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "14.5.0".to_string())
        })
        .clone()
}

/// Start the shared Chromium against `profile`. stderr is captured to a file so
/// a startup failure can be REPORTED instead of surfacing as a bare timeout.
pub(super) fn try_launch(
    bin: &std::path::Path,
    port: u16,
    profile: &std::path::Path,
    ua: Option<&str>,
) -> Result<Child, String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("cannot create profile dir: {e}"))?;
    clear_stale_profile_lock(profile);
    let err_file = std::fs::File::create(profile.join("chromium-stderr.log"))
        .map_err(|e| format!("cannot open chromium log: {e}"))?;
    let mut cmd = Command::new(bin);
    cmd.args(launch_args(bin, port, profile, ua))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file));
    // Lead a NEW process group so the whole Chromium tree (its renderer, gpu and
    // utility children) can be signalled as one. Without this the tree shares the
    // app's group and `Child::kill()` (SIGKILL, which children cannot trap and
    // forward) leaves every helper orphaned and holding its renderer heap — the
    // "browsers survive app quit" leak. Mirrors `lsp::spawn`.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()
        .map_err(|e| format!("cannot start Chromium ({}): {e}", bin.display()))
}

/// SIGKILL the browser's whole process group, falling back to the child handle.
///
/// `Child::kill()` alone cannot do it: SIGKILL is untrappable, so Chromium never
/// runs its own child cleanup and the helpers are left reparented to launchd.
/// Signalling the GROUP (the browser leads it, see `try_launch`) takes the tree
/// down in one shot.
pub(super) fn kill_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: `killpg` on a pgid we created is async-signal-safe and cannot
        // touch another process: pid 0 would signal OUR group, so it is excluded.
        let pgid = child.id() as libc::pid_t;
        if pgid > 0 {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    // Backstop for the child itself, and the only path on non-unix.
    let _ = child.kill();
    let _ = child.wait();
}

/// Wait until Chromium's debugging port answers, or report why it never did.
pub(super) fn wait_for_port(child: &mut Child, port: u16, profile: &std::path::Path) -> Result<(), String> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if http_get_json(port, "/json/version").is_ok() {
            return Ok(());
        }
        if child.try_wait().ok().flatten().is_some() {
            return Err(format!(
                "Chromium exited during startup: {}",
                stderr_tail(profile)
            ));
        }
        if Instant::now() >= deadline {
            kill_process_tree(child);
            return Err(format!(
                "Chromium did not open its debugging port in time: {}",
                stderr_tail(profile)
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Start the shared Chromium (once) and wait until its debugging port answers.
///
/// Tries EVERY installed build, best first (the full Chrome-for-Testing from
/// the one-click install, then the Playwright headless shell, ...): a build
/// that cannot START here must not take the whole browser feature down — the
/// full build's helper processes, for one, fail to spawn inside a daemon or
/// sandboxed context (GPU process launch 1003 → "GPU process isn't usable.
/// Goodbye.") while the headless shell runs fine in the same context. The
/// first build whose debugging port answers wins; per-build errors are
/// collected so a total failure still explains itself.
pub(super) fn spawn_browser() -> Result<u16, String> {
    // A browser left by a previous run (crash, forced quit) still holds the
    // profile and lock files; clear it before starting ours.
    reap_orphans();
    // An install unpacked by an older build can be missing the executable bit
    // on Chrome's INTERNAL helpers (crashpad handler, Helper apps) even though
    // the main binary runs — every launch then spawns a fork child that dies
    // pre-exec and macOS pops a crash dialog. Re-grant the bits on every
    // installed build before probing candidates; a no-op once fixed.
    for root in browser_roots() {
        for dir in candidate_dirs(&root) {
            make_executable(&dir);
        }
    }
    let candidates = chromium_candidates();
    if candidates.is_empty() {
        return Err(
            "no automation browser installed — install the built-in one from the \
             Browser panel (or run `npx playwright install chromium`)"
                .to_string(),
        );
    }
    let port = pick_port()?;
    let profile = profile_dir();
    let mut failures: Vec<String> = Vec::new();
    for bin in &candidates {
        let ua = chrome_user_agent(bin);
        let mut child = match try_launch(bin, port, &profile, ua.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                failures.push(format!("{}: {e}", bin.display()));
                continue;
            }
        };
        if let Err(e) = wait_for_port(&mut child, port, &profile) {
            // `wait_for_port` kills the child when the port never opens; the
            // explicit `wait` keeps it from becoming a zombie. A failed child
            // may also have left the profile lock wedged — clear it before the
            // next candidate inherits the same profile.
            let _ = child.kill();
            let _ = child.wait();
            clear_stale_profile_lock(&profile);
            failures.push(format!("{}: {e}", bin.display()));
            continue;
        }
        // A build whose helper processes cannot spawn here (the full build's
        // GPU process in a daemon/sandboxed context) binds its debugging port,
        // then DIES the moment the first page needs compositing — the port
        // alone is not proof of health. Wait one settle beat, then demand a
        // REAL round trip on a short-lived browser-level connection
        // (independent of the not-yet-registered BROWSER state): create a
        // page, attach, and capture one frame — exactly the work that dies.
        std::thread::sleep(Duration::from_millis(1200));
        let died = child.try_wait().ok().flatten().is_some();
        let health_port = port;
        let healthy = !died
            && block_on(async move {
                let mut cdp = Cdp::connect(health_port).await?;
                let res = cdp
                    .send(
                        "Target.createTarget",
                        json!({"url": "about:blank#health"}),
                    )
                    .await?;
                let id = res["targetId"]
                    .as_str()
                    .ok_or_else(|| "no targetId".to_string())?
                    .to_string();
                let attached = cdp
                    .send(
                        "Target.attachToTarget",
                        json!({"targetId": id, "flatten": true}),
                    )
                    .await?;
                cdp.session = Some(
                    attached["sessionId"]
                        .as_str()
                        .ok_or_else(|| "no sessionId".to_string())?
                        .to_string(),
                );
                let shot = cdp
                    .send(
                        "Page.captureScreenshot",
                        json!({"format": "jpeg", "quality": 40}),
                    )
                    .await;
                let _ = cdp
                    .send("Target.closeTarget", json!({"targetId": id}))
                    .await;
                shot.map(|v| v["data"].as_str().is_some())
                    .map_err(|e| format!("capture failed: {e}"))
            })
            .unwrap_or(false);
        if !healthy {
            let _ = child.kill();
            let _ = child.wait();
            clear_stale_profile_lock(&profile);
            failures.push(format!(
                "{}: debugging port opened but the browser did not survive startup",
                bin.display()
            ));
            continue;
        }
        let mut guard = BROWSER.lock().map_err(|_| "browser lock poisoned")?;
        // A previous process (e.g. a crashed one) is replaced.
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        // A brand-new Chromium: the pooled connection (if any) points at the
        // dead process, so the next call starts a fresh driver.
        invalidate_cdp_pool();
        drop_all_frames();
        *guard = Some(BrowserProc {
            child,
            port,
            last_used: Instant::now(),
        });
        return Ok(port);
    }
    Err(failures.join("; "))
}

/// Port of the shared browser, starting it (and nothing else) when needed.
pub(super) fn ensure_browser() -> Result<u16, String> {
    match alive_port() {
        Some(p) => Ok(p),
        None => spawn_browser(),
    }
}

