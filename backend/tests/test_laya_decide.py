"""تست تصمیم محلی laya و آبشار به پروایدر بیرونی."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import laya_decide


class _FakeRouter:
    def __init__(self, result=None, exc=None):
        self._result = result
        self._exc = exc

    def predict(self, state, question):
        if self._exc is not None:
            raise self._exc
        return self._result


def test_decide_handled_when_confident(monkeypatch):
    """اطمینان بالا → تصمیم محلی اجرا می‌شود و نیازی به مدل بزرگ نیست."""
    fake = _FakeRouter(result={"label": "handle_locally", "confidence": 0.92})
    monkeypatch.setattr(laya_decide, "_get_router", lambda: fake)
    out = laya_decide.decide({"prompt": "سلام"}, {"type": "choice"})
    assert out.handled is True
    assert out.value == "handle_locally"
    assert out.confidence == 0.92
    assert out.abstained is False


def test_decide_fallback_when_low_confidence_or_abstain_or_unavailable(monkeypatch):
    """اطمینان پایین / نمی‌دانم / در دسترس نبودن → واگذاری به مدل بزرگ."""
    # اطمینان پایین
    monkeypatch.setattr(
        laya_decide, "_get_router", lambda: _FakeRouter(result={"label": "x", "confidence": 0.2})
    )
    low = laya_decide.decide({}, {"type": "choice"})
    assert low.handled is False
    # صراحتاً نمی‌دانم حتی با اطمینان بالا
    monkeypatch.setattr(
        laya_decide,
        "_get_router",
        lambda: _FakeRouter(result={"label": "unknown", "confidence": 0.99}),
    )
    abst = laya_decide.decide({}, {"type": "choice"})
    assert abst.handled is False
    assert abst.abstained is True
    # laya نصب نیست
    monkeypatch.setattr(laya_decide, "_get_router", lambda: None)
    missing = laya_decide.decide({}, {"type": "choice"})
    assert missing.handled is False
    assert missing.abstained is True


def test_decide_via_provider_confident(monkeypatch):
    """پروایدر مطمئن → تصمیم پروایدر اجرا می‌شود (مثل حالت ریموت STT)."""
    import asyncio
    import types

    fake_llm = types.SimpleNamespace(
        build_chat_model=lambda *a, **k: object(),
        llm_generate=lambda model, **k: asyncio.sleep(0, result=('{"value": "browser", "confidence": 0.9}', None)),
    )
    monkeypatch.setitem(__import__("sys").modules, "llm", fake_llm)
    monkeypatch.setattr(
        laya_decide, "_laya_provider_config", lambda pid: {"kind": "custom", "model": "m"}
    )
    out = laya_decide.decide(
        {"prompt": "open the website"},
        {"type": "choice", "options": ["computer", "browser", "normal"]},
        provider_id="my-provider",
    )
    assert out.handled is True
    assert out.value == "browser"
    assert out.reason == "provider-decision"


def test_fast_route_hints():
    """سرنخ متنی computer/browser به مسیر درست می‌رسد."""
    assert laya_decide.fast_route("open the desktop app") == laya_decide.FAST_ROUTE_COMPUTER
    assert laya_decide.fast_route("open the website with playwright") == laya_decide.FAST_ROUTE_BROWSER
    assert laya_decide.fast_route("refactor this function") == laya_decide.FAST_ROUTE_NORMAL
