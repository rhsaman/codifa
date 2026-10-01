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


# Per-turn read ledger: windows already fetched this turn, shared between
# the agent loops (writers, via _SeenWindows in llm.py) and read_tool
# (reader, for the "also fetched" footer). Turn-scoped: reset at turn
# start, cleared on compaction, a path's entries dropped on edit.
# Best-effort throughout — the ledger must never break a turn.
_READ_LEDGER: ContextVar[dict[str, list[tuple[int, int]]] | None] = ContextVar(
    "read_ledger", default=None
)


def reset_read_ledger() -> None:
    """Start a fresh per-turn ledger (call once at turn start / on clear)."""
    _READ_LEDGER.set({})


def note_fetched_window(path: str, start: int, end: int) -> None:
    """Record a fetched window; no-op when no ledger is active (e.g. tests)."""
    led = _READ_LEDGER.get()
    if led is None or not path:
        return
    try:
        led.setdefault(str(path), []).append((int(start), int(end)))
    except (TypeError, ValueError):
        pass


def drop_ledger_path(path: str) -> None:
    """Forget a path (edit made earlier windows stale)."""
    led = _READ_LEDGER.get()
    if led is not None and path:
        led.pop(str(path), None)


def fetched_windows(path: str) -> list[tuple[int, int]]:
    """Windows already fetched for ``path`` this turn (possibly empty)."""
    led = _READ_LEDGER.get()
    if led is None or not path:
        return []
    try:
        return [w for w in led.get(str(path), []) if isinstance(w, tuple) and len(w) == 2]
    except (TypeError, ValueError):
        return []


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


def _rank_step_calls(calls: list[dict], query: str = "") -> list[dict]:
    """Best-effort laya ordering of one step's parallel tool calls.

    Read-only calls run concurrently either way; a better order only means
    more relevant results resolve first when the model reads them in order.
    Returns the calls reordered (most relevant first) or the original list
    on no-signal. Never raises so the tool loop can never break on ranking.
    """
    try:
        items = [c for c in (calls or []) if isinstance(c, dict)]
        if len(items) < 2:
            return list(calls or [])
        import json as _json

        import laya_decide

        cands = []
        for c in items:
            try:
                args_text = _json.dumps(c.get("args") or {}, ensure_ascii=False, sort_keys=True)[:300]
            except Exception:  # noqa: BLE001
                args_text = str(c.get("args") or "")[:300]
            cands.append({"name": str(c.get("name") or c.get("id") or ""), "description": args_text})
        ranked = laya_decide.rank(str(query or ""), cands, top_k=len(cands))
        if not ranked:
            return list(calls or [])
        pos = {str(r.get("name") or ""): i for i, r in enumerate(ranked) if isinstance(r, dict)}
        base = len(pos)
        order = sorted(range(len(items)), key=lambda i: pos.get(str(items[i].get("name") or items[i].get("id") or ""), base))
        return [items[i] for i in order]
    except Exception:  # noqa: BLE001 — ranking is best-effort
        try:
            return list(calls or [])
        except Exception:  # noqa: BLE001
            return []


async def execute_readonly_calls(
    calls: list[dict], execute: Callable[[dict], Awaitable[Any]], query: str = ""
) -> list[Any]:
    """Preserve each callback and its result while sharing compatible raw I/O.

    Callers retain responsibility for separating mutating/blocking tools.
    The context is local to this step; it never buffers work across model turns.
    ``query`` optionally reorders the step's calls by laya relevance first.
    """
    if not calls:
        return []
    ordered = _rank_step_calls(calls, query) if query else list(calls)
    # Map results back to the caller's original order: each ToolMessage is
    # matched by tool_call_id downstream, but the returned list is zipped
    # positionally, so restore the input order before returning.
    if ordered is not calls and len(ordered) == len(calls):
        index = {id(c): i for i, c in enumerate(calls)}
        results_by_idx: dict[int, Any] = {}
        batch = _StepBatch()
        token = _CURRENT_BATCH.set(batch)
        try:
            ordered_results = list(await asyncio.gather(*(execute(call) for call in ordered)))
        finally:
            _CURRENT_BATCH.reset(token)
            await batch.close()
        for call, res in zip(ordered, ordered_results):
            results_by_idx[index[id(call)]] = res
        return [results_by_idx[i] for i in range(len(calls))]
    batch = _StepBatch()
    token = _CURRENT_BATCH.set(batch)
    try:
        return list(await asyncio.gather(*(execute(call) for call in calls)))
    finally:
        _CURRENT_BATCH.reset(token)
        await batch.close()
