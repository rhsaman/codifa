"""Shared local mock OpenAI-compatible server for backend live tests.

Drives the REAL backend (agents.run_agent / tools) against a controllable
in-process server so tests are deterministic and cost nothing. The mock honors
the two request shapes pydantic-ai uses: streaming SSE (``stream: true``) and
plain JSON (the explore sub-agent's non-streaming run), and can be switched into
a mode that rejects ``parallel_tool_calls`` (to exercise the provider allowlist).
"""
import asyncio
import json
import os
import sys

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

MODEL = "mock-model"


class MockState:
    def __init__(self) -> None:
        # Queue of response spec lists; each request pops one. See text_reply /
        # tool_call below.
        self.script: list[list[dict] | None] = []
        # Every request body received, in order, for assertions.
        self.captured: list[dict] = []
        # When True, a request carrying `parallel_tool_calls` gets a hard 400 —
        # simulates a gateway that rejects the field.
        self.reject_parallel = False
        # Queue of (status_code, message) error responses keyed by REQUEST INDEX
        # (0-based, in arrival order). A request whose index is present gets that
        # error instead of popping from `script`, so a transient provider error
        # (429 throttle, 500) can be injected at a precise point mid-turn (e.g.
        # the request right AFTER a tool call).
        self.error_at: dict[int, tuple[int, str]] = {}
        # HTTP status returned for every request, in order, for assertions.
        self.statuses: list[int] = []


mock = MockState()


def sse(*chunks):
    def gen():
        for c in chunks:
            yield f"data: {json.dumps(c)}\n\n"
        yield "data: [DONE]\n\n"
    return gen


def text_reply(text, finish="stop"):
    return [
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": MODEL, "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]},
        {"id": "c-2", "object": "chat.completion.chunk", "created": 0,
         "model": MODEL,
         "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}},
    ]


def tool_call(tool, args_json, call_id="call_x", finish="tool_calls"):
    return [
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": MODEL,
         "choices": [{"index": 0, "delta": {"tool_calls": [
             {"index": 0, "id": call_id, "type": "function",
              "function": {"name": tool, "arguments": args_json}}
         ]}, "finish_reason": None}]},
        {"id": "c-2", "object": "chat.completion.chunk", "created": 0,
         "model": MODEL,
         "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}},
    ]


def length_reply(finish="length"):
    """Emulate a small local model whose context window was exceeded: an empty
    response with ``finish_reason: 'length'``. pydantic-ai raises
    ``UnexpectedModelBehavior`` on this — exactly the crash the sub-agents now
    degrade from instead of killing the turn."""
    return [
        {"id": "c-1", "object": "chat.completion.chunk", "created": 0,
         "model": MODEL,
         "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
    ]


async def models_handler(request: Request):
    return JSONResponse({"object": "list", "data": [
        {"id": MODEL, "context_length": 32000},
    ]})


def _to_completion(chunks, finish="stop"):
    """Reassemble a completion object from chunk spec(s) (non-streaming path)."""
    text = "".join(
        c["choices"][0]["delta"].get("content") or ""
        for c in chunks
        if c and c.get("choices", [{}])[0].get("delta", {}).get("content")
    )
    return {
        "id": "c-1", "object": "chat.completion", "created": 0, "model": MODEL,
        "choices": [{"index": 0, "message": {"role": "assistant",
                                             "content": text or None}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110},
    }


async def chat_handler(request: Request):
    body = await request.json()
    mock.captured.append(body)
    # Snapshot the per-test script/error state AT REQUEST START. The mock server
    # runs on its own thread/loop, so a request that began while an OLD test's
    # script was active must keep consuming THAT script -- not the NEW test's
    # script, which the next test may have assigned by the time we pop. Without
    # this snapshot, a previous test's in-flight (still-streaming) response would
    # steal the next test's script[0], causing flaky cross-test pollution.
    script_snapshot = mock.script
    error_at_snapshot = dict(mock.error_at)
    if mock.reject_parallel and body.get("parallel_tool_calls"):
        mock.statuses.append(400)
        return JSONResponse(
            {"error": {"message": "parallel_tool_calls unsupported", "type": "unsupported"}},
            media_type="application/json",
            status_code=400,
            headers={"Connection": "close"},
        )
    if error_at_snapshot:
        idx = len(mock.captured) - 1
        if idx in error_at_snapshot:
            status, message = error_at_snapshot[idx]
            mock.statuses.append(status)
            return JSONResponse(
                {"error": {"message": message, "type": "server_error"}},
                media_type="application/json",
                status_code=status,
                headers={"Connection": "close"},
            )
    spec = script_snapshot.pop(0) if script_snapshot else text_reply("default")
    if spec is None:
        mock.statuses.append(400)
        return JSONResponse(
            {"error": {"message": "bad request", "type": "invalid_request"}},
            media_type="application/json",
            status_code=400,
            headers={"Connection": "close"},
        )
    mock.statuses.append(200)
    # Derive usage from the REAL request/response sizes so token counts are
    # internally logical (input tokens scale with the context actually sent),
    # instead of the hard-coded 100/10 placeholders.
    prompt_tokens = max(1, len(json.dumps(body, ensure_ascii=False)) // 4)
    resp_text = ""
    if body.get("stream"):
        for c in spec:
            resp_text += (c.get("choices", [{}])[0].get("delta", {}).get("content") or "")
    else:
        if spec and any(c.get("choices", [{}])[0].get("finish_reason") for c in spec):
            finish = next((c["choices"][0]["finish_reason"] for c in spec
                           if c.get("choices", [{}])[0].get("finish_reason")), "stop")
        else:
            finish = "stop"
        resp_text = _to_completion(spec, finish=finish)["choices"][0]["message"].get("content") or ""
    completion_tokens = max(0, len(resp_text) // 4)
    usage = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }
    if body.get("stream"):
        if spec:
            spec[-1]["usage"] = usage
        return StreamingResponse(sse(*spec)(), media_type="text/event-stream")
    finish = "stop"
    if spec and any(c.get("choices", [{}])[0].get("finish_reason") for c in spec):
        finish = next((c["choices"][0]["finish_reason"] for c in spec
                       if c.get("choices", [{}])[0].get("finish_reason")), "stop")
    comp = _to_completion(spec, finish=finish)
    comp["usage"] = usage
    return JSONResponse(comp)


app = Starlette(routes=[
    Route("/v1/models", models_handler, methods=["GET"]),
    Route("/v1/chat/completions", chat_handler, methods=["POST"]),
])

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS_DIR, os.path.dirname(_THIS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


_server_ref: "uvicorn.Server | None" = None


async def start_server():
    """Start the mock on an ephemeral port; returns (server_task, base_url)."""
    global _server_ref
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
    _server_ref = server
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    return task, f"http://127.0.0.1:{port}/v1"


async def stop_server(task) -> None:
    if _server_ref is not None:
        _server_ref.should_exit = True
    else:
        task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001, S110
        pass