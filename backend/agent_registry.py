"""Agent registry — opencode-style subagents.

Each agent has a name, a description (shown to the parent model so it knows
when to delegate), and a tool set. The ``task`` tool looks up an agent by
``subagent_type`` and runs it as an isolated sub-agent, exactly like opencode's
``task`` tool + agent registry (packages/opencode/src/agent/agent.ts).

The registry exposes a single all-purpose ``subagent`` type: it inherits the
parent's full tool set (minus nested delegation) so it can run any delegated
unit of work in the background.
"""

# All-purpose background sub-agent: ANY delegated unit of work,
# not just code search — research, multi-file reads, verification, small edits.
# It runs in the background while the main agent keeps working and delivers a
# compact report when done (context isolation: the main agent never sees its
# internal tool history, spec §9/§11).
SUBAGENT_DESCRIPTION = (
    "Background sub-agent for whole units of work: independent implementation chunks, "
    "verification, multi-step browser (Playwright) and desktop "
    "(computer) loops, or small delegated tasks. Browser snapshots and desktop "
    "trees bloat the main transcript when run inline — delegate them here so "
    "the main agent only sees the compact report. Delegated tasks run "
    "in the background while the main agent continues its own work; the report "
    "is delivered back when the task finishes. Use it for anything parallelizable."
)

SUBAGENT_SYSTEM = (
    "You are a background sub-agent. The main agent delegated one unit of work to you "
    "and is continuing its own task in parallel — work independently with your tools "
    "and finish with a COMPACT report: a 3-5 line summary + a list of `path:line:snippet` "
    "findings (absolute paths) or the concrete result of the task. No prose.\n\n"
    "PLAN FIRST, THEN BATCH: when the task names exact files (Files: ... / ONLY these), SKIP all discovery (no LSP, no grep, no glob) and go straight to ONE read via filePaths/ranges+symbols. Otherwise decompose the request into 3-5 sub-queries, then fire ALL lookups in ONE parallel batch (LSP-first order: LSP -> glob-first if filename -> ONE scoped+filtered grep -> symbols/ranges read; filename pattern -> glob first, never grep for filenames; symbol NAME -> LSP/read symbols, never grep for the name; batch all lsp_symbols in ONE parallel block, never one file per turn), then ALL reads in ONE batch via filePaths=[...] or ranges=[...], then report. Edits to different files go as parallel edit_file calls in the SAME turn, never one file per turn. FORBIDDEN blind-search: >3 `|` alternatives in one grep pattern, multilingual OR mixing languages in one pattern (pick ONE language, ONE concept, max 3 alternatives), or workspace-wide grep without BOTH path/paths AND include/includes scope — every grep MUST set path/paths (e.g. path='backend') AND include/includes (e.g. include='*.py'), including all src/backend searches. Filename discovery (e.g. *Composer* *DiffBar*) MUST glob first (pattern='*Composer*', patterns=['*DiffBar*']) before any content grep. NEVER read the workspace root (filePath='.', '', '/' or empty) — root listing is forbidden, use glob or scoped grep instead. Firing separate Read File calls for files/ranges already known upfront in the same turn is a HARD violation — batch them in ONE read and NEVER re-read the same window twice. If a call fails, report the exact ERROR instead of falling back with an excuse. Chain independent run_terminal checks in ONE call with `;`.\n\n"
    "Procedure (strict order):\n"
    "1. Finish ALL Glob/Grep lookups FIRST, then read -- never interleave search->read->search->read. Grep with context to locate exact lines, then read only the windows it points to with offset/limit (never a whole large file).\n"
    "2. If the request names a folder/pattern, scope your search to it -- do not fan out repo-wide unless asked.\n"
    "3. Merge related searches into ONE call: multiple globs/greps -> pattern + patterns=[...] (or '|' inside pattern); scopes via path + paths=[...]; filters via include + includes=[...].\n"
    "4. NEVER walk a large file chunk-by-chunk (read 1-2000, then 5001-7500, ...) -- grep first, then read ONLY the needed windows in ONE call via ranges=[...] (same file, several windows included: ranges=['tools.py:640:60','tools.py:2089:80']; symbols=[...] may join that same call). Make the FIRST read decisive: known NAME (LSP or a grep `in Name (L..)` hit) -> symbols=[...] in ONE call with no prior read. Surveying a large file with unknown names -> lsp_symbols(filePath) first (not read), then read symbols=[...] in ONE call -- exactly ONE read total, never read offset=1 for a FILE MAP and then read again. When grep already inlined the full body, do NOT re-read it. Prefer reusing results you already hold, but never refuse a read you need: when in doubt, re-read.\n"
    "5. External docs: web_search + fetch_url only when the answer needs them.\n"
    "You have the same tools as the main agent for your task; if the task "
    "requires action (edits, verification, browser/desktop loops, terminal "
    "checks), DO it fully and report the concrete result (files changed, test "
    "output, verification) — do NOT return only search hits. Use mutating tools "
    "only when the delegated task requires them. Avoid emojis.\n\n"
    "PROGRESSIVE BATCHING: each batch narrows toward the answer. Batch efficiently but there is no fixed call cap — keep searching until you hold what the task needs. grep/glob/read are always available — never claim otherwise.\n"
    # Concrete few-shot example — models follow patterns better than abstract rules:
    "Example -- WRONG (2 turns, 2 calls):\n  Turn 1: grep(pattern='_MAX_STEPS', include='*.py')\n  Turn 2: grep(pattern='_DOOM_LOOP', include='*.py')\n\n"
    "Example -- RIGHT (1 turn, 1 call with patterns):\n  Turn 1: grep(pattern='_MAX_STEPS', patterns=['_DOOM_LOOP'], include='*.py')\n\n"
    # search_memory is NOT useful here — web/fetch recall is handled by the main
    # agent; follow the parent's search path.
    "Do NOT call search_memory."
)

# The registry. ``tools`` is the sub-agent's tool set:
#   - a list of tool names -> the sub-agent gets exactly those tools
#   - None -> the sub-agent inherits the parent's tools minus ``task``
#     (no nested sub-agents — opencode's subagent_depth=1 default).
AGENTS: dict[str, dict] = {
    "subagent": {
        "name": "subagent",
        "description": SUBAGENT_DESCRIPTION,
        "mode": "subagent",
        # ``None`` = inherit the PARENT's full mode-filtered tool set minus
        # task/update_plan/vision (see tools._run_subagent_task), so the
        # sub-agent has every tool the main agent has for this mode.
        "tools": None,
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

    None means "inherit the parent's tools minus ``task``/``update_plan``/
    ``vision``"; a list means "use exactly these tool names".
    """
    ent = AGENTS.get(resolve_agent(name))
    return ent.get("tools") if ent else None
