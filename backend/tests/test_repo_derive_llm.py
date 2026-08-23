"""Tests for the LLM-powered repo_derive search planner.

Covers:
* the JSON extraction / list helpers,
* the single-call planner (happy path + fallback on error/garbage),
* `repo_grep` folding planner "queries" into phrase-grep,
* `repo_collect` ranking the backfill by "queries".
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import graph
from graph import _as_list, _extract_json_object, repo_collect, repo_derive, repo_grep


def _q():
    return asyncio.Queue()


# --- helpers ---------------------------------------------------------------

def test_as_list_coerces():
    assert _as_list(None) == []
    assert _as_list("") == []
    assert _as_list("x") == ["x"]
    assert _as_list(["a", "a", "b", 1]) == ["a", "b", "1"]


def test_extract_json_object_robust():
    assert _extract_json_object(None) is None
    assert _extract_json_object("no json here") is None
    # plain
    assert _extract_json_object('{"a":1}') == {"a": 1}
    # fenced
    fenced = '```json\n{"globs":["**/a.py"],"keywords":["x"],"queries":["q"]}\n```'
    assert _extract_json_object(fenced) == {
        "globs": ["**/a.py"], "keywords": ["x"], "queries": ["q"],
    }
    # prose-wrapped
    prose = 'Sure! {"queries":["auth timeout"],"globs":[],"keywords":[]} done'
    assert _extract_json_object(prose) == {
        "queries": ["auth timeout"], "globs": [], "keywords": [],
    }


# --- planner call ----------------------------------------------------------

async def test_llm_derive_happy_path():
    payload = (
        '{"queries":["authentication timeout"],'
        '"globs":["**/*auth*"],"keywords":["session","token"]}'
    )
    with patch.object(graph, "llm_generate", new=AsyncMock(return_value=(payload, None))):
        spec = await graph._llm_derive_explore_patterns("find auth", "tree", MagicMock())
    assert spec == {
        "glob": ["**/*auth*"],
        "grep": ["session", "token"],
        "queries": ["authentication timeout"],
    }


async def test_llm_derive_returns_none_on_garbage():
    with patch.object(graph, "llm_generate", new=AsyncMock(return_value=("not json", None))):
        assert await graph._llm_derive_explore_patterns("x", "t", MagicMock()) is None


async def test_llm_derive_returns_none_on_raise():
    with patch.object(graph, "llm_generate", new=AsyncMock(side_effect=RuntimeError("boom"))):
        assert await graph._llm_derive_explore_patterns("x", "t", MagicMock()) is None


async def test_repo_derive_uses_llm_then_falls_back_on_error(tmp_path):
    # LLM raises -> deterministic fallback (queries mirror grep).
    state = {
        "_queue": _q(),
        "request": "where is auth handled",
        "root": str(tmp_path),
        "provider": "openai", "model_name": "x", "base_url": "",
        "api_key": "", "env_var": "", "oauth_token": "",
    }
    with patch.object(graph, "build_chat_model", new=MagicMock(return_value=MagicMock())), \
         patch.object(graph, "llm_generate", new=AsyncMock(side_effect=RuntimeError("boom"))):
        res = await repo_derive(state)
    spec = res["search_spec"]
    # fallback present and well-formed
    assert set(spec) >= {"glob", "grep", "queries"}
    assert spec["queries"] == spec["grep"]


async def test_repo_derive_uses_llm_when_ok(tmp_path):
    payload = (
        '{"queries":["login timeout"],"globs":["**/login.py"],'
        '"keywords":["expires"]}'
    )
    state = {
        "_queue": _q(),
        "request": "find login timeout logic",
        "root": str(tmp_path),
        "provider": "openai", "model_name": "x", "base_url": "",
        "api_key": "", "env_var": "", "oauth_token": "",
    }
    with patch.object(graph, "build_chat_model", new=MagicMock(return_value=MagicMock())), \
         patch.object(graph, "llm_generate", new=AsyncMock(return_value=(payload, None))):
        res = await repo_derive(state)
    spec = res["search_spec"]
    # The LLM spec is merged with the deterministic heuristic (semantic globs +
    # keyword greps) for recall, so we assert the LLM outputs are present rather
    # than exact equality.
    assert "**/login.py" in spec["glob"]
    assert "expires" in spec["grep"]
    assert "login timeout" in spec["queries"]


# --- consumer wiring -------------------------------------------------------

async def test_repo_grep_uses_only_keywords_not_queries(tmp_path):
    # `queries` are natural-language phrases for RANKING, not valid grep
    # regexes — feeding them in as grep patterns yields weak/wrong matches.
    # Only the structured `keywords` (grep) field is grepped.
    state = {
        "_queue": _q(),
        "root": str(tmp_path),
        "search_spec": {
            "glob": [], "grep": ["session"], "queries": ["auth timeout"],
        },
    }
    with patch.object(graph, "_make_explore_tools", new=MagicMock(return_value={})), \
         patch.object(graph, "_run_repo_tool", new=AsyncMock(return_value="")):
        await repo_grep(state)
    patterns = []
    while not state["_queue"].empty():
        ev = state["_queue"].get_nowait()
        if ev.get("kind") == "tool" and ev.get("tool") == "grep":
            patterns.append(ev["args"]["pattern"])
    assert "session" in patterns
    assert "auth timeout" not in patterns


async def test_repo_collect_ranks_by_queries(tmp_path):
    (tmp_path / "auth_login.py").write_text("def login(): pass\n")
    (tmp_path / "util.py").write_text("def helper(): pass\n")
    state = {
        "_queue": _q(),
        "root": str(tmp_path),
        "request": "",
        "search_spec": {"glob": [], "grep": [], "queries": ["auth login"]},
        "explore_glob": [],
        "explore_grep": [],
    }
    res = await repo_collect(state)
    cands = res["candidate_files"]
    assert cands[0] == "auth_login.py"


async def test_repo_collect_ranks_by_request_when_no_queries(tmp_path):
    (tmp_path / "auth_login.py").write_text("def login(): pass\n")
    (tmp_path / "util.py").write_text("def helper(): pass\n")
    state = {
        "_queue": _q(),
        "root": str(tmp_path),
        "request": "auth login flow",
        # grep present so the backfill is allowed (empty spec => ask, not rank);
        # rank_text then falls back to the request and ranks auth_login.py first
        "search_spec": {"glob": [], "grep": ["login"], "queries": []},
        "explore_glob": [],
        "explore_grep": [],
    }
    res = await repo_collect(state)
    assert res["candidate_files"][0] == "auth_login.py"
