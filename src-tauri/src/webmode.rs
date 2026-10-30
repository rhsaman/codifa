//! Web/serve mode — run the app headless on a server and drive it from a
//! browser.
//!
//! `codifa serve [--host H] [--port N] [--dist DIR]` (or the `CODIFA_SERVE=1`
//! env) switches the SAME binary into server mode: no window is shown, the
//! native router binds the requested address and additionally serves the built
//! frontend plus a small authenticated web surface (`/web/call`,
//! `/web/upload`, `/ws/terminal`) that mirrors the `window.coder` Tauri
//! commands a browser has no other way to reach.
//!
//! Everything here is process-global state (a `OnceLock` per concern) because
//! the router runs on its own tokio runtime with no `AppHandle` — the same
//! pattern `state::current_data_root()` already uses for the data path.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Serve-mode configuration, parsed from argv/env before the Tauri builder
/// runs. `None` = normal desktop launch (loopback router, window, no auth).
pub struct ServeConfig {
    pub host: String,
    pub port: u16,
    /// Directory with the built frontend (`index.html` + `assets/`). Packaged
    /// builds serve the frontend embedded in the binary first and only fall
    /// back to this for a dev/cargo run.
    pub dist: Option<PathBuf>,
    /// `codifa serve` runs DETACHED by default (`--daemon` is the default
    /// behaviour, kept as an accepted alias): the process re-spawns itself,
    /// prints the access URL and the parent returns. `--foreground` opts out
    /// for terminal-attached runs and supervisors (systemd).
    pub daemon: bool,
}

static SERVE: OnceLock<ServeConfig> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static TOKEN: OnceLock<String> = OnceLock::new();
/// Set when the exit was EXPLICIT — `restart_app` (code RESTART_EXIT_CODE).
/// The only situation where the parked main thread below may let the process
/// end: the new process is already spawned at that point.
static EXIT_ALLOWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Parse `codifa serve [--host H] [--port N] [--dist DIR]`.
///
/// Also honours `CODIFA_SERVE=1` with `CODIFA_SERVE_HOST` / `CODIFA_SERVE_PORT`
/// / `CODIFA_SERVE_DIST`, so a systemd unit needs no argv at all. Returns
/// `None` for a normal desktop launch.
pub fn from_env_and_args() -> Option<ServeConfig> {
    let args: Vec<String> = std::env::args().collect();
    let serve_arg = args.iter().any(|a| a == "serve" || a == "--serve");
    let serve_env = std::env::var("CODIFA_SERVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !serve_arg && !serve_env {
        return None;
    }
    let mut host = std::env::var("CODIFA_SERVE_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let mut port: u16 = std::env::var("CODIFA_SERVE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let mut dist = std::env::var("CODIFA_SERVE_DIST").ok().map(PathBuf::from);
    // serve = background by default; --foreground attaches to the terminal
    // (and is what a systemd unit should use).
    let mut daemon = true;
    // argv overrides env (only meaningful for the `serve` subcommand form).
    // Index-walked rather than iterator-driven: taking a flag's VALUE needs to
    // advance past the flag itself, which a `while let Some(a) = it.next()`
    // loop cannot do (the item borrow would hold the iterator for the body).
    let mut i = 1usize;
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = |prefix: &str| -> Option<String> {
            let rest = a.strip_prefix(prefix)?;
            if !rest.is_empty() {
                return Some(rest.trim_start_matches('=').to_string());
            }
            i += 1;
            args.get(i).cloned()
        };
        if let Some(v) = val("--host") {
            host = v;
        } else if let Some(v) = val("--port") {
            port = v.parse().unwrap_or(port);
        } else if let Some(v) = val("--dist") {
            dist = Some(PathBuf::from(v));
        } else if a == "--daemon" || a == "-d" {
            daemon = true;
        } else if a == "--foreground" || a == "--no-daemon" || a == "-f" {
            daemon = false;
        }
        i += 1;
    }
    if host == "0.0.0.0" {
        // A wildcard bind is exactly the "expose to the network" case the token
        // exists for, but leaving it silent is how someone exposes this twice.
        eprintln!(
            "[web] WARNING: binding 0.0.0.0 — the router is reachable from every \
             interface. Only run this on a trusted network or behind a TLS proxy."
        );
    }
    Some(ServeConfig { host, port, dist, daemon })
}

/// Install the serve config (called from `main` before the builder runs).
pub fn init(config: ServeConfig) -> bool {
    SERVE.set(config).is_ok()
}

pub fn active() -> Option<&'static ServeConfig> {
    SERVE.get()
}

/// The app handle, mirrored at setup so handle-free threads (the router, the
/// terminal WebSocket) can reach the commands' logic.
pub fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

pub fn app() -> Option<&'static tauri::AppHandle> {
    APP.get()
}

/// The web access token.
///
/// Loaded from `CODIFA_WEB_TOKEN`, then the persisted `web-token` file in the
/// data root, then generated once and persisted (0600, like a private key):
/// the token must survive restarts or every restart would invalidate the URL
/// the user saved. Called from `setup` while an AppHandle still exists.
pub fn ensure_token(data_root: &std::path::Path) -> &'static str {
    TOKEN.get_or_init(|| {
        if let Ok(t) = std::env::var("CODIFA_WEB_TOKEN") {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
        let path = data_root.join("web-token");
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if t.len() >= 16 {
                return t;
            }
        }
        use rand::Rng;
        let t: String = (0..48)
            .map(|_| {
                const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                CHARS[rand::thread_rng().gen_range(0..CHARS.len())] as char
            })
            .collect();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match std::fs::write(&path, &t) {
            Ok(_) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &path,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
            }
            Err(e) => eprintln!("[web] could not persist web-token ({e}); token is per-run only"),
        }
        t
    })
}

pub fn token() -> Option<&'static str> {
    TOKEN.get().map(String::as_str)
}

/// Mark the exit as explicit (restart_app): the parked main thread may stop.
pub fn allow_exit() {
    EXIT_ALLOWED.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub fn exit_allowed() -> bool {
    EXIT_ALLOWED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Per-turn INFO logs are quiet by default: a server log must show errors,
/// not one line per message. `CODIFA_VERBOSE=1` restores the info lines —
/// STRUCTURAL fields only; chat content never goes to the log from anywhere.
pub fn verbose() -> bool {
    static VERBOSE: OnceLock<bool> = OnceLock::new();
    *VERBOSE.get_or_init(|| {
        std::env::var("CODIFA_VERBOSE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

/// The frontend directory to serve, resolved lazily.
///
/// `--dist` wins. Without it, a `dist/` next to the current working directory
/// is picked up — that makes plain `codifa serve` from the repo root (or
/// `npm run serve`) work with no flags at all. A packaged build never gets
/// here: the frontend is embedded in the binary and the asset resolver
/// answers first.
pub fn dist_dir() -> Option<PathBuf> {
    let cfg = active()?;
    if let Some(d) = &cfg.dist {
        return Some(d.clone());
    }
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let d = std::env::current_dir().ok()?.join("dist");
            d.join("index.html").is_file().then_some(d)
        })
        .clone()
}

/// `~/.codifa` — the daemon bookkeeping (pid + log) home. Deliberately NOT
/// the movable data root: the parent has no AppHandle yet, and a log/pid pair
/// that never moves is easier to find in `journalctl` and tab completion.
fn runtime_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codifa")
}

/// `codifa serve --daemon` — re-spawn THIS binary detached and let the parent
/// return, so the shell gets its prompt back and the server outlives the
/// terminal. The child runs with `CODIFA_SERVE_CHILD=1` (no re-spawn), stdout
/// into `~/.codifa/serve.log`, and its own process group so a Ctrl-C or
/// terminal close on the parent never reaches it.
///
/// Returns true when the caller should EXIT (the parent after spawning, or on
/// a spawn failure); false when this process IS the server (the child, or no
/// --daemon requested).
pub fn daemonize_if_requested() -> bool {
    let Some(cfg) = active() else { return false };
    if !cfg.daemon {
        return false;
    }
    if std::env::var_os("CODIFA_SERVE_CHILD").is_some() {
        return false;
    }
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("serve.log");
    let pre_len = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[web] daemon: cannot resolve the executable: {e}");
            return true;
        }
    };
    // Same argv minus the daemon flags, so the child is a plain `serve`.
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| a != "--daemon" && a != "-d")
        .collect();
    let mut cmd = std::process::Command::new(exe);
    cmd.args(&args).env("CODIFA_SERVE_CHILD", "1");
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => {
            let out = file.try_clone().ok();
            let err = file.try_clone().ok();
            if let Some(o) = out {
                cmd.stdout(std::process::Stdio::from(o));
            }
            if let Some(e) = err {
                cmd.stderr(std::process::Stdio::from(e));
            }
        }
        Err(e) => eprintln!("[web] daemon: cannot open {}: {e}", log_path.display()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            let _ = std::fs::write(dir.join("serve.pid"), pid.to_string());
            // Surface the ready URL from the child's fresh log output, so the
            // parent's stdout is still the one place to copy the URL from.
            let started = std::time::Instant::now();
            let mut announced = false;
            while started.elapsed() < std::time::Duration::from_secs(20) {
                if let Ok(bytes) = std::fs::read(&log_path) {
                    let fresh = if (pre_len as usize) < bytes.len() {
                        &bytes[pre_len as usize..]
                    } else {
                        &[][..]
                    };
                    if let Some(line) = String::from_utf8_lossy(fresh)
                        .lines()
                        .find(|l| l.contains("[web] Codifa server ready"))
                    {
                        println!("{line}");
                        announced = true;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            if !announced {
                println!(
                    "[web] starting in background — log: {}",
                    log_path.display()
                );
            }
            println!(
                "[web] pid {pid} — stop with `codifa stop` (or: kill $(cat {}/serve.pid))",
                dir.display()
            );
        }
        Err(e) => eprintln!("[web] daemon spawn failed: {e}"),
    }
    true
}

/// `codifa stop` — SIGTERM the background server recorded in serve.pid.
/// Returns true when the arg was `stop` (the caller exits either way).
pub fn stop_daemon() -> bool {
    if !std::env::args().any(|a| a == "stop") {
        return false;
    }
    let pid_path = runtime_dir().join("serve.pid");
    match std::fs::read_to_string(&pid_path) {
        Ok(text) => match text.trim().parse::<u32>() {
            Ok(pid) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .output();
                }
                println!("[web] sent stop signal to {pid}");
                let _ = std::fs::remove_file(&pid_path);
            }
            Err(_) => println!("[web] serve.pid is corrupt: {}", text.trim()),
        },
        Err(_) => println!(
            "[web] no background server found ({} missing) — start one with `codifa serve --daemon`",
            pid_path.display()
        ),
    }
    true
}

/// Constant-time-ish token comparison: XOR-fold instead of early return, so a
/// remote caller cannot time-keyside a prefix match. The fold makes the work
/// independent of where the mismatch is.
pub fn token_matches(candidate: &str) -> bool {
    let Some(expected) = token() else {
        return false;
    };
    if candidate.len() != expected.len() {
        return false;
    }
    candidate
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_match_rejects_wrong_length_and_content() {
        // No token installed in the test process: everything must be refused.
        assert!(!token_matches(""));
        assert!(!token_matches("whatever"));
    }

    #[test]
    fn serve_config_reads_cli_flags() {
        // Directly exercise the flag parser via a fake argv is awkward with
        // std::env::args pinned to the test binary, so only assert the
        // desktop default here: no serve flags in a unit-test run.
        // (from_env_and_args is covered by the smoke test in serve mode.)
        let forced = std::env::var("CODIFA_SERVE").is_ok();
        if !forced {
            assert!(from_env_and_args().is_none());
        }
    }
}
