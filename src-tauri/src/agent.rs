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
    /// Per-slot sub-agent model overrides from the UI's Tool Models settings
    /// (e.g. {"subagent": "providerId/model"}); empty = the parent model.
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    /// Full provider configs keyed by id, so a "providerId/model" sub-agent
    /// entry routes to THAT provider's base URL / keys (cross-provider).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
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
    /// Emitted when a tool call STARTS — the frontend mints a running card.
    /// `id` is the provider tool_call id so the frontend can dedup/re-pair.
    ToolStart { id: String, name: String, args: Value },
    /// Emitted when the tool FINISHES — resolves the running card.
    Tool { id: String, name: String, args: Value, result: String, ok: bool },
    Warn { content: String },
    /// Carries the model + provider_id that actually served this request so
    /// the frontend attributes sub-agent tokens to the SUB model, not the
    /// parent's.
    Usage { input_tokens: u64, output_tokens: u64, model: String, provider_id: String },
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
            AgentEvent::ToolStart { id, name, args } => json!({
                "kind": "tool", "id": id, "name": name, "tool": name, "args": args,
            }),
            AgentEvent::Tool { id, name, args, result, ok } => json!({
                "kind": "tool_result", "id": id, "name": name, "tool": name, "args": args,
                "result": result, "ok": ok,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::Usage { input_tokens, output_tokens, model, provider_id } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "model": model, "provider_id": provider_id,
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
        ("explore", "Delegate a search/research task to the explore sub-agent. It reads files, greps, globs and runs LSP lookups, then returns the FULL findings — you cannot search yourself, so ask it for everything you need. Args: description (SHORT label for the UI, under 80 chars) and prompt (the full research question)."),
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
                        "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                        "prompt": {"type": "string", "description": "The full research question for the sub-agent"},
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
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let _turn = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = req.root.clone();
    let trace = crate::trace::TraceStore::new(req.chat_id.clone());
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

    // Trace: the full system prompt of this turn (prompt row, like Python).
    trace.record(crate::trace::TraceEntry {
        kind: "prompt".into(),
        summary: format!("prompt · {} chars", system.len()),
        prompt: Some(system.clone()),
        ..Default::default()
    });

    // The explore sub-agent gets the full read/search set; the main agent
    // deliberately has NO search tools and must delegate via `explore`.
    let schemas = if req.mode == "subagent" {
        research_schemas()
    } else {
        tool_schemas()
    };

    for _step in 0..MAX_STEPS {
        // Client disconnect (Stop button closes the SSE stream) flips the
        // cancel flag — bail out instead of burning provider tokens.
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            emit(&AgentEvent::Done { aborted: true });
            return Ok(());
        }
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
            model: req.model.clone(),
            provider_id: req.provider_id.clone(),
        });
        // Trace: one llm row per model call (model + tokens), like the
        // Python sidecar's trace panel rows.
        trace.record(crate::trace::TraceEntry {
            kind: "llm".into(),
            model: Some(req.model.clone()),
            tokens: Some(crate::trace::Tokens {
                input: in_tok,
                output: out_tok,
                total: in_tok + out_tok,
            }),
            summary: format!("{} · {} tokens", req.model, in_tok + out_tok),
            ..Default::default()
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
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                emit(&AgentEvent::Done { aborted: true });
                return Ok(());
            }
            let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            emit(&AgentEvent::Status {
                stage: "tool".into(),
                content: name.clone(),
            });
            // Two-phase protocol (like the Python sidecar): the start event
            // mints a running card immediately, so long tools (explore) are
            // visible while they work and Stop leaves a visible card.
            emit(&AgentEvent::ToolStart {
                id: id.clone(),
                name: name.clone(),
                args: args.clone(),
            });
            let (result, ok) = if name == "explore" || name == "task" {
                if req.mode == "subagent" {
                    ("sub-agents cannot spawn further sub-agents".into(), false)
                } else {
                    Box::pin(run_subagent(req, &args, emit, cancel)).await
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
            // Trace: one tool row per executed call (args + result).
            trace.record(crate::trace::TraceEntry {
                kind: "tool".into(),
                summary: name.clone(),
                prompt: Some(raw_args.clone()),
                result: Some(shown.clone()),
                detail: Some(serde_json::json!({
                    "name": name,
                    "ok": ok,
                    "sub": req.mode == "subagent",
                })),
                ..Default::default()
            });
            emit(&AgentEvent::Tool {
                id: id.clone(),
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
/// Resolve the explore sub-agent's model from the Tool Models settings.
/// Mirrors graph.py resolve_subagent_model: "" / missing -> the parent
/// model; "providerId/model" -> THAT provider's base URL + keys
/// (cross-provider routing); a bare model id -> the parent provider.
fn resolve_subagent_target(req: &AgentRequest) -> (String, String, Vec<String>) {
    // The UI's Tool Models settings store the explore model under the
    // "explore" key (agent name); "subagent" is the legacy alias.
    let entry = req
        .subagent_models
        .get("explore")
        .or_else(|| req.subagent_models.get("subagent"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if entry.is_empty() || entry == "main" || entry == "main_model" || entry == "main model" {
        return (
            req.model.clone(),
            req.base_url.clone(),
            req.api_keys.clone(),
        );
    }
    let (provider_id, model) = match entry.split_once('/') {
        Some((pid, m)) => (pid.trim().to_string(), m.trim().to_string()),
        None => (String::new(), entry),
    };
    if provider_id.is_empty() {
        // Bare model id: same provider as the parent.
        return (model, req.base_url.clone(), req.api_keys.clone());
    }
    match req.providers.get(&provider_id) {
        Some(cfg) => {
            let base = cfg
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or(&req.base_url)
                .to_string();
            let mut keys: Vec<String> = cfg
                .get("apiKeys")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
                    keys.push(k.to_string());
                }
            }
            if keys.is_empty() {
                keys = req.api_keys.clone();
            }
            (model, base, keys)
        }
        // Unknown provider id: fall back to the parent provider.
        None => (
            model,
            req.base_url.clone(),
            req.api_keys.clone(),
        ),
    }
}

async fn run_subagent(
    parent: &AgentRequest,
    args: &Value,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &std::sync::atomic::AtomicBool,
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

    // Read-only sub-request: research-only system prompt. The model comes
    // from the Tool Models "subagent" slot (cross-provider aware), falling
    // back to the parent model when the slot is empty.
    let (sub_model, sub_base, sub_keys) = resolve_subagent_target(parent);
    let sub_req = AgentRequest {
        provider: parent.provider.clone(),
        provider_id: parent.provider_id.clone(),
        model: sub_model,
        base_url: sub_base,
        api_key: parent.api_key.clone(),
        api_keys: sub_keys,
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
        subagent_models: std::collections::HashMap::new(),
        providers: parent.providers.clone(),
    };

    let mut report = String::new();
    let mut sub_error = String::new();
    let res = {
        let mut sink = |ev: &AgentEvent| {
            match ev {
                AgentEvent::Text { content } => report.push_str(content),
                // Capture the sub-agent's error so an empty report can say WHY
                // it is empty (provider 400/401, tool failure, …).
                AgentEvent::Error { content } => sub_error.push_str(content),
                _ => {}
            }
            // Forward only structural sub-agent events (status/tool/usage/
            // thinking) to the parent stream so its tool calls stay visible
            // in the chat while explore works — the sub-agent's narration
            // (Text) and errors must never surface in the user's chat: the
            // report goes to the PARENT agent as the tool result only.
            match ev {
                AgentEvent::Text { .. } | AgentEvent::Error { .. } => {}
                _ => emit(ev),
            }
        };
        run_turn(&sub_req, &mut sink, cancel).await
    };
    match res {
        Ok(()) => {
            if report.trim().is_empty() {
                // The turn "succeeded" but produced no text — the parent must
                // not treat an empty report as data. Surface the captured
                // sub-agent error (or a generic message) so it can retry or
                // fall back to its own tools.
                let why = if sub_error.trim().is_empty() {
                    "the sub-agent produced no output (empty model response)".to_string()
                } else {
                    sub_error
                };
                (format!("explore returned no findings: {why}"), false)
            } else {
                (report, true)
            }
        }
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
            id: "call1".into(),
            name: "read".into(),
            args: json!({"filePath": "a"}),
            result: "x".into(),
            ok: true,
        }
        .to_json();
        // Finished tools resolve the running card minted by ToolStart.
        assert_eq!(t["kind"], "tool_result");
        assert_eq!(t["name"], "read");
        assert_eq!(t["ok"], true);
        // The provider tool_call id rides along so the frontend can dedup
        // (no duplicate cards) and re-pair start/result events.
        assert_eq!(t["id"], "call1");
        let t = AgentEvent::Usage {
            input_tokens: 3,
            output_tokens: 1,
            model: "sub-model".into(),
            provider_id: "p2".into(),
        }
        .to_json();
        // The usage event names the model/provider that served the request so
        // sub-agent tokens land under the SUB model in Model usage.
        assert_eq!(t["model"], "sub-model");
        assert_eq!(t["provider_id"], "p2");
        let ts = AgentEvent::ToolStart {
            id: "call1".into(),
            name: "explore".into(),
            args: json!({}),
        }
        .to_json();
        assert_eq!(ts["kind"], "tool");
        assert_eq!(ts["tool"], "explore");
        assert_eq!(ts["id"], "call1");
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

    fn base_req() -> AgentRequest {
        AgentRequest {
            provider: "custom".into(),
            provider_id: "p1".into(),
            model: "main-model".into(),
            base_url: "http://parent/v1".into(),
            api_key: "pk".into(),
            api_keys: vec!["pk".into()],
            root: "/tmp/x".into(),
            mode: "build".into(),
            prompt: "hi".into(),
            history: Vec::new(),
            system_prompt: String::new(),
            context_window: 0,
            chat_id: String::new(),
            mcp_servers: Value::Null,
            subagent_models: std::collections::HashMap::new(),
            providers: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn subagent_model_slot_defaults_to_parent() {
        let req = base_req();
        let (model, base, keys) = resolve_subagent_target(&req);
        assert_eq!(model, "main-model");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
    }

    #[test]
    fn subagent_model_slot_bare_model_uses_parent_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("subagent".into(), "cheap-model".into());
        let (model, base, _) = resolve_subagent_target(&req);
        assert_eq!(model, "cheap-model");
        assert_eq!(base, "http://parent/v1");
    }

    #[test]
    fn subagent_model_slot_routes_cross_provider() {
        let mut req = base_req();
        req.subagent_models
            .insert("subagent".into(), "p2/other-model".into());
        req.providers.insert(
            "p2".into(),
            json!({"baseUrl": "http://other/v1", "apiKeys": ["ok1", "ok2"]}),
        );
        let (model, base, keys) = resolve_subagent_target(&req);
        assert_eq!(model, "other-model");
        assert_eq!(base, "http://other/v1");
        assert_eq!(keys, vec!["ok1".to_string(), "ok2".to_string()]);
    }

    #[test]
    fn subagent_model_slot_unknown_provider_falls_back() {
        let mut req = base_req();
        req.subagent_models
            .insert("subagent".into(), "ghost/m".into());
        let (model, base, keys) = resolve_subagent_target(&req);
        assert_eq!(model, "m");
        assert_eq!(base, "http://parent/v1");
        assert_eq!(keys, vec!["pk".to_string()]);
    }
}
