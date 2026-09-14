"""Unit tests: advisory batching nudge in both tool loops.

The model keeps firing one grep/glob/read per turn even though the tools
accept batch parameters (grep ``patterns=[...]``, read ``filePaths=[...]`` /
``ranges=[...]``). ``_batchable_nudge`` detects, per step, whether ≥2 calls
of the same batchable tool differ only in their primary argument (pattern /
filePath) — i.e. they could have been ONE call — and returns a reminder
that the loops deliver as a standalone HumanMessage AFTER the tool results
(a suffix buried at the end of a huge result never reached the model).

Covers:
1. Two greps with different patterns, same path/include → nudge fires.
2. Two reads with different filePaths, same offset/limit → nudge fires.
3. A call that already passes patterns=[...] → NO nudge (already batching).
4. Two greps with DIFFERENT paths (same include) → nudge fires with a
   concrete merged example using paths=[...] (scopes merge in one call).
5. Two greps with DIFFERENT includes → nudge fires with includes=[...]
   (file filters merge in one call); ranges members are always quoted.
6. Mixed tools (grep + read) → nudge mentions both.
7. Single call per tool → NO nudge.
8. End-to-end: the sub-agent loop delivers the nudge as a HumanMessage.
9. Cross-step streak tracker: per-TOOL counting, threshold=2, repeated
   reminders with a concrete merged example built from the model's own calls.
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
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from llm import _batchable_nudge, _BatchStreakTracker
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


def test_different_paths_now_merge_via_paths():
    """Scopes merge via paths=[...] — two greps with different paths (same
    include) SHOULD nudge with a concrete merged example."""
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "path": "backend"}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "paths=" in out
    assert "pattern='alpha'" in out and "patterns=['beta']" in out


def test_different_includes_now_merge_via_includes():
    """File filters merge via includes=[...] — two greps with different
    includes (same path) SHOULD nudge with a concrete merged example."""
    tcs = [
        {"name": "grep", "args": {"pattern": "alpha", "include": "*.ts"}, "id": "a"},
        {"name": "grep", "args": {"pattern": "beta", "include": "*.py"}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "BATCHING REMINDER" in out
    assert "includes=" in out
    assert "include='*.ts'" in out and "includes=['*.py']" in out


def test_ranges_members_are_quoted():
    """The merged example must be a VALID literal call — every ranges member
    quoted, so a model copying it verbatim doesn't send broken args."""
    tcs = [
        {"name": "read", "args": {"filePath": "a.py", "offset": 1, "limit": 100}, "id": "a"},
        {"name": "read", "args": {"filePath": "b.py", "offset": 50, "limit": 140}, "id": "b"},
    ]
    out = _batchable_nudge(tcs)
    assert "'a.py:1:100'" in out and "'b.py:50:140'" in out, out


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


def test_streak_fires_across_different_scopes():
    """The reported regression (screenshot): 9 greps with DIFFERENT scopes —
    one grep per step. Scopes merge via paths=[...], so the per-tool count
    must build and fire with a concrete merged example."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([
        {"name": "grep", "args": {"pattern": "alpha", "path": "src"}, "id": "a"}
    ]) == ""
    out = t.observe([
        {"name": "grep", "args": {"pattern": "beta", "path": "backend"}, "id": "b"}
    ])
    assert "BATCHING REMINDER" in out
    assert "paths=" in out
    assert "pattern='alpha'" in out and "patterns=['beta']" in out


def test_streak_fires_across_different_includes():
    """The reported regression (screenshot): consecutive greps with DIFFERENT
    file filters (include='tools.py' vs include='graph.py'). Filters merge via
    includes=[...], so the per-tool count must build and fire."""
    t = _BatchStreakTracker(threshold=2)
    assert t.observe([
        {"name": "grep", "args": {"pattern": "alpha", "include": "tools.py"}, "id": "a"}
    ]) == ""
    out = t.observe([
        {"name": "grep", "args": {"pattern": "beta", "include": "graph.py"}, "id": "b"}
    ])
    assert "BATCHING REMINDER" in out
    assert "includes=" in out
    assert "include='tools.py'" in out and "includes=['graph.py']" in out


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


# ── enforcement: رد فراخوانی تکِ بعد از تذکر نادیده‌گرفته‌شده ─────────────

def test_enforcement_rejects_next_single_call_once():
    """بعد از شلیک تذکر (streak)، فراخوانی تکِ بعدی همان ابزار یک بار رد
    می‌شود — اجرا نمی‌شود و متن رد حاوی نمونه‌ی ترکیبی است. فراخوانی تکِ
    بعد از رد، دوباره عادی اجرا می‌شود (بدترین حالت: ۱ رفت‌وبرگشت هدر)."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    assert t.observe([_read_tc("b.py", 2)]) != ""  # تذکر شلیک کرد
    # فراخوانی تکِ بعدی → رد
    rej = t.should_reject("read")
    assert rej.startswith("NOT RUN"), rej
    assert "ranges=" in rej or "filePaths=" in rej  # نمونه‌ی ترکیبی
    assert "do NOT re-issue" in rej.lower() or "Do NOT re-issue" in rej
    # رد فقط یک بار است — فراخوانی تکِ بعدیِ بعدی عادی اجرا می‌شود
    assert t.should_reject("read") == ""
    # ابزار دیگر تحت تأثیر نیست
    assert t.should_reject("grep") == ""


def test_enforcement_not_triggered_without_reminder():
    """بدون شلیک تذکر، هیچ فراخوانی‌ای رد نمی‌شود."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    assert t.should_reject("read") == ""


def test_enforcement_batch_call_never_rejected():
    """فراخوانی batch شده (filePaths=[...]) هرگز رد نمی‌شود — رد فقط
    فراخوانی‌های تک را می‌گیرد (سیم‌کشی در حلقه‌ها این شرط را چک می‌کند)."""
    t = _BatchStreakTracker(threshold=2)
    t.observe([_read_tc("a.py", 1)])
    t.observe([_read_tc("b.py", 2)])  # تذکر شلیک کرد
    # فراخوانی batch بعدی streak را ریست می‌کند و ردی هم نمی‌گیرد
    assert t.observe([
        {"name": "read", "args": {"filePath": "a.py", "filePaths": ["c.py"]}, "id": "c3"}
    ]) == ""
    assert t.should_reject("read") == ""


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
    model = _TwoGrepModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="find alpha and beta",
            tools=_make_tools(),
            max_steps=5,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_nudge, "the nudge must reach the model as a HumanMessage"


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


class _IgnoringModel:
    """The reported regression: the model IGNORES the batching reminder and
    keeps firing one read per step. Enforcement must reject exactly ONE of
    those calls (the tool is not run — the model sees a NOT RUN error)."""

    model_name = "fake-ignoring-reminder"

    def __init__(self, steps: int = 5):
        self._step = 0
        self._max = steps
        self.saw_nudge = False
        self.saw_rejection = False

    def bind_tools(self, tools):
        class _Bound:
            def __init__(self, model):
                self._model = model

            async def ainvoke(self, msgs):
                m = self._model
                m._step += 1
                for msg in msgs:
                    _c = str(getattr(msg, "content", ""))
                    if isinstance(msg, HumanMessage) and "BATCHING REMINDER" in _c:
                        m.saw_nudge = True
                    if isinstance(msg, ToolMessage) and "NOT RUN" in _c:
                        m.saw_rejection = True
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


def test_loop_enforcement_rejects_ignored_reminder():
    """End-to-end: a model that keeps firing single reads after the reminder
    gets ONE rejected call (NOT RUN) — the tool is not executed for it."""
    model = _IgnoringModel(steps=5)
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="read f1..f5",
            tools=_make_tools(),
            max_steps=10,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_nudge, "the reminder must reach the model first"
    assert model.saw_rejection, (
        "the ignored reminder must trigger a NOT RUN rejection the model sees"
    )


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


if __name__ == "__main__":
    test_two_greps_same_scope_nudge_fires()
    print("  ✅ two greps same scope")
    test_two_reads_same_window_nudge_fires()
    print("  ✅ two reads same window")
    test_already_batched_call_no_nudge()
    print("  ✅ already batched → no nudge")
    test_different_paths_now_merge_via_paths()
    print("  ✅ different paths → merge via paths")
    test_different_includes_now_merge_via_includes()
    print("  ✅ different includes → merge via includes")
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
    test_enforcement_rejects_next_single_call_once()
    print("  ✅ enforcement rejects next single call once")
    test_enforcement_not_triggered_without_reminder()
    print("  ✅ enforcement not triggered without reminder")
    test_enforcement_batch_call_never_rejected()
    print("  ✅ enforcement never rejects batch calls")
    test_loop_enforcement_rejects_ignored_reminder()
    print("  ✅ loop enforcement rejects ignored reminder")
    print("\n🎉 همه تست‌های batching nudge رد شد")
