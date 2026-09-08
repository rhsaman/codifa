"""Bridge that connects configured MCP servers to the agent's tool set.

The agent stores MCP connector configs in ``state["mcp_servers"]`` (seeded from
the app database / settings). This module turns each live server into a set of
LangChain ``StructuredTool`` instances so the model can actually call them —
previously the runtime never opened a connection, so MCP tools (e.g. the Docker
MCP connector) were unreachable and the frontend only injected a no-op text
note telling the model to "use the MCP tools".

Design notes
------------
* stdio connectors (``command``/``args``) use ``mcp.client.stdio``.
* HTTP/SSE connectors (``url``) use ``mcp.client.streamable_http`` (falling back
  to ``sse_client`` when the server only speaks SSE).
* Sessions are **cached between turns**: once a server connects, its session
  stays alive across multiple turns so interactive tools (like Playwright) can
  maintain browser state (open tabs, cookies, DOM).  The cache is keyed by
  ``(server_name, config_hash)`` — when the user changes a connector's config,
  the old session is closed and a fresh one is created.
* Failures are isolated per-server: a broken connector never takes down the
  whole turn — it is skipped and a warning is emitted to the UI.
* Orphaned processes from a dead previous run (the MCP server and the browser
  it launched survive a crashed sidecar and keep holding e.g. Chrome's profile
  lock) are reaped before every fresh connect and again on shutdown.
* A per-server lock serialises connects so two concurrent turns never
  double-spawn the same server.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import subprocess
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools import StructuredTool
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

# ---------------------------------------------------------------------------
# Session cache — persistent MCP connections between turns
# ---------------------------------------------------------------------------

@dataclass(frozen=False, slots=True)
class _CachedSession:
    """A live MCP server session that persists across turns."""
    stack: AsyncExitStack
    session: ClientSession
    raw_tools: list[Any]  # mcp.types.Tool objects
    config_hash: str
    # Original config — needed to reap this server's leftover processes on
    # close/shutdown (closing the stack alone doesn't reach browser
    # grandchildren that outlived their server process).
    cfg: dict = field(default_factory=dict)


# Module-level: server name → _CachedSession
_session_cache: dict[str, _CachedSession] = {}

# Per-server connect locks: two concurrent turns must never double-spawn the
# same server — the second spawn would hit the first one's profile lock.
_connect_locks: dict[str, asyncio.Lock] = {}


def _lock_for(name: str) -> asyncio.Lock:
    lock = _connect_locks.get(name)
    if lock is None:
        lock = asyncio.Lock()
        _connect_locks[name] = lock
    return lock


def _config_hash(cfg: dict) -> str:
    """Deterministic fingerprint of an MCP server config."""
    blob = json.dumps(cfg, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Orphan reaping — kill leftover server/browser processes before connecting
# ---------------------------------------------------------------------------

# SIGKILL where it exists; Windows only offers SIGTERM semantics for os.kill.
_KILL_SIGNAL = getattr(signal, "SIGKILL", signal.SIGTERM)


def _distinctive_tokens(cfg: dict) -> list[str]:
    """Tokens specific enough to identify this server's own processes.

    A token qualifies when it is long enough and carries a path/package
    marker (``/`` or ``@``) — e.g. ``@playwright/mcp@latest`` or
    ``/Users/x/.codifa/playwright-profile``. Short or generic words
    (``run``, ``gateway``, ``--browser=chrome``) never qualify, so a config
    like ``docker mcp gateway run`` matches nothing instead of killing
    unrelated processes.
    """
    tokens: list[str] = []
    for a in (cfg.get("args") or []):
        s = str(a)
        if len(s) < 8:
            continue
        if "/" in s or "@" in s:
            tokens.append(s)
    return tokens


def _descendants_of(root: int, pid_ppid: dict[int, int]) -> set[int]:
    """All PIDs transitively descended from ``root`` (BFS over the PPID map)."""
    children: dict[int, list[int]] = {}
    for pid, ppid in pid_ppid.items():
        children.setdefault(ppid, []).append(pid)
    found: set[int] = set()
    queue = [root]
    while queue:
        for child in children.get(queue.pop(), ()):
            if child not in found:
                found.add(child)
                queue.append(child)
    return found


def _reap_processes(cfg: dict, *, protect_own: bool) -> int:
    """Kill leftover processes belonging to this MCP server config.

    When the sidecar dies without a clean shutdown (crash, force-quit), the
    server subprocess and the browser it launched survive as orphans and keep
    holding locks (e.g. Chrome's profile ``SingletonLock``) — every fresh
    connect then fails with "Browser is already in use". This scans the
    process table for command lines carrying one of the config's distinctive
    tokens and kills them.

    ``protect_own=True`` skips the current process's own descendants — used
    before a fresh connect so a concurrent startup probe or another server's
    live session is never touched. ``False`` is for tearing a session down:
    its own stragglers (a browser that outlived its server) must die too.
    """
    tokens = _distinctive_tokens(cfg)
    if not tokens:
        return 0
    try:
        proc = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,command="],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 0
    rows: list[tuple[int, int, str]] = []
    for line in (proc.stdout or "").splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
        except ValueError:
            continue
    if not rows:
        return 0
    skip: set[int] = set()
    if protect_own:
        me = os.getpid()
        skip = _descendants_of(me, {pid: ppid for pid, ppid, _ in rows})
        skip.add(me)
    killed = 0
    for pid, _ppid, cmd in rows:
        if pid in skip:
            continue
        if not any(tok in cmd for tok in tokens):
            continue
        try:
            os.kill(pid, _KILL_SIGNAL)
            killed += 1
        except OSError:
            pass
    return killed


def _json_schema_from_input(input_schema: dict | None) -> dict:
    """Normalise an MCP tool's input schema into a JSON schema for LangChain.

    MCP advertises ``inputSchema``; if missing we accept anything (empty object)
    so the tool is still callable.
    """
    if not isinstance(input_schema, dict):
        return {"type": "object", "properties": {}}
    props = input_schema.get("properties")
    if not isinstance(props, dict):
        return {"type": "object", "properties": {}}
    return {
        "type": "object",
        "properties": props,
        "required": input_schema.get("required", []),
    }


def _tool_input_schema(tool: Any) -> dict | None:
    """Read an MCP tool's input schema, tolerating both attribute spellings.

    The official ``mcp`` Python SDK returns ``Tool.input_schema`` (snake_case),
    while raw MCP wire payloads and older mocks use ``inputSchema`` (camelCase).
    """
    for attr in ("input_schema", "inputSchema"):
        schema = getattr(tool, attr, None)
        if isinstance(schema, dict):
            return schema
    return None


async def _call_mcp_tool(
    session: ClientSession,
    tool_name: str,
    emit: Callable[[dict], None],
    server_name: str,
    qualified: str,
    **kwargs: Any,
) -> str:
    """Invoke an MCP tool and return its textual result.

    Mirrors the internal tools' UI contract: emit a ``tool`` event before the
    call and a ``tool_result`` event after, so MCP calls render in the live
    activity feed exactly like native tools.
    """
    emit({"kind": "tool", "tool": qualified, "args": kwargs, "mcp_server": server_name})
    try:
        result = await session.call_tool(tool_name, arguments=kwargs or {})
    except Exception as exc:  # noqa: BLE001
        msg = f"ERROR calling MCP tool {tool_name!r}: {exc}"
        emit({"kind": "tool_result", "tool": tool_name, "summary": msg, "status": "error"})
        return msg

    # MCP returns structured content; flatten it to text for the model.
    parts: list[str] = []
    content = getattr(result, "content", None)
    if isinstance(content, list):
        for item in content:
            text = getattr(item, "text", None)
            if text is not None:
                parts.append(str(text))
            else:
                parts.append(str(item))
    elif content is not None:
        parts.append(str(content))
    if not parts:
        # Some servers signal success via isError / structured data only.
        if getattr(result, "isError", False):
            parts.append("ERROR: MCP tool returned an error")
        else:
            parts.append("(no output)")
    summary = "\n".join(parts)
    emit({"kind": "tool_result", "tool": qualified, "summary": summary[:500], "status": "ok"})
    return summary


def is_browser_mcp_tool(name: str) -> bool:
    """True for browser-control MCP tools (``mcp__<server>__browser_*``)."""
    parts = name.split("__", 2)
    return len(parts) == 3 and parts[0] == "mcp" and parts[2].startswith("browser_")


def _make_tool(
    server_name: str,
    tool: Any,
    session: ClientSession,
    emit: Callable[[dict], None],
) -> StructuredTool:
    """Wrap a single MCP tool definition into a LangChain ``StructuredTool``."""
    tool_name = getattr(tool, "name", None) or "tool"
    # Prefix to avoid collisions with native tools and across servers.
    qualified = f"mcp__{server_name}__{tool_name}"

    async def _func(**kwargs: Any) -> str:
        return await _call_mcp_tool(
            session, tool_name, emit, server_name, qualified=qualified, **kwargs
        )

    _func.__name__ = qualified
    _func.__doc__ = (
        f"[MCP:{server_name}] {getattr(tool, 'description', '') or tool_name}"
    )

    return StructuredTool.from_function(
        coroutine=_func,
        name=qualified,
        description=_func.__doc__ or qualified,
        args_schema=_json_schema_from_input(_tool_input_schema(tool)),
    )


async def _connect_stdio(
    name: str,
    cfg: dict,
    emit: Callable[[dict], None],
) -> tuple[AsyncExitStack, ClientSession, list[Any]]:
    """Open a stdio MCP server and return (stack, session, raw_tools).

    The ``AsyncExitStack`` must stay alive as long as the session is in use.
    Closing it from a different async task than the one that opened it would
    raise ``RuntimeError: Attempted to exit cancel scope in a different task``
    (anyio limitation), so the stack is stored in the session cache and only
    closed when the server config changes or the app shuts down.
    """
    command = cfg.get("command")
    if not command:
        raise ValueError(f"MCP server {name!r}: no command specified")

    params = StdioServerParameters(
        command=str(command),
        args=[str(a) for a in (cfg.get("args") or []) if isinstance(a, (str, int))],
        env={**os.environ, **(cfg.get("env") or {})},
    )

    stack = AsyncExitStack()
    try:
        read_stream, write_stream = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
        await session.initialize()
        mlist = await session.list_tools()
    except BaseException:
        # A half-open stack would leak the spawned subprocess — close it.
        # BaseException on purpose: a mid-connect cancellation must close too.
        with suppress(Exception):
            await stack.aclose()
        raise
    return stack, session, list(mlist.tools or [])


async def _connect_http(
    name: str,
    cfg: dict,
    emit: Callable[[dict], None],
) -> tuple[AsyncExitStack, ClientSession, list[Any]]:
    """Open an HTTP/SSE MCP server and return (stack, session, raw_tools)."""
    url = cfg.get("url")
    if not url:
        raise ValueError(f"MCP server {name!r}: no url specified")

    # Prefer the modern streamable-http transport; fall back to SSE for legacy
    # servers. Imported lazily so a missing extra doesn't break stdio servers.
    try:
        from mcp.client.streamable_http import streamablehttp_client
    except Exception:  # noqa: BLE001
        streamablehttp_client = None

    try:
        from mcp.client.sse import sse_client
    except Exception:  # noqa: BLE001
        sse_client = None

    if streamablehttp_client is not None:
        ctx = streamablehttp_client(url)
    elif sse_client is not None:
        ctx = sse_client(url)
    else:
        raise RuntimeError(f"MCP server {name!r}: no HTTP/SSE client available")

    stack = AsyncExitStack()
    try:
        read_stream, write_stream, _ = await stack.enter_async_context(ctx)
        session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
        await session.initialize()
        mlist = await session.list_tools()
    except BaseException:
        # A half-open stack would leak the connection — close it.
        with suppress(Exception):
            await stack.aclose()
        raise
    return stack, session, list(mlist.tools or [])


async def build_mcp_tools(
    mcp_servers: dict | None,
    emit: Callable[[dict], None],
) -> tuple[list[StructuredTool], Callable[[], Awaitable[None]]]:
    """Connect to every configured MCP server and return (tools, cleanup).

    Sessions are **cached** between calls: if a server with the same name and
    config was already connected, its live ``ClientSession`` is reused — the
    browser (or other long-running MCP tool) stays open across turns so the
    model can interact with it incrementally (e.g. navigate → read → click).

    When the user changes a connector's config the old session is closed and a
    fresh one is created.  The ``cleanup`` coroutine returned here is a no-op
    for cached sessions; use ``shutdown_mcp_sessions()`` to close everything
    on app exit.
    """
    tools: list[StructuredTool] = []

    for name, cfg in (mcp_servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        h = _config_hash(cfg)
        cached = _session_cache.get(name)

        # --- cache hit: same config → reuse live session ---
        if cached and cached.config_hash == h:
            new_tools = [_make_tool(name, t, cached.session, emit) for t in cached.raw_tools]
            tools.extend(new_tools)
            print(
                f"[coder] MCP server {name!r}: reused session ({len(new_tools)} tool(s))",
                flush=True,
            )
            continue

        # --- cache miss (or config changed): connect fresh ---
        # The per-server lock serialises concurrent turns: the second caller
        # waits for the first connect to finish and then reuses its session
        # instead of double-spawning the server (and hitting its profile lock).
        async with _lock_for(name):
            # Re-check the cache under the lock — the first caller may have
            # connected while we were waiting.
            cached = _session_cache.get(name)
            if cached and cached.config_hash == h:
                new_tools = [_make_tool(name, t, cached.session, emit) for t in cached.raw_tools]
                tools.extend(new_tools)
                print(
                    f"[coder] MCP server {name!r}: reused session ({len(new_tools)} tool(s))",
                    flush=True,
                )
                continue

            # Close the old session if the config changed.
            if cached:
                print(f"[coder] MCP server {name!r}: config changed, reconnecting", flush=True)
                with suppress(Exception):
                    await cached.stack.aclose()
                # Kill this server's leftover processes (an outlived browser
                # keeps the profile locked) before spawning the replacement.
                _reap_processes(cached.cfg, protect_own=False)
                _session_cache.pop(name, None)

            # Kill orphans from a previous run that still hold this server's
            # locks (e.g. Chrome's profile SingletonLock) — but never our own
            # live descendants (a concurrent probe or another cached session).
            _reap_processes(cfg, protect_own=True)

            try:
                if cfg.get("url"):
                    stack, session, raw_tools = await _connect_http(name, cfg, emit)
                else:
                    stack, session, raw_tools = await _connect_stdio(name, cfg, emit)

                if raw_tools:
                    _session_cache[name] = _CachedSession(
                        stack=stack,
                        session=session,
                        raw_tools=raw_tools,
                        config_hash=h,
                        cfg=dict(cfg),
                    )
                    new_tools = [_make_tool(name, t, session, emit) for t in raw_tools]
                    tools.extend(new_tools)
                    print(
                        f"[coder] MCP server {name!r}: loaded {len(new_tools)} tool(s)",
                        flush=True,
                    )
                else:
                    with suppress(Exception):
                        await stack.aclose()
                    print(f"[coder] MCP server {name!r}: no tools", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[coder] MCP server {name!r} failed: {exc}", flush=True)
                emit(
                    {
                        "kind": "warn",
                        "content": (
                            f"MCP server {name!r} could not be reached: {exc}. "
                            "Its tools are unavailable this turn."
                        ),
                    }
                )

    async def _noop_cleanup() -> None:
        # Cached sessions persist across turns — nothing to close here.
        pass

    return tools, _noop_cleanup


async def shutdown_mcp_sessions() -> None:
    """Close all cached MCP sessions.  Called on app exit."""
    for name, cached in list(_session_cache.items()):
        with suppress(Exception):
            await cached.stack.aclose()
        # Kill this server's leftover processes (a browser that outlived its
        # server keeps the profile locked for the next app launch).
        _reap_processes(cached.cfg, protect_own=False)
        print(f"[coder] MCP server {name!r}: session closed", flush=True)
    _session_cache.clear()
