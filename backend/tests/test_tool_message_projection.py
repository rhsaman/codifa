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


def test_mutating_tool_identical_duplicates_collapse():
    """Identical-duplicate collapse is tool-agnostic: a byte-identical
    (name, args, content) triple is lossless to reference even for mutating
    tools — the full text stays in this same request under the first id."""
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
    assert tools[0].content == BODY
    assert "c1" in tools[1].content
    assert len(tools[1].content) < len(BODY)


def test_repeated_terminal_output_collapses():
    """The headline case: re-running the same command with the same output
    (test suite re-run, cached fetch) must not re-send the full text twice."""
    body = "PASSED backend/tests/test_a.py\n" * 80
    msgs = [
        HumanMessage(content="run the tests"),
        AIMessage(content="", tool_calls=[
            {"name": "run_terminal", "args": {"command": "uv run pytest"}, "id": "t1"},
        ]),
        ToolMessage(content=body, tool_call_id="t1", name="run_terminal"),
        AIMessage(content="", tool_calls=[
            {"name": "run_terminal", "args": {"command": "uv run pytest"}, "id": "t2"},
        ]),
        ToolMessage(content=body, tool_call_id="t2", name="run_terminal"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content == body
    assert "t1" in tools[1].content
    assert len(tools[1].content) < len(body)


def test_all_tool_call_ids_preserved():
    msgs = _convo(BODY)
    out = project_tool_results(msgs)
    assert [m.tool_call_id for m in out if isinstance(m, ToolMessage)] == [
        "c1", "c2", "c3",
    ]


def test_duplicate_tool_result_id_is_removed_from_provider_request():
    """نسخهٔ ارسالی به provider فقط یک خروجی برای هر شناسه نگه می‌دارد."""
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "p"}, "id": "c1"},
        ]),
        ToolMessage(content="نخستین نتیجه", tool_call_id="c1", name="grep"),
        ToolMessage(content="نتیجهٔ تکراری", tool_call_id="c1", name="grep"),
    ]

    out = project_tool_results(msgs)
    tools = [message for message in out if isinstance(message, ToolMessage)]

    assert len(tools) == 1
    assert tools[0].tool_call_id == "c1"
    assert tools[0].content == "نخستین نتیجه"


# ── stale grep entries collapsed once a read covers their rows ──────────

_GREP_BODY = (
    "MATCHES for 'composer'\n"
    "src/components/Chat.tsx:4531:\n"
    "> 4531 |   const composerRef = useRef<HTMLDivElement>(null);\n"
    "  4532 |   const inputRef = useRef<HTMLTextAreaElement>(null);  // composer input\n"
    "\n"
    "src/styles/global.css:3318:\n"
    "  3318 | .composer {\n"
    "> 3319 |   position: absolute;\n"
    "\n"
    "src/lib/store.ts:2298: setChatDraft: (id, patch) => {  // draft persistence\n"
    "\n"
    "Found 3 matches.\n"
)


def _grep_then_read_convo(read_body: str) -> list:
    return [
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "composer"}, "id": "g1"},
        ]),
        ToolMessage(content=_GREP_BODY, tool_call_id="g1", name="grep"),
        AIMessage(content="", tool_calls=[
            {
                "name": "read",
                "args": {"filePath": "src/components/Chat.tsx", "offset": 4529, "limit": 5},
                "id": "r1",
            },
        ]),
        ToolMessage(content=read_body, tool_call_id="r1", name="read"),
    ]


_READ_BODY = (
    "<path>src/components/Chat.tsx</path>\n<type>file</type>\n<content>\n"
    "4529 |   }\n"
    "4530 | \n"
    "4531 |   const composerRef = useRef<HTMLDivElement>(null);\n"
    "4532 |   const inputRef = useRef<HTMLTextAreaElement>(null);\n"
    "4533 |   return (\n"
    "</content>"
)


def test_stale_grep_rows_collapsed_by_later_read():
    out = project_tool_results(_grep_then_read_convo(_READ_BODY))
    grep = next(m for m in out if isinstance(m, ToolMessage) and m.tool_call_id == "g1")
    # Covered entry: pointer kept, code rows replaced by the range marker.
    assert "src/components/Chat.tsx:4531:" in grep.content
    assert "[lines 4531-4532 identical to an earlier read of this file above; omitted]" in grep.content
    assert "const composerRef" not in grep.content


def test_uncovered_grep_entries_kept():
    out = project_tool_results(_grep_then_read_convo(_READ_BODY))
    grep = next(m for m in out if isinstance(m, ToolMessage) and m.tool_call_id == "g1")
    # global.css was never read and store.ts:2298 is not covered → intact.
    assert "position: absolute;" in grep.content
    assert "setChatDraft: (id, patch) => {" in grep.content
    # The header and trailing note survive.
    assert grep.content.startswith("MATCHES for 'composer'")
    assert "Found 3 matches." in grep.content


def test_grep_without_any_read_untouched():
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "composer"}, "id": "g1"},
        ]),
        ToolMessage(content=_GREP_BODY, tool_call_id="g1", name="grep"),
    ]
    out = project_tool_results(msgs)
    assert out[1].content == _GREP_BODY


def test_grep_error_result_never_collapsed():
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "composer"}, "id": "g1"},
        ]),
        ToolMessage(content=_GREP_BODY, tool_call_id="g1", name="grep", status="error"),
        AIMessage(content="", tool_calls=[
            {"name": "read", "args": {"filePath": "src/components/Chat.tsx"}, "id": "r1"},
        ]),
        ToolMessage(content=_READ_BODY, tool_call_id="r1", name="read"),
    ]
    out = project_tool_results(msgs)
    grep = next(m for m in out if isinstance(m, ToolMessage) and m.tool_call_id == "g1")
    assert grep.content == _GREP_BODY


def test_single_line_grep_entry_collapsed_when_covered():
    read_body = (
        "<path>src/lib/store.ts</path>\n<type>file</type>\n<content>\n"
        "2298 | setChatDraft: (id, patch) => {\n"
        "2299 |   const chat = get().chats[id]\n"
        "</content>"
    )
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "grep", "args": {"pattern": "setChatDraft"}, "id": "g1"},
        ]),
        ToolMessage(content=_GREP_BODY, tool_call_id="g1", name="grep"),
        AIMessage(content="", tool_calls=[
            {"name": "read", "args": {"filePath": "src/lib/store.ts"}, "id": "r1"},
        ]),
        ToolMessage(content=read_body, tool_call_id="r1", name="read"),
    ]
    out = project_tool_results(msgs)
    grep = next(m for m in out if isinstance(m, ToolMessage) and m.tool_call_id == "g1")
    assert "src/lib/store.ts:2298:" in grep.content
    assert "setChatDraft: (id, patch) => {" not in grep.content


def test_projection_of_grep_then_read_is_deterministic():
    """Same message set → same output: once collapsed, later steps must not
    re-shape the prefix (prompt-cache stability)."""
    convo = _grep_then_read_convo(_READ_BODY)
    first = [m.content for m in project_tool_results(convo) if isinstance(m, ToolMessage)]
    second = [m.content for m in project_tool_results(convo) if isinstance(m, ToolMessage)]
    assert first == second


# ── stale browser snapshots collapse, the newest one stays full ─────────

_SNAPSHOT_BODY = (
    "### Page\n- Page URL: https://example.com\n"
    + "".join(f"- generic [ref=e{i}]: filler line {i}\n" for i in range(120))
)


def _browser_convo(snapshot_bodies: list[str]) -> list:
    msgs: list = [HumanMessage(content="check the page")]
    for i, body in enumerate(snapshot_bodies):
        msgs.append(AIMessage(content="", tool_calls=[
            {"name": "browser_snapshot", "args": {}, "id": f"b{i + 1}"},
        ]))
        msgs.append(ToolMessage(content=body, tool_call_id=f"b{i + 1}", name="browser_snapshot"))
    return msgs


def test_only_last_browser_snapshot_stays_full():
    out = project_tool_results(_browser_convo([_SNAPSHOT_BODY, _SNAPSHOT_BODY, _SNAPSHOT_BODY]))
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content.startswith("[older browser_snapshot result")
    assert tools[1].content.startswith("[older browser_snapshot result")
    assert tools[2].content == _SNAPSHOT_BODY
    # The marker points forward and keeps the id for the tool loop.
    assert "newer browser_snapshot result" in tools[0].content


def test_single_browser_snapshot_untouched():
    out = project_tool_results(_browser_convo([_SNAPSHOT_BODY]))
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content == _SNAPSHOT_BODY


def test_qualified_browser_snapshot_name_collapses_too():
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "mcp__playwright__browser_snapshot", "args": {}, "id": "q1"},
        ]),
        ToolMessage(content=_SNAPSHOT_BODY, tool_call_id="q1", name="mcp__playwright__browser_snapshot"),
        AIMessage(content="", tool_calls=[
            {"name": "browser_snapshot", "args": {}, "id": "q2"},
        ]),
        ToolMessage(content=_SNAPSHOT_BODY, tool_call_id="q2", name="browser_snapshot"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content.startswith("[older browser_snapshot result")
    assert tools[1].content == _SNAPSHOT_BODY


def test_rebuilt_history_snapshot_collapses_by_shape():
    """A rebuilt-history result has no live AIMessage tool_call — the Playwright
    result shape is the fallback detector."""
    msgs = [
        ToolMessage(content=_SNAPSHOT_BODY, tool_call_id="old-1"),
        ToolMessage(content=_SNAPSHOT_BODY, tool_call_id="old-2"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content.startswith("[older browser result")
    assert tools[1].content == _SNAPSHOT_BODY


def test_small_browser_results_untouched():
    navigate = "### Ran Playwright code\n```js\nawait page.goto('https://x.dev')\n```\n### Page\n- tiny"
    msgs = [
        AIMessage(content="", tool_calls=[
            {"name": "browser_navigate", "args": {"url": "https://x.dev"}, "id": "n1"},
        ]),
        ToolMessage(content=navigate, tool_call_id="n1", name="browser_navigate"),
        AIMessage(content="", tool_calls=[
            {"name": "browser_snapshot", "args": {}, "id": "b1"},
        ]),
        ToolMessage(content="### Page\n- small", tool_call_id="b1", name="browser_snapshot"),
    ]
    out = project_tool_results(msgs)
    tools = [m for m in out if isinstance(m, ToolMessage)]
    assert tools[0].content == navigate
    assert tools[1].content == "### Page\n- small"


def test_browser_snapshot_originals_not_mutated():
    msgs = _browser_convo([_SNAPSHOT_BODY, _SNAPSHOT_BODY])
    before = [m.model_copy(deep=True) for m in msgs]
    project_tool_results(msgs)
    assert [m.model_copy(deep=True) for m in msgs] == before
