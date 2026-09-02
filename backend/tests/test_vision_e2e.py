
import pytest
from mock_openai import mock, text_reply

import graph


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
    # A non-retryable (401) failure — e.g. an authentication error with the
    # vision provider. (400/429/5xx are all retried now, so use 401 to force a
    # permanent failure the pre-fetch cannot recover from.)
    mock.script = [text_reply("FINAL_ANSWER")]
    mock.error_at = {0: (401, "vision boom")}
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


@pytest.mark.asyncio
async def test_vision_retries_transient_429_then_succeeds(run_events):
    # A transient 429 on the FIRST vision request must be retried (not silently
    # dropped). The retry recovers and the analysis is injected normally.
    mock.script = [
        text_reply("PREFETCH_ANALYSIS after a transient 429"),
        text_reply("FINAL_ANSWER based on the analysis"),
    ]
    # 429 on request index 0 (the vision pre-fetch); the retry hits index 1.
    mock.error_at = {0: (429, "rate limited")}
    await run_events(
        "what do you see in this image?",
        mode="ask",
        subagent_models={"vision": "mock-model"},
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    # The analysis recovered from the 429 and was injected into the main model.
    assert any(
        "PREFETCH_ANALYSIS" in _all_text(b) for b in mock.captured
    ), "vision did not recover from a transient 429 and inject the analysis"
    # Exactly two vision requests were made (one 429 + one successful retry),
    # proving the transient failure was retried rather than silently dropped.
    vision_requests = [b for b in mock.captured if _has_image(b)]
    assert len(vision_requests) == 2, \
        "a transient 429 should be retried (expected 2 vision requests)"


@pytest.mark.asyncio
async def test_vision_non_transient_error_not_retried(run_events):
    # A permanent non-retryable error (e.g. 401 auth failure) must NOT be retried
    # — it should surface immediately as a diagnostic note (no wasted retries).
    mock.script = [text_reply("FINAL_ANSWER")]
    mock.error_at = {0: (401, "vision boom")}
    await run_events(
        "what do you see in this image?",
        mode="ask",
        subagent_models={"vision": "mock-model"},
        images=[{"path": "x.png", "dataUrl": "data:image/png;base64,AAAA"}],
    )
    # The 401 is permanent -> no retry -> the diagnostic note is injected.
    assert any(
        "could not analyze" in _all_text(b) for b in mock.captured
    ), "permanent 400 failure did not inject a diagnostic note"
    # Exactly one vision request was attempted (no retry on a 400).
    vision_requests = [
        b for b in mock.captured
        if _has_image(b)
    ]
    assert len(vision_requests) == 1, \
        "a permanent 400 should not be retried (expected 1 vision request)"


@pytest.mark.asyncio
async def test_vision_downscales_large_image():
    # A large image (3000x3000) must be downscaled to <= 1536 on its longest
    # side so vision providers don't choke on it (the source of slow vision).
    from io import BytesIO

    from PIL import Image

    import agents as _agents

    big = BytesIO()
    Image.new("RGB", (3000, 3000), (255, 0, 0)).save(big, format="PNG")
    data_url = "data:image/png;base64," + __import__("base64").b64encode(big.getvalue()).decode()

    out = _agents._maybe_downscale_image(data_url)
    _, b64 = out.split(",", 1)
    raw = __import__("base64").b64decode(b64)
    with Image.open(BytesIO(raw)) as img:
        assert max(img.size) <= 1536, \
            "large image was not downscaled to the 1536px vision limit"


@pytest.mark.asyncio
async def test_vision_model_timeout_is_bounded():
    # The vision model must be built with a bounded timeout (30s) so a slow
    # provider fails fast instead of hanging the turn for minutes.
    model = graph.resolve_subagent_model(
        "custom", "mock-model", "http://localhost:1", "test", "", None, "",
        default_to_parent=False, timeout=30,
    )
    # LangChain stores the scalar timeout as `request_timeout` on the model.
    actual = getattr(model, "request_timeout", None) or getattr(model, "timeout", None)
    assert actual == 30, \
        "vision model should be built with a bounded timeout of 30s"


@pytest.mark.asyncio
async def test_vision_respects_total_budget(monkeypatch):
    # The whole vision analysis must respect the total wall-clock budget and
    # stop retrying once it is exhausted (no multi-minute turn lock).
    import asyncio

    monkeypatch.setattr(graph, "_VISION_TOTAL_BUDGET", 2.0)

    # Each attempt takes ~1s and fails transiently (500); with a 2s budget the
    # loop must stop after at most 2 attempts, not run all 3.
    calls = {"n": 0}

    async def _slow_fail(*args, **kwargs):
        calls["n"] += 1
        await asyncio.sleep(1.0)
        raise RuntimeError("500: transient server error")

    monkeypatch.setattr(graph, "llm_generate", _slow_fail)

    class _FakeModel:
        model_name = "mock-vision"

    start = asyncio.get_event_loop().time()
    result = await graph._vision_analyze(_FakeModel(), ["data:image/png;base64,AAAA"])
    elapsed = asyncio.get_event_loop().time() - start

    assert result is None, "vision should give up (None) when the budget is exhausted"
    assert calls["n"] <= 2, \
        "vision should stop retrying once the total budget is exhausted"
    assert elapsed < 5.0, \
        f"vision analysis blew past the 2s budget (took {elapsed:.1f}s)"
