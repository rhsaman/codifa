import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient

import server


def _client() -> TestClient:
    return TestClient(server.app)


def _base_payload(**overrides) -> dict:
    payload = {
        "provider": "custom",
        "provider_id": "p1",
        "model": "main-model",
        "api_keys": [],
        "base_url": "",
        "subagent_models": {},
        "providers": {},
        "text": "how do I bake sourdough bread at home?",
    }
    payload.update(overrides)
    return payload


def _stub_model(monkeypatch, reply="Ok title"):
    """Stub the model layer; returns (built, called) capture dicts."""
    built: dict = {}
    called: dict = {}

    def fake_build(kind, model, *args, **kwargs):
        built["kind"] = kind
        built["model"] = model
        built.update(kwargs)
        return object()

    async def fake_complete(mo, **kwargs):
        called.update(kwargs)
        if isinstance(reply, Exception):
            raise reply
        return reply, None

    monkeypatch.setattr(server, "build_chat_model", fake_build)
    monkeypatch.setattr(server, "llm_complete", fake_complete)
    return built, called


def test_chats_title_ok_strips_quotes(monkeypatch):
    _stub_model(monkeypatch, '"Sourdough Baking Guide"')
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Sourdough Baking Guide"
    assert data["usage"] is None


def test_chats_title_truncates_to_one_short_line(monkeypatch):
    _stub_model(
        monkeypatch,
        "Title: A very long chat title that keeps going " + "word " * 30 + "\nsecond line",
    )
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    title = r.json()["title"]
    assert "\n" not in title
    assert len(title) <= 60
    assert len(title.split()) <= 4
    assert not title.lower().startswith("title:")


def test_chats_title_capped_at_four_words(monkeypatch):
    _, called = _stub_model(monkeypatch, "A very long chat title that keeps going forever")
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    title = r.json()["title"]
    assert len(title.split()) <= 4
    assert title == "A very long chat"
    assert "4 words" in (called.get("system") or "")


def test_chats_title_missing_text_400():
    r = _client().post("/chats/title", json=_base_payload(text="   "))
    assert r.status_code == 400


def test_chats_title_build_failure_returns_null(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("no model")

    monkeypatch.setattr(server, "build_chat_model", boom)
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    assert r.json()["title"] is None


def test_chats_title_llm_failure_returns_null(monkeypatch):
    _stub_model(monkeypatch, RuntimeError("provider down"))
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    assert r.json()["title"] is None


def test_chats_title_empty_reply_returns_null(monkeypatch):
    _stub_model(monkeypatch, "   ")
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    assert r.json()["title"] is None


def test_chats_title_prefers_title_slot_over_compact(monkeypatch):
    built, called = _stub_model(monkeypatch, "Ok")
    r = _client().post(
        "/chats/title",
        json=_base_payload(subagent_models={"title": "t-model", "compact": "c-model"}),
    )
    assert r.status_code == 200
    assert built["model"] == "t-model"
    assert built.get("max_tokens") == 256
    assert "sourdough" in (called.get("user") or "")


def test_chats_title_falls_back_to_compact_slot(monkeypatch):
    built, _ = _stub_model(monkeypatch, "Ok")
    r = _client().post(
        "/chats/title",
        json=_base_payload(subagent_models={"title": "", "compact": "c-model"}),
    )
    assert r.status_code == 200
    assert built["model"] == "c-model"


def test_chats_title_uses_main_model_without_slot(monkeypatch):
    built, _ = _stub_model(monkeypatch, "Ok")
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    assert built["model"] == "main-model"


@pytest.mark.parametrize("entry", ["main model", "main_model", "main"])
def test_chats_title_main_model_entry_uses_parent(monkeypatch, entry):
    """Explicit 'main model' pick is the parent model, not a literal model id."""
    built, _ = _stub_model(monkeypatch, "Ok")
    r = _client().post(
        "/chats/title",
        json=_base_payload(subagent_models={"title": entry}),
    )
    assert r.status_code == 200
    assert built["model"] == "main-model"
    assert r.json()["title"] == "Ok"


def test_chats_title_input_capped_at_500_chars(monkeypatch):
    _, called = _stub_model(monkeypatch, "Ok")
    r = _client().post("/chats/title", json=_base_payload(text="x" * 5000))
    assert r.status_code == 200
    assert len(called["user"]) == 500


def test_chats_title_falls_back_when_title_slot_fails(monkeypatch):
    """A failing title-slot model falls through to the main model."""

    def fake_build(kind, model, *args, **kwargs):
        if model == "bad-model":
            raise RuntimeError("slot model rejected")
        return object()

    async def fake_complete(mo, **kwargs):
        return "Fallback Title", None

    monkeypatch.setattr(server, "build_chat_model", fake_build)
    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = _client().post(
        "/chats/title",
        json=_base_payload(subagent_models={"title": "bad-model"}),
    )
    assert r.status_code == 200
    assert r.json()["title"] == "Fallback Title"


def test_chats_title_returns_usage_for_sidebar(monkeypatch):
    """The model usage flows back so the sidebar bills provider/model."""
    usage = {
        "kind": "usage",
        "input_tokens": 120,
        "output_tokens": 8,
        "total_tokens": 128,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "model": "t-model",
        "sub": False,
        "provider": "custom",
        "provider_id": "p1",
    }

    async def fake_complete(mo, **kwargs):
        return "Ok", usage

    monkeypatch.setattr(server, "build_chat_model", lambda *a, **k: object())
    monkeypatch.setattr(server, "llm_complete", fake_complete)
    r = _client().post("/chats/title", json=_base_payload())
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Ok"
    assert data["usage"]["model"] == "t-model"
    assert data["usage"]["provider_id"] == "p1"
    assert data["usage"]["input_tokens"] == 120


def test_chats_title_forwards_chat_id_for_trace(monkeypatch):
    """chat_id reaches the model call so the trace panel records it."""
    _, called = _stub_model(monkeypatch, "Ok")
    r = _client().post("/chats/title", json=_base_payload(chat_id="chat-123"))
    assert r.status_code == 200
    assert called.get("chat_id") == "chat-123"
