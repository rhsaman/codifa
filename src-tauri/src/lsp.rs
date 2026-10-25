//! Native LSP tool support (phase 3-3 parity with backend/lsp_manager.py).
//!
//! A minimal stdio JSON-RPC client with Content-Length framing that spawns
//! language servers lazily per (root, language), runs `initialize`, opens
//! documents on demand and serves the five LSP tools the agent exposes
//! (definition / references / hover / symbols / diagnostics).
//!
//! Parity notes (mirrors lsp_manager.py):
//! - language detection via the same suffix table
//! - same server commands per language
//! - VSCode languageId per suffix for didOpen (servers need exact ids)
//! - caps: refs 40 (inline 25 x 160 chars), symbols 400, def body 60 lines

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
// `process_group` on `Command` (own process group per language server).
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tools::resolve_safe;

// --- caps (parity with tools.py constants) ----------------------------------
pub const DEF_BODY_MAX_LINES: usize = 60;
pub const REF_CAP: usize = 40;
pub const REF_INLINE_CAP: usize = 25;
pub const REF_INLINE_MAX_CHARS: usize = 160;
pub const SYMBOLS_CAP: usize = 400;
/// How long a request may wait for its response.
///
/// Deliberately generous, and NOT a wedge detector: exceeding it no longer kills
/// the server (see `request`). rust-analyzer answers a `definition` only once it
/// has loaded the crate graph, and the first request against a cold server is
/// the one that pays for it — aborting that threw away every second of indexing
/// already done, so the next call started over from zero and LSP never became
/// warm.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Budget for the `initialize` handshake of a COLD server.
///
/// rust-analyzer runs `cargo metadata` and starts loading the project before it
/// answers; on a Tauri-sized workspace that is minutes, not seconds. A server
/// that is still loading is NOT broken, so this just has to outlast a normal
/// cold start.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(180);
/// How long `diagnostics` drains pushed `publishDiagnostics` notifications.
///
/// How long the AUTOMATIC post-edit diagnostics may listen.
///
/// Much shorter than the explicit `lsp_diagnostics` window (3s): this one is
/// not the model's deliberate question, it is a freebie riding on an edit
/// result, so it must never delay the edit. A warm server answers in
/// milliseconds — a shorter window only drops a slow answer, which the model
/// still covers with its own build command.
const POST_EDIT_DIAGNOSTICS_WINDOW: Duration = Duration::from_millis(1500);

/// The same window for a file the server had NOT seen before the edit.
///
/// MEASURED with a real client against `typescript-language-server`: the first
/// `publishDiagnostics` after `didOpen` arrives in 1.99s, the re-lint after
/// `didChange` in 0.40s. The warm 1.5s window above is therefore too short for
/// exactly the first edit of every file — the one that matters most, because a
/// new file has never been checked at all. Paid only in that case, and only
/// when the server was already warm (`diagnostics_if_warm`).
const POST_EDIT_DIAGNOSTICS_WINDOW_COLD: Duration = Duration::from_millis(3000);

/// How long `diagnostics` drains pushed `publishDiagnostics` notifications.
///
/// A soft window: diagnostics are a bonus, and this call must never wedge the
/// turn — it triggers a pull without waiting for the response (`request_nowait`)
/// and then only listens for as long as this.
const DIAGNOSTICS_WINDOW: Duration = Duration::from_secs(3);
const MAX_OPEN_DOCS: usize = 30;
/// How many unread server messages are buffered before advisory notifications
/// are dropped.
///
/// A language server broadcasts progress and diagnostics while it indexes, and
/// nothing consumes them between tool calls — an unbounded queue grew with every
/// message rust-analyzer produced (hundreds of MB over a long indexing session).
/// The bound keeps memory flat. Messages carrying an `id` (the responses a call
/// is waiting for, and server->client requests we must answer) are NEVER dropped;
/// only advisory notifications are.
const NOTIFY_QUEUE: usize = 1024;
/// Serialises the spawn+insert pair in `server_for`.
///
/// Without it, two concurrent cold callers for the same (root, language) both
/// spawn a server and the second insert overwrites (and orphans) the first.
static LSP_SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// How long an UNUSED language server is kept before it is reaped.
///
/// A server holds the project index in memory (rust-analyzer: hundreds of MB to
/// a couple of GB), so one per project ever opened grows without bound over a
/// long session. Ten minutes is long enough that switching back and forth
/// between two projects keeps both warm, and short enough that abandoned
/// projects do not pile up. Reaping happens on a workspace switch (`prune_idle`).
const LSP_IDLE_TTL: Duration = Duration::from_secs(600);

/// Language servers whose project index is measured in GIGABYTES.
///
/// `rust-analyzer` keeps a whole-crate-graph index and, measured on this
/// machine, reached **1921 MB of physical footprint** — twice the memory budget
/// of the entire app, whose shell was 233 MB. It was never reaped either: every
/// agent turn calls `prewarm`, and `server_for`'s fast path refreshes
/// `last_used`, so the idle TTL below never expired for it and the process sat
/// resident for the whole session.
///
/// These are therefore NEVER pre-warmed: a pre-warm spawns one per project the
/// user ever opens, while most sessions never issue a single LSP call. They
/// start on demand from a real LSP tool call and are reaped far sooner.
const HEAVY_LANGUAGES: [&str; 8] = [
    "rust", "c", "cpp", "java", "scala", "haskell", "dart", "csharp",
];

/// Idle TTL for a HEAVY language server.
///
/// Two minutes, not ten: one of these outweighs the rest of the app combined, so
/// freeing it quickly matters far more than saving a cold start nobody asked
/// for. A light server (TypeScript, Python) is cheap to keep warm.
const LSP_HEAVY_IDLE_TTL: Duration = Duration::from_secs(120);

/// Languages worth SPECULATIVELY starting before any LSP call asks for them.
///
/// Pre-warming exists for latency: a warm server answers the first tool call in
/// milliseconds instead of paying a cold start. That trade only pays for a CHEAP
/// server, and it is decided here against measurement, not intuition:
///
///   * `rust` and friends (see `HEAVY_LANGUAGES`): 1921 MB — never.
///   * `python`: `pylsp` measured **158 MB** of physical footprint for one
///     workspace (it loads jedi plus every registered plugin), which is more than
///     the entire app shell. Most sessions never issue an LSP call at all, so
///     paying that before the user asks is a pure loss; a real `lsp_*` tool call
///     still starts it on demand.
///   * TypeScript stays: `typescript-language-server` costs ~27 MB and gives the
///     best latency win of anything in the walk.
fn should_prewarm(language: &str) -> bool {
    !is_heavy_language(language) && !matches!(language, "python")
}

/// Whether this language's server holds a whole-project index in memory.
fn is_heavy_language(language: &str) -> bool {
    HEAVY_LANGUAGES.contains(&language)
}
/// How long a call may wait for exclusive use of a root+language server.
///
/// `Mutex::lock` waits FOREVER, and dropping an abandoned attempt does not stop
/// it: `spawn_blocking` cannot be cancelled, so the thread that is inside the
/// LSP call keeps running and keeps this mutex. The next attempt then parked
/// behind it and attempts stacked up — one wedged call could stall a turn for
/// half an hour, and nothing ever released the lock.
///
/// A HEALTHY holder releases far sooner: `request` itself gives up at
/// `REQUEST_TIMEOUT` (60s), so 120s only expires for a genuinely stuck server.
/// Even then the server is KEPT (see `lock_server`): the holder is almost always
/// a healthy call still working on a cold index, and throwing the server away
/// there is exactly what kept LSP from ever getting warm. The caller gets a
/// clear "still busy, retry" error instead of a silently restarted server.
const SERVER_LOCK_WAIT: Duration = Duration::from_secs(120);
/// How long `server_for`'s liveness probe may wait for a server's lock before
/// concluding "busy, therefore alive".
///
/// The probe must never block: a wedged thread can hold that lock indefinitely
/// (`spawn_blocking` LSP calls cannot be cancelled), and waiting on it is
/// precisely how attempts piled up. Handing the server back lets `lock_server`
/// do the bounded wait — and replace it if it truly never releases.
const SERVER_PROBE_WAIT: Duration = Duration::from_secs(2);
/// How often a bounded wait reports liveness.
///
/// Every wait is served in slices this long and each slice refreshes a global
/// heartbeat, so the agent's idle guard can tell "the language server is still
/// loading" (real progress — a cold rust-analyzer says nothing for minutes)
/// from "the turn is wedged". Without it the guard would abort a healthy cold
/// start, and with a shorter request budget the server would be killed and
/// re-cold-started forever.
const LSP_PULSE_SLICE: Duration = Duration::from_secs(5);

/// Global "the LSP layer is alive and working" counter — see `LSP_PULSE_SLICE`.
static LSP_ACTIVITY: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// True on a BACKGROUND pre-warm thread.
    ///
    /// A pre-warm loads language servers for the whole workspace on its own
    /// thread, and loading a cold server means minutes of `next_message` /
    /// `lock_bounded` waits — each of which refreshes the global counter. Fed
    /// into the agent's idle guard, that background work looked like the CURRENT
    /// attempt making progress, so a genuinely hung provider was never detected.
    /// Only LSP work caused by the attempt itself may count as its liveness.
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Mark LSP progress so the agent's idle guard does not mistake a cold server
/// for a hung turn.
///
/// A background pre-warm (`QUIET`) is deliberately excluded: it is not the
/// agent's attempt, so it must never keep a hung attempt alive.
fn touch() {
    if QUIET.with(std::cell::Cell::get) {
        return;
    }
    LSP_ACTIVITY.fetch_add(1, Ordering::Relaxed);
}

/// Current LSP activity counter (the agent's idle guard polls this).
pub fn activity() -> u64 {
    LSP_ACTIVITY.load(Ordering::Relaxed)
}

// --- registry tables (parity with lsp_manager.py) ---------------------------

/// `NODE_OPTIONS` for a node-based language server: cap the V8 heap, then
/// append whatever the user already had.
///
/// `typescript-language-server` forks `tsserver`, whose default heap ceiling is
/// several GB — measured 578 MB of RSS on this workspace before any cap. This
/// is the knob VS Code exposes as `maxTsServerMemory`; nothing becomes
/// unavailable, the GC simply runs earlier (a full GC at >512 MB takes ~290 ms,
/// so 1 GB leaves room to stay responsive).
///
/// The user's own options are appended, never replaced, and always separated by
/// a space: without it `--inspect` would concatenate into `=1024--inspect` and
/// node would reject the whole string.
fn node_options_with_heap_cap() -> String {
    const HEAP_CAP: &str = "--max-old-space-size=1024";
    let inherited = std::env::var("NODE_OPTIONS").unwrap_or_default();
    let inherited = inherited.trim().to_string();
    if inherited.is_empty() {
        HEAP_CAP.to_string()
    } else {
        format!("{HEAP_CAP} {inherited}")
    }
}

fn server_command(language: &str) -> Option<Vec<String>> {
    let cmd: &[&str] = match language {
        "python" => &["pylsp"],
        "typescript" | "javascript" => &["typescript-language-server", "--stdio"],
        "astro" => &["astro-ls", "--stdio"],
        "bash" => &["bash-language-server", "start"],
        "c" | "cpp" => &["clangd"],
        "csharp" => &["csharp-ls"],
        "css" => &["vscode-css-language-server", "--stdio"],
        "dart" => &["dart", "language-server"],
        "elixir" => &["elixir-ls"],
        "elm" => &["elm-language-server"],
        "erlang" => &["erlang_ls"],
        "go" => &["gopls"],
        "haskell" => &["haskell-language-server-wrapper", "--lsp"],
        "html" => &["vscode-html-language-server", "--stdio"],
        "java" => &["jdtls"],
        "json" => &["vscode-json-language-server", "--stdio"],
        "kotlin" => &["kotlin-language-server"],
        "lua" => &["lua-language-server"],
        "markdown" => &["marksman"],
        "nix" => &["nil"],
        "ocaml" => &["ocamllsp"],
        "php" => &["intelephense", "--stdio"],
        "ruby" => &["solargraph", "stdio"],
        "rust" => &["rust-analyzer"],
        "scala" => &["metals"],
        "svelte" => &["svelteserver", "--stdio"],
        "swift" => &["sourcekit-lsp"],
        "terraform" => &["terraform-ls", "serve"],
        "toml" => &["taplo", "lsp", "stdio"],
        "vue" => &["vue-language-server", "--stdio"],
        "yaml" => &["yaml-language-server", "--stdio"],
        "zig" => &["zls"],
        "tailwind" => &["tailwindcss-language-server", "--stdio"],
        "eslint" => &["vscode-eslint-language-server", "--stdio"],
        _ => return None,
    };
    Some(cmd.iter().map(|s| s.to_string()).collect())
}

fn language_for_suffix(suffix: &str) -> Option<&'static str> {
    Some(match suffix {
        ".py" | ".pyi" => "python",
        ".ts" | ".tsx" | ".mts" | ".cts" => "typescript",
        // JavaScript is served by the SAME `typescript-language-server` binary
        // (see `server_command`), so it maps onto the `typescript` key: one key
        // per PROCESS is what keeps a repo with .ts AND .js files from starting
        // two identical servers (and two tsserver children) for one root.
        ".js" | ".jsx" | ".mjs" | ".cjs" => "typescript",
        ".astro" => "astro",
        ".sh" | ".bash" => "bash",
        ".c" | ".h" => "c",
        ".cc" | ".cpp" | ".hpp" => "cpp",
        ".cs" => "csharp",
        ".css" | ".scss" | ".less" => "css",
        ".dart" => "dart",
        ".ex" | ".exs" => "elixir",
        ".elm" => "elm",
        ".erl" | ".hrl" => "erlang",
        ".go" => "go",
        ".hs" => "haskell",
        ".html" | ".htm" => "html",
        ".java" => "java",
        ".json" | ".jsonc" => "json",
        ".kt" | ".kts" => "kotlin",
        ".lua" => "lua",
        ".md" | ".markdown" => "markdown",
        ".nix" => "nix",
        ".ml" | ".mli" => "ocaml",
        ".rb" => "ruby",
        ".php" => "php",
        ".rs" => "rust",
        ".scala" | ".sbt" => "scala",
        ".svelte" => "svelte",
        ".swift" => "swift",
        ".tf" | ".tfvars" => "terraform",
        ".toml" => "toml",
        ".vue" => "vue",
        ".yaml" | ".yml" => "yaml",
        ".zig" => "zig",
        _ => return None,
    })
}

/// VSCode languageId sent in textDocument/didOpen (servers expect exact ids).
fn language_id_for_suffix(suffix: &str) -> &str {
    match suffix {
        ".tsx" => "typescriptreact",
        ".jsx" => "javascriptreact",
        // `.js`/`.mjs`/`.cjs` map onto the `typescript` PROCESS key (one server
        // per binary), but the protocol languageId must stay "javascript" —
        // falling through to `language_for_suffix` would announce a plain .js
        // file to the server as TypeScript.
        ".js" | ".mjs" | ".cjs" => "javascript",
        ".sh" | ".bash" => "shellscript",
        ".scss" => "scss",
        ".less" => "less",
        ".jsonc" => "jsonc",
        ".tfvars" => "terraform-vars",
        other => language_for_suffix(other).unwrap_or("plaintext"),
    }
}

// --- JSON-RPC over stdio -----------------------------------------------------

fn next_id() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    // Content-Length framing: headers separated by \r\n, blank line, body.
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("server closed the stream".into());
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(v) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            content_length = v.trim().parse::<usize>().ok();
        }
    }
    let len = content_length
        .ok_or_else(|| "missing Content-Length header".to_string())?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

fn write_message(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    stdin.write_all(&body).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

// --- per-root manager ---------------------------------------------------------

/// PATH for language servers. A GUI-launched macOS app inherits a minimal PATH
/// (no Homebrew, ~/.cargo/bin or nvm node), so `rust-analyzer` — or a node-based
/// `typescript-language-server`, which needs `node` on PATH — was never found
/// and every lsp_* call failed; the sub-agent then gave up on LSP entirely.
fn augmented_path() -> std::ffi::OsString {
    let mut dirs_vec: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut extra: Vec<PathBuf> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = dirs::home_dir() {
        for rel in [".cargo/bin", ".local/bin", "go/bin", ".volta/bin", ".bun/bin", ".pyenv/shims"] {
            extra.push(home.join(rel));
        }
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for e in rd.flatten() {
                extra.push(e.path().join("bin"));
            }
        }
    }
    for d in extra {
        if d.is_dir() && !dirs_vec.contains(&d) {
            dirs_vec.push(d);
        }
    }
    std::env::join_paths(dirs_vec).unwrap_or_default()
}

/// Resolve a bare server command against `path_env` (explicit paths pass through).
fn resolve_binary(cmd0: &str, path_env: &std::ffi::OsStr) -> PathBuf {
    if cmd0.contains('/') {
        return PathBuf::from(cmd0);
    }
    for dir in std::env::split_paths(path_env) {
        let cand = dir.join(cmd0);
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from(cmd0)
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    /// Messages parsed by a background reader thread that OWNS the server's
    /// stdout.
    ///
    /// Reading the pipe inline cannot be bounded (a blocking `read_line` ignores
    /// any deadline checked between messages), so a server that accepted the
    /// request and then went silent — rust-analyzer still indexing a large
    /// repo, for one — froze the whole agent turn FOREVER, with no error and no
    /// retry hook. Inside an explore that surfaced as "hangs after a tool call".
    /// A channel lets every wait below carry a real deadline, and a dead server
    /// disconnects it instead of blocking.
    rx: std::sync::mpsc::Receiver<Value>,
    /// Set by the reader thread the moment it stops (the server closed stdout or
    /// the process died).
    ///
    /// Used as the registry's reuse probe. A channel can be probed for
    /// disconnection only with `try_recv`, which would SWALLOW a pending
    /// message — this flag cannot.
    dead: std::sync::Arc<std::sync::atomic::AtomicBool>,
    initialized: bool,
    /// Whether the `initialize` request has been WRITTEN yet.
    ///
    /// A cold start on a big workspace can outlast its budget; the retry then
    /// resumes draining for the answer to the request already in flight instead
    /// of restarting the handshake (servers ignore a second `initialize`).
    initialize_sent: bool,
    /// Open documents: uri -> (version, on-disk signature). The signature is
    /// what makes a STALE open document detectable — see `ensure_open`.
    open_docs: HashMap<String, (u64, (u64, u64))>,
    /// When a call last used this server. Drives idle eviction so a long session
    /// that opens many projects does not keep a language-server process — with
    /// its whole project index in memory — alive for every one of them.
    last_used: Instant,
    /// The language this server serves.
    ///
    /// Needed by `initialize` to pick per-server options (a heavy server is
    /// configured differently) and by callers that must know whether they are
    /// talking to a heavyweight index before waiting on it.
    language: String,
}

impl Server {
    fn spawn(root: &Path, language: &str) -> Result<Server, String> {
        let cmd = server_command(language)
            .ok_or_else(|| format!("no language server registered for {language}"))?;
        let path_env = augmented_path();
        let program = resolve_binary(&cmd[0], &path_env);
        let mut process = Command::new(&program)
            .args(&cmd[1..])
            .env("PATH", &path_env)
            // Cap the cargo/rustc subprocesses a check or build-script run can
            // start. rust-analyzer spawns them by the dozen on a big workspace
            // and each one is a full compiler; unbounded, they were the source
            // of the multi-GB spikes that made this app look like a leak.
            .env("CARGO_BUILD_JOBS", "2")
            // Bound the V8 heap of node-based servers. `typescript-language-server`
            // forks tsserver, and tsserver holds the whole project index; without a
            // cap V8 lets its heap grow until macOS swaps (measured 578 MB on this
            // workspace). This is the same knob VS Code exposes as
            // `maxTsServerMemory` (its default is ~3 GB): no feature is lost —
            // diagnostics, hover and rename all still work, the GC merely runs
            // earlier. 1 GB leaves generous headroom above every RSS sample we
            // have taken while still halving the pathological peak. Ignored by
            // non-node servers (rust-analyzer is a native binary). Appended to any
            // NODE_OPTIONS the user already set, never replacing it.
            .env("NODE_OPTIONS", node_options_with_heap_cap())
            .current_dir(root)
            // Give the server its OWN process group so it dies with everything it
            // spawns. A language server is a launcher: `typescript-language-server`
            // forks `tsserver`, and that child is where the project index lives
            // (measured ~294 MB for one workspace). Without a group, killing the
            // launcher orphaned the child, so the memory was never released — and
            // the orphan kept a whole workspace index resident for good.
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!(
                    "LSP unavailable: could not start {} ({e}) — the language server is not installed or not on PATH. Use grep + read for {language} files instead of retrying.",
                    cmd[0]
                )
            })?;
        let stdin = process.stdin.take().ok_or("no stdin")?;
        let stdout = process.stdout.take().ok_or("no stdout")?;
        // The reader thread owns stdout and pushes parsed messages. When the
        // server dies or closes its stream the channel disconnects, so every
        // wait below reports a closed stream instead of hanging on a pipe.
        //
        // BOUNDED on purpose — see NOTIFY_QUEUE: an unbounded queue grew with
        // every notification the server produced while nobody was listening.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Value>(NOTIFY_QUEUE);
        let dead = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let dead_reader = std::sync::Arc::clone(&dead);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(msg) = read_message(&mut reader) {
                // A message carrying an `id` is something a call is WAITING for
                // (a response) or something the server WAITS on us for (a
                // server->client request): sent with a blocking send so it is
                // never dropped. Everything else is advisory (progress,
                // diagnostics, logMessage) — if the queue is full nobody is
                // listening, so dropping it is exactly the intent of the bound.
                let needed = msg.get("id").is_some();
                let keep_reading = if needed {
                    tx.send(msg).is_ok()
                } else {
                    match tx.try_send(msg) {
                        Ok(()) => true,
                        // Full: nobody is reading right now — drop this one.
                        Err(std::sync::mpsc::TrySendError::Full(_)) => true,
                        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
                    }
                };
                if !keep_reading {
                    break;
                }
            }
            // The stream ended: the registry must stop handing this server out.
            dead_reader.store(true, Ordering::Relaxed);
        });
        Ok(Server {
            child: process,
            stdin,
            rx,
            dead,
            initialized: false,
            initialize_sent: false,
            open_docs: HashMap::new(),
            last_used: Instant::now(),
            language: language.to_string(),
        })
    }

    /// Wait up to `timeout` for the next message from the server.
    ///
    /// Bounded on purpose — see the `rx` field. `"timed out"` means the server
    /// stayed silent for the whole window; `"server closed the stream"` means
    /// the reader thread ended (the process died or closed stdout).
    fn next_message(&self, timeout: Duration) -> Result<Value, String> {
        // Served in small slices that each refresh the global heartbeat: a cold
        // server legitimately answers nothing for minutes, and without the
        // heartbeat the agent's idle guard would read that as a wedged turn.
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("timed out".to_string());
            }
            touch();
            match self.rx.recv_timeout(remaining.min(LSP_PULSE_SLICE)) {
                Ok(msg) => return Ok(msg),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("server closed the stream".into())
                }
            }
        }
    }

    /// Whether this server can no longer answer AT ALL.
    ///
    /// A server that is merely SLOW is not dead and must be kept: it is still
    /// building its index, and discarding it means paying the whole cold start
    /// again on the next call — the reason LSP never became fast.
    fn is_dead(&mut self) -> bool {
        if self.dead.load(Ordering::Relaxed) {
            return true;
        }
        // Err = we cannot tell; assume alive so a transient probe failure never
        // throws away a warm server.
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(false)
    }

    /// Answer a server->client request so the server is never left waiting on
    /// us.
    ///
    /// rust-analyzer sends `workspace/configuration`,
    /// `client/registerCapability` and `window/workDoneProgress/create` while it
    /// loads. Unanswered, IT blocks — which the user sees as OUR request being
    /// slow, with no error anywhere.
    fn answer_server_request(&mut self, msg: &Value) {
        let Some(rid) = msg.get("id") else { return };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        let result = if method == "workspace/configuration" {
            // One null per requested section: the server then falls back to its
            // own defaults instead of waiting for answers that never come.
            let n = msg
                .pointer("/params/items")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            Value::Array(vec![Value::Null; n])
        } else {
            Value::Null
        };
        let _ = write_message(
            &mut self.stdin,
            &json!({"jsonrpc": "2.0", "id": rid, "result": result}),
        );
    }

    /// Send a request and return its id WITHOUT waiting for the response.
    ///
    /// Used by `diagnostics`, which only wants to trigger the server and then
    /// listen for a short window; waiting for the response would make that
    /// best-effort call block for the full request budget against a server that
    /// may not implement pull diagnostics at all.
    fn request_nowait(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = next_id();
        write_message(
            &mut self.stdin,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )?;
        Ok(id)
    }

    /// Consume whatever has ALREADY arrived, without ever blocking.
    ///
    /// Called before writing a request (which can be large — `didOpen` sends the
    /// whole file). Because the queue is bounded, a full one leaves the reader
    /// thread parked on its send; draining here lets it resume reading stdout, so
    /// the server cannot end up blocked on its own output while we are blocked
    /// writing to its stdin — the classic pipe deadlock. Server->client requests
    /// seen here are answered like anywhere else, so nothing is lost by draining.
    fn drain_pending(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            if msg.get("method").is_some() && msg.get("id").is_some() {
                self.answer_server_request(&msg);
            }
        }
    }

    fn initialize(&mut self, root: &Path) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        let root_uri = path_to_uri(root);
        // Per-server initialization options. A language not listed here gets
        // none and keeps its own defaults.
        //
        // HISTORY: these options used to switch off rust-analyzer's
        // `diagnostics` and `cargo.buildScripts`, plus an `lruCapacity` cut, to
        // save memory. That was the wrong fix — both of those CHANGE WHAT THE
        // USER GETS (no diagnostics for Rust files at all, and no analysis of
        // the build-script / proc-macro generated code a Tauri project is full
        // of), and the LRU cut traded resident memory for repeated re-parses.
        // They are gone: full analysis quality is the priority.
        //
        // The real leak was LIFETIME, not configuration: `prewarm` started a
        // server for every project ever opened and each agent turn refreshed its
        // idle timer, so a 1921 MB index lived forever. That is fixed in the
        // lifecycle policy (`HEAVY_LANGUAGES`, `should_prewarm`,
        // `LSP_HEAVY_IDLE_TTL`), so a heavy server now costs memory only while
        // it is actually in use.
        //
        // `cachePriming` is the one entry that stays off: it changes no answer
        // at all — it is a speculative pre-build of the whole dependency graph
        // and the single biggest measured allocation. On-demand analysis
        // produces identical results, just without the eager warm-up.
        let initialization_options = if self.language == "rust" {
            json!({
                // Skip the initial "cache priming" scan: it walks the whole
                // workspace before the first query and was a large part of the
                // multi-GB spikes. Nothing user-visible depends on it.
                "cachePriming": { "enable": false },
                // Cap the parallel-query worker pool instead of one thread per
                // core: each worker holds part of the query arena, and the peak
                // (measured 2 GB) scaled with it. 4 keeps hover/rename fast on
                // an 8-core machine while halving the worst-case arena.
                "numThreads": 4,
                // Keep the query LRU at its documented default so caching
                // behaviour (and therefore responsiveness) is unchanged.
                "lru": { "capacity": 128 },
                // Pinned explicitly on purpose: these are the features the
                // caps above must never degrade.
                "diagnostics": { "enable": true },
                "procMacro": { "enable": true },
                "cargo": { "buildScripts": { "enable": true } },
            })
        } else {
            Value::Null
        };
        let params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "initializationOptions": initialization_options,
            "capabilities": initialize_capabilities(),
        });
        // Send the handshake request only ONCE per process: a later retry must
        // keep draining for the answer to the request already in flight rather
        // than restart the handshake (servers ignore a second `initialize`).
        if !self.initialize_sent {
            write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "id": next_id(), "method": "initialize", "params": params}))?;
            self.initialize_sent = true;
        }
        // Drain responses until the matching initialize result arrives. A cold
        // rust-analyzer runs `cargo metadata` first and legitimately says
        // nothing for minutes — it is loading, not stuck — so this waits on its
        // own budget and never kills the process (doing so threw away the load
        // that had already happened).
        let deadline = Instant::now() + INITIALIZE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("LSP server did not finish starting (initialize timed out) — it may still be indexing; retry, or use grep + read for now".into());
            }
            let msg = self.next_message(remaining).map_err(|e| {
                if e == "timed out" {
                    "LSP server did not finish starting (initialize timed out) — it may still be indexing; retry, or use grep + read for now".to_string()
                } else {
                    e
                }
            })?;
            // A server->client request also carries an `id` (and a `method`);
            // only a method-less message is the initialize response.
            if msg.get("id").is_some() && msg.get("method").is_none() {
                break;
            }
            // It may ask US something while loading (configuration, capability
            // registration): unanswered, it waits on us instead of us on it.
            if msg.get("id").is_some() && msg.get("method").is_some() {
                self.answer_server_request(&msg);
            }
        }
        write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}))?;
        self.initialized = true;
        Ok(())
    }

    /// Make sure the server has the CURRENT text of `abs`.
    ///
    /// Returns whether a `didOpen` was sent, i.e. whether this is the server's
    /// FIRST sight of the file. That is not a detail: MEASURED (probe against
    /// `typescript-language-server` on a real workspace file) a first lint after
    /// `didOpen` takes 1.99s while a re-lint after `didChange` takes 0.40s, so a
    /// caller that budgets the same window for both inevitably drops every
    /// first-time answer.
    fn ensure_open(&mut self, abs: &Path) -> Result<bool, String> {
        self.drain_pending();
        let uri = path_to_uri(abs);
        let sig = file_sig(abs);
        // An already-open document is re-checked against the DISK before it is
        // trusted. `didOpen` used to be sent once and never revisited, so after
        // the agent's own `edit_file` every later definition / references /
        // diagnostics call was answered about the PRE-EDIT text — a silent
        // quality loss (the server described a file that no longer existed).
        if let Some((version, prev)) = self.open_docs.get(&uri).copied() {
            if prev == sig {
                return Ok(false);
            }
            let text = std::fs::read_to_string(abs)
                .map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
            let next = version + 1;
            write_message(&mut self.stdin, &json!({
                "jsonrpc": "2.0", "method": "textDocument/didChange",
                "params": {
                    "textDocument": {"uri": uri, "version": next},
                    "contentChanges": [{"text": text}]
                }
            }))?;
            self.open_docs.insert(uri, (next, sig));
            return Ok(false);
        }
        if self.open_docs.len() >= MAX_OPEN_DOCS {
            // Evict an arbitrary open doc to stay bounded.
            if let Some(old) = self.open_docs.keys().next().cloned() {
                let _ = write_message(&mut self.stdin, &json!({
                    "jsonrpc": "2.0", "method": "textDocument/didClose",
                    "params": {"textDocument": {"uri": old}}
                }));
                self.open_docs.remove(&old);
            }
        }
        let text = std::fs::read_to_string(abs)
            .map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        let language_id = language_id_for_suffix(
            abs.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default()
                .as_str(),
        )
        .to_string();
        write_message(&mut self.stdin, &json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {"textDocument": {"uri": uri, "languageId": language_id, "version": 1, "text": text}}
        }))?;
        self.open_docs.insert(uri, (1, sig));
        Ok(true)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.drain_pending();
        let id = next_id();
        write_message(&mut self.stdin, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("{method} timed out"));
            }
            let msg = self.next_message(remaining).map_err(|e| {
                if e == "timed out" {
                    // Do NOT kill the server: a timeout usually means it is still
                    // loading/building its index, and a fresh process would just
                    // start that over — which is exactly why LSP never got warm.
                    // The late response is not a desync risk: every message we
                    // send carries its own id and unmatched ones are skipped.
                    format!("{method} timed out after {}s — the language server is still indexing; retry, or use grep + read for now", REQUEST_TIMEOUT.as_secs())
                } else {
                    e
                }
            })?;
            // Server->client requests (workDoneProgress/create, registerCapability)
            // use their own id counter and can collide with ours: require a
            // method-less message so one is never mistaken for our response.
            if msg.get("id").and_then(Value::as_u64) == Some(id) && msg.get("method").is_none() {
                if let Some(err) = msg.get("error") {
                    return Err(format!("server error: {err}"));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
            // Anything the server ASKS us (workspace/configuration, capability
            // registration, work-done progress) must be answered, or the server
            // blocks waiting for us and every later request looks slow.
            if msg.get("id").is_some() && msg.get("method").is_some() {
                self.answer_server_request(&msg);
            }
            // Notifications (publishDiagnostics etc.) are skipped.
        }
    }
}

/// Cheap on-disk fingerprint (mtime + length) of a file, or `(0, 0)` when it
/// cannot be stat'd.
///
/// Used by `Server::ensure_open` to notice that the file changed under an OPEN
/// document. Content is not hashed: this runs before every LSP call, and an
/// mtime+length pair moves on any real edit while costing one `stat`.
fn file_sig(abs: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(abs) else {
        return (0, 0);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (mtime, meta.len())
}

impl Drop for Server {
    fn drop(&mut self) {
        // Signal the whole process GROUP, not just the direct child.
        //
        // `typescript-language-server` is a thin Node wrapper that spawns a
        // `tsserver` child — and the CHILD is the one holding the project index
        // (hundreds of MB). `Child::kill()` signals only the wrapper, so the real
        // memory holder was left running as an orphan: measured on macOS, killing
        // the wrapper released ~15 MB and leaked ~450 MB across two orphaned
        // tsservers. The server is spawned as its own group leader
        // (`process_group(0)` in `spawn`), so a group signal reaches it and every
        // child it started. `Child::kill()` is kept as the fallback for the case
        // where the group signal finds nothing (already-dead group).
        let pgid = self.child.id() as i32;
        // SAFETY: `kill(2)` takes plain integers (pid/pgid + signal). A negative
        // pid signals the process group with that id. When the child is already
        // gone this fails harmlessly with ESRCH.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn path_to_uri(path: &Path) -> String {
    // file:///abs/path with percent-encoding kept minimal (spaces only) —
    // servers accept unencoded UTF-8 paths.
    let s = path.to_string_lossy().replace(' ', "%20");
    format!("file://{s}")
}

/// The `capabilities` the client declares at `initialize`.
///
/// MEASURED against `typescript-language-server` with a real workspace file and a
/// 2x2 factor matrix (capabilities vs the answers given to server->client
/// requests), same `didOpen` every time:
///
/// | declared capabilities                        | first `publishDiagnostics` |
/// |----------------------------------------------|----------------------------|
/// | `documentSymbol` only (what this client sent) | **never** (10s window)     |
/// | `+ textDocument.publishDiagnostics`           | 0.00s                      |
/// | `+ textDocument.synchronization`              | never                      |
/// | `+ workspace.configuration/workspaceFolders`  | never                      |
///
/// So the push is gated on the CLIENT declaring `publishDiagnostics`: without it
/// the server stays silent no matter how the client answers its requests, which
/// is why the post-edit diagnostics lever fired on only 3 of 99 traced edits and
/// even an explicit `lsp_diagnostics` was told "no report arrived". Declaring a
/// capability that was already required to RECEIVE these notifications costs
/// nothing and starts no work — the server simply keeps doing what it did.
fn initialize_capabilities() -> Value {
    json!({
        "textDocument": {
            // Without hierarchicalDocumentSymbolSupport servers answer
            // documentSymbol with flat SymbolInformation (handled in `symbols`).
            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
            "publishDiagnostics": { "relatedInformation": true },
        },
    })
}

/// Per-root singleton: (root realpath) -> language -> server.
#[derive(Default)]
pub struct LspRegistry {
    roots: Mutex<HashMap<PathBuf, HashMap<String, Arc<Mutex<Server>>>>>,
    /// Roots already pre-warmed, so `prewarm` costs one directory walk per
    /// project instead of one per turn.
    warmed: Mutex<std::collections::HashSet<PathBuf>>,
}

impl LspRegistry {
    /// The existing server for `root`+`language`, but ONLY if it is live right
    /// now — never starts one.
    ///
    /// Used by the automatic post-edit diagnostics, where a cold start would be
    /// a stall (see `lsp::diagnostics_if_warm`): the edit is cheap, so anything
    /// that costs a project index must be skipped and left to the model.
    fn warm_server(&self, root: &Path, language: &str) -> Option<Arc<Mutex<Server>>> {
        let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let entry = {
            let roots = self.roots.lock().unwrap();
            roots.get(&key).and_then(|langs| langs.get(language)).cloned()
        }?;
        // A held lock means another call is inside a request: BUSY is exactly a
        // warm, working server, so probing must not block. Only a dead one is
        // refused here.
        let alive = match entry.try_lock() {
            Ok(mut guard) => {
                guard.last_used = Instant::now();
                !guard.is_dead()
            }
            Err(std::sync::TryLockError::Poisoned(_)) => false,
            Err(std::sync::TryLockError::WouldBlock) => true,
        };
        alive.then_some(entry)
    }
    /// Acquire exclusive use of a root+language server within `SERVER_LOCK_WAIT`.
    ///
    /// A timeout keeps the server: the holder is almost always a HEALTHY call
    /// still inside a long request on a cold server, and `spawn_blocking` calls
    /// cannot be cancelled, so that thread finishes and releases on its own.
    /// Discarding the server here was the reason LSP never got warm — the next
    /// call spawned a fresh process and paid the whole cold start again, and
    /// every attempt after that stacked behind the same abandoned thread. Only a
    /// genuinely DEAD server is dropped, so a warm index is never thrown away.
    fn lock_server<'a>(
        &self,
        root: &Path,
        language: &str,
        srv: &'a Arc<Mutex<Server>>,
    ) -> Result<std::sync::MutexGuard<'a, Server>, String> {
        if let Some(mut guard) = lock_bounded(srv, SERVER_LOCK_WAIT) {
            // Refresh the idle clock: this is what tells the eviction pass
            // (`prune_idle`) that the project is in active use and must stay warm.
            guard.last_used = Instant::now();
            return Ok(guard);
        }
        // Never BLOCK on the probe: a held lock means "busy", and busy means
        // alive — which is exactly the server we want to keep warm.
        let dead = match srv.try_lock() {
            Ok(mut guard) => guard.is_dead(),
            Err(std::sync::TryLockError::Poisoned(_)) => true,
            Err(std::sync::TryLockError::WouldBlock) => false,
        };
        if !dead {
            return Err(format!(
                "the language server is still busy with an earlier request (it may be indexing the project) — retry this call; it will be much faster once the index is ready"
            ));
        }
        let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if let Some(langs) = self.roots.lock().unwrap().get_mut(&key) {
            // Only drop it if it is still the exact server we failed to lock:
            // another thread may already have replaced the entry.
            let stale = langs
                .get(language)
                .is_some_and(|cur| Arc::ptr_eq(cur, srv));
            if stale {
                langs.remove(language);
            }
        }
        Err(format!(
            "the language server died while loading the project and was replaced — retry this call"
        ))
    }

    /// Drop servers that have been UNUSED for `LSP_IDLE_TTL`.
    ///
    /// Called on a workspace switch. Every server holds its project's index in
    /// memory (rust-analyzer: hundreds of MB to a couple of GB), so without this
    /// a long session that opens many projects keeps one process per project
    /// forever — the memory leak that made the agent's footprint grow all day.
    /// The TTL keeps the projects you actually switch between warm; only
    /// abandoned ones are released, and a released project cold-starts again on
    /// the next call.
    pub fn prune_idle(&self) {
        let now = Instant::now();
        let mut evicted: Vec<PathBuf> = Vec::new();
        {
            let mut roots = self.roots.lock().unwrap();
            for (key, langs) in roots.iter_mut() {
                langs.retain(|language, srv| {
                    // A heavy server (rust-analyzer: ~1.9 GB measured) is given a
                    // much shorter idle TTL. Keyed on the LANGUAGE, which is this
                    // map's key — the old `|_, srv|` ignored it, so every server
                    // got the same ten minutes no matter what it cost.
                    let ttl = if is_heavy_language(language) {
                        LSP_HEAVY_IDLE_TTL
                    } else {
                        LSP_IDLE_TTL
                    };
                    match srv.try_lock() {
                        Ok(mut guard) => {
                            !guard.is_dead() && now.duration_since(guard.last_used) < ttl
                        }
                        // Could not lock it: it is BUSY, so it is in use — keep it.
                        Err(std::sync::TryLockError::WouldBlock) => true,
                        // A POISONED mutex means a panicking LSP call left the server
                        // unusable — it can never serve again, so evict it (the same
                        // call `lock_server` makes).
                        Err(std::sync::TryLockError::Poisoned(_)) => false,
                    }
                });
                if langs.is_empty() {
                    evicted.push(key.clone());
                }
            }
            roots.retain(|_, langs| !langs.is_empty());
        }
        // Forget the pre-warmed marker too, or reopening an evicted project would
        // be deduped into a no-op and never re-warm.
        if !evicted.is_empty() {
            let mut warmed = self.warmed.lock().unwrap();
            for key in evicted {
                warmed.remove(&key);
            }
        }
    }

    fn server_for(&self, root: &Path, language: &str) -> Result<Arc<Mutex<Server>>, String> {
        let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        // Fast path: hand back an existing live server and release the registry
        // lock immediately. A cold start in another thread (the pre-warm) must
        // never block this call — that would put the whole cold-start cost back
        // in the caller's path, which is the thing pre-warming exists to avoid.
        let existing = {
            let roots = self.roots.lock().unwrap();
            roots
                .get(&key)
                .and_then(|langs| langs.get(language))
                .cloned()
        };
        if let Some(existing) = existing {
            // Never BLOCK here — see SERVER_PROBE_WAIT. The handshake is finished
            // while we ALREADY hold the lock: re-locking afterwards would be one
            // more unbounded wait.
            let usable = match lock_bounded(&existing, SERVER_PROBE_WAIT) {
                Some(mut guard) => {
                    // A slow server is still a WARM server: killing it on a
                    // timeout meant every later call paid the cold start again,
                    // so only a genuinely dead one (process gone, stdout
                    // closed) is replaced.
                    if guard.is_dead() {
                        false
                    } else {
                        // Registered by a call whose handshake is still in
                        // flight: finish THAT handshake instead of spawning a
                        // second process. `initialize_sent` makes this a pure
                        // drain, so the loading already done is not thrown away.
                        // An error here leaves the server registered, so the
                        // next call resumes the same handshake.
                        if !guard.initialized {
                            guard.initialize(root)?;
                        }
                        // Refresh the idle clock. This is the COMMON path for an
                        // already-warm server, and without it an actively used
                        // server could be reaped as idle by `prune_idle`.
                        guard.last_used = Instant::now();
                        true
                    }
                }
                // Could not lock it quickly: a BUSY server is a live one, almost
                // certainly running its own handshake right now. Hand it back;
                // `lock_server`'s bounded wait covers it.
                None => true,
            };
            if usable {
                return Ok(existing);
            }
        }
        // Slow path: spawn + initialize WITHOUT holding the registry lock. A
        // cold rust-analyzer takes minutes to answer `initialize`, and holding
        // the lock across it would freeze every other call on this registry.
        //
        // But the spawn must still be SINGLE-FLIGHT per (root, language). Reading
        // the registry, releasing the lock, spawning and inserting is a
        // check-then-act race: two callers (the pre-warm thread plus a tool call,
        // measured happening 3s apart) both missed the entry, both spawned, and
        // the second insert silently overwrote the first `Arc` — leaving TWO live
        // servers for one workspace, with the loser invisible to `prune_idle`. On
        // the real profile that meant two `typescript-language-server` wrappers,
        // four `tsserver` children and ~470 MB of node RSS for a single project.
        // This guard serialises only the spawn+insert pair; the handshake below
        // still runs outside it, so a cold start never blocks another language.
        let srv = {
            let _spawn_guard = LSP_SPAWN_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Re-check under the guard: while we waited, the other thread may have
            // finished spawning exactly this server.
            let raced = self
                .roots
                .lock()
                .unwrap()
                .get(&key)
                .and_then(|l| l.get(language))
                .cloned();
            if let Some(existing) = raced {
                let usable = match lock_bounded(&existing, SERVER_PROBE_WAIT) {
                    Some(mut guard) => !guard.is_dead(),
                    None => true,
                };
                if usable {
                    return Ok(existing);
                }
            }
            let srv = Arc::new(Mutex::new(Server::spawn(root, language)?));
            // Register BEFORE the handshake. A cold start on a large workspace can
            // outlast even a generous budget, and dropping the server there threw
            // away every second of loading already done — the next call then paid
            // the whole cold start again, which is what kept LSP from ever getting
            // warm. Registered, the retry resumes draining the handshake already in
            // flight (see `initialize_sent`).
            {
                let mut roots = self.roots.lock().unwrap();
                roots
                    .entry(key)
                    .or_default()
                    .insert(language.to_string(), srv.clone());
            }
            srv
            // Guard released HERE: the handshake below must not hold it.
            // A cold rust-analyzer takes minutes, and the guard is global, so
            // keeping it here serialised every spawn in the app behind one slow
            // server — the pre-warm thread blocked tool calls for other
            // languages. The pair that actually needed protecting (spawn +
            // insert) is inside this block.
        };
        // BOUNDED lock, like every other per-server wait: an unbounded `.lock()`
        // here could block a turn forever (and panic on a poisoned mutex). A
        // failed handshake leaves the server registered, so the next call resumes
        // it instead of paying the cold start again.
        {
            let mut guard = lock_bounded(&srv, SERVER_LOCK_WAIT).ok_or_else(|| {
                "the language server is still busy starting up — retry this call".to_string()
            })?;
            guard.initialize(root)?;
            guard.last_used = Instant::now();
        }
        Ok(srv)
    }
}

/// Poll for `srv`'s lock until `budget` expires, refreshing the LSP heartbeat.
///
/// The heartbeat matters as much as the budget: a cold language server is SLOW
/// but HEALTHY (it says nothing for minutes while loading), and without it the
/// agent's idle guard would abort a perfectly good cold start. Waiting is
/// progress, so it counts as activity.
fn lock_bounded<'a>(
    srv: &'a Arc<Mutex<Server>>,
    budget: Duration,
) -> Option<std::sync::MutexGuard<'a, Server>> {
    let deadline = Instant::now() + budget;
    loop {
        if let Ok(guard) = srv.try_lock() {
            return Some(guard);
        }
        touch();
        if Instant::now() >= deadline {
            return None;
        }
        // Short sleeps so a release is noticed promptly; `try_lock` is the only
        // way to give up on a `std::sync::Mutex`.
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The process-wide registry (a `OnceLock` so it is reachable from shutdown).
static REGISTRY: std::sync::OnceLock<LspRegistry> = std::sync::OnceLock::new();

fn registry() -> &'static LspRegistry {
    REGISTRY.get_or_init(LspRegistry::default)
}

/// Release language servers that have not been used for a while.
///
/// Called whenever a workspace is (re)opened, so switching projects gives back
/// the memory held by the ones you left. See `LspRegistry::prune_idle`.
pub fn prune_idle() {
    registry().prune_idle();
}

/// Kill EVERY language server and forget the registry.
///
/// Called on app shutdown. Nothing used to release them on exit: the registry
/// lives in a `OnceLock` for the life of the process, so its `Arc`s were never
/// dropped and `impl Drop for Server` never ran. The servers then outlived the
/// window as orphans — and a language server is the single largest thing this app
/// keeps off-process (one `tsserver` held ~294 MB, `rust-analyzer` more), so an
/// exit that left them behind looked exactly like a memory leak in the app.
pub fn shutdown_all() {
    let Some(reg) = REGISTRY.get() else {
        return;
    };
    // Take the map out from under the lock, then let the values drop OUTSIDE it:
    // `Drop for Server` waits on the child, which must never happen while the
    // registry lock is held (the idle reaper would block behind it).
    let taken = {
        let mut roots = match reg.roots.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        std::mem::take(&mut *roots)
    };
    drop(taken);
}

/// Start the background idle reaper for language servers.
///
/// `prune_idle` used to run ONLY on a workspace switch, so a session that
/// simply stops using a project (the user moves on to another app, or just
/// stops making LSP calls) kept every language server — with each project's
/// full index in memory — alive until one of those rare events happened. This
/// sweeps on a timer instead, so the memory comes back on its own.
///
/// Idempotent: the spawned-once guard means repeated calls are a no-op.
pub fn start_idle_reaper() {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    const SWEEP: Duration = Duration::from_secs(60);
    std::thread::spawn(move || loop {
        std::thread::sleep(SWEEP);
        // A panicking prune must never kill the reaper for the rest of the
        // process — language servers would then never be released again.
        let _ = std::panic::catch_unwind(|| registry().prune_idle());
    });
}

/// Start a workspace's language servers in the BACKGROUND.
///
/// The first `lsp_*` call in a project otherwise pays the whole cold start:
/// process spawn, `initialize` (rust-analyzer runs `cargo metadata` and loads
/// the crate graph before it answers) and the first `didOpen`. Pre-warming moves
/// that cost into the model's own thinking time, so the first LSP call of a turn
/// usually finds an already-loaded server.
///
/// Best-effort by design: a missing binary or a failed start is ignored here —
/// the tool call itself still reports the real error. One walk per project per
/// process.
pub fn prewarm(root: &str) {
    // Every workspace switch is the natural moment to give back the memory of
    // projects that are no longer in use — that is where the footprint of a long
    // session used to grow without bound.
    prune_idle();
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return;
    }
    let key = root_path
        .canonicalize()
        .unwrap_or_else(|_| root_path.clone());
    {
        let mut warmed = registry().warmed.lock().unwrap();
        if !warmed.insert(key) {
            return;
        }
    }
    std::thread::spawn(move || {
        // Background thread: its LSP waits are NOT the agent's attempt making
        // progress, so they must not refresh the activity the idle guard polls.
        QUIET.with(|q| q.set(true));
        let mut langs: Vec<&'static str> = Vec::new();
        collect_languages(&root_path, 0, &mut langs);
        for language in langs {
            // Never PRE-WARM a server that costs more than it saves: a heavy one
            // measured 1921 MB (`rust-analyzer`) and `pylsp` measured 158 MB,
            // while most sessions never make a single LSP call. A real LSP tool
            // call still starts them on demand (`server_for`).
            if !should_prewarm(language) {
                continue;
            }
            // `server_for` spawns AND initializes; the registry then keeps that
            // server warm for every later call in this process.
            let _ = registry().server_for(&root_path, language);
        }
    });
}

/// Languages present in a shallow, dependency-skipping walk of `dir`.
///
/// Ordered by discovery and capped: each language is a real process to start,
/// so a project with a stray `.rb` in a fixture must not pay for a Ruby server.
fn collect_languages(dir: &Path, depth: usize, out: &mut Vec<&'static str>) {
    const MAX_SERVERS: usize = 3;
    const MAX_DEPTH: usize = 3;
    const SKIP_DIRS: [&str; 7] = [
        "node_modules", "target", ".git", "dist", "build", ".venv", "vendor",
    ];
    // Config/markup servers are cheap to start on demand and otherwise just
    // consume a process; pre-warm the languages that actually have to index.
    const SKIP_LANGS: [&str; 6] = ["json", "yaml", "toml", "markdown", "html", "css"];
    if depth > MAX_DEPTH || out.len() >= MAX_SERVERS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SERVERS {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_languages(&path, depth + 1, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if let Some(language) = language_for_suffix(&format!(".{ext}")) {
                if !out.contains(&language) && !SKIP_LANGS.contains(&language) {
                    out.push(language);
                }
            }
        }
    }
}

// --- shared helpers -----------------------------------------------------------

fn detect_language(abs: &Path) -> Result<&'static str, String> {
    let suffix = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    language_for_suffix(&suffix)
        .ok_or_else(|| format!("no language server for {suffix} files"))
}

fn position_of(line: i64, character: i64) -> Value {
    json!({"line": line.saturating_sub(1).max(0), "character": character.max(0)})
}

fn uri_to_path(uri: &str) -> PathBuf {
    PathBuf::from(uri.strip_prefix("file://").unwrap_or(uri).replace("%20", " "))
}

fn fmt_location(loc: &Value) -> Option<(String, u32, u32)> {
    let uri = loc.get("uri").or_else(|| loc.get("targetUri"))?.as_str()?;
    let range = loc.get("range").or_else(|| loc.get("targetSelectionRange"))?;
    let line = range.pointer("/start/line").and_then(Value::as_u64)? as u32 + 1;
    let ch = range.pointer("/start/character").and_then(Value::as_u64)? as u32;
    Some((uri_to_path(uri).display().to_string(), line, ch))
}

fn read_excerpt(path: &Path, start_line: u32, max_lines: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    content
        .lines()
        .skip((start_line.saturating_sub(1)) as usize)
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

// --- the five tools ------------------------------------------------------------

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_comment_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//") || t.starts_with('#') || t.starts_with('*') || t.starts_with("/*")
}

/// Locate `symbol` in `text` as a whole word. Returns (1-based line, UTF-16
/// character offset — the unit LSP positions use, so text before the symbol
/// may be Persian/emoji). When `hint_line` (1-based) contains the symbol that
/// occurrence wins; otherwise the first non-comment occurrence, then the first
/// occurrence anywhere.
pub fn find_symbol_position(text: &str, symbol: &str, hint_line: Option<i64>) -> Option<(i64, i64)> {
    if symbol.is_empty() {
        return None;
    }
    let occurrence = |line: &str| -> Option<i64> {
        for (idx, _) in line.match_indices(symbol) {
            let before = line[..idx].chars().next_back();
            let after = line[idx + symbol.len()..].chars().next();
            if before.map_or(true, |c| !is_ident_char(c)) && after.map_or(true, |c| !is_ident_char(c)) {
                return Some(line[..idx].encode_utf16().count() as i64);
            }
        }
        None
    };
    let lines: Vec<&str> = text.lines().collect();
    if let Some(h) = hint_line {
        if h >= 1 {
            if let Some(line) = lines.get((h - 1) as usize) {
                if let Some(col) = occurrence(line) {
                    return Some((h, col));
                }
            }
        }
    }
    let mut fallback: Option<(i64, i64)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(col) = occurrence(line) {
            if !is_comment_line(line) {
                return Some((i as i64 + 1, col));
            }
            if fallback.is_none() {
                fallback = Some((i as i64 + 1, col));
            }
        }
    }
    fallback
}

/// Resolve `symbol=` (what the model actually knows) to a (line, character)
/// position inside `file_path` for definition/references/hover.
pub fn locate_symbol(root: &str, file_path: &str, symbol: &str, hint_line: Option<i64>) -> Result<(i64, i64), String> {
    let abs = resolve_safe(root, file_path, true, None)?;
    let text = std::fs::read_to_string(&abs).map_err(|e| format!("cannot read {file_path}: {e}"))?;
    find_symbol_position(&text, symbol, hint_line).ok_or_else(|| {
        format!("symbol {symbol:?} not found in {file_path} — check the spelling, or grep for it first")
    })
}

/// lsp_definition: `path:line:character` hits; inline body for <= 3 hits.
pub fn definition(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = resolve_safe(root, file_path, true, None)?;
    let abs = PathBuf::from(abs);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = registry().lock_server(&root_path, language, &srv)?;
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": path_to_uri(&abs)}, "position": position_of(line, character)}),
    )?;
    let locs: Vec<Value> = match result {
        Value::Null => vec![],
        Value::Array(a) => a,
        v @ Value::Object(_) => vec![v],
        _ => vec![],
    };
    if locs.is_empty() {
        return Ok("No definition found.".into());
    }
    let mut out = Vec::new();
    for loc in locs.iter().filter_map(fmt_location) {
        out.push(format!("{}:{}:{}", loc.0, loc.1, loc.2));
    }
    if locs.len() <= 3 {
        for loc in locs.iter().filter_map(fmt_location) {
            let excerpt = read_excerpt(Path::new(&loc.0), loc.1, DEF_BODY_MAX_LINES);
            if !excerpt.is_empty() {
                out.push(String::new());
                out.push(excerpt);
            }
        }
    }
    Ok(out.join("\n"))
}

/// lsp_references: grouped by file, capped at 40 with inline source lines.
pub fn references(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = registry().lock_server(&root_path, language, &srv)?;
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/references",
        json!({
            "textDocument": {"uri": path_to_uri(&abs)},
            "position": position_of(line, character),
            "context": {"includeDeclaration": true},
        }),
    )?;
    let locs = result.as_array().cloned().unwrap_or_default();
    if locs.is_empty() {
        return Ok("No references found.".into());
    }
    let mut out = Vec::new();
    let mut inline = 0usize;
    for (i, loc) in locs.iter().enumerate() {
        if i >= REF_CAP {
            out.push(format!("(+{} more)", locs.len() - REF_CAP));
            break;
        }
        let Some((path, l, _c)) = fmt_location(loc) else { continue };
        let mut row = format!("{path}:{l}");
        if inline < REF_INLINE_CAP {
            let line_text = read_excerpt(Path::new(&path), l, 1);
            let line_text: String = line_text.chars().take(REF_INLINE_MAX_CHARS).collect();
            if !line_text.is_empty() {
                row.push_str(&format!("  {line_text}"));
            }
            inline += 1;
        }
        out.push(row);
    }
    Ok(out.join("\n"))
}

/// lsp_hover: raw hover text.
pub fn hover(root: &str, file_path: &str, line: i64, character: i64) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = registry().lock_server(&root_path, language, &srv)?;
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/hover",
        json!({"textDocument": {"uri": path_to_uri(&abs)}, "position": position_of(line, character)}),
    )?;
    let text = result
        .pointer("/contents/value")
        .or_else(|| result.pointer("/contents"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Ok("No hover info (server answered empty).".into());
    }
    Ok(text)
}

/// lsp_symbols: document symbols sorted by line, optional substring filter.
pub fn symbols(root: &str, file_path: &str, query: &str) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = registry().lock_server(&root_path, language, &srv)?;
    srv.ensure_open(&abs)?;
    let result = srv.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": path_to_uri(&abs)}}),
    )?;
    let syms = result.as_array().cloned().unwrap_or_default();
    if syms.is_empty() {
        return Ok("No symbols found.".into());
    }
    // Flatten nested children, sort by start line, filter, cap.
    let mut rows: Vec<(u64, u64, String, String)> = Vec::new();
    fn walk(nodes: &[Value], out: &mut Vec<(u64, u64, String, String)>) {
        for n in nodes {
            let name = n.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
            let kind = n
                .get("kind")
                .and_then(Value::as_u64)
                .map(symbol_kind_name)
                .unwrap_or_else(|| "?".into());
            // DocumentSymbol carries `range`; flat SymbolInformation (pylsp, or
            // any server without hierarchical support) nests it under
            // `location.range` — reading only `range` made every symbol L1-L1.
            let range = n.get("range").or_else(|| n.pointer("/location/range"));
            let start = range.and_then(|r| r.pointer("/start/line")).and_then(Value::as_u64).unwrap_or(0) + 1;
            let end = range.and_then(|r| r.pointer("/end/line")).and_then(Value::as_u64).unwrap_or(0) + 1;
            out.push((start, end, kind, name));
            if let Some(children) = n.get("children").and_then(Value::as_array) {
                walk(children, out);
            }
        }
    }
    walk(&syms, &mut rows);
    rows.sort_by_key(|r| r.0);
    let q = query.to_lowercase();
    let filtered: Vec<_> = rows
        .into_iter()
        .filter(|(_, _, _, name)| q.is_empty() || name.to_lowercase().contains(&q))
        .collect();
    if filtered.is_empty() {
        return Ok(format!("No symbols matching {query:?}."));
    }
    let total = filtered.len();
    let mut out = Vec::new();
    for (start, end, kind, name) in filtered.into_iter().take(SYMBOLS_CAP) {
        out.push(format!("- {kind} {name} (L{start}-{end})"));
    }
    if total > SYMBOLS_CAP {
        out.push(format!("(+{total} more)"));
    }
    Ok(out.join("\n"))
}

fn symbol_kind_name(kind: u64) -> String {
    let names = [
        "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
        "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
        "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
        "Event", "Operator", "TypeParameter",
    ];
    names
        .get(kind.saturating_sub(1) as usize)
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| format!("kind{kind}"))
}

/// lsp_diagnostics: publishDiagnostics for the target file.
pub fn diagnostics(root: &str, file_path: &str) -> Result<String, String> {
    diagnostics_within(root, file_path, DIAGNOSTICS_WINDOW)
}

/// Automatic post-edit diagnostics: ONLY when a server for that language is
/// already warm.
///
/// MEASURED: `lsp_diagnostics` was never called once in the traced corpus,
/// while the model ran 37 manual typecheck/build commands (12 of them in the
/// round right after an edit) — a whole round-trip each, on a question the
/// language server already has the answer to. Relying on the model to pick the
/// tool did not work (the same reason the prompt-level hints were refuted), so
/// the cheap case is decided in the backend instead: if the file's language
/// server is live, its diagnostics ride along with the edit result.
///
/// Crucially it NEVER starts a server: a cold start (rust-analyzer reached
/// 1921 MB and takes minutes to index) would turn a cheap edit into a stall, so
/// a cold language returns `None` and the model keeps its own build command.
pub fn diagnostics_if_warm(root: &str, file_path: &str) -> Option<String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None).ok()?);
    let language = detect_language(&abs).ok()?;
    registry().warm_server(&PathBuf::from(root), language)?;
    diagnostics_within(root, file_path, POST_EDIT_DIAGNOSTICS_WINDOW).ok()
}

fn diagnostics_within(
    root: &str,
    file_path: &str,
    budget: Duration,
) -> Result<String, String> {
    let abs = PathBuf::from(resolve_safe(root, file_path, true, None)?);
    let language = detect_language(&abs)?;
    let root_path = PathBuf::from(root);
    let srv = registry().server_for(&root_path, language)?;
    let mut srv = registry().lock_server(&root_path, language, &srv)?;
    // A FIRST `didOpen` lints the whole file (measured 1.99s against
    // `typescript-language-server`) while a re-lint after `didChange` answers in
    // 0.40s. Budgeting both the same made every FIRST edit of every file drop
    // its answer — exactly the case where nothing had checked that file yet.
    let first_open = srv.ensure_open(&abs)?;
    let budget = if first_open {
        budget.max(POST_EDIT_DIAGNOSTICS_WINDOW_COLD)
    } else {
        budget
    };
    let uri = path_to_uri(&abs);
    // Trigger a pull WITHOUT waiting for its response, then drain notifications
    // for a short window. Waiting for the response here would make this
    // best-effort call block for the full request budget on servers that do not
    // implement pull diagnostics at all.
    let _ = srv.request_nowait("textDocument/diagnostic", json!({"textDocument": {"uri": uri}}));
    let deadline = Instant::now() + budget;
    let mut diags: Vec<Value> = Vec::new();
    // Whether the server actually ANSWERED for this uri. Without this, a window
    // that expires while the server is still indexing was reported as "No
    // diagnostics." — indistinguishable from a clean file, so a turn that
    // trusted it would skip the real typecheck on code that does not compile.
    let mut reported = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match srv.next_message(remaining) {
            Ok(msg) => {
                // A server->client request seen here must be ANSWERED, not
                // discarded: an unanswered one leaves the server waiting on us
                // (and is the same reason `initialize`/`request` answer them).
                if msg.get("method").is_some() && msg.get("id").is_some() {
                    srv.answer_server_request(&msg);
                    continue;
                }
                if msg.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") {
                    let d_uri = msg.pointer("/params/uri").and_then(Value::as_str).unwrap_or("");
                    if d_uri == uri {
                        diags = msg
                            .pointer("/params/diagnostics")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        reported = true;
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !reported {
        return Ok(format!(
            "No diagnostics report arrived within {}s for {} — the language server may still be \
indexing, so this is NOT a clean result: treat the file as unchecked and run your own \
build/typecheck command for it.",
            budget.as_secs(),
            abs.display()
        ));
    }
    if diags.is_empty() {
        return Ok(format!(
            "No diagnostics for {} — the language server parsed it and reported no errors or \
warnings.",
            abs.display()
        ));
    }
    let severity_name = |s: u64| match s {
        1 => "error",
        2 => "warning",
        3 => "info",
        4 => "hint",
        _ => "diag",
    };
    let mut out = Vec::new();
    for d in diags {
        let line = d.pointer("/range/start/line").and_then(Value::as_u64).unwrap_or(0) + 1;
        let sev = d.get("severity").and_then(Value::as_u64).unwrap_or(0);
        let msg = d.get("message").and_then(Value::as_str).unwrap_or("");
        let source = d.get("source").and_then(Value::as_str).unwrap_or("");
        out.push(format!(
            "{}:{line} [{}] {msg} ({source})",
            abs.display(),
            severity_name(sev)
        ));
    }
    Ok(out.join("\n"))
}

// --- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A heavy server must be recognised from its registry key, must not be
    /// pre-warmed, and must get a shorter idle TTL than a light one.
    ///
    /// `rust-analyzer` measured 1921 MB of physical footprint for one workspace
    /// — twice the whole app's budget — while the app shell was 233 MB. Two
    /// things made it permanent: `prewarm` spawned one for every project ever
    /// opened, and the shared ten-minute idle TTL never expired for it because
    /// each agent turn's `prewarm` refreshed `last_used` through the fast path.
    #[test]
    fn heavy_servers_are_never_prewarmed_and_expire_sooner() {
        // The languages whose index is measured in gigabytes.
        for lang in ["rust", "c", "cpp", "java", "scala", "haskell", "dart", "csharp"] {
            assert!(is_heavy_language(lang), "{lang} must be heavy");
        }
        // The cheap ones this app pre-warms on purpose.
        for lang in ["typescript", "python", "json", "yaml", "bash"] {
            assert!(!is_heavy_language(lang), "{lang} must not be heavy");
        }
        // The short TTL must actually be shorter, or the policy is cosmetic.
        assert!(LSP_HEAVY_IDLE_TTL < LSP_IDLE_TTL);

        // Pre-warm is a latency/memory TRADE, decided by measured cost: the
        // cheap server stays warm, everything that costs more than the app shell
        // waits for a real call. `pylsp` measured 158 MB for one workspace.
        assert!(should_prewarm("typescript"));
        assert!(!should_prewarm("python"));
        for lang in HEAVY_LANGUAGES {
            assert!(!should_prewarm(lang), "{lang} must not be pre-warmed");
        }
    }

    /// A FIRST `didOpen` needs more budget than a re-lint, and the code must
    /// actually use the wider one.
    ///
    /// MEASURED with a real client against `typescript-language-server` on a
    /// workspace file: the first `publishDiagnostics` after `didOpen` arrived in
    /// 1.99s, the re-lint after `didChange` in 0.40s. The automatic post-edit
    /// window was 1.5s for both, so every FIRST edit of a file silently dropped
    /// its answer — the trace showed the marker on 2 of 56 edits, and only for
    /// files another call had opened earlier.
    #[test]
    fn a_first_open_gets_more_diagnostics_time_than_a_relint() {
        assert!(
            POST_EDIT_DIAGNOSTICS_WINDOW_COLD > POST_EDIT_DIAGNOSTICS_WINDOW,
            "the first-open window must be wider than the warm one, or the \
             measured 1.99s first lint is dropped again"
        );
        // The widening is bounded: this window rides on an EDIT result, so it may
        // never approach the explicit `lsp_diagnostics` budget (3s) — it is
        // allowed to match it at most.
        assert!(POST_EDIT_DIAGNOSTICS_WINDOW_COLD <= DIAGNOSTICS_WINDOW);
        // And it must stay above the measured 0.40s re-lint, so a warm answer is
        // never dropped either.
        assert!(POST_EDIT_DIAGNOSTICS_WINDOW >= Duration::from_millis(400));
    }

    /// The client MUST declare `publishDiagnostics`, or the server never pushes.
    ///
    /// MEASURED with a 2x2 factor matrix (declared capabilities x the answers
    /// given to server->client requests) against `typescript-language-server`,
    /// same `didOpen` every time: `documentSymbol`-only (what this client used to
    /// send) produced NO `publishDiagnostics` in a 10s window, adding
    /// `textDocument.publishDiagnostics` produced it in 0.00s, and adding
    /// `synchronization` or `workspace.configuration` changed nothing.
    ///
    /// The blast radius was measured on real traces: the post-edit lever fired on
    /// 3 of 99 edits and an explicit `lsp_diagnostics` answered "no report
    /// arrived" — a silent, permanent quality hole that read as a slow server.
    #[test]
    fn the_client_declares_the_capability_the_push_requires() {
        let caps = initialize_capabilities();
        assert_eq!(
            caps.pointer("/textDocument/publishDiagnostics/relatedInformation"),
            Some(&Value::Bool(true)),
            "without textDocument.publishDiagnostics the server pushes nothing"
        );
        // The one capability that was already there and is load-bearing for
        // `symbols`: flat SymbolInformation is unusable as an outline.
        assert_eq!(
            caps.pointer("/textDocument/documentSymbol/hierarchicalDocumentSymbolSupport"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn language_detection_matches_python_registry() {
        assert_eq!(language_for_suffix(".py"), Some("python"));
        assert_eq!(language_for_suffix(".tsx"), Some("typescript"));
        assert_eq!(language_for_suffix(".hpp"), Some("cpp"));
        assert_eq!(language_for_suffix(".yaml"), Some("yaml"));
        assert_eq!(language_for_suffix(".unknown"), None);
    }

    /// One PROCESS key per binary: `.js` and `.ts` share
    /// `typescript-language-server`, so both must resolve to the same registry
    /// key. With two keys the pre-warm started TWO servers (each with its own
    /// `tsserver` children) for a single root — ~470 MB of node RSS for one
    /// project.
    #[test]
    fn js_and_ts_share_one_server_key() {
        assert_eq!(language_for_suffix(".js"), language_for_suffix(".ts"));
        assert_eq!(language_for_suffix(".mjs"), Some("typescript"));
        assert_eq!(language_for_suffix(".cjs"), Some("typescript"));
        assert_eq!(language_for_suffix(".jsx"), Some("typescript"));
    }

    /// The protocol languageId is NOT the process key: a plain `.js` file must
    /// still be announced as JavaScript.
    #[test]
    fn js_language_id_stays_javascript() {
        assert_eq!(language_id_for_suffix(".js"), "javascript");
        assert_eq!(language_id_for_suffix(".mjs"), "javascript");
        assert_eq!(language_id_for_suffix(".cjs"), "javascript");
        assert_eq!(language_id_for_suffix(".jsx"), "javascriptreact");
    }

    #[test]
    fn language_id_uses_vscode_identifiers() {
        assert_eq!(language_id_for_suffix(".tsx"), "typescriptreact");
        assert_eq!(language_id_for_suffix(".sh"), "shellscript");
        assert_eq!(language_id_for_suffix(".py"), "python");
    }

    /// The heap cap must never swallow a user's own `NODE_OPTIONS`: a missing
    /// separator turns `--max-old-space-size=1024--inspect=0` into an invalid
    /// string and node refuses to start at all.
    #[test]
    fn node_options_cap_is_always_separated() {
        std::env::remove_var("NODE_OPTIONS");
        assert_eq!(node_options_with_heap_cap(), "--max-old-space-size=1024");
        std::env::set_var("NODE_OPTIONS", "--inspect=0");
        assert_eq!(
            node_options_with_heap_cap(),
            "--max-old-space-size=1024 --inspect=0"
        );
        std::env::set_var("NODE_OPTIONS", "   ");
        assert_eq!(node_options_with_heap_cap(), "--max-old-space-size=1024");
        std::env::remove_var("NODE_OPTIONS");
    }

    #[test]
    fn server_commands_match_python_registry() {
        assert_eq!(server_command("python").unwrap(), vec!["pylsp"]);
        assert_eq!(
            server_command("typescript").unwrap(),
            vec!["typescript-language-server", "--stdio"]
        );
        assert_eq!(server_command("rust").unwrap(), vec!["rust-analyzer"]);
        assert!(server_command("cobol").is_none());
    }

    #[test]
    fn uri_roundtrip_handles_spaces() {
        let p = PathBuf::from("/tmp/some dir/file.rs");
        let uri = path_to_uri(&p);
        assert!(uri.starts_with("file:///"));
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn symbol_kind_names_match_lsp_spec() {
        assert_eq!(symbol_kind_name(5), "class");
        assert_eq!(symbol_kind_name(12), "function");
        assert_eq!(symbol_kind_name(6), "method");
    }

    #[test]
    fn symbol_position_prefers_hint_line_then_code_over_comments() {
        let text = "// compact_history is great\nfn other() {}\npub async fn compact_history(a: u8) {}\nlet x = compact_history(1);\n";
        // No hint: skips the comment and lands on the declaration (line 3).
        assert_eq!(find_symbol_position(text, "compact_history", None), Some((3, 13)));
        // The hint line wins even when the model got the column wrong.
        assert_eq!(find_symbol_position(text, "compact_history", Some(4)), Some((4, 8)));
        // A hint line without the symbol falls back to the global search.
        assert_eq!(find_symbol_position(text, "compact_history", Some(2)), Some((3, 13)));
        // Whole-word only; comment-only occurrences still resolve as a fallback.
        assert_eq!(find_symbol_position("fn compact_history_x() {}", "compact_history", None), None);
        assert_eq!(find_symbol_position("// foo bar\n", "foo", None), Some((1, 3)));
    }

    #[test]
    fn symbol_position_is_utf16_after_persian_text() {
        // "سلام " is 5 UTF-16 units before the symbol; an emoji takes 2.
        assert_eq!(find_symbol_position("سلام foo()\n", "foo", None), Some((1, 5)));
        assert_eq!(find_symbol_position("😀 foo()\n", "foo", None), Some((1, 3)));
    }

    #[test]
    fn resolve_binary_passes_explicit_paths_and_falls_back_to_bare_name() {
        let p = augmented_path();
        assert_eq!(resolve_binary("/x/y", &p), PathBuf::from("/x/y"));
        assert_eq!(
            resolve_binary("definitely-not-installed-xyz", &p),
            PathBuf::from("definitely-not-installed-xyz")
        );
    }

    #[test]
    fn definition_rejects_paths_outside_root() {
        let tmp = std::env::temp_dir().join(format!("codifa-lsp-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let err = definition(tmp.to_str().unwrap(), "../../etc/passwd", 1, 0);
        assert!(err.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
