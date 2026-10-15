//! In-app terminal panel backend (mirrors electron/terminal.ts).
//!
//! Owns PTY sessions spawned with portable-pty and streams their output to the
//! renderer via the `terminal:data` / `terminal:exit` events. Sessions outlive
//! the panel being closed (like VSCode) and are killed when the app quits.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct TerminalSessionInfo {
    pub id: String,
    /// Shell binary basename (zsh, bash, …) shown in the terminal tab.
    pub shell: String,
    /// Directory the shell was spawned in.
    pub cwd: String,
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    info: TerminalSessionInfo,
}

pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        TerminalState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Only accept an existing absolute directory; anything else falls back to the
/// home dir (a stale workspace path must never fail the spawn).
fn valid_cwd(dir: &str) -> PathBuf {
    let d = dir.trim();
    if !d.is_empty() {
        let p = PathBuf::from(d);
        if p.is_absolute() && p.is_dir() {
            return p;
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into());
        return (comspec, vec![]);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    });
    (shell, vec!["-l".into()])
}

/// Spawn a login shell and start its reader thread.
#[tauri::command]
pub fn terminal_create(app: AppHandle, cwd: &str) -> Result<TerminalSessionInfo, String> {
    let cwd = valid_cwd(cwd);
    let (file, args) = default_shell();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&file);
    cmd.args(&args);
    cmd.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let info = TerminalSessionInfo {
        id: id.clone(),
        shell: PathBuf::from(&file)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.clone()),
        cwd: cwd.to_string_lossy().into_owned(),
    };

    // Reader thread: pty output -> terminal:data events. The buffer is a
    // growing UTF-8 accumulator: a multi-byte char split across two reads must
    // not be emitted as replacement chars (they corrupted the xterm input
    // echo — typing one letter could paint extra garbage characters).
    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Emit only up to the last complete UTF-8 char boundary.
                    let mut emit_len = pending.len();
                    while emit_len > 0 {
                        match std::str::from_utf8(&pending[..emit_len]) {
                            Ok(_) => break,
                            Err(e) if e.error_len().is_none() => {
                                // Incomplete tail char: try a shorter prefix.
                                emit_len = e.valid_up_to();
                                if emit_len > 0 {
                                    break;
                                }
                                // No complete char yet — wait for more bytes.
                                emit_len = 0;
                                break;
                            }
                            Err(_) => {
                                // Invalid bytes: drop the leading bad byte.
                                pending.drain(..1);
                                emit_len = pending.len();
                            }
                        }
                    }
                    if emit_len > 0 {
                        let data = String::from_utf8_lossy(&pending[..emit_len]).into_owned();
                        pending.drain(..emit_len);
                        let _ = reader_app.emit("terminal:data", (reader_id.clone(), data));
                    }
                }
            }
        }
        let code = reader_app
            .state::<TerminalState>()
            .sessions
            .lock()
            .unwrap()
            .remove(&reader_id)
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code())
            .unwrap_or(0);
        // Removing the session here means an explicit kill (which already
        // removed it) does not double-emit the exit event.
        let _ = reader_app.emit("terminal:exit", (reader_id, code));
    });

    app.state::<TerminalState>()
        .sessions
        .lock()
        .unwrap()
        .insert(
            id.clone(),
            TerminalSession {
                writer,
                child,
                info: info.clone(),
            },
        );
    // Keep the master handle for later resize calls.
    app.state::<TerminalMasters>()
        .0
        .lock()
        .unwrap()
        .insert(id, pair.master);
    Ok(info)
}

#[tauri::command]
pub fn terminal_list(app: AppHandle) -> Vec<TerminalSessionInfo> {
    app.state::<TerminalState>()
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| s.info.clone())
        .collect()
}

#[tauri::command]
pub fn terminal_write(app: AppHandle, id: &str, data: &str) -> bool {
    let sessions = app.state::<TerminalState>();
    let mut sessions = sessions.sessions.lock().unwrap();
    match sessions.get_mut(id) {
        Some(s) => s.writer.write_all(data.as_bytes()).is_ok(),
        None => false,
    }
}

#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: &str, cols: u16, rows: u16) -> bool {
    let state = app.state::<TerminalState>();
    let sessions = state.sessions.lock().unwrap();
    // The master handle is not stored per session (portable-pty master is not
    // Sync-shareable); resize is applied through the stored master registry.
    if !sessions.contains_key(id) {
        return false;
    }
    drop(sessions);
    if let Some(masters) = app.try_state::<TerminalMasters>() {
        let masters = masters.0.lock().unwrap();
        if let Some(master) = masters.get(id) {
            let c = cols.clamp(2, 500);
            let r = rows.clamp(2, 200);
            return master
                .resize(PtySize {
                    rows: r,
                    cols: c,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .is_ok();
        }
    }
    false
}

#[tauri::command]
pub fn terminal_kill(app: AppHandle, id: &str) -> bool {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().unwrap();
    if sessions.remove(id).is_none() {
        return false;
    }
    drop(sessions);
    if let Some(masters) = app.try_state::<TerminalMasters>() {
        if let Some(master) = masters.0.lock().unwrap().remove(id) {
            let _ = master.take_writer(); // drop the writer to signal EOF
        }
    }
    true
}

/// Per-session master handles kept for resize (see terminal_resize).
pub struct TerminalMasters(pub Arc<Mutex<HashMap<String, Box<dyn portable_pty::MasterPty + Send>>>>);

impl TerminalMasters {
    pub fn new() -> Self {
        TerminalMasters(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// Kill every live session — called once on app quit so no orphaned shells
/// are left behind.
pub fn kill_all_terminal_sessions(app: &AppHandle) {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().unwrap();
    for (_, mut s) in sessions.drain() {
        let _ = s.child.kill();
    }
}
