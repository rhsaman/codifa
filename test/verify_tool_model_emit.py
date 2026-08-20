"""Verify grep/glob/read tool events now carry the search-subagent model name
end-to-end through make_tool_callbacks (the same path the app uses)."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from tools import make_tool_callbacks  # noqa: E402


class FakeModel:
    def __init__(self, name: str):
        self.model_name = name


async def main() -> None:
    events: list[dict] = []
    tools = make_tool_callbacks(
        root=os.path.join(os.path.dirname(__file__), ".."),
        emit=events.append,
        explore_model=FakeModel("nvidia/nemotron-3-super-120b-a12b"),
        web_model=FakeModel("openrouter/free"),
        search_model=FakeModel("openrouter/free"),
        main_model=FakeModel("deepseek-v4-flash-free"),
    )

    # grep
    await tools["grep"]("def main", "test", "*.py")
    # glob
    await tools["glob"]("*.py", "test")
    # read (file)
    await tools["read"]("test/verify_tool_model_emit.py", 1, 5)

    print("=== emitted events (tool / tool_result) ===")
    for ev in events:
        if ev.get("kind") in ("tool", "tool_result"):
            print(f"  {ev['kind']:12} {ev['tool']:12} model={ev.get('model')!r}")

    tool_evs = [e for e in events if e.get("kind") == "tool"]
    missing = [e["tool"] for e in tool_evs if not e.get("model")]
    print()
    if missing:
        print(f"❌ MISSING model on: {missing}")
        sys.exit(1)
    print("✅ ALL tool events carry the search-subagent model name")


if __name__ == "__main__":
    asyncio.run(main())