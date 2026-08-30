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
