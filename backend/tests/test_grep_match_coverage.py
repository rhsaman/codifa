"""Single-file grep served-rows stub: when every match of a grep on ONE file
sits on lines already served (same-turn reads/greps or a previous turn,
byte-unchanged), the rows are re-sent for zero benefit — stub with a
pointer instead.

Mirrors the trace ping-pong (grep a file, read its body, grep a narrower
term on the same file): the narrower rows were already shown, so only a
narrower *unserved* term, another scope, or an edit re-serves.
"""
from pathlib import Path

from tool_batching import reset_turn_seen_calls


def _fresh():
    reset_turn_seen_calls()


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


async def test_narrower_grep_on_served_lines_stubs(tmp_path):
    root = str(tmp_path)
    _ws(root)
    _fresh()
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    assert "alpha first marker" in out1, out1
    # "beta" is a fresh word (no subset/containment stub applies), but its
    # only match (line 3) sits inside the served snippets ([1,5] and [1,7]).
    out2 = await cbs["grep"]("beta", path="a.py")
    assert "MATCHES for" not in out2, out2
    assert "already served" in out2, out2
    assert "beta second marker" not in out2, out2


async def test_grep_with_unserved_match_serves(tmp_path):
    root = str(tmp_path)
    _ws(root)
    _fresh()
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    # "six" matches line 6: its ±3 window [3,9] extends past the served
    # [1,7] — genuinely new rows, so it serves whole.
    out2 = await cbs["grep"]("six", path="a.py")
    assert "MATCHES for" in out2, out2
    assert "filler six" in out2, out2


async def test_edit_clears_served_match_stub(tmp_path):
    root = str(tmp_path)
    _ws(root)
    _fresh()
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="a.py")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("beta", path="a.py")
    assert "already served" in out2, out2
    # Tool edit drops the served spans: the same grep re-serves fresh rows.
    await cbs["edit_file"]("a.py", "beta second marker", "beta second edited")
    out3 = await cbs["grep"]("beta", path="a.py")
    assert "MATCHES for" in out3, out3
    assert "beta second edited" in out3, out3
    assert "already served" not in out3, out3


async def test_multi_file_scope_always_serves(tmp_path):
    root = str(tmp_path)
    _ws(root)
    Path(root, "b.py").write_text("filler one\nbeta other file\nfiller three\n")
    _fresh()
    cbs = _cbs(root)
    out1 = await cbs["grep"]("alpha", path="")
    assert "MATCHES for" in out1, out1
    # Workspace scope spans files — the single-file rule never applies.
    out2 = await cbs["grep"]("beta", path="")
    assert "MATCHES for" in out2, out2
