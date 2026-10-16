//! Native MCP (Model Context Protocol) client.
//!
//! The composer's MCP popup switches connectors on per turn; the frontend
//! sends the enabled ones as `mcp_servers` on the agent request. This module
//! turns each connector into agent tools named `mcp__<server>__<tool>`:
//! `tool_schemas` advertises them to the model and `call_tool` executes them.
//!
//! Two transports are supported, mirroring the Python bridge:
//!   * stdio — spawn `command` + `args`, newline-delimited JSON-RPC
//!   * http  — POST JSON-RPC to `url` (streamable HTTP)
//!
//! Sessions are cached per server so a turn does not re-spawn (and
//! re-initialize) the same server for every tool call. Every failure is
//! fail-open: a broken connector contributes no tools instead of breaking
//! the turn — but the reason is RETURNED (see `tool_schemas`) so the agent
//! loop can surface it, instead of the connector silently doing nothing.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

/// How long one JSON-RPC round-trip may take before the server is considered
/// wedged (killed and dropped from the cache).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Protocol revision we advertise; servers negotiate down as needed.
const PROTOCOL_VERSION: &str = "2024-11-05";
/// Prefix of every MCP-backed tool name.
pub const TOOL_PREFIX: &str = "mcp__";

struct Session {
    child: Child,
    stdin: ChildStdin,
    reader: Option<BufReader<ChildStdout>>,
    next_id: i64,
}

impl Session {
    /// One JSON-RPC round-trip. The read runs on a helper thread so a wedged
    /// server cannot block the turn forever: on timeout the child is killed
    /// (which closes stdout and unblocks the reader) and the session is
    /// dropped by the caller.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{msg}").map_err(|e| format!("mcp write failed: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("mcp flush failed: {e}"))?;

        let reader = self.reader.take().ok_or("mcp session busy")?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, String>>();
        let handle = std::thread::spawn(move || {
            let mut reader = reader;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = tx.send(Err("mcp server closed the connection".into()));
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                            continue;
                        };
                        // Notifications carry no id — skip them.
                        if v.get("id").and_then(Value::as_i64) != Some(id) {
                            continue;
                        }
                        let _ = tx.send(Ok(v));
                        break;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("mcp read failed: {e}")));
                        break;
                    }
                }
            }
            reader
        });

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(v)) => {
                if let Ok(reader) = handle.join() {
                    self.reader = Some(reader);
                }
                if let Some(err) = v.get("error") {
                    return Err(format!("mcp error: {err}"));
                }
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                let _ = self.child.kill();
                let _ = handle.join();
                Err(format!(
                    "mcp server did not answer {method} within {}s",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache key: the server name plus its config, so editing a connector in
/// Settings starts a fresh process instead of reusing the old one.
fn key(server: &str, cfg: &Value) -> String {
    format!(
        "{server}\u{1}{}",
        serde_json::to_string(cfg).unwrap_or_default()
    )
}

/// Run `f` against the cached session for this connector, spawning and
/// initializing it on first use. A failed round-trip drops the session so the
/// next call starts clean.
fn with_session<T>(
    server: &str,
    cfg: &Value,
    f: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let k = key(server, cfg);
    let mut guard = sessions().lock().map_err(|_| "mcp session lock poisoned")?;
    if !guard.contains_key(&k) {
        guard.insert(k.clone(), spawn_session(cfg)?);
    }
    let session = guard.get_mut(&k).ok_or("mcp session missing")?;
    match f(session) {
        Ok(v) => Ok(v),
        Err(e) => {
            guard.remove(&k);
            Err(e)
        }
    }
}

fn spawn_session(cfg: &Value) -> Result<Session, String> {
    let command = cfg["command"].as_str().unwrap_or_default().trim();
    if command.is_empty() {
        return Err("mcp connector has no command".into());
    }
    let mut cmd = Command::new(command);
    if let Some(args) = cfg["args"].as_array() {
        cmd.args(args.iter().filter_map(Value::as_str));
    }
    // A GUI-launched app inherits a minimal PATH (no npx/node/uvx), so a
    // stdio connector like `npx @playwright/mcp` could not start at all and
    // silently contributed no tools. Give the child the same login-shell PATH
    // the sidecar spawn uses.
    cmd.env("PATH", crate::sidecar::shell_path());
    // The app bundle exports PYTHONHOME for its own sidecar; an inherited
    // value makes any python-based MCP server exit immediately ("No module
    // named 'encodings'"), which surfaced as "closed the connection".
    cmd.env_remove("PYTHONHOME");
    if let Some(env) = cfg["env"].as_object() {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot start mcp server {command:?}: {e}"))?;
    let stdin = child.stdin.take().ok_or("mcp stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("mcp stdout unavailable")?;
    let mut session = Session {
        child,
        stdin,
        reader: Some(BufReader::new(stdout)),
        next_id: 1,
    };
    session.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "codifa", "version": env!("CARGO_PKG_VERSION")},
        }),
    )?;
    // The initialized notification has no id and expects no reply.
    let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let _ = writeln!(session.stdin, "{note}");
    let _ = session.stdin.flush();
    Ok(session)
}

fn is_http(cfg: &Value) -> bool {
    cfg["url"]
        .as_str()
        .map(|u| !u.trim().is_empty())
        .unwrap_or(false)
}

/// POST one JSON-RPC message to an HTTP connector.
///
/// `reqwest::blocking` builds its own runtime and panics when called from
/// inside an async context (the agent loop is async), so the request runs on a
/// plain thread with no ambient runtime.
fn http_request(cfg: &Value, method: &str, params: Value) -> Result<Value, String> {
    let cfg = cfg.clone();
    let method = method.to_string();
    std::thread::spawn(move || http_request_blocking(&cfg, &method, params))
        .join()
        .map_err(|_| "mcp http thread panicked".to_string())?
}

fn http_request_blocking(cfg: &Value, method: &str, params: Value) -> Result<Value, String> {
    let url = cfg["url"].as_str().unwrap_or_default().trim();
    if url.is_empty() {
        return Err("mcp connector has no url".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(url).json(&json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    }));
    if let Some(headers) = cfg["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                req = req.header(k, v);
            }
        }
    }
    let res = req.send().map_err(|e| format!("mcp http failed: {e}"))?;
    let body: Value = res.json().map_err(|e| format!("mcp http body: {e}"))?;
    if let Some(err) = body.get("error") {
        return Err(format!("mcp error: {err}"));
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

/// True when this connector spawns Playwright MCP.
fn is_playwright_cfg(cfg: &Value) -> bool {
    cfg["args"]
        .as_array()
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .any(|a| a.contains("playwright/mcp"))
        })
        .unwrap_or(false)
}

/// Ask the native browser session for this chat's CDP endpoint. The Rust
/// router owns the headless Chromium the right-side Browser panel mirrors, so
/// pointing Playwright MCP at that endpoint keeps the agent and the panel on
/// the SAME browser — nothing opens outside the app. Returns None when the
/// session cannot start (the caller then falls back to --headless).
fn in_app_cdp_endpoint(chat_id: &str) -> Option<String> {
    let endpoint = crate::browser::cdp_endpoint(chat_id)?;
    // The endpoint is only useful when the browser is ACTUALLY listening.
    // Playwright MCP exits immediately on an unreachable --cdp-endpoint, which
    // surfaced to the user as "the browser tool is unavailable" — worse than
    // the old behaviour of opening its own window. Probe the port first and
    // let the caller fall back to --headless.
    let addr = endpoint.strip_prefix("http://")?;
    let addr: std::net::SocketAddr = addr.parse().ok()?;
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    Some(endpoint)
}

/// The config to actually connect with. `@playwright/mcp` normally launches a
/// visible browser window of its own; pointing it at the chat's in-app CDP
/// endpoint makes it attach to the panel's Chromium instead. When the in-app
/// session cannot start we force `--headless` rather than let a window pop up
/// outside the app. Every other connector's config is returned unchanged.
fn effective_cfg(cfg: &Value, chat_id: &str) -> Value {
    if !is_playwright_cfg(cfg) {
        return cfg.clone();
    }
    let mut args: Vec<String> = cfg["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if args
        .iter()
        .any(|a| a.starts_with("--cdp-endpoint") || a.starts_with("--endpoint"))
    {
        return cfg.clone(); // the user pinned their own endpoint — respect it
    }
    match in_app_cdp_endpoint(chat_id) {
        Some(endpoint) => {
            args.push("--cdp-endpoint".into());
            args.push(endpoint);
        }
        None => args.push("--headless".into()),
    }
    let mut out = cfg.clone();
    out["args"] = json!(args);
    out
}

/// Tool list for one connector. The failure is returned rather than swallowed:
/// a connector that cannot start used to contribute nothing silently, which is
/// exactly why MCP tools "never worked" with no clue in the UI.
fn list_tools(server: &str, cfg: &Value, chat_id: &str) -> Result<Vec<Value>, String> {
    let cfg = effective_cfg(cfg, chat_id);
    let result = if is_http(&cfg) {
        http_request(&cfg, "tools/list", json!({}))
    } else {
        with_session(server, &cfg, |s| s.request("tools/list", json!({})))
    }?;
    Ok(result["tools"].as_array().cloned().unwrap_or_default())
}

/// Agent tool schemas for every enabled connector. A tool name that is UNIQUE
/// across the enabled connectors is exposed BARE (`browser_navigate`) so the
/// model sees short readable names instead of `mcp__playwright__browser_navigate`;
/// a name two connectors both expose stays qualified to remain unambiguous.
/// The second element carries one message per connector that could not be
/// reached, so the agent loop can warn the user instead of failing silently.
pub fn tool_schemas(servers: &Value, chat_id: &str) -> (Vec<Value>, Vec<String>) {
    let Some(map) = servers.as_object() else {
        return (Vec::new(), Vec::new());
    };
    let mut failures = Vec::new();
    // Collect every connector's tools first: the bare/qualified decision needs
    // the whole picture (a name is only short when nothing else claims it).
    let mut found: Vec<(String, Vec<Value>)> = Vec::new();
    for (server, cfg) in map {
        match list_tools(server, cfg, chat_id) {
            Ok(tools) => found.push((server.clone(), tools)),
            Err(e) => failures.push(format!(
                "MCP connector {server:?} is unavailable this turn: {e}"
            )),
        }
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (_, tools) in &found {
        for t in tools {
            if let Some(n) = t["name"].as_str() {
                *counts.entry(n).or_default() += 1;
            }
        }
    }
    let mut out = Vec::new();
    for (server, tools) in &found {
        for t in tools {
            let tool = t["name"].as_str().unwrap_or_default().trim();
            if tool.is_empty() {
                continue;
            }
            let desc = t["description"].as_str().unwrap_or_default().trim();
            let name = if counts.get(tool).copied().unwrap_or(0) == 1 {
                tool.to_string()
            } else {
                format!("{TOOL_PREFIX}{server}__{tool}")
            };
            out.push(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": format!("[MCP connector {server}] {desc}"),
                    "parameters": t.get("inputSchema").cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                }
            }));
        }
    }
    (out, failures)
}

/// Split `mcp__<server>__<tool>` back into its two parts.
fn split_name(name: &str) -> Result<(&str, &str), String> {
    let rest = name
        .strip_prefix(TOOL_PREFIX)
        .ok_or_else(|| format!("not an mcp tool: {name}"))?;
    rest.split_once("__")
        .ok_or_else(|| format!("malformed mcp tool name: {name}"))
}

/// Flatten an MCP `tools/call` result into the plain text the agent loop
/// stores as the tool message.
fn flatten_content(result: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = result["content"].as_array() {
        for item in items {
            let piece = match item["type"].as_str() {
                Some("text") => item["text"].as_str().unwrap_or_default().to_string(),
                Some(other) => format!("[{other} content]"),
                None => continue,
            };
            if piece.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&piece);
        }
    }
    if out.is_empty() {
        out = result.to_string();
    }
    if result["isError"].as_bool().unwrap_or(false) {
        out = format!("mcp tool error: {out}");
    }
    out
}

/// Resolve a tool name to its connector. A qualified `mcp__<server>__<tool>`
/// carries its server; a BARE name (the short form `tool_schemas` hands the
/// model) is looked up in the enabled connectors — the same list the schemas
/// came from, so any user-added MCP resolves too.
fn resolve(servers: &Value, name: &str, chat_id: &str) -> Result<(String, String), String> {
    if name.starts_with(TOOL_PREFIX) {
        let (server, tool) = split_name(name)?;
        return Ok((server.to_string(), tool.to_string()));
    }
    let map = servers
        .as_object()
        .ok_or_else(|| format!("mcp tool {name:?} is not enabled for this turn"))?;
    for (server, cfg) in map {
        if let Ok(tools) = list_tools(server, cfg, chat_id) {
            if tools.iter().any(|t| t["name"].as_str() == Some(name)) {
                return Ok((server.clone(), name.to_string()));
            }
        }
    }
    Err(format!("mcp tool {name:?} is not enabled for this turn"))
}

/// Execute one MCP tool call, by bare (`browser_navigate`) or qualified
/// (`mcp__playwright__browser_navigate`) name.
pub fn call_tool(
    servers: &Value,
    name: &str,
    args: &Value,
    chat_id: &str,
) -> Result<String, String> {
    let (server, tool) = resolve(servers, name, chat_id)?;
    let cfg = servers
        .get(&server)
        .ok_or_else(|| format!("mcp connector {server:?} is not enabled for this turn"))?;
    let cfg = effective_cfg(cfg, chat_id);
    let params = json!({"name": tool, "arguments": args});
    let result = if is_http(&cfg) {
        http_request(&cfg, "tools/call", params)?
    } else {
        with_session(&server, &cfg, |s| s.request("tools/call", params))?
    };
    Ok(flatten_content(&result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_name_parses_server_and_tool() {
        assert_eq!(split_name("mcp__docker__list_containers").unwrap(), ("docker", "list_containers"));
        assert!(split_name("read").is_err());
        assert!(split_name("mcp__docker").is_err());
    }

    #[test]
    fn flatten_content_joins_text_blocks_and_flags_errors() {
        let ok = json!({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]});
        assert_eq!(flatten_content(&ok), "a\nb");
        let err = json!({"content": [{"type": "text", "text": "boom"}], "isError": true});
        assert_eq!(flatten_content(&err), "mcp tool error: boom");
        // A result with no content blocks still yields something readable.
        assert!(flatten_content(&json!({"foo": 1})).contains("foo"));
    }

    #[test]
    fn tool_schemas_is_empty_without_connectors() {
        assert!(tool_schemas(&Value::Null, "").0.is_empty());
        assert!(tool_schemas(&json!({}), "").0.is_empty());
    }

    /// A connector that cannot start must be REPORTED, not silently dropped:
    /// the old code swallowed the spawn error, so the model simply had no MCP
    /// tools and the user saw nothing explaining why.
    #[test]
    fn tool_schemas_reports_a_connector_that_cannot_start() {
        let servers = json!({ "broken": {"command": "codifa-no-such-binary-xyz"} });
        let (schemas, failures) = tool_schemas(&servers, "");
        assert!(schemas.is_empty(), "{schemas:?}");
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert!(failures[0].contains("broken"), "{failures:?}");
    }

    /// A GUI-launched app inherits a minimal PATH (no npx/node/uvx), so a
    /// stdio connector like `npx @playwright/mcp` could not start at all. The
    /// child must get the same login-shell PATH the sidecar spawn uses.
    #[test]
    fn stdio_session_inherits_the_login_shell_path() {
        // The child must see a PATH that resolves ordinary tools: a
        // GUI-launched app's minimal PATH (no /usr/bin) is exactly what made
        // `npx @playwright/mcp` fail to start, silently disabling the browser
        // tools. The fake server reports whether /usr/bin is on its PATH.
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"path","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      case ":$PATH:" in
        *:/usr/bin:*) verdict=has-usr-bin ;;
        *) verdict=missing-usr-bin ;;
      esac
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$verdict" ;;
  esac
done
"#;
        let servers = json!({ "pathtest": {"command": "sh", "args": ["-c", script]} });
        let out = call_tool(&servers, "mcp__pathtest__path", &json!({}), "").unwrap();
        assert_eq!(out.trim(), "has-usr-bin");
    }

    #[test]
    fn call_tool_rejects_a_disabled_connector() {
        let err = call_tool(&json!({}), "mcp__docker__ps", &json!({}), "").unwrap_err();
        assert!(err.contains("not enabled"), "{err}");
    }

    /// A tool name unique across the enabled connectors is exposed BARE, so the
    /// model sees `browser_navigate` instead of `mcp__playwright__browser_navigate`
    /// — and a bare call must still route back to its connector.
    #[test]
    fn unique_tool_names_are_exposed_bare_and_still_resolve() {
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"browser_navigate","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"navigated"}]}}\n' "$id" ;;
  esac
done
"#;
        let servers = json!({ "playwright": {"command": "sh", "args": ["-c", script]} });
        let (schemas, failures) = tool_schemas(&servers, "");
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(schemas[0]["function"]["name"], "browser_navigate");
        let out = call_tool(&servers, "browser_navigate", &json!({}), "").unwrap();
        assert_eq!(out, "navigated");
    }

    /// Two connectors exposing the SAME tool name keep the qualified form, so a
    /// call is never routed to the wrong server.
    #[test]
    fn ambiguous_tool_names_stay_qualified() {
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"ping","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
  esac
done
"#;
        let servers = json!({
            "a": {"command": "sh", "args": ["-c", script]},
            "b": {"command": "sh", "args": ["-c", script]},
        });
        let (schemas, _) = tool_schemas(&servers, "");
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"mcp__a__ping"), "{names:?}");
        assert!(names.contains(&"mcp__b__ping"), "{names:?}");
        assert!(!names.contains(&"ping"), "{names:?}");
    }

    /// End-to-end stdio transport: a shell script plays a minimal MCP server
    /// (initialize + tools/list + tools/call) so the handshake, the schema
    /// mapping and the content flattening are all exercised for real.
    #[test]
    fn stdio_session_lists_and_calls_tools() {
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}]}}\n' "$id" ;;
  esac
done
"#;
        let cfg = json!({"command": "sh", "args": ["-c", script]});
        let servers = json!({ "fake": cfg });

        let (schemas, failures) = tool_schemas(&servers, "");
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(schemas.len(), 1, "{schemas:?}");
        // Unique across the enabled connectors, so it is exposed bare.
        assert_eq!(schemas[0]["function"]["name"], "echo");
        assert!(schemas[0]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("Echo text"));

        let out = call_tool(&servers, "echo", &json!({"text": "ping"}), "").unwrap();
        assert_eq!(out, "pong");
        // The qualified form keeps working (older transcripts / pinned names).
        let out = call_tool(&servers, "mcp__fake__echo", &json!({"text": "ping"}), "").unwrap();
        assert_eq!(out, "pong");
    }
}
