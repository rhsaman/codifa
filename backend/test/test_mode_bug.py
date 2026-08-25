"""Tests for the mode-detection bug fix.

The UI/toolbar mode is authoritative. The router must NOT infer the mode from
keywords in the prompt (e.g. "fix the bug" must not flip a Plan session into
Coder). Only an explicit slash command (/plan, /code, /ask, /reader) may
override the UI mode — matching opencode's behavior.
"""

from graph import router


def test_router_respects_ui_mode_plan():
    # User selected Plan, but the prompt mentions editing/fixing.
    state = {"request": "fix the login bug in the parser", "mode": "plan"}
    assert router(state)["mode"] == "plan"


def test_router_respects_ui_mode_coder():
    # User selected Coder, but the prompt sounds like a question.
    state = {"request": "what is the difference between these two files?", "mode": "coder"}
    assert router(state)["mode"] == "coder"


def test_router_respects_ui_mode_ask():
    # User selected Ask, but the prompt sounds like an implementation task.
    state = {"request": "implement a new caching layer for the API", "mode": "ask"}
    assert router(state)["mode"] == "ask"


def test_router_slash_code_overrides_plan():
    state = {"request": "/code implement the feature", "mode": "plan"}
    assert router(state)["mode"] == "coder"


def test_router_slash_plan_overrides_coder():
    state = {"request": "/plan outline the refactor", "mode": "coder"}
    assert router(state)["mode"] == "plan"


def test_router_slash_ask_overrides_plan():
    state = {"request": "/ask explain this error", "mode": "plan"}
    assert router(state)["mode"] == "ask"


def test_router_slash_reader_overrides_coder():
    state = {"request": "/reader summarize the docs", "mode": "coder"}
    assert router(state)["mode"] == "reader"


def test_router_slash_must_be_exact_word():
    # "/codex" is not "/code" — must fall back to UI mode, not coder.
    state = {"request": "/codex is a cool tool", "mode": "plan"}
    assert router(state)["mode"] == "plan"


def test_router_defaults_to_ask_when_no_mode():
    state = {"request": "hello there"}
    assert router(state)["mode"] == "ask"
