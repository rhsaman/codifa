"""Unit test: models.dev context/reasoning resolution for cloudflare,
tokenrouter and nvidia.

The context meter at the top of the app (and the thinking pill) are driven by
per-model context/reasoning metadata that the backend enriches from the
models.dev catalog. Three gateways were silently missing it:

* cloudflare  -> catalog key is "cloudflare-workers-ai", not "cloudflare"
* tokenrouter -> no catalog key; the model id's own provider prefix
                 ("openai/gpt-4o" -> "openai") must be tried
* nvidia      -> ids are prefixed ("nvidia/<model>") and must resolve against
                 the "nvidia" catalog key

Run standalone (`python backend/tests/test_models_dev.py`) or via
`python backend/tests/run_tests.py`.
"""
import asyncio
import os
import tempfile

# Hermetic data root BEFORE importing anything that touches state_db.
_TMP = tempfile.mkdtemp(prefix="coder-test-modelsdev-data-")
os.environ["CODER_DATA_DIR"] = _TMP

from providers import (  # noqa: E402
    _models_dev_context,
    _models_dev_keys,
    _models_dev_reasoning,
    _models_dev_provider_key,
)

# A slice of the real models.dev catalog shape (keys + ids as they actually
# appear there).
CATALOG = {
    "cloudflare-workers-ai": {
        "models": {
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
                "limit": {"context": 24000},
                "reasoning": True,
            },
        }
    },
    "openai": {
        "models": {
            "gpt-4o": {"limit": {"context": 128000}, "reasoning": False},
        }
    },
    "anthropic": {
        "models": {
            "claude-opus-4-7": {"limit": {"context": 1000000}, "reasoning": True},
        }
    },
    "nvidia": {
        "models": {
            "nvidia/nemotron-mini-4b-instruct": {
                "limit": {"context": 131072},
                "reasoning": True,
            },
        }
    },
}


def check(label: str, got, want) -> bool:
    ok = got == want
    print(f"  {'OK' if ok else 'FAIL'}: {label} -> {got}")
    return ok


async def main() -> None:
    ok = True

    # cloudflare: provider key resolves to the catalog's real key.
    ok &= check(
        "cloudflare provider key",
        _models_dev_provider_key("cloudflare", ""),
        "cloudflare-workers-ai",
    )
    keys = _models_dev_keys("cloudflare", "", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
    ok &= check("cloudflare keys", keys, ["cloudflare-workers-ai", "@cf"])
    ok &= check(
        "cloudflare ctx",
        _models_dev_context(CATALOG, keys, "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        24000,
    )
    ok &= check(
        "cloudflare reasoning",
        _models_dev_reasoning(CATALOG, keys, "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        True,
    )

    # tokenrouter: no catalog key of its own; the model id's provider prefix
    # ("openai") is tried and resolves against the upstream provider's entry.
    keys = _models_dev_keys("tokenrouter", "", "openai/gpt-4o")
    ok &= check("tokenrouter keys", keys, ["tokenrouter", "openai"])
    ok &= check(
        "tokenrouter ctx",
        _models_dev_context(CATALOG, keys, "openai/gpt-4o"),
        128000,
    )

    # tokenrouter renames upstream models with dots + speed suffixes
    # ("anthropic/claude-opus-4.7-fast") while models.dev keys them with dashes
    # ("claude-opus-4-7") — the normalized fallback must resolve it.
    keys = _models_dev_keys("tokenrouter", "", "anthropic/claude-opus-4.7-fast")
    ok &= check("tokenrouter fast keys", keys, ["tokenrouter", "anthropic"])
    ok &= check(
        "tokenrouter fast ctx (normalized)",
        _models_dev_context(CATALOG, keys, "anthropic/claude-opus-4.7-fast"),
        1000000,
    )
    ok &= check(
        "tokenrouter fast reasoning (normalized)",
        _models_dev_reasoning(CATALOG, keys, "anthropic/claude-opus-4.7-fast"),
        True,
    )

    # nvidia: prefixed ids resolve against the "nvidia" key directly.
    keys = _models_dev_keys("nvidia", "", "nvidia/nemotron-mini-4b-instruct")
    ok &= check("nvidia keys", keys, ["nvidia"])
    ok &= check(
        "nvidia ctx",
        _models_dev_context(CATALOG, keys, "nvidia/nemotron-mini-4b-instruct"),
        131072,
    )

    # opencode: bare ids stay bare, no spurious prefix key.
    keys = _models_dev_keys("opencode", "", "deepseek-v4-flash-free")
    ok &= check("opencode keys", keys, ["opencode"])
    ok &= check(
        "opencode ctx (unknown in this catalog)",
        _models_dev_context(CATALOG, keys, "deepseek-v4-flash-free"),
        None,
    )

    if not ok:
        raise SystemExit("MODELS-DEV TESTS FAILED")
    print("MODELS-DEV TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())