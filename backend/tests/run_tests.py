"""Run every backend live test module sequentially.

Usage:  python3 backend/tests/run_tests.py
Each module runs its own in-process mock server against the real backend.
"""
import asyncio
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

TESTS = [
    "test_resume",
    "test_subagent",
    "test_parallel_tools",
    "test_issues",
    "test_compact",
]


async def run_one(name: str) -> bool:
    print(f"\n=== {name} ===")
    try:
        mod = importlib.import_module(name)
        await mod.main()
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