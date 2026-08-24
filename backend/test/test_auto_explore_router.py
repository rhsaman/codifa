"""Unit tests for the auto-explore router (``_wrap_auto_explore_router``).

The router must let TARGETED searches run directly (grep/glob/read/web_search/
fetch_url) and only route BROAD or REPEATED calls to the explore sub-agent via
an explore hint. It must NOT force explore on every search — only when it truly
needs to. The explore sub-agent itself keeps web_search/fetch_url so it can read
documentation in isolation.
"""
import pytest

from agents import (
    _AUTO_EXPLORE_THRESHOLD,
    _AUTO_EXPLORE_WEB_THRESHOLD,
    _reset_search_call_count,
    _SUB_AGENT_CTX,
    _wrap_auto_explore_router,
)


async def _direct_marker(*args, **kwargs):
    return "DIRECT"


def _wrap(name: str):
    async def fn(*a, **k):
        return "DIRECT"

    fn.__name__ = name
    return _wrap_auto_explore_router(fn)


def setup_function(_fn):
    # Each test starts a fresh turn.
    _reset_search_call_count()


async def test_targeted_glob_runs_directly():
    tool = _wrap("glob")
    out = await tool(pattern="src/**/*.py", include="*.py")
    assert out == "DIRECT"


async def test_broad_glob_without_include_is_routed():
    tool = _wrap("glob")
    out = await tool(pattern="**/*.py")
    assert "explore" in out and out != "DIRECT"


async def test_targeted_grep_runs_directly():
    tool = _wrap("grep")
    out = await tool(pattern="def foo", path="src", include="*.py")
    assert out == "DIRECT"


async def test_repo_wide_grep_is_routed():
    tool = _wrap("grep")
    out = await tool(pattern="TODO")
    assert "explore" in out and out != "DIRECT"


async def test_read_always_runs_directly():
    tool = _wrap("read")
    out = await tool(filePath="src/main.py")
    assert out == "DIRECT"


async def test_repeated_grep_exceeds_threshold_and_routes():
    tool = _wrap("grep")
    # First calls (up to threshold) run directly.
    for _ in range(_AUTO_EXPLORE_THRESHOLD):
        assert await tool(pattern="x", path="src", include="*.py") == "DIRECT"
    # The next call pushes the counter past the threshold -> routed.
    out = await tool(pattern="x", path="src", include="*.py")
    assert "explore" in out and out != "DIRECT"


async def test_repeated_web_search_routes_after_web_threshold():
    tool = _wrap("web_search")
    for _ in range(_AUTO_EXPLORE_WEB_THRESHOLD):
        assert await tool(query="x") == "DIRECT"
    out = await tool(query="x")
    assert "explore" in out and out != "DIRECT"


async def test_fetch_url_runs_directly_until_threshold():
    tool = _wrap("fetch_url")
    out = await tool(url="https://example.com/doc")
    assert out == "DIRECT"


async def test_counter_resets_per_turn():
    tool = _wrap("grep")
    # Exhaust the threshold in one turn.
    for _ in range(_AUTO_EXPLORE_THRESHOLD + 1):
        await tool(pattern="x", path="src", include="*.py")
    # Reset (new turn) -> targeted calls run directly again.
    _reset_search_call_count()
    out = await tool(pattern="x", path="src", include="*.py" if False else "*.py")
    assert out == "DIRECT"


async def test_subagent_tools_run_directly_even_when_broad():
    """The explore sub-agent must never route its own searches back to itself.

    Inside the sub-agent context (``_SUB_AGENT_CTX`` set), even a repo-wide grep
    or repeated calls must run directly — otherwise the sub-agent deadlocks with
    "explore is blocked" hints and makes zero real tool calls.
    """
    tool = _wrap("grep")
    token = _SUB_AGENT_CTX.set(True)
    try:
        # A repo-wide grep (broad) must still run directly inside the sub-agent.
        assert await tool(pattern="TODO") == "DIRECT"
        # Repeated calls past the threshold must also run directly.
        for _ in range(_AUTO_EXPLORE_THRESHOLD + 2):
            assert await tool(pattern="x", path="src", include="*.py") == "DIRECT"
    finally:
        _SUB_AGENT_CTX.reset(token)


async def test_subagent_web_tools_run_directly():
    """web_search/fetch_url inside the sub-agent run directly, not routed."""
    web = _wrap("web_search")
    fetch = _wrap("fetch_url")
    token = _SUB_AGENT_CTX.set(True)
    try:
        for _ in range(_AUTO_EXPLORE_WEB_THRESHOLD + 2):
            assert await web(query="x") == "DIRECT"
            assert await fetch(url="https://example.com/doc") == "DIRECT"
    finally:
        _SUB_AGENT_CTX.reset(token)
