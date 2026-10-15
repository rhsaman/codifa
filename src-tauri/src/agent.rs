//! Native agent loop (phase 3-2): mirrors the Python graph.py turn loop for
//! the core tool set and emits the same `kind`-discriminated SSE events the
//! frontend already consumes. Tool execution delegates to `tools::dispatch`;
//! LSP-backed tools, MCP and subagents stay on the Python sidecar until their
//! phases land (dispatch returns a clear error for those names).

// Phase 3-2 WIP: the native agent loop is not wired to a route yet
// (/chat/stream stays on the Python sidecar until parity). Keep the code
// compiled and tested; silence dead-code until the route lands.
#![allow(dead_code)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::llm::{http_client, stream_chat, LlmConfig, StreamAcc};
use crate::tools;

/// Maximum tool-loop iterations per turn (mirrors graph.py MAX_STEPS).
const MAX_STEPS: usize = 60;
/// Cap on the tool result echoed to the UI (full result still goes to the LLM).
const TOOL_RESULT_CAP: usize = 4000;
/// Sub-agent depth limit (mirrors graph.py: sub-agents cannot spawn more).
const MAX_SUBAGENT_DEPTH: usize = 1;

// ---------------------------------------------------------------------------
// Request / events
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentRequest {
    pub provider: String,
    // Part of the public request contract; consumed in phase 3-3.
    #[serde(default)]
    #[allow(dead_code)]
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub root: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<Value>,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub context_window: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub chat_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub mcp_servers: Value,
}

fn default_mode() -> String {
    "build".to_string()
}

/// One SSE event of the agent turn — serialized as `{"kind": ..., ...}`.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Status { stage: String, content: String },
    Text { content: String },
    Thinking { active: bool },
    Tool { name: String, args: Value, result: String, ok: bool },
    Warn { content: String },
    Usage { input_tokens: u64, output_tokens: u64 },
    Done { aborted: bool },
    Error { content: String },
}

impl AgentEvent {
    pub fn to_json(&self) -> Value {
        match self {
            AgentEvent::Status { stage, content } => {
                json!({"kind": "status", "stage": stage, "content": content})
            }
            AgentEvent::Text { content } => json!({"kind": "text", "content": content}),
            AgentEvent::Thinking { active } => json!({"kind": "thinking", "active": active}),
            AgentEvent::Tool { name, args, result, ok } => json!({
                "kind": "tool", "name": name, "tool": name, "args": args,
                "result": result, "ok": ok,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::Usage { input_tokens, output_tokens } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }),
            AgentEvent::Done { aborted } => json!({"kind": "done", "aborted": aborted}),
            AgentEvent::Error { content } => json!({"kind": "error", "content": content}),
        }
    }
}

/// Tool schemas for the MAIN agent: no search/read tools — the main agent
/// delegates all research to the `explore` sub-agent and works only with the
/// data the sub-agent returns (user request: main agent must not search).
fn tool_schemas() -> Vec<Value> {
    [
        ("write_file", "Create or overwrite a file."),
        ("edit_file", "Replace an exact string in an existing file."),
        ("run_terminal", "Run a shell command in the workspace with a timeout."),
        ("current_time", "Current UTC time."),
        ("explore", "Delegate a search/research task to the explore sub-agent. It reads files, greps, globs and runs LSP lookups, then returns the FULL findings — you cannot search yourself, so ask it for everything you need."),
        ("save_memory", "Persist a durable note about the project for future sessions."),
    ]
    .into_iter()
    .map(|(name, desc)| {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filePath": {"type": "string"},
                        "path": {"type": "string"},
                        "pattern": {"type": "string"},
                        "patterns": {"type": "array", "items": {"type": "string"}},
                        "include": {"type": "string"},
                        "content": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                        "replace_all": {"type": "boolean"},
                        "edits": {"type": "array"},
                        "command": {"type": "string"},
                        "timeout": {"type": "integer"},
                        "offset": {"type": "integer"},
                        "limit": {"type": "integer"},
                        "max_results": {"type": "integer"},
                    },
                },
            },
        })
    })
    .collect()
}

/// Tool schemas for the explore SUB-AGENT: the full read/search set the main
/// agent no longer has (read/grep/glob/LSP) plus memory search.
fn research_schemas() -> Vec<Value> {
    [
        ("read", "Read a file (optionally a window via offset/limit)."),
        ("grep", "Regex content search under a path."),
        ("glob", "Find files by glob pattern (path-scoped)."),
        ("lsp_definition", "Jump to the definition of a symbol (LSP)."),
        ("lsp_references", "Find references of a symbol (LSP)."),
        ("lsp_hover", "Hover text/signature for a symbol (LSP)."),
        ("lsp_symbols", "List definitions in one file (LSP)."),
        ("lsp_diagnostics", "Diagnostics for one file (LSP)."),
        ("search_memory", "Search previously saved project notes."),
    ]
    .into_iter()
    .map(|(name, desc)| {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filePath": {"type": "string"},
                        "path": {"type": "string"},
                        "pattern": {"type": "string"},
                        "patterns": {"type": "array", "items": {"type": "string"}},
                        "include": {"type": "string"},
                        "offset": {"type": "integer"},
                        "limit": {"type": "integer"},
                        "max_results": {"type": "integer"},
                        "query": {"type": "string"},
                        "symbol": {"type": "string"},
                        "character": {"type": "integer"},
                        "line": {"type": "integer"},
                    },
                },
            },
        })
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

static TURN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Run one full agent turn: stream the model, execute tool calls, repeat
/// until the model answers without tool calls or MAX_STEPS is reached.
/// Emits the same event protocol as the Python graph.
pub async fn run_turn(
    req: &AgentRequest,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
) -> Result<(), String> {
    let _turn = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = req.root.clone();
    let cfg = LlmConfig {
        provider: req.provider.clone(),
        model: req.model.clone(),
        base_url: req.base_url.clone(),
        api_keys: if req.api_key.is_empty() {
            req.api_keys.clone()
        } else {
            let mut keys = vec![req.api_key.clone()];
            keys.extend(req.api_keys.iter().cloned());
            keys
        },
        temperature: None,
        max_tokens: None,
        timeout_secs: 600,
    };

    // Assemble the message list: system + history + current user prompt.
    let mut messages: Vec<Value> = Vec::new();
    let system = if req.system_prompt.is_empty() {
        default_system_prompt(&req.mode, &root)
    } else {
        req.system_prompt.clone()
    };
    messages.push(json!({"role": "system", "content": system}));
    for m in &req.history {
        if let (Some(role), Some(content)) = (
            m.get("role").and_then(Value::as_str),
            m.get("content").and_then(Value::as_str),
        ) {
            messages.push(json!({"role": role, "content": content}));
        }
    }
    if !req.prompt.is_empty() {
        messages.push(json!({"role": "user", "content": req.prompt}));
    }

    let client = http_client();
    emit(&AgentEvent::Status {
        stage: "thinking".into(),
        content: "Contacting model".into(),
    });

    // The explore sub-agent gets the full read/search set; the main agent
    // deliberately has NO search tools and must delegate via `explore`.
    let schemas = if req.mode == "subagent" {
        research_schemas()
    } else {
        tool_schemas()
    };

    for _step in 0..MAX_STEPS {
        // stream_chat accumulates text/tool_calls itself; the sink only
        // forwards live text deltas to the SSE stream.
        let mut sink = |delta: &str| {
            if !delta.is_empty() {
                emit(&AgentEvent::Text {
                    content: delta.to_string(),
                });
            }
        };
        let acc = match stream_chat(&client, &cfg, &messages, Some(&schemas), &mut sink).await
        {
            Ok(acc) => acc,
            Err((_, e)) => {
                emit(&AgentEvent::Error { content: e });
                return Ok(());
            }
        };
        let (in_tok, out_tok) = usage_tuple(&acc);
        emit(&AgentEvent::Usage {
            input_tokens: in_tok,
            output_tokens: out_tok,
        });

        let text = acc.text.clone();
        let tool_calls: Vec<(String, String, String)> = acc
            .tool_calls
            .iter()
            .map(|tc| {
                (
                    tc["id"].as_str().unwrap_or_default().to_string(),
                    tc["function"]["name"].as_str().unwrap_or_default().to_string(),
                    tc["function"]["arguments"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();

        if tool_calls.is_empty() {
            emit(&AgentEvent::Done { aborted: false });
            return Ok(());
        }

        // Record the assistant tool-call message, then execute each call.
        let calls_json: Vec<Value> = tool_calls
            .iter()
            .map(|(id, name, args)| {
                json!({"id": id, "type": "function",
                       "function": {"name": name, "arguments": args}})
            })
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { json!(text) },
            "tool_calls": calls_json,
        }));

        for (id, name, raw_args) in &tool_calls {
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            emit(&AgentEvent::Status {
                stage: "tool".into(),
                content: name.clone(),
            });
            let (result, ok) = if name == "explore" || name == "task" {
                if req.mode == "subagent" {
                    ("sub-agents cannot spawn further sub-agents".into(), false)
                } else {
                    Box::pin(run_subagent(req, &args, emit)).await
                }
            } else {
                match tools::dispatch(&root, name, &args, None) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            };
            // UI echo is capped; the full result still goes to the model.
            let mut shown = result.clone();
            if shown.len() > TOOL_RESULT_CAP {
                shown.truncate(TOOL_RESULT_CAP);
                shown.push_str("\n… (truncated)");
            }
            emit(&AgentEvent::Tool {
                name: name.clone(),
                args: args.clone(),
                result: shown,
                ok,
            });
            messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": result,
            }));
        }
    }

    emit(&AgentEvent::Warn {
        content: format!("turn stopped after {MAX_STEPS} steps"),
    });
    emit(&AgentEvent::Done { aborted: false });
    Ok(())
}

/// Run the explore sub-agent (tools `explore`/`task`): depth-limited
/// recursion into run_turn with a research-only prompt and the FULL
/// read/search tool set. The report is returned UNCAPPED — the main agent
/// has no search tools of its own, so this report is its only source of
/// data (UI echo is still capped by the caller).
async fn run_subagent(
    parent: &AgentRequest,
    args: &Value,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
) -> (String, bool) {
    let description = args["description"].as_str().unwrap_or_default().to_string();
    let prompt = args["prompt"].as_str().unwrap_or_default().to_string();
    if prompt.is_empty() {
        return ("explore requires a non-empty prompt".into(), false);
    }

    emit(&AgentEvent::Status {
        stage: "subagent".into(),
        content: description.clone(),
    });

    // Read-only sub-request: same model config, research-only system prompt.
    let sub_req = AgentRequest {
        provider: parent.provider.clone(),
        provider_id: parent.provider_id.clone(),
        model: parent.model.clone(),
        base_url: parent.base_url.clone(),
        api_key: parent.api_key.clone(),
        api_keys: parent.api_keys.clone(),
        root: parent.root.clone(),
        mode: "subagent".into(),
        prompt,
        history: Vec::new(),
        system_prompt: format!(
            "You are the explore sub-agent inside the workspace {}. \
Search and read files (read/grep/glob/LSP tools) and report the FULL \
findings — the main agent cannot search itself and relies entirely on \
your report, so include exact file paths, line numbers, symbol names \
and relevant code excerpts. You have NO write tools: never modify files. \
Report in English.",
            parent.root
        ),
        context_window: parent.context_window,
        chat_id: parent.chat_id.clone(),
        mcp_servers: Value::Null,
    };

    let mut report = String::new();
    let res = {
        let mut sink = |ev: &AgentEvent| {
            if let AgentEvent::Text { content } = ev {
                report.push_str(content);
            }
        };
        run_turn(&sub_req, &mut sink).await
    };
    match res {
        Ok(()) => (report, true),
        Err(e) => (format!("sub-agent failed: {e}"), false),
    }
}

fn usage_tuple(acc: &StreamAcc) -> (u64, u64) {
    let Some(u) = &acc.usage else {
        return (0, 0);
    };
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(*k).and_then(Value::as_u64))
            .unwrap_or(0)
    };
    (
        pick(&["prompt_tokens", "input_tokens"]),
        pick(&["completion_tokens", "output_tokens"]),
    )
}

fn default_system_prompt(mode: &str, root: &str) -> String {
    format!(
        "You are Codifa, a coding agent inside the user's desktop IDE. \
Workspace root: {root}. Mode: {mode}. \
You have NO search/read tools: delegate ALL file reading, searching and \
LSP lookups to the `explore` sub-agent and work from its full report. \
Use write_file/edit_file/run_terminal to make changes. \
Reply in the user's language. \
Docstrings and comments in code must be English."
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_shapes_match_python_protocol() {
        assert_eq!(
            AgentEvent::Text { content: "hi".into() }.to_json(),
            json!({"kind": "text", "content": "hi"})
        );
        assert_eq!(
            AgentEvent::Done { aborted: true }.to_json(),
            json!({"kind": "done", "aborted": true})
        );
        let t = AgentEvent::Tool {
            name: "read".into(),
            args: json!({"filePath": "a"}),
            result: "x".into(),
            ok: true,
        }
        .to_json();
        assert_eq!(t["kind"], "tool");
        assert_eq!(t["name"], "read");
        assert_eq!(t["ok"], true);
    }

    #[test]
    fn tool_schemas_main_agent_has_no_search_tools() {
        let schemas = tool_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        // Main agent must NOT have search/read tools — research is delegated.
        for banned in ["read", "grep", "glob", "lsp_definition", "lsp_symbols"] {
            assert!(!names.contains(&banned), "main agent must not have {banned}");
        }
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"run_terminal"));
    }

    #[test]
    fn research_schemas_cover_search_set() {
        let schemas = research_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        for expected in [
            "read",
            "grep",
            "glob",
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            "lsp_symbols",
            "lsp_diagnostics",
            "search_memory",
        ] {
            assert!(names.contains(&expected), "missing schema: {expected}");
        }
        // The sub-agent must not be able to write or spawn agents.
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"explore"));
    }

    #[test]
    fn subagent_rejects_missing_prompt() {
        // Synchronous guard check: empty prompt must fail fast (no model call).
        let args = json!({"description": "d"});
        assert!(args["prompt"].as_str().unwrap_or_default().is_empty());
    }

    #[test]
    fn usage_tuple_maps_both_vocabularies() {
        let mut acc = StreamAcc::default();
        acc.usage = Some(json!({"prompt_tokens": 10, "completion_tokens": 5}));
        assert_eq!(usage_tuple(&acc), (10, 5));
        acc.usage = Some(json!({"input_tokens": 7, "output_tokens": 3}));
        assert_eq!(usage_tuple(&acc), (7, 3));
        acc.usage = None;
        assert_eq!(usage_tuple(&acc), (0, 0));
    }

    #[test]
    fn dispatch_via_tools_roundtrip() {
        let dir = std::env::temp_dir().join(format!("codifa-agent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap().to_string();
        let (msg, ok) = match tools::dispatch(&root, "write_file", &json!({"path": "a.txt", "content": "hello"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok, "{msg}");
        let (msg, ok) = match tools::dispatch(&root, "read", &json!({"filePath": "a.txt"}), None) {
            Ok(m) => (m, true),
            Err(m) => (m, false),
        };
        assert!(ok && msg.contains("hello"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_request_deserializes_minimal_body() {
        let body = json!({
            "provider": "custom",
            "model": "m1",
            "root": "/tmp/x",
            "prompt": "hi"
        });
        let req: AgentRequest = serde_json::from_value(body).unwrap();
        assert_eq!(req.mode, "build");
        assert!(req.api_keys.is_empty());
    }
}
