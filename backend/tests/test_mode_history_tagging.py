"""Tests that a mid-chat mode switch is made legible to the model.

When the user switches modes (e.g. Plan -> Coder), the prior turns keep their
original behavior. The authoritative mode for THIS turn is declared by the system
prompt (``=== CURRENT MODE: … ===``), and we deliberately do NOT inject any
per-turn mode tag into the history — a past-mode marker in the transcript only
teaches the model to echo it back (e.g. writing ``<!-- mode:ask -->`` while the
button says Plan). These tests verify that history stays tag-free and that the
mode declaration forbids echoing a mode tag.
"""

import agents
import graph


def test_history_is_never_tagged():
    history = [
        {"role": "user", "content": "make a plan", "mode": "plan"},
        {"role": "assistant", "content": "## Plan\nsteps...", "mode": "plan"},
        {"role": "user", "content": "now implement it", "mode": "coder"},
    ]
    # Current turn is Coder; the earlier Plan turns must NOT be wrapped in a tag.
    msgs = graph.history_to_langchain_messages(history, current_mode="coder")
    joined = "\n".join(getattr(m, "content", "") for m in msgs)
    assert "<!-- mode:" not in joined, "history must never carry a mode tag"
    assert "[Mode:" not in joined, "history must never carry a mode tag"


def test_history_no_tag_without_current_mode():
    history = [
        {"role": "user", "content": "hi", "mode": "plan"},
        {"role": "assistant", "content": "## Plan", "mode": "plan"},
    ]
    msgs = graph.history_to_langchain_messages(history)
    joined = "\n".join(getattr(m, "content", "") for m in msgs)
    assert "<!-- mode:" not in joined, "no tagging (backward compatible)"
    assert "[Mode:" not in joined, "no tagging (backward compatible)"


def test_mode_declare_forbids_echoing_mode_tag():
    note = agents._mode_declare("coder")
    assert "CURRENT MODE: Coder" in note
    # The directive must tell the model NOT to write a mode tag at the start of
    # its reply (neither the old ``[Mode: …]`` nor the ``<!-- mode:… -->`` form).
    assert "NEVER write a mode tag" in note
    assert "<!-- mode:" in note
    assert "[Mode:" in note


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
