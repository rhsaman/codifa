"""Live tests: error handling continues WITHOUT learned replay.

The LangGraph migration removed the old pydantic-ai ``resume_tool`` replay and
the durable resume-file mechanism. On error the agent now:

* continues on ANY transient provider failure (429 throttle, 5xx, timeout,
  network blip) via a unified bounded backoff (``_RETRY_MAX_ATTEMPTS`` attempts,
  30s apart), re-sending the REAL transcript (tool results are already in
  ``messages``) -- no synthetic "you already did X" injection and nothing is
  persisted to "teach" the model;
* surfaces a hard/fatal error (400 / quota exhausted / auth) as an ``error``
  event and stops gracefully, without writing a durable replay file.

Run: pytest backend/tests/test_retry_resume.py (or via run_tests.py).
"""
import json

import agents
import pytest

import state_db
from mock_openai import mock, text_reply, tool_call


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

    last = _body_with_write()
    assert last is not None, "expected a captured request containing the write call"
    assert len(_write_calls(last)) == 1, "write must not be re-executed"
    assert _write_result_present(last)
    assert _all_requests_have_no_resume()


# ---------------------------------------------------------------------------
# FATAL ERRORS — surface as an error event, do NOT learn / persist.
# ---------------------------------------------------------------------------


async def test_500_retries_then_giveup_after_budget(run_events, monkeypatch):
    """A 500 (server error) is now a transient failure, so it auto-retries up to
    the unified budget (``_RETRY_MAX_ATTEMPTS``) instead of surfacing as a fatal
    error immediately. After exhausting the budget it gives up (a ``retry_giveup``
    or ``error`` event) rather than hanging forever. Every request is forced to
    500 so the turn keeps hitting the transient failure until the budget runs
    out."""
    monkeypatch.setattr(agents, "_RETRY_BASE_SECONDS", 0)
    mock.script = [text_reply("Done")]
    # Force a 500 on EVERY request index (0..budget) so the turn never succeeds
    # before the retry budget is exhausted.
    mock.error_at = {i: (500, "server error") for i in range(agents._RETRY_MAX_ATTEMPTS + 1)}

    events = await run_events("read app.py and summarize it", mode="plan")

    retries = _retry_events(events)
    assert retries, "500 must now auto-retry (it is a transient failure)"
    assert len(retries) <= agents._RETRY_MAX_ATTEMPTS, \
        f"retries must stay within the budget, got {len(retries)}"
    # After exhausting the budget it must give up (retry_giveup or error), not hang.
    assert any(e.get("kind") in ("retry_giveup", "error") for e in events), \
        "500 must surface as retry_giveup/error after the budget is spent"
    assert _all_requests_have_no_resume()


async def test_fatal_400_surfaces_as_error_no_durable_resume(run_events, workspace):
    """A hard 400 after a completed read: surfaces as an `error` event (no
    raise, no crash) and writes NO durable resume file -- the model is not
    "taught" the interrupted work."""
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        None,  # hard 400 on the main model's next request
    ]
    events = await run_events(
        "read app.py and summarize it", mode="plan", chat_id="pytest-chat"
    )

    assert any(e.get("kind") == "error" for e in events), \
        "fatal 400 must surface as an error event (no raise)"
    # No durable resume file is persisted on error (we don't learn on error).
    resume = state_db.load_turn_resume(str(workspace), "pytest-chat")
    assert resume is None, "no durable resume file should be written on error"


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


async def test_client_abort_stops_cleanly_no_error_event(mock_server, workspace):  # noqa: F811
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
