"""تست‌های idle-retry: رفتار retry بک‌اند در حالت idle.

- 429/502/503/504 (شلوغی/rate limit): همیشه retry می‌کند (حتی idle).
- خطاهای دیگر (500/400/408/409) در idle: error event فوری (بدون retry).

Run: pytest backend/tests/test_idle_no_retry.py -xvs
"""

import agents


def _retry_events(events):
    return [e for e in events if e.get("kind") == "retry"]


def _error_events(events):
    return [e for e in events if e.get("kind") == "error"]


# ---------------------------------------------------------------------------
# 429 + idle → retry عادی (429 شلوغی‌ست، retry لازمه حتی idle)
# ---------------------------------------------------------------------------


async def test_idle_429_retries(run_events, monkeypatch):
    """وقتی اولین فراخوانی model خطای 429 بدهد و agent هیچ output نداشته
    باشد (idle)، باید retry عادی انجام شود. 429 = rate limit و باید
    با صبر حل بشه."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    from mock_openai import mock

    mock.script = [None]
    mock.error_at = {0: (429, "Rate limit exceeded.")}

    events = await run_events("hi", mode="coder")

    retries = _retry_events(events)
    assert retries, \
        "429 must always retry, even when idle (rate limit = retryable)"
    assert retries[0].get("attempt", 0) >= 1


# ---------------------------------------------------------------------------
# hard error (400) + idle → error event فوری (بدون retry)
# ---------------------------------------------------------------------------


async def test_idle_hard_error_shows_error(run_events, monkeypatch):
    """خطای 400 (non-retryable) حتی در حالت idle باید فوراً error event
    بفرسته — نه retry، نه silence."""
    from mock_openai import mock

    mock.script = [None]
    mock.error_at = {0: (400, "Bad request")}

    events = await run_events("hi", mode="coder")

    assert _retry_events(events) == [], \
        "400 must NOT retry even when idle"
    assert _error_events(events), \
        "400 must produce error event so user sees the reason"


# ---------------------------------------------------------------------------
# 429 بعد از tool output → retry عادی
# ---------------------------------------------------------------------------


async def test_output_then_429_retries(run_events, monkeypatch):
    """وقتی agent ابتدا tool call موفق دارد و بعد خطای 429 می‌خورد،
    باید retry کند."""
    import json

    from mock_openai import mock, text_reply, tool_call

    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("write_file", json.dumps({"path": "a.py", "content": "x"})),
        text_reply("Done"),
    ]
    mock.error_at = {1: (429, "Rate limit exceeded.")}

    events = await run_events("create a.py", mode="coder")

    retries = _retry_events(events)
    assert retries, \
        "after producing tool output, a 429 must trigger retry"
    assert retries[0].get("attempt", 0) >= 1


# ---------------------------------------------------------------------------
# OpenRouter wraps upstream-provider failures as 400 with the phrase
# "Backend request failed" in the body. The status code is 400 (normally
# non-retryable per the status-code check), but the body phrase is the
# gateway's signal that the upstream hiccuped — the 30s backoff should
# ride it out instead of failing the turn.
# ---------------------------------------------------------------------------


async def test_openrouter_upstream_400_wraps_as_retryable(run_events, monkeypatch):
    """OpenRouter 400 with 'Backend request failed' body must trigger a retry,
    NOT a hard error. This is the exact shape the user reported: a real
    400 status from openrouter with the upstream-provider error in metadata."""
    import json

    from mock_openai import mock, text_reply, tool_call

    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("read", json.dumps({"filePath": "x.ts", "offset": 1, "limit": 10})),
        text_reply("ok"),
    ]
    # The real exception text emitted by langchain-openai for the user's
    # reported 400 — exact substring of `Backend request failed` lives
    # inside the metadata.raw JSON. Mirrors the first SSE the user pasted
    # in the bug report (truncated for readability here).
    real_exception = (
        "Error code: 400 - {'error': {'message': 'Provider returned error', "
        "'code': 400, 'metadata': {'raw': '{\"error\":{\"message\":\"Backend "
        "request failed with status 400\",\"type\":\"backend_error\""
    )
    mock.error_at = {1: (400, real_exception)}

    events = await run_events("read x.ts", mode="coder")

    retries = _retry_events(events)
    assert retries, (
        "OpenRouter 'Backend request failed' wrapper must trigger a retry — "
        "the upstream is transient, the 400 status alone is misleading."
    )
    assert retries[0].get("attempt", 0) >= 1


def test_is_retryable_matches_backend_failed_phrase():
    """Unit test for the phrase check independent of the run pipeline:
    a 400 exception whose text contains the OpenRouter 'Backend request
    failed' wrapper must be classified as retryable."""
    exc = Exception(
        "Error code: 400 - {'error': {'message': 'Provider returned error', "
        "'code': 400, 'metadata': {'raw': '{\"error\":{\"message\":\"Backend "
        "request failed with status 400\",\"type\":\"backend_error\""
    )
    assert agents._is_retryable(exc), (
        "A 400 carrying the OpenRouter 'Backend request failed' wrapper must "
        "be classified as retryable so the 30s backoff rides it out."
    )
