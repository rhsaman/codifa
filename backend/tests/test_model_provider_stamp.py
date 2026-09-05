"""Tests for provider-identity stamping on built models.

``build_chat_model`` stamps (kind, id) onto every model it builds so usage
attribution (``usage_event`` / ``llm_generate`` / ``langchain_tool_loop``) can
report the provider that ACTUALLY ran a call — including sub-agents routed to
a different provider — without threading provider params through every layer.
"""
import asyncio

from langchain_core.messages import AIMessage

import llm as _llm
from agents import _subagent_target
from llm import build_chat_model, model_provider, usage_event

# --- _stamp_provider / model_provider ---------------------------------------


def test_model_provider_empty_on_unstamped_model():
    class _Bare:
        model_name = "m"

    assert model_provider(_Bare()) == ("", "")


def test_stamp_provider_survives_pydantic_models(monkeypatch):
    # ReasoningChatOpenAI is a pydantic model: object.__setattr__ must still
    # land the private attrs (attribution must never break a build).
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeOpenAI)

    m = build_chat_model(
        "opencode", "m", "", "", "", "", provider_id="opencode"
    )
    assert model_provider(m) == ("opencode", "opencode")


def test_stamp_provider_defaults_to_empty_id(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeOpenAI)

    m = build_chat_model("openrouter", "vendor/model", "", "k")
    assert model_provider(m) == ("openrouter", "")


# --- usage_event: provider_id field ------------------------------------------


def test_usage_event_carries_provider_id():
    meta = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    ev = usage_event(meta, model="m", provider="openrouter", provider_id="my-or")
    assert ev is not None
    assert ev["provider"] == "openrouter"
    assert ev["provider_id"] == "my-or"


def test_usage_event_provider_id_defaults_empty():
    meta = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    ev = usage_event(meta, model="m")
    assert ev is not None
    assert ev["provider_id"] == ""


# --- llm_generate reads the stamp --------------------------------------------


class _FakeModel:
    """Minimal LangChain-like model: returns a fixed AIMessage."""

    def __init__(self, name="m", kind="", pid=""):
        self.model_name = name
        if kind or pid:
            _llm._stamp_provider(self, kind, pid)

    async def ainvoke(self, _msgs):
        return AIMessage(
            content="ok",
            usage_metadata={"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
        )


def test_llm_generate_reports_stamped_provider():
    m = _FakeModel(kind="openrouter", pid="my-or")
    _text, usage = asyncio.run(_llm.llm_generate(m, user="hi"))
    assert usage is not None
    assert usage["provider"] == "openrouter"
    assert usage["provider_id"] == "my-or"


def test_llm_generate_unstamped_model_reports_empty_provider():
    m = _FakeModel()
    _text, usage = asyncio.run(_llm.llm_generate(m, user="hi"))
    assert usage is not None
    assert usage["provider"] == ""
    assert usage["provider_id"] == ""


# --- langchain_tool_loop emits stamped usage --------------------------------


class _FakeToolModel(_FakeModel):
    def bind_tools(self, _tools):
        return self


def test_langchain_tool_loop_emits_stamped_usage():
    m = _FakeToolModel(kind="nvidia", pid="nvidia")
    emitted = []

    async def run():
        out = await _llm.langchain_tool_loop(
            m, tools={}, user="hi", emit=emitted.append
        )
        return out

    out = asyncio.run(run())
    assert out == "ok"
    usage = [e for e in emitted if e.get("kind") == "usage"]
    assert len(usage) == 1
    assert usage[0]["provider"] == "nvidia"
    assert usage[0]["provider_id"] == "nvidia"
    assert usage[0]["sub"] is True


# --- _subagent_target returns the 7th element (provider id) ------------------


def _parent(**over):
    base = {
        "parent_provider": "opencode",
        "parent_base_url": "http://parent.example/v1",
        "parent_api_key": "parent-key",
        "parent_env_var": "",
        "parent_oauth_token": "",
    }
    base.update(over)
    return base


def test_subagent_target_saved_row_returns_row_id():
    row = {
        "id": "my-or", "kind": "openrouter", "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk", "envVar": "", "oauthRefreshToken": "",
    }
    t = _subagent_target(
        "my-or/vendor/model", **_parent(),
        provider_lookup=lambda pid: row if pid == "my-or" else None,
    )
    assert t is not None
    assert len(t) == 7
    assert t[0] == "openrouter"
    assert t[6] == "my-or"


def test_subagent_target_builtin_kind_returns_kind_as_id():
    # No saved row: a known built-in gateway kind routes through its own
    # defaults; the id falls back to the kind itself.
    t = _subagent_target(
        "openrouter/free", **_parent(), provider_lookup=lambda _pid: None
    )
    assert t is not None
    assert t[0] == "openrouter"
    assert t[6] == "openrouter"


def test_subagent_target_parent_path_returns_parent_provider_id():
    t = _subagent_target(
        "free", **_parent(), provider_lookup=lambda _pid: None,
        parent_provider_id="opencode",
    )
    assert t is not None
    assert t[6] == "opencode"


def test_subagent_target_parent_path_defaults_empty_id():
    t = _subagent_target(
        "free", **_parent(), provider_lookup=lambda _pid: None
    )
    assert t is not None
    assert t[6] == ""


# --- resolve_subagent_model stamps the built model ---------------------------


def test_resolve_subagent_model_stamps_cross_provider_id(monkeypatch):
    # The explore slot routed to a saved openrouter row must carry that row's
    # id on the built model, so its usage groups under openrouter — not the
    # parent (opencode) chat provider.
    import graph

    row = {
        "id": "my-or", "kind": "openrouter", "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk", "envVar": "", "oauthRefreshToken": "",
    }
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeOpenAI)

    m = graph.resolve_subagent_model(
        "opencode",
        "my-or/vendor/model",
        "http://parent.example/v1",
        "parent-key",
        "",
        "",
        "parent-model",
        provider_lookup=lambda pid: row if pid == "my-or" else None,
        parent_provider_id="opencode",
    )
    assert m is not None
    assert model_provider(m) == ("openrouter", "my-or")


def test_resolve_subagent_model_parent_default_stamps_parent_id(monkeypatch):
    import graph

    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("llm.ReasoningChatOpenAI", FakeOpenAI)

    m = graph.resolve_subagent_model(
        "opencode",
        "",
        "http://parent.example/v1",
        "parent-key",
        "",
        "",
        "parent-model",
        parent_provider_id="opencode",
    )
    assert m is not None
    assert model_provider(m) == ("opencode", "opencode")


def test_resolve_subagent_model_none_entry_vision_slot(monkeypatch):
    import graph

    m = graph.resolve_subagent_model(
        "opencode",
        None,
        "http://parent.example/v1",
        "parent-key",
        "",
        "",
        "parent-model",
        default_to_parent=False,
        parent_provider_id="opencode",
    )
    assert m is None
