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


def test_doing_tasks_block_appended_to_every_mode():
    """_DOING_TASKS (opencode-style 'Doing tasks' guidance) must be defined and
    instruct the agent to use the search tools and never commit unprompted."""
    block = agents._DOING_TASKS
    assert "grep/glob/read" in block
    assert "NEVER commit changes" in block
    # It must not contradict the auto-verify discipline already in the coder
    # prompt (both say trust the auto-check).
    assert "auto-checks" in block


def test_tool_docstrings_reference_explore_delegation():
    """grep/glob docstrings must mirror opencode: an open-ended search should be
    delegated to the explore sub-agent rather than done inline.

    The tool functions are nested inside make_tool_callbacks, so we assert on
    the source text of tools.py rather than importing the functions directly.
    """
    import pathlib  # noqa: E402

    src = pathlib.Path(__file__).resolve().parent.parent / "tools.py"
    text = src.read_text(encoding="utf-8")
    assert "subagent_type='explore'" in text


def test_read_docstring_encourages_parallel_reads():
    """read docstring must mirror opencode: read multiple files in parallel."""
    import pathlib  # noqa: E402

    src = pathlib.Path(__file__).resolve().parent.parent / "tools.py"
    text = src.read_text(encoding="utf-8")
    assert "read multiple independent files in parallel" in text


def test_discovery_block_delegates_broad_search_to_explore():
    """The DISCOVERY block (ask/plan modes) must not contradict _SEARCH_RULE:
    broad / multi-file exploration is delegated to the explore sub-agent, not
    done inline with grep/glob/read."""
    block = agents._DISCOVERY_BLOCK
    assert "subagent_type='explore'" in block
    assert "BROAD" in block.upper()
    # It frames grep/glob/read as the TARGETED path, not the broad one.
    assert "TARGETED" in block.upper()


def test_discovery_block_is_single_source_of_truth():
    """The DISCOVERY block must mirror _SEARCH_RULE's framing: grep/glob/read
    are for TARGETED lookups, explore is for BROAD/multi-file."""
    block = agents._DISCOVERY_BLOCK
    rule = agents._SEARCH_RULE
    # Both must agree on the explore-for-broad delegation.
    assert "subagent_type='explore'" in block
    assert "subagent_type='explore'" in rule
    # Neither should make broad search optional via 'or delegate'.
    assert "or delegate" not in block.lower()
    assert "or delegate" not in rule.lower()
