"""Cross-turn reuse: repeats of a previous turn's read/grep stub out while the
files are unchanged, and re-serve the moment anything changes.

Within one turn the per-turn ledgers already stub repeats; across turns they
reset, so the next turn re-sent full content for zero new information. These
tests pin the cross-turn layer: served windows (reads) and complete searches
(greps) are remembered with file signatures, and a repeat in a LATER turn
serves only a short pointer — unless the file changed (our edit or an
external one), when it re-serves fresh content.

Turn boundaries are simulated with reset_read_ledger() + reset_turn_seen_calls()
(the production turn-start resets); cross-turn stores must SURVIVE those.
"""
import os
from pathlib import Path

from tool_batching import (
    cross_turn_grep_check,
    cross_turn_read_covers,
    note_cross_turn_grep,
    note_cross_turn_read,
    reset_cross_turn,
    reset_read_ledger,
    reset_turn_seen_calls,
)


def _next_turn():
    """Simulate the production turn boundary: per-turn state resets."""
    reset_read_ledger()
    reset_turn_seen_calls()


def _append(root: str, name: str, text: str) -> None:
    """Append to a workspace file (sync helper: no blocking open in tests)."""
    p = Path(root) / name
    p.write_text(p.read_text() + text)


def _ws(root):
    with open(f"{root}/a.py", "w") as f:
        f.write("alpha embedding model here\nbeta laya router there\ngamma plain\n")
    with open(f"{root}/b.py", "w") as f:
        f.write("bee content line one\nbee content line two\n")


def _cbs(root):
    import tools

    return tools.make_tool_callbacks(root, lambda ev: None, main_model=None)


# ── reads: integration ────────────────────────────────────────────────


async def test_cross_turn_read_reuses_when_unchanged(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["read"]("a.py")
    assert "alpha embedding model here" in out1, out1
    _next_turn()
    out2 = await cbs["read"]("a.py")
    assert out2.startswith("SKIPPED (already in context)"), out2
    assert "fetched before" in out2, out2
    assert "alpha embedding model here" not in out2, out2


async def test_cross_turn_read_reserves_after_external_edit(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    await cbs["read"]("a.py")
    # External edit: no generation bump, only the file signature changes.
    _append(root, "a.py", "delta outside line\n")
    _next_turn()
    out2 = await cbs["read"]("a.py")
    assert "fetched before" not in out2, out2
    assert "SKIPPED (already in context)" not in out2, out2


async def test_cross_turn_read_reserves_fresh_after_edit_tool(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    await cbs["read"]("a.py")
    await cbs["edit_file"]("a.py", "gamma plain", "gamma EDITED fresh")
    _next_turn()
    out2 = await cbs["read"]("a.py")
    assert "SKIPPED (already in context)" not in out2, out2
    assert "EDITED fresh" in out2, out2


async def test_batch_partial_cross_turn_drop(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    await cbs["read"]("a.py")
    _next_turn()
    out = await cbs["read"]("a.py", filePaths=["b.py"])
    # a.py reused from the earlier serve, b.py served fresh in this call.
    assert "fetched before" in out, out
    assert "serving the rest below" in out, out
    assert "bee content line one" in out, out
    assert "alpha embedding model here" not in out, out


# ── greps: integration ────────────────────────────────────────────────


async def test_cross_turn_grep_reuses_repeat_and_subset(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["grep"]("embedding|laya", path="")
    assert "MATCHES for" in out1, out1
    _next_turn()
    out2 = await cbs["grep"]("embedding|laya", path="")
    assert "REUSED from an earlier" in out2, out2
    assert "MATCHES for" not in out2, out2
    assert "a.py" not in out2, out2
    # A narrower subset is covered by the same earlier search.
    out3 = await cbs["grep"]("embedding", path="")
    assert "REUSED from an earlier" in out3, out3
    # A wider pattern has words the earlier search never covered: executes.
    out4 = await cbs["grep"]("embedding|laya|gamma", path="")
    assert "MATCHES for" in out4, out4
    assert "REUSED" not in out4, out4


async def test_cross_turn_grep_rescans_after_external_edit(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    await cbs["grep"]("embedding|laya", path="")
    _append(root, "a.py", "embedding external line\n")
    _next_turn()
    out2 = await cbs["grep"]("embedding|laya", path="")
    # Stat validation fails: no stub, even though the result cache may serve.
    assert "REUSED" not in out2, out2


async def test_cross_turn_grep_rescans_fresh_after_edit_tool(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    await cbs["grep"]("embedding|laya", path="")
    await cbs["edit_file"]("a.py", "gamma plain", "gamma plain\nembedding edited line")
    _next_turn()
    out2 = await cbs["grep"]("embedding|laya", path="")
    assert "REUSED" not in out2, out2
    assert "MATCHES for" in out2, out2
    assert "edited line" in out2, out2


async def test_no_match_grep_has_no_cross_turn_stub(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["grep"]("zxqv|nomatchhere", path="")
    assert "No matches" in out1, out1
    _next_turn()
    # No-match searches record nothing cross-turn (a stale "no matches"
    # could hide newly added matches); the repeat executes.
    out2 = await cbs["grep"]("zxqv|nomatchhere", path="")
    assert "REUSED" not in out2, out2
    assert "No matches" in out2, out2


# ── units: signatures, scope, lifecycle ───────────────────────────────


def test_unit_read_partial_coverage_and_edit(tmp_path):
    p = tmp_path / "f.py"
    p.write_text("".join(f"line {i}\n" for i in range(100)))
    note_cross_turn_read("R", "f.py", 1, 50, str(p))
    assert cross_turn_read_covers("R", "f.py", 1, 10) is True
    assert cross_turn_read_covers("R", "f.py", 1, 50) is True
    assert cross_turn_read_covers("R", "f.py", 1, 51) is False
    assert cross_turn_read_covers("R", "f.py", 40, 60) is False
    # Other roots never share entries.
    assert cross_turn_read_covers("OTHER", "f.py", 1, 10) is False
    # Any content change invalidates, even with the same generation.
    with open(str(p), "a") as f:
        f.write("extra\n")
    assert cross_turn_read_covers("R", "f.py", 1, 10) is False


def test_unit_read_default_limit_repeat_of_short_file(tmp_path):
    # A default-limit request (1-2000) of a 3-line file is fully satisfied
    # by the served 1-3: the check clamps to the recorded line count.
    p = tmp_path / "s.py"
    p.write_text("one\ntwo\nthree\n")
    note_cross_turn_read("R", "s.py", 1, 3, str(p), 3)
    assert cross_turn_read_covers("R", "s.py", 1, 2000) is True
    assert cross_turn_read_covers("R", "s.py", 1, 3) is True
    # A request starting past EOF is never "covered" (error path re-runs).
    assert cross_turn_read_covers("R", "s.py", 500, 600) is False


def test_unit_read_deleted_file_misses(tmp_path):
    p = tmp_path / "g.py"
    p.write_text("hello\n")
    note_cross_turn_read("R", "g.py", 1, 1, str(p))
    assert cross_turn_read_covers("R", "g.py", 1, 1) is True
    os.remove(str(p))
    assert cross_turn_read_covers("R", "g.py", 1, 1) is False


def test_unit_grep_subset_scope_and_edit(tmp_path):
    a = tmp_path / "a.py"
    b = tmp_path / "b.py"
    a.write_text("alpha embedding here\n")
    b.write_text("beta laya here\n")
    note_cross_turn_grep(
        "R", 7, ("", ""), frozenset({"embedding", "laya"}), 50,
        "embedding|laya", "2 matches in 2 files", [str(a), str(b)],
    )
    assert cross_turn_grep_check(
        "R", 7, ("", ""), frozenset({"embedding", "laya"}), 50
    )
    assert cross_turn_grep_check(
        "R", 7, ("", ""), frozenset({"embedding"}), 50
    )
    # Wider pattern, larger cap, other scope, other generation: all execute.
    assert not cross_turn_grep_check(
        "R", 7, ("", ""), frozenset({"embedding", "laya", "gamma"}), 50
    )
    assert not cross_turn_grep_check(
        "R", 7, ("", ""), frozenset({"embedding"}), 500
    )
    assert not cross_turn_grep_check(
        "R", 7, ("sub", ""), frozenset({"embedding"}), 50
    )
    assert not cross_turn_grep_check(
        "R", 8, ("", ""), frozenset({"embedding"}), 50
    )
    # Touching any matched file invalidates the entry.
    with open(str(b), "a") as f:
        f.write("more\n")
    assert not cross_turn_grep_check(
        "R", 7, ("", ""), frozenset({"embedding"}), 50
    )


def test_unit_grep_without_statable_files_records_nothing(tmp_path):
    note_cross_turn_grep(
        "R", 7, ("", ""), frozenset({"nope"}), 50,
        "nope", "0 matches", [str(tmp_path / "missing.py")],
    )
    assert not cross_turn_grep_check("R", 7, ("", ""), frozenset({"nope"}), 50)


def test_reset_cross_turn_clears(tmp_path):
    p = tmp_path / "h.py"
    p.write_text("hello\n")
    note_cross_turn_read("R", "h.py", 1, 1, str(p))
    note_cross_turn_grep(
        "R", 1, ("", ""), frozenset({"hello"}), 50,
        "hello", "1 match in 1 file", [str(p)],
    )
    reset_cross_turn()
    assert cross_turn_read_covers("R", "h.py", 1, 1) is False
    assert not cross_turn_grep_check("R", 1, ("", ""), frozenset({"hello"}), 50)


def test_seen_clear_drops_cross_turn(tmp_path):
    from llm import _SeenWindows

    p = tmp_path / "k.py"
    p.write_text("hello\n")
    note_cross_turn_read("R", "k.py", 1, 1, str(p))
    assert cross_turn_read_covers("R", "k.py", 1, 1) is True
    # Compaction path: history may have evicted the content, so pointers
    # must not dangle.
    _SeenWindows().clear()
    assert cross_turn_read_covers("R", "k.py", 1, 1) is False
