"""Unit tests for the generic UA ladder + the Anthropic-compatible provider
kind (no gateway is hardcoded by name — the ladder retries ANY custom
endpoint that 401s an unknown client).

Covers:
  * ``_models_endpoint`` for the anthropic kind (base WITHOUT /v1 → /v1/models)
  * ``normalize_base_url`` stripping a user-entered /v1 or /v1/messages suffix
  * the UA ladder retrying a 401 models fetch until a UA is accepted
  * ``build_chat_model`` building a ``ChatAnthropic`` with x-api-key auth
"""

from __future__ import annotations

import pytest

import providers
from providers import UA_LADDER, _models_endpoint, normalize_base_url


def test_models_endpoint_anthropic_appends_v1():
    url, fmt = _models_endpoint("anthropic", "https://gw.example.com")
    assert url == "https://gw.example.com/v1/models"
    assert fmt == "openai"


def test_normalize_base_url_anthropic_strips_v1_suffix():
    # کاربر ممکن است /v1 یا /v1/messages را هم کپی کند؛ هر دو باید حذف شوند
    assert normalize_base_url("anthropic", "https://gw.example.com/v1") == "https://gw.example.com"
    assert (
        normalize_base_url("anthropic", "https://gw.example.com/v1/messages")
        == "https://gw.example.com"
    )
    assert normalize_base_url("anthropic", "https://gw.example.com") == "https://gw.example.com"


def test_ua_ladder_is_generic():
    # نردبان UA نباید نام هیچ گیت‌وی خاصی را هاردکد کند؛ فقط UAهای
    # شناخته‌شده‌ی کلاینت‌های agent هستند.
    assert isinstance(UA_LADDER, tuple)
    assert len(UA_LADDER) >= 2
    assert all(isinstance(ua, str) and ua for ua in UA_LADDER)


@pytest.mark.asyncio
async def test_list_models_retries_401_with_ua_ladder(monkeypatch):
    """فچ مدل‌ها که با 401 رد شد، باید با هر UA نردبان دوباره امتحان شود
    و اولین پاسخ غیر-401 (مثلاً 200) پذیرفته شود."""
    calls: list[str] = []

    class Resp:
        def __init__(self, status: int, payload: dict):
            self.status_code = status
            self._payload = payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise providers.ProviderError(f"HTTP {self.status_code}")

        def json(self):
            return self._payload

    class Client:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            h = headers or {}
            ua = h.get("User-Agent", "")
            calls.append(ua)
            if "claude-cli" in ua:
                return Resp(200, {"data": [{"id": "m-1"}]})
            return Resp(401, {"error": {"message": "unauthorized client"}})

    monkeypatch.setattr(providers.httpx, "AsyncClient", Client)
    # کش مدل‌ها را خالی کنیم تا فetch واقعی انجام شود
    providers._model_cache.clear()

    models = await providers.list_models("custom", "https://gw.example.com/v1", "sk-x")
    assert [m["id"] for m in models] == ["m-1"]
    # اول بدون UA (پیش‌فرض httpx) → 401؛ بعد اولین UA نردبان → 200
    assert calls[0] == ""
    assert calls[1] == UA_LADDER[0]


def test_build_chat_model_anthropic(monkeypatch):
    """kind=anthropic باید ChatAnthropic بسازد با base بدون /v1 و UA نردبان."""
    import llm

    captured: dict = {}

    class FakeAnthropic:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setitem(llm.__dict__, "ChatAnthropic", FakeAnthropic)
    # import داخل تابع را monkeypatch نمی‌توانیم؛ به‌جای آن ماژول تزریق می‌کنیم
    import sys
    import types

    fake_mod = types.ModuleType("langchain_anthropic")
    fake_mod.ChatAnthropic = FakeAnthropic
    monkeypatch.setitem(sys.modules, "langchain_anthropic", fake_mod)

    llm.build_chat_model(
        "anthropic",
        "claude-opus-4-6",
        "https://gw.example.com/v1",
        "sk-test",
    )
    assert captured["model"] == "claude-opus-4-6"
    assert captured["base_url"] == "https://gw.example.com"
    assert captured["api_key"] == "sk-test"
    assert captured["default_headers"]["User-Agent"] == UA_LADDER[0]
