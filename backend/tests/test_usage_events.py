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


def test_usage_event_includes_provider():
    # The provider field must be forwarded so the frontend can route usage
    # entries to the correct provider group in the sidebar.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
        },
    )
    ev = _usage_event_from_ai(ai, "claude-3.5-sonnet", provider="openrouter")
    assert ev is not None
    assert ev["provider"] == "openrouter"
    assert ev["model"] == "claude-3.5-sonnet"


def test_usage_event_provider_defaults_to_empty():
    # Legacy callers that don't pass provider should get an empty string.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
        },
    )
    ev = _usage_event_from_ai(ai, "gpt-4o")
    assert ev is not None
    assert ev["provider"] == ""


def test_usage_event_surfaces_reasoning_tokens():
    # Reasoning/thinking tokens (OpenAI o-series / Anthropic extended thinking /
    # DeepSeek reasoner) occupy the context window and must be surfaced so the
    # frontend context meter can sum them in (opencode's tokens.total includes
    # reasoning). OpenAI/Anthropic-native reports them under
    # output_token_details.reasoning_tokens.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1300,
            "output_token_details": {"reasoning_tokens": 500},
        },
    )
    ev = _usage_event_from_ai(ai, "openai/o3")
    assert ev["reasoning_tokens"] == 500


def test_usage_event_surfaces_reasoning_tokens_completion_details():
    # OpenAI raw / DeepSeek surfaces reasoning under
    # completion_tokens_details.reasoning_tokens.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1300,
            "completion_tokens_details": {"reasoning_tokens": 333},
        },
    )
    ev = _usage_event_from_ai(ai, "deepseek/reasoner")
    assert ev["reasoning_tokens"] == 333


def test_usage_event_reasoning_added_to_total_subset_fallback():
    # When the provider does NOT report its own total_tokens (subset convention),
    # the fallback hand-sum MUST include reasoning_tokens so the context meter is
    # opencode-faithful (total = input + output + reasoning). Here cache is a
    # subset of input (no cache key), so only input+output+reasoning is summed.
    # AIMessage validation requires total_tokens, so we set usage_metadata after
    # construction to exercise the fallback (provided_total == 0) path.
    ai = AIMessage(content="x")
    ai.usage_metadata = {
        "input_tokens": 1000,
        "output_tokens": 200,
        # no total_tokens -> fallback path
        "output_token_details": {"reasoning_tokens": 500},
    }
    ev = _usage_event_from_ai(ai, "openai/o3")
    assert ev["reasoning_tokens"] == 500
    # 1000 + 200 + 500 = 1700 (reasoning folded into the total).
    assert ev["total_tokens"] == 1700


def test_usage_event_reasoning_added_to_total_additive():
    # Anthropic-native (additive) convention: cache is separate from input, so the
    # true total is input + output + reasoning + cache_read + cache_write. Reasoning
    # must be included in that sum.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 500,
            "output_tokens": 40,
            "total_tokens": 999,  # ignored by additive branch (hand-sum wins)
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 150,
            "output_token_details": {"reasoning_tokens": 60},
        },
    )
    ev = _usage_event_from_ai(ai, "anthropic/claude")
    assert ev["reasoning_tokens"] == 60
    # 500 + 40 + 60 + 300 + 150 = 1050 (not the bogus 999).
    assert ev["total_tokens"] == 1050


def test_usage_event_reasoning_tokens_default_zero():
    # A non-reasoning model reports no reasoning tokens -> default to 0 so the
    # frontend sum stays correct without special-casing.
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_tokens": 1200,
        },
    )
    ev = _usage_event_from_ai(ai, "openai/gpt-4o")
    assert ev["reasoning_tokens"] == 0


def test_context_tokens_is_provider_total():
    # `context_tokens` (what the frontend context meter displays) must equal the
    # provider's `total_tokens` verbatim — NOT `total - output`. The meter and the
    # auto-compaction trigger both compare against the RAW window (compact_at_percent
    # of ctx), so they must use the SAME number (opencode's `tokens.total`). Reporting
    # `total - output` would make the meter disagree with the trigger and under-report
    # the true context footprint (output/reasoning/cache all occupy the window).
    # Subset provider: in=6286, cache_read=6144 (inside input), out=164,
    # provider total=6450 -> context_tokens = 6450 (the full total).
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 6286,
            "output_tokens": 164,
            "total_tokens": 6450,
            "input_token_details": {"cache_read": 6144},
        },
    )
    ev = _usage_event_from_ai(ai, "openrouter/hy3-free")
    assert ev["context_tokens"] == 6450

    # Additive provider (Anthropic): total = in + out + reasoning + cache_read
    # + cache_write = 500 + 40 + 60 + 300 + 150 = 1050 -> context = 1050 (full total).
    ai2 = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 500,
            "output_tokens": 40,
            "total_tokens": 999,  # ignored by additive branch
            "cache_read_input_tokens": 300,
            "cache_creation_input_tokens": 150,
            "output_token_details": {"reasoning_tokens": 60},
        },
    )
    ev2 = _usage_event_from_ai(ai2, "anthropic/claude")
    assert ev2["context_tokens"] == 1050


def test_last_context_tokens_uses_provider_total_not_hand_sum():
    # Regression: `state["last_context_tokens"]` (the value auto-compaction fires
    # off) must use the provider-aware `total_tokens` from the usage event, NOT a
    # hand-sum of the breakdown. For subset providers (OpenAI/OpenRouter/hy3-free)
    # cache_read/write is already folded into input_tokens, so a hand-sum would
    # double-count the cache (~2x the real context). The usage event's
    # total_tokens already respects the additive/subset convention.
    from graph import _usage_event_from_ai

    # Subset provider: in=6286, cache_read=6144 (already inside input), out=164.
    # Provider total = 6450. A hand-sum would give ~12430 (double-count).
    ai = AIMessage(
        content="x",
        usage_metadata={
            "input_tokens": 6286,
            "output_tokens": 164,
            "total_tokens": 6450,
            "input_token_details": {"cache_read": 6144},
        },
    )
    ev = _usage_event_from_ai(ai, "openrouter/hy3-free")
    assert ev["total_tokens"] == 6450
    # The compaction trigger must see the provider total, never the double-count.
    assert ev["total_tokens"] < 6286 + 164 + 6144


def test_usage_event_includes_provider_field():
    """provider field is surfaced so the frontend groups usage under the correct provider."""
    ai = AIMessage(
        content="hi",
        usage_metadata={
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
        },
    )
    ev = _usage_event_from_ai(ai, "claude-3.5-sonnet", provider="openrouter")
    assert ev is not None
    assert ev["provider"] == "openrouter"


def test_usage_event_provider_default_empty():
    """When no provider is passed, the field defaults to empty string (legacy compat)."""
    ai = AIMessage(
        content="hi",
        usage_metadata={
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
        },
    )
    ev = _usage_event_from_ai(ai, "gpt-4o")
    assert ev is not None
    assert ev["provider"] == ""


def test_usage_event_from_llm_generate_includes_provider():
    """usage_event() in llm.py also surfaces the provider field."""
    from llm import usage_event

    metadata = {
        "input_tokens": 500,
        "output_tokens": 40,
        "total_tokens": 540,
    }
    ev = usage_event(metadata, model="gpt-4o", provider="openrouter")
    assert ev is not None
    assert ev["provider"] == "openrouter"
    assert ev["model"] == "gpt-4o"
    # provider_id defaults to "" (legacy callers) — never absent.
    assert ev["provider_id"] == ""
