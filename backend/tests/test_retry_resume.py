"""Live tests: retry paths resume with REAL tool results, not a re-run.

Covers the three retry types end-to-end against the real backend + mock:

1. Message retry (frontend) — test/retry.test.ts + test/retryStore.test.ts
   (restart-from-message truncates below the user message; banner resume keeps
   the partial reply + tool calls).
2. Automatic error retry — a transient provider error (429 throttle, 500 drop)
   AFTER a completed tool: the retried request carries the tool as a REAL
   `resume_tool` call/return pair (the fix in run_agent's except block), so the
   model continues from the actual result instead of re-executing the tool.
3. Manual error retry — a fatal 400 persists the durable resume file; the
   banner-Retry run for the same chat replays the tool from the file.

Run: pytest backend/tests/test_retry_resume.py (or via run_tests.py).
"""
import json

import pytest

import agents
import state_db
from mock_openai import mock, text_reply, tool_call


@pytest.fixture(autouse=True)
def _no_openai_client_retries(monkeypatch):
    """Disable the openai client's INTERNAL retry/backoff (default max_retries=2)
    so a transient 500/429 propagates to run_agent's own retry logic instead of
    being swallowed by the client. Also keeps the tests fast (no exponential
    backoff). The client is built inside pydantic-ai's OpenAIProvider, so we
    patch the class constructor it uses."""
    import openai

    orig = openai.AsyncOpenAI.__init__

    def _no_retry(self, *args, **kwargs):
        kwargs["max_retries"] = 0
        orig(self, *args, **kwargs)

    monkeypatch.setattr(openai.AsyncOpenAI, "__init__", _no_retry)


def _resume_calls(body):
    """Assistant tool_calls whose id starts with `resume-` (replayed work)."""
    out = []
    for msg in body.get("messages", []):
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                if str(tc.get("id", "")).startswith("resume-"):
                    out.append(tc)
    return out


def _resume_returns(body):
    """Tool returns whose tool_call_id starts with `resume-`."""
    out = []
    for msg in body.get("messages", []):
        if msg.get("role") == "tool" and str(
            msg.get("tool_call_id", "")
        ).startswith("resume-"):
            out.append(msg)
    return out


def _fresh_read_calls(body):
    """Tool calls that would RE-EXECUTE read (id NOT resume-)."""
    out = []
    for msg in body.get("messages", []):
        if msg.get("role") == "assistant":
            for tc in msg.get("tool_calls") or []:
                if tc.get("function", {}).get("name") == "read" and not str(
                    tc.get("id", "")
                ).startswith("resume-"):
                    out.append(tc)
    return out


def _retry_events(events):
    return [e for e in events if e.get("kind") == "retry"]


# ---------------------------------------------------------------------------
# 2) AUTOMATIC ERROR RETRY — the fix: completed tools are replayed as REAL
#    resume_tool call/return pairs so the retried request continues instead of
#    re-executing them.
# ---------------------------------------------------------------------------


async def test_auto_retry_500_resumes_with_real_tool_results(run_events):
    """A 500 (timeout-recovery branch) after a completed read: the retried
    request carries the read as a REAL resume_tool call + return pair, and the
    model does NOT re-execute it."""
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        text_reply("Done"),
    ]
    # Request 1 (the main model's request AFTER the read tool ran) gets a 500.
    mock.error_at = {1: (500, "server error")}

    events = await run_events("read app.py and summarize it", mode="plan")

    retries = _retry_events(events)
    assert retries, "expected an auto-retry event after the 500"
    assert "connection dropped" in retries[0].get("reason", ""), retries[0]

    # The retried request (the last one the mock saw) must replay the completed
    # read as a REAL tool call + return pair with the FULL result.
    last = mock.captured[-1]
    calls = _resume_calls(last)
    returns = _resume_returns(last)
    assert len(calls) == 1, f"expected 1 resume call, got {len(calls)}"
    assert calls[0]["function"]["name"] == "read", calls[0]
    assert len(returns) == 1, f"expected 1 resume return, got {len(returns)}"
    assert returns[0]["tool_call_id"] == calls[0]["id"], returns[0]
    assert "def foo" in returns[0]["content"], returns[0]["content"][:200]
    # And it must NOT re-execute read.
    assert _fresh_read_calls(last) == [], "model re-executed the completed read"


async def test_auto_retry_throttle_resumes_with_real_tool_results(
    run_events, monkeypatch
):
    """A 429 throttle (throttle branch) after a completed read: same guarantee —
    the retried request carries the real resume_tool pair, no re-execution."""
    monkeypatch.setattr(agents, "_THROTTLE_BASE_SECONDS", 0)
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        text_reply("Done"),
    ]
    # Request 1 (after the read tool ran) gets a 429 throttle.
    mock.error_at = {1: (429, "Rate limit exceeded. Please try again later.")}

    events = await run_events("read app.py and summarize it", mode="plan")

    retries = _retry_events(events)
    assert retries, "expected an auto-retry event after the throttle"
    assert "rate limit" in retries[0].get("reason", ""), retries[0]

    last = mock.captured[-1]
    calls = _resume_calls(last)
    returns = _resume_returns(last)
    assert len(calls) == 1 and calls[0]["function"]["name"] == "read", calls
    assert len(returns) == 1 and "def foo" in returns[0]["content"], returns
    assert _fresh_read_calls(last) == [], "model re-executed the completed read"


async def test_auto_retry_before_any_tool_has_no_injection(run_events):
    """A transient error BEFORE any tool ran: the original auto-retry path runs
    unchanged — there is nothing to replay, so no resume_tool records."""
    mock.script = [text_reply("Done")]
    # Request 0 (the very first request, before any tool) gets a 500.
    mock.error_at = {0: (500, "server error")}

    events = await run_events("read app.py and summarize it", mode="plan")

    assert _retry_events(events), "expected an auto-retry event"
    last = mock.captured[-1]
    assert _resume_calls(last) == [], "no tool ran — nothing to replay"
    assert _resume_returns(last) == []


async def test_auto_retry_injects_resume_tools_only_once(run_events):
    """Two consecutive transient errors after a tool: the resume_tool records
    are injected ONCE (the `_resume_injected` flag), so the final request
    carries exactly one set — no duplication."""
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        text_reply("Done"),
    ]
    # Requests 1 and 2 (both after the read tool ran) get a 500 each.
    mock.error_at = {1: (500, "server error"), 2: (500, "server error")}

    events = await run_events("read app.py and summarize it", mode="plan")

    retries = _retry_events(events)
    assert len(retries) == 2, f"expected 2 auto-retries, got {len(retries)}"

    last = mock.captured[-1]
    calls = _resume_calls(last)
    assert len(calls) == 1, f"resume_tool injected more than once: {len(calls)}"
    assert _fresh_read_calls(last) == []


# ---------------------------------------------------------------------------
# 3) MANUAL ERROR RETRY — the banner Retry path: a fatal error persists the
#    durable resume file, and the next run for the same chat replays the
#    completed tools from it.
# ---------------------------------------------------------------------------


async def test_manual_retry_resumes_from_durable_file(run_events, workspace):
    """A fatal 400 after a completed read persists the resume file; the banner
    Retry run for the same chat replays the read as a REAL resume_tool pair and
    does NOT re-execute it."""
    mock.script = [
        tool_call("read", json.dumps({"filePath": "app.py"})),
        None,  # hard 400 on the main model's next request
    ]
    with pytest.raises(Exception):
        await run_events("read app.py and summarize it", mode="plan")

    # The durable resume file must hold the completed read.
    resume = state_db.load_turn_resume(str(workspace), "pytest-chat")
    assert resume and resume.get("tools"), "resume file missing after fatal error"
    tools = [t for t in resume["tools"] if isinstance(t, dict)]
    assert tools and tools[0]["tool"] == "read", tools

    # Banner Retry: same chat, history carries the interrupted marker.
    mock.script = [text_reply("Done")]
    mock.captured = []
    history = [
        {"role": "user", "content": "read app.py and summarize it"},
        {
            "role": "assistant",
            "content": (
                "[Interrupted before finishing. Already done this turn — do NOT "
                "repeat these:\n- read: ...]"
            ),
        },
    ]
    await run_events("read app.py and summarize it", mode="plan", history=history)

    last = mock.captured[-1]
    calls = _resume_calls(last)
    returns = _resume_returns(last)
    assert len(calls) == 1 and calls[0]["function"]["name"] == "read", calls
    assert len(returns) == 1 and "def foo" in returns[0]["content"], returns
    assert _fresh_read_calls(last) == [], "model re-executed the completed read"
    # A clean finish clears the durable file.
    assert state_db.load_turn_resume(str(workspace), "pytest-chat") is None