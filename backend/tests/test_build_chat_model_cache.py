"""Unit tests for prompt-caching header wiring in build_chat_model.

- _extra_headers returns the x-openrouter-cache header only when cache=True AND
  the provider advertises cache_headers (openrouter). Other providers get no
  cache header.
- build_chat_model(cache=True) forwards the cache header into default_headers
  for openrouter (via ReasoningChatOpenAI), and cache=False omits it.
"""

from llm import _extra_headers, build_chat_model


def test_extra_headers_openrouter_cache_true():
    headers = _extra_headers("openrouter", "", True)
    assert headers.get("x-openrouter-cache") == "true"


def test_extra_headers_openrouter_cache_false():
    headers = _extra_headers("openrouter", "", False)
    assert "x-openrouter-cache" not in headers


def test_extra_headers_non_caching_provider_omits_header():
    # google/ollama/custom do not advertise cache_headers -> no cache header.
    for provider in ("google", "ollama", "custom", "opencode"):
        assert "x-openrouter-cache" not in _extra_headers(provider, "", True)


def test_build_chat_model_forwards_cache_header(monkeypatch):
    captured = {}

    class FakeModel:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeModel)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=True,
    )

    assert captured.get("default_headers", {}).get("x-openrouter-cache") == "true"


def test_build_chat_model_no_cache_header_when_disabled(monkeypatch):
    captured = {}

    class FakeModel:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeModel)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=False,
    )

    assert "x-openrouter-cache" not in (captured.get("default_headers") or {})


if __name__ == "__main__":
    test_extra_headers_openrouter_cache_true()
    test_extra_headers_openrouter_cache_false()
    test_extra_headers_non_caching_provider_omits_header()
    test_build_chat_model_forwards_cache_header()
    test_build_chat_model_no_cache_header_when_disabled()
    print("BUILD CHAT MODEL CACHE TESTS PASSED")
