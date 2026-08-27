"""Tests that a mid-chat mode switch is made legible to the model.

When the user switches modes (e.g. Plan -> Coder), the prior turns keep their
original behavior. Without a marker the model blends the old mode's style/actions
into the new turn. `history_to_langchain_messages` tags turns whose `mode` differs
from the current one, and `_mode_declare` tells the model how to read those tags.
"""

import agents
import graph


def test_history_tags_turns_from_other_modes():
    history = [
        {"role": "user", "content": "make a plan", "mode": "plan"},
        {
            "role": "assistant",
            "content": "## Plan\nsteps...",
            "mode": "plan",
        },
        {"role": "user", "content": "now implement it", "mode": "coder"},
    ]
    # Current turn is Coder; the earlier Plan turns must be wrapped in markers.
    msgs = graph.history_to_langchain_messages(history, current_mode="coder")
    contents = [getattr(m, "content", "") for m in msgs]
    joined = "\n".join(contents)
    assert "[Mode: Plan]" in joined, "plan turn must be tagged when current mode is coder"
    assert "[/Mode]" in joined
    # The current-mode (coder) turn must NOT be wrapped.
    assert "now implement it" in joined
    assert "[Mode: Coder]" not in joined


def test_history_no_tag_when_mode_matches():
    history = [
        {"role": "user", "content": "hi", "mode": "ask"},
        {"role": "assistant", "content": "sure", "mode": "ask"},
    ]
    msgs = graph.history_to_langchain_messages(history, current_mode="ask")
    joined = "\n".join(getattr(m, "content", "") for m in msgs)
    assert "[Mode:" not in joined, "same-mode turns must not be tagged"


def test_history_no_tag_without_current_mode():
    history = [
        {"role": "user", "content": "hi", "mode": "plan"},
        {"role": "assistant", "content": "## Plan", "mode": "plan"},
    ]
    msgs = graph.history_to_langchain_messages(history)
    joined = "\n".join(getattr(m, "content", "") for m in msgs)
    assert "[Mode:" not in joined, "no current_mode => no tagging (backward compatible)"


def test_mode_declare_explains_history_tags():
    note = agents._mode_declare("coder")
    assert "CURRENT MODE: Coder" in note
    assert "HISTORY MODE TAGS" in note
    assert "[Mode: X]" in note
    # The directive must tell the model NOT to copy a differently-tagged turn.
    assert "PAST work" in note


def test_mode_declare_roles_are_distinct():
    # Sanity check: the three canonical modes declare different roles so the
    # model can tell them apart even from the declaration alone.
    ask = agents._mode_declare("ask")
    plan = agents._mode_declare("plan")
    coder = agents._mode_declare("coder")
    assert "MENTOR" in ask
    assert "PLANNER" in plan
    assert "implementation agent" in coder
    # Each must mention its own label as the current mode.
    assert "currently Ask" in ask
    assert "currently Plan" in plan
    assert "currently Coder" in coder
