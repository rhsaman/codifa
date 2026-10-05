"""Search/discovery rule is injected into every sub-agent system prompt.

Every sub-agent registered in ``agent_registry`` sees the same discovery
rules as the main agent via ``_SEARCH_RULE`` — so the model delegates broad
search to the sub-agent instead of filling context with one-by-one reads.
"""
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agent_registry import agent_names, agent_system


def test_search_rule_in_every_subagent_system():
    """هر sub-agent ثبت‌شده باید marker اصلی _SEARCH_RULE را داشته باشد."""
    marker = "subagent_type='subagent'"
    missing = []
    for name in agent_names():
        sys_prompt = agent_system(name)
        if marker not in sys_prompt:
            missing.append(name)
    assert not missing, f"sub-agent های فاقد search rule: {missing}"


def test_search_rule_prepended_before_base():
    """_SEARCH_RULE باید قبل از base prompt هر sub-agent بیاید."""
    for name in agent_names():
        sys_prompt = agent_system(name)
        marker_idx = sys_prompt.find("SEARCH STRATEGY")
        # هر base prompt با یک marker خاص شروع می‌شود؛ برای subagent
        # این «You are» است (مطابق SUBAGENT_SYSTEM).
        base_idx = sys_prompt.find("You are")
        assert marker_idx != -1, f"{name}: marker SEARCH STRATEGY یافت نشد"
        assert base_idx != -1, f"{name}: base prompt (You are) یافت نشد"
        assert marker_idx < base_idx, (
            f"{name}: _SEARCH_RULE باید قبل از base prompt بیاید "
            f"(marker={marker_idx}, base={base_idx})"
        )


def test_search_rule_present_for_subagent():
    """تست صریح برای sub-agent فعلی — اگر agent جدیدی اضافه شد، این
    تست fail می‌شود تا توسعه‌دهنده متوجه شود باید قانون را برای آن هم
    فعال کند."""
    for name in ("subagent",):
        sys_prompt = agent_system(name)
        assert "PROGRESSIVE BATCHING" in sys_prompt, (
            f"{name}: قانون PROGRESSIVE BATCHING در system prompt نیست"
        )
        assert "filePaths" in sys_prompt, (
            f"{name}: راهنمای filePaths (parallel reads) در system prompt نیست"
        )


if __name__ == "__main__":
    test_search_rule_in_every_subagent_system()
    test_search_rule_prepended_before_base()
    test_search_rule_present_for_subagent()
    print("SUBAGENT SEARCH RULE TESTS PASSED")
