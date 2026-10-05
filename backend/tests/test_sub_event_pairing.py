"""Sub-agent SSE pairing: concurrent same-tool calls keep their own ids.

Regression for the name-based FIFO in ``tools._emit`` (pop the oldest
pending id on each ``tool_result``): when two sub-agent ``run_terminal``
calls ran concurrently and finished OUT of order, the fast result popped
the slow call's id and vice versa — the frontend paired each result with
the wrong card. Pairing now rides the per-invocation ``ContextVar`` set by
``_invoke`` (same mechanism as parent tools), so completion order can
never swap ids.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-subpair-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import (
    _SUB_AGENT_BRANCH_CTX,
    _SUB_AGENT_CTX,
    make_tool_callbacks,
)


def _cmd_of(ev):
    return str((ev.get("args") or {}).get("command") or "")


def _text_of(ev):
    res = ev.get("results") or []
    try:
        return " ".join(str(r.get("content") or "") for r in res if isinstance(r, dict))
    except Exception:  # noqa: BLE001 — test helper only
        return ""


async def test_sub_parallel_results_keep_own_ids():
    """Slow sub call started first, fast sub call finishes first."""
    events: list[dict] = []
    cbs = make_tool_callbacks(
        root="/tmp",
        emit=events.append,
        main_model=None,
    )
    run = cbs["run_terminal"]
    tok = _SUB_AGENT_CTX.set(True)
    tokb = _SUB_AGENT_BRANCH_CTX.set(9)
    try:
        slow = asyncio.create_task(run(command="sleep 0.4 && echo slow-marker"))
        await asyncio.sleep(0.1)
        fast_text = await run(command="echo fast-marker")
        slow_text = await slow
    finally:
        _SUB_AGENT_CTX.reset(tok)
        _SUB_AGENT_BRANCH_CTX.reset(tokb)
    assert "fast-marker" in fast_text
    assert "slow-marker" in slow_text
    tools_ev = [e for e in events if e.get("kind") == "tool" and e.get("tool") == "run_terminal"]
    res_ev = [e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "run_terminal"]
    assert len(tools_ev) == 2, f"expected 2 tool events, got {len(tools_ev)}"
    assert len(res_ev) == 2, f"expected 2 results, got {len(res_ev)}"
    assert all(e.get("sub") is True for e in tools_ev + res_ev)
    tool_id_by_marker = {}
    for e in tools_ev:
        cmd = _cmd_of(e)
        marker = "slow-marker" if "slow-marker" in cmd else ("fast-marker" if "fast-marker" in cmd else "")
        assert marker, f"unexpected tool command: {cmd!r}"
        tool_id_by_marker[marker] = e.get("call_id")
    assert tool_id_by_marker["slow-marker"] != tool_id_by_marker["fast-marker"]
    for r in res_ev:
        text = _text_of(r) or str(r.get("summary") or "")
        marker = "slow-marker" if "slow-marker" in text else ("fast-marker" if "fast-marker" in text else "")
        assert marker, f"result matches neither call: {text[:120]!r}"
        assert r.get("call_id") == tool_id_by_marker[marker], (
            f"result for {marker} carries the other call's id "
            f"({r.get('call_id')!r} != {tool_id_by_marker[marker]!r})"
        )


if __name__ == "__main__":
    asyncio.run(test_sub_parallel_results_keep_own_ids())
    print("OK")
