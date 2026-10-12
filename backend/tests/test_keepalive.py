"""Tests for the SSE keepalive wrapper used to keep idle sockets alive mid-stream.

`_with_keepalive` wraps the agent event generator and injects a sentinel event
whenever the agent goes silent for `timeout` seconds. The sentinel is later
turned into a `: keepalive` SSE comment by `event_gen`, which the frontend's
parseFrame ignores — so it never reaches onEvent and never resets the stall
watchdog. These tests verify the wrapper's timing/sentinel behaviour without
any network, server, or LLM.
"""
import asyncio

import pytest

from server import _ModelSilenceTimeout, _with_keepalive


async def _silent_gen(delay: float, events):
    """Yield `events` with `delay` seconds of silence before each one."""
    for ev in events:
        await asyncio.sleep(delay)
        yield ev


async def test_keepalive_injected_on_silence():
    """When the agent is silent longer than `timeout`, a sentinel is injected."""
    gen = _with_keepalive(_silent_gen(0.05, [{"kind": "token", "content": "a"}]), timeout=0.01)
    collected = [e async for e in gen]
    # First event is the sentinel (silence before the first real event), then
    # the real event.
    assert collected[0] == {"kind": "_keepalive"}
    assert collected[-1] == {"kind": "token", "content": "a"}


async def test_no_keepalive_when_agent_is_responsive():
    """When the agent emits events faster than `timeout`, no sentinel appears."""
    gen = _with_keepalive(_silent_gen(0.0, [{"kind": "token", "content": "a"}, {"kind": "done"}]), timeout=0.05)
    collected = [e async for e in gen]
    assert all(e.get("kind") != "_keepalive" for e in collected)
    assert collected == [{"kind": "token", "content": "a"}, {"kind": "done"}]


async def test_keepalive_between_events():
    """A sentinel is injected between two slow events, not just before the first.

    While an event is pending the wrapper emits a keepalive every `timeout`
    seconds (so the socket stays alive during a long silence), then the real
    event once it arrives. We assert the *sequence of kinds* — keepalive(s)
    before `a`, then keepalive(s) before `b` — not the exact count.
    """
    async def slow_pair():
        await asyncio.sleep(0.05)
        yield {"kind": "token", "content": "a"}
        await asyncio.sleep(0.05)
        yield {"kind": "token", "content": "b"}

    gen = _with_keepalive(slow_pair(), timeout=0.01)
    collected = [e async for e in gen]
    kinds = [e.get("kind") for e in collected]
    # First real event is `a`, preceded only by keepalive(s); `b` follows, also
    # preceded by keepalive(s).
    assert kinds.count("token") == 2
    assert kinds[-1] == "token"
    assert kinds[-2] == "_keepalive"
    assert kinds[0] == "_keepalive"
    assert {"kind": "token", "content": "a"} in collected
    assert {"kind": "token", "content": "b"} in collected


async def test_empty_generator_yields_nothing():
    """An empty agent generator produces no events (no spurious keepalive)."""
    gen = _with_keepalive(_silent_gen(0.0, []), timeout=0.01)
    collected = [e async for e in gen]
    assert collected == []


async def test_silence_cap_closes_stream_with_exception():
    """Past `max_silence` of continuous silence the wrapper raises
    `_ModelSilenceTimeout` instead of keepaliving forever, so the stream is
    torn down and the frontend can auto-resume from its checkpoint."""
    gen = _with_keepalive(
        _silent_gen(0.2, [{"kind": "token", "content": "a"}]),
        timeout=0.01,
        max_silence=0.05,
    )
    with pytest.raises(_ModelSilenceTimeout):
        async for _ in gen:
            pass


async def test_silence_cap_suspended_while_paused():
    """`is_paused` suspends the cap: waiting on a permission/ask gate is
    legitimate silence (the user can take arbitrarily long), so keepalives
    keep flowing and no exception fires."""
    gen = _with_keepalive(
        _silent_gen(0.08, [{"kind": "token", "content": "a"}]),
        timeout=0.01,
        max_silence=0.05,
        is_paused=lambda: True,
    )
    collected = [e async for e in gen]
    assert collected[0] == {"kind": "_keepalive"}
    assert collected[-1] == {"kind": "token", "content": "a"}


async def test_real_event_resets_silence_clock():
    """A real event mid-stream resets the silence clock: several short gaps,
    each under the cap, must NOT add up to a cap breach."""

    async def gappy():
        for _ in range(4):
            await asyncio.sleep(0.03)
            yield {"kind": "token", "content": "x"}

    gen = _with_keepalive(gappy(), timeout=0.01, max_silence=0.06)
    collected = [e async for e in gen]
    kinds = [e.get("kind") for e in collected]
    assert kinds.count("token") == 4


async def test_silence_cap_not_counted_while_thinking():
    """While the model's reasoning window is open (`thinking active:True`),
    silence far beyond `max_silence` is legitimate thinking: keepalives keep
    flowing, no `_ModelSilenceTimeout`, and the stream completes normally."""

    async def thinking_then_long_silence():
        yield {"kind": "thinking", "active": True}
        await asyncio.sleep(0.2)  # 4x the cap
        yield {"kind": "thinking", "active": False}
        yield {"kind": "token", "content": "a"}

    gen = _with_keepalive(
        thinking_then_long_silence(), timeout=0.01, max_silence=0.05
    )
    collected = [e async for e in gen]
    kinds = [e.get("kind") for e in collected]
    assert "_keepalive" in kinds
    assert collected[-1] == {"kind": "token", "content": "a"}


async def test_silence_cap_applies_after_thinking_ends():
    """Once thinking is closed (`active:False`), the old behaviour is kept: a
    genuinely wedged stream (silence past the cap) still raises."""

    async def thinking_closed_then_silence():
        yield {"kind": "thinking", "active": True}
        yield {"kind": "thinking", "active": False}
        await asyncio.sleep(0.2)
        yield {"kind": "token", "content": "a"}

    gen = _with_keepalive(
        thinking_closed_then_silence(), timeout=0.01, max_silence=0.05
    )
    with pytest.raises(_ModelSilenceTimeout):
        async for _ in gen:
            pass
