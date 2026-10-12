"""Persistent goal (/goal) judge and prompt helpers.

Claude-style completion-condition judge: after every turn a small fast model
(the compact/subagent slot) grades the goal against the ASSISTANT's work only
— never the user's messages — and answers ``met`` / ``not_met`` /
``impossible`` with a short reason. The reason is fed to the next turn as
guidance. Any judge failure resolves to ``not_met`` (fail closed), never to a
keyword heuristic.
"""

from __future__ import annotations

import inspect
import json
import re

try:
    import asyncio as _asyncio
except Exception:  # noqa: BLE001 — asyncio is stdlib; defensive only
    _asyncio = None  # type: ignore[assignment]

# Bound on extra auto-continue turns requested for an unmet goal.
# Enforced server-side in graph.done_node AND mirrored client-side in
# Chat.tsx (MAX_GOAL_TURNS) so a missing/old client can never spin forever.
GOAL_MAX_EXTRA_TURNS = 15

# Cap on the transcript handed to the judge model (chars, tail-kept).
GOAL_JUDGE_TRANSCRIPT_CHARS = 12000

# Kept for backward compatibility with older clients/tests. The production
# path (graph.done_node) no longer uses keyword signals.
_COMPLETION_SIGNALS = (
    "all tests pass",
    "tests pass",
    "tests passing",
    "task complete",
    "task completed",
    "goal met",
    "done",
    "completed",
    "complete",
    "fixed",
    "implemented",
    "verified",
)

_IMPOSSIBLE_SIGNALS = (
    "impossible",
    "cannot be done",
    "can't be done",
    "unable to achieve",
    "not possible",
    "unachievable",
    "blocked",
)

_STOPWORDS = frozenset(
    {
        "the", "and", "with", "from", "that", "this", "have", "will",
        "your", "into", "over", "under", "while", "when", "then",
        "than", "such", "only", "also", "just", "like", "make",
        "made", "does", "doing", "done", "what", "which", "their",
        "there", "here", "were", "been", "being", "about", "after",
        "before", "between", "should", "could", "would",
    }
)

# Visible markers the backend appends to the assistant reply. They must never
# reach the judge (feedback loop) and never count as evidence of completion.
_GOAL_MARKER_RE = re.compile(
    r"\[GOAL (?:CONTINUES|CLEARED|PAUSED|IMPOSSIBLE)\][^\n]*",
    re.IGNORECASE,
)

# Frontend loop pings that quote the condition verbatim. Judging them would
# clear every goal after ~2 turns (the ping IS the condition text).
_GOAL_PING_PREFIXES = (
    "continue working on the persistent goal:",
    "follow this persistent goal",
)

GOAL_JUDGE_SYSTEM = (
    "You judge whether a coding agent has achieved a standing goal. "
    "Answer ONLY with a JSON object of the form "
    '{"status": "met" | "not_met" | "impossible", "reason": "<one short sentence>"}. '
    "Rules: 'met' ONLY when the transcript shows concrete evidence the goal is "
    "done (passing test output, verified file changes, quoted results) — never "
    "because the goal text is merely mentioned, planned, or promised. "
    "'impossible' ONLY when further attempts clearly cannot succeed (missing "
    "credentials/access, nonexistent target, explicit hard blocker) — not for "
    "transient errors, rate limits, or user interruptions. Otherwise 'not_met', "
    "with 'reason' stating the single most useful next step. "
    "Judge the work in ANY language (including Persian). Keep 'reason' under 25 words."
)


def normalize_goal(goal: str | dict | None) -> str:
    """Normalize a str|dict|None goal value to plain condition text."""
    if goal is None:
        return ""
    if isinstance(goal, dict):
        raw = goal.get("condition", "")
        return str(raw or "").strip()
    if isinstance(goal, str):
        return goal.strip()
    return str(goal).strip()


def format_goal_block(condition: str) -> str:
    """Return a short system-prompt block for the active goal."""
    text = (condition or "").strip() if isinstance(condition, str) else str(condition or "").strip()
    return (
        f"ACTIVE GOAL: {text}\n"
        "Keep working toward this goal until its completion condition is met. "
        "Stay focused on the goal and report progress concisely."
    )


def _strip_markers(text: str) -> str:
    """Remove backend [GOAL ...] marker lines from judged text."""
    try:
        return _GOAL_MARKER_RE.sub("", text or "").strip()
    except Exception:  # noqa: BLE001 — stripping never breaks judging
        return text or ""


def _is_goal_ping(text: str) -> bool:
    """True when an entry is the frontend's own loop ping, not real work."""
    try:
        lowered = (text or "").strip().lower()
        return any(lowered.startswith(p) for p in _GOAL_PING_PREFIXES)
    except Exception:  # noqa: BLE001
        return False


def _tool_text(entry: dict) -> str:
    """Render an entry's tool evidence as plain text for the judge."""
    parts: list[str] = []
    try:
        for act in entry.get("toolActivity") or []:
            if not isinstance(act, dict):
                continue
            if act.get("status") == "running":
                continue
            tool = str(act.get("tool") or "")
            summary = str(act.get("summary") or "")
            if tool or summary:
                parts.append(f"[{tool}] {summary}".strip())
            diff = act.get("diff")
            if isinstance(diff, str) and diff.strip():
                parts.append(diff.strip()[:2000])
        preserved = entry.get("preservedToolSummary")
        if isinstance(preserved, str) and preserved.strip():
            parts.append(preserved.strip()[:2000])
    except Exception:  # noqa: BLE001, S110 — evidence is best-effort
        pass
    return "\n".join(p for p in parts if p)


def build_goal_transcript(
    history: list | None,
    final_response: str = "",
    max_chars: int = GOAL_JUDGE_TRANSCRIPT_CHARS,
) -> str:
    """Build the judge transcript from ASSISTANT work only.

    User messages are excluded entirely: they contain the goal condition
    verbatim (``/goal X`` setup plus every ``Continue working...`` ping), and
    judging them clears every goal after ~2 turns without any work done.
    Backend ``[GOAL ...]`` markers are stripped to avoid a feedback loop.
    Tail-kept to ``max_chars`` so the judge call stays cheap.
    """
    chunks: list[str] = []
    try:
        items = history if isinstance(history, list) else []
        for entry in items[-8:]:
            if not isinstance(entry, dict):
                continue
            role = str(entry.get("role") or "").lower()
            if role == "user":
                continue
            content = _strip_markers(str(entry.get("content") or ""))
            if content and not _is_goal_ping(content):
                chunks.append(content)
            tools = _tool_text(entry)
            if tools:
                chunks.append(_strip_markers(tools))
    except Exception:  # noqa: BLE001, S110 — transcript is best-effort
        pass
    try:
        final = _strip_markers(str(final_response or ""))
        if final:
            chunks.append(final)
    except Exception:  # noqa: BLE001, S110
        pass
    text = "\n\n".join(c for c in chunks if c and c.strip()).strip()
    try:
        limit = int(max_chars) if max_chars else GOAL_JUDGE_TRANSCRIPT_CHARS
    except (TypeError, ValueError):
        limit = GOAL_JUDGE_TRANSCRIPT_CHARS
    if limit > 0 and len(text) > limit:
        text = text[-limit:]
    return text


def parse_goal_judge_output(text: str) -> dict | None:
    """Parse a ``{status, reason}`` verdict from raw judge model output.

    Returns ``None`` when unparseable (caller fails closed to ``not_met``).
    """
    try:
        raw = (text or "").strip()
        if not raw:
            return None
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        data = json.loads(raw[start : end + 1])
        if not isinstance(data, dict):
            return None
        status = str(data.get("status", "")).strip().lower()
        reason = str(data.get("reason", "") or "").strip()
        if status not in ("met", "not_met", "impossible"):
            return None
        return {"status": status, "reason": reason or "Judge verdict."}
    except Exception:  # noqa: BLE001 — unparseable means not_met
        return None


def _extract_keywords(text: str) -> list[str]:
    """Extract significant lowercase keywords (len >= 4, no stopwords)."""
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    seen: list[str] = []
    for word in words:
        if len(word) < 4 or word in _STOPWORDS:
            continue
        if word not in seen:
            seen.append(word)
    return seen


def _heuristic_judge(condition: str, transcript: str) -> dict:
    """Legacy keyword heuristic. Kept for offline unit tests only.

    The production path (graph.done_node) uses the LLM judge and fails
    closed to ``not_met`` — this heuristic is intentionally NOT consulted
    there (verbatim self-quotes, ASCII-only keywords, and substring
    completion signals all misjudge real goals).
    """
    cond = (condition or "").strip()
    text = (transcript or "").strip()
    if not cond:
        return {"status": "not_met", "reason": "Empty goal condition."}
    if not text:
        return {"status": "not_met", "reason": "Empty transcript — goal not yet met."}
    lower_cond = cond.lower()
    lower_text = text.lower()
    # Verbatim condition mention counts as met (caller quotes the condition).
    if lower_cond and lower_cond in lower_text:
        return {"status": "met", "reason": "Transcript states the completion condition."}
    for signal in _IMPOSSIBLE_SIGNALS:
        if signal in lower_text:
            return {"status": "impossible", "reason": f"Transcript reports: {signal}."}
    keywords = _extract_keywords(cond)
    if not keywords:
        # Short condition with no significant keywords: fall back to word overlap.
        short = [w for w in re.findall(r"[a-z0-9]+", lower_cond) if len(w) >= 3]
        if not short:
            return {"status": "not_met", "reason": "Goal not yet met."}
        hits = sum(1 for w in short if w in lower_text)
        if hits / max(len(short), 1) >= 0.6:
            return {"status": "met", "reason": "Transcript covers the goal terms."}
        return {"status": "not_met", "reason": "Goal not yet met."}
    hits = sum(1 for kw in keywords if kw in lower_text)
    ratio = hits / max(len(keywords), 1)
    has_completion = any(sig in lower_text for sig in _COMPLETION_SIGNALS)
    if ratio >= 0.6 or (ratio >= 0.4 and has_completion):
        return {"status": "met", "reason": "Transcript covers the goal terms."}
    return {"status": "not_met", "reason": "Goal not yet met."}


def judge_goal(condition: str, transcript: str, llm_call=None) -> dict:
    """Judge whether the goal condition is met.

    Uses the optional ``llm_call`` hook when provided, otherwise falls back
    to the local heuristic. ``llm_call`` may be sync or async and must accept
    ``(condition, transcript)`` and return ``{"status": ..., "reason": ...}``.
    Always returns ``{"status": "met"|"not_met"|"impossible", "reason": str}``.
    """
    cond = condition if isinstance(condition, str) else str(condition or "")
    text = transcript if isinstance(transcript, str) else str(transcript or "")
    if llm_call is not None:
        try:
            result = llm_call(cond, text)
            if inspect.isawaitable(result):
                try:
                    _asyncio.get_running_loop()
                except RuntimeError:
                    result = _asyncio.run(result)
                else:
                    # Inside a running loop we cannot block: use heuristic.
                    return _heuristic_judge(cond, text)
            if isinstance(result, dict):
                status = str(result.get("status", "")).strip()
                reason = str(result.get("reason", "") or "")
                if status in ("met", "not_met", "impossible"):
                    return {"status": status, "reason": reason or "LLM judge."}
        except Exception:  # noqa: BLE001, S110 — hook must never break the judge
            pass
    return _heuristic_judge(cond, text)
