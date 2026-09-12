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
    # Compact `path:line:text` form with a few lines of surrounding context
    # (SNIPPET_CONTEXT) so a `read` is usually unnecessary.
    assert "app.py:4:" in out
    assert "return compute()  # TARGET" in out
    # Surrounding context is bundled (helps the model avoid extra reads).
    # نکته: grep فقط ±SNIPPET_CONTEXT (3) خط اطراف match برمی‌گردونه،
    # پس خط ۲ (setup_one) نمایش داده نمی‌شه — این رفتار درسته.


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


async def test_grep_patterns_batch_single_scan():
    """چند الگو در یک فراخوانی → یک اسکن دیسک و خروجی ترکیبی.

    رگرسیونِ مصرف توکن: قبلاً مدل برای هر term یک grep جدا می‌زد و هر
    فراخوانی کل مکالمه را دوباره به API می‌فرستاد. حالا patterns=[...]
    همه را در یک regex ترکیبی و یک ToolMessage برمی‌گرداند.
    """
    import tools as _tools

    root = _make_ws()
    scans = {"n": 0}
    _orig = _tools.search_in_files

    def _counting(*a, **k):
        scans["n"] += 1
        return _orig(*a, **k)

    _tools.search_in_files = _counting
    _tools._parent_search_cache.clear()
    try:
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["grep"]("TARGET", patterns=["gamma", "alpha"])
        # یک فراخوانی = دقیقاً یک اسکن دیسک (نه سه تا).
        assert scans["n"] == 1, scans
        # هدر الگوی ترکیبی و نتایج هر دو term در همان ToolMessage.
        assert out.startswith("MATCHES for 'TARGET|gamma|alpha'"), out
        assert "app.py:4:" in out  # TARGET
        assert "app.py:7:" in out  # gamma
    finally:
        _tools.search_in_files = _orig
        _tools._parent_search_cache.clear()


async def test_grep_patterns_dedup_and_empty():
    """الگوی تکراری/خالی حذف می‌شود؛ بدون patterns رفتار تک‌الگویی می‌ماند."""
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("TARGET", patterns=["TARGET", "", "gamma"])
    assert out.startswith("MATCHES for 'TARGET|gamma'"), out
    single = await cbs["grep"]("TARGET")
    assert single.startswith("MATCHES for 'TARGET'"), single


def _make_glob_ws():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    for name in ("a.py", "b.ts", "c.test.ts"):
        with open(os.path.join(root, name), "w") as f:
            f.write("x = 1\n")
    return root


async def test_glob_patterns_batch_merges_results():
    """چند glob در یک فراخوانی → نتایج merge و بدون تکرار."""
    root = _make_glob_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["glob"]("*.py", patterns=["*.ts"])
    assert out.startswith("GLOB MATCHES for '*.py|*.ts'"), out
    assert "a.py" in out
    assert "b.ts" in out
    assert "c.test.ts" in out
    # بدون patterns رفتار تک‌الگویی می‌ماند.
    single = await cbs["glob"]("*.py")
    assert single.startswith("GLOB MATCHES for '*.py'"), single
    assert "b.ts" not in single
