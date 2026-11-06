use super::*;

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        open::that_detached(&url).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn open_external_chrome(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let ok = std::process::Command::new("open")
            .args(["-a", "Google Chrome", &url])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let roots = [
            std::env::var("PROGRAMFILES").ok(),
            std::env::var("PROGRAMW6432").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];
        for root in roots.into_iter().flatten() {
            let exe = PathBuf::from(root)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe");
            if exe.exists() {
                if let Ok(child) = std::process::Command::new(&exe).arg(&url).spawn() {
                    reap_detached(child);
                    return Ok(());
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for bin in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
            if let Ok(child) = std::process::Command::new(bin).arg(&url).spawn() {
                reap_detached(child);
                return Ok(());
            }
        }
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file_external(
    app: AppHandle,
    abs_path: String,
    editor: String,
) -> OpResult {
    let abs = PathBuf::from(abs_path.trim());
    if !abs.is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    match editor.as_str() {
        "default" => {
            // Office documents open in the OS-associated app.
            #[cfg(target_os = "macos")]
            {
                let lower = abs.to_string_lossy().to_lowercase();
                let s = lower.as_str();
                let app_name = if s.ends_with(".doc") || s.ends_with(".docx") {
                    Some("Microsoft Word")
                } else if s.ends_with(".xls") || s.ends_with(".xlsx") || s.ends_with(".xlsm") {
                    Some("Microsoft Excel")
                } else {
                    None
                };
                if let Some(name) = app_name {
                    let ok = std::process::Command::new("open")
                        .args(["-a", name])
                        .arg(&abs)
                        .status()
                        .map(|st| st.success())
                        .unwrap_or(false);
                    if ok {
                        return OpResult::ok();
                    }
                }
            }
            match open::that(&abs) {
                Ok(_) => OpResult::ok(),
                Err(e) => OpResult::err(e.to_string()),
            }
        }
        "vscode" => {
            // 1) `code` CLI on PATH.
            if spawn_detached("code", &[&abs.to_string_lossy()]) {
                return OpResult::ok();
            }
            // 2) The CLI inside well-known bundles (macOS).
            #[cfg(target_os = "macos")]
            {
                let home = dirs::home_dir().unwrap_or_default();
                for base in [PathBuf::from("/Applications"), home.join("Applications")] {
                    for name in [
                        "Visual Studio Code.app",
                        "Visual Studio Code - Insiders.app",
                    ] {
                        let cli = base
                            .join(name)
                            .join("Contents/Resources/app/bin/code");
                        if cli.exists()
                            && spawn_detached(&cli.to_string_lossy(), &[&abs.to_string_lossy()])
                        {
                            return OpResult::ok();
                        }
                    }
                }
                for args in [
                    vec!["-b", "com.microsoft.VSCode"],
                    vec!["-b", "com.microsoft.VSCode.Insiders"],
                    vec!["-a", "Visual Studio Code"],
                ] {
                    let mut cmd = std::process::Command::new("open");
                    cmd.args(&args).arg(&abs);
                    if cmd.status().map(|st| st.success()).unwrap_or(false) {
                        return OpResult::ok();
                    }
                }
            }
            // 3) The registered vscode:// handler.
            let url = format!("vscode://file{}", abs.to_string_lossy());
            if open::that_detached(&url).is_ok() {
                return OpResult::ok();
            }
            OpResult::err("Could not open VS Code — is it installed?")
        }
        // Neovim NEVER leaves the app: the renderer opens a terminal tab and
        // runs `nvim +<line> <file>` in its own pty. A stale renderer build can
        // still send this, though, and killing its menu row with "Unknown
        // editor" was the old failure — so reuse a running nvim when one exists,
        // and otherwise open the file the OS way rather than silently dropping
        // the request. There is no external-terminal target any more.
        "nvim" | "inapp" => {
            if open_in_running_nvim(&abs.to_string_lossy()) {
                return OpResult::ok();
            }
            match open::that(&abs) {
                Ok(_) => OpResult::ok(),
                Err(_) => OpResult::err(
                    "Open this file from the in-app terminal tab (Open with → Neovim).",
                ),
            }
        }
        other => OpResult::err(format!("Unknown editor: {other}")),
    }
    .pipe_result(&app)
}

impl OpResult {
    fn pipe_result(self, _app: &AppHandle) -> OpResult {
        self
    }
}

/// Spawn a child and reap it on a background thread.
///
/// These helpers only LAUNCH a program for the user (open a terminal, an app, a
/// file); nothing ever calls `wait` on the result, so every such child stayed in
/// the process table as `<defunct>` for the rest of the session — three were
/// still listed after eight hours of uptime. Waiting on a detached thread keeps
/// the launch non-blocking AND hands the pid back to the OS.
pub(super) fn reap_detached(child: std::process::Child) -> bool {
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    true
}

pub(super) fn spawn_detached(bin: &str, args: &[&str]) -> bool {
    match std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => reap_detached(child),
        Err(_) => false,
    }
}

/// `:edit` the file in the first running nvim instance over its RPC socket.
pub(super) fn open_in_running_nvim(abs: &str) -> bool {
    let expr = format!("execute('edit ' . fnameescape('{}'))", abs.replace('\'', "''"));
    for sock in find_nvim_sockets() {
        let out = std::process::Command::new("nvim")
            .args(["--server", &sock, "--remote-expr", &expr])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                return true;
            }
        }
    }
    false
}

/// Unix sockets listening for nvim RPC, discovered by globbing nvim's socket
/// dirs (pid-liveness filtered).
pub(super) fn find_nvim_sockets() -> Vec<String> {
    let mut found: Vec<String> = vec![];
    if let Ok(env_sock) = std::env::var("NVIM_LISTEN_ADDRESS") {
        let p = env_sock.replacen('~', &dirs::home_dir().unwrap_or_default().to_string_lossy(), 1);
        if p.starts_with('/') && Path::new(&p).exists() {
            found.push(p);
        } else if p.contains(':') {
            found.push(p);
        }
    }
    let mut roots: Vec<PathBuf> = vec![];
    if let Ok(tmp) = std::env::temp_dir().read_dir() {
        for e in tmp.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("nvim") {
                roots.push(e.path());
            }
        }
    }
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        roots.push(PathBuf::from(xdg).join("nvim"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library/Caches/nvim"));
    }
    for root in roots {
        walk_nvim_socket_dir(&root, 0, &mut found);
    }
    found.sort();
    found.dedup();
    found
}

pub(super) fn walk_nvim_socket_dir(dir: &Path, depth: usize, acc: &mut Vec<String>) {
    if depth > 5 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let full = e.path();
        if full.is_dir() {
            walk_nvim_socket_dir(&full, depth + 1, acc);
            continue;
        }
        let leaf = e.file_name().to_string_lossy().into_owned();
        let pid: Option<u32> = if let Some(rest) = leaf.strip_prefix("nvim.").and_then(|r| r.strip_suffix(".0")) {
            rest.parse().ok()
        } else if leaf == "0" {
            full.parent()
                .and_then(|p| p.file_name())
                .and_then(|p| p.to_string_lossy().parse().ok())
        } else {
            None
        };
        let Some(pid) = pid else { continue };
        if pid_alive(pid) && full.exists() {
            acc.push(full.to_string_lossy().into_owned());
        }
    }
}

pub(super) fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    // Windows: `kill(2)` does not exist. Open a minimal handle — the same
    // privilege Task Manager uses — and treat a live process or an access
    // denied (a protected system process, mirroring the Unix EPERM case) as
    // alive. A closed handle is required or the pid leaks a kernel object.
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // GetExitCodeProcess reports a live-but-unexited process with this
        // sentinel instead of a real exit code (not exported by windows-sys).
        const STILL_ACTIVE: u32 = 259;
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        // HANDLE is `isize` in windows-sys: 0 is the invalid handle.
        if h == 0 {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let alive = GetExitCodeProcess(h, &mut code) != 0 && code != STILL_ACTIVE;
        CloseHandle(h);
        alive
    }
    #[cfg(not(any(unix, windows)))]
    {
        true // conservative: report alive rather than drop a live session
    }
}


#[tauri::command]
pub fn open_workspace_folder(dir: String) -> OpResult {
    let d = dir.trim();
    if !Path::new(d).is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    match open::that(d) {
        Ok(_) => OpResult::ok(),
        Err(e) => OpResult::err(e.to_string()),
    }
}

/// Open a terminal AT `dir` — always the caller's own in-app terminal tab.
///
/// Kept as a command because the renderer asks through the same bridge as the
/// other workspace actions, but there is no external terminal anymore: the tab
/// itself is a pty spawned by src-tauri/src/pty.rs, so the request is complete
/// once the renderer knows which directory to open.
#[tauri::command]
pub fn open_workspace_terminal(dir: String) -> OpResult {
    let d = dir.trim();
    if !Path::new(d).is_absolute() {
        return OpResult::err("Not an absolute path.");
    }
    OpResult::ok()
}

// --- Google OAuth (native: loopback callback + token exchange in Rust) ------

