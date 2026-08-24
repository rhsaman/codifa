"""Unit tests for the ask-mode brevity change and plan/coder length rule.

- ask prompt no longer forces "explain the WHY" and tells the model to stay short.
- _UNIVERSAL_RULES no longer contains the "MATCH LENGTH TO NEED" rule (so ask
  is not pushed to write long answers).
- _LENGTH_RULE exists and is appended ONLY for plan/coder, not for ask.
"""

from agents import SYSTEM_PROMPTS, _UNIVERSAL_RULES, _LENGTH_RULE


def test_ask_prompt_drops_explain_the_why():
    ask = SYSTEM_PROMPTS["ask"]
    assert "explain the WHY" not in ask
    assert "Keep answers short" in ask


def test_universal_rules_no_longer_match_length_to_need():
    assert "MATCH LENGTH TO NEED" not in _UNIVERSAL_RULES


def test_length_rule_present_and_only_for_plan_coder():
    assert "MATCH LENGTH TO NEED" in _LENGTH_RULE
    # Mirror the exact assembly logic from graph.build_turn_context.
    for mode in ("ask", "reader"):
        base = (
            SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
            + _UNIVERSAL_RULES
            + (_LENGTH_RULE if mode in ("plan", "coder") else "")
        )
        assert "MATCH LENGTH TO NEED" not in base, f"{mode} must stay short"
    for mode in ("plan", "coder"):
        base = (
            SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
            + _UNIVERSAL_RULES
            + (_LENGTH_RULE if mode in ("plan", "coder") else "")
        )
        assert "MATCH LENGTH TO NEED" in base, f"{mode} must keep full length rule"


if __name__ == "__main__":
    test_ask_prompt_drops_explain_the_why()
    test_universal_rules_no_longer_match_length_to_need()
    test_length_rule_present_and_only_for_plan_coder()
    print("PROMPT BREVITY TESTS PASSED")
