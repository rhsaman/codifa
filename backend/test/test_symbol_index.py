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
        assert "L1" in out  # خط ۱


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
