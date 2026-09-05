"""Live tests: error handling continues WITHOUT learned replay.

On error the agent continues on ANY transient provider failure (429 throttle,
5xx, timeout, network blip) via a unified bounded backoff
(``_RETRY_MAX_ATTEMPTS`` attempts, 30s apart), re-sending the REAL transcript
(tool results are already in ``messages``) -- no synthetic "you already did
X" injection and nothing is persisted to "teach" the model;
* surfaces a hard/fatal error (400 / quota exhausted / auth) as an ``error``
  event and stops gracefully, without writing a durable replay file.

Run: pytest backend/tests/test_retry_resume.py (or via run_tests.py).
"""
import json

import pytest
from mock_openai import mock, text_reply, tool_call

import agents


@pytest.fixture(autouse=True)
def _no_openai_client_retries(monkeypatch):
    """Disable the openai client's INTERNAL retry/backoff (default max_retries=2)
    so a transient 500/429 propagates to graph's own retry logic instead of
    being swallowed by the client. Also keeps the tests fast (no exponential
    backoff). The client is built inside langchain's ChatOpenAI, so we patch the
    class constructor it uses."""
    import openai

    orig = openai.AsyncOpenAI.__init__

    def _no_retry(self, *args, **kwargs):
        kwargs["max_retries"] = 0
        orig(self, *args, **kwargs)

    monkeypatch.setattr(openai.AsyncOpenAI, "__init__", _no_retry)


def _retry_events(events):
    return [e for e in events if e.get("kind") == "retry"]


def _write_calls(body):
    out = []
    for msg in body.get("messages", []):
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                if tc.get("function", {}).get("name") == "write_file":
                    out.append(tc)
    return out


def _resume_ids(body):
    out = []
    for msg in body.get("messages", []):
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                if str(tc.get("id", "")).startswith("resume-"):
                    out.append(tc)
        if msg.get("role") == "tool" and str(msg.get("tool_call_id", "")).startswith("resume-"):
            out.append(msg)
    return out


def _all_requests_have_no_resume():
    return all(not _resume_ids(b) for b in mock.captured)


def _write_result_present(body):
    return any(
        msg.get("role") == "tool" and "Successfully wrote" in str(msg.get("content", ""))
        for msg in body.get("messages", [])
    )


def _body_with_write():
    """The captured request whose transcript contains the write_file tool call."""
    for body in mock.captured:
        if _write_calls(body):
            return body
    return None


# ---------------------------------------------------------------------------
# 429 THROTTLE — continue via bounded retry, NO learned replay.
# ---------------------------------------------------------------------------


async def test_throttle_retry_continues_without_resume(run_events, monkeypatch):
    """A 429 (free-tier throttle) after a completed write: the turn retries, and
    the model continues from the REAL transcript (the write result is already in
    `messages`) -- nothing is injected or persisted to "teach" it."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("write_file", json.dumps({"path": "app.py", "content": "def foo():\n    return 42\n"})),
        text_reply("Done"),
    ]
    # The coder agent writes first (request 0); its trailing text reply is
    # request 1. Throttle that so the turn retries from the REAL transcript
    # (the write result is already in `messages`).
    mock.error_at = {1: (429, "Rate limit exceeded. Please try again later.")}

    events = await run_events("create app.py with a foo function", mode="coder")

    retries = _retry_events(events)
    assert retries, "expected an auto-retry event after the throttle"
    assert "rate limit" in retries[0].get("reason", "").lower(), retries[0]
    # Backend-driven retries are self-heals, not user restarts: they MUST carry
    # `reconnecting: True` so the frontend keeps the already-streamed text
    # instead of wiping it (which made the user see the reply vanish while
    # the agent was clearly still working).
    assert all(e.get("reconnecting") is True for e in retries), (
        f"every backend retry event must include reconnecting=True, got: {retries}"
    )

    last = _body_with_write()
    assert last is not None, "expected a captured request containing the write call"
    # Exactly one real write call, and its result is in the transcript so the
    # model continues correctly -- no second/duplicate execution.
    assert len(_write_calls(last)) == 1, f"expected 1 write call, got {len(_write_calls(last))}"
    assert _write_result_present(last), "write result must be in the transcript"
    # No synthetic resume- replay was injected anywhere.
    assert _all_requests_have_no_resume(), "no resume- replay ids allowed"


async def test_throttle_retry_twice_no_duplicate_work(run_events, monkeypatch):
    """Two consecutive throttles: still exactly one write call (no duplicated
    work), just more retries -- and still no resume- injection."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("write_file", json.dumps({"path": "app.py", "content": "def foo():\n    return 42\n"})),
        text_reply("Done"),
    ]
    # The coder agent writes first (request 0); two consecutive throttles on its
    # trailing text replies (request indices 1 and 2).
    mock.error_at = {1: (429, "Rate limit exceeded. Please try again later."),
                     2: (429, "Rate limit exceeded. Please try again later.")}

    events = await run_events("create app.py with a foo function", mode="coder")

    retries = _retry_events(events)
    assert len(retries) == 2, f"expected 2 auto-retries, got {len(retries)}"
    # Same reconnecting=True contract as the single-retry test: the frontend
    # relies on this flag to distinguish backend self-heal from user restart.
    assert all(e.get("reconnecting") is True for e in retries), (
        f"every backend retry event must include reconnecting=True, got: {retries}"
    )

    last = _body_with_write()
    assert last is not None, "expected a captured request containing the write call"
    assert len(_write_calls(last)) == 1, "write must not be re-executed"
    assert _write_result_present(last)
    assert _all_requests_have_no_resume()


# ---------------------------------------------------------------------------
# FATAL ERRORS — surface as an error event, do NOT learn / persist.
# ---------------------------------------------------------------------------


async def test_500_idle_shows_error(run_events, monkeypatch):
    """وقتی agent هیچ output تولید نکرده و خطای non-retryable (500) بخورد،
    نباید retry کند اما باید error event بفرستد تا کاربر دلیل خطا رو ببیند.
    فقط 429/502/503/504 retryable هستند — بقیه خطاها مستقیماً نمایش داده می‌شوند."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [text_reply("Done")]
    # همه فراخوانی‌ها 500 می‌دهند — 500 non-retryable است.
    mock.error_at = {i: (500, "Internal Server Error") for i in range(agents._RETRY_MAX_ATTEMPTS + 1)}

    events = await run_events("read app.py and summarize it", mode="plan")

    retries = _retry_events(events)
    assert retries == [], \
        "500 is non-retryable — must NOT retry"
    giveups = [e for e in events if e.get("kind") == "retry_giveup"]
    assert giveups == [], \
        "500 is non-retryable — must NOT retry_giveup"
    errors = [e for e in events if e.get("kind") == "error"]
    assert len(errors) == 1, \
        "500 must surface as an error event so the user sees the banner"
    assert _all_requests_have_no_resume()


async def test_500_active_output_then_retries(run_events, monkeypatch):
    """وقتی agent ابتدا output تولید کند (tool call) و بعد خطای transient
    بخورد، باید retry کند تا کار ناتمام ادامه یابد."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("write_file", json.dumps({"path": "a.py", "content": "x"})),
        text_reply("Done"),
    ]
    # درخواست اول (index 0) tool call موفق → agent فعال می‌شود.
    # درخواست دوم (index 1) 429 → retry (چون agent قبلاً output داشته).
    mock.error_at = {1: (429, "rate limited")}

    events = await run_events("create a.py", mode="coder")

    retries = _retry_events(events)
    assert retries, \
        "after producing tool output, a 429 must trigger retry"
    assert retries[0].get("attempt", 0) >= 1


async def test_400_retries_then_surfaces_error(run_events, monkeypatch, workspace):
    """A 400 from upstream (e.g. minimax-m3:free on OpenRouter) is treated as
    transient and retried up to the budget. If it persists, it surfaces as a
    `retry_giveup` event (no raise, no crash) and does NOT "teach" the model the
    interrupted work. The interrupted-turn resume checkpoint (LangGraph
    checkpointer) is left in place on a hard error so a same-prompt retry can
    resume, but nothing is injected back into the prompt."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        None,  # 400 on the main model's next request
    ]
    # Every request returns a 400. The model produces NO tool output first
    # (idle 400), so the retry path runs but nothing advances.
    mock.error_at = {i: (400, "Bad Request") for i in range(
        agents._RETRY_MAX_ATTEMPTS + 2
    )}

    events = await run_events(
        "read app.py and summarize it", mode="plan", chat_id="pytest-chat"
    )

    retries = _retry_events(events)
    giveups = [e for e in events if e.get("kind") == "retry_giveup"]

    # 400 is now retryable — expect retry events.
    assert retries, "400 should trigger auto-retry events"
    # After exhausting the budget, a give-up event surfaces.
    assert len(giveups) == 1, (
        f"expected exactly one retry_giveup event, got {len(giveups)}"
    )
    assert _all_requests_have_no_resume()


# ---------------------------------------------------------------------------
# RETRY GIVE-UP — the bounded retry loop must actually stop at the budget.
# ---------------------------------------------------------------------------


async def test_retry_gives_up_at_max_attempts(run_events, monkeypatch):
    """The retry counter used to be reset to 0 on every loop iteration
    (``attempt = 0`` lived inside ``while True:``), so the budget check
    ``attempt >= _RETRY_MAX_ATTEMPTS`` was always ``1 >= 10`` → never true →
    the loop never gave up. With every transient 429 a chat would spin
    forever in "retrying..." with no ``retry_giveup`` event for the user.

    After the fix the counter persists across iterations, so a sustained
    burst of retryable failures hits the budget and the turn terminates
    with a single ``retry_giveup`` event. The number of ``retry`` events
    is bounded by ``_RETRY_MAX_ATTEMPTS - 1`` (the last attempt is the one
    that gives up — no further ``retry`` event for it).
    """
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [text_reply("Done")]
    # Every request returns a 429. The model produces NO tool output first
    # (idle throttle), so the retry path runs but nothing advances.
    mock.error_at = {i: (429, "Rate limit exceeded.") for i in range(
        agents._RETRY_MAX_ATTEMPTS + 2
    )}

    events = await run_events("hi", mode="coder")

    retries = _retry_events(events)
    giveups = [e for e in events if e.get("kind") == "retry_giveup"]
    errors = [e for e in events if e.get("kind") == "error"]

    # The give-up must fire — that's the whole point of the fix.
    assert len(giveups) == 1, (
        f"expected exactly one retry_giveup event, got {len(giveups)} "
        f"(retries={len(retries)}, errors={len(errors)})"
    )
    # The give-up must report the budget, not 1.
    g = giveups[0]
    assert g.get("attempt", 0) >= agents._RETRY_MAX_ATTEMPTS, g
    assert g.get("max_attempts") == agents._RETRY_MAX_ATTEMPTS, g
    # Bounded retry count (last attempt is the give-up, no further retry event).
    assert len(retries) <= agents._RETRY_MAX_ATTEMPTS - 1, (
        f"too many retry events: {len(retries)}"
    )
    # The attempt counter must be monotonically increasing (proves the counter
    # is no longer reset to 0 inside the loop).
    attempts = [r.get("attempt", 0) for r in retries]
    assert attempts == sorted(attempts) and attempts, attempts
    assert attempts[0] >= 1, attempts
    # No bare error event — give-up is the user-facing signal.
    assert errors == [], f"retry_giveup should not be paired with an error event: {errors}"


def test_free_usage_limit_is_transient_not_quota():
    """A free-tier gateway's ``FreeUsageLimitError`` carrying a "Rate limit
    exceeded. Please try again later." message is a BRIEF 429 throttle, not a
    permanent quota cap. It must NOT be treated as quota-exhausted (which would
    skip the retry loop and surface as a fatal error immediately) — the unified
    30s backoff should ride it out."""
    exc = RuntimeError(
        'Error code: 429 - {"error": {"type": "FreeUsageLimitError", '
        '"message": "Rate limit exceeded. Please try again later."}}'
    )
    assert agents._is_quota_exhausted(exc) is False
    assert agents._is_retryable(exc) is True


def test_400_is_retryable():
    """HTTP 400 is retryable because some upstream gateways (e.g. minimax-m3:free
    on OpenRouter) return 400 for transient conditions that resolve on retry."""
    exc = RuntimeError('Error code: 400 - {"error": {"message": "Bad Request"}}')
    assert agents._is_retryable(exc) is True


def test_400_validation_is_not_retryable():
    """A 400 'Validation: missing results for tool_call_id' error is a permanent
    transcript bug, NOT a transient gateway issue. Retrying wastes the full
    retry budget (~5 min) for nothing — must fail fast."""
    exc = RuntimeError(
        'Error code: 400 - {\'error\': {\'message\': \'Validation: Tool messages '
        'starting at `messages[321]` are missing results for tool_call_id(s): '
        'call_8c49cffa436c046f\'}}'
    )
    assert agents._is_retryable(exc) is False

    # A "tool_call_id not found" variant
    exc2 = RuntimeError(
        "Error code: 400 - tool_call_id not found in transcript"
    )
    assert agents._is_retryable(exc2) is False


def test_hard_quota_exhausted_still_detected():
    """A genuine usage-quota cap (no transient phrase) is still detected as
    exhausted and skips the retry loop."""
    exc = RuntimeError(
        'Error code: 429 - {"error": {"type": "FreeUsageLimitError", '
        '"message": "You have reached your usage limit. Upgrade to continue."}}'
    )
    assert agents._is_quota_exhausted(exc) is True
    assert _all_requests_have_no_resume()


# ---------------------------------------------------------------------------
# CLIENT ABORT — a torn-down SSE socket must NOT surface as an error event.
# ---------------------------------------------------------------------------


async def test_client_abort_stops_cleanly_no_error_event(mock_server, workspace):
    """When the client closes the stream mid-turn (abort), the backend must NOT
    treat the resulting CancelledError as a transient failure and emit an `error`
    event that would never be read (the SSE socket is already torn down). It
    should just stop cleanly — unwinding via CancelledError, not a retry/error
    path that would leave the UI showing a frozen, unresponsive agent."""
    from agents import run_agent

    base, _mock = mock_server
    mock.script = [text_reply("Done")]
    agen = run_agent(
        provider="custom",
        model_name="mock-model",
        base_url=base,
        api_key="test",
        root=str(workspace),
        mode="coder",
        prompt="say hi",
        history=[],
        chat_id="pytest-abort",
    )
    # Pull one event, then abort the consumer (simulates the client closing SSE).
    first = await agen.__anext__()
    assert first.get("kind") != "error", "the first event must not be an error"
    # Closing the consumer cancels the generator. The backend must unwind cleanly
    # (no retry/error path for the dead socket) — so no `error` event is emitted
    # and the generator terminates without raising.
    await agen.aclose()
    # Drain any remaining buffered events; none of them may be an `error` event
    # for the torn-down socket.
    remaining = []
    try:
        while True:
            remaining.append(await agen.__anext__())
    except StopAsyncIteration:
        pass
    assert not any(e.get("kind") == "error" for e in remaining), \
        f"client abort must not emit an error event, got: {remaining}"
