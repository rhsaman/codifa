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
    # Single reads run the batch pipeline: compact position marker + one
    # shared footer instead of the old per-read guidance footers.
    assert "(a.py: lines 1-3 of 3)" in out
    assert "Batch complete" in out


@pytest.mark.asyncio
async def test_read_file_more_footer(tmp_path):
    # File over _SMALL_FILE_LINES so the `more` branch applies (small files
    # come back whole). Plain lines carry no block boundary, so the window
    # is exactly limit lines and the footer points at symbols=/ranges=.
    f = tmp_path / "a.py"
    f.write_text("".join(f"line{i}\n" for i in range(1, 401)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", offset=1, limit=5)
    assert "(a.py: lines 1-5 of 400)" in out
    assert "Batch complete" in out
    assert "Use offset=" not in out
    assert "<path>a.py</path>" in out
    assert "<type>file</type>" in out


@pytest.mark.asyncio
async def test_read_small_file_returns_whole(tmp_path):
    # Files at or under _SMALL_FILE_LINES come back whole from the offset:
    # one read instead of offset/limit paging across round-trips.
    f = tmp_path / "a.py"
    f.write_text("".join(f"line{i}\n" for i in range(1, 21)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", offset=1, limit=5)
    assert "1 | line1" in out
    assert "20 | line20" in out
    assert "(a.py: lines 1-20 of 20)" in out
    assert "Batch complete" in out


@pytest.mark.asyncio
async def test_read_file_cut_footer(tmp_path):
    # Bulk head read of a 1000-line file serves a file map instead of a
    # capped dump: structure first, content via symbols=/ranges=.
    # (Many SHORT lines: ~100 bytes each, 1000 lines > 50 KB.)
    f = tmp_path / "big.py"
    f.write_text("".join(f"x = {i:06d} " + "y" * 80 + "\n" for i in range(1000)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="big.py", offset=1, limit=2000)
    assert "file map" in out
    assert "has 1000 lines" in out
    assert "no indexable symbols" in out
    assert "read exact ranges" in out
    # The byte-cap branch itself still fires for non-head windows, but
    # batch members carry only the compact position marker — the paging
    # guidance lives once in the shared footer, not per block.
    out2 = await read(filePath="big.py", offset=200, limit=2000)
    assert "(big.py: lines" in out2
    assert "Batch complete" in out2
    assert "Output capped at" not in out2
    assert "Use offset=" not in out2
    assert "(End of file" not in out2


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
    """An unchanged re-read re-serves identical bytes (via the byte cache),
    and an edit invalidates everything so the next read reflects the new
    content."""
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
    # Second read of the same path/offset/limit: file unchanged -> the full
    # content is served again (summary "cached").
    r2 = await read(filePath="a.py")
    assert r1 == r2
    assert "1 | alpha" in r2, r2
    assert any(
        e.get("kind") == "tool_result" and e.get("summary") == "cached" for e in captured
    )

    # Edit the file -> cache for a.py is invalidated.
    await edit_file(path="a.py", old_string="alpha", new_string="ALPHA")
    r3 = await read(filePath="a.py")
    assert "1 | ALPHA" in r3
    assert r3 != r1


@pytest.mark.asyncio
async def test_read_cache_invalidates_across_path_spellings(tmp_path):
    """Invalidation must match regardless of how the model spells the path.

    The read cache is keyed by the normalized absolute path, so editing the
    same file via a different spelling (e.g. ``./a.py`` instead of ``a.py``)
    must still drop the cached entry — otherwise a re-read would return stale
    bytes. This guards the latent bug where a raw-string key would miss the
    mismatch and serve old content after an edit.
    """
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
    assert "1 | alpha" in r1
    # Same path, different spelling -> the full content is served again.
    r2 = await read(filePath="./a.py")
    assert "1 | alpha" in r2, r2
    assert any(
        e.get("kind") == "tool_result" and e.get("summary") == "cached" for e in captured
    )

    # Edit using the alternate spelling -> cache must be invalidated.
    await edit_file(path="./a.py", old_string="alpha", new_string="ALPHA")
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


@pytest.mark.asyncio
async def test_read_ranges_per_path_windows(tmp_path):
    """ranges=['path:offset:limit', ...] → هر فایل با پنجره‌ی خودش در یک فراخوانی.

    رگرسیونِ مصرف توکن: قبلاً مدل برای هر بازه‌ی متفاوت یک read جدا می‌زد
    (هر کدام کل مکالمه را دوباره به API می‌فرستاد). حالا یک فراخوانی با
    ranges همه‌ی پنجره‌ها را برمی‌گرداند.
    """
    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 401)))
    (tmp_path / "b.py").write_text("".join(f"other{i}\n" for i in range(1, 401)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(
        filePath="a.py",
        ranges=["a.py:10:5", "b.py:20:3"],
    )
    # هر دو فایل در همان خروجی واحد هستند.
    assert "<path>a.py</path>" in out
    assert "<path>b.py</path>" in out
    # پنجره‌ی اختصاصی هر فایل اعمال شده (نه offset/limit سراسری).
    assert "10 | line10" in out
    assert "14 | line14" in out
    assert "15 | line15" not in out  # limit=5 → خطوط 10-14
    assert "20 | other20" in out
    assert "22 | other22" in out
    assert "23 | other23" not in out  # limit=3 → خطوط 20-22


@pytest.mark.asyncio
async def test_read_ranges_same_file_two_windows(tmp_path):
    """رگرسیون تصویر: ranges تکراری هم‌فایل (tools.py با 640:60 و 2089:80)
    باید هر دو بازه را برگرداند — نه فقط آخری (رفع collapse روی dict)."""
    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 401)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", ranges=["a.py:10:5", "a.py:30:5"])
    # هر دو بازه در همان خروجی واحد هستند.
    assert "10 | line10" in out
    assert "14 | line14" in out
    assert "30 | line30" in out
    assert "34 | line34" in out
    # مرزهای هر بازه رعایت شده‌اند.
    assert "15 | line15" not in out
    assert "35 | line35" not in out


@pytest.mark.asyncio
async def test_edit_file_batch_applies_all_edits_atomically(tmp_path):
    """چند ویرایش هم‌فایل در یک فراخوانی edit_file با edits=[...] — یک
    checkpoint/diff/verify به‌جای N راندتریپ ترتیبی؛ خطا در هر عضو یعنی
    هیچ‌چیز نوشته نمی‌شود (atomic)."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    root = str(tmp_path)
    captured: list[dict] = []

    def emit(event: dict) -> None:
        captured.append(event)

    cbs = tools.make_tool_callbacks(root, emit)
    out = await cbs["edit_file"](
        path="a.py",
        edits=[
            {"old_string": "alpha", "new_string": "ALPHA"},
            {"old_string": "gamma", "new_string": "GAMMA"},
        ],
    )
    assert "2 edits" in out
    assert (tmp_path / "a.py").read_text() == "ALPHA\nbeta\nGAMMA\n"
    # فقط یک diff برای کل بچ (نه یکی به‌ازای هر ویرایش).
    assert sum(1 for e in captured if e.get("kind") == "diff") == 1
    # عضو نامعتبر → هیچ‌چیز نوشته نمی‌شود.
    (tmp_path / "b.py").write_text("one\ntwo\n")
    out2 = await cbs["edit_file"](
        path="b.py",
        edits=[
            {"old_string": "one", "new_string": "ONE"},
            {"old_string": "missing", "new_string": "X"},
        ],
    )
    assert out2.startswith("ERROR")
    assert (tmp_path / "b.py").read_text() == "one\ntwo\n"


@pytest.mark.asyncio
async def test_edit_file_batch_accepts_json_string_edits(tmp_path):
    """مدل گاهی edits را به‌صورت رشته‌ی JSON (نه لیست واقعی) می‌فرستد —
    بدون coerce شدن، رشته به کاراکترها شکسته می‌شد و خطای گمراه‌کننده‌ی
    «edit 1/N: must be an object» (با N برابر طول رشته!) برمی‌گشت."""
    import json

    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    root = str(tmp_path)
    cbs = tools.make_tool_callbacks(root, lambda event: None)
    payload = json.dumps([
        {"old_string": "alpha", "new_string": "ALPHA"},
        {"old_string": "gamma", "new_string": "GAMMA"},
    ])
    # کل لیست به‌صورت یک رشته‌ی JSON
    out = await cbs["edit_file"](path="a.py", edits=payload)
    assert "2 edits" in out
    assert (tmp_path / "a.py").read_text() == "ALPHA\nbeta\nGAMMA\n"
    # آیتم‌هایی که خودشان رشته‌ی JSON‌اند
    (tmp_path / "b.py").write_text("one\ntwo\n")
    out2 = await cbs["edit_file"](
        path="b.py",
        edits=[json.dumps({"old_string": "one", "new_string": "ONE"})],
    )
    assert "Successfully edited" in out2
    assert (tmp_path / "b.py").read_text() == "ONE\ntwo\n"


@pytest.mark.parametrize(
    "old_string,new_string,expected",
    [
        # old copied WITH the read tool's "NNN | " prefixes.
        ("1 | alpha\n2 | beta", "ALPHA\nBETA", "ALPHA\nBETA\ngamma\n"),
        # stray trailing whitespace / CRLF in the copied old.
        ("alpha  \nbeta", "ALPHA\nBETA", "ALPHA\nBETA\ngamma\n"),
        # grep-style "file:line: " prefix.
        ("a.py:1: alpha", "ALPHA", "ALPHA\nbeta\ngamma\n"),
        # grep match marker "> N | " copied from context lines.
        ("> 1 | alpha\n  2 | beta", "ALPHA\nBETA", "ALPHA\nBETA\ngamma\n"),
        # grep enclosing-symbol annotation "in Name (L..)" after file:line.
        (
            "a.py:1: in foo (L1-3):alpha",
            "ALPHA",
            "ALPHA\nbeta\ngamma\n",
        ),
        # full read block with wrappers and position marker footer.
        (
            (
                "<path>a.py</path>\n<type>file</type>\n<content>\n"
                "1 | alpha\n2 | beta\n\n(a.py: lines 1-2 of 3)\n</content>"
            ),
            "ALPHA\nBETA",
            "ALPHA\nBETA\ngamma\n",
        ),
        # full read block: wrapper lines, position marker, batch footer.
        (
            (
                "<path>a.py</path>\n<type>file</type>\n<content>\n"
                "1 | alpha\n2 | beta\n\n(a.py: lines 1-2 of 3)\n</content>\n\n"
                '(Batch complete — page further windows with ranges=["path:start:count", ...] in one call.)'
            ),
            "ALPHA\nBETA",
            "ALPHA\nBETA\ngamma\n",
        ),
    ],
)
def test_edit_file_tolerant_old_string(tmp_path, old_string, new_string, expected):
    """old copied from read/grep output (prefixes, stray whitespace) must
    still edit instead of failing with 'old_string not found'."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    res = tools.edit_file(str(tmp_path), "a.py", old_string, new_string)
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == expected


def test_edit_file_batch_tolerant_second_edit(tmp_path):
    """Regression: batches died at 'edit 2/N: old_string not found' when a
    later old_string carried copied read-tool prefixes."""
    (tmp_path / "b.py").write_text("one\ntwo\nthree\n")
    res = tools.edit_file_batch(
        str(tmp_path),
        "b.py",
        [
            {"old_string": "one", "new_string": "ONE"},
            {"old_string": "2 | two", "new_string": "2 | TWO"},
        ],
    )
    assert res.get("ok"), res
    assert res["edits_applied"] == 2
    assert (tmp_path / "b.py").read_text() == "ONE\nTWO\nthree\n"


@pytest.mark.parametrize(
    "old_string,new_string,expected",
    [
        # History-rebuilt rows ("path: N | text").
        ("a.py: 1 | alpha", "ALPHA", "ALPHA\nbeta\ngamma\n"),
        # Grep symbol annotation with a single line number.
        ("a.py:1: in foo (L1):alpha", "ALPHA", "ALPHA\nbeta\ngamma\n"),
        # Duplicate-reference note above a copied window (backend emits
        # this marker when a result repeats an earlier one).
        (
            (
                "[This result is byte-identical to tool result call_01abc "
                "earlier in these messages — use that full text.]\n1 | alpha"
            ),
            "ALPHA",
            "ALPHA\nbeta\ngamma\n",
        ),
    ],
)
def test_edit_file_tolerant_history_shapes(tmp_path, old_string, new_string, expected):
    """History/projection row shapes must edit instead of not-found."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    res = tools.edit_file(str(tmp_path), "a.py", old_string, new_string)
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == expected


@pytest.mark.parametrize(
    "old_string,hint",
    [
        # Omission marker hides middle lines: error must say so + show content.
        (
            "1 | alpha\n[lines 2-2 identical to an earlier read of this file above; omitted]\n3 | gamma",
            "identical to an earlier read",
        ),
        # Collapsed single-line grep head carries no code text.
        ("a.py:1:[line read above]", "[line read above]"),
        # Middle-truncated long line.
        ("alpha…rest", "truncated"),
    ],
)
def test_edit_file_not_found_error_guides_copy(tmp_path, old_string, hint):
    """Lossy copies must fail with an actionable error, not a bare not-found."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    res = tools.edit_file(str(tmp_path), "a.py", old_string, "X")
    assert "error" in res and "old_string not found" in res["error"], res
    assert hint in res["error"], res
    assert "copy verbatim" in res["error"], res
    assert "alpha" in res["error"], res


def test_edit_file_indent_insensitive_preserves_indent(tmp_path):
    """Retyped blocks without indent must splice with the file's indent."""
    (tmp_path / "a.py").write_text("def f():\n  alpha = 1\n  beta = 2\n")
    res = tools.edit_file(
        str(tmp_path), "a.py", "alpha = 1\nbeta = 2", "alpha = 1\nbeta = 99"
    )
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == "def f():\n  alpha = 1\n  beta = 99\n"


@pytest.mark.parametrize(
    "old_string,new_string",
    [
        # Retyped at column 0 (no leading indent).
        (
            "const clamped = Math.min(100, Math.max(0, pct))\nconst raw = min + 1",
            "const clamped = Math.min(100, Math.max(0, pct))\nconst raw = min + 2",
        ),
        # Copied with read-tool "NNN | " prefixes.
        (
            (
                "53 |   const clamped = Math.min(100, Math.max(0, pct))\n"
                "54 |   const raw = min + 1"
            ),
            "  const clamped = Math.min(100, Math.max(0, pct))\n  const raw = min + 2",
        ),
    ],
)
def test_edit_file_indent_insensitive_ts_block(tmp_path, old_string, new_string):
    """Regression for browserViewport.ts: indented TS block must match."""
    (tmp_path / "b.ts").write_text(
        "export function f(pct: number): number {\n"
        "  const clamped = Math.min(100, Math.max(0, pct))\n"
        "  const raw = min + 1\n"
        "  return raw\n"
        "}\n"
    )
    res = tools.edit_file(str(tmp_path), "b.ts", old_string, new_string)
    assert res.get("ok"), res
    assert "  const raw = min + 2\n  return raw" in (tmp_path / "b.ts").read_text()


def test_edit_file_strips_code_fences(tmp_path):
    """Fenced copies from chat snippets must edit instead of not-found."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    res = tools.edit_file(str(tmp_path), "a.py", "```python\n1 | alpha\n```", "ALPHA")
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == "ALPHA\nbeta\ngamma\n"


def test_edit_file_reflow_single_line(tmp_path):
    """A multi-line block retyped as one line must still match (reflow)."""
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n")
    res = tools.edit_file(str(tmp_path), "a.py", "alpha beta", "ALPHA BETA")
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == "ALPHA BETA\ngamma\n"


@pytest.mark.parametrize(
    "source,old_string,new_string,expected",
    [
        # Single literal: old is the full decoded value (quotes dropped).
        (
            'PROMPT = "Follow the search strategy rule above for every task.\\n"\n',
            "Follow the search strategy rule above for every task.\n",
            "Follow the updated search strategy rule for every task.\n",
            'PROMPT = "Follow the updated search strategy rule for every task.\\n"\n',
        ),
        # Implicitly-concatenated run: old is the full combined decoded value.
        (
            'P = (\n    "Follow the search strategy rule above.\\n"\n    "Use grep for a targeted look.\\n"\n)\n',
            "Follow the search strategy rule above.\nUse grep for a targeted look.\n",
            "Follow the updated search strategy rule.\nUse grep for a targeted look.\n",
            'P = (\n    "Follow the updated search strategy rule.\\nUse grep for a targeted look.\\n"\n)\n',
        ),
    ],
)
def test_edit_file_decoded_string_literal(tmp_path, source, old_string, new_string, expected):
    """old_string as the decoded VALUE of a source string literal must match.

    Regression for the recurring failure where the model copies a prompt line's
    runtime value (quotes dropped, real newlines) from a quoted source string in
    the file — the byte text differs, so every other tier fails.
    """
    (tmp_path / "a.py").write_text(source)
    res = tools.edit_file(str(tmp_path), "a.py", old_string, new_string)
    assert res.get("ok"), res
    assert (tmp_path / "a.py").read_text() == expected


def test_edit_file_not_unique_lists_occurrences(tmp_path):
    """Ambiguous old_string must fail with every occurrence location."""
    (tmp_path / "a.py").write_text("alpha\nbeta\nalpha\nbeta\nalpha\n")
    res = tools.edit_file(str(tmp_path), "a.py", "alpha", "ALPHA")
    assert "error" in res and "not unique (3 occurrences)" in res["error"], res
    assert "occurrence 1" in res["error"], res
    assert "occurrence 3" in res["error"], res
    assert "replace_all=true" in res["error"], res


@pytest.mark.asyncio
async def test_read_batch_partial_failure_footer(tmp_path):
    """رگرسیون «خواندن دسته‌ای خطا داد»: یک فایل خطادار در batch نباید کل
    نتیجه را ERROR جلوه دهد — فایل‌های سالم عادی خوانده می‌شوند و خطاها
    به‌صورت فوتر خلاصه در انتها می‌آیند تا مدل به read های جدا برنگردد."""
    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 21)))
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", filePaths=["missing.py"])
    # فایل سالم عادی خوانده شده است.
    assert "<path>a.py</path>" in out
    assert "1 | line1" in out
    # خطای فایل غایب به‌صورت فوتر خلاصه آمده — نه به‌صورت شروعِ کل خروجی.
    assert not out.startswith("ERROR")
    assert "missing.py" in out
    assert "1/2 files read OK" in out


@pytest.mark.asyncio
async def test_read_snaps_to_block_end(tmp_path):
    """A window ending mid-function extends to the closing bracket instead
    of forcing a follow-up read (the 640-859/860-899 pattern)."""
    lines = [f"line{i}" for i in range(1, 401)]
    lines[9] = "def foo():"
    lines[10] = "    x = 1"
    lines[11] = "    return x"
    # line12 stays "line12", line13 (index 12) becomes the closer
    lines[12] = "}"
    (tmp_path / "a.py").write_text("\n".join(lines) + "\n")
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="a.py", offset=1, limit=10)
    # Requested 1-10, but the block closes at line 13 -> snapped.
    assert "10 | def foo():" in out
    assert "13 | }" in out
    assert "14 | line14" not in out


@pytest.mark.asyncio
async def test_read_batch_broadcast_past_eof_serves_from_line_one(tmp_path):
    """One shared offset/limit across different-size files past-EOFs on the
    short ones — the short file is served from line 1 with a note instead of
    burning another step on an error, and the footer still steers to
    per-file ranges= windows."""
    (tmp_path / "big.py").write_text("".join(f"line{i}\n" for i in range(1, 401)))
    (tmp_path / "small.py").write_text("only\n")
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="big.py", filePaths=["small.py"], offset=300, limit=50)
    assert "ERROR" not in out, out
    assert "(offset 300 is past the end of small.py; showing from line 1 instead)" in out
    assert "only" in out
    assert "ranges=" in out


@pytest.mark.asyncio
async def test_read_symbols_single_call(tmp_path):
    """symbols=[...] reads named definitions in one call — no line guessing."""
    (tmp_path / "m.py").write_text(
        "def alpha():\n    return 1\n\ndef beta():\n    return 2\n"
        + "".join(f"filler{i} = {i}\n" for i in range(400))
    )
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="m.py", symbols=["beta"])
    assert "return 2" in out
    assert "return 1" not in out


@pytest.mark.asyncio
async def test_read_symbols_missing(tmp_path):
    (tmp_path / "m.py").write_text("def alpha():\n    return 1\n")
    root = str(tmp_path)
    read, _ = _make_read(root)
    out = await read(filePath="m.py", symbols=["nope"])
    assert out.startswith("ERROR")
    assert "nope" in out
