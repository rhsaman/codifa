"""Unit tests for reasoning-effort mapping across providers.

Covers ``_thinking_kwargs`` (the gate that decides whether a reasoning effort
is sent) and ``build_chat_model`` (which wires the effort into the right
downstream field per provider class: ``reasoning_effort`` for OpenAI-compatible
gateways, ``thinking_budget`` for Google/Gemini).
"""


from llm import _thinking_kwargs, build_chat_model

# --- _thinking_kwargs: the central gate -------------------------------------


def test_off_levels_return_empty():
    # '' (legacy) and 'none' mean reasoning is disabled -> no param at all.
    assert _thinking_kwargs("openrouter", "gpt-4o", "") == {}
    assert _thinking_kwargs("openrouter", "gpt-4o", "none") == {}
    assert _thinking_kwargs("openrouter", "gpt-4o", "  none  ") == {}


def test_extra_top_rungs_pass_through():
    # 'xhigh' (gpt-5.1 style routes) and 'max' (agentrouter / some OpenRouter
    # routes) pass through verbatim; routes that reject one are remapped by the
    # reasoning-effort 400 retry path instead of being dropped here.
    assert _thinking_kwargs("openrouter", "gpt-4o", "xhigh") == {"reasoning_effort": "xhigh"}
    assert _thinking_kwargs("openrouter", "gpt-4o", "max") == {"reasoning_effort": "max"}


def test_unknown_level_stays_off():
    # A genuinely unknown level still falls through to the empty mapping.
    assert _thinking_kwargs("openrouter", "gpt-4o", "ultra") == {}


def test_auto_think_cloud_provider_gets_reasoning_effort():
    for provider in ("openrouter", "nvidia", "cloudflare", "tokenrouter"):
        kw = _thinking_kwargs(provider, "some-model", "high")
        assert kw == {"reasoning_effort": "high"}, provider


def test_non_auto_think_provider_without_model_flag_gets_nothing():
    # google/ollama/custom have no auto_think flag, so without an explicit
    # model_reasoning flag the effort is suppressed.
    for provider in ("google", "ollama", "custom"):
        kw = _thinking_kwargs(provider, "some-model", "high")
        assert kw == {}, provider


def test_local_model_reasoning_flag_enables_effort():
    # A local/custom model that is explicitly reasoning-capable (e.g. ollama
    # deepseek-r1) should receive the effort even though the provider lacks
    # the cloud auto_think flag.
    for provider in ("ollama", "custom"):
        kw = _thinking_kwargs(provider, "deepseek-r1", "medium", model_reasoning=True)
        assert kw == {"reasoning_effort": "medium"}, provider


def test_local_model_without_reasoning_flag_stays_off():
    # Explicitly non-reasoning local model -> never send the effort.
    kw = _thinking_kwargs("ollama", "llama3", "high", model_reasoning=False)
    assert kw == {}


# --- build_chat_model: per-provider wiring ----------------------------------


def test_openai_compatible_wires_reasoning_effort(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeOpenAI)

    build_chat_model(
        provider="openrouter",
        model="gpt-4o",
        api_key="test",
        thinking_level="high",
    )

    assert captured.get("reasoning_effort") == "high"


def test_google_wires_thinking_budget(monkeypatch):
    captured = {}

    class FakeGoogle:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        __import__("sys").modules,
        "langchain_google_genai",
        type("m", (), {"ChatGoogleGenerativeAI": FakeGoogle})(),
    )

    build_chat_model(
        provider="google",
        model="gemini-2.5-pro",
        api_key="test",
        thinking_level="high",
    )

    # 'high' -> 32768 token budget; 'none'/'' -> None (thinking disabled).
    assert captured.get("thinking_budget") == 32768
    assert "reasoning_effort" not in captured


def test_google_off_level_disables_thinking_budget(monkeypatch):
    captured = {}

    class FakeGoogle:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        __import__("sys").modules,
        "langchain_google_genai",
        type("m", (), {"ChatGoogleGenerativeAI": FakeGoogle})(),
    )

    build_chat_model(
        provider="google",
        model="gemini-2.5-pro",
        api_key="test",
        thinking_level="none",
    )

    assert captured.get("thinking_budget") is None
