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
import re
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
# آخرین دلیل آماده‌نبودن روتر محلی (تفکیک «نصب نیست» از «وزن نیست»).
_ROUTER_ERROR: str = ""

# سقف‌های زمانی کوتاه تا حلقه رویداد بلوکه نشود.
LOCAL_PREDICT_TIMEOUT = 4.0
PROVIDER_DECIDE_TIMEOUT = 8.0


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
    # مصرف توکن (رویداد usage از llm_generate برای حالت پروایدر؛
    # دیکشنری صفرتوکنی با پرچم laya برای حالت لوکال تا ردیف قابل‌مشاهده بماند)
    usage: dict | None = None
    # شناسه پروایدر تصمیم (local یا شناسه پروایدر بیرونی)
    provider_id: str = ""
    # مدل تصمیم (ریپوی محلی یا مدل چت پروایدر)
    model: str = ""

    def display(self, route: str = "") -> dict:
        """خروجی آماده نمایش برای پنل زنده (مسیر، اطمینان، انصراف، دلیل)."""
        chosen = str(route or "").strip() or str(self.value or "").strip()
        if chosen not in FAST_ROUTE_OPTIONS:
            chosen = FAST_ROUTE_NORMAL if not chosen else chosen
        try:
            conf = float(self.confidence)
        except (TypeError, ValueError):
            conf = 0.0
        if not 0.0 <= conf <= 1.0:
            conf = 0.0
        return {
            "route": chosen,
            "confidence": conf,
            "abstained": bool(self.abstained),
            "reason": str(self.reason or ""),
            "handled": bool(self.handled),
            "provider_id": str(self.provider_id or ""),
            "model": str(self.model or ""),
        }


def _local_usage(repo: str) -> dict:
    """رویداد usage صفرتوکنی برای تصمیم لوکال (ردیف قابل‌مشاهده در model usage)."""
    return {
        "kind": "usage",
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "model": repo or "",
        "provider": LAYA_PROVIDER_DEFAULT,
        "provider_id": LAYA_PROVIDER_DEFAULT,
        "sub": True,
        "laya": True,
    }


def _note_router_error(reason: str) -> None:
    """ثبت آخرین دلیل آماده‌نبودن روتر (برای تفکیک دلیل در decide)."""
    global _ROUTER_ERROR
    _ROUTER_ERROR = reason


def router_unavailable_reason() -> str:
    """دلیل آماده‌نبودن روتر محلی: نصب‌نیست در برابر وزن‌نیست."""
    if not is_available():
        return "laya-not-installed"
    if not is_ready():
        return "laya-weights-missing"
    if _ROUTER_ERROR:
        return _ROUTER_ERROR
    return "laya-unavailable"


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


def _local_router_models(repo: str, weight_dir: str) -> dict | None:
    """نگاشت مدل‌های Router به پوشه وزن محلی (آفلاین).

    دانلود ما کل ریپو را داخل ``models/laya--<slug>/`` می‌خواباند، در حالی که
    کش پیش‌فرض هاب جای دیگری است؛ پس شناسه ریپو را مستقیم به Router نمی‌دهیم
    (آرگومان اول Router دیکشنری models است نه رشته — دادن رشته خطای
    AttributeError می‌داد). در عوض مسیر محلی را می‌دهیم تا Agent آن را
    بدون دانلود دوباره بارگذاری کند.
    """
    try:
        if not weight_dir or not os.path.isdir(weight_dir):
            return None
        if not os.path.isfile(os.path.join(weight_dir, "rl_agent_config.json")):
            return None
        models: dict = {}
        for name, sub in (
            ("english", None),
            ("multilingual", "multilingual"),
            ("typed-decisions", "typed-decisions"),
        ):
            if sub is None:
                models[name] = (weight_dir, None)
            elif os.path.isfile(os.path.join(weight_dir, sub, "rl_agent_config.json")):
                models[name] = (weight_dir, sub)
            else:
                # زیرپوشه نیست (ریپوی تکی یا دانلود ناقص) → همان چک‌پوینت تکی.
                models[name] = (weight_dir, None)
        return models
    except Exception:  # noqa: BLE001 — fallback به رفتار پیش‌فرض
        return None


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
            _note_router_error("laya-not-installed")
            return None
        if not is_ready():
            _note_router_error("laya-weights-missing")
            return None
        try:
            import model_download

            weight_dir = model_download._laya_dir(repo)
        except Exception:  # noqa: BLE001 — fallback به کش پیش‌فرض
            weight_dir = ""
        models = _local_router_models(repo, weight_dir)
        cache = _router_cache_dir()
        os.makedirs(cache, exist_ok=True)
        # کش هاب را به پوشه داده کاربر هدایت کن تا دانلود خودکار
        # Router.predict داخل models/ بماند و آفلاین کار کند.
        os.environ.setdefault("HF_HOME", cache)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", cache)
        try:
            if models:
                _ROUTER = Router(models=models)
            else:
                _ROUTER = Router()
            _ROUTER_REPO = repo
            _note_router_error("")
            return _ROUTER
        except Exception as exc:  # noqa: BLE001 — وزن خراب/ناقص
            _ROUTER = None
            _ROUTER_REPO = ""
            _note_router_error(f"laya-error: {exc}")
            return None


def warmup_router() -> bool:
    """پیش‌گرم‌کردن روتر هنگام بالا آمدن سایدکار (ساخت اول‌باره خارج از حلقه)."""
    try:
        return _get_router() is not None
    except Exception:  # noqa: BLE001 — warmup اختیاری است
        return False


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
    repo = _laya_repo()
    router = _get_router()
    if router is None:
        reason = router_unavailable_reason()
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=reason,
            usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
        )
    try:
        import concurrent.futures

        # بدون with: خروج از with هنگام timeout منتظر پایان نخ می‌ماند
        # (shutdown با wait=True) و مهلت عملاً اعمال نمی‌شد.
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            fut = pool.submit(router.predict, state or {}, question or {})
            try:
                result = fut.result(timeout=LOCAL_PREDICT_TIMEOUT)
            except BaseException:
                fut.cancel()
                raise
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    except Exception as exc:  # noqa: BLE001 — خطای محلی = واگذاری به مدل بزرگ
        reason = "laya-timeout" if "timeout" in type(exc).__name__.lower() or "timed out" in str(exc).lower() else f"laya-error: {exc}"
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=reason,
            usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
        )
    value = _value_of(result)
    confidence = _confidence_of(result)
    abstained = _abstained_of(result, value)
    if abstained or confidence < threshold:
        return LayaDecision(
            handled=False, kind=kind, value=value, confidence=confidence,
            abstained=abstained,
            reason="abstained" if abstained else f"low-confidence:{confidence:.2f}",
            usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
        )
    return LayaDecision(
        handled=True, kind=kind, value=value, confidence=confidence,
        abstained=False, reason="local-decision",
        usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
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
            usage=None, provider_id=provider_id, model="",
        )
    try:
        from llm import build_chat_model, llm_generate
    except Exception:  # noqa: BLE001 — بدون llm فقط واگذار کن
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason="laya-provider-unavailable",
            usage=None, provider_id=provider_id, model=str(cfg.get("model") or ""),
        )
    options = question.get("options") if isinstance(question, dict) else None
    options_text = ", ".join(str(o) for o in options) if isinstance(options, list) and options else ""
    state_text = str(state)[:2000]
    prompt = (
        "Fast routing decision. Reply with compact JSON only: "
        '{"value": <choice or score>, "confidence": 0-1}. '
        f"kind={kind} options=[{options_text}] state={state_text}"
    )
    try:
        import asyncio
        import concurrent.futures

        model_name = str(cfg.get("model") or "")
        model = build_chat_model(
            str(cfg.get("kind") or "custom"),
            model_name,
            str(cfg.get("baseUrl") or ""),
            str(cfg.get("apiKey") or ""),
            str(cfg.get("envVar") or ""),
            temperature=0.0,
            max_tokens=256,
            timeout=PROVIDER_DECIDE_TIMEOUT,
            provider_id=provider_id,
        )

        def _run_provider() -> tuple[str, dict | None]:
            async def _one() -> tuple[str, dict | None]:
                return await llm_generate(model, user=prompt, sub=True)

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None and loop.is_running():
                # داخل حلقه رویداد هستیم: اجرای همگام در نخ جدا تا حلقه بلوکه نشود.
                import threading

                box: dict[str, Any] = {}

                def _target() -> None:
                    try:
                        box["out"] = asyncio.run(_one())
                    except BaseException as exc:  # noqa: BLE001 — به فراخواننده برمی‌گردد
                        box["err"] = exc

                thread = threading.Thread(target=_target, daemon=True)
                thread.start()
                thread.join(timeout=PROVIDER_DECIDE_TIMEOUT + 2.0)
                if thread.is_alive():
                    raise TimeoutError(f"laya provider timed out after {PROVIDER_DECIDE_TIMEOUT + 2.0:.0f}s")
                if "err" in box:
                    raise box["err"]
                return box["out"]
            return asyncio.run(_one())

        # بدون with: خروج از with هنگام timeout منتظر پایان نخ می‌ماند
        # (shutdown با wait=True) و مهلت عملاً اعمال نمی‌شد.
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            fut = pool.submit(_run_provider)
            try:
                text, usage = fut.result(timeout=PROVIDER_DECIDE_TIMEOUT + 4.0)
            except BaseException:
                fut.cancel()
                raise
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    except Exception as exc:  # noqa: BLE001 — خطای پروایدر = واگذاری
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=f"laya-provider-error: {exc}",
            usage=None, provider_id=provider_id, model=str(cfg.get("model") or ""),
        )
    value, confidence = _parse_provider_decision(text, options)
    abstained = _abstained_of({"abstained": False}, value)
    # مصرف واقعی llm_generate را نگه دار (مثل tools با sub=True) تا در جمع چت ثبت شود.
    if isinstance(usage, dict):
        usage = {**usage, "sub": True, "laya": True}
        if not usage.get("provider_id"):
            usage["provider_id"] = provider_id
        if not usage.get("model"):
            usage["model"] = str(cfg.get("model") or "")
    model_name = str(cfg.get("model") or "")
    if abstained or confidence < threshold:
        return LayaDecision(
            handled=False, kind=kind, value=value, confidence=confidence,
            abstained=abstained,
            reason="abstained" if abstained else f"low-confidence:{confidence:.2f}",
            usage=usage if isinstance(usage, dict) else None,
            provider_id=provider_id, model=model_name,
        )
    return LayaDecision(
        handled=True, kind=kind, value=value, confidence=confidence,
        abstained=False, reason="provider-decision",
        usage=usage if isinstance(usage, dict) else None,
        provider_id=provider_id, model=model_name,
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


def _contains_word(text: str, hint: str) -> bool:
    """تطبیق سرنخ با مرز کلمه تا حدس غلط کم شود (مثلاً web داخل website نه)."""
    hint = (hint or "").strip().lower()
    if not hint:
        return False
    if hint[-1].isspace():
        # سرنخ چندحرفی با فاصله انتهایی: تطبیق زیررشته‌ای امن است.
        return hint.strip() in text
    if any(ch.isalnum() or ch == "_" for ch in hint):
        try:
            return re.search(r"(?<!\w)" + re.escape(hint) + r"(?!\w)", text) is not None
        except re.error:
            return hint in text
    return hint in text


def fast_route(prompt: str) -> str:
    """مسیر سریع computer/browser/normal را از روی متن درخواست حدس می‌زند.

    قانون ساده و قابل پیش‌بینی با مرز کلمه: اشاره به اپ دسکتاپ یعنی computer،
    اشاره به وب/مرورگر یعنی browser، بقیه normal. مدل بزرگ فقط وقتی صدا زده
    می‌شود که laya نتواند همین قانون را با اطمینان تأیید کند.
    """
    text = (prompt or "").strip().lower()
    if not text:
        return FAST_ROUTE_NORMAL
    # «app»/«web»/«url»/«مک» به‌عمد حذف شدند: زیررشته‌های پرتکرار («app store»،
    # «web page»، «curl»، «کمک») با مرز کلمه هم حدس غلط می‌زنند؛ همان‌ها را
    # decide با laya تأیید می‌کند.
    computer_hints = (
        "computer", "desktop", "application", "windows", "macos", "linux",
        "اپ دسکتاپ", "دسکتاپ", "ویندوز", "لینوکس",
    )
    browser_hints = (
        "browser", "playwright", "website", "http", "https",
        "مرورگر", "وب", "سایت",
    )
    if any(_contains_word(text, hint) for hint in computer_hints):
        return FAST_ROUTE_COMPUTER
    if any(_contains_word(text, hint) for hint in browser_hints):
        return FAST_ROUTE_BROWSER
    return FAST_ROUTE_NORMAL


def choice(state: dict, options: list, threshold: float = DEFAULT_CONFIDENCE_THRESHOLD, provider_id: str = "") -> LayaDecision:
    """انتخاب از گزینه‌ها (کاندید خوب laya): خروجی ساخت‌یافته با اطمینان."""
    opts = [str(o) for o in (options or []) if str(o or "").strip()]
    if not opts:
        return LayaDecision(
            handled=False, kind="choice", value=None, confidence=0.0,
            abstained=True, reason="choice-no-options",
            usage=None, provider_id=(provider_id or _laya_provider_id()), model="",
        )
    return decide(state or {}, {"type": "choice", "options": opts}, threshold, provider_id)


def score(state: dict, candidate: Any, threshold: float = DEFAULT_CONFIDENCE_THRESHOLD, provider_id: str = "") -> LayaDecision:
    """امتیازدهی یک کاندید (۰ تا ۱) با آستانه اطمینان و واگذاری امن."""
    out = decide(state or {}, {"type": "score", "candidate": candidate}, threshold, provider_id)
    try:
        num = float(out.value)
    except (TypeError, ValueError):
        num = 0.0
    if not 0.0 <= num <= 1.0:
        return LayaDecision(
            handled=False, kind="score", value=num, confidence=0.0,
            abstained=True, reason="score-invalid",
            usage=out.usage, provider_id=out.provider_id, model=out.model,
        )
    return out


def status() -> dict:
    """وضعیت کامل laya برای نمایش در رابط کاربری (نصب/آماده/ریپو/پروایدر/دلیل)."""
    available = is_available()
    ready = is_ready()
    reason = ""
    if not available:
        reason = "laya-not-installed"
    elif not ready:
        reason = "laya-weights-missing"
    elif _ROUTER_ERROR and _ROUTER_ERROR not in ("laya-not-installed", "laya-weights-missing"):
        # خطای stale تلاش قبلی (نصب/وزن) را وقتی وزن آماده است نشان نده؛
        # خطاهای واقعی بارگذاری (laya-error) via decide می‌آیند.
        reason = _ROUTER_ERROR
    try:
        import model_download

        weight_dir = model_download._laya_dir(model_download._user_laya_model())
    except Exception:  # noqa: BLE001 — مسیر اختیاری است
        weight_dir = ""
    return {
        "available": available,
        "ready": ready,
        "repo": _laya_repo(),
        "provider": _laya_provider_id(),
        "reason": reason,
        "weight_dir": weight_dir,
    }
