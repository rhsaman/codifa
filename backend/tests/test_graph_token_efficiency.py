"""Measure request characters and actual tool executions independently."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

import graph

BODY = "نتیجهٔ کامل جست‌وجو با اطلاعات لازم\n" * 200


async def run_scenario(monkeypatch, scenario):
    requested = ["اول", "دوم"]
    executions = []
    requests = []
    checkpoints = []
    initial = [HumanMessage(content="جست‌وجو کن")]
    resumed = None
    if scenario == "resume":
        resumed = initial + [
            AIMessage(content="", tool_calls=[
                {"name": "grep", "args": {"pattern": "مشترک"}, "id": "قبلی"},
            ]),
            ToolMessage(content=BODY, tool_call_id="قبلی"),
        ]

    class Model:
        model_name = "آزمایشی"

        def bind_tools(self, tools):
            return self

        async def astream(self, messages):
            requests.append([m.model_copy(deep=True) for m in messages])
            if len(requests) == 1:
                yield AIMessageChunk(content="", tool_calls=[
                    {"name": "grep", "args": {"pattern": (
                        cid if scenario == "parallel" else "مشترک"
                    )}, "id": cid}
                    for cid in requested
                ])
            else:
                yield AIMessageChunk(content="انجام شد")

    started = set()
    both_started = asyncio.Event()

    async def grep(pattern):
        executions.append(pattern)
        if scenario == "parallel":
            started.add(pattern)
            if len(started) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 2)
        return BODY

    async def save_checkpoint(thread_id, messages):
        checkpoints.append([m.model_copy(deep=True) for m in messages])

    monkeypatch.setattr(graph, "build_turn_context", AsyncMock(return_value={
        "model": Model(), "lc_tools": [], "tools": {"grep": grep},
        "messages": initial,
    }))
    # نادجِ batching مشاوره‌ای است و مستقل از projection — برای ایزوله‌کردن
    # رفتار projection، اینجا خاموش می‌شود تا محتوای ToolMessageها دست‌نخورده بماند.
    monkeypatch.setattr(graph, "_batchable_nudge", lambda tcs: "")
    monkeypatch.setattr(graph, "_load_turn_checkpoint_valid", AsyncMock(return_value=resumed))
    monkeypatch.setattr(graph, "_save_turn_checkpoint", save_checkpoint)
    monkeypatch.setattr(graph, "_clear_turn_checkpoint", AsyncMock())
    monkeypatch.setattr(graph._agents, "_drain_steer", AsyncMock(return_value=[]))
    queue = asyncio.Queue()
    reply = await graph._run_mode_turn({"chat_id": "آزمون", "context_window": 0}, "coder", queue)
    assert reply == "انجام شد"
    assert not any(e.get("kind") == "error" for e in list(queue._queue))
    return requests, executions, checkpoints


@pytest.mark.parametrize("scenario, expected_executions", [
    ("duplicate", 1), ("parallel", 2), ("resume", 0),
])
async def test_unprojected_baseline(monkeypatch, scenario, expected_executions):
    monkeypatch.setattr(graph, "project_tool_results", lambda msgs: list(msgs), raising=False)
    requests, executions, checkpoints = await run_scenario(monkeypatch, scenario)
    assert len(requests) == 2
    assert len(executions) == expected_executions
    results = [m for m in requests[-1] if isinstance(m, ToolMessage)]
    assert len(results) == (3 if scenario == "resume" else 2)
    assert all(m.content == BODY for m in results)
    assert sum(len(m.content) for m in results) == len(results) * len(BODY)
    assert all(m.content == BODY for checkpoint in checkpoints for m in checkpoint
               if isinstance(m, ToolMessage))


@pytest.mark.parametrize("scenario, expected_executions, expected_full", [
    ("duplicate", 1, 1), ("parallel", 2, 2), ("resume", 0, 1),
])
async def test_projection_saves_request_chars(monkeypatch, scenario, expected_executions, expected_full):
    """با projection فعال، تکرار فقط از پیام ارسالی حذف می‌شود؛ اجرا و تاریخچه دست‌نخورده."""
    requests, executions, checkpoints = await run_scenario(monkeypatch, scenario)
    assert len(requests) == 2
    assert len(executions) == expected_executions
    results = [m for m in requests[-1] if isinstance(m, ToolMessage)]
    assert len(results) == (3 if scenario == "resume" else 2)
    # حداقل یک نسخهٔ کامل از هر نتیجهٔ یکسان در همین درخواست موجود می‌ماند.
    full = [m for m in results if m.content == BODY]
    assert len(full) == expected_full
    # سایر نسخه‌ها ارجاع کوتاه به نسخهٔ کامل‌اند — کوتاه‌تر از متن کامل.
    refs = [m for m in results if m.content != BODY]
    assert all(len(m.content) < len(BODY) for m in refs)
    assert len(full) + len(refs) == len(results)
    # تاریخچهٔ اصلی و ذخیرهٔ بازیابی همچنان متن کامل را دارند.
    assert all(m.content == BODY for checkpoint in checkpoints for m in checkpoint
               if isinstance(m, ToolMessage))
    # صرفه‌جویی واقعی فقط جایی که تکرار وجود داشت: ارسال کمتر از حالت بدون projection.
    if refs:
        assert sum(len(m.content) for m in results) < len(results) * len(BODY)
    else:
        assert sum(len(m.content) for m in results) == len(results) * len(BODY)
