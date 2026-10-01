"""Grep diversity cap: a dump that truncates across many files shows a
per-file-capped first page instead of letting one noisy file eat all slots.

Focused searches (few files) keep full depth — the cap only engages when the
result already truncates AND spans more than 5 files. Skipped hits fold into
the hidden count with a per-file pointer.
"""
import os
import tempfile

from tools import make_tool_callbacks


def _write(root, name, content):
    with open(os.path.join(root, name), "w") as f:
        f.write(content)


def _broad_ws():
    """8 files x 12 uniquely-tagged hits each."""
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    for n in range(8):
        _write(
            root,
            f"f{n}.py",
            "\n".join(f'x = "CAPMARK-f{n}-{k:02d}"' for k in range(12)) + "\n",
        )
    return root


def _hits_per_file(out, n):
    return out.count(f"f{n}.py:")


async def test_grep_broad_dump_capped_per_file():
    root = _broad_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("CAPMARK", max_results=20)
    assert "Found 96 matches" in out
    # No file dominates the page; the page spans files.
    counts = [_hits_per_file(out, n) for n in range(8)]
    assert max(counts) <= 8, counts
    assert sum(1 for c in counts if c > 0) >= 3, counts
    assert "Per-file cap (8/file)" in out


async def test_grep_focused_search_keeps_depth():
    """2 files: no cap — depth preserved, no cap note."""
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    for n in range(2):
        _write(
            root,
            f"g{n}.py",
            "\n".join(f'y = "DEEPMARK-g{n}-{k:02d}"' for k in range(20)) + "\n",
        )
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("DEEPMARK", max_results=25)
    assert "Found 40 matches" in out
    counts = [out.count(f"g{n}.py:") for n in range(2)]
    assert sum(counts) == 25, counts
    assert max(counts) > 8, counts  # first file keeps full depth
    assert "Per-file cap" not in out
