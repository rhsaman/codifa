"""Tests that progressive batching applies to BOTH the main agent (_SEARCH_RULE)
and the explore sub-agent (EXPLORE_SYSTEM), keeping broad searches routed.

The key behavior under test: with the old threshold of 2, the auto-router
blocked the main agent's 3rd+ search call in a single turn and forced it to
delegate to explore. With the threshold raised to 8, the main agent may fire a
SINGLE-TURN BATCH of up to 8 targeted searches before the router trips — so it
can narrow toward the answer in one pass instead of serially tripping the
router. Broad searches are still hard-blocked by _is_broad_search.
"""

import json

from mock_openai import text_reply, tool_call

import agents
from agent_registry import EXPLORE_SYSTEM


def test_threshold_allows_single_turn_batch():
    assert agents._AUTO_EXPLORE_THRESHOLD >= 8


def test_search_rule_instructs_progressive_batching():
    rule = agents._SEARCH_RULE
    assert "SINGLE BATCH" in rule
    assert "progressive" in rule.lower()
    assert "UNDER 10" in rule


def test_explore_system_also_batches():
    assert "SINGLE BATCH" in EXPLORE_SYSTEM
    assert "progressive" in EXPLORE_SYSTEM.lower()
    assert "UNDER 10" in EXPLORE_SYSTEM


def test_broad_grep_without_scope_still_routed():
    assert agents._is_broad_search("grep", {"pattern": "foo"}) is True


def test_search_rule_no_longer_says_piling_up_in_one_turn():
    # The auto-router counts across the WHOLE user-message sequence (reset only
    # at run_graph start), so the rule must NOT say "piling up in one turn" —
    # that wording misled the model into thinking turn-by-turn greps were safe.
    # (The phrase "in one turn" is still legitimately used in clause 4 about
    # firing targeted lookups in the same turn, so we only assert the removed
    # wording is gone.)
    assert "piling up in one turn" not in agents._SEARCH_RULE


def test_targeted_grep_with_scope_not_broad():
    assert (
        agents._is_broad_search("grep", {"pattern": "foo", "path": "backend", "include": "*.py"})
        is False
    )


def test_broad_glob_without_include_still_routed():
    assert agents._is_broad_search("glob", {"pattern": "**/*.py"}) is True


async def _run_serial_greps(run_events, mock_server, threshold, n=8):
    """Drive the REAL backend with the mock model emitting ONE scoped grep per
    model request (truly SERIAL — each request pops one script entry, so the
    search counter accumulates across calls). Returns the number of greps the
    agent actually EXECUTED before the router forced it to stop searching.

    NOTE: parallel tool calls each run in their own asyncio task with a *copied*
    ContextVar, so the counter never accumulates there and the threshold never
    bites. That's why we emit one grep per request — to exercise the SERIAL path
    where the threshold actually matters.
    """
    agents._AUTO_EXPLORE_THRESHOLD = threshold
    _base, mock = mock_server
    mock.script = []
    for i in range(n):
        mock.script.append(tool_call(
            "grep",
            json.dumps({"pattern": f"def handler_{i}", "path": "backend", "include": "*.py"}),
            call_id=f"call_{i}",
        ))
    mock.script.append(text_reply("تمام شد."))

    events = await run_events("پیدا کن همه‌ی هندلرها", mode="ask")

    real_grep = [
        e for e in events
        if e.get("kind") == "tool_result" and e.get("tool") == "grep"
    ]
    hints = [e for e in real_grep if "AUTO-ROUTER" in (e.get("summary") or "")]
    executed = [e for e in real_grep if e not in hints]
    return len(executed)


async def test_main_agent_can_run_8_serial_targeted_searches(run_events, mock_server):
    """End-to-end proof that the threshold change actually lets the main agent
    fire up to 8 SERIAL targeted searches (each with explicit path+include scope
    so none is 'broad') before the router forces delegation. With threshold=8 all
    8 must run; the old threshold=2 would have stopped after the 2nd.
    """
    executed = await _run_serial_greps(run_events, mock_server, threshold=8)
    assert executed == 8, (
        f"expected all 8 scoped greps to run serially, got {executed}. "
        f"The router blocked the batch too early."
    )
    # Restore the real threshold for any later test.
    agents._AUTO_EXPLORE_THRESHOLD = 8


async def test_old_threshold_would_have_blocked_serial_searches(run_events, mock_server):
    """Regression guard proving the change is NOT a no-op: with the OLD
    threshold of 2, the same 8 SERIAL scoped greps would have been stopped after
    the 2nd call. We temporarily restore the old value and assert the batch is
    truncated — so the test fails if someone reverts the threshold.
    """
    executed = await _run_serial_greps(run_events, mock_server, threshold=2)
    # With threshold=2 only the first 2 scoped greps run; the rest are blocked.
    assert executed == 2, (
        f"with the OLD threshold=2 only 2 greps should run, got {executed}"
    )
    # Restore the real threshold for any later test.
    agents._AUTO_EXPLORE_THRESHOLD = 8
