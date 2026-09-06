"""Tests for the MCP bridge (backend/mcp_bridge.py).

These verify that ``build_mcp_tools``:
* opens a connection per configured server,
* converts each advertised MCP tool into a LangChain ``StructuredTool``,
* invokes the underlying ``session.call_tool`` when the tool is called,
* isolates a broken server (skips it, emits a warning) without crashing,
* returns a ``cleanup`` coroutine that is a no-op (sessions are cached),
* **caches sessions between calls** so interactive tools (Playwright) can
  maintain browser state across turns.

The MCP ``ClientSession`` is mocked so no real subprocess / network is
started — we only exercise the bridge's wiring logic.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

import mcp_bridge
from mcp_bridge import build_mcp_tools


@pytest.fixture(autouse=True)
def _clear_session_cache():
    """Reset the module-level session cache between tests."""
    mcp_bridge._session_cache.clear()
    yield
    mcp_bridge._session_cache.clear()


def _fake_tool(name: str, description: str = "", schema: dict | None = None):
    """Build a fake MCP tool definition object."""
    t = MagicMock()
    t.name = name
    t.description = description
    t.inputSchema = schema or {"type": "object", "properties": {}}
    return t


def _fake_session(tools, call_result_text="result-ok"):
    """Build a fake MCP ClientSession that lists ``tools`` and echoes text."""
    session = MagicMock()
    mlist = MagicMock()
    mlist.tools = tools
    session.list_tools = AsyncMock(return_value=mlist)
    session.initialize = AsyncMock()

    result = MagicMock()
    result.content = [MagicMock(text=call_result_text)]
    result.isError = False
    session.call_tool = AsyncMock(return_value=result)

    # Make the session usable as an async context manager (we aenter/aexit it).
    session.__aenter__.return_value = session
    session.__aexit__.return_value = False
    return session


class _FakeStdioCM:
    """Async context manager standing in for ``stdio_client(params)``."""

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        # stdio_client yields (read_stream, write_stream)
        return (MagicMock(), MagicMock())

    async def __aexit__(self, *exc):
        return False


def _fake_stdio_client(session):
    """Return a fake ``stdio_client`` async context manager yielding (r, w)."""
    return _FakeStdioCM(session)


@pytest.mark.asyncio
async def test_builds_structured_tools_from_session(monkeypatch):
    tool = _fake_tool("greet", "Greet someone", {"type": "object", "properties": {"name": {"type": "string"}}})
    session = _fake_session([tool])

    # Patch the stdio transport + ClientSession so no real subprocess is spawned.
    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr(
        "mcp_bridge.ClientSession", lambda r, w: session
    )

    servers = {"demo": {"command": "echo", "args": ["hi"]}}
    tools, cleanup = await build_mcp_tools(servers, lambda ev: None)

    assert len(tools) == 1
    t = tools[0]
    assert t.name == "mcp__demo__greet"
    assert "MCP:demo" in (t.description or "")

    # The tool's schema must carry the MCP input schema's parameters so the
    # model sees the real parameter names (regression: input_schema vs inputSchema).
    assert "name" in t.args

    # Calling the tool should reach session.call_tool with the args.
    out = await t.ainvoke({"name": "world"})
    assert out == "result-ok"
    session.call_tool.assert_awaited_once_with("greet", arguments={"name": "world"})

    # Cleanup must be awaitable and not raise.
    await cleanup()


@pytest.mark.asyncio
async def test_tool_schema_uses_snake_case_input_schema(monkeypatch):
    """The official mcp SDK returns ``Tool.input_schema`` (snake_case) — the
    bridge must read it, not only the camelCase ``inputSchema`` spelling.

    Regression: with only ``inputSchema`` support the schema silently became
    ``{properties: {}}`` and the model had to GUESS parameter names, producing
    errors like ``browser_evaluate(expression=...)`` instead of ``function=...``.
    """
    # Simulate the real SDK: a plain object with ONLY the snake_case attribute.
    from types import SimpleNamespace

    tool = SimpleNamespace(
        name="browser_evaluate",
        description="Evaluate JS",
        input_schema={
            "type": "object",
            "properties": {
                "function": {"type": "string", "description": "() => { /* code */ }"},
                "element": {"type": "string"},
            },
            "required": ["function"],
        },
    )
    session = _fake_session([tool])

    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr(
        "mcp_bridge.ClientSession", lambda r, w: session
    )

    servers = {"playwright": {"command": "npx", "args": ["-y", "@playwright/mcp"]}}
    tools, cleanup = await build_mcp_tools(servers, lambda ev: None)

    assert len(tools) == 1
    t = tools[0]
    # The model must see the REAL parameter names from the server's schema.
    assert "function" in t.args
    assert "element" in t.args
    await cleanup()


@pytest.mark.asyncio
async def test_empty_config_yields_no_tools():
    tools, cleanup = await build_mcp_tools({}, lambda ev: None)
    assert tools == []
    await cleanup()


@pytest.mark.asyncio
async def test_real_docker_mcp_connects(monkeypatch):
    """Integration check: the built-in Docker MCP gateway really serves tools.

    Skipped automatically when ``docker`` is unavailable (CI without Docker), so
    it never turns the suite red on machines that can't run the gateway.
    """
    import asyncio
    import shutil
    import subprocess

    if shutil.which("docker") is None:
        pytest.skip("docker CLI not installed")

    # The CLI may be installed but the daemon (Docker Desktop) not running — the
    # gateway then fails to connect and returns zero tools instead of raising,
    # which would otherwise turn the suite red on machines without Docker.
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", "info"],
            capture_output=True,
            timeout=15,
            check=False,
        )
        if result.returncode != 0:
            pytest.skip("docker daemon not running")
    except Exception:  # noqa: BLE001
        pytest.skip("docker daemon not reachable")

    servers = {"docker": {"command": "docker", "args": ["mcp", "gateway", "run"]}}
    try:
        tools, cleanup = await build_mcp_tools(servers, lambda ev: None)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"docker MCP gateway unavailable: {exc}")
    try:
        # The gateway advertises GitHub + fetch + hugging-face tools.
        names = {t.name for t in tools}
        assert len(tools) > 0
        assert any(n.startswith("mcp__docker__") for n in names)
    finally:
        await cleanup()


@pytest.mark.asyncio
async def test_broken_server_is_isolated(monkeypatch):
    good_tool = _fake_tool("ok_tool")
    good_session = _fake_session([good_tool])

    class _BoomCM:
        async def __aenter__(self):
            raise RuntimeError("connection refused")

        async def __aexit__(self, *exc):
            return False

    def _boom_client(params):
        return _BoomCM()

    monkeypatch.setattr("mcp_bridge.stdio_client", _boom_client)

    events = []
    servers = {
        "broken": {"command": "nope", "args": []},
        "good": {"command": "echo", "args": ["x"]},
    }
    # Patch the stdio transport + ClientSession. The broken server raises before
    # reaching a session; "good" reaches the (patched) ClientSession.
    real_client = _fake_stdio_client(good_session)
    monkeypatch.setattr(
        "mcp_bridge.stdio_client",
        lambda params: _boom_client(params) if params.command == "nope" else real_client,
    )
    monkeypatch.setattr(
        "mcp_bridge.ClientSession", lambda r, w: good_session
    )

    tools, cleanup = await build_mcp_tools(servers, events.append)

    # The broken server is skipped; the good one still yields its tool.
    assert len(tools) == 1
    assert tools[0].name == "mcp__good__ok_tool"
    # A warning event was emitted for the broken server.
    assert any(e.get("kind") == "warn" for e in events)
    await cleanup()


# ---------------------------------------------------------------------------
# Tests for the create_mcp tool schema fix (cmd_args, not reserved 'args')
# and for async tool → StructuredTool conversion (coroutine=, not func=).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_mcp_tool_schema_uses_cmd_args():
    """``create_mcp_tool`` must expose ``cmd_args`` (not the reserved ``args``)
    in its input schema so LangChain doesn't rename it to ``v__args``."""
    import tempfile

    from langchain_core.tools import StructuredTool

    from tools import make_tool_callbacks

    with tempfile.TemporaryDirectory() as tmp:
        emitted: list[dict] = []
        cbs = make_tool_callbacks(
            root=tmp,
            emit=emitted.append,
        )
        fn = cbs["create_mcp"]

    # Build the StructuredTool the same way graph.py does (coroutine=).
    st = StructuredTool.from_function(
        coroutine=fn, name="create_mcp", description=(fn.__doc__ or "create_mcp"),
    )
    schema = st.args_schema.model_json_schema()
    props = list(schema.get("properties", {}).keys())

    # The schema must contain "cmd_args" and NOT "args" or "v__args".
    assert "cmd_args" in props, f"expected 'cmd_args' in schema, got {props}"
    assert "args" not in props, f"'args' (reserved) should not appear in schema: {props}"
    assert "v__args" not in props, f"'v__args' should not appear in schema: {props}"


@pytest.mark.asyncio
async def test_create_mcp_tool_invocation_persists_connector():
    """Calling ``create_mcp`` with ``cmd_args`` must write a connector file
    that ``list_mcp`` can read back."""
    import tempfile

    from state_db import list_mcp
    from tools import make_tool_callbacks

    with tempfile.TemporaryDirectory() as tmp:
        cbs = make_tool_callbacks(root=tmp, emit=lambda e: None)
        fn = cbs["create_mcp"]

        result = await fn(
            name="test-connector",
            command="npx",
            cmd_args=["-y", "@playwright/mcp"],
        )
        assert "saved" in result.lower() or "error" not in result.lower()

        # The connector must now be visible via list_mcp.
        connectors = list_mcp()
        assert "test-connector" in connectors, (
            f"connector not found after save; list_mcp()={connectors}"
        )
        cfg = connectors["test-connector"]
        assert cfg.get("command") == "npx"
        assert cfg.get("args") == ["-y", "@playwright/mcp"]


# ---------------------------------------------------------------------------
# Tests for session caching between turns
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_is_cached_between_calls(monkeypatch):
    """Second call with the same config must reuse the cached session, not
    spawn a new subprocess (call_list_tools tracks how many times
    ``session.list_tools`` is hit)."""
    from types import SimpleNamespace

    tool = SimpleNamespace(
        name="search",
        description="search",
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )
    session = _fake_session([tool])

    call_count = 0
    _original_init = session.initialize

    async def _counting_init():
        nonlocal call_count
        call_count += 1
        return await _original_init()

    session.initialize = _counting_init

    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr(
        "mcp_bridge.ClientSession", lambda r, w: session
    )

    servers = {"demo": {"command": "echo", "args": ["hi"]}}
    emit = lambda ev: None

    # First call — connects and caches
    tools1, cleanup1 = await build_mcp_tools(servers, emit)
    assert len(tools1) == 1
    assert call_count == 1
    assert "demo" in mcp_bridge._session_cache

    # Second call — must reuse the cache, NOT call initialize again
    tools2, cleanup2 = await build_mcp_tools(servers, emit)
    assert len(tools2) == 1
    assert call_count == 1  # still 1 — no new connection
    assert tools2[0].name == tools1[0].name

    # Both cleanups are no-ops (cached sessions persist)
    await cleanup1()
    await cleanup2()


@pytest.mark.asyncio
async def test_config_change_invalidates_cache(monkeypatch):
    """When the config changes, the old session is closed and a fresh one is
    created."""
    tool_v1 = MagicMock()
    tool_v1.name = "tool_v1"
    tool_v1.description = "v1"
    tool_v1.input_schema = {"type": "object", "properties": {}}

    tool_v2 = MagicMock()
    tool_v2.name = "tool_v2"
    tool_v2.description = "v2"
    tool_v2.input_schema = {"type": "object", "properties": {}}

    init_count = 0

    def _make_session(tools):
        """Create a mock session with an ``initialize`` counter."""
        sess = _fake_session(tools)
        _orig_init = sess.initialize

        async def _counting_init():
            nonlocal init_count
            init_count += 1
            return await _orig_init()

        sess.initialize = _counting_init
        return sess

    session_v1 = _make_session([tool_v1])
    session_v2 = _make_session([tool_v2])

    call_idx = 0

    def _select_client(params):
        nonlocal call_idx
        call_idx += 1
        return _fake_stdio_client(session_v1 if call_idx <= 1 else session_v2)

    def _select_session(r, w):
        return session_v1 if call_idx <= 1 else session_v2

    monkeypatch.setattr("mcp_bridge.stdio_client", _select_client)
    monkeypatch.setattr("mcp_bridge.ClientSession", _select_session)

    # First connect
    tools1, _ = await build_mcp_tools(
        {"srv": {"command": "echo", "args": ["v1"]}}, lambda ev: None
    )
    assert len(tools1) == 1
    assert "tool_v1" in tools1[0].name
    assert init_count == 1

    # Config change → must reconnect
    tools2, _ = await build_mcp_tools(
        {"srv": {"command": "echo", "args": ["v2"]}}, lambda ev: None
    )
    assert len(tools2) == 1
    assert "tool_v2" in tools2[0].name
    assert init_count == 2  # new session initialized


@pytest.mark.asyncio
async def test_shutdown_mcp_sessions_clears_cache(monkeypatch):
    """``shutdown_mcp_sessions`` must close all cached sessions."""
    from types import SimpleNamespace

    tool = SimpleNamespace(
        name="t", description="t",
        input_schema={"type": "object", "properties": {}},
    )

    close_called = False

    class _FakeStack:
        async def aclose(self):
            nonlocal close_called
            close_called = True

    session = _fake_session([tool])

    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr(
        "mcp_bridge.ClientSession", lambda r, w: session
    )

    # Connect and cache
    await build_mcp_tools({"srv": {"command": "echo", "args": []}}, lambda ev: None)
    assert "srv" in mcp_bridge._session_cache

    # Manually replace the stack with our fake to track aclose()
    mcp_bridge._session_cache["srv"].stack = _FakeStack()

    from mcp_bridge import shutdown_mcp_sessions
    await shutdown_mcp_sessions()

    assert close_called
    assert mcp_bridge._session_cache == {}
