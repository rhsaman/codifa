"""Re-read nudge: a read window mostly already fetched this turn reminds
the model to reuse context instead of burning another round-trip.

Run: cd backend && uv run python -m pytest tests/test_reread_nudge.py -q
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-reread-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from llm import _read_windows, _SeenWindows


def _tc(name, args, cid="c1"):
    return {"name": name, "args": args, "id": cid}


def test_read_windows_offset_limit():
    assert _read_windows({"filePath": "a.py", "offset": 10, "limit": 5}) == [
        ("a.py", 10, 14)
    ]


def test_read_windows_filepaths_and_ranges():
    out = _read_windows(
        {"filePath": "a.py", "filePaths": ["b.py"], "ranges": ["c.py:1:3"]}
    )
    assert ("c.py", 1, 3) in out
    assert ("a.py", 1, 2000) in out
    assert ("b.py", 1, 2000) in out


def test_read_windows_symbols_skipped():
    # symbols= reads are precise by construction — never nudge-bait.
    assert _read_windows({"filePath": "a.py", "symbols": ["Foo"]}) == []


def test_read_windows_bad_values_safe():
    assert _read_windows({"filePath": "a.py", "offset": "x", "limit": None}) == [
        ("a.py", 1, 2000)
    ]
    assert _read_windows({"filePath": "", "ranges": ["bad"]}) == []


def test_no_hint_on_first_read():
    t = _SeenWindows()
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})]) == ""


def test_hint_on_covered_window():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})])
    hint = t.observe([_tc("read", {"filePath": "a.py", "offset": 640, "limit": 220})])
    assert "a.py" in hint
    assert "640-859" in hint
    assert "REREAD" in hint


def test_no_hint_on_disjoint_window():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100})])
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 500, "limit": 100})]) == ""


def test_no_hint_below_threshold():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100})])
    # 50/100 covered < 0.8 → no nudge (genuine extension read).
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 51, "limit": 100})]) == ""


def test_hint_at_threshold():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100})])
    # 80/100 covered == 0.8 → nudge fires.
    hint = t.observe([_tc("read", {"filePath": "a.py", "offset": 21, "limit": 100})])
    assert "REREAD" in hint


def test_each_window_keeps_nudging_while_covered():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})])
    args = {"filePath": "a.py", "offset": 640, "limit": 220}
    assert t.observe([_tc("read", args)]) != ""
    # Ignoring the hint must not be free: the repeat warns again on every
    # later step while the coverage still holds (the old once-per-turn
    # silence let the model learn that re-reading had no cost).
    assert t.observe([_tc("read", args)]) != ""
    assert t.observe([_tc("read", args)]) != ""


def test_edit_invalidates():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})])
    t.observe([_tc("edit_file", {"path": "a.py", "old_string": "x", "new_string": "y"})])
    # Post-edit re-read is legitimate — no nudge.
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})]) == ""


def test_clear_resets():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000})])
    t.clear()
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 640, "limit": 220})]) == ""


def test_non_read_calls_ignored():
    t = _SeenWindows()
    assert t.observe([_tc("grep", {"pattern": "foo"})]) == ""
    assert t.observe([]) == ""


def test_ranges_member_overlap():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "ranges": ["a.py:1:500"]})])
    hint = t.observe([_tc("read", {"filePath": "a.py", "ranges": ["a.py:100:50"]})])
    assert "REREAD" in hint


def test_separation_none_on_overlap():
    assert _SeenWindows._separation(10, 20, [(15, 25)]) is None
    assert _SeenWindows._separation(10, 20, []) is None
    assert _SeenWindows._separation(10, 20, [(30, 40)]) == 9
    assert _SeenWindows._separation(30, 40, [(10, 20), (100, 110)]) == 9


def test_adjacent_gap_nudges_once_per_path():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 2040, "limit": 120})])
    hint = t.observe([_tc("read", {"filePath": "a.py", "offset": 2240, "limit": 273})])
    assert "REREAD" in hint
    assert "80 lines later" in hint
    # Second adjacent read on the same path stays silent (no nagging).
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 2600, "limit": 50})]) == ""


def test_contiguous_paging_stays_silent():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100})])
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 101, "limit": 100})]) == ""


def test_far_window_stays_silent():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100})])
    assert t.observe([_tc("read", {"filePath": "a.py", "offset": 500, "limit": 100})]) == ""


def test_ledger_footer_consolidated_to_step_line(tmp_path):
    """The per-block "Also fetched this turn" note is gone: N blocks no
    longer repeat N reminders. Coverage is reported once per step via
    context_ledger_line (sent transiently with the next request)."""
    import tools
    from tool_batching import reset_read_ledger

    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 401)))
    root = str(tmp_path)
    captured = []
    cbs = tools.make_tool_callbacks(root, captured.append)
    read = cbs["read"]
    reset_read_ledger()
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 50})])

    import asyncio

    out = asyncio.run(read(filePath="a.py", offset=200, limit=50))
    assert "Also fetched this turn" not in out


def test_ledger_empty_without_observe(tmp_path):
    import tools
    from tool_batching import reset_read_ledger

    (tmp_path / "a.py").write_text("".join(f"line{i}\n" for i in range(1, 401)))
    root = str(tmp_path)
    captured = []
    cbs = tools.make_tool_callbacks(root, captured.append)

    import asyncio

    reset_read_ledger()
    out = asyncio.run(cbs["read"](filePath="a.py", offset=200, limit=50))
    assert "Also fetched this turn" not in out


def test_check_covered_full_window():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000}, "c1")])
    stubs = t.check_covered(
        [_tc("read", {"filePath": "a.py", "offset": 640, "limit": 220}, "c2")]
    )
    assert set(stubs) == {"c2"}
    assert "SKIPPED (already in context)" in stubs["c2"]
    assert "640-859" in stubs["c2"]


def test_check_covered_partial_window_none():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c1")])
    assert (
        t.check_covered(
            [_tc("read", {"filePath": "a.py", "offset": 51, "limit": 100}, "c2")]
        )
        == {}
    )


def test_check_covered_skips_batches_symbols_edits():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 2000}, "c1")])
    # Multi-path batch keeps content.
    assert (
        t.check_covered(
            [
                _tc(
                    "read",
                    {"filePath": "a.py", "filePaths": ["b.py"]},
                    "c2",
                )
            ]
        )
        == {}
    )
    # symbols= keeps content.
    assert (
        t.check_covered([_tc("read", {"filePath": "a.py", "symbols": ["F"]}, "c3")])
        == {}
    )
    # Edited path keeps content.
    t.observe([_tc("edit_file", {"path": "a.py", "old_string": "x", "new_string": "y"}, "c4")])
    assert (
        t.check_covered([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 10}, "c5")])
        == {}
    )


def test_check_covered_heals_after_clean_reread():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c1")])
    t.observe([_tc("edit_file", {"path": "a.py", "old_string": "x", "new_string": "y"}, "c2")])
    # Clean re-read after the edit heals caution...
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c3")])
    # ...so a further identical re-read is stub-eligible again.
    stubs = t.check_covered([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c4")])
    assert set(stubs) == {"c4"}


def test_check_covered_same_step_edit_stays_cautious():
    t = _SeenWindows()
    t.observe([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c1")])
    # Edit + read in the SAME step: the read ran pre-edit, content is stale.
    t.observe(
        [
            _tc("edit_file", {"path": "a.py", "old_string": "x", "new_string": "y"}, "c2"),
            _tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c3"),
        ]
    )
    assert (
        t.check_covered([_tc("read", {"filePath": "a.py", "offset": 1, "limit": 100}, "c4")])
        == {}
    )


class _RereadLoopModel:
    """Step 1 reads the whole file, step 2 re-reads a covered window.

    The loop must substitute a stub for the second result instead of
    re-sending the body — and the REREAD note must reach the model.
    """

    model_name = "fake-reread-loop"

    def __init__(self):
        self._step = 0
        self.saw_stub = False
        self.saw_note = False

    def bind_tools(self, tools):
        outer = self

        class _Bound:
            async def ainvoke(self, msgs):
                from langchain_core.messages import HumanMessage, ToolMessage

                outer._step += 1
                for msg in msgs:
                    if isinstance(msg, ToolMessage) and "SKIPPED (already in context)" in str(
                        getattr(msg, "content", "")
                    ):
                        outer.saw_stub = True
                    if isinstance(msg, HumanMessage) and "REREAD NOTE" in str(
                        getattr(msg, "content", "")
                    ):
                        outer.saw_note = True
                if outer._step == 1:
                    return _ai_read("a.py", 1, 2000, "call_1")
                if outer._step == 2:
                    return _ai_read("a.py", 640, 220, "call_2")
                return _ai_text("done")

        return _Bound()


def _ai_read(path, offset, limit, cid):
    from langchain_core.messages import AIMessage

    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "read",
                "args": {"filePath": path, "offset": offset, "limit": limit},
                "id": cid,
            }
        ],
    )


def _ai_text(text):
    from langchain_core.messages import AIMessage

    return AIMessage(content=text)


def test_loop_stubs_covered_reread():
    import asyncio

    from llm import langchain_tool_loop as _tool_loop

    async def read(**kwargs):
        return "FULL BODY " * 200

    model = _RereadLoopModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="read the file twice",
            tools={"read": read},
            max_steps=6,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_stub, "covered re-read must be stubbed in the transcript"
    assert model.saw_note, "REREAD note must reach the model"


def test_is_plan_only_step():
    from llm import _is_plan_only_step

    assert _is_plan_only_step([_tc("update_plan", {})]) is True
    assert (
        _is_plan_only_step(
            [_tc("update_plan", {}), _tc("read", {"filePath": "a.py"})]
        )
        is False
    )
    assert _is_plan_only_step([_tc("read", {"filePath": "a.py"})]) is False
    assert _is_plan_only_step([]) is False
    assert _is_plan_only_step(None) is False


class _PlanOnlyLoopModel:
    """Step 1 calls update_plan alone; the loop must answer with the
    batch-it reminder before step 2."""

    model_name = "fake-plan-only-loop"

    def __init__(self):
        self._step = 0
        self.saw_note = False

    def bind_tools(self, tools):
        outer = self

        class _Bound:
            async def ainvoke(self, msgs):
                from langchain_core.messages import AIMessage, HumanMessage

                outer._step += 1
                for msg in msgs:
                    if isinstance(msg, HumanMessage) and "PLAN-ONLY STEP" in str(
                        getattr(msg, "content", "")
                    ):
                        outer.saw_note = True
                if outer._step == 1:
                    return AIMessage(
                        content="",
                        tool_calls=[{"name": "update_plan", "args": {}, "id": "p1"}],
                    )
                return AIMessage(content="done")

        return _Bound()


def test_loop_nudges_plan_only_step():
    import asyncio

    from llm import langchain_tool_loop as _tool_loop

    async def update_plan(**kwargs):
        return "plan updated"

    model = _PlanOnlyLoopModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="do the task",
            tools={"update_plan": update_plan},
            max_steps=4,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_note, "plan-only step must trigger the batch-it reminder"
