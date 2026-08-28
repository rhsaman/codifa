"""Regression test: DeepSeek reasoning models must round-trip `reasoning_content`.

pydantic-ai's stock backfill (openai.py `_map_messages`) only adds the empty
`reasoning_content` field to assistant tool-call messages while SOME message in
the conversation carries a ThinkingPart (`thinking_active`). Gateways that strip
`reasoning_content` from the streamed response (TokenRouter) never produce a
ThinkingPart, so the stock backfill never fires and upstream DeepSeek rejects the
request with `messages[N].reasoning_content is required for thinking tool-call
history`.

`_ReasoningBackfillChatModel` (wired in `build_model` for DeepSeek reasoning
models) forces the backfill regardless of ThinkingPart presence. These tests pin
that behavior so a future pydantic-ai upgrade can't silently regress it.
"""
import asyncio
import os
import sys

os.environ.setdefault("CODER_DATA_DIR", "/tmp/codefa-test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from pydantic_ai.messages import (  # noqa: E402
    ModelRequest,
    ModelResponse,
    ThinkingPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters  # noqa: E402

from providers import (  # noqa: E402
    _ReasoningBackfillChatModel,
    _is_deepseek_reasoning_model,
    build_model,
)

BASE = "https://api.tokenrouter.com/v1"


def _tool_call_history() -> list:
    """A user turn + an assistant tool-call turn with NO ThinkingPart.

    This is exactly what a gateway that strips `reasoning_content` from the
    stream produces: the assistant turn has tool calls but no thinking text.
    """
    return [
        ModelRequest(parts=[UserPromptPart(content="what is the weather?")]),
        ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="get_weather",
                    args={"city": "tehran"},
                    tool_call_id="call_1",
                )
            ]
        ),
    ]


def _mixed_history() -> list:
    """Real runtime scenario: turn 1 captured a ThinkingPart, turn 2 is a bare
    tool-call turn. Because of turn 1's ThinkingPart, pydantic-ai's STOCK
    backfill fires and injects an EMPTY `reasoning_content: ''` on turn 2 —
    which gateways that strip empty values (TokenRouter) then drop, causing
    the 400. The wrapper must REPLACE that empty value, not just add a missing
    one.
    """
    return [
        ModelRequest(parts=[UserPromptPart(content="analyze this repo")]),
        ModelResponse(
            parts=[
                ThinkingPart(content="let me think about this..."),
                ToolCallPart(
                    tool_name="list_files",
                    args={"path": "."},
                    tool_call_id="call_1",
                ),
            ]
        ),
        ModelRequest(parts=[UserPromptPart(content="continue")]),
        ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="read_file",
                    args={"path": "README.md"},
                    tool_call_id="call_2",
                )
            ]
        ),
    ]


async def _mapped(model, messages: list) -> list[dict]:
    return await model._map_messages(messages, ModelRequestParameters())


def test_matcher() -> None:
    assert _is_deepseek_reasoning_model("deepseek-v4-pro")
    assert _is_deepseek_reasoning_model("deepseek-reasoner")
    assert _is_deepseek_reasoning_model("deepseek-r1")
    assert _is_deepseek_reasoning_model("deepseek-v3.1")
    assert not _is_deepseek_reasoning_model("deepseek-chat")
    assert not _is_deepseek_reasoning_model("deepseek-v3")
    assert not _is_deepseek_reasoning_model("gpt-4o")


def test_reasoning_model_uses_backfill_wrapper() -> None:
    model = build_model("tokenrouter", "deepseek-v4-pro", BASE, "test-key")
    assert isinstance(model, _ReasoningBackfillChatModel)


def test_non_reasoning_model_is_plain() -> None:
    model = build_model("tokenrouter", "deepseek-chat", BASE, "test-key")
    assert not isinstance(model, _ReasoningBackfillChatModel)


def test_backfill_injects_reasoning_content_without_thinking_part() -> None:
    model = build_model("tokenrouter", "deepseek-v4-pro", BASE, "test-key")
    mapped = asyncio.run(_mapped(model, _tool_call_history()))
    assistant = [m for m in mapped if m.get("role") == "assistant"]
    assert len(assistant) == 1
    # TokenRouter strips an EMPTY reasoning_content from the request before
    # forwarding to DeepSeek (verified live: `""` → 400, `" "` → 200), so the
    # backfill must use a non-empty placeholder for this gateway.
    assert assistant[0].get("reasoning_content") == " "


def test_backfill_placeholder_empty_for_direct_providers() -> None:
    # Direct DeepSeek accepts the empty string, so non-gateway providers keep
    # the stock `""` backfill (no fake reasoning text injected).
    model = build_model("custom", "deepseek-v4-pro", "https://api.deepseek.com/v1", "test-key")
    mapped = asyncio.run(_mapped(model, _tool_call_history()))
    assistant = [m for m in mapped if m.get("role") == "assistant"]
    assert len(assistant) == 1
    assert assistant[0].get("reasoning_content") == ""


def test_backfill_replaces_stock_empty_when_thinking_active() -> None:
    # THE runtime bug: once ANY message carries a ThinkingPart, pydantic-ai's
    # stock backfill injects `reasoning_content: ''` on bare tool-call turns.
    # TokenRouter strips the empty value → DeepSeek 400s. The wrapper must
    # REPLACE the empty value with the non-empty placeholder.
    model = build_model("tokenrouter", "deepseek-v4-pro", BASE, "test-key")
    mapped = asyncio.run(_mapped(model, _mixed_history()))
    assistant = [m for m in mapped if m.get("role") == "assistant"]
    assert len(assistant) == 2
    # Turn 1 keeps its real thinking text.
    assert assistant[0].get("reasoning_content") == "let me think about this..."
    # Turn 2 (bare tool-call) must NOT be left empty — the gateway would strip it.
    assert assistant[1].get("reasoning_content") == " "


def test_backfill_keeps_empty_for_direct_providers_when_thinking_active() -> None:
    # Direct DeepSeek accepts the empty string, so even with a ThinkingPart in
    # the history the backfill stays `""` (no fake reasoning text).
    model = build_model("custom", "deepseek-v4-pro", "https://api.deepseek.com/v1", "test-key")
    mapped = asyncio.run(_mapped(model, _mixed_history()))
    assistant = [m for m in mapped if m.get("role") == "assistant"]
    assert len(assistant) == 2
    assert assistant[0].get("reasoning_content") == "let me think about this..."
    assert assistant[1].get("reasoning_content") == ""


def test_plain_model_does_not_backfill() -> None:
    model = build_model("tokenrouter", "deepseek-chat", BASE, "test-key")
    mapped = asyncio.run(_mapped(model, _tool_call_history()))
    assistant = [m for m in mapped if m.get("role") == "assistant"]
    assert len(assistant) == 1
    assert "reasoning_content" not in assistant[0]


if __name__ == "__main__":
    for fn in (
        test_matcher,
        test_reasoning_model_uses_backfill_wrapper,
        test_non_reasoning_model_is_plain,
        test_backfill_injects_reasoning_content_without_thinking_part,
        test_backfill_placeholder_empty_for_direct_providers,
        test_backfill_replaces_stock_empty_when_thinking_active,
        test_backfill_keeps_empty_for_direct_providers_when_thinking_active,
        test_plain_model_does_not_backfill,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("ALL PASS")