"""Turn continuity: previous-turn outcome survives and prevents re-execution."""

import trace_store
from agents import (
    _TURN_OUTCOME_MARKER,
    _is_status_check,
    _prune_history,
    _turn_terminal_state,
)


def _unique_chat(tag: str) -> str:
    import time
    import uuid

    return f"turn-cont-{tag}-{time.time_ns()}-{uuid.uuid4().hex[:6]}"


def test_outcome_survives_turn_and_task_change():
    chat = _unique_chat("survive")
    trace_store.next_turn(chat)
    trace_store.record_turn_outcome(
        chat, "completed", evidence="terminal exit 0: pytest -q", mode="coder"
    )
    # New turn + new task_id must not lose the outcome (keyed by chat only).
    trace_store.next_turn(chat)
    trace_store.append(chat, "tool", "sub-agent work", task_id=f"task-{chat[:8]}-new")
    got = trace_store.previous_turn_outcome(chat)
    assert got is not None
    assert got["status"] == "completed"
    assert "pytest" in got["evidence"]


def test_completed_note_forbids_reexecution():
    note = trace_store.format_turn_outcome_note(
        {"turn": 3, "status": "completed", "evidence": "terminal exit 0", "mode": "coder"}
    )
    assert "completed" in note
    assert "Do NOT re-execute" in note
    assert _TURN_OUTCOME_MARKER in "[Previous turn 3 (coder) finished: completed.]"


def test_incomplete_note_asks_to_continue_pending_work():
    note = trace_store.format_turn_outcome_note(
        {"turn": 2, "status": "incomplete", "evidence": "plan 1/3 done", "mode": "plan"}
    )
    assert "incomplete" in note
    assert "Continue exactly its pending work" in note


def test_status_check_covers_confirmation_prompts():
    for prompt in ["\u062a\u0645\u0648\u0645 \u0634\u062f\u061f", "done?", "finished?", "status?"]:
        assert _is_status_check(prompt) is True
    assert _is_status_check("please add a new feature to export csv") is False
    assert _is_status_check("") is False


def test_terminal_state_completed_for_status_check_and_full_plan():
    assert _turn_terminal_state([{"content": "a", "status": "pending"}], "done?") == "completed"
    assert (
        _turn_terminal_state(
            [{"content": "a", "status": "completed"}, {"content": "b", "status": "completed"}],
            "continue",
        )
        == "completed"
    )
    assert (
        _turn_terminal_state(
            [{"content": "a", "status": "completed"}, {"content": "b", "status": "in_progress"}],
            "continue",
        )
        == "incomplete"
    )


def test_prune_keeps_previous_turn_evidence(monkeypatch):
    import agents as agents_mod

    monkeypatch.setattr(agents_mod, "_PRUNE_PROTECT_TOKENS", 200)
    monkeypatch.setattr(agents_mod, "_PRUNE_MIN_TOKENS", 50)
    outcome_tool = {
        "role": "tool",
        "tool": "run_terminal",
        "content": "[Previous turn 1 finished: completed.] Evidence:\nterminal exit 0",
    }
    filler = {"role": "tool", "tool": "run_terminal", "content": "x" * 2000}
    history = [outcome_tool, filler, {"role": "user", "content": "done?"}]
    pruned = _prune_history(history)
    assert any(_TURN_OUTCOME_MARKER in str(m.get("content", "")) for m in pruned)
