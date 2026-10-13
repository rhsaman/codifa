"""Rules for the mandatory test-execution cycle and the run_tests tool.

Checks (in the style of test_coder_debug_protocol.py):
- the test-discipline rule is appended to plan+build prompts,
- the build-only execution rule is appended to build and absent from
  read-only modes,
- run_tests is gated like run_terminal (sequential tools, mode gates,
  sub-agent stripping).
"""

import agents
from graph import _SEQUENTIAL_TOOLS, filter_tools_for_mode


def _prompt_for(mode: str) -> str:
    """Rebuild the mode prompt the way build_turn_context assembles it."""
    base = agents.SYSTEM_PROMPTS[mode]
    return (
        base
        + agents._LENGTH_RULE
        + agents._TEST_DIR_RULE
        + agents._TEST_STYLE_RULE
        + agents._TEST_DISCIPLINE_RULE
        + (agents._TEST_EXECUTION_RULE if mode == "build" else "")
    )


def test_discipline_rule_in_plan_and_build_prompts():
    for mode in ("plan", "build"):
        prompt = _prompt_for(mode)
        assert "TEST DISCIPLINE RULE" in prompt, (
            f"{mode} prompt must carry the test-discipline rule"
        )
        assert "BEHAVIOR, not implementation" in prompt
        assert "network, disk, clock, third-party services" in prompt
        assert "failing test" in prompt


def test_execution_rule_only_in_build_prompt():
    build = _prompt_for("build")
    assert "TEST EXECUTION RULE" in build, (
        "build prompt must mandate the write-run-read-fix-rerun cycle"
    )
    assert "run_tests" in build, "build prompt must name the run_tests tool"
    for mode in ("plan", "ask", "reader"):
        prompt = _prompt_for(mode)
        assert "TEST EXECUTION RULE" not in prompt, (
            f"read-only mode {mode} must not get the execution rule"
        )


def test_run_tests_is_sequential():
    assert "run_tests" in _SEQUENTIAL_TOOLS


def test_run_tests_gated_like_run_terminal():
    tools = {"run_terminal": lambda: None, "run_tests": lambda: None}
    for mode in ("build", "plan", "ask"):
        allowed = filter_tools_for_mode(mode, dict(tools))
        if "run_terminal" in allowed:
            assert "run_tests" in allowed, (
                f"{mode}: run_tests must be allowed wherever run_terminal is"
            )
        else:
            assert "run_tests" not in allowed, (
                f"{mode}: run_tests must be denied wherever run_terminal is"
            )


def test_run_tests_stripped_from_subagents():
    from tools import _SUBAGENT_STRIPPED_TOOLS

    assert "run_tests" in _SUBAGENT_STRIPPED_TOOLS
