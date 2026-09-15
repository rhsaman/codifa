"""Step-local I/O coalescing without rewriting tool arguments or result IDs."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Hashable
from contextvars import ContextVar
from typing import Any

_BatchRunner = Callable[[list[Any]], Awaitable[list[Any]]]


class _StepBatch:
    def __init__(self) -> None:
        self.pending: dict[Hashable, list[tuple[Any, asyncio.Future]]] = {}
        self.tasks: set[asyncio.Task] = set()
        self.closed = False

    async def submit(self, key: Hashable, request: Any, run: _BatchRunner) -> Any:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        if key not in self.pending:
            self.pending[key] = []
            # Let sibling tool callbacks reach their I/O boundary first.
            loop.call_soon(self._start, key, run)
        self.pending[key].append((request, future))
        return await future

    def _start(self, key: Hashable, run: _BatchRunner) -> None:
        entries = self.pending.pop(key, [])
        if self.closed:
            for _, future in entries:
                future.cancel()
            return
        entries = [(request, future) for request, future in entries if not future.done()]
        if entries:
            task = asyncio.create_task(self._dispatch(entries, run))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def _dispatch(self, entries: list[tuple[Any, asyncio.Future]], run: _BatchRunner) -> None:
        try:
            results = await run([request for request, _ in entries])
            if len(results) != len(entries):
                raise ValueError("تعداد نتایج دسته با تعداد درخواست‌ها برابر نیست")
            for (_, future), result in zip(entries, results):
                if not future.done():
                    if isinstance(result, Exception):
                        future.set_exception(result)
                    else:
                        future.set_result(result)
        except (asyncio.CancelledError, ValueError):
            for _, future in entries:
                future.cancel()
            raise
        except Exception as exc:  # noqa: BLE001 — خطا به هر future منتقل می‌شود
            for _, future in entries:
                if not future.done():
                    future.set_exception(exc)

    async def close(self) -> None:
        self.closed = True
        for entries in self.pending.values():
            for _, future in entries:
                future.cancel()
        self.pending.clear()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


_CURRENT_BATCH: ContextVar[_StepBatch | None] = ContextVar("tool_io_batch", default=None)


async def coalesce_io(
    key: Hashable,
    request: Any,
    single: Callable[[], Awaitable[Any]],
    batch: _BatchRunner,
) -> Any:
    """Opt in at an I/O boundary, after the callback's permission checks."""
    current = _CURRENT_BATCH.get()
    if current is None or current.closed:
        return await single()
    return await current.submit(key, request, batch)


async def execute_readonly_calls(
    calls: list[dict], execute: Callable[[dict], Awaitable[Any]]
) -> list[Any]:
    """Preserve each callback and its result while sharing compatible raw I/O.

    Callers retain responsibility for separating mutating/blocking tools.
    The context is local to this step; it never buffers work across model turns.
    """
    if not calls:
        return []
    batch = _StepBatch()
    token = _CURRENT_BATCH.set(batch)
    try:
        return list(await asyncio.gather(*(execute(call) for call in calls)))
    finally:
        _CURRENT_BATCH.reset(token)
        await batch.close()
