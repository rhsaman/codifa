"""Probe: does a pydantic-ai async tool see a contextvar set in the run context?

The parallel-explore fix relies on `_sub_seen_ctx` / `_sub_emit_ctx` (set per
branch in `_run_explore`) being visible inside the sub-agent's read/grep/glob
tools. pydantic-ai runs each tool call as a separate async task — contextvars
propagate to child tasks created from within the branch task, but if pydantic-ai
runs tools via a thread pool or a task created OUTSIDE the branch context, the
per-branch value is lost and every branch falls back to the SHARED dedup sets
(→ all branches converge on the same searches) and to the branch-less emit path
(→ the frontend nests every sub-event into EVERY running explore card).

This probe runs a real pydantic-ai Agent whose tool reads a contextvar set just
before `agent.run()`, and prints what the tool actually saw.
"""
import asyncio
import contextvars
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai import Agent, Tool  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

_CTX: contextvars.ContextVar = contextvars.ContextVar("probe_ctx", default="UNSET")


async def main():
    seen: list[str] = []

    async def probe_tool() -> str:
        seen.append(_CTX.get())
        return "ok"

    agent = Agent(TestModel(), tools=[Tool(probe_tool, name="probe")])

    # Set the contextvar in the CURRENT task, then run the agent in a child task
    # (mirrors _run_explore: contextvar set inside the branch task, sub-agent
    # run happens in that same task).
    async def run_in_task():
        _CTX.set("BRANCH-7")
        await agent.run("call the probe tool")

    await asyncio.gather(run_in_task())

    print(f"  tool saw contextvar = {seen!r}")
    if seen == ["BRANCH-7"]:
        print("PROBE PASSED: contextvar propagates into pydantic-ai tool calls")
    else:
        print("PROBE FAILED: contextvar LOST inside tool call")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())