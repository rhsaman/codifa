"""Sliver-serve: partially overlapping reads omit already-served lines.

A repeat that is only PARTIALLY covered (e.g. symbols served 121-182, then an
offset read asks 119-138) used to re-send the whole window — 62 of 64 lines
re-sent for 2 new ones. Now the served spans (sig-validated, so an edited
file always serves whole) are omitted from the body with a pointer note;
line numbers are kept, so the gapped body stays coherent.
"""
from pathlib import Path

from tool_batching import (
    note_fetched_window,
    reset_read_ledger,
    reset_turn_seen_calls,
)


def _fresh():
    reset_read_ledger()
    reset_turn_seen_calls()


def _ws_num(root, name, n, tag="sl"):
    Path(root, name).write_text(
        "".join(f"{tag}{i:04d}\n" for i in range(1, n + 1))
    )


def _cbs(root):
    import tools

    return tools.make_tool_callbacks(root, lambda ev: None, main_model=None)


async def test_partial_overlap_omits_served_lines(tmp_path):
    root = str(tmp_path)
    _ws_num(root, "s.py", 400)
    cbs = _cbs(root)
    out1 = await cbs["read"]("s.py", offset=1, limit=50)
    assert " | sl0001" in out1, out1
    out2 = await cbs["read"]("s.py", offset=40, limit=51)
    # 40-50 already served: omitted with a pointer, only 51+ shown.
    assert " | sl0051" in out2, out2
    assert " | sl0090" in out2, out2
    assert " | sl0050" not in out2, out2
    assert " | sl0040" not in out2, out2
    assert "omitted" in out2, out2
    assert "40-50" in out2, out2


async def test_ranges_then_offset_trace_case(tmp_path):
    """The trace shape: symbols/ranges served 121-182, then an offset read
    asks 119-138 — only the 2 new lines come back."""
    root = str(tmp_path)
    _ws_num(root, "s.py", 400)
    cbs = _cbs(root)
    await cbs["read"]("s.py", ranges=["s.py:121:62"])
    out2 = await cbs["read"]("s.py", offset=119, limit=20)
    assert " | sl0119" in out2, out2
    assert " | sl0120" in out2, out2
    assert " | sl0121" not in out2, out2
    assert " | sl0138" not in out2, out2
    assert "omitted" in out2, out2
    assert "121-138" in out2, out2


async def test_fresh_window_unaffected(tmp_path):
    root = str(tmp_path)
    _ws_num(root, "s.py", 400)
    cbs = _cbs(root)
    await cbs["read"]("s.py", offset=1, limit=50)
    out = await cbs["read"]("s.py", offset=300, limit=50)
    assert " | sl0300" in out, out
    assert "omitted" not in out, out


async def test_observe_only_requests_do_not_filter(tmp_path):
    """observe() pre-records REQUESTED windows into the request ledger without
    serving them — omission must not trust those, only actually-served spans."""
    root = str(tmp_path)
    _ws_num(root, "q.py", 60)
    cbs = _cbs(root)
    _fresh()
    note_fetched_window("q.py", 1, 50)  # request recorded, nothing served
    out = await cbs["read"]("q.py", offset=1, limit=50)
    assert " | sl0001" in out, out
    assert " | sl0050" in out, out
    assert "omitted" not in out, out


async def test_edit_clears_omission(tmp_path):
    root = str(tmp_path)
    _ws_num(root, "s.py", 400)
    cbs = _cbs(root)
    await cbs["read"]("s.py", offset=1, limit=50)
    Path(root, "s.py").write_text(
        Path(root, "s.py").read_text() + "sl0401\n"
    )
    out2 = await cbs["read"]("s.py", offset=40, limit=51)
    # Signature changed: whole window served, nothing omitted.
    assert " | sl0040" in out2, out2
    assert "omitted" not in out2, out2


async def test_map_served_path_unfiltered(tmp_path):
    """A file MAP shows structure, not content — its head window must not
    count as served for omission."""
    root = str(tmp_path)
    _ws_num(root, "big.py", 500)
    cbs = _cbs(root)
    out1 = await cbs["read"]("big.py", offset=1, limit=450)
    assert "file map" in out1, out1
    out2 = await cbs["read"]("big.py", offset=1, limit=40)
    assert " | sl0001" in out2, out2
    assert " | sl0040" in out2, out2
    assert "omitted" not in out2, out2


async def test_wider_window_recovers_omitted(tmp_path):
    root = str(tmp_path)
    _ws_num(root, "s.py", 400)
    cbs = _cbs(root)
    await cbs["read"]("s.py", offset=1, limit=50)
    out2 = await cbs["read"]("s.py", offset=40, limit=51)
    assert "omitted" in out2, out2
    # A wider window re-serves everything not yet shown.
    out3 = await cbs["read"]("s.py", offset=1, limit=200)
    assert " | sl0095" in out3, out3
    assert " | sl0199" in out3, out3
