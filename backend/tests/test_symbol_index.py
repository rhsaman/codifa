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
        assert "function x (L1-2)" in out  # امضا: نام + بازه خط (بدون بدنه)


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


def test_rank_with_laya_empty_query_fallback():
    """وقتی query خالی است باید بدون خطا [] برگردد (fallback)."""
    from symbol_index import rank_with_laya

    assert rank_with_laya("", [{"name": "a.py", "description": "foo"}]) == []
    assert rank_with_laya("   ", [{"name": "a.py"}]) == []


def test_rank_with_laya_no_signal_fallback(monkeypatch):
    """وقتی laya سیگنالی ندارد، ترتیب قبلی حفظ شود."""
    import symbol_index

    monkeypatch.setattr(symbol_index, "rank_with_laya", lambda q, c, top_k=None: [])
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    pass\n")
        out = format_symbol_map(d, query="something unrelated xyz")
        assert "a.py" in out and "b.py" in out


def test_rank_with_laya_reorders(monkeypatch):
    """وقتی laya سیگنال دارد، فایل مرتبط باید اول بیاید."""
    import symbol_index

    def fake_rank(query, candidates, top_k=None):
        # b.py را مرتبط‌تر نشان بده
        ordered = sorted(candidates, key=lambda c: 0 if c["name"] == "b.py" else 1)
        return [{"name": c["name"], "confidence": 0.9, "score": 1.0, "reason": "embedding-rank"} for c in ordered]

    monkeypatch.setattr(symbol_index, "rank_with_laya", fake_rank)
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    pass\n")
        out = format_symbol_map(d, query="bar feature")
        assert out.find("b.py") < out.find("a.py")


def test_rerank_cache_reuses_result_for_repeat_query(monkeypatch):
    # Repeat turns with the same query over unchanged files must reuse the
    # cached order instead of paying the embedding cost again.
    import symbol_index

    calls: list[str] = []

    def fake_rank(query, candidates, top_k=None):
        calls.append(query)
        ordered = sorted(candidates, key=lambda c: 0 if c["name"] == "b.py" else 1)
        return [{"name": c["name"], "confidence": 0.9, "score": 1.0, "reason": "embedding-rank"} for c in ordered]

    monkeypatch.setattr(symbol_index, "rank_with_laya", fake_rank)
    symbol_index._RERANK_CACHE.clear()
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    pass\n")
        out1 = format_symbol_map(d, query="repeat-query-cache-probe-xyz")
        out2 = format_symbol_map(d, query="repeat-query-cache-probe-xyz")
    assert len(calls) == 1
    assert out1 == out2
    assert out1.find("b.py") < out1.find("a.py")


def test_rerank_cache_miss_on_new_query_or_new_file(monkeypatch):
    import symbol_index

    calls: list[str] = []

    def fake_rank(query, candidates, top_k=None):
        calls.append(query)
        return [{"name": c["name"], "confidence": 0.9, "score": 1.0, "reason": "embedding-rank"} for c in candidates]

    monkeypatch.setattr(symbol_index, "rank_with_laya", fake_rank)
    symbol_index._RERANK_CACHE.clear()
    with tempfile.TemporaryDirectory() as d:
        _write(d, "a.py", "def foo():\n    pass\n")
        _write(d, "b.py", "def bar():\n    pass\n")
        format_symbol_map(d, query="first-cache-miss-probe-xyz")
        format_symbol_map(d, query="second-cache-miss-probe-xyz")
        assert len(calls) == 2
        _write(d, "c.py", "def baz():\n    pass\n")
        format_symbol_map(d, query="second-cache-miss-probe-xyz")
        assert len(calls) == 3
