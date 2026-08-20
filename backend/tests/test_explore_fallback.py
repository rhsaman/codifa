"""Live test: explore sub-agent model failure falls back to the MAIN model.

Verifies the per-sub-search fallback for the EXPLORE path (grep/glob/read):

1. When the explore sub-agent model is unavailable / errors, EVERY individual
   grep/read/glob model request re-runs on the MAIN model instead of killing
   the explore (non-sticky per-step fallback).
2. A ``retry`` event with ``fallback: true`` is emitted for each fallback,
   naming the failed sub-agent model and the main model that actually ran.
3. The explore still completes with a report (the main model drives the
   searches and produces the report).
4. The fallback is NON-STICKY: once the sub-agent model recovers, the next
   request goes straight back to it (no permanent flip to the main model).

Raw events are collected (no ``_tool_event`` filter) because the whitelist
strips the ``fallback`` flag the UI banner needs — same as the existing
``test_subagent_fallback.py`` terminal-path test.
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-fallback-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pydantic_ai.messages import (  # noqa: E402
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.test import TestModel  # noqa: E402

from tools import make_tool_callbacks  # noqa: E402


class _Scripted(TestModel):
    """A model that follows an exact scripted tool-call sequence then reports."""

    def __init__(self, calls, final_text, model_name="main-model"):
        super().__init__(
            call_tools=[], custom_output_text=final_text, model_name=model_name
        )
        self._calls = list(calls)
        self._final = final_text

    def _request(self, messages, model_settings, model_request_parameters):
        done = sum(
            1
            for m in messages
            if isinstance(m, ModelRequest)
            and any(isinstance(p, ToolReturnPart) for p in m.parts)
        )
        if done < len(self._calls):
            name, args = self._calls[done]
            return ModelResponse(
                parts=[
                    ToolCallPart(name, args, tool_call_id=f"pyd_ai_test_call_{done}")
                ],
                model_name=self._model_name,
            )
        return ModelResponse(
            parts=[TextPart(self._final)], model_name=self._model_name
        )


class _AlwaysFail(TestModel):
    """Explore sub-agent model that is UNAVAILABLE: every request raises."""

    def __init__(self):
        super().__init__(call_tools=[], custom_output_text="never used")
        self.requests = 0

    async def request(self, messages, model_settings, model_request_parameters):
        self.requests += 1
        raise RuntimeError("sub-agent model unavailable (simulated)")


class _FailOnce(TestModel):
    """Explore sub-agent model that fails on the FIRST request only, then works."""

    def __init__(self):
        super().__init__(call_tools=[], custom_output_text="PRIMARY REPORT")
        self.requests = 0

    async def request(self, messages, model_settings, model_request_parameters):
        self.requests += 1
        if self.requests == 1:
            raise RuntimeError("sub-agent model unavailable (simulated)")
        return await super().request(
            messages, model_settings, model_request_parameters
        )


def _sub_tools(emitted: list[dict]) -> list[dict]:
    return [e for e in emitted if e.get("kind") == "tool" and e.get("sub")]


def _fallback_events(emitted: list[dict]) -> list[dict]:
    return [e for e in emitted if e.get("fallback")]


async def _run_explore(ws, prompt, explore_model, main_model):
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(ev),  # raw events: keep the fallback flag
        explore_model=explore_model,
        main_model=main_model,
    )
    report = await tools["task"](
        description="test", prompt=prompt, subagent_type="explore"
    )
    return report, emitted


async def main():
    ws = tempfile.mkdtemp(prefix="coder-test-explore-fallback-ws-")
    os.makedirs(os.path.join(ws, "src"), exist_ok=True)
    pricing = os.path.join(ws, "src", "pricing.py")
    with open(pricing, "w") as fh:
        fh.write("def compute_total(price, qty):\n    return price * qty\n")

    # --- Scenario A: sub-agent model UNAVAILABLE for every request. The main
    # model must drive every grep/read/glob step and produce the report.
    main_model = _Scripted(
        calls=[
            ("glob", {"pattern": "**/*.py"}),
            ("read", {"filePath": pricing, "offset": 1, "limit": 2000}),
        ],
        final_text="MAIN REPORT: found compute_total",
        model_name="main-model",
    )
    report, emitted = await _run_explore(
        ws,
        "find compute_total and report its file path",
        _AlwaysFail(),
        main_model,
    )
    assert "MAIN REPORT" in report, (
        f"explore must complete via the main model, got: {report[:300]!r}"
    )
    subs = _sub_tools(emitted)
    assert len(subs) == 2, (
        f"expected glob+read sub-searches on the main model, got {len(subs)}: "
        f"{[e.get('tool') for e in subs]}"
    )
    fb = _fallback_events(emitted)
    assert len(fb) == 3, (
        f"expected one fallback per model request (glob/read/report), got {len(fb)}: {fb}"
    )
    for ev in fb:
        assert ev.get("kind") == "retry", f"fallback event must be kind=retry: {ev}"
        assert "explore sub-search failed" in ev.get("reason", ""), ev
        assert ev.get("model") == "main-model", (
            f"fallback event must name the main model: {ev}"
        )
    print(
        "  scenario A OK: unavailable sub-agent model -> "
        f"{len(fb)} per-step fallbacks, {len(subs)} sub-searches "
        "(glob+read) ran on the main model, explore completed"
    )

    # --- Scenario B: sub-agent model fails ONCE then recovers. The fallback is
    # NON-STICKY: the next request goes straight back to the sub-agent model.
    primary = _FailOnce()
    main_model_b = _Scripted(
        calls=[("glob", {"pattern": "**/*.py"})],
        final_text="MAIN REPORT (must NOT be the final report)",
        model_name="main-model",
    )
    report2, emitted2 = await _run_explore(
        ws,
        "find compute_total and report its file path",
        primary,
        main_model_b,
    )
    assert "PRIMARY REPORT" in report2, (
        f"recovered sub-agent model must produce the report, got: {report2[:300]!r}"
    )
    fb2 = _fallback_events(emitted2)
    assert len(fb2) == 1, (
        f"expected exactly 1 fallback (non-sticky), got {len(fb2)}: {fb2}"
    )
    assert primary.requests >= 2, (
        "non-sticky: sub-agent model must be tried again after recovery, "
        f"requests={primary.requests}"
    )
    print(
        "  scenario B OK: non-sticky fallback — 1 fallback event, then the next "
        "request went back to the sub-agent model"
    )

    print("EXPLORE-FALLBACK TEST PASSED")


if __name__ == "__main__":
    asyncio.run(main())
