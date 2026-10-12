"""Unit tests for the read-only sub-agent contract (no edits, trusted reports)."""

import agent_registry
import graph
from tools import _SUBAGENT_STRIPPED_TOOLS


def test_plan_mode_strips_edit_tools():
    """Plan mode (and its sub-agent inheritance) must not expose edit tools."""
    tools = {
        "grep": lambda *a, **k: "",
        "glob": lambda *a, **k: "",
        "read": lambda *a, **k: "",
        "task": lambda *a, **k: "",
        "write_file": lambda *a, **k: "",
        "edit_file": lambda *a, **k: "",
        "run_terminal": lambda *a, **k: "",
        "confirm_action": lambda *a, **k: "",
        "git_commit": lambda *a, **k: "",
        "write_document": lambda *a, **k: "",
    }
    old = graph._PARENT_TOOLS_CTX.get()
    try:
        filtered = graph.filter_tools_for_mode(
            "plan",
            dict(tools),
            None,
            set(),
            True,
            False,
        )
        for name in (
            "write_file",
            "edit_file",
            "run_terminal",
            "confirm_action",
            "git_commit",
            "write_document",
        ):
            assert name not in filtered
        for name in ("grep", "glob", "read", "task"):
            assert name in filtered
        parent = graph._PARENT_TOOLS_CTX.get()
        for name in ("write_file", "edit_file", "git_commit", "write_document"):
            assert name not in parent
    finally:
        graph._PARENT_TOOLS_CTX.set(old)


def test_subagent_report_format_trusted_no_research():
    """Report header/body/verify suffix locked; long reports truncate."""
    text = graph._subagent_report_text("t123", "done stuff", "completed")
    assert "[background sub-agent report - task_id=t123, status=finished]" in text
    assert "done stuff" in text
    assert "Verify the task is actually done before finalizing" in text

    empty = graph._subagent_report_text("t9", "   ", "failed")
    assert "status=failed" in empty
    assert "(no report produced)" in empty

    long_text = graph._subagent_report_text("t7", "x" * 7000, "completed")
    assert "…[sub-agent report truncated" in long_text
    assert "x" * 7000 not in long_text


def test_subagent_allowlist_is_search_read_web_only():
    """Locked allowlist keeps web research, drops every mutating tool."""
    allowed = set(agent_registry.SUBAGENT_TOOLS)
    for name in ("grep", "glob", "read", "web_search", "fetch_url"):
        assert name in allowed
    for name in (
        "write_file",
        "edit_file",
        "run_terminal",
        "confirm_action",
        "git_commit",
        "task",
        "update_plan",
    ):
        assert name not in allowed


def test_subagent_stripped_tools_cover_all_mutations_not_web():
    """Defense-in-depth strip set covers edits/terminal, never web tools."""
    for name in (
        "write_file",
        "edit_file",
        "write_document",
        "confirm_action",
        "git_commit",
        "run_terminal",
        "create_skill",
        "create_mcp",
    ):
        assert name in _SUBAGENT_STRIPPED_TOOLS
    assert "web_search" not in _SUBAGENT_STRIPPED_TOOLS
    assert "fetch_url" not in _SUBAGENT_STRIPPED_TOOLS
