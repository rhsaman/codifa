"""Reader agent: routes explicitly-specified files (attachment / open Neovim
file / a named file in the message) to a dedicated read-only agent that reads
ONLY the needed parts -- deterministically, with NO repo-wide glob/grep and NO
extra LLM calls (the answer is a single LLM call, like Explore's final step).

Covers routing, the deterministic targeted-read pipeline, and its helpers.
"""

import asyncio
import os

import pytest

import graph
from graph import (
    _explicit_files,
    _in_file_grep,
    _merge_ranges,
    _parse_line_refs,
    _route_ask_entry,
    reader_read,
)


def _repo(tmp_path):
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "graph.py").write_text("x = 1\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export default function App(){}\n")
    (tmp_path / "a.py").write_text("a = 1\n")
    (tmp_path / "b.py").write_text("b = 2\n")
    return str(tmp_path)


# --- Routing ---------------------------------------------------------------

def test_route_reader_for_attachment(tmp_path):
    root = _repo(tmp_path)
    assert (
        _route_ask_entry(
            {"request": "explain this", "attachments": ["backend/graph.py"], "root": root}
        )
        == "reader"
    )


def test_route_reader_for_nvim(tmp_path):
    root = _repo(tmp_path)
    assert (
        _route_ask_entry(
            {"request": "explain this", "nvim_file": "backend/graph.py", "root": root}
        )
        == "reader"
    )


def test_route_reader_for_named_file(tmp_path):
    root = _repo(tmp_path)
    assert (
        _route_ask_entry({"request": "explain backend/graph.py", "root": root})
        == "reader"
    )


def test_route_reader_for_multiple_files(tmp_path):
    root = _repo(tmp_path)
    files = _explicit_files(
        {"request": "compare a.py and b.py", "attachments": ["a.py"], "root": root}
    )
    assert "a.py" in files and "b.py" in files


def test_route_ask_for_plain_chat(tmp_path):
    root = _repo(tmp_path)
    assert _route_ask_entry({"request": "سلام", "root": root}) == "ask_answer"


def test_route_repo_derive_for_broad_cue(tmp_path):
    root = _repo(tmp_path)
    # Strong repo cue, no specific file named -> full Explore discovery.
    assert (
        _route_ask_entry(
            {"request": "where is the auth function in the repo", "root": root}
        )
        == "repo_derive"
    )


# --- Plan-mode routing (reader when a specific file is pointed at) ---------

def test_route_plan_understand_reader_for_attachment(tmp_path):
    from graph import _route_plan_understand

    root = _repo(tmp_path)
    assert (
        _route_plan_understand(
            {"request": "plan this", "attachments": ["backend/graph.py"], "root": root}
        )
        == "reader_read"
    )


def test_route_plan_understand_reader_for_named_file(tmp_path):
    from graph import _route_plan_understand

    root = _repo(tmp_path)
    assert (
        _route_plan_understand(
            {"request": "plan a refactor of backend/graph.py", "root": root}
        )
        == "reader_read"
    )


def test_route_plan_understand_repo_derive_broad(tmp_path):
    from graph import _route_plan_understand

    root = _repo(tmp_path)
    # Broad plan question, no specific file -> full repo discovery.
    assert (
        _route_plan_understand(
            {"request": "make a plan for the auth system", "root": root}
        )
        == "repo_derive"
    )


def test_route_reader_dispatch_plan_vs_ask():
    from graph import _route_reader_dispatch

    assert _route_reader_dispatch({"mode": "plan"}) == "plan_build"
    assert _route_reader_dispatch({"mode": "ask"}) == "reader_answer"
    assert _route_reader_dispatch({"mode": "reader"}) == "reader_answer"


# --- Helpers ---------------------------------------------------------------

def test_parse_line_refs(tmp_path):
    root = _repo(tmp_path)
    refs = _parse_line_refs(
        "look at backend/graph.py:42 and src/App.tsx#L10-15",
        ["backend/graph.py", "src/App.tsx"],
    )
    assert refs["backend/graph.py"] == [(42, None)]
    assert refs["src/App.tsx"] == [(10, 15)]


def test_in_file_grep(tmp_path):
    root = _repo(tmp_path)
    import re

    f = os.path.join(root, "backend", "graph.py")
    with open(f, "w") as fh:
        fh.write("alpha\nbeta TARGET gamma\ndelta\n")
    nums = _in_file_grep(root, "backend/graph.py", [re.compile("TARGET")])
    assert nums == {2}


def test_merge_ranges():
    assert _merge_ranges([(1, 5), (3, 8), (20, 25)]) == [(1, 8), (20, 25)]
    assert _merge_ranges([]) == []


# --- Targeted read (no whole-file dump) ------------------------------------

@pytest.mark.asyncio
async def test_reader_read_targets_only_matching_lines(tmp_path, monkeypatch):
    (tmp_path / "backend").mkdir()
    f = tmp_path / "backend" / "graph.py"
    lines = [f"line{i}\n" for i in range(1, 101)]
    lines[49] = "def TARGET_FUNCTION():\n"  # line 50
    f.write_text("".join(lines))
    root = str(tmp_path)

    def fake_read(filePath, offset=1, limit=2000):
        target = os.path.join(root, filePath)
        with open(target) as fh:
            all_lines = fh.readlines()
        return "".join(all_lines[offset - 1 : offset - 1 + limit])

    # Bypass model construction; the reader pipeline only needs the read tool.
    monkeypatch.setattr(graph, "_make_explore_tools", lambda state, queue: {"read": fake_read})

    q = asyncio.Queue()
    state = {
        "_queue": q,
        "root": root,
        "provider": "openai",
        "model_name": "x",
        "base_url": "",
        "api_key": "",
        "env_var": "",
        "oauth_token": "",
        "request": "explain TARGET_FUNCTION in backend/graph.py",
    }
    result = await reader_read(state)
    ctx = result["read_context"]
    assert "TARGET_FUNCTION" in ctx
    # A bounded window around the match -- NOT the whole 100-line file.
    assert ctx.count("\n") < 100
    assert "line1\n" not in ctx  # far-away lines are excluded


@pytest.mark.asyncio
async def test_reader_read_line_ref_window(tmp_path, monkeypatch):
    (tmp_path / "backend").mkdir()
    f = tmp_path / "backend" / "graph.py"
    f.write_text("".join(f"line{i}\n" for i in range(1, 101)))
    root = str(tmp_path)

    def fake_read(filePath, offset=1, limit=2000):
        target = os.path.join(root, filePath)
        with open(target) as fh:
            all_lines = fh.readlines()
        return "".join(all_lines[offset - 1 : offset - 1 + limit])

    monkeypatch.setattr(graph, "_make_explore_tools", lambda state, queue: {"read": fake_read})

    q = asyncio.Queue()
    state = {
        "_queue": q,
        "root": root,
        "provider": "openai",
        "model_name": "x",
        "base_url": "",
        "api_key": "",
        "env_var": "",
        "oauth_token": "",
        "request": "show backend/graph.py:50",
    }
    result = await reader_read(state)
    assert "--- backend/graph.py:20-80 ---" in result["read_context"]
