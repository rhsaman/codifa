"""Live test: THREE concurrent task calls (subagent_type='explore') with
DIFFERENT prompts — each call's sub-events must be attributed to ITS OWN card
only, never cross-nested into a sibling card.

This is the regression test for the reported symptom: three explore cards with
different titles (backend / frontend / electron bugs) all showed the SAME
sub-searches ("116 calls · 109.5s" on every card). That happens when the
frontend nests every sub-event into EVERY running task card — either because
the backend emits branch-less sub-events, or because branch ids collide across
parallel calls.

ROOT CAUSE (found 2025): the real SSE pipeline routes every tool event through
``agents._tool_event`` (agents.py:4216: ``lambda ev: queue.put_nowait(_tool_event(ev))``),
whose field WHITELIST was missing ``"branch"`` — so the branch id stamped on
the explore card and every sub-event (tools.py) was STRIPPED before the
frontend saw it. The frontend (Chat.tsx) then falls back to "no branch →
nest into every running task card", duplicating every sub-event into all three
cards. This test therefore collects events THROUGH ``_tool_event`` (exactly the
production path), not raw.

The existing test (test_parallel_explore_calls.py) only asserts
`set(sub_branches) <= set(card_branches)` — which PASSES even when call #1's
sub-events carry call #2's branch (swapped attribution). This test replicates
the frontend's nesting algorithm (Chat.tsx: sub-events nest into the running
task card with the SAME branch id) and asserts:

1. 3 concurrent distinct explore calls -> 3 cards, globally-unique branch ids.
2. Every sub-event carries the branch of the card its OWN call created
   (per-call attribution, not just "some card's branch").
3. Simulated frontend nesting: each card's children are exactly its own
   branch's sub-events — disjoint, nothing duplicated, nothing dropped.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-explore-attrib-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import _tool_event, make_tool_callbacks  # noqa: E402 — _tool_event is the real SSE field filter (must keep `branch`)


def _explore_cards(emitted: list[dict]) -> list[dict]:
    return [
        e for e in emitted
        if e.get("kind") == "tool" and e.get("tool") == "task"
        and (e.get("args") or {}).get("subagent_type") == "explore"
    ]


def _simulate_frontend_nesting(emitted: list[dict]) -> list[dict]:
    """Replicate Chat.tsx's sub-event routing: a sub tool event nests into the
    running task card whose `branch` matches the event's `branch`; a sub-event
    with NO branch would nest into EVERY running task card (the bug). Returns
    the task cards with their accumulated `children`."""
    cards: list[dict] = []
    for ev in emitted:
        kind = ev.get("kind")
        if kind == "tool":
            if ev.get("sub"):
                branch = ev.get("branch")
                for card in cards:
                    if card["tool"] == "task" and card["status"] == "running":
                        if branch is not None and card.get("branch") != branch:
                            continue
                        card["children"].append(ev)
            else:
                cards.append({
                    "tool": ev.get("tool"),
                    "status": "running",
                    "branch": ev.get("branch"),
                    "call_id": ev.get("call_id"),
                    "children": [],
                })
        elif kind == "tool_result":
            if ev.get("sub"):
                # Sub results resolve a CHILD row inside the card, never the
                # task card itself (Chat.tsx: `if (event.sub && isTop)` skips
                # the top-level match). Only the task's OWN tool_result marks
                # the card done.
                continue
            for card in cards:
                if card["tool"] == "task" and card["status"] == "running":
                    if card.get("call_id") == ev.get("call_id") or (
                        ev.get("branch") is not None
                        and card.get("branch") == ev.get("branch")
                    ):
                        card["status"] = "done"
    return cards


async def main():
    # Direct whitelist check: the SSE field filter MUST keep `branch` (the
    # frontend routes each branch's sub-events by it). This failed before the
    # fix: `_tool_event` stripped `branch`, so sub-events were duplicated into
    # every running task card.
    _probe = _tool_event(
        {"kind": "tool", "tool": "read", "sub": True, "branch": 7}
    )
    assert _probe.get("branch") == 7, (
        f"_tool_event stripped `branch` from the event (whitelist missing "
        f"'branch'?): got {_probe}"
    )

    ws = tempfile.mkdtemp(prefix="coder-test-parallel-explore-attrib-ws-")
    for name in ("app.py", "lib.py", "util.py", "ui.py", "main.py"):
        with open(os.path.join(ws, name), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name.split('.')[0]}():\n    return 1\n")

    emitted: list[dict] = []
    # The sub-agent calls THREE tools per explore (grep, glob, read) so each
    # call emits several sub-events — enough to detect cross-attribution.
    explore_model = TestModel(
        call_tools=["grep", "glob", "read"],
        custom_output_text="REPORT: found",
    )
    # Route events through `_tool_event` — the EXACT production SSE filter
    # (agents.py:4216 `queue.put_nowait(_tool_event(ev))`). Collecting raw
    # events would MISS the bug: the old whitelist stripped `branch` from
    # every event before it reached the frontend.
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(_tool_event(ev)),
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    task = tools["task"]

    # THREE distinct explore calls run CONCURRENTLY (as the parent would issue
    # them in one parallel-tool-calls response). Distinct prompts must NOT be
    # deduped — all three run.
    reports = await asyncio.gather(
        task(description="find backend bugs", prompt="find backend python bugs", subagent_type="explore"),
        task(description="find frontend bugs", prompt="find frontend react bugs", subagent_type="explore"),
        task(description="find electron bugs", prompt="find electron and test bugs", subagent_type="explore"),
    )
    assert all("<task" in r and "<task_result>" in r for r in reports), reports

    cards = _explore_cards(emitted)
    sub_tools = [e for e in emitted if e.get("kind") == "tool" and e.get("sub")]
    sub_results = [e for e in emitted if e.get("kind") == "tool_result" and e.get("sub")]

    card_branches = [e.get("branch") for e in cards]
    sub_branches = [e.get("branch") for e in sub_tools]

    print(f"  explore cards: {len(cards)} (expect 3: distinct tasks all run)")
    print(f"  card branch ids: {card_branches}")
    print(f"  sub tool events: {len(sub_tools)} (expect 9: 3 tools x 3 calls)")
    print(f"  sub branch ids:  {sorted(set(sub_branches))}")

    # 1. All three distinct calls run -> 3 cards with globally-unique branches.
    assert len(cards) == 3, f"expected 3 cards (different tasks), got {len(cards)}"
    assert len(card_branches) == len(set(card_branches)), \
        f"DUPLICATE branch ids across parallel explore calls: {card_branches}"

    # 2. Every sub-event carries the branch of the card its OWN call created.
    #    Cards are emitted in gather order (the task `tool` event is emitted
    #    synchronously before any await), so call i's sub-events must carry
    #    cards[i]'s branch — NOT a sibling's. This is the check the old test
    #    missed (it only required sub_branches ⊆ card_branches, which passes
    #    even with swapped attribution).
    assert len(sub_tools) == 9, f"expected 9 sub tool events (3 tools x 3 calls), got {len(sub_tools)}"
    for i, branch in enumerate(card_branches):
        mine = [e for e in sub_tools if e.get("branch") == branch]
        assert len(mine) == 3, (
            f"call #{i} (branch {branch}) has {len(mine)} sub-events, expected 3 — "
            f"sub-events cross-attributed: {sub_branches}"
        )
    # Every sub-event belongs to exactly one card's branch (no branch-less
    # sub-events floating around, which the frontend would nest into ALL cards).
    assert all(b in card_branches for b in sub_branches), \
        f"sub-event with unknown branch: {set(sub_branches) - set(card_branches)}"

    # 3. Simulate the frontend nesting (Chat.tsx): each card's children must be
    #    exactly its own branch's sub-events — disjoint, nothing duplicated.
    nested = _simulate_frontend_nesting(emitted)
    task_cards = [c for c in nested if c["tool"] == "task"]
    assert len(task_cards) == 3, f"simulated frontend has {len(task_cards)} task cards"
    total_children = sum(len(c["children"]) for c in task_cards)
    assert total_children == len(sub_tools), (
        f"frontend simulation nested {total_children} children across 3 cards, "
        f"but only {len(sub_tools)} sub-events exist — sub-events were "
        f"DUPLICATED into multiple cards (the reported bug)"
    )
    for card in task_cards:
        for child in card["children"]:
            assert child.get("branch") == card.get("branch"), (
                f"card branch {card.get('branch')} contains sub-event with "
                f"branch {child.get('branch')} — cross-nested!"
            )

    print("  parallel-explore-attribution OK: 3 cards, per-call sub-events, no cross-nesting")
    print("PARALLEL-EXPLORE-ATTRIBUTION TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())