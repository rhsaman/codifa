"""Unit tests: doom-loop detector in ``langchain_tool_loop``.

Regression guard for the bug where a sub-agent (explore/general) issues the SAME
tool call (same name + same args) over and over, burning tokens in an infinite
loop. After the fix, ``langchain_tool_loop`` detects 3 identical consecutive
tool-call steps and forces the model to stop and report findings instead.

Covers:
- A model that repeats the same tool call 3x in a row is stopped (loop breaks).
- A model that varies its tool calls is NOT falsely stopped.
"""

import asyncio
import atexit
import os
import shutil
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-doom-")
os.environ["CODER_DATA_DIR"] = _TMP
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from langchain_core.messages import AIMessage, SystemMessage

import llm as _llm


class _FakeModel:
    """A model that always returns the same tool call (simulating a doom loop)."""

    model_name = "fake-doom"

    def __init__(self, call_name: str = "grep", call_args: dict | None = None):
        self._name = call_name
        self._call_args = call_args or {"pattern": "x"}
        self.call_count = 0

    def bind_tools(self, tools):
        # Return an object whose ainvoke returns a fixed tool-call AIMessage.
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                # Count how many times we've been asked to call a tool.
                self._model.call_count += 1
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": self._model._name,
                            "args": self._model._call_args,
                            "id": f"call-{self._model.call_count}",
                        }
                    ],
                )

        return _Bound(self)


def _make_tools():
    async def grep(**kwargs):
        return "no matches"

    return {"grep": grep}


async def _run_doom():
    model = _FakeModel()
    result = await _llm.langchain_tool_loop(
        model,
        system="",
        user="find bugs",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,  # no compaction; doom-loop detector is independent of ctx
        emit=None,
    )
    return model, result


async def _run_varied():
    """A model that varies its tool call each step should NOT be stopped."""

    class _VariedModel:
        model_name = "fake-varied"

        def __init__(self):
            self._calls = [
                {"name": "grep", "args": {"pattern": "a"}},
                {"name": "grep", "args": {"pattern": "b"}},
                {"name": "grep", "args": {"pattern": "c"}},
                {"name": "grep", "args": {"pattern": "d"}},
            ]
            self._i = 0

        def bind_tools(self, tools):
            class _Bound:
                def __init__(self, model):
                    self._model = model

                async def ainvoke(self, msgs):
                    if self._model._i >= len(self._model._calls):
                        return AIMessage(content="done")
                    c = self._model._calls[self._model._i]
                    self._model._i += 1
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": c["name"], "args": c["args"], "id": f"call-{self._model._i}"}
                        ],
                    )

            return _Bound(self)

    result = await _llm.langchain_tool_loop(
        _VariedModel(),
        system="",
        user="find bugs",
        tools=_make_tools(),
        max_steps=25,
        ctx=0,
        emit=None,
    )
    return result


def test_doom_loop_stops_after_3_identical_calls():
    model, result = asyncio.run(_run_doom())
    # The loop must break after 3 identical consecutive calls, NOT run all 25.
    assert model.call_count == 3
    assert isinstance(result, str)


def test_varied_calls_not_falsely_stopped():
    result = asyncio.run(_run_varied())
    # Varied calls should reach the final text reply ("done") without a
    # doom-loop stop being injected.
    assert result == "done"


def test_steering_messages_are_human_not_system():
    """Regression: the soft tool-call budget nudge and the doom-loop guard
    inject steering text mid-list. To keep chat templates that require the
    SystemMessage only at position 0 happy (e.g. Qwen3.5 / llama.cpp), both
    must be HumanMessage, NOT SystemMessage.

    The constants ``_TOOL_CALL_SOFT_LIMIT`` and ``_DOOM_LOOP_LIMIT`` are
    function-local in ``langchain_tool_loop``, so we don't try to monkey-patch
    them. Instead we record every snapshot the model receives and assert no
    snapshot has a SystemMessage at a mid-list position.
    """

    seen: list = []

    class _RecordingModel:
        model_name = "fake-record"

        def bind_tools(self, tools):
            class _Bound:
                def __init__(self, outer):
                    self._outer = outer
                    self._n = 0

                async def ainvoke(self, msgs):
                    # Snapshot msgs so we can check what type the steering
                    # messages are, then return a fresh tool-call to keep the
                    # loop alive for one more step.
                    seen.append(list(msgs))
                    self._n += 1
                    if self._n >= 12:
                        # Cap the loop so the test terminates.
                        return AIMessage(content="done")
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "grep",
                                "args": {"pattern": "x"},
                                "id": f"call-{self._n}",
                            }
                        ],
                    )

            return _Bound(self)

    rec = _RecordingModel()

    async def grep(**kwargs):
        return "no matches"

    async def _driver():
        await _llm.langchain_tool_loop(
            rec,
            system="sys-prompt",
            user="find bugs",
            tools={"grep": grep},
            max_steps=20,
            ctx=0,
            emit=None,
        )

    asyncio.run(_driver())

    # At least one snapshot must have been recorded (model was called).
    assert seen, "model was never called"

    # No snapshot may contain a SystemMessage at any position other than 0
    # (the initial system prompt). Steering messages that land mid-list
    # MUST be HumanMessage.
    for snapshot in seen:
        for i, m in enumerate(snapshot):
            if i == 0:
                continue  # the system prompt is allowed here
            assert not isinstance(m, SystemMessage), (
                f"SystemMessage found at mid-list position {i} — would crash "
                f"Qwen3.5 / llama.cpp templates that require SystemMessage "
                f"only at position 0. Content: {getattr(m, 'content', '')[:80]!r}"
            )


def test_empty_system_still_emits_system_message_at_index_0():
    """Regression: when ``system=""`` (empty string) is passed, ``langchain_tool_loop``
    must still place a SystemMessage at position 0 of the message list sent to the
    model. Some chat templates (e.g. Qwen3.5 / llama.cpp) crash with
    "System message must be at the beginning" if ``msgs[0]`` is a HumanMessage.

    The caller in ``graph._read`` (and similar sub-agent entry points) passes
    ``system=""`` explicitly. Without a safety net, the ``if system:`` guard in
    ``langchain_tool_loop`` would skip the SystemMessage entirely, and msgs[0]
    would become HumanMessage — breaking strict local-model templates.
    """

    seen: list = []

    class _RecordingModel:
        model_name = "fake-record-empty-sys"

        def bind_tools(self, tools):
            class _Bound:
                def __init__(self, outer):
                    self._outer = outer

                async def ainvoke(self, msgs):
                    # Snapshot only the first call (where the bug would occur).
                    if not seen:
                        seen.append(list(msgs))
                    return AIMessage(content="done")

            return _Bound(self)

    rec = _RecordingModel()

    async def grep(**kwargs):
        return "no matches"

    async def _driver():
        await _llm.langchain_tool_loop(
            rec,
            system="",  # <-- the critical case: empty system prompt
            user="find bugs",
            tools={"grep": grep},
            max_steps=5,
            ctx=0,
            emit=None,
        )

    asyncio.run(_driver())

    assert seen, "model was never called"
    msgs = seen[0]
    # msgs[0] must be a SystemMessage (possibly with a placeholder), never
    # HumanMessage. This is the contract that keeps strict templates happy.
    assert isinstance(msgs[0], SystemMessage), (
        f"msgs[0] must be SystemMessage even when system='' (was "
        f"{type(msgs[0]).__name__}). This breaks Qwen3.5 / llama.cpp templates "
        f"that require SystemMessage at the beginning."
    )


def test_normalized_call_sig_collapses_windowing_args():
    """The loop-guard signature must treat "same file, different window" as
    the SAME call: read keeps only the path identity, grep only the scope.
    Exact-arg repeats of other tools still match; different files never do.
    """
    # Same file, different offset/limit/ranges -> identical signature.
    a = _llm._normalized_call_sig("read", {"filePath": "a.py", "offset": 1, "limit": 100})
    b = _llm._normalized_call_sig("read", {"filePath": "a.py", "offset": 500, "limit": 50})
    assert a == b, "same-file windowing must collapse to one signature"
    # filePaths batch of the same set (order-insensitive) also collapses.
    c = _llm._normalized_call_sig("read", {"filePaths": ["b.py", "a.py"]})
    d = _llm._normalized_call_sig("read", {"filePaths": ["a.py", "b.py"]})
    assert c == d
    # Different file -> different signature.
    assert a != _llm._normalized_call_sig("read", {"filePath": "z.py"})
    # grep: same scope, different pattern -> DIFFERENT signature (varied
    # searches are genuine work; only scope+pattern repeats are a loop).
    g1 = _llm._normalized_call_sig("grep", {"pattern": "foo", "path": "src", "include": "*.ts"})
    g2 = _llm._normalized_call_sig("grep", {"pattern": "bar", "path": "src", "include": "*.ts"})
    assert g1 != g2
    # Same scope+pattern, cosmetic arg difference -> same signature.
    g3 = _llm._normalized_call_sig("grep", {"pattern": "foo", "path": "src", "include": "*.ts", "max_results": 10})
    assert g1 == g3
    # Non-windowing tools keep exact args.
    e1 = _llm._normalized_call_sig("edit_file", {"path": "a.py", "old_string": "x"})
    e2 = _llm._normalized_call_sig("edit_file", {"path": "a.py", "old_string": "y"})
    assert e1 != e2


def test_near_miss_paging_loop_stops_early():
    """A model paging ONE file window after window (same path, different
    offset each step) is the near-miss loop the exact-args guard missed.
    The normalized signature must count it: the second identical step gets
    the repeat short-circuit (no tool re-execution), the third breaks the
    loop with the steering message.
    """

    class _PagingModel:
        model_name = "fake-paging"

        def __init__(self):
            self._offsets = [1, 500, 1000, 1500, 2000]
            self._i = 0
            self.executions = 0

        def bind_tools(self, tools):
            outer = self

            class _Bound:
                async def ainvoke(self, msgs):
                    if outer._i >= len(outer._offsets):
                        return AIMessage(content="done")
                    off = outer._offsets[outer._i]
                    outer._i += 1
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "read",
                                "args": {"filePath": "same.py", "offset": off, "limit": 100},
                                "id": f"call-{outer._i}",
                            }
                        ],
                    )

            return _Bound()

    model = _PagingModel()

    async def read(**kwargs):
        model.executions += 1
        return "file content"

    result = asyncio.run(
        _llm.langchain_tool_loop(
            model,
            system="",
            user="read the file",
            tools={"read": read},
            max_steps=25,
            ctx=0,
            emit=None,
        )
    )
    # The 3rd identical (normalized) step breaks the loop; the 2nd was
    # short-circuited, so the tool only really executed ONCE.
    assert model.executions == 1, (
        f"repeat short-circuit failed: tool ran {model.executions} times"
    )
    assert isinstance(result, str)


if __name__ == "__main__":
    test_doom_loop_stops_after_3_identical_calls()
    test_varied_calls_not_falsely_stopped()
    test_steering_messages_are_human_not_system()
    test_empty_system_still_emits_system_message_at_index_0()
    test_normalized_call_sig_collapses_windowing_args()
    test_near_miss_paging_loop_stops_early()
    print("OK")
