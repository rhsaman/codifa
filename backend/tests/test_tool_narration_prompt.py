"""Sub-agent narration rule test — the model's working narration above each
tool call.

- _UNIVERSAL_RULES must contain the TOOL NARRATION clause.
- graph.build_turn_context appends SYSTEM_PROMPTS + _UNIVERSAL_RULES for every
  main mode, so the rule must appear in each main mode's final assembly.
- Sub-agents get only _SEARCH_RULE via agent_system and their text is never
  streamed to the UI; the rule must not reach their prompt.
"""

from agent_registry import agent_system
from agents import _UNIVERSAL_RULES, SYSTEM_PROMPTS

_MAIN_MODES = ("ask", "plan", "coder", "reader")
_SUBAGENTS = ("subagent",)


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
    # Sub-agent text is never streamed to the UI; the rule must not reach it.
    for name in _SUBAGENTS:
        assert "TOOL NARRATION" not in agent_system(name), name


if __name__ == "__main__":
    test_universal_rules_have_narration()
    test_every_main_mode_gets_narration_rule()
    test_subagent_prompts_do_not_get_narration()
    print("TOOL NARRATION PROMPT TESTS PASSED")
