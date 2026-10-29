//! Background terminals the AGENT started (`run_terminal` with background=true).
//!
//! The harness's own Bash tool has this mode: a long-running command (dev
//! server, watcher, build) is spawned detached, its output streams into a log
//! file, and the tool returns immediately so the turn continues. The renderer's
//! right panel lists the live ones ("Terminals · N in background") with a Stop
//! control, so the user can see — and kill — what the agent left running.
//!
//! Deliberately NOT a pty (pty.rs is the user's own interactive tabs): the
//! agent's background command needs no input, only the combined output of a
//! plain pipe, which `tail` can read back from the log.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One agent background terminal as the renderer sees it. `running` decides
/// whether the panel lists it; an exited row is kept briefly so the exit code
/// survives at least one poll, then pruned.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentTerminalInfo {
    pub id: String,
    pub chat_id: String,
    /// The full command line the agent asked to run — the panel shows it
    /// verbatim (it IS the description of what is running).
    pub command: String,
    pub cwd: String,
    /// Epoch millis, so the panel can render "Running for 18m 35s" locally
    /// without the backend ticking.
    pub started_at_ms: u64,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Where the combined output goes. Outside the workspace (the data root),
    /// so `read` may open it and `run_terminal tail` may show it without a
    /// sandbox refusal.
    pub log_path: String,
    /// OS process id — also the process-GROUP id on unix, which is what the
    /// model needs to stop the whole tree itself (`kill -- -PID`).
    pub pid: u32,
}

struct AgentTerminalRow {
    info: AgentTerminalInfo,
    /// Kept so `stop` can kill on every platform (a bare pid is unix-only for
    /// group signals). `None` once the watcher reaped the exit.
    child: Option<Child>,
}

fn registry() -> &'static Mutex<HashMap<String, AgentTerminalRow>> {
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, AgentTerminalRow>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Exited rows kept in the registry. The panel only ever lists running ones;
/// keeping a handful of dead rows lets a poll that races the exit still read
/// the exit code instead of the row vanishing between two polls.
const KEEP_EXITED: usize = 10;

/// Where log files live: `<data root>/terminal-logs/<id>.log`. The data root
/// mirror is what handle-free threads (this one) read; a process started
/// before the mirror was primed falls back to the OS temp dir.
fn log_dir() -> PathBuf {
    crate::state::current_data_root()
        .unwrap_or_else(std::env::temp_dir)
        .join("terminal-logs")
}

/// One row file per terminal, next to its log: `<data root>/terminal-logs/<id>.json`.
///
/// The live map (with the `Child` handles) is per-process — but the user runs
/// several app instances side by side (a release bundle next to a dev build),
/// and a panel in ANY of them must list — and be able to stop — a terminal
/// that any of them spawned. So every row is mirrored to the shared data root:
/// the owning instance's watcher keeps its file's `running`/`exit_code` fresh,
/// while every other instance merges the file in and judges liveness by
/// probing the pid. The guard keeps ids (which arrive from HTTP) from naming
/// paths outside this directory.
fn row_file(id: &str) -> Option<PathBuf> {
    if !id.starts_with("bg-") || id.contains(['/', '\\', '.']) {
        return None;
    }
    Some(log_dir().join(format!("{id}.json")))
}

/// Persist one row (atomic rename so a concurrent `list` never reads half a
/// file); a row that cannot be serialized is a bug upstream, not worth
/// failing a spawn over.
fn write_row_file(info: &AgentTerminalInfo) {
    let Some(path) = row_file(&info.id) else { return };
    let tmp = path.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec(info) {
        if fs::write(&tmp, &bytes).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

/// Read every row file on disk, ignoring malformed or half-written ones.
fn disk_rows() -> Vec<AgentTerminalInfo> {
    let Ok(entries) = fs::read_dir(log_dir()) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(info) = serde_json::from_slice::<AgentTerminalInfo>(&bytes) {
                rows.push(info);
            }
        }
    }
    rows
}

/// Is a foreign row's pid still alive? `kill(pid, 0)` succeeds for a live
/// process we can signal; EPERM also means alive (owned by another user).
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

/// Row files of terminals that exited over a day ago are deleted on the next
/// spawn — panels only ever list running rows, so this just stops the folder
/// from growing forever.
fn prune_disk_rows() {
    let cutoff = crate::state::now_ms() as u64 - 24 * 60 * 60 * 1000;
    for info in disk_rows() {
        if !info.running && info.started_at_ms < cutoff {
            if let Some(path) = row_file(&info.id) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Spawn `command` in `root` detached, append its output to a fresh log, and
/// register it. Returns the info the caller turns into the tool result.
///
/// The child becomes a process-group leader on unix, so stopping it takes the
/// whole tree down (a dev server's own children die with it) — the same rule
/// pty.rs applies to its sessions.
pub fn spawn(root: &str, chat_id: &str, command: &str) -> Result<AgentTerminalInfo, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("background terminal needs a command".into());
    }
    std::fs::create_dir_all(log_dir()).map_err(|e| format!("cannot create log dir: {e}"))?;
    let id = format!("bg-{}", uuid::Uuid::new_v4().simple().to_string()[..8].to_string());
    let log_path = log_dir().join(format!("{id}.log"));
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("cannot open log file: {e}"))?;
    let err = out
        .try_clone()
        .map_err(|e| format!("cannot open log file: {e}"))?;

    // The login PATH is what makes `vite`/`cargo` resolvable from a
    // GUI-launched bundle — the same probe tools.rs::run_terminal uses.
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command).current_dir(root);
    cmd.env("PATH", crate::shell_env::shell_path());
    cmd.stdout(Stdio::from(out));
    cmd.stderr(Stdio::from(err));
    // A command reading stdin must see EOF, not inherit the GUI's fd.
    cmd.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn().map_err(|e| format!("cannot spawn: {e}"))?;
    let pid = child.id();

    let info = AgentTerminalInfo {
        id: id.clone(),
        chat_id: chat_id.to_string(),
        command: command.to_string(),
        cwd: root.to_string(),
        started_at_ms: crate::state::now_ms() as u64,
        running: true,
        exit_code: None,
        log_path: log_path.to_string_lossy().into_owned(),
        pid,
    };
    prune_exited();
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), AgentTerminalRow { info: info.clone(), child: Some(child) });

    // Publish to the SHARED data root so panels of other app instances list —
    // and can stop — this terminal too; the in-memory registry is per-process.
    write_row_file(&info);
    prune_disk_rows();

    // Watcher: reap the exit whenever it comes (the turn that started this
    // terminal has long moved on by then). try_wait under the short lock —
    // never a blocking wait, or a stop would stall behind it.
    let watch_id = id;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let done = {
            let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(row) = reg.get_mut(&watch_id) else { return };
            let Some(child) = row.child.as_mut() else { return };
            match child.try_wait() {
                Ok(Some(status)) => {
                    row.info.running = false;
                    row.info.exit_code = status.code();
                    // The child is reaped; drop the handle.
                    row.child = None;
                    Some(row.info.clone())
                }
                Ok(None) => None,
                Err(_) => {
                    row.info.running = false;
                    row.info.exit_code = Some(-1);
                    row.child = None;
                    Some(row.info.clone())
                }
            }
        };
        // Publish the exit to the shared data root so other instances' panels
        // drop this terminal on their next poll.
        if let Some(done) = done {
            write_row_file(&done);
            return;
        }
    });

    Ok(info)
}

/// Stop one terminal: TERM the whole group (unix), escalate to KILL after a
/// short grace. The watcher thread reaps the exit and flips `running`.
pub fn stop(id: &str) -> bool {
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(row) = reg.get_mut(id) {
            if !row.info.running {
                return false;
            }
            kill_row(row, SIG_TERM);
            drop(reg);
            // Escalation lives on its own thread so a child that ignores TERM
            // (a misbehaving server) cannot make the Stop click hang.
            let escalate = id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                let Some(row) = reg.get_mut(&escalate) else { return };
                if row.info.running {
                    kill_row(row, SIG_KILL);
                }
            });
            return true;
        }
    }
    // Not ours: the terminal was spawned by ANOTHER app instance. Its child
    // handle is over there, but the pid is the process-GROUP leader, so the
    // same signals reach the whole tree from here.
    stop_foreign(id)
}

/// Kill a pid (and, on unix, its whole group) from a process that holds no
/// `Child` handle.
#[cfg(unix)]
fn kill_pid(pid: u32, sig: i32) {
    // SAFETY: `kill(2)` takes plain integers; ESRCH on an already-dead pid is
    // harmless. Same group rule as `kill_row`.
    unsafe {
        libc::kill(pid as i32, sig);
        libc::kill(-(pid as i32), sig);
    }
}

/// Foreign stop is a unix capability (group signals by pid); on Windows an
/// instance can only manage its own children.
#[cfg(not(unix))]
fn stop_foreign(_id: &str) -> bool {
    false
}

#[cfg(unix)]
fn stop_foreign(id: &str) -> bool {
    let Some(info) = disk_rows().into_iter().find(|i| i.id == id) else {
        return false;
    };
    if !info.running || !pid_alive(info.pid) {
        return false;
    }
    kill_pid(info.pid, SIG_TERM);
    let escalate = info.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        if pid_alive(escalate.pid) {
            kill_pid(escalate.pid, SIG_KILL);
        }
        // The owner's watcher publishes the real exit; heal the file ourselves
        // only once the process is gone (a still-alive pid is left alone so
        // the owner can reap it and write the true exit code).
        for _ in 0..15 {
            if !pid_alive(escalate.pid) {
                let mut done = escalate.clone();
                done.running = false;
                write_row_file(&done);
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    true
}

// libc's signal numbers only exist on Unix; the Windows build passes a dummy
// (kill_row then ignores the signal and kills the direct child).
#[cfg(unix)]
const SIG_TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIG_KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const SIG_TERM: i32 = 0;
#[cfg(not(unix))]
const SIG_KILL: i32 = 0;

/// Signal a row's process (group). Unix uses the group so the command's own
/// children die too; elsewhere only the direct child can be reached.
fn kill_row(row: &mut AgentTerminalRow, sig: i32) {
    let pid = row.info.pid as i32;
    #[cfg(unix)]
    {
        // SAFETY: `kill(2)` takes plain integers. The child is a group leader
        // (spawned with process_group(0)), so the negative pid reaches the
        // whole tree. ESRCH on an already-dead child is harmless.
        unsafe {
            libc::kill(pid, sig);
            libc::kill(-pid, sig);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = sig;
        if let Some(child) = row.child.as_mut() {
            let _ = child.kill();
        }
    }
}

/// Every live terminal, newest first; an empty `chat_id` lists them all (the
/// renderer always passes the active chat, scheduled headless runs pass none).
///
/// In-memory rows are authoritative (their `Child` is here); rows mirrored by
/// OTHER app instances are merged in from the shared data root, their
/// liveness judged by probing the pid — a stale file whose process is gone is
/// healed to `running: false` so panels drop it.
pub fn list(chat_id: &str) -> Vec<AgentTerminalInfo> {
    let mut rows: Vec<AgentTerminalInfo>;
    let foreign: Vec<AgentTerminalInfo>;
    {
        let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        rows = reg
            .values()
            .map(|r| r.info.clone())
            .filter(|i| chat_id.is_empty() || i.chat_id == chat_id)
            .collect();
        let local: HashSet<&str> = reg.keys().map(String::as_str).collect();
        foreign = disk_rows()
            .into_iter()
            .filter(|i| !local.contains(i.id.as_str()))
            .filter(|i| chat_id.is_empty() || i.chat_id == chat_id)
            .collect();
    }
    for mut info in foreign {
        if info.running && !pid_alive(info.pid) {
            info.running = false;
            info.exit_code = info.exit_code.or(Some(-1));
            write_row_file(&info);
        }
        rows.push(info);
    }
    rows.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then(b.started_at_ms.cmp(&a.started_at_ms))
    });
    rows
}

/// Drop the oldest exited rows past the keep limit (called on every spawn so
/// the registry cannot grow for the life of the app).
fn prune_exited() {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut exited: Vec<String> = reg
        .iter()
        .filter(|(_, r)| !r.info.running)
        .map(|(k, _)| k.clone())
        .collect();
    if exited.len() <= KEEP_EXITED {
        return;
    }
    exited.sort_by_key(|k| {
        reg.get(k)
            .map(|r| r.info.started_at_ms)
            .unwrap_or_default()
    });
    let drop_count = exited.len() - KEEP_EXITED;
    for k in exited.into_iter().take(drop_count) {
        reg.remove(&k);
    }
}

/// Kill every live terminal — called once on app quit so no dev server is
/// left behind (they are children of THIS process and would otherwise be
/// reparented to launchd). Hard kill: nothing here can be graceful at quit.
pub fn kill_all() {
    let rows: Vec<AgentTerminalRow> = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, r)| r)
        .collect();
    for mut row in rows {
        if row.info.running {
            kill_row(&mut row, SIG_KILL);
        }
    }
}

/// The text the MODEL sees as the tool result — everything it needs to check
/// progress and stop the command without another tool.
pub fn model_text(info: &AgentTerminalInfo) -> String {
    format!(
        "Started in background: `{}` (terminal {}, PID {})\n\
         - Output is appended to: {} — check progress with run_terminal: `tail -c 4000 '{path}'`.\n\
         - It keeps running after this turn; the user sees it in the Terminals panel and can stop it there.\n\
         - To stop it yourself, run: `kill -TERM -- -{pid}` (negative PID = its whole process group).",
        info.command,
        info.id,
        info.pid,
        info.log_path,
        path = info.log_path,
        pid = info.pid,
    )
}

/// Read the tail of a terminal's log — used by tests; the model reads the file
/// through its own tools.
#[cfg(test)]
fn read_log(id: &str, max_bytes: usize) -> String {
    use std::fs::File;
    use std::io::Read;
    let path = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .map(|r| PathBuf::from(r.info.log_path.clone()));
    let Some(path) = path else { return String::new() };
    let mut buf = Vec::new();
    if File::open(path)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .is_err()
    {
        return String::new();
    }
    let start = buf.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&buf[start..]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn wait_until(deadline_ms: u64, pred: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed().as_millis() < deadline_ms as u128 {
            if pred() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        pred()
    }

    #[test]
    fn a_background_command_runs_detached_and_writes_its_log() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let info = spawn(&root, "chat-test", "echo bg-hello").unwrap();
        assert!(info.running);
        assert_eq!(info.chat_id, "chat-test");
        assert!(info.log_path.contains("terminal-logs"));
        // The command finishes on its own; the watcher must notice and record
        // the exit code without any call from outside.
        let done = wait_until(5000, || {
            list("chat-test")
                .iter()
                .any(|i| i.id == info.id && !i.running && i.exit_code == Some(0))
        });
        assert!(done, "terminal never reported exit: {:?}", list("chat-test"));
        assert!(read_log(&info.id, 1024).contains("bg-hello"));
    }

    #[test]
    fn a_failing_command_reports_a_nonzero_exit() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let info = spawn(&root, "chat-test", "exit 3").unwrap();
        let done = wait_until(5000, || {
            list("chat-test")
                .iter()
                .any(|i| i.id == info.id && i.exit_code == Some(3))
        });
        assert!(done);
    }

    #[test]
    fn stop_takes_a_running_command_down() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let info = spawn(&root, "chat-test", "sleep 30").unwrap();
        assert!(list("chat-test").iter().any(|i| i.id == info.id && i.running));
        assert!(stop(&info.id));
        let gone = wait_until(5000, || {
            list("chat-test")
                .iter()
                .any(|i| i.id == info.id && !i.running)
        });
        assert!(gone, "stop left the terminal running");
        // Stopping twice must not re-signal a dead row (and must report it).
        assert!(!stop(&info.id));
    }

    #[test]
    fn stop_of_an_unknown_id_is_false() {
        assert!(!stop("bg-does-not-exist"));
    }

    #[test]
    fn an_empty_command_is_refused() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(spawn(&root, "chat-test", "   ").is_err());
    }

    #[test]
    fn list_filters_by_chat_and_puts_running_first() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let sleeper = spawn(&root, "chat-a", "sleep 30").unwrap();
        let finished = spawn(&root, "chat-a", "true").unwrap();
        let other = spawn(&root, "chat-b", "sleep 30").unwrap();
        let _ = wait_until(5000, || {
            list("chat-a")
                .iter()
                .any(|i| i.id == finished.id && !i.running)
        });
        let rows = list("chat-a");
        assert!(rows.iter().all(|i| i.chat_id == "chat-a"));
        assert_eq!(rows[0].id, sleeper.id, "running row must sort first");
        assert!(rows.iter().any(|i| i.id == finished.id));
        // The other chat's row is invisible through this filter…
        assert!(!rows.iter().any(|i| i.id == other.id));
        // …but the unfiltered list (empty chat_id) still sees it.
        assert!(list("").iter().any(|i| i.id == other.id));
        stop(&sleeper.id);
        stop(&other.id);
    }

    #[test]
    fn model_text_names_the_log_and_the_group_kill() {
        let info = AgentTerminalInfo {
            id: "bg-abcd1234".into(),
            chat_id: "c".into(),
            command: "vite".into(),
            cwd: "/w".into(),
            started_at_ms: 0,
            running: true,
            exit_code: None,
            log_path: "/logs/bg-abcd1234.log".into(),
            pid: 4242,
        };
        let text = model_text(&info);
        assert!(text.contains("bg-abcd1234"));
        assert!(text.contains("/logs/bg-abcd1234.log"));
        assert!(text.contains("kill -TERM -- -4242"));
        assert!(text.contains("tail -c 4000"));
    }

    #[test]
    fn a_spawned_row_is_published_to_disk() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let info = spawn(&root, "chat-disk", "true").unwrap();
        let file = std::path::PathBuf::from(&root)
            .join("terminal-logs")
            .join(format!("{}.json", info.id));
        let bytes = std::fs::read(&file).expect("row file must exist next to the log");
        let on_disk: AgentTerminalInfo = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(on_disk.id, info.id);
        assert!(on_disk.running);
        // Prune needs a day to reach a fresh file — clean this test's up now.
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn list_merges_foreign_rows_and_heals_dead_pids() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        // A row written by "another instance": running, but nobody is home.
        let dead = AgentTerminalInfo {
            id: "bg-deadtest".into(),
            chat_id: "chat-foreign".into(),
            command: "echo hi".into(),
            cwd: root.clone(),
            started_at_ms: 1,
            running: true,
            exit_code: None,
            log_path: "/dev/null".into(),
            pid: u32::MAX - 1, // reserved pid: never alive, never ours
        };
        write_row_file(&dead);
        let row = list("chat-foreign")
            .into_iter()
            .find(|i| i.id == "bg-deadtest")
            .expect("foreign row must merge in");
        assert!(!row.running, "a dead pid must be healed to not-running");
        assert_eq!(row.exit_code, Some(-1));
        // The healed file is written back so the next list is stable…
        let healed: AgentTerminalInfo = serde_json::from_slice(
            &std::fs::read(
                std::path::PathBuf::from(&root).join("terminal-logs/bg-deadtest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(!healed.running);
        // …and stop on it is a plain false (nothing running to signal).
        assert!(!stop("bg-deadtest"));
        let _ = std::fs::remove_file(
            std::path::PathBuf::from(&root).join("terminal-logs/bg-deadtest.json"),
        );
    }

    #[test]
    fn a_row_id_that_escapes_the_log_dir_is_never_written() {
        assert!(row_file("../escape").is_none());
        assert!(row_file("bg-ok").is_some());
        assert!(row_file("not-a-terminal").is_none());
    }

    /// The per-chat filter must hold for rows MERGED FROM DISK too: a panel
    /// polling chat-viewer (another instance, another chat) never sees a
    /// terminal started in chat-own, on disk or in memory.
    #[test]
    fn a_foreign_row_from_another_chat_stays_filtered_out() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let foreign = AgentTerminalInfo {
            id: "bg-othchat".into(),
            chat_id: "chat-own".into(),
            command: "echo hi".into(),
            cwd: root.clone(),
            started_at_ms: 1,
            running: true,
            exit_code: None,
            log_path: "/dev/null".into(),
            pid: u32::MAX - 2, // reserved pid: never ours; liveness is irrelevant here
        };
        write_row_file(&foreign);
        assert!(
            !list("chat-viewer").iter().any(|i| i.id == "bg-othchat"),
            "another chat's disk row leaked through the filter"
        );
        // its own chat still sees it across instances
        assert!(list("chat-own").iter().any(|i| i.id == "bg-othchat"));
        let _ = std::fs::remove_file(
            std::path::PathBuf::from(&root).join("terminal-logs/bg-othchat.json"),
        );
    }
}
