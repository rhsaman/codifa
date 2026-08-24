"""Unit test: the search-strategy prompt is unified across all modes.

Two bugs were fixed:
1. `_SEARCH_RULE` (the authoritative "BROAD/multi-file -> use explore" rule)
   was gated behind `if mode not in ("coder","ask","plan","reader")` in
   graph.py, so it never reached any default mode. Now it is appended to
   every mode.
2. The per-mode prompts and `_MODE_CAPS` repeated a weak "or delegate broad
   exploration to the Explore sub-agent" clause with the word `or`, making
   delegation optional. Those duplicate clauses were removed so `_SEARCH_RULE`
   is the single source of truth (it makes broad/multi-file delegation the
   required path, grep/glob/read only for targeted lookups).
"""

import sys
import os

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agents  # noqa: E402


def test_search_rule_makes_broad_exploration_required():
    """_SEARCH_RULE must instruct broad/multi-file search to use explore."""
    rule = agents._SEARCH_RULE
    assert "subagent_type='explore'" in rule
    assert "BROAD" in rule.upper()
    # It frames grep/glob/read as the TARGETED path, not the broad one.
    assert "TARGETED" in rule.upper()


def test_no_duplicate_delegate_clause_in_mode_prompts():
    """Per-mode prompts must not repeat the weak 'or delegate' clause."""
    for mode, prompt in agents.SYSTEM_PROMPTS.items():
        assert "delegate broad exploration" not in prompt, (
            f"{mode} prompt still has the duplicate delegate clause"
        )


def test_no_duplicate_delegate_clause_in_mode_caps():
    """_MODE_CAPS must not repeat the weak 'or delegate' clause."""
    for mode, caps in agents._MODE_CAPS.items():
        assert "delegate" not in caps, (
            f"{mode} caps still reference delegation"
        )


def test_search_rule_is_the_single_source_of_truth():
    """No mode prompt should contradict _SEARCH_RULE by re-allowing broad
    search directly (the word 'or delegate' implied that)."""
    for mode, prompt in agents.SYSTEM_PROMPTS.items():
        # The only place 'explore' should appear in a mode prompt now is the
        # explore agent's own registry prompt, not the parent mode prompts.
        assert "delegate broad exploration" not in prompt
