import json

import pytest

from mock_openai import mock, text_reply, tool_call


def _has_image(body: dict) -> bool:
    for msg in body.get("messages", []):
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
    return False


def _all_text(body: dict) -> str:
    out = []
    for msg in body.get("messages", []):
        content = msg.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    out.append(part.get("text", ""))
    return "\n".join(out)


@pytest.mark.asyncio
async def test_image_attached_to_main_model_when_no_vision(run_events):
    mock.script = [text_reply("I see the screenshot clearly.")]
    await run_events(
        "what do you see in this image?",
        mode="ask",
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    assert any(_has_image(b) for b in mock.captured), \
        "image content part missing from main model request (no vision model)"


@pytest.mark.asyncio
async def test_vision_model_prefetch_analyzes_and_injects(run_events):
    # build_turn_context pre-analyzes the image with the vision model (request
    # 0) and injects the result into the main model (request 1).
    mock.script = [
        text_reply("PREFETCH_ANALYSIS of the screenshot"),
        text_reply("FINAL_ANSWER based on the analysis"),
    ]
    await run_events(
        "what do you see in this image?",
        mode="ask",
        subagent_models={"vision": "mock-model"},
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    # 1) the vision model received the raw image (pre-fetch call)
    assert _has_image(mock.captured[0]), "vision model pre-fetch did not receive the image"
    # 2) the main model did NOT get the raw image (it is stripped)
    assert not _has_image(mock.captured[1]), \
        "main model should not receive the raw image when a vision model is set"
    # 3) the pre-fetch analysis was injected into the main model's context
    assert "PREFETCH_ANALYSIS" in _all_text(mock.captured[1]), \
        "vision analysis was not injected into the main model context"


@pytest.mark.asyncio
async def test_vision_prefetch_failure_injects_note(run_events):
    # Vision model errors during pre-fetch -> a clear note is injected (no crash,
    # no fallback to the main model).
    # A non-retryable (400) failure — e.g. a vision model that rejects images.
    # (500s are retried by the OpenAI client, so use 400 to force a permanent
    # failure the pre-fetch cannot recover from.)
    mock.script = [text_reply("FINAL_ANSWER")]
    mock.error_at = {0: (400, "vision boom")}
    await run_events(
        "what do you see in this image?",
        mode="ask",
        subagent_models={"vision": "mock-model"},
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    assert any(
        "failed to analyze" in _all_text(b) for b in mock.captured
    ), "pre-fetch failure did not inject a diagnostic note into the context"


@pytest.mark.asyncio
async def test_ask_mode_has_no_explore_tools(run_events):
    """Ask mode must NOT expose read/grep/glob: repository exploration is the
    job of the deterministic discovery pipeline (which runs when the question is
    project-related and injects the gathered context), so the ask LLM never
    re-searches from zero."""
    mock.script = [text_reply("done")]
    await run_events("where is foo defined?", mode="ask")
    tools = set()
    for body in mock.captured:
        for t in body.get("tools", []) or []:
            fn = t.get("function", {})
            if fn.get("name"):
                tools.add(fn["name"])
    for denied in ("read", "grep", "glob"):
        assert denied not in tools, f"ask mode must not expose '{denied}': {tools}"
