"""Unit tests for ``filter_tools_for_mode`` web-tool gating.

Web tools (web_search / fetch_url / search_console) must be available to the
main agent in every mode (ask/plan/coder) whenever the web capability is not
explicitly denied — the agent decides on its own when a web lookup is needed.
They are only stripped when ``cap["web"]`` is explicitly ``False``.
"""
from graph import filter_tools_for_mode

_WEB = {"web_search", "fetch_url", "search_console"}
_ALL = (
    "web_search", "fetch_url", "search_console",
    "write_file", "edit_file", "run_terminal", "confirm_action",
    "grep", "glob", "read", "task", "update_plan", "memory",
    "search_memory", "ask_user", "request_permission",
)


def _fake_tools():
    return {n: (lambda *a, **k: None) for n in _ALL}


def test_web_always_available_when_cap_empty():
    # No capability map supplied (the common case) -> web stays available in
    # every mode, including ask with a trivial prompt.
    for mode in ("ask", "plan", "coder"):
        tools = filter_tools_for_mode(
            mode, _fake_tools(), {}, set(), True, False, prompt="سلام", root=""
        )
        assert _WEB <= set(tools), f"web tools missing in mode={mode}: {set(tools)}"


def test_web_denied_only_when_cap_web_false():
    tools = filter_tools_for_mode(
        "plan", _fake_tools(), {"web": False}, set(), True, False
    )
    assert _WEB.isdisjoint(set(tools))


def test_web_survives_ask_trivial_prompt():
    # Even a trivial ask prompt must keep web tools; only the planning /
    # permission / memory tools are dropped.
    tools = filter_tools_for_mode(
        "ask", _fake_tools(), {}, set(), True, False, prompt="سلام", root=""
    )
    assert _WEB <= set(tools)
    assert "update_plan" not in tools
    assert "memory" not in tools
    assert "ask_user" not in tools


def test_web_available_with_cap_web_true_explicit():
    tools = filter_tools_for_mode(
        "coder", _fake_tools(), {"web": True}, set(), True, False
    )
    assert _WEB <= set(tools)


def test_coder_keeps_write_and_terminal_with_empty_cap():
    tools = filter_tools_for_mode(
        "coder", _fake_tools(), {}, set(), True, False, prompt="x", root=""
    )
    assert {"write_file", "edit_file", "run_terminal"} <= set(tools)
    assert _WEB <= set(tools)


def test_non_coder_strips_write_and_terminal_but_keeps_web():
    tools = filter_tools_for_mode(
        "plan", _fake_tools(), {}, set(), True, False, prompt="x", root=""
    )
    assert "write_file" not in tools
    assert "run_terminal" not in tools
    assert _WEB <= set(tools)
