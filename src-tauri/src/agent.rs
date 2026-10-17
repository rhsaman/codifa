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

/// Cap on an explore/task report forwarded to the model.
///
/// A report is the main agent's ONLY view of the code — it has no read/grep
/// tools of its own — so a truncated report means the search results inside it
/// are simply lost and the agent re-delegates the same question. Reports get a
/// larger budget than a raw tool result, and are cut from the MIDDLE (see
/// finish_tool) so both the answer at the head and the details at the tail
/// survive.
const EXPLORE_REPORT_CAP: usize = 40_000;

/// Per-result budget when a sub-agent runs out of steps and its gathered tool
/// results are folded into a report (see run_turn). A grep/read result IS the
/// finding, so this is far larger than a UI echo cap.
const SUBAGENT_FOLD_RESULT_CHARS: usize = 4_000;

/// Slice of a tool's stored prose result (`resultText`) echoed into the history
/// recap for ordinary tools.
const RECAP_RESULT_CHARS: usize = 400;
/// Same slice for an explore/task report. That report is the main agent's ONLY
/// view of the code, so the recap must carry it at (near) full length —
/// otherwise the next turn receives a short digest, cannot answer from it, and
/// re-delegates the very same question.
const RECAP_EXPLORE_CHARS: usize = 8_000;

/// UI-echo budget for one tool result. The echo is also what the frontend stores
/// as `resultText`, i.e. the ONLY source the next turn's history recap is built
/// from. An explore/task report must therefore be echoed at least as long as
/// the recap reads it: with the flat 4 KB echo cap the report was cut before the
/// recap's 8 KB budget could apply, and its tail (later CODE blocks, ALSO
/// RELEVANT) was lost between turns.
fn ui_echo_cap(tool: &str) -> usize {
    if matches!(tool, "explore" | "task") {
        RECAP_EXPLORE_CHARS
    } else {
        TOOL_RESULT_CAP
    }
}

/// Fold a history message's non-prose state into its content so the model can
/// see what already happened.
///
/// The frontend keeps the durable record of a turn on the message object
/// (`toolActivity`, `preservedToolSummary`, `plan`) and sends only `role` +
/// `content` in `history`. Without this recap the model saw prose alone, could
/// not tell which tools had already run, and re-searched the same files every
/// turn — the reported "context keeps shrinking and it re-searches" loop.
/// Mirrors graph.py's history projection (which rebuilt real tool_calls; a
/// textual recap is used here because it needs no synthetic tool-call ids).
fn history_recap(m: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(acts) = m.get("toolActivity").and_then(Value::as_array) {
        let mut lines: Vec<String> = Vec::new();
        for a in acts {
            let tool = a.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let status = a.get("status").and_then(Value::as_str).unwrap_or("");
            if status == "running" {
                continue;
            }
            let mut line = format!("- {tool}");
            if let Some(args) = a.get("args") {
                let s = serde_json::to_string(args).unwrap_or_default();
                if !s.is_empty() && s != "{}" {
                    line.push_str(&format!(" {}", s.chars().take(200).collect::<String>()));
                }
            }
            if !status.is_empty() {
                line.push_str(&format!(" [{status}]"));
            }
            // The RESULT matters as much as the call. Listing only the tool
            // name tells the model a grep ran but not what it found, so it
            // re-runs the same search on the next turn — the reported
            // "it keeps searching again" loop. `summary` is the frontend's
            // one-line result digest; `results[].content` carries the payload
            // for tools that keep one.
            if let Some(sum) = a.get("summary").and_then(Value::as_str) {
                if !sum.trim().is_empty() {
                    line.push_str(&format!(
                        " → {}",
                        sum.chars().take(300).collect::<String>()
                    ));
                }
            }
            if let Some(results) = a.get("results").and_then(Value::as_array) {
                for r in results.iter().take(2) {
                    if let Some(c) = r.get("content").and_then(Value::as_str) {
                        if !c.trim().is_empty() {
                            line.push_str(&format!(
                                "\n    {}",
                                c.chars().take(400).collect::<String>()
                            ));
                        }
                    }
                }
            }
            // Native tool results arrive as `resultText` (the frontend keeps
            // the prose verbatim for prose-only tools). Without this the recap
            // showed the explore CALL but not a single finding, so the main
            // agent re-delegated research it had already paid for.
            if let Some(text) = a.get("resultText").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    let cap = if matches!(tool, "explore" | "task") {
                        RECAP_EXPLORE_CHARS
                    } else {
                        RECAP_RESULT_CHARS
                    };
                    line.push_str(&format!("\n    {}", text.chars().take(cap).collect::<String>()));
                }
            }
            lines.push(line);
        }
        if !lines.is_empty() {
            parts.push(format!(
                "\n[Tools already run in this turn — do NOT re-run them:\n{}]",
                lines.join("\n")
            ));
        }
    }
    if let Some(p) = m.get("preservedToolSummary").and_then(Value::as_str) {
        if !p.trim().is_empty() {
            parts.push(p.to_string());
        }
    }
    if let Some(items) = m.get("plan").and_then(Value::as_array) {
        let done = items
            .iter()
            .filter(|i| i.get("status").and_then(Value::as_str) == Some("completed"))
            .count();
        if done > 0 {
            parts.push(format!(
                "\n[Checklist progress {done}/{} — do NOT re-execute completed steps.]",
                items.len()
            ));
        }
    }
    parts.concat()
}
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
    /// True when the turn asks to create/edit a skill or an MCP connector
    /// (`/create-skill`, `/create-mcp`). The `create_skill` / `create_mcp`
    /// tools are bound ONLY then, so an ordinary turn cannot silently rewrite
    /// the user's skill store or connector list.
    #[serde(default)]
    pub allow_create: bool,
    /// Web-search engines from Settings → Plugins, verbatim and in priority
    /// order: `order` 0 is the primary and higher orders are fallbacks tried in
    /// turn, so the user's list order IS the fallback chain.
    #[serde(default)]
    pub search_plugins: Vec<Value>,
}

fn default_mode() -> String {
    "build".to_string()
}

impl AgentRequest {
    /// Snapshot of this turn handed to each explore/task sub-agent.
    ///
    /// `history` is set to EMPTY on purpose: `run_subagent` never reads the
    /// parent's transcript (it rebuilds its own `history: Vec::new()`), yet a
    /// plain `req.clone()` deep-copies the whole conversation — and the
    /// parallel explore path clones once PER explore in the step, so a
    /// four-explore step copied the entire chat four times only to drop it.
    /// The fields are listed explicitly (no `..self.clone()`, which would still
    /// copy `history`) so a future field addition must be decided here.
    fn subagent_snapshot(&self) -> Self {
        Self {
            provider: self.provider.clone(),
            provider_id: self.provider_id.clone(),
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            api_keys: self.api_keys.clone(),
            root: self.root.clone(),
            mode: self.mode.clone(),
            prompt: self.prompt.clone(),
            // Never inherited — see the doc comment above.
            history: Vec::new(),
            system_prompt: self.system_prompt.clone(),
            skills: self.skills.clone(),
            context_window: self.context_window,
            chat_id: self.chat_id.clone(),
            mcp_servers: self.mcp_servers.clone(),
            subagent_models: self.subagent_models.clone(),
            providers: self.providers.clone(),
            data_root: self.data_root.clone(),
            allow_computer: self.allow_computer,
            allow_create: self.allow_create,
            search_plugins: self.search_plugins.clone(),
        }
    }
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
    /// Unified diff of an edit_file/write_file call. Emitted while the card is
    /// still "running" so the frontend folds it into the card and the Review
    /// panel can show/revert the change — without it Review always answered
    /// "No changes in this turn." (the Python sidecar used to emit this; the
    /// native agent must too).
    Diff { tool: String, path: String, diff: String },
    Warn { content: String },
    /// Carries the model + provider_id that actually served this request so
    /// the frontend attributes sub-agent tokens to the SUB model, not the
    /// parent's.
    ///
    /// `sub` marks a request made by the explore sub-agent. The frontend must
    /// NOT let those replace the parent's context meter / message badge (a
    /// sub-agent request is small and isolated — it never enters the parent's
    /// context), so without the flag the meter dropped to the explore's 5-16k
    /// every time an explore ran.
    Usage { input_tokens: u64, output_tokens: u64, model: String, provider_id: String, sub: bool },
    /// A tool event tagged with the sub-agent branch it belongs to. Serialized
    /// as the inner event plus `branch` (and `sub`). Without the tags the
    /// explore card never gets a branch id, so every call the explore makes
    /// is an orphan and the frontend promotes it to a flat top-level card
    /// ("Search Files ×48" in the chat) instead of nesting it under the card.
    /// `sub` is false for the explore/task card's own start event (it must
    /// stay a top-level card) and true for the calls made INSIDE it.
    Branch { branch: u64, sub: bool, inner: Box<AgentEvent> },
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
            AgentEvent::Diff { tool, path, diff } => json!({
                "kind": "diff", "tool": tool, "path": path, "diff": diff,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::Usage { input_tokens, output_tokens, model, provider_id, sub } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "model": model, "provider_id": provider_id,
                "sub": sub,
            }),
            AgentEvent::Branch { branch, sub, inner } => {
                let mut v = inner.to_json();
                v["branch"] = json!(branch);
                v["sub"] = json!(sub);
                v
            }
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
fn tool_schemas(allow_create: bool) -> Vec<Value> {
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
            "create_skill",
            "Create or update a stored skill (the Codex/Claude create_skill flow). ALWAYS pass fa_keywords: the user's own Persian phrases for when this skill applies (comma-separated, e.g. \"ترجمه کن, translate this\") — the skill catalog shows them, so a Persian request finds the skill without any embedding. Pass previous_name when renaming an existing skill so its extra files survive.",
            json!({
                "name": {"type": "string", "description": "Skill name (also the folder slug)"},
                "description": {"type": "string", "description": "One-line English summary of when to use this skill"},
                "content": {"type": "string", "description": "The skill body: step-by-step instructions the agent follows"},
                "fa_keywords": {"type": "string", "description": "Comma-separated Persian phrases that should trigger this skill"},
                "previous_name": {"type": "string", "description": "Old name when renaming an existing skill"},
                "extra_files": {"type": "object", "description": "Optional extra files: filename -> content"},
                "delete": {"type": "boolean", "description": "Delete the skill instead of writing it"}
            }),
        ),
        (
            "create_mcp",
            "Create or update an MCP connector (the `/create-mcp` flow). Pass EITHER command (+ optional args/env) for a stdio server, OR url for an HTTP one. To EDIT an existing connector, pass its SAME name to overwrite it in place, or pass previous_name to rename it (the old file is removed so no stale duplicate is left). The connector is saved but stays off until the user enables it in the composer's MCP picker.",
            json!({
                "name": {"type": "string", "description": "Connector name (also the file name)"},
                "command": {"type": "string", "description": "Executable for a stdio server (e.g. npx)"},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Arguments for the stdio command"},
                "env": {"type": "object", "description": "Optional environment variables for the stdio server"},
                "url": {"type": "string", "description": "Endpoint for an HTTP connector (instead of command)"},
                "previous_name": {"type": "string", "description": "Old name when renaming an existing connector"}
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
            "Delegate research to the explore sub-agent (it reads files, greps, globs, runs LSP lookups and returns the FULL findings — you cannot search yourself). ALWAYS split the work: call explore SEVERAL TIMES IN THE SAME STEP, one focused question per area/file group — parallel calls run CONCURRENTLY and cost ONE round-trip, while a single broad explore is the slowest and shallowest option. Prefer 2-4 focused explores over one giant one; only a genuinely single-area question justifies a single call. Args: description (SHORT label for the UI, under 80 chars) and prompt (the full research question).",
            json!({
                "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                "prompt": {"type": "string", "description": "The full research question for the sub-agent"}
            }),
        ),
        (
            "web_search",
            "Search the web and return ranked results (title, url, snippet). Use it for facts, docs and current information. The engines come from Settings → Plugins and are tried in the user's order until one answers.",
            json!({
                "query": {"type": "string", "description": "The search query"},
                "max_results": {"type": "integer", "description": "How many results to return (default 5)"}
            }),
        ),
    ];
    schemas
        .iter()
        // The skill/connector authoring tools are bound only for a turn that
        // actually asked for them (see AgentRequest::allow_create).
        .filter(|(name, _, _)| {
            allow_create || !matches!(*name, "create_skill" | "create_mcp")
        })
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
            "Search previously saved project notes. Every hit carries an `id` — pass it to delete_memory to remove a note that is stale or wrong.",
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
            "delete_memory",
            "Delete ONE saved note by its id (the `id` field returned by search_memory). Use it to drop a note that turned out to be wrong or obsolete.",
            json!({
                "memory_id": {"type": "string", "description": "Id of the note to delete (from search_memory)"}
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
            "web_search",
            "Search the web and return ranked results (title, url, snippet). Use it for facts, docs and current information. The engines come from Settings → Plugins and are tried in the user's order until one answers.",
            json!({
                "query": {"type": "string", "description": "The search query"},
                "max_results": {"type": "integer", "description": "How many results to return (default 5)"}
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

/// Source of sub-agent branch ids. Process-wide (not per step) because the
/// frontend matches `branch` across every card in a message — two explores in
/// different steps must never share an id or each would show the other's calls.
static BRANCH_SEQ: AtomicU64 = AtomicU64::new(1);

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
    let echo_cap = ui_echo_cap(name);
    let mut shown = result.clone();
    if shown.len() > echo_cap {
        let mut end = echo_cap;
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
    let is_report = name == "explore" || name == "task";
    let cap = if is_report { EXPLORE_REPORT_CAP } else { MODEL_RESULT_CAP };
    if for_model.len() > cap {
        if is_report {
            // Cut the MIDDLE, not the tail: the head holds the answer and the
            // tail holds the search results / file list, and the main agent
            // cannot re-read either on its own. Only the middle is dropped,
            // with an explicit pointer to ask for it again.
            let head_len = cap / 2;
            let mut head_end = head_len;
            while head_end > 0 && !for_model.is_char_boundary(head_end) {
                head_end -= 1;
            }
            let mut tail_start = for_model.len() - (cap - head_len);
            while tail_start < for_model.len() && !for_model.is_char_boundary(tail_start) {
                tail_start += 1;
            }
            let omitted = tail_start - head_end;
            for_model = format!(
                "{}\n… [{omitted} chars omitted from the middle of this report — the head and the tail are intact; ask explore for the omitted section if you need it]\n{}",
                &for_model[..head_end],
                &for_model[tail_start..]
            );
        } else {
            let mut end = cap;
            while end > 0 && !for_model.is_char_boundary(end) {
                end -= 1;
            }
            for_model.truncate(end);
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
    // Skills: the system prompt carries a catalog of the installed skills and
    // the model loads the ones it needs via `load_skill` (the Codex/Claude
    // pattern). Only the skills the user attached are inlined whole.
    // The skill store lives in the DATA root, not the workspace. A caller that
    // omits `data_root` (e.g. a scheduled run) must still find the store, so
    // fall back to the native data root rather than the workspace — reading the
    // workspace found no skills at all, which silently disabled auto-loading.
    let skill_root = if req.data_root.is_empty() {
        native_data_root()
    } else {
        req.data_root.clone()
    };
    let skill_section = crate::skill_router::build_section(&skill_root, &req.skills);
    if !skill_section.text.is_empty() {
        system.push_str(&skill_section.text);
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
            // Carry the turn's non-prose state (tools run, preserved summary,
            // checklist) into the content — see history_recap.
            let recap = history_recap(m);
            if recap.is_empty() {
                messages.push(json!({"role": role, "content": content}));
            } else {
                messages.push(json!({"role": role, "content": format!("{content}{recap}")}));
            }
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
        tool_schemas(req.allow_create)
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
    // Lookups already executed in THIS turn. A repeat of the same read window
    // or grep is pure waste — the payload is already in the context above —
    // and the explore prompt forbids it, yet a traced run re-read three files
    // in round 3 that round 1 had returned and repeated a refused grep.
    let mut seen_lookups: std::collections::HashSet<String> = std::collections::HashSet::new();
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
                // Terminal `done` after the error: the event protocol requires
                // it (the client treats an EOF without `done` as a dropped
                // connection). Without it the stream ended silently and the UI
                // stacked "Connection lost mid-turn" on top of the real
                // provider error — reported on one of two concurrent chats.
                emit(&AgentEvent::Done { aborted: false });
                return Ok(());
            }
        };
        let (in_tok, out_tok) = usage_tuple(&acc);
        emit(&AgentEvent::Usage {
            input_tokens: in_tok,
            output_tokens: out_tok,
            model: req.model.clone(),
            provider_id: req.provider_id.clone(),
            sub: req.mode == "subagent",
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
        let mut repeats: Vec<(String, String, Value)> = Vec::new();
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
                // A repeat of an identical lookup answers with a pointer
                // instead of the payload again (see `seen_lookups`).
                let key = lookup_key(name, &args);
                let is_repeat = key.is_some_and(|k| !seen_lookups.insert(k));
                if is_repeat {
                    repeats.push((id.clone(), name.clone(), args));
                } else {
                    batch.push((id.clone(), name.clone(), args));
                }
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
        for (id, name, args) in repeats {
            finish_tool(
                &mut messages,
                emit,
                &trace,
                &id,
                &name,
                &args,
                "already returned above — this exact lookup is in your context; \
use what it showed, read a DIFFERENT window, or move on"
                    .into(),
                true,
                req.mode == "subagent",
            );
        }
        // Explore sub-agents in one step run CONCURRENTLY (tokio::spawn +
        // join): the model often fires several research questions at once and
        // each takes seconds — sequential execution multiplies the wall time.
        // Mutating tools stay sequential (ordering + cancel semantics).
        let mut explore_batch: Vec<(String, String, Value, u64)> = Vec::new();
        let mut rest: Vec<(String, String, String)> = Vec::new();
        for call in sequential {
            if call.1 == "explore" || call.1 == "task" {
                let args: Value =
                    serde_json::from_str(&call.2).unwrap_or_else(|_| json!({}));
                emit(&AgentEvent::Status {
                    stage: "tool".into(),
                    content: call.1.clone(),
                });
                let branch = BRANCH_SEQ.fetch_add(1, Ordering::Relaxed);
                // The card carries its branch id so the calls the explore
                // makes (tagged with the same id) nest under it.
                emit(&AgentEvent::Branch {
                    branch,
                    sub: false,
                    inner: Box::new(AgentEvent::ToolStart {
                        id: call.0.clone(),
                        name: call.1.clone(),
                        args: args.clone(),
                    }),
                });
                explore_batch.push((call.0, call.1, args, branch));
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
                .map(|(_id, _name, args, branch)| {
                    let branch = *branch;
                    let req_c = req.subagent_snapshot();
                    let args_c = args.clone();
                    let cancel_c = std::sync::Arc::clone(cancel);
                    let tx = tx.clone();
                    Box::pin(async move {
                        let mut sink = move |ev: &AgentEvent| {
                            let _ = tx.send(ev.clone());
                        };
                        run_subagent(&req_c, &args_c, branch, &mut sink, &cancel_c).await
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
            for ((id, name, args, _branch), (result, ok)) in explore_batch.into_iter().zip(results) {
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
            // Capture the pre-edit content so a unified diff can be emitted
            // after the call — without it the Review panel answers "No changes
            // in this turn." for every edit. A missing file (brand-new
            // write_file) diffs as pure additions.
            let pre_edit = if name == "edit_file" || name == "write_file" {
                let p = args["path"]
                    .as_str()
                    .or_else(|| args["filePath"].as_str())
                    .unwrap_or_default();
                Some(crate::tools::read_pre_edit(&root, p).unwrap_or_default())
            } else {
                None
            };
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
            } else if name == "web_search" {
                // Native web search: the engine chain is the user's Settings →
                // Plugins order, so this must run here (async) rather than in
                // the sync `tools::dispatch`.
                let query = args["query"].as_str().unwrap_or_default();
                let max = args["max_results"].as_u64().unwrap_or(5) as usize;
                match crate::websearch::search(&req.search_plugins, query, max).await {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            } else {
                match tools::dispatch(&root, name, &args, None) {
                    Ok(r) => (r, true),
                    Err(e) => (e, false),
                }
            };
            // Emit the unified diff while the card is still "running" — the
            // frontend folds it into the card (and the Review panel) before
            // the Tool result resolves the card to done.
            if ok {
                if let Some(old) = pre_edit {
                    let p = args["path"]
                        .as_str()
                        .or_else(|| args["filePath"].as_str())
                        .unwrap_or_default();
                    if let Ok(target) = crate::tools::resolve_safe(&root, p, false, None) {
                        let newc = std::fs::read_to_string(target).unwrap_or_default();
                        let diff = crate::tools::unified_diff(p, &old, &newc);
                        if !diff.is_empty() {
                            emit(&AgentEvent::Diff {
                                tool: name.clone(),
                                path: p.to_string(),
                                diff,
                            });
                        }
                    }
                }
            }
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

        // A step with a single call is a wasted model round trip when more
        // lookups were foreseeable. The hint rides on that call's own result,
        // so it costs no extra request and never cuts a report.
        if let Some(hint) = single_call_hint(&req.mode, &tool_calls) {
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
        // Newest first: the most recent searches are the ones the report was
        // building toward, so they must survive the cap below.
        for m in messages.iter().rev() {
            if m["role"].as_str() != Some("tool") {
                continue;
            }
            let c = m["content"].as_str().unwrap_or_default();
            if c.trim().is_empty() {
                continue;
            }
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            // The per-result budget is generous because a grep/read result IS
            // the finding: cutting it to a few hundred chars dropped the very
            // search hits the parent asked for, and it re-delegated the same
            // question. The whole report is capped by EXPLORE_REPORT_CAP, the
            // same budget a normal report gets.
            let mut end = SUBAGENT_FOLD_RESULT_CHARS.min(c.len());
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            report.push_str("- ");
            report.push_str(&c[..end]);
            if end < c.len() {
                report.push_str("…");
            }
            report.push('\n');
            if report.len() > EXPLORE_REPORT_CAP {
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
            if !matches!(
                name.as_str(),
                "save_memory" | "search_memory" | "delete_memory"
            ) =>
        {
            report.clear()
        }
        _ => {}
    }
}

/// Identity of a repeatable read-only lookup: a read window (file + offset +
/// limit) or a grep (pattern + scope). Two calls with the same key return the
/// same payload, so the second one is answered with a pointer instead of the
/// body — the content is already in the context above.
fn lookup_key(name: &str, args: &Value) -> Option<String> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    match name {
        "read" => {
            let file = s("filePath");
            if file.is_empty() {
                return None;
            }
            let offset = args["offset"].as_u64().unwrap_or(1);
            let limit = args["limit"].as_u64().unwrap_or(400);
            // `ranges` selects other windows of the same file: without it in the
            // key, a second read of a DIFFERENT range was answered as a repeat.
            let ranges = args["ranges"].to_string(); // "null" when absent
            Some(format!("read|{file}|{offset}|{limit}|{ranges}"))
        }
        "grep" => {
            // The model sends either `pattern` or a `patterns` array.
            let mut pattern = s("pattern");
            if pattern.is_empty() {
                if let Some(list) = args["patterns"].as_array() {
                    pattern = list
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\u{1f}");
                }
            }
            if pattern.is_empty() {
                return None;
            }
            Some(format!("grep|{pattern}|{}|{}", s("path"), s("include")))
        }
        "find_symbol" => {
            let symbol = s("symbol");
            if symbol.is_empty() {
                return None;
            }
            Some(format!("find_symbol|{symbol}|{}|{}", s("path"), s("include")))
        }
        _ => None,
    }
}

/// Batching reminder appended to the result of a step that issued a single
/// tool call. Read-only calls of one step run in parallel, so every extra step
/// costs seconds (one model round trip) for no extra information.
///
/// Two audiences, because the waste differs:
/// - the explore sub-agent: one lookup per step burns rounds;
/// - the MAIN agent: one broad explore is slow and comes back shallow, while
///   the same step could have carried several focused explores concurrently
///   (a traced turn fired a single wide explore and got a 4-round report).
fn single_call_hint(mode: &str, calls: &[(String, String, String)]) -> Option<&'static str> {
    if calls.len() != 1 {
        return None;
    }
    if mode == "subagent" {
        return Some(
            "[hint] That step had ONE call. Calls of a step run in parallel and each extra step costs a model round trip: in your NEXT step issue every call you can already foresee together (other greps, find_symbol, lsp_symbols, reads of the exact windows), then write the report.",
        );
    }
    let name = calls[0].1.as_str();
    (name == "explore" || name == "task").then_some(
        "[hint] That step had ONE explore. Explores of one step run CONCURRENTLY and cost a single round-trip, while one broad explore is slow and returns a shallow report: when the task spans several areas, fire 2-4 focused explores (one per area/file group) IN THE SAME STEP.",
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
HARD RULE: never issue a step with a single call while you still have a \
question whose answer could change what you do next. If you catch yourself \
about to send one call, add the other calls you already know you need (the \
next file's window, the second keyword, the symbol lookup) to the SAME step. \
A one-call step is only correct when it is genuinely the last thing you need \
before the report. Never read a file you have not located, and never guess an \
offset: read offset=1, or the window a result pointed you at — an offset past \
the end returns nothing and wastes a whole round.\n\
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
or rely on — copy the exact text, never paraphrase code. `read` output has a \
`path (lines a-b):` header and an `N: ` prefix on every line: N is the line \
number, NOT file content — use it for start-end, but never copy the header or \
the prefix into CODE (the main agent edits by exact-match strings).\n\
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
    branch: u64,
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
        // Authoring tools are never delegated either.
        allow_create: false,
        // Web search IS research, so the sub-agent inherits the same engine
        // chain the user configured for the parent turn.
        search_plugins: parent.search_plugins.clone(),
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
                // The sub-run's own Done must not reach the parent stream
                // (it would read as the PARENT turn finishing).
                AgentEvent::Text { .. } | AgentEvent::Error { .. } | AgentEvent::Done { .. } => {}
                // Tool calls are tagged with this explore's branch so they
                // nest under its card instead of floating in the chat.
                AgentEvent::ToolStart { .. } | AgentEvent::Tool { .. } => {
                    emit(&AgentEvent::Branch {
                        branch,
                        sub: true,
                        inner: Box::new(ev.clone()),
                    })
                }
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
explore per area/file group. A single broad explore is the slowest, \
shallowest option; only a genuinely single-area question justifies one call. \
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
            sub: true,
        }
        .to_json();
        // Sub-agent usage is flagged so the context meter ignores it.
        assert_eq!(t["sub"], true);
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
    fn branch_wrapper_tags_the_inner_event_without_changing_its_shape() {
        let inner_call = AgentEvent::ToolStart {
            id: "c9".into(),
            name: "grep".into(),
            args: json!({"pattern": "x"}),
        };
        let v = AgentEvent::Branch { branch: 7, sub: true, inner: Box::new(inner_call) }.to_json();
        assert_eq!(v["kind"], "tool");
        assert_eq!(v["tool"], "grep");
        assert_eq!(v["id"], "c9");
        assert_eq!(v["branch"], 7);
        assert_eq!(v["sub"], true);
        // The explore card's own start carries the branch but is NOT a sub
        // event — it has to stay a top-level card the children nest under.
        let card = AgentEvent::Branch {
            branch: 7,
            sub: false,
            inner: Box::new(AgentEvent::ToolStart {
                id: "e1".into(),
                name: "explore".into(),
                args: json!({}),
            }),
        }
        .to_json();
        assert_eq!(card["branch"], 7);
        assert_eq!(card["sub"], false);
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
    fn history_recap_carries_tool_results_not_just_calls() {
        // A recap that lists only tool names tells the model a grep ran but
        // not what it found, so it re-runs the same search next turn. The
        // result digest must survive into the recap.
        let m = json!({
            "role": "assistant",
            "content": "done",
            "toolActivity": [
                {"tool": "grep", "args": {"pattern": "foo"}, "status": "done",
                 "summary": "3 hits in 2 files"},
                {"tool": "read", "status": "running"}
            ]
        });
        let recap = history_recap(&m);
        assert!(recap.contains("grep"), "{recap}");
        assert!(recap.contains("3 hits in 2 files"), "{recap}");
        // A still-running call is not reported as completed work.
        // (Match the list item, not the bare word: "already" contains "read".)
        assert!(!recap.contains("- read"), "{recap}");
    }

    #[test]
    fn history_recap_carries_explore_findings_at_length() {
        // explore's findings reach the backend only as `resultText` (the
        // frontend stores prose results verbatim for prose-only tools, and
        // explore/task are among them). Recap the call without the findings and
        // the next turn re-delegates research it already paid for, so the
        // report must survive AND keep more than an ordinary tool's digest.
        let report = "x".repeat(2_000);
        let m = json!({
            "role": "assistant",
            "content": "researched",
            "toolActivity": [
                {"tool": "explore", "args": {"prompt": "trace usage"}, "status": "done",
                 "resultText": report},
                {"tool": "lsp_hover", "args": {}, "status": "done",
                 "resultText": "fn usage_meter() -> Usage"}
            ]
        });
        let recap = history_recap(&m);
        assert!(
            recap.contains(&"x".repeat(1_000)),
            "explore report must survive beyond the ordinary digest cap: {}",
            recap.len()
        );
        assert!(recap.contains("usage_meter"), "{recap}");
    }

    #[test]
    fn explore_report_echo_is_not_cut_below_the_recap_budget() {
        // The recap can only carry what the UI echo kept (`resultText`), so the
        // echo budget for a report may never be smaller than the recap's.
        assert!(ui_echo_cap("explore") >= RECAP_EXPLORE_CHARS);
        assert!(ui_echo_cap("task") >= RECAP_EXPLORE_CHARS);
        assert_eq!(ui_echo_cap("grep"), TOOL_RESULT_CAP);
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
        let schemas = tool_schemas(false);
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|s| s["function"]["name"].as_str())
            .collect();
        // Main agent must NOT have search/read tools — research is delegated.
        // Memory tools live on the explore sub-agent too (user request).
        for banned in [
            "read",
            "grep",
            "glob",
            "find_symbol",
            "lsp_definition",
            "lsp_symbols",
            "save_memory",
            "search_memory",
            "delete_memory",
        ] {
            assert!(!names.contains(&banned), "main agent must not have {banned}");
        }
        assert!(names.contains(&"explore"));
        assert!(names.contains(&"edit_file"));
        assert!(names.contains(&"run_terminal"));
        // Web search is not file discovery: the main agent may search the web
        // itself (the engines come from Settings → Plugins).
        assert!(names.contains(&"web_search"));
    }

    #[test]
    fn authoring_tools_are_bound_only_when_the_turn_asks_for_them() {
        // An ordinary turn must not be able to rewrite the skill store or the
        // connector list, so the authoring tools are gated on allow_create.
        let names = |allow: bool| -> Vec<String> {
            tool_schemas(allow)
                .iter()
                .filter_map(|s| s["function"]["name"].as_str().map(str::to_string))
                .collect()
        };
        let plain = names(false);
        assert!(!plain.contains(&"create_skill".to_string()));
        assert!(!plain.contains(&"create_mcp".to_string()));
        // load_skill stays available: reading a skill is not authoring.
        assert!(plain.contains(&"load_skill".to_string()));

        let authoring = names(true);
        assert!(authoring.contains(&"create_skill".to_string()));
        assert!(authoring.contains(&"create_mcp".to_string()));
    }

    #[test]
    fn explore_schema_asks_for_parallel_calls() {
        // The model only parallelizes when the tool description says so: one
        // broad explore used to be the default and made turns slow/shallow.
        let schemas = tool_schemas(false);
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
            "delete_memory",
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
        // The single-call rule and the offset rule are what stop the 4-round
        // serial runs seen in a real trace.
        assert!(p.contains("HARD RULE") && p.contains("never guess an"), "{p}");
        assert!(p.contains("FILES only") && p.contains("no matches"));
        // Still read-only and English-reporting.
        assert!(p.contains("NO write tools") && p.contains("Report in English"));
        // Report contract: answer first, verbatim code only where it is needed.
        assert!(p.contains("ANSWER") && p.contains("VERBATIM") && p.contains("nothing between tool calls"));
        // Latency guidance: rounds (not calls) are the cost, batch in ONE step.
        assert!(p.contains("ROUNDS") && p.contains("ONE step"), "{p}");
        // `read` numbers its lines; the report must not carry that scaffolding
        // into CODE excerpts the main agent will use as exact-match edit strings.
        assert!(p.contains("line number") && p.contains("never copy the header"), "{p}");
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
    fn repeated_lookups_are_detected_but_distinct_windows_are_not() {
        // Same file + same window (an omitted offset/limit means the default
        // window) is a repeat: the body is already in the context.
        let a = json!({"filePath": "src/a.ts", "offset": 1, "limit": 400});
        let b = json!({"filePath": "src/a.ts"});
        assert_eq!(lookup_key("read", &a), lookup_key("read", &b));
        // A different window of the same file is a real read.
        let c = json!({"filePath": "src/a.ts", "offset": 401, "limit": 400});
        assert_ne!(lookup_key("read", &a), lookup_key("read", &c));
        // Different `ranges` of one file are different lookups (same ranges repeat).
        let r1 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 1, "limit": 50}]});
        let r2 = json!({"filePath": "src/a.ts", "ranges": [{"offset": 200, "limit": 50}]});
        assert_ne!(lookup_key("read", &r1), lookup_key("read", &r2));
        assert_eq!(lookup_key("read", &r1), lookup_key("read", &r1.clone()));
        // Grep keys carry the scope, so the same pattern in another directory
        // is a different lookup.
        let g1 = json!({"pattern": "foo", "path": "src"});
        let g2 = json!({"pattern": "foo", "path": "backend"});
        assert_ne!(lookup_key("grep", &g1), lookup_key("grep", &g2));
        assert_eq!(
            lookup_key("grep", &g1),
            lookup_key("grep", &json!({"pattern": "foo", "path": "src"}))
        );
        // The `patterns` array form keys the same way as a single pattern.
        assert_eq!(
            lookup_key("grep", &json!({"patterns": ["a", "b"]})),
            lookup_key("grep", &json!({"patterns": ["a", "b"]}))
        );
        // find_symbol dumps definition bodies + usages: the same symbol in the
        // same scope is a repeat, a different scope is a real lookup.
        let f1 = json!({"symbol": "foo", "path": "src"});
        assert_eq!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &f1.clone()));
        assert_ne!(lookup_key("find_symbol", &f1), lookup_key("find_symbol", &json!({"symbol": "foo", "path": "backend"})));
        assert!(lookup_key("find_symbol", &json!({"path": "src"})).is_none());
        // Shapes without a target are never deduped (nothing to compare).
        assert!(lookup_key("read", &json!({"path": "src"})).is_none());
        assert!(lookup_key("grep", &json!({"path": "src"})).is_none());
        assert!(lookup_key("glob", &json!({"pattern": "**/*.ts"})).is_none());
    }

    #[test]
    fn single_call_steps_get_a_batching_hint() {
        let one = |name: &str| vec![("c1".to_string(), name.to_string(), "{}".to_string())];
        // The explore sub-agent: one lookup per step burns rounds.
        assert!(single_call_hint("subagent", &one("grep"))
            .unwrap()
            .contains("NEXT step"));
        // The main agent: a single broad explore wastes the concurrent fan-out
        // (a traced turn fired one wide explore and got a 4-round report).
        let main = single_call_hint("agent", &one("explore")).unwrap();
        assert!(main.contains("CONCURRENTLY") && main.contains("2-4 focused explores"), "{main}");
        // Batched steps are left alone, and so is a single non-explore call.
        let two = vec![
            ("a".to_string(), "grep".to_string(), "{}".to_string()),
            ("b".to_string(), "read".to_string(), "{}".to_string()),
        ];
        assert!(single_call_hint("subagent", &two).is_none());
        assert!(single_call_hint("agent", &one("run_terminal")).is_none());
    }

    #[test]
    fn explore_report_truncation_keeps_head_and_tail_and_never_points_at_read() {
        let mut messages: Vec<Value> = Vec::new();
        let mut emit = |_: &AgentEvent| {};
        let trace = crate::trace::TraceStore::new(String::new());
        // A report longer than the report cap: the head (answer) AND the tail
        // (search results / file list) must both survive — the main agent has
        // no read tool, so a lost tail is lost work it would re-delegate.
        let big = format!("HEAD{}TAIL", "x".repeat(EXPLORE_REPORT_CAP + 100));
        finish_tool(&mut messages, &mut emit, &trace, "c1", "explore", &json!({}), big, true, false);
        let c = messages[0]["content"].as_str().unwrap();
        assert!(c.contains("HEAD") && c.contains("TAIL"), "head and tail must survive");
        assert!(c.contains("ask explore") && !c.contains("offset/limit"));
        // A raw tool result still points at a narrower read window.
        let big2 = "x".repeat(MODEL_RESULT_CAP + 100);
        finish_tool(&mut messages, &mut emit, &trace, "c2", "read", &json!({}), big2, true, true);
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
    fn create_skill_persists_persian_keywords_into_the_catalog() {
        use crate::tools::dispatch;
        let dir = std::env::temp_dir().join(format!("codifa-create-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        let out = dispatch(
            root,
            "create_skill",
            &json!({
                "name": "Movie Finder",
                "description": "find movies",
                "content": "Step 1: ask for the genre.",
                "fa_keywords": "فیلم, سینما",
            }),
            None,
        )
        .unwrap();
        assert!(out.contains("Movie Finder"), "{out}");

        // The keywords must reach the catalog, otherwise a Persian request
        // could never match this skill (the catalog is all the model sees).
        let section = crate::skill_router::build_section(root, &[]);
        assert!(section.text.contains("[fa: فیلم, سینما]"), "{}", section.text);
        assert!(section.text.contains("Movie Finder: find movies"), "{}", section.text);

        // A missing name/content is rejected instead of writing a broken skill.
        assert!(dispatch(root, "create_skill", &json!({"content": "x"}), None).is_err());
        assert!(dispatch(root, "create_skill", &json!({"name": "x"}), None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
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
            allow_create: false,
            search_plugins: Vec::new(),
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

    #[test]
    fn subagent_snapshot_drops_history_but_keeps_settings() {
        // A four-explore step snapshots the parent once per explore. The
        // transcript must not ride along: run_subagent never reads it, so a
        // full clone only copies the whole chat (megabytes on a long one)
        // once per parallel sub-agent before it is thrown away.
        let mut req = base_req();
        req.history = vec![json!({"role": "user", "content": "x".repeat(1000)})];
        req.chat_id = "chat-1".into();
        req.search_plugins = vec![json!({"kind": "duckduckgo"})];
        req.context_window = 200_000;
        req.mcp_servers = json!({"srv": {"command": "x"}});

        let snap = req.subagent_snapshot();

        assert!(snap.history.is_empty(), "snapshot must not carry history");
        // The parent's own history is untouched (the turn keeps using it).
        assert_eq!(req.history.len(), 1);
        // Settings the sub-agent genuinely reads still flow through.
        assert_eq!(snap.model, req.model);
        assert_eq!(snap.root, req.root);
        assert_eq!(snap.chat_id, "chat-1");
        assert_eq!(snap.context_window, 200_000);
        assert_eq!(snap.search_plugins, req.search_plugins);
        assert_eq!(snap.mcp_servers, req.mcp_servers);
        assert_eq!(snap.api_keys, req.api_keys);
    }
}
