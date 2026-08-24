"""Tests that the LangChain usage -> frontend `usage` event mapping reports
the TRUE token counts (input / output / cache-read) so the sidebar can show
per-model cost and the title bar can show real consumed context.

These lock in the contract that `_usage_event_from_ai` extracts the exact
provider numbers (no guessing, no zero-events that would blank the meter).
"""
from langchain_core.messages import AIMessage

from graph import _usage_event_from_ai


def test_usage_event_reports_true_counts_and_model():
    ai = AIMessage(
        content="hi",
        usage_metadata={
            "input_tokens": 1234,
            "output_tokens": 56,
            "total_tokens": 1290,
            "input_token_details": {"cached_tokens": 1000},
            "output_token_details": {},
        },
    )
    ev = _usage_event_from_ai(ai, "openai/gpt-4o")
    assert ev is not None
    assert ev["kind"] == "usage"
    assert ev["input_tokens"] == 1234
    assert ev["output_tokens"] == 56
    assert ev["total_tokens"] == 1290
    # Cached tokens are surfaced as cache_read so cost can bill them cheaper.
    assert ev["cache_read_tokens"] == 1000
    assert ev["cache_write_tokens"] == 0
    assert ev["model"] == "openai/gpt-4o"


def test_usage_event_surfaces_cache_read_tokens():
    # Provider cache hits are billed cheaper; the sidebar needs the cached
    # portion split out so cost math is correct.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 500,
            "output_tokens": 40,
            "total_tokens": 540,
            "input_token_details": {"cached_tokens": 400},
        },
    )
    ev = _usage_event_from_ai(ai, "m")
    assert ev["input_tokens"] == 500
    assert ev["output_tokens"] == 40
    assert ev["cache_read_tokens"] == 400


def test_usage_event_surfaces_cache_write_tokens():
    # Prompt-cache creation (cache_write) is billed at its own rate; the sidebar
    # needs it split out so cost math is correct across providers.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 500,
            "output_tokens": 40,
            "total_tokens": 540,
            "input_token_details": {
                "cached_tokens": 300,
                "cache_creation_tokens": 150,
            },
        },
    )
    ev = _usage_event_from_ai(ai, "m")
    assert ev["input_tokens"] == 500
    assert ev["output_tokens"] == 40
    assert ev["cache_read_tokens"] == 300
    assert ev["cache_write_tokens"] == 150


def test_usage_event_surfaces_anthropic_cache_write():
    # Anthropic surfaces cache creation under cache_creation_input_tokens.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 500,
            "output_tokens": 40,
            "total_tokens": 540,
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 150,
        },
    )
    ev = _usage_event_from_ai(ai, "m")
    assert ev["cache_read_tokens"] == 300
    assert ev["cache_write_tokens"] == 150


def test_usage_event_returns_none_when_no_usage():
    ai = AIMessage(content="hi")
    assert _usage_event_from_ai(ai, "m") is None


def test_usage_event_returns_none_on_zero_tokens():
    # A degenerate (rejected / empty) request must not emit a 0-token event,
    # or the frontend context meter would drop to a misleading 0%.
    ai = AIMessage(content="hi", usage_metadata={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0})
    assert _usage_event_from_ai(ai, "m") is None
