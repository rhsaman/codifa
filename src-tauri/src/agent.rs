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
/// The explore sub-agent must answer in seconds, not minutes — a much smaller
/// step budget than the main agent's, with a forced final report (below).
const SUBAGENT_MAX_STEPS: usize = 12;
/// Cap on the tool result echoed to the UI (full result still goes to the LLM).
const TOOL_RESULT_CAP: usize = 4000;
/// Cap on the tool result forwarded to the MODEL: full multi-MB read/grep
/// outputs ballooned the context (76k-token turns) and made every LLM
/// round-trip crawl — the #1 cause of slow explore turns.
const MODEL_RESULT_CAP: usize = 16_000;
/// Sub-agent depth limit (mirrors graph.py: sub-agents cannot spawn more).
const MAX_SUBAGENT_DEPTH: usize = 1;

// ---------------------------------------------------------------------------
// Request / events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
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
    /// Skill names the user attached to this turn (@mention). Their full
    /// bodies are inlined into the system prompt, exactly like the Python
    /// sidecar's ATTACHED SKILLS section.
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub context_window: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub chat_id: String,
    #[serde(default)]
    pub mcp_servers: Value,
    /// Per-slot sub-agent model overrides from the UI's Tool Models settings
    /// (e.g. {"subagent": "providerId/model"}); empty = the parent model.
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    /// Full provider configs keyed by id, so a "providerId/model" sub-agent
    /// entry routes to THAT provider's base URL / keys (cross-provider).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
    /// The app data root (~/.codifa) where the skill store lives. Skills are
    /// NOT workspace files: `/skills` reads them from the data root, so the
    /// router must look there too — reading the workspace root found nothing
    /// and silently disabled both auto-match and the decision model.
    #[serde(default)]
    pub data_root: String,
    /// The composer's Computer Use switch. When false the `computer` tool is
    /// never bound, so the agent cannot touch the desktop at all.
    #[serde(default)]
    pub allow_computer: bool,
}

fn default_mode() -> String {
    "build".to_string()
}

/// App data root for the native agent (mirrors trace.rs's fallback: the
/// sidecar env var when set, else ~/.codifa).
fn native_data_root() -> String {
    if let Ok(d) = std::env::var("CODER_DATA_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".codifa").to_string_lossy().into_owned())
        .unwrap_or_else(|| ".codifa".into())
}

/// Extract the plan document from a plan-mode reply: from the first
/// `## Plan`-style heading (English or Persian) to the end. Returns
/// (title, body); None when the reply carries no plan heading.
fn extract_plan_body(text: &str) -> Option<(String, String)> {
    let mut start: Option<usize> = None;
    let mut title = String::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let is_heading = (trimmed.starts_with('#')
            && trimmed
                .trim_start_matches('#')
                .trim()
                .to_lowercase()
                .starts_with("plan"))
            || trimmed.starts_with("# پلن");
        if is_heading {
            start = Some(idx);
            title = trimmed.trim_start_matches('#').trim().to_string();
            break;
        }
    }
    let s = start?;
    let body: String = text.lines().skip(s).collect::<Vec<_>>().join("\n");
    if body.trim().is_empty() {
        return None;
    }
    Some((title, body))
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
    /// Plan mode finished: the collapsed plan document (title + markdown
    /// body) — the frontend renders it as the Plan card and the docked
    /// Plan viewer tab.
    PlanCard { title: String, body: String },
    /// Auto-matched / attached skills for this turn (the frontend renders
    /// them as ⚡ chips on the assistant message).
    Skills { skills: Vec<String>, manual: bool, note: Option<String> },
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
            AgentEvent::PlanCard { title, body } => {
                json!({"kind": "plan_card", "title": title, "body": body})
            }
            AgentEvent::Skills { skills, manual, note } => {
                let mut v = json!({"kind": "skill", "skills": skills, "manual": manual});
                if let Some(n) = note {
                    v["note"] = json!(n);
                }
                v
            }
            AgentEvent::Error { content } => json!({"kind": "error", "content": content}),
        }
    }
}

/// Tool schemas for the MAIN agent: no search/read tools — the main agent
/// delegates all research to the `explore` sub-agent and works only with the
/// data the sub-agent returns (user request: main agent must not search).
fn tool_schemas() -> Vec<Value> {
    // Per-tool schemas: the model only sees the args each tool actually
    // accepts — a shared all-fields block made it emit empty filler
    // (command:"", limit:0, filePath:""…) that garbled cards and traces.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "write_file",
            "Create or overwrite a file.",
            json!({"path": {"type": "string"}, "content": {"type": "string"}}),
        ),
        (
            "edit_file",
            "Replace an exact string in an existing file.",
            json!({
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
                "edits": {"type": "array", "items": {"type": "object"}}
            }),
        ),
        (
            "run_terminal",
            "Run a shell command in the workspace with a timeout.",
            json!({"command": {"type": "string"}, "timeout": {"type": "integer"}}),
        ),
        ("current_time", "Current UTC time.", json!({})),
        (
            "system_stats",
            "Read the OS process list (Activity Monitor): per-process RSS memory and CPU usage. Use it to diagnose memory/CPU issues. Args: filter (substring, optional) and top (how many rows, default 15).",
            json!({
                "filter": {"type": "string", "description": "Only processes whose command contains this substring (optional)"},
                "top": {"type": "integer", "description": "Max rows to return (default 15)"}
            }),
        ),
        (
            "load_skill",
            "Load the FULL body of one stored skill by name (or one of its extra files via `file`). Skills that obviously match the request are already inlined in your prompt — call this only for a skill you need but were not given.",
            json!({
                "name": {"type": "string", "description": "Skill name or slug"},
                "file": {"type": "string", "description": "Optional extra file of that skill"}
            }),
        ),
        (
            "explore",
            "Delegate ONE research question to the explore sub-agent (it reads files, greps, globs, runs LSP lookups and returns the FULL findings — you cannot search yourself). IMPORTANT: when a task spans several independent areas, call explore SEVERAL TIMES IN THE SAME STEP — parallel calls run CONCURRENTLY and cost one round-trip, while one giant explore is slow and returns a shallow report. Prefer 2-4 focused explores (one per area/file group) over a single broad one. Args: description (SHORT label for the UI, under 80 chars) and prompt (the full research question).",
            json!({
                "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                "prompt": {"type": "string", "description": "The full research question for the sub-agent"}
            }),
        ),
    ];
    schemas
        .iter()
        .map(|(name, desc, props)| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props},
                },
            })
        })
        .collect()
}

/// Tool schemas for the explore SUB-AGENT: the full read/search set the main
/// agent no longer has (read/grep/glob/LSP) plus memory search.
fn research_schemas() -> Vec<Value> {
    // Per-tool schemas (see tool_schemas): only the args each tool accepts.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "read",
            "Read ONE file (single filePath — never a list). Default window is 400 lines; pass offset/limit for one window or ranges=[{\"offset\":..,\"limit\":..},…] for SEVERAL windows of the same file in one call.",
            json!({
                "filePath": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
                "ranges": {"type": "array", "items": {"type": "object", "properties": {"offset": {"type": "integer"}, "limit": {"type": "integer"}}}}
            }),
        ),
        (
            "grep",
            "Regex content search. ALWAYS pass path (a directory or single file) and include (glob filter); keep patterns narrow (max 3 alternatives) and max_results small.",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "include": {"type": "string"},
                "max_results": {"type": "integer"}
            }),
        ),
        (
            "glob",
            "Find FILES (never directories) by glob. The pattern is matched against the path relative to `path`; `**/` matches zero or more directories and `*` never crosses `/`. ALWAYS pass path scoped to a real directory from the project layout. A 'no matches' answer is final — do not retry variations; use grep, or read a directory path to list it.",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "max_results": {"type": "integer"}
            }),
        ),
        (
            "find_symbol",
            "Definition(s) with their bodies PLUS every usage of ONE identifier, in a single call — replaces the grep -> lsp_definition -> lsp_references chain (three round trips) and needs no language server, so it works for every language. Pass symbol (a bare identifier: letters, digits, _ or $ — never a regex) and optionally path (directory or file) and include (glob filter) to scope it. Use this FIRST when the question names a symbol; fall back to lsp_* only when you need type/signature info.",
            json!({
                "symbol": {"type": "string", "description": "Bare identifier to look up (no regex)"},
                "path": {"type": "string", "description": "Directory or file to scope the search (optional)"},
                "include": {"type": "string", "description": "Glob filter such as *.rs (optional)"}
            }),
        ),
        (
            "lsp_definition",
            "Jump to the DEFINITION of a symbol and show its body (LSP) — more precise and cheaper than grep for \"where is X defined\". Pass filePath + symbol (the identifier as written in that file); line is an optional hint for repeated names. No need to know line/character.",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol (a usage or the declaration)"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_references",
            "Find ALL references/usages of a symbol across the workspace (LSP). Pass filePath + symbol (same as lsp_definition).",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_hover",
            "Type/signature/docs of a symbol (LSP). Pass filePath + symbol (same as lsp_definition).",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_symbols",
            "List the functions/classes/structs of ONE file with their line ranges (query filters by name). Use it instead of reading a large file just to find where something lives, then read only that window.",
            json!({"filePath": {"type": "string"}, "query": {"type": "string"}}),
        ),
        (
            "lsp_diagnostics",
            "Diagnostics for one file (LSP).",
            json!({"filePath": {"type": "string"}}),
        ),
        (
            "search_memory",
            "Search previously saved project notes.",
            json!({"query": {"type": "string"}}),
        ),
        (
            "save_memory",
            "Persist a durable note about the project for future sessions. Save ONLY key points: decisions, user preferences, gotchas, and facts worth remembering — never dump whole files, tool outputs or conversation text. Keep each note under ~500 chars.",
            json!({
                "content": {"type": "string", "description": "The key point to remember (concise, self-contained)"},
                "memory_type": {"type": "string", "description": "long_term (default) or short_term"}
            }),
        ),
        (
            "load_skill",
            "Load the FULL body of one stored skill by name (or one of its extra files via `file`). Skills that obviously match the request are already inlined in your prompt — call this only for a skill you need but were not given.",
            json!({
                "name": {"type": "string", "description": "Skill name or slug"},
                "file": {"type": "string", "description": "Optional extra file of that skill"}
            }),
        ),
    ];
    schemas
        .iter()
        .map(|(name, desc, props)| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": {"type": "object", "properties": props},
                },
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

static TURN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Cap the UI echo, record the trace row, emit the Tool event and push the
/// tool message — shared by the parallel (read-only batch) and sequential
/// tool paths so both produce identical cards/traces/model messages.
fn finish_tool(
    messages: &mut Vec<Value>,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    trace: &crate::trace::TraceStore,
    id: &str,
    name: &str,
    args: &Value,
    result: String,
    ok: bool,
    sub: bool,
) {
    // UI echo is capped; cap on a UTF-8 char boundary — byte slicing
    // mid-char panics on Persian text.
    let mut shown = result.clone();
    if shown.len() > TOOL_RESULT_CAP {
        let mut end = TOOL_RESULT_CAP;
        while end > 0 && !shown.is_char_boundary(end) {
            end -= 1;
        }
        shown.truncate(end);
        shown.push_str("\n… (truncated)");
    }
    // Trace: one tool row per executed call (args + result).
    trace.record(crate::trace::TraceEntry {
        kind: "tool".into(),
        summary: name.to_string(),
        prompt: Some(serde_json::to_string(args).unwrap_or_default()),
        result: Some(shown.clone()),
        detail: Some(serde_json::json!({
            "name": name,
            "ok": ok,
            "sub": sub,
        })),
        ..Default::default()
    });
    emit(&AgentEvent::Tool {
        id: id.to_string(),
        name: name.to_string(),
        args: args.clone(),
        result: shown,
        ok,
    });
    // The model receives a capped copy too — a narrower re-read is one
    // cheap tool call; an unbounded context is seconds per round-trip.
    let mut for_model = result;
    if for_model.len() > MODEL_RESULT_CAP {
        let mut end = MODEL_RESULT_CAP;
        while end > 0 && !for_model.is_char_boundary(end) {
            end -= 1;
        }
        for_model.truncate(end);
        // The main agent has no read tool, so "re-read a narrower window" would
        // be a dead end for an explore report — point it at explore instead.
        if name == "explore" || name == "task" {
            for_model.push_str(
                "\n… [report truncated for the model — ask explore again with a narrower question]",
            );
        } else {
            for_model.push_str(
                "\n… [truncated for the model — re-read a narrower offset/limit window if you need more]",
            );
        }
    }
    messages.push(json!({
        "role": "tool",
        "tool_call_id": id,
        "content": for_model,
    }));
}

/// Run one full agent turn: stream the model, execute tool calls, repeat
/// until the model answers without tool calls or MAX_STEPS is reached.
/// Emits the same event protocol as the Python graph.
pub async fn run_turn(
    req: &AgentRequest,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
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
    let mut system = if req.system_prompt.is_empty() {
        default_system_prompt(&req.mode, &root)
    } else {
        req.system_prompt.clone()
    };
    // Skills: the user's @mentions plus the auto-match are inlined as full
    // bodies (mirror of graph.py's SKILLS section). No picks = no tokens.
    // The "decision" Tool Models slot, when set, picks the skills with a model
    // call; otherwise the deterministic in-code matcher runs (no extra call).
    let client = http_client();
    let decision_cfg = req.subagent_models.get("decision").and_then(|slot| {
        if slot.trim().is_empty() {
            return None;
        }
        let (model, base_url, api_keys) = crate::backend_light::resolve_slot_target(
            slot,
            &req.model,
            &req.base_url,
            &cfg.api_keys,
            &req.providers,
        );
        Some(LlmConfig {
            // `provider` is the KIND (openrouter/anthropic/google/custom…):
            // endpoint_and_auth switches on it to pick the URL path + auth
            // header. Using the user-configured provider_id here sent every
            // anthropic/google decision call to the OpenAI-compatible path.
            provider: crate::backend_light::resolve_slot_kind(
                slot,
                &req.provider,
                &req.providers,
            ),
            model,
            base_url,
            api_keys,
            temperature: Some(0.0),
            max_tokens: Some(32),
            timeout_secs: 30,
        })
    });
    let skill_section = crate::skill_router::build_section_async(
        // The skill store lives in the DATA root, not the workspace.
        if req.data_root.is_empty() {
            &root
        } else {
            &req.data_root
        },
        &req.prompt,
        &req.skills,
        decision_cfg.as_ref().map(|c| (&client, c)),
    )
    .await;
    if !skill_section.text.is_empty() {
        system.push_str(&skill_section.text);
    }
    if !skill_section.auto.is_empty() {
        emit(&AgentEvent::Skills {
            skills: skill_section.auto.clone(),
            manual: false,
            note: None,
        });
    }
    if !skill_section.missing.is_empty() {
        emit(&AgentEvent::Skills {
            skills: Vec::new(),
            manual: true,
            note: Some(format!(
                "Attached skills not found — they may have been deleted or renamed: {}. The turn runs without them.",
                skill_section.missing.join(", ")
            )),
        });
    }
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
    // Separate context/autocompact for the explore sub-agent (user request):
    // its message list is compacted against its OWN budget — never the main
    // agent's history or window.
    if req.mode == "subagent" {
        compact_subagent_messages(&mut messages, req.context_window as usize);
    }

    let client = http_client();
    emit(&AgentEvent::Status {
        stage: "thinking".into(),
        content: "Contacting model".into(),
    });    // Trace: the full system prompt of this turn (prompt row, like Python).
    trace.record(crate::trace::TraceEntry {
        kind: "prompt".into(),
        summary: format!("prompt · {} chars", system.len()),
        prompt: Some(system.clone()),
        ..Default::default()
    });

    // The explore sub-agent gets the full read/search set; the main agent
    // deliberately has NO search tools and must delegate via `explore`.
    let mut schemas = if req.mode == "subagent" {
        research_schemas()
    } else {
        tool_schemas()
    };
    // MCP connectors switched on in the composer become extra tools named
    // `mcp__<server>__<tool>`; their schemas come from each server's
    // tools/list. A connector that fails to start contributes no tools — but
    // the reason is surfaced as a warning, so "the agent has no browser tool"
    // is never a silent mystery again.
    let (mcp_schemas, mcp_failures) = crate::mcp::tool_schemas(&req.mcp_servers, &req.chat_id);
    for failure in mcp_failures {
        emit(&AgentEvent::Warn { content: failure });
    }
    // The exact names the model will call. A connector tool whose name is
    // unique across the enabled servers is advertised BARE (`browser_navigate`)
    // so the model sees short readable names; dispatch therefore cannot rely on
    // the `mcp__` prefix alone. Without this set a bare call fell through to
    // the native dispatcher and failed with "not available natively" — the
    // browser tool looked broken even though the connector was running.
    let mcp_names: std::collections::HashSet<String> = mcp_schemas
        .iter()
        .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
        .collect();
    schemas.extend(mcp_schemas);
    // Desktop control is a hard on/off switch (composer → Computer Use): when
    // it is off the tool is never bound, so the model cannot even try.
    if req.allow_computer && req.mode != "subagent" {
        schemas.push(crate::computer::schema());
    }

    let max_steps = if req.mode == "subagent" {
        SUBAGENT_MAX_STEPS
    } else {
        MAX_STEPS
    };
    for step in 0..max_steps {
        // Client disconnect (Stop button closes the SSE stream) flips the
        // cancel flag — bail out instead of burning provider tokens.
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            emit(&AgentEvent::Done { aborted: true });
            return Ok(());
        }
        // Budget nudge (explore only): make the sub-agent report while it
        // still has calls left instead of running out silently.
        if req.mode == "subagent" && step + 3 == max_steps {
            messages.push(json!({
                "role": "user",
                "content": "Tool budget nearly exhausted — report your findings in your NEXT answer; only call a tool if it is essential."
            }));
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
        let acc = match stream_chat(&client, &cfg, &messages, Some(&schemas), &mut sink, Some(cancel)).await
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
            // Plan mode: persist the plan document to disk (native plans.rs,
            // same layout the Python sidecar used) and emit plan_card so the
            // frontend collapses the streamed plan into its Plan card.
            if req.mode == "plan" {
                if let Some((title, body)) = extract_plan_body(&text) {
                    let data_root = native_data_root();
                    let ws = crate::plans::workspace_slug_for_root(&root);
                    let _ = crate::plans::save_plan(
                        &data_root,
                        &ws,
                        &title,
                        &body,
                        &req.chat_id,
                    );
                    emit(&AgentEvent::PlanCard {
                        title,
                        body,
                    });
                }
            }
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

        // Read-only tools are side-effect free: run the step's batch
        // concurrently (spawn_blocking + join) so N parallel greps cost one
        // round-trip instead of N sequential ones — the explore sub-agent's
        // wall time is dominated by these. Mutating tools and sub-agents
        // stay sequential (ordering + cancel semantics).
        let is_readonly = |name: &str| {
            // An MCP tool is never batched as read-only: it may mutate remote
            // state, and a bare connector name could otherwise shadow a native
            // tool of the same name.
            !mcp_names.contains(name)
                && matches!(
                    name,
                    "read" | "grep" | "glob" | "find_symbol" | "current_time" | "system_stats"
                        | "search_memory" | "load_skill" | "lsp_definition" | "lsp_references"
                        | "lsp_hover" | "lsp_symbols" | "lsp_diagnostics"
                )
        };
        let mut batch: Vec<(String, String, Value)> = Vec::new();
        let mut sequential: Vec<(String, String, String)> = Vec::new();
        for (id, name, raw_args) in &tool_calls {
            if is_readonly(name) {
                let args: Value = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: name.clone(),
                });
                emit(&AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                });
                batch.push((id.clone(), name.clone(), args));
            } else {
                sequential.push((id.clone(), name.clone(), raw_args.clone()));
            }
        }
        if !batch.is_empty() {
            let root_c = root.clone();
            let handles: Vec<_> = batch
                .iter()
                .map(|(_, name, args)| {
                    let root = root_c.clone();
                    let name = name.clone();
                    let args = args.clone();
                    tokio::task::spawn_blocking(move || {
                        match tools::dispatch(&root, &name, &args, None) {
                            Ok(r) => (r, true),
                            Err(e) => (e, false),
                        }
                    })
                })
                .collect();
            for ((id, name, args), handle) in batch.into_iter().zip(handles) {
                let (result, ok) = handle
                    .await
                    .unwrap_or(("tool task failed".into(), false));
                finish_tool(
                    &mut messages,
                    emit,
                    &trace,
                    &id,
                    &name,
                    &args,
                    result,
                    ok,
                    req.mode == "subagent",
                );
            }
        }
        // Explore sub-agents in one step run CONCURRENTLY (tokio::spawn +
        // join): the model often fires several research questions at once and
        // each takes seconds — sequential execution multiplies the wall time.
        // Mutating tools stay sequential (ordering + cancel semantics).
        let mut explore_batch: Vec<(String, String, Value)> = Vec::new();
        let mut rest: Vec<(String, String, String)> = Vec::new();
        for call in sequential {
            if call.1 == "explore" || call.1 == "task" {
                let args: Value =
                    serde_json::from_str(&call.2).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: call.1.clone(),
                });
                emit(&AgentEvent::ToolStart {
                    id: call.0.clone(),
                    name: call.1.clone(),
                    args: args.clone(),
                });
                explore_batch.push((call.0, call.1, args));
            } else {
                rest.push(call);
            }
        }
        if !explore_batch.is_empty() {
            // Concurrent explores polled in THIS task via join_all — no
            // tokio::spawn, so no Send bound and the turn still blocks until
            // every report is back (explore stays synchronous by design).
            // Structural events (tool cards/status/usage) flow through a
            // channel to the parent stream so parallel explores stay VISIBLE
            // in the chat while they work; Text/Error stay inside each
            // sub-agent's own report (never surfaced in the chat).
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
            let futures: Vec<_> = explore_batch
                .iter()
                .map(|(_id, _name, args)| {
                    let req_c = req.clone();
                    let args_c = args.clone();
                    let cancel_c = std::sync::Arc::clone(cancel);
                    let tx = tx.clone();
                    Box::pin(async move {
                        let mut sink = move |ev: &AgentEvent| {
                            let _ = tx.send(ev.clone());
                        };
                        run_subagent(&req_c, &args_c, &mut sink, &cancel_c).await
                    })
                })
                .collect();
            // Drop our sender so rx.recv() returns None once every explore
            // has finished and the forward loop can end.
            drop(tx);
            let sub_all = futures_util::future::join_all(futures);
            let forward = async {
                while let Some(ev) = rx.recv().await {
                    // Stop must also abort the concurrent explores: the shared
                    // cancel flag is checked on every forwarded event.
                    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    match ev {
                        AgentEvent::Text { .. } | AgentEvent::Error { .. } => {}
                        _ => emit(&ev),
                    }
                }
            };
            let (results, _) = tokio::join!(sub_all, forward);
            for ((id, name, args), (result, ok)) in explore_batch.into_iter().zip(results) {
                finish_tool(
                    &mut messages,
                    emit,
                    &trace,
                    &id,
                    &name,
                    &args,
                    result,
                    ok,
                    req.mode == "subagent",
                );
            }
        }
        for (id, name, raw_args) in &rest {
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
            let (result, ok) = if name == "run_terminal"
                && req.mode != "subagent"
                && is_file_search_command(args["command"].as_str().unwrap_or_default())
            {
                (
                    "blocked: the main agent must not locate files via the terminal — delegate file discovery to the `explore` sub-agent".into(),
                    false,
                )
            } else if name == "computer" {
                // Bound only when the user enabled Computer Use; the schema is
                // withheld otherwise, so reaching here means it is allowed.
                match crate::computer::run(&args) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else if mcp_names.contains(name) || name.starts_with(crate::mcp::TOOL_PREFIX) {
                match crate::mcp::call_tool(&req.mcp_servers, name, &args, &req.chat_id) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else {
                match tools::dispatch(&root, name, &args, None) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            };
            finish_tool(
                &mut messages,
                emit,
                &trace,
                id,
                name,
                &args,
                result,
                ok,
                req.mode == "subagent",
            );
        }

        // Explore only: a step with a single call is a wasted model round trip
        // when more lookups were foreseeable. The hint rides on that call's
        // own result, so it costs no extra request and never cuts a report.
        if let Some(hint) = single_call_hint(&req.mode, tool_calls.len()) {
            if let Some(last) = messages.last_mut() {
                if last["role"].as_str() == Some("tool") {
                    if let Some(c) = last["content"].as_str() {
                        last["content"] = json!(format!("{c}\n\n{hint}"));
                    }
                }
            }
        }
    }

    // Budget exhausted. The explore sub-agent must still hand the parent its
    // findings: fold the tool results it already gathered into a report —
    // no forced extra model call (the data is already in context).
    if req.mode == "subagent" {
        let mut report =
            String::from("[Tool budget exhausted] Findings gathered so far:\n");
        for m in messages.iter().rev() {
            if m["role"].as_str() != Some("tool") {
                continue;
            }
            let c = m["content"].as_str().unwrap_or_default();
            if c.trim().is_empty() {
                continue;
            }
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            let mut end = 600.min(c.len());
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            report.push_str("- ");
            report.push_str(&c[..end]);
            report.push_str("…\n");
            if report.len() > 8000 {
                break;
            }
        }
        emit(&AgentEvent::Text { content: report });
        emit(&AgentEvent::Done { aborted: false });
        return Ok(());
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

/// Compact the explore sub-agent's message list independently of the main
/// agent's history (user request: explore context/autocompact must be
/// separate). Mirrors compact.rs but with a smaller budget: the sub-agent
/// only needs its recent tool results + the report it is building.
fn compact_subagent_messages(messages: &mut Vec<Value>, ctx: usize) {
    // Rough token estimate: ~4 chars per token (same heuristic as compact.rs).
    let est = |m: &Value| -> usize { m["content"].as_str().map(|c| c.len().div_ceil(4)).unwrap_or(0) };
    let total: usize = messages.iter().map(&est).sum();
    // Keep ~60% of the context window usable; compact when over.
    let budget = ctx.saturating_sub(2048).max(4096) * 60 / 100;
    if total <= budget {
        return;
    }
    // Keep the system prompt (index 0) and the last few messages verbatim;
    // summarize the middle into one user message.
    let mut start = messages.len() - 4.min(messages.len().saturating_sub(1));
    // Never orphan a tool message: if the tail would START with a `tool`
    // reply whose assistant tool_calls got compacted away, extend the tail
    // back until it starts with a non-tool message (providers reject orphans).
    while start > 1 && messages[start]["role"].as_str() == Some("tool") {
        start -= 1;
    }
    let head = messages[0].clone();
    let mid: Vec<Value> = messages[1..start].to_vec();
    let tail: Vec<Value> = messages[start..].to_vec();
    let mut summary = String::from("[Earlier research compacted] Key findings so far:\n");
    for m in &mid {
        let c = m["content"].as_str().unwrap_or_default();
        if c.len() > 400 {
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            let mut end = 400;
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            summary.push_str(&format!("- {}…\n", &c[..end]));
        } else if !c.is_empty() {
            summary.push_str(&format!("- {c}\n"));
        }
    }
    *messages = vec![
        head,
        json!({"role": "user", "content": summary}),
    ];
    messages.extend(tail);
}

/// Shared cancel flag for spawned sub-agent tasks: flipping the parent's
/// flag (Stop button) aborts every concurrent explore too.
type CancelFlag = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// True when a shell command tries to LOCATE files (find/grep/rg/ls/…).
/// The main agent has no search tools by design — file discovery must go
/// through the explore sub-agent, not terminal one-liners (user request).
fn is_file_search_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    // Check every pipeline/chain segment, not just the first token.
    lower
        .split([';', '|', '&', '\n'])
        .any(|seg| {
            let t = seg.trim();
            ["find", "grep", "rg", "ls", "fd", "locate", "tree", "glob"]
                .iter()
                .any(|p| t == *p || t.starts_with(&format!("{p} ")))
        })
}

/// Fold one sub-agent event into its report / error buffers. Text streamed
/// BEFORE a search tool call is narration ("let me search…"), not the report:
/// it is dropped when the tool starts, so only the answer written after the
/// LAST search tool reaches the main agent (it used to receive every step's
/// chatter, resent on each later step). Memory tools are exempt so a report
/// written in the same step as save_memory survives.
fn fold_subagent_event(report: &mut String, sub_error: &mut String, ev: &AgentEvent) {
    match ev {
        AgentEvent::Text { content } => report.push_str(content),
        // Capture the sub-agent's error so an empty report can say WHY it is
        // empty (provider 400/401, tool failure, …).
        AgentEvent::Error { content } => sub_error.push_str(content),
        AgentEvent::ToolStart { name, .. }
            if name.as_str() != "save_memory" && name.as_str() != "search_memory" =>
        {
            report.clear()
        }
        _ => {}
    }
}

/// Batching reminder appended to the result of an explore step that issued a
/// single tool call. Read-only calls of one step run in parallel, so every
/// extra step costs seconds (one model round trip) for no extra information.
fn single_call_hint(mode: &str, calls_in_step: usize) -> Option<&'static str> {
    (mode == "subagent" && calls_in_step == 1).then_some(
        "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together (other greps, find_symbol, lsp_symbols, reads of the exact windows), then write the report.",
    )
}

/// System prompt of the explore sub-agent: the research strategy plus a compact
/// project layout, so it starts from REAL paths instead of guessing with glob
/// (a traced run burned ~20 calls hunting for `backend/`), and explicit LSP
/// guidance (the old prompt never mentioned LSP, so the model never used it).
fn explore_system_prompt(root: &str) -> String {
    let layout = tools::layout_snapshot(root, 3500);
    format!(
        "You are the explore sub-agent inside the workspace {root}. \
The main agent waits on you and cannot search itself, so be fast and precise. \
Every model round trip costs seconds while tools cost milliseconds, so what matters \
is the number of ROUNDS (steps), not the number of calls: issue every call you can \
already foresee together in ONE step (they run in parallel) — a grep per \
identifier/keyword variant, lsp_symbols for likely files, reads of files the \
question names — then act on all the results at once. Aim for 2-3 rounds.\n\n\
How to search — never blindly. First decide what the question gives you, enter at \
the matching step below, and move from the cheapest PRECISE tool to the next:\n\
1. Paths and directories come from PROJECT LAYOUT (below), never from guessing. \
glob lists FILES only (never directories) and matches the pattern against the \
path relative to `path`; `**/` matches zero or more directories. To list a \
directory, read its path. A 'no matches' answer is final: do NOT retry it with \
variations — switch tool, or re-read the layout.\n\
2. The question names a FILE (or the layout makes the file obvious): lsp_symbols \
on it (names + line ranges), then read ONLY the window you need. Never read a big \
file whole.\n\
3. The question names a SYMBOL / identifier: ONE find_symbol call with the bare \
identifier (scope it with path/include taken from the layout) — it returns the \
definition(s) with their bodies AND the usages together, so it replaces the \
grep -> lsp_definition -> lsp_references chain. Reach for lsp_definition / \
lsp_references only when you need type/signature info or the language server's \
view of a name find_symbol could not resolve.\n\
4. The question describes a BEHAVIOUR with no names: ONE grep scoped to the likely \
directory/include with 2-3 alternative keywords (a|b|c) — several such greps for \
different directories go in the same step; then continue from step 2 or 3 on what \
it found.\n\
5. If an lsp_* tool says the language server is unavailable, stop using LSP for \
that language and use grep + read.\n\
6. Before each step, for every call ask: which exact question does it answer, and \
what will I do differently depending on the result? Drop any call that cannot \
change your next action. Grep shows only a few lines around each hit — read the \
window you need, but never re-read what a result already showed and never repeat \
a search with the same pattern.\n\n\
FINAL REPORT (your only text output — write nothing between tool calls): the \
main agent has no read tool and edits files with exact-match strings, so precision \
matters and padding costs it tokens on every later step. Format:\n\
(a) ANSWER: 2-4 lines that directly answer the question.\n\
(b) CODE: VERBATIM excerpts, each with path:start-end, ONLY for code it must edit \
or rely on — copy the exact text, never paraphrase code.\n\
(c) ALSO RELEVANT: other locations as `path:line — one line`.\n\
Leave out the search trail, dead ends, irrelevant files and any restating of the \
question. Aim for under ~6 KB.\n\
You have NO write tools: never modify files. When you learn a durable key point \
(decision, preference, gotcha), save it with save_memory — concise, under ~500 \
chars, never whole files or outputs. Report in English.\n\n\
PROJECT LAYOUT (dir: entries; hidden dirs and build output omitted):\n{layout}"
    )
}

async fn run_subagent(
    parent: &AgentRequest,
    args: &Value,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
    cancel: &CancelFlag,
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
        system_prompt: explore_system_prompt(&parent.root),
        skills: Vec::new(),
        context_window: parent.context_window,
        chat_id: parent.chat_id.clone(),
        mcp_servers: Value::Null,
        subagent_models: std::collections::HashMap::new(),
        providers: parent.providers.clone(),
        data_root: parent.data_root.clone(),
        // Sub-agents are research-only: desktop control is never delegated.
        allow_computer: false,
    };

    let mut report = String::new();
    let mut sub_error = String::new();
    let res = {
        let mut sink = |ev: &AgentEvent| {
            fold_subagent_event(&mut report, &mut sub_error, ev);
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
When a task spans several independent areas, fire SEVERAL `explore` calls \
IN THE SAME STEP (they run concurrently, one round-trip) — one focused \
explore per area/file group, never a single broad one. \
NEVER use run_terminal to find or inspect files (find/grep/rg/ls) — file \
discovery goes through `explore` only; run_terminal is for builds, tests \
and git. \
Use write_file/edit_file/run_terminal to make changes. \
Only run `git commit` when the user EXPLICITLY asks for it — never commit \
on your own initiative. \
A system message holding a compacted summary is AUTHORITATIVE history: every \
item under its 'Work completed' ledger is already DONE — never redo, re-verify \
or re-implement it, and never re-read a file just to confirm a change listed \
there. Continue from its 'Next steps' only. \
The conversation itself is the same kind of record: before you start any task, \
scan the turns above (and any '[Interrupted before finishing. Already done this \
turn]' block) for work that is ALREADY DONE. If a fix, file edit or commit is \
listed there, it is finished — do NOT redo it, do NOT re-verify it, and do NOT \
re-implement it from scratch. Say what is already done and continue from what \
is actually left. Redoing finished work is a bug, not thoroughness. \
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
    fn compact_subagent_never_orphans_tool_messages() {
        // If the tail boundary lands on a `tool` message whose assistant
        // tool_calls were compacted away, providers reject the orphan with
        // a 400. The tail must extend back to keep the pair together.
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..40 {
            messages.push(json!({
                "role": "user",
                "content": "متن فارسی طولانی برای عبور از بودجه ی اتوکامپکت ".repeat(30),
            }));
        }
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{ "id": "c1", "type": "function" }],
        }));
        messages.push(json!({ "role": "tool", "tool_call_id": "c1", "content": "نتیجه ابزار" }));
        messages.push(json!({ "role": "user", "content": "ادامه بده" }));
        messages.push(json!({ "role": "assistant", "content": "پاسخ" }));
        messages.push(json!({ "role": "user", "content": "یکی دیگر" }));
        compact_subagent_messages(&mut messages, 4096);
        // Every tool message must be preceded by its assistant tool_calls.
        for (i, m) in messages.iter().enumerate().skip(1) {
            if m["role"] == "tool" {
                assert!(
                    messages[i - 1]["tool_calls"].is_array(),
                    "orphan tool message at index {i}"
                );
            }
        }
    }

    #[test]
    fn compact_subagent_messages_persian_char_boundaries() {
        // The explore sub-agent compacts Persian content — the 400-byte cut
        // used to slice mid-char and panic (compact.rs:103 crash report).
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        for _ in 0..50 {
            messages.push(json!({
                "role": "user",
                "content": "این یک متن فارسی طولانی برای آزمایش برش ایمن نویسه‌هاست ".repeat(20),
            }));
        }
        messages.push(json!({ "role": "user", "content": "گزارش نهایی" }));
        compact_subagent_messages(&mut messages, 4096);
        // Head + summary + tail survive, all valid UTF-8 (no panic above).
        assert!(messages.len() >= 3);
        assert!(messages[0]["content"] == "sys");
        let summary = messages[1]["content"].as_str().unwrap();
        assert!(summary.contains("[Earlier research compacted]"));
        assert!(messages.last().unwrap()["content"] == "گزارش نهایی");
    }

    #[test]
    fn tool_schemas_main_agent_has_no_search_tools() {
        let schemas = tool_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        // Main agent must NOT have search/read tools — research is delegated.
        // Memory tools live on the explore sub-agent too (user request).
        for banned in ["read", "grep", "glob", "find_symbol", "lsp_definition", "lsp_symbols", "save_memory", "search_memory"] {
            assert!(!names.contains(&banned), "main agent must not have {banned}");
        }
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"run_terminal"));
    }

    #[test]
    fn explore_schema_asks_for_parallel_calls() {
        // The model only parallelizes when the tool description says so: one
        // broad explore used to be the default and made turns slow/shallow.
        let schemas = tool_schemas();
        let desc = schemas
            .iter()
            .find(|s| s["function"]["name"] == "explore")
            .and_then(|s| s["function"]["description"].as_str())
            .unwrap();
        assert!(desc.contains("SEVERAL TIMES IN THE SAME STEP"), "{desc}");
        assert!(desc.contains("CONCURRENTLY"), "{desc}");
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
            "find_symbol",
            "lsp_definition",
            "lsp_references",
            "lsp_hover",
            "lsp_symbols",
            "lsp_diagnostics",
            "search_memory",
            "save_memory",
        ] {
            assert!(names.contains(&expected), "missing schema: {expected}");
        }
        // The sub-agent must not be able to write or spawn agents.
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"explore"));
    }

    #[test]
    fn explore_prompt_carries_layout_and_lsp_guidance() {
        let dir = std::env::temp_dir().join(format!("codifa-explore-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        std::fs::write(dir.join("backend/server.py"), "").unwrap();
        let p = explore_system_prompt(dir.to_str().unwrap());
        // Real paths up front, so the model never has to glob for them.
        assert!(p.contains("backend/: server.py"), "{p}");
        // LSP + glob semantics are spelled out (the old prompt never named LSP).
        assert!(p.contains("lsp_definition") && p.contains("lsp_references") && p.contains("lsp_symbols"));
        // find_symbol is the one-call replacement for the grep -> lsp chain.
        assert!(p.contains("find_symbol"), "{p}");
        assert!(p.contains("FILES only") && p.contains("no matches"));
        // Still read-only and English-reporting.
        assert!(p.contains("NO write tools") && p.contains("Report in English"));
        // Report contract: answer first, verbatim code only where it is needed.
        assert!(p.contains("ANSWER") && p.contains("VERBATIM") && p.contains("nothing between tool calls"));
        // Latency guidance: rounds (not calls) are the cost, batch in ONE step.
        assert!(p.contains("ROUNDS") && p.contains("ONE step"), "{p}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_report_keeps_only_text_after_the_last_search_tool() {
        let mut report = String::new();
        let mut err = String::new();
        let text = |s: &str| AgentEvent::Text { content: s.into() };
        let tool = |n: &str| AgentEvent::ToolStart { id: "i".into(), name: n.into(), args: json!({}) };
        fold_subagent_event(&mut report, &mut err, &text("Let me search..."));
        fold_subagent_event(&mut report, &mut err, &tool("grep"));
        fold_subagent_event(&mut report, &mut err, &text("Now reading..."));
        fold_subagent_event(&mut report, &mut err, &tool("read"));
        fold_subagent_event(&mut report, &mut err, &text("ANSWER: x"));
        assert_eq!(report, "ANSWER: x");
        // A report written in the same step as save_memory survives it.
        fold_subagent_event(&mut report, &mut err, &tool("save_memory"));
        fold_subagent_event(&mut report, &mut err, &text(" (saved)"));
        assert_eq!(report, "ANSWER: x (saved)");
        fold_subagent_event(&mut report, &mut err, &AgentEvent::Error { content: "boom".into() });
        assert_eq!(err, "boom");
    }

    #[test]
    fn single_call_steps_of_explore_get_a_batching_hint() {
        assert!(single_call_hint("subagent", 1).unwrap().contains("NEXT step"));
        // Batched steps and the main agent's steps are left alone.
        assert!(single_call_hint("subagent", 3).is_none());
        assert!(single_call_hint("agent", 1).is_none());
    }

    #[test]
    fn explore_report_truncation_does_not_point_at_a_missing_read_tool() {
        let mut messages: Vec<Value> = Vec::new();
        let mut emit = |_: &AgentEvent| {};
        let trace = crate::trace::TraceStore::new(String::new());
        let big = "x".repeat(MODEL_RESULT_CAP + 100);
        finish_tool(&mut messages, &mut emit, &trace, "c1", "explore", &json!({}), big.clone(), true, false);
        let c = messages[0]["content"].as_str().unwrap();
        assert!(c.contains("ask explore again") && !c.contains("offset/limit"));
        finish_tool(&mut messages, &mut emit, &trace, "c2", "read", &json!({}), big, true, true);
        assert!(messages[1]["content"].as_str().unwrap().contains("offset/limit"));
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
    fn load_skill_returns_body_and_lists_names_when_missing() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-load-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sdir = dir.join("skills").join("movie-finder");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(
            sdir.join("skill.md"),
            "---\nname: Movie Finder\ndescription: find movies\n---\nBODY HERE\n",
        )
        .unwrap();
        std::fs::write(sdir.join("extra.md"), "EXTRA BODY").unwrap();
        let root = dir.to_str().unwrap();

        let body = dispatch(root, "load_skill", &json!({"name": "Movie Finder"}), None).unwrap();
        assert!(body.contains("BODY HERE"), "{body}");
        assert!(body.contains("Extra files: extra.md"), "{body}");
        // Slug works too, and an extra file is readable on demand.
        let extra = dispatch(root, "load_skill", &json!({"name": "movie-finder", "file": "extra.md"}), None).unwrap();
        assert_eq!(extra, "EXTRA BODY");
        // A miss names the available skills instead of a bare error.
        let err = dispatch(root, "load_skill", &json!({"name": "Ghost"}), None).unwrap_err();
        assert!(err.contains("Movie Finder"), "{err}");
        assert!(dispatch(root, "load_skill", &json!({}), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
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
            skills: Vec::new(),
            context_window: 0,
            chat_id: String::new(),
            mcp_servers: Value::Null,
            subagent_models: std::collections::HashMap::new(),
            providers: std::collections::HashMap::new(),
            data_root: String::new(),
            allow_computer: false,
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
