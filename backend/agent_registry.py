"""Agent registry — opencode-style subagents.

Each agent has a name, a description (shown to the parent model so it knows
when to delegate), and a tool set. The ``task`` tool looks up an agent by
``subagent_type`` and runs it as an isolated sub-agent, exactly like opencode's
``task`` tool + agent registry (packages/opencode/src/agent/agent.ts).

The descriptions below are opencode's verbatim agent descriptions — the parent
model reads them from the ``task`` tool schema and decides which agent to
delegate to.
"""

# opencode's general agent description (agent.ts) — verbatim.
GENERAL_DESCRIPTION = (
    "General-purpose agent for researching complex questions and executing "
    "multi-step tasks. Use this agent to execute multiple units of work in "
    "parallel."
)

GENERAL_SYSTEM = (
    "You are a general-purpose sub-agent. The main agent delegated a task to "
    "you. Work through it independently with your tools, then reply with a "
    "concise final result (under ~300 words unless the task needs more). You "
    "run in an isolated context — the main agent only sees your final reply, so "
    "include the concrete findings, exact paths and any numbers it needs. Do "
    "not ask the user questions; do not call the task tool."
)

# Exploration sub-agent: broad, repository-wide research. Returns a compact
# structured finding (summary + relevant files + findings) — the Main Agent
# never sees its internal grep/glob/read history (context isolation, spec §9/§11).
EXPLORE_DESCRIPTION = (
    "Exploration agent for multi parallel research. Use this to map how a "
    "feature, subsystem, or concept is implemented across the codebase — "
    "it searches with glob/grep/read and returns a compact summary with the "
    "relevant files and findings."
)

EXPLORE_SYSTEM = (
    "You are a file-search specialist for research. "
    "Return a COMPACT report: a 3-5 line summary + a list of "
    "`path:line:snippet` findings (absolute paths). No prose.\n\n"
    "Procedure (strict order):\n"
    "1. Glob/Grep FIRST to locate the answer then use the specific lines you need (offset/limit). Never read a whole large file.\n"
    "2. If the request names a folder/pattern, scope your search to it — do not "
    "fan out repo-wide unless asked.\n"
    "3. Fire multiple Glob/Grep in ONE turn (parallel) when known.\n"
    "4. External docs: web_search + fetch_url only when the answer needs them.\n"
    "Do NOT create/modify files. Do NOT run mutating bash. Avoid emojis.\n\n"
    # Progressive batching (mirrors _SEARCH_RULE so explore also batches):
    "PROGRESSIVE BATCHING: fire ALL targeted searches you need (each with explicit "
    "scope: path + include) as a SINGLE BATCH of parallel tool calls each turn. "
    "Each batch must narrow toward the answer (progressive). Goal: UNDER 10 total "
    "grep/glob/read calls per task.\n"
    # When you already know the files you need, read them ALL in ONE call using
    # filePaths=[...] — never read one file per call (that multiplies turns).
    "When you know multiple files, read them ALL in ONE call using filePaths=[...]. "
    "Never read one-by-one.\n"
    # Concrete few-shot example — models follow patterns better than abstract rules:
    "Example — WRONG (2 turns, 2 calls):\n"
    "  Turn 1: grep(pattern='_MAX_STEPS', include='*.py')\n"
    "  Turn 2: grep(pattern='_DOOM_LOOP', include='*.py')\n\n"
    "Example — RIGHT (1 turn, 1 call with '|'):\n"
    "  Turn 1: grep(pattern='_MAX_STEPS|_DOOM_LOOP', include='*.py')\n\n"
    "When you have 2+ related patterns for the same path/include, merge them "
    "with '|' into a single grep call instead of firing separate greps.\n"
    # search_memory is NOT useful for exploration — the CODE MAP above already
    # gives you the symbol layout, and web/fetch recall is handled by the main
    # agent. Do not call search_memory.
    "Do NOT call search_memory — the CODE MAP above is your structure reference."
)

# The registry. ``tools`` is the sub-agent's tool set:
#   - a list of tool names -> the sub-agent gets exactly those tools
#   - None -> the sub-agent inherits the parent's tools minus ``task``
#     (no nested sub-agents — opencode's subagent_depth=1 default).
AGENTS: dict[str, dict] = {
    "general": {
        "name": "general",
        "description": GENERAL_DESCRIPTION,
        "mode": "subagent",
        # parent's tools minus `task` (and plan/checklist tools that would
        # pollute the parent's UI state)
        "tools": None,
        "system": GENERAL_SYSTEM,
        # Hard step budget for this sub-agent (mirrors opencode's `agent.steps`).
        # None -> fall back to the caller's default max_steps.
        "steps": 100,  # general sub-agent step budget
    },
    "explore": {
        "name": "explore",
        "description": EXPLORE_DESCRIPTION,
        "mode": "subagent",
        # Read-only exploration tool set (no write/task) — matches opencode's
        # explore agent: grep/glob/read/run_terminal (read-only-wrapped) + web/vision.
        "tools": [
            "grep",
            "glob",
            "read",
            "run_terminal",
            "web_search",
            "fetch_url",
            "search_console",
            "current_time",
            "vision",
            # search_memory removed: exploration uses the CODE MAP (injected into
            # the system prompt) for structure, and web/fetch recall is the main
            # agent's job. Calling search_memory inside explore just wastes a turn.
        ],
        "system": EXPLORE_SYSTEM,
        # Explore agents fan out wide searches; give them a slightly tighter
        # budget so a single explore call can't run away (opencode's explore is
        # also bounded).
        "steps": 30,  # explore sub-agent step budget
    },
}


def agent_names() -> list[str]:
    """All registered sub-agent type names (sorted, for stable tool schemas)."""
    return sorted(AGENTS.keys())


def agent_description(name: str) -> str:
    """The description the parent model sees for a sub-agent type."""
    ent = AGENTS.get(name)
    return ent["description"] if ent else ""


def agent_system(name: str) -> str:
    """The system prompt for a sub-agent type (defaults to empty).

    The shared search/discovery rule (`_SEARCH_RULE` from ``agents``) is
    prepended so every sub-agent — even ones that don't mention the search
    tools in their own prompt (e.g. ``general``) — gets the same discovery
    discipline as the main mode agents: prefer targeted grep/glob/read,
    delegate broad/multi-file search to the ``explore`` sub-agent, batch
    parallel tool calls, page large files with offset/limit.

    NOTE: ``EXPLORE_SYSTEM`` repeats parts of the rule for emphasis; that
    redundancy is intentional until ``EXPLORE_SYSTEM`` is rewritten to
    reference the shared block by name.
    """
    # Late import: ``agents`` imports from many modules (tools, llm, etc.)
    # and is heavier; pulling `_SEARCH_RULE` at call time keeps registry
    # import cheap. No cycle — ``agents`` does not import this module.
    from agents import _SEARCH_RULE

    ent = AGENTS.get(name)
    base = ent.get("system", "") if ent else ""
    return _SEARCH_RULE + base if base else _SEARCH_RULE


def agent_tools(name: str) -> list | None:
    """The explicit tool-set for a sub-agent type, or None to inherit.

    None means "inherit the parent's tools minus ``task``" (the general agent);
    a list means "use exactly these tool names" (the explore agent).
    """
    ent = AGENTS.get(name)
    return ent.get("tools") if ent else None
