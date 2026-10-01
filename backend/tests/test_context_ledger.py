"""Step-level context ledger + batch past-EOF recovery + footer-once.

context_ledger_line summarizes read windows already present in the live
messages as one line, so the model stops re-reading content it has.
Batch reads serve a past-EOF member from line 1 (with a note) instead of
burning a step on an error, and per-block guidance footers are compacted
with the paging guidance emitted once per batch.
"""
from langchain_core.messages import HumanMessage, ToolMessage

from tool_message_projection import context_ledger_line


def _block(path, rows):
    body = "\n".join(f"{n} | {text}" for n, text in rows)
    return (
        f"<path>{path}</path>\n<type>file</type>\n<content>\n"
        f"{body}\n(End of file)\n</content>"
    )


def _tm(content, cid, status="success"):
    return ToolMessage(content=content, tool_call_id=cid, status=status)


def test_ledger_empty_without_reads():
    assert context_ledger_line([]) == ""
    assert context_ledger_line([HumanMessage(content="hello")]) == ""


def test_ledger_silent_for_single_file_single_window():
    msgs = [_tm(_block("a.py", [(1, "x"), (2, "y")]), "c1")]
    assert context_ledger_line(msgs) == ""


def test_ledger_multi_file_exact_line():
    msgs = [
        HumanMessage(content="noise"),
        _tm(_block("a.py", [(1, "x"), (2, "y")]), "c1"),
        _tm(_block("a.py", [(635, "z"), (636, "w")]), "c2"),
        _tm(_block("b.css", [(1, "q")]), "c3"),
    ]
    assert context_ledger_line(msgs) == (
        "[already in context \u2014 do NOT re-read: "
        "a.py 1-2,635-636 | b.css 1]"
    )


def test_ledger_merges_contiguous_across_blocks():
    msgs = [
        _tm(_block("a.py", [(1, "x"), (2, "y")]), "c1"),
        _tm(_block("a.py", [(3, "z"), (5, "w")]), "c2"),
    ]
    assert context_ledger_line(msgs) == (
        "[already in context \u2014 do NOT re-read: a.py 1-3,5]"
    )


def test_ledger_ignores_errors_and_non_file_blocks():
    msgs = [
        _tm("ERROR reading x.py: file not found", "c0", status="error"),
        _tm("<path>d</path>\n<type>directory</type>\n<entries>\na.py\n</entries>", "c1"),
        _tm(_block("a.py", [(1, "x")]), "c2"),
        _tm(_block("b.py", [(1, "y")]), "c3"),
    ]
    line = context_ledger_line(msgs)
    assert "x.py" not in line
    assert line == "[already in context \u2014 do NOT re-read: a.py 1 | b.py 1]"


def test_ledger_caps_files_with_counter():
    import re

    long = "d" * 60
    msgs = [_tm(_block(f"{long}{n:02d}.py", [(1, "x")]), f"c{n}") for n in range(20)]
    line = context_ledger_line(msgs)
    assert re.search(r"\(\+\d+ more\)", line)
    assert len(line) <= 520
    assert f"{long}00.py 1" in line
    # No range is ever cut mid-token.
    assert not re.search(r"-\]", line)


async def test_batch_past_eof_served_from_line_one(tmp_path):
    import tools

    (tmp_path / "big.py").write_text("".join(f"line{i}\n" for i in range(1, 601)))
    (tmp_path / "small.py").write_text("".join(f"s{i}\n" for i in range(1, 51)))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", filePaths=["small.py"], offset=500, limit=100)
    assert "ERROR" not in out, out
    assert "(offset 500 is past the end of small.py; showing from line 1 instead)" in out
    assert "s1" in out


async def test_batch_empty_file_keeps_error(tmp_path):
    import tools

    (tmp_path / "big.py").write_text("".join(f"line{i}\n" for i in range(1, 601)))
    (tmp_path / "empty.py").write_text("")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", filePaths=["empty.py"], offset=500, limit=100)
    # Nothing to serve from line 1: the past-EOF report survives.
    assert "past the end of the file (0 lines)" in out, out
    assert "showing from line 1 instead" not in out, out


async def test_batch_footer_once_and_compact(tmp_path):
    import tools

    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 601)))
    (tmp_path / "b.py").write_text("".join(f"row{i}\n" for i in range(1, 601)))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("a.py", filePaths=["b.py"], offset=1, limit=100)
    # Per-block paging guidance is gone; compact position markers remain.
    assert "Read all needed sections" not in out, out
    assert "(a.py: lines" in out and "(b.py: lines" in out
    # The batch guidance footer appears exactly once.
    assert out.count("Batch complete") == 1, out


async def test_single_read_uses_batch_pipeline(tmp_path):
    import tools

    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 601)))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"](filePath="a.py", offset=1, limit=100)
    # No single fast-path: one file still gets the position marker and the
    # shared batch footer.
    assert "(a.py: lines 1-" in out, out
    assert "Batch complete" in out, out
