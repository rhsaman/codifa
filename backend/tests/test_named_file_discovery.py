"""Named-file discovery: when the user references a real file (in the current
message OR an earlier turn), it must be force-included in the Explore read set
even if the LLM planner misses it -- without adding LLM calls.

Pure-logic + targeted repo_derive tests, PLUS one full end-to-end test that runs
the REAL graph (router -> ask_entry -> repo_derive -> glob -> grep -> read ->
ask_answer) through the mock LLM, reproducing the exact "graph.py was missed"
transcript.
"""

import asyncio

import pytest

import graph
from graph import _resolve_file_refs, _route_ask_entry, repo_derive


def _make_repo(tmp_path):
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "graph.py").write_text("def route():\n    pass\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export default function App(){}\n")
    return str(tmp_path)


def _request_contains(captured, needle):
    for body in captured:
        for msg in body.get("messages") or []:
            content = msg.get("content")
            if isinstance(content, str) and needle in content:
                return True
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and needle in (part.get("text") or ""):
                        return True
    return False


def test_resolve_file_refs_finds_file_named_in_history(tmp_path):
    root = _make_repo(tmp_path)
    # current request has NO path; a PRIOR turn named graph.py
    refs = _resolve_file_refs(
        ["خودت برو کد رو ببین", "فایل backend/graph.py رو نگاه کن"], root
    )
    assert "backend/graph.py" in refs


def test_resolve_file_refs_ignores_nonexistent_and_prose(tmp_path):
    root = _make_repo(tmp_path)
    refs = _resolve_file_refs(
        ["open foo.bar and v1.2 then backend/graph.py"], root
    )
    assert "backend/graph.py" in refs
    assert "foo.bar" not in refs  # not a real file
    assert "v1.2" not in refs


def test_resolve_file_refs_empty_when_no_file_mentioned(tmp_path):
    root = _make_repo(tmp_path)
    assert _resolve_file_refs(["سلام", "چطوری؟"], root) == []


def test_route_ask_entry_triggers_repo_derive_for_referenced_file(tmp_path):
    root = _make_repo(tmp_path)
    # "ببینش" alone has no project cue, but graph.py was named earlier.
    state = {
        "request": "ببینش",
        "history": [{"role": "user", "content": "فایل backend/graph.py رو نشون بده"}],
        "root": root,
    }
    assert _route_ask_entry(state) == "repo_derive"
    # No reference and not project-related -> straight to ask_answer.
    assert _route_ask_entry({"request": "سلام", "history": [], "root": root}) == "ask_answer"


@pytest.mark.asyncio
async def test_repo_derive_forces_named_file_into_spec(tmp_path, monkeypatch):
    root = _make_repo(tmp_path)
    # LLM planner returns a frontend-focused spec that OMITS graph.py (the bug).
    monkeypatch.setattr(graph, "build_chat_model", lambda *a, **k: None)
    monkeypatch.setattr(
        graph,
        "_llm_derive_explore_patterns",
        lambda *a, **k: {
            "glob": ["**/*.tsx"],
            "grep": ["frontend"],
            "queries": ["frontend"],
        },
    )
    q = asyncio.Queue()
    state = {
        "_queue": q,
        "provider": "openai",
        "model_name": "x",
        "base_url": "",
        "api_key": "",
        "env_var": "",
        "oauth_token": "",
        "root": root,
        "request": "خودت برو کد رو ببین",
        "history": [{"role": "user", "content": "فایل backend/graph.py رو نشون بده"}],
    }
    result = await repo_derive(state)
    assert "backend/graph.py" in result["search_spec"]["glob"]
    assert result["named_files"] == ["backend/graph.py"]


@pytest.mark.asyncio
async def test_ask_end_to_end_reads_named_file_from_history(run_events, workspace):
    """Reproduces the real transcript: graph.py is named in an EARLIER turn, the
    current message ('خودت برو کد رو ببین') has no path. The agent must read the
    file and receive its content -- NOT refuse with 'I can't read files'."""
    (workspace / "backend").mkdir()
    (workspace / "backend" / "graph.py").write_text(
        "def route():\n    return 'GRAPH_MARKER_XYZ'\n", encoding="utf-8"
    )
    from mock_openai import mock as _mock, text_reply

    _mock.script = [text_reply("here is the answer about the graph")]
    events = await run_events(
        "خودت برو کد رو ببین",
        history=[{"role": "user", "content": "فایل backend/graph.py رو نشون بده"}],
        mode="ask",
    )

    read_events = [e for e in events if e.get("kind") == "tool" and e.get("tool") == "read"]
    assert any(
        e.get("args", {}).get("filePath") == "backend/graph.py" for e in read_events
    ), read_events
    # The file's content must reach the agent's context (no refusal).
    assert _request_contains(_mock.captured, "GRAPH_MARKER_XYZ")
