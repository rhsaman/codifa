"""Tests for the MCP bridge (backend/mcp_bridge.py).

These verify that ``build_mcp_tools``:
* opens a connection per configured server,
* converts each advertised MCP tool into a LangChain ``StructuredTool``,
* invokes the underlying ``session.call_tool`` when the tool is called,
* isolates a broken server (skips it, emits a warning) without crashing,
* returns a ``cleanup`` coroutine that is a no-op (sessions are cached),
* **caches sessions between calls** so interactive tools (Playwright) can
  maintain browser state across turns,
* **reaps orphaned server/browser processes** before a fresh connect so a
  crashed previous run can't hold the browser profile lock forever,
* **serialises concurrent connects** per server (no double-spawn).

The MCP ``ClientSession`` is mocked so no real subprocess / network is
started — we only exercise the bridge's wiring logic.
"""

import asyncio
import json
import os
from contextlib import AsyncExitStack
from types import SimpleNamespace
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
    # Short binding: the server prefix is dropped from the tool name.
    assert t.name == "greet"
    assert "MCP:demo" in (t.description or "")
    # Metadata carries the backing server + the qualified name.
    assert t.metadata["mcp_server"] == "demo"
    assert t.metadata["mcp_qualified"] == "mcp__demo__greet"

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
async def test_short_name_falls_back_on_collision(monkeypatch):
    """An MCP tool whose short name collides with a reserved (native) tool
    name must bind under its fully qualified ``mcp__<server>__<tool>`` name —
    never shadow the native tool."""
    tool = _fake_tool("read", "Read something")
    session = _fake_session([tool])

    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr("mcp_bridge.ClientSession", lambda r, w: session)

    servers = {"demo": {"command": "echo", "args": ["hi"]}}
    # "read" is a native tool → the MCP tool must fall back to the qualified name.
    tools, cleanup = await build_mcp_tools(
        servers, lambda ev: None, reserved_names={"read", "grep"}
    )

    assert len(tools) == 1
    assert tools[0].name == "mcp__demo__read"
    # Without the collision the same tool binds short.
    tools2, _ = await build_mcp_tools(servers, lambda ev: None, reserved_names=set())
    assert tools2[0].name == "read"
    await cleanup()


@pytest.mark.asyncio
async def test_cross_server_short_name_collision(monkeypatch):
    """دو سرور MCP با ابزار هم‌نام: اولی نام کوتاه می‌گیرد، دومی به نام
    qualified برمی‌گردد — هیچ ابزاری دیگری را shadow نمی‌کند."""
    session_a = _fake_session([_fake_tool("greet", "Greet from A")])
    session_b = _fake_session([_fake_tool("greet", "Greet from B")])

    def _client_for(session):
        def _client(params):
            return _fake_stdio_client(session)

        return _client

    monkeypatch.setattr("mcp_bridge.stdio_client", _client_for(session_a))
    monkeypatch.setattr("mcp_bridge.ClientSession", lambda r, w: session_a)

    # سرور دوم باید session خودش را بگیرد — بر اساس command تفکیک می‌کنیم.
    def _stdio_by_command(params):
        if params.command == "server-b":
            return _fake_stdio_client(session_b)
        return _fake_stdio_client(session_a)

    monkeypatch.setattr("mcp_bridge.stdio_client", _stdio_by_command)
    monkeypatch.setattr("mcp_bridge.ClientSession", lambda r, w: session_a)

    servers = {
        "a": {"command": "server-a", "args": []},
        "b": {"command": "server-b", "args": []},
    }
    tools, cleanup = await build_mcp_tools(servers, lambda ev: None)

    names = [t.name for t in tools]
    # یکی کوتاه، دیگری qualified — هر دو قابل فراخوانی، بدون shadow.
    assert sorted(names) == ["greet", "mcp__b__greet"]
    # هر دو به سرور خودشان وصل‌اند (metadata درست است).
    by_name = {t.name: t for t in tools}
    assert by_name["greet"].metadata["mcp_server"] == "a"
    assert by_name["mcp__b__greet"].metadata["mcp_server"] == "b"
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
        # Short bindings (no mcp__ prefix); a collision falls back to the
        # qualified form, so both spellings are acceptable here.
        assert any(
            n.startswith("mcp__docker__") or not n.startswith("mcp__") for n in names
        )
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
    assert tools[0].name == "ok_tool"
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


# ---------------------------------------------------------------------------
# Tests for orphan reaping (leftover server/browser processes)
# ---------------------------------------------------------------------------


def test_distinctive_tokens_filters_generic_words():
    """Only long tokens with path/package markers qualify — ``docker mcp
    gateway run`` must match nothing, ``@playwright/mcp@latest`` must."""
    from mcp_bridge import _distinctive_tokens

    # Generic short words never qualify — a docker config must reap nothing.
    assert _distinctive_tokens({"command": "docker", "args": ["mcp", "gateway", "run"]}) == []

    # Package/path tokens qualify.
    tokens = _distinctive_tokens(
        {"command": "npx", "args": ["-y", "@playwright/mcp@latest", "--browser=chrome"]}
    )
    assert tokens == ["@playwright/mcp@latest"]

    # A user-data-dir path qualifies too (it identifies the profile lock).
    tokens = _distinctive_tokens(
        {"command": "npx", "args": ["--user-data-dir", "/Users/x/.codifa/playwright-profile"]}
    )
    assert tokens == ["/Users/x/.codifa/playwright-profile"]


def test_reap_processes_kills_matching_orphans(monkeypatch):
    """``_reap_processes`` kills only processes whose command line carries a
    distinctive token — and never the current process's own descendants."""
    import mcp_bridge as mb

    me = os.getpid()
    # Two orphans (one carrying the token) + our own process (must survive).
    fake_ps = (
        f"  101     1 node /usr/local/bin/npx @playwright/mcp@latest --browser=chrome\n"
        f"  102     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.codifa/playwright-profile\n"
        f"  103     1 docker mcp gateway run\n"
        f"  {me}     1 python server.py --port 18080\n"
    )

    killed: list[int] = []

    def fake_run(cmd, **kwargs):
        return SimpleNamespace(stdout=fake_ps, returncode=0)

    monkeypatch.setattr(mb.subprocess, "run", fake_run)
    monkeypatch.setattr(
        os, "kill",
        lambda pid, sig: killed.append(pid),
    )

    cfg = {
        "command": "npx",
        "args": [
            "-y",
            "@playwright/mcp@latest",
            "--browser=chrome",
            "--user-data-dir",
            "/Users/x/.codifa/playwright-profile",
        ],
    }
    n = mb._reap_processes(cfg, protect_own=True)

    # The npx server (101) and the Chrome holding the profile (102) die;
    # docker (103, no token) and our own process (me) survive.
    assert sorted(killed) == [101, 102]
    assert n == 2


def test_reap_processes_protects_own_descendants(monkeypatch):
    """With ``protect_own=True`` the current process's own children (e.g. a
    live cached session's server) are never killed."""
    import mcp_bridge as mb

    me = os.getpid()
    child = me + 1  # pretend this is our own child
    fake_ps = (
        f"  {child}  {me} node @playwright/mcp@latest\n"
        f"  201     1 node @playwright/mcp@latest\n"
    )

    killed: list[int] = []

    def fake_run(cmd, **kwargs):
        return SimpleNamespace(stdout=fake_ps, returncode=0)

    monkeypatch.setattr(mb.subprocess, "run", fake_run)
    monkeypatch.setattr(os, "kill", lambda pid, sig: killed.append(pid))

    cfg = {"command": "npx", "args": ["@playwright/mcp@latest"]}
    mb._reap_processes(cfg, protect_own=True)

    # Only the true orphan (201) dies; our own child survives.
    assert killed == [201]


@pytest.mark.asyncio
async def test_connect_failure_closes_stack(monkeypatch):
    """A connect that fails mid-handshake must close its half-open stack —
    otherwise the spawned subprocess leaks (and holds the profile lock)."""
    tool = _fake_tool("t", "t")

    class _ExplodingCM:
        async def __aenter__(self):
            return (MagicMock(), MagicMock())

        async def __aexit__(self, *exc):
            return False

    closed = False

    class _TrackingStack:
        def __init__(self):
            self._stack = AsyncExitStack()

        async def enter_async_context(self, cm):
            return await self._stack.enter_async_context(cm)

        async def aclose(self):
            nonlocal closed
            closed = True
            await self._stack.aclose()

    # ClientSession whose initialize() explodes mid-handshake.
    session = _fake_session([tool])
    session.initialize = AsyncMock(side_effect=RuntimeError("boom"))

    monkeypatch.setattr("mcp_bridge.stdio_client", lambda params: _ExplodingCM())
    monkeypatch.setattr("mcp_bridge.ClientSession", lambda r, w: session)
    monkeypatch.setattr("mcp_bridge.AsyncExitStack", _TrackingStack)

    servers = {"srv": {"command": "echo", "args": ["hi"]}}
    # Must not raise — the failure is isolated per-server.
    tools, _ = await build_mcp_tools(servers, lambda ev: None)

    assert tools == []
    assert closed, "half-open stack must be closed on connect failure"
    assert "srv" not in mcp_bridge._session_cache


@pytest.mark.asyncio
async def test_concurrent_connects_share_one_session(monkeypatch):
    """Two turns connecting the same server at once must end up with ONE
    cached session — the per-server lock serialises the double-spawn."""
    tool = _fake_tool("search", "search")
    session = _fake_session([tool])

    init_count = 0
    _orig_init = session.initialize

    async def _slow_init():
        nonlocal init_count
        init_count += 1
        await asyncio.sleep(0.05)  # widen the race window
        return await _orig_init()

    session.initialize = _slow_init

    monkeypatch.setattr(
        "mcp_bridge.stdio_client", lambda params: _fake_stdio_client(session)
    )
    monkeypatch.setattr("mcp_bridge.ClientSession", lambda r, w: session)

    servers = {"demo": {"command": "echo", "args": ["hi"]}}

    # Two concurrent build_mcp_tools calls (two turns racing).
    results = await asyncio.gather(
        build_mcp_tools(servers, lambda ev: None),
        build_mcp_tools(servers, lambda ev: None),
    )

    # Both get the same tools, but only ONE session was initialised.
    assert init_count == 1, f"double-spawn: initialize ran {init_count} times"
    assert len(results[0][0]) == 1
    assert len(results[1][0]) == 1
    assert results[0][0][0].name == results[1][0][0].name
    assert len(mcp_bridge._session_cache) == 1


# ---------------------------------------------------------------------------
# فشرده‌سازی تعریف ابزارها (کاهش مصرف توکن در هر turn)
# ---------------------------------------------------------------------------


def test_compact_description_truncates_at_sentence_boundary():
    """توضیح بلند باید در مرز جمله و زیر سقف بریده شود، نه وسط کلمه."""
    long_desc = (
        "Navigate to a URL. "
        "This is a very long second sentence with lots of detail that the "
        "model does not need to pick the tool. " * 5
    ).strip()
    out = mcp_bridge._compact_description(long_desc)
    assert len(out) <= mcp_bridge._DESC_MAX_CHARS + 2
    assert out.startswith("Navigate to a URL.")
    assert out.endswith("."), "برش باید در مرز جمله باشد"


def test_compact_description_short_text_untouched():
    """توضیح کوتاه‌تر از سقف باید دست‌نخورده بماند."""
    short = "List running containers."
    assert mcp_bridge._compact_description(short) == short


def test_compact_description_no_sentence_falls_back_to_word_boundary():
    """بدون مرز جمله، برش در مرز کلمه انجام می‌شود (با نشانگر …)."""
    long_desc = "x" * 400  # یک «کلمه» پیوسته بدون فاصله
    out = mcp_bridge._compact_description(long_desc)
    assert out.endswith("…")
    assert len(out) <= mcp_bridge._DESC_MAX_CHARS + 2


def test_compact_schema_strips_titles_and_caps_field_descriptions():
    """title حذف و description فیلدها به سقف محدود می‌شود؛ ساختار دست‌نخورده."""
    schema = {
        "type": "object",
        "title": "Big Title",
        "properties": {
            "url": {
                "type": "string",
                "title": "Url",
                "description": "d" * 200,
            },
            "opts": {
                "type": "object",
                "title": "Opts",
                "properties": {
                    "headless": {
                        "type": "boolean",
                        "description": "short",
                    },
                },
            },
        },
        "required": ["url"],
    }
    out = mcp_bridge._compact_schema(schema)
    assert "title" not in out
    assert out["required"] == ["url"]
    url_desc = out["properties"]["url"]["description"]
    assert len(url_desc) <= mcp_bridge._FIELD_DESC_MAX_CHARS + 2
    assert url_desc.endswith("…")
    # تو در تو هم پاک می‌شود
    assert "title" not in out["properties"]["opts"]
    assert out["properties"]["opts"]["properties"]["headless"]["description"] == "short"


def test_compact_schema_does_not_mutate_input():
    """ورودی نباید تغییر کند — اسکیمای خامِ کش‌شده در session دست‌نخورده بماند."""
    schema = {"type": "object", "title": "T", "properties": {"a": {"type": "string", "title": "A"}}}
    before = json.dumps(schema, sort_keys=True)
    mcp_bridge._compact_schema(schema)
    assert json.dumps(schema, sort_keys=True) == before


@pytest.mark.asyncio
async def test_make_tool_compacts_description_and_schema():
    """_make_tool باید توضیح و schema فشرده‌شده به مدل بدهد."""
    long_desc = "Does one thing well. " + "extra prose " * 40
    schema = {
        "type": "object",
        "title": "T",
        "properties": {
            "q": {"type": "string", "description": "d" * 200},
        },
    }
    tool = _fake_tool("search", long_desc, schema)
    session = _fake_session([tool])
    st = mcp_bridge._make_tool("srv", tool, session, lambda ev: None)

    assert st.name == "search"
    assert len(st.description) < len(long_desc)
    assert st.description.startswith("[MCP:srv] Does one thing well.")
    # schema فشرده شده: بدون title، description فیلد سقف خورده
    args = st.args_schema.model_json_schema() if hasattr(st.args_schema, "model_json_schema") else st.args_schema
    dumped = json.dumps(args)
    assert '"title": "T"' not in dumped
    assert "d" * 100 not in dumped
