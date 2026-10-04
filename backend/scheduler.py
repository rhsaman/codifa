"""منطق زمان‌بندی تسک‌های خودکار (مثل Codex): پارس کرون و محاسبه next_run.

فرمت کرون پشتیبانی‌شده (۵ فیلد، UTC):
    minute hour day-of-month month day-of-week
    مثال: "0 9 * * *" هر روز ساعت ۹ صبح، "*/15 * * * *" هر ۱۵ دقیقه.

همچنین presetهای ساده فارسی/انگلیسی پذیرفته می‌شود:
    "once" / "hourly" / "daily" / "weekly" / "every N minutes|hours"

همه زمان‌ها epoch ثانیه (UTC) هستند تا با state_db سازگار باشند.
"""

from __future__ import annotations

import calendar
import re
import time
from datetime import datetime, timezone

# preset نگاشت نام → کرون معادل
_PRESETS = {
    "once": "",
    "hourly": "0 * * * *",
    "daily": "0 9 * * *",
    "weekly": "0 9 * * 1",
}

_EVERY_RE = re.compile(
    r"every\s+(\d+)\s*(minute|minutes|hour|hours|min|hr|hrs|m|h)",
    re.IGNORECASE,
)


def normalize_cron(spec: str) -> str:
    """تبدیل preset/متن آزاد به کرون ۵ فیلدی؛ "" یعنی اجرای یک‌باره."""
    spec = (spec or "").strip().lower()
    if not spec or spec == "once":
        return ""
    if spec in _PRESETS:
        return _PRESETS[spec]
    m = _EVERY_RE.fullmatch(spec)
    if m:
        n = max(1, int(m.group(1)))
        unit = m.group(2).lower()
        if unit in ("m", "min", "minute", "minutes"):
            if n == 1:
                return "* * * * *"
            if n <= 59:
                return f"*/{n} * * * *"
            # بیشتر از ۵۹ دقیقه → ساعتی گرد کن
            return f"0 */{max(1, round(n / 60))} * * *"
        # ساعت
        if n == 1:
            return "0 * * * *"
        if n <= 23:
            return f"0 */{n} * * *"
        return "0 0 * * *"
    # اگر خودش کرون ۵ فیلدی معتبر است، همان را برگردان
    if _is_valid_cron(spec):
        return spec
    raise ValueError(f"زمان‌بندی نامعتبر: {spec!r}")


def _parse_field(field: str, lo: int, hi: int) -> set[int]:
    """پارس یک فیلد کرون به مجموعه اعداد مجاز (پشتیبانی از * , - /)."""
    out: set[int] = set()
    field = field.strip()
    if field == "*":
        return set(range(lo, hi + 1))
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            part, _, step_s = part.partition("/")
            step = max(1, int(step_s))
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            s, _, e = part.partition("-")
            start, end = int(s), int(e)
        else:
            start = end = int(part)
        if start < lo or end > hi or start > end:
            raise ValueError(f"فیلد کرون خارج از بازه: {field!r}")
        for v in range(start, end + 1, step):
            out.add(v)
    if not out:
        raise ValueError(f"فیلد کرون خالی: {field!r}")
    return out


def _is_valid_cron(spec: str) -> bool:
    try:
        parts = spec.split()
        if len(parts) != 5:
            return False
        bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
        for part, (lo, hi) in zip(parts, bounds):
            _parse_field(part, lo, hi)
        return True
    except (ValueError, TypeError):
        return False


def is_valid_schedule(spec: str) -> bool:
    """True اگر spec یک preset معتبر یا کرون ۵ فیلدی معتبر باشد."""
    try:
        normalize_cron(spec)
        return True
    except ValueError:
        return False


def next_run_after(cron: str, after_ts: float | None = None) -> float | None:
    """نوبت بعدی اجرای کرون بعد از after_ts (پیش‌فرض: اکنون). None برای once."""
    cron = (cron or "").strip()
    if not cron:
        return None
    parts = cron.split()
    if len(parts) != 5:
        raise ValueError(f"کرون باید ۵ فیلد داشته باشد: {cron!r}")
    bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
    fields = [_parse_field(p, lo, hi) for p, (lo, hi) in zip(parts, bounds)]
    minutes, hours, dom, months, dow = fields
    base = int(after_ts if after_ts is not None else time.time())
    # از دقیقه بعد شروع کن (ثانیه‌ها صفر می‌شوند)
    cursor = (base // 60) * 60 + 60
    # سقف جست‌وجو: ~۲ سال دقیقه‌به‌دقیقه (کافی برای هر کرون معتبر)
    for _ in range(366 * 2 * 24 * 60):
        dt = datetime.fromtimestamp(cursor, tz=timezone.utc)
        # کرون dow: 0 و ۷ هر دو یکشنبه‌اند؛ پایتون Monday=0 پس تبدیل لازم است
        cron_dow = (dt.weekday() + 1) % 7
        if (
            dt.minute in minutes
            and dt.hour in hours
            and dt.day in dom
            and dt.month in months
            and cron_dow in dow
        ):
            return float(cursor)
        cursor += 60
    return None


def describe_cron_fa(cron: str) -> str:
    """توصیف فارسی کوتاه یک کرون برای نمایش در UI."""
    cron = (cron or "").strip()
    if not cron:
        return "یک‌بار"
    presets_fa = {
        "0 * * * *": "هر ساعت",
        "0 9 * * *": "هر روز ساعت ۹",
        "0 9 * * 1": "هفتگی (دوشنبه ۹ صبح)",
        "* * * * *": "هر دقیقه",
    }
    if cron in presets_fa:
        return presets_fa[cron]
    m = re.fullmatch(r"\*/(\d+) \* \* \* \*", cron)
    if m:
        return f"هر {m.group(1)} دقیقه"
    m = re.fullmatch(r"0 \*/(\d+) \* \* \*", cron)
    if m:
        return f"هر {m.group(1)} ساعت"
    return cron


def compute_next_run(task: dict, now: float | None = None) -> float | None:
    """next_run یک تسک را از روی cron و last_run حساب کن.

    - تسک غیرفعال → None
    - cron خالی (once) → اگر هرگز اجرا نشده، now؛ وگرنه None
    - تکراری → نوبت بعدی بعد از max(last_run, now)؛ یعنی ران‌های missed
      دوران مکث/خاموشی اجرا نمی‌شوند و resume همیشه از لحظه ادامه حساب می‌شود.
    """
    now = now if now is not None else time.time()
    if not task.get("enabled", True):
        return None
    cron = normalize_cron(str(task.get("cron") or ""))
    last = task.get("last_run")
    try:
        last_f = float(last) if last else 0.0
    except (TypeError, ValueError):
        last_f = 0.0
    if not cron:
        return float(now) if not last_f else None
    # لنگر از max(last_run, now): اگر last_run قدیمی (قبل از مکث) باشد،
    # نوبت بعدی از اکنون حساب می‌شود نه از گذشته — بدون catch-up burst.
    anchor = max(now, last_f)
    return next_run_after(cron, anchor)


# پنجره تحمل سررسید (ثانیه): next_run ذخیره‌شده‌ای که حداکثر این‌قدر از
# اکنون گذشته باشد، سررسید واقعی حساب می‌شود. بزرگ‌تر از فاصله پولینگ حلقه
# (۳۰ ثانیه) است تا تاخیر یک تیک، اجرا را از دست ندهد؛ ولی ران‌های missed
# قدیمی (دوران مکث/خاموشی) را stale حساب می‌کند تا burst تکراری نزنند.
DUE_GRACE_SECONDS = 90.0


def is_due(task: dict, now: float | None = None, grace: float | None = None) -> bool:
    """True اگر تسک فعال باشد و نوبتش رسیده (next_run <= now).

    - تسک once (کرون خالی): اگر هرگز اجرا نشده باشد due است (اجرای فوری در
      تیک بعدی حلقه)، وگرنه هرگز due نیست.
    - تسک تکراری بدون next_run ذخیره‌شده: هنوز due نیست — کالر باید next_run
      تازه را persist کند و تا نوبت بعدی صبر کند (بدون burst فوری پس از ساخت).
    - next_run ذخیره‌شده در آینده: هنوز نرسیده → False.
    - next_run ذخیره‌شده در گذشته نزدیک (داخل grace): سررسید واقعی → True.
    - next_run خیلی قدیمی (stale — مثلاً از دوران مکث/خاموشی): ران missed
      اجرا نمی‌شود → False؛ کالر باید next_run را تازه کند (heal).
    """
    now = now if now is not None else time.time()
    if not task.get("enabled", True):
        return False
    try:
        cron = normalize_cron(str(task.get("cron") or ""))
    except ValueError:
        return False
    try:
        last_f = float(task.get("last_run") or 0)
    except (TypeError, ValueError):
        last_f = 0.0
    nxt = task.get("next_run")
    try:
        nxt_f = float(nxt) if nxt else None
    except (TypeError, ValueError):
        nxt_f = None
    if not cron:
        # once: اگر قبلاً اجرا شده هرگز due نیست؛ وگرنه فوری due است مگر
        # next_run ذخیره‌شده‌ای در آینده داشته باشد. ران missed یک‌باره
        # (stale) همچنان اجرا می‌شود — برخلاف تکراری‌ها catch-up دارد.
        if last_f:
            return False
        return not (nxt_f is not None and nxt_f > now)
    if nxt_f is None:
        return False
    if nxt_f > now:
        return False
    grace_s = DUE_GRACE_SECONDS if grace is None else float(grace)
    return (now - nxt_f) <= grace_s


def days_in_month(year: int, month: int) -> int:
    """تعداد روزهای ماه (کمکی برای تست/اعتبارسنجی)."""
    return calendar.monthrange(year, month)[1]
