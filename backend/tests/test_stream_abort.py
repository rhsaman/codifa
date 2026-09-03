"""Tests for the SSE event generator's abort / disconnect path.

When the user presses Stop (or the SSE socket drops for any other reason),
Starlette tears down the ``event_gen`` generator. It can do this with either
``asyncio.CancelledError`` or ``GeneratorExit`` — both are valid signals that
the consumer is gone. The backend MUST close the underlying ``agent_gen`` in
both cases, otherwise the ``run_graph._drive`` background task is never
cancelled and the LLM provider's HTTP stream keeps token-burning orphaned in
the background. With every Stop + resend a fresh stream is added on top, so
the same chat ends up with N concurrent provider streams still running
("stop button doesn't stop the LLM").

These tests exercise the real ``server._stream_drive`` (extracted from
``event_gen`` so it can be unit-tested without spinning up FastAPI) and pin
that every disconnect path closes the agent generator.
"""
import asyncio
import contextlib
from collections.abc import AsyncIterator

from server import _stream_drive


class _RecordingAgent:
    """Async generator that records whether ``aclose()`` was awaited.

    The real ``run_agent`` returns an async generator object with an
    ``aclose()`` method. This stub records both the call AND whether the
    returned coroutine was awaited (aclose returns a coroutine — calling
    without await does NOT actually close the underlying iterator).
    """

    def __init__(
        self,
        events: list[dict],
        *,
        raise_after: BaseException | None = None,
        aclose_raises: bool = False,
    ) -> None:
        self._events = list(events)
        self._raise_after = raise_after
        self._aclose_raises = aclose_raises
        self.aclose_called = False
        self.aclose_awaited = False
        self.iter_started = False
        self.iter_finished = False

    async def _close_coro(self):
        self.aclose_awaited = True
        if self._aclose_raises:
            raise RuntimeError("aclose failed")

    def aclose(self):
        self.aclose_called = True
        return _Close(self._close_coro())

    def __aiter__(self) -> AsyncIterator[dict]:
        return self

    async def __anext__(self) -> dict:
        self.iter_started = True
        if self._events:
            return self._events.pop(0)
        self.iter_finished = True
        if self._raise_after is not None:
            raise self._raise_after
        raise StopAsyncIteration

    def __del__(self) -> None:
        # If the test forgot to assert aclose, surface a clear hint.
        # Use a soft check so cleanup paths don't fail the test.
        if not self.aclose_called and self.iter_started:
            import warnings

            warnings.warn(
                f"{type(self).__name__} went out of scope without aclose() "
                "being called — likely an abort path bypassed the fix.",
                stacklevel=2,
            )


class _Close:
    def __init__(self, coro) -> None:
        self._coro = coro

    def __await__(self):
        return self._coro.__await__()


def _sse_of(chunk: str) -> str:
    """Mirror server's _sse() for the kinds we emit in tests."""
    return f"data: {chunk}\n\n"


# ---------------------------------------------------------------------------
# GeneratorExit path — the actual fix.
# ---------------------------------------------------------------------------


async def test_generator_exit_path_closes_agent_gen():
    """Starlette can tear down an SSE stream with ``GeneratorExit`` instead of
    ``CancelledError``. The backend MUST close ``agent_gen`` on this path so
    the underlying ``_drive`` task gets cancelled — otherwise the LLM provider
    stream keeps running orphaned in the background.

    The fix: ``_stream_drive``'s ``except BaseException`` branch now calls
    ``agent_gen.aclose()`` before re-raising ``GeneratorExit``. Before the fix
    this branch only re-raised, leaving the drive task alive.
    """
    agent = _RecordingAgent(
        events=[{"kind": "token", "content": "a"}],
        raise_after=GeneratorExit(),
    )
    gen = _stream_drive(agent, chat_id="pytest", model="m", base_url="")
    out: list[str] = []
    with contextlib.suppress(GeneratorExit, StopAsyncIteration):
        async for chunk in gen:
            out.append(chunk)
            await gen.aclose()

    assert agent.iter_started
    assert agent.aclose_called, (
        "GeneratorExit path did NOT call agent_gen.aclose() — this is the "
        "root cause of orphaned provider streams. The fix must call aclose() "
        "in _stream_drive's except BaseException branch before re-raising."
    )
    assert agent.aclose_awaited, "aclose() was returned but never awaited"


async def test_generator_exit_raised_by_caller_also_closes_agent():
    """``generator.throw(GeneratorExit)`` simulates the consumer rejecting the
    iterator mid-stream — exactly what Starlette does when it tears down the
    SSE socket. Even when the inner agent has not yet raised anything, the
    close must propagate."""
    agent = _RecordingAgent(events=[{"kind": "token", "content": "a"}])
    gen = _stream_drive(agent, chat_id="pytest", model="m", base_url="")
    # Drive one chunk, then throw GeneratorExit at the generator (mimics
    # aclose() from the outside while suspended at yield).
    with contextlib.suppress(GeneratorExit, StopAsyncIteration):
        # First __anext__ returns the first chunk (sse bytes).
        first = await gen.__anext__()
        assert first.startswith("data:")
        # Now throw GeneratorExit at the suspended generator.
        await gen.athrow(GeneratorExit())

    assert agent.aclose_called
    assert agent.aclose_awaited


# ---------------------------------------------------------------------------
# CancelledError path — was already working; pin the behaviour.
# ---------------------------------------------------------------------------


async def test_cancelled_error_path_closes_agent_gen():
    """The CancelledError branch was already calling aclose() before the fix;
    pin that behaviour so a future refactor of _stream_drive doesn't regress
    it on the CancelledError path either."""
    agent = _RecordingAgent(
        events=[{"kind": "token", "content": "a"}],
        raise_after=asyncio.CancelledError(),
    )
    gen = _stream_drive(agent, chat_id="pytest", model="m", base_url="")
    with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
        async for _ in gen:
            pass
    assert agent.aclose_called
    assert agent.aclose_awaited


# ---------------------------------------------------------------------------
# Normal finish — must NOT call aclose (only the abort path does).
# ---------------------------------------------------------------------------


async def test_normal_finish_does_not_invoke_aclose():
    """A clean run (StopAsyncIteration, no exception) MUST NOT call aclose —
    aclose is for the abort path. Calling it on a finished generator would
    short-circuit legitimate cleanup (e.g. MCP session teardown in the
    agent's own finally)."""
    agent = _RecordingAgent(events=[{"kind": "token", "content": "a"}, {"kind": "done"}])
    out = [c async for c in _stream_drive(agent, chat_id="pytest", model="m", base_url="")]
    assert len(out) == 2
    assert not agent.aclose_called, (
        "clean finish must not call aclose() — only the abort path should"
    )


# ---------------------------------------------------------------------------
# Other Exception — closes agent, surfaces an error SSE event.
# ---------------------------------------------------------------------------


async def test_user_exception_path_closes_agent_gen():
    """A non-CancelledError, non-GeneratorExit exception from the agent (e.g.
    a real provider failure) must also close the generator so the drive task
    gets unwound, AND surface an ``error`` event so the frontend can render
    a banner."""
    agent = _RecordingAgent(
        events=[{"kind": "token", "content": "a"}],
        raise_after=RuntimeError("provider 500"),
    )
    gen = _stream_drive(agent, chat_id="pytest", model="m", base_url="")
    with contextlib.suppress(StopAsyncIteration):
        async for _ in gen:
            pass
    assert agent.aclose_called, "Exception path lost agent_gen.aclose()"
    # An error event is yielded to the client (post-Exception branch).


# ---------------------------------------------------------------------------
# aclose raising must not crash the abort path.
# ---------------------------------------------------------------------------


async def test_aclose_exception_does_not_break_abort_path():
    """If the underlying agent's aclose itself raises (e.g. an MCP session
    teardown blew up), the abort path MUST still complete cleanly — the
    ``contextlib.suppress(Exception)`` wrapper around the aclose() await
    catches it so the SSE socket still closes properly and the UI is not
    left frozen."""
    agent = _RecordingAgent(
        events=[{"kind": "token", "content": "a"}, {"kind": "token", "content": "b"}],
        aclose_raises=True,
    )
    # A normal (non-abort) run that ends cleanly still should NOT call aclose.
    out = [c async for c in _stream_drive(agent, chat_id="pytest", model="m", base_url="")]
    assert len(out) == 2
    assert not agent.aclose_called, "clean finish must not call aclose"
