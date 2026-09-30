"""Project repeated read-only results without changing the durable transcript."""

import json
import re
from collections.abc import Sequence

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

READ_ONLY_TOOLS = frozenset({"read", "grep", "glob"})

# Overlapping `read` windows. A read result looks like
#   <path>P</path>\n<type>file</type>\n<content>\nN | text\n...\n(footer)\n</content>
# (batch calls concatenate several such blocks). Later windows often re-cover
# lines an earlier result that is STILL in this request already shows
# (post-edit re-reads, "next 60 lines" probes, widened windows) and every such
# line is re-sent on every following step. Runs of rows that are byte-identical
# to an earlier row of the same file are replaced by a one-line range marker.
# Line numbers are explicit and the earlier full text is in the same request,
# so nothing is lost; the durable transcript is never touched.
_READ_BLOCK_RE = re.compile(
    r"(<path>(?P<path>[^\n]*?)</path>\n<type>file</type>\n<content>\n)"
    r"(?P<body>.*?)(?P<tail>\n</content>)",
    re.DOTALL,
)
_ROW_RE = re.compile(r"(\d+) \| ")
_MIN_OMIT_RUN = 8
_MIN_READ_CHARS = 800


def _omit_overlapping_rows(content: str, shown: dict[str, dict[int, str]]) -> str:
    def _sub(match: re.Match[str]) -> str:
        known = shown.setdefault(match.group("path"), {})
        rows = match.group("body").split("\n")
        numbers: list[int | None] = []
        for row in rows:
            m = _ROW_RE.match(row)
            numbers.append(int(m.group(1)) if m else None)
        dup = [n is not None and known.get(n) == row for n, row in zip(numbers, rows)]
        out: list[str] = []
        changed = False
        i = 0
        while i < len(rows):
            if not dup[i]:
                out.append(rows[i])
                i += 1
                continue
            j = i
            while j < len(rows) and dup[j]:
                j += 1
            if j - i >= _MIN_OMIT_RUN:
                out.append(
                    f"[lines {numbers[i]}-{numbers[j - 1]} identical to an earlier "
                    "read of this file above; omitted]"
                )
                changed = True
            else:
                out.extend(rows[i:j])
            i = j
        for n, row in zip(numbers, rows):
            if n is not None:
                known[n] = row
        if not changed:
            return match.group(0)
        return match.group(1) + "\n".join(out) + match.group("tail")

    return _READ_BLOCK_RE.sub(_sub, content)


def stable_tool_order(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """Stable order of tool messages for prompt caching.

    Single source of truth for both the main-agent loop (graph.py) and the
    sub-agent loop (llm.py): only consecutive ``ToolMessage`` runs are
    sorted by ``tool_call_id`` so parallel-execution permutations do not
    break the prompt-cache prefix. All other messages keep their order.
    """
    out: list[BaseMessage] = []
    run: list[BaseMessage] = []

    def _flush() -> None:
        if len(run) > 1:
            try:
                run.sort(key=lambda m: str(getattr(m, "tool_call_id", "") or ""))
            except Exception:  # noqa: BLE001, S110 — best-effort ordering
                pass
        out.extend(run)
        run.clear()

    for m in messages or []:
        if isinstance(m, ToolMessage):
            run.append(m)
            continue
        _flush()
        out.append(m)
    _flush()
    return out


def project_tool_results(
    messages: Sequence[BaseMessage],
    *,
    read_only_tools: frozenset[str] = READ_ONLY_TOOLS,
    min_chars: int = 512,
) -> list[BaseMessage]:
    """Keep a full reference in this request for every shortened duplicate."""
    calls: dict[str, tuple[str, str]] = {}
    originals: dict[tuple[str, str, str], str] = {}
    projected: list[BaseMessage] = []
    seen_tool_result_ids: set[str] = set()
    shown_rows: dict[str, dict[int, str]] = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                name, call_id = call.get("name"), call.get("id")
                if name not in read_only_tools or not call_id:
                    continue
                try:
                    args = json.dumps(call.get("args", {}), sort_keys=True, ensure_ascii=False)
                except (TypeError, ValueError):
                    continue
                calls[call_id] = (name, args)
        elif isinstance(message, ToolMessage):
            call_id = str(message.tool_call_id or "")
            if call_id and call_id in seen_tool_result_ids:
                continue
            if call_id:
                seen_tool_result_ids.add(call_id)
            signature = calls.get(message.tool_call_id)
            content = message.content
            if (
                signature is not None
                and (not message.name or message.name == signature[0])
                and message.status == "success"
                and isinstance(content, str)
                and len(content) >= min_chars
                and not content.lstrip().upper().startswith(("ERROR", "INVALID PATH"))
            ):
                key = (*signature, content)
                original_id = originals.get(key)
                if original_id is None:
                    originals[key] = message.tool_call_id
                else:
                    reference = (
                        f"نتیجه عیناً با پاسخ ابزار {original_id} در همین پیام‌ها یکسان است؛ "
                        "متن کامل همان پاسخ را استفاده کن."
                    )
                    if len(reference) < len(content):
                        message = message.model_copy(update={"content": reference})
            if (
                signature is not None
                and signature[0] == "read"
                and message.status == "success"
                and isinstance(message.content, str)
                and len(message.content) >= _MIN_READ_CHARS
                and "<type>file</type>" in message.content
            ):
                trimmed = _omit_overlapping_rows(message.content, shown_rows)
                if trimmed != message.content:
                    message = message.model_copy(update={"content": trimmed})
        projected.append(message)
    return projected
