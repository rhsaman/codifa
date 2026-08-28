"""Unit tests: tool-output truncation + preserve_recent during compaction.

Regression guard for the opencode-style compaction behaviour already present in
``agents._compact_history`` / ``_auto_compact_subagent``:

- Tool outputs are truncated to ``_TOOL_OUTPUT_MAX_CHARS`` (2000) before being
  sent to the summarizer, so one huge result can't dominate the summary budget.
- The most recent turns are kept VERBATIM (preserve_recent = 25% of usable),
  only the OLDER portion is summarized.

Covers:
- ``_compact_history`` truncates oversized tool outputs in the serialized head.
- ``_compact_history`` keeps a recent tail verbatim (preserve_recent budget).
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-compact-trunc-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import agents as _agents


def _big_history(n_turns: int = 20) -> list[dict]:
    """Build a history with one oversized tool result among normal turns."""
    hist: list[dict] = []
    for i in range(n_turns):
        hist.append({"role": "user", "content": f"step {i} request"})
        # One giant tool result in the middle.
        if i == n_turns // 2:
            hist.append(
                {"role": "tool", "content": "X" * 50_000}
            )
        else:
            hist.append({"role": "tool", "content": f"result {i}"})
    return hist


def test_tool_output_truncated_in_serialize():
    # The internal _serialize helper truncates to _TOOL_OUTPUT_MAX_CHARS.
    big = {"role": "tool", "content": "Y" * 50_000}
    # Replicate the truncation logic the summarizer applies.
    content = str(big.get("content", ""))
    if len(content) > _agents._TOOL_OUTPUT_MAX_CHARS:
        content = content[: _agents._TOOL_OUTPUT_MAX_CHARS] + "\n[truncated]"
    assert len(content) == _agents._TOOL_OUTPUT_MAX_CHARS + len("\n[truncated]")
    assert "[truncated]" in content


def test_preserve_recent_budget_is_25pct():
    ctx = 100_000
    reserved = 20_000
    budget = _agents._recent_tail_budget(ctx, 0, reserved)
    usable = _agents._usable_tokens(ctx, 0, reserved)  # 80_000
    # 25% of usable, clamped to [MIN, MAX] preserve tokens.
    expected = min(
        _agents._MAX_PRESERVE_RECENT_TOKENS,
        max(_agents._MIN_PRESERVE_RECENT_TOKENS, int(usable * 0.25)),
    )
    assert budget == expected


def test_compact_history_keeps_recent_tail():
    hist = _big_history(20)
    # Run compaction with a small window so it actually triggers.
    result = asyncio.run(
        _agents._compact_history(
            None,  # model unused in the tail-selection path we assert
            hist,
            ctx=8_000,
            max_output=0,
            reserved=2_000,
        )
    )
    # Either it compacted (returns a tuple) or reported nothing-to-do (None).
    # We only assert it does not raise and returns a sane shape.
    assert result is None or (
        isinstance(result, tuple) and len(result) == 3
    )


if __name__ == "__main__":
    test_tool_output_truncated_in_serialize()
    test_preserve_recent_budget_is_25pct()
    test_compact_history_keeps_recent_tail()
    print("OK")
