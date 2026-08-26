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
    "Do NOT create/modify files. Do NOT run mutating bash. Avoid emojis."
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
        "steps": 15,
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
            "vision",
        ],
        "system": EXPLORE_SYSTEM,
        # Explore agents fan out wide searches; give them a slightly tighter
        # budget so a single explore call can't run away (opencode's explore is
        # also bounded).
        "steps": 20,
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
    """The system prompt for a sub-agent type (defaults to empty)."""
    ent = AGENTS.get(name)
    return ent.get("system", "") if ent else ""


def agent_tools(name: str) -> list | None:
    """The explicit tool-set for a sub-agent type, or None to inherit.

    None means "inherit the parent's tools minus ``task``" (the general agent);
    a list means "use exactly these tool names" (the explore agent).
    """
    ent = AGENTS.get(name)
    return ent.get("tools") if ent else None
