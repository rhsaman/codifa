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


def test_usage_event_surfaces_anthropic_nested_cache():
    # LangChain's Anthropic integration nests cache counts under
    # input_token_details (cache_read_input_tokens / cache_creation_input_tokens),
    # not the OpenAI-style cached_tokens nor a top-level key. The frontend context
    # meter depends on this being surfaced as cache_read/cache_write, otherwise it
    # collapses to the non-cached input_tokens and under-reports the true context.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 350,
            "output_tokens": 40,
            "total_tokens": 5400,
            "input_token_details": {
                "cache_read_input_tokens": 5000,
                "cache_creation_input_tokens": 10,
            },
        },
    )
    ev = _usage_event_from_ai(ai, "anthropic/claude")
    assert ev["input_tokens"] == 350
    assert ev["output_tokens"] == 40
    assert ev["cache_read_tokens"] == 5000
    assert ev["cache_write_tokens"] == 10
    assert ev["total_tokens"] == 350 + 40 + 5000 + 10


def test_usage_event_cache_read_is_subset_of_input():
    # OpenRouter / OpenAI-style providers nest the cached history under
    # input_token_details.cache_read, but input_tokens ALREADY includes it
    # (total = input + output already counts the cache). So the cache is a SUBSET:
    # surface it for cost math, but do NOT add it back to the total (that would
    # double-count). The true context is the provider's total_tokens (5847).
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 5776,
            "output_tokens": 71,
            "total_tokens": 5847,
            "input_token_details": {"cache_read": 5568},
            "output_token_details": {"reasoning": 32},
        },
    )
    ev = _usage_event_from_ai(ai, "openrouter/anthropic")
    assert ev["input_tokens"] == 5776
    assert ev["output_tokens"] == 71
    assert ev["cache_read_tokens"] == 5568
    assert ev["cache_write_tokens"] == 0
    # cache_read is a subset of input_tokens -> total stays the provider total.
    assert ev["total_tokens"] == 5847


def test_usage_event_promotes_to_additive_when_cache_exceeds_input():
    # A provider that reports cache under the literal `cache_read` key but where
    # the cached portion is LARGER than input_tokens proves input excludes the
    # cache -> promote to additive so the true context is reconstructed.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 208,
            "output_tokens": 40,
            "total_tokens": 248,
            "input_token_details": {"cache_read": 5568},
        },
    )
    ev = _usage_event_from_ai(ai, "anthropic/proxy")
    assert ev["cache_read_tokens"] == 5568
    # 208 (new) + 40 (out) + 5568 (cached) = 5816 true context.
    assert ev["total_tokens"] == 208 + 40 + 5568


def test_usage_event_returns_none_when_no_usage():
    ai = AIMessage(content="hi")
    assert _usage_event_from_ai(ai, "m") is None


def test_usage_event_returns_none_on_zero_tokens():
    # A degenerate (rejected / empty) request must not emit a 0-token event,
    # or the frontend context meter would drop to a misleading 0%.
    ai = AIMessage(content="hi", usage_metadata={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0})
    assert _usage_event_from_ai(ai, "m") is None
