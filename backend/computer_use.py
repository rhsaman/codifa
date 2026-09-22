"""لایهٔ نازک روی xa11y برای کنترل اپ‌های دسکتاپ از طریق Accessibility Tree.

همهٔ تعامل با xa11y در همین یک فایل محصور است تا:
  - تست‌پذیر باشد (mock کردن فقط همین ماژول کافی است)،
  - اگر روزی کتابخانه جایگزین شود، فقط همین فایل عوض شود.

xa11y روی هر سه سیستم‌عامل (macOS: AXUIElement، Windows: UI Automation،
Linux: AT-SPI2) درخت Accessibility را با یک API واحد می‌دهد: selector شبیه
CSS، اکشن‌های معنایی روی عنصر (press/set_value/…) و InputSim برای fallback
مختصاتی ماوس/کیبورد.

توابع این ماژول synchronous هستند (فراخوانی‌های Rust بلاک‌کننده‌اند)؛
فراخوانندهٔ async باید آن‌ها را با ``asyncio.to_thread`` اجرا کند.
"""

from __future__ import annotations

import base64
import io
import platform
import subprocess
import time
from typing import Any

try:  # xa11y فقط در محیط نصب‌شده در دسترس است؛ CI بدون UI هم باید import شود
    import xa11y

    _XA11Y_AVAILABLE = True
except ImportError:  # pragma: no cover - فقط وقتی وابستگی نصب نباشد
    xa11y = None  # type: ignore[assignment]
    _XA11Y_AVAILABLE = False

# سقف عمق پیش‌فرض درخت — کنترل مصرف توکن برای اپ‌های شلوغ (IDE، مرورگر)
DEFAULT_MAX_DEPTH = 14
# حداکثر کاراکتر خروجی dump قبل از برش
MAX_DUMP_CHARS = 24_000
# سقف گره‌های پیمایش‌شده وقتی bounds هر خط را می‌خواهیم: پیمایش lazy روی
# Element به ازای هر گره چند فراخوانی native دارد، پس در اپ‌های خیلی شلوغ به
# snapshot سریع xa11y (بدون geometry) برمی‌گردیم
MAX_BOUNDED_TREE_NODES = 400

# نقش‌های تعاملی که برای هرکدام selector + مرکز bounds گزارش می‌شود تا مدل
# به‌جای حدس زدن پیکسل از روی اسکرین‌شات، مختصات منطقی درست داشته باشد.
INTERACTIVE_ROLES = (
    "button",
    "link",
    "check_box",
    "radio_button",
    "text_field",
    "combo_box",
    "menu_item",
    "tab",
    "slider",
    "list_item",
)
# سقف آیتم‌های targets — کنترل مصرف توکن در اپ‌های شلوغ
MAX_TARGETS = 60

# اکشن‌های معنایی مجاز روی عنصر (نام متد Locator در xa11y)
ELEMENT_ACTIONS = {
    "press",
    "focus",
    "toggle",
    "expand",
    "collapse",
    "select",
    "show_menu",
    "scroll_into_view",
    "increment",
    "decrement",
    "set_value",
    "set_numeric_value",
    "type_text",
    "minimize",
    "maximize",
    "restore",
    "close",
}

# مدل‌ها اغلب برای «کلیک روی دکمه» action='click' می‌فرستند، در حالی که
# click مال ``input`` (fallback مختصاتی) است، نه ``act`` (معنایی). به‌جای
# خطا دادن و هدر رفتن یک رفت‌وبرگشت کامل، معادل معنایی‌اش اجرا می‌شود — دقیقاً
# همان چیزی که از «کلیک روی یک دکمه/آیتم» انتظار می‌رود.
ACT_DO_ALIASES: dict[str, str] = {
    "click": "press",
    "tap": "press",
}

# اکشن‌های مختصاتی InputSim (fallback وقتی اکشن معنایی ممکن نیست)
INPUT_ACTIONS = {
    "click",
    "double_click",
    "right_click",
    "move_to",
    "drag",
    "scroll",
    "press_key",
    "chord",
    "type_text",
}

# اکشن‌های مجاز داخل sequence (INPUT_ACTIONS + wait)
SEQUENCE_STEP_KINDS = INPUT_ACTIONS | {"wait"}

# اکشن‌هایی که به یک «هدف» نیاز دارند: مختصات logical یا selector یک عنصر.
# با selector، xa11y خودش مرکز bounds عنصر را استفاده می‌کند — بدون هیچ
# تبدیل مختصاتی، پس خطای مقیاس/رتینا در این مسیر صفر است.
TARGET_ACTIONS = {"click", "double_click", "right_click", "move_to", "drag", "scroll"}

# فاصلهٔ پیش‌فرض بین دو step در sequence (میلی‌ثانیه) — فرصت واکنش UI
SEQUENCE_DEFAULT_GAP_MS = 150

# سقف انتظار برای جلو آمدن پنجرهٔ اپ بعد از activate (ثانیه)
ACTIVATE_TIMEOUT_S = 2.0

# حداکثر عرض تصویر (پیکسل فیزیکی) قبل از downscale برای کنترل توکن
MAX_IMAGE_WIDTH = 1600

# نام کلیدهای نام‌دار در xa11y به شکل Pascal است ("Enter", "ArrowUp", "F5")؛
# مدل‌ها اغلب lowercase یا نام‌های متعارف دیگر می‌فرستند. این جدول alias ها را
# به امضای درست xa11y تبدیل می‌کند تا `press_key` بی‌دلیل خطا نگیرد.
KEY_ALIASES: dict[str, str] = {
    "enter": "Enter",
    "return": "Enter",
    "newline": "Enter",
    "cr": "Enter",
    "tab": "Tab",
    "esc": "Escape",
    "escape": "Escape",
    "space": "Space",
    "spacebar": "Space",
    "backspace": "Backspace",
    "delete": "Delete",
    "del": "Delete",
    "insert": "Insert",
    "home": "Home",
    "end": "End",
    "pageup": "PageUp",
    "pgup": "PageUp",
    "pagedown": "PageDown",
    "pgdn": "PageDown",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    "arrowup": "ArrowUp",
    "arrowdown": "ArrowDown",
    "arrowleft": "ArrowLeft",
    "arrowright": "ArrowRight",
    "printscreen": "PrintScreen",
    "capslock": "CapsLock",
    "numlock": "NumLock",
    "scrolllock": "ScrollLock",
}

# مودیفایرها در xa11y دقیقاً Shift/Ctrl/Alt/Meta هستند؛ مدل‌ها cmd/command/
# control/option/win می‌نویسند.
MODIFIER_ALIASES: dict[str, str] = {
    "shift": "Shift",
    "ctrl": "Ctrl",
    "control": "Ctrl",
    "alt": "Alt",
    "option": "Alt",
    "meta": "Meta",
    "cmd": "Meta",
    "command": "Meta",
    "super": "Meta",
    "win": "Meta",
    "windows": "Meta",
}

# دستیار کلیپ‌بورد هر سیستم‌عامل: (فرمان کپی، کلید paste به‌صورت chord)
_CLIPBOARD_HELPERS = {
    "Darwin": ("pbcopy", "v", ["Meta"]),
    "Windows": ("clip", "v", ["Ctrl"]),
    "Linux": ("xclip", "v", ["Ctrl"]),
}

# راهنمای پرمیشن مخصوص هر سیستم‌عامل
_ACCESS_NOTES = {
    "Darwin": (
        "macOS requires Accessibility permission: System Settings → Privacy & "
        "Security → Accessibility → enable the Electron app AND the Python sidecar "
        "that actually calls the tree (when running dev via `npm run dev` "
        "enable Terminal/iTerm + backend/.venv/bin/python; when running the "
        "bundled app re-enable after every update). After enabling, fully quit "
        "with ⌘Q and restart — a window close is not enough. Screen Recording "
        "is NOT needed for the tree, only for screenshots."
    ),
    "Windows": (
        "Windows needs no setup — UI Automation is available to all processes."
    ),
    "Linux": (
        "Linux needs AT-SPI2: on GNOME it is enabled by default; otherwise "
        "install at-spi2-core and enable the accessibility bus "
        "(GTK_MODULES=gail:atk-bridge or org.gnome.desktop.interface "
        "toolkit-accessibility=true)."
    ),
}


def _friendly_error(exc: Exception) -> str:
    """تبدیل خطاهای xa11y به پیام قابل‌فهم برای مدل."""
    name = type(exc).__name__
    txt_lower = str(exc).lower()
    mapping = {
        "PermissionDeniedError": _ACCESS_NOTES.get(platform.system(), ""),
        "PlatformError": (
            _ACCESS_NOTES.get(platform.system(), "")
            if ("permission denied" in txt_lower or "accessibility" in txt_lower)
            else ""
        ),
        "SelectorNotMatchedError": (
            "No element matched the selector — read the tree first "
            "(action=read_screen) and check the selector syntax. "
            "For dynamic text (prices, timers) use prefix/contains match "
            "like `web_area[name^='EURUSD']` or `button[name*='Save']`, "
            "or use `action=see` + `input` click via pixel (works for any app)."
        ),
        "ActionNotSupportedError": (
            "The element does not support this action — check the element's "
            "actions list in the tree dump and pick another action."
        ),
        "AccessibilityNotEnabledError": (
            "The target app advertises an accessibility tree but it is empty "
            "(the app may not expose one, e.g. games or canvas-based UIs)."
        ),
        "TimeoutError": "Timed out waiting for the element/app to appear.",
        "InvalidSelectorError": "Invalid selector syntax.",
    }
    hint = mapping.get(name)
    # Fallback: any error whose MESSAGE says permission denied / accessibility
    # (e.g. PlatformError(-1) from the Rust side, or future renames) still
    # gets the Darwin note even if the class name changes.
    if not hint and ("permission denied" in txt_lower or "enable accessibility" in txt_lower):
        hint = _ACCESS_NOTES.get(platform.system(), "")
    out = f"{name}: {exc}"
    if hint:
        out += f" — {hint}"
    # کلیدهای ترکیبی با نام اشتباه (command+t، cmd+n، ctrl، …) — راهنمای فرمت درست
    if isinstance(exc, ValueError) and "unknown key name" in str(exc).lower():
        out += (
            " — named keys use their Pascal name ('Enter', 'Tab', 'Escape', "
            "'ArrowUp', 'F5'); printable characters are literal and lowercase "
            "('a', '1'). Combos go through kind='chord' with key='t' and "
            "held='Meta'. Valid modifiers: Meta, Ctrl, Alt, Shift."
        )
    return out


def check_access() -> dict[str, Any]:
    """بررسی دسترسی Accessibility و راهنمای پرمیشن مخصوص همین OS."""
    result: dict[str, Any] = {
        "available": _XA11Y_AVAILABLE,
        "platform": platform.system(),
    }
    if not _XA11Y_AVAILABLE:
        result["ok"] = False
        result["note"] = "xa11y is not installed — run `uv add xa11y`."
        return result
    try:
        app = xa11y.App.foreground(timeout=1.0)
        result["ok"] = True
        result["foreground_app"] = app.name
    except Exception as exc:  # noqa: BLE001
        result["ok"] = False
        result["error"] = _friendly_error(exc)
        result["note"] = _ACCESS_NOTES.get(platform.system(), "")
    return result


def _resolve_app(app_name: str):
    """اپ هدف: با نام دقیق، وگرنه اپ foreground."""
    if app_name.strip():
        canonical = _canonical_app_name(app_name)
        # نام کوتاه chrome هم باید Google Chrome را پیدا کند — برای هر اپ هم case-insensitive
        for cand in [canonical, app_name.strip()]:
            try:
                return xa11y.App.by_name(cand, timeout=3.0)
            except Exception:  # noqa: BLE001, S112 — نام بعدی را امتحان کن
                continue
        # fallback عمومی: لیست اپ‌ها و تطبیق تساهلی (finder ↔ Finder, notes ↔ Notes)
        try:
            for a in xa11y.App.list():
                if _names_match(getattr(a, "name", ""), canonical) or _names_match(
                    getattr(a, "name", ""), app_name
                ):
                    return a
        except Exception:  # noqa: BLE001, S110 — list در دسترس نیست؛ ادامه به خطای اصلی
            pass
        # آخرین تلاش: با نام اصلی خطا را بالا ببر تا _friendly_error پیام درست بدهد
        return xa11y.App.by_name(app_name.strip(), timeout=3.0)
    return xa11y.App.foreground(timeout=3.0)


_APP_ALIASES: dict[str, str] = {
    "chrome": "Google Chrome",
    "google chrome": "Google Chrome",
    "google-chrome": "Google Chrome",
    "chromium": "Chromium",
    "code": "Visual Studio Code",
    "vscode": "Visual Studio Code",
    "vs code": "Visual Studio Code",
}


def _canonical_app_name(name: str) -> str:
    """نگاشت نام‌های کوتاه/کوچک به نام واقعی اپ در macOS."""
    raw = name.strip()
    low = raw.lower()
    return _APP_ALIASES.get(low, raw)


def _names_match(a: str, b: str) -> bool:
    """مقایسهٔ تساهلی نام اپ — case-insensitive و شامل alias."""
    al = a.strip().lower()
    bl = b.strip().lower()
    return al == bl or al in bl or bl in al


def _wait_foreground(app_name: str, timeout: float = ACTIVATE_TIMEOUT_S) -> bool:
    """صبر تا اپ هدف واقعاً foreground شود (به‌جای sleep کور).

    فعال‌سازی مک/ویندوز ناهمگام است: اگر بلافاصله رویداد بفرستیم، پنجره هنوز
    جلو نیامده و کلیک/کلید به اپ قبلی می‌رود. تا سقف ``timeout``poll می‌کنیم
    و اگر نشد False برمی‌گردیم (اکشن باز هم اجرا می‌شود؛ فقط هشدار می‌دهد).

    Chrome و برخی اپ‌های Electron با ``App.by_name(...).is_foreground``
    همیشه False گزارش می‌دهند (یا نام کوتاه ``chrome`` فرستاده می‌شود)؛ برای
    همین هم ``by_name`` و هم ``foreground().name`` را با تطبیق تساهلی چک می‌کنیم.
    """
    canonical = _canonical_app_name(app_name)
    candidates = [canonical, app_name.strip()]
    # حذف تکراری با حفظ ترتیب
    seen: set[str] = set()
    uniq: list[str] = []
    for c in candidates:
        low = c.lower()
        if low not in seen:
            seen.add(low)
            uniq.append(c)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for cand in uniq:
            try:
                app = xa11y.App.by_name(cand, timeout=0.5)
                if getattr(app, "is_foreground", False):
                    return True
            except Exception:  # noqa: BLE001, S110 — اپ هنوز لیست نشده؛ ادامه بده
                pass
            # fallback: نام اپ foreground چیست؟
            try:
                fg = xa11y.App.foreground(timeout=0.5)
                if _names_match(fg.name, cand):
                    return True
            except Exception:  # noqa: BLE001, S110 — foreground قابل خواندن نیست
                pass
        # تلاش دیگر: هر اپ foreground فعلی را مستقیماً با canonical مقایسه کن
        try:
            fg = xa11y.App.foreground(timeout=0.5)
            if _names_match(fg.name, canonical):
                return True
        except Exception:  # noqa: BLE001, S110
            pass
        time.sleep(0.05)
    return False


def _normalize_key(key: str) -> str:
    """نام کلید به امضای xa11y (Pascal برای کلیدهای نام‌دار، حرفی‌ها عیناً)."""
    raw = (key or "").strip()
    if not raw:
        raise ValueError("empty key name — pass a single key like 'Enter' or 'a'")
    alias = KEY_ALIASES.get(raw.lower())
    if alias:
        return alias
    # نام‌های جداشده با فاصله/آندرلاین: 'arrow up' → 'ArrowUp'
    if " " in raw or "_" in raw:
        joined = raw.replace("_", " ").strip()
        alias = KEY_ALIASES.get(joined.replace(" ", "").lower())
        if alias:
            return alias
        if len(joined.split()) > 1:
            return "".join(p[:1].upper() + p[1:] for p in joined.split())
    # F1..F24 و حروف/ارقام تکی: xa11y خودش می‌شناسد؛ فقط case کلید نام‌دار
    if raw.upper().startswith("F") and raw[1:].isdigit():
        return "F" + raw[1:]
    return raw


def _normalize_modifiers(held: Any) -> list[str]:
    """مودیفایرها به Shift/Ctrl/Alt/Meta (تک‌رشته یا لیست پذیرفته می‌شود)."""
    if held is None:
        return []
    parts = held if isinstance(held, (list, tuple)) else str(held).split(",")
    out: list[str] = []
    for part in parts:
        token = str(part).strip()
        if not token:
            continue
        mapped = MODIFIER_ALIASES.get(token.lower())
        if mapped is None:
            raise ValueError(
                f"unknown modifier {token!r} — valid modifiers: "
                + ", ".join(sorted({"Meta", "Ctrl", "Alt", "Shift"}))
            )
        out.append(mapped)
    return out


def _center_of(element) -> tuple[int, int] | None:
    """مرکز bounds یک عنصر در فضای logical screen (همان فضای InputSim)."""
    bounds = getattr(element, "bounds", None)
    if bounds is None:
        return None
    return (
        int(bounds.x + bounds.width / 2),
        int(bounds.y + bounds.height / 2),
    )


def _bounds_origin(element) -> tuple[int, int] | None:
    """گوشهٔ بالا-چپ bounds یک عنصر (مبدأ یک اسکرین‌شات بریده‌شده)."""
    try:
        bounds = element.bounds
    except Exception:  # noqa: BLE001 — بعضی providerها bounds ندارند
        return None
    if bounds is None:
        return None
    return (int(bounds.x), int(bounds.y))


def _describe_element(element, fallback: str) -> str:
    """توصیف کوتاه عنصر + مرکز آن — تا مدل بداند کلیک کجا می‌نشیند."""
    try:
        label = f"{element.role} '{element.name or ''}'".strip()
    except Exception:  # noqa: BLE001 — توصیف best-effort است
        return fallback
    center = _center_of(element)
    if center:
        label += f" @({center[0]},{center[1]})"
    return label


def _resolve_pointer_target(
    selector: str,
    app_name: str,
    x: Any,
    y: Any,
    *,
    scroll_into_view: bool = True,
):
    """مرجع برای اکشن ماوسی: Element از selector، وگرنه tuple منطقی (x, y).

    selector اولویت دارد چون xa11y خودش مرکز bounds را حساب می‌کند؛ هیچ تبدیل
    مقیاس/پیکسلی در کار نیست و خطای «کلیک دور از هدف» حذف می‌شود.
    """
    if selector.strip():
        app = _resolve_app(app_name)
        loc = app.locator(selector.strip())
        if scroll_into_view:
            try:  # عنصر بیرون viewport ممکن است bounds نامعتبر داشته باشد
                loc.scroll_into_view()
            except Exception:  # noqa: BLE001, S110 — اگر support نکرد با همان bounds
                pass
        return loc.element()
    if x is None or y is None:
        raise ValueError(
            "this input kind needs a target: pass selector='<role>[name=...]' "
            "(recommended — xa11y clicks the element's bounds centre) or "
            "explicit x/y in LOGICAL screen points."
        )
    try:
        return (int(float(x)), int(float(y)))
    except (TypeError, ValueError):
        return (int(x), int(y))


def _resolve_drag_end(
    selector2: str,
    app_name: str,
    x2: Any,
    y2: Any,
):
    """مقصد drag از ``selector2``، وگرنه مختصات صریح (x2, y2).

    مبدأ ممکن است یک Element باشد (از ``selector``)؛ در آن حالت هیچ مختصاتی
    برای حدس مقصد وجود ندارد، پس مقصد باید صریح داده شود.
    """
    if selector2.strip():
        app = _resolve_app(app_name)
        return app.locator(selector2.strip()).element()
    if x2 is None or y2 is None:
        raise ValueError(
            "drag needs an end point: pass selector2 or x2/y2 (logical points)."
        )
    try:
        return (int(float(x2)), int(float(y2)))
    except (TypeError, ValueError):
        return (int(x2), int(y2))


def _selector_for(role: str, name: str) -> str:
    """selector امن برای یک عنصر (نام داخل [] با escape شدن نقل‌قول)."""
    if not name:
        return role
    safe = name.replace("\\", "\\\\").replace("'", "\\'")
    return f"{role}[name='{safe}']"


def _actionable_targets(
    app, limit: int = MAX_TARGETS, scope_selector: str = ""
) -> tuple[list[str], bool]:
    """فهرست «selector → مرکز منطقی» برای نقش‌های تعاملی.

    دلیل وجود: مدل بدون مرجع مختصاتی مجبور است از روی پیکسل‌های اسکرین‌شات
    حدس بزند، و آن حدس با مقیاس رتینا و downscale تصویر خراب می‌شود. این
    فهرست هم selector می‌دهد (برای act — دقیق‌ترین مسیر) و هم مرکز bounds در
    همان فضای logical point که input در آن اجرا می‌شود.

    ``scope_selector`` جست‌وجو را به زیردرخت یک عنصر محدود می‌کند (مسیر
    read_element)؛ selectorهای خروجی هم با همان پیشوند برمی‌گردند تا مستقیماً
    قابل استفاده باشند. عناصر هم‌نام با ``:nth(k)`` یکتا می‌شوند — بدون آن،
    selector دوسو دارد و xa11y ممکن است عنصر اشتباهی را برگیرد.
    """
    prefix = f"{scope_selector.strip()} >> " if scope_selector.strip() else ""
    found: list[tuple[str, tuple[int, int]]] = []
    capped = False
    # سقف پیمایش کمی بزرگ‌تر از limit تا شمارش :nth درست بماند
    for role in INTERACTIVE_ROLES:
        if len(found) >= limit * 2:
            capped = True
            break
        try:
            elements = app.locator(prefix + role).elements()
        except Exception:  # noqa: BLE001, S112 — اپ این role را support نمی‌کند
            continue
        for el in elements or []:
            try:
                center = _center_of(el)
                if center is None:
                    continue
                # role از همان حلقه می‌آید، نه el.role — تا با selector درخواستی
                # و ترتیب :nth یکسان بماند
                found.append((_selector_for(role, el.name or ""), center))
            except Exception:  # noqa: BLE001, S112 — عنصر بی‌bounds رد می‌شود
                continue
    totals: dict[str, int] = {}
    for key, _center in found:
        totals[key] = totals.get(key, 0) + 1
    seen: dict[str, int] = {}
    lines: list[str] = []
    for key, center in found[:limit]:
        sel = prefix + key
        if totals[key] > 1:
            seen[key] = seen.get(key, 0) + 1
            sel += f":nth({seen[key]})"
        lines.append(f"{sel} -> center=({center[0]},{center[1]})")
    if len(found) > limit:
        capped = True
    return lines, capped


def read_screen(app_name: str = "", max_depth: int = DEFAULT_MAX_DEPTH) -> dict[str, Any]:
    """درخت Accessibility اپ هدف (با نام، یا پیش‌فرض اپ فعال) به‌صورت متن فشرده."""
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        app = _resolve_app(app_name)
        dump, has_bounds = _dump_with_bounds(app.as_element(), max_depth)
        truncated = len(dump) > MAX_DUMP_CHARS
        result: dict[str, Any] = {
            "app": app.name,
            "tree": dump[:MAX_DUMP_CHARS],
            "truncated": truncated,
            # True: هر خط bounds خودش را دارد (model می‌تواند مستقیم کلیک کند).
            # False: درخت از بودجه رد شد و به dump سریع برگشتیم — برای
            # مختصات به ``targets`` تکیه کن، نه به حدس پیکسلی.
            "bounds_in_tree": has_bounds,
        }
        targets, capped = _actionable_targets(app)
        if targets:
            result["targets"] = targets
            result["targets_truncated"] = capped
            result["targets_hint"] = (
                "centers are LOGICAL screen points — the same space `input` "
                "clicks in. Prefer action='act' with these selectors; use the "
                "center only for coordinate gestures (drag/scroll)."
            )
        # درخت خالی = اپ اجراست ولی پنجره‌ای ندارد (مثلاً فقط آیکون در Dock)
        if len(dump.strip().splitlines()) <= 1:
            result["hint"] = (
                "The app is running but has NO open window (empty tree). "
                "Use action='open_app' to bring it to front / open a window, "
                "then read_screen again."
            )
        return result
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def list_apps() -> dict[str, Any]:
    """لیست اپ‌های در حال اجرا (برای انتخاب هدف اکشن‌ها)."""
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        apps = xa11y.App.list()
        return {"apps": [a.name for a in apps]}
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def find_and_act(
    selector: str,
    action: str,
    value: str = "",
    app_name: str = "",
) -> dict[str, Any]:
    """اجرای اکشن معنایی روی عنصری که selector با آن match می‌شود.

    ``action`` یکی از ``ELEMENT_ACTIONS`` است؛ ``set_value``/``type_text`` به
    ``value`` نیاز دارند. خروجی شامل نام/role عنصر است تا مدل (و کاربر) بدانند
    اکشن روی چه چیزی اجرا شد.
    """
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    action = ACT_DO_ALIASES.get(action, action)
    if action not in ELEMENT_ACTIONS:
        return {
            "error": f"Unknown action {action!r} — use one of: "
            + ", ".join(sorted(ELEMENT_ACTIONS))
        }
    try:
        # هر اکشن معنایی روی اپ فوکوس‌شده اجرا می‌شود؛ اگر app مشخص شده،
        # اول اپ را فعال می‌کنیم تا روی اپ اشتباهی کلیک/تایپ نشود.
        warning = ""
        if app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            if not activated.get("foreground", True):
                warning = (
                    f"app {app_name!r} did not become foreground within "
                    f"{ACTIVATE_TIMEOUT_S}s — action may have gone to wrong app"
                )
        app = _resolve_app(app_name)
        loc = app.locator(selector)
        # عنصر خارج viewport باشد bounds نامعتبر می‌دهد — اول اسکرول
        try:
            loc.scroll_into_view()
        except Exception:  # noqa: BLE001, S110 — اگر support نکرد با همان bounds ادامه بده
            pass
        # bounds نداشتن = عنصر مخفی/غیرقابل کلیک — هشدار بده ولی ادامه بده
        try:
            _el_for_check = loc.element()
            if getattr(_el_for_check, "bounds", None) is None:
                msg = "element has no bounds (hidden/offscreen) — click may do nothing"
                warning = f"{warning}; {msg}" if warning else msg
        except Exception:  # noqa: BLE001, S110 — best-effort
            pass
        if action == "set_value":
            loc.set_value(value)
        elif action == "type_text":
            loc.type_text(value)
        elif action == "set_numeric_value":
            try:
                loc.set_numeric_value(float(value))
            except ValueError:
                return {"error": f"set_numeric_value needs a number, got {value!r}"}
        else:
            getattr(loc, action)()
        # نام/role + مرکز bounds عنصر برای نمایش به کاربر — بعد از اکشن
        # دوباره resolve می‌شود. مرکز به مدل مرجع می‌دهد تا بداند اکشن کجا
        # نشسته و در صورت نیاز همان نقطه را با input تکرار کند.
        try:
            el = loc.element()
            target = _describe_element(el, selector)
        except Exception:  # noqa: BLE001 — اکشن موفق بود؛ توصیف عنصر best-effort است
            target = selector
        out: dict[str, Any] = {"ok": True, "app": app.name, "action": action, "target": target}
        if warning:
            out["warning"] = warning
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def _paste_via_clipboard(sim, text: str) -> None:
    """قرار دادن متن در کلیپ‌بورد سیستم و paste کردن با میان‌بر.

    محتوای قبلی کلیپ‌بورد کاربر به‌صورت best-effort ذخیره و بازگردانی
    می‌شود (فقط مک — در ویندوز/لینوکس دستیار معکوس استانداردی نیست).
    """
    system = platform.system()
    copy_cmd, paste_key, held = _CLIPBOARD_HELPERS.get(
        system, ("xclip", "v", ["Ctrl"])
    )
    saved = None
    if system == "Darwin":
        try:  # ذخیرهٔ محتوای فعلی کلیپ‌بورد
            saved = subprocess.run(
                ["pbpaste"], capture_output=True, timeout=2, check=False
            ).stdout
        except Exception:  # noqa: BLE001 — بازگردانی best-effort است
            saved = None
    try:
        subprocess.run(
            [copy_cmd], input=text.encode("utf-8"), check=True, timeout=2
        )
        time.sleep(0.1)
        sim.chord(paste_key, held=held)
        # paste یک رویداد غیرهمگام است: اپ متن را زمانِ رسیدنِ کلید
        # از کلیپ‌بورد می‌خواند. اگر زودتر restore کنیم، اپ محتوای
        # قبلی کلیپ‌بورد را می‌خواند و متن اشتباه paste می‌شود.
        time.sleep(0.4)
    finally:
        if saved is not None:
            try:  # بازگردانی کلیپ‌بورد کاربر
                subprocess.run(
                    ["pbcopy"], input=saved, check=True, timeout=2
                )
            except Exception:  # noqa: BLE001, S110 — بازگردانی best-effort
                pass


def _type_text(sim, text: str) -> None:
    """type_text xa11y فقط ASCII را می‌پذیرد؛ متن غیر ASCII از کلیپ‌بورد."""
    if text.isascii():
        sim.type_text(text)
    else:
        _paste_via_clipboard(sim, text)


def _sim_do(
    sim,
    kind: str,
    *,
    target: Any = None,
    target2: Any = None,
    key: str = "",
    held: Any = "",
    text: str = "",
    dx: int = 0,
    dy: int = 0,
) -> None:
    """اجرای یک اکشن InputSim — mapping مشترک برای input_action و sequence.

    ``target``/``target2`` یا یک tuple منطقی ``(x, y)`` هستند یا یک ``Element``
    (که xa11y خودش مرکز bounds را انتخاب می‌کند). نام کلید و مودیفایرها همین‌جا
    به امضای xa11y نرمال می‌شوند تا هر دو مسیر یکسان رفتار کنند.
    """
    if kind == "click":
        sim.click(target)
    elif kind == "double_click":
        sim.double_click(target)
    elif kind == "right_click":
        sim.right_click(target)
    elif kind == "move_to":
        sim.move_to(target)
    elif kind == "drag":
        sim.drag(target, target2)
    elif kind == "scroll":
        sim.scroll(target, dx=dx, dy=dy)
    elif kind == "press_key":
        # press_key با held عمداً معادل chord است؛ اگر نادیده گرفته شود،
        # مدل فکر می‌کند ترکیب را زده در حالی که فقط کلید ساده رفته
        mods = _normalize_modifiers(held)
        if mods:
            sim.chord(_normalize_key(key), held=mods)
        else:
            sim.press(_normalize_key(key))
    elif kind == "chord":
        sim.chord(_normalize_key(key), held=_normalize_modifiers(held))
    elif kind == "type_text":
        _type_text(sim, text)
    # kind های دیگر ("wait") اینجا نمی‌رسند — در run_sequence هندل می‌شوند


def _build_step_targets(step: dict[str, Any], app_name: str) -> tuple[Any, Any]:
    """مرجع‌های ماوسی یک step: (target, target2) — selector بر مختصات مقدم است."""
    kind = step.get("kind", "")
    if kind not in TARGET_ACTIONS:
        return None, None
    target = _resolve_pointer_target(
        str(step.get("selector", "") or ""),
        app_name,
        step.get("x"),
        step.get("y"),
    )
    target2 = None
    if kind == "drag":
        target2 = _resolve_drag_end(
            str(step.get("selector2", "") or ""),
            app_name,
            step.get("x2"),
            step.get("y2"),
        )
    return target, target2


def run_sequence(steps: list[dict[str, Any]], app_name: str = "") -> dict[str, Any]:
    """اجرای چند اکشن پشت‌سرهم در یک فراخوانی (و یک پروسهٔ Rust).

    هر step یک dict با کلید ``kind`` است: click/double_click/right_click/
    move_to/drag/scroll/press_key/chord/type_text + ``wait`` (میلی‌ثانیه).
    stepهای ماوسی می‌توانند به‌جای ``x``/``y`` کلید ``selector`` (و برای drag
    ``selector2``) بدهند — xa11y خودش مرکز bounds عنصر را هدف می‌گیرد، پس این
    مسیر به مقیاس نمایشگر حساس نیست و همیشه درست‌ترین گزینه است.
    بین هر دو اکشن فاصلهٔ پیش‌فرض 150ms درج می‌شود تا UI فرصت واکنش داشته
    باشد؛ step خودش می‌تواند با ``gap_ms`` آن را برای همان step تغییر دهد.
    اگر stepی شکست بخورد، بقیه اجرا نمی‌شوند و index شکست برمی‌گردد.
    """
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    for i, step in enumerate(steps):
        kind = step.get("kind", "")
        if kind not in SEQUENCE_STEP_KINDS:
            return {
                "error": f"Unknown step kind {kind!r} at index {i} — use one of: "
                + ", ".join(sorted(SEQUENCE_STEP_KINDS))
            }
    try:
        # فعال‌سازی اپ هدف قبل از رویدادها — InputSim ورودی را به اپِ
        # فوکوس‌شدهٔ سیستم می‌فرستد؛ بدون این، کلیدها به اپ اشتباه
        # (مثلاً خودِ ایجنت) می‌روند.
        focus_warning = ""
        if app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            # فعال‌سازی ناهمگام است: تا واقعاً foreground نشده صبر کن، وگرنه
            # اولین کلیک روی پنجرهٔ اپ قبلی می‌نشیند.
            if not _wait_foreground(app_name):
                focus_warning = (
                    f"target app {app_name!r} did not become foreground within "
                    f"{ACTIVATE_TIMEOUT_S}s — input may have gone to another app"
                )
        sim = xa11y.input_sim()
        ran = 0
        for i, step in enumerate(steps):
            kind = step["kind"]
            if kind == "wait":
                time.sleep(max(0, step.get("ms", 0)) / 1000)
                # wait هم یک step اجراشده است؛ ran باید با failed_at هم‌واحد
                # بماند (آن index همهٔ stepها را می‌شمارد)
                ran += 1
                continue
            try:
                target, target2 = _build_step_targets(step, app_name)
                _sim_do(
                    sim,
                    kind,
                    target=target,
                    target2=target2,
                    key=step.get("key", ""),
                    held=step.get("held", ""),
                    text=step.get("text", ""),
                    dx=step.get("dx", 0),
                    dy=step.get("dy", 0),
                )
            except Exception as exc:  # noqa: BLE001
                return {
                    "ok": False,
                    "ran": ran,
                    "failed_at": i,
                    "error": _friendly_error(exc),
                }
            ran += 1
            gap = step.get("gap_ms", SEQUENCE_DEFAULT_GAP_MS)
            if gap > 0 and i < len(steps) - 1:
                time.sleep(gap / 1000)
        out: dict[str, Any] = {"ok": True, "ran": ran}
        if focus_warning:
            out["warning"] = focus_warning
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def open_app(app_name: str) -> dict[str, Any]:
    """فعال‌سازی (یا اجرای) اپ — مک: AppleScript؛ لینوکس: wmctrl؛
    ویندوز: os.startfile روی نام اپ.

    بر خلاف «فقط فرمان بده و برو»، تا foreground شدن واقعی اپ صبر می‌کند:
    فعال‌سازی ناهمگام است و اگر بلافاصله رویداد بفرستیم، کلیک/کلید به اپ
    قبلی می‌رود. ``foreground`` نتیجهٔ poll را گزارش می‌کند تا فراخواننده
    در صورت شکست هشدار بدهد.
    """
    if not app_name.strip():
        return {"error": "open_app needs an app name."}
    system = platform.system()
    canonical = _canonical_app_name(app_name)
    try:
        if system == "Darwin":
            # برای نام کوتاه chrome هم باید Google Chrome فعال شود — و برای هر اپ
            # case-insensitive (Finder/finder) هم پوشش داده شود
            try:
                subprocess.run(
                    ["osascript", "-e", f'tell application "{canonical}" to activate'],
                    check=True,
                    timeout=10,
                )
            except Exception:  # noqa: BLE001 — fallback به نام اصلی (مثلاً Finder با حروف کوچک)
                subprocess.run(
                    ["osascript", "-e", f'tell application "{app_name.strip()}" to activate'],
                    check=True,
                    timeout=10,
                )
        elif system == "Linux":
            # wmctrl فعال‌سازی پنجرهٔ اپ را می‌دهد؛ اگر نصب نبود خطا می‌دهد
            # برای chrome هم canonical را امتحان کن
            try:
                subprocess.run(
                    ["wmctrl", "-a", canonical],
                    check=True,
                    timeout=10,
                )
            except Exception:  # noqa: BLE001 — fallback به نام اصلی
                subprocess.run(
                    ["wmctrl", "-a", app_name],
                    check=True,
                    timeout=10,
                )
        else:  # Windows — startfile روی نام اپ یا مسیر اجرا
            import os

            os.startfile(app_name)  # راه استاندارد ویندوز
        out: dict[str, Any] = {"ok": True, "app": app_name}
        if _XA11Y_AVAILABLE:
            out["foreground"] = _wait_foreground(app_name)
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def _node_line(role: str, name: str, value: str, indent: int) -> str:
    """یک خط از درخت: role + name + value با فرمت یکنواخت.

    نام همیشه نقل‌قول‌دار چاپ می‌شود: نام‌های دارای فاصله («Save as») و نام‌های
    خالی بدون نقل‌قول با role بعدی اشتباه خوانده می‌شوند، و شکل نقل‌قول‌دار همان
    چیزی است که در selector هم باید نوشت (``button[name='OK']``).
    """
    line = f"{'  ' * indent}{role}"
    if name:
        line += f" {name!r}"
    if value:
        line += f" value={value!r}"
    return line


def _bounds_text(element) -> str:
    """bounds یک عنصر به شکل ``bounds=(x,y,w,h)`` — فضای logical point.

    رشتهٔ خالی یعنی عنصر bounds ندارد (گروه‌های مجازی/پنهان) — نه اینکه
    مختصاتش (0,0) است؛ این تمایز برای کلیک مهم است.
    """
    try:
        bounds = element.bounds
    except Exception:  # noqa: BLE001 — بعضی providerها روی گرهٔ root خطا می‌دهند
        return ""
    if bounds is None:
        return ""
    return f" bounds=({bounds.x},{bounds.y},{bounds.width},{bounds.height})"


def _render_element_tree(
    element,
    indent: int = 0,
    max_depth: int | None = None,
    budget: int = MAX_BOUNDED_TREE_NODES,
) -> tuple[list[str], int, bool]:
    """پیمایش lazy روی Element و serialize با bounds هر گره.

    برمی‌گرداند ``(lines, nodes_used, overflowed)``؛ اگر بودجهٔ گره تمام شود
    ``overflowed=True`` تا فراخواننده بداند خروجی ناقص است و به dump سریع
    xa11y برگردد.
    """
    role = getattr(element, "role", "") or ""
    name = getattr(element, "name", None) or ""
    value = getattr(element, "value", None) or ""
    lines = [_node_line(role, name, value, indent) + _bounds_text(element)]
    used = 1
    if max_depth is not None and indent >= max_depth:
        return lines, used, False
    try:
        children = element.children() or []
    except Exception:  # noqa: BLE001 — گرهٔ leaf/ناپایدار؛ بقیهٔ درخت مهم است
        children = []
    for child in children:
        if used >= budget:
            return lines, used, True
        sub_lines, sub_used, overflowed = _render_element_tree(
            child, indent + 1, max_depth, budget
        )
        lines.extend(sub_lines)
        used += sub_used
        if overflowed:
            return lines, used, True
    return lines, used, False


def _dump_with_bounds(root, max_depth: int | None) -> tuple[str, bool]:
    """متن indented درخت همراه با bounds هر خط، و fallback به snapshot سریع.

    دلیل وجود: ``tree()``/``dump()`` در xa11y فقط role/name/value می‌دهند، پس
    مدل هیچ مرجع هندسی نداشت و مجبور بود مکان کلیک را از پیکسل‌های
    اسکرین‌شات حدس بزند — همان‌جا که مقیاس رتینا و downscale خطا می‌سازد.
    ``root`` یک ``Element`` است (اپ: ``app.as_element()``).
    """
    lines, _used, overflowed = _render_element_tree(root, max_depth=max_depth)
    if overflowed:
        return root.dump(max_depth=max_depth), False
    return "\n".join(lines), True


def read_element(selector: str, app_name: str = "", max_depth: int = 6) -> dict[str, Any]:
    """فقط زیردرخت عنصر تطبیق‌یافته — نه کل صفحه. ارزان در توکن، دقیق."""
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        app = _resolve_app(app_name)
        loc = app.locator(selector)
        rendered, has_bounds = _dump_with_bounds(loc.element(), max_depth)
        truncated = len(rendered) > MAX_DUMP_CHARS
        result: dict[str, Any] = {
            "app": app.name,
            "selector": selector,
            "tree": rendered[:MAX_DUMP_CHARS],
            "truncated": truncated,
            "bounds_in_tree": has_bounds,
        }
        # مرکز خود عنصر + centers فرزندان تعاملی — همان فضای logical point
        # که input در آن کلیک می‌کند
        try:
            center = _center_of(loc.element())
            if center:
                result["center"] = f"({center[0]},{center[1]})"
        except Exception:  # noqa: BLE001, S110 — توصیف best-effort است
            pass
        targets, capped = _actionable_targets(app, scope_selector=selector)
        if targets:
            result["targets"] = targets
            result["targets_truncated"] = capped
            result["targets_hint"] = (
                "centers are LOGICAL screen points — the same space `input` "
                "clicks in. Prefer action='act' with these selectors."
            )
        return result
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def screenshot_to_data_uri(png: bytes) -> str:
    """base64 → data:image/png;base64,... برای llm_generate."""
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _downscale_png(png: bytes) -> tuple[bytes, float]:
    """اگر عرض تصویر > MAX_IMAGE_WIDTH بود با Pillow کوچک شود.

    علاوه بر بایت‌ها، ``ratio`` ارسالی را هم برمی‌گرداند (۱.۰ یعنی دست‌نخورده)
    تا فراخواننده بتواند مختصات پیکسلیِ روی تصویری که مدل واقعاً دیده را به
    فضای منطقیِ کلیک تبدیل کند.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover — Pillow وابستگی موجود است
        return png, 1.0
    try:
        img = Image.open(io.BytesIO(png))
    except Exception:  # noqa: BLE001 — PNG نامعتبر: دست نزنیم، همان برگردد
        return png, 1.0
    if img.width <= MAX_IMAGE_WIDTH:
        return png, 1.0
    ratio = MAX_IMAGE_WIDTH / img.width
    img = img.resize(
        (MAX_IMAGE_WIDTH, int(img.height * ratio)), Image.LANCZOS
    )
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue(), ratio


def _normalize_region(region: Any) -> tuple[int, int, int, int]:
    """اعتبارسنجی ناحیهٔ اسکرین‌شات به ``(x, y, width, height)`` منطقی.

    از لایهٔ ابزار JSON یک لیست می‌آید و xa11y یک tuple چهارتایی عددی
    می‌خواهد؛ طول/عرض منفی یا عضو غیرعددی باید همین‌جا خطای خوانا بدهد،
    نه داخل پل Rust با پیام مبهم.
    """
    parts = list(region) if isinstance(region, (list, tuple)) else []
    if len(parts) != 4:
        raise ValueError(
            "region must be (x, y, width, height) in LOGICAL screen points — "
            "the same space as element bounds."
        )
    try:
        x, y, width, height = (int(float(p)) for p in parts)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"region members must be numbers, got {region!r}"
        ) from exc
    if width <= 0 or height <= 0:
        raise ValueError(
            f"region needs positive width/height, got ({x},{y},{width},{height})"
        )
    return (x, y, width, height)


def capture_screenshot(
    app_name: str = "",
    selector: str = "",
    region: tuple[int, int, int, int] | None = None,
    annotate: bool = False,
) -> dict[str, Any]:
    """اسکرین‌شات از صفحه/عنصر/ناحیه — PNG bytes به data URI برای مدل بینایی.

    ``selector`` از یک عنصر، ``region`` از یک مستطیل، ``app`` تنها از پنجرهٔ
    همان اپ، و هیچ‌کدام از کل صفحه عکس می‌گیرد. ``region`` چهارتایی ``(x, y, width, height)`` در فضای
    **logical point** است — همان فضایی که bounds عناصر و مختصات ``input`` در
    آن‌اند، پس می‌توان مستقیماً bounds یک عنصر را اینجا گذاشت. دادن همزمان
    ``selector`` و ``region`` خطا است (xa11y هم همین را می‌گوید).

    ``annotate=True`` کادرهای شماره‌دار روی عناصر تطبیق‌یافتهٔ selector
    می‌کشد + legend متنی (selector دقیق هر کادر) — پل بین دید پیکسلی و
    درخت AX. روی مک به پرمیشن Screen Recording نیاز دارد.

    فضای مختصات: xa11y ``Rect``/``InputSim`` در **نقطهٔ منطقی** (logical point)
    کار می‌کنند، ولی ``shot.width`` **پیکسل فیزیکی** است (روی رتینا ۲×) و
    تصویر ارسالی به مدل ممکن است بیشتر downscale شده باشد. پس هر سه عدد
    گزارش می‌شود تا تبدیل، حدسی باقی نماند::

        logical = pixel_in_sent_image / image_scale

    که ``image_scale = physical_width / scale / image_width``.
    """
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        kwargs: dict[str, Any] = {}
        if selector and region:
            return {
                "error": "see takes either selector or region, not both — "
                "capture the element, or pass its bounds as region."
            }
        if selector:
            app = _resolve_app(app_name)
            kwargs["element"] = app.locator(selector).element()
        elif region:
            kwargs["region"] = _normalize_region(region)
        elif app_name.strip():
            app = _resolve_app(app_name)
            element = None
            for sel in ("window", "dialog", "window:nth(1)"):
                try:
                    cand = app.locator(sel).element()
                    if cand is not None:
                        element = cand
                        break
                except Exception:  # noqa: BLE001, S112 — این selector روی این اپ نیست
                    continue
            if element is None:
                try:  # آخرین تلاش: خود اپ به‌عنوان عنصر (برخی اپ‌ها bounds روی application دارند)
                    cand = app.as_element()
                    b = getattr(cand, "bounds", None)
                    if b is not None and getattr(b, "width", 0) > 0 and getattr(b, "height", 0) > 0:
                        element = cand
                except Exception:  # noqa: BLE001, S110 — as_element bounds ندارد
                    pass
            if element is not None:
                kwargs["element"] = element
        if annotate:
            app = _resolve_app(app_name)
            # annotate به Locator scoped به اپ نیاز دارد (نه selector ریشه‌ای)
            # قبلاً فقط button/text_field annotate می‌شد؛ بقیهٔ نقش‌های
            # تعاملی (چک‌باکس، رادیو، کمبو، منو، تب، اسلایدر، لیست‌آیتم،
            # لینک) بدون کادر می‌ماندند و مدل مجبور بود پیکسل حدس بزند —
            # همان چیزی که کلیک را نادقیق می‌کرد. حالا از همان لیست مشترک
            # INTERACTIVE_ROLES استفاده می‌شود.
            kwargs["annotate"] = [app.locator(role) for role in INTERACTIVE_ROLES]
        shot = xa11y.screenshot(**kwargs)
        png, downscale = _downscale_png(shot.to_png())
        # مقیاس نمایشگر (فیزیکی/منطقی). اگر xa11y نسخهٔ بدون scale داد، ۱ فرض کن.
        display_scale = float(getattr(shot, "scale", 1.0) or 1.0)
        physical_w = shot.width
        physical_h = shot.height
        logical_w = physical_w / display_scale
        logical_h = physical_h / display_scale
        sent_w = round(physical_w * downscale)
        sent_h = round(physical_h * downscale)
        # مبدأ تصویر نسبت به کل صفحه. برای capture بریده‌شده (عنصر/ناحیه)
        # مختصاتِ روی تصویر نسبی به همان برش است؛ بدون مبدأ، کلیک
        # ``origin`` واحد جابه‌جا می‌نشیند.
        origin_x, origin_y = 0, 0
        if "element" in kwargs:
            origin = _bounds_origin(kwargs["element"])
            if origin:
                origin_x, origin_y = origin
        elif region:
            origin_x, origin_y = kwargs["region"][0], kwargs["region"][1]
        result: dict[str, Any] = {
            "ok": True,
            # ابعاد تصویرِ واقعاً ارسالی به مدل — هر مختصاتی که مدل از روی
            # این تصویر می‌خواند در همین فضا است
            "image_width": sent_w,
            "image_height": sent_h,
            # پیکسل فیزیکی اسکرین‌شات خام و نسبت فیزیکی/منطقی نمایشگر
            "physical_width": physical_w,
            "physical_height": physical_h,
            "display_scale": display_scale,
            # فضای مختصاتی که input/click در آن اجرا می‌شود
            "logical_width": round(logical_w),
            "logical_height": round(logical_h),
            # ضریب تبدیل: pixel_in_sent_image / image_scale = logical point
            # دو محور جدا تا رندِ ارتفاع خطای عمودی نسازد
            "image_scale": round(sent_w / logical_w, 6) if logical_w else 1.0,
            "image_scale_x": round(sent_w / logical_w, 6) if logical_w else 1.0,
            "image_scale_y": round(sent_h / logical_h, 6) if logical_h else 1.0,
            # مبدأ نسبت به کل صفحه — برای تبدیل مختصات تصویرِ بریده‌شده
            "origin_x": origin_x,
            "origin_y": origin_y,
            "data_uri": screenshot_to_data_uri(png),
        }
        if annotate and getattr(shot, "legend", None):
            legend_lines = []
            for entry in shot.legend:
                entry_bounds = getattr(entry, "bounds", None)
                bounds_txt = ""
                if entry_bounds is not None:
                    center = _center_of(entry) or (0, 0)
                    bounds_txt = (
                        f" bounds=({entry_bounds.x},{entry_bounds.y},"
                        f"{entry_bounds.width},{entry_bounds.height})"
                        f" center=({center[0]},{center[1]})"
                    )
                legend_lines.append(
                    f"{getattr(entry, 'tag', '')}: "
                    f"{getattr(entry, 'selector', '')}"
                    f" [{getattr(entry, 'role', '')}]"
                    f"{bounds_txt}"
                )
            result["legend"] = legend_lines[:100]
            # عناصری که کادر نخوردند تا مدل فکر نکند وجود ندارند
            omitted = getattr(shot, "omitted", None) or []
            if omitted:
                result["omitted"] = [
                    f"{getattr(o, 'selector', '')} ({getattr(o, 'reason', '')})"
                    for o in omitted[:20]
                ]
        result["hint"] = (
            "Prefer acting by selector from the legend/tree — never by pixel "
            "guess. If you must click coordinates, they are LOGICAL screen "
            "points: (origin_x + pixel_x / image_scale_x, origin_y + pixel_y / "
            "image_scale_y). The tool also auto-converts image pixels from the "
            "last `see` — you may pass raw pixel numbers and they will be mapped."
        )
        return result
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def input_action(
    kind: str,
    x: int | None = None,
    y: int | None = None,
    x2: int | None = None,
    y2: int | None = None,
    key: str = "",
    held: str = "",
    text: str = "",
    dx: int = 0,
    dy: int = 0,
    app_name: str = "",
    selector: str = "",
    selector2: str = "",
) -> dict[str, Any]:
    """fallback مختصاتی با InputSim — فقط وقتی اکشن معنایی ممکن نیست.

    ``kind`` یکی از ``INPUT_ACTIONS`` است. برای اکشن‌های ماوسی ``selector``
    مقدم بر ``x``/``y`` است: با selector خودِ xa11y مرکز bounds عنصر را هدف
    می‌گیرد و هیچ تبدیل مقیاسی لازم نیست (``drag`` مقصد را از ``selector2``
    یا ``x2``/``y2`` می‌گیرد). مختصات‌ها در فضای **logical point** هستند —
    همان فضای bounds عناصر، نه پیکسل فیزیکی اسکرین‌شات. اگر ``app_name`` داده
    شود، اپ هدف قبل از رویدادها فعال و منتظر foreground شدن می‌ماند.
    """
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    if kind not in INPUT_ACTIONS:
        return {
            "error": f"Unknown input kind {kind!r} — use one of: "
            + ", ".join(sorted(INPUT_ACTIONS))
        }
    try:
        # فعال‌سازی اپ هدف قبل از رویدادها — همان ریشه‌ی run_sequence
        warning = ""
        if app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            if not activated.get("foreground", True):
                warning = (
                    f"target app {app_name!r} did not become foreground within "
                    f"{ACTIVATE_TIMEOUT_S}s — input may have gone to another app"
                )
        target, target2 = _build_step_targets(
            {"kind": kind, "selector": selector, "selector2": selector2,
             "x": x, "y": y, "x2": x2, "y2": y2},
            app_name,
        )
        sim = xa11y.input_sim()
        _sim_do(
            sim, kind, target=target, target2=target2, key=key, held=held,
            text=text, dx=dx, dy=dy,
        )
        out: dict[str, Any] = {"ok": True, "input": kind}
        if isinstance(target, tuple):
            out["at"] = target
        if warning:
            out["warning"] = warning
        return out
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}
