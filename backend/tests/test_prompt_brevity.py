"""Unit tests for the ask-mode brevity change and plan/build length rule.

- ask prompt no longer forces "explain the WHY" and tells the model to stay short.
- _UNIVERSAL_RULES no longer contains the "MATCH LENGTH TO NEED" rule (so ask
  is not pushed to write long answers).
- _LENGTH_RULE exists and is appended ONLY for plan/build, not for ask.
"""

from agents import (
    _CODING_RULES,
    _DISCOVERY_BLOCK,
    _LENGTH_RULE,
    _PERSIAN_REPLY_RULE,
    _UNIVERSAL_RULES,
    SYSTEM_PROMPTS,
    _language_directive,
)


def test_ask_prompt_drops_explain_the_why():
    ask = SYSTEM_PROMPTS["ask"]
    assert "explain the WHY" not in ask
    assert "Keep answers short" in ask


def test_universal_rules_no_longer_match_length_to_need():
    assert "MATCH LENGTH TO NEED" not in _UNIVERSAL_RULES


def test_length_rule_present_and_only_for_plan_build():
    assert "MATCH LENGTH TO NEED" in _LENGTH_RULE
    # Mirror the exact assembly logic from graph.build_turn_context.
    for mode in ("ask", "reader"):
            base = (
                SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
                + _UNIVERSAL_RULES
                + (_LENGTH_RULE if mode in ("plan", "build") else "")
            )
            assert "MATCH LENGTH TO NEED" not in base, f"{mode} must stay short"
    for mode in ("plan", "build"):
            base = (
                SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
                + _UNIVERSAL_RULES
                + (_LENGTH_RULE if mode in ("plan", "build") else "")
            )
            assert "MATCH LENGTH TO NEED" in base, f"{mode} must keep full length rule"


def test_no_duplicate_read_rule():
    # MANDATORY READ RULE lives only in _SEARCH_RULE, not duplicated in mode prompts.
    assert "MANDATORY READ RULE" not in SYSTEM_PROMPTS["build"]
    assert "MANDATORY READ RULE" not in SYSTEM_PROMPTS["plan"]


def test_no_duplicate_language_rule():
    # The language directive is injected dynamically per turn (_language_directive),
    # so it must not be baked into any static SYSTEM_PROMPTS entry.
    for mode, prompt in SYSTEM_PROMPTS.items():
        assert "Match the user's language" not in prompt, f"{mode} must not repeat language rule"


def test_discovery_block_compact():
    # _DISCOVERY_BLOCK must not re-expand the full explore-subagent mechanics
    # (that is the job of _SEARCH_RULE); it only references the strategy.
    assert "compact report" not in _DISCOVERY_BLOCK


def test_ask_mode_answers_general_questions():
    # Ask mode is a simple general-purpose assistant: it must handle BOTH
    # everyday questions and codebase questions, in the user's language.
    ask = SYSTEM_PROMPTS["ask"]
    assert "everyday questions" in ask
    assert "project/code questions" in ask
    assert "SAME LANGUAGE" in ask
    # _MODE_CAPS should also reflect the general-purpose nature.
    from agents import _MODE_CAPS
    assert "everyday questions" in _MODE_CAPS["ask"]
    assert "project/code questions" in _MODE_CAPS["ask"]


def test_code_always_english_in_universal_rules():
    assert "CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH" in _UNIVERSAL_RULES


def test_links_are_never_code_in_universal_rules():
    assert "LINKS ARE NEVER CODE" in _UNIVERSAL_RULES
    assert "never wrap http(s) URLs in backticks" in _UNIVERSAL_RULES


def test_build_has_persian_reply_rule():
    build = SYSTEM_PROMPTS["build"]
    assert _PERSIAN_REPLY_RULE in build
    assert "HARD RULE (always follow): The user writes in Persian" in build
    assert "ask_user question and options" in build
    assert "SKILLS ARE ALWAYS ENGLISH (HARD)" in build
    assert "CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD)" in build


def test_build_coding_rules_guarded():
    build = SYSTEM_PROMPTS["build"]
    assert _CODING_RULES in build
    assert "CODING RULES (always follow when writing or modifying code)" in build
    assert "Keep types strict" in build
    assert "Handle errors explicitly and validate external/user input" in build
    assert "Avoid security vulnerabilities, race conditions" in build
    assert "CPU- and memory-efficient code" in build
    assert "blocking operations where inappropriate" in build
    assert "Prefer efficient algorithms and data structures" in build
    assert "Write CPU- and memory-efficient code" in build
    assert "blocking operations where inappropriate" in build
    assert "CPU usage, memory usage, performance, and maintainability" in build


def test_build_persian_rule_guarded_against_deletion():
    build = SYSTEM_PROMPTS["build"]
    assert _PERSIAN_REPLY_RULE in build
    assert "These hard rules override the Persian reply rule" in build


def test_language_directive_keeps_code_english_for_persian():
    directive = _language_directive("سلام")
    assert "CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH" in directive
    assert "comment or text inside generated code/files" not in directive


if __name__ == "__main__":
    test_ask_prompt_drops_explain_the_why()
    test_universal_rules_no_longer_match_length_to_need()
    test_length_rule_present_and_only_for_plan_coder()
    test_no_duplicate_read_rule()
    test_no_duplicate_language_rule()
    test_discovery_block_compact()
    print("PROMPT BREVITY TESTS PASSED")
