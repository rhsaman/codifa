use super::*;

/// The turn's out-of-workspace permit, built ONCE from the renderer's grants
/// PLUS the folders the user approved with "Always allow" in ANY earlier turn.
///
/// `resolve_safe` has always honoured a `permit` (workspace, tmp and `~/.codifa`
/// pass without one); the loop simply never built it, so the user's popup answer
/// could not reach the sandbox.
pub(super) fn outside_permit(req: &AgentRequest) -> Option<Value> {
    // "Always allow" must outlive the session: the renderer's own grant list is
    // in-memory state, so a folder approved for keeps was asked for AGAIN after
    // every relaunch and every workspace switch — the ask the button exists to
    // end. The persisted copy (data root, `trusted-folders.json`) rides along.
    let mut folders = req.allow_outside_folders.clone();
    folders.extend(trusted_folders(&turn_data_root(req)));
    if !req.allow_outside && folders.is_empty() {
        return None;
    }
    Some(json!({
        "outside": req.allow_outside,
        "folders": folders,
    }))
}

/// The data root THIS turn reads its stores from (the caller's value, else the
/// live one). The same rule `skill_root` uses below.
pub(super) fn turn_data_root(req: &AgentRequest) -> String {
    if req.data_root.trim().is_empty() {
        native_data_root()
    } else {
        req.data_root.clone()
    }
}

/// The persisted "Always allow" folder grants: `<data-root>/trusted-folders.json`,
/// a JSON array of canonical absolute paths. Written by POST /permission/trust
/// when the user clicks "Always allow" on an outside-workspace popup; read by
/// every turn so the grant survives restarts. A headless (scheduled) run reads
/// the SAME file, which is how a schedule keeps touching an approved folder
/// without ever prompting.
pub(super) fn trusted_folders(data_root: &str) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(trusted_folders_file(data_root)) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

pub(super) fn trusted_folders_file(data_root: &str) -> std::path::PathBuf {
    std::path::Path::new(data_root).join("trusted-folders.json")
}

/// Persist one "Always allow" folder. The path is stored CANONICAL so the
/// matcher in `resolve_safe` (which canonicalizes both sides) can never be
/// defeated by a symlinked spelling of the same folder. Returns the stored path.
pub fn add_trusted_folder(data_root: &str, folder: &str) -> Result<String, String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Err("folder is required".into());
    }
    let canon = std::fs::canonicalize(trimmed)
        .map_err(|_| format!("folder does not exist: {trimmed}"))?
        .to_string_lossy()
        .to_string();
    let mut all = trusted_folders(data_root);
    if all.iter().any(|f| f == &canon) {
        return Ok(canon);
    }
    all.push(canon.clone());
    let file = trusted_folders_file(data_root);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(&all).unwrap_or_else(|_| "[]".into()))
        .map_err(|e| format!("cannot write trusted folders: {e}"))?;
    Ok(canon)
}

/// The persisted "Always allow" SSH hosts: `<data-root>/trusted-hosts.json`,
/// a JSON array of destinations (`user@host`). Written by POST
/// /permission/trust-host when the user clicks "Always allow" on the SSH
/// connection popup; read by the `run_terminal` SSH gate so an approved server
/// never asks again — the SAME semantics the folder grant has for paths.
pub(super) fn trusted_hosts(data_root: &str) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(trusted_hosts_file(data_root)) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

pub(super) fn trusted_hosts_file(data_root: &str) -> std::path::PathBuf {
    std::path::Path::new(data_root).join("trusted-hosts.json")
}

/// Persist one "Always allow" SSH destination. Stored verbatim (trimmed) — the
/// gate compares it against the exact string `ssh_destination` extracted from
/// the command, so no canonicalization is possible or needed.
pub fn add_trusted_host(data_root: &str, host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("host is required".into());
    }
    let mut all = trusted_hosts(data_root);
    if !all.iter().any(|h| h == trimmed) {
        all.push(trimmed.to_string());
    }
    let file = trusted_hosts_file(data_root);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(&all).unwrap_or_else(|_| "[]".into()))
        .map_err(|e| format!("cannot write trusted hosts: {e}"))?;
    Ok(trimmed.to_string())
}

/// Ask the user to approve an out-of-workspace path, then report whether the
/// grant covers `path`.
///
/// This is what turns a burned round into a served one: the refusal used to
/// arrive AFTER the model had already paid for the round, then the model spent
/// another round re-asking with a different tool. Asking first means the answer
/// is known before the work runs. `scope`/`folder` ride the event so "Always
/// allow" can register exactly this subtree.
pub(super) async fn ask_outside_access(
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    chat_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
    action: &str,
    ask: &OutsideAsk,
    headless: bool,
) -> bool {
    // A scheduled run has NO renderer: the `Permission` event is dropped by its
    // `emit` closure, so waiting for `await_answer` blocked the run FOREVER —
    // measured on a live trace, a paid article run stopped one call after the
    // model asked to touch a path outside the allowed roots and sat on
    // "running" with no timeout, no log line and no popup anywhere. Deny at
    // once instead, so the model gets an answer it can act on.
    if headless {
        eprintln!(
            "[tool] {action}: refused (scheduled run has no user to approve {})",
            ask.target.display()
        );
        return false;
    }
    let gate = next_gate_id();
    let target = ask.target.to_string_lossy().to_string();
    let folder = ask.folder.to_string_lossy().to_string();
    // The reason is BUILT, never a fixed string: a constant "outside the
    // workspace" told the user nothing they did not already know. Now it says
    // which act and which file — "Overwrite the whole file /etc/hosts" vs
    // "Create a new file" — so the answer is informed instead of reflexive.
    let reason = outside_reason(action, &target, ask.target.exists());
    emit(&AgentEvent::Permission {
        id: gate.clone(),
        action: action.to_string(),
        path: target,
        reason,
        scope: "outside".to_string(),
        folder,
    });
    match await_answer(&gate, chat_id, cancel).await {
        Some(v) => v["allowed"].as_bool().unwrap_or(false),
        None => false,
    }
}

/// The human reason shown on an out-of-workspace card: WHAT the tool is about
/// to do to which path. A fixed string here made the prompt useless.
fn outside_reason(action: &str, target: &str, exists: bool) -> String {
    let act = match action {
        "write_file" if exists => format!("Overwrite the whole file {target}"),
        "write_file" => format!("Create a new file {target}"),
        "edit_file" if exists => format!("Edit {target}"),
        "edit_file" => format!("Edit a file that does not exist yet {target}"),
        "delete" | "delete_file" => format!("Delete {target}"),
        "run_terminal" => format!("Run a command that touches {target}"),
        "plugin" => format!("Run a bundle script working inside {target}"),
        _ => format!("Access {target}"),
    };
    format!("{act}: this path is outside the project folder.")
}

/// Ask the user to approve an SSH connection to `dest` (`user@host`), then
/// report whether the answer was "allow".
///
/// Every command that would open an SSH session passes through here the FIRST
/// time it names a server the user has not yet approved — the connection is an
/// outward-facing act the user must own, the same class as the
/// out-of-workspace popup above. The popup's "Always allow" persists the host
/// (POST /permission/trust-host), so ONE answer covers the whole project;
/// a denied connection returns false and the call answers with
/// [`denied_ssh`].
pub(super) async fn ask_ssh_access(
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    chat_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
    dest: &str,
    headless: bool,
) -> bool {
    // A scheduled run has NO renderer: same trap as `ask_outside_access` —
    // waiting on `await_answer` would park the run forever. Deny at once.
    if headless {
        eprintln!("[tool] run_terminal: refused (scheduled run has no user to approve SSH to {dest})");
        return false;
    }
    let gate = next_gate_id();
    emit(&AgentEvent::Permission {
        id: gate.clone(),
        action: format!("ssh {dest}"),
        path: dest.to_string(),
        reason: "SSH connection to a remote server".to_string(),
        scope: "ssh".to_string(),
        folder: dest.to_string(),
    });
    match await_answer(&gate, chat_id, cancel).await {
        Some(v) => v["allowed"].as_bool().unwrap_or(false),
        None => false,
    }
}

/// The answer to a DENIED SSH connection. It must not read as a tool error the
/// model retries: it says what happened and what the model CAN do instead.
pub(super) fn denied_ssh(dest: &str) -> String {
    format!(
        "The user DENIED the SSH connection to {dest}. Nothing was run — do NOT retry this \
connection. Work only on the local workspace, or ask the user to run the remote steps \
themselves."
    )
}

/// Ask the user to approve DESKTOP control for ONE task, then report whether the
/// answer was "allow".
///
/// The composer's Computer Use switch says the user is willing to allow desktop
/// work in principle; it is not a per-task grant. Moving the real mouse, typing
/// into any window and reading the screen reach outside the app, so the FIRST
/// action of a task goes through this gate — and the card carries the model's
/// own REASON, because "allow what?" is the only question the user has.
///
/// A scheduled run has nobody to answer: deny at once instead of parking the
/// run forever (the same rule SSH and outside-workspace access follow).
pub(super) async fn ask_desktop_access(
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    chat_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
    action: &str,
    reason: &str,
    headless: bool,
) -> bool {
    let reason = reason.trim();
    let reason = if reason.is_empty() {
        "The agent wants to control the desktop for this task."
    } else {
        reason
    };
    if headless {
        eprintln!(
            "[tool] computer: refused (scheduled run has no user to approve desktop control: \
{reason})"
        );
        return false;
    }
    let gate = next_gate_id();
    emit(&AgentEvent::Permission {
        id: gate.clone(),
        action: action.trim().to_string(),
        // Desktop control has no path or folder: the reason is the whole story.
        path: String::new(),
        reason: reason.to_string(),
        scope: "computer".to_string(),
        folder: String::new(),
    });
    match await_answer(&gate, chat_id, cancel).await {
        Some(v) => v["allowed"].as_bool().unwrap_or(false),
        None => false,
    }
}

/// The answer to a DENIED desktop request. Like [`denied_ssh`], it must not
/// read as a transient tool error the model retries: nothing ran, and the model
/// should finish with the tools it still has.
pub(super) fn denied_desktop(reason: &str) -> String {
    format!(
        "The user DENIED desktop control ({reason}). NOTHING was done on the desktop — do NOT \
retry this action. Finish the task with the browser and the other tools you already have, or \
ask the user to do the desktop step themselves."
    )
}

/// Every SSH destination a shell command would connect to, in first-seen
/// order, deduplicated.
///
/// An empty result means the command opens no SSH session, so the gate stays
/// silent. Chains and pipelines are walked segment by segment (like
/// `is_mutating_depth`), because one `run_terminal` line may legitimately
/// touch SEVERAL servers (`ssh h1 …; ssh h2 …`) and each new destination must
/// prompt. Only the direct form and a `sh -c`/`bash -c` wrapper are followed —
/// the same boundary the mutating-command gate draws; deeper obfuscation is
/// the user's own shell, not a pattern the model emits in practice.
///
/// The recognized surface is the ssh-family binaries: `ssh`, `slogin`, `scp`,
/// `sftp`, `mosh`, `rsync` (remote specs `[[user@]host:]path` / `rsync://`),
/// and `sshpass` unwrapped one level so a password helper cannot smuggle the
/// connection past the gate.
pub(super) fn ssh_destinations(cmd: &str) -> Vec<String> {
    ssh_destinations_depth(cmd, 0)
}

pub(super) fn ssh_destinations_depth(cmd: &str, depth: usize) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for seg in cmd.split([';', '|', '&', '\n']) {
        let words: Vec<&str> = seg.split_whitespace().collect();
        let Some(first) = words.first() else {
            continue;
        };
        // Strip a leading path so `/usr/bin/ssh` is caught as well.
        let bin = first.rsplit('/').next().unwrap_or(first).to_lowercase();
        // A `sh -c '…'` payload is code the shell will run: decide from the
        // payload itself, bounded like the mutating gate.
        if matches!(bin.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh") {
            if let Some(pos) = words.iter().position(|w| *w == "-c") {
                let payload = words[pos + 1..].join(" ").trim_matches(['\'', '"']).to_string();
                if !payload.trim().is_empty() && depth < 3 {
                    for d in ssh_destinations_depth(&payload, depth + 1) {
                        if !found.contains(&d) {
                            found.push(d);
                        }
                    }
                }
                continue;
            }
        }
        // `sshpass -p PW ssh …`: drop the helper and its option/value pair,
        // then parse the wrapped command as the segment's head.
        let words: Vec<&str> = if bin == "sshpass" {
            let mut rest = words[1..].to_vec();
            if let Some(second) = rest.first() {
                if matches!(*second, "-f" | "-p" | "-d" | "-P" | "-e") && rest.len() > 1 {
                    rest.drain(0..2);
                }
            }
            rest
        } else {
            words
        };
        let head = words
            .first()
            .map(|w| w.rsplit('/').next().unwrap_or(w).to_lowercase())
            .unwrap_or_default();
        let Some(dest) = (match head.as_str() {
            "ssh" | "slogin" | "mosh" => Some(dest_of_ssh_like(&words[1..])),
            "scp" => Some(dest_of_scp(&words[1..])),
            "sftp" => Some(dest_of_scp(&words[1..])),
            "rsync" => Some(dest_of_rsync(&words[1..])),
            _ => None,
        })
        .flatten()
        else {
            continue;
        };
        if !found.contains(&dest) {
            found.push(dest);
        }
    }
    found
}

/// Options of the ssh-family that CONSUME the next word, so their value is
/// never mistaken for the destination. Deliberately generous: skipping one
/// option too many at worst delays the prompt by a word, while skipping one
/// too few can misname the host the user is approving. Flags (`-4`, `-A`,
/// `-t`, …) stay OUT of the set on purpose — `ssh -t host` must still find
/// `host`.
pub(super) const SSH_VALUE_OPTS: &[&str] = &[
    "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o",
    "-p", "-P", "-Q", "-R", "-S", "-w", "-W",
];
/// `scp` consumes: `-P` port, `-c` cipher, `-F` config, `-i` identity, `-o`
/// option, `-l` limit, `-S` program. `sftp` adds `-b` batchfile and `-D`
/// server. NOT here: `-B` is a scp FLAG (batch) and sftp's buffer size —
/// consuming it would swallow a real `host:file` after `scp -B host:file .`.
pub(super) const SCP_VALUE_OPTS: &[&str] = &[
    "-P", "-c", "-F", "-i", "-o", "-l", "-S", "-b", "-D",
];

/// The destination word of an `ssh`/`mosh`/`sftp`-style invocation: the first
/// argument that is neither an option nor an option's value. `sftp` also
/// accepts `sftp://user@host/path` URLs.
pub(super) fn dest_of_ssh_like(args: &[&str]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(w) = iter.next() {
        if let Some(rest) = w.strip_prefix("--") {
            // `--opt=value` is one word; a bare `--opt` that takes a value is
            // rare on OpenSSH — treat the next word as consumable only when
            // the option is known to need one.
            if !rest.contains('=') && rest == "rsh" {
                iter.next();
            }
            continue;
        }
        if w.starts_with('-') && w.len() > 1 {
            if SSH_VALUE_OPTS.contains(w) {
                iter.next();
            }
            continue;
        }
        let url = w.strip_prefix("sftp://").or_else(|| w.strip_prefix("ssh://"));
        if let Some(rest) = url {
            let authority = rest.split(['/', '?']).next().unwrap_or(rest);
            if !authority.is_empty() {
                return Some(authority.to_string());
            }
            continue;
        }
        return Some(w.to_string());
    }
    None
}

/// The FIRST remote spec of an `scp` invocation — either endpoint may be the
/// remote (`scp local remote:`, `scp remote:file local`).
pub(super) fn dest_of_scp(args: &[&str]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(w) = iter.next() {
        if w.starts_with('-') && w.len() > 1 {
            if SCP_VALUE_OPTS.contains(w) {
                iter.next();
            }
            continue;
        }
        if let Some(d) = remote_spec(w) {
            return Some(d);
        }
    }
    None
}

/// The FIRST remote spec of an `rsync` invocation (`[[user@]host:]path` or
/// `rsync://host/…`). Options are skipped WITHOUT consuming a following word:
/// rsync's short flags are a different alphabet from ssh's (`-P` is
/// `--partial --progress` here, a port elsewhere), so consuming values could
/// swallow the real destination (`rsync -P host:path .`) and MISS the prompt —
/// while a value misread as a destination merely prompts with a wrong name,
/// which is the safe direction.
pub(super) fn dest_of_rsync(args: &[&str]) -> Option<String> {
    for w in args {
        if w.starts_with('-') && w.len() > 1 {
            continue;
        }
        if let Some(d) = remote_spec(w) {
            return Some(d);
        }
    }
    None
}

/// `[[user@]host:]path` / `rsync://host/…` → `user@host` (or `host`), else
/// `None` for a plain local path. The destination is what the user approves,
/// so it keeps the `user@` part but drops the path.
pub(super) fn remote_spec(word: &str) -> Option<String> {
    if let Some(rest) = word.strip_prefix("rsync://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        if !authority.is_empty() {
            return Some(authority.to_string());
        }
        return None;
    }
    let slash = word.find('/').unwrap_or(word.len());
    let head = &word[..slash];
    let Some(colon) = head.rfind(':') else {
        return None;
    };
    let host = &head[..colon];
    // `C:/Users/x` is a drive letter, not a host; an empty head (`:path`,
    // rsync's "relative to home" spelling) names no host either.
    if host.is_empty() || (host.len() == 1 && host.chars().all(|c| c.is_ascii_alphabetic())) {
        return None;
    }
    Some(host.to_string())
}

/// The folder a grant must cover before a call may touch a path OUTSIDE every
/// allowed root (the workspace, the OS temp roots, `~/.codifa`, or a folder
/// already granted this turn).
///
/// `None` means the call stays inside that set — or names no path at all — so it
/// runs with no prompt. This is the pre-flight that ends the old two-round
/// dance: refuse → the model re-asks with a NATIVE tool → that one fails on the
/// SAME path, so one answer was billed twice. The user's rule is that every READ
/// works everywhere and only APPLYING a change needs Build, so an out-of-tree
/// read needs a GRANT, never a refusal.
/// What a pre-flight gate reports: the EXACT path the call names (for the
/// card) and the folder a grant must cover (for "Always allow").
///
/// These two are NOT the same thing: `path_access` walks up to the nearest
/// existing parent, so /etc/hosts used to be shown as /etc and the user was
/// asked to approve a directory without seeing which file changes.
pub(super) struct OutsideAsk {
    /// The canonical target the call would touch — what the card shows.
    pub target: std::path::PathBuf,
    /// The nearest existing parent — what "Always allow" widens.
    pub folder: std::path::PathBuf,
}

pub(super) fn outside_target(
    name: &str,
    args: &Value,
    root: &str,
    permit: Option<&Value>,
    caps: &ToolCaps,
) -> Option<OutsideAsk> {
    let mut rels = if name == "run_terminal" {
        shell_targets(args["command"].as_str().unwrap_or_default())
    } else {
        crate::tools::lookup_paths(name, args)
    };
    // A WRITER asks before it runs too — but only when the mode may write at
    // all: in a read-only mode the call is refused by caps anyway and the popup
    // would change nothing. The tool's own `resolve_safe` refusal then never
    // fires first, so the round is spent on the answer instead of on
    // discovering the refusal.
    if caps.write_files && matches!(name, "write_file" | "edit_file") {
        rels.extend(crate::tools::writer_gate_paths(name, args));
    }
    // A bundle script IS a command (see `plugin_mode_refusal`): it follows the
    // terminal capability, so an explicit working folder outside the free set
    // (the bundle's own folder, ~/.codifa, temp) asks exactly like a shell line
    // naming that folder would.
    if caps.run_terminal && name == "plugin" {
        rels.extend(crate::tools::writer_gate_paths(name, args));
    }
    for rel in rels {
        if let crate::tools::PathAccess::NeedsPermission(folder) =
            crate::tools::path_access(root, &rel, permit)
        {
            // The exact target the call names, resolved the same way
            // `path_access` resolved it but WITHOUT walking up to a parent.
            // An unexpandable path (`~bad`) has no target; the folder alone is
            // still worth showing, so fall back to it.
            let target = crate::tools::absolute_target(root, &rel).unwrap_or_else(|_| folder.clone());
            return Some(OutsideAsk { target, folder });
        }
    }
    None
}

/// Record a folder the user just approved for the rest of THIS turn, so the very
/// next call in the same round already sees the grant.
pub(super) fn grant_folder(permit: &mut Option<Value>, folder: &std::path::Path) {
    let f = folder.to_string_lossy().to_string();
    if f.is_empty() {
        return;
    }
    let p = permit.get_or_insert_with(|| json!({"outside": false, "folders": []}));
    if let Some(arr) = p["folders"].as_array_mut() {
        if !arr.iter().any(|v| v.as_str() == Some(f.as_str())) {
            arr.push(json!(f));
        }
    }
}

/// The answer to a DENIED out-of-workspace request. It must not read as a tool
/// error the model retries: it names what IS reachable instead.
pub(super) fn denied_outside(folder: &std::path::Path) -> String {
    format!(
        "The user DENIED access to {}. Nothing was read or run — do NOT retry this path. \
The workspace, the OS temp folder (/tmp) and ~/.codifa stay open; use one of those or ask the \
user what to do instead.",
        folder.display()
    )
}

/// Map a model-invented tool name onto the REAL advertised one.
///
/// Models are RL-trained on other agents' vocabularies (`read_client`,
/// `read_file`, `view_file`, `shell`, `bash`, `todos`…), so a perfectly correct
/// intent sent under a foreign name was answered with the generic
/// "unknown tool" error — and a traced explore retried the same wrong name 75
/// times, burning the whole tool budget. The alias resolves ONLY when the
/// canonical name is really advertised, so the model is never handed a tool
/// that does not exist in this run.
pub(crate) fn canonical_tool_name(name: &str, advertised: &[String]) -> Option<String> {
    let norm = |s: &str| s.trim().to_lowercase().replace(['-', ' '], "_");
    let n = norm(name);
    // 1) Case / dash / underscore-insensitive match on a real advertised name.
    if let Some(hit) = advertised.iter().find(|a| norm(a) == n) {
        return Some(hit.clone());
    }
    // 2) Known cross-agent aliases -> the advertised canonical name.
    let canonical = match n.as_str() {
        "read_client" | "read_file" | "readfile" | "view_file" | "read_text_file" | "get_file" => {
            "read"
        }
        "search_files" | "search_content" | "ripgrep" | "search_in_files" => "grep",
        "find_files" | "list_dir" | "ls" | "list_directory" => "glob",
        "shell" | "bash" | "sh" | "run_command" | "execute_command" | "terminal" | "run" => {
            "run_terminal"
        }
        "search_web" | "websearch" | "google" => "web_search",
        "fetch_url" | "fetch" | "open_url" | "read_url" | "webfetch" | "http_get" => {
            "fetch_url"
        }
        "load_plugin" | "skill" | "load_skill" | "load_skill_file" => "load_plugin",
        "create_file" | "writefile" => "write_file",
        "str_replace" | "replace_in_file" | "editfile" => "edit_file",
        "plan" | "todos" | "todo_write" | "write_todos" | "update_todos" => "update_plan",
        // The batch tool was renamed to `batch_search` to say what it is (a
        // SEARCH composer, never a write one). The old spelling stays an alias
        // so a model that learned the previous name — or a replayed transcript —
        // still lands on the real tool instead of "unknown tool".
        "batch" | "batch_search" | "batch_tools" | "batch_calls" => "batch_search",
        "ask" | "question" | "ask_question" => "ask_user",
        "permission" | "request_permission" => "confirm_action",
        _ => return None,
    };
    if advertised.iter().any(|a| a == canonical) {
        Some(canonical.to_string())
    } else {
        None
    }
}

