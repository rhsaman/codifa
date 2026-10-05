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




# Short results are copied to merged siblings verbatim (stubs, errors,
# "no matches" are all short); long results are replaced by a pointer so
# the transcript carries the block once, not N times.
_MERGED_SIBLING_COPY_CHARS = 500


def merge_same_scope_greps(
    calls: list[dict],
) -> tuple[list[dict], object]:
    """Merge same-step grep calls sharing one scope into a single execution.

    Back-to-back greps with the same path+include are one search the model
    split in two: combine them into pattern + patterns=[...] (one disk scan,
    one trace row, unified caps) and fan the result out afterwards. Returns
    (exec_calls, expand) where expand(exec_results) rebuilds the positional
    result list for the ORIGINAL calls: the first call of each group keeps
    the full result, later siblings get it verbatim when short else a
    pointer to it (never re-sent).

    Only pure single-pattern greps merge: same path string, same include
    string, no batch params already (patterns/paths/includes), non-empty
    pattern. Different scopes NEVER merge (that Cartesian expansion scans
    more and returns more tokens). merged max_results = max (a small cap
    must not shrink a sibling's answer). Never raises; on any doubt the
    calls pass through untouched.
    """
    try:
        items = [c for c in (calls or []) if isinstance(c, dict)]
        if len(items) < 2:
            return list(calls or []), (lambda results: list(results or []))
        # Same-file reads are one read the model split in two: merge them
        # into filePath + ranges=["path:o:l", ...] (one disk pass, one
        # trace row, one ToolMessage). Same contract as the grep merge
        # below: owner keeps the full result, siblings get a pointer.
        read_groups: dict[str, int] = {}  # filePath -> exec position
        read_plans: dict[int, dict] = {}
        for pos, tc in enumerate(items):
            try:
                name = str(tc.get("name") or "").lower()
                args = tc.get("args") or {}
                key = None
                if (
                    name == "read"
                    and isinstance(args, dict)
                    and str(args.get("filePath") or "").strip()
                    and not args.get("filePaths")
                    and not args.get("ranges")
                    and not args.get("symbols")
                ):
                    key = str(args.get("filePath") or "").strip()
            except Exception:  # noqa: BLE001 — unmergeable passes through
                key = None
            if key is None:
                continue
            if key not in read_groups:
                read_groups[key] = pos
                read_plans[pos] = {"sibs": [], "specs": [], "owner": dict(tc.get("args") or {})}
                plan = read_plans[pos]
                try:
                    plan["specs"].append(
                        f"{key}:{int(args.get('offset') or 1)}:{int(args.get('limit') or 2000)}"
                    )
                except (TypeError, ValueError):
                    plan["specs"].append(f"{key}:1:2000")
                continue
            plan = read_plans[read_groups[key]]
            plan["sibs"].append(pos)
            try:
                plan["specs"].append(
                    f"{key}:{int(args.get('offset') or 1)}:{int(args.get('limit') or 2000)}"
                )
            except (TypeError, ValueError):
                plan["specs"].append(f"{key}:1:2000")
        if any(p["sibs"] for p in read_plans.values()):
            # Fold merged reads into the grep-merge pipeline below: drop the
            # sibling read calls from `items` and rewrite the owner with the
            # combined ranges, tracking original positions so expand() can
            # fan the single result back out to every sibling.
            read_owner_pos: dict[int, int] = {}  # owner pos -> exec position
            read_sibs: dict[int, list[int]] = {}  # exec position -> sibling orig positions
            read_combined: dict[int, str] = {}  # exec position -> ranges summary
            kept: list = []
            for pos, tc in enumerate(items):
                owner_of = None
                for opos, plan in read_plans.items():
                    if pos == opos or pos in plan["sibs"]:
                        owner_of = opos
                        break
                if owner_of is None:
                    kept.append(tc)
                    continue
                if pos == owner_of:
                    plan = read_plans[owner_of]
                    merged_args = dict(plan["owner"])
                    merged_args["ranges"] = list(plan["specs"])
                    merged_tc = dict(tc)
                    merged_tc["args"] = merged_args
                    read_owner_pos[owner_of] = len(kept)
                    kept.append(merged_tc)
            items = kept
            for opos, plan in read_plans.items():
                if not plan["sibs"]:
                    continue
                exec_pos = read_owner_pos.get(opos)
                if exec_pos is None:
                    continue
                read_sibs[exec_pos] = list(plan["sibs"])
                try:
                    read_combined[exec_pos] = "|".join(plan["specs"])
                except Exception:  # noqa: BLE001
                    read_combined[exec_pos] = ""
        else:
            read_sibs = {}
            read_combined = {}
        groups: dict[tuple, int] = {}  # merge key -> exec position
        exec_calls: list[dict] = []
        exec_orig: list[int] = []  # exec position -> original position
        # exec position -> {"sibs": [orig positions], "combined": str, "scope": str}
        plans: dict[int, dict] = {}
        for pos, tc in enumerate(items):
            try:
                name = str(tc.get("name") or "").lower()
                args = tc.get("args") or {}
                key = None
                if (
                    name == "grep"
                    and isinstance(args, dict)
                    and str(args.get("pattern") or "")
                    and not args.get("patterns")
                    and not args.get("paths")
                    and not args.get("includes")
                ):
                    key = (
                        "grep",
                        str(args.get("path") or ""),
                        str(args.get("include") or ""),
                    )
            except Exception:  # noqa: BLE001 — unmergeable passes through
                key = None
            if key is None:
                exec_calls.append(tc)
                exec_orig.append(pos)
                continue
            if key not in groups:
                groups[key] = len(exec_calls)
                plans[len(exec_calls)] = {
                    "sibs": [],
                    "terms": [str(tc.get("args").get("pattern"))],
                    "max_results": 50,
                    "owner": dict(tc.get("args") or {}),
                }
                exec_calls.append(tc)
                exec_orig.append(pos)
                continue
            plan = plans[groups[key]]
            plan["sibs"].append(pos)
            plan["terms"].append(str(tc.get("args").get("pattern")))
            try:
                plan["max_results"] = max(
                    int(plan["max_results"]),
                    int(tc.get("args").get("max_results") or 50),
                )
            except (TypeError, ValueError):
                pass
            try:
                plan["max_results"] = max(
                    int(plan["max_results"]),
                    int(plan["owner"].get("max_results") or 50),
                )
            except (TypeError, ValueError):
                pass
        # Read siblings merged above must survive even when no grep merged:
        # map exec positions back to ORIGINAL call positions (read owners
        # were rewritten in `items`, whose positions still match `calls`
        # when no read merge happened, else map via read_owner_pos).
        _read_exec_sibs: dict[int, list[int]] = {}
        _read_exec_combined: dict[int, str] = {}
        try:
            for opos, epos in (read_owner_pos or {}).items():
                sibs = (read_sibs or {}).get(epos, [])
                if not sibs:
                    continue
                _read_exec_sibs[epos] = list(sibs)
                _read_exec_combined[epos] = str((read_combined or {}).get(epos, ""))
        except Exception:  # noqa: BLE001 — read fan-out is best-effort
            _read_exec_sibs = {}
            _read_exec_combined = {}
        if not any(p["sibs"] for p in plans.values()):
            if not _read_exec_sibs:
                return list(calls or []), (lambda results: list(results or []))

            def _expand_reads_only(exec_results: list) -> list:
                try:
                    total = len(calls or [])
                    out: list = [None] * total
                    res_by_exec = list(exec_results or [])
                    for exec_pos in range(len(exec_calls)):
                        res = res_by_exec[exec_pos] if exec_pos < len(res_by_exec) else ""
                        out[exec_orig[exec_pos]] = res
                        sibs = _read_exec_sibs.get(exec_pos, [])
                        if not sibs:
                            continue
                        text = str(res if res is not None else "")
                        if len(text) < _MERGED_SIBLING_COPY_CHARS:
                            sib_text = text
                        else:
                            sib_text = (
                                f"(same-step merged read — ranges={_read_exec_combined.get(exec_pos, '')!r}: "
                                "the full result is in this step's read result above; not re-sent.)"
                            )
                        for sib in sibs:
                            if 0 <= int(sib) < total:
                                out[int(sib)] = sib_text
                    return out
                except Exception:  # noqa: BLE001 — merge never breaks a step
                    return list(exec_results or [])

            return exec_calls, _expand_reads_only
        # Rewrite the owner exec calls with the combined patterns.
        for exec_pos, plan in plans.items():
            if not plan["sibs"]:
                continue
            merged_args = dict(plan["owner"])
            merged_args["pattern"] = plan["terms"][0]
            merged_args["patterns"] = plan["terms"][1:]
            merged_args["max_results"] = int(plan["max_results"])
            merged_tc = dict(exec_calls[exec_pos])
            merged_tc["args"] = merged_args
            exec_calls[exec_pos] = merged_tc
            plan["combined"] = "|".join(plan["terms"])
            try:
                _scope = str(plan["owner"].get("path") or "") or "/"
            except Exception:  # noqa: BLE001
                _scope = "/"
            plan["scope"] = _scope

        def expand(exec_results: list) -> list:
            # NOTE: `items` may be shorter than `calls` when reads merged
            # (siblings dropped). Size the output for the ORIGINAL calls and
            # map read siblings by their original positions.
            total = len(calls or [])
            out: list = [None] * total
            res_by_exec = list(exec_results or [])
            for exec_pos in range(len(exec_calls)):
                res = res_by_exec[exec_pos] if exec_pos < len(res_by_exec) else ""
                orig = exec_orig[exec_pos] if exec_pos < len(exec_orig) else exec_pos
                if 0 <= int(orig) < total:
                    out[int(orig)] = res
                text = str(res if res is not None else "")
                if len(text) < _MERGED_SIBLING_COPY_CHARS:
                    sib_text_grep = text
                    sib_text_read = text
                else:
                    sib_text_grep = ""
                    sib_text_read = (
                        f"(same-step merged read — ranges={_read_exec_combined.get(exec_pos, '')!r}: "
                        "the full result is in this step's read result above; not re-sent.)"
                    )
                plan = plans.get(exec_pos)
                if plan and plan.get("sibs"):
                    if not sib_text_grep:
                        sib_text_grep = (
                            f"(same-step merged grep — pattern={plan.get('combined', '')!r} "
                            f"under {plan.get('scope', '/')}: the full result is in "
                            "this step's grep result above; not re-sent.)"
                        )
                    for sib in plan["sibs"]:
                        if 0 <= int(sib) < total:
                            out[int(sib)] = sib_text_grep
                for sib in _read_exec_sibs.get(exec_pos, []):
                    if 0 <= int(sib) < total:
                        out[int(sib)] = sib_text_read
            return out

        return exec_calls, expand
    except Exception:  # noqa: BLE001 — merge never breaks a step
        return list(calls or []), (lambda results: list(results or []))


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
    """Ordering hook for one step's parallel tool calls (ranking removed).

    Always returns the calls in input order. Never raises so the tool loop
    can never break on ranking.
    """
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
    """
    if not calls:
        return []
    ordered = list(calls)
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
