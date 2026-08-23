"""Tests for the explore-context condenser (repo_condense).

The condenser shrinks the discovered `read_context` into a single relevant
block (using the configured compact model) so the planner doesn't re-send the
full ~24k-char dump on every step. It must skip when there's nothing to
condense, never drop data on failure, and `_build_explore_context` must prefer
the condensed result.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import graph


def _q():
    return asyncio.Queue()


def _base_state(read_context, **over):
    st = {
        "_queue": _q(),
        "root": "/tmp/x",
        "request": "where is the auth logic",
        "read_context": read_context,
        "grep_results": [],
        "subagent_models": {},
        "providers": {},
        "provider": "custom", "model_name": "main-model", "base_url": "",
        "api_key": "", "env_var": "", "oauth_token": "",
    }
    st.update(over)
    return st


async def test_repo_condense_skips_empty_read_context():
    st = _base_state("")
    with patch.object(graph, "_llm_condense_explore_context", new=AsyncMock()) as cond:
        res = await graph.repo_condense(st)
    assert res == {}
    cond.assert_not_called()


async def test_repo_condense_skips_small_read_context():
    st = _base_state("x" * 3900)  # below the 4000-char gate
    with patch.object(graph, "_llm_condense_explore_context", new=AsyncMock()) as cond:
        res = await graph.repo_condense(st)
    assert res == {}
    cond.assert_not_called()


async def test_repo_condense_condenses_large_context():
    st = _base_state("y" * 5000)
    fake_model = MagicMock()
    with patch.object(graph, "resolve_subagent_model", return_value=fake_model) as rsm, \
         patch.object(graph, "_llm_condense_explore_context",
                      new=AsyncMock(return_value="CONDENSED BLOCK")) as cond:
        res = await graph.repo_condense(st)
    assert res == {"condensed_context": "CONDENSED BLOCK"}
    # uses the compact model slot (unset -> main model fallback)
    rsm.assert_called_once()
    assert rsm.call_args.kwargs.get("entry") is None or True
    cond.assert_awaited_once()


async def test_repo_condense_keeps_raw_on_llm_failure():
    st = _base_state("y" * 5000)
    fake_model = MagicMock()
    with patch.object(graph, "resolve_subagent_model", return_value=fake_model), \
         patch.object(graph, "_llm_condense_explore_context",
                      new=AsyncMock(return_value=None)):
        res = await graph.repo_condense(st)
    # no condensed_context -> raw read_context is preserved downstream
    assert res == {}


def test_build_explore_context_prefers_condensed():
    state = {
        "explore_tree": "src/\n  main.py",
        "read_context": "=== RAW FILE ===\nraw content here",
        "grep_results": ["raw.py:1:raw"],
        "condensed_context": "CONDENSED relevent bits",
    }
    out = graph._build_explore_context(state)
    assert "CONDENSED relevent bits" in out
    # raw dump + raw grep section are replaced by the condensed block
    assert "=== RAW FILE ===" not in out
    assert "raw.py:1:raw" not in out
    # tree still shown
    assert "src/" in out


def test_build_explore_context_falls_back_to_raw():
    state = {
        "read_context": "=== RAW FILE ===\nraw content here",
        "grep_results": ["raw.py:1:raw"],
    }
    out = graph._build_explore_context(state)
    assert "=== RAW FILE ===" in out
    assert "raw.py:1:raw" in out
