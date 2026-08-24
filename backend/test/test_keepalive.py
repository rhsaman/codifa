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

from server import _with_keepalive


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
