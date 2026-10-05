"""Sub-agent test: the sub-agent has no search_memory tool and its prompt
references the CODE MAP while banning search_memory."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent_registry import AGENTS


def test_subagent_has_no_search_memory():
    """The sub-agent must not have the search_memory tool."""
    tools = AGENTS["subagent"]["tools"] or []
    assert "search_memory" not in tools


def test_subagent_system_mentions_code_map_and_no_search_memory():
    """The sub-agent prompt must reference the CODE MAP and ban search_memory."""
    sys_prompt = AGENTS["subagent"]["system"]
    assert "CODE MAP" in sys_prompt
    assert "Do NOT call search_memory" in sys_prompt
    assert "filePaths=[...]" in sys_prompt  # batch read


def test_subagent_steps_budget_is_reasonable():
    """The sub-agent steps budget must stay bounded (a sane cap so one
    delegated task cannot loop forever)."""
    assert 0 < AGENTS["subagent"]["steps"] <= 100
