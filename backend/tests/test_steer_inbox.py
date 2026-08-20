"""Regression tests for the steer inbox mechanism.

Covers the race condition where ``_drain_steer`` read the shared
``STEER_INBOX`` dict without holding ``_STEER_LOCK`` while
``_enqueue_steer`` / ``_remove_steer`` wrote to it under the lock.
That could silently drop steer messages (frontend POSTs mid-run while
the tool wrapper drains). The fix made ``_drain_steer`` async and moved
the read+clear inside ``async with _STEER_LOCK``.
"""
import asyncio

from agents import STEER_INBOX, _drain_steer, _enqueue_steer, _remove_steer


async def test_steer_basic_enqueue_drain():
    chat_id = "test-steer-basic"
    await _enqueue_steer(chat_id, {"id": "m1", "prompt": "p1"})

    items = await _drain_steer(chat_id)
    assert [i["id"] for i in items] == ["m1"]

    # inbox is cleared after drain
    assert await _drain_steer(chat_id) == []
    assert STEER_INBOX.get(chat_id) in (None, [])


async def test_steer_remove_before_drain():
    chat_id = "test-steer-remove"
    await _enqueue_steer(chat_id, {"id": "m1", "prompt": "p1"})
    await _enqueue_steer(chat_id, {"id": "m2", "prompt": "p2"})

    await _remove_steer(chat_id, "m1")

    items = await _drain_steer(chat_id)
    assert [i["id"] for i in items] == ["m2"]


async def test_steer_concurrent_enqueue_drain_no_loss():
    """Regression: concurrent enqueue (frontend POST) + drain (tool wrapper)
    must not lose or duplicate steer messages."""
    chat_id = "test-steer-race"
    n = 300
    ids = [f"msg-{i}" for i in range(n)]

    drained: list[str] = []
    drained_lock = asyncio.Lock()

    async def drainer():
        while True:
            items = await _drain_steer(chat_id)
            if items:
                async with drained_lock:
                    drained.extend(i["id"] for i in items)
            else:
                await asyncio.sleep(0)

    async def enqueuer(i):
        await _enqueue_steer(chat_id, {"id": ids[i], "prompt": f"p{i}"})

    drainers = [asyncio.create_task(drainer()) for _ in range(5)]
    await asyncio.gather(*(enqueuer(i) for i in range(n)))
    await asyncio.sleep(0.05)
    for d in drainers:
        d.cancel()
    await asyncio.gather(*drainers, return_exceptions=True)

    # collect anything left in the inbox after the drainers stopped
    drained.extend(i["id"] for i in await _drain_steer(chat_id))

    assert sorted(drained) == sorted(ids), (
        f"lost={len(set(ids) - set(drained))} "
        f"dupes={len(drained) - len(set(drained))}"
    )