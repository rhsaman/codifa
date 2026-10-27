//! In-app terminal panel backend (mirrors electron/terminal.ts).
//!
//! Owns PTY sessions spawned with portable-pty and streams their output to the
//! renderer via the `terminal:data` / `terminal:exit` events. Sessions outlive
//! the panel being closed (like VSCode) and are killed when the app quits.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct TerminalSessionInfo {
    pub id: String,
    /// Shell (or program) binary basename — zsh, bash, nvim … — shown in the
    /// terminal tab.
    pub shell: String,
    /// Full command line shown in the tab TOOLTIP. Differs from `shell` when a
    /// pty runs a program instead of a shell (`nvim +42 /w/a.ts`).
    pub program: String,
    /// Directory the shell was spawned in.
    pub cwd: String,
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    info: TerminalSessionInfo,
}

/// Terminate a pty session — and everything it started — then REAP it.
///
/// `Child::kill()` alone is NOT enough once a session can run a program instead
/// of a shell. It sends SIGKILL to the direct child only, and Neovim starts its
/// language servers (mason's `typescript-language-server`, which forks
/// `tsserver`) as separate jobs: a SIGKILL gives nvim no chance to shut them
/// down, so they survive as orphans. Measured on this machine, the editor's tree
/// held ~600 MB (44 MB nvim + ~560 MB of language servers, per OPEN file), so
/// every closed tab could strand that much memory for the life of the app.
///
/// So: ask the child to QUIT first (SIGTERM — nvim then kills its own jobs), give
/// it a short grace period, and only then force the whole process group down,
/// exactly like `lsp.rs` does for language servers. The final `wait` reaps the
/// pid: without it the child stays `<defunct>` under the app (measured: two of
/// them after a couple of closed terminal tabs).
fn terminate_session(session: &mut TerminalSession) {
    #[cfg(unix)]
    {
        if let Some(pid) = session.child.process_id().map(|p| p as i32) {
            // SAFETY: `kill(2)` takes plain integers. A negative pid signals the
            // whole process GROUP — the pty child is a session leader (its pgid
            // equals its pid), so a group signal also reaches anything it left in
            // that group. Failures (ESRCH on an already-dead child) are harmless.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
                libc::kill(-pid, libc::SIGTERM);
            }
            // Grace period, polled rather than slept in full so a fast-exiting
            // shell does not make every close cost the whole budget.
            for _ in 0..10 {
                if matches!(session.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    // Also the path for Windows (no group signal there) and for a child whose
    // pid could not be read: signal directly, then reap.
    let _ = session.child.kill();
    let _ = session.child.wait();
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

/// The shell a terminal session runs when no explicit program was requested.
///
/// `$SHELL` is the OS login shell; Settings → Terminal can override it with a
/// plain shell name (zsh/fish/nu/…) that is resolved on the LOGIN path, so a
/// Homebrew shell the GUI never inherited still starts. An override that cannot
/// be resolved falls back to `$SHELL` instead of failing the tab: a terminal
/// that refuses to open is worse than one in the wrong shell.
fn default_shell(app: &AppHandle, override_shell: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into());
        return (comspec, vec![]);
    }
    let login = || {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/bash".into()
            }
        })
    };
    // The tab's own shell wins (Settings → Terminal), then the persisted
    // preference, then the app's documented default (zsh); only an unavailable
    // shell degrades to `$SHELL`.
    let picked = override_shell.trim();
    let picked = if picked.is_empty() {
        crate::prefs::string_pref(app, crate::prefs::TERMINAL_SHELL_KEY)
    } else {
        picked.to_string()
    };
    (
        pick_shell(&picked, login, crate::prefs::DEFAULT_TERMINAL_SHELL),
        vec!["-l".into()],
    )
}

/// The shell to run for `picked` (Settings → Terminal).
///
/// `fallback` is used when the preference is empty/unset; `login` is the OS
/// shell, used when the requested shell cannot be resolved on PATH. A terminal
/// that refuses to open is worse than one in the wrong shell, so an unavailable
/// override degrades instead of failing the tab.
fn pick_shell(picked: &str, login: impl FnOnce() -> String, fallback: &str) -> String {
    let name = picked.trim();
    if name.is_empty() {
        return resolve_program(fallback).unwrap_or_else(login);
    }
    resolve_program(name).unwrap_or_else(login)
}

/// The login shell that carries a requested PROGRAM (`-lc`).
///
/// Deliberately NOT the user's chosen interactive shell: this one only has to
/// exist to `exec` the program with a complete environment, so zsh (present on
/// every supported macOS) is preferred over `$SHELL`, which a GUI-launched
/// bundle may not even set.
fn login_shell() -> String {
    resolve_program("zsh")
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// argv for `login_shell()` that runs `name` with `args` inside a fresh pty.
///
/// The program runs through the login shell, never directly: a Finder-launched
/// bundle has no Homebrew on PATH, so a bare `nvim` resolves fine in
/// `resolve_program` yet cannot find its own runtime or the tools its config
/// shells out to.
///
/// `sh -lc <script> <$0> <args…>` makes the first word after the script `$0`
/// and the rest `$@`, so the script stays a FIXED `exec "$0" "$@"` and every
/// user-supplied path arrives as a real argument — never interpolated into the
/// script text, never re-parsed by the shell. (Writing the path into the script
/// string instead mangled filenames containing quotes, and passing `--` before
/// the file was worse: nvim reads `--` as the end of ITS options, so the file
/// became a second filename and the requested one opened as an empty buffer.)
fn program_argv(name: &str, args: &[String]) -> Result<Vec<String>, String> {
    let exe = resolve_program(name).ok_or_else(|| format!("{name}: program not found"))?;
    let mut argv: Vec<String> = vec!["-lc".into(), "exec \"$0\" \"$@\"".into(), exe];
    argv.extend(args.iter().cloned());
    Ok(argv)
}

/// Does PATH contain `name` as a path of its own (`a/b`, or `a\b` on Windows)?
/// Without this, `format!("{dir}/{name}")` would also match a sibling that
/// merely STARTS with the name (`/usr/bin/nvim-wrapper`).
fn has_separator(p: &str) -> bool {
    p.contains('/') || (cfg!(windows) && p.contains('\\'))
}

/// The LOGIN-shell PATH, probed once per process: spawning a shell for every
/// terminal tab would add a visible delay to opening one.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(crate::shell_env::shell_path)
}

/// Resolve a requested PROGRAM (a new-tab target such as nvim) to a runnable
/// path. A bare name is looked up on the LOGIN-shell PATH — the process PATH of
/// a Finder-launched bundle has no Homebrew, so `CommandBuilder::new("nvim")`
/// would fail to spawn. A name carrying a separator is taken as a path, and an
/// absolute one must exist. `None` means the program cannot be run.
fn resolve_program(name: &str) -> Option<String> {
    if name.starts_with('/') {
        return PathBuf::from(name).is_file().then(|| name.to_string());
    }
    if has_separator(name) {
        return Some(name.to_string());
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    login_path()
        .split(sep)
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|cand| cand.is_file())
        .map(|cand| cand.to_string_lossy().into_owned())
}

/// Spawn a login shell — or, when `program` is given, that program — in a fresh
/// pty and start its reader thread.
///
/// `program`/`args` are what lets a NON-shell target run inside the panel:
/// "Edit in nvim" asks for `nvim` + `["+42", "/w/a.ts"]`, so the file opens in
/// the user's own Neovim inside the side pane. A requested program that cannot
/// be found is an error the caller can show, never a silent fallback shell.
///
/// `shell` overrides the shell of a PLAIN tab (Settings → Terminal). It is a
/// separate parameter on purpose: passing `zsh` as `program` would run the
/// binary with no login flags and leave a shell with no prompt — an empty pane.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    cwd: &str,
    program: Option<String>,
    args: Option<Vec<String>>,
    shell: Option<String>,
    // Session id requested by the renderer. The pty emits from the reader
    // thread the instant it spawns — before `terminal_create` can ANSWER — so
    // the renderer cannot route that early output unless the id is known to it
    // BEFORE the spawn. A tab derives a stable id (`<tabId>#pty`), so every
    // early `terminal:data` event already carries the name the tab's screen
    // listens for. None = the old behaviour (a fresh uuid) — the bottom panel
    // and any other caller that does not pass an id keep working unchanged.
    requested_id: Option<String>,
) -> Result<TerminalSessionInfo, String> {
    let cwd = valid_cwd(cwd);
    let (file, argv) = match program.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(name) => (login_shell(), program_argv(name, &args.unwrap_or_default())?),
        None => default_shell(&app, shell.as_deref().unwrap_or("")),
    };
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
    cmd.args(&argv);
    cmd.cwd(&cwd);
    // The shell must be told what emulator sits on the other end. A GUI-launched
    // app inherits (at best) a near-empty environment — a Finder-launched macOS
    // bundle has no TERM at all — and portable-pty passes the parent env
    // straight through. Without TERM, zsh's terminfo has no cursor-movement
    // capabilities, so zle's incremental redraw paints each keystroke OVER the
    // previous render instead of overwriting it: typing "ls" showed as "llls"
    // until a space forced a full-line redraw. TERM also decides how colours
    // are encoded: `fg=8` (the zsh-autosuggestions highlight slot) degrades to
    // an incomplete SGR that xterm ignores, so the inline suggestion inherited
    // whatever colour preceded it and rendered green.
    //
    // Forced rather than defaulted: the emulator here is always xterm.js, no
    // matter which terminal the GUI happened to be launched from, so an
    // inherited value ("dumb", or another terminal's id) would be wrong.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Same rule for the terminal's IDENTITY: the app inherits `TERM_PROGRAM`
    // from whatever launched it (`iTerm.app` when started from iTerm2), and a
    // program that trusts it behaves like that emulator. Neovim does exactly
    // that: for `iTerm.app` it paints truecolor with the colon form
    // `ESC[38:2:R:G:B m` (no colour-space slot), which xterm.js reads as
    // `38:2:<cs>:R:G:B` — every colour came out as (G, B, 0), so the whole
    // editor rendered olive/yellow. The emulator here is xterm.js, so say so.
    cmd.env("TERM_PROGRAM", "codifa");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    // iTerm2 also leaves its fingerprints in other variables (and `LC_TERMINAL`
    // is forwarded over ssh/sudo); programs that sniff any of them take the same
    // iTerm-only colon-form truecolor path. Drop every one.
    for var in [
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "TERM_SESSION_ID",
    ] {
        cmd.env_remove(var);
    }
    // Same reason as TERM, for the other direction: a program spawned directly
    // ("Edit in nvim") inherits the minimal GUI PATH and could not find the
    // tools its own config shells out to (git, rg, node, …). The login PATH is
    // the one the user's terminal has.
    cmd.env("PATH", login_path());
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = requested_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let info = TerminalSessionInfo {
        id: id.clone(),
        shell: PathBuf::from(&file)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.clone()),
        program: std::iter::once(file.as_str())
            .chain(argv.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        cwd: cwd.to_string_lossy().into_owned(),
    };

    // Register the session BEFORE the reader thread exists. The reader removes
    // the session when the child exits, so spawning it first let a fast-dying
    // child remove nothing and then have this insert add an ALREADY-DEAD
    // session — a phantom tab in `terminal_list` reporting exit code 0.
    app.state::<TerminalState>()
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), pair.master);

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
                    // A colon SGR can straddle two reads: hold back a trailing,
                    // still-unfinished CSI so the rewrite below always sees the
                    // WHOLE sequence.
                    let safe = emit_safe_len(&pending[..emit_len]);
                    if safe > 0 {
                        let cleaned = sanitize_colon_sgr(&pending[..safe]);
                        pending.drain(..safe);
                        let data = String::from_utf8_lossy(&cleaned).into_owned();
                        let _ = reader_app.emit("terminal:data", (reader_id.clone(), data));
                    }
                }
            }
        }
        let code = reader_app
            .state::<TerminalState>()
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&reader_id)
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code())
            .unwrap_or(0);
        // Drop the master handle too. A session that ends on its OWN (the user
        // typed `exit`, nvim quit) never goes through `terminal_kill`, so the
        // registry pinned its pty master — an open fd plus the pty buffers —
        // for the rest of the app's life. One leaked handle per closed tab is
        // exactly the slow climb a long session shows.
        if let Some(masters) = reader_app.try_state::<TerminalMasters>() {
            masters
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&reader_id);
        }
        // Removing the session here means an explicit kill (which already
        // removed it) does not double-emit the exit event.
        let _ = reader_app.emit("terminal:exit", (reader_id, code));
    });

    Ok(info)
}

/// Longest prefix of `data` that may be emitted right now: a trailing,
/// unfinished CSI (`ESC[` followed by only parameter bytes, no final byte yet)
/// is held back so the colon rewrite below always sees the WHOLE sequence. Only
/// a CSI is ever held — string sequences (OSC/DCS) may want many more bytes and
/// stream through safely; xterm.js re-assembles those itself.
fn emit_safe_len(data: &[u8]) -> usize {
    for i in (0..data.len()).rev() {
        if data[i] == 0x1b {
            let rest = &data[i..];
            if rest.len() < 2 {
                return i; // a bare trailing ESC — could still become a CSI
            }
            if rest[1] == b'[' {
                let ends = rest[2..]
                    .iter()
                    .position(|&b| !(0x20..=0x3f).contains(&b))
                    .map_or(rest.len(), |p| p + 2);
                if ends == rest.len() {
                    return i; // parameters so far, no final byte yet
                }
            }
            return data.len();
        }
    }
    data.len()
}

/// Rewrite iTerm2-style colon SGR truecolour into the semicolon form xterm.js
/// parses: `ESC[38:2:R:G:B m` → `ESC[38;2;R;G;B m` (same for 48). xterm.js
/// reads the colon form as the colourspace-first encoding (38:2:<cs>:R:G:B),
/// shifting every channel — colour (25,23,36) painted as (23,36,0): the olive
/// background and yellow text of the nvim screen. `TERM_PROGRAM` is forced at
/// spawn so nvim never picks that encoding, but the value can leak back in
/// (ssh, tmux, an rc file, a binary launched from iTerm), so this reader-level
/// rewrite is the real guard: it is independent of the environment.
fn sanitize_colon_sgr(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'[' {
            let start = i + 2;
            let mut end = start;
            while end < data.len() && (0x20..=0x3f).contains(&data[end]) {
                end += 1;
            }
            if end < data.len() && data[end] == b'm' && start < end {
                out.extend_from_slice(b"\x1b[");
                let mut first = true;
                for part in data[start..end].split(|&b| b == b';') {
                    if !first {
                        out.push(b';');
                    }
                    first = false;
                    // 38:2:R:G:B (5 colon subparams, direct colour) is the one
                    // form xterm.js misreads; the colourspace-carrying
                    // 6-subparam form and everything else pass through.
                    let subs: Vec<&[u8]> = part.split(|&b| b == b':').collect();
                    let direct = subs.len() == 5
                        && (subs[0] == b"38" || subs[0] == b"48")
                        && subs[1] == b"2"
                        && subs[2..].iter().all(|p| {
                            !p.is_empty() && p.len() <= 3 && p.iter().all(|b| b.is_ascii_digit())
                        });
                    if direct {
                        for &b in part {
                            out.push(if b == b':' { b';' } else { b });
                        }
                    } else {
                        out.extend_from_slice(part);
                    }
                }
                out.push(b'm');
                i = end + 1;
                continue;
            }
        }
        out.push(data[i]);
        i += 1;
    }
    out
}

#[tauri::command]
pub fn terminal_list(app: AppHandle) -> Vec<TerminalSessionInfo> {
    app.state::<TerminalState>()
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|s| s.info.clone())
        .collect()
}

#[tauri::command]
pub fn terminal_write(app: AppHandle, id: &str, data: &str) -> bool {
    let sessions = app.state::<TerminalState>();
    let mut sessions = sessions.sessions.lock().unwrap_or_else(|e| e.into_inner());
    match sessions.get_mut(id) {
        Some(s) => s.writer.write_all(data.as_bytes()).is_ok(),
        None => false,
    }
}

#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: &str, cols: u16, rows: u16) -> bool {
    let state = app.state::<TerminalState>();
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    // The master handle is not stored per session (portable-pty master is not
    // Sync-shareable); resize is applied through the stored master registry.
    if !sessions.contains_key(id) {
        return false;
    }
    drop(sessions);
    if let Some(masters) = app.try_state::<TerminalMasters>() {
        let masters = masters.0.lock().unwrap_or_else(|e| e.into_inner());
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
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut session) = sessions.remove(id) else {
        return false;
    };
    // Kill (and reap) explicitly: removing the entry used to drop the `Child`
    // handle while the shell kept running, and the reader thread could no longer
    // reap it (its `remove` returned `None`), leaving a defunct process until
    // the app exited. terminate_session also takes the program's OWN children
    // down — a run target like nvim holds most of its memory in its LSP jobs.
    //
    // The lock is released FIRST: terminating waits for a grace period (up to a
    // second), and holding the sessions lock that long would stall every other
    // terminal command behind a closing tab.
    drop(sessions);
    terminate_session(&mut session);
    drop(session);
    if let Some(masters) = app.try_state::<TerminalMasters>() {
        if let Some(master) = masters.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
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
    // Take the sessions OUT under the lock, then terminate outside it: each
    // termination waits for its own grace period, serially, and nothing may
    // need the map meanwhile (the app is quitting).
    let drained: Vec<TerminalSession> = {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.drain().map(|(_, s)| s).collect()
    };
    for mut s in drained {
        // Same path as closing one tab, so quitting cannot orphan a run
        // target's language servers (hundreds of MB each) either.
        terminate_session(&mut s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colon_truecolor_sgr_is_rewritten_to_semicolons() {
        // The exact bytes captured from nvim under TERM_PROGRAM=iTerm.app.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38:2:224:222:244m"),
            b"\x1b[38;2;224;222;244m".to_vec()
        );
        assert_eq!(
            sanitize_colon_sgr(b"x\x1b[48:2:25:23:36m y"),
            b"x\x1b[48;2;25;23;36m y".to_vec()
        );
        // A leading plain parameter must survive the flattening.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[0;38:2:110:106:134m"),
            b"\x1b[0;38;2;110;106;134m".to_vec()
        );
    }

    #[test]
    fn other_sequences_pass_through_untouched() {
        // The colourspace-carrying form xterm.js parses correctly.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38:2:0:224:222:244m"),
            b"\x1b[38:2:0:224:222:244m".to_vec()
        );
        // Underline colon SGR / a shorter colon parameter / a wrong colour id.
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[58:2:1:2:3m"),
            b"\x1b[58:2:1:2:3m".to_vec()
        );
        assert_eq!(
            sanitize_colon_sgr(b"\x1b[38;2;1:2m z"),
            b"\x1b[38;2;1:2m z".to_vec()
        );
        // Plain payload and non-SGR CSI.
        assert_eq!(
            sanitize_colon_sgr(b"hi\x1b[2K\x1b[1;5Hthere"),
            b"hi\x1b[2K\x1b[1;5Hthere".to_vec()
        );
    }

    #[test]
    fn an_unfinished_csi_at_the_tail_is_held_back() {
        assert_eq!(emit_safe_len(b"\x1b[38:2:110"), 0);
        assert_eq!(emit_safe_len(b"\x1b[38"), 0);
        assert_eq!(emit_safe_len(b"prep \x1b["), 5);
        assert_eq!(emit_safe_len(b"pre\x1b[38:2:"), 3);
        // A COMPLETE sequence — even colon-formed — is never held.
        let done = b"\x1b[38:2:110;1m rest";
        assert_eq!(emit_safe_len(done), done.len());
        // Text around escapes survives: only the ESC tail is held.
        assert_eq!(emit_safe_len(b"ab\x1b"), 2);
        // String sequences (OSC) stream through even when unterminated.
        let osc = b"a\x1b]0;title";
        assert_eq!(emit_safe_len(osc), osc.len());
        assert_eq!(emit_safe_len(b"\x1b[m"), 3);
    }

    #[test]
    fn only_a_path_separator_makes_a_program_a_path() {
        assert!(!has_separator("nvim"));
        assert!(has_separator("bin/nvim"));
        assert!(has_separator("/opt/homebrew/bin/nvim"));
    }

    #[test]
    fn an_absolute_program_must_exist() {
        assert!(resolve_program("/no/such/dir/nvim").is_none());
        #[cfg(unix)]
        assert_eq!(resolve_program("/bin/sh").as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn an_uninstalled_bare_name_stays_unresolved() {
        // Nothing is installed under that name, so the spawn must fail loudly
        // instead of quietly handing the user a shell tab.
        assert!(resolve_program("codifa-no-such-program").is_none());
    }

    #[test]
    fn a_program_runs_through_the_login_shell_with_its_own_argv() {
        // `-lc <script> <$0> <args…>` — the program's path is `$0`, the rest is
        // `$@`, so a path is never quoted into the script text.
        let argv = program_argv("/bin/sh", &["+42".into(), "/w/a.ts".into()]).unwrap();
        assert_eq!(argv[0], "-lc");
        assert_eq!(argv[1], "exec \"$0\" \"$@\"");
        assert_eq!(argv[2], "/bin/sh");
        assert_eq!(&argv[3..], &["+42", "/w/a.ts"]);
    }

    #[test]
    fn a_program_argv_never_injects_a_double_dash_separator() {
        // `nvim -- <file>` makes nvim read the file as a second filename: the
        // requested one opened as an EMPTY buffer. The separator must not exist.
        let argv = program_argv("/bin/sh", &["/w/a.ts".into()]).unwrap();
        assert!(!argv.iter().any(|a| a == "--"));
    }

    #[test]
    fn an_unresolvable_program_is_an_error_never_a_shell() {
        assert!(program_argv("codifa-no-such-program", &[]).is_err());
    }

    #[test]
    fn the_picked_shell_overrides_the_login_one() {
        // An absolute, existing shell wins over $SHELL.
        assert_eq!(
            pick_shell("/bin/sh", || "/bin/zsh".into(), "zsh"),
            "/bin/sh"
        );
    }

    #[test]
    fn an_unset_shell_preference_uses_the_documented_default() {
        // No setting must not mean "whatever sh --login gives": the app's default
        // is zsh (DEFAULT_TERMINAL_SHELL), resolved on the LOGIN path — so a
        // Homebrew zsh wins over /bin/zsh, which is exactly the point.
        let homebrew = pick_shell("", || "/bin/zsh".into(), "zsh");
        assert!(
            homebrew.ends_with("/zsh"),
            "the default must resolve to an actual zsh, got {homebrew}"
        );
        assert_eq!(pick_shell("   ", || "/bin/sh".into(), "zsh").ends_with("/zsh"), true);
        // A default the machine does not have still degrades to the OS shell.
        assert_eq!(
            pick_shell("", || "/bin/sh".into(), "codifa-no-such-shell"),
            "/bin/sh"
        );
    }

    #[test]
    fn an_unresolvable_shell_falls_back_instead_of_failing() {
        // A stale setting (a shell the user uninstalled) must still open a tab.
        assert_eq!(
            pick_shell("codifa-no-such-shell", || "/bin/zsh".into(), "zsh"),
            "/bin/zsh"
        );
    }
}
