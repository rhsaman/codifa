"""Grep always serves its matches: a narrower grep on already-read lines
re-serves the full rows instead of stubbing with a pointer.
"""
from pathlib import Path


def _ws(root):
    with open(f"{root}/a.py", "w") as f:
        f.write(
            "filler one\n"
            "alpha first marker\n"
            "beta second marker\n"
            "alpha third marker\n"
            "filler five\n"
            "filler six\n"
        )


def _cbs(root):
    import tools

    return tools.make_tool_callbacks(root, lambda ev: None, main_model=None)


async def test_narrower_grep_on_served_lines_serves(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    assert "alpha first marker" in out1, out1
    out2 = await cbs["grep"]("beta", path="a.py")
    assert "MATCHES for" in out2, out2
    assert "beta second marker" in out2, out2


async def test_grep_with_unserved_match_serves(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("six", path="a.py")
    assert "MATCHES for" in out2, out2
    assert "filler six" in out2, out2


async def test_edit_then_grep_serves_fresh_rows(tmp_path):
    root = str(tmp_path)
    _ws(root)
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("beta", path="a.py")
    assert "MATCHES for" in out2, out2
    await cbs["edit_file"]("a.py", "beta second marker", "beta second edited")
    out3 = await cbs["grep"]("beta", path="a.py")
    assert "MATCHES for" in out3, out3
    assert "beta second edited" in out3, out3


async def test_multi_file_scope_always_serves(tmp_path):
    root = str(tmp_path)
    _ws(root)
    Path(root, "b.py").write_text("filler one\nbeta other file\nfiller three\n")
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("beta", path="")
    assert "MATCHES for" in out2, out2
