"""Live + unit tests for the LangGraph-checkpointer interrupted-turn resume.

This replaces the old custom JSONL "resume file" with LangGraph's native
``AsyncSqliteSaver`` checkpointer. The full in-flight transcript (every completed
tool call + its result) is persisted to the checkpointer keyed per chat; on a
reconnect/interrupt the transcript is reloaded so the turn CONTINUES instead of
redoing work. Because the replayed results keep their ORIGINAL tool_call ids, the
loop's result-dedup (by name+args signature) reuses them instead of re-running
identical greps — which is exactly what previously caused the repetition loop.

Run standalone (``python backend/tests/test_resume.py``) or via
``python backend/tests/run_tests.py``.
"""
import asyncio
import json
import os
import tempfile

# Hermetic data root BEFORE importing anything that touches state_db.
_TMP = tempfile.mkdtemp(prefix="coder-test-resume-data-")
os.environ["CODER_DATA_DIR"] = _TMP

# Import the harness FIRST — it puts the repo backend dir on sys.path so the
# backend modules below resolve wherever the tests run from.
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from mock_openai import (
    mock,
    start_server,
    stop_server,
    text_reply,
    tool_call,
)

from agents import run_agent
from graph import (
    _clear_turn_checkpoint,
    _load_turn_checkpoint,
    _resume_checkpoint_path,
    _resume_thread_id,
    _save_turn_checkpoint,
    clear_chat_resume_checkpoint,
    prune_stale_resume_checkpoints,
)


async def run_turn(**kw):
    events = []
    async for ev in run_agent(**kw):
        events.append(ev)
    return events


def make_workspace():
    ws = tempfile.mkdtemp(prefix="coder-test-resume-ws-")
    with open(os.path.join(ws, "app.py"), "w") as fh:
        fh.write("def foo():\n    return 42\n")
    return ws


async def _save_ckpt_with_ts(thread_id: str, ts_iso: str, content: str = "x") -> None:
    """Save a checkpoint with a caller-controlled ``ts`` (to simulate age)."""
    from langchain_core.messages import HumanMessage
    from langgraph.checkpoint.base import empty_checkpoint
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    ckpt = empty_checkpoint()
    ckpt["ts"] = ts_iso
    ckpt["channel_values"] = {"messages": [HumanMessage(content=content)]}
    ckpt["channel_versions"] = {"messages": "v1"}
    ckpt["versions_seen"] = {}
    async with AsyncSqliteSaver.from_conn_string(_resume_checkpoint_path()) as saver:
        await saver.aput(
            {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}},
            ckpt,
            {"step": 1, "source": "input", "writes": {}},
            {"messages": "v1"},
        )


async def main():
    task, base = await start_server()
    try:
        ws = make_workspace()

        # ==== Unit: checkpointer helpers round-trip ====
        tid = _resume_thread_id({"chat_id": "unit-chat"})
        assert tid == "resume:unit-chat", tid
        msgs = [
            HumanMessage(content="hi"),
            AIMessage(
                content="",
                tool_calls=[{"name": "grep", "args": {"pattern": "foo"}, "id": "c1"}],
            ),
            ToolMessage(content="MATCHES for 'foo'\napp.py:1: def foo():", tool_call_id="c1"),
        ]
        await _save_turn_checkpoint(tid, msgs)
        loaded = await _load_turn_checkpoint(tid)
        assert loaded and len(loaded) == 3, f"expected 3 messages, got {len(loaded) if loaded else 0}"
        # ToolMessage content (the FULL tool result) survives the round-trip.
        assert any(
            getattr(m, "type", "") == "tool" and "foo" in str(m.content) for m in loaded
        ), "tool result lost in checkpointer round-trip"
        await _clear_turn_checkpoint(tid)
        assert await _load_turn_checkpoint(tid) is None, "clear failed"
        print("  resume/unit OK: checkpointer helpers round-trip")

        # ==== Integration: an interrupted turn leaves a checkpoint that a resumed
        #      run reloads (and reuses) instead of re-running the tool. ====
        chat = "chat-resume-native"
        common = {
            "provider": "custom",
            "model_name": "mock-model",
            "base_url": base,
            "api_key": "test",
            "root": ws,
            "mode": "ask",
            "chat_id": chat,
        }

        # Turn 1: model calls grep TWICE with DIFFERENT args (so the loop's
        # result-dedup doesn't collapse them) and we break after the SECOND tool
        # result, simulating a client abort. The checkpoint written after the 2nd
        # result holds both tool results.
        mock.script = [
            tool_call("grep", json.dumps({"pattern": "foo", "path": ""}), call_id="call_foo"),
            tool_call("grep", json.dumps({"pattern": "bar", "path": ""}), call_id="call_bar"),
            text_reply("done"),
        ]
        mock.captured = []
        seen = 0
        async for ev in run_agent(prompt="find foo", history=[], **common):
            if ev.get("kind") == "tool_result":
                seen += 1
                if seen >= 2:
                    break  # simulate client abort / Stop after the 2nd result
        assert seen >= 2, "turn 1 never reached two tool results"

        # The checkpointer must now hold the interrupted transcript (with the grep
        # result) so a reconnect can resume from it.
        loaded = await _load_turn_checkpoint(_resume_thread_id({"chat_id": chat}))
        assert loaded and any(
            getattr(m, "type", "") == "tool" for m in loaded
        ), "interrupted turn must leave a resume checkpoint with the tool result"
        print("  resume/int OK: interrupted turn left a checkpointer resume state")

        # Turn 2: same chat, same prompt. The resumed model should RECEIVE the
        # prior ToolMessage in its very first request (checkpoint reloaded),
        # proving resume happened and the prior result is reused (not re-run).
        mock.script = [text_reply("here is the summary")]
        mock.captured = []
        async for _ in run_agent(prompt="find foo", history=[], **common):
            pass
        first = mock.captured[0] if mock.captured else None
        assert first, "expected a captured request on resume"
        has_prior_tool = any(
            msg.get("role") == "tool" and "foo" in str(msg.get("content", ""))
            for msg in first.get("messages", [])
        )
        assert has_prior_tool, \
            "resumed run did not reload the prior tool result from the checkpointer"
        # Clean finish clears the checkpoint so later turns start fresh.
        assert await _load_turn_checkpoint(_resume_thread_id({"chat_id": chat})) is None, \
            "checkpoint must be cleared after a clean finish"
        print("  resume/int OK: resumed run reloads prior result; clean finish clears it")

        # ==== Hard error leaves the checkpoint behind (for retry) ====
        chat2 = "chat-resume-err"
        mock.script = [
            tool_call("grep", json.dumps({"pattern": "def", "path": ""})),
            None,  # hard 400 on the main model's next request
        ]
        mock.captured = []
        ev2 = await run_turn(prompt="find def", history=[], **{**common, "chat_id": chat2})
        assert any(e.get("kind") == "error" for e in ev2), \
            "hard error must surface as an error event"
        assert await _load_turn_checkpoint(_resume_thread_id({"chat_id": chat2})) is not None, \
            "checkpoint must survive a hard error so a retry can resume"
        await _clear_turn_checkpoint(_resume_thread_id({"chat_id": chat2}))
        print("  resume/int OK: hard error leaves checkpoint for retry")

        # ==== Stale prune: old checkpoints reclaimed, recent ones kept ====
        from datetime import datetime, timedelta, timezone

        old_tid = _resume_thread_id({"chat_id": "prune-old"})
        new_tid = _resume_thread_id({"chat_id": "prune-new"})
        old_iso = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        new_iso = datetime.now(timezone.utc).isoformat()
        await _save_ckpt_with_ts(old_tid, old_iso)
        await _save_ckpt_with_ts(new_tid, new_iso)
        await prune_stale_resume_checkpoints(ttl_hours=24)
        assert await _load_turn_checkpoint(old_tid) is None, \
            "old checkpoint must be pruned"
        assert await _load_turn_checkpoint(new_tid) is not None, \
            "recent checkpoint must survive the prune"
        await _clear_turn_checkpoint(new_tid)
        print("  resume/prune OK: stale checkpoint reclaimed, recent kept")

        # ==== Deleting a chat drops its resume checkpoint ====
        del_tid = _resume_thread_id({"chat_id": "chat-to-delete"})
        await _save_turn_checkpoint(del_tid, [HumanMessage(content="y")])
        assert await _load_turn_checkpoint(del_tid) is not None, \
            "checkpoint should exist before chat deletion"
        await clear_chat_resume_checkpoint("chat-to-delete")
        assert await _load_turn_checkpoint(del_tid) is None, \
            "deleted chat's resume checkpoint must be removed"
        print("  resume/del OK: deleting a chat clears its resume checkpoint")

        print("RESUME TEST PASSED")
    finally:
        await stop_server(task)


if __name__ == "__main__":
    asyncio.run(main())
