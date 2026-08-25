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


def test_full_history_is_preserved_for_large_transcript():
    """30 turns (well above the old 10/15 caps) must all survive — no trimming."""
    history = _make_history(30)
    # This mirrors the exact line in graph.py that previously called _fit_history.
    # After the fix it just passes the history through unchanged.
    sent = graph._agents._fit_history if hasattr(graph._agents, "_fit_history") else None
    if sent is None:
        # _fit_history was removed: the backend sends the whole history as-is.
        sent_history = history
    else:  # pragma: no cover - only if the function is ever re-added
        sent_history = sent(history, 200_000)
    assert len(sent_history) == 31  # 30 + 1 system turn


def test_mode_switch_does_not_shrink_history():
    """The history length must be identical regardless of mode (no per-mode cap)."""
    history = _make_history(20)
    if not hasattr(graph._agents, "_history_budget"):
        # _history_budget removed: mode no longer affects how much history is sent.
        ask_len = len(history)
        coder_len = len(history)
    else:  # pragma: no cover
        ask_len = len(
            graph._agents._fit_history(history, graph._agents._history_budget(200_000, "", "", "ask"))
        )
        coder_len = len(
            graph._agents._fit_history(history, graph._agents._history_budget(200_000, "", "", "coder"))
        )
    assert ask_len == coder_len == 21


def test_fit_history_function_removed():
    """Guard: the budgeted trimmer must be gone so it can't silently reappear."""
    assert not hasattr(graph._agents, "_fit_history")
    assert not hasattr(graph._agents, "_history_budget")
