"""Live tests: error handling continues WITHOUT learned replay.

The LangGraph migration removed the old pydantic-ai ``resume_tool`` replay and
the durable resume-file mechanism. On error the agent now:

* continues on a transient throttle (429) via a bounded backoff, re-sending the
  REAL transcript (tool results are already in ``messages``) -- no synthetic
  "you already did X" injection and nothing is persisted to "teach" the model;
* surfaces a fatal error (400/500) as an ``error`` event and stops gracefully,
  without writing a durable replay file.

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
    monkeypatch.setattr(agents, "_THROTTLE_BASE_SECONDS", 0)
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
    assert "rate limit" in retries[0].get("reason", ""), retries[0]

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
    monkeypatch.setattr(agents, "_THROTTLE_BASE_SECONDS", 0)
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


async def test_fatal_500_surfaces_as_error_no_resume(run_events):
    """A 500 (server error) in the main mode LLM call is fatal, so it surfaces
    as an `error` event and stops -- there is nothing to replay and nothing to
    learn. (Request index 0 is now the LLM search-planner; index 1 is the mode
    LLM call, so the fatal 500 is aimed there.)"""
    mock.script = [text_reply("Done")]
    mock.error_at = {1: (500, "server error")}

    events = await run_events("read app.py and summarize it", mode="plan")

    assert not _retry_events(events), "500 is fatal -- no auto-retry"
    assert any(e.get("kind") == "error" for e in events), \
        "500 must surface as an error event"
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
    assert _all_requests_have_no_resume()
