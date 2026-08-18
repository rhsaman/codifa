"""Agent registry — opencode-style subagents.

Each agent has a name, a description (shown to the parent model so it knows
when to delegate), and a tool set. The ``task`` tool looks up an agent by
``subagent_type`` and runs it as an isolated sub-agent, exactly like opencode's
``task`` tool + agent registry (packages/opencode/src/agent/agent.ts).

The descriptions below are opencode's verbatim agent descriptions — the parent
model reads them from the ``task`` tool schema and decides which agent to
delegate to.
"""

# opencode's explore agent description (agent.ts) — verbatim.
EXPLORE_DESCRIPTION = (
    'Fast agent specialized for exploring codebases. Use this when you need to '
    'quickly find files by patterns (eg. "src/components/**/*.tsx"), search code '
    'for keywords (eg. "API endpoints"), or answer questions about the codebase '
    '(eg. "how do API endpoints work?"). When calling this agent, specify the '
    'desired thoroughness level: "quick" for basic searches, "medium" for '
    'moderate exploration, or "very thorough" for comprehensive analysis across '
    'multiple locations and naming conventions.'
)

# opencode's general agent description (agent.ts) — verbatim.
GENERAL_DESCRIPTION = (
    "General-purpose agent for researching complex questions and executing "
    "multi-step tasks. Use this agent to execute multiple units of work in "
    "parallel."
)

# The registry. ``tools`` is the sub-agent's tool set:
#   - a list of tool names -> the sub-agent gets exactly those tools
#   - None -> the sub-agent inherits the parent's tools minus ``task``
#     (no nested sub-agents — opencode's subagent_depth=1 default).
AGENTS: dict[str, dict] = {
    "explore": {
        "name": "explore",
        "description": EXPLORE_DESCRIPTION,
        "mode": "subagent",
        # read-only file-search tools; the sub-agent does the searching itself
        "tools": ["read", "grep", "glob"],
    },
    "general": {
        "name": "general",
        "description": GENERAL_DESCRIPTION,
        "mode": "subagent",
        # parent's tools minus `task` (and plan/checklist tools that would
        # pollute the parent's UI state)
        "tools": None,
    },
}


def agent_names() -> list[str]:
    """All registered sub-agent type names (sorted, for stable tool schemas)."""
    return sorted(AGENTS.keys())


def agent_description(name: str) -> str:
    """The description the parent model sees for a sub-agent type."""
    ent = AGENTS.get(name)
    return ent["description"] if ent else ""