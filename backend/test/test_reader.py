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
import tools
from graph import (
    _ask_needs_repo,
    _explicit_files,
    _in_file_grep,
    _merge_ranges,
    _parse_line_refs,
    _route_ask_entry,
    reader_read,
)


def _make_read(root):
    """Build the real `read` tool bound to ``root`` with a no-op emit."""
    captured = []

    def emit(event):
        captured.append(event)

    cbs = tools.make_tool_callbacks(root, emit)
    return cbs["read"], captured


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


def test_route_ask_answer_for_broad_cue(tmp_path):
    root = _repo(tmp_path)
    # Strong repo cue, but no specific file pointed at -> the agent answers
    # directly and searches itself (OpenCode-style), not a separate derive stage.
    assert (
        _route_ask_entry(
            {"request": "where is the auth function in the repo", "root": root}
        )
        == "ask_answer"
    )


# --- Ask-mode repo cues (path / component / file / definition) ---------------


def test_ask_needs_repo_for_path_component_cues():
    # English: asking for the path / component of something must explore.
    assert _ask_needs_repo("write the exact path of the chat component")
    assert _ask_needs_repo("what file implements the auth module")
    assert _ask_needs_repo("where is the session defined?")
    # Persian: مسیر / کامپوننت must trigger exploration too.
    assert _ask_needs_repo("مسیر دقیق فایل کامپوننت چت را بنویسید")
    assert _ask_needs_repo("کامپوننت چت کجاست")


def test_ask_does_not_need_repo_for_general_knowledge():
    # Conceptual / chit-chat questions must NOT trigger exploration.
    assert not _ask_needs_repo("what is a closure in python?")
    assert not _ask_needs_repo("سلام")


def test_route_ask_entry_path_component_without_file_is_ask_answer(tmp_path):
    root = _repo(tmp_path)
    # A path/component question with NO specific file pointed at is answered by
    # the ask agent itself (it searches via grep/glob/read), not a derive stage.
    assert (
        _route_ask_entry(
            {"request": "write the exact path of the chat component", "root": root}
        )
        == "ask_answer"
    )
    assert (
        _route_ask_entry(
            {"request": "مسیر دقیق فایل کامپوننت چت را بنویسید", "root": root}
        )
        == "ask_answer"
    )


def test_route_ask_entry_followup_reference_uses_history(tmp_path):
    root = _repo(tmp_path)
    # A follow-up that only refers back to a prior answer ("look at the paths
    # you mentioned") must NOT re-explore an empty result; it re-states from
    # the prior answer already in history.
    history = [{"role": "assistant", "content": "it is src/components/Chat.tsx"}]
    assert (
        _route_ask_entry(
            {
                "request": "همون مسیرهاییکه گفتی رو ببین",
                "root": root,
                "history": history,
            }
        )
        == "ask_answer"
    )
    assert (
        _route_ask_entry(
            {
                "request": "look at the paths you mentioned",
                "root": root,
                "history": history,
            }
        )
        == "ask_answer"
    )


def test_route_ask_entry_followup_no_history_falls_to_ask(tmp_path):
    root = _repo(tmp_path)
    # Same follow-up phrasing but with NO prior answer and no searchable entity
    # -> it cannot explore, so it falls back to ask_answer (the agent will ask
    # for clarification) rather than looping on an empty result.
    assert (
        _route_ask_entry(
            {"request": "look at the paths you mentioned", "root": root}
        )
        == "ask_answer"
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


def test_route_plan_understand_broad_builds_plan(tmp_path):
    from graph import _route_plan_understand

    root = _repo(tmp_path)
    # Broad plan question, no specific file -> the planner explores itself via
    # grep/glob/read (OpenCode-style) and builds the plan.
    assert (
        _route_plan_understand(
            {"request": "make a plan for the auth system", "root": root}
        )
        == "plan_build"
    )


def test_route_reader_dispatch_plan_vs_ask():
    from graph import _route_reader_dispatch

    assert _route_reader_dispatch({"mode": "plan"}) == "plan_build"
    assert _route_reader_dispatch({"mode": "ask"}) == "reader_answer"
    assert _route_reader_dispatch({"mode": "reader"}) == "reader_answer"


# --- Helpers ---------------------------------------------------------------

def test_parse_line_refs(tmp_path):
    _repo(tmp_path)
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


# --- read tool: opencode-style format & pagination ------------------------


@pytest.mark.asyncio
async def test_read_file_xml_format(tmp_path):
    f = tmp_path / "a.py"
    f.write_text("alpha\nbeta\ngamma\n")
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py")
    assert "<path>a.py</path>" in out
    assert "<type>file</type>" in out
    assert "<content>" in out
    assert "1 | alpha" in out
    assert "2 | beta" in out
    assert "3 | gamma" in out
    assert "(End of file - total 3 lines)" in out


@pytest.mark.asyncio
async def test_read_file_more_footer(tmp_path):
    f = tmp_path / "a.py"
    f.write_text("".join(f"line{i}\n" for i in range(1, 21)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", offset=1, limit=5)
    assert "(Showing lines 1-5 of 20. Use offset=6 to continue.)" in out
    assert "<path>a.py</path>" in out
    assert "<type>file</type>" in out


@pytest.mark.asyncio
async def test_read_file_cut_footer(tmp_path):
    # Many SHORT lines so the accumulated output crosses the 50 KB byte cap
    # (MAX_READ_EXCERPT_BYTES) well before the line `limit`, exercising the
    # `cut` branch (not `more`). Each line is ~100 bytes; 1000 lines > 50 KB.
    f = tmp_path / "big.py"
    f.write_text("".join(f"x = {i:06d} " + "y" * 80 + "\n" for i in range(1000)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="big.py", offset=1, limit=2000)
    assert "Output capped at" in out
    assert "Use offset=" in out
    assert "(End of file" not in out


@pytest.mark.asyncio
async def test_read_dir_xml_format(tmp_path):
    (tmp_path / "a.py").write_text("a\n")
    (tmp_path / "b.py").write_text("b\n")
    (tmp_path / "sub").mkdir()
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath=".")
    assert "<path>." in out
    assert "<type>directory</type>" in out
    assert "<entries>" in out
    assert "a.py" in out
    assert "b.py" in out
    assert "sub/" in out
    assert "(3 entries)" in out


@pytest.mark.asyncio
async def test_read_tool_caches_and_invalidates_on_edit(tmp_path):
    """A re-read of the same region returns the cached bytes (no re-scan), and
    an edit invalidates the cache so the next read reflects the new content."""
    f = tmp_path / "a.py"
    f.write_text("alpha\nbeta\n")
    root = str(tmp_path)

    captured = []

    def emit(event):
        captured.append(event)

    cbs = tools.make_tool_callbacks(root, emit)
    read = cbs["read"]
    edit_file = cbs["edit_file"]

    r1 = await read(filePath="a.py")
    assert "1 | alpha" in r1 and "2 | beta" in r1
    # Second read of the same path/offset/limit hits the cache (summary "cached").
    r2 = await read(filePath="a.py")
    assert r1 == r2
    assert any(
        e.get("kind") == "tool_result" and e.get("summary") == "cached" for e in captured
    )

    # Edit the file -> cache for a.py is invalidated.
    await edit_file(path="a.py", old_string="alpha", new_string="ALPHA")
    r3 = await read(filePath="a.py")
    assert "1 | ALPHA" in r3
    assert r3 != r1


@pytest.mark.asyncio
async def test_read_dir_paginated_footer(tmp_path):
    for i in range(5):
        (tmp_path / f"f{i}.py").write_text("x\n")
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath=".", offset=1, limit=2)
    assert "Showing 2 of 5 entries" in out
    assert "Use 'offset' parameter to read beyond entry 2" in out
