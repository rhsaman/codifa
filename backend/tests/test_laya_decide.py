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

    fake_usage = {
        "kind": "usage",
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "model": "m",
        "provider": "custom",
        "provider_id": "my-provider",
        "sub": True,
    }
    fake_llm = types.SimpleNamespace(
        build_chat_model=lambda *a, **k: object(),
        llm_generate=lambda model, **k: asyncio.sleep(0, result=('{"value": "browser", "confidence": 0.9}', fake_usage)),
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
    # مصرف واقعی llm_generate باید برگردد (مثل tools با sub=True)
    assert isinstance(out.usage, dict)
    assert out.usage.get("kind") == "usage"
    assert out.usage.get("input_tokens") == 10
    assert out.usage.get("output_tokens") == 5
    assert out.usage.get("sub") is True
    assert out.usage.get("laya") is True
    assert out.usage.get("provider_id") == "my-provider"
    assert out.provider_id == "my-provider"
    assert out.model == "m"


def test_decide_local_returns_zero_token_usage(monkeypatch):
    """تصمیم لوکال → usage صفرتوکنی با پرچم laya تا ردیف قابل‌مشاهده بماند."""
    fake = _FakeRouter(result={"label": "computer", "confidence": 0.9})
    monkeypatch.setattr(laya_decide, "_get_router", lambda: fake)
    monkeypatch.setattr(laya_decide, "_laya_repo", lambda: "convaiinnovations/laya")
    out = laya_decide.decide(
        {"prompt": "open the desktop app"},
        {"type": "choice", "options": ["computer", "browser", "normal"]},
        provider_id="local",
    )
    assert out.handled is True
    assert isinstance(out.usage, dict)
    assert out.usage.get("kind") == "usage"
    assert out.usage.get("total_tokens") == 0
    assert out.usage.get("laya") is True
    assert out.usage.get("provider_id") == "local"
    assert out.provider_id == "local"
    assert out.model == "convaiinnovations/laya"


def test_fast_route_hints():
    """سرنخ متنی computer/browser به مسیر درست می‌رسد."""
    assert laya_decide.fast_route("open the desktop application") == laya_decide.FAST_ROUTE_COMPUTER
    assert laya_decide.fast_route("open the website with playwright") == laya_decide.FAST_ROUTE_BROWSER
    assert laya_decide.fast_route("refactor this function") == laya_decide.FAST_ROUTE_NORMAL


def test_fast_route_word_boundary_no_false_positive():
    """مرز کلمه: زیررشته حدس غلط نمی‌زند («مک» در «کمک»، «url» در «curl»)."""
    assert laya_decide.fast_route("my website redesign") == laya_decide.FAST_ROUTE_BROWSER
    assert laya_decide.fast_route("somewebsite") == laya_decide.FAST_ROUTE_NORMAL
    assert laya_decide.fast_route("webby") == laya_decide.FAST_ROUTE_NORMAL
    assert laya_decide.fast_route("کمک") == laya_decide.FAST_ROUTE_NORMAL
    assert laya_decide.fast_route("curl the bar") == laya_decide.FAST_ROUTE_NORMAL
    assert laya_decide.fast_route("the web page") == laya_decide.FAST_ROUTE_NORMAL
    assert laya_decide.fast_route("open the app store") == laya_decide.FAST_ROUTE_NORMAL


def test_router_unavailable_reason_distinguishes_install_vs_weights(monkeypatch):
    """تفکیک «نصب نیست» از «وزن نیست» برای دلیل دقیق تنظیمات."""
    monkeypatch.setattr(laya_decide, "is_available", lambda: False)
    assert laya_decide.router_unavailable_reason() == "laya-not-installed"
    monkeypatch.setattr(laya_decide, "is_available", lambda: True)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: False)
    assert laya_decide.router_unavailable_reason() == "laya-weights-missing"


def test_choice_and_score_delegate_safely(monkeypatch):
    """choice/score با اطمینان بالا اجرا، با خطا/نامعتبر واگذار می‌کنند."""
    fake = _FakeRouter(result={"label": "prefer_tree", "confidence": 0.9})
    monkeypatch.setattr(laya_decide, "_get_router", lambda: fake)
    chosen = laya_decide.choice({"q": "x"}, ["prefer_tree", "prefer_see"], provider_id="local")
    assert chosen.handled is True
    assert chosen.value == "prefer_tree"
    # امتیاز نامعتبر (خارج از ۰ تا ۱) → واگذاری امن
    monkeypatch.setattr(laya_decide, "_get_router", lambda: _FakeRouter(result={"label": "9.5", "confidence": 0.9}))
    bad = laya_decide.score({"bullet": "x"}, "9.5", provider_id="local")
    assert bad.handled is False
    assert bad.reason == "score-invalid"
    # گزینه خالی → واگذاری بدون صدازدن روتر
    empty = laya_decide.choice({"q": "x"}, [], provider_id="local")
    assert empty.handled is False
    assert empty.reason == "choice-no-options"


def test_prefer_tree_over_see_gate(monkeypatch):
    """گیت computer_use: True یعنی درخت اول، None یعنی رفتار قبلی."""
    import computer_use as cu

    monkeypatch.setattr(cu, "LAYA_SEE_GATE_ENABLED", True)
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="": laya_decide.LayaDecision(
            handled=True, kind="choice", value="prefer_tree", confidence=0.9,
            abstained=False, reason="local-decision",
        ),
    )
    assert cu.prefer_tree_over_see("click the OK button", "Notes") is True
    # پرچم خاموش → همیشه None (رفتار قبلی)
    monkeypatch.setattr(cu, "LAYA_SEE_GATE_ENABLED", False)
    assert cu.prefer_tree_over_see("click the OK button", "Notes") is None


def test_laya_distill_choice_gate(monkeypatch):
    """گیت distill: فقط «raw» با اطمینان بالا خلاصه را رد می‌کند."""
    import tools as tools_mod

    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="": laya_decide.LayaDecision(
            handled=True, kind="choice", value="raw", confidence=0.9,
            abstained=False, reason="local-decision",
        ),
    )
    assert tools_mod._laya_distill_choice("q", 3, 500) == "raw"
    # ورودی طول کل نتایج را هم به laya می‌دهد تا با دید کامل تصمیم بگیرد
    seen: dict = {}

    def _spy(state, options, threshold=0.65, provider_id=""):
        seen.update(state)
        return laya_decide.LayaDecision(
            handled=True, kind="choice", value="distill", confidence=0.9,
            abstained=False, reason="local-decision",
        )

    monkeypatch.setattr(laya_decide, "choice", _spy)
    assert tools_mod._laya_distill_choice("q", 2, 1234) == "distill"
    assert seen.get("total_chars") == 1234
    # واگذاری (اطمینان پایین) → None یعنی رفتار قبلی
    monkeypatch.setattr(
        laya_decide, "choice",
        lambda state, options, threshold=0.65, provider_id="": laya_decide.LayaDecision(
            handled=False, kind="choice", value="raw", confidence=0.2,
            abstained=False, reason="low-confidence:0.20",
        ),
    )
    assert tools_mod._laya_distill_choice("q", 3) is None


def test_local_router_models_maps_to_weight_dir(tmp_path, monkeypatch):
    """نگاشت Router به پوشه محلی: بدون دانلود دوباره، با زیرپوشه‌ها."""
    weight = tmp_path / "laya--convaiinnovations--laya"
    weight.mkdir()
    (weight / "rl_agent_config.json").write_text("{}")
    (weight / "multilingual").mkdir()
    (weight / "multilingual" / "rl_agent_config.json").write_text("{}")
    monkeypatch.setattr(laya_decide, "_laya_repo", lambda: "convaiinnovations/laya")
    models = laya_decide._local_router_models("convaiinnovations/laya", str(weight))
    assert models is not None
    assert models["english"] == (str(weight), None)
    assert models["multilingual"] == (str(weight), "multilingual")
    # پوشه خالی/ناقص → None یعنی fallback به رفتار پیش‌فرض
    assert laya_decide._local_router_models("x", str(tmp_path / "missing")) is None
    bad = tmp_path / "bad"
    bad.mkdir()
    assert laya_decide._local_router_models("x", str(bad)) is None


def test_get_router_uses_local_models_not_repo_string(tmp_path, monkeypatch):
    """_get_router شناسه ریپو را به Router نمی‌دهد (خطای AttributeError قبلی)."""
    import sys
    import types

    weight = tmp_path / "laya--convaiinnovations--laya"
    weight.mkdir()
    (weight / "rl_agent_config.json").write_text("{}")
    seen: dict = {}

    class _FakeRouterCls:
        def __init__(self, *args, **kwargs):
            seen["args"] = args
            seen["kwargs"] = kwargs

    fake_laya = types.SimpleNamespace(Router=_FakeRouterCls)
    monkeypatch.setitem(sys.modules, "laya", fake_laya)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: True)
    monkeypatch.setattr(laya_decide, "_laya_repo", lambda: "convaiinnovations/laya")
    monkeypatch.setattr(laya_decide, "_ROUTER", None)
    monkeypatch.setattr(laya_decide, "_ROUTER_REPO", "")
    import model_download

    monkeypatch.setattr(model_download, "_user_laya_model", lambda: "convaiinnovations/laya")
    monkeypatch.setattr(model_download, "_models_dir", lambda: str(tmp_path))
    router = laya_decide._get_router()
    assert router is not None
    assert seen["args"] == ()
    assert isinstance(seen["kwargs"].get("models"), dict)
    assert seen["kwargs"]["models"]["english"][0] == str(weight)


def test_display_ready_for_panel():
    """خروجی نمایشی تصمیم: مسیر، اطمینان، انصراف و دلیل برای پنل زنده."""
    d = laya_decide.LayaDecision(
        handled=True, kind="choice", value="browser", confidence=0.9,
        abstained=False, reason="local-decision",
        provider_id="local", model="convaiinnovations/laya",
    )
    shown = d.display("browser")
    assert shown["route"] == "browser"
    assert shown["confidence"] == 0.9
    assert shown["abstained"] is False
    assert shown["handled"] is True
    assert shown["provider_id"] == "local"
    # اطمینان نامعتبر clamp می‌شود تا نوار اطمینان نشکند
    bad = laya_decide.LayaDecision(
        handled=False, kind="choice", value=None, confidence=9.0,
        abstained=True, reason="laya-error",
    )
    assert bad.display("")["confidence"] == 0.0


def test_status_hides_stale_error_when_ready(monkeypatch):
    """خطای کهنه وزن وقتی وزن آماده است در status نمایش داده نمی‌شود."""
    monkeypatch.setattr(laya_decide, "is_available", lambda: True)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: True)
    monkeypatch.setattr(laya_decide, "_ROUTER_ERROR", "laya-weights-missing")
    shown = laya_decide.status()
    assert shown["ready"] is True
    assert shown["reason"] == ""
    # خطای واقعی بارگذاری همچنان نمایش داده می‌شود
    monkeypatch.setattr(laya_decide, "_ROUTER_ERROR", "laya-error: boom")
    shown2 = laya_decide.status()
    assert shown2["reason"] == "laya-error: boom"


def test_status_reports_missing_weights(monkeypatch):
    """وقتی وزن آماده نیست دلیل دقیق وزن برمی‌گردد."""
    monkeypatch.setattr(laya_decide, "is_available", lambda: True)
    monkeypatch.setattr(laya_decide, "is_ready", lambda: False)
    monkeypatch.setattr(laya_decide, "_ROUTER_ERROR", "")
    shown = laya_decide.status()
    assert shown["ready"] is False
    assert shown["reason"] == "laya-weights-missing"
