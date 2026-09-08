"""صحت نسخهٔ ارسالی به مدل: تکرارها کوتاه می‌شوند، تاریخچه دست‌نخورده می‌ماند."""

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from tool_message_projection import project_tool_results


def _convo(body: str) -> list:
    """دو دور grep یکسان + یک read متفاوت با همان ابزار."""
    return [
        HumanMessage(content="جست‌وجو کن"),
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "مشترک"}, "id": "c1"},
        ]),
        ToolMessage(content=body, tool_call_id="c1", name="grep"),
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "مشترک"}, "id": "c2"},
            {"name": "read", "args": {"filePath": "a.py"}, "id": "c3"},
        ]),
        ToolMessage(content=body, tool_call_id="c2", name="grep"),
        ToolMessage(content=body, tool_call_id="c3", name="read"),
    ]


BODY = "خط نتیجه با محتوای بلند\n" * 60


def test_duplicate_shortened_but_original_kept():
    out = project_tool_results(_convo(BODY))
    tools = [m for m in out if isinstance(m, ToolMessage)]
    # c1 (نخستین نسخه) کامل می‌ماند؛ c2 (تکرار عیناً یکسان) کوتاه می‌شود.
    assert tools[0].content == BODY
    assert tools[1].content != BODY
    assert "c1" in tools[1].content
    # read با همان ابزار اما آرگومان متفاوت → دست‌نخورده.
    assert tools[2].content == BODY


def test_original_messages_not_mutated():
    msgs = _convo(BODY)
    before = [m.model_copy(deep=True) for m in msgs]
    project_tool_results(msgs)
    assert [m.model_copy(deep=True) for m in msgs] == before


def test_short_results_untouched():
    body = "کوتاه"
    out = project_tool_results(_convo(body))
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert all(m.content == body for m in tools)


def test_different_content_not_deduplicated():
    msgs = [
        HumanMessage(content="x"),
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "p"}, "id": "c1"},
            {"name": "grep", "args": {"pattern": "p"}, "id": "c2"},
        ]),
        ToolMessage(content=BODY, tool_call_id="c1", name="grep"),
        ToolMessage(content=BODY + "متفاوت", tool_call_id="c2", name="grep"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content == BODY
    assert tools[1].content == BODY + "متفاوت"


def test_error_results_never_shortened():
    msgs = [
        HumanMessage(content="x"),
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "p"}, "id": "c1"},
            {"name": "grep", "args": {"pattern": "p"}, "id": "c2"},
        ]),
        ToolMessage(content=BODY, tool_call_id="c1", name="grep"),
        ToolMessage(content="ERROR: شکست", tool_call_id="c2", name="grep"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[1].content == "ERROR: شکست"


def test_mutating_tool_never_shortened():
    msgs = [
        HumanMessage(content="x"),
        AIMessage(content="", tool_calls=[
            {"name": "edit_file", "args": {"path": "a.py"}, "id": "c1"},
            {"name": "edit_file", "args": {"path": "a.py"}, "id": "c2"},
        ]),
        ToolMessage(content=BODY, tool_call_id="c1", name="edit_file"),
        ToolMessage(content=BODY, tool_call_id="c2", name="edit_file"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert all(m.content == BODY for m in tools)


def test_all_tool_call_ids_preserved():
    msgs = _convo(BODY)
    out = project_tool_results(msgs)
    assert [m.tool_call_id for m in out if isinstance(m, ToolMessage)] == [
        "c1", "c2", "c3",
    ]
