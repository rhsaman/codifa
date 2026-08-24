import json

import pytest

import graph
from mock_openai import mock, text_reply, tool_call


@pytest.fixture(autouse=True)
def _clear_vision_cache():
    # The vision cache is module-level and keyed by image URI; clear it between
    # tests so a successful analysis from one test can't satisfy another.
    graph._VISION_CACHE.clear()
    yield
    graph._VISION_CACHE.clear()


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
async def test_vision_prefetch_falls_back_to_main_when_no_vision_model(run_events):
    # No dedicated vision subagent model -> prefetch must use the MAIN model
    # (mirroring the `vision` tool's own fallback) so the image is still
    # analyzed automatically. The raw image is stripped from the main request
    # (the analysis text is injected instead).
    mock.script = [
        text_reply("PREFETCH_ANALYSIS of the screenshot"),
        text_reply("FINAL_ANSWER based on the analysis"),
    ]
    await run_events(
        "what do you see in this image?",
        mode="ask",
        subagent_models={},  # no vision model configured
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    # 1) the main model received the raw image during pre-fetch
    assert _has_image(mock.captured[0]), "pre-fetch did not receive the image"
    # 2) the main model's final call does NOT get the raw image (it is stripped)
    assert not _has_image(mock.captured[1]), \
        "main model should not receive the raw image when no vision model is set"
    # 3) the pre-fetch analysis was injected into the main model's context
    assert "PREFETCH_ANALYSIS" in _all_text(mock.captured[1]), \
        "vision analysis was not injected into the main model context"


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
async def test_vision_analyzes_image_from_history(run_events):
    # Image attached in an EARLIER message (now living in `history`); the current
    # turn carries no new image. Vision must still analyze it so the model keeps
    # "seeing" the image on follow-up turns (history drops image content).
    mock.script = [
        text_reply("PREFETCH_ANALYSIS of the earlier screenshot"),
        text_reply("FINAL_ANSWER based on the analysis"),
    ]
    await run_events(
        "look at the image again",
        mode="ask",
        subagent_models={"vision": "mock-model"},
        history=[
            {
                "role": "user",
                "content": "here is a screenshot",
                "images": [{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
            }
        ],
        images=[],  # current turn has no new image
    )
    assert any(
        "PREFETCH_ANALYSIS" in _all_text(b) for b in mock.captured
    ), "vision did not analyze an image attached in an earlier message"


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
        "could not analyze" in _all_text(b) for b in mock.captured
    ), "pre-fetch failure did not inject a diagnostic note into the context"
    assert any(
        "Settings → Subagents → Vision" in _all_text(b) for b in mock.captured
    ), "pre-fetch failure note should tell the user to configure a Vision model"
