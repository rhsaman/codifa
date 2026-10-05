"""Plan-loop guards: revisit brake wired in + scouting converges to ## Plan.

Covers the loop where plan mode scouted forever
(search -> update_plan(0/N) -> search ...) without writing ## Plan:

1. The sub-agent/main loops must nudge when one file/scope is re-touched
   step after step (the _RevisitStreakTracker existed but was never wired
   into either loop, so only identical-arg repeats were caught).
2. A pending-only solo update_plan DURING scouting (no ## Plan yet) is a
   wasted round-trip; the same call AFTER ## Plan stays legitimate.

Run: cd backend && uv run python -m pytest tests/test_plan_loop_guards.py -q
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-planloop-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _tc(name, args, cid="c1"):
    return {"name": name, "args": args, "id": cid}


def _pending_update(items):
    return [_tc("update_plan", {"items": items}, cid="u1")]


def _all_pending(n=3):
    return [{"title": f"step {i}", "status": "pending"} for i in range(n)]


def test_scout_checklist_wasteful_during_scouting():
    import graph

    assert graph._plan_scout_checklist_wasteful(
        _pending_update(_all_pending()), "", []
    ) is True


def test_scout_checklist_legit_after_plan_in_reply():
    import graph

    assert graph._plan_scout_checklist_wasteful(
        _pending_update(_all_pending()), "## Plan\n- goal", []
    ) is False


def test_scout_checklist_legit_after_plan_in_history():
    from langchain_core.messages import AIMessage

    import graph

    msgs = [AIMessage(content="## Plan\n- goal: x")]
    assert graph._plan_scout_checklist_wasteful(
        _pending_update(_all_pending()), "", msgs
    ) is False


def test_scout_checklist_legit_when_marking_progress():
    import graph

    items = _all_pending() + [{"title": "done", "status": "completed"}]
    assert graph._plan_scout_checklist_wasteful(
        _pending_update(items), "", []
    ) is False


def test_revisit_tracker_wired_into_graph_loop():
    import graph

    assert hasattr(graph, "_RevisitStreakTracker")


class _PagingLoopModel:
    """Reads one window of the same file per step, then finishes.

    The loop must deliver a REPEAT NOTE before the final answer instead of
    letting the paging run silently to max_steps.
    """

    model_name = "fake-paging-loop"

    def __init__(self):
        self._step = 0
        self.saw_revisit_note = False

    def bind_tools(self, tools):
        outer = self

        class _Bound:
            async def ainvoke(self, msgs):
                from langchain_core.messages import AIMessage, HumanMessage

                outer._step += 1
                for msg in msgs:
                    if isinstance(msg, HumanMessage) and "REPEAT NOTE" in str(
                        getattr(msg, "content", "")
                    ):
                        outer.saw_revisit_note = True
                if outer._step <= 4:
                    off = 1 + (outer._step - 1) * 100
                    return AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "read",
                                "args": {
                                    "filePath": "store.ts",
                                    "offset": off,
                                    "limit": 100,
                                },
                                "id": f"r{outer._step}",
                            }
                        ],
                    )
                return AIMessage(content="done")

        return _Bound()


def test_subagent_loop_nudges_revisit_paging():
    from llm import langchain_tool_loop as _tool_loop

    async def read(**kwargs):
        return "x" * 500

    model = _PagingLoopModel()
    result = asyncio.run(
        _tool_loop(
            model,
            system="",
            user="survey the file",
            tools={"read": read},
            max_steps=8,
            ctx=0,
            emit=None,
        )
    )
    assert result == "done"
    assert model.saw_revisit_note, (
        "paging one file window-per-step must trigger the revisit reminder"
    )


def test_qualifying_plan_body_accepts_genuine_plan():
    import graph

    text = "scouting notes\n## Plan\n- [ ] add split view\nFiles: src/App.tsx\n"
    body = graph._qualifying_plan_body(text)
    assert "## Plan" in body and "split view" in body


def test_qualifying_plan_body_rejects_prose():
    import graph

    assert graph._qualifying_plan_body("I need the API key to proceed.") == ""
    # A mere mention must never overwrite the saved plan.
    assert graph._qualifying_plan_body("Blocked on the C# plan review.") == ""
    # A line-anchored header qualifies (same rule as _split_plan_reply);
    # coder_node additionally refuses to overwrite an already-saved plan,
    # so a "### Plan vs actual" summary section is harmless there.
    assert "### Plan vs actual" in graph._qualifying_plan_body(
        "Done.\n### Plan vs actual\nAll good."
    )


def test_qualifying_plan_body_accepts_midline_header_with_structure():
    import graph

    # Streamed chunks concatenate without newlines; with steps + Files line
    # the mid-line header is still a real plan.
    text = "scouting done## Plan\n- [ ] add split view\nFiles: src/App.tsx\n"
    assert "split view" in graph._qualifying_plan_body(text)


def test_plan_draft_in_turn_ignores_history():
    from langchain_core.messages import AIMessage

    import graph

    history_plan = AIMessage(content="## Plan\n- old plan")
    seed = set(map(id, [history_plan]))
    assert graph._plan_draft_in_turn("", [history_plan], seed) is False
    fresh = AIMessage(content="## plan\n- new draft")
    assert graph._plan_draft_in_turn("", [history_plan, fresh], seed) is True
    assert graph._plan_draft_in_turn("# Plan\n- x", [], None) is True
    assert graph._plan_draft_in_turn("Blocked on the C# plan review.", [], None) is False


def test_scout_checklist_wasteful_ignores_history_plan():
    from langchain_core.messages import AIMessage

    import graph

    history_plan = AIMessage(content="## Plan\n- old plan")
    seed = set(map(id, [history_plan]))
    assert graph._plan_scout_checklist_wasteful(
        _pending_update(_all_pending()), "", [history_plan], seed
    ) is True


def test_agent_state_declares_mode_switch_keys():
    import graph

    assert "_prev_mode" in graph.AgentState.__annotations__
    assert "_mode_changed" in graph.AgentState.__annotations__


class _PlanOnceModel:
    """Plan-mode model that delivers ## Plan immediately, then counts any
    further calls (each extra call is one completion-gate re-loop)."""

    model_name = "fake-plan-once"

    def __init__(self):
        self.calls = 0

    def bind_tools(self, tools):
        return self

    async def astream(self, msgs):
        from langchain_core.messages import AIMessage

        self.calls += 1
        yield AIMessage(content="## Plan\n- [ ] add split view\nFiles: src/App.tsx\n")


async def _run_plan_turn(model, state):
    from langchain_core.messages import HumanMessage

    import graph as _graph

    async def _fake_build_turn_context(state, queue, model=model):
        return {
            "model": model,
            "messages": [HumanMessage(content="hi")],
            "tools": {},
            "lc_tools": [],
            "compact_model": None,
        }

    queue = asyncio.Queue()
    orig = _graph.build_turn_context
    _graph.build_turn_context = _fake_build_turn_context
    try:
        return await _graph._run_mode_turn(state, "plan", queue)
    finally:
        _graph.build_turn_context = orig


def test_plan_turn_with_delivered_plan_ignores_coder_checklist():
    """Replay of the observed loop: update_plan ran during scouting (7 items,
    all pending — Coder's future work), then ## Plan was delivered. The
    completion gate must NOT force re-emits; the turn ends after one pass."""
    import tools as _tools_mod

    chat = "plan-gate-loop-test"
    _tools_mod._PLAN_BY_CHAT[chat] = [
        {"title": f"step {i}", "status": "pending"} for i in range(7)
    ]
    try:
        model = _PlanOnceModel()
        state = {
            "chat_id": chat,
            "context_window": 0,
            "model_name": "fake",
            "mode": "plan",
            "request": "x",
        }
        reply = asyncio.run(_run_plan_turn(model, state))
    finally:
        _tools_mod._PLAN_BY_CHAT.pop(chat, None)
    assert "## Plan" in reply
    assert model.calls == 1, (
        f"completion gate re-looped a delivered plan {model.calls} times"
    )
