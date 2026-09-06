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
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass
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


# Module-level: server name → _CachedSession
_session_cache: dict[str, _CachedSession] = {}


def _config_hash(cfg: dict) -> str:
    """Deterministic fingerprint of an MCP server config."""
    blob = json.dumps(cfg, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


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
    read_stream, write_stream = await stack.enter_async_context(stdio_client(params))
    session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
    await session.initialize()
    mlist = await session.list_tools()
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
    read_stream, write_stream, _ = await stack.enter_async_context(ctx)
    session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
    await session.initialize()
    mlist = await session.list_tools()
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
        # Close the old session if the config changed.
        if cached:
            print(f"[coder] MCP server {name!r}: config changed, reconnecting", flush=True)
            with suppress(Exception):
                await cached.stack.aclose()
            _session_cache.pop(name, None)

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
                )
                new_tools = [_make_tool(name, t, session, emit) for t in raw_tools]
                tools.extend(new_tools)
                print(
                    f"[coder] MCP server {name!r}: loaded {len(new_tools)} tool(s)",
                    flush=True,
                )
            else:
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
        print(f"[coder] MCP server {name!r}: session closed", flush=True)
    _session_cache.clear()
