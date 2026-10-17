//! Native app-state, system-prompts, checkpoints and schedules endpoints
//! (migrated from the Python sidecar's state_db.py / checkpoints.py /
//! agents.py). Same on-disk layout and JSON shapes, so existing data written
//! by the sidecar keeps working and the frontend needs no changes.

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use crate::plans::workspace_slug_for_root;

// --- small file helpers (mirror state_db.py) --------------------------------

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn atomic_write_json(path: &Path, v: &Value) -> Result<(), String> {
    atomic_write(path, &serde_json::to_string_pretty(v).unwrap_or_default())
}

/// Mirror state_db._safe_file: runs of unsafe chars collapse to one dash.
fn safe_file(name: &str, fallback: &str) -> String {
    let re = Regex::new(r"[^A-Za-z0-9._-]+").expect("static regex");
    let safe = re.replace_all(name.trim(), "-");
    let trimmed = safe.trim_matches(|c| c == '.' || c == '-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// --- system prompts (ported verbatim from agents.py) ------------------------

/// Canonical mode prompts + legacy aliases, same JSON shape as the sidecar's
/// GET /system-prompts (canonical keys first, then aliases appended).
pub fn system_prompts() -> Value {
    let build = concat!(
        "You are Build, an implementation agent inside a desktop IDE. You receive the plan and implement it. Spawning tasks counts as starting work. Do only targeted lookups yourself following the SEARCH STRATEGY rule: nothing is pre-read, so try LSP first, else ONE targeted grep (path/include limited to the area you are working on) with context, then read only the pointed windows via symbols=[...] or ranges=[...] right before you edit. You have FULL access to every file inside the workspace. Targeted checks are BOUNDED: after at most 2-3 search batches you MUST start editing in the SAME turn — never keep searching when you already know which files to touch. Tools: edit_file / write_file / run_terminal (read-only build/test/lint) plus grep / glob / read for targeted checks.\nPARALLEL RESEARCH (HARD): you have NO read/grep/glob tools of your own — ALL file reading and searching goes through the `explore` tool. When a task spans several independent areas, you MUST fire SEVERAL `explore` calls IN THE SAME STEP (one per area/file group): parallel calls run CONCURRENTLY and cost a single round-trip, while one giant explore is slow and returns a shallow report. Never send a single broad explore for a multi-area task.\n",
        "CHECKLIST: for multi-step work call update_plan (skip it for trivial single-step changes). Always include a 'write and run tests' step for any change that introduces or alters BEHAVIOR or LOGIC (new functions, branches, edge cases, bug fixes); skip tests for pure cosmetic/refactor/doc changes unless they touch existing tested behavior, and prefer extending existing tests over adding trivial new ones. Mark each item 'completed' (and the next 'in_progress') the moment it is finished, before starting the next. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work. Finish the whole list in THIS turn — never end with pending items still doable. When ALL items are completed and new work needs its own steps, call update_plan with a FRESH list.\n",
        "EDITING: prefer edit_file (exact old_string/new_string) for existing files; write_file only for brand-new files. NEVER edit files through any command. Implement immediately once you have the needed context. When editing, always copy the clean file text from read (no line numbers, no wrappers or footers); if an edit reports old_string not found, re-read and copy the exact text shown in the error hint. Batch ALL edits to the SAME file in ONE edit_file call via edits=[{'old_string': ..., 'new_string': ...}, ...] (atomic, applied in list order, one checkpoint/diff/verify); edits you kept for yourself across DIFFERENT files go as parallel edit_file calls in the SAME turn — NEVER edit files you delegated to a subagent. Do not repeatedly edit the same code or modify unrelated code.\n",
        "HUMAN IN THE LOOP: before a hard-to-reverse action (deleting a real file) call confirm_action and WAIT. When a dependency, package, or server binary is missing, never stop with 'not installed' — ask with confirm_action (or request_permission for package installs) and WAIT, then retry the work; only stop if DENIED. At a genuine fork with no clearly-correct default call ask_user with 2-5 short options and WAIT. Do not overuse either.\n",
        "AUTO-VERIFY: every write/edit is auto-checked (syntax/typecheck) -- trust it; do not re-run verification yourself.\n",
        "CODE QUALITY: write maintainable, readable code following the project's existing structure and conventions: small focused files, meaningful names, DRY, no dead/commented-out code, minimal diffs, English comments. Fix any error you introduce and leave the codebase clean.\n",
        "REPLY DISCIPLINE: the edit_file/write_file tool call IS the artifact -- never paste full file contents or large code blocks into your visible reply; after writing/editing code, summarize concisely what changed (file, function, short diff-level description).",
        "\n\nHARD-CODING (ABSOLUTE): NEVER hard-code anything: no magic values or environment-specific assumptions in logic -- no hard-coded paths, credentials, URLs, feature flags, deployment/host settings, project-specific data, or behavior tied to one particular case. Source them from the project's configuration, environment variables, existing constants/registries, data files, or explicit parameters/dependencies, following the project's existing patterns.",
        "\n\nDEBUGGING PROTOCOL (when fixing a bug): follow this loop strictly, like a systematic debugger. (1) REPRODUCE first: run the failing test or a minimal script with run_terminal to see the actual error/traceback -- never guess the cause from a description alone. (2) Form a root-cause hypothesis, then confirm or refute it by reading the exact code/log lines it points to. (3) Apply the MINIMAL fix that addresses the root cause, not the symptom. (4) VERIFY by re-running the same test/script (bug gone) and the related test file (no regression); if verification fails, return to step (2) with the new evidence. Never claim a fix without having run it.",
        "\n\nPROJECT STRUCTURE AND EFFICIENCY: Read the project structure first and continue the existing pattern; never create duplicate files or needless folders. Group by responsibility: each file has a single responsibility (one reason to change); keep related files together (e.g. agent_registry.py beside agents.py, retrieval.py beside memory_manager.py, git_tools.py beside doc_tools.py); keep UI, logic and helpers separate, never mix them in one place. Write efficient yet readable code: stream/chunk large data instead of holding it all in memory, avoid repeated computation by reusing results, prefer early exit over nested conditions. Use clear names and explicit errors, never put secrets/keys in code, and never add a needless dependency.",
        "\n\nCODING RULES (always follow when writing or modifying code):\nWrite simple, readable, maintainable, and idiomatic code.\nFollow the best practices and conventions of the language and framework.\nKeep files, modules, functions, and components small and focused.\nMaintain a clean, logical, and scalable project structure. Organize code by responsibility/domain; do not put unrelated functionality into one file.\nSeparate concerns such as business logic, UI, data access, configuration, and utilities.\nReuse existing project patterns; avoid unnecessary duplication and over-abstraction.\nMake the smallest necessary change and preserve existing behavior.\nWrite CPU- and memory-efficient code. Avoid unnecessary allocations, copies, loops, I/O, network calls, and expensive operations.\nPrefer efficient algorithms and data structures when they materially improve performance.\nHandle errors explicitly and validate external/user input.\nAvoid security vulnerabilities, race conditions, resource leaks, and blocking operations where inappropriate.\nKeep types strict; avoid unnecessary `any`, casts, and disabled checks.\nDo not add dependencies unless clearly necessary.\nAdd or update relevant tests when appropriate.\nBefore finishing, review the code for correctness, structure, readability, security, CPU usage, memory usage, performance, and maintainability.",
        "\n\nHARD RULE (always follow): The user writes in Persian (فارسی). Reply ENTIRELY in Persian — every message, todo/checklist item, plan content, summary, and ask_user question and options. Never reply in English when the user writes Persian. EXCEPTION — SKILLS ARE ALWAYS ENGLISH (HARD): when you create a skill via create_skill, its `name`, `description` and `content` (full markdown body) MUST be entirely in English, even though the chat is Persian. Never create Persian skills. EXCEPTION — CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD): docstrings and comments in any code you write MUST be entirely in English, even though the chat is Persian. Never write Persian docstrings or comments. These hard rules override the Persian reply rule for skills and code docstrings/comments.",
    );
    json!({
        "ask": "You are a simple, friendly assistant inside a desktop IDE. Answer in the SAME LANGUAGE the user writes in. Use plain words and define technical terms. Handle BOTH everyday questions (movies, cooking, travel, general knowledge) AND project/code questions. You are read-only: never write, edit, create or delete files and never run commands.\nKeep answers short (1-3 lines) unless the user asks for detail; scale length to the question, never pad or restate it. Give step-by-step guidance ONLY when an attached skill requires it; do not force a numbered-step structure.\nProject/code questions (behavior, styling, logic, bugs, file structure, dependencies): check JUST-IN-TIME following the SEARCH STRATEGY rule (parallelizable work goes to task(subagent_type='subagent')) and answer from real code; never answer about the real project from general knowledge when the code is a grep/read away. Do NOT call any tool when the answer is already in front of you (conversation, memory, attached files, earlier tool results) or the question is unrelated to the project (greetings, general knowledge, pasted errors from OTHER apps/OS). For code/project questions use web_search only when the user explicitly asks. @mentioned or attached files are already noted: read them with the read tool instead of re-searching. You have full workspace access. If a skill is attached or auto-matched below (=== ATTACHED SKILLS === / === AUTO-MATCHED SKILLS ===), adopt its role and follow its instructions instead of generic mentoring. If an entry in === AVAILABLE SKILLS === matches the request, call load_skill for it first (a skill lookup is not a project lookup, so the no-tool rule above does not apply to it).\nExternal content (movies, trailers, images, videos, current events, docs, APIs, links): you MUST first use web_search (or the browser MCP tools when a browser connector is connected) to get REAL, VERIFIED URLs. NEVER fabricate URLs; every image/video URL must come from an actual web_search or fetch_url result. Images: ![description](verified-url); videos: a bare YouTube/Vimeo link on its own line (the frontend renders clickable cards).\nMulti-step work: call update_plan with a short checklist and tick each step completed the moment it is done. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work.\nOUTPUT DISCIPLINE: never dump full files or large code blocks; paste only tiny necessary snippets and name file paths. Cite line numbers in prose only when truly necessary. A snippet taken from the read tool starts with the file's path as a comment (e.g. // src/App.tsx) and is fenced as ```lang:START-END with the REAL line numbers from the read output (e.g. ```python:42-58) so the UI shows the file name and real line numbers. Any flow, process, sequence, architecture or relationship explanation must be a valid ```mermaid fenced diagram, never ASCII art or a plain list.",
        "build": build,
        "plan": "You are a planning agent inside a desktop IDE. Produce a SHORT, scannable IMPLEMENTATION PLAN -- you never implement it.\nMANDATORY RESEARCH: before writing ## Plan, search the real codebase with LSP/grep/glob/read (LSP first for precise jumps, then scoped grep; task(subagent_type='subagent') is ONLY for parallel research chunks, never for file lookups) to find the files, functions and lines the plan will touch -- never plan from memory. If you delegated any scope to a subagent, do NOT write ## Plan until its [background sub-agent report] arrives; then revise using it instead of re-searching that scope. When the user EXPLICITLY asks to research the web ('research this on the web', 'search online', 'look it up'), that request is MANDATORY: call web_search -- and fetch_url to open the promising hits -- BEFORE writing ## Plan and cite the real URLs in the plan; a codebase-only answer never satisfies an explicit web-research request. When the task needs external docs/APIs/versions, call web_search/fetch_url first and cite real results. When the request is ambiguous or you hit a genuine fork with no clearly-correct default, call ask_user with 2-5 short options and WAIT -- never pick silently. Do all file lookups (glob + grep) up front in ONE batched parallel turn, then read only the specific files you need: enough context in a SINGLE call (read with offset/limit), never rereading a location. Stop the moment every file the plan will touch is identified.\nTERMINAL: read-only inspection only -- git status, plain git diff (working-tree/staged), pwd, node/python --version, and build/test/lint. Never modify/create/delete files and never use it to read files (no ls/find/cat/sed/awk/head/tail/wc/grep).\nCHECKLIST: call update_plan ONCE, after writing '## Plan', with the final checklist Build will execute (every item status='pending': one item per file/group below plus a 'write and run tests' item); never while scouting.\nPREVIOUS PLAN: your finished plan is saved automatically (one per chat), OVERWRITING that chat's previous one. If the conversation already contains a previous ## Plan (in history or a SAVED PLAN block) AND the new message continues the same task, REVISE it instead of starting over: keep the bullets that are still correct, update/add/remove only what the user's new message affects, and open with 1-2 lines saying what changed. If the new message is a new, unrelated task, ignore the previous plan entirely and create a fresh one.\nFORMAT: open your final reply with '## Plan' and keep the WHOLE plan under ~25 lines in exactly this shape: (1) goal: 1-2 lines max; (2) one bullet PER FILE: `path` + what changes + why (function/line target, no prose dump, never repeating the same change in several bullets); (3) new files, if any, as bullets in the same list; (4) test: 1-3 verification commands only. Write the ## Plan document EXACTLY ONCE in your final message — never emit a second copy, never repeat the summary, never restate bullets as prose.\nAUDIENCE: write for the USER first, Build second -- every bullet understandable by a non-programmer: plain words, one reason ('why') per bullet, no bare symbol/line dumps without one short clause saying what they mean, no jargon without a 3-word explanation in parentheses.\nSNIPPETS: at most ONE tiny snippet (a few lines) per file, ONLY when Coder cannot infer the change from the bullet -- never one that restates a bullet -- followed by one short plain-language line saying what the user will SEE change. A snippet taken from the read tool starts with the file's path as a comment (e.g. // src/App.tsx) and is fenced as ```lang:START-END with the REAL line numbers from the read output (e.g. ```python:42-58).\nSKILLS/MCP: call create_skill/create_mcp only if the user explicitly asks to create/edit/install them (to edit a skill, load_skill first, then create_skill with the SAME name to overwrite it); otherwise plan them for Build.\nENDING: finish the plan with a single 'Files: path1, path2, ...' line (one line, comma-separated exact paths of every file the implementation will touch), then a single summary of MAX 3 bullets (same language as the plan) covering goal, changed files and outcome -- never repeating step text, never a second summary. Each section appears EXACTLY ONCE: one goal, one bullet list, one test line, one Files line, one summary. Do NOT close with an offer to implement or to switch modes: after your plan the app itself asks the user to Approve (which starts implementation in Coder mode) or request edits, so just end after the summary.\nOUTPUT DISCIPLINE: short beats complete -- cut every line the reader can skip; never restate the request, explain your scouting, or pad.",
        "reader": "You are a focused CODE READER inside a desktop IDE. The user has pointed at specific file(s) -- attached, or named directly. Read them with the read tool (and grep/read within them as needed) to answer; the search tools are available but stay focused on the pointed-at files unless the user asks to broaden. You MAY use web_search / fetch_url / vision only when the user explicitly asks for external info or attaches an image. Explain with exact file:line references and the WHY. Keep it concise; cite file:line. If the pointed-at context is insufficient, say what is missing rather than inventing file contents.",
        // Legacy aliases (same resolution as the sidecar's MODE_ALIASES).
        "chat": "You are a simple, friendly assistant inside a desktop IDE. Answer in the SAME LANGUAGE the user writes in. Use plain words and define technical terms. Handle BOTH everyday questions (movies, cooking, travel, general knowledge) AND project/code questions. You are read-only: never write, edit, create or delete files and never run commands.\nKeep answers short (1-3 lines) unless the user asks for detail; scale length to the question, never pad or restate it. Give step-by-step guidance ONLY when an attached skill requires it; do not force a numbered-step structure.\nProject/code questions (behavior, styling, logic, bugs, file structure, dependencies): check JUST-IN-TIME following the SEARCH STRATEGY rule (parallelizable work goes to task(subagent_type='subagent')) and answer from real code; never answer about the real project from general knowledge when the code is a grep/read away. Do NOT call any tool when the answer is already in front of you (conversation, memory, attached files, earlier tool results) or the question is unrelated to the project (greetings, general knowledge, pasted errors from OTHER apps/OS). For code/project questions use web_search only when the user explicitly asks. @mentioned or attached files are already noted: read them with the read tool instead of re-searching. You have full workspace access. If a skill is attached or auto-matched below (=== ATTACHED SKILLS === / === AUTO-MATCHED SKILLS ===), adopt its role and follow its instructions instead of generic mentoring. If an entry in === AVAILABLE SKILLS === matches the request, call load_skill for it first (a skill lookup is not a project lookup, so the no-tool rule above does not apply to it).\nExternal content (movies, trailers, images, videos, current events, docs, APIs, links): you MUST first use web_search (or the browser MCP tools when a browser connector is connected) to get REAL, VERIFIED URLs. NEVER fabricate URLs; every image/video URL must come from an actual web_search or fetch_url result. Images: ![description](verified-url); videos: a bare YouTube/Vimeo link on its own line (the frontend renders clickable cards).\nMulti-step work: call update_plan with a short checklist and tick each step completed the moment it is done. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work.\nOUTPUT DISCIPLINE: never dump full files or large code blocks; paste only tiny necessary snippets and name file paths. Cite line numbers in prose only when truly necessary. A snippet taken from the read tool starts with the file's path as a comment (e.g. // src/App.tsx) and is fenced as ```lang:START-END with the REAL line numbers from the read output (e.g. ```python:42-58) so the UI shows the file name and real line numbers. Any flow, process, sequence, architecture or relationship explanation must be a valid ```mermaid fenced diagram, never ASCII art or a plain list.",
        "codewriter": "You are Build, an implementation agent inside a desktop IDE. You receive the plan and implement it. Spawning tasks counts as starting work. Do only targeted lookups yourself following the SEARCH STRATEGY rule: nothing is pre-read, so try LSP first, else ONE targeted grep (path/include limited to the area you are working on) with context, then read only the pointed windows via symbols=[...] or ranges=[...] right before you edit. You have FULL access to every file inside the workspace. Targeted checks are BOUNDED: after at most 2-3 search batches you MUST start editing in the SAME turn — never keep searching when you already know which files to touch. Tools: edit_file / write_file / run_terminal (read-only build/test/lint) plus grep / glob / read for targeted checks.\nPARALLEL RESEARCH (HARD): you have NO read/grep/glob tools of your own — ALL file reading and searching goes through the `explore` tool. When a task spans several independent areas, you MUST fire SEVERAL `explore` calls IN THE SAME STEP (one per area/file group): parallel calls run CONCURRENTLY and cost a single round-trip, while one giant explore is slow and returns a shallow report. Never send a single broad explore for a multi-area task.\nCHECKLIST: for multi-step work call update_plan (skip it for trivial single-step changes). Always include a 'write and run tests' step for any change that introduces or alters BEHAVIOR or LOGIC (new functions, branches, edge cases, bug fixes); skip tests for pure cosmetic/refactor/doc changes unless they touch existing tested behavior, and prefer extending existing tests over adding trivial new ones. Mark each item 'completed' (and the next 'in_progress') the moment it is finished, before starting the next. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work. Finish the whole list in THIS turn — never end with pending items still doable. When ALL items are completed and new work needs its own steps, call update_plan with a FRESH list.\nEDITING: prefer edit_file (exact old_string/new_string) for existing files; write_file only for brand-new files. NEVER edit files through any command. Implement immediately once you have the needed context. When editing, always copy the clean file text from read (no line numbers, no wrappers or footers); if an edit reports old_string not found, re-read and copy the exact text shown in the error hint. Batch ALL edits to the SAME file in ONE edit_file call via edits=[{'old_string': ..., 'new_string': ...}, ...] (atomic, applied in list order, one checkpoint/diff/verify); edits you kept for yourself across DIFFERENT files go as parallel edit_file calls in the SAME turn — NEVER edit files you delegated to a subagent. Do not repeatedly edit the same code or modify unrelated code.\nHUMAN IN THE LOOP: before a hard-to-reverse action (deleting a real file) call confirm_action and WAIT. When a dependency, package, or server binary is missing, never stop with 'not installed' — ask with confirm_action (or request_permission for package installs) and WAIT, then retry the work; only stop if DENIED. At a genuine fork with no clearly-correct default call ask_user with 2-5 short options and WAIT. Do not overuse either.\nAUTO-VERIFY: every write/edit is auto-checked (syntax/typecheck) -- trust it; do not re-run verification yourself.\nCODE QUALITY: write maintainable, readable code following the project's existing structure and conventions: small focused files, meaningful names, DRY, no dead/commented-out code, minimal diffs, English comments. Fix any error you introduce and leave the codebase clean.\nREPLY DISCIPLINE: the edit_file/write_file tool call IS the artifact -- never paste full file contents or large code blocks into your visible reply; after writing/editing code, summarize concisely what changed (file, function, short diff-level description).\n\nHARD-CODING (ABSOLUTE): NEVER hard-code anything: no magic values or environment-specific assumptions in logic -- no hard-coded paths, credentials, URLs, feature flags, deployment/host settings, project-specific data, or behavior tied to one particular case. Source them from the project's configuration, environment variables, existing constants/registries, data files, or explicit parameters/dependencies, following the project's existing patterns.\n\nDEBUGGING PROTOCOL (when fixing a bug): follow this loop strictly, like a systematic debugger. (1) REPRODUCE first: run the failing test or a minimal script with run_terminal to see the actual error/traceback -- never guess the cause from a description alone. (2) Form a root-cause hypothesis, then confirm or refute it by reading the exact code/log lines it points to. (3) Apply the MINIMAL fix that addresses the root cause, not the symptom. (4) VERIFY by re-running the same test/script (bug gone) and the related test file (no regression); if verification fails, return to step (2) with the new evidence. Never claim a fix without having run it.\n\nPROJECT STRUCTURE AND EFFICIENCY: Read the project structure first and continue the existing pattern; never create duplicate files or needless folders. Group by responsibility: each file has a single responsibility (one reason to change); keep related files together (e.g. agent_registry.py beside agents.py, retrieval.py beside memory_manager.py, git_tools.py beside doc_tools.py); keep UI, logic and helpers separate, never mix them in one place. Write efficient yet readable code: stream/chunk large data instead of holding it all in memory, avoid repeated computation by reusing results, prefer early exit over nested conditions. Use clear names and explicit errors, never put secrets/keys in code, and never add a needless dependency.\n\nCODING RULES (always follow when writing or modifying code):\nWrite simple, readable, maintainable, and idiomatic code.\nFollow the best practices and conventions of the language and framework.\nKeep files, modules, functions, and components small and focused.\nMaintain a clean, logical, and scalable project structure. Organize code by responsibility/domain; do not put unrelated functionality into one file.\nSeparate concerns such as business logic, UI, data access, configuration, and utilities.\nReuse existing project patterns; avoid unnecessary duplication and over-abstraction.\nMake the smallest necessary change and preserve existing behavior.\nWrite CPU- and memory-efficient code. Avoid unnecessary allocations, copies, loops, I/O, network calls, and expensive operations.\nPrefer efficient algorithms and data structures when they materially improve performance.\nHandle errors explicitly and validate external/user input.\nAvoid security vulnerabilities, race conditions, resource leaks, and blocking operations where inappropriate.\nKeep types strict; avoid unnecessary `any`, casts, and disabled checks.\nDo not add dependencies unless clearly necessary.\nAdd or update relevant tests when appropriate.\nBefore finishing, review the code for correctness, structure, readability, security, CPU usage, memory usage, performance, and maintainability.\n\nHARD RULE (always follow): The user writes in Persian (فارسی). Reply ENTIRELY in Persian — every message, todo/checklist item, plan content, summary, and ask_user question and options. Never reply in English when the user writes Persian. EXCEPTION — SKILLS ARE ALWAYS ENGLISH (HARD): when you create a skill via create_skill, its `name`, `description` and `content` (full markdown body) MUST be entirely in English, even though the chat is Persian. Never create Persian skills. EXCEPTION — CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD): docstrings and comments in any code you write MUST be entirely in English, even though the chat is Persian. Never write Persian docstrings or comments. These hard rules override the Persian reply rule for skills and code docstrings/comments.",
    })
}

// --- app state (settings + chats) -------------------------------------------

/// Keys the renderer ships as cold-start defaults (mirror of state_db's
/// _DEFAULT_SETTINGS_KEYS) — used by the skeleton guard below.
const DEFAULT_SETTINGS_KEYS: &[&str] = &[
    "providers", "activeProviderId", "systemPrompts", "mcpServers", "mcpEnabled",
    "modes", "compactHeadroom", "root", "dir", "recentModels", "sidebarOpen",
    "fontSize", "dataPath", "whisperModel", "whisperBaseUrl",
    "sttProviderId", "sttModel",
    "subagentModels", "memory", "memoryTtlDays", "memoryMaxDocs",
    "memoryMaxChunks", "workspaceColors", "pinnedWorkspaces", "workspaces",
    "searchPlugins", "searchConsole", "pinnedChats",
];

/// True ONLY for the cold-start DEFAULT skeleton — a real user update must
/// always win over it (protects settings.json on slow volumes at boot).
fn looks_like_default_skeleton(settings: &Value) -> bool {
    let Some(obj) = settings.as_object() else { return false };
    if obj.is_empty() {
        return false;
    }
    if obj.keys().any(|k| !DEFAULT_SETTINGS_KEYS.contains(&k.as_str())) {
        return false;
    }
    for marker in ["workspaces", "recentModels", "workspaceColors", "systemPrompts", "modes", "mcpServers"] {
        if obj.get(marker).map(|v| !v.is_null()).unwrap_or(false) {
            let empty = match obj.get(marker) {
                Some(Value::Array(a)) => a.is_empty(),
                Some(Value::Object(o)) => o.is_empty(),
                _ => false,
            };
            if !empty {
                return false;
            }
        }
    }
    if let Some(Value::Array(providers)) = obj.get("providers") {
        for p in providers {
            if let Some(po) = p.as_object() {
                let has_key = po.get("apiKey").map(|v| !v.as_str().unwrap_or_default().is_empty()).unwrap_or(false);
                let has_models = po.get("models").map(|v| !v.is_null()).unwrap_or(false);
                if has_key || has_models {
                    return false;
                }
            }
        }
    }
    true
}

/// Every chat object on disk (chats/<workspace>/<id>.json), deduped by id with
/// the newest updatedAt winning — mirrors state_db._iter_chat_files.
fn iter_chats(data_root: &Path) -> Vec<Value> {
    let base = data_root.join("chats");
    let mut best: BTreeMap<String, (f64, Value)> = BTreeMap::new();
    let Ok(ws_dirs) = std::fs::read_dir(&base) else { return vec![] };
    let mut ws_names: Vec<PathBuf> = ws_dirs
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    ws_names.sort();
    for ws in ws_names {
        let Ok(files) = std::fs::read_dir(&ws) else { continue };
        let mut paths: Vec<PathBuf> = files
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        paths.sort();
        for p in paths {
            let Some(obj) = read_json(&p).filter(|v| v.is_object()) else { continue };
            let Some(cid) = obj.get("id").and_then(Value::as_str).map(String::from) else { continue };
            let mtime = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            let updated = obj
                .get("updatedAt")
                .and_then(Value::as_f64)
                .filter(|u| *u != 0.0)
                .unwrap_or(mtime);
            match best.get(&cid) {
                Some((u, _)) if *u > updated => {}
                _ => {
                    best.insert(cid, (updated, obj));
                }
            }
        }
    }
    best.into_values().map(|(_, v)| v).collect()
}

pub fn get_state(data_root: &Path) -> Value {
    let settings = read_json(&data_root.join("settings.json")).filter(|v| v.is_object());
    let mut chats = iter_chats(data_root);
    chats.sort_by(|a, b| {
        let ua = a.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0);
        let ub = b.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0);
        ua.partial_cmp(&ub).unwrap_or(std::cmp::Ordering::Equal)
    });
    json!({ "settings": settings, "chats": chats })
}

#[derive(serde::Deserialize)]
pub struct StateSaveBody {
    #[serde(default)]
    pub settings: Option<Value>,
    #[serde(default)]
    pub chats: Option<Vec<Value>>,
    #[serde(default)]
    pub deleted_chats: Option<Vec<String>>,
    #[serde(default)]
    pub deleted_workspaces: Option<Vec<String>>,
}

fn chat_file(data_root: &Path, chat: &Value) -> PathBuf {
    let root = chat.get("root").and_then(Value::as_str).unwrap_or_default();
    let ws = if root.trim().is_empty() {
        "workspace".to_string()
    } else {
        workspace_slug_for_root(root)
    };
    let cid = safe_file(chat.get("id").and_then(Value::as_str).unwrap_or("chat"), "chat");
    data_root.join("chats").join(ws).join(format!("{cid}.json"))
}

fn delete_chat_file_by_id(data_root: &Path, cid: &str) -> bool {
    let base = data_root.join("chats");
    let target = format!("{cid}.json");
    let Ok(ws_dirs) = std::fs::read_dir(&base) else { return false };
    for ws in ws_dirs.flatten() {
        let p = ws.path().join(&target);
        if p.is_file() {
            return std::fs::remove_file(&p).is_ok();
        }
    }
    false
}

/// Best-effort cleanup when a chat is deleted: its trace log and checkpoints.
fn cleanup_deleted_chat(data_root: &Path, cid: &str) {
    let safe = safe_file(cid, "chat");
    let _ = std::fs::remove_file(data_root.join("traces").join(format!("{safe}.jsonl")));
    let _ = std::fs::remove_dir_all(data_root.join("checkpoints").join(safe));
}

pub fn save_state(data_root: &Path, body: StateSaveBody) -> Response {
    if let Some(settings) = &body.settings {
        if settings.is_null() {
            // mirror save_settings: None is a no-op
        } else {
            let path = data_root.join("settings.json");
            let existing_json = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
            match existing_json {
                Some(existing_json)
                    if existing_json.as_object().map(|o| !o.is_empty()).unwrap_or(false)
                        && looks_like_default_skeleton(settings) =>
                {
                    // Cold-start skeleton racing a real file: keep the real
                    // one, archive it (mirror of _backup_then_save_settings).
                    let _ = atomic_write(
                        &data_root.join("settings.json.bak"),
                        &serde_json::to_string_pretty(&existing_json).unwrap_or_default(),
                    );
                }
                other => {
                    // settings.json is ONE flat document that also holds sibling
                    // keys the store writes directly ("chats", "deleted_chats",
                    // tombstones). Replacing the whole file with just the
                    // `settings` object silently deleted every sibling key —
                    // including the entire chat list. Merge instead: listed keys
                    // win, everything else survives.
                    let mut doc = other
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    if let Value::Object(incoming) = settings {
                        for (k, v) in incoming {
                            doc.insert(k.clone(), v.clone());
                        }
                    }
                    let _ = atomic_write_json(&path, &Value::Object(doc));
                }
            }
        }
    }
    if let Some(deleted) = &body.deleted_chats {
        for cid in deleted {
            delete_chat_file_by_id(data_root, cid);
            cleanup_deleted_chat(data_root, cid);
        }
    }
    if let Some(chats) = &body.chats {
        for c in chats {
            let path = chat_file(data_root, c);
            let _ = atomic_write_json(&path, c);
        }
    }
    if let Some(workspaces) = &body.deleted_workspaces {
        // Best-effort vector-db cleanup for removed workspaces (the sidecar's
        // per-workspace sqlite files live under vector-db/).
        for root in workspaces {
            let slug = workspace_slug_for_root(root);
            let vdb = data_root.join("vector-db");
            if let Ok(files) = std::fs::read_dir(&vdb) {
                for f in files.flatten() {
                    let name = f.file_name().to_string_lossy().into_owned();
                    if name.starts_with(&slug) {
                        let _ = if f.path().is_dir() {
                            std::fs::remove_dir_all(f.path())
                        } else {
                            std::fs::remove_file(f.path())
                        };
                    }
                }
            }
        }
    }
    Json(json!({ "ok": true })).into_response()
}

// --- checkpoints (Undo) ------------------------------------------------------

fn ckpt_base(data_root: &Path, chat_id: &str) -> PathBuf {
    data_root.join("checkpoints").join(safe_file(chat_id, "chat"))
}

fn ckpt_seq_dir(data_root: &Path, chat_id: &str, seq: i64) -> PathBuf {
    ckpt_base(data_root, chat_id).join(format!("{seq:06}"))
}

fn load_manifest(data_root: &Path, chat_id: &str, seq: i64) -> Option<Value> {
    read_json(&ckpt_seq_dir(data_root, chat_id, seq).join("manifest.json"))
}

pub fn list_checkpoints(data_root: &Path, chat_id: &str) -> Value {
    let base = ckpt_base(data_root, chat_id);
    let mut seqs: Vec<i64> = std::fs::read_dir(&base)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_string_lossy().parse::<i64>().ok())
                .collect()
        })
        .unwrap_or_default();
    seqs.sort_unstable_by(|a, b| b.cmp(a));
    let mut out: Vec<Value> = vec![];
    for seq in seqs {
        let Some(man) = load_manifest(data_root, chat_id, seq) else { continue };
        let paths: Vec<String> = man
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(|f| f.get("path").and_then(Value::as_str).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        out.push(json!({
            "seq": seq,
            "created": man.get("created").cloned().unwrap_or(json!(0)),
            "paths": paths,
        }));
    }
    json!({ "checkpoints": out })
}

fn prune_checkpoints(data_root: &Path, chat_id: &str, keep: usize) {
    let base = ckpt_base(data_root, chat_id);
    let Ok(rd) = std::fs::read_dir(&base) else { return };
    let mut seqs: Vec<i64> = rd
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse::<i64>().ok())
        .collect();
    seqs.sort_unstable();
    let excess = seqs.len().saturating_sub(keep);
    for seq in seqs.into_iter().take(excess) {
        let _ = std::fs::remove_dir_all(ckpt_seq_dir(data_root, chat_id, seq));
    }
}

pub fn restore_checkpoint(data_root: &Path, chat_id: &str, seq: i64, root: &str) -> Result<Value, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("missing workspace root".into());
    }
    let Some(man) = load_manifest(data_root, chat_id, seq) else {
        return Err(format!("checkpoint {seq} not found"));
    };
    let root_real = std::fs::canonicalize(root).map_err(|e| format!("root missing: {e}"))?;
    let mut restored: Vec<Value> = vec![];
    let mut errors: Vec<String> = vec![];
    let files = man.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    for f in files {
        let rel = f.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
        if rel.is_empty() {
            continue;
        }
        // Containment: a snapshot may belong to another workspace.
        let target = root_real.join(rel.trim_start_matches('/'));
        let anchor = if target.exists() {
            target.clone()
        } else {
            let mut anc = target.clone();
            while !anc.exists() && anc.pop() {}
            anc
        };
        match std::fs::canonicalize(&anchor) {
            Ok(real) if real == root_real || real.starts_with(&root_real) => {}
            _ => {
                errors.push(format!("{rel}: path escapes workspace root"));
                continue;
            }
        }
        if f.get("existed").and_then(Value::as_bool).unwrap_or(false) {
            let sha = f.get("sha256").and_then(Value::as_str).unwrap_or_default();
            let blob = ckpt_seq_dir(data_root, chat_id, seq).join("blobs").join(sha);
            let Ok(content) = std::fs::read_to_string(&blob) else {
                errors.push(format!("{rel}: blob missing"));
                continue;
            };
            let changed = std::fs::read_to_string(&target)
                .map(|cur| cur != content)
                .unwrap_or(false);
            if let Some(dir) = target.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&target, &content) {
                Ok(()) => restored.push(json!({ "path": rel, "changed": changed })),
                Err(e) => errors.push(format!("{rel}: {e}")),
            }
        } else {
            // The file did not exist before the write → restore means delete.
            if target.is_file() {
                let _ = std::fs::remove_file(&target);
            }
            restored.push(json!({ "path": rel, "changed": false }));
        }
    }
    prune_checkpoints(data_root, chat_id, 50);
    let mut out = json!({ "seq": seq, "restored": restored });
    if !errors.is_empty() {
        out["errors"] = json!(errors);
    }
    Ok(out)
}

// --- schedules (CRUD + run history; the due-check loop stays in the sidecar) -

fn schedules_dir(data_root: &Path) -> PathBuf {
    data_root.join("schedules")
}

fn schedule_runs_dir(data_root: &Path) -> PathBuf {
    schedules_dir(data_root).join("runs")
}

fn schedule_file(data_root: &Path, id: &str) -> PathBuf {
    schedules_dir(data_root).join(format!("{}.json", safe_file(id, "schedule")))
}

fn schedule_run_file(data_root: &Path, id: &str) -> PathBuf {
    schedule_runs_dir(data_root).join(format!("{}.json", safe_file(id, "run")))
}

pub fn list_schedules(data_root: &Path) -> Value {    let base = schedules_dir(data_root);
    let mut out: Vec<(f64, Value)> = vec![];
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "json").unwrap_or(false) {
                if let Some(obj) = read_json(&p).filter(|v| v.get("id").is_some()) {
                    let created = obj.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
                    out.push((created, obj));
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

pub fn save_schedule(data_root: &Path, mut task: Value) -> Result<Value, String> {
    let obj = task.as_object_mut().unwrap_or_else(|| Box::leak(Box::new(Map::new())));
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| format!("sch-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    obj.insert("id".into(), json!(id));
    let now = now_secs();
    obj.entry("created_at".to_string()).or_insert(json!(now));
    obj.insert("updated_at".into(), json!(now));
    if !obj.get("name").map(|v| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)).unwrap_or(false) {
        let name = obj
            .get("title")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("تسک زمان‌بندی");
        obj.insert("name".into(), json!(name));
    }
    obj.entry("enabled".to_string()).or_insert(json!(true));
    obj.entry("mode".to_string()).or_insert(json!("build"));
    obj.entry("run_count".to_string()).or_insert(json!(0));
    // Stale next_run in the past would make the panel show a past clock and
    // the loop burst — drop it (mirror of state_db.save_schedule).
    if let Some(nxt) = obj.get("next_run").and_then(Value::as_f64) {
        if nxt <= now {
            obj.remove("next_run");
        }
    }
    let path = schedule_file(data_root, &id);
    match atomic_write_json(&path, &task) {
        Ok(()) => Ok(task),
        Err(e) => Err(e),
    }
}

pub fn delete_schedule(data_root: &Path, id: &str) -> Value {
    let ok = std::fs::remove_file(schedule_file(data_root, id)).is_ok();
    json!({ "ok": ok })
}

pub fn list_schedule_runs(data_root: &Path, schedule_id: &str, limit: usize) -> Value {
    let base = schedule_runs_dir(data_root);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&base)
        .map(|rd| {
            let mut v: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            v.sort();
            v.reverse(); // newest filename first, like the sidecar
            v
        })
        .unwrap_or_default();
    if files.len() > limit.max(1) * 4 {
        files.truncate(limit.max(1) * 4);
    }
    let mut out: Vec<(f64, Value)> = vec![];
    for p in files {
        let Some(obj) = read_json(&p).filter(|v| v.get("id").is_some()) else { continue };
        if !schedule_id.is_empty()
            && obj.get("schedule_id").and_then(Value::as_str).unwrap_or_default() != schedule_id
        {
            continue;
        }
        let started = obj.get("started_at").and_then(Value::as_f64).unwrap_or(0.0);
        out.push((started, obj));
        if out.len() >= limit.max(1) {
            break;
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

pub fn delete_schedule_runs(data_root: &Path, schedule_id: &str) -> Value {
    let mut removed = 0usize;
    if !schedule_id.is_empty() {
        if let Value::Array(runs) = list_schedule_runs(data_root, schedule_id, 10_000) {
            for r in runs {
                if let Some(rid) = r.get("id").and_then(Value::as_str) {
                    if std::fs::remove_file(schedule_run_file(data_root, rid)).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    json!({ "ok": true, "removed": removed })
}

pub fn delete_schedule_run(data_root: &Path, run_id: &str) -> Value {
    let ok = !run_id.trim().is_empty()
        && std::fs::remove_file(schedule_run_file(data_root, run_id)).is_ok();
    json!({ "ok": ok })
}

pub fn delete_orphan_schedule_runs(data_root: &Path) -> Value {
    // Runs whose schedule no longer exists (mirror of /schedule-runs/orphans).
    let live: Vec<String> = match list_schedules(data_root)["schedules"].clone() {
        Value::Array(items) => items
            .iter()
            .filter_map(|s| s.get("id").and_then(Value::as_str).map(String::from))
            .collect(),
        _ => vec![],
    };
    let mut removed = 0usize;
    if let Value::Array(runs) = list_schedule_runs(data_root, "", 10_000) {
        for r in runs {
            let sid = r.get("schedule_id").and_then(Value::as_str).unwrap_or_default();
            if !sid.is_empty() && !live.iter().any(|l| l == sid) {
                if let Some(rid) = r.get("id").and_then(Value::as_str) {
                    if std::fs::remove_file(schedule_run_file(data_root, rid)).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    json!({ "ok": true, "removed": removed })
}

// --- chat title (native; replaces the sidecar's /chats/title) ---------------

#[derive(serde::Deserialize)]
pub struct TitleBody {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
    #[serde(default)]
    pub text: String,
}

/// Generate a short chat title from the first user message. The "title" Tool
/// Models slot overrides the model (cross-provider aware, same resolution as
/// the compact slot); empty slot = the chat model. Never throws.
pub async fn chat_title(
    axum::extract::State(st): axum::extract::State<crate::backend_light::AppState>,
    Json(body): Json<TitleBody>,
) -> Response {
    let _ = &st;
    let slot = body.subagent_models.get("title").cloned().unwrap_or_default();
    let (model, base_url, api_keys) = crate::backend_light::resolve_slot_target(
        &slot,
        &body.model,
        &body.base_url,
        &body.api_keys,
        &body.providers,
    );
    // The kind selects the URL path + auth header. `provider` carries it; a
    // legacy caller that only sent the configured id falls back to that.
    let parent_kind = if body.provider.trim().is_empty() {
        body.provider_id.as_str()
    } else {
        body.provider.as_str()
    };
    // `provider` is the KIND (openrouter/anthropic/google/custom…):
    // endpoint_and_auth + normalize_base switch on it to pick the URL path and
    // auth header. Filling it with the user-configured provider_id made every
    // anthropic/google title call hit the OpenAI-compatible path
    // (`{base}/chat/completions`) and fail.
    let kind = crate::backend_light::resolve_slot_kind(&slot, parent_kind, &body.providers);
    let prompt = format!(
        "Generate a short chat title (max 6 words, no quotes) for a conversation starting with:\n{}",
        body.text.chars().take(400).collect::<String>()
    );
    let client = crate::llm::http_client();

    // Fallback chain (title slot -> compact slot -> the chat model), mirroring
    // the Python handler: a slot that is unset, misconfigured or simply
    // unreachable must not leave the chat untitled. Each attempt is one cheap
    // one-shot completion, so trying the next candidate costs one round trip.
    let mut candidates: Vec<(String, String, String, Vec<String>)> =
        vec![(kind, model, base_url, api_keys)];
    for fallback_slot in ["compact", ""] {
        let entry = if fallback_slot.is_empty() {
            String::new()
        } else {
            body.subagent_models.get(fallback_slot).cloned().unwrap_or_default()
        };
        let (f_model, f_base, f_keys) = crate::backend_light::resolve_slot_target(
            &entry,
            &body.model,
            &body.base_url,
            &body.api_keys,
            &body.providers,
        );
        let f_kind = crate::backend_light::resolve_slot_kind(&entry, parent_kind, &body.providers);
        let cand = (f_kind, f_model, f_base, f_keys);
        if !candidates.contains(&cand) {
            candidates.push(cand);
        }
    }

    // Report the FIRST candidate's failure, not the last: the first candidate
    // is the model the user actually picked (the title slot), so its error is
    // the actionable one. Reporting the last fallback's error hid the real
    // cause — a misconfigured title slot surfaced as "no api key configured"
    // from the parent-model fallback, which sent debugging in the wrong
    // direction entirely.
    let mut first_error = String::new();
    let mut usage = Value::Null;
    for (c_kind, c_model, c_base, c_keys) in candidates {
        let cfg = crate::llm::LlmConfig {
            provider: c_kind,
            model: c_model,
            base_url: c_base,
            api_keys: c_keys,
            temperature: Some(0.2),
            // Reasoning models spend their first tokens on the thinking block,
            // so the old tiny cap (24) returned an EMPTY title for them and the
            // chat stayed untitled. A title is a few tokens, so a generous cap
            // costs nothing while leaving room for the reasoning preamble.
            max_tokens: Some(512),
            timeout_secs: 30,
        };
        match crate::llm::complete(&client, &cfg, "You generate concise chat titles.", &prompt).await {
            Ok(res) => {
                if usage.is_null() {
                    usage = res.usage.clone().unwrap_or(Value::Null);
                }
                let title = clean_title(&res.text);
                if !title.is_empty() {
                    return Json(json!({ "title": title, "usage": usage })).into_response();
                }
                if first_error.is_empty() {
                    first_error = "model returned an empty title".into();
                }
            }
            Err(e) => {
                if first_error.is_empty() {
                    first_error = e;
                }
            }
        }
    }
    Json(json!({ "title": Value::Null, "usage": usage, "error": first_error })).into_response()
}

/// Reduce a raw model reply to a usable one-line title.
///
/// Reasoning models wrap their answer in a ` thinking…</think>` block and often
/// quote or bullet the title; both would otherwise land in the sidebar verbatim.
fn clean_title(raw: &str) -> String {
    let mut text = raw.to_string();
    for (open, close) in [(" thinking", "</think>"), ("<thinking>", "</thinking>")] {
        while let (Some(a), Some(b)) = (text.find(open), text.find(close)) {
            if b < a {
                break;
            }
            text.replace_range(a..b + close.len(), "");
        }
    }
    let line = text
        .lines()
        .map(|l| l.trim().trim_start_matches(['#', '-', '*', ' ']).trim())
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    line.trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '.' || c == ':')
        .trim()
        .chars()
        .take(80)
        .collect()
}

// --- axum handlers -----------------------------------------------------------

#[cfg(test)]
mod title_tests {
    use super::clean_title;

    #[test]
    fn clean_title_strips_reasoning_and_decoration() {
        // A reasoning model's think block must never reach the sidebar.
        assert_eq!(clean_title(" thinkingweighing options</think>Fix the browser panel"), "Fix the browser panel");
        assert_eq!(clean_title("<thinking>x</thinking>Terminal scrollbar"), "Terminal scrollbar");
        // Bullets, quotes and trailing punctuation are decoration, not title.
        assert_eq!(clean_title("- \"Compact summary ledger\""), "Compact summary ledger");
        assert_eq!(clean_title("## Plan: migrate to Rust."), "Plan: migrate to Rust");
        // A think-only reply has no title at all — the caller must fall back.
        assert_eq!(clean_title(" thinkingonly thinking</think>"), "");
        assert_eq!(clean_title("   \n  "), "");
        // Long replies are cut to a sidebar-sized line.
        assert_eq!(clean_title(&"a".repeat(200)).chars().count(), 80);
    }
}

pub async fn app_state_get(State(st): State<crate::backend_light::AppState>) -> Response {
    Json(get_state(&st.root())).into_response()
}

pub async fn app_state_post(
    State(st): State<crate::backend_light::AppState>,
    Json(body): Json<StateSaveBody>,
) -> Response {
    save_state(&st.root(), body)
}

pub async fn system_prompts_get() -> Response {
    Json(system_prompts()).into_response()
}

pub async fn checkpoints_list(
    State(st): State<crate::backend_light::AppState>,
    AxumPath(chat_id): AxumPath<String>,
) -> Response {
    Json(list_checkpoints(&st.root(), &chat_id)).into_response()
}

#[derive(serde::Deserialize)]
pub struct CheckpointRestoreBody {
    #[serde(default)]
    pub root: String,
}

pub async fn checkpoints_restore(
    State(st): State<crate::backend_light::AppState>,
    AxumPath((chat_id, seq)): AxumPath<(String, i64)>,
    Json(body): Json<CheckpointRestoreBody>,
) -> Response {
    match restore_checkpoint(&st.root(), &chat_id, seq, &body.root) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    }
}

pub async fn schedules_list(State(st): State<crate::backend_light::AppState>) -> Response {
    Json(json!({ "schedules": list_schedules(&st.root()) })).into_response()
}

pub async fn schedules_upsert(
    State(st): State<crate::backend_light::AppState>,
    Json(body): Json<Value>,
) -> Response {
    match save_schedule(&st.root(), body) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub async fn schedules_delete(
    State(st): State<crate::backend_light::AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    Json(delete_schedule(&st.root(), &id)).into_response()
}

#[derive(serde::Deserialize)]
pub struct RunsQuery {
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn schedule_runs_list(
    State(st): State<crate::backend_light::AppState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<RunsQuery>,
) -> Response {
    Json(json!({ "runs": list_schedule_runs(&st.root(), &id, q.limit.unwrap_or(20)) })).into_response()
}

pub async fn schedule_runs_clear(
    State(st): State<crate::backend_light::AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    Json(delete_schedule_runs(&st.root(), &id)).into_response()
}

pub async fn all_schedule_runs(
    State(st): State<crate::backend_light::AppState>,
    Query(q): Query<RunsQuery>,
) -> Response {
    Json(json!({ "runs": list_schedule_runs(&st.root(), "", q.limit.unwrap_or(50)) })).into_response()
}

pub async fn schedule_run_delete(
    State(st): State<crate::backend_light::AppState>,
    AxumPath(run_id): AxumPath<String>,
) -> Response {
    Json(delete_schedule_run(&st.root(), &run_id)).into_response()
}

pub async fn orphan_schedule_runs_clear(State(st): State<crate::backend_light::AppState>) -> Response {
    Json(delete_orphan_schedule_runs(&st.root())).into_response()
}

// --- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-appstate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn build_prompt_requires_parallel_explore_calls() {
        // The main agent has no read/grep tools, so the prompt must name the
        // real tool (`explore`) and demand several calls in ONE step — the
        // old text pointed at a non-existent `task(subagent_type=...)` tool.
        let prompts = system_prompts();
        let build = prompts["build"].as_str().unwrap();
        assert!(build.contains("`explore`"), "{build}");
        assert!(build.contains("SEVERAL `explore` calls"), "{build}");
        assert!(!build.contains("subagent_type"), "{build}");
        // Legacy alias must carry the same research contract (old servers
        // answer with the alias keys only).
        let legacy = prompts["codewriter"].as_str().unwrap();
        assert!(legacy.contains("SEVERAL `explore` calls"), "{legacy}");
        assert!(!legacy.contains("subagent_type"), "{legacy}");
    }

    #[test]
    fn settings_roundtrip_and_skeleton_guard() {
        let root = tmp_root("settings");
        // A real settings write lands on disk.
        let real = json!({"theme": "latte", "providers": []});
        save_state(&root, StateSaveBody {
            settings: Some(real.clone()), chats: None, deleted_chats: None, deleted_workspaces: None,
        });
        assert_eq!(read_json(&root.join("settings.json")).unwrap(), real);
        // A later cold-start skeleton must NOT clobber it (archived instead).
        let skeleton = json!({"providers": [], "root": ""});
        save_state(&root, StateSaveBody {
            settings: Some(skeleton), chats: None, deleted_chats: None, deleted_workspaces: None,
        });
        assert_eq!(read_json(&root.join("settings.json")).unwrap(), real);
        assert!(root.join("settings.json.bak").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chats_save_dedupe_and_delete_cleanup() {
        let root = tmp_root("chats");
        let chat = json!({"id": "c1", "root": "/tmp/ws", "updatedAt": 100.0});
        save_state(&root, StateSaveBody {
            settings: None, chats: Some(vec![chat.clone()]), deleted_chats: None, deleted_workspaces: None,
        });
        let state = get_state(&root);
        assert_eq!(state["chats"].as_array().unwrap().len(), 1);
        assert_eq!(state["chats"][0]["id"], "c1");
        // Deleting the chat removes the file, its traces and its checkpoints.
        fs::create_dir_all(root.join("traces")).unwrap();
        fs::write(root.join("traces").join("c1.jsonl"), "{}").unwrap();
        save_state(&root, StateSaveBody {
            settings: None, chats: None, deleted_chats: Some(vec!["c1".into()]), deleted_workspaces: None,
        });
        assert_eq!(get_state(&root)["chats"].as_array().unwrap().len(), 0);
        assert!(!root.join("traces").join("c1.jsonl").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoint_restore_roundtrip() {
        let root = tmp_root("ckpt");
        let ws = root.join("ws");
        fs::create_dir_all(&ws).unwrap();
        // Build a checkpoint by hand in the sidecar's layout.
        let seq_dir = root.join("checkpoints").join("c1").join("000001");
        fs::create_dir_all(seq_dir.join("blobs")).unwrap();
        fs::write(seq_dir.join("blobs").join("abc"), "old content").unwrap();
        fs::write(
            seq_dir.join("manifest.json"),
            json!({"seq": 1, "created": 1.0, "files": [
                {"path": "a.txt", "existed": true, "sha256": "abc"},
                {"path": "gone.txt", "existed": false}
            ]}).to_string(),
        ).unwrap();
        // Current disk state differs from the snapshot.
        fs::write(ws.join("a.txt"), "changed on disk").unwrap();
        fs::write(ws.join("gone.txt"), "to be removed").unwrap();

        let listed = list_checkpoints(&root, "c1");
        assert_eq!(listed["checkpoints"][0]["seq"], 1);

        let out = restore_checkpoint(&root, "c1", 1, ws.to_str().unwrap()).unwrap();
        let restored = out["restored"].as_array().unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0]["changed"], json!(true)); // disk differed from blob
        assert_eq!(fs::read_to_string(ws.join("a.txt")).unwrap(), "old content");
        assert!(!ws.join("gone.txt").exists()); // restore of a new file = delete
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn schedules_crud_and_runs() {
        let root = tmp_root("sched");
        let saved = save_schedule(&root, json!({"name": "nightly", "cron": "0 3 * * *"})).unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("sch-"));
        assert_eq!(list_schedules(&root).as_array().unwrap().len(), 1);
        // A run for a live schedule is listed; deleting the schedule orphans it.
        let run_file = schedule_run_file(&root, "run-1");
        atomic_write_json(&run_file, &json!({"id": "run-1", "schedule_id": id, "started_at": 1.0})).unwrap();
        assert_eq!(list_schedule_runs(&root, &id, 50).as_array().unwrap().len(), 1);
        assert_eq!(delete_schedule(&root, &id)["ok"], json!(true));
        let out = delete_orphan_schedule_runs(&root);
        assert_eq!(out["removed"], json!(1));
        assert!(!run_file.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
