"""Run every backend live test module sequentially.

Usage:  python3 backend/tests/run_tests.py
Each module runs its own in-process mock server against the real backend.
"""
import asyncio
import contextvars
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

TESTS = [
    "test_resume",
    "test_parallel_tools",
    "test_task_unknown_agent",
    "test_task_general_agent",
    "test_task_depth_limit",
    "test_issues",
    "test_compact",
    "test_models_dev",
]


async def run_one(name: str) -> bool:
    print(f"\n=== {name} ===")
    try:
        mod = importlib.import_module(name)
        # Run each module in a FRESH contextvars context: the modules share one
        # process/event loop, and tools.py/agents.py keep run-scoped state in
        # contextvars (e.g. _PARENT_TOOLS_CTX, set by run_agent and never
        # reset). Without isolation that state leaks into the next module —
        # e.g. test_task_general_agent's general sub-agent inherited the
        # PREVIOUS run's tool closures (bound to a dead emit callback), so its
        # read event never reached the test's listener. A fresh context resets
        # every contextvar to its default, matching production where each
        # request runs in its own task context.
        ctx = contextvars.Context()
        task = ctx.run(asyncio.create_task, mod.main())
        await task
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED {name}: {exc!r}")
        import traceback
        traceback.print_exc()
        return False
    return True


async def main() -> int:
    ok = 0
    for t in TESTS:
        if await run_one(t):
            ok += 1
    print(f"\n{ok}/{len(TESTS)} test modules passed")
    return 0 if ok == len(TESTS) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))