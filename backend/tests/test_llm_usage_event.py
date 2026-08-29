"""Tests that ``llm.usage_event`` surfaces the TRUE token counts (input /
output / cache / reasoning) so the sidebar can show per-model cost and the
title bar can show real consumed context, including reasoning tokens.

These lock in the contract that ``usage_event`` extracts the exact provider
numbers (no guessing, no zero-events that would blank the meter).
"""
from llm import usage_event


def test_usage_event_surfaces_reasoning_tokens():
    # OpenAI o-series / Anthropic extended thinking report reasoning under
    # output_token_details.reasoning_tokens. The frontend context meter sums
    # it into the opencode-faithful total, so it must be surfaced.
    meta = {
        "input_tokens": 1000,
        "output_tokens": 200,
        "total_tokens": 1300,
        "output_token_details": {"reasoning_tokens": 500},
    }
    ev = usage_event(meta, model="openai/o3")
    assert ev is not None
    assert ev["reasoning_tokens"] == 500


def test_usage_event_reasoning_tokens_default_zero():
    # A non-reasoning model reports no reasoning tokens -> default to 0.
    meta = {
        "input_tokens": 1000,
        "output_tokens": 200,
        "total_tokens": 1200,
    }
    ev = usage_event(meta, model="openai/gpt-4o")
    assert ev is not None
    assert ev["reasoning_tokens"] == 0


def test_usage_event_reasoning_added_to_total_subset_fallback():
    # When no provider total_tokens is given (subset convention), the fallback
    # hand-sum MUST include reasoning_tokens (opencode-faithful total).
    meta = {
        "input_tokens": 1000,
        "output_tokens": 200,
        # no total_tokens -> fallback path
        "output_token_details": {"reasoning_tokens": 500},
    }
    ev = usage_event(meta, model="openai/o3")
    assert ev is not None
    assert ev["reasoning_tokens"] == 500
    # 1000 + 200 + 500 = 1700.
    assert ev["total_tokens"] == 1700


def test_usage_event_reasoning_added_to_total_additive():
    # Anthropic-native (additive): cache is separate from input, so the true total
    # is input + output + reasoning + cache_read + cache_write.
    meta = {
        "input_tokens": 500,
        "output_tokens": 40,
        "cache_read_input_tokens": 300,
        "cache_creation_input_tokens": 150,
        "output_token_details": {"reasoning_tokens": 60},
    }
    ev = usage_event(meta, model="anthropic/claude")
    assert ev is not None
    assert ev["reasoning_tokens"] == 60
    # 500 + 40 + 60 + 300 + 150 = 1050.
    assert ev["total_tokens"] == 1050


def test_usage_event_surfaces_cache_and_reasoning():
    meta = {
        "input_tokens": 500,
        "output_tokens": 40,
        "total_tokens": 540,
        "input_token_details": {"cached_tokens": 300},
        "output_token_details": {"reasoning_tokens": 25},
    }
    ev = usage_event(meta, model="m")
    assert ev is not None
    assert ev["cache_read_tokens"] == 300
    assert ev["reasoning_tokens"] == 25
