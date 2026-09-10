"""تست قانون TOOL NARRATION — روایتِ کاریِ مدل بالای هر فراخوانی ابزار.

- _UNIVERSAL_RULES باید بند TOOL NARRATION را داشته باشد.
- چون graph.build_turn_context برای همهٔ مودهای اصلی SYSTEM_PROMPTS + _UNIVERSAL_RULES
  را می‌چسباند، قانون باید در سرهم‌بندیِ نهایی هر مود اصلی دیده شود.
- ساب‌ایجنت‌ها (explore/general) از agent_system فقط _SEARCH_RULE می‌گیرند و متنشان
  به UI استریم نمی‌شود؛ پس قانون نباید به پرامپتشان برسد.
"""

from agent_registry import agent_system
from agents import _UNIVERSAL_RULES, SYSTEM_PROMPTS

_MAIN_MODES = ("ask", "plan", "coder", "reader")
_SUBAGENTS = ("explore", "general")


def test_universal_rules_have_narration():
    assert "TOOL NARRATION" in _UNIVERSAL_RULES


def test_every_main_mode_gets_narration_rule():
    # آینهٔ منطق سرهم‌بندی graph.build_turn_context
    for mode in _MAIN_MODES:
        base = (
            SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
            + _UNIVERSAL_RULES
        )
        assert "TOOL NARRATION" in base, mode


def test_subagent_prompts_do_not_get_narration():
    # متن ساب‌ایجنت به UI استریم نمی‌شود؛ قانون نباید بهشان برسد
    for name in _SUBAGENTS:
        assert "TOOL NARRATION" not in agent_system(name), name


if __name__ == "__main__":
    test_universal_rules_have_narration()
    test_every_main_mode_gets_narration_rule()
    test_subagent_prompts_do_not_get_narration()
    print("TOOL NARRATION PROMPT TESTS PASSED")
