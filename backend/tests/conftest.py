"""Shared pytest fixtures for the opencode-style backend test suite.

The legacy backend tests are sequential ``main()`` modules run by
``run_tests.py``; pytest could only collect one of them because the tests
directory was never on ``sys.path`` (so ``import mock_openai`` failed). This
conftest fixes that and provides the fixtures the new behavior/pure-logic
tests share:

* ``mock_server`` — a session-scoped in-process mock OpenAI server. Mock ONLY
  the LLM layer; the agent, its tools, the sub-agent runner and the event
  stream are all real.
* ``workspace`` — a fresh temp workspace per test.
* ``run_events`` — runs the real ``run_agent`` against the mock and returns
  the collected events.

``CODER_DATA_DIR`` is pointed at a temp dir before anything imports ``agents``
so no test ever touches the user's real data.
"""
import asyncio
import os
import sys
import tempfile
import threading
import uuid

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Hermetic data root BEFORE importing anything that binds state_db.
os.environ.setdefault("CODER_DATA_DIR", tempfile.mkdtemp(prefix="coder-pytest-data-"))

from mock_openai import mock, start_server, stop_server

from agents import run_agent


@pytest.fixture(scope="session")
def mock_server():
    """Start the in-process mock OpenAI server once; yield (base_url, mock).

    The server runs in a dedicated thread with its own event loop so it stays
    alive for the whole session regardless of pytest-asyncio's per-test loops.
    """
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    task, base = asyncio.run_coroutine_threadsafe(start_server(), loop).result(timeout=30)
    try:
        yield base, mock
    finally:
        asyncio.run_coroutine_threadsafe(stop_server(task), loop).result(timeout=30)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def _reset_mock(request):
    """Every test starts with a clean mock script and capture log."""
    mock.script = []
    mock.captured = []
    mock.reject_parallel = False
    mock.error_at = {}
    mock.statuses = []
    yield


@pytest.fixture(autouse=True)
def _reset_tool_contextvars():
    """Reset tool ContextVars leaked by sync unit tests.

    ``graph.filter_tools_for_mode`` records the mode-filtered toolset in
    ``tools._PARENT_TOOLS_CTX`` as a side effect. Sync tests that call it
    directly (e.g. test_perf_fixes) run in the shared thread context, so the
    fake ``{"computer": ..., "read": ...}`` dict would otherwise leak into
    later tests — a general sub-agent would then inherit lambdas instead of
    real tools and emit no ``sub=True`` read events (test_task_general_agent).
    Production sets this fresh every turn, so resetting per test is safe.
    """
    try:
        from tools import _PARENT_TOOLS_CTX, _SUB_AGENT_BRANCH_CTX, _TASK_DEPTH_CTX
    except ImportError:
        yield
        return
    _parent_token = _PARENT_TOOLS_CTX.set(None)
    _branch_token = _SUB_AGENT_BRANCH_CTX.set(0)
    _depth_token = _TASK_DEPTH_CTX.set(0)
    try:
        from tool_batching import reset_read_ledger
    except ImportError:
        reset_read_ledger = None  # type: ignore[assignment]
    if reset_read_ledger is not None:
        # Fresh per-turn read ledger: without this, ledger entries written
        # by one test's tracker would leak into the next test's read footers.
        reset_read_ledger()
    try:
        from tool_batching import reset_turn_grep_cover
    except ImportError:
        reset_turn_grep_cover = None  # type: ignore[assignment]
    if reset_turn_grep_cover is not None:
        # Fresh per-test grep coverage: a complete grep in one test must not
        # stub a subset grep in the next test.
        reset_turn_grep_cover()
    try:
        from tool_batching import reset_cross_turn
    except ImportError:
        reset_cross_turn = None  # type: ignore[assignment]
    if reset_cross_turn is not None:
        # Cross-turn stores survive turns by design — but never across tests.
        reset_cross_turn()
    try:
        from tool_batching import _TURN_CALLS
    except ImportError:
        _TURN_CALLS = None  # type: ignore[assignment]
    if _TURN_CALLS is not None:
        # Deactivate the per-turn duplicate-call registry: it is keyed
        # WITHOUT the workspace root, so an active set leaks false
        # "duplicate" stubs across tests with same relative paths. Tests
        # that need it opt in explicitly via reset_turn_seen_calls().
        try:
            _TURN_CALLS.set(None)
        except Exception:  # noqa: BLE001, S110 — isolation never breaks setup
            pass
    try:
        yield
    finally:
        try:
            _PARENT_TOOLS_CTX.reset(_parent_token)
        except Exception:  # noqa: BLE001, S110
            pass
        try:
            _SUB_AGENT_BRANCH_CTX.reset(_branch_token)
        except Exception:  # noqa: BLE001, S110
            pass
        try:
            _TASK_DEPTH_CTX.reset(_depth_token)
        except Exception:  # noqa: BLE001, S110
            pass


@pytest.fixture(autouse=True)
def _no_retry(monkeypatch):
    """Disable the OpenAI client's automatic retries so fatal HTTP errors
    (e.g. 500) surface immediately instead of being silently retried and
    masked. Application-level retries (429 throttle handling in the graph) are
    unaffected."""
    try:
        from openai import AsyncOpenAI, OpenAI
    except ImportError:
        return

    def _patch(cls):
        orig = cls.__init__

        def __init__(self, *args, **kwargs):
            kwargs["max_retries"] = 0
            return orig(self, *args, **kwargs)

        monkeypatch.setattr(cls, "__init__", __init__)

    _patch(AsyncOpenAI)
    _patch(OpenAI)


@pytest.fixture
def workspace(tmp_path):
    """A fresh workspace with one sample file, per test."""
    (tmp_path / "app.py").write_text("def foo():\n    return 42\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def run_events(mock_server, workspace):
    """Factory: run the REAL agent against the mock and collect its events."""
    base, _mock = mock_server

    async def _run(prompt, *, history=None, subagent_models=None, mode="coder",
                   chat_id=None, **kw):
        # Unique chat_id per call by default so state_db (saved plans, turn
        # resume) cannot leak across tests. Tests that need a STABLE chat_id
        # across calls pass it explicitly.
        if chat_id is None:
            chat_id = f"pytest-{uuid.uuid4().hex[:8]}"
        events = []
        async for ev in run_agent(
            provider="custom",
            model_name="mock-model",
            base_url=base,
            api_key="test",
            root=str(workspace),
            mode=mode,
            prompt=prompt,
            history=history or [],
            chat_id=chat_id,
            subagent_models=subagent_models,
            **kw,
        ):
            events.append(ev)
        return events

    return _run