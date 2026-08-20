"""Live test: ONE task call (subagent_type='explore') -> ONE sub-agent (exactly
like opencode), and near-duplicate explore task calls reuse the first report
instead of spawning more sub-agents.

The user-reported symptom (recurring): "بازم چند تا اکسپلور با ساب ایجنت های
مثل هم درست کرد" — the parent model fires SEVERAL task tool calls (often in
one parallel-tool-calls response) with near-identical prompts, and each used to
spawn its own sub-agent card with similar sub-searches.

Fixed at the CODE level in task_tool (not prompt-only):
1. ONE sub-agent per task call (no fan-out into sibling sub-agents) —
   exactly opencode's `explore` agent (mode: subagent, read-only,
   thoroughness quick|medium|very thorough, passed in the prompt text).
2. Turn-level dedup of explore task calls: a near-duplicate (Dice >= 0.8 on
   the prompt text) reuses the earlier call's report instead
   of spawning another sub-agent — completed calls via `_explore_call_log`,
   concurrent calls via `_explore_inflight` (awaits the in-flight report).
   A new call asking for "very thorough" after a weaker run is NOT deduped.

Guards:
1. task(explore) -> exactly ONE task card.
2. task(same prompt) again -> reuses the first report, NO new card.
3. task(different prompt) -> a NEW card (genuinely different areas stay
   independent).
4. task(same prompt, "very thorough" in text) after medium -> NOT deduped
   (the deeper sweep is a real request).
5. task(same prompt, "quick" in text) after very thorough -> deduped.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-single-subagent-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import _thoroughness_from_prompt, _thoroughness_prompt, make_tool_callbacks  # noqa: E402


def test_thoroughness_prompt():
    """Unit test for the thoroughness prompt builder (ported from opencode's
    explore subagent): quick = minimal searches, very thorough = exhaustive
    sweep, unknown/empty -> medium default, case-insensitive."""
    assert "MINIMUM searches" in _thoroughness_prompt("quick")
    assert "COMPREHENSIVE sweep" in _thoroughness_prompt("very thorough")
    assert "obvious locations" in _thoroughness_prompt("medium")
    assert "obvious locations" in _thoroughness_prompt("")  # default
    assert "obvious locations" in _thoroughness_prompt("bogus")  # unknown -> medium
    assert "COMPREHENSIVE sweep" in _thoroughness_prompt("VERY THOROUGH")  # case-insensitive
    print("  thoroughness prompt unit test OK")


def test_thoroughness_from_prompt():
    """Unit test for parsing thoroughness out of the task prompt text (opencode
    passes it in the prompt, not as a structured param). Default is QUICK so an
    unspecified explore finishes in a couple of targeted searches (latency-bound)."""
    assert _thoroughness_from_prompt("find where x lives") == "quick"
    assert _thoroughness_from_prompt("quickly find where x lives") == "quick"
    assert _thoroughness_from_prompt("a very thorough sweep of src") == "very thorough"
    assert _thoroughness_from_prompt("do a comprehensive review") == "very thorough"
    assert _thoroughness_from_prompt("") == "quick"
    print("  thoroughness-from-prompt unit test OK")


def _explore_cards(emitted: list[dict]) -> list[dict]:
    """Every explore task call emits exactly ONE task card."""
    return [
        e
        for e in emitted
        if e.get("kind") == "tool"
        and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]


async def main():
    test_thoroughness_prompt()
    test_thoroughness_from_prompt()
    ws = tempfile.mkdtemp(prefix="coder-test-explore-single-subagent-ws-")
    for name in ("app.go", "lib.go", "util.go"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"package x\n\nfunc {name.split('.')[0]}() {{\n    return 1\n}}\n")

    # No call_tools: the sub-agent just returns its report text (we only assert
    # card counts and report reuse, not search behavior).
    explore_model = TestModel(custom_output_text="REPORT: found it")
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # --- Case 1: one task -> exactly ONE card (no fan-out branches). ---
    emitted = []
    r1 = await task(description="find app logic", prompt="find where app logic lives", subagent_type="explore")
    assert "<task" in r1 and "<task_result>" in r1, r1[:200]
    cards1 = _explore_cards(emitted)
    print(f"  case 1 (single task): {len(cards1)} explore cards (expect 1)")
    assert len(cards1) == 1, (
        f"single task call produced {len(cards1)} cards — expected exactly 1 "
        f"(one sub-agent per explore call, like opencode)"
    )

    # --- Case 2: same prompt again -> reuses the report, NO new card. ---
    emitted = []
    r2 = await task(description="find app logic", prompt="find where app logic lives", subagent_type="explore")
    assert "reusing its report" in r2, f"duplicate task NOT deduped: {r2[:200]}"
    cards2 = _explore_cards(emitted)
    print(f"  case 2 (duplicate task): {len(cards2)} explore cards (expect 0 — reused)")
    assert len(cards2) == 0, (
        f"duplicate task call spawned a new card ({len(cards2)}) — near-identical "
        f"calls must reuse the earlier report"
    )

    # --- Case 3: different prompt -> a NEW card (distinct areas stay independent). ---
    emitted = []
    r3 = await task(description="find config", prompt="find how config is loaded", subagent_type="explore")
    assert "<task" in r3 and "<task_result>" in r3, r3[:200]
    cards3 = _explore_cards(emitted)
    print(f"  case 3 (different task): {len(cards3)} explore cards (expect 1)")
    assert len(cards3) == 1, (
        f"genuinely different explore task was wrongly deduped: {len(cards3)} cards"
    )

    # --- Case 4: same prompt, "very thorough" in the text after medium -> NOT deduped. ---
    emitted = []
    r4 = await task(description="find config", prompt="find how config is loaded — very thorough", subagent_type="explore")
    assert "<task" in r4 and "<task_result>" in r4, r4[:200]
    cards4 = _explore_cards(emitted)
    print(f"  case 4 (same task, very thorough): {len(cards4)} explore cards (expect 1 — deeper sweep)")
    assert len(cards4) == 1, (
        f"'very thorough' after a weaker run was wrongly deduped: {len(cards4)} cards"
    )

    # --- Case 5: same prompt, "quick" in the text after very thorough -> deduped. ---
    emitted = []
    r5 = await task(description="find config", prompt="find how config is loaded — quick", subagent_type="explore")
    assert "reusing its report" in r5, f"quick-after-thorough NOT deduped: {r5[:200]}"
    cards5 = _explore_cards(emitted)
    print(f"  case 5 (same task, quick): {len(cards5)} explore cards (expect 0 — reused)")
    assert len(cards5) == 0, (
        f"quick re-run after very thorough spawned a new card ({len(cards5)})"
    )

    print("  explore-single-subagent OK: one sub-agent per call + call-level dedup")
    print("EXPLORE-SINGLE-SUBAGENT TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
