"""Local model servers must report their REAL context window, never the floor."""

from __future__ import annotations

import asyncio

import httpx
import providers
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.messages import (
    InstructionPart,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.providers.openai import OpenAIProvider


def _run_with_mock(handler, coro_fn):
    """Patch httpx.AsyncClient with a mock transport for one coroutine only."""
    orig = httpx.AsyncClient

    def patched(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return orig(*a, **k)

    providers.httpx.AsyncClient = patched
    try:
        return asyncio.run(coro_fn())
    finally:
        httpx.AsyncClient = orig
        providers.httpx.AsyncClient = orig


def test_llamacpp_context_from_props():
    def handler(request):
        if request.url.port == 8080 and request.url.path == "/props":
            return httpx.Response(200, json={"default_generation_settings": {"n_ctx": 8192}})
        return httpx.Response(404)

    async def go():
        return await providers._local_model_ctx("http://localhost:8080/v1", "llama")

    assert _run_with_mock(handler, go) == 8192


def test_lmstudio_context_from_native_api():
    def handler(request):
        if request.url.port == 1234 and request.url.path == "/props":
            return httpx.Response(404)
        if request.url.port == 1234 and request.url.path == "/api/v1/model":
            return httpx.Response(200, json={"data": {"context_length": 4096, "model_key": "qwen"}})
        if request.url.port == 1234 and request.url.path == "/api/v1/models":
            return httpx.Response(200, json={"data": [{"id": "qwen", "model_info": {"context_length": 4096}}]})
        return httpx.Response(404)

    async def go():
        return await providers._local_model_ctx("http://localhost:1234/v1", "qwen")

    assert _run_with_mock(handler, go) == 4096


def test_ollama_provider_custom_base_lists_local_context():
    # The UI "ollama" provider is the generic local endpoint; a custom base URL
    # (LM Studio at 1234) must list via /v1/models and detect context, not /api/tags.
    def handler(request):
        if request.url.port == 1234 and request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "Qwen3.5-4B", "object": "model"}]})
        if request.url.port == 1234 and request.url.path == "/props":
            return httpx.Response(404)
        if request.url.port == 1234 and request.url.path == "/api/v1/model":
            return httpx.Response(200, json={"data": {"context_length": 4096}})
        return httpx.Response(404)

    async def go():
        models = await providers.list_models("ollama", "http://localhost:1234/v1")
        return models[0]["context"]

    assert _run_with_mock(handler, go) == 4096


def test_model_context_resolves_local_not_floor():
    def handler(request):
        if request.url.port == 1234 and request.url.path == "/props":
            return httpx.Response(404)
        if request.url.port == 1234 and request.url.path == "/api/v1/model":
            return httpx.Response(200, json={"data": {"context_length": 4096}})
        if request.url.port == 1234 and request.url.path == "/api/v1/models":
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404)

    async def go():
        return await providers.model_context("ollama", "qwen", "http://localhost:1234/v1")

    # 4096, NOT the 32000 DEFAULT_CONTEXT_WINDOW_FLOOR
    assert _run_with_mock(handler, go) == 4096


def _mrp():
    return ModelRequestParameters(
        function_tools=[],
        native_tools=[],
        instruction_parts=[InstructionPart(content="MAIN SYSTEM PROMPT")],
        output_mode="text",
        revealed_tool_names=set(),
        deferred_capability_ids=set(),
        allow_text_output=True,
        allow_image_output=False,
    )


def test_local_model_collapses_mid_conversation_system():
    """A system message injected mid-conversation (interrupted-turn resume)
    must be relocated to the front and collapsed into one system block, so
    strict local chat templates (Qwen2.5/DeepSeek/Llama-3.x) don't 400 with
    'System message must be at the beginning'."""

    async def go():
        provider = OpenAIProvider(base_url="http://x", api_key="x")
        model = providers._LocalChatModel("m", provider=provider)
        messages = [
            ModelRequest(parts=[UserPromptPart(content="hi")]),
            ModelResponse(parts=[ToolCallPart(tool_name="t", args={}, tool_call_id="c1")]),
            ModelRequest(parts=[ToolReturnPart(tool_name="t", content="r", tool_call_id="c1")]),
            # system note appended AFTER tool results (the resume injection)
            ModelRequest(parts=[SystemPromptPart(content="RESUME NOTE")]),
            ModelRequest(parts=[UserPromptPart(content="continue")]),
        ]
        mapped = await model._map_messages(messages, _mrp())
        roles = [m["role"] for m in mapped]
        # exactly one system, and it is the first message
        assert roles[0] == "system"
        assert roles.count("system") == 1
        assert roles == ["system", "user", "assistant", "tool", "user"]

    asyncio.run(go())


def test_local_model_collapses_multiple_leading_systems():
    """A prepended note (e.g. tool-reuse) PLUS the main instructions yields two
    leading `system` messages. Qwen3.5's template rejects ANY non-first system
    message, so they must collapse into ONE system block at index 0."""

    async def go():
        provider = OpenAIProvider(base_url="http://x", api_key="x")
        model = providers._LocalChatModel("m", provider=provider)
        messages = [
            # tool-reuse note prepended ahead of the instructions insertion point
            ModelRequest(parts=[SystemPromptPart(content="TOOL REUSE NOTE")]),
            ModelRequest(parts=[UserPromptPart(content="hi")]),
            ModelResponse(parts=[ToolCallPart(tool_name="t", args={}, tool_call_id="c1")]),
            ModelRequest(parts=[ToolReturnPart(tool_name="t", content="r", tool_call_id="c1")]),
        ]
        mapped = await model._map_messages(messages, _mrp())
        roles = [m["role"] for m in mapped]
        assert roles[0] == "system"
        assert roles.count("system") == 1
        assert roles == ["system", "user", "assistant", "tool"]

    asyncio.run(go())
