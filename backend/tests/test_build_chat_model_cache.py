"""Unit tests for prompt-caching header wiring in build_chat_model.

- _extra_headers returns the x-openrouter-cache header only when cache=True AND
  the provider advertises cache_headers (openrouter). Other providers get no
  cache header.
- build_chat_model(cache=True) forwards the cache header into default_headers
  for openrouter (via ReasoningChatOpenAI), and cache=False omits it.
- session_id (sticky routing) lands in x-session-id for openrouter only.
- Anthropic models on openrouter get a top-level cache_control (automatic
  prompt caching); other models/providers never receive it.
"""

from llm import _extra_headers, build_chat_model
from providers import UA_LADDER


def test_extra_headers_openrouter_cache_true():
    headers = _extra_headers("openrouter", "", True)
    assert headers.get("x-openrouter-cache") == "true"


def test_extra_headers_openrouter_cache_false():
    headers = _extra_headers("openrouter", "", False)
    assert "x-openrouter-cache" not in headers


def test_extra_headers_non_caching_provider_omits_header():
    # google/ollama/custom do not advertise cache_headers -> no cache header.
    for provider in ("google", "ollama", "custom"):
        assert "x-openrouter-cache" not in _extra_headers(provider, "", True)


def test_extra_headers_session_id_openrouter():
    headers = _extra_headers("openrouter", "", False, session_id="chat-42")
    assert headers.get("x-session-id") == "chat-42"


def test_extra_headers_session_id_other_providers_omitted():
    # Sticky routing is an OpenRouter feature; other providers must not see it.
    for provider in ("google", "ollama", "custom"):
        headers = _extra_headers(provider, "", True, session_id="chat-42")
        assert "x-session-id" not in headers


def test_extra_headers_empty_session_id_omits_header():
    assert "x-session-id" not in _extra_headers("openrouter", "", True, session_id="")


def test_extra_headers_custom_remote_gateway_gets_ua_ladder():
    """A custom provider with a REMOTE base URL gets the UA-ladder header so
    gateways that block unknown HTTP clients (401 "unauthorized client")
    accept the chat request. No gateway is hardcoded — the header applies to
    every remote custom endpoint."""
    headers = _extra_headers("custom", "https://some-gateway.example.com/v1", False)
    assert headers.get("User-Agent") == UA_LADDER[0]


def test_extra_headers_custom_local_server_no_ua_header():
    """Local custom servers (llama.cpp/Ollama/LM Studio) never UA-filter —
    sending a spoofed agent-CLI UA there is pointless (and can confuse
    request logs)."""
    for base in ("http://localhost:8080/v1", "http://127.0.0.1:11434/v1", ""):
        headers = _extra_headers("custom", base, False)
        assert "User-Agent" not in headers


def test_extra_headers_builtin_kinds_untouched():
    """Built-in kinds send no UA header (their gateways don't UA-filter); only
    remote custom gateways get the ladder."""
    for kind in ("google", "openrouter", "nvidia", "cloudflare", "tokenrouter"):
        assert "User-Agent" not in _extra_headers(kind, "", False)


def _capture_model(monkeypatch):
    captured = {}

    class FakeModel:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeModel)
    return captured


def test_build_chat_model_forwards_cache_header(monkeypatch):
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=True,
    )

    assert captured.get("default_headers", {}).get("x-openrouter-cache") == "true"


def test_build_chat_model_no_cache_header_when_disabled(monkeypatch):
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=False,
    )

    assert "x-openrouter-cache" not in (captured.get("default_headers") or {})


def test_build_chat_model_forwards_session_id(monkeypatch):
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        session_id="chat-42",
    )

    assert captured.get("default_headers", {}).get("x-session-id") == "chat-42"


def test_build_chat_model_anthropic_gets_cache_control(monkeypatch):
    """OpenRouter + Anthropic + cache=True → top-level automatic prompt
    caching via extra_body.cache_control."""
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=True,
    )

    assert captured.get("extra_body") == {"cache_control": {"type": "ephemeral"}}


def test_build_chat_model_non_anthropic_no_cache_control(monkeypatch):
    """Non-Anthropic models on openrouter must NOT receive cache_control —
    it is an Anthropic-only param and other models may 400 on it."""
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="openai/gpt-4o",
        api_key="test-key",
        cache=True,
    )

    assert "extra_body" not in captured


def test_build_chat_model_anthropic_cache_disabled_no_cache_control(monkeypatch):
    """cache=False (user turned caching off) → no cache_control either."""
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="openrouter",
        model="anthropic/claude-3.5-sonnet",
        api_key="test-key",
        cache=False,
    )

    assert "extra_body" not in captured


def test_build_chat_model_custom_provider_never_gets_cache_control(monkeypatch):
    """Local/custom providers (Qwen on llama.cpp, ollama, …) must stay
    untouched — this guards the Jinja/small-context fixes."""
    captured = _capture_model(monkeypatch)

    build_chat_model(
        provider="custom",
        model="qwen3-coder",
        base_url="http://localhost:8080/v1",
        api_key="test-key",
        cache=True,
    )

    assert "extra_body" not in captured
    assert "x-session-id" not in (captured.get("default_headers") or {})
    assert "x-openrouter-cache" not in (captured.get("default_headers") or {})


if __name__ == "__main__":
    test_extra_headers_openrouter_cache_true()
    test_extra_headers_openrouter_cache_false()
    test_extra_headers_non_caching_provider_omits_header()
    test_extra_headers_session_id_openrouter()
    test_extra_headers_session_id_other_providers_omitted()
    test_extra_headers_empty_session_id_omits_header()
    test_build_chat_model_forwards_cache_header()
    test_build_chat_model_no_cache_header_when_disabled()
    test_build_chat_model_forwards_session_id()
    test_build_chat_model_anthropic_gets_cache_control()
    test_build_chat_model_non_anthropic_no_cache_control()
    test_build_chat_model_anthropic_cache_disabled_no_cache_control()
    test_build_chat_model_custom_provider_never_gets_cache_control()
    print("BUILD CHAT MODEL CACHE TESTS PASSED")
