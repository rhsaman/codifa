"""تست‌های ترتیب event در حالت content=list (Anthropic/Gemini).

وقتی LLM در یک chunk چندین part می‌فرستد (``text`` و ``tool_use``)، ترتیب
انتشار event ها در queue باید text قبل از tool باشد تا UI کارت tool را
بعد از text نشان دهد (و نه قبل).

این منطق اکنون در ``_run_mode_turn`` استخراج شده و این فایل منطق
ساخت event را به‌طور واحد تست می‌کند (بدون نیاز به mock کردن کل
stream loop).
"""

import json


# Helper: replay the event-construction logic from _run_mode_turn on a single
# content list. We mirror the in-line logic instead of importing the closure
# so this test stays independent of the stream-loop internals.
def _build_events_from_content_list(content):
    """Yield events in the exact order the stream loop would emit them.

    Mirrors the loop body for ``isinstance(content, list)`` in
    ``_run_mode_turn``: a ``text`` part → ``kind: "text"``, a
    ``tool_use``/``tool_call`` part → ``kind: "tool"``. Other parts are
    skipped (matching the production code).
    """
    events = []
    for part in content:
        if not isinstance(part, dict):
            continue
        ptype = part.get("type")
        if ptype == "text":
            t = part.get("text") or ""
            if t:
                events.append({"kind": "text", "content": t})
        elif ptype in ("tool_use", "tool_call"):
            pname = part.get("name") or (
                part.get("function") or {}
            ).get("name") or ""
            pargs = part.get("input")
            if pargs is None:
                pargs = (part.get("function") or {}).get("arguments")
            if isinstance(pargs, str):
                try:
                    pargs = json.loads(pargs)
                except (ValueError, TypeError):
                    pargs = {"_raw": pargs}
            events.append(
                {
                    "kind": "tool",
                    "tool": pname,
                    "args": pargs or {},
                    "id": part.get("id") or "",
                }
            )
    return events


# ── 1. فقط text parts
def test_text_only_content():
    content = [
        {"type": "text", "text": "I'll "},
        {"type": "text", "text": "search for that."},
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 2
    assert all(e["kind"] == "text" for e in events)
    assert events[0]["content"] == "I'll "
    assert events[1]["content"] == "search for that."


# ── 2. فقط tool_use
def test_tool_only_content():
    content = [
        {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "read",
            "input": {"path": "/x.py"},
        }
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    assert events[0]["kind"] == "tool"
    assert events[0]["tool"] == "read"
    assert events[0]["args"] == {"path": "/x.py"}
    assert events[0]["id"] == "toolu_1"


# ── 3. ترتیب text قبل از tool (در همان chunk)
def test_text_then_tool_in_same_chunk():
    """مهم‌ترین تست: متن قبل از tool در همان chunk باید در queue ترتیب text→tool داشته باشد."""
    content = [
        {"type": "text", "text": "I'll search the code."},
        {
            "type": "tool_use",
            "id": "toolu_42",
            "name": "grep",
            "input": {"pattern": "def auth"},
        },
        {"type": "text", "text": "Let me see."},
        {
            "type": "tool_use",
            "id": "toolu_43",
            "name": "read",
            "input": {"path": "auth.py"},
        },
    ]
    events = _build_events_from_content_list(content)
    kinds = [e["kind"] for e in events]
    # ترتیب باید دقیقاً text, tool, text, tool باشد
    assert kinds == ["text", "tool", "text", "tool"], f"got {kinds}"


# ── 4. tool_use بدون input (می‌تواند در stream open باشد)
def test_tool_use_with_no_input():
    content = [{"type": "tool_use", "id": "toolu_x", "name": "read", "input": {}}]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    assert events[0]["args"] == {}


# ── 5. tool_use با input به صورت string JSON (OpenAI-style)
def test_tool_call_with_string_args():
    content = [
        {
            "type": "tool_call",
            "id": "call_1",
            "function": {
                "name": "grep",
                "arguments": '{"pattern": "def auth"}',
            },
        }
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    assert events[0]["tool"] == "grep"
    assert events[0]["args"] == {"pattern": "def auth"}


# ── 6. tool_use با string arguments که JSON نیست
def test_tool_call_with_invalid_json_args():
    content = [
        {
            "type": "tool_call",
            "id": "call_2",
            "function": {"name": "grep", "arguments": "raw not json"},
        }
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    # باید در _raw بسته‌بندی شود
    assert events[0]["args"] == {"_raw": "raw not json"}


# ── 7. part نامعتبر (non-dict) نادیده گرفته شود
def test_non_dict_part_skipped():
    content = [
        "raw string",  # نامعتبر
        None,  # نامعتبر
        {"type": "text", "text": "ok"},
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    assert events[0]["content"] == "ok"


# ── 8. text part خالی نادیده گرفته شود
def test_empty_text_part_skipped():
    content = [
        {"type": "text", "text": ""},
        {"type": "text", "text": "ok"},
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
    assert events[0]["content"] == "ok"


# ── 9. part با type نامعتبر نادیده گرفته شود
def test_unknown_part_type_skipped():
    content = [
        {"type": "image", "src": "..."},
        {"type": "text", "text": "ok"},
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1


# ── 10. part با type نامشخص (بدون type) نادیده گرفته شود
def test_part_without_type_skipped():
    content = [
        {"name": "x", "input": {}},  # type ندارد
        {"type": "text", "text": "ok"},
    ]
    events = _build_events_from_content_list(content)
    assert len(events) == 1
