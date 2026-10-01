"""Batch list args sometimes arrive as JSON-encoded strings.

The model occasionally sends e.g. patterns='["a", "b"]' instead of
patterns=["a", "b"]. Iterating that string split it into characters and
produced garbage searches (``No matches for '...[|"|e|m|b|...'``). Batch
args must parse JSON-array strings, keep real lists intact, and treat any
other string as a single item.
"""
import os
import tempfile
import textwrap

from tools import make_tool_callbacks


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
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["glob"]("*.py", patterns='["*.ts"]')
    assert "app.py" in out, out
    assert "other.ts" in out, out
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
