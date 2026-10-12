"""Unit tests for the persistent-goal (/goal) backend part.

Fast, no network, no sleeps. The production judge is the small-model verdict
(parsed via parse_goal_judge_output over the assistant-only transcript from
build_goal_transcript); the legacy keyword heuristic is covered only for
backward compatibility.
"""

from __future__ import annotations

from goals import (
    GOAL_MAX_EXTRA_TURNS,
    build_goal_transcript,
    format_goal_block,
    judge_goal,
    normalize_goal,
    parse_goal_judge_output,
)
from server import ChatRequest


def test_format_goal_block_contains_condition():
    block = format_goal_block("all tests pass")
    assert "all tests pass" in block
    assert "ACTIVE GOAL" in block


def test_normalize_goal_dict():
    assert normalize_goal({"condition": "  all tests pass  "}) == "all tests pass"
    assert normalize_goal(None) == ""
    assert normalize_goal("  fix login  ") == "fix login"


def test_judge_goal_empty_condition_not_met():
    result = judge_goal("", "some transcript")
    assert result["status"] == "not_met"
    assert isinstance(result["reason"], str) and result["reason"]


def test_judge_goal_matching_transcript_met():
    result = judge_goal("all tests pass", "Work done: all tests pass now.")
    assert result["status"] == "met"


def test_judge_goal_unrelated_transcript_not_met():
    result = judge_goal("migrate database schema", "Fixed a typo in the header.")
    assert result["status"] == "not_met"


def test_judge_goal_impossible_signal():
    result = judge_goal("migrate database schema", "This is impossible, blocked by access.")
    assert result["status"] == "impossible"


def test_judge_goal_llm_hook_sync():
    def fake_llm(condition, transcript):
        return {"status": "met", "reason": "LLM says done."}

    result = judge_goal("anything", "nothing relevant", llm_call=fake_llm)
    assert result == {"status": "met", "reason": "LLM says done."}


def test_judge_goal_llm_hook_async():
    async def fake_async(condition, transcript):
        return {"status": "impossible", "reason": "No way."}

    # Sync context (no running loop) so the async hook can run to completion.
    result = judge_goal("anything", "nothing relevant", llm_call=fake_async)
    assert result["status"] == "impossible"


def test_chat_request_accepts_goal_field():
    req = ChatRequest(root="/tmp", prompt="hi", goal="all tests pass")
    assert req.goal == "all tests pass"
    req2 = ChatRequest(root="/tmp", prompt="hi", goal={"condition": "all tests pass"})
    assert req2.goal == {"condition": "all tests pass"}
    req3 = ChatRequest(root="/tmp", prompt="hi")
    assert req3.goal is None


def test_judge_goal_empty_transcript_not_met():
    # Interrupted / failed turns produce an empty transcript: the goal must
    # stay active (not_met -> continue), never be cleared as met/impossible.
    result = judge_goal("all tests pass", "")
    assert result["status"] == "not_met"


def test_goal_turn_cap_is_configured():
    # The server enforces this authoritatively per request (goal_turns is
    # seeded from the client's cumulative counter); the client mirrors it.
    assert GOAL_MAX_EXTRA_TURNS == 15


def test_build_goal_transcript_excludes_user_pings():
    # Frontend loop pings quote the condition verbatim — judging them would
    # self-clear every goal after ~2 turns with zero work done.
    history = [
        {"role": "user", "content": "/goal all tests pass"},
        {"role": "user", "content": 'Continue working on the persistent goal: "all tests pass".'},
        {"role": "assistant", "content": "I started looking into the failures."},
    ]
    text = build_goal_transcript(history, "Still investigating.")
    assert "Continue working on the persistent goal" not in text
    assert "/goal all tests pass" not in text
    assert "Still investigating." in text


def test_build_goal_transcript_strips_markers():
    history = [
        {"role": "assistant", "content": "Did stuff.\n\n[GOAL CONTINUES] Goal not yet met."},
    ]
    text = build_goal_transcript(history, "More work.\n\n[GOAL CONTINUES] Keep going.")
    assert "[GOAL CONTINUES]" not in text
    assert "Did stuff." in text


def test_build_goal_transcript_includes_tool_evidence():
    history = [
        {
            "role": "assistant",
            "content": "Ran the suite.",
            "toolActivity": [{"tool": "run_terminal", "status": "done", "summary": "pytest: 42 passed"}],
        },
    ]
    text = build_goal_transcript(history, "")
    assert "42 passed" in text


def test_parse_goal_judge_output_valid():
    out = parse_goal_judge_output('{"status": "met", "reason": "All green."} noise')
    assert out == {"status": "met", "reason": "All green."}


def test_parse_goal_judge_output_invalid_is_none():
    assert parse_goal_judge_output("not json at all") is None
    assert parse_goal_judge_output('{"status": "done", "reason": "x"}') is None


def test_chat_request_accepts_goal_turns():
    req = ChatRequest(root="/tmp", prompt="hi", goal="all tests pass", goal_turns=7)
    assert req.goal_turns == 7
    req2 = ChatRequest(root="/tmp", prompt="hi")
    assert req2.goal_turns == 0
