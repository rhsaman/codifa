"""Unit tests: advisory batching nudge in both tool loops.

The model keeps firing one grep/glob/read per turn even though the tools
accept batch parameters (grep ``patterns=[...]``, read ``filePaths=[...]`` /
``ranges=[...]``). ``_batchable_nudge`` detects, per step, whether ≥2 calls
of the same batchable tool differ only in their primary argument (pattern /
filePath) — i.e. they could have been ONE parallel step — and returns a
reminder that the loops deliver as a standalone HumanMessage AFTER the tool
results (a suffix buried at the end of a huge result never reached the model).

Covers:
1. Two greps with different patterns, same path/include → nudge fires.
2. Two reads with different filePaths, same offset/limit → nudge fires.
3. A call that already passes patterns=[...] → NO nudge (already batching).
4. Two greps with DIFFERENT paths → NO single-call merge (Cartesian
   over-scan); parallel calls in one step are the correct shape.
5. Two greps with DIFFERENT includes → NO single-call merge;
   ranges members are always quoted.
6. Mixed tools (grep + read) → nudge mentions both.
7. Single call per tool → NO nudge.
8. End-to-end: the sub-agent loop delivers the nudge as a HumanMessage.
9. Cross-step streak tracker: per-TOOL counting, threshold=2, repeated
   reminders; same-scope merges show a concrete example, different scopes
   advise parallel calls.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-batchnudge-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from llm import _batchable_nudge, _BatchStreakTracker, _RevisitStreakTracker
from llm import langchain_tool_loop as _tool_loop

# ── pure detector tests ────────────────────────────────────────────────────

def test_two_greps_same_scope_nudge_fires():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "path": "src", "include": "*.ts"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "path": "src", "include": "*.ts"}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    # نمونه‌ی ترکیبی دقیق از خود آرگومان‌های مدل ساخته می‌شود.
    assert "pattern='alpha'" in out and "patterns=['beta']" in out


def test_two_reads_same_window_nudge_fires():
    tcs = [
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 100}, "id": "a"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 1, "limit": 100}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    # پنجره‌ی یکسان → filePaths=[...]؛ پنجره‌های متفاوت → ranges=[...].
    assert "filePaths=" in out and "a.py" in out and "b.py" in out


def test_already_batched_call_no_nudge():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "patterns": ["beta"]}, "id": "a"},
        {"name": "grep", "args": {"pattern": "gamma", "patterns": ["delta"]}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_different_paths_no_single_call_merge():
    """Different scopes must NOT suggest a single Cartesian merge — foo@src +
    bar@backend into foo|bar over both scopes changes semantics and costs
    more tokens. No per-step single-call nudge; parallel calls in one step
    are the correct shape."""
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "path": "backend"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_different_includes_no_single_call_merge():
    """Different file filters must NOT suggest a Cartesian includes= merge."""
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "include": "*.ts"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "include": "*.py"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_ranges_members_are_quoted():
    """The merged example must be a VALID literal call — every ranges member
    quoted, so a model copying it verbatim doesn't send broken args."""
    tcs = [
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 100}, "id": "a"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 50, "limit": 140}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "'a.py:1:100'" in out and "'b.py:50:140'" in out, out


def test_two_reads_same_file_different_windows_nudge_keeps_both():
    """رگرسیون تصویر: دو read پشت‌سرهم روی یک فایل با پنجره‌های متفاوت
    (مثل tools.py با 640:60 و 2089:80) نباید روی هم collapse شوند — مثال
    ترکیبی باید هر دو عضو را در ranges نگه دارد."""
    tcs = [
        {"name": "read", "args": {"filePath": "tools.py", "offset": 640, "limit": 60}, "id": "a"},
        {"name": "read", "args": {"filePath": "tools.py", "offset": 2089, "limit": 80}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "ranges=" in out, out
    assert "'tools.py:640:60'" in out and "'tools.py:2089:80'" in out, out


def test_mixed_tools_nudge_mentions_both():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta"}, "id": "b"},
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 50}, "id": "c"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 1, "limit": 50}, "id": "d"},
    ]
    out = _batchable_nudge(tcs)
    assert "grep" in out and "read" in out


def test_single_call_per_tool_no_nudge():
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha"}, "id": "a"},
        {"name": "read", "args": {"filePath": "a.py"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_nudge_text_warns_against_reissuing():
    """The merged example is built from calls that ALREADY ran — a literal
    model copying it verbatim would re-read the same files and double the
    context cost. Both reminder texts must say so explicitly."""
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta"}, "id": "b"},
    ]
    assert "do NOT repeat" in _batchable_nudge(tcs)
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    out = t.observe([_read_tc("b.py", 2)])
    assert "do NOT re-issue" in out


def test_empty_and_none_safe():
    assert _batchable_nudge([]) == ""
    assert _batchable_nudge(None) == ""


# ── read batching: same-step merge hint via ranges/filePaths ─────────────

def test_read_batch_hint_uses_ranges_for_different_windows():
    """Four same-step reads hint a single ranges call covering all windows."""
    tcs = [
        {"name": "read", "args": {"filePath": "backend/agents.py", "offset": 740, "limit": 80}, "id": "a"},
        {"name": "read", "args": {"filePath": "backend/graph.py", "offset": 2800, "limit": 80}, "id": "b"},
        {"name": "read", "args": {"filePath": "backend/graph.py", "offset": 4980, "limit": 60}, "id": "c"},
        {"name": "read", "args": {"filePath": "backend/agents.py", "offset": 3630, "limit": 80}, "id": "d"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "ranges=" in out
    assert "backend/agents.py:740:80" in out
    assert "backend/graph.py:2800:80" in out


def test_read_batch_hint_same_file_windows_keep_both():
    """Two windows on one file stay as two ranges members, not collapsed."""
    tcs = [
        {"name": "read", "args": {"filePath": "tools.py", "offset": 640, "limit": 60}, "id": "a"},
        {"name": "read", "args": {"filePath": "tools.py", "offset": 2089, "limit": 80}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "'tools.py:640:60'" in out
    assert "'tools.py:2089:80'" in out


def test_read_batch_hint_single_call_untouched():
    """A single call must not trigger a batch hint."""
    tcs = [{"name": "read", "args": {"filePath": "a.py"}, "id": "a"}]
    assert _batchable_nudge(tcs) == ""


def test_read_batch_hint_already_batched_untouched():
    """A call that already batches must not trigger another hint."""
    tcs = [
        {"name": "read", "args": {"filePath": "a.py", "ranges": ["a.py:1:50"]}, "id": "a"},
        {"name": "read", "args": {"filePath": "b.py"}, "id": "b"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_duplicate_results_projected_request_local():
    """Identical read-only results are shortened per-request by
    project_tool_results, never by mutating the durable transcript."""
    from langchain_core.messages import AIMessage, ToolMessage

    from tool_message_projection import project_tool_results

    body = "\n".join(f"{i} | line {i}" for i in range(1, 101))
    full = f"<path>a.py</path>\n<type>file</type>\n<content>\n{body}\n</content>"
    assert len(full) >= 512
    msgs = [
        AIMessage(
            content="",
            tool_calls=[
                {"name": "read", "args": {"filePath": "a.py"}, "id": "first"},
                {"name": "read", "args": {"filePath": "a.py"}, "id": "second"},
            ],
        ),
        ToolMessage(content=full, tool_call_id="first"),
        ToolMessage(content=full, tool_call_id="second"),
    ]
    out = project_tool_results(msgs)
    assert str(msgs[2].content) == full
    ref = str(out[2].content)
    assert len(ref) < len(full)
    assert "first" in ref


# ── cross-step streak tracker (one call per step) ──────────────────────────

def _read_tc(path: str, i: int) -> dict:
    return {"name": "read", "args": {"filePath": path, "offset": 1, "limit": 100}, "id": f"c{i}"}


def test_streak_fires_across_different_windows():
    """The reported regression: the model fires ONE read per step, each with
    a DIFFERENT window (70/140/80/... lines) — a batch expresses differing
    windows via ranges=['path:offset:limit', ...], so the streak must still
    build and fire on the 2nd step (threshold=2)."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([_read_tc("a.py", 1)]) == ""
    out = t.observe([
        {"name": "read", "args": {"filePath": "b.py", "offset": 50, "limit": 140}, "id": "c2"}
    ])
    assert "BATCHING REMINDER" in out
    # نمونه‌ی ترکیبی دقیق ساخته‌شده از خود فراخوانی‌های مدل:
    assert "ranges=" in out
    assert "'a.py:1:100'" in out and "'b.py:50:140'" in out


def test_streak_fires_across_same_file_different_windows():
    """رگرسیون تصویر: دو read تک‌تک روی یک فایل با پنجره‌های متفاوت
    (tools.py با 640:60 و سپس 2089:80) باید استریک بسازد و هر دو پنجره
    در مثال ranges باشند."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([
        {"name": "read", "args": {"filePath": "tools.py", "offset": 640, "limit": 60}, "id": "c1"}
    ]) == ""
    out = t.observe([
        {"name": "read", "args": {"filePath": "tools.py", "offset": 2089, "limit": 80}, "id": "c2"}
    ])
    assert "BATCHING REMINDER" in out
    assert "ranges=" in out, out
    assert "'tools.py:640:60'" in out and "'tools.py:2089:80'" in out, out


def test_streak_fires_across_different_scopes():
    """Consecutive greps with different scopes still fire, but advise
    parallel calls in one step — never a Cartesian paths= merge."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([
        {"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "a"}
    ]) == ""
    out = t.observe([
        {"name": "grep", "args": {"pattern": "beta", "path": "backend"}, "id": "b"}
    ])
    assert "BATCHING REMINDER" in out
    assert "parallel" in out.lower()
    assert "paths=" not in out


def test_streak_fires_across_different_includes():
    """Consecutive greps with different filters advise parallel calls."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([
        {"name": "grep", "args": {"pattern": "alpha", "include": "tools.py"}, "id": "a"}
    ]) == ""
    out = t.observe([
        {"name": "grep", "args": {"pattern": "beta", "include": "graph.py"}, "id": "b"}
    ])
    assert "BATCHING REMINDER" in out
    assert "parallel" in out.lower()
    assert "includes=" not in out


def test_streak_survives_interleaved_non_batchable_work():
    """Real turns interleave reads with searches/commands (see the reported
    screenshot: read, read, Search Files, run_terminal, read...). A step with
    no batchable call must NOT wipe the streak."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    t.observe([{"name": "run_terminal", "args": {"command": "uv add xa11y"}, "id": "x"}])
    out = t.observe([_read_tc("b.py", 2)])
    assert "BATCHING REMINDER" in out


def test_streak_resets_on_batch_call():
    """A step that already batches (filePaths=[...]) resets the streak."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    assert t.observe([
        {"name": "read", "args": {"filePath": "a.py", "filePaths": ["b.py", "c.py"]}, "id": "c2"}
    ]) == ""
    assert t.observe([_read_tc("d.py", 3)]) == ""


def test_streak_keeps_reminding_until_model_batches():
    """A single reminder demonstrably gets ignored (the reported regression:
    9 consecutive greps). The reminder must repeat on EVERY further
    one-at-a-time step, with the merged example growing."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    assert t.observe([_read_tc("b.py", 2)]) != ""
    out = t.observe([_read_tc("c.py", 3)])
    assert "BATCHING REMINDER" in out
    assert "c.py" in out  # نمونه‌ی ترکیبی شامل آخرین فراخوانی است


def test_streak_ignores_varied_work():
    """Different tools / non-batchable calls never build a streak."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([{"name": "run_terminal", "args": {"command": "ls"}, "id": "a"}])
    t.observe([{"name": "grep", "args": {"pattern": "x"}, "id": "b"}])
    out = t.observe([{"name": "glob", "args": {"pattern": "*.py"}, "id": "d"}])
    assert out == ""


# ── end-to-end: sub-agent loop appends the nudge to the LAST result ────────

class _TwoGrepModel:
    """Step 1: two same-scope greps. Step 2: stop after seeing the nudge."""

    model_name = "fake-two-grep"

    def __init__(self):
        self._step = 0
        self.saw_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                self._model._step += 1
                for m in msgs:
                    if isinstance(m, HumanMessage) and "BATCHING REMINDER" in str(
                        getattr(m, "content", "")
                    ):
                        self._model.saw_nudge = True
                if self._model._step == 1:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "grep", "args": {"pattern": "alpha"}, "id": "c1"},
                            {"name": "grep", "args": {"pattern": "beta"}, "id": "c2"},
                        ],
                    )
                return AIMessage(content="done")

        return _Bound(self)


def _make_tools():
    async def grep(**kwargs):
        return "no matches"

    async def read(**kwargs):
        return "file body"

    return {"grep": grep, "read": read}


def test_loop_delivers_nudge_as_human_message():
    """Two same-scope greps in one step now execute as ONE merged grep —
    the mechanical merge replaced the advisory nudge for this case, so no
    nag is needed and the tool runs once."""
    model = _TwoGrepModel()
    grep_calls: list[dict] = []

    async def _counting_grep(**kwargs):
        grep_calls.append(kwargs)
        return "no matches"

    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="find alpha and beta",
            tools={"grep": _counting_grep, "read": _make_tools()["read"]},
            max_steps=5,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert len(grep_calls) == 1, grep_calls
    assert grep_calls[0].get("pattern") == "alpha", grep_calls
    assert grep_calls[0].get("patterns") == ["beta"], grep_calls
    assert not model.saw_nudge, "merged pair needs no batching nag"


class _OneReadPerStepModel:
    """The reported regression: the model fires ONE read per step (no
    parallel_tool_calls), same window, several steps in a row. The per-step
    detector never fires; the streak tracker must reach the model."""

    model_name = "fake-one-read-per-step"

    def __init__(self, steps: int = 6):
        self._step = 0
        self._max = steps
        self.saw_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                m = self._model
                m._step += 1
                for msg in msgs:
                    if isinstance(msg, HumanMessage) and "BATCHING REMINDER" in str(
                        getattr(msg, "content", "")
                    ):
                        m.saw_nudge = True
                if m._step <= m._max:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "read",
                                "args": {
                                    "filePath": f"f{m._step}.py",
                                    "offset": 1,
                                    "limit": 100,
                                },
                                "id": f"call_{m._step}",
                            }
                        ],
                    )
                return AIMessage(content="done")

        return _Bound(self)


def test_loop_nudges_one_at_a_time_reads():
    """End-to-end: 6 consecutive single-read steps must produce a streak
    reminder the model actually sees (appended to a ToolMessage)."""
    model = _OneReadPerStepModel(steps=6)
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="read f1..f6",
            tools=_make_tools(),
            max_steps=10,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_nudge, (
        "the cross-step streak reminder must reach the model as a HumanMessage"
    )


class _OneGrepPerStepModel:
    """The reported regression (screenshot): ONE grep per step, each with a
    DIFFERENT scope — 9 round-trips that should have been 1-2 calls."""

    model_name = "fake-one-grep-per-step"

    def __init__(self, steps: int = 4):
        self._step = 0
        self._max = steps
        self.saw_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                m = self._model
                m._step += 1
                for msg in msgs:
                    if isinstance(msg, HumanMessage) and "BATCHING REMINDER" in str(
                        getattr(msg, "content", "")
                    ):
                        m.saw_nudge = True
                if m._step <= m._max:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "grep",
                                "args": {
                                    "pattern": f"term{m._step}",
                                    "path": f"dir{m._step}",
                                },
                                "id": f"call_{m._step}",
                            }
                        ],
                    )
                return AIMessage(content="done")

        return _Bound(self)


def test_loop_nudges_one_at_a_time_greps_different_scopes():
    """End-to-end: consecutive single-grep steps with DIFFERENT scopes must
    produce a streak reminder the model actually sees."""
    model = _OneGrepPerStepModel(steps=4)
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="search dir1..dir4",
            tools=_make_tools(),
            max_steps=10,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_nudge, (
        "the cross-step streak reminder must reach the model as a HumanMessage"
    )


class _TwoThenOneGrepModel:
    """Step 1: TWO mergeable greps (the per-step detector fires — the old
    ``or`` short-circuit skipped observe() on such steps). Step 2: ONE grep.
    The streak must have kept counting through step 1, so step 2 crosses
    the threshold and delivers the one-at-a-time reminder."""

    model_name = "fake-two-then-one-grep"

    def __init__(self):
        self._step = 0
        self.saw_streak_nudge = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                m = self._model
                m._step += 1
                for msg in msgs:
                    if (
                        isinstance(msg, HumanMessage)
                        and "one-at-a-time" in str(getattr(msg, "content", ""))
                    ):
                        m.saw_streak_nudge = True
                if m._step == 1:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "grep", "args": {"pattern": "alpha"}, "id": "c1"},
                            {"name": "grep", "args": {"pattern": "beta"}, "id": "c2"},
                        ],
                    )
                if m._step == 2:
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "grep", "args": {"pattern": "gamma"}, "id": "c3"}
                        ],
                    )
                return AIMessage(content="done")

        return _Bound(self)


def test_loop_streak_counts_through_per_step_nudge_step():
    """Regression (``or`` short-circuit): when the per-step detector fires,
    the streak tracker must STILL observe that step — otherwise its count
    restarts and the following one-at-a-time step gets no reminder."""
    model = _TwoThenOneGrepModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="search",
            tools=_make_tools(),
            max_steps=5,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_streak_nudge, (
        "the streak must keep counting even on a step where the per-step detector fired"
    )


# ── step-local I/O coalescing (tool_batching) ──────────────────────────────

@pytest.mark.asyncio
async def test_execute_readonly_calls_coalesces_same_key_io():
    """تجمیع واقعی I/O: فراخوانی‌های هم‌مرحله‌ای با کلید یکسان فقط یک‌بار در
    مرز I/O اجرا می‌شوند ولی نتیجه‌ی هر tool_call_id مستقل حفظ می‌شود."""
    from tool_batching import coalesce_io, execute_readonly_calls

    io_calls: list[list[str]] = []

    async def _single():
        raise AssertionError("مسیر single نباید داخل step اجرا شود")

    async def _batch(requests):
        io_calls.append(list(requests))
        return [f"body:{r}" for r in requests]

    async def _execute(call):
        return await coalesce_io(
            ("read", call["filePath"]), call["filePath"], _single, _batch
        )

    calls = [
        {"filePath": "a.py", "id": "c1"},
        {"filePath": "a.py", "id": "c2"},
        {"filePath": "b.py", "id": "c3"},
    ]
    results = await execute_readonly_calls(calls, _execute)
    assert results == ["body:a.py", "body:a.py", "body:b.py"]
    # a.py یک‌بار در مرز I/O اجرا شد؛ b.py جدا (کلید ناسازگار ادغام نمی‌شود).
    assert io_calls == [["a.py", "a.py"], ["b.py"]]


@pytest.mark.asyncio
async def test_coalesce_io_falls_back_to_single_outside_step():
    """خارج از step (بدون زمینه‌ی batch) مسیر single اجرا می‌شود — رفتار
    قدیمی ابزارها بدون تجمیع حفظ می‌شود."""
    from tool_batching import coalesce_io

    async def _single():
        return "single"

    async def _batch(requests):
        raise AssertionError("batch نباید خارج از step اجرا شود")

    assert await coalesce_io(("read", "a.py"), "a.py", _single, _batch) == "single"


@pytest.mark.asyncio
async def test_scoped_read_batch_partial_scope():
    """رگرسیون wrapper اسکوپ‌شده: یک مسیر خارج از اسکوپ در batch نباید کل
    batch را رد کند — مسیرهای مجاز خوانده می‌شوند و مسیر رد‌شده در فوتر
    گزارش می‌شود (رفع «خواندن دسته‌ای خطا داد» → برگشت به read های جدا)."""
    import agents as _agents

    async def fake_read(filePath, offset=1, limit=2000, filePaths=None, ranges=None, **kw):
        paths = [filePath, *(filePaths or [])]
        return "\n\n".join(f"<path>{p}</path>\nOK" for p in paths)

    wrapped = _agents._wrap_scoped_read(fake_read, {"a.py", "b.py"})
    # یک مسیر خارج از اسکوپ (c.py) — بقیه باید خوانده شوند.
    out = await wrapped(filePath="a.py", filePaths=["b.py", "c.py"])
    assert "<path>a.py</path>" in out
    assert "<path>b.py</path>" in out
    assert "<path>c.py</path>" not in out  # مسیر خارج از اسکوپ اجرا نشد
    assert "c.py" in out  # اما در فوتر گزارش شد
    # همه‌ی مسیرها خارج از اسکوپ → خطای واضح (نه سکوت).
    out2 = await wrapped(filePath="x.py")
    assert out2.startswith("ERROR")


def test_revisit_read_fires_on_nth_touch_once():
    """Same file re-touched step after step: silent until the Nth touch,
    then one transient reminder (once per key per turn). symbols= reads
    count as touches too (still a round-trip)."""
    t = _RevisitStreakTracker(threshold=2)
    w1 = [{"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 50}, "id": "c1"}]
    assert t.observe(w1) == ""
    out = t.observe(
        [{"name": "read", "args": {"filePath": "a.py", "offset": 51, "limit": 50}, "id": "c2"}]
    )
    assert "REPEAT NOTE" in out and "a.py" in out and "2nd" in out
    assert "ONE call" in out
    # Further touches stay silent (once per key).
    assert t.observe(w1) == ""
    # symbols-only steps touch the file too.
    t2 = _RevisitStreakTracker(threshold=2)
    s = lambda i: [
        {"name": "read", "args": {"filePath": "m.py", "symbols": ["F"]}, "id": f"s{i}"}
    ]
    assert t2.observe(s(1)) == ""
    assert "m.py" in t2.observe(s(2))


def test_streak_survives_read_grep_terminal_interleave():
    """ترکیب read + grep + run_terminal: مرحله بدون batch (ترمینال یا
    چک‌لیست) نباید streak را پاک کند — مدل باید بعد از کار میانی همچنان
    یادآوری دسته‌بندی بگیرد."""
    from llm import _BatchStreakTracker

    t = _BatchStreakTracker(threshold=2)
    r1 = [{"name": "read", "args": {"filePath": "a.py"}, "id": "c1"}]
    term = [{"name": "run_terminal", "args": {"command": "pytest -q"}, "id": "c2"}]
    r2 = [{"name": "read", "args": {"filePath": "b.py"}, "id": "c3"}]
    assert t.observe(r1) == ""
    assert t.observe(term) == ""
    out = t.observe(r2)
    assert "BATCHING REMINDER" in out and "read" in out
    g1 = [{"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "g1"}]
    upd = [{"name": "update_plan", "args": {"items": []}, "id": "u1"}]
    g2 = [{"name": "grep", "args": {"pattern": "beta", "path": "src"}, "id": "g2"}]
    t2 = _BatchStreakTracker(threshold=2)
    assert t2.observe(g1) == ""
    assert t2.observe(upd) == ""
    out2 = t2.observe(g2)
    assert "BATCHING REMINDER" in out2 and "grep" in out2


def test_revisit_grep_scope_patterns_and_merged_skip():
    """Same grep scope re-searched: reminder lists seen patterns; other
    scopes are independent; already-merged batch greps never streak."""
    t = _RevisitStreakTracker(threshold=2)
    g = lambda p, i: [
        {"name": "grep", "args": {"pattern": p, "path": "src"}, "id": f"g{i}"}
    ]
    assert t.observe(g("alpha", 1)) == ""
    out = t.observe(g("beta", 2))
    assert "REPEAT NOTE" in out and "src" in out
    assert "alpha" in out and "beta" in out and "patterns=" in out
    # Another scope is untouched; merged batch greps never count.
    assert t.observe(
        [{"name": "grep", "args": {"pattern": "zzz", "path": "docs"}, "id": "g3"}]
    ) == ""
    t2 = _RevisitStreakTracker(threshold=2)
    m = lambda i: [
        {
            "name": "grep",
            "args": {"pattern": "a", "patterns": ["b"], "path": "src"},
            "id": f"m{i}",
        }
    ]
    assert t2.observe(m(1)) == "" and t2.observe(m(2)) == ""


def test_computer_act_steps_suggest_sequence():
    """Two mutating computer calls in one step suggest ONE sequence call."""
    tcs = [
        {"name": "computer", "args": {"action": "act", "selector": "a"}, "id": "c1"},
        {"name": "computer", "args": {"action": "input", "selector": "b"}, "id": "c2"},
    ]
    out = _batchable_nudge(tcs)
    assert "sequence" in out, out


def test_computer_read_only_no_sequence_nudge():
    """Read-only computer actions must never merge into a sequence nudge."""
    tcs = [
        {"name": "computer", "args": {"action": "read_screen"}, "id": "c1"},
        {"name": "computer", "args": {"action": "read_element"}, "id": "c2"},
    ]
    assert _batchable_nudge(tcs) == ""


def test_computer_streak_suggests_sequence():
    """One act/input per step across steps fires a sequence reminder."""
    t = _BatchStreakTracker(threshold=2)
    s1 = [{"name": "computer", "args": {"action": "act"}, "id": "c1"}]
    s2 = [{"name": "computer", "args": {"action": "input"}, "id": "c2"}]
    assert t.observe(s1) == ""
    out = t.observe(s2)
    assert "sequence" in out, out


if __name__ == "__main__":
    test_two_greps_same_scope_nudge_fires()
    print("  ✅ two greps same scope")
    test_two_reads_same_window_nudge_fires()
    print("  ✅ two reads same window")
    test_already_batched_call_no_nudge()
    print("  ✅ already batched → no nudge")
    test_different_paths_no_single_call_merge()
    print("  ✅ different paths → no Cartesian merge")
    test_different_includes_no_single_call_merge()
    print("  ✅ different includes → no Cartesian merge")
    test_ranges_members_are_quoted()
    print("  ✅ ranges members quoted")
    test_mixed_tools_nudge_mentions_both()
    print("  ✅ mixed tools")
    test_single_call_per_tool_no_nudge()
    print("  ✅ single call per tool")
    test_empty_and_none_safe()
    print("  ✅ empty/None safe")
    test_streak_fires_across_different_windows()
    print("  ✅ streak across different windows")
    test_streak_fires_across_different_scopes()
    print("  ✅ streak across different scopes")
    test_streak_fires_across_different_includes()
    print("  ✅ streak across different includes")
    test_streak_survives_interleaved_non_batchable_work()
    print("  ✅ streak survives interleaved work")
    test_streak_resets_on_batch_call()
    print("  ✅ streak resets on batch call")
    test_streak_keeps_reminding_until_model_batches()
    print("  ✅ streak keeps reminding")
    test_streak_ignores_varied_work()
    print("  ✅ streak ignores varied work")
    test_nudge_text_warns_against_reissuing()
    print("  ✅ nudge text warns against re-issuing")
    test_loop_delivers_nudge_as_human_message()
    print("  ✅ loop delivers nudge as HumanMessage")
    test_loop_nudges_one_at_a_time_reads()
    print("  ✅ loop nudges one-at-a-time reads")
    test_loop_nudges_one_at_a_time_greps_different_scopes()
    print("  ✅ loop nudges one-at-a-time greps (different scopes)")
    test_loop_streak_counts_through_per_step_nudge_step()
    print("  ✅ streak counts through per-step-nudge steps")
    test_revisit_read_fires_on_nth_touch_once()
    print("  ✅ revisit read fires once")
    test_revisit_grep_scope_patterns_and_merged_skip()
    print("  ✅ revisit grep scope + merged skip")
    test_streak_survives_read_grep_terminal_interleave()
    print("  ✅ streak survives read+grep+terminal interleave")
    print("\n🎉 همه تست‌های batching nudge رد شد")
