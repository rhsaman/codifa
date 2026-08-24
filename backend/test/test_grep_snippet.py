"""grep returns match locations as compact `path:line:text` lines.

The efficiency goal: a single `grep` returns the matching line only (no
surrounding code blocks), so the model scans many hits quickly and then `read`s
only the files it needs. Results are capped by `max_results` and a char budget.
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


async def test_grep_returns_path_line_text():
    root = _make_ws()
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        root, lambda ev: emitted.append(ev), main_model=None
    )
    out = await tools["grep"]("TARGET")
    assert out.startswith("MATCHES for 'TARGET'"), out
    # Compact `path:line:text` form: the matching line only, no surrounding code.
    assert "app.py:4:" in out
    assert "return compute()  # TARGET" in out
    # Surrounding lines are intentionally NOT bundled (the model reads on demand).
    assert "setup_one()" not in out
    assert "def gamma(self):" not in out


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
