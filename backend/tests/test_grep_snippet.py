"""grep returns match locations AND surrounding code snippets inline.

The efficiency goal: a single `grep` replaces the old grep -> read -> read
round-trip by bundling a few context lines with every hit, so the model rarely
needs a separate `read`.
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
            setup_one()
            setup_two()
            return compute()  # TARGET

        class Beta:
            def gamma(self):
                return 42
        """
    ).lstrip()
    with open(os.path.join(root, "app.py"), "w") as f:
        f.write(src)
    return root


def _make_wide_ws():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    wide = "x" * 5000 + " MARKER\n"  # line far wider than SNIPPET_LINE_WIDTH
    with open(os.path.join(root, "big.py"), "w") as f:
        f.write(wide)
    return root


async def test_grep_includes_surrounding_lines():
    root = _make_ws()
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        root, lambda ev: emitted.append(ev), main_model=None
    )
    out = await tools["grep"]("TARGET")
    assert out.startswith("MATCHES for 'TARGET'"), out
    # The matching line is present ...
    assert "return compute()  # TARGET" in out
    # ... and so are lines BEFORE and AFTER it (the snippet), so no `read` needed.
    assert "setup_one()" in out  # a line BEFORE the hit
    assert "def gamma(self):" in out  # a line AFTER the hit (within the 3-line window)
    # The actual hit is marked with '>'.
    assert "> 4:" in out


async def test_grep_snippet_stays_bounded():
    """A broad match still respects the per-match snippet width cap."""
    root = _make_wide_ws()
    tools = make_tool_callbacks(
        root, lambda ev: None, main_model=None
    )
    out = await tools["grep"]("MARKER")
    # snippet line truncated to SNIPPET_LINE_WIDTH (240), not the full 5000.
    assert "x" * 1000 not in out
    assert "MARKER" in out
