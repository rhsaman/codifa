"""Live test: parallel SAME-NAMED tool calls keep their tool->result pairing.

The bug being guarded against: `make_tool_callbacks` used to correlate each
`tool_result` back to its originating `tool` by a name-based FIFO (pop the
oldest pending id for that tool name). When the SAME tool runs multiple times
in PARALLEL (pydantic-ai runs each call as a separate async task), completion
order can differ from start order — a name-based FIFO then swaps which card
owns which result. On a Stop this made the frontend mark the wrong cards done
(one left stuck "running") and the retried model re-ran already-completed
duplicates.

The fix threads a per-INVOCATION `call_id` through a `contextvars.ContextVar`
set inside each tool invocation, so a `tool` and its own `tool_result` always
share the same id regardless of completion order.

This test proves each parallel invocation is closed out with EXACTLY one result
sharing its own `call_id` — no result is lost, duplicated or left pending — even
though all N calls run concurrently and may finish out of order.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-parallel-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import make_tool_callbacks


async def _run_parallel_tools_cases() -> None:
    ws = tempfile.mkdtemp(prefix="coder-test-parallel-ws-")
    for name in "abcde":
        with open(os.path.join(ws, f"{name}.py"), "w") as fh:  # noqa: ASYNC230
            fh.write(f"def {name}():\n    return 1\n")

    emitted: list[dict] = []
    tools = make_tool_callbacks(ws, lambda ev: emitted.append(ev))
    grep = tools["grep"]

    patterns = [f"def {c}" for c in "abcde"]
    results = await asyncio.gather(*[grep(p) for p in patterns])
    assert all("MATCHES" in r for r in results), "grep expected to match"

    starts = [e for e in emitted if e.get("kind") == "tool"]
    ends = [e for e in emitted if e.get("kind") == "tool_result"]
    assert len(starts) == len(patterns), f"{len(starts)} starts != {len(patterns)}"
    assert len(ends) == len(patterns), f"{len(ends)} ends != {len(patterns)}"

    start_ids = [e["call_id"] for e in starts]
    assert len(set(start_ids)) == len(patterns), \
        f"parallel tool calls must each get a DISTINCT call_id, got {start_ids}"

    end_ids = [e["call_id"] for e in ends]
    assert len(set(end_ids)) == len(patterns), \
        f"tool_results must map to distinct call_ids, got {end_ids}"

    # Core invariant: every result's call_id is one of the start ids, and the
    # started/resolved id sets are IDENTICAL — i.e. no parallel call is left
    # pending (a "stuck running" card) and none is double-resolved.
    assert sorted(end_ids) == sorted(start_ids), \
        f"result ids {sorted(end_ids)} != start ids {sorted(start_ids)}"

    print(f"  parallel OK: {len(patterns)} parallel grep calls kept distinct ids "
          f"and each was resolved by exactly one matching result")
    print("PARALLEL-TOOLS TEST PASSED")


async def test_parallel_tools() -> None:
    """Same coverage as the legacy ``main()``; exposed as a pytest test so
    ``pytest tests/`` actually collects and runs it.
    """
    await _run_parallel_tools_cases()


def main() -> None:
    asyncio.run(_run_parallel_tools_cases())


if __name__ == "__main__":
    main()
