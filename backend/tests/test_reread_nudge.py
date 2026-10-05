"""Read windows helper + plan-only step: repeats always re-serve.

There is no re-read nudge or coverage stub: every read serves its full
content, so a repeated window is simply served again.

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

from llm import _read_windows


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
    # symbols= reads resolve server-side to exact ranges.
    assert _read_windows({"filePath": "a.py", "symbols": ["Foo"]}) == []


def test_read_windows_bad_values_safe():
    assert _read_windows({"filePath": "a.py", "offset": "x", "limit": None}) == [
        ("a.py", 1, 2000)
    ]
    assert _read_windows({"filePath": "", "ranges": ["bad"]}) == []


class _RepeatReadLoopModel:
    """Step 1 reads the whole file, step 2 re-reads a covered window.

    Both results must carry the full body — no stub, no re-read note.
    """

    model_name = "fake-repeat-read-loop"

    def __init__(self):
        self._step = 0
        self.bodies = 0

    def bind_tools(self, tools):
        outer = self

        class _Bound:
            async def ainvoke(self, msgs):
                from langchain_core.messages import ToolMessage

                outer._step += 1
                for msg in msgs:
                    if isinstance(msg, ToolMessage) and "FULL BODY" in str(
                        getattr(msg, "content", "")
                    ):
                        outer.bodies += 1
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


def test_loop_reserves_repeat_reads():
    import asyncio

    from llm import langchain_tool_loop as _tool_loop

    async def read(**kwargs):
        return "FULL BODY " * 200

    model = _RepeatReadLoopModel()
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
    assert model.bodies >= 2, "both reads must serve the full body"


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
