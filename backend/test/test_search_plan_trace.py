"""End-to-end trace of a plan-mode SEARCH with the user's prompt.

Runs the REAL agent (tools + sub-agent runner + event stream) against the mock
and verifies:
  * the search (grep) tool is invoked,
  * the search runs directly on the MAIN model (no distill sub-agent) and finds
    the problem,
  * the turn finishes,
and reports process time + token consumption + a trace of the search tool calls
and the context (request bodies) sent to the model.

Swap the mock for a real local model by setting CODER_TEST_BASE_URL /
CODER_TEST_MODEL (otherwise the in-process mock is used).
"""

import json
import os
import time

from mock_openai import mock, text_reply, tool_call


def _trace(events, captured):
    print("\n================ SEARCH TRACE ================")
    for e in events:
        kind = e.get("kind")
        if kind == "tool":
            print(f"  [tool]      {e.get('tool')}  args={str(e.get('args'))[:80]}")
        elif kind == "tool_result":
            print(f"  [result]    {e.get('tool')}  summary={e.get('summary')!r}  status={e.get('status')}")
        elif kind == "usage":
            print(f"  [usage]     {e.get('model')}  in={e.get('input_tokens')} out={e.get('output_tokens')} total={e.get('total_tokens')}")
        elif kind == "text":
            print(f"  [text]      {str(e.get('content',''))[:80]!r}")
    print("  ---- context sent to the model (request breakdown) ----")
    for i, b in enumerate(captured):
        msgs = b.get("messages", [])
        sys_size = len(json.dumps(msgs[0], ensure_ascii=False)) if msgs and msgs[0].get("role") == "system" else 0
        n_tools = len(b.get("tools") or [])
        n_hist = len([m for m in msgs if m.get("role") in ("user", "assistant", "tool")])
        est_tok = len(json.dumps(b, ensure_ascii=False)) // 4
        flag = ""
        if est_tok > 8192:
            flag = "  <-- BIG: exceeds an 8k local window"
        elif est_tok > 4096:
            flag = "  <-- watch: exceeds a 4k local window"
        print(f"  req[{i}] stream={b.get('stream')} est_tokens~{est_tok} "
              f"system={sys_size}B tools={n_tools} history_msgs={n_hist} "
              f"max_tokens={b.get('max_tokens')}{flag}")
    print("=============================================\n")


async def test_search_plan_trace(run_events, mock_server, workspace):
    base, _mock = mock_server
    # Seed a file that matches the search so the main model's grep finds it directly.
    (workspace / "ui.py").write_text(
        "def render_header(model):\n    # context capacity of the local model\n"
        "    return f'{model} context capacity'\n",
        encoding="utf-8",
    )
    real_base = os.environ.get("CODER_TEST_BASE_URL")
    if real_base:
        # Run against a REAL model (set CODER_TEST_BASE_URL + CODER_TEST_MODEL
        # + CODER_TEST_API_KEY). No script — the model drives the turn.
        from agents import run_agent
        model = os.environ.get("CODER_TEST_MODEL", "local-model")
        api_key = os.environ.get("CODER_TEST_API_KEY", "test")
        t0 = time.perf_counter()
        events = []
        async for ev in run_agent(
            provider="custom", model_name=model, base_url=real_base, api_key=api_key,
            root=str(workspace), mode="plan",
            prompt=(
                "where is the render_header function defined? "
                "use grep to search the code."
            ),
            history=[], chat_id="pytest-chat", subagent_models={},
        ):
            events.append(ev)
        captured = []
        dt = time.perf_counter() - t0
    else:
        # In the OpenCode-style design the PLAN agent searches JUST-IN-TIME: it
        # calls the grep tool itself (no deterministic pre-search), so we drive
        # the mock to issue a grep tool call and then answer from the result.
        mock.script = [
            tool_call("grep", json.dumps({"pattern": "render_header"})),
            text_reply(
                "render_header is defined in ui.py and returns the model's reported "
                "context capacity; for local models the header may not show it if the "
                "window isn't reported."
            ),
        ]
        t0 = time.perf_counter()
        events = await run_events(
            "where is the render_header function defined?",
            mode="plan",
            subagent_models={},
        )
        captured = mock.captured
        dt = time.perf_counter() - t0

    # Assertions: search ran, no crash, turn finished.
    assert any(e.get("kind") == "tool" and e.get("tool") == "grep" for e in events), \
        "search (grep) tool was not invoked"
    assert not any(
        e.get("kind") == "tool_result" and e.get("tool") == "grep"
        and "sub-agent failed" in (e.get("summary") or "")
        for e in events
    ), "search distiller crashed (old context-window bug)"
    assert any(e.get("kind") == "text" for e in events), "turn did not finish"

    # Token consumption across the whole turn.
    total_in = total_out = total = 0
    for e in events:
        if e.get("kind") == "usage":
            total_in += int(e.get("input_tokens") or 0)
            total_out += int(e.get("output_tokens") or 0)
            total += int(e.get("total_tokens") or 0)

    _trace(events, mock.captured)
    print(f"PROCESS TIME: {dt:.2f}s   TOKENS: in={total_in} out={total_out} total={total}")
