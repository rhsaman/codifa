"""Live test: interrupted-turn resume.

Covers Stop/abort, a hard API error, an app-close (no marker folded into history),
and a Plan→Coder style handoff with a checklist. Drives the real backend against
the shared mock server. Run standalone (`python backend/tests/test_resume.py`) or via
`python backend/tests/run_tests.py`.
"""
import asyncio
import json
import os
import tempfile
import time

# Hermetic data root BEFORE importing anything that touches state_db.
_TMP = tempfile.mkdtemp(prefix="coder-test-resume-data-")
os.environ["CODER_DATA_DIR"] = _TMP

# Import the harness FIRST — it puts the repo backend dir on sys.path so the
# backend modules below resolve wherever the tests run from.
from mock_openai import (
    mock,
    start_server,
    stop_server,
    text_reply,
    tool_call,
)

import state_db
from agents import run_agent


async def run_turn(**kw):
    events = []
    async for ev in run_agent(**kw):
        events.append(ev)
    return events


def find_in_request(captured, pred):
    for body in captured:
        for msg in body.get("messages", []):
            if pred(msg):
                return body, msg
    return None, None


def make_workspace():
    ws = tempfile.mkdtemp(prefix="coder-test-resume-ws-")
    with open(os.path.join(ws, "app.py"), "w") as fh:
        fh.write("def foo():\n    return 42\n")
    return ws


async def main():
    task, base = await start_server()
    try:
        ws = make_workspace()
        chat_id = "chat-resume-1"
        common = {
            "provider": "custom", "model_name": "mock-model", "base_url": base, "api_key": "test",
            "root": ws, "mode": "ask", "chat_id": chat_id,
        }

        # ==== Scenario 1: Stop / abort mid-stream after a completed tool ====
        mock.script = [tool_call("grep", json.dumps({"pattern": "foo", "path": ""}))]
        mock.captured = []
        events = []
        interrupted = False
        async for ev in run_agent(prompt="find foo", history=[], **common):
            events.append(ev)
            if ev.get("kind") == "tool_result":
                interrupted = True
                break  # simulate client abort / Stop
        assert interrupted, "run 1 never reached a tool_result"

        resume = state_db.load_turn_resume(ws, chat_id)
        assert resume and resume.get("tools"), "resume file missing after interruption"
        tools = [t for t in resume["tools"] if isinstance(t, dict)]
        assert tools and tools[0]["tool"] == "grep", "resume file lost the grep record"
        full_result = tools[0]["result"]
        # grep now distills through the search/explore subagent (defaults to the
        # parent model when no subagent is configured), so the stored result is
        # the distilled summary — still the FULL tool result the resume replays.
        assert full_result and "foo" in full_result, \
            f"resume result is not the FULL grep output: {full_result[:200]!r}"
        print("  resume/1 OK: interrupted; file holds full grep result")

        mock.script = [text_reply("Done")]
        mock.captured = []
        history = [
            {"role": "user", "content": "find foo"},
            {"role": "assistant",
             "content": "[Interrupted before finishing. Already done this turn — do NOT repeat these:\n- grep: 1 matches]"},
        ]
        await run_turn(prompt="continue", history=history, **common)
        _, call_msg = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant" and any(
                tc.get("id", "").startswith("resume-") for tc in (m.get("tool_calls") or [])
            ),
        )
        assert call_msg, "continue request did not replay the resume tool call"
        tool_calls = [tc for tc in call_msg["tool_calls"] if tc.get("id", "").startswith("resume-")]
        assert tool_calls[0]["function"]["name"] == "grep", "resume tool call wrong name"
        _, ret_msg = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "tool" and m.get("tool_call_id") == tool_calls[0]["id"],
        )
        assert ret_msg and full_result in ret_msg["content"], \
            "resume tool return missing the FULL result"
        assert state_db.load_turn_resume(ws, chat_id) is None, \
            "resume file not cleared after a clean finish"
        print("  resume/1 OK: continue replays full result; file cleared")

        # ==== Scenario 2: run cut off by a hard 400 after tool work ====
        chat2 = "chat-resume-2"
        mock.script = [
            tool_call("grep", json.dumps({"pattern": "def", "path": ""})),
            # grep distills through the search subagent (defaults to the parent
            # model), so this request consumes the next script item — give it a
            # valid reply so the hard 400 below hits the MAIN model's next
            # request instead of being swallowed by the distiller fallback.
            text_reply("distilled summary"),
            None,  # next MAIN model request gets a hard 400
        ]
        mock.captured = []
        raised = None
        try:
            async for _ev in run_agent(prompt="find def", history=[], **{**common, "chat_id": chat2}):
                pass
        except Exception as exc:  # noqa: BLE001
            raised = exc
        assert raised is not None, "expected the hard error to propagate"
        resume2 = state_db.load_turn_resume(ws, chat2)
        assert resume2 and resume2.get("tools"), "resume file missing after an error"
        assert resume2["tools"][0]["tool"] == "grep", "resume after error lost the record"

        mock.script = [text_reply("Done")]
        mock.captured = []
        history2 = [
            {"role": "user", "content": "find def"},
            {"role": "assistant", "content": "[Interrupted before finishing. Already done this turn — do NOT repeat these:\n- grep: 1 matches]"},
        ]
        await run_turn(prompt="continue", history=history2, **{**common, "chat_id": chat2})
        _, call_msg = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant" and any(
                tc.get("id", "").startswith("resume-") for tc in (m.get("tool_calls") or [])
            ),
        )
        assert call_msg, "error-path continue did not replay the resume tool call"
        print("  resume/2 OK: resume file survives a hard error and replays")

        # ==== Scenario 3: hard app close — no marker, recency guard must fire ====
        chat3 = "chat-resume-3"
        state_db.save_turn_resume(ws, chat3, {"prompt": "find foo", "tools": [
            {"tool": "grep", "args": {"pattern": "foo", "path": ""},
             "result": "MATCHES for 'foo'\napp.py:1: def foo():", "ts": time.time()},
        ]})
        mock.script = [text_reply("Done")]
        mock.captured = []
        history3 = [
            {"role": "user", "content": "find foo"},
            {"role": "assistant", "content": "Let me search for that.\nRunning grep..."},
        ]
        await run_turn(prompt="continue", history=history3, **{**common, "chat_id": chat3})
        _, call_msg3 = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant" and any(
                tc.get("id", "").startswith("resume-") for tc in (m.get("tool_calls") or [])
            ),
        )
        assert call_msg3, "hard-close continuation did not inject resume via recency guard"
        assert state_db.load_turn_resume(ws, chat3) is None, "hard-close continue left the file behind"
        print("  resume/3 OK: fresh resume file injected without a marker")

        # ==== Scenario 4: interrupted run had a checklist; continue preserves it ====
        chat4 = "chat-resume-4"
        state_db.save_turn_resume(ws, chat4, {"prompt": "implement X", "tools": [
            {"tool": "grep", "args": {"pattern": "foo", "path": ""},
             "result": "MATCHES for 'foo'\napp.py:1: def foo():", "ts": time.time()},
        ]})
        mock.script = [text_reply("Continuing.")]
        mock.captured = []
        history4 = [
            {"role": "user", "content": "implement feature X"},
            {"role": "assistant", "mode": "coder",
             "content": "I'll break this into steps.",
             "plan": [
                 {"content": "Find where foo is defined", "status": "completed"},
                 {"content": "Read the implementation", "status": "in_progress"},
                 {"content": "Write the change", "status": "pending"},
             ]},
            {"role": "assistant",
             "content": "grep ran...[Interrupted before finishing. Already done this turn — do NOT repeat these:\n- grep: 1 matches]"},
        ]
        # Seed a plan so coder skips the discovery pipeline and this scenario
        # stays focused on checklist/resume preservation.
        state_db.save_plan(ws, "plan", "## Plan\n\n1. implement X\n\nFiles: app.py", chat_id=chat4)
        await run_turn(prompt="ادامه بده", history=history4, mode="coder",
                       **{**{k: v for k, v in common.items() if k != "mode"}, "chat_id": chat4})
        _, call_msg4 = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant" and any(
                tc.get("id", "").startswith("resume-") for tc in (m.get("tool_calls") or [])
            ),
        )
        assert call_msg4, "plan scenario continue did not replay completed tool work"
        _, plan_note = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "system" and "Continue this checklist" in (m.get("content") or ""),
        )
        assert plan_note and "Read the implementation" in plan_note.get("content", ""), \
            "checklist not preserved via _plan_reuse_note"
        assert state_db.load_turn_resume(ws, chat4) is None, "plan scenario left the resume file behind"
        print("  resume/4 OK: checklist preserved on continue")

        # ==== Scenario 5: REAL Retry — SAME prompt re-sent with a skill suffix.
        # No marker is present (the frontend retry re-sends only the prompt), so
        # the normalized gate (a) must fire and NOT re-run the completed tool.
        chat5 = "chat-resume-5"
        mock.script = [
            tool_call("grep", json.dumps({"pattern": "foo", "path": ""})),
            text_reply("distilled summary"),  # search-distiller sub-agent request
            None,  # hard 400 on the MAIN model — the turn errors after the grep completes
        ]
        mock.captured = []
        try:
            async for _ev in run_agent(
                prompt="find foo", history=[], **{**common, "chat_id": chat5}
            ):
                pass
        except Exception:  # noqa: BLE001 — the hard error is expected
            pass
        resume5 = state_db.load_turn_resume(ws, chat5)
        assert resume5 and resume5.get("tools"), "retry: resume file missing after error"

        # The frontend retry re-sends the SAME prompt, but (when skills are
        # active) with a suffixes section appended. Normalize and assert resume.
        from agents import _resume_prompt_key

        retry_prompt = (
            "find foo\n\n=== USER-SELECTED SKILLS/TOOLS FOR THIS TURN ===\nUse the X skill."
        )
        assert _resume_prompt_key(retry_prompt) == "find foo", "prompt normalizer failed"
        mock.script = [text_reply("Done")]
        mock.captured = []
        await run_turn(prompt=retry_prompt, history=[], **{**common, "chat_id": chat5})
        _, call_msg5 = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant" and any(
                tc.get("id", "").startswith("resume-") for tc in (m.get("tool_calls") or [])
            ),
        )
        assert call_msg5, "retry: same-prompt retry did not replay the completed tool"
        assert state_db.load_turn_resume(ws, chat5) is None, "retry left the resume file behind"
        print("  resume/5 OK: same-prompt retry (with skill suffix) resumes done work, no re-run")

        # ==== Scenario 6: NO tool completed, but text streamed — the partial
        # reply must be injected so the model continues instead of restarting.
        # Simulates a hard app close where the interrupted assistant message
        # was never persisted, so the partial text is NOT in history.
        chat6 = "chat-resume-6"
        state_db.save_turn_resume(ws, chat6, {
            "prompt": "find foo",
            "tools": [],
            "partial": "Let me search for that.\nRunning grep...",
            "ts": time.time(),
        })
        mock.script = [text_reply("Done")]
        mock.captured = []
        history6 = [
            {"role": "user", "content": "find foo"},
        ]
        await run_turn(prompt="continue", history=history6, **{**common, "chat_id": chat6})
        _, partial_msg = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "assistant"
            and "Let me search for that." in (m.get("content") or ""),
        )
        assert partial_msg, "partial reply was not injected into the continue request"
        _, cont_note = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "system"
            and "cut off mid-generation" in (m.get("content") or ""),
        )
        assert cont_note, "continuation note missing when partial was injected"
        assert state_db.load_turn_resume(ws, chat6) is None, \
            "partial scenario left the resume file behind"
        print("  resume/6 OK: partial reply injected (no completed tools)")

        # ==== Scenario 6b: partial ALREADY in history (the frontend kept the
        # failed message with the folded marker) — must NOT be duplicated; only
        # the continuation note is added.
        chat6b = "chat-resume-6b"
        state_db.save_turn_resume(ws, chat6b, {
            "prompt": "find foo",
            "tools": [],
            "partial": "Let me search for that.\nRunning grep...",
            "ts": time.time(),
        })
        mock.script = [text_reply("Done")]
        mock.captured = []
        history6b = [
            {"role": "user", "content": "find foo"},
            {"role": "assistant",
             "content": "Let me search for that.\nRunning grep...[Interrupted before finishing. Already done this turn — do NOT repeat these: ]"},
        ]
        await run_turn(prompt="continue", history=history6b, **{**common, "chat_id": chat6b})
        partial_count = sum(
            1 for body in mock.captured for m in body.get("messages", [])
            if m.get("role") == "assistant"
            and "Let me search for that." in (m.get("content") or "")
        )
        assert partial_count == 1, f"partial reply duplicated: {partial_count}"
        _, cont_note6b = find_in_request(
            mock.captured,
            lambda m: m.get("role") == "system"
            and "cut off mid-generation" in (m.get("content") or ""),
        )
        assert cont_note6b, "continuation note missing when partial already in history"
        assert state_db.load_turn_resume(ws, chat6b) is None, \
            "partial-in-history scenario left the resume file behind"
        print("  resume/6b OK: partial not duplicated; continuation note added")

        print("RESUME TESTS PASSED (Stop / error / hard-close / checklist / retry / partial)")
    finally:
        await stop_server(task)


if __name__ == "__main__":
    asyncio.run(main())