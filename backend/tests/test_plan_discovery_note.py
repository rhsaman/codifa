"""Plan→Coder handoff: the discovery note carries the Plan's own line anchors.

Without anchors the coder opens every plan file head-to-toe (file map), then
greps for symbols — one wasted round-trip per file. With anchors it starts at
read(ranges=...)/read(symbols=...) directly.
"""

from agents import _plan_discovery_note, _plan_line_anchors


def _plan_turn(tool_activity: list | None = None) -> dict:
    turn = {
        "role": "assistant",
        "mode": "plan",
        "content": "## Plan\ndo it\nFiles: src/components/Chat.tsx, src/types.ts\n",
    }
    if tool_activity is not None:
        turn["toolActivity"] = tool_activity
    return turn


def test_note_without_tool_activity_has_no_anchor_section():
    note = _plan_discovery_note([{"role": "user", "content": "x"}, _plan_turn()])
    assert "Chat.tsx" in note
    assert "Line anchors" not in note


def test_note_includes_grep_and_read_anchors():
    activity = [
        {
            "tool": "grep",
            "status": "done",
            "args": {"pattern": "composer"},
            "items": [
                {"path": "src/components/Chat.tsx", "line": 4531, "snippet": "x"},
                {"path": "src/components/Chat.tsx", "line": 4531, "snippet": "dup"},
                {"path": "src/types.ts", "line": 413, "snippet": "y"},
            ],
        },
        {
            "tool": "read",
            "status": "done",
            "args": {"filePath": "src/components/Chat.tsx", "offset": 1, "limit": 400},
        },
        {
            "tool": "read",
            "status": "done",
            "args": {
                "filePath": "src/styles/global.css",
                "ranges": ["src/styles/global.css:3318:120"],
            },
        },
    ]
    note = _plan_discovery_note(
        [{"role": "user", "content": "x"}, _plan_turn(activity)]
    )
    assert "src/components/Chat.tsx:4531" in note
    assert "src/types.ts:413" in note
    assert "src/styles/global.css:3318" in note
    # A head read (offset 1) contributes no anchor.
    assert "Chat.tsx:1" not in note
    assert "ranges=" in note and "symbols=" in note


def test_error_activity_contributes_nothing():
    activity = [
        {
            "tool": "grep",
            "status": "error",
            "args": {"pattern": "x"},
            "items": [{"path": "src/a.py", "line": 5}],
        },
    ]
    assert _plan_line_anchors(_plan_turn(activity)) == []


def test_anchors_capped_and_deduped():
    activity = [
        {
            "tool": "grep",
            "status": "done",
            "args": {"pattern": "x"},
            "items": [
                {"path": f"src/f{i}.py", "line": i} for i in range(30)
            ],
        },
    ]
    anchors = _plan_line_anchors(_plan_turn(activity))
    assert len(anchors) == 16
    assert len(set(anchors)) == 16


def test_latest_plan_turn_wins():
    history = [
        {
            "role": "assistant",
            "mode": "plan",
            "content": "## Plan\nFiles: src/old.ts\n",
            "toolActivity": [
                {
                    "tool": "grep",
                    "status": "done",
                    "args": {"pattern": "x"},
                    "items": [{"path": "src/old.ts", "line": 5}],
                },
            ],
        },
        _plan_turn(),
    ]
    note = _plan_discovery_note(history)
    assert "old.ts" not in note
    assert "Line anchors" not in note
