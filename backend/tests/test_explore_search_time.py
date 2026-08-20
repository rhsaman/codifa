"""Explore SEARCH TIME + QUALITY tests.

Requirements (user):
1. FAST — an explore must finish in a bounded number of model round-trips /
   sub-searches: per-thoroughness budgets (quick < medium < very thorough).
2. QUALITY — it must still FIND what it needs: a quick explore that does the
   right targeted searches returns a report citing the real file.
3. NO TOKEN WASTE — a fruitless explore (searches return nothing) stops EARLY
   instead of burning the whole budget on re-sent transcripts (each sub-agent
   model request re-sends the entire transcript, so a fruitless round-trip is
   pure token burn).

Mechanisms under test:
- ``_explore_usage_limits``: per-thoroughness request/tool-call caps +
  ``empty_stop_after`` (consecutive empty results allowed before stopping).
- ``_sub_track_result`` / ``_sub_empty_ctx``: the sub-tools count consecutive
  empty results (grep/glob with no matches, read errors); any real content
  resets the streak and marks the branch as having found something.
- ``_PerStepFallbackModel.request``: early stop — when the streak reaches the
  threshold:
    * nothing useful found at all (found_any=False) -> returns a
      "SEARCH STOPPED EARLY ... not found" report WITHOUT calling the model
      (no more token burn);
    * something WAS found earlier (found_any=True) -> raises ``_SubEarlyStop``
      so the findings-so-far are returned as the report (quality: partial
      findings are never discarded).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-explore-search-time-data-")
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

from tools import _explore_usage_limits, _tool_event, make_tool_callbacks  # noqa: E402


class _ScriptedExplore(TestModel):
    """A sub-agent model that follows an exact scripted tool-call sequence
    (tool name + args per round), then reports. Lets tests drive the sub-agent's
    search behavior deterministically (how many rounds, which searches)."""

    def __init__(self, calls: list[tuple[str, dict]], final_text: str):
        super().__init__(call_tools=[], custom_output_text=final_text)
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
                    ToolCallPart(
                        name, args, tool_call_id=f"pyd_ai_test_call_{done}"
                    )
                ],
                model_name=self._model_name,
            )
        return ModelResponse(
            parts=[TextPart(self._final)], model_name=self._model_name
        )


def _sub_tools(emitted: list[dict]) -> list[dict]:
    return [e for e in emitted if e.get("kind") == "tool" and e.get("sub")]


async def _explore(ws: str, prompt: str, explore_model) -> tuple[str, list[dict]]:
    emitted: list[dict] = []
    tools = make_tool_callbacks(
        ws,
        lambda ev: emitted.append(_tool_event(ev)),  # real SSE field filter
        explore_model=explore_model,
        main_model=TestModel(custom_output_text="done"),
    )
    report = await tools["task"](
        description="test", prompt=prompt, subagent_type="explore"
    )
    return report, emitted


def _check_limits_unit() -> None:
    quick = _explore_usage_limits("quick")
    medium = _explore_usage_limits("medium")
    very = _explore_usage_limits("very thorough")
    assert quick["request_limit"] < medium["request_limit"] < very["request_limit"], (
        quick, medium, very
    )
    assert (
        quick["tool_calls_limit"]
        < medium["tool_calls_limit"]
        < very["tool_calls_limit"]
    ), (quick, medium, very)
    assert (
        quick["empty_stop_after"]
        <= medium["empty_stop_after"]
        <= very["empty_stop_after"]
    ), "empty_stop_after must scale with thoroughness"
    assert quick["widen_max"] == 1 and medium["widen_max"] == very["widen_max"] == 2
    # Content-gathering keeps a high floor so broad tasks finish in one run.
    qc = _explore_usage_limits("quick", content_gathering=True)
    assert qc["request_limit"] >= 12 and qc["tool_calls_limit"] >= 24, qc
    # Unknown thoroughness -> medium defaults.
    assert _explore_usage_limits("banana")["tool_calls_limit"] == medium[
        "tool_calls_limit"
    ]
    print(
        "  usage-limits unit OK: quick"
        f" req={quick['request_limit']} calls={quick['tool_calls_limit']}"
        f" empty_stop={quick['empty_stop_after']}  <  medium"
        f" req={medium['request_limit']} calls={medium['tool_calls_limit']}"
        f" empty_stop={medium['empty_stop_after']}"
    )


async def _check_quality_and_speed(ws: str, pricing: str) -> None:
    """A well-behaved quick explore (targeted glob -> read -> report) must find
    the real file AND stay under the quick budget — fast and high quality."""
    model = _ScriptedExplore(
        calls=[
            ("glob", {"pattern": "**/*.py"}),
            ("read", {"filePath": pricing, "offset": 1, "limit": 2000}),
        ],
        # Sub-agents cite RELATIVE paths (the sub-tools return os.path.relpath
        # paths), so the report must use src/pricing.py — an absolute citation
        # would trip citation verification and trigger a wasteful correction
        # re-run, which is exactly what the speed requirement forbids.
        final_text=(
            "<results><files>src/pricing.py:1</files><answer>compute_total is "
            "defined at src/pricing.py:1</answer></results>"
        ),
    )
    report, emitted = await _explore(
        ws, "quick: find compute_total and report its file path", model
    )
    # QUALITY: the report carries the real file path.
    assert "src/pricing.py" in report, f"report must cite the real file, got: {report!r}"
    subs = _sub_tools(emitted)
    quick = _explore_usage_limits("quick")
    # SPEED: exactly the 2 scripted searches run — NO correction round (the
    # relative citation verified clean), no widen, no early-stop. Any extra
    # sub-search here means the run re-did work, i.e. it was slow.
    assert len(subs) == 2, (
        f"quick explore made {len(subs)} sub-searches, expected exactly 2"
    )
    # Scout honored: the FIRST search is a targeted glob, not a root re-list.
    assert subs and subs[0].get("tool") == "glob", (
        f"first sub-search should be a targeted glob, got {subs[0] if subs else None}"
    )
    # No widen/retry events on a well-behaved run.
    retries = [e for e in emitted if e.get("kind") == "retry"]
    assert not retries, f"no retries expected, got {retries}"
    print(
        f"  quality+speed OK: quick explore made {len(subs)} sub-searches"
        f" (budget {quick['tool_calls_limit']}) and found pricing.py"
    )


async def _check_fruitless_early_stop(ws: str) -> None:
    """A pathological sub-agent that keeps grepping for nonexistent strings must
    be stopped EARLY: with quick empty_stop_after=2, the 3rd+ scripted searches
    never run — the model wrapper short-circuits instead of burning more
    round-trips (the whole point of the no-token-waste requirement)."""
    fruitless = _ScriptedExplore(
        calls=[
            ("grep", {"pattern": "zzz_c_never_1"}),
            ("grep", {"pattern": "zzz_c_never_2"}),
            ("grep", {"pattern": "zzz_c_never_3"}),
            ("grep", {"pattern": "zzz_c_never_4"}),
            ("grep", {"pattern": "zzz_c_never_5"}),
        ],
        final_text="<results><answer>found nothing</answer></results>",
    )
    report, emitted = await _explore(ws, "quick: find zzz_nonexistent_thing", fruitless)
    subs = _sub_tools(emitted)
    assert len(subs) == 2, (
        f"expected exactly 2 sub-searches (empty_stop_after=2), got {len(subs)}"
    )
    assert "SEARCH STOPPED EARLY" in report, f"expected early-stop report, got: {report!r}"
    retries = [e for e in emitted if e.get("kind") == "retry"]
    assert not retries, f"no widen retries expected on a fruitless run, got {retries}"
    print(
        "  fruitless early-stop OK: scripted 5 searches, stopped after 2"
        " (model never called again — tokens saved)"
    )


async def _check_early_stop_keeps_findings(ws: str, pricing: str) -> None:
    """QUALITY guard on the early stop: if the sub-agent HAD found something
    (read a real file) and then went empty, the stop must NOT discard the
    findings — the report carries them (the _SubEarlyStop path)."""
    withfindings = _ScriptedExplore(
        calls=[
            ("read", {"filePath": pricing, "offset": 1, "limit": 2000}),
            ("grep", {"pattern": "zzz_d_never_1"}),
            ("grep", {"pattern": "zzz_d_never_2"}),
            ("grep", {"pattern": "zzz_d_never_3"}),
        ],
        final_text="<results><answer>found something</answer></results>",
    )
    report, emitted = await _explore(
        ws, "quick: investigate compute_total area", withfindings
    )
    assert "EXPLORATION STOPPED EARLY" in report, (
        f"expected findings-so-far report, got: {report!r}"
    )
    # The file the sub-agent read must survive in the report (never discard
    # partial findings).
    assert "pricing.py" in report, f"findings lost in early-stop report: {report!r}"
    print("  early-stop-keeps-findings OK: report preserves the read of pricing.py")


async def main() -> None:
    _check_limits_unit()

    ws = tempfile.mkdtemp(prefix="coder-test-explore-search-time-ws-")
    os.makedirs(os.path.join(ws, "src"), exist_ok=True)
    pricing = os.path.join(ws, "src", "pricing.py")
    with open(pricing, "w") as fh:  # noqa: ASYNC230
        fh.write("def compute_total(price, qty):\n    return price * qty\n")

    await _check_quality_and_speed(ws, pricing)
    await _check_fruitless_early_stop(ws)
    await _check_early_stop_keeps_findings(ws, pricing)

    print("explore-search-time OK: fast + high quality + no token waste")


if __name__ == "__main__":
    asyncio.run(main())
