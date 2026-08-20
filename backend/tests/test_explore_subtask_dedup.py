"""Live test: task CALL-level dedup folds near-duplicate explore task calls.

The user-reported symptom (recurring): "بازم چند تا اکسپلور با ساب ایجنت های
مثل هم درست کرد" — the parent model fires several task tool calls with
near-identical prompts (same area rephrased, or the same task with different
filler words), and each used to spawn its own sub-agent card that re-searched
the same area from scratch.

Fix: `task_tool` dedups explore task CALLS at the tool level within a turn
(Dice >= 0.8 on the prompt text): the 2nd..Nth near-duplicate reuses the first
call's report instead of spawning another sub-agent card. Completed calls are
compared via `_explore_call_log`; concurrent calls await the matching in-flight
call's report.

Guards:
1. Identical prompts -> 1 card total (2nd reuses 1st report).
2. Near-duplicate prompts (same content words, different filler) -> deduped.
3. Genuinely different prompts -> both run (2 cards).
4. Same prompt but "very thorough" in the text after "medium" -> NOT deduped
   (deeper sweep).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-call-dedup-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


def _cards(emitted: list[dict]) -> list[dict]:
    return [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-explore-call-dedup-ws-")
    for name in ("a.go", "b.go", "c.go", "d.go"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"package x\n\nfunc {name.split('.')[0]}() {{\n    return 1\n}}\n")

    # ONE make_tool_callbacks = ONE turn: the call log lives at turn level, so
    # all calls below share the dedup state (exactly like the parent model
    # firing several explore task calls in one response).
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=TestModel(custom_output_text="REPORT: found it"),
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # 1) Identical prompts → only the first call spawns a sub-agent.
    r1 = await task(description="show a.go", prompt="show me a.go", subagent_type="explore")
    assert "<task" in r1 and "<task_result>" in r1, f"unexpected report: {r1[:200]}"
    cards = _cards(emitted)
    assert len(cards) == 1, f"first explore call should run, got {len(cards)} cards"

    r2 = await task(description="show a.go", prompt="show me a.go", subagent_type="explore")
    cards = _cards(emitted)
    print(f"  identical prompt again → task cards: {len(cards)} (expect 1 total — reused)")
    assert "reusing its report" in r2, f"identical prompt NOT deduped: {r2[:200]}"
    assert len(cards) == 1, (
        f"IDENTICAL explore prompt spawned {len(cards)} cards (expected 1 total — must "
        f"reuse the first call's report)"
    )

    # 2) Near-duplicate prompt (same content words, different filler) → deduped.
    r3 = await task(description="show a.go", prompt="show me a.go please", subagent_type="explore")
    cards = _cards(emitted)
    print(f"  near-dup prompt → task cards: {len(cards)} (expect 1 total — reused)")
    assert "reusing its report" in r3, f"near-dup prompt NOT deduped: {r3[:200]}"
    assert len(cards) == 1, (
        f"near-duplicate prompt spawned {len(cards)} cards (expected 1 total)"
    )

    # 3) Genuinely different prompt → runs (no over-dedup).
    r4 = await task(description="show b.go", prompt="show me b.go", subagent_type="explore")
    cards = _cards(emitted)
    print(f"  distinct prompt → task cards: {len(cards)} (expect 2 total)")
    assert "<task" in r4 and "<task_result>" in r4, r4[:200]
    assert len(cards) == 2, (
        f"distinct prompt wrongly deduped: {len(cards)} cards (expected 2 total)"
    )

    # 4) Same prompt but "very thorough" in the text after "medium" → NOT deduped.
    r5 = await task(description="show b.go", prompt="show me b.go — very thorough", subagent_type="explore")
    cards = _cards(emitted)
    print(f"  same prompt, very thorough after medium → cards: {len(cards)} (expect 3 total)")
    assert "<task" in r5 and "<task_result>" in r5, r5[:200]
    assert len(cards) == 3, (
        f"'very thorough' after a weaker run was wrongly deduped: {len(cards)} cards"
    )

    print("  explore-call-dedup OK: near-duplicate explore calls folded before spawning")
    print("EXPLORE-CALL-DEDUP TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())