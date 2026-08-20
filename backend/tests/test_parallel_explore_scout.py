"""Combined live test: PARALLEL task (explore) + scout, both layers at once.

The exact scenario the user asks about: "هر وقت بخواد اکسپلور پارالل انجام
میده بدون ساب سرچ تکراری درسته؟" — when the parent issues N task calls
(subagent_type='explore') in one parallel-tool-calls response, we must get:

  1. ONE sub-agent (call-level dedup via `_explore_inflight`) — the other N-1
     calls await the first call's report instead of spawning their own
     sub-agent.
  2. ONE search inside that sub-agent (no duplicate sub-search).
  3. The single sub-agent's system prompt carries the AUTO-SCOUTED overview
     (via `_SCOUT_CTX`) — so it does NOT re-glob the root to orient itself.

Guards:
  A. 5 concurrent same-prompt explore task calls -> exactly 1 task card.
  B. exactly 1 grep result (no duplicate sub-search).
  C. the sub-agent's system prompt contains the scout header + root entries.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-scout-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.messages import ModelRequest, SystemPromptPart  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import _SCOUT_CTX, make_tool_callbacks  # noqa: E402


class SpyModel(TestModel):
    """TestModel that records every system prompt it receives."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.system_prompts: list[str] = []

    def request(self, messages, model_settings=None, model_request_parameters=None):
        for m in messages:
            if isinstance(m, ModelRequest):
                for part in m.parts:
                    if isinstance(part, SystemPromptPart):
                        self.system_prompts.append(part.content)
        return super().request(messages, model_settings, model_request_parameters)


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-scout-ws-")
    for name in ("app.go", "lib.go", "util.go"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"package x\n\nfunc {name.split('.')[0]}() {{\n    return 1\n}}\n")

    # agents.py sets _SCOUT_CTX before each agent run — simulate that.
    scout_text = (
        "=== AUTO-SCOUTED WORKSPACE OVERVIEW (do not take this as exhaustive) ===\n"
        "This already covers the workspace root — do NOT list the root again "
        "this turn.\n"
        f"root: {ws} — top-level entries: app.go, lib.go, util.go"
    )
    _SCOUT_CTX.set(scout_text)

    emitted: list[dict] = []
    spy = SpyModel(call_tools=["grep"], custom_output_text="REPORT: found")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=spy,
        main_model=TestModel(custom_output_text="done"),
    )
    explore = tools["task"]

    # 5 explore task calls run CONCURRENTLY (one parallel-tool-calls response),
    # all with the SAME prompt — the exact user-reported symptom.
    reports = await asyncio.gather(
        *[explore(description="find app logic", prompt="find app logic", subagent_type="explore") for _ in range(5)]
    )
    assert all("<task" in r and "<task_result>" in r for r in reports), reports[:3]

    cards = [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]
    greps = [e for e in emitted if e.get("kind") == "tool_result" and e.get("tool") == "grep" and e.get("sub")]

    print(f"  task cards: {len(cards)} (expect 1 — call dedup)")
    print(f"  grep results: {len(greps)} (expect 1 — no duplicate sub-search)")
    print(f"  sub-agent system prompts seen: {len(spy.system_prompts)} (expect 1)")

    # A. call-level dedup: 5 concurrent same-prompt calls -> 1 sub-agent.
    assert len(cards) == 1, (
        f"5 concurrent same-prompt explore calls spawned {len(cards)} cards "
        f"(expected 1 — the other 4 must reuse the first call's report)"
    )
    # B. no duplicate sub-search inside the single sub-agent.
    assert len(greps) == 1, f"expected 1 grep, got {len(greps)}"
    # C. the one sub-agent that ran was told the root is already listed.
    # (A sub-agent may call its model several times — after each tool result
    # pydantic-ai re-sends the system prompt — so EVERY prompt it saw must
    # carry the scout; the single-sub-agent fact is proven by len(cards)==1.)
    assert spy.system_prompts, "spy saw no sub-agent system prompt"
    for i, prompt in enumerate(spy.system_prompts):
        assert "AUTO-SCOUTED" in prompt, f"prompt {i} missing the scout header"
        assert "top-level entries: app.go, lib.go, util.go" in prompt, (
            f"prompt {i} missing the root-entries line"
        )

    print("  parallel+scout OK: 5 concurrent same-task calls -> 1 sub-agent, 1 search, root pre-listed")
    print("PARALLEL-SCOUT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())