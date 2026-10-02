"""Step-local I/O coalescing without rewriting tool arguments or result IDs."""

from __future__ import annotations

import asyncio
import posixpath
import re
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
    _SERVED_MAPS.set(set())


def _ledger_key(path: str) -> str:
    """Canonical ledger key: "./a.py" and "a.py" are the same file.

    The model spells paths inconsistently across steps; without this a
    window served as "a.py" never covers a re-read of "./a.py" and the
    same content is served twice.
    """
    try:
        return posixpath.normpath(str(path))
    except Exception:  # noqa: BLE001 — fall back to the raw string
        return str(path)


def note_fetched_window(path: str, start: int, end: int) -> None:
    """Record a fetched window; no-op when no ledger is active (e.g. tests)."""
    led = _READ_LEDGER.get()
    if led is None or not path:
        return
    try:
        led.setdefault(_ledger_key(path), []).append((int(start), int(end)))
    except (TypeError, ValueError):
        pass


def drop_ledger_path(path: str) -> None:
    """Forget a path (edit made earlier windows stale)."""
    led = _READ_LEDGER.get()
    if led is not None and path:
        led.pop(_ledger_key(path), None)
    maps = _SERVED_MAPS.get()
    if maps is not None and path:
        maps.discard(_ledger_key(path))


def fetched_windows(path: str) -> list[tuple[int, int]]:
    """Windows already fetched for ``path`` this turn (possibly empty)."""
    led = _READ_LEDGER.get()
    if led is None or not path:
        return []
    try:
        return [w for w in led.get(_ledger_key(path), []) if isinstance(w, tuple) and len(w) == 2]
    except (TypeError, ValueError):
        return []


# Paths served a file MAP instead of the requested head window this turn.
# A map shows structure (head rows + symbol list), not content — so the
# requested window must NOT count as fetched for coverage/stub purposes.
# Turn-scoped like _READ_LEDGER; cleared by reset_read_ledger().
_SERVED_MAPS: ContextVar[set[str] | None] = ContextVar(
    "served_maps", default=None
)


def note_served_map(path: str) -> None:
    """Record that ``path`` was served a file map (not the requested window)."""
    maps = _SERVED_MAPS.get()
    if maps is None or not path:
        return
    try:
        maps.add(_ledger_key(path))
    except (TypeError, ValueError):
        pass


def has_served_map(path: str) -> bool:
    """True when ``path`` was served a file map this turn (coverage is untrusted)."""
    maps = _SERVED_MAPS.get()
    if maps is None or not path:
        return False
    try:
        return _ledger_key(path) in maps
    except (TypeError, ValueError):
        return False


# Per-turn duplicate-call set: exact (tool, args) pairs already executed this
# turn. Turn-scoped like _READ_LEDGER — reset at the same loop-start sites
# (wherever reset_read_ledger() runs): a byte-identical repeat inside one turn
# re-sends content for zero benefit, so the tool layer stubs it instead of
# re-sending. Edit-safe: callers fold the search generation (bumped on every
# edit) into the key, so a post-edit repeat re-executes instead of stubbing.
_TURN_CALLS: ContextVar[set[tuple] | None] = ContextVar(
    "turn_seen_calls", default=None
)


def reset_turn_seen_calls() -> None:
    """Start a fresh per-turn duplicate set (call wherever reset_read_ledger runs)."""
    _TURN_CALLS.set(set())
    reset_turn_grep_cover()


def note_turn_call(key: tuple) -> bool:
    """Record an executed call; True when this exact call already ran this turn.

    No-op (False) when no turn is active (e.g. unit tests) or the key is empty.
    """
    if not key:
        return False
    seen = _TURN_CALLS.get()
    if seen is None:
        return False
    try:
        if key in seen:
            return True
        seen.add(key)
    except TypeError:
        return False
    return False


# Same-turn grep coverage: (generation, scope) -> complete searches already
# served, each as (word set, max_results, pattern display). A later grep on the
# same scope whose words are a SUBSET of a complete earlier search can only
# repeat rows already in context, so the tool layer stubs it instead of
# re-scanning and re-sending. Only COMPLETE searches are recorded (truncated
# ones hid rows a narrower pattern could surface). Generation-scoped like the
# dup keys above, so a post-edit repeat re-executes.
_TURN_GREP_COVER: ContextVar[dict | None] = ContextVar(
    "turn_grep_cover", default=None
)


def reset_turn_grep_cover() -> None:
    """Start a fresh per-turn grep-coverage map (same lifecycle as dup calls)."""
    _TURN_GREP_COVER.set({})


# A grep `|`-branch with zero regex metacharacters (plain literal text).
# When such a branch E of an earlier COMPLETE search sits inside a later
# single-branch literal pattern L as a substring, every line matching L
# contains E literally, so L's rows are a subset of E's rows on the same
# scope — the later grep can stub. Anything with regex syntax is excluded:
# claiming containment there is unsound (e.g. `renderSide?` contains
# "renderSide" but also matches "renderSid").
_LITERAL_ALT_RE = re.compile(r"[A-Za-z0-9_ \-\./:]+")
_LITERAL_ALT_MIN_LEN = 3


def _literal_alternatives(combined: str) -> tuple[str, ...]:
    """Lowercased literal `|`-branches of a combined grep pattern.

    Only branches entirely free of regex metacharacters qualify (see above).
    Never raises.
    """
    try:
        out: list[str] = []
        for _b in str(combined or "").split("|"):
            _s = _b.strip()
            if (
                len(_s) >= _LITERAL_ALT_MIN_LEN
                and _LITERAL_ALT_RE.fullmatch(_s)
                and _s.lower() not in out
            ):
                out.append(_s.lower())
        return tuple(out)
    except Exception:  # noqa: BLE001 — overlap never breaks a search
        return ()


def grep_cover_check(
    generation: int,
    scope_key: tuple,
    words: frozenset,
    max_results: int,
    combined: str = "",
) -> str:
    """Return the earlier pattern covering this grep, or "" when it must run.

    Covered = same generation+scope, earlier word set is a superset, earlier
    max_results >= this one — or literal containment: the later pattern is a
    single literal branch containing an earlier literal branch (then its rows
    are a subset of the earlier complete search's rows). No-op ("") when no
    turn is active.
    """
    if not words:
        return ""
    try:
        cover = _TURN_GREP_COVER.get()
    except Exception:  # noqa: BLE001 — coverage never breaks a search
        return ""
    if not cover:
        return ""
    try:
        entries = cover.get((int(generation), scope_key)) or []
        for _e in entries:
            try:
                _w, _m, _p = _e[0], _e[1], _e[2]
            except (TypeError, IndexError):
                continue
            if int(max_results) <= int(_m) and words <= _w:
                return str(_p)
        # Literal containment (e.g. earlier `renderSide|...`, later
        # `const renderSide` — the new word "const" defeats the word-subset
        # rule, but every matching line still contains "renderside").
        _lc = str(combined or "").strip()
        if (
            _lc
            and "|" not in _lc
            and len(_lc) >= _LITERAL_ALT_MIN_LEN
            and _LITERAL_ALT_RE.fullmatch(_lc)
        ):
            _lcl = _lc.lower()
            for _e in entries:
                try:
                    _m2, _p2 = _e[1], _e[2]
                    _alts2 = _e[3] if len(_e) > 3 else ()
                except (TypeError, IndexError):
                    continue
                if int(max_results) > int(_m2):
                    continue
                for _a in _alts2 or ():
                    if _a and _a in _lcl:
                        return str(_p2)
    except (TypeError, ValueError):
        return ""
    return ""


def grep_cover_note(
    generation: int,
    scope_key: tuple,
    words: frozenset,
    max_results: int,
    pattern_disp: str,
    combined: str = "",
) -> None:
    """Record a COMPLETE grep so later subset greps on the scope stub out."""
    if not words:
        return
    try:
        cover = _TURN_GREP_COVER.get()
    except Exception:  # noqa: BLE001 — coverage never breaks a search
        return
    if cover is None:
        return
    try:
        key = (int(generation), scope_key)
        entries = cover.setdefault(key, [])
        for _e in entries:
            try:
                _w, _m = _e[0], _e[1]
            except (TypeError, IndexError):
                continue
            if words <= _w and int(max_results) <= int(_m):
                return  # an earlier entry already covers this one
        entries.append(
            (
                frozenset(words),
                int(max_results),
                str(pattern_disp)[:120],
                _literal_alternatives(combined or pattern_disp),
            )
        )
    except (TypeError, ValueError):
        pass


# Cross-turn reuse: what PREVIOUS turns served, validated by file signature
# at check time. The per-turn ledgers above reset every turn, so a repeat
# read/grep in the next turn re-sent full content for zero new information.
# These stores survive turns and stub the repeat when nothing changed — the
# model's history already holds the content, so only a short pointer is
# sent. Same trust model as _parent_search_cache (our edits bump the
# generation, which is part of every grep key), but additionally
# stat-checked, so edits made OUTSIDE the agent (IDE, git) also force a
# fresh serve instead of a stale stub. Cleared on compaction (history may
# have evicted the content) via _SeenWindows.clear -> reset_cross_turn.
# Bounded and best-effort throughout: reuse must never break a read/search.
_CROSS_READS_MAX_KEYS = 400
_CROSS_READS_MAX_WINDOWS = 16
# (root, ledger path key) -> [(start, end, mtime_ns, size, abs_target, total)]
# ``total`` is the file's line count when served: a request for lines 1-2000
# of a 3-line file is fully satisfied by the served 1-3 (EOF clamp), so the
# check window is clamped to it instead of demanding 2000 served lines.
_CROSS_READS: dict[tuple[str, str], list[tuple[int, int, int, int, str, int]]] = {}

_CROSS_GREPS_MAX_KEYS = 400
_CROSS_GREP_FILES = 24
_CROSS_GREP_ENTRIES = 8
# (root, generation, scope_key) -> [(words, max_results, pattern_disp,
# summary, ((abs_file, mtime_ns, size), ...))]
_CROSS_GREPS: dict[tuple, list[tuple]] = {}


def _cross_file_sig(abs_path: str) -> tuple[int, int] | None:
    """(mtime_ns, size) for ``abs_path``, or None when it cannot be stated."""
    try:
        import os as _os

        _st = _os.stat(abs_path)
        return (int(_st.st_mtime_ns), int(_st.st_size))
    except (OSError, TypeError, ValueError):
        return None


def reset_cross_turn() -> None:
    """Drop all cross-turn reuse memory (compaction, tests, workspace switch)."""
    try:
        _CROSS_READS.clear()
    except Exception:  # noqa: BLE001, S110 — reset never breaks setup
        pass
    try:
        _CROSS_GREPS.clear()
    except Exception:  # noqa: BLE001, S110 — reset never breaks setup
        pass


def note_cross_turn_read(
    root: str, path: str, start: int, end: int, abs_target: str, total: int = 0
) -> None:
    """Remember a served read window for LATER turns.

    Records the file's current signature alongside the served extent and its
    line count; a later repeat only stubs when the signature still matches
    (file unchanged) and the served extents cover the request (clamped to
    the recorded line count). Map-served paths must NOT be recorded (map
    coverage is untrusted). Never raises.
    """
    try:
        sig = _cross_file_sig(abs_target)
        if sig is None or not path:
            return
        key = (str(root or ""), _ledger_key(path))
        if key not in _CROSS_READS and len(_CROSS_READS) >= _CROSS_READS_MAX_KEYS:
            _CROSS_READS.pop(next(iter(_CROSS_READS)))
        entries = _CROSS_READS.setdefault(key, [])
        entries.append(
            (
                int(start), int(end), sig[0], sig[1], str(abs_target),
                int(total or 0),
            )
        )
        del entries[:-_CROSS_READS_MAX_WINDOWS]
    except Exception:  # noqa: BLE001, S110 — reuse never breaks a read
        pass


def cross_turn_read_covers(root: str, path: str, start: int, end: int) -> bool:
    """True when a previous turn served this window and the file is unchanged.

    Only served extents whose recorded signature matches the file's CURRENT
    signature count toward coverage — an edit (ours or external) invalidates
    them and the repeat re-executes. The request is clamped to the recorded
    line count (same bytes = same length), so a default-limit repeat of a
    short file stubs instead of demanding thousands of served lines. Never
    raises.
    """
    try:
        entries = _CROSS_READS.get((str(root or ""), _ledger_key(path)))
        if not entries:
            return False
        sig_now = _cross_file_sig(entries[0][4])
        if sig_now is None:
            _CROSS_READS.pop((str(root or ""), _ledger_key(path)), None)
            return False
        total = 0
        covered = 0
        for _s0, _s1, _mt, _sz, _, _tot in entries:
            if (_mt, _sz) != sig_now:
                continue
            if total <= 0:
                try:
                    total = int(_tot or 0)
                except (TypeError, ValueError):
                    total = 0
            covered += max(0, min(int(end), _s1) - max(int(start), _s0) + 1)
        eff_end = min(int(end), total) if total > 0 else int(end)
        if eff_end < int(start):
            return False  # request starts past EOF — re-execute (error path)
        return covered >= max(1, eff_end - int(start) + 1)
    except Exception:  # noqa: BLE001 — coverage never breaks a read
        return False


def note_cross_turn_grep(
    root: str,
    generation: int,
    scope_key: tuple,
    words: frozenset,
    max_results: int,
    pattern_disp: str,
    summary: str,
    matched_abs_files: list[str],
) -> None:
    """Remember a COMPLETE grep (with matches) for later turns.

    Stores per-file signatures of the matched files (bounded): a later
    subset/exact repeat on the same generation+scope only stubs when every
    matched file is byte-unchanged. Searches with NO matches are NOT
    recorded — a no-match re-scan is one cheap line, while a stale "no
    matches" stub could hide newly added matches. Never raises.
    """
    try:
        if not words:
            return
        sigs: list[tuple[str, int, int]] = []
        for _f in matched_abs_files or []:
            if _f in [s[0] for s in sigs]:
                continue
            _sig = _cross_file_sig(_f)
            if _sig is not None:
                sigs.append((str(_f), _sig[0], _sig[1]))
            if len(sigs) >= _CROSS_GREP_FILES:
                break
        if not sigs:
            return  # nothing statable to validate against later — skip
        key = (str(root or ""), int(generation), scope_key)
        if key not in _CROSS_GREPS and len(_CROSS_GREPS) >= _CROSS_GREPS_MAX_KEYS:
            _CROSS_GREPS.pop(next(iter(_CROSS_GREPS)))
        entries = _CROSS_GREPS.setdefault(key, [])
        for _w, _m, _ in entries:
            if words <= _w and int(max_results) <= int(_m):
                return  # an earlier entry already covers this one
        entries.append(
            (
                frozenset(words),
                int(max_results),
                str(pattern_disp)[:120],
                str(summary)[:160],
                tuple(sigs),
            )
        )
        del entries[:-_CROSS_GREP_ENTRIES]
    except Exception:  # noqa: BLE001, S110 — reuse never breaks a search
        pass


def cross_turn_served_spans(root: str, path: str) -> list[tuple[int, int]]:
    """Sig-validated served extents for ``path`` (for line omission).

    Same store as the cross-turn coverage above, but returns the extents
    themselves so a PARTIALLY overlapping repeat can omit the already-served
    lines from its body instead of re-sending them. Only extents whose
    recorded signature matches the file's CURRENT signature are returned —
    an edit (ours or external) yields [] and the repeat serves whole.
    Map-served paths are never recorded upstream, so no map guard is needed
    here (callers still skip map paths for defense in depth). Never raises.
    """
    try:
        entries = _CROSS_READS.get((str(root or ""), _ledger_key(path)))
        if not entries:
            return []
        sig_now = _cross_file_sig(entries[0][4])
        if sig_now is None:
            return []
        out: list[tuple[int, int]] = []
        for _e in entries:
            try:
                _s0, _s1, _mt, _sz, _, _ = _e
                if (_mt, _sz) != sig_now:
                    continue
                out.append((int(_s0), int(_s1)))
            except (TypeError, ValueError):
                continue
        return out
    except Exception:  # noqa: BLE001 — omission never breaks a read
        return []


def cross_turn_sig_changed(root: str, path: str) -> bool:
    """True when a recorded serve exists but the file changed since.

    The per-turn ledger (fetched_windows) carries no signature, so same-turn
    omission cannot tell an external edit happened — it would omit lines
    served BEFORE the edit as if still current. The cross-turn store DOES
    record the signature at serve time, so a mismatch here means "changed
    since last serve": callers must drop same-turn spans for this path too
    (and heal the per-turn ledger). False when nothing was recorded, the
    file is unchanged, or the signature cannot be stated. Never raises.
    """
    try:
        entries = _CROSS_READS.get((str(root or ""), _ledger_key(path)))
        if not entries:
            return False
        sig_now = _cross_file_sig(entries[0][4])
        if sig_now is None:
            return False
        try:
            _mt, _sz = int(entries[0][2]), int(entries[0][3])
        except (TypeError, ValueError, IndexError):
            return False
        return (_mt, _sz) != sig_now
    except Exception:  # noqa: BLE001 — validation never breaks a read
        return False


def cross_turn_grep_check(
    root: str, generation: int, scope_key: tuple, words: frozenset, max_results: int
) -> str:
    """Return the previous turn's pattern+summary covering this grep, or "".

    Covered = same root+generation+scope, earlier word set is a superset,
    earlier max_results >= this one, AND every matched file is unchanged
    since (a post-edit generation or an external touch misses and the grep
    re-executes). Never raises.
    """
    try:
        if not words:
            return ""
        entries = _CROSS_GREPS.get((str(root or ""), int(generation), scope_key))
        if not entries:
            return ""
        for _w, _m, _p, _s, _sigs in entries:
            try:
                if not (int(max_results) <= int(_m) and words <= _w):
                    continue
                _ok = True
                for _f, _mt, _sz in _sigs:
                    if _cross_file_sig(_f) != (_mt, _sz):
                        _ok = False
                        break
                if _ok:
                    return f"{_p} ({_s})" if _s else str(_p)
            except (TypeError, ValueError):
                continue
        return ""
    except Exception:  # noqa: BLE001 — coverage never breaks a search
        return ""


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
        if not any(p["sibs"] for p in plans.values()):
            return list(calls or []), (lambda results: list(results or []))
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
            out: list = [None] * len(items)
            res_by_exec = list(exec_results or [])
            for exec_pos in range(len(exec_calls)):
                res = res_by_exec[exec_pos] if exec_pos < len(res_by_exec) else ""
                out[exec_orig[exec_pos]] = res
                plan = plans.get(exec_pos)
                if not plan or not plan.get("sibs"):
                    continue
                text = str(res if res is not None else "")
                if len(text) < _MERGED_SIBLING_COPY_CHARS:
                    sib_text = text
                else:
                    sib_text = (
                        f"(same-step merged grep — pattern={plan.get('combined', '')!r} "
                        f"under {plan.get('scope', '/')}: the full result is in "
                        "this step's grep result above; not re-sent.)"
                    )
                for sib in plan["sibs"]:
                    out[sib] = sib_text
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
