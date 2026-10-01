"""Paging auto-join: a read window starting/ending near an already-fetched
window of the same file bridges the gap instead of leaving a sliver to page.

The advisory "read ONE wide window" nudge for this case is routinely ignored
(steps paging 2040-2159 then 2200-2359), so the join is enforced in _read_target:
bounded (<=100 lines), disclosed in a footer, and only the gap itself is
ledger-recorded (no double-count for coverage checks).
"""
import os
from contextlib import contextmanager

from tool_batching import note_fetched_window, reset_read_ledger
from tools import make_tool_callbacks


@contextmanager
def _isolated_ledger():
    """Hermetic read ledger: other tests may leave it set; save/restore."""
    import tool_batching

    prev = tool_batching._READ_LEDGER.get()
    reset_read_ledger()
    try:
        yield
    finally:
        tool_batching._READ_LEDGER.set(prev)


def _make_ws(n=400):
    import tempfile

    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    with open(os.path.join(root, "join_paging.py"), "w") as f:
        f.write("\n".join(f"x_{i:04d} = {i}" for i in range(1, n + 1)) + "\n")
    return root


async def test_read_bridges_backward_gap():
    """Fetched 100-149, request 180-219 (gap 30): response starts at 150."""
    root = _make_ws()
    with _isolated_ledger():
        note_fetched_window("join_paging.py", 100, 149)
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["read"]("join_paging.py", 180, 40)
    assert "150 | x_0150" in out
    assert "219 | x_0219" in out
    assert "no gap left to page" in out


async def test_read_bridges_forward_gap():
    """Fetched 300-349, request 200-259 (gap 40): response extends to 299."""
    root = _make_ws()
    with _isolated_ledger():
        note_fetched_window("join_paging.py", 300, 349)
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["read"]("join_paging.py", 200, 60)
    assert "200 | x_0200" in out
    assert "299 | x_0299" in out
    assert "no gap left to page" in out


async def test_read_no_join_when_far():
    """Gap 110 (> 100): no bridging, exact window, no note."""
    root = _make_ws()
    with _isolated_ledger():
        note_fetched_window("join_paging.py", 100, 149)
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["read"]("join_paging.py", 260, 20)
    assert "260 | x_0260" in out
    assert "259 | x_0259" not in out
    assert "no gap left to page" not in out


async def test_read_no_join_without_ledger():
    """No ledger entries: window untouched (backward-compatible)."""
    root = _make_ws()
    with _isolated_ledger():
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["read"]("join_paging.py", 180, 40)
    assert "180 | x_0180" in out
    assert "179 | x_0179" not in out
    assert "no gap left to page" not in out
