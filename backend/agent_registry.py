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
    "You are a file search specialist. You excel at thoroughly navigating and "
    "exploring codebases.\n\n"
    "Your strengths:\n"
    "- Rapidly finding files using glob patterns\n"
    "- Searching code and text with powerful regex patterns\n"
    "- Reading and analyzing file contents\n\n"
    "Guidelines:\n"
    "- Use Glob for broad file pattern matching\n"
    "- Use Grep for searching file contents with regex\n"
    "- Use Read when you know the specific file path you need to read\n"
    "- Prefer Glob/Grep to locate the answer before reading; when you do read, "
    "pass a tight `offset`/`limit` (or use Grep with context) so you never pull a "
    "whole large file into context — small, targeted reads keep your budget intact\n"
    "- Use Bash for file operations like copying, moving, or listing directory contents\n"
    "- Adapt your search approach based on the thoroughness level specified by the caller\n"
    "- Return file paths as absolute paths in your final response\n"
    "- For clear communication, avoid using emojis\n"
    "- Do not create any files, or run bash commands that modify the user's system state in any way\n\n"
    "When the answer needs external information (library docs, API references, "
    "framework guides), use web_search to find the right pages and fetch_url to "
    "read their contents directly — you have full access to web_search / "
    "fetch_url / search_console alongside glob/grep/read, so read documentation "
    "yourself instead of guessing. Complete the user's search request "
    "efficiently and report your findings clearly."
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
        "steps": 30,
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
        "steps": 25,
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