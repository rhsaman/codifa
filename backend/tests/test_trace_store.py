"""تست حافظه موقت لاگ هر چت (trace_store)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import trace_store


def test_append_and_list():
    trace_store.clear("c1")
    entry = trace_store.append("c1", "laya", "normal · 90٪", detail={"route": "normal"})
    assert entry is not None
    items = trace_store.list_traces("c1")
    assert len(items) == 1
    assert items[0]["kind"] == "laya"
    assert items[0]["summary"] == "normal · 90٪"


def test_kind_filter():
    trace_store.clear("c2")
    trace_store.append("c2", "laya", "a")
    trace_store.append("c2", "llm", "b")
    trace_store.append("c2", "prompt", "c")
    trace_store.append("c2", "tool", "d", prompt='{"x": 1}')
    assert len(trace_store.list_traces("c2", "llm")) == 1
    assert len(trace_store.list_traces("c2", "tool")) == 1
    assert len(trace_store.list_traces("c2")) == 4


def test_tool_result_and_ambient_chat():
    trace_store.clear("c4")
    token = trace_store.set_current_chat("c4")
    try:
        entry = trace_store.append("", "tool", "read", prompt='{"path": "a"}')
        assert entry is not None
        done = trace_store.finish_tool("", entry["detail"].get("call_id") or entry["id"], "ok-result")
        assert done is not None
        assert done["result"] == "ok-result"
    finally:
        trace_store.reset_current_chat(token)
    items = trace_store.list_traces("c4", "tool")
    assert len(items) == 1
    assert items[0]["result"] == "ok-result"


def test_llm_always_logged_without_usage():
    trace_store.clear("c5")
    entry = trace_store.append("c5", "llm", "m · 0 tokens", prompt="[user]\nhello")
    assert entry is not None
    assert entry["prompt"] == "[user]\nhello"
    assert trace_store.list_traces("c5", "llm")[0]["prompt"] == "[user]\nhello"


def test_cap_and_invalid():
    trace_store.clear("c3")
    assert trace_store.append("", "llm", "x") is None
    assert trace_store.append("c3", "nope", "x") is None
    for i in range(trace_store.MAX_ENTRIES_PER_CHAT + 10):
        trace_store.append("c3", "llm", f"m{i}")
    items = trace_store.list_traces("c3")
    assert len(items) == trace_store.MAX_ENTRIES_PER_CHAT
    assert trace_store.clear("c3") == trace_store.MAX_ENTRIES_PER_CHAT
    assert trace_store.list_traces("c3") == []
