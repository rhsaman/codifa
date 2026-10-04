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
import time
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

# تصمیم‌های سریع computer/browser برای حذف رفت‌وبرگشت‌های کند مدل بزرگ.
# هر کدام choice/rank امن با واگذاری None/[] هستند تا مسیر اصلی هرگز نشکند.
COMPUTER_STEP_OPTIONS = ("act_direct", "read_first")
COMPUTER_MODE_OPTIONS = ("act", "sequence")
BROWSER_STEP_OPTIONS = ("act_direct", "snapshot_first")
# مسیریابی گام‌به‌گام حلقهٔ اصلی: گام مکانیکی بعدی (مثل کلیک تکراری مرورگر)
# می‌تواند روی «مدل گام» کوچک اجرا شود؛ big_model یعنی مدل اصلی. فقط یک
# برچسب است — هیچ tool callی توسط laya ساخته یا اجرا نمی‌شود.
STEP_ROUTE_OPTIONS = ("big_model", "cheap_step")

_ROUTER_LOCK = threading.Lock()
# Only one torch forward at a time: native backends (notably MPS) abort
# the process on concurrent inference instead of raising.
_PREDICT_LOCK = threading.Lock()
_ROUTER: Any = None
_ROUTER_REPO: str = ""
# آخرین دلیل آماده‌نبودن روتر محلی (تفکیک «نصب نیست» از «وزن نیست»).
_ROUTER_ERROR: str = ""

# Device for the local laya router. Default "cpu": auto selection picks
# MPS on Apple Silicon, whose native backend aborts (SIGABRT) under
# threaded/parallel inference. Override with LAYA_DEVICE=mps|cuda|cpu.
LAYA_DEVICE_DEFAULT = "cpu"


def _laya_device() -> str:
    """Local router device from env (default CPU for stability)."""
    try:
        raw = str(os.environ.get("LAYA_DEVICE") or "").strip().lower()
    except Exception:  # noqa: BLE001 — env read must never fail
        raw = ""
    return raw or LAYA_DEVICE_DEFAULT


# سقف‌های زمانی کوتاه تا حلقه رویداد بلوکه نشود.
LOCAL_PREDICT_TIMEOUT = 4.0
PROVIDER_DECIDE_TIMEOUT = 8.0
# تصمیم‌های ثانویه (قدم بعدی computer/مرورگر، عمق درخت، گیت see) باید خیلی
# سریع برگردند: FALLBACK بعد از ۱ ثانیه بهتر از ۴ ثانیه معطلی است.
SECONDARY_PREDICT_TIMEOUT = 1.0
# آستانه جداگانه برای عمق shallow: سؤال دودویی shallow/full ذاتاً مرزی است
# (نمونه واقعی: ۵۱٪) و با آستانه عمومی ۰٫۶۵ همیشه واگذار می‌شد.
SHALLOW_CONFIDENCE_THRESHOLD = 0.5


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
    """Dedicated HF hub cache dir for laya auto-downloads.

    Must NOT be the shared ``models/`` root: huggingface_hub lays out
    downloads as ``models--<org>--<name>/`` there, and embedding_dirs()
    scans exactly that prefix — a laya auto-download used to show up as an
    "incomplete" row in the Settings Memory card.
    """
    try:
        import model_download

        return model_download.hub_cache_dir()
    except Exception:  # noqa: BLE001 — standalone fallback
        try:
            from state_db import data_root

            root = data_root()
        except Exception:  # noqa: BLE001
            root = os.path.join(os.path.expanduser("~"), ".codifa")
        return os.path.join(root, "models", "hub-cache")


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
            device = _laya_device()
            if models:
                _ROUTER = Router(models=models, device=device)
            else:
                _ROUTER = Router(device=device)
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
        router = _get_router()
        if router is None:
            return False
        # یک predict آزمایشی تا بارگذاری تنبل وزن‌ها هم همین‌جا انجام شود،
        # نه وسط اولین ترن چت (همان ۴ ثانیه‌ای که laya-timeout می‌ساخت).
        try:
            _predict_local(
                router,
                {"warmup": "1"},
                {"q": {"type": "choice", "instructions": "Pick one.", "criteria": ["a", "b"]}},
                timeout=15.0,
            )
        except Exception:  # cold predict failed, correctly report not-warm
            logger.warning("laya warmup predict failed (non-fatal)", exc_info=True)
            return False
        return True
    except Exception:  # noqa: BLE001 — warmup اختیاری است
        return False


def _first_answer(result: Any) -> Any | None:
    """اولین جواب typed را از خروجی واقعی Router.predict بیرون می‌کشد."""
    try:
        if isinstance(result, dict):
            answers = result.get("answers")
            if isinstance(answers, dict) and answers:
                first_key = next(iter(answers))
                return answers[first_key]
    except Exception as exc:  # noqa: BLE001 — خروجی ناهمگون؛ fallback به خود result
        logger.debug("laya first answer unreadable: %s", exc)
    return None


def _confidence_of(result: Any) -> float:
    """اطمینان ۰ تا ۱ را از خروجی ناهمگون Router.predict استخراج می‌کند."""
    answer = _first_answer(result)
    candidates: list[Any] = []
    if answer is not None:
        candidates.append(answer)
    candidates.append(result)
    for item in candidates:
        for attr in ("answer_confidence", "confidence", "prob", "probability", "score"):
            try:
                val = item.get(attr) if isinstance(item, dict) else getattr(item, attr, None)
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
    answer = _first_answer(result)
    if isinstance(answer, dict):
        for key in ("choice", "label", "value", "decision", "prediction"):
            if answer.get(key) is not None:
                return answer[key]
        if answer.get("type") == "score" and answer.get("score") is not None:
            try:
                levels = len(answer.get("legend") or answer.get("probabilities") or [])
                if levels > 1:
                    return float(answer["score"]) / float(levels - 1)
            except (TypeError, ValueError, ZeroDivisionError):
                pass
            return answer.get("score")
        if answer.get("type") == "noul" and answer.get("noul") is not None:
            return answer.get("noul")
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


def _normalize_candidates(candidates: Any) -> list[tuple[str, str | None]]:
    """فهرست نامزدها (رشته یا دیکت name/description) را به (نام، توضیح) تبدیل می‌کند."""
    out: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    items = candidates if isinstance(candidates, list) else []
    for item in items:
        name = ""
        desc: str | None = None
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("label") or item.get("id") or "").strip()
            raw_desc = item.get("description", item.get("desc"))
            if raw_desc is not None:
                desc = str(raw_desc).strip()[:300] or None
        else:
            name = str(item or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append((name, desc))
    return out


def _to_laya_questions(question: dict) -> dict:
    """سؤال داخلی (options/candidates) را به فرمت واقعی Router.predict تبدیل می‌کند."""
    q = question or {}
    kind = str(q.get("type") or "choice").strip().lower() or "choice"
    instructions = str(q.get("instructions") or "").strip()[:500]
    if kind == "choice":
        raw = q.get("options", q.get("candidates", []))
        pairs = _normalize_candidates(raw if isinstance(raw, list) else [])
        if not pairs:
            return {}
        if not instructions:
            instructions = "Pick the best matching option."
        if all(d is None for _, d in pairs):
            criteria: Any = [n for n, _ in pairs]
        else:
            criteria = {n: (d or "") for n, d in pairs}
        return {"q": {"type": "choice", "instructions": instructions, "criteria": criteria}}
    if kind == "score":
        levels = q.get("levels")
        if isinstance(levels, list):
            clean = [str(l).strip() for l in levels if str(l or "").strip()][:8]
        else:
            clean = []
        if not clean:
            clean = ["not relevant", "somewhat relevant", "relevant", "very relevant"]
        if not instructions:
            instructions = "Rate how relevant the candidate is."
        return {"q": {"type": "score", "instructions": instructions, "criteria": clean}}
    if kind == "noul":
        if not instructions:
            instructions = "Is it true?"
        crit = q.get("criteria")
        if isinstance(crit, dict):
            return {"q": {"type": "noul", "instructions": instructions, "criteria": crit}}
        return {"q": {"type": "noul", "instructions": instructions}}
    return {}


def _predict_local(
    router: Any,
    state: dict,
    questions: dict,
    timeout: float = LOCAL_PREDICT_TIMEOUT,
) -> Any:
    """اجرای Router.predict با سقف زمانی کوتاه (بدون بلوکه ماندن نخ)."""
    import concurrent.futures

    try:
        limit = float(timeout)
    except (TypeError, ValueError):
        limit = LOCAL_PREDICT_TIMEOUT
    if limit <= 0:
        limit = LOCAL_PREDICT_TIMEOUT
    # عبور سریع: تصمیم ثانویه نباید پشت قفل predict صف شود. وقتی یک predict
    # دیگر در حال اجراست، سریع واگذار کن تا تأخیرها روی هم انباشته نشوند.
    if limit <= SECONDARY_PREDICT_TIMEOUT + 0.01 and _PREDICT_LOCK.locked():
        raise TimeoutError("laya predict locked by another call")
    snapshot_state = dict(state or {})
    snapshot_questions = dict(questions or {})

    def _call() -> Any:
        # Only one torch forward at a time; concurrent native inference
        # aborts the sidecar (SIGABRT) instead of raising.
        with _PREDICT_LOCK:
            return router.predict(snapshot_state, snapshot_questions)

    # بدون with: خروج از with هنگام timeout منتظر پایان نخ می‌ماند
    # (shutdown با wait=True) و مهلت عملاً اعمال نمی‌شد.
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        fut = pool.submit(_call)
        try:
            return fut.result(timeout=limit)
        except BaseException:
            fut.cancel()
            raise
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def decide(
    state: dict,
    question: dict,
    threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    provider_id: str = "",
    chat_id: str = "",
    timeout: float = LOCAL_PREDICT_TIMEOUT,
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
        return _decide_via_provider(state or {}, question or {}, kind, threshold, provider,
                                      chat_id=chat_id)
    repo = _laya_repo()
    router = _get_router()
    if router is None:
        reason = router_unavailable_reason()
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason=reason,
            usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
        )
    questions = _to_laya_questions(question or {})
    if not questions:
        # Backward compat: legacy callers/tests pass a bare
        # {"type": "choice"} with no options and a stub router that
        # ignores the question shape. Try the raw question once so those
        # still resolve; real Router rejects it and we fall back below.
        try:
            legacy = _predict_local(router, dict(state or {}), dict(question or {}), timeout)
            value = _value_of(legacy)
            confidence = _confidence_of(legacy)
            abstained = _abstained_of(legacy, value)
            if not abstained and confidence >= threshold and value is not None:
                return LayaDecision(
                    handled=True, kind=kind, value=value, confidence=confidence,
                    abstained=False, reason="local-decision",
                    usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
                )
        except Exception as exc:  # noqa: BLE001 — fall through to bad-question
            logger.debug("laya legacy question failed: %s", exc)
        return LayaDecision(
            handled=False, kind=kind, value=None, confidence=0.0,
            abstained=True, reason="laya-bad-question",
            usage=_local_usage(repo), provider_id=LAYA_PROVIDER_DEFAULT, model=repo,
        )
    eff_state = dict(state or {})
    if kind == "score":
        cand = (question or {}).get("candidate")
        if cand is not None and "candidate" not in eff_state:
            eff_state["candidate"] = cand
    try:
        result = _predict_local(router, eff_state, questions, timeout)
    except Exception as exc:  # noqa: BLE001 — خطای محلی = واگذاری به مدل بزرگ
        _exc_text = f"{type(exc).__name__}: {exc}".lower()
        if "locked by another call" in _exc_text:
            reason = "laya-busy"
        elif "timeout" in type(exc).__name__.lower() or "timed out" in str(exc).lower():
            reason = "laya-timeout"
        else:
            reason = f"laya-error: {exc}"
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
    chat_id: str = "",
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
                return await llm_generate(model, user=prompt, sub=True,
                                          chat_id=str(chat_id or ""))

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
        "chrome", "tab", "window", "chart",
        "screenshot", "screen", "click", "keyboard", "mouse",
        "اپ دسکتاپ", "دسکتاپ", "ویندوز", "لینوکس",
        "کروم", "کامپیوتر", "پنجره", "تب", "چارت",
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


def choice(state: dict, options: list, threshold: float = DEFAULT_CONFIDENCE_THRESHOLD, provider_id: str = "", timeout: float = LOCAL_PREDICT_TIMEOUT, chat_id: str = "") -> LayaDecision:
    """انتخاب از گزینه‌ها (کاندید خوب laya): خروجی ساخت‌یافته با اطمینان."""
    opts = [str(o) for o in (options or []) if str(o or "").strip()]
    if not opts:
        return LayaDecision(
            handled=False, kind="choice", value=None, confidence=0.0,
            abstained=True, reason="choice-no-options",
            usage=None, provider_id=(provider_id or _laya_provider_id()), model="",
        )
    return decide(state or {}, {"type": "choice", "options": opts}, threshold, provider_id, str(chat_id or ""), timeout)


def score(state: dict, candidate: Any, threshold: float = DEFAULT_CONFIDENCE_THRESHOLD, provider_id: str = "", chat_id: str = "") -> LayaDecision:
    """امتیازدهی یک کاندید (۰ تا ۱) با آستانه اطمینان و واگذاری امن."""
    out = decide(state or {}, {"type": "score", "candidate": candidate}, threshold, provider_id, str(chat_id or ""))
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


# Embedding-rank confidence floor + distinctiveness margin. e5 cosine scores
# are compressed: unrelated text still lands around 0.7+, so a "high" score on
# a FLAT list is noise, not signal (reported bug: Movie Finder at 75% for an
# edit-error question, an unrelated test file at 78% for a TS edit). Below the
# floor — or with no clear winner over the runner-up — the embedding path
# abstains and the caller falls back to the keyword path / its previous
# behaviour instead of acting on a fabricated top pick.
_EMBED_RANK_MIN_CONF = 0.85
_EMBED_RANK_MIN_MARGIN = 0.03


def rank(
    text: str,
    candidates: Any,
    top_k: int = 5,
    instructions: str = "",
) -> list[dict]:
    """Generic ranking of candidates against free-form text (no domain hard-coding).

    Fast embedding prefilter in the spirit of ``laya.predict_shortlist``:
    ranks many options locally before any expensive Router call. Returns at
    most ``top_k`` dicts sorted by relevance (desc), each with ``name``,
    ``confidence`` (0-1), ``score`` (raw cosine or overlap count) and
    ``reason`` (``embedding-rank`` or ``keyword-rank``).

    Empty list means "no signal" — the caller must keep its previous
    behaviour (full list). Never raises.
    """
    pairs = _normalize_candidates(candidates)
    if not pairs:
        return []
    try:
        limit = int(top_k)
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(limit, len(pairs)))
    head = str(instructions or "").strip()
    body = str(text or "").strip()
    query_text = f"{head}\n{body}".strip()[:4000] if head else body[:4000]
    if not query_text:
        return []
    # Fast path: local embedding cosine (offline e5 model, no Router load).
    try:
        from embeddings import embed_passages, embed_queries, model_dir

        if model_dir():
            option_texts = [n if not d else f"{n}: {d}" for n, d in pairs]
            qvec = embed_queries([query_text])[0]
            pvecs = embed_passages(option_texts)
            scored: list[tuple[str, float, float]] = []
            for idx, (name, _desc) in enumerate(pairs):
                pv = pvecs[idx] if idx < len(pvecs) else []
                try:
                    dot = sum(a * b for a, b in zip(qvec, pv))
                    qn = sum(a * a for a in qvec) ** 0.5
                    pn = sum(b * b for b in pv) ** 0.5
                    cos = dot / (qn * pn) if qn > 0.0 and pn > 0.0 else 0.0
                    if not (-1.0 <= cos <= 1.0):
                        cos = 0.0
                except Exception:  # noqa: BLE001 — one bad vector skips, not the batch
                    cos = 0.0
                conf = max(0.0, min(1.0, cos))
                scored.append((name, conf, float(cos)))
            scored.sort(key=lambda item: item[2], reverse=True)
            top_conf = scored[0][1] if scored else 0.0
            runner_up = scored[1][1] if len(scored) > 1 else 0.0
            if top_conf >= _EMBED_RANK_MIN_CONF and (
                len(scored) == 1 or top_conf - runner_up >= _EMBED_RANK_MIN_MARGIN
            ):
                return [
                    {"name": n, "confidence": c, "score": s, "reason": "embedding-rank"}
                    for n, c, s in scored[:limit]
                ]
            # Flat/noisy scores: no signal — fall through to the keyword path
            # (which itself returns [] when there is no token overlap).
            logger.debug(
                "laya rank embedding path weak: top=%.3f margin=%.3f -> keyword fallback",
                top_conf,
                top_conf - runner_up,
            )
    except Exception as exc:  # noqa: BLE001 — fall through to keyword path
        logger.debug("laya rank embedding path failed: %s", exc)
    # Fallback: token-overlap ranking (no model needed, modest confidence).
    try:
        qtokens = {t for t in re.findall(r"\w+", query_text.lower()) if len(t) >= 2}
        if not qtokens:
            return []
        keyed: list[tuple[str, float, float]] = []
        for name, desc in pairs:
            ctokens = set(re.findall(r"\w+", f"{name} {desc or ''}".lower()))
            overlap = len(qtokens & ctokens)
            conf = min(0.55, 0.15 + 0.1 * overlap) if overlap else 0.0
            keyed.append((name, conf, float(overlap)))
        keyed.sort(key=lambda item: (-item[2], item[0]))
        if not any(k[2] > 0.0 for k in keyed):
            return []
        return [
            {"name": n, "confidence": c, "score": s, "reason": "keyword-rank"}
            for n, c, s in keyed[:limit]
        ]
    except Exception as exc:  # noqa: BLE001 — no signal, caller falls back
        logger.debug("laya rank keyword path failed: %s", exc)
        return []


def report_secondary(
    decision: Any | None,
    *,
    route: str = "",
    sub: str = "",
    chat_id: str = "",
    emit: Any = None,
    elapsed_ms: int = 0,
    prompt: str = "",
    options: Any = None,
    ranked: Any = None,
) -> None:
    """انتشار مشاهده‌پذیری تصمیم ثانویه laya (trace + رویداد زنده) — best-effort.

    هر مشورت laya (حتی abstain/low-confidence) یک ردیف در تب Laya می‌سازد تا
    «فقط یک‌بار laya» دیده نشود. هرگز استثنا نمی‌دهد تا مسیر اصلی نشکند.
    """
    try:
        r = (route or "").strip() or FAST_ROUTE_NORMAL
        if r not in FAST_ROUTE_OPTIONS:
            r = FAST_ROUTE_NORMAL
        label = (sub or "").strip() or "laya"
        conf = 0.0
        handled = False
        abstained = True
        reason = ""
        value: Any = None
        provider_id = LAYA_PROVIDER_DEFAULT
        model = ""
        kind = "choice"
        opts: list = []
        try:
            if decision is not None:
                conf = float(getattr(decision, "confidence", 0.0) or 0.0)
                handled = bool(getattr(decision, "handled", False))
                abstained = bool(getattr(decision, "abstained", True))
                reason = str(getattr(decision, "reason", "") or "")
                value = getattr(decision, "value", None)
                provider_id = str(getattr(decision, "provider_id", "") or LAYA_PROVIDER_DEFAULT)
                model = str(getattr(decision, "model", "") or "")
                kind = str(getattr(decision, "kind", "choice") or "choice")
            elif isinstance(ranked, list) and ranked:
                top = ranked[0] if isinstance(ranked[0], dict) else {}
                try:
                    conf = float(top.get("confidence", 0.0) or 0.0)
                except Exception:  # noqa: BLE001
                    conf = 0.0
                value = top.get("name") if isinstance(top, dict) else None
                handled = True
                abstained = False
                reason = str(top.get("reason", "") or "rank-ok")
                kind = "rank"
            else:
                return
        except Exception:  # noqa: BLE001
            return
        if not 0.0 <= conf <= 1.0:
            conf = 0.0
        try:
            opts = list(options) if isinstance(options, (list, tuple)) else []
        except Exception:  # noqa: BLE001
            opts = []
        summary = f"{r} · {int(conf * 100)}٪ · {label}"
        if value is not None and str(value).strip():
            summary += f" · {str(value).strip()[:80]}"
        live = {
            "kind": "laya",
            "route": r,
            "confidence": conf,
            "abstained": abstained,
            "reason": f"{label}: {reason}" if reason else label,
            "handled": handled,
            "provider_id": provider_id or LAYA_PROVIDER_DEFAULT,
            "model": model,
            "elapsed_ms": int(elapsed_ms or 0),
        }
        if emit is not None:
            try:
                emit(dict(live))
            except Exception:  # noqa: BLE001, S110 — رویداد زنده اختیاری است
                pass
        try:
            import trace_store

            trace_store.append(
                str(chat_id or ""),
                "laya",
                summary,
                detail={
                    "route": r,
                    "confidence": conf,
                    "abstained": abstained,
                    "reason": reason,
                    "handled": handled,
                    "provider_id": provider_id,
                    "model": model,
                    "elapsed_ms": int(elapsed_ms or 0),
                    "value": value,
                    "kind": kind,
                    "options": opts,
                    "sub": label,
                },
                model=model,
                prompt=str(prompt or "")[:2000],
                result=str(value or "") + (f"\nreason: {reason}" if reason else ""),
            )
        except Exception:  # noqa: BLE001, S110 — trace اختیاری است
            pass
    except Exception:  # noqa: BLE001, S110 — مشاهده‌پذیری هرگز مسیر اصلی را نمی‌شکند
        pass


def computer_next_step(task: str, app: str = "", chat_id: str = "", emit: Any = None) -> str | None:
    """قدم بعدی computer: مستقیم act بزن یا اول درخت بخوان؟

    خروجی یکی از COMPUTER_STEP_OPTIONS یا None (واگذاری به رفتار قبلی).
    هر مشورت (حتی abstain) در trace/رویداد زنده ثبت می‌شود تا فقط یک ردیف laya دیده نشود.
    هرگز استثنا نمی‌دهد تا مسیر اصلی ابزار نشکند.
    """
    _start = time.monotonic()
    try:
        decision = choice(
            {
                "task": (task or "")[:500],
                "app": (app or "")[:120],
            },
            list(COMPUTER_STEP_OPTIONS),
            timeout=SECONDARY_PREDICT_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 — خطا = ادامه رفتار قبلی
        return None
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        report_secondary(
            decision,
            route=FAST_ROUTE_COMPUTER,
            sub="computer_next_step",
            chat_id=chat_id,
            emit=emit,
            elapsed_ms=_elapsed,
            prompt=task or "",
            options=list(COMPUTER_STEP_OPTIONS),
        )
    except Exception:  # noqa: BLE001, S110 — گزارش اختیاری است
        pass
    try:
        if not decision.handled:
            return None
        value = str(decision.value or "").strip()
        if value in COMPUTER_STEP_OPTIONS:
            return value
    except Exception:  # noqa: BLE001
        return None
    return None


def computer_act_mode(task: str, app: str = "", chat_id: str = "", emit: Any = None) -> str | None:
    """حالت اجرای computer: اکشن معنایی act یا sequence مختصاتی؟

    خروجی یکی از COMPUTER_MODE_OPTIONS یا None (واگذاری به رفتار قبلی).
    هر مشورت در trace/رویداد زنده ثبت می‌شود. هرگز استثنا نمی‌دهد.
    """
    _start = time.monotonic()
    try:
        decision = choice(
            {
                "task": (task or "")[:500],
                "app": (app or "")[:120],
            },
            list(COMPUTER_MODE_OPTIONS),
            timeout=SECONDARY_PREDICT_TIMEOUT,
        )
    except Exception:  # noqa: BLE001
        return None
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        report_secondary(
            decision,
            route=FAST_ROUTE_COMPUTER,
            sub="computer_act_mode",
            chat_id=chat_id,
            emit=emit,
            elapsed_ms=_elapsed,
            prompt=task or "",
            options=list(COMPUTER_MODE_OPTIONS),
        )
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        if not decision.handled:
            return None
        value = str(decision.value or "").strip()
        if value in COMPUTER_MODE_OPTIONS:
            return value
    except Exception:  # noqa: BLE001
        return None
    return None


def browser_next_step(task: str, chat_id: str = "", emit: Any = None) -> str | None:
    """قدم بعدی Playwright: مستقیم act بزن یا اول snapshot بخوان؟

    خروجی یکی از BROWSER_STEP_OPTIONS یا None (واگذاری به رفتار قبلی).
    هر مشورت در trace/رویداد زنده ثبت می‌شود. هرگز استثنا نمی‌دهد.
    """
    _start = time.monotonic()
    try:
        decision = choice(
            {"task": (task or "")[:500]},
            list(BROWSER_STEP_OPTIONS),
            timeout=SECONDARY_PREDICT_TIMEOUT,
        )
    except Exception:  # noqa: BLE001
        return None
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        report_secondary(
            decision,
            route=FAST_ROUTE_BROWSER,
            sub="browser_next_step",
            chat_id=chat_id,
            emit=emit,
            elapsed_ms=_elapsed,
            prompt=task or "",
            options=list(BROWSER_STEP_OPTIONS),
        )
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        if not decision.handled:
            return None
        value = str(decision.value or "").strip()
        if value in BROWSER_STEP_OPTIONS:
            return value
    except Exception:  # noqa: BLE001
        return None
    return None


def step_route(
    task: str,
    last_tools: str = "",
    last_error: bool = False,
    step: int = 0,
    chat_id: str = "",
    emit: Any = None,
) -> str | None:
    """قدم بعدی حلقهٔ اصلی روی «مدل گام» کوچک اجرا شود یا مدل اصلی؟

    ورودی عمداً کوچک است (نه ترنسکریپت چندده‌هزارتوکنی): تسک، نام ابزارهای
    گام قبل، وضعیت خطا و شماره گام. خروجی یکی از STEP_ROUTE_OPTIONS یا None
    (واگذاری به مدل اصلی). هر مشورت در trace/رویداد زنده ثبت می‌شود.
    هرگز استثنا نمی‌دهد تا حلقهٔ اصلی نشکند.
    """
    _start = time.monotonic()
    try:
        decision = choice(
            {
                "task": (task or "")[:500],
                "last_tools": (last_tools or "")[:120],
                "last_error": "yes" if last_error else "no",
                "step": str(int(step or 0)),
            },
            list(STEP_ROUTE_OPTIONS),
            timeout=SECONDARY_PREDICT_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 — خطا = ادامه با مدل اصلی
        return None
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        report_secondary(
            decision,
            route=FAST_ROUTE_NORMAL,
            sub="step_route",
            chat_id=chat_id,
            emit=emit,
            elapsed_ms=_elapsed,
            prompt=task or "",
            options=list(STEP_ROUTE_OPTIONS),
        )
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        if not decision.handled:
            return None
        value = str(decision.value or "").strip()
        if value in STEP_ROUTE_OPTIONS:
            return value
    except Exception:  # noqa: BLE001
        return None
    return None


def rank_selectors(task: str, selectors: Any, top_k: int = 5, chat_id: str = "", emit: Any = None) -> list[dict]:
    """رتبه‌بندی selectorهای computer برای یک تسک (کدام محتمل‌تر است؟).

    خروجی rank (حداکثر top_k) یا [] یعنی بدون سیگنال و حفظ رفتار قبلی.
    نتیجه در trace/رویداد زنده ثبت می‌شود. هرگز استثنا نمی‌دهد.
    """
    _start = time.monotonic()
    try:
        out = rank(
            str(task or ""),
            selectors,
            top_k=top_k,
            instructions="Pick the most likely UI selector for this task.",
        )
    except Exception:  # noqa: BLE001
        return []
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        if out:
            report_secondary(
                None,
                route=FAST_ROUTE_COMPUTER,
                sub="rank_selectors",
                chat_id=chat_id,
                emit=emit,
                elapsed_ms=_elapsed,
                prompt=str(task or ""),
                ranked=out,
            )
    except Exception:  # noqa: BLE001, S110
        pass
    return out


def rank_browser_tools(task: str, tools: Any, top_k: int = 5, chat_id: str = "", emit: Any = None) -> list[dict]:
    """رتبه‌بندی ابزارهای مرورگر Playwright برای یک تسک.

    خروجی rank (حداکثر top_k) یا [] یعنی بدون سیگنال و حفظ رفتار قبلی.
    نتیجه در trace/رویداد زنده ثبت می‌شود. هرگز استثنا نمی‌دهد.
    """
    _start = time.monotonic()
    try:
        out = rank(
            str(task or ""),
            tools,
            top_k=top_k,
            instructions="Pick the most likely browser tool for this task.",
        )
    except Exception:  # noqa: BLE001
        return []
    try:
        _elapsed = int((time.monotonic() - _start) * 1000)
    except Exception:  # noqa: BLE001
        _elapsed = 0
    try:
        if out:
            report_secondary(
                None,
                route=FAST_ROUTE_BROWSER,
                sub="rank_browser_tools",
                chat_id=chat_id,
                emit=emit,
                elapsed_ms=_elapsed,
                prompt=str(task or ""),
                ranked=out,
            )
    except Exception:  # noqa: BLE001, S110
        pass
    return out


def status() -> dict:
    """وضعیت کامل laya برای نمایش در رابط کاربری (نصب/آماده/ریپو/پروایدر/دلیل)."""
    available = is_available()
    ready = bool(available and is_ready())
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
