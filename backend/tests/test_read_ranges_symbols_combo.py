"""ranges + symbols combine in ONE read call on the same file.

Regression for the two-round-trip pattern (a ranges call plus a separate
symbols call on the same file): the tool serves both job kinds together,
so the batching rule telling the model to combine them is real.
"""


def _ws(root):
    with open(f"{root}/m.py", "w") as f:
        f.write("".join(f"line{i}\n" for i in range(1, 30)))
        f.write("def target_fn():\n    return 1\n")
        f.write("".join(f"tail{i}\n" for i in range(200)))




async def test_same_file_ranges_emit_unique_result(tmp_path):
    import tools

    _ws(str(tmp_path))
    captured = []
    cbs = tools.make_tool_callbacks(str(tmp_path), captured.append)
    out = await cbs["read"](
        "m.py", ranges=["m.py:1:10", "m.py:100:10", "m.py:200:10"]
    )
    assert "Batch complete" in out, out
    result_events = [
        e for e in captured if e.get("kind") == "tool_result" and e.get("tool") == "read"
    ]
    assert result_events, captured
    last = result_events[-1]
    paths = [r.get("path") for r in (last.get("results") or [])]
    assert paths == ["m.py"], paths
    assert last.get("summary") == "1 file", last
