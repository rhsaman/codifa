"""تصمیم سریع محلی با laya + آبشار به پروایدر بیرونی.

laya یک مدل تصمیم System 1 غیرخودرگرسیو است (نه چت‌بات): ورودی
``state`` + سؤال تایپ‌دار (``choice`` / ``score`` / ``noul``) می‌گیرد و
خروجی ساخت‌یافته با احتمال برمی‌گرداند (حدود ۷۰ تا ۵۰۰ میلی‌ثانیه).

الگو: اول Laya/Jev — اگر اطمینان بالا بود همان‌جا اجرا می‌شود، اگر
اطمینان پایین بود یا جواب «نمی‌دانم» بود، فقط همان مورد سخت به مدل
بزرگ (پروایدر بیرونی) می‌رود (سیاست ``abstention``).

رابط واقعی ``laya.Router.predict`` در اولین استفاده چک‌پوینت را از
HuggingFace Hub دانلود می‌کند؛ این ماژول با تنظیم متغیر محیطی کش
(``HF_HOME`` / ``HUGGINGFACE_HUB_CACHE``) روی پوشه داده کاربر، همان
دانلود را داخل ``models/laya--<slug>/`` نگه می‌دارد تا کاملاً آفلاین
کار کند (مثل whisper).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# آستانه اطمینان: زیر این مقدار، تصمیم به مدل بزرگ واگذار می‌شود.
DEFAULT_CONFIDENCE_THRESHOLD = 0.65

# حالت پروایدر مثل STT: 'local' یعنی روتر محلی، غیر آن شناسه پروایدر در تنظیمات.
LAYA_PROVIDER_DEFAULT = "local"

# مسیر سریع computer/browser/normal برای هدایت مدل به ابزار درست با توکن کمتر.
FAST_ROUTE_COMPUTER = "computer"
FAST_ROUTE_BROWSER = "browser"
FAST_ROUTE_NORMAL = "normal"
FAST_ROUTE_OPTIONS = (FAST_ROUTE_COMPUTER, FAST_ROUTE_BROWSER, FAST_ROUTE_NORMAL)

_ROUTER_LOCK = threading.Lock()
_ROUTER: Any = None
_ROUTER_REPO: str = ""


@dataclass
class LayaDecision:
    """نتیجه یک تصمیم محلی: اجرا شد یا باید به مدل بزرگ رفت."""

    # True یعنی تصمیم محلی کافی است و نیازی به مدل بزرگ نیست.
    handled: bool
    # نوع سؤال laya: choice / score / noul
    kind: str
    # برچسب/مقدار انتخاب‌شده (برای choice) یا امتیاز (برای score)
    value: Any
    # اطمینان ۰ تا ۱ گزارش‌شده توسط laya
    confidence: float
    # True وقتی laya صراحتاً «نمی‌دانم» برگرداند (سیاست abstention)
    abstained: bool
    # دلیل کوتاه برای لاگ/دیباگ
    reason: str = ""


def _router_cache_dir() -> str:
    """پوشه کش laya داخل data-root (مشترک با model_download)."""
    try:
        import model_download

        return os.path.join(os.path.dirname(model_download._models_dir()), "models")
    except Exception:  # noqa: BLE001 — fallback مستقل
        try:
            from state_db import data_root

            root = data_root()
        except Exception:  # noqa: BLE001
            root = os.path.join(os.path.expanduser("~"), ".codifa")
        return os.path.join(root, "models")


def _laya_provider_id() -> str:
    """شناسه پروایدر تصمیم سریع (پیش‌فرض 'local' مثل STT)."""
    try:
        from state_db import get_settings

        settings = get_settings()
        if isinstance(settings, dict):
            provider = str(settings.get("layaProviderId") or "").strip()
            if provider:
                return provider
    except Exception:  # noqa: BLE001, S110
        pass
    return LAYA_PROVIDER_DEFAULT


def _laya_provider_model() -> str:
    """مدل تصمیم سریع روی پروایدر (خالی = مدل پیش‌فرض همان پروایدر)."""
    try:
        from state_db import get_settings

        settings = get_settings()
        if isinstance(settings, dict):
            return str(settings.get("layaProviderModel") or "").strip()
    except Exception:  # noqa: BLE001, S110
        pass
    return ""


def _laya_provider_config(provider_id: str) -> dict | None:
    """کانفیگ پروایدر laya از تنظیمات (برای حالت غیرمحلی)."""
    try:
        from state_db import get_settings

        settings = get_settings()
        providers = (settings or {}).get("providers") if isinstance(settings, dict) else None
        if isinstance(providers, list):
            for item in providers:
                if isinstance(item, dict) and str(item.get("id") or "") == provider_id:
                    cfg = dict(item)
                    override = _laya_provider_model()
                    if override:
                        cfg["model"] = override
                    return cfg
    except Exception:  # noqa: BLE001
        return None
    return None


def _laya_repo() -> str:
    """ریپوی laya انتخاب‌شده توسط کاربر (پیش‌فرض مخزن اصلی)."""
    try:
        import model_download

        return model_download._user_laya_model()
    except Exception:  # noqa: BLE001
        try:
            from state_db import get_settings

            settings = get_settings()
            if isinstance(settings, dict):
                model = str(settings.get("layaModel") or "").strip()
                if model:
                    return model
        except Exception:  # noqa: BLE001, S110
            pass
    try:
        import model_download

        return model_download.LAYA_DEFAULT_REPO
    except Exception:  # noqa: BLE001
        return "convaiinnovations/laya"


def is_available() -> bool:
    """True وقتی پکیج laya نصب است (بدون بارگذاری وزن‌ها)."""
    try:
        import laya  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def is_ready() -> bool:
    """True وقتی چک‌پوینت محلی دانلود شده و آماده استفاده آفلاین است."""
    try:
        import model_download

        return model_download.laya_ready(model_download._user_laya_model())
    except Exception:  # noqa: BLE001
        return False


def _get_router() -> Any | None:
    """روتر laya را یک‌بار می‌سازد و کش می‌کند (thread-safe)."""
    global _ROUTER, _ROUTER_REPO
    repo = _laya_repo()
    with _ROUTER_LOCK:
        if _ROUTER is not None and _ROUTER_REPO == repo:
            return _ROUTER
        try:
            from laya import Router
        except Exception:  # noqa: BLE001 — پکیج نصب نیست
            return None
        cache = _router_cache_dir()
        os.makedirs(cache, exist_ok=True)
        # کش هاب را به پوشه داده کاربر هدایت کن تا دانلود خودکار
        # Router.predict داخل models/ بماند و آفلاین کار کند.
        os.environ.setdefault("HF_HOME", cache)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", cache)
        try:
            _ROUTER = Router(repo)
            _ROUTER_REPO = repo
            return _ROUTER
        except Exception:  # noqa: BLE001 — وزن خراب/ناقص
            _ROUTER = None
            _ROUTER_REPO = ""
            return None


def _confidence_of(result: Any) -> float:
    """اطمینان ۰ تا ۱ را از خروجی ناهمگون Router.predict استخراج می‌کند."""
    for attr in ("confidence", "prob", "probability", "score"):
        try:
            val = result.get(attr) if isinstance(result, dict) else getattr(result, attr, None)
        except Exception:  # noqa: BLE001 — خروجی ناهمگون؛ ادامه به ویژگی بعدی
            logger.debug("laya confidence attr %s unreadable", attr)
            continue
        try:
            num = float(val)
        except (TypeError, ValueError):
            continue
        if 0.0 <= num <= 1.0:
            return num
    return 0.0


def _abstained_of(result: Any, value: Any) -> bool:
    """تشخیص «نمی‌دانم» (abstention) در خروجی laya."""
    text = str(value or "").strip().lower()
    if text in ("unknown", "abstain", "none", "noul", "نمی‌دانم"):
        return True
    try:
        flag = result.get("abstained") if isinstance(result, dict) else getattr(result, "abstained", None)
    except Exception:  # noqa: BLE001
        flag = None
    return bool(flag)


def _value_of(result: Any) -> Any:
    """مقدار تصمیم را از خروجی ناهمگون Router.predict استخراج می‌کند."""
    if isinstance(result, dict):
        for key in ("label", "choice", "value", "decision", "prediction"):
            if result.get(key) is not None:
                return result[key]
        return None
    for attr in ("label", "choice", "value", "decision", "prediction"):
        try:
            val = getattr(result, attr, None)
        except Exception:  # noqa: BLE001 — خروجی ناهمگون؛ ادامه به ویژگی بعدی
            logger.debug("laya value attr %s unreadable", attr)
            continue
        if val is not None:
            return val
    return result


def decide(
    state: dict,
    question: dict,
    threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    provider_id: str = "",
) -> LayaDecision:
    """یک تصمیم سریع می‌گیرد؛ در صورت اطمینان پایین واگذار می‌کند.

    ``state`` زمینه فعلی و ``question`` سؤال تایپ‌دار laya است
    (``{"type": "choice"|"score"|"noul", ...}``). وقتی ``provider_id`` خالی
    باشد از تنظیمات خوانده می‌شود؛ مقدار ``"local"`` یعنی روتر محلی و هر
    مقدار دیگر یعنی تصمیم از طریق پروایدر بیرونی. وقتی laya در دسترس
    نباشد یا اطمینان زیر ``threshold`` باشد، ``handled=False`` برمی‌گردد
    تا فراخواننده فقط همان مورد سخت را به مدل بزرگ بفرستد.
    """
    kind = str((question or {}).get("type") or "choice").strip().lower() or "choice"
    provider = (provider_id or "").strip() or _laya_provider_id()
    if provider and provider != LAYA_PROVIDER_DEFAULT:
        return _decide_via_provider(state or {}, question or {}, kind, threshold, provider)
    router = _get_router()
    if router is None:
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason="laya-unavailable",
        )
    try:
        result = router.predict(state or {}, question or {})
    except Exception as exc:  # noqa: BLE001 — خطای محلی = واگذاری به مدل بزرگ
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=f"laya-error: {exc}",
        )
    value = _value_of(result)
    confidence = _confidence_of(result)
    abstained = _abstained_of(result, value)
    if abstained or confidence < threshold:
        return LayaDecision(
            handled=False, kind=kind, value=value, confidence=confidence,
            abstained=abstained,
            reason="abstained" if abstained else f"low-confidence:{confidence:.2f}",
        )
    return LayaDecision(
        handled=True, kind=kind, value=value, confidence=confidence,
        abstained=False, reason="local-decision",
    )


def _decide_via_provider(
    state: dict,
    question: dict,
    kind: str,
    threshold: float,
    provider_id: str,
) -> LayaDecision:
    """تصمیم سریع از طریق پروایدر بیرونی (مثل حالت ریموت STT).

    از همان مدل چت پروایدر انتخاب‌شده با یک پرامپ ساخت‌یافته استفاده
    می‌کند تا خروجی ``choice/score`` با اطمینان برگردد؛ هر خطا یعنی
    واگذاری به مدل بزرگ.
    """
    cfg = _laya_provider_config(provider_id)
    if not cfg:
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason="laya-provider-unknown",
        )
    try:
        from llm import build_chat_model, llm_generate
    except Exception:  # noqa: BLE001 — بدون llm فقط واگذار کن
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason="laya-provider-unavailable",
        )
    options = question.get("options") if isinstance(question, dict) else None
    options_text = ", ".join(str(o) for o in options) if isinstance(options, list) and options else ""
    prompt = (
        "Fast routing decision. Reply with compact JSON only: "
        '{"value": <choice or score>, "confidence": 0-1}. '
        f"kind={kind} options=[{options_text}] state={state}"
    )
    try:
        import asyncio

        model = build_chat_model(
            str(cfg.get("kind") or "custom"),
            str(cfg.get("model") or ""),
            str(cfg.get("baseUrl") or ""),
            str(cfg.get("apiKey") or ""),
            str(cfg.get("envVar") or ""),
            temperature=0.0,
            max_tokens=256,
            timeout=15,
            provider_id=provider_id,
        )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop and loop.is_running():
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                text, _usage = pool.submit(
                    asyncio.run, llm_generate(model, user=prompt)
                ).result(timeout=20)
        else:
            text, _usage = asyncio.run(llm_generate(model, user=prompt))
    except Exception as exc:  # noqa: BLE001 — خطای پروایدر = واگذاری
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=f"laya-provider-error: {exc}",
        )
    value, confidence = _parse_provider_decision(text, options)
    abstained = _abstained_of({"abstained": False}, value)
    if abstained or confidence < threshold:
        return LayaDecision(
            handled=False, kind=kind, value=value, confidence=confidence,
            abstained=abstained,
            reason="abstained" if abstained else f"low-confidence:{confidence:.2f}",
        )
    return LayaDecision(
        handled=True, kind=kind, value=value, confidence=confidence,
        abstained=False, reason="provider-decision",
    )


def _parse_provider_decision(text: str, options: Any) -> tuple[Any, float]:
    """خروجی JSON پروایدر را به (مقدار، اطمینان) تبدیل می‌کند."""
    import json

    raw = (text or "").strip()
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        payload = json.loads(raw[start:end + 1] if start >= 0 and end > start else raw)
    except Exception:  # noqa: BLE001 — متن آزاد
        payload = {}
    value = payload.get("value") if isinstance(payload, dict) else None
    if value is None:
        value = raw or None
    if isinstance(options, list) and options and value not in options:
        lowered = str(value or "").strip().lower()
        for option in options:
            if str(option).strip().lower() == lowered:
                value = option
                break
    try:
        confidence = float(payload.get("confidence", 0.0)) if isinstance(payload, dict) else 0.0
    except (TypeError, ValueError):
        confidence = 0.0
    if not 0.0 <= confidence <= 1.0:
        confidence = 0.0
    return value, confidence


def fast_route(prompt: str) -> str:
    """مسیر سریع computer/browser/normal را از روی متن درخواست حدس می‌زند.

    قانون ساده و قابل پیش‌بینی: اشاره به اپ دسکتاپ یعنی computer، اشاره
    به وب/مرورگر یعنی browser، بقیه normal. مدل بزرگ فقط وقتی صدا زده
    می‌شود که laya نتواند همین قانون را با اطمینان تأیید کند.
    """
    text = (prompt or "").strip().lower()
    if not text:
        return FAST_ROUTE_NORMAL
    computer_hints = (
        "computer", "desktop", "app ", "windows", "macos", "linux",
        "اپ دسکتاپ", "دسکتاپ", "ویندوز", "مک", "لینوکس",
    )
    browser_hints = (
        "browser", "playwright", "web ", "website", "http", "url",
        "مرورگر", "وب", "سایت",
    )
    if any(hint in text for hint in computer_hints):
        return FAST_ROUTE_COMPUTER
    if any(hint in text for hint in browser_hints):
        return FAST_ROUTE_BROWSER
    return FAST_ROUTE_NORMAL


def status() -> dict:
    """وضعیت laya برای نمایش در رابط کاربری (نصب/آماده/ریپو/پروایدر)."""
    return {
        "available": is_available(),
        "ready": is_ready(),
        "repo": _laya_repo(),
        "provider": _laya_provider_id(),
    }
