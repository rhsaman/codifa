"""ranges + symbols combine in ONE read call on the same file.

Regression for the two-round-trip pattern (a ranges call plus a separate
symbols call on the same file): the tool serves both job kinds together,
so the batching rule telling the model to combine them is real.
"""
from tool_batching import reset_read_ledger, reset_turn_seen_calls


def _fresh():
    reset_read_ledger()
    reset_turn_seen_calls()


def _ws(root):
    with open(f"{root}/m.py", "w") as f:
        f.write("".join(f"line{i}\n" for i in range(1, 30)))
        f.write("def target_fn():\n    return 1\n")
        f.write("".join(f"tail{i}\n" for i in range(200)))


async def test_ranges_and_symbols_in_one_call(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None)
    out = await cbs["read"](
        "m.py", ranges=["m.py:1:10"], symbols=["target_fn"]
    )
    assert "1 | line1" in out, out
    assert "def target_fn():" in out, out
    assert "Batch complete" in out, out
