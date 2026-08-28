"""Live tests for the three pending issues:

1. Output-discipline instructions present in the ask/coder/plan system prompts,
   and max_tokens scoped down for narrow tasks (narrow vs broad request bodies).
2. Plan→Coder handoff: the files Plan identified are injected into Coder's
   prompt so it skips rediscovery.
3. parallel_tool_calls: sent for OpenAI-compatible cloud kinds (custom) only,
   never for ollama — and an ollama-style run still completes when a gateway
   would reject the field.
"""
import asyncio
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-issues-data-")
os.environ["CODER_DATA_DIR"] = _TMP

from mock_openai import (
    mock,
    start_server,
    stop_server,
    text_reply,
)

from agents import run_agent
from llm import _MAX_OUTPUT_TOKENS


def system_text(captured, needle):
    """Return the first system message containing `needle`, or None."""
    for body in captured:
        for m in body.get("messages", []):
            if m.get("role") == "system" and needle in (m.get("content") or ""):
                return m["content"]
    return None


async def main():
    task, base = await start_server()
    try:
        ws = tempfile.mkdtemp(prefix="coder-test-issues-ws-")
        with open(os.path.join(ws, "app.py"), "w") as fh:  # noqa: ASYNC230
            fh.write("def foo():\n    return 42\n")

        _chat_seq = 0

        async def one_turn(mode, prompt, history=None, provider="custom", **extra):
            nonlocal _chat_seq
            mock.script = [text_reply("ok")]
            mock.captured = []
            events = []
            _chat_seq += 1
            async for ev in run_agent(
                provider=provider, model_name="mock-model", base_url=base, api_key="test",
                root=ws, mode=mode, prompt=prompt, history=history or [],
                chat_id=f"chat-issue-{_chat_seq}-{mode}-{provider}",
                context_window=32000, **extra,
            ):
                events.append(ev)
            return events, mock.captured

        # ---- Issue 1a: output-discipline instructions reach the model ----
        _, cap_ask = await one_turn("ask", "where is foo defined")
        assert system_text(cap_ask, "OUTPUT DISCIPLINE"), "ask prompt missing OUTPUT DISCIPLINE"
        _, cap_coder = await one_turn("coder", "fix the bug in app.py")
        assert system_text(cap_coder, "REPLY DISCIPLINE"), "coder prompt missing REPLY DISCIPLINE"
        _, cap_plan = await one_turn("plan", "make a plan to add a toggle")
        plan_sys = system_text(cap_plan, "OUTPUT DISCIPLINE")
        assert plan_sys and "Files:" in (system_text(cap_plan, "Files:") or ""), \
            "plan prompt missing Files: contract"
        print("  issues/1a OK: OUTPUT/REPLY DISCIPLINE + plan Files: contract in system prompts")

        # ---- Issue 1b: narrow tasks get a tighter output budget (proportional) ----
        # The broad budget for an unknown model output limit is _MAX_OUTPUT_TOKENS
        # (the old min(max(1024, ctx//4), 8192) clamp was removed because it made
        # models truncate on even an empty context). Narrow caps at 50% with a 2048
        # floor (see llm._request_body).
        broad_budget = _MAX_OUTPUT_TOKENS  # = 32000 in mock ctx
        expected_narrow = min(broad_budget, max(2048, broad_budget // 2))
        assert expected_narrow < broad_budget  # sanity: cap is tighter than broad

        _, cap_narrow = await one_turn("coder", "find where foo is defined and fix it")
        _, cap_broad = await one_turn("coder", "how does the whole architecture work end to end")
        narrow_body = cap_narrow[0]
        broad_body = cap_broad[0]
        n_max = narrow_body.get("max_completion_tokens", narrow_body.get("max_tokens"))
        b_max = broad_body.get("max_completion_tokens", broad_body.get("max_tokens"))
        assert n_max == expected_narrow, \
            f"narrow task max output {n_max} != expected proportional cap {expected_narrow}"
        assert b_max == broad_budget, \
            f"broad task max output {b_max} != full budget {broad_budget}"
        print(f"  issues/1b OK: narrow output capped at {n_max}, broad keeps {b_max}")

        # ---- Issue 2: Plan→Coder handoff injects Plan's files ----
        history = [
            {"role": "user", "content": "plan a settings toggle feature"},
            {"role": "assistant", "mode": "plan", "content":
                "## Plan\n1. Add a toggle card in app.tsx.\n2. Wire state in store.ts.\n"
                "Files: src/app.tsx, src/lib/store.ts"},
        ]
        _, cap_handoff = await one_turn("coder", "implement the plan", history=history)
        note = system_text(cap_handoff, "already identified these files as relevant")
        assert note, "Plan→Coder discovery note not injected"
        assert "src/app.tsx" in note and "src/lib/store.ts" in note, \
            f"Plan files missing from the note:\n{note[:300]!r}"
        assert "Do NOT re-run glob/grep" in note or "read/grep" in note, "note must steer to verification"
        print("  issues/2 OK: Plan files injected; Coder steered to verify, not rediscover")

        # ---- Issue 3: parallel_tool_calls allowlist ----
        _, cap_custom = await one_turn("coder", "add a toggle button", provider="custom")
        assert cap_custom[0].get("parallel_tool_calls") is True, \
            "custom request must carry parallel_tool_calls=True"
        # ollama is NOT in the allowlist: the field must be absent, and the run
        # must still complete even when a hypothetical gateway rejects the field.
        mock.reject_parallel = True
        try:
            _, cap_ollama = await one_turn("coder", "add a toggle button", provider="ollama")
        finally:
            mock.reject_parallel = False
        assert "parallel_tool_calls" not in cap_ollama[0], \
            "ollama request must NOT carry parallel_tool_calls"
        print("  issues/3 OK: parallel_tool_calls sent for custom, omitted for ollama")

        print("ISSUE TESTS PASSED")
    finally:
        await stop_server(task)


if __name__ == "__main__":
    asyncio.run(main())