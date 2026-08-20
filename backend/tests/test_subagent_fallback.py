"""Live test: sub-agent model hard-failure falls back to the MAIN model.

Verifies the fallback added for explore / web / search sub-agents:

1. A tool call that uses a sub-agent model first tries the sub-agent model; on
   a hard failure (bad key / invalid model / quota exhaustion) it re-runs the
   call on the MAIN model instead of degrading to a raw-output note.
2. A ``retry`` event with ``fallback: true`` is emitted so the UI shows the
   distinct 'sub-agent failed — using main model' banner.
3. The fallback is STICKY per slot per turn: the next call for the same slot
   goes straight to the main model (no second fallback event).

The test drives the ``run_terminal`` search-reader path (the only fallback
path that needs no network): a search command whose output is >= 600 chars
triggers the "search" sub-agent reader, which we force to fail with a fake
model object.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-fallback-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import make_tool_callbacks  # noqa: E402


class _FakeModel:
    """A model object that raises when pydantic-ai tries to use it."""

    def __init__(self, name: str, error: str):
        self.model_name = name
        self._error = error

    def __repr__(self):
        return f"<FakeModel {self.model_name}>"


SUB_MODEL = _FakeModel("sub-agent-model", "SUBAGENT MODEL ERROR")
MAIN_MODEL = _FakeModel("main-model", "MAIN MODEL ERROR")


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-fallback-ws-")
    # A file big enough that `cat` produces >= 600 chars of output.
    with open(os.path.join(ws, "big.txt"), "w") as fh:  # noqa: ASYNC230
        for i in range(120):
            fh.write(f"line {i}: some content to make the output long enough\n")

    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),
        search_model=SUB_MODEL,
        main_model=MAIN_MODEL,
    )
    terminal = tools["run_terminal"]

    # --- First call: sub-agent model fails -> falls back to main model, which
    # also fails -> terminal_tool swallows the error and returns the RAW output
    # with a note naming the failed model. A fallback event is emitted naming
    # the failed sub-agent model and the main model.
    result = await terminal("cat big.txt")
    assert "search sub-agent" in result.lower() or "sub-agent" in result.lower(), (
        f"expected a sub-agent failure note in the result, got: {result[:200]!r}"
    )
    assert "line 0" in result, f"expected raw output to be included, got: {result[:200]!r}"

    fallback_evs = [e for e in emitted if e.get("fallback")]
    assert len(fallback_evs) == 1, (
        f"expected exactly 1 fallback event, got {len(fallback_evs)}: {fallback_evs}"
    )
    ev = fallback_evs[0]
    assert ev.get("kind") == "retry", f"expected retry kind, got {ev.get('kind')}"
    assert "sub-agent-model" in ev.get("reason", ""), (
        f"reason should name the failed sub-agent model: {ev.get('reason')}"
    )
    assert ev.get("model") == "main-model", (
        f"fallback event should name the main model: {ev.get('model')}"
    )

    # --- Second call: STICKY — goes straight to the main model, so no new
    # fallback event is emitted (the sub-agent model is never tried again).
    emitted.clear()
    result2 = await terminal("cat big.txt")
    assert "line 0" in result2, f"expected raw output, got: {result2[:200]!r}"
    assert not [e for e in emitted if e.get("fallback")], (
        "sticky fallback: second call must NOT emit another fallback event"
    )

    print("  fallback OK: sub-agent model failed -> re-ran on main model, sticky per slot")
    print("SUBAGENT-FALLBACK TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())