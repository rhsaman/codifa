"""In-memory per-chat trace log (LangSmith-style).

Keeps a bounded queue of trace entries per chat id for live debugging:
``llm`` calls (model + tokens + error), ``prompt``
snapshots (full text + summary) and ``tool`` calls (name + args + result).
In-memory only, never persisted.
"""

from __future__ import annotations

import contextvars
import threading
import time
import uuid

MAX_ENTRIES_PER_CHAT = 200

_VALID_KINDS = ("llm", "prompt", "tool")

_lock = threading.Lock()
_store: dict[str, list[dict]] = {}

_current_chat: contextvars.ContextVar[str] = contextvars.ContextVar(
    "trace_current_chat", default=""
)

_current_turn: contextvars.ContextVar[int] = contextvars.ContextVar(
    "trace_current_turn", default=0
)

_turn_counter: dict[str, int] = {}

# Final status of the last finished turn per chat (turn continuity).
# Keyed ONLY by chat id so it survives turn increments and task_id changes.
# Shape: {"turn": int, "status": "completed"|"incomplete", "evidence": str,
#         "mode": str, "at": float}. Evidence is a short human-readable note
# (e.g. last test exit code + plan progress) the next turn can report from
# instead of re-executing finished work.
_TURN_OUTCOME: dict[str, dict] = {}
_VALID_OUTCOMES = ("completed", "incomplete")
_OUTCOME_EVIDENCE_LIMIT = 2000


def _clean_text(value: object, limit: int = 20000) -> str:
    try:
        text = str(value or "")
    except Exception:  # noqa: BLE001 — trace must never fail
        return ""
    text = text.replace("\r\n", "\n")
    if len(text) > limit:
        return text[:limit] + "\n…[truncated]"
    return text


def set_current_chat(chat_id: str):
    """Set the ambient chat id for this task; returns a token to reset."""
    return _current_chat.set((chat_id or "").strip())


def reset_current_chat(token) -> None:
    try:
        _current_chat.reset(token)
    except Exception:  # noqa: BLE001, S110 — reset must never fail
        pass


def get_current_chat() -> str:
    try:
        return str(_current_chat.get() or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def set_current_turn(turn: int):
    """Set the ambient turn number for this task; returns a token to reset."""
    try:
        return _current_turn.set(int(turn or 0))
    except Exception:  # noqa: BLE001 — trace must never fail
        return None


def reset_current_turn(token) -> None:
    try:
        if token is not None:
            _current_turn.reset(token)
    except Exception:  # noqa: BLE001, S110 — reset must never fail
        pass


def get_current_turn() -> int:
    try:
        return int(_current_turn.get() or 0)
    except Exception:  # noqa: BLE001
        return 0


def next_turn(chat_id: str) -> int:
    """Start a new turn for a chat. Returns the new turn number (1-based)."""
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return get_current_turn()
    with _lock:
        n = int(_turn_counter.get(cid, 0) or 0) + 1
        _turn_counter[cid] = n
    try:
        _current_turn.set(n)
    except Exception:  # noqa: BLE001, S110 — trace must never fail
        pass
    return n


def latest_turn(chat_id: str) -> int:
    """Latest turn number started for a chat (0 when unknown)."""
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return get_current_turn()
    with _lock:
        return int(_turn_counter.get(cid, 0) or 0)


def record_turn_outcome(
    chat_id: str,
    status: str,
    evidence: str = "",
    mode: str = "",
) -> dict | None:
    """Record the final status of the last finished turn for a chat.

    Keyed ONLY by chat id so it survives turn increments and task_id
    changes. ``status`` is ``"completed"`` or ``"incomplete"``; anything
    else normalizes to ``"incomplete"``. ``evidence`` is a short note
    (e.g. last test exit code + plan progress) the next turn can report
    from instead of re-executing finished work.
    """
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return None
    st = str(status or "").strip().lower()
    if st not in _VALID_OUTCOMES:
        st = "incomplete"
    ev = str(evidence or "").strip()
    if len(ev) > _OUTCOME_EVIDENCE_LIMIT:
        ev = ev[:_OUTCOME_EVIDENCE_LIMIT] + "\n…[truncated]"
    outcome = {
        "turn": int(latest_turn(cid) or get_current_turn() or 0),
        "status": st,
        "evidence": ev,
        "mode": str(mode or "").strip().lower()[:20],
        "at": time.time(),
    }
    with _lock:
        _TURN_OUTCOME[cid] = outcome
    return dict(outcome)


def previous_turn_outcome(chat_id: str) -> dict | None:
    """Return the recorded final status of the previous turn, if any."""
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return None
    with _lock:
        outcome = _TURN_OUTCOME.get(cid)
        return dict(outcome) if outcome else None


def format_turn_outcome_note(outcome: dict | None) -> str:
    """Format a prompt note carrying the previous turn outcome forward."""
    if not isinstance(outcome, dict):
        return ""
    status = str(outcome.get("status") or "").strip().lower()
    if status not in _VALID_OUTCOMES:
        return ""
    turn = outcome.get("turn", 0)
    mode = str(outcome.get("mode") or "").strip()
    evidence = str(outcome.get("evidence") or "").strip()
    label = f"turn {turn}" if turn else "previous turn"
    if mode:
        label += f" ({mode})"
    if status == "completed":
        note = (
            f"[Previous {label} finished: completed. "
            "Do NOT re-execute its finished work — report from the evidence below. "
            "Only run tools for NEW information this turn actually needs.]"
        )
    else:
        note = (
            f"[Previous {label} finished: incomplete. "
            "Continue exactly its pending work — do NOT restart completed steps.]"
        )
    if evidence:
        note += f"\nEvidence:\n{evidence}"
    return note


def append(
    chat_id: str,
    kind: str,
    summary: str,
    detail: dict | None = None,
    *,
    model: str = "",
    tokens: dict | None = None,
    error: str = "",
    prompt: str = "",
    result: str = "",
    task_id: str = "",
) -> dict | None:
    """Append one trace entry for a chat. Returns the entry or None."""
    cid = (chat_id or "").strip() or get_current_chat()
    k = (kind or "").strip().lower()
    if not cid or k not in _VALID_KINDS:
        return None
    turn = get_current_turn()
    if turn <= 0:
        turn = latest_turn(cid)
    detail_dict = dict(detail or {})
    tid = str(task_id or detail_dict.get("task_id") or "").strip()
    if tid:
        detail_dict["task_id"] = tid
    entry = {
        "id": uuid.uuid4().hex[:12],
        "at": time.time(),
        "kind": k,
        "turn": int(turn or 0),
        "task_id": tid,
        "summary": str(summary or "")[:500],
        "detail": detail_dict,
        "model": str(model or ""),
        "tokens": dict(tokens or {}),
        "error": str(error or "")[:2000],
        "prompt": _clean_text(prompt),
        "result": _clean_text(result),
    }
    with _lock:
        items = _store.get(cid, [])
        items.append(entry)
        if len(items) > MAX_ENTRIES_PER_CHAT:
            items = items[-MAX_ENTRIES_PER_CHAT:]
        _store[cid] = items
    return entry


def claim_running_tool(
    chat_id: str,
    name: str,
    sub: bool = False,
    extra_detail: dict | None = None,
) -> dict | None:
    """Reuse the running tool entry for the same call instead of duplicating it.

    The main agent loop appends a tool entry with the step number before
    execution, then the tool wrapper emits its own ``tool`` event for the
    SAME call. Claiming merges the wrapper fields (event call id, branch,
    sub) into the existing running entry — matched by tool name + turn,
    oldest unclaimed first — so each call shows exactly once in the
    panel. Oldest-first matters for parallel same-name calls (two greps in
    one step): the wrapper emits run in start order, so the first claim must
    take the first appended entry, not the most recent one. Args are
    deliberately NOT compared: the wrapper normalizes them (e.g. joins
    include/path lists) while the loop logs the raw model args.
    The ``sub`` flag keeps sub-agent streams off the main entries and the
    turn check keeps aborted-turn leftovers out of new turns.
    Returns the merged entry, or None when there is no match (caller appends).
    """
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return None
    want_name = str(name or "")
    want_sub = bool(sub)
    turn = get_current_turn()
    if turn <= 0:
        turn = latest_turn(cid)
    extra = dict(extra_detail or {})
    want_tid = str(extra.get("task_id") or "").strip()
    with _lock:
        items = _store.get(cid, [])
        for entry in items:
            if entry.get("kind") != "tool":
                continue
            detail = entry.get("detail") or {}
            if detail.get("status") != "running":
                continue
            if detail.get("ev_call_id"):
                continue
            if str(detail.get("name") or "") != want_name:
                continue
            if bool(detail.get("sub")) != want_sub:
                continue
            if want_tid:
                _e_tid = str(entry.get("task_id") or detail.get("task_id") or "").strip()
                if _e_tid != want_tid:
                    continue
            if turn and int(entry.get("turn") or 0) != int(turn):
                continue
            detail.update(extra)
            entry["detail"] = detail
            return dict(entry)
    return None


def finish_tool(
    chat_id: str,
    call_id: object,
    result: object,
    error: str = "",
    task_id: str = "",
) -> dict | None:
    """Attach a tool result to the matching running tool entry."""
    cid = (chat_id or "").strip() or get_current_chat()
    if not cid:
        return None
    want = str(call_id or "").strip()
    want_tid = str(task_id or "").strip()
    text = _clean_text(result, limit=20000)
    with _lock:
        items = _store.get(cid, [])
        if want:
            for entry in reversed(items):
                if entry.get("kind") != "tool":
                    continue
                detail = entry.get("detail") or {}
                if (
                    str(detail.get("call_id") or "").strip() == want
                    or str(detail.get("ev_call_id") or "").strip() == want
                    or str(entry.get("id") or "") == want
                ):
                    if want_tid:
                        _e_tid = str(entry.get("task_id") or detail.get("task_id") or "").strip()
                        if _e_tid != want_tid:
                            continue
                    entry["result"] = text
                    if error:
                        entry["error"] = str(error)[:2000]
                    detail["status"] = "error" if error else "done"
                    detail["result_chars"] = len(text)
                    entry["detail"] = detail
                    return dict(entry)
            if want_tid:
                for entry in reversed(items):
                    if entry.get("kind") != "tool":
                        continue
                    detail = entry.get("detail") or {}
                    if (
                        str(detail.get("call_id") or "").strip() == want
                        or str(detail.get("ev_call_id") or "").strip() == want
                        or str(entry.get("id") or "") == want
                    ):
                        entry["result"] = text
                        if error:
                            entry["error"] = str(error)[:2000]
                        detail["status"] = "error" if error else "done"
                        detail["result_chars"] = len(text)
                        entry["detail"] = detail
                        return dict(entry)
        # Fallback: latest running tool entry (or latest tool entry when the
        # caller never stamped status/call_id, e.g. direct append in tests).
        for entry in reversed(items):
            if entry.get("kind") == "tool" and (entry.get("detail") or {}).get("status") == "running":
                entry["result"] = text
                if error:
                    entry["error"] = str(error)[:2000]
                (entry.get("detail") or {}).update({"status": "error" if error else "done", "result_chars": len(text)})
                return dict(entry)
        for entry in reversed(items):
            if entry.get("kind") == "tool":
                entry["result"] = text
                if error:
                    entry["error"] = str(error)[:2000]
                detail = entry.get("detail") or {}
                detail.update({"status": "error" if error else "done", "result_chars": len(text)})
                entry["detail"] = detail
                return dict(entry)
    return None


def list_traces(chat_id: str, kind: str = "", task_id: str = "") -> list[dict]:
    """Return a copy of a chat's traces, optionally filtered by kind and task."""
    cid = (chat_id or "").strip()
    k = (kind or "").strip().lower()
    tid = (task_id or "").strip()
    with _lock:
        items = list(_store.get(cid, []))
    if k and k in _VALID_KINDS:
        items = [e for e in items if e.get("kind") == k]
    if tid:
        items = [
            e
            for e in items
            if str(e.get("task_id") or "") == tid
            or str((e.get("detail") or {}).get("task_id") or "") == tid
        ]
    return [dict(e) for e in items]


def clear(chat_id: str) -> int:
    """Drop all traces for a chat. Returns removed count."""
    cid = (chat_id or "").strip()
    with _lock:
        removed = len(_store.get(cid, []))
        _store.pop(cid, None)
        # Turn continuity state is per-chat too: dropping only the trace
        # entries left a stale outcome/turn counter behind, so a deleted or
        # cleared chat could later report another chat's "previous turn".
        _TURN_OUTCOME.pop(cid, None)
        _turn_counter.pop(cid, None)
    return removed
