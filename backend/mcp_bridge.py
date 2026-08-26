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
* Each server's ``ClientSession`` is kept open for the whole turn and returned
  alongside the tools so the caller can close it in a ``finally`` block. This is
  required because ``StructuredTool.func`` is invoked lazily during the tool
  loop, long after ``build_mcp_tools`` has returned.
* Failures are isolated per-server: a broken connector never takes down the
  whole turn — it is skipped and a warning is emitted to the UI.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, suppress
from typing import Any

from langchain_core.tools import StructuredTool
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


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
        func=_func,
        name=qualified,
        description=_func.__doc__ or qualified,
        args_schema=_json_schema_from_input(getattr(tool, "inputSchema", None)),
    )


async def _connect_stdio(
    name: str,
    cfg: dict,
    emit: Callable[[dict], None],
) -> tuple[list[StructuredTool], Callable[[], Awaitable[None]]]:
    """Open a stdio MCP server and return (tools, cleanup).

    We use an ``AsyncExitStack`` so the ``stdio_client`` (and its underlying
    anyio task group) and the ``ClientSession`` are opened and closed in the
    SAME task. Opening them with a bare ``__aenter__`` and closing elsewhere
    raises ``RuntimeError: Attempted to exit cancel scope in a different task``
    because anyio binds the task group to the entering task — so the whole
    server would silently fail to load. The stack is unwound in ``_cleanup``.
    """
    command = cfg.get("command")
    if not command:
        return [], (lambda: _noop())

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
    tools = [_make_tool(name, t, session, emit) for t in (mlist.tools or [])]

    async def _cleanup() -> None:
        with suppress(Exception):
            await stack.aclose()

    return tools, _cleanup


async def _connect_http(
    name: str,
    cfg: dict,
    emit: Callable[[dict], None],
) -> tuple[list[StructuredTool], Callable[[], Awaitable[None]]]:
    """Open an HTTP/SSE MCP server and return (tools, cleanup)."""
    url = cfg.get("url")
    if not url:
        return [], (lambda: _noop())

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
        emit(
            {
                "kind": "warn",
                "content": f"MCP server {name!r}: no HTTP/SSE client available.",
            }
        )
        return [], (lambda: _noop())

    # Same AsyncExitStack pattern as stdio: open and close in the same task so
    # anyio's cancel scope is never crossed (avoids the "different task" error).
    stack = AsyncExitStack()
    read_stream, write_stream, _ = await stack.enter_async_context(ctx)
    session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
    await session.initialize()
    mlist = await session.list_tools()
    tools = [_make_tool(name, t, session, emit) for t in (mlist.tools or [])]

    async def _cleanup() -> None:
        with suppress(Exception):
            await stack.aclose()

    return tools, _cleanup


async def _noop() -> None:
    return None


async def build_mcp_tools(
    mcp_servers: dict | None,
    emit: Callable[[dict], None],
) -> tuple[list[StructuredTool], Callable[[], Awaitable[None]]]:
    """Connect to every configured MCP server and return (tools, cleanup).

    ``mcp_servers`` maps a connector name to its config dict (``command``/``args``
    for stdio, or ``url`` for HTTP/SSE). Returns the flattened list of
    ``StructuredTool`` instances plus a ``cleanup`` coroutine that closes every
    opened session — the caller MUST await it in a ``finally`` block when the
    turn ends.

    A failure on any single server is isolated: the server is skipped, a warning
    is emitted, and the remaining servers are still wired up.
    """
    tools: list[StructuredTool] = []
    cleanups: list[Callable[[], Awaitable[None]]] = []

    for name, cfg in (mcp_servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        try:
            if cfg.get("url"):
                srv_tools, cleanup = await _connect_http(name, cfg, emit)
            else:
                srv_tools, cleanup = await _connect_stdio(name, cfg, emit)
            if srv_tools:
                tools.extend(srv_tools)
                cleanups.append(cleanup)
                print(
                    f"[coder] MCP server {name!r}: loaded {len(srv_tools)} tool(s)",
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

    async def _cleanup_all() -> None:
        for c in cleanups:
            with suppress(Exception):
                await c()

    return tools, _cleanup_all
