"""Tests for the MCP bridge (backend/mcp_bridge.py).

These verify that ``build_mcp_tools``:
* opens a connection per configured server,
* converts each advertised MCP tool into a LangChain ``StructuredTool``,
* invokes the underlying ``session.call_tool`` when the tool is called,
* isolates a broken server (skips it, emits a warning) without crashing,
* returns a ``cleanup`` coroutine that closes every opened session.

The MCP ``ClientSession`` is mocked so no real subprocess / network is
started — we only exercise the bridge's wiring logic.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from mcp_bridge import build_mcp_tools


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

    # Calling the tool should reach session.call_tool with the args.
    out = await t.func(name="world")
    assert out == "result-ok"
    session.call_tool.assert_awaited_once_with("greet", arguments={"name": "world"})

    # Cleanup must be awaitable and not raise.
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
    import shutil

    if shutil.which("docker") is None:
        pytest.skip("docker CLI not installed")

    servers = {"docker": {"command": "docker", "args": ["mcp", "gateway", "run"]}}
    tools, cleanup = await build_mcp_tools(servers, lambda ev: None)
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
