"""File map for blind head reads.

A head read (offset 1, bulk limit) of a file over 400 lines returns
structure — first rows + symbol list + a copy-pasteable symbols= example —
instead of a bulk dump.
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-filemap-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _tc(name, args, cid="c1"):
    return {"name": name, "args": args, "id": cid}


def _big_py(path, n=500):
    parts = []
    for i in range(1, n + 1):
        if i % 25 == 1:
            parts.append(f"def func_{i:04d}():")
            parts.append(f"    return {i}")
            parts.append("")
        else:
            parts.append(f"value_{i:04d} = {i}")
    with open(path, "w") as f:
        f.write("\n".join(parts) + "\n")


async def test_head_read_returns_map_not_dump(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", offset=1, limit=2000)
    assert "full head not shown" in out, out
    assert "1 | " in out and "40 | " in out
    assert "500 | " not in out
    assert "func_0001" in out  # symbol list names real definitions
    assert "symbols=[" in out  # copy-pasteable follow-up


async def test_head_read_small_file_unchanged(tmp_path):
    import tools

    _big_py(str(tmp_path / "small.py"), n=350)
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("small.py", offset=1, limit=2000)
    assert "file map" not in out, out
    assert "349 | " in out or "348 | " in out


async def test_non_head_window_unaffected(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", offset=200, limit=100)
    assert "file map" not in out, out
    assert "200 | " in out


async def test_small_head_window_unaffected(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", offset=1, limit=100)
    assert "file map" not in out, out
    assert "100 | " in out


async def test_ranges_head_window_unaffected(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.py", ranges=["big.py:1:100"])
    assert "file map" not in out, out
    assert "100 | " in out


async def test_css_file_maps_without_symbols(tmp_path):
    import tools

    (tmp_path / "big.css").write_text("".join(f".c{i} {{ color: red; }}\n" for i in range(1, 601)))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"]("big.css", offset=1, limit=2000)
    assert "no indexable symbols" in out, out
    assert "60 | " in out
    assert "61 | " not in out


async def test_symbols_read_after_map_serves_body(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    await cbs["read"]("big.py", offset=1, limit=2000)  # map
    out = await cbs["read"]("big.py", symbols=["func_0001"])
    assert "ERROR" not in out, out
    assert "return 1" in out


async def test_later_window_after_map_serves_content(tmp_path):
    import tools

    _big_py(str(tmp_path / "big.py"))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    await cbs["read"]("big.py", offset=1, limit=2000)  # map
    out = await cbs["read"]("big.py", offset=450, limit=50)
    assert "ERROR" not in out, out
    assert "450 | " in out
