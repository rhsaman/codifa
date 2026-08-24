"""Tests that the SEARCH STRATEGY prompt disambiguates the two meanings of
'parallel' so a weak model does not mistake several direct read/grep calls in
one turn for the parallel exploration (multiple explore sub-agents) we ask for.

Regression guard for the bug where the model fired several direct read/grep
calls in a single turn and labelled it "parallel reading", believing it had
already done the broad exploration and therefore skipping the explore agent.
"""

import pytest

from agents import _SEARCH_RULE, _DOING_TASKS, _DISCOVERY_BLOCK


def test_search_rule_names_both_parallel_meanings():
    # Clause 2 (broad) must be framed as multiple SUB-AGENTS, not direct reads.
    assert "explore SUB-AGENTS" in _SEARCH_RULE
    # Clause 4 (targeted) must be framed as DIRECT tools.
    assert "DIRECT tools" in _SEARCH_RULE


def test_search_rule_has_disambiguation_note():
    # The NOTE must spell out that 'parallel' has two distinct meanings and that
    # broad searches MUST use sub-agents, not parallel direct reads.
    assert "'parallel' has TWO distinct meanings" in _SEARCH_RULE
    assert "TARGETED lookups" in _SEARCH_RULE
    assert "BROAD / multi-file" in _SEARCH_RULE
    # Explicitly states parallel direct reads do NOT count as the exploration.
    assert "does NOT count as the parallel exploration" in _SEARCH_RULE


def test_doing_tasks_limits_parallel_to_targeted():
    # The parallel-tool-calls instruction must be scoped to TARGETED searches
    # and must still point broad work at explore sub-agents.
    assert "TARGETED search" in _DOING_TASKS
    assert "parallel tool calls" in _DOING_TASKS
    assert "explore sub-agents in parallel" in _DOING_TASKS


def test_discovery_block_limits_parallel_to_targeted():
    assert "TARGETED search" in _DISCOVERY_BLOCK
    assert "parallel tool calls" in _DISCOVERY_BLOCK
    assert "explore sub-agents in parallel" in _DISCOVERY_BLOCK


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
