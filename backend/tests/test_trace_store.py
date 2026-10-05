"""تست حافظه موقت لاگ هر چت (trace_store)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import trace_store


def test_append_and_list():
    trace_store.clear("c1")
    entry = trace_store.append("c1", "llm", "model · 10 tokens", detail={"route": "normal"})
    assert entry is not None
    items = trace_store.list_traces("c1")
    assert len(items) == 1
    assert items[0]["kind"] == "llm"
    assert items[0]["summary"] == "model · 10 tokens"


def test_kind_filter():
    trace_store.clear("c2")
    trace_store.append("c2", "llm", "a")
    trace_store.append("c2", "llm", "b")
    trace_store.append("c2", "prompt", "c")
    trace_store.append("c2", "tool", "d", prompt='{"x": 1}')
    assert len(trace_store.list_traces("c2", "llm")) == 2
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


def test_tool_claim_reuses_running_entry_no_duplicate():
    trace_store.clear("c6")
    trace_store.next_turn("c6")
    first = trace_store.append(
        "c6",
        "tool",
        "grep · step 1",
        detail={"name": "grep", "args": {"pattern": "x"}, "call_id": "lc-1", "step": 1, "status": "running"},
        prompt='{"pattern": "x"}',
    )
    assert first is not None
    # Wrapper normalizes args — matching ignores args, uses name + turn.
    claimed = trace_store.claim_running_tool(
        "c6", "grep", False, {"ev_call_id": "ev-7", "sub": False}
    )
    assert claimed is not None
    assert claimed["id"] == first["id"]
    assert claimed["detail"]["step"] == 1
    assert claimed["detail"]["ev_call_id"] == "ev-7"
    assert len(trace_store.list_traces("c6", "tool")) == 1
    # Second claim for the same call finds nothing (already claimed).
    assert trace_store.claim_running_tool("c6", "grep", False, {}) is None
    # Finish via the wrapper event id resolves the same single entry.
    done = trace_store.finish_tool("c6", "ev-7", "MATCHES")
    assert done is not None
    assert done["id"] == first["id"]
    assert done["result"] == "MATCHES"
    assert len(trace_store.list_traces("c6", "tool")) == 1


def test_tool_claim_miss_on_different_name_sub_or_turn():
    trace_store.clear("c7")
    trace_store.next_turn("c7")
    trace_store.append(
        "c7",
        "tool",
        "read · step 1",
        detail={"name": "read", "args": {"path": "a"}, "call_id": "lc-1", "step": 1, "status": "running"},
    )
    assert trace_store.claim_running_tool("c7", "grep", False, {}) is None
    assert trace_store.claim_running_tool("c7", "read", True, {}) is None
    trace_store.next_turn("c7")
    assert trace_store.claim_running_tool("c7", "read", False, {}) is None
    assert len(trace_store.list_traces("c7", "tool")) == 1


def test_tool_claim_parallel_same_name_keeps_order():
    trace_store.clear("c8")
    trace_store.next_turn("c8")
    first = trace_store.append(
        "c8",
        "tool",
        "grep · step 1",
        detail={"name": "grep", "args": {"pattern": "aaa"}, "call_id": "lc-1", "step": 1, "status": "running"},
    )
    second = trace_store.append(
        "c8",
        "tool",
        "grep · step 1",
        detail={"name": "grep", "args": {"pattern": "bbb"}, "call_id": "lc-2", "step": 1, "status": "running"},
    )
    assert first is not None and second is not None
    # Wrapper emits run in start order: first claim must take the first entry.
    c1 = trace_store.claim_running_tool("c8", "grep", False, {"ev_call_id": "ev-1"})
    c2 = trace_store.claim_running_tool("c8", "grep", False, {"ev_call_id": "ev-2"})
    assert c1 is not None and c2 is not None
    assert c1["id"] == first["id"], "first claim took the wrong entry"
    assert c2["id"] == second["id"], "second claim took the wrong entry"
    # Results resolve via the wrapper event ids onto the right entries.
    d1 = trace_store.finish_tool("c8", "ev-1", "AAA")
    d2 = trace_store.finish_tool("c8", "ev-2", "BBB")
    assert d1 is not None and d2 is not None
    assert d1["id"] == first["id"] and d1["result"] == "AAA"
    assert d2["id"] == second["id"] and d2["result"] == "BBB"
    assert len(trace_store.list_traces("c8", "tool")) == 2


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


def test_task_id_filter_isolates_subagent_trace():
    trace_store.clear("c9")
    trace_store.append("c9", "tool", "main call", detail={"name": "read"})
    trace_store.append("c9", "tool", "sub call", detail={"name": "grep"}, task_id="task-abc")
    assert len(trace_store.list_traces("c9")) == 2
    only_sub = trace_store.list_traces("c9", task_id="task-abc")
    assert len(only_sub) == 1
    assert only_sub[0]["summary"] == "sub call"
    assert only_sub[0]["task_id"] == "task-abc"
    assert trace_store.list_traces("c9", task_id="task-other") == []


def test_claim_and_finish_isolate_by_task_id():
    trace_store.clear("c10")
    trace_store.next_turn("c10")
    trace_store.append(
        "c10",
        "tool",
        "grep · step 1",
        detail={"name": "grep", "call_id": "lc-1", "step": 1, "status": "running", "sub": True},
        task_id="task-aaa",
    )
    trace_store.append(
        "c10",
        "tool",
        "grep · step 1",
        detail={"name": "grep", "call_id": "lc-2", "step": 1, "status": "running", "sub": True},
        task_id="task-bbb",
    )
    claimed = trace_store.claim_running_tool(
        "c10", "grep", True, {"ev_call_id": "ev-1", "sub": True, "task_id": "task-bbb"}
    )
    assert claimed is not None
    assert claimed["detail"]["task_id"] == "task-bbb"
    done = trace_store.finish_tool("c10", "ev-1", "BBB", task_id="task-bbb")
    assert done is not None
    assert done["result"] == "BBB"
    assert done["detail"]["task_id"] == "task-bbb"
    other = [e for e in trace_store.list_traces("c10") if e["detail"].get("task_id") == "task-aaa"]
    assert len(other) == 1
    assert other[0].get("result", "") != "BBB"
