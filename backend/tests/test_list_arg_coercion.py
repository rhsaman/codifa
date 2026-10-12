"""Batch list args sometimes arrive as JSON-encoded strings.

The model occasionally sends e.g. patterns='["a", "b"]' instead of
patterns=["a", "b"]. Iterating that string split it into characters and
produced garbage searches (``No matches for '...[|"|e|m|b|...'``). Batch
args must parse JSON-array strings, keep real lists intact, and treat any
other string as a single item.
"""
import asyncio
import os
import tempfile
import textwrap

from tools import make_tool_callbacks


def _write(path: str, text: str) -> None:
    """Blocking file write helper for async tests (ASYNC230)."""
    with open(path, "w") as f:
        f.write(text)


def _make_ws():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    src = textwrap.dedent(
        """
        def alpha():
            return compute()  # TARGET

        class Beta:
            def gamma(self):
                return 42
        """
    ).lstrip()
    with open(os.path.join(root, "app.py"), "w") as f:
        f.write(src)
    with open(os.path.join(root, "other.ts"), "w") as f:
        f.write("export const marker = 1;\n")
    return root


def _make_scoped_ws():
    root = _make_ws()
    os.makedirs(os.path.join(root, "sub"))
    with open(os.path.join(root, "sub", "hit.py"), "w") as f:
        f.write("SCOPED = 1\n")
    return root


async def test_grep_stringified_patterns_parsed():
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("TARGET", patterns='["gamma", "alpha"]')
    assert out.startswith("MATCHES for 'TARGET|gamma|alpha'"), out
    assert "app.py:1:" in out  # TARGET (def-body header reports alpha)
    assert "app.py:5:" in out  # gamma (def-body header reports gamma def)


async def test_grep_plain_string_pattern_is_single_item():
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("TARGET", patterns="gamma")
    assert out.startswith("MATCHES for 'TARGET|gamma'"), out
    assert "app.py:5:" in out


async def test_grep_stringified_paths_parsed():
    root = _make_scoped_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("SCOPED", paths='["sub"]')
    assert "hit.py" in out, out
    assert "app.py" not in out, out


async def test_glob_stringified_patterns_parsed():
    root = _make_ws()
    # glob enforces a scope, so the files live in a subdir and the call
    # passes path=... (a workspace-wide glob is rejected).
    os.makedirs(os.path.join(root, "sub"))
    for name in ("s.py", "s.ts"):
        await asyncio.to_thread(
            _write, os.path.join(root, "sub", name), "x = 1\n"
        )
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["glob"]("*.py", path="sub", patterns='["*.ts"]')
    assert "s.py" in out, out
    assert "s.ts" in out, out
    # No char-split garbage: single chars never match real files here.
    assert "No matches" not in out, out


async def test_read_stringified_filepaths_parsed():
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"]("app.py", filePaths='["other.ts"]')
    assert "TARGET" in out, out
    assert "marker" in out, out


async def test_read_stringified_ranges_parsed():
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"]("app.py", ranges='["other.ts:1:1"]')
    assert "marker" in out, out


def _make_big_ws():
    """A file over 300 lines: small files are returned whole, so window
    parsing (ranges) is only observable on a big file."""
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    lines = [f"value_{i} = {i}" for i in range(1, 401)]
    lines[1] = "MARKER_A = 1"  # line 2
    lines[300] = "MARKER_B = 1"  # line 301
    with open(os.path.join(root, "big.py"), "w") as f:
        f.write("\n".join(lines) + "\n")
    return root


async def test_read_json_array_range_window():
    """Regression (live trace): ranges=["[2, 2]"] — a JSON-array window —
    was silently dropped and the read served nothing useful, costing a
    full retry round. It must parse as an inclusive [start,end] window on
    the single filePaths entry."""
    root = _make_big_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](filePaths=["big.py"], ranges=["[2, 2]"])
    assert "MARKER_A" in out, out
    assert "MARKER_B" not in out, out


async def test_read_offset_limit_range_without_path():
    """Regression (live trace): ranges=["2:1"] (offset:limit, no path)
    was silently dropped; it must window the single filePaths entry."""
    root = _make_big_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](filePaths=["big.py"], ranges=["2:1"])
    assert "MARKER_A" in out, out
    assert "MARKER_B" not in out, out


async def test_read_bad_range_is_reported_not_silent():
    """An unparseable range is REPORTED in the output instead of being
    silently dropped — the model then corrects in one step instead of
    re-reading blind."""
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](filePaths=["app.py"], ranges=["nonsense"])
    assert "unparsed ranges ignored: nonsense" in out, out


async def test_read_same_file_ranges_emit_unique_result():
    """Same-file multi-window reads serve every window but list the file
    once on the card — otherwise RESULTS shows one row per range."""
    root = _make_big_ws()
    events: list = []
    cbs = make_tool_callbacks(root, events.append, main_model=None)
    out = await cbs["read"](
        filePaths=["big.py"],
        ranges=["big.py:2:10", "big.py:300:10"],
    )
    assert "MARKER_A" in out, out
    assert "MARKER_B" in out, out
    cards = [
        ev
        for ev in events
        if isinstance(ev, dict)
        and ev.get("kind") == "tool_result"
        and ev.get("tool") == "read"
    ]
    assert cards, events
    results = cards[-1].get("results") or []
    paths = [r.get("path") for r in results if isinstance(r, dict)]
    assert paths == ["big.py"], cards[-1]
    assert cards[-1].get("summary") == "1 file", cards[-1]


async def test_read_dict_range_window():
    """Regression (live trace, build mode): ranges=[{"start": 2, "end": 2}]
    — a JSON-object window — was silently dropped by the strict
    "path:start:count" parser; the wasted retry then tripped the search
    budget. It must parse as an inclusive window on the single target."""
    root = _make_big_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](filePaths=["big.py"], ranges=[{"start": 2, "end": 2}])
    assert "MARKER_A" in out, out
    assert "MARKER_B" not in out, out


async def test_read_dict_range_limit_and_path_forms():
    """{"start","limit"} windows and a dict carrying its own "path" both
    resolve correctly in one batched call."""
    root = _make_big_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](
        filePaths=["big.py"],
        ranges=[
            {"start": 2, "limit": 1},
            {"path": "big.py", "start": 301, "end": 301},
        ],
    )
    assert "MARKER_A" in out, out
    assert "MARKER_B" in out, out


async def test_read_dict_range_bad_keys_reported():
    """A dict range with no usable start/offset is REPORTED, not silent."""
    root = _make_big_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["read"](filePaths=["big.py"], ranges=[{"from": 2, "to": 2}])
    assert "unparsed ranges ignored" in out, out
