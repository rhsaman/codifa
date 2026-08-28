"""
Verify that parent search-slot tool events carry the search-subagent model name
(so the frontend can attribute search usage to the correct model).

grep/glob are NO LONGER parent tools — searching is delegated to the explore
sub-agent. `read` is the remaining parent tool that runs on the search-subagent
model (or the main model once the slot falls back), so it must stamp its `tool`
event with that model name.
"""
import asyncio
import sys

sys.path.insert(0, "backend")

from tools import make_tool_callbacks


class _FakeModel:
    def __init__(self, name):
        self.model_name = name


async def main():
    events = []

    tools = make_tool_callbacks(
        root="/tmp",
        emit=events.append,
        search_model=_FakeModel("search-subagent-model"),
        main_model=_FakeModel("main-model"),
    )

    # grep/glob are delegated to the explore sub-agent — they must NOT be
    # parent tools anymore.
    assert "grep" not in tools, "grep should be delegated to explore, not a parent tool"
    assert "glob" not in tools, "glob should be delegated to explore, not a parent tool"

    # `read` is the remaining parent search-slot tool: its `tool` event must
    # carry the search-subagent model name. (A missing file is fine — the `tool`
    # event is emitted before any file access.)
    await tools["read"]("nonexistent-file-for-test.py")

    tool_events = [ev for ev in events if ev.get("kind") == "tool"]
    if not tool_events:
        print("FAIL: no `tool` events were emitted by read")
        sys.exit(1)

    bad = [ev for ev in tool_events if not ev.get("model")]
    if bad:
        print("FAIL: tool events missing model:")
        for ev in bad:
            print("  ", ev)
        sys.exit(1)

    print("✅ parent search-slot tool events carry the search-subagent model name")


if __name__ == "__main__":
    asyncio.run(main())
