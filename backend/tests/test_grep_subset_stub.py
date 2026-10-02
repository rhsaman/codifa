"""Same-turn grep subset stub: a grep whose words are covered by a COMPLETE
earlier grep on the same scope stubs out instead of re-sending the rows.

Mirrors the trace waste (re-grep of SettingsModal.tsx with a narrower
pattern seconds after a broader one): the rows are already in context, so
re-scanning buys nothing. Only complete searches record coverage —
truncated ones hid rows a narrower pattern could surface.
"""
from tool_batching import reset_turn_seen_calls


def _fresh():
    reset_turn_seen_calls()


def _ws(root):
    with open(f"{root}/a.py", "w") as f:
        f.write("alpha embedding model here\nbeta laya router there\ngamma plain\n")


def _ws_many(root, n=50):
    with open(f"{root}/a.py", "w") as f:
        f.write("".join(f"hitmark line {i}\n" for i in range(n)))


async def test_subset_grep_stubs_after_complete(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("embedding|laya", path="")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("embedding", path="")
    assert "DUPLICATE" in out2, out2
    assert "covered by" in out2, out2
    assert "a.py" not in out2, out2


async def test_superset_grep_still_runs(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    await cbs["grep"]("embedding", path="")
    out = await cbs["grep"]("embedding|laya", path="")
    assert "MATCHES for" in out, out
    assert "DUPLICATE" not in out, out


async def test_other_scope_still_runs(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    await cbs["grep"]("embedding|laya", path="")
    # Different scope key scans independently — coverage never crosses scopes.
    out = await cbs["grep"]("embedding", path=".")
    assert "MATCHES for" in out, out
    assert "DUPLICATE" not in out, out


async def test_larger_max_results_still_runs(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    await cbs["grep"]("embedding|laya", path="", max_results=5)
    out = await cbs["grep"]("embedding", path="", max_results=50)
    assert "MATCHES for" in out, out
    assert "DUPLICATE" not in out, out


async def test_truncated_search_records_nothing(tmp_path):
    import tools

    _fresh()
    _ws_many(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("hitmark", path="", max_results=5)
    assert "more not shown" in out1, out1
    out2 = await cbs["grep"]("hitmark", path="", max_results=5)
    # Exact repeat hits the dup stub (fine), but a NARROWER-word subset must
    # still execute: the truncated search recorded no coverage.
    assert "DUPLICATE" in out2, out2


async def test_no_match_records_coverage(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("zxqv|nomatchhere", path="")
    assert "No matches" in out1, out1
    out2 = await cbs["grep"]("zxqv", path="")
    assert "DUPLICATE" in out2, out2


async def test_regex_operators_carry_no_signal(tmp_path):
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("embedding|\\s+laya", path="")
    assert "MATCHES for" in out1, out1
    # "\\s" contributes no word: {embedding, laya} recorded, {laya} subsets.
    out2 = await cbs["grep"]("laya", path="")
    assert "DUPLICATE" in out2 and "covered by" in out2, out2


async def test_literal_refinement_covered_by_earlier_alternative(tmp_path):
    """A later literal pattern containing an earlier literal `|`-branch stubs.

    Mirrors the trace ping-pong (broad `renderSide|...` grep, then a
    `const renderSide` refinement): the new word "const" defeats the
    word-subset rule, but every matching line still contains "renderside",
    so its rows are a subset of the complete earlier search's rows.
    """
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("embedding|laya", path="")
    assert "MATCHES for" in out1, out1
    out2 = await cbs["grep"]("alpha embedding", path="")
    assert "DUPLICATE" in out2, out2
    assert "covered by" in out2, out2


async def test_regex_refinement_still_runs(tmp_path):
    """Regex syntax in the later pattern opts out of containment (unsound).

    `embedding?` contains "embedding" as a string but also matches
    "embeddin" — its rows are NOT a subset, so it must execute. (Here the
    word-subset rule would stub it via {embedding}; that path is
    unaffected — this test pins the containment gate itself via a word the
    earlier search never saw.)
    """
    import tools

    _fresh()
    _ws(str(tmp_path))
    cbs = tools.make_tool_callbacks(str(tmp_path), lambda ev: None, main_model=None)
    out1 = await cbs["grep"]("gamma|laya", path="")
    assert "MATCHES for" in out1, out1
    # "gamma here?" has regex syntax (?), so containment is skipped; but its
    # words {gamma, here} are not a subset of {gamma, laya} ("here" is new),
    # so the search genuinely executes.
    out2 = await cbs["grep"]("gamma here?", path="")
    assert "MATCHES for" in out2 or "No matches" in out2, out2
    assert "DUPLICATE" not in out2, out2
