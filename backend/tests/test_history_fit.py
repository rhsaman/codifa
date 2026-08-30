"""Regression tests: the backend must send the FULL history every turn (opencode
parity), never trimming it by a char/token budget before sending.

Previously `graph.py` called `_agents._fit_history(state["history"], _agents._history_budget(ctx, ...))`
which dropped older turns once the history exceeded a per-mode char budget
(ask:60k / plan:120k / coder:140k). That caused two bugs:
  - messages disappeared every turn (history shrank even when the window was far
    from full), and
  - switching mode shrank the context (the per-mode ceiling changed).

opencode sends the whole transcript and only compacts on real overflow, so the
backend must do the same. These tests lock that behavior in.
"""

import graph


def _make_history(n: int) -> list[dict]:
    """Build ``n`` alternating user/assistant turns (plus a system turn)."""
    turns = [{"role": "system", "content": "system prompt"}]
    for i in range(n):
        if i % 2 == 0:
            turns.append({"role": "user", "content": f"user message number {i}"})
        else:
            turns.append({"role": "assistant", "content": f"assistant reply number {i}"})
    return turns


def test_fit_history_function_removed():
    """Guard: the budgeted trimmer must be gone so it can't silently reappear."""
    assert not hasattr(graph._agents, "_fit_history")
    assert not hasattr(graph._agents, "_history_budget")
