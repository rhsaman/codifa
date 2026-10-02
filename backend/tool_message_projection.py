"""Project repeated read-only results without changing the durable transcript."""

import json
import posixpath
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


_READ_LEDGER_MAX_FILES = 8
_READ_LEDGER_MAX_CHARS = 500
_READ_LEDGER_MAX_RANGES_PER_FILE = 4


def context_ledger_line(messages: Sequence[BaseMessage]) -> str:
    """One-line summary of read windows already present in these messages.

    Built from live messages only: files whose content was compacted away
    are simply absent, so the line never claims coverage it cannot show.
    Returns "" when there is nothing worth saying (no reads, or a single
    file with a single window — that result speaks for itself).
    """
    covered: dict[str, list[list[int]]] = {}
    order: list[str] = []
    for message in messages or []:
        if not isinstance(message, ToolMessage):
            continue
        if getattr(message, "status", "success") != "success":
            continue
        content = message.content
        if not isinstance(content, str):
            continue
        for block in _READ_BLOCK_RE.finditer(content):
            path = (block.group("path") or "").strip()
            if not path:
                continue
            nums: list[int] = []
            for row in block.group("body").split("\n"):
                m = _ROW_RE.match(row)
                if m:
                    try:
                        nums.append(int(m.group(1)))
                    except ValueError:
                        continue
            if not nums:
                continue
            bucket = covered.setdefault(path, [])
            if path not in order:
                order.append(path)
            for n in sorted(set(nums)):
                if bucket and n <= bucket[-1][1] + 1:
                    bucket[-1][1] = max(bucket[-1][1], n)
                else:
                    bucket.append([n, n])
    if len(order) < 1:
        return ""
    if len(order) == 1 and len(covered[order[0]]) == 1:
        return ""
    prefix = "[already in context \u2014 do NOT re-read: "
    suffix = "]"
    parts: list[str] = []
    added = 0
    for path in order:
        wins = covered[path]
        shown = wins[:_READ_LEDGER_MAX_RANGES_PER_FILE]
        text = ",".join(
            f"{a}-{b}" if a != b else f"{a}" for a, b in shown
        )
        if len(wins) > len(shown):
            text += f" (+{len(wins) - len(shown)} more)"
        cand = f"{path} {text}"
        if len(prefix + " | ".join([*parts, cand]) + suffix) > _READ_LEDGER_MAX_CHARS:
            if not parts:
                budget = _READ_LEDGER_MAX_CHARS - len(prefix) - len(suffix) - 3
                parts.append(cand[: max(0, budget)] + "...")
                added += 1
            continue
        parts.append(cand)
        added += 1
    # Files after the first overflow fold into a counter, keeping the line
    # within budget without ever cutting a range mid-token.
    skipped = len(order) - added
    if skipped > 0:
        parts.append(f"(+{skipped} more)")
    return prefix + " | ".join(parts) + suffix


_GREP_HIT_RE = re.compile(r"^MATCHES for (.*?)\s*$")
_GREP_MISS_RE = re.compile(r"^No matches for (.*?) under (.*?)\s*$")
_GREP_FOUND_RE = re.compile(r"Found (\d+) matches")
_GLOB_HIT_RE = re.compile(r"^GLOB MATCHES for (.*?)\s*$")
_GLOB_MISS_RE = re.compile(r"^No files match (.*?) under (.*?)\.\s*$")
_GLOB_FOUND_RE = re.compile(r"\((\d+) matches found")
_SEARCH_LEDGER_MAX_ITEMS = 6
_SEARCH_LEDGER_MAX_CHARS = 400
_SEARCH_LEDGER_MAX_PAT = 60


def _unquote(text: str) -> str:
    text = (text or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def search_ledger_line(messages: Sequence[BaseMessage]) -> str:
    """One-line summary of grep/glob searches already run in these messages.

    The model re-searches patterns it already ran (results seen, then
    forgotten two steps later). Live messages only: a search whose result
    was compacted away is simply absent, so the line never claims results
    it cannot show. Silent until at least two searches ran — a single
    search followed by action is the normal flow, not waste.
    """
    calls: dict[str, tuple[str, dict]] = {}
    for message in messages or []:
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            name = call.get("name")
            if name in ("grep", "glob") and call.get("id"):
                calls[call["id"]] = (name, call.get("args") or {})
    if len(calls) < 2:
        return ""
    items: list[str] = []
    seen: set[str] = set()
    for message in messages or []:
        if not isinstance(message, ToolMessage):
            continue
        if getattr(message, "status", "success") != "success":
            continue
        content = message.content
        if not isinstance(content, str):
            continue
        sig = calls.get(str(message.tool_call_id or ""))
        if sig is None:
            continue
        name, args = sig
        head = content.split("\n", 1)[0]
        item = ""
        if name == "grep":
            m = _GREP_HIT_RE.match(head)
            if m:
                found = _GREP_FOUND_RE.search(content)
                outcome = f"{found.group(1)} hits" if found else "hits"
                item = _search_item(name, args, _unquote(m.group(1)), outcome)
            else:
                m = _GREP_MISS_RE.match(head)
                if m:
                    item = _search_item(name, args, _unquote(m.group(1)), "no matches")
        else:
            m = _GLOB_HIT_RE.match(head)
            if m:
                found = _GLOB_FOUND_RE.search(content)
                outcome = f"{found.group(1)} hits" if found else "hits"
                item = _search_item(name, args, _unquote(m.group(1)), outcome)
            else:
                m = _GLOB_MISS_RE.match(head)
                if m:
                    item = _search_item(name, args, _unquote(m.group(1)), "no matches")
        if item and item not in seen:
            seen.add(item)
            items.append(item)
    if not items:
        return ""
    prefix = "[already searched — do NOT re-search: "
    suffix = "]"
    shown = items[:_SEARCH_LEDGER_MAX_ITEMS]
    parts: list[str] = []
    for item in shown:
        if len(prefix + " | ".join([*parts, item]) + suffix) > _SEARCH_LEDGER_MAX_CHARS:
            break
        parts.append(item)
    skipped = len(items) - len(parts)
    if skipped > 0:
        parts.append(f"(+{skipped} more)")
    return prefix + " | ".join(parts) + suffix


def _search_item(name: str, args: dict, pattern: str, outcome: str) -> str:
    """Compact `grep 'pat' in scope (filter): outcome` for the ledger."""
    try:
        scope = str(args.get("path") or "").strip() or "/"
    except Exception:  # noqa: BLE001 — display-only
        scope = "/"
    try:
        extra_scopes = args.get("paths") or []
        if isinstance(extra_scopes, str):
            extra_scopes = [extra_scopes]
        extra_n = len(list(extra_scopes))
        if extra_n > 0:
            scope += f" +{extra_n}"
    except Exception:  # noqa: BLE001, S110 — display-only
        pass
    filt = ""
    try:
        inc = str(args.get("include") or "").strip()
        if inc:
            filt = f" ({inc})"
    except Exception:  # noqa: BLE001, S110 — display-only
        pass
    pat = (pattern or "").strip()
    if len(pat) > _SEARCH_LEDGER_MAX_PAT:
        pat = pat[: _SEARCH_LEDGER_MAX_PAT - 3] + "..."
    return f"{name} '{pat}' in {scope}{filt}: {outcome}"


def _live_key(path: str) -> str:
    try:
        return posixpath.normpath(str(path).strip())
    except Exception:  # noqa: BLE001 — lookup only
        return str(path).strip()


_HISTORY_ROW_FIRST_RE = re.compile(r"^(?P<path>.+?): (?P<n>\d+) \| ")


def live_read_lines(messages: Sequence[BaseMessage], path: str) -> frozenset[int]:
    """Line numbers of ``path`` whose text is present in ``messages`` right now.

    A cross-turn "already in context" stub is only honest when the rows are in
    the CALLING agent's transcript. Two shapes carry rows: live read results
    (``<path>..</path>`` blocks) and read results rebuilt from a previous
    turn's saved activity (``path: N | text`` then ``N | text`` rows, capped
    per item). Another chat, a sub-agent, and trimmed or compacted results
    contribute nothing, so they can never be claimed as covered.
    """
    key = _live_key(path)
    out: set[int] = set()
    for message in messages or []:
        if not isinstance(message, ToolMessage):
            continue
        if getattr(message, "status", "success") != "success":
            continue
        content = message.content
        if not isinstance(content, str) or " | " not in content:
            continue
        if "<type>file</type>" in content:
            for block in _READ_BLOCK_RE.finditer(content):
                if _live_key(block.group("path") or "") != key:
                    continue
                for row in block.group("body").split("\n"):
                    m = _ROW_RE.match(row)
                    if m:
                        out.add(int(m.group(1)))
            continue
        current = ""
        for row in content.split("\n"):
            first = _HISTORY_ROW_FIRST_RE.match(row)
            if first:
                current = _live_key(first.group("path"))
                if current == key:
                    out.add(int(first.group("n")))
                continue
            if current == key:
                m = _ROW_RE.match(row)
                if m:
                    out.add(int(m.group(1)))
    return frozenset(out)


def live_grep_heads(messages: Sequence[BaseMessage]) -> list[str]:
    """First line (``MATCHES for '...'``) of every live grep result."""
    heads: list[str] = []
    for message in messages or []:
        if not isinstance(message, ToolMessage):
            continue
        if getattr(message, "status", "success") != "success":
            continue
        content = message.content
        if isinstance(content, str) and content.startswith("MATCHES for "):
            heads.append(content.split("\n", 1)[0])
    return heads
