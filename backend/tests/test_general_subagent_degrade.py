"""Regression test: plan mode must complete gracefully (no crash) when the
deterministic repo-discovery runs. Repository exploration is now a deterministic
workflow (not a general sub-agent), so there is no sub-agent 'length' failure --
the turn simply finishes from the injected context.
"""

import json

from mock_openai import mock, text_reply, tool_call


async def test_plan_completes_with_deterministic_discovery(run_events, mock_server, workspace):
    base, _mock = mock_server
    # A file whose symbol is discoverable deterministically.
    (workspace / "ui.py").write_text(
        "def render_header(model):\n    return f'{model} context capacity'\n",
        encoding="utf-8",
    )
    mock.script = [text_reply("render_header lives in ui.py.")]
    events = await run_events("where is render_header defined?", mode="plan")

    # The deterministic discovery ran and the turn finished (no crash).
    assert any(
        e.get("kind") == "tool" and e.get("tool") == "repo_search" for e in events
    ), "deterministic repo discovery did not run"
    assert any(e.get("kind") == "text" for e in events), "turn did not finish"

    # No exploration tools leaked to the LLM.
    tool_names = set()
    for body in mock.captured:
        for t in body.get("tools") or []:
            tool_names.add((t.get("function") or {}).get("name"))
    assert not (tool_names & {"glob", "grep", "read", "task"}), \
        f"plan LLM must not have exploration tools: {tool_names}"
