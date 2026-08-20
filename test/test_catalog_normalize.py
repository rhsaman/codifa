"""Regression test: router-gateway model ids resolve to models.dev catalog entries.

TokenRouter serves DATED and FREE variants of upstream models
("deepseek-v4-pro-0813-free", "deepseek-v4-flash-0731") that models.dev keys
under the BASE model ("deepseek-v4-pro"). `_normalize_catalog_id` must strip
the "-free" and date suffixes so the variant's context/reasoning still resolves
against the catalog — otherwise `model_context()` returns 0, the request budget
falls back to the 32k default, and the UI context meter shows no capacity.
"""
import asyncio
import os
import sys

os.environ.setdefault("CODER_DATA_DIR", "/tmp/codefa-test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from providers import (  # noqa: E402
    _models_dev_catalog,
    _models_dev_context,
    _models_dev_entry,
    _normalize_catalog_id,
    model_context,
)

BASE = "https://api.tokenrouter.com/v1"


def test_normalize_strips_free_and_date_suffixes() -> None:
    assert _normalize_catalog_id("deepseek-v4-pro-0813-free") == "deepseek-v4-pro"
    assert _normalize_catalog_id("deepseek-v4-flash-0731") == "deepseek-v4-flash"
    assert _normalize_catalog_id("deepseek-v4-flash-free") == "deepseek-v4-flash"
    assert _normalize_catalog_id("deepseek-v4-pro") == "deepseek-v4-pro"
    # Speed/dot normalization still works (unchanged behavior). The provider
    # prefix is kept — stripping it happens in `_models_dev_entry`.
    assert _normalize_catalog_id("anthropic/claude-opus-4.7-fast") == "anthropic/claude-opus-4-7"


def test_dated_free_variant_resolves_catalog_context() -> None:
    catalog = asyncio.run(_models_dev_catalog())
    entry = _models_dev_entry(catalog, ["deepseek"], "deepseek-v4-pro-0813-free")
    assert entry, "dated/free variant must resolve to the base catalog entry"
    ctx = _models_dev_context(catalog, ["deepseek"], "deepseek-v4-pro-0813-free")
    assert ctx and ctx > 0, f"expected a real context window, got {ctx}"


def test_model_context_returns_real_window_for_variant() -> None:
    ctx = asyncio.run(
        model_context("tokenrouter", "deepseek/deepseek-v4-pro-0813-free", BASE, "test-key")
    )
    assert ctx and ctx > 0, f"expected a real context window, got {ctx}"


if __name__ == "__main__":
    for fn in (
        test_normalize_strips_free_and_date_suffixes,
        test_dated_free_variant_resolves_catalog_context,
        test_model_context_returns_real_window_for_variant,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("ALL PASS")