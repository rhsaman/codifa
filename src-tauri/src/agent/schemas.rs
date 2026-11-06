use super::*;

/// Tool schemas for the MAIN agent: the WORK set (edit/write/terminal/browser)
/// plus targeted lookups — `read` (files the step already knows), `grep` (one
/// known token) and locate-by-symbol (`find_symbol`, `lsp_symbols` and the three
/// position-based LSP lookups, see `lsp_position_schemas`) — which is what keeps
/// a narrow question from costing either a shell detour or a full `explore`
/// delegation. DISCOVERY stays delegated: `glob` is withheld (see
/// `retain_allowed_tools` and `denied_by_caps`).
pub(super) fn tool_schemas(allow_create: bool, allow_browser: bool) -> Vec<Value> {
    // Per-tool schemas: the model only sees the args each tool actually
    // accepts — a shared all-fields block made it emit empty filler
    // (command:"", limit:0, filePath:""…) that garbled cards and traces.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "write_file",
            "Create or overwrite file(s). SEVERAL files: pass `files` — written IN ORDER in this ONE call; never spend one round-trip per file.",
            json!({
                "path": {"type": "string"},
                "content": {"type": "string"},
                "files": {
                    "type": "array",
                    "description": "Several files written IN ORDER in this ONE call.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"}
                        },
                        "required": ["path", "content"]
                    }
                }
            }),
        ),
        (
            "edit_file",
            // A batch MUST name its file per entry. The schema used to say only
            // "an entry MAY name its own path", and the model duly sent
            // `{edits:[{old_string,new_string}]}` with no path anywhere — refused
            // as "no file named" and a whole round was spent relearning that.
            // The rule is now stated in the description AND enforced by `required`,
            // so the nameless shape is not constructible in the first place.
            "Replace exact strings in existing files. Put EVERY replacement you know in ONE call via `edits`, and give `path` on EVERY entry — a batch across files still costs ONE call, run IN ORDER. A call with neither a top-level `path` nor a `path` per entry names no file and is refused.",
            json!({
                "path": {"type": "string", "description": "The file to edit — required for the single-edit form; when using `edits`, put `path` on every entry instead."},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
                "edits": {
                    "type": "array",
                    "description": "Independent replacements, all applied IN ORDER in this one step.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "File this entry targets — required on every entry."},
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean"}
                        },
                        "required": ["path", "old_string", "new_string"]
                    }
                }
            }),
        ),
        (
            "run_terminal",
            // The schema is where the model learns the DIVISION OF LABOUR: the
            // backend refuses a shell read/search (MEASURED: the model reached
            // for `cat`/`sed -n` whenever the tool list did not say so).
            "Run shell command(s) in the workspace with a timeout. For terminal-only work: listing/measuring (du, df, ps, lsof), builds, tests, git, and paths outside the workspace (shell grep/find is fine there). It does NOT read workspace files and does NOT locate files — those are `read` and `grep`/`glob`/`find_symbol`. For a long-running process (dev server, watcher) set background=true: detached, output to a log, returns at once — never mute curl/wget (-s/-q hides progress). SEVERAL commands: pass `commands` — they run IN ORDER in this ONE call (one result block each); never spend one round-trip per inspection.",
            json!({
                "command": {"type": "string"},
                "commands": {"type": "array", "items": {"type": "string"}, "description": "Several commands run IN ORDER in this ONE call — one result block per command. Batch every independent inspection here instead of one call each."},
                "timeout": {"type": "integer", "description": "max seconds to wait (default 120, hard ceiling 1800 — for anything longer use background=true)"},
                "background": {"type": "boolean"}
            }),
        ),
        ("current_time", "Current UTC time.", json!({})),
        // Bounded read/search: the main agent may read what the step already
        // NAMED (a file list, one window) without a delegation. Measured on the
        // traced corpus, one main round re-sends the whole conversation for
        // ~7.7K uncached tokens at the START of a turn, but that number grows
        // with the turn: re-measured on the newest build, a late main round
        // re-sends a median of 79K input tokens against 16K for an `explore`
        // round, so past round 20 one main step already costs about five
        // explore rounds. Read/search here is for what the step already NAMED.
        (
            "read",
            "Read files this step KNOWS (discovery is `explore`). One call covers all: ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":80},{\"path\":\"a.rs\",\"offset\":400}] reads one window PER ENTRY (several files or windows cost one call; overlaps merge). An entry without `path` reuses filePath. Headers give the file's TOTAL lines, and a large file's FIRST window carries its definition outline — jump to the line you need, don't walk window by window.",
            json!({
                "filePath": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
                "ranges": {"type": "array", "items": {"type": "object"}}
            }),
        ),
        (
            "grep",
            "Regex search for a token whose FILE is unknown: pass path+include to scope it, then read the hits. Search HERE, not via `run_terminal` (a shell search is refused).",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "include": {"type": "string", "description": "Glob filter(s): `*.rs`, or a comma list `*.ts,*.tsx` — split into one glob per entry"},
                "max_results": {"type": "integer"},
                "context": {"type": "integer"},
                "ignore_case": {"type": "boolean"}
            }),
        ),
        // Locate-by-symbol, main-agent edition: the two tools that answer
        // "where does this live" WITHOUT reading the file. Traced on the live
        // corpus, the main agent burned 376 extra same-file reads (3.05M chars
        // ≈ 763K tokens) hunting lines it could have located, 62 of them
        // re-sending windows that overlapped what it had already read, and 35
        // rounds whose successor was a plain read of a grep hit. `find_symbol`
        // collapses grep → definition → references into ONE call and needs no
        // language server, so it works for every language; `lsp_symbols`
        // outlines a file instead of reading it to find where something lives.
        (
            "find_symbol",
            "Locate ONE identifier: its definition(s) with bodies PLUS every usage, in a single call — replaces the grep → definition → references chain (three rounds) and needs no language server. Use it FIRST whenever you know the symbol's name, then read only the windows it points at.",
            json!({
                "symbol": {"type": "string", "description": "Bare identifier (letters, digits, _ or $ — never a regex)"},
                "path": {"type": "string", "description": "Directory or file to scope the search (optional)"},
                "include": {"type": "string", "description": "Glob filter such as *.rs (optional)"}
            }),
        ),
        (
            "lsp_symbols",
            "Outline ONE file — functions/structs/classes with line ranges, `query` filters by name. Native and INSTANT (no server to boot), so use it instead of reading a large file to find where something lives, then read only that window.",
            json!({"filePath": {"type": "string"}, "query": {"type": "string"}}),
        ),
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
            "Create or update a stored skill (the Codex/Claude create_skill flow). ALWAYS pass `description` — one short ENGLISH line saying WHEN to use it; the agent picks skills by matching the request against it. To install from a repo pass `repo` instead of `content`. To EDIT, `load_skill` first then send the revised body; pass previous_name when renaming.",
            json!({
                "name": {"type": "string", "description": "Skill name (also the folder slug)"},
                "description": {"type": "string", "description": "REQUIRED. One-line ENGLISH summary of when to use this skill"},
                "content": {"type": "string", "description": "The skill body: step-by-step instructions the agent follows"},
                "previous_name": {"type": "string", "description": "Old name when renaming"},
                "repo": {"type": "string", "description": "Install from a repo instead of `content`: `owner/repo`, a GitHub URL, or a local folder"},
                "repo_path": {"type": "string", "description": "install: sub-folder holding SKILL.md (default: discover)"},
                "repo_ref": {"type": "string", "description": "install: branch/tag/commit (default: default branch)"},
                "extra_files": {"type": "object", "description": "Optional extra files: filename -> content"},
                "deleted_files": {"type": "array", "items": {"type": "string"}, "description": "Extra files to delete"},
                "delete": {"type": "boolean", "description": "Delete the skill instead of writing it"}
            }),
        ),
        (
            "update_plan",
            "Set/replace the live todo checklist shown in the Todos panel (also persisted to disk next to the plan). Call it ONCE after writing the plan, then again whenever an item's status changes. ALWAYS send the COMPLETE list, in order — it REPLACES the previous one. While a long step runs you may report its percent done via the optional \"progress\" field (0-100); the UI draws a small bar.",
            json!({
                "items": {
                    "type": "array",
                    "description": "The complete checklist, in order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "description": "Short imperative item the user can understand, in the user's language: what this step does (and the file it touches). Never bare jargon."},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                            "progress": {"type": "number", "description": "Optional 0-100 percent done for the step; the UI renders a progress bar. Omit when unknown."}
                        },
                        "required": ["content", "status"]
                    }
                }
            }),
        ),
        (
            "ask_user",
            "Ask the user and WAIT for the answer. Use on ambiguity or a genuine fork with no clearly-correct default. ONE decision: `question` + `options` (2-5 short choices; the app shows a pick-one card; free text allowed too). Related sub-questions feeding the SAME decision: `sections` instead — one card, answered and submitted together. Fill either form, never both.",
            json!({
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "2-5 short choices"},
                "sections": {
                    "type": "array",
                    "description": "2-4 related sub-questions in ONE card; each item {title, options[2-5]}.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "options": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["title", "options"]
                    }
                }
            }),
        ),
        (
            "confirm_action",
            "Ask the user to APPROVE a destructive or out-of-workspace action and WAIT for the decision (returns allowed/denied). Use it before deleting outside the workspace, installing packages, or running an irreversible command.",
            json!({
                "action": {"type": "string", "description": "What you want to do — short and concrete"},
                "path": {"type": "string", "description": "The file/folder it touches, if any"},
                "reason": {"type": "string", "description": "Why it is needed"}
            }),
        ),
        (
            "create_mcp",
            "Create or update an MCP connector (the `/mcp` flow). Pass EITHER command (+ optional args/env) for a stdio server, OR url for an HTTP one. To EDIT an existing connector, pass its SAME name to overwrite it in place, or pass previous_name to rename it (the old file is removed so no stale duplicate is left). The connector is saved but stays off until the user enables it in the composer's MCP picker.",
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
            "batch",
            "Run SEVERAL tool calls IN ORDER in this ONE call — a whole step in one round-trip: ops=[{\"tool\": \"grep\", \"args\": {...}}, {\"tool\": \"read\", ...}, {\"tool\": \"edit_file\", ...}, {\"tool\": \"run_terminal\", ...}]. Batchable: read, grep, glob, find_symbol, the lsp_* lookups, run_terminal, edit_file, write_file, current_time, system_stats (max 10). Every result comes back COMPLETE, labeled per op, run in order — a later op sees an earlier edit's effects. Plan the WHOLE step here: all the lookups you expect to need, the edits, and the verification command together. A wave that needs a result you do not have yet waits for your next round.",
            json!({
                "ops": {
                    "type": "array",
                    "description": "The tool calls of this step, IN ORDER. Each entry: {tool, args} with args = that tool's normal arguments.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string", "description": "One of the batchable tools"},
                            "args": {"type": "object", "description": "That tool's normal arguments"}
                        },
                        "required": ["tool"]
                    }
                }
            }),
        ),
        (
            "load_skill",
            "Load a skill's FULL body BEFORE work it covers. ONE call can load SEVERAL skills: names=[\"A\",\"B\"] returns every body together — ask for all the skills the task needs here, a second load call costs a round-trip. `query` searches every installed skill, `bundle` lists one plugin bundle's skills.",
            json!({
                "name": {"type": "string", "description": "Name or slug"},
                "names": {"type": "array", "items": {"type": "string"}, "description": "SEVERAL skills in THIS one call — every body comes back together"},
                "query": {"type": "string", "description": "Words when the name is unknown"},
                "bundle": {"type": "string", "description": "Plugin bundle slug: list that bundle's skills"},
                "file": {"type": "string", "description": "Extra file of that skill (single-name form only)"}
            }),
        ),
        // Plugins bundle skills + MCP connectors into ONE switchable unit. The
        // `action` multiplexer (same shape as `computer`) keeps the tool list
        // short: create/update/toggle/delete/list instead of four tools.
        (
            "plugin",
            "Create, edit, install or run a plugin: one switchable folder bundling skills, MCP connectors, commands, sub-agents, hooks and scripts. `create` MAKES one, `install` READS one from a repo or folder, `update` patches only what is sent, `toggle` flips `enabled`, `run` executes a script. `list` is compact — one line per bundle; pass `slug` with it for that one bundle's full manifest. Give every part a one-line English `description` — the agent matches requests against it. Scripts are Rust unless the user asked otherwise.",
            json!({
                "action": {"type": "string", "enum": ["list", "install", "create", "update", "toggle", "delete", "run"]},
                "repo": {"type": "string", "description": "install: `owner/repo`, GitHub URL, or local path"},
                "repo_path": {"type": "string", "description": "install: sub-folder holding the bundle"},
                "repo_ref": {"type": "string", "description": "install: branch/tag/commit"},
                "name": {"type": "string", "description": "Plugin name (also the slug)"},
                "slug": {"type": "string", "description": "Folder slug; defaults to the lowercased name"},
                "description": {"type": "string", "description": "ONE short English line saying WHEN the bundle applies — the agent matches requests against it."},
                "version": {"type": "string", "description": "Defaults to 1.0.0"},
                "enabled": {"type": "boolean", "description": "toggle: the value to set; omit to flip"},
                "skills": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "content": {"type": "string"},
                            "description": {"type": "string", "description": "ONE short English line saying WHEN to use it"},
                            "previous_name": {"type": "string", "description": "Old skill name when renaming"},
                            "extra_files": {"type": "object", "description": "Extra files: filename -> content"},
                            "deleted_files": {"type": "array", "items": {"type": "string"}, "description": "Extra files to delete"}
                        },
                        "required": ["name", "content"]
                    }
                },
                "deleted_skills": {"type": "array", "items": {"type": "string"}},
                "commands": {"type": "array", "description": "Slash commands: name (typed after `/`), description, content (body; `$ARGUMENTS`, `$1`..`$9`).", "items": {"type": "object", "properties": {"name": {"type": "string"}, "description": {"type": "string"}, "content": {"type": "string"}}, "required": ["name"]}},
                "deleted_commands": {"type": "array", "items": {"type": "string"}},
                "agents": {"type": "array", "description": "Sub-agent profiles: each is a delegation tool that ALWAYS runs on the Explore model row.", "items": {"type": "object", "properties": {"name": {"type": "string"}, "description": {"type": "string", "description": "WHEN to delegate"}, "tools": {"type": "array", "items": {"type": "string"}, "description": "Omit for all; can only NARROW"}, "prompt": {"type": "string", "description": "Its system prompt"}}, "required": ["name", "prompt"]}},
                "deleted_agents": {"type": "array", "items": {"type": "string"}},
                "hooks": {"type": "object", "description": "Shell guards: {Event: [{matcher, hooks: [{command}]}]}. Exit 2 vetoes. They run while the bundle is enabled."},
                "scripts": {
                    "type": "array",
                    "description": "Runnable scripts. RUST unless the user explicitly named another language: leave `language` OUT.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Name used by action=run"},
                            "language": {"type": "string", "enum": ["rust", "python", "node", "bash"], "description": "Omit for Rust. Set ONLY when the user named this language themselves."},
                            "description": {"type": "string"},
                            "content": {"type": "string", "description": "Full source; omit for a starter"},
                            "previous_name": {"type": "string", "description": "Set when renaming"}
                        },
                        "required": ["name"]
                    }
                },
                "deleted_scripts": {"type": "array", "items": {"type": "string"}},
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "run: script arguments"
                },
                "timeout": {"type": "integer", "description": "run: max seconds to wait (omit for no limit — a plugin script is never cut off)"},
                "cwd": {"type": "string", "description": "run: working folder (default: the plugin folder)"}
            }),
        ),
        // Artifacts are versioned documents the renderer previews in a sandboxed
        // right-hand panel instead of dumping raw markup into the bubble. They
        // carry supporting files too: an artifact may need a real backend.
        (
            "artifact",
            "Create, update or delete a chat artifact: a versioned HTML/Markdown document shown in a sandboxed preview panel, optionally with supporting files (backend source, data, config).",
            json!({
                "action": {"type": "string", "enum": ["create", "update", "delete"]},
                "title": {"type": "string"},
                "id": {"type": "string", "description": "Derived from title; needed to update"},
                "kind": {"type": "string", "enum": ["html", "md"]},
                "content": {"type": "string", "description": "The document itself; self-contained for html (inline CSS/JS, no network). If the UI needs live data or logic, do NOT fake it in the page: write the backend too and pass it through `files`, then talk to it over the page's MCP channel."},
                "files": {
                    "type": "array",
                    "description": "Supporting files of this version: backend source, data, config. BACKEND LANGUAGE: Rust first. Write the backend as a Rust source file (single file, std-only unless the project already carries a manifest) and list it here, so the plugin runner compiles and caches it. Use another language ONLY if Rust genuinely cannot do the job (e.g. a Python-only SDK the task needs) AND the user agreed after you asked — never silently, never for convenience. Omitting `files` on an update keeps the files already stored.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative file name (e.g. backend.rs); stored under the artifact's assets folder"},
                            "content": {"type": "string"}
                        },
                        "required": ["path", "content"]
                    }
                },
                "chat_id": {"type": "string", "description": "Owning chat id"}
            }),
        ),
        // Schedules as data: the agent creates the task, the panel only shows it.
        (
            "schedule",
            "Create, edit, toggle or delete a scheduled task (cron prompt that runs headless in the background).",
            json!({
                "action": {"type": "string", "enum": ["list", "create", "update", "toggle", "delete"]},
                "id": {"type": "string", "description": "Needed for update/toggle/delete"},
                "name": {"type": "string"},
                "prompt": {"type": "string", "description": "What the run should do"},
                "cron": {"type": "string", "description": "5-field cron in the machine's LOCAL time; empty = run once"},
                "enabled": {"type": "boolean", "description": "toggle: value to set; omit to flip"},
                "root": {"type": "string", "description": "Workspace root the run works in"},
                "mode": {"type": "string"},
                "plugins": {"type": "array", "items": {"type": "string"}, "description": "Plugins every run gets"},
                "allow_browser": {"type": "boolean", "description": "Let every run of this task use the in-app browser: the shared Chromium with its saved logins (e.g. a posted session cookie), for tasks like posting to Instagram or trading on a web exchange. Default false — set true only when the task really browses."}
            }),
        ),
        (
            "explore",
            "Delegate research that needs MANY rounds (how an area works, where X is wired up). It reads, greps, globs and runs LSP lookups, then returns the FULL findings. Fire SEVERAL TIMES IN THE SAME STEP — parallel calls run CONCURRENTLY for ONE round-trip — one focused question per area; prefer 2-4 focused explores over one giant one. Read a file whose path you already know directly instead of delegating it. Args: description (SHORT label for the UI, under 80 chars) and prompt (the full research question).",
            json!({
                "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                "prompt": {"type": "string", "description": "The full research question for the sub-agent"}
            }),
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
            "web_search",
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. The result count is fixed by the user's \"Results per search\" setting (Settings → Web Providers) — do NOT try to request more or fewer results; if the user wants a different count, tell them where to change it. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"}
            }),
        ),
        (
            "fetch_url",
            "Fetch ONE web page or raw file and return its text (Markdown). The full page comes back, capped at 100000 chars; pass full=true for source files (SKILL.md, docs, raw.githubusercontent / jsdelivr / gist URLs), or offset=N to page past an earlier excerpt. Run web_search first to find the right URL, then fetch only the URLs you need.",
            json!({
                "url": {"type": "string", "description": "The URL to fetch (must start with http:// or https://)"},
                "full": {"type": "boolean", "description": "Lift the 100000-char cap (use for source/document files)"},
                "offset": {"type": "integer", "description": "Character offset to start from, when paging through a long page"}
            }),
        ),
        (
            "use_mcp",
            "Load an MCP connector's tools for this turn. Connectors are exposed as an INDEX (see the MCP CONNECTORS section of your prompt): a switched-on connector costs nothing until you ask for it, because every connector's whole catalogue would otherwise ride on every round trip. Call this with the server name when the task actually needs that connector; its tools become available from your next call onward. Call it with no argument to list what is available.",
            json!({
                "server": {"type": "string", "description": "The connector's server name, exactly as the MCP CONNECTORS index spells it"}
            }),
        ),
    ];
    // Native browser tools (`browser_driver`): the app's own CDP driver ships
    // these under the SAME `browser_*` names the prompts and skills already
    // describe, so the built-in browser needs no MCP connector. Any connector
    // that happens to expose a colliding name is dropped by the native-wins
    // filter above instead of shadowing the in-process driver.
    //
    // Bound ONLY while the composer's Browser switch is on: with it off the
    // model never sees a browser tool, so it cannot start a Chromium nobody
    // asked for. This is the first of two gates; the dispatch arm is the second.
    let mut extra = if allow_browser {
        crate::browser_driver::entries()
    } else {
        Vec::new()
    };
    let schemas: Vec<(&str, &str, Value)> = schemas
        .iter()
        .map(|(name, desc, props)| (*name, *desc, props.clone()))
        .chain(lsp_position_schemas())
        .chain(extra.drain(..))
        .collect();
    let mut out: Vec<Value> = schemas
        .iter()
        // The skill/connector AUTHORING tools are bound only for a turn that
        // actually asked for them (see AgentRequest::allow_create). `artifact`
        // is deliberately NOT in this list: whether a turn builds one is the
        // MODEL's decision, not something `allow_create` (a prompt-text guess)
        // can predict — gating it made a correctly phrased request ship a
        // hard-coded HTML mock instead. `plugin` is likewise absent: it is the
        // one door to a bundle's scripts, so a plain turn keeps `list`/`run`
        // (see the narrowing below) and the create path gets its full action
        // set — which is what an artifact with a Rust backend needs to RUN it.
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
        .collect();
    if !allow_create {
        compact_plugin_schema(&mut out);
        compact_schedule_schema(&mut out);
    }
    out
}

/// Swap the `schedule` tool's full schema for the list-only one, the exact
/// mirror of `compact_plugin_schema`: `schedule` STAYS in the tool list in every
/// turn (the model can always answer "what is scheduled" without burning a
/// round on a refusal), but the authoring prose and the create/update/toggle/
/// delete enum only ride on a turn that may actually write. The full schema is
/// ~1.1K chars re-sent on every round-trip, and a read-only turn advertising
/// `action=create` only invites the call its own backstop then refuses.
pub(super) fn compact_schedule_schema(schemas: &mut [Value]) {
    for s in schemas.iter_mut() {
        if s["function"]["name"] != "schedule" {
            continue;
        }
        *s = json!({
            "type": "function",
            "function": {
                "name": "schedule",
                "description": "List the user's scheduled tasks (name, cron, on/off). \
Creating or editing one is not available in this mode.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list"]},
                    },
                },
            },
        });
    }
}

/// The four media-generation tools, bound ONLY on the main agent's turn (see
/// the call site: a sub-agent must not spend the user's provider credit). The
/// descriptions name the user's configured DEFAULT models — the model knows
/// what it will hit before the call costs anything — and teach the display
/// contract: every result carries a `codifa-media://` markdown reference the
/// renderer turns into an inline picture or player, and the model includes it
/// VERBATIM so the user actually sees the file.
///
/// NOTE: no tool here exposes a per-call `model` argument. The agent must
/// generate with whatever the user configured in Settings (slot default +
/// ordered fallbacks); a tool-supplied override would let it silently pick
/// other providers' models and spend the user's credit elsewhere. Model
/// choice is a USER setting, never an agent lever.
pub(super) fn media_tool_schemas(image_default: &str, video_default: &str) -> Vec<Value> {
    let img = if image_default.trim().is_empty() {
        "(no default — the tool errors until one is set in Settings)"
    } else {
        image_default.trim()
    };
    let vid = if video_default.trim().is_empty() {
        "(no default — the tool errors until one is set in Settings)"
    } else {
        video_default.trim()
    };
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": format!(
                    "Generate ONE image from a text prompt with the user's configured image provider (default model: {img}). \
                     The file is saved into THIS CHAT's media folder under the app data root (~/.codifa/media — NOT the workspace) and the result carries a \
                     `codifa-media://` markdown reference — include that line VERBATIM in your reply so the user sees the image. \
                     Costs the user's provider credit: one call per image, never batch speculative sizes. \
                     If the user asked for an EDIT of an existing picture, use edit_image instead."
                ),
                "parameters": {"type": "object", "properties": json!({
                    "prompt": {"type": "string", "description": "What the image shows — be concrete (subject, style, lighting)"},
                    "size": {"type": "string", "description": "Optional WxH like 1024x1024; omit to let the provider default"},
                    "output": {"type": "string", "description": "Optional workspace-relative save path; default media/<stamp>.png"}
                })},
            },
        }),
        json!({
            "type": "function",
            "function": {
                "name": "edit_image",
                "description": format!(
                    "Edit an EXISTING image in the workspace with the configured image provider (default model: {img}): \
                     restyle, add/remove elements, or re-generate a rectangular region. `path` is a workspace-relative \
                     image; `mask_region` (x/y/w/h in source pixels) limits the change to that rectangle and keeps the \
                     rest identical where the provider supports masking. The EDITED copy is saved as a NEW file — the \
                     original is never overwritten — and the result's `codifa-media://` line goes into your reply VERBATIM. \
                     For a brand-new picture use generate_image."
                ),
                "parameters": {"type": "object", "properties": json!({
                    "path": {"type": "string", "description": "Workspace-relative image to edit (e.g. media/image-20261031-120000-ab12.png)"},
                    "prompt": {"type": "string", "description": "What to change"},
                    "mask_region": {"type": "object", "description": "Optional {x,y,w,h} rectangle in source pixels to restrict the edit"},
                    "size": {"type": "string", "description": "Optional WxH output size"},
                    "output": {"type": "string", "description": "Optional save path; default media/image-edit-<stamp>.png"}
                })},
            },
        }),
        json!({
            "type": "function",
            "function": {
                "name": "generate_video",
                "description": format!(
                    "Generate ONE short video clip from a text prompt (or animate an image: pass `image` — that \
                     picture becomes the clip's FIRST frame) with the configured video provider (default model: {vid}). \
                     This is SLOW (often 1-5 minutes) and expensive — fire it only when the user asked for video, and \
                     tell the user it is running. Clips are SHORT (providers cap them at ~4-12s) and clips WITH audio \
                     cost more than silent ones. For a LONGER story, chain clips: generate clip 1, extract its LAST \
                     frame (edit_video action=frames at the end timestamp), pass that frame as `image` to clip 2, then \
                     stitch everything with edit_video action=merge. Local assembly (slideshow from images, trim, \
                     merge) is edit_video's job, not this tool's. The result's `codifa-media://` markdown line goes \
                     into your reply VERBATIM so the inline player appears."
                ),
                "parameters": {"type": "object", "properties": json!({
                    "prompt": {"type": "string", "description": "What the clip shows (camera movement, scene, mood)"},
                    "image": {"type": "string", "description": "Optional workspace-relative image to animate (image-to-video)"},
                    "seconds": {"type": "integer", "description": "Clip length in seconds (providers cap it, often 4-12)"},
                    "size": {"type": "string", "description": "Optional WxH or aspect like 1280x720"},
                    "output": {"type": "string", "description": "Optional save path; default media/clip-<stamp>.mp4"}
                })},
            },
        }),
        json!({
            "type": "function",
            "function": {
                "name": "edit_video",
                "description": "Local ffmpeg editing of EXISTING media files — fast and free, no provider involved. \
                     Actions: `probe` (duration/size/fps of one file — run it BEFORE trimming to pick bounds), \
                     `trim` (path+start+end seconds, frame-accurate re-encode), `merge` (paths[] in list order; every \
                     clip is normalized to the first clip's size/fps, so different sources still concatenate cleanly), \
                     `slideshow` (paths[] of IMAGES + seconds each → one mp4 — the free way to make a short video), \
                     `frames` (path+at[] → stills in media/frames/, feed one to edit_image), `convert` (path+format: \
                     mp4|webm|mov|gif|mp3|wav). Outputs are NEW files in media/; results carry `codifa-media://` \
                     markdown lines for your reply.",
                "parameters": {"type": "object", "properties": json!({
                    "action": {"type": "string", "description": "probe | trim | merge | slideshow | frames | convert"},
                    "path": {"type": "string", "description": "Workspace-relative media file (probe/trim/frames/convert)"},
                    "paths": {"type": "array", "items": {"type": "string"}, "description": "List of files, IN ORDER (merge, slideshow)"},
                    "start": {"type": "number", "description": "trim: start seconds"},
                    "end": {"type": "number", "description": "trim: end seconds"},
                    "seconds": {"type": "number", "description": "slideshow: seconds per image (default 3)"},
                    "at": {"type": "array", "items": {"type": "number"}, "description": "frames: timestamps in seconds"},
                    "format": {"type": "string", "description": "convert: mp4 | webm | mov | gif | mp3 | wav"},
                    "output": {"type": "string", "description": "Optional save path; default media/<kind>-<stamp>.<ext>"}
                })},
            },
        }),
    ]
}

/// Advertise every ENABLED bundle's sub-agent profiles as delegation tools.
///
/// One mechanism for every sub-agent: the builtin `explore` is advertised in the
/// static table, and every installed profile joins it HERE, under
/// [`DELEGATION_PREFIX`] so a bundle's `reviewer` cannot shadow a native `read`.
/// Each description carries the profile's own text (that is how the model learns
/// WHEN to delegate to it), and the parameter shape is `explore`'s — a profile
/// never asks for different arguments.
pub(super) fn delegation_schemas(root: &std::path::Path) -> Vec<Value> {
    crate::plugins::enabled_plugin_agents(root)
        .iter()
        .filter_map(|row| {
            let name = row["name"].as_str()?.trim();
            let prompt = row["prompt"].as_str().unwrap_or_default().trim();
            if name.is_empty() || prompt.is_empty() {
                return None;
            }
            let description = row["description"].as_str().unwrap_or_default().trim();
            let bundle = row["plugin"].as_str().unwrap_or_default().trim();
            let head = if description.is_empty() {
                format!("Delegate to the `{name}` sub-agent")
            } else {
                format!("Delegate to the `{name}` sub-agent: {description}")
            };
            Some(json!({
                "type": "function",
                "function": {
                    "name": delegation_tool_name(name),
                    "description": format!(
                        "{head}{} Args: description (SHORT label for the UI) and prompt \
                         (the full task for that sub-agent). Every sub-agent runs on the \
                         Explore model row of Settings → Tools.",
                        if bundle.is_empty() {
                            String::new()
                        } else {
                            format!(" (from the `{bundle}` plugin)")
                        }
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "description": {"type": "string", "description": "SHORT label for the UI (under 80 chars)"},
                            "prompt": {"type": "string", "description": "The full task for the sub-agent"}
                        },
                        "required": ["description", "prompt"]
                    }
                }
            }))
        })
        .collect()
}

/// Swap the `plugin` tool's full schema for the compact one: a plain turn keeps
/// the door to a bundle's scripts (`list`/`run`) but NOT the authoring prose.
/// The full schema is ~2.9K chars and is re-sent on every round-trip, so the
/// authoring description would tax every turn to describe actions this one
/// cannot call. This is ALSO the honest gate in read-only modes: `allow_create`
/// is sticky (granted by an authoring request earlier in the history), so an
/// Ask turn can still carry it — with the full enum the model then names
/// `action=update` where only `run` is possible. A mode that cannot write
/// files therefore gets the compact form too; the loop keeps a second gate for
/// a stale transcript.
pub(super) fn compact_plugin_schema(schemas: &mut [Value]) {
    for s in schemas.iter_mut() {
        if s["function"]["name"] != "plugin" {
            continue;
        }
        *s = json!({
            "type": "function",
            "function": {
                "name": "plugin",
                "description": "A plugin bundle's scripts: `list` names the bundles and their \
scripts, `run` executes one on disk. Saving a bundle needs the user to ask for it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list", "run"]},
                        "slug": {"type": "string", "description": "Plugin folder slug"},
                        "name": {"type": "string", "description": "run: script name"},
                        "args": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        });
    }
}

/// The POSITION-based LSP lookups: definition, references, hover — plus
/// `lsp_diagnostics`.
///
/// Shared by BOTH roles through `lsp_position_schemas`, so the main agent gets
/// targeted symbol navigation without a second copy of the prose. They stay
/// separate from `tool_schemas`' base table because the explore set already
/// carried them and the main set only grew them once the trace justified it:
/// 92.2% of every read window in the corpus (1_645 of 1_785) sits in a language
/// with a REGISTERED language server (.rs/.ts/.tsx/.js/.py/.sh/.astro), so a
/// symbol jump is available wherever the model actually spends its reads. The
/// failure path is bounded and self-explaining — an uninstalled server answers
/// "the language server is not installed or not on PATH. Use grep + read …
/// instead of retrying" — so one miss costs one round, not a hunt.
///
/// `lsp_diagnostics` also rides on every successful `edit_file` (see
/// `tools::post_edit_diagnostics`): a WARM server answers inline, so the model
/// no longer spends a whole round on a manual typecheck it cannot skip.
pub(super) fn lsp_position_schemas() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "lsp_definition",
            "Jump to the DEFINITION of a symbol and show its body — more precise and cheaper than grep for \"where is X defined\". Pass filePath + symbol (the identifier as written in that file); line is an optional hint for repeated names. Never waits for an index.",
            json!({
                "filePath": {"type": "string", "description": "File that contains the symbol (a usage or the declaration)"},
                "symbol": {"type": "string", "description": "Identifier to look up, exactly as written in the file"},
                "line": {"type": "integer", "description": "Optional 1-based line to disambiguate repeated names"},
                "character": {"type": "integer"}
            }),
        ),
        (
            "lsp_references",
            "Find ALL references/usages of a symbol across the workspace. Pass filePath + symbol (same as lsp_definition). Never waits for an index.",
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
            "lsp_diagnostics",
            "Errors and warnings the language server reports for ONE file, WITHOUT running a build. Use it right after an edit instead of a full build/typecheck round: it answers in one call and names the exact line. It reports only what the server has published for that file — it is not a substitute for running the project's real test command before finishing.",
            json!({
                "filePath": {"type": "string", "description": "File to check (a language server must be installed for its language)"}
            }),
        ),
    ]
}

/// Tool schemas for the explore SUB-AGENT: the UNBOUNDED search set — `glob`
/// discovery — plus the memory tools, which BOTH roles share (see tool_schemas).
/// It shares `read`/`grep`/`find_symbol` and the position-based LSP lookups with
/// the main agent by design: both roles read, they differ in how far they may
/// wander.
pub(super) fn research_schemas() -> Vec<Value> {
    // Per-tool schemas (see tool_schemas): only the args each tool accepts.
    let schemas: &[(&str, &str, Value)] = &[
        (
            "read",
            "Read files you already KNOW. ONE call covers several: ranges=[{\"path\":\"a.rs\",\"offset\":1,\"limit\":80},{\"path\":\"a.rs\",\"offset\":400},{\"path\":\"b.ts\"},…] reads one window per entry (several files and several windows alike); an entry without `path` reuses filePath. Overlapping or adjacent windows of one file arrive merged. Default window 400 lines; each header states the file's TOTAL lines — jump to the window you need instead of walking the file.",
            json!({
                "filePath": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
                "ranges": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}}}
            }),
        ),
        (
            "grep",
            "Regex content search. ALWAYS pass path (dir or single file) and include (glob filter); keep patterns narrow (max 3 alternatives) and max_results small. Over budget: definition lines (struct/fn/impl/…) come FIRST, the rest spreads fairly across files, and every unseen matching file is listed with its hit count — read a named file instead of re-grepping. A miss auto-tries spelling variants (snake/camel/Pascal), labeled. Context: 1 line per hit (pass `context` 0-5 only when surroundings matter); matching is case-SENSITIVE unless ignore_case=true.",
            json!({
                "pattern": {"type": "string"},
                "patterns": {"type": "array", "items": {"type": "string"}},
                "path": {"type": "string"},
                "include": {"type": "string"},
                "max_results": {"type": "integer"},
                "context": {"type": "integer", "description": "Lines of context around each hit (0-5, default 1)"},
                "ignore_case": {"type": "boolean", "description": "Case-insensitive match (default false)"}
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
            "batch",
            "Run SEVERAL tool calls IN ORDER in this ONE call — a whole research step in one round-trip: ops=[{\"tool\": \"grep\", \"args\": {...}}, {\"tool\": \"read\", ...}] (max 10). Batchable: read, grep, glob, find_symbol, the lsp_* lookups, current_time, system_stats. Every result comes back COMPLETE, labeled per op. Plan the WHOLE search phase here — every lookup you expect to need in one round; a wave that needs a result you do not have yet waits for your next round.",
            json!({
                "ops": {
                    "type": "array",
                    "description": "The lookups of this step, IN ORDER. Each entry: {tool, args} with args = that tool's normal arguments.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string"},
                            "args": {"type": "object"}
                        },
                        "required": ["tool"]
                    }
                }
            }),
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
            "web_search",
            "Search the web and fetch the real page content of the top results before answering. Use it for facts, docs and current information. The result count is fixed by the user's \"Results per search\" setting (Settings → Web Providers) — do NOT try to request more or fewer results; if the user wants a different count, tell them where to change it. For several searches, fire every web_search call in the SAME turn (parallel tool calls). Only use fetch_url afterwards for one specific URL that was not among the top results.",
            json!({
                "query": {"type": "string", "description": "The search query"}
            }),
        ),
        (
            "fetch_url",
            "Fetch ONE web page or raw file and return its text (Markdown). The full page comes back, capped at 100000 chars; pass full=true for source files (SKILL.md, docs, raw.githubusercontent / jsdelivr / gist URLs), or offset=N to page past an earlier excerpt. Run web_search first to find the right URL, then fetch only the URLs you need.",
            json!({
                "url": {"type": "string", "description": "The URL to fetch (must start with http:// or https://)"},
                "full": {"type": "boolean", "description": "Lift the 100000-char cap (use for source/document files)"},
                "offset": {"type": "integer", "description": "Character offset to start from, when paging through a long page"}
            }),
        ),
    ];
    lsp_position_schemas()
        .into_iter()
        .chain(schemas.iter().map(|(name, desc, props)| (*name, *desc, props.clone())))
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
