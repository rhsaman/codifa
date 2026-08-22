"""Regression test: the general (task) sub-agent must degrade gracefully when
the underlying model returns an empty ``finish_reason: 'length'`` response
(the exact failure a small local model produces when its context window is
exceeded) instead of crashing the whole turn.
"""

import json

from mock_openai import length_reply, text_reply, tool_call


async def test_general_subagent_degrades_on_local_length_error(run_events, mock_server):
    base, mock = mock_server
    mock.script = [
        tool_call(
            "task",
            json.dumps({
                "description": "find context display",
                "prompt": "find where the app shows context capacity",
                "subagent_type": "general",
            }),
        ),
        length_reply(),  # sub-agent's request exceeds the small local window
        text_reply("I delegated the search but the sub-agent couldn't run locally."),
    ]

    events = await run_events(
        "چرا بالای اپ ظرفیت کانتکست مدل لوکال رو نمایش نمیده؟",
        mode="plan",
    )

    # The turn must complete (run_agent does not raise) — no hard crash.
    task_errors = [
        e for e in events
        if e.get("kind") == "tool_result" and e.get("tool") == "task"
        and e.get("status") == "error"
    ]
    assert task_errors, "expected a graceful task error, not a turn-killing crash"
    assert "sub-agent failed" in task_errors[0].get("summary", ""), \
        f"unexpected task failure: {task_errors[0]}"
    # The parent model still finishes the turn after the sub-agent failure.
    assert any(e.get("kind") == "text" for e in events), "turn did not finish"
