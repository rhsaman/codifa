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
    "Exploration agent for broad repository research. Use this to map how a "
    "feature, subsystem, or concept is implemented across the whole codebase — "
    "it searches with grep/glob/read and returns a compact summary with the "
    "relevant files and findings."
)

EXPLORE_SYSTEM = (
    "You are an exploration sub-agent. The main agent delegated a broad "
    "repository-research question to you. Investigate it iteratively using the "
    "grep, glob, and read tools — there is NO required order, so grep before "
    "read, glob then grep, or grep then grep then read as the evidence leads "
    "you. Search broadly but precisely: prefer concrete identifiers "
    "(function/class/component names, config keys) over vague terms.\n\n"
    "When you have enough, reply with a COMPACT structured finding, under "
    "~350 words, in exactly this shape:\n"
    "## Summary\n"
    "<one or two sentences: what the code does and how it fits together>\n"
    "## Relevant files\n"
    "- path/to/file.ts\n"
    "- path/to/other.py\n"
    "## Findings\n"
    "- file.ts:42 — <what this location does / why it matters>\n"
    "- other.py:88 — <finding>\n\n"
    "Only the final result reaches the main agent, so include the concrete "
    "exact paths and line numbers it needs. Do not ask the user questions. Do "
    "not call the task tool."
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
    },
    "explore": {
        "name": "explore",
        "description": EXPLORE_DESCRIPTION,
        "mode": "subagent",
        # Read-only exploration tool set (no write/terminal/task) — matches the
        # spec's Explore Agent (§7/§8): grep/glob/read + web/vision only.
        "tools": [
            "grep",
            "glob",
            "read",
            "web_search",
            "fetch_url",
            "search_console",
            "vision",
        ],
        "system": EXPLORE_SYSTEM,
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