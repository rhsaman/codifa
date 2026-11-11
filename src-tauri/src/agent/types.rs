use super::*;

/// Sub-agent depth limit (mirrors graph.py: sub-agents cannot spawn more).
pub(super) const MAX_SUBAGENT_DEPTH: usize = 1;

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
    /// Upper-level persona a workspace runs in: `chat` (general-purpose agent)
    /// or `code` (software-engineering agent). Absent from an older client, and
    /// an unknown value, both mean `chat` — the general-purpose default.
    #[serde(default = "default_run_mode")]
    pub run_mode: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<Value>,
    #[serde(default)]
    pub system_prompt: String,
    /// Extra instruction APPENDED to the assembled system prompt for this turn
    /// only. Live voice uses it to shape an answer for the ear (one language,
    /// plain prose, numbers as words) without touching the chat's own custom
    /// prompt: `system_prompt` REPLACES the builtin prompt, so a per-turn
    /// instruction cannot ride on it without destroying what the user set.
    #[serde(default)]
    pub system_suffix: String,
    /// Skill names the user attached to this turn (@mention). Their full
    /// bodies are inlined into the system prompt, exactly like the Python
    /// sidecar's ATTACHED SKILLS section.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Plugin slugs the user attached to this turn (the `/slug` composer
    /// command or the open plugin-use session). A plugin is ONE unit: its
    /// skills are inlined and its connectors are activated together, and the
    /// model must not load any of them again.
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub context_window: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub chat_id: String,
    #[serde(default)]
    pub mcp_servers: Value,
    /// Connectors the model already asked for through `use_mcp` in this chat.
    ///
    /// Their schemas are NOT inlined until the connector is named here, which is
    /// what keeps a switched-on-but-unused connector at one prompt line instead
    /// of its whole catalogue (measured: 391 schemas / ~59K tokens for a single
    /// enabled Proxmox connector the turn never touched). The renderer persists
    /// this per chat and echoes it back, so a connector loaded once stays loaded
    /// for the rest of the conversation without asking again.
    #[serde(default)]
    pub mcp_active: Vec<String>,
    /// Per-slot sub-agent model overrides from the UI's Tool Models settings
    /// (e.g. {"explore": "providerId/model"}); empty = the parent model.
    #[serde(default)]
    pub subagent_models: std::collections::HashMap<String, String>,
    /// User-created sub-agent profiles from settings (`customSubagents`). Same
    /// role as a plugin profile — prompt, optional tool narrowing, `kind` — but
    /// stored in settings.json instead of a bundle. Carried on every request so
    /// `delegation_schemas` can advertise them and `run_subagent` can resolve
    /// one by id when the model delegates to it.
    #[serde(default)]
    pub custom_subagents: Vec<Value>,
    /// Tool-set kind of THIS turn when it is a sub-agent turn: `research`
    /// (default), `browser` or `computer`. `run_subagent` sets it on the CHILD
    /// request; `turn.rs` reads it to bind the matching tool set.
    #[serde(default)]
    pub subagent_kind: Option<String>,
    /// Full provider configs keyed by id, so a "providerId/model" sub-agent
    /// entry routes to THAT provider's base URL / keys (cross-provider).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, Value>,
    /// The app data root (~/.codifa) where the skill store lives. Skills are
    /// NOT workspace files: `/skills` reads them from the data root, so the
    /// router must look there too — reading the workspace root found nothing
    /// and silently shipped an empty catalog.
    #[serde(default)]
    pub data_root: String,
    /// The composer's Computer Use switch. When false the `computer` tool is
    /// never bound, so the agent cannot touch the desktop at all.
    #[serde(default)]
    pub allow_computer: bool,
    /// Per-chat desktop grant — the "Always in this chat" answer on a desktop
    /// card, kept on the chat by the renderer and re-sent every turn. The
    /// renderer also ORs this into `allow_computer` so the tool binds; THIS
    /// field is what skips the per-task popup gate for the rest of the
    /// conversation. The composer switch alone never sets it, so a switch
    /// turned on in Settings still asks per task as before.
    #[serde(default)]
    pub allow_computer_chat: bool,
    /// True when the turn asks to create or edit a PLUGIN (`/plugin create` /
    /// `/plugin update`). The authoring actions of the `plugin` tool are bound
    /// only then, so an ordinary turn cannot silently rewrite the user's
    /// bundles. Skills and connectors are authored INSIDE a plugin — there is
    /// no separate skill/connector tool.
    #[serde(default)]
    pub allow_create: bool,
    /// The composer's Browser switch, the same hard on/off as Computer Use.
    /// When false the native `browser_*` tools are never bound and a call that
    /// still reaches the driver is refused BEFORE a Chromium is launched, so a
    /// chat can no longer open a browser window on its own. The Browser panel
    /// keeps working either way: this gates the agent's tools, not the user's
    /// own browsing.
    #[serde(default)]
    pub allow_browser: bool,
    /// The renderer's session-scoped "allow outside-workspace" grant
    /// (`store.outsideAllowed`). Sent on every message since the Python era but
    /// never read by the native loop, so a grant the user made in the popup
    /// could not reach `resolve_safe` and every out-of-tree path answered
    /// "path escapes project root" — after the round was already paid for.
    #[serde(default)]
    pub allow_outside: bool,
    /// Folders individually approved with "Always allow" (`store.outsideFolders`,
    /// the nearest existing parent of what was asked). Only these subtrees open
    /// up; the flag above opens the whole space.
    #[serde(default)]
    pub allow_outside_folders: Vec<String>,
    /// Per-chat blanket grant for the model's own `confirm_action` /
    /// `request_permission` asks: once the user clicked "Always in this chat"
    /// on such a card, later asks in the SAME conversation are approved
    /// without a popup. The renderer keeps the grant on the chat and re-sends
    /// it every turn; scheduled runs never send it, so a headless turn still
    /// auto-denies through the `headless` check that runs FIRST.
    #[serde(default)]
    pub allow_confirm_chat: bool,
    /// SSH destinations granted "Always in this chat". The `run_terminal` gate
    /// skips them alongside the turn-local answers and the persisted
    /// `trusted-hosts.json` hosts — this grant lives on the chat, not on disk,
    /// so a fresh chat asks again.
    #[serde(default)]
    pub allow_ssh_hosts: Vec<String>,
    /// Web-search engines from Settings → Plugins, verbatim and in priority
    /// order: `order` 0 is the primary and higher orders are fallbacks tried in
    /// turn, so the user's list order IS the fallback chain.
    #[serde(default)]
    pub search_plugins: Vec<Value>,
    /// Image-generation slot (Settings → Media Providers): provider id into
    /// `providers` + default model + ordered fallbacks. Empty id = the
    /// `generate_image` / `edit_image` tools answer "not configured".
    #[serde(default)]
    pub image_provider_id: String,
    #[serde(default)]
    pub image_model: String,
    #[serde(default)]
    pub image_fallbacks: Vec<Value>,
    /// Video-generation slot, same shape as the image slot. Empty id =
    /// `generate_video` answers "not configured" (local ffmpeg edits still run).
    #[serde(default)]
    pub video_provider_id: String,
    #[serde(default)]
    pub video_model: String,
    #[serde(default)]
    pub video_fallbacks: Vec<Value>,
    /// Auto-compaction threshold as a percentage of the RAW context window —
    /// the renderer has always sent this (the Python graph consumed it), and
    /// the native loop now honours it MID-TURN: once a turn's wire history
    /// outgrows `context_window * compact_at_percent / 100`, the older half is
    /// folded into a running summary instead of waiting for the next turn.
    #[serde(default = "default_compact_percent")]
    pub compact_at_percent: u64,
    /// Per-slot sub-agent models, used to route the summarizer through the
    /// user's "compact" Tool Models entry (empty = the active model).
    #[serde(default)]
    pub fallback_provider: String,
    #[serde(default)]
    pub fallback_model: String,
    #[serde(default)]
    pub fallback_base_url: String,
    #[serde(default)]
    pub fallback_api_key: String,
    #[serde(default)]
    pub fallback_api_keys: Vec<String>,
    /// Reasoning-effort level for the MAIN model of this turn (the one chosen
    /// in the composer): "none" / "low" / "medium" / "high" / "xhigh" /
    /// "max". Empty = the provider default (no reasoning parameter sent).
    #[serde(default)]
    pub thinking_level: String,
    /// Whether the main model is known to be reasoning-capable (the provider's
    /// `/models` reasoning flag, or the user's manual override). Gates the
    /// reasoning parameter for local/custom providers without `auto_think`.
    #[serde(default)]
    pub model_reasoning: bool,
    /// Per-tool reasoning-effort overrides, keyed by the SAME slot names as
    /// `subagent_models` (compact / explore / web / vision / schedule /
    /// title). A missing key means "inherit the main model's level".
    #[serde(default)]
    pub subagent_thinking: std::collections::HashMap<String, String>,
    /// Per-tool FALLBACK models from Settings → Tools, keyed by the same slot
    /// names as `subagent_models`: each value is an ordered list of
    /// "providerId/model" entries tried top-to-bottom while THAT tool's own
    /// model fails. Purely per-call — nothing is remembered between calls, so
    /// every new call starts at the tool's own model again — and a fallback
    /// inherits the calling tool's reasoning level rather than carrying one.
    #[serde(default)]
    pub tool_fallbacks: std::collections::HashMap<String, Vec<String>>,
    /// Inline images attached to THIS turn, as `data:<mime>;base64,…` URLs (or
    /// bare paths, which are read from disk). Owned by the user message: they
    /// are sent to the main model and to the vision model, never echoed back
    /// as history.
    #[serde(default, deserialize_with = "deserialize_images")]
    pub images: Vec<String>,
    /// Composer FILE attachments for THIS turn, as absolute paths or paths
    /// relative to the workspace root. They ride into the first user message as
    /// a short `Attached files:` text block (the same shape a mid-turn steer
    /// uses), so the model knows the files exist and opens them with the normal
    /// file tools. Empty for turns without attachments.
    #[serde(default)]
    pub attachments: Vec<String>,
    /// Tools a sub-agent PROFILE declared (a plugin `agents/*.md` row or a
    /// Settings → Sub-agents row). Empty = the default set for the profile's
    /// `kind`; non-empty = the exact tools it may call. Names are canonicalized
    /// through [`canonical_subagent_tool`], so a Claude Code pack's `Bash` /
    /// `Edit` / `Write` reach Codifa's `run_terminal` / `edit_file` /
    /// `write_file` instead of being dropped.
    #[serde(default)]
    pub subagent_tools: Vec<String>,
    /// True when this sub-turn runs a user or plugin PROFILE rather than the
    /// builtin `explore`. A profile may reach the full sub-agent universe
    /// ([`subagent_schemas`]) when it declares tools; `explore` keeps the
    /// classic read-only research set. The distinction lives in the request
    /// because both arrive with `mode: "subagent"`.
    #[serde(default)]
    pub subagent_profile: bool,
    /// Who this sub-agent IS — its name, description and the head of its
    /// prompt. Only used to pick WHICH of an attached bundle's skills belong to
    /// it: a pack can ship dozens (the trading bundle has 82 skills / ~820 KB),
    /// and inlining all of them would flood the child before its first tool
    /// call. The rest are listed with their file path so the agent can `read`
    /// the one it needs. Empty for the builtin `explore`.
    #[serde(default)]
    pub subagent_focus: String,
    /// The user's "Results per search" number (Settings → Web Providers). It is
    /// ONE setting with two effects: how many results `web_search` returns, and
    /// how many of those top results get their REAL page content fetched (not
    /// just a snippet) before the distiller reads them. 0 disables the page
    /// fetch and falls back to snippets-only results.
    #[serde(default = "default_web_search_auto_fetch")]
    pub web_search_auto_fetch: usize,
    /// What the tools may do this turn. `None` means "derive it from `mode`"
    /// (`caps_for_mode`) — the renderer sends the real object, the scheduler and
    /// any headless caller omit it and get the mode's table row instead.
    #[serde(default)]
    pub cap: Option<ToolCaps>,
    /// True when the caller is headless (the scheduler): there is no SSE client
    /// to receive the `Error`/`Done` event protocol, so a mid-turn provider
    /// error must come back as `Err` — the caller records the run and walks its
    /// own fallback chain. With the interactive protocol's swallow-as-Ok this
    /// caller saw a "successful" turn whose text was just the narration so far.
    #[serde(default)]
    pub headless: bool,
}

pub(super) fn default_mode() -> String {
    "build".to_string()
}

/// Default for `run_mode`: the general-purpose persona, so a request that never
/// mentions it (the scheduler, a sub-agent, an older UI build) is not silently
/// forced into the engineering persona.
pub(super) fn default_run_mode() -> String {
    "chat".to_string()
}

/// Default for `webSearchAutoFetch` (Settings → Web Providers) when the field
/// is absent: the same five results the UI's setting starts at.
pub(super) fn default_web_search_auto_fetch() -> usize {
    crate::websearch::WEB_SEARCH_AUTO_FETCH_DEFAULT
}

/// What the tools may do in a turn. The renderer sends this as `cap` (mirroring
/// `ModeCapabilities` in `src/lib/modes.ts`); callers that omit it get the
/// mode's row from `caps_for_mode`.
///
/// This is a HARD gate, not a hint: a forbidden tool is dropped from the schema
/// list the model sees, and a call that still arrives is refused in the tool
/// loop. Prompt text alone was never enough — an Ask turn whose prompt says
/// "you are read-only" still called `write_file` and it landed on disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolCaps {
    /// Listing / searching / reading the workspace.
    pub read_files: bool,
    /// `write_file` and `edit_file`.
    pub write_files: bool,
    /// `run_terminal`.
    pub run_terminal: bool,
    /// `web_search` and `fetch_url`.
    pub web: bool,
}

impl Default for ToolCaps {
    /// Permissive: a caller that sends nothing keeps the pre-gating behaviour,
    /// so an unknown/legacy client never loses tools because of a missing field.
    fn default() -> Self {
        Self {
            read_files: true,
            write_files: true,
            run_terminal: true,
            web: true,
        }
    }
}

/// Capabilities of the built-in modes. An id this build does not know stays
/// permissive — a missing table row must not silently disarm a mode.
pub fn caps_for_mode(mode: &str) -> ToolCaps {
    match mode {
        // Ask: reads the code, the web AND the shell, never touches the
        // workspace. The terminal stays bound because inspecting is reading —
        // `du -sh`, `df -h`, `ps`, `git status` are exactly what a read-only
        // turn needs, and the in-loop gate refuses every command that would
        // write while `write_files` is false.
        "ask" | "chat" => ToolCaps {
            write_files: false,
            run_terminal: true,
            ..ToolCaps::default()
        },
        // Plan: may inspect with the terminal, still never writes.
        "plan" => ToolCaps {
            write_files: false,
            ..ToolCaps::default()
        },
        // Sub-agents run with the PARENT's table (`run_subagent` passes it
        // explicitly). This row only applies to a caller that names `subagent`
        // as its mode with no cap at all; build/unknown ids keep the full set.
        _ => ToolCaps::default(),
    }
}

/// The refusal text when this turn's capabilities forbid ONE op inside a
/// `batch`, else `None`.
///
/// A batch is not a privileged context: every verdict the TOP-LEVEL call
/// boundary makes must hold for an op too, or the batch becomes a shelter the
/// model learns to hide in. Traced (`mwbmxr0r`): 285 terminal ops inside
/// batches, 224 of them really RAN, against 143 native read/grep/glob/lsp ops —
/// the terminal outran the very tools it was supposed to delegate to, because
/// `ls`/`grep -rn`/`sed -n` were refused one level up and ran one level down.
///
/// `mode`/`can_search`/`can_read` describe the caller: a `subagent` child
/// narrowed to `read` has no `grep` to switch to, so a delegation gate stands
/// down for it exactly like it does at the top level. A child that DOES
/// advertise the native alternative has no excuse, so the gate bites there too.
pub(super) fn batch_op_refusal(
    caps: &ToolCaps,
    name: &str,
    args: &Value,
    mode: &str,
    root: &str,
    can_search: bool,
    can_read: bool,
) -> Option<String> {
    match name {
        "write_file" | "edit_file" if !caps.write_files => Some(
            "this turn is read-only — writing or editing files needs Build mode".to_string(),
        ),
        "run_terminal" if !caps.run_terminal => Some(
            "this turn cannot run commands — running them needs a mode with terminal access"
                .to_string(),
        ),
        "run_terminal" => {
            let cmd = args["command"].as_str().unwrap_or_default();
            if !caps.write_files && is_mutating_command(cmd) {
                return Some(
                    "this turn is read-only — a command that would change the workspace needs Build mode"
                        .to_string(),
                );
            }
            if (mode != "subagent" || can_search) && is_file_search_command(cmd, root) {
                return Some(
                    "the terminal does not locate files. Use `grep` (one token, with path= and include=), `glob` (file names), or `find_symbol` (a symbol's definition AND every usage in ONE call) as another op of this batch."
                        .to_string(),
                );
            }
            if (mode != "subagent" || can_read) && workspace_file_read(cmd, root) {
                return Some(
                    "the terminal does not read workspace files. Use `read` with ranges=[{path,offset,limit}] as another op of this batch — it takes SEVERAL files and windows in ONE call."
                        .to_string(),
                );
            }
            None
        }
        _ => None,
    }
}

/// The refusal text when this turn's capabilities forbid `name`, else `None`.
/// Phrased like the other in-loop refusals: one plain sentence the model can act
/// on, no "Error:" prefix (the card already renders failure from `ok`).
pub(super) fn denied_by_caps(caps: &ToolCaps, name: &str) -> Option<String> {
    let (allowed, action) = match name {
        "write_file" | "edit_file" => (caps.write_files, "write or edit files"),
        // Media tools create NEW files only (the result paths are minted
        // unique under media/ — an existing file is never overwritten), so
        // they stay available in the read-only Ask/Plan modes exactly like
        // web_search does: a user who asks "make me a picture" in Ask mode
        // expects the picture, not a lecture. The read-only protection for
        // these is the dispatch arm IGNOREing the `output` argument when
        // `write_files` is off, so no call can aim a write at a project file.
        "generate_image" | "edit_image" | "generate_video" | "edit_video" => (true, ""),
        "run_terminal" => (caps.run_terminal, "run commands"),
        // The memory tools are a read of the project's own notes (and the
        // matching write to the same store), so they ride the read capability
        // like the locator tools: a turn that may not read the workspace must
        // not reach the saved notes either.
        "search_memory" | "save_memory" | "delete_memory" => {
            (caps.read_files, "read or write project memory")
        }
        // Read/search follows the mode's own read capability, not `web`: a mode
        // that may not read the workspace must not reach it through `grep`.
        // The locator tools read the workspace as well (`find_symbol` answers
        // with file bodies), so they ride the same capability.
        "read" | "grep" | "glob" | "find_symbol" | "lsp_symbols" | "lsp_definition"
        | "lsp_references" | "lsp_hover" | "lsp_diagnostics" => {
            (caps.read_files, "read or search the workspace")
        }
        // The batch executor rides the READ capability at the NAME level (its
        // write/terminal ops are gated per-op in the loop, the only place the
        // caps are known): a turn that cannot read the workspace cannot batch
        // its lookups either.
        "batch_search" => (caps.read_files, "read or search the workspace"),
        "web_search" | "fetch_url" => (caps.web, "search or fetch the web"),
        _ => return None,
    };
    if allowed {
        return None;
    }
    Some(format!(
        "blocked: this turn is read-only — `{name}` is not available in this mode, so it \
cannot {action}. Answer with the concrete change instead: which file, which line, and the \
exact old text → new text. Tell the user to switch to Build mode if they want it applied. \
(Do NOT re-call it in this turn — a repeat burns a round and gets the same refusal.)"
    ))
}

/// The `plugin` actions that WRITE the bundle store.
///
/// `list` and `run` are not authoring: naming what a bundle ships and running a
/// script already on disk are acts of the same kind as `run_terminal`, which
/// Build and Ask already allow — while a scheduled Build run has nobody to ask
/// and still has to be able to fire a bundle's script.
///
/// These actions stay behind `allow_create` ("the user asked for a bundle this
/// turn"), which is a REQUEST gate, not a MODE gate: see `plugin_mode_refusal`
/// for why the mode no longer refuses them.
pub(super) fn plugin_action_needs_authoring(action: &str) -> bool {
    matches!(action, "install" | "create" | "update" | "toggle" | "delete")
}

/// The mode half of the `plugin` gate: why this turn refuses an action.
///
/// `run` follows the terminal capability alone: a bundle's script IS dispatched
/// exactly like a `run_terminal` line, so a mode that may run commands — Ask
/// included — may run it, and Ask's own mutating-command gate still covers what
/// the script does to the disk. Gating `run` on `write_files` as well was the
/// MT5 bug: Ask refused every plugin script only because it forbids edits,
/// while plain shell commands were fine.
///
/// The AUTHORING actions are NOT refused here either. They write the plugin
/// bundle under `~/.codifa/plugins/`, which is not the workspace, so
/// `write_files` — "may touch the project" — has nothing to say about them.
/// Gating them on it was the same bug class as the `schedule` one ("[Schedule:
/// update …]" answered with a read-only refusal): the user asks in plain words
/// and a read-only chat silently refuses. The REQUEST gate on top of this one
/// (`req.allow_create` in `turn.rs`, "the user asked for a bundle this turn")
/// keeps an unasked-for write out; a mode cannot substitute for it, and
/// requiring both meant an explicit user request never worked.
pub(super) fn plugin_mode_refusal(action: &str, caps: &ToolCaps) -> Option<String> {
    if action == "run" && !caps.run_terminal {
        Some(
            "blocked: this turn cannot run commands — running a plugin script is the same \
act as a terminal command, which this mode does not allow. Switch to Build mode to run it."
                .into(),
        )
    } else {
        None
    }
}

/// Whether a `schedule` action is REFUSED in an unattended run, else `None`.
///
/// Schedule actions are NEVER refused for being writes: a scheduled task lives in
/// `~/.codifa/schedules/`, not in the workspace, so `write_files` — "may touch the
/// project" — has nothing to say about it. Gating them on it was the
/// "[Schedule: update …]" bug: the user typed the command and Ask answered with a
/// read-only refusal, so create/update/toggle/delete silently did nothing unless
/// the chat happened to be in Build mode. Every action (list, create, update,
/// toggle, delete) is therefore allowed in every user-invoked mode; only a
/// `headless` run is told otherwise, because a scheduled run has nobody to approve
/// a change to that store and must not author or destroy a schedule on its own.
pub(super) fn schedule_mode_refusal(action: &str, headless: bool) -> Option<String> {
    if action == "list" || !headless {
        return None;
    }
    Some(
        format!(
            "blocked: this run is unattended — `schedule action={action}` changes the schedule \
store, and a scheduled run has nobody to approve that. Only action=list is allowed here."
        ),
    )
}

/// Codifa's canonical name for a tool a sub-agent PROFILE declared.
///
/// Profiles arrive in the Claude Code bundle format, so a pack's `tools:` list
/// uses that vocabulary (`Read`, `Grep`, `Glob`, `Bash`, `WebSearch`,
/// `WebFetch`, …) while Codifa's schemas are lowercase and sometimes spelled
/// differently (`web_search`, `fetch_url`, `run_terminal`). Case alone already
/// worked; this table covers the names that do NOT merely differ by case.
///
/// A name with no Codifa equivalent is returned lowercased/underscored, so it
/// simply matches no schema and is dropped by [`retain_subagent_tools`] — a
/// profile can never invent a tool.
pub(super) fn canonical_subagent_tool(name: &str) -> String {
    let key = name.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    let canonical = match key.as_str() {
        "read" | "read_file" | "readfile" | "view" | "cat" => "read",
        "grep" | "grep_search" | "ripgrep" | "rg" => "grep",
        // Claude Code's LS is the file lister; Codifa's discovery tool is glob.
        "glob" | "ls" | "list_files" | "list_dir" | "list_directory" => "glob",
        "find_symbol" => "find_symbol",
        "bash" | "shell" | "terminal" | "run_shell_command" => "run_terminal",
        "websearch" | "web_search" | "search_web" => "web_search",
        "webfetch" | "web_fetch" | "fetch" | "fetch_page" | "fetch_webpage" => "fetch_url",
        "task" => "explore",
        "write" | "write_file" | "create_file" => "write_file",
        "edit" | "edit_file" | "multiedit" | "multi_edit" | "str_replace" | "apply_patch" => {
            "edit_file"
        }
        "todowrite" | "todo_write" | "update_todos" => "update_plan",
        other => other,
    };
    canonical.to_string()
}

/// Narrow a sub-agent's tool set to the profile's declared tools.
///
/// `declared` is empty when the profile said nothing → the default set for its
/// kind, which is also what the builtin `explore` runs with. Names are
/// canonicalized first ([`canonical_subagent_tool`]), so a Claude Code pack's
/// `WebSearch` reaches Codifa's `web_search` instead of being silently dropped.
///
/// The filter only ever REMOVES work tools from the table it is given; the
/// caller decides how wide that table starts. A profile with declared tools
/// starts from the full sub-agent universe ([`subagent_schemas`]), which is what
/// lets a pack's `Bash`/`Edit`/`Write` actually reach
/// `run_terminal`/`edit_file`/`write_file` instead of being dropped on the
/// floor. Parent capabilities still gate the result afterwards, so an Ask/Plan
/// turn cannot become writable this way.
///
/// `load_plugin` is the ONE tool a declaration cannot remove: plugin access is
/// not a per-agent setting, so even the narrowest sub-agent can load any
/// installed toolbox on its own.
///
/// Returns `false` when a NON-EMPTY declaration matched nothing this table can
/// actually run (an unknown name, or `Task`/`TodoWrite`, which stay with the
/// parent). The caller then keeps the kind's default set: leaving a sub-agent
/// with zero tools is useless, and silently granting it the whole universe
/// would reward a malformed list with more reach than it asked for.
pub(super) fn retain_subagent_tools(schemas: &mut Vec<Value>, declared: &[String]) -> bool {
    if declared.is_empty() {
        return true;
    }
    let wanted: Vec<String> = declared.iter().map(|d| canonical_subagent_tool(d)).collect();
    let mut kept: Vec<Value> = schemas
        .iter()
        .filter(|s| {
            s["function"]["name"].as_str().is_some_and(|n| {
                wanted.iter().any(|d| d.eq_ignore_ascii_case(n))
            })
        })
        .cloned()
        .collect();
    if kept.is_empty() {
        return false;
    }
    // Plugin access is NOT a per-agent setting. A declaration narrows the work
    // tools, but `load_plugin` stays: every sub-agent must be able to use any
    // installed toolbox on its own (Settings → Sub-agents assigns none), and a
    // pack that lists `Read`/`Bash` was never saying "no plugins".
    if !kept
        .iter()
        .any(|s| s["function"]["name"].as_str() == Some("load_plugin"))
    {
        if let Some(schema) = schemas
            .iter()
            .find(|s| s["function"]["name"].as_str() == Some("load_plugin"))
            .cloned()
        {
            kept.push(schema);
        }
    }
    // `batch` is the ROUND COMPOSER, not a capability: it runs nothing on its
    // own and every op it carries is re-checked against the turn's caps gate, so
    // keeping it cannot widen a child's reach by one tool. Dropping it did real
    // damage: a declared profile ("Read, Grep, Bash") silently lost the only
    // way to issue those three in ONE round, so the child spent three rounds on
    // work the main agent does in one — and the batching levers, reading the
    // real binding, then had nothing to offer it.
    if !kept
        .iter()
        .any(|s| s["function"]["name"].as_str() == Some(crate::tools::BATCH_TOOL))
    {
        if let Some(schema) = schemas
            .iter()
            .find(|s| s["function"]["name"].as_str() == Some(crate::tools::BATCH_TOOL))
            .cloned()
        {
            kept.push(schema);
        }
    }
    *schemas = kept;
    true
}

/// Mode gating, part one: drop every tool this turn may not use. The model
/// cannot pick a tool it cannot see, so withholding the schema is the primary
/// gate; `denied_by_caps` in the loop is the backstop for a stale transcript or
/// a hallucinated (or connector-supplied) name.
pub(super) fn retain_allowed_tools(schemas: &mut Vec<Value>, caps: &ToolCaps, mode: &str) {
    schemas.retain(|s| {
        let Some(n) = s["function"]["name"].as_str() else {
            return true;
        };
        if denied_by_caps(caps, n).is_some() {
            return false;
        }
        // `glob` is pure DISCOVERY: the main agent may read files its step
        // already named and grep one known token, but finding out WHICH files
        // exist stays with the sub-agent, whose report is what the main agent
        // works from (67% of all tool calls are raw search, all of it in
        // explore). A sub-agent keeps the full set.
        !(n == "glob" && mode != "subagent")
    })
}

/// Accept the renderer's loose image payload and normalise it to data URLs.
///
/// The frontend sends each entry either as a bare path, as a `data:` URL, or as
/// `{path, dataUrl}` (the shape the picker and screenshot code produce). The
/// model needs bytes, not paths, so a path is read from disk here — and an
/// unreadable one is dropped rather than failing the whole turn.
pub(super) fn deserialize_images<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(resolve_image_entries(
        Vec::<Value>::deserialize(d).unwrap_or_default(),
    ))
}

/// Turn the renderer's loose image entries into data URLs: a bare path, an
/// inline `data:` URL, or `{path, dataUrl}` (the picker/screenshot shape, where
/// the inline copy wins so the backend never depends on a temp file still being
/// on disk). An unreadable path is DROPPED — one missing file must not fail the
/// whole turn. Shared by the current turn's request field and by the history
/// entries, which arrive in exactly the same shape.
pub(super) fn resolve_image_entries(raw: Vec<Value>) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw {
        let (path, inline) = match &item {
            Value::String(s) => (Some(s.clone()), None),
            Value::Object(o) => (
                o.get("path").and_then(Value::as_str).map(str::to_string),
                o.get("dataUrl").and_then(Value::as_str).map(str::to_string),
            ),
            _ => (None, None),
        };
        if let Some(url) = inline.filter(|u| u.starts_with("data:")) {
            out.push(url);
            continue;
        }
        if let Some(url) = path.clone().filter(|p| p.starts_with("data:")) {
            out.push(url);
            continue;
        }
        if let Some(p) = path {
            if let Some(url) = crate::commands::image_data_url(&p) {
                out.push(url);
            }
        }
    }
    out
}

/// Matches the UI's own default (Settings → compact threshold).
pub(super) fn default_compact_percent() -> u64 {
    80
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
    pub(super) fn subagent_snapshot(&self) -> Self {
        Self {
            provider: self.provider.clone(),
            provider_id: self.provider_id.clone(),
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            api_keys: self.api_keys.clone(),
            root: self.root.clone(),
            mode: self.mode.clone(),
            run_mode: self.run_mode.clone(),
            prompt: self.prompt.clone(),
            // Never inherited — see the doc comment above.
            history: Vec::new(),
            system_prompt: self.system_prompt.clone(),
            // Live-voice reply shaping belongs to the turn the user HEARS.
            // A sub-agent's output is folded into the parent's answer, so
            // inheriting the rule would only distort its research output.
            system_suffix: String::new(),
            skills: self.skills.clone(),
            plugins: self.plugins.clone(),
            context_window: self.context_window,
            chat_id: self.chat_id.clone(),
            mcp_servers: self.mcp_servers.clone(),
            mcp_active: self.mcp_active.clone(),
            subagent_models: self.subagent_models.clone(),
            providers: self.providers.clone(),
            data_root: self.data_root.clone(),
            allow_computer: self.allow_computer,
            allow_create: self.allow_create,
            allow_browser: self.allow_browser,
            custom_subagents: self.custom_subagents.clone(),
            subagent_kind: self.subagent_kind.clone(),
            // A read grant is inherited: the user widened THIS TURN's reach, and
            // a sub-agent the turn delegates to searches the same disk.
            allow_outside: self.allow_outside,
            allow_outside_folders: self.allow_outside_folders.clone(),
            // "Always in this chat" grants: the desktop grant rides along like
            // `allow_computer` above (the child already skips the popup by
            // MODE, this keeps the snapshot faithful); the model-confirmation
            // grant stays parent-only (a child cannot call `confirm_action`),
            // and no SSH host grant is inherited — a child never reaches the
            // SSH gate.
            allow_computer_chat: self.allow_computer_chat,
            allow_confirm_chat: false,
            allow_ssh_hosts: Vec::new(),
            search_plugins: self.search_plugins.clone(),
            // Media slots ride along: an explore that generates a preview image
            // uses the same configured provider the parent would have.
            image_provider_id: self.image_provider_id.clone(),
            image_model: self.image_model.clone(),
            image_fallbacks: self.image_fallbacks.clone(),
            video_provider_id: self.video_provider_id.clone(),
            video_model: self.video_model.clone(),
            video_fallbacks: self.video_fallbacks.clone(),
            // Sub-agents never auto-compact mid-turn (they have their own
            // budget), but the snapshot stays a faithful copy of the turn.
            compact_at_percent: self.compact_at_percent,
            fallback_provider: self.fallback_provider.clone(),
            fallback_model: self.fallback_model.clone(),
            fallback_base_url: self.fallback_base_url.clone(),
            fallback_api_key: self.fallback_api_key.clone(),
            fallback_api_keys: self.fallback_api_keys.clone(),
            // Reasoning settings flow through to a sub-agent unchanged (its
            // own slot level is applied in `run_subagent`, which overrides the
            // level per explore/compact slot).
            thinking_level: self.thinking_level.clone(),
            model_reasoning: self.model_reasoning,
            subagent_thinking: self.subagent_thinking.clone(),
            tool_fallbacks: self.tool_fallbacks.clone(),
            // A research sub-agent is text-only: images stay with the parent.
            images: Vec::new(),
            // Composer attachments belong to the parent's user message; the
            // child receives only the prompt that already names them.
            attachments: Vec::new(),
            // A sub-agent's own tool narrowing is decided by the profile it runs
            // under, never inherited from the parent turn.
            subagent_tools: Vec::new(),
            // The snapshot is a PARENT, not a profile: `run_subagent` sets these
            // when it builds the child request.
            subagent_profile: false,
            subagent_focus: String::new(),
            // A research sub-agent searches the web the same way the parent does.
            web_search_auto_fetch: self.web_search_auto_fetch,
            // A research sub-agent has no mutating tool at all, so it runs with
            // the parent's capabilities unchanged.
            cap: self.cap.clone(),
            // A headless parent (the scheduler) keeps a headless sub-agent: a
            // mid-turn stream error must surface to the ladder as Err there too.
            headless: self.headless,
        }
    }
}

/// App data root for the native agent.
///
/// Order matters: the LIVE data root (Settings → Data path) wins, because the
/// HTTP readers (`/plan`, `/plan/checklist`, traces, memory) resolve through
/// `state::current_data_root()`. Reading only the env var + `~/.codifa` made
/// the agent write plans into a DIFFERENT root than the reader looked at as
/// soon as the user moved their data folder — the plan saved fine and was
/// still invisible.
pub(super) fn native_data_root() -> String {
    if let Some(root) = crate::state::current_data_root() {
        return root.to_string_lossy().into_owned();
    }
    if let Ok(d) = std::env::var("CODER_DATA_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".codifa").to_string_lossy().into_owned())
        .unwrap_or_else(|| ".codifa".into())
}

/// Extract the plan document from a plan-mode reply.
///
/// The save used to depend on the reply carrying a heading that STARTS with
/// `plan` (or `# پلن`). A model writing `## Implementation Plan`,
/// `## Phase 1`, `## طرح` or no heading at all produced NO save — silently,
/// because the caller drops the Result — which is why a plan sometimes landed
/// on disk and sometimes vanished. The heading is now only used for the TITLE;
/// the body is the whole reply (minus the preamble before the first heading
/// when one exists).
pub(super) fn extract_plan_body(text: &str) -> Option<(String, String)> {
    if text.trim().is_empty() {
        return None;
    }
    let mut start: Option<usize> = None;
    let mut title = String::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('#') {
            continue;
        }
        start = Some(idx);
        title = trimmed.trim_start_matches('#').trim().to_string();
        break;
    }
    // No heading at all: still a plan — keep the whole reply and name it from
    // its first non-empty line, so a save always happens in plan mode.
    let Some(s) = start else {
        let first = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("Plan")
            .trim_start_matches('#')
            .trim();
        let title: String = first.chars().take(120).collect();
        return Some((
            if title.is_empty() { "Plan".into() } else { title },
            text.trim().to_string(),
        ));
    };
    let body: String = text.lines().skip(s).collect::<Vec<_>>().join("\n");
    if body.trim().is_empty() {
        return None;
    }
    Some((
        if title.is_empty() {
            "Plan".into()
        } else {
            title
        },
        body,
    ))
}

/// The plan a plan-mode turn saved as a markdown ARTIFACT.
///
/// Plan mode is read-only, so a planner that wants a durable document can call
/// `artifact create` with the plan instead of writing `docs/PLAN.md`. That
/// content lives only in the tool call, never in the round's prose, so the
/// end-of-turn save used to keep the closing summary ("## خلاصه") as `plan.md`
/// and the Plan panel showed that summary instead of the real plan.
///
/// Only a document whose title or first heading names a plan qualifies — a
/// supporting artifact (design notes, a diagram, a report) must not replace the
/// plan with whichever document happened to be created last.
pub(super) fn plan_document_from_artifact(
    title: &str,
    content: &str,
) -> Option<(String, String)> {
    let (heading, body) = extract_plan_body(content)?;
    if !crate::plans::looks_like_plan_name(title)
        && !crate::plans::looks_like_plan_name(&heading)
    {
        return None;
    }
    let title = if title.trim().is_empty() {
        heading
    } else {
        title.trim().to_string()
    };
    Some((title, body))
}

