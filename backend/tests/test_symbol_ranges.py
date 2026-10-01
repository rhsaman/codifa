"""Symbol ranges (start-end lines) for TS/TSX and Python.

Run: cd backend && uv run python -m pytest tests/test_symbol_ranges.py -q
"""
import os

from symbol_index import (
    enclosing_symbol,
    find_symbol_range,
    format_symbol_map,
    get_symbol_ranges,
)


def _write(root, rel, content):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(content)


def test_tsx_function_range(tmp_path):
    _write(
        tmp_path,
        "src/A.tsx",
        "export function DiffView() {\n  const x = 1\n  return x\n}\n"
        "export const helper = () => ({})\n",
    )
    p = os.path.join(str(tmp_path), "src/A.tsx")
    assert find_symbol_range(p, "DiffView") == (1, 4, "function")
    assert find_symbol_range(p, "helper") == (5, 5, "function")
    assert find_symbol_range(p, "missing") is None


def test_ts_interface_and_method_ranges(tmp_path):
    _write(
        tmp_path,
        "src/b.ts",
        "export interface Foo {\n  x: string\n}\n"
        "export class Bar {\n  baz() {\n    return 1\n  }\n}\n",
    )
    p = os.path.join(str(tmp_path), "src/b.ts")
    assert find_symbol_range(p, "Foo") == (1, 3, "interface")
    assert find_symbol_range(p, "Bar")[0] == 4
    assert find_symbol_range(p, "baz") == (5, 7, "method")


def test_python_nested_ranges(tmp_path):
    _write(
        tmp_path,
        "m.py",
        "def outer():\n    def inner():\n        pass\n    return inner\n",
    )
    p = os.path.join(str(tmp_path), "m.py")
    assert find_symbol_range(p, "outer") == (1, 4, "function")
    assert find_symbol_range(p, "inner") == (2, 3, "function")


def test_format_map_shows_ranges(tmp_path):
    _write(tmp_path, "a.ts", "export function hello() {\n  return 1\n}\n")
    out = format_symbol_map(str(tmp_path))
    assert "hello" in out
    assert "L1-3" in out


def test_get_symbol_ranges_case_insensitive(tmp_path):
    _write(tmp_path, "c.ts", "export function CamelCase() {\n}\n")
    p = os.path.join(str(tmp_path), "c.ts")
    assert get_symbol_ranges(p).get("camelcase") == (1, 2, "function")


def test_top_level_const_indexed(tmp_path):
    _write(
        tmp_path,
        "k.ts",
        "export const LIMIT = 640;\nexport function use() {\n  return LIMIT\n}\n",
    )
    p = os.path.join(str(tmp_path), "k.ts")
    assert find_symbol_range(p, "LIMIT") == (1, 1, "constant")
    assert find_symbol_range(p, "use") == (2, 4, "function")


def test_python_module_const_indexed(tmp_path):
    _write(tmp_path, "m.py", "MAX_FOO = 1\nx: int = 2\ndef f():\n    pass\n")
    p = os.path.join(str(tmp_path), "m.py")
    assert find_symbol_range(p, "MAX_FOO") == (1, 1, "constant")
    assert find_symbol_range(p, "x") == (2, 2, "constant")


def test_parse_failure_not_cached(tmp_path):
    import symbol_index as _si

    p = os.path.join(str(tmp_path), "bad.py")
    with open(p, "w") as fh:
        fh.write("def broken(:\n")
    assert _si.get_symbol_ranges(p) == {}
    # Failure must not poison the mtime cache: fix the file, same mtime
    # granularity is fine — the point is no stale empty entry persists.
    with open(p, "w") as fh:
        fh.write("def fixed():\n    pass\n")
    os.utime(p, (os.path.getmtime(p), os.path.getmtime(p)))
    assert find_symbol_range(p, "fixed") == (1, 2, "function")


def test_display_hides_nested_boosts_mentioned(tmp_path):
    _write(
        tmp_path,
        "m.py",
        "def zebra():\n    pass\ndef alpha():\n    def inner():\n        pass\n    return inner\n",
    )
    out = format_symbol_map(str(tmp_path), mentioned_idents={"alpha"})
    assert "inner" not in out  # nested helper stays out of display slots
    assert out.index("alpha") < out.index("zebra")  # mentioned first
    assert "L3-6" in out  # Python end lines shown (alpha spans 3-6)


def test_enclosing_symbol_innermost(tmp_path):
    _write(
        tmp_path,
        "m.py",
        "def outer():\n    def inner():\n        x = 1\n    return inner\n",
    )
    p = os.path.join(str(tmp_path), "m.py")
    assert enclosing_symbol(p, 3) == ("inner", 2, 3, "function")
    assert enclosing_symbol(p, 1)[0] == "outer"
    assert enclosing_symbol(p, 99) is None
