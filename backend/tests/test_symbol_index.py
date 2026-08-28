"""تست‌های نقشه‌ی نماد لحظه‌ای (symbol_index)."""

from __future__ import annotations

import os
import tempfile

from symbol_index import build_symbol_map, format_symbol_map


def _write(root: str, rel: str, content: str) -> None:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def test_build_symbol_map_python():
    with tempfile.TemporaryDirectory() as d:
        _write(
            d,
            "sample.py",
            "def foo():\n    pass\n\nclass Bar:\n    def baz(self):\n        pass\n",
        )
        sym_map = build_symbol_map(d)
        assert "sample.py" in sym_map
        names = {name for name, _, _ in sym_map["sample.py"]}
        assert "foo" in names
        assert "Bar" in names


def test_build_symbol_map_ts():
    with tempfile.TemporaryDirectory() as d:
        _write(
            d,
            "src/comp.ts",
            "function hello() {}\n\nclass World {}\n",
        )
        sym_map = build_symbol_map(d)
        assert "src/comp.ts" in sym_map
        names = {name for name, _, _ in sym_map["src/comp.ts"]}
        assert "hello" in names
        assert "World" in names


def test_format_symbol_map_includes_line_numbers():
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def x():\n    pass\n")
        out = format_symbol_map(d)
        assert "a.py" in out
        assert "x" in out
        assert "function x (L1)" in out  # امضا: نام + خط (بدون بدنه)


def test_skip_dirs_and_binary():
    with tempfile.TemporaryDirectory() as d:
        _write(d, "node_modules/dep.py", "def hidden():\n    pass\n")
        _write(d, "real.py", "def visible():\n    pass\n")
        sym_map = build_symbol_map(d)
        assert "real.py" in sym_map
        assert "node_modules/dep.py" not in sym_map


def test_empty_project():
    with tempfile.TemporaryDirectory() as d:
        assert build_symbol_map(d) == {}
        assert format_symbol_map(d) == ""


def test_format_symbol_map_ranks_mentioned_files():
    """فایل ذکرشده (mentioned) باید بالاتر از فایل‌های دیگه بیاد."""
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    pass\n")
        out = format_symbol_map(d, mentioned_fnames={"b.py"})
        idx_a = out.find("a.py")
        idx_b = out.find("b.py")
        assert idx_a != -1 and idx_b != -1
        assert idx_b < idx_a  # b.py بالاتر (mentioned)


def test_format_symbol_map_ranks_referenced_files():
    """فایل تعریف‌کننده (referenced) باید بالاتر از فایل ارجاع‌دهنده بیاد."""
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    return foo()\n")  # b.py ارجاع به foo (توی a.py)
        out = format_symbol_map(d)
        idx_a = out.find("a.py")
        idx_b = out.find("b.py")
        assert idx_a != -1 and idx_b != -1
        assert idx_a < idx_b  # a.py بالاتر (foo تعریف شده اینجا، b.py ارجاع می‌ده)


def test_looks_like_code_ident_filter():
    """فیلتر استخراج mentioned_idents نباید کلمات ساده‌ی انگلیسی رو
    به‌عنوان identifier کد قبول کنه (نویز) — فقط snake/camel/Pascal واقعی."""
    from symbol_index import _looks_like_code_ident

    # کلمات ساده انگلیسی نباید قبول بشن (نویز)
    assert not _looks_like_code_ident("data")
    assert not _looks_like_code_ident("state")
    assert not _looks_like_code_ident("path")
    assert not _looks_like_code_ident("read")
    assert not _looks_like_code_ident("result")
    assert not _looks_like_code_ident("content")

    # identifierهای واقعی (snake/camel/Pascal + طول >= 8)
    assert _looks_like_code_ident("user_service")
    assert _looks_like_code_ident("buildSymbolMap")
    assert _looks_like_code_ident("HttpRequest")
    assert _looks_like_code_ident("cache_manager")
