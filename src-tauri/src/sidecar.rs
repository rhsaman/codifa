//! Python sidecar lifecycle (mirrors electron/sidecar.ts).
//!
//! Spawns `backend/server.py` with a free loopback port, waits for /health,
//! and reports unexpected deaths to the renderer via the `sidecar:dead` event.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::secrets::get_secrets_key;
use crate::state::get_data_root;

pub struct SidecarHandle {
    pub url: String,
    pub child: Child,
}

pub struct SidecarState {
    pub handle: Mutex<Option<SidecarHandle>>,
    pub stopping: Mutex<bool>,
    /// Guards against concurrent spawns: two simultaneous start_sidecar calls
    /// (setup thread + renderer's sidecar_url) each spawned a Python process.
    pub starting: Mutex<bool>,
}

/// The sidecar's private loopback URL, mirrored into a global so the axum
/// proxy (which runs without a Tauri AppHandle) can reach it.
static PRIVATE_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Current sidecar URL for the proxy layer, if running.
pub fn current_url() -> Option<String> {
    PRIVATE_URL.lock().unwrap().clone()
}

impl SidecarState {
    pub fn new() -> Self {
        SidecarState {
            handle: Mutex::new(None),
            stopping: Mutex::new(false),
            starting: Mutex::new(false),
        }
    }
}

fn find_backend_dir(app: &AppHandle) -> Option<PathBuf> {
    // In `tauri dev` the resource dir holds a copy of the backend that Tauri
    // staged at build time — running it silently ignores source edits (and it
    // goes stale the moment backend/ changes). Prefer the repo checkout while
    // developing; the packaged layout wins in release builds.
    let dev_candidates = [
        std::env::current_dir().ok().map(|d| d.join("backend")),
        std::env::current_dir()
            .ok()
            .and_then(|d| d.parent().map(|p| p.join("backend"))),
    ];
    let packaged = app
        .path()
        .resource_dir()
        .ok()
        .map(|res| res.join("backend"));
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    if let Ok(p) = std::env::var("CODER_BACKEND") {
        candidates.push(Some(PathBuf::from(p)));
    }
    if cfg!(debug_assertions) {
        candidates.extend(dev_candidates);
        candidates.push(packaged);
    } else {
        candidates.push(packaged);
        candidates.extend(dev_candidates);
    }
    for c in candidates.into_iter().flatten() {
        if c.join("server.py").exists() {
            return Some(c);
        }
    }
    None
}

/// Merge the minimal GUI-launched PATH with the user's login-shell PATH so
/// child tools (docker, rg, MCP stdio servers, …) resolve like a terminal launch.
pub(crate) fn shell_path() -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(sep)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if !cfg!(windows) {
        for dir in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            let p = PathBuf::from(dir);
            if p.exists() && !parts.iter().any(|x| x == dir) {
                parts.push(dir.to_string());
            }
        }
        // Ask the login shell for the real user PATH (macOS GUI apps do not
        // load shell rc files). A slow/missing shell just keeps the defaults.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        });
        let probe = if cfg!(target_os = "macos") {
            format!("{shell} -l -c 'echo -n \"$PATH\"'")
        } else {
            format!("{shell} -c 'echo -n \"$PATH\"'")
        };
        if let Ok(out) = std::process::Command::new("sh")
            .arg("-c")
            .arg(&probe)
            .output()
        {
            let out = String::from_utf8_lossy(&out.stdout);
            for p in out.trim().split(sep) {
                if !p.is_empty() && !parts.iter().any(|x| x == p) {
                    parts.push(p.to_string());
                }
            }
        }
    }
    parts.join(&sep.to_string())
}

fn find_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Locate the uv binary even when the app is launched from Finder with a
/// minimal PATH (GUI apps do not load shell rc files).
fn find_uv() -> Option<String> {
    if let Ok(p) = std::env::var("UV_BIN") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/uv"),
        PathBuf::from("/usr/local/bin/uv"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/uv"));
        candidates.push(home.join(".cargo/bin/uv"));
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

fn spawn_sidecar(
    backend_dir: &PathBuf,
    port: u16,
    data_root: &str,
    secret_key: &str,
) -> std::io::Result<Child> {
    let server = backend_dir.join("server.py");
    let venv = if cfg!(windows) {
        backend_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        backend_dir.join(".venv").join("bin").join("python")
    };
    let (cmd, args): (String, Vec<String>) = if venv.exists() {
        (
            venv.to_string_lossy().into_owned(),
            vec![server.to_string_lossy().into_owned(), "--port".into(), port.to_string()],
        )
    } else {
        // GUI-launched apps have a minimal PATH; probe the common uv install
        // locations instead of relying on `uv` being resolvable.
        let uv = find_uv().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "uv not found; cannot launch the Python backend",
            )
        })?;
        (
            uv,
            vec![
                "run".into(),
                "--project".into(),
                backend_dir.to_string_lossy().into_owned(),
                "python".into(),
                server.to_string_lossy().into_owned(),
                "--port".into(),
                port.to_string(),
            ],
        )
    };
    let mut command = std::process::Command::new(&cmd);
    command
        .args(&args)
        .current_dir(backend_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Inherit the parent env, then apply the sidecar-specific overrides.
    for (k, v) in std::env::vars() {
        command.env(&k, &v);
    }
    command.env("PATH", shell_path());
    command.env("PYTHONIOENCODING", "utf-8");
    // A PYTHONHOME inherited from the parent (a dev shell, a launcher, a
    // previous bundled run) points the venv python at a foreign stdlib and
    // makes it exit immediately — the sidecar then never answers /health.
    // Drop it; only the bundled base below may set it.
    command.env_remove("PYTHONHOME");
    // The bundled venv ships a relocated copy of the uv-managed base python
    // (built with prefix /install); point PYTHONHOME at it so the stdlib and
    // encodings resolve inside the .app bundle.
    let bundled_base = backend_dir.join(".python-base");
    if bundled_base.exists() {
        command.env("PYTHONHOME", &bundled_base);
    }
    command.env("CODER_DATA_DIR", data_root);
    command.env("CODER_SECRET_KEY", secret_key);
    command.env("CODIFA_PARENT_PID", std::process::id().to_string());
    if cmd == "uv" {
        // The packaged backend dir is read-only-ish inside the .app bundle;
        // keep the uv-managed venv in the user's data root instead.
        command.env(
            "UV_PROJECT_ENVIRONMENT",
            PathBuf::from(data_root).join(".venv"),
        );
    }
    command.spawn()
}

/// Wait until `url/health` answers OK. The budget is generous because a cold
/// start may run `uv sync` (first launch with a missing/broken venv) which
/// installs the whole dependency tree.
fn wait_healthy(url: &str, child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(120);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("reqwest client");
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if let Ok(res) = client.get(format!("{url}/health")).send() {
            if res.status().is_success() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

/// Start the sidecar if it is not already running. Returns its URL.
/// Concurrent callers wait for the in-flight spawn instead of spawning again.
pub fn start_sidecar(app: &AppHandle) -> Result<String, String> {
    {
        let state = app.state::<SidecarState>();
        let guard = state.handle.lock().unwrap();
        if let Some(h) = guard.as_ref() {
            return Ok(h.url.clone());
        }
        // Another thread is already spawning: wait (bounded) for it to finish.
        if *state.starting.lock().unwrap() {
            drop(guard);
            let deadline = Instant::now() + Duration::from_secs(130);
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(200));
                let state = app.state::<SidecarState>();
                let guard = state.handle.lock().unwrap();
                if let Some(h) = guard.as_ref() {
                    return Ok(h.url.clone());
                }
                if !*state.starting.lock().unwrap() {
                    break; // spawn failed; fall through to a fresh attempt
                }
            }
            return Err("sidecar startup already in progress".into());
        }
        *state.starting.lock().unwrap() = true;
    }
    let result = start_sidecar_inner(app);
    let state = app.state::<SidecarState>();
    *state.starting.lock().unwrap() = false;
    result
}

fn start_sidecar_inner(app: &AppHandle) -> Result<String, String> {
    let backend_dir = find_backend_dir(app)
        .ok_or_else(|| "backend/server.py not found; run `npm run setup`".to_string())?;
    let port = find_free_port().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}");
    let data_root = get_data_root(app).to_string_lossy().into_owned();
    let secret_key = get_secrets_key(app);
    let mut child = spawn_sidecar(&backend_dir, port, &data_root, &secret_key)
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;
    if !wait_healthy(&url, &mut child) {
        let _ = child.kill();
        return Err("Python sidecar did not become healthy; run `npm run setup`".into());
    }
    // Drain sidecar output onto the app log (stderr only — stdout is quiet).
    let mut stderr = child.stderr.take();
    std::thread::spawn(move || {
        use std::io::Read;
        if let Some(stderr) = stderr.as_mut() {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        for line in text.lines() {
                            if !line.trim().is_empty() {
                                eprintln!("[sidecar] {line}");
                            }
                        }
                    }
                }
            }
        }
    });
    // Watch for unexpected death -> emit sidecar:dead. The child itself stays
    // owned by the state; the watcher polls its pid via try_wait through the
    // state handle.
    let watcher_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let (still_running, was_stopping) = {
            let st = watcher_app.state::<SidecarState>();
            let mut guard = st.handle.lock().unwrap();
            match guard.as_mut() {
                Some(h) => match h.child.try_wait() {
                    Ok(Some(_)) | Err(_) => (false, *st.stopping.lock().unwrap()),
                    Ok(None) => (true, false),
                },
                None => (false, true), // explicitly stopped
            }
        };
        if still_running {
            continue;
        }
        {
            let st = watcher_app.state::<SidecarState>();
            let mut guard = st.handle.lock().unwrap();
            if guard.is_some() {
                *guard = None;
                let mut stopping = st.stopping.lock().unwrap();
                *stopping = false;
            }
        }
        if !was_stopping {
            eprintln!("[sidecar] exited unexpectedly");
            let _ = watcher_app.emit("sidecar:dead", ());
        }
        break;
    });
    {
        let state = app.state::<SidecarState>();
        let mut guard = state.handle.lock().unwrap();
        *guard = Some(SidecarHandle {
            url: url.clone(),
            child,
        });
    }
    *PRIVATE_URL.lock().unwrap() = Some(url.clone());
    Ok(url)
}

/// The running sidecar's URL WITHOUT starting it (quit-flush fast path).
pub fn peek_sidecar_url(app: &AppHandle) -> Option<String> {
    let state = app.state::<SidecarState>();
    let guard = state.handle.lock().unwrap();
    guard.as_ref().map(|h| h.url.clone())
}

/// Stop the sidecar gracefully (SIGTERM then SIGKILL after a timeout).
pub fn stop_sidecar(app: &AppHandle, timeout_ms: u64) {
    let current = {
        let state = app.state::<SidecarState>();
        let mut guard = state.handle.lock().unwrap();
        guard.take()
    };
    *PRIVATE_URL.lock().unwrap() = None;
    let Some(mut handle) = current else {
        return;
    };
    {
        let state = app.state::<SidecarState>();
        *state.stopping.lock().unwrap() = true;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(handle.child.id() as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = handle.child.kill();
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        match handle.child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let _ = handle.child.kill();
    let _ = handle.child.wait();
}

/// Liveness probe: true when the cached URL answers /health within 1.5s.
pub fn probe_sidecar(app: &AppHandle) -> bool {
    let Some(url) = peek_sidecar_url(app) else {
        return false;
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("reqwest client");
    matches!(client.get(format!("{url}/health")).send(), Ok(res) if res.status().is_success())
}
