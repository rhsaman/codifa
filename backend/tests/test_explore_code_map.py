"""تست: explore sub-agent باید نقشه‌ی نماد (CODE MAP) بگیره و search_memory نداشته باشه."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent_registry import AGENTS


def test_explore_has_no_search_memory():
    """explore نباید ابزار search_memory داشته باشه."""
    tools = AGENTS["explore"]["tools"] or []
    assert "search_memory" not in tools


def test_explore_system_mentions_code_map_and_no_search_memory():
    """پرامپت explore باید به CODE MAP اشاره کنه و search_memory رو منع کنه."""
    sys_prompt = AGENTS["explore"]["system"]
    assert "CODE MAP" in sys_prompt
    assert "Do NOT call search_memory" in sys_prompt
    assert "filePaths=[...]" in sys_prompt  # batch read


def test_explore_steps_budget_is_reasonable():
    """بودجه‌ی steps explore نباید بی‌نهایت باشه (محدودیت step روی grep/glob/read
    برداشته شد، ولی explore هنوز یه بودجه‌ی معقول داره تا حلقه نزنه)."""
    assert 0 < AGENTS["explore"]["steps"] <= 30
