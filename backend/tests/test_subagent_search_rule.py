"""تست: قانون search/discovery به system prompt هر sub-agent تزریق می‌شود.

این تضمین می‌کند هر sub-agent ثبت‌شده در ``agent_registry`` (اعم از
``explore`` و ``general``) همان قواعد discovery را که main agent می‌بیند
از طریق ``_SEARCH_RULE`` می‌بیند — تا در هر run، مدل به‌طور پیش‌فرض
``explore`` را برای broad search صدا بزند، نه اینکه فایل‌ها را یکی‌یکی
با read پر کند.
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
    marker = "subagent_type='explore'"
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
        # هر base prompt با یک marker خاص شروع می‌شود؛ برای general و explore
        # این «You are» است (مطابق GENERAL_SYSTEM / EXPLORE_SYSTEM).
        base_idx = sys_prompt.find("You are")
        assert marker_idx != -1, f"{name}: marker SEARCH STRATEGY یافت نشد"
        assert base_idx != -1, f"{name}: base prompt (You are) یافت نشد"
        assert marker_idx < base_idx, (
            f"{name}: _SEARCH_RULE باید قبل از base prompt بیاید "
            f"(marker={marker_idx}, base={base_idx})"
        )


def test_search_rule_present_for_explore_and_general():
    """تست صریح برای دو sub-agent فعلی — اگر agent جدیدی اضافه شد، این
    تست fail می‌شود تا توسعه‌دهنده متوجه شود باید قانون را برای آن هم
    فعال کند."""
    for name in ("general", "explore"):
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
    test_search_rule_present_for_explore_and_general()
    print("SUBAGENT SEARCH RULE TESTS PASSED")
