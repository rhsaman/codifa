"""Batch member coverage: a batch re-fetching an already-served window drops
that member instead of re-sending it (loop-side stubs cover only
single-window reads).

The tool checks the served-windows ledger minus this call's own requests
(recorded pre-execution by observe()): coverage must come from EARLIER
serving. Map-served paths are untrusted and never drop. Tests simulate
observe()'s recording with note_fetched_window directly.
"""
from tool_batching import (
    has_served_map,
    note_fetched_window,
    note_served_map,
    reset_read_ledger,
    reset_turn_seen_calls,
)


def _fresh():
    reset_read_ledger()
    reset_turn_seen_calls()


def _ws(root, name, n, marker):
    with open(f"{root}/{name}", "w") as f:
        f.write("\n".join(f"{marker}{i}" for i in range(1, n + 1)) + "\n")


def _ws_with_def(root):
    with open(f"{root}/m.py", "w") as f:
        f.write("".join(f"v{i} = {i}\n" for i in range(1, 30)))
        f.write("def target_fn():\n    return 1\n")
        f.write("".join(f"w{i} = {i}\n" for i in range(200)))


def _ws_padded(root, name, marker, n=200):
    with open(f"{root}/{name}", "w") as f:
        f.write("".join(f"{marker}{i:04d}\n" for i in range(1, n + 1)))


async def test_drop_covered_member_partial(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    _ws(str(tmp_path), "b.py", 200, "bLINE")
    # Prior turn serving + this call's own recording (as observe() would).
    note_fetched_window("a.py", 1, 50)
    note_fetched_window("a.py", 1, 50)
    note_fetched_window("b.py", 1, 50)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("a.py", filePaths=["b.py"], offset=1, limit=50)
    assert "already in context, skipped: a.py lines 1-50" in out, out
    assert "aLINE25" not in out, out
    assert "bLINE25" in out, out


async def test_all_covered_returns_stub(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    _ws(str(tmp_path), "b.py", 200, "bLINE")
    note_fetched_window("a.py", 1, 50)
    note_fetched_window("b.py", 1, 50)
    note_fetched_window("a.py", 1, 50)
    note_fetched_window("b.py", 1, 50)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("a.py", filePaths=["b.py"], offset=1, limit=50)
    assert out.startswith("SKIPPED (already in context)"), out
    assert "aLINE25" not in out and "bLINE25" not in out, out


async def test_fresh_batch_untouched(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    _ws(str(tmp_path), "b.py", 200, "bLINE")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("a.py", filePaths=["b.py"], offset=1, limit=50)
    assert "already in context" not in out, out
    assert "aLINE25" in out and "bLINE25" in out, out


async def test_partial_overlap_still_served(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    _ws(str(tmp_path), "b.py", 200, "bLINE")
    note_fetched_window("a.py", 1, 50)
    note_fetched_window("a.py", 40, 90)
    note_fetched_window("b.py", 1, 50)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("a.py", filePaths=["b.py"], offset=40, limit=51)
    assert "already in context, skipped" not in out, out
    assert "aLINE60" in out, out


async def test_ranges_covered_member_dropped(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "m.py", 200, "mLINE")
    _ws(str(tmp_path), "n.py", 200, "nLINE")
    note_fetched_window("m.py", 10, 60)
    note_fetched_window("m.py", 10, 30)
    note_fetched_window("n.py", 1, 2000)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("m.py", filePaths=["n.py"], ranges=["m.py:10:21"])
    assert "already in context, skipped: m.py lines 10-30" in out, out
    assert "mLINE15" not in out, out
    assert "nLINE100" in out, out


async def test_map_served_path_never_dropped(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "p.py", 700, "pLINE")
    note_served_map("p.py")
    note_fetched_window("p.py", 1, 2000)
    note_fetched_window("p.py", 500, 550)
    assert has_served_map("p.py")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("p.py", ranges=["p.py:500:51"])
    assert "already in context, skipped" not in out, out
    assert "pLINE520" in out, out


async def test_symbols_call_records_served_windows(tmp_path):
    """A symbols= batch must leave a ledger trace: observe() records nothing
    for symbols calls, so without tool-side served-window recording the next
    read of the same lines re-serves them ("duplicate files")."""
    import tools

    _fresh()
    _ws_with_def(str(tmp_path))
    _ws(str(tmp_path), "n.py", 200, "nLINE")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out1 = await cbs["read"]("m.py", filePaths=["n.py"], symbols=["target_fn"])
    assert "def target_fn" in out1, out1
    # Same lines via ranges afterwards: already served → dropped, no re-send.
    # n.py was served whole in out1 and is unchanged, so the whole second
    # call is now a stub (nothing new to serve anywhere).
    out2 = await cbs["read"]("m.py", filePaths=["n.py"], ranges=["m.py:30:2"])
    assert out2.startswith("SKIPPED (already in context)"), out2
    assert "m.py lines 30-31 were already fetched this turn" in out2, out2
    assert "def target_fn" not in out2, out2
    assert "nLINE100" not in out2, out2


async def test_ranges_then_symbols_drop(tmp_path):
    import tools

    _fresh()
    _ws_with_def(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out1 = await cbs["read"]("m.py", ranges=["m.py:1:60"])
    assert "def target_fn" in out1, out1
    # Small files come back whole, so the def is served; the symbols call
    # resolving inside must drop instead of re-sending it.
    out2 = await cbs["read"]("m.py", symbols=["target_fn"])
    assert out2.startswith("SKIPPED (already in context)"), out2
    assert "def target_fn" not in out2, out2


async def test_path_spelling_normalized(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out1 = await cbs["read"]("a.py", offset=1, limit=50)
    assert "aLINE25" in out1, out1
    # Same file, different spelling: must hit coverage, not re-serve.
    out2 = await cbs["read"]("./a.py", offset=1, limit=50)
    assert out2.startswith("SKIPPED (already in context)"), out2


async def test_same_turn_partial_overlap_omits_served_lines(tmp_path):
    """Partial overlap within the same turn omits served lines, not re-sends.

    Regression for back-to-back reads like 640-879 then 630-649: the second
    body must skip the 640-649 lines already in context and serve only the
    630-639 sliver (+ omission note), instead of duplicating 10 lines.
    """
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 500, "aLINE")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out1 = await cbs["read"]("a.py", offset=1, limit=100)
    # Sanity: first window served (1-100 of the 500-line file).
    assert "aLINE90" in out1, out1
    # Overlapping repeat: 80-179 overlaps served 1-100 on 80-100.
    out2 = await cbs["read"]("a.py", offset=80, limit=100)
    assert "already in context" in out2, out2
    assert "omitted; showing only new lines" in out2, out2
    assert "aLINE90" not in out2, out2
    assert "aLINE150" in out2, out2


async def test_identical_members_served_once(tmp_path):
    import tools

    _fresh()
    # Zero-padded markers: every line's text is unique (no "5"/"55" style
    # substring collisions when counting blocks).
    _ws_padded(str(tmp_path), "a.py", "qa")
    _ws_padded(str(tmp_path), "b.py", "qb")
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"](
        "a.py", filePaths=["b.py", "b.py"], ranges=["b.py:1:10", "b.py:1:10"]
    )
    # Exact line match: the b.py block must appear exactly once.
    assert out.count("5 | qb0005") == 1, out
    assert "5 | qa0005" in out, out


async def test_batch_result_card_kind_is_tool_result(tmp_path):
    """The aggregate batch card must be kind=tool_result: the trace log pairs
    call(tool)→result(tool_result), so a result emitted as kind=tool renders
    as an empty row (chat showed content, trace log showed nothing)."""
    import tools

    _fresh()
    _ws(str(tmp_path), "a.py", 200, "aLINE")
    _ws(str(tmp_path), "b.py", 200, "bLINE")
    emitted: list[dict] = []
    cbs = tools.make_tool_callbacks(str(tmp_path), emitted.append)
    await cbs["read"]("a.py", filePaths=["b.py"], offset=1, limit=50)
    results = [
        e for e in emitted
        if e.get("kind") == "tool_result" and e.get("tool") == "read"
    ]
    assert results, emitted
    assert any("file" in str(r.get("summary", "")) for r in results), emitted
    for e in emitted:
        if e.get("kind") == "tool" and e.get("tool") == "read":
            assert "args" in e and "summary" not in e, e


async def test_symbols_window_covered_by_real_serving_drops(tmp_path):
    import tools

    _fresh()
    _ws_with_def(str(tmp_path))
    _ws(str(tmp_path), "n.py", 200, "nLINE")
    # Real prior serving of the def lines (no current-call recording:
    # observe() records nothing for symbols= calls, mirrored here).
    note_fetched_window("m.py", 25, 40)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("m.py", filePaths=["n.py"], symbols=["target_fn"])
    assert "already in context, skipped: m.py lines" in out, out
    assert "nLINE100" in out, out
