//! Plugin hooks: the `hooks/hooks.json` half of a Claude Code bundle.
//!
//! A bundle may declare shell handlers that run at four points of an agent turn
//! (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`). A handler can veto
//! a tool call (`PreToolUse` only) by exiting with code 2, or by printing
//! `{"decision":"block","reason":"…"}` on stdout.
//!
//! SECURITY: this is the one part of a bundle that runs arbitrary code, so a
//! bundle's hooks only run while the bundle itself is ENABLED (the switch on
//! its card); it runs inside the plugin's own folder, with a bounded wall-clock
//! budget and output, in a scrubbed environment (no provider keys), and every
//! run is reported back so the trace can name what happened.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Folder inside a plugin holding its hook declarations.
pub(crate) const HOOKS: &str = "hooks";
/// File inside that folder.
pub(crate) const HOOKS_FILE: &str = "hooks.json";
/// Wall-clock budget for ONE handler. A hook is a guard, not a job: a handler
/// that needs longer is a script and belongs in `scripts/`.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on the bytes a handler may print. Its output is fed back to the model,
/// so an unbounded one would let a bundle rewrite the whole context.
pub(crate) const MAX_OUTPUT: usize = 4000;
/// Cap on the declared handlers of one bundle.
pub(crate) const MAX_HOOKS: usize = 32;
/// Wall-clock budget for ONE event across ALL handlers of every bundle.
///
/// `TIMEOUT` bounds a single handler; this bounds what a turn is willing to spend
/// on hooks at all, so a bundle that declares thirty slow handlers cannot stall
/// the model call behind them.
pub(crate) const RUN_BUDGET: Duration = Duration::from_secs(20);

/// The events Codifa actually dispatches, in lifecycle order.
pub const DISPATCHED: [&str; 5] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];

/// Events a declaration may name. The others are accepted files-wise — a real
/// Claude Code bundle lists them — but they are reported as not dispatched
/// instead of being silently dropped.
pub const KNOWN: [&str; 8] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "Notification",
];

/// What one event run did, for the trace and for the blocking decision.
#[derive(Debug, Default)]
pub struct Outcome {
    /// True when a handler vetoed the action (only meaningful for PreToolUse).
    pub blocked: bool,
    /// Why it vetoed, or a short note about what ran.
    pub reason: String,
    /// How many handlers were actually executed.
    pub ran: usize,
    /// Last non-empty stdout, capped. On `PostToolUse` this IS the payload: the
    /// call already happened, so whatever the handler printed is shipped back to
    /// the model as information about it.
    pub output: String,
}

/// One declared handler, resolved out of `hooks.json`.
#[derive(Debug, Clone)]
pub struct Hook {
    pub event: String,
    /// Substring/name the event must match (tool name, or empty for "all").
    pub matcher: String,
    pub command: String,
}

/// Folder holding one plugin's hook declarations.
pub fn hooks_dir(plugin_dir: &Path) -> PathBuf {
    plugin_dir.join(HOOKS)
}

/// Path of the declaration file, whether or not it exists.
pub fn hooks_file(plugin_dir: &Path) -> PathBuf {
    hooks_dir(plugin_dir).join(HOOKS_FILE)
}

/// Read and validate a bundle's hook declarations.
///
/// Unknown events, empty commands and commands that try to leave the plugin
/// folder are DROPPED rather than kept: a hook list that cannot be executed as
/// written must never be half-executed.
pub fn read_hooks(plugin_dir: &Path) -> Vec<Hook> {
    let Ok(raw) = std::fs::read_to_string(hooks_file(plugin_dir)) else {
        return Vec::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    hooks_of(&doc)
}

/// Same as [`read_hooks`] for an already-parsed document (the repo reader has
/// the text in hand and must not write a file first).
pub fn hooks_of(doc: &Value) -> Vec<Hook> {
    hooks_of_in(doc, Path::new("."))
}

/// [`hooks_of`] with the bundle folder, so an absolute command can be checked
/// against the sandbox it claims to live in.
pub fn hooks_of_in(doc: &Value, plugin_dir: &Path) -> Vec<Hook> {
    let Some(map) = doc["hooks"].as_object().or_else(|| doc.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<Hook> = Vec::new();
    for (event, entries) in map {
        let event_name = KNOWN
            .iter()
            .find(|e| e.eq_ignore_ascii_case(event))
            .map(|e| e.to_string());
        let Some(event_name) = event_name else {
            continue;
        };
        let list = match entries {
            Value::Array(a) => a.clone(),
            Value::Object(_) => vec![entries.clone()],
            _ => continue,
        };
        for entry in list {
            if out.len() >= MAX_HOOKS {
                return out;
            }
            let matcher = entry["matcher"].as_str().unwrap_or("").trim().to_string();
            // Two shapes exist in the wild: a `{matcher, hooks:[{command}]}`
            // group, and a flat `{matcher, command}` entry.
            let commands: Vec<String> = if let Some(group) = entry["hooks"].as_array() {
                group
                    .iter()
                    .filter_map(|h| h["command"].as_str().map(str::to_string))
                    .collect()
            } else {
                entry["command"]
                    .as_str()
                    .map(|c| vec![c.to_string()])
                    .unwrap_or_default()
            };
            for command in commands {
                let command = command.trim().to_string();
                if command.is_empty() || !command_is_contained(&command, plugin_dir) {
                    continue;
                }
                out.push(Hook {
                    event: event_name.clone(),
                    matcher: matcher.clone(),
                    command,
                });
            }
        }
    }
    out
}

/// The bundle-relative file a declared command runs, when it names one.
///
/// Real Claude Code bundles spell their handler as
/// `${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh`, so the var prefix is
/// stripped first. `None` means the command is inline shell (`exit 2`, `jq …`)
/// or a bare program on PATH — there is no file to carry.
pub fn handler_path(command: &str) -> Option<String> {
    let first = command.split_whitespace().next()?.trim();
    let rel = first
        .strip_prefix("${CLAUDE_PLUGIN_ROOT}/")
        .or_else(|| first.strip_prefix("$CLAUDE_PLUGIN_ROOT/"))
        .or_else(|| first.strip_prefix("${CODIFA_PLUGIN_ROOT}/"))
        .or_else(|| first.strip_prefix("./"))
        .unwrap_or(first);
    // An inline shell word, an absolute path or a bare name is not a bundle file.
    if rel.is_empty() || rel.starts_with('/') || rel.starts_with('$') || !rel.contains('.') {
        return None;
    }
    if rel.split('/').any(|part| part == "..") {
        return None;
    }
    Some(rel.to_string())
}

/// Whether a declared command stays inside the bundle.
///
/// A relative command is resolved against the plugin folder, so `..` — the only
/// way a relative path escapes it — is rejected outright. An absolute path is
/// accepted only when it lands inside the same folder; anything else (another
/// plugin, the user's home dotfiles, `/tmp`) is a bundle reaching outside its
/// own sandbox and is refused. A bare program name (`guard.sh`) is relative by
/// definition and stays in the folder.
fn command_is_contained(command: &str, plugin_dir: &Path) -> bool {
    if command.contains("..") {
        return false;
    }
    // Only the FIRST token decides where the program lives; the rest are args.
    let first = command.split_whitespace().next().unwrap_or("");
    let path = Path::new(first);
    if !path.is_absolute() {
        return true;
    }
    // `canonicalize` needs the file to exist; the plugin folder does, and the
    // prefix check is what actually guards the escape.
    let Ok(root) = plugin_dir.canonicalize() else {
        return false;
    };
    path.canonicalize().is_ok_and(|p| p.starts_with(&root))
}

/// Handlers of one event, filtered by the value they must match.
pub fn matching(hooks: &[Hook], event: &str, target: &str) -> Vec<Hook> {
    hooks
        .iter()
        .filter(|h| h.event.eq_ignore_ascii_case(event))
        .filter(|h| h.matcher.is_empty() || target.to_lowercase().contains(&h.matcher.to_lowercase()))
        .cloned()
        .collect()
}

/// Run one event's handlers for `target` (the tool name, or the prompt).
///
/// `plugin_dir` is both the working directory and the sandbox: a relative
/// command resolves inside it. `trusted` must already be checked by the caller —
/// it is repeated here so a mistake at a call site can never execute a hook for
/// a bundle the user did not approve.
pub fn run_event(plugin_dir: &Path, hooks: &[Hook], event: &str, target: &str) -> Outcome {
    let mut outcome = Outcome::default();
    for hook in matching(hooks, event, target) {
        match run_one(plugin_dir, &hook) {
            Ok((code, stdout)) => {
                outcome.ran += 1;
                if !stdout.trim().is_empty() {
                    outcome.output = truncate(stdout.trim());
                }
                if let Some(reason) = blocked_by(code, &stdout) {
                    outcome.blocked = true;
                    outcome.reason = reason;
                    return outcome;
                }
            }
            Err(reason) => {
                // A handler that could not run at all must not fail the turn
                // open silently: record it as the outcome's note.
                outcome.reason = reason;
            }
        }
    }
    outcome
}

/// Whether a finished handler vetoes the action, and why.
fn blocked_by(code: i32, stdout: &str) -> Option<String> {
    if code == 2 {
        let text = stdout.trim();
        return Some(if text.is_empty() {
            "the hook vetoed this action (exit 2)".to_string()
        } else {
            truncate(text)
        });
    }
    let doc: Value = serde_json::from_str(stdout.trim()).ok()?;
    let decision = doc["decision"].as_str().unwrap_or("");
    if decision.eq_ignore_ascii_case("block") || doc["continue"].as_bool() == Some(false) {
        let reason = doc["reason"].as_str().unwrap_or("the hook vetoed this action");
        return Some(truncate(reason));
    }
    None
}

fn truncate(text: &str) -> String {
    text.chars().take(MAX_OUTPUT).collect()
}

/// One handler together with the bundle folder it runs in.
///
/// The agent needs the pair: `run_event` sandboxes and `cd`s into that folder,
/// and hooks from several bundles fire on the same event.
#[derive(Debug, Clone)]
pub struct Active {
    pub dir: PathBuf,
    pub hook: Hook,
}

/// Every declared handler of the bundles that are BOTH enabled and approved.
///
/// Nothing here decides trust on its own: the caller passes the pairs it already
/// resolved from the manifests, so a bundle the user never approved can never
/// reach this list by accident.
pub fn active_in(bundles: &[(PathBuf, bool)]) -> Vec<Active> {
    let mut out: Vec<Active> = Vec::new();
    for (dir, declared) in bundles {
        if !*declared || out.len() >= MAX_HOOKS {
            continue;
        }
        for hook in read_hooks(dir) {
            if out.len() >= MAX_HOOKS {
                return out;
            }
            out.push(Active {
                dir: dir.clone(),
                hook,
            });
        }
    }
    out
}

/// Run one event across every active handler, in bundle order.
///
/// Stops at the FIRST veto: a guard that already refused must not be argued with
/// by the next bundle's handler.
pub fn run_active(hooks: &[Active], event: &str, target: &str) -> Outcome {
    let mut outcome = Outcome::default();
    let started = Instant::now();
    for active in hooks {
        if !active.hook.event.eq_ignore_ascii_case(event) {
            continue;
        }
        // One shared wall-clock budget for the WHOLE event, not just per handler:
        // a bundle may declare up to MAX_HOOKS handlers, and 32 × 10 s of a
        // stalled turn is not a guard, it is a hang. The budget is spent silently
        // past this point and the note says so.
        if started.elapsed() >= RUN_BUDGET {
            outcome.reason = format!(
                "remaining {event} handlers skipped after {}s of hook time",
                RUN_BUDGET.as_secs()
            );
            return outcome;
        }
        let one = run_event(&active.dir, std::slice::from_ref(&active.hook), event, target);
        outcome.ran += one.ran;
        if !one.output.is_empty() {
            outcome.output = one.output;
        }
        if one.blocked {
            outcome.blocked = true;
            outcome.reason = one.reason;
            return outcome;
        }
        if !one.reason.is_empty() {
            outcome.reason = one.reason;
        }
    }
    outcome
}

/// Run one handler, bounded in time and output.
fn run_one(plugin_dir: &Path, hook: &Hook) -> Result<(i32, String), String> {
    let mut cmd = Command::new(shell_program());
    cmd.arg("-c")
        .arg(&hook.command)
        .current_dir(plugin_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Scrubbed environment: a bundle's hook must not be able to read the
        // provider keys, OAuth tokens or secrets this process holds. Only what
        // a plain script needs survives.
        .env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    // The variables a Claude Code bundle writes its handlers against. They are
    // the ONLY additions to the scrubbed environment, and both point at the
    // bundle itself: a real bundle ships `${CLAUDE_PLUGIN_ROOT}/hooks-handlers/
    // session-start.sh` (that is the documented spelling), and without this the
    // var expands to nothing and the handler dies as `/hooks-handlers/...`.
    cmd.env("CLAUDE_PLUGIN_ROOT", plugin_dir);
    cmd.env("CODIFA_PLUGIN_ROOT", plugin_dir);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("hook `{}` could not start: {e}", hook.command))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("hook `{}` failed: {e}", hook.command)),
        }
        if started.elapsed() >= TIMEOUT {
            // Left-behind handlers are a resource leak and a turn-long stall:
            // kill it outright rather than waiting on a process we abandoned.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "hook `{}` timed out after {}s",
                hook.command,
                TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("hook `{}` produced no output: {e}", hook.command))?;
    let code = out.status.code().unwrap_or(0);
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    Ok((code, truncate(&text)))
}

#[cfg(unix)]
fn shell_program() -> &'static str {
    "sh"
}

#[cfg(not(unix))]
fn shell_program() -> &'static str {
    "cmd"
}

/// JSON summary of what a bundle declares, for the renderer and the agent.
pub fn describe(plugin_dir: &Path) -> Value {
    let hooks = read_hooks(plugin_dir);
    let rows: Vec<Value> = hooks
        .iter()
        .map(|h| {
            json!({
                "event": h.event,
                "matcher": h.matcher,
                "command": h.command,
                "dispatched": DISPATCHED.iter().any(|e| e.eq_ignore_ascii_case(&h.event)),
            })
        })
        .collect();
    json!({ "hooks": rows })
}

#[cfg(test)]
mod tests;
