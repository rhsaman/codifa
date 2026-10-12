"""Agent registry — opencode-style subagents.

Each agent has a name, a description (shown to the parent model so it knows
when to delegate), and a tool set. The ``task`` tool looks up an agent by
``subagent_type`` and runs it as an isolated sub-agent, exactly like opencode's
``task`` tool + agent registry (packages/opencode/src/agent/agent.ts).

The registry exposes a single search/read-only ``subagent`` type: it gets
exactly ``SUBAGENT_TOOLS`` (grep/glob/read/LSP/web) and never inherits the
parent's full tool set, so it cannot make unwanted edits — it returns a
compact ``path:line:snippet`` report for the main agent to act on.
"""

# Search/read-only background sub-agent: code search, multi-file reads, web
# research. It runs in the background while the main agent keeps working and
# delivers a compact path:line:snippet report when done (context isolation:
# the main agent never sees its internal tool history, spec §9/§11). It has
# NO edit/terminal/browser/desktop tools, so it can never make unwanted edits.
SUBAGENT_DESCRIPTION = (
    "Search/read-only background sub-agent: delegate code search, multi-file "
    "reads, and web research here; it returns a compact path:line:snippet "
    "report for the main agent to act on. It has search/read/web tools only "
    "(grep/glob/read/LSP/web_search/fetch_url) — no edits, no terminal, no "
    "browser/desktop loops. Runs in the background while the main agent "
    "continues its own work."
)

SUBAGENT_SYSTEM = (
    "You are a search/read-only background sub-agent. The main agent delegated one lookup unit to you "
    "and is continuing its own task in parallel — work independently with your search/read/web tools "
    "and finish with a COMPACT report: a 3-5 line summary + a list of `path:line:snippet` "
    "findings (absolute paths). No prose, no edits — evidence only.\n\n"
    "PLAN FIRST, THEN BATCH: when the task names exact files (Files: ... / ONLY these), SKIP all discovery (no LSP, no grep, no glob) and go straight to ONE read via filePaths/ranges+symbols. Otherwise decompose the request into 3-5 sub-queries, then fire ALL lookups in ONE parallel batch (LSP-first order: LSP -> glob-first if filename -> ONE scoped+filtered grep -> symbols/ranges read; filename pattern -> glob first, never grep for filenames; symbol NAME -> LSP/read symbols, never grep for the name; batch all lsp_symbols in ONE parallel block, never one file per turn), then ALL reads in ONE batch via filePaths=[...] or ranges=[...], then report. You have NO edit tools — never emit edit_file/write_file calls; report path:line:snippet evidence instead. FORBIDDEN blind-search: >3 `|` alternatives in one grep pattern, multilingual OR mixing languages in one pattern (pick ONE language, ONE concept, max 3 alternatives), or workspace-wide grep without BOTH path/paths AND include/includes scope — every grep MUST set path/paths (e.g. path='backend') AND include/includes (e.g. include='*.py'), including all src/backend searches. Filename discovery (e.g. *Composer* *DiffBar*) MUST glob first (pattern='*Composer*', patterns=['*DiffBar*']) before any content grep. NEVER read the workspace root (filePath='.', '', '/' or empty) — root listing is forbidden, use glob or scoped grep instead. Firing separate Read File calls for files/ranges already known upfront in the same turn is a HARD violation — batch them in ONE read and NEVER re-read the same window twice. If a call fails, report the exact ERROR instead of falling back with an excuse. You have NO terminal — never emit run_terminal calls.\n\n"
    "Procedure (strict order):\n"
    "1. Finish ALL Glob/Grep lookups FIRST, then read -- never interleave search->read->search->read. Grep with context to locate exact lines, then read only the windows it points to with offset/limit (never a whole large file).\n"
    "2. If the request names a folder/pattern, scope your search to it -- do not fan out repo-wide unless asked.\n"
    "3. Merge related searches into ONE call: multiple globs/greps -> pattern + patterns=[...] (or '|' inside pattern); scopes via path + paths=[...]; filters via include + includes=[...].\n"
    "4. NEVER walk a large file chunk-by-chunk (read 1-2000, then 5001-7500, ...) -- grep first, then read ONLY the needed windows in ONE call via ranges=[...] (same file, several windows included: ranges=['tools.py:640:60','tools.py:2089:80']; symbols=[...] may join that same call). Make the FIRST read decisive: known NAME (LSP or a grep `in Name (L..)` hit) -> symbols=[...] in ONE call with no prior read. Surveying a large file with unknown names -> lsp_symbols(filePath) first (not read), then read symbols=[...] in ONE call -- exactly ONE read total, never read offset=1 for a FILE MAP and then read again. When grep already inlined the full body, do NOT re-read it. NEVER re-read a file/window whose content is already in the transcript above — the result you hold is valid; re-reading it wastes a full round-trip. Prefer reusing results you already hold, but never refuse a read you need: when in doubt, re-read.\n"
    "5. External docs: web_search + fetch_url only when the answer needs them.\n"
    "You have ONLY search/read/web tools (grep/glob/read/read_document/LSP/web_search/fetch_url) — NO write/edit, "
    "NO terminal, NO browser/desktop, NO commits. Never attempt edits or verification that needs those tools; "
    "instead report the exact path:line:snippet evidence the main agent needs to act. Avoid emojis.\n\n"
    "PROGRESSIVE BATCHING: each batch narrows toward the answer. Batch efficiently but there is no fixed call cap — keep searching until you hold what the task needs. grep/glob/read are always available — never claim otherwise.\n"
    # Concrete few-shot example — models follow patterns better than abstract rules:
    "Example -- WRONG (2 turns, 2 calls):\n  Turn 1: grep(pattern='_MAX_STEPS', include='*.py')\n  Turn 2: grep(pattern='_DOOM_LOOP', include='*.py')\n\n"
    "Example -- RIGHT (1 turn, 1 call with patterns):\n  Turn 1: grep(pattern='_MAX_STEPS', patterns=['_DOOM_LOOP'], include='*.py')\n\n"
    # search_memory is NOT useful here — web/fetch recall is handled by the main
    # agent; follow the parent's search path.
    "Do NOT call search_memory."
)

# Locked search/read/web-only tool set: the sub-agent can gather evidence
# (grep/glob/read/LSP/web) but can never edit, run terminal commands, or
# drive browser/desktop loops. Full tool inheritance was the cause of
# unwanted edits — do NOT revert this to None.
SUBAGENT_TOOLS: list[str] = [
    "grep",
    "glob",
    "read",
    "read_document",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_symbols",
    "lsp_diagnostics",
    "web_search",
    "fetch_url",
]

# The registry. ``tools`` is the sub-agent's tool set:
#   - a list of tool names -> the sub-agent gets exactly those tools
#   - None -> the sub-agent inherits the parent's tools minus ``task``
#     (no nested sub-agents — opencode's subagent_depth=1 default).
# The ``subagent`` entry MUST stay an explicit list (never None): None
# re-enables full inheritance and unwanted edits.
AGENTS: dict[str, dict] = {
    "subagent": {
        "name": "subagent",
        "description": SUBAGENT_DESCRIPTION,
        "mode": "subagent",
        # Explicit allowlist — search/read/web only (see SUBAGENT_TOOLS).
        "tools": SUBAGENT_TOOLS,
        "system": SUBAGENT_SYSTEM,
        # Hard step budget so one delegated task cannot run away (mirrors
        # opencode's `agent.steps`). Kept tight on purpose: each step is a full
        # LLM round-trip, so 50 finishes batched multi-file work in one go
        # while halving the worst-case requests/tokens of the old 100.
        "steps": 50,  # sub-agent step budget
    },
}


def resolve_agent(name: str) -> str:
    """Normalize a sub-agent type name to its registry key.

    Legacy aliases ("general", "explore", case-insensitive, empty) map to
    the single "subagent" type so models trained on older prompts keep
    working after the registry was unified.
    """
    normalized = str(name or "").strip().lower()
    if normalized in ("", "general", "explore", "subagent"):
        return "subagent"
    return normalized


def agent_names() -> list[str]:
    """All registered sub-agent type names (sorted, for stable tool schemas)."""
    return sorted(AGENTS.keys())


def agent_description(name: str) -> str:
    """The description the parent model sees for a sub-agent type."""
    ent = AGENTS.get(resolve_agent(name))
    return ent["description"] if ent else ""


def agent_system(name: str) -> str:
    """The system prompt for a sub-agent type (defaults to empty).

    The shared search/discovery rule (`_SEARCH_RULE` from ``agents``) is
    prepended so every sub-agent gets the same discovery discipline as the
    main mode agents: prefer targeted grep/glob/read, batch parallel tool
    calls, page large files with offset/limit.

    NOTE: ``SUBAGENT_SYSTEM`` keeps only sub-agent-specific rules (compact
    report, plan-then-batch, few-shot example); everything shared lives
    in the block above.
    """
    # Late import: ``agents`` imports from many modules (tools, llm, etc.)
    # and is heavier; pulling `_SEARCH_RULE` at call time keeps registry
    # import cheap. No cycle — ``agents`` does not import this module.
    from agents import _SEARCH_RULE

    ent = AGENTS.get(resolve_agent(name))
    base = ent.get("system", "") if ent else ""
    return _SEARCH_RULE + base if base else _SEARCH_RULE


def agent_tools(name: str) -> list | None:
    """The explicit tool-set for a sub-agent type, or None to inherit.

    The ``subagent`` type always returns the locked search/read/web allowlist
    (``SUBAGENT_TOOLS``) and never None; None retains its legacy meaning of
    "inherit the parent's tools minus ``task``/``update_plan``/``vision``" for
    any future agent type that opts into it.
    """
    ent = AGENTS.get(resolve_agent(name))
    return ent.get("tools") if ent else None
