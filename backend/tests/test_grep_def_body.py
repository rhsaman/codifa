"""grep inlines definition bodies for matches on the def line itself.

A `grep def foo` must return foo's whole body (bounded), killing the
grep-def -> read-body round trip. Matches INSIDE a body keep the plain
snippet (no duplication), and bodies respect the per-body line cap and the
per-call body count cap.
"""
import os
import tempfile

from tools import make_tool_callbacks


def _write(root, name, content):
    with open(os.path.join(root, name), "w") as f:
        f.write(content)


def _make_ws():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    # Built line-by-line (no dedent): def L1, 18 body statements L2-19.
    lines = ["def target_fn():"]
    lines += [f"    step_{i:02d}()" for i in range(1, 19)]
    lines += [
        "",
        "result = target_fn()  # CALLSITE-1",
        "print(result)  # CALLSITE-2",
        "x = 1  # CALLSITE-3",
        "y = 2  # CALLSITE-4",
        "z = 3  # CALLSITE-5",
    ]
    _write(root, "app.py", "\n".join(lines) + "\n")
    return root


async def test_grep_def_match_inlines_body():
    """Match on the def line -> full body inline, no follow-up read needed."""
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("def target_fn")
    assert "app.py:1:" in out
    assert "in target_fn (L1-19)" in out
    # Body lines far beyond the +/-3 snippet are present inline.
    assert "step_18()" in out


async def test_grep_body_match_keeps_snippet_only():
    """Match inside a body -> plain snippet, NOT the whole function again."""
    root = _make_ws()
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("CALLSITE-3")
    assert "CALLSITE-3" in out
    # The def line of the enclosing scope is NOT expanded for a body match.
    assert "step_18()" not in out


async def test_grep_long_body_truncated_with_pointer():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    body = "\n".join(f"    work_{i:03d}()" for i in range(1, 101))
    _write(root, "big.py", f"def huge():\n{body}\n")
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("def huge")
    assert "work_001()" in out
    # Capped at 60 lines with a pointer to the rest (no silent cut).
    assert "more lines to L101" in out
    assert "work_100()" not in out


async def test_grep_body_count_capped():
    """Many def matches -> first 6 bodies inline, rest keep snippet + note."""
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    parts = []
    for n in range(8):
        # 8 real statements per def (Lk..Lk+7); the LAST statement proves the
        # body was inlined (the +/-1 snippet only reaches the first line).
        fn_body = "\n".join(f"    h{n}_step{k}()" for k in range(7))
        parts.append(f"def handler_{n}():\n{fn_body}\n    h{n}_step6()\n")
    _write(root, "many.py", "\n".join(parts))
    cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
    out = await cbs["grep"]("def handler_")
    for n in range(6):
        assert f"h{n}_step6()" in out, f"body {n} should be inlined"
    assert "h6_step6()" not in out
    assert "h7_step6()" not in out
    assert "2 definition bodies omitted" in out
