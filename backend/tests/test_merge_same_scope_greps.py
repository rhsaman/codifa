"""Same-step same-scope greps merge into one scan (tool_batching).

Back-to-back greps on one scope are one search the model split in two:
the loop executes a single combined grep and fans the result out (owner
keeps the block, siblings get it verbatim when short else a pointer).
Different scopes never merge (Cartesian over-scan); batch params already
present pass through; non-greps pass through; order is preserved.
"""
from tool_batching import merge_same_scope_greps


def _tc(name, args, cid):
    return {"name": name, "args": dict(args), "id": cid}


def test_merge_same_scope_pair():
    tcs = [
        _tc("grep", {"pattern": "foo", "path": "backend"}, "1"),
        _tc("grep", {"pattern": "bar", "path": "backend"}, "2"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    assert len(ex) == 1, ex
    assert ex[0]["args"]["pattern"] == "foo", ex
    assert ex[0]["args"]["patterns"] == ["bar"], ex
    assert ex[0]["id"] == "1", ex
    out = expand(["FULL-BLOCK"])
    assert out == ["FULL-BLOCK", "FULL-BLOCK"], out


def test_long_result_owner_keeps_pointer_for_sibling():
    tcs = [
        _tc("grep", {"pattern": "foo", "path": "backend"}, "1"),
        _tc("grep", {"pattern": "bar", "path": "backend"}, "2"),
    ]
    _, expand = merge_same_scope_greps(tcs)
    big = "x" * 2000
    out = expand([big])
    assert out[0] == big, out
    assert "merged grep" in out[1] and "foo|bar" in out[1], out
    assert len(out[1]) < len(big), out


def test_different_scopes_never_merge():
    tcs = [
        _tc("grep", {"pattern": "foo", "path": "backend"}, "1"),
        _tc("grep", {"pattern": "bar", "path": "src"}, "2"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    assert len(ex) == 2, ex
    assert expand(["A", "B"]) == ["A", "B"], ex


def test_batch_params_and_other_tools_pass_through():
    tcs = [
        _tc("grep", {"pattern": "foo", "path": "b", "patterns": ["x"]}, "1"),
        _tc("grep", {"pattern": "bar", "path": "b"}, "2"),
        _tc("read", {"filePath": "a.py"}, "3"),
        _tc("grep", {"pattern": "", "path": "b"}, "4"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    assert len(ex) == 4, ex
    assert expand(["A", "B", "C", "D"]) == ["A", "B", "C", "D"], ex


def test_max_results_takes_max_and_order_preserved():
    tcs = [
        _tc("read", {"filePath": "a.py"}, "0"),
        _tc("grep", {"pattern": "aa", "path": "b", "max_results": 10}, "1"),
        _tc("grep", {"pattern": "bb", "path": "b", "max_results": 50}, "2"),
        _tc("grep", {"pattern": "cc", "path": "b", "max_results": 5}, "3"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    assert [c["id"] for c in ex] == ["0", "1"], ex
    assert ex[1]["args"]["patterns"] == ["bb", "cc"], ex
    assert ex[1]["args"]["max_results"] == 50, ex
    big = "R" * 2000
    out = expand(["R", big])
    assert out[0] == "R", out
    assert out[1] == big, out
    assert "merged grep" in out[2] and "merged grep" in out[3], out


def test_same_file_reads_merge_into_ranges():
    tcs = [
        _tc("read", {"filePath": "a.py", "offset": 1, "limit": 60}, "1"),
        _tc("read", {"filePath": "a.py", "offset": 200, "limit": 60}, "2"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    assert len(ex) == 1, ex
    assert ex[0]["args"]["ranges"] == ["a.py:1:60", "a.py:200:60"], ex
    big = "R" * 2000
    out = expand([big])
    assert out[0] == big, out
    assert "merged read" in out[1], out


async def test_execute_readonly_calls_runs_merged_once():
    from tool_batching import execute_readonly_calls

    seen: list[dict] = []

    async def _execute(call):
        seen.append(call)
        return f"res:{call.get('id')}"

    tcs = [
        _tc("grep", {"pattern": "foo", "path": "b"}, "1"),
        _tc("grep", {"pattern": "bar", "path": "b"}, "2"),
    ]
    ex, expand = merge_same_scope_greps(tcs)
    results = await execute_readonly_calls(ex, _execute)
    assert len(seen) == 1, seen
    assert seen[0]["args"]["patterns"] == ["bar"], seen
    out = expand(results)
    # Short results copy verbatim to every sibling (like the dup fan-out).
    assert out == ["res:1", "res:1"], out
