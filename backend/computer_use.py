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

# فاصلهٔ پیش‌فرض بین دو step در sequence (میلی‌ثانیه) — فرصت واکنش UI
SEQUENCE_DEFAULT_GAP_MS = 150

# حداکثر عرض تصویر (پیکسل فیزیکی) قبل از downscale برای کنترل توکن
MAX_IMAGE_WIDTH = 1600

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
        "Security → Accessibility → enable this app (the Electron app, not the "
        "terminal). Screen Recording is NOT needed for the tree, only for "
        "screenshots."
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
    mapping = {
        "PermissionDeniedError": _ACCESS_NOTES.get(platform.system(), ""),
        "SelectorNotMatchedError": (
            "No element matched the selector — read the tree first "
            "(action=read_screen) and check the selector syntax."
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
    out = f"{name}: {exc}"
    if hint:
        out += f" — {hint}"
    # کلیدهای ترکیبی با نام اشتباه (command+t، cmd+n، ctrl، …) — راهنمای فرمت درست
    if isinstance(exc, ValueError) and "unknown key name" in str(exc).lower():
        out += (
            " — key names are lowercase single keys ('enter', 'tab', 'a'); for "
            "combos use chord with held modifiers, e.g. press_key 't' after "
            "chord 't' with held='Meta', or one step kind='chord' key='t' "
            "held='Meta'. Valid modifiers: Meta, Control, Alt, Shift."
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
        return xa11y.App.by_name(app_name.strip(), timeout=3.0)
    return xa11y.App.foreground(timeout=3.0)


def read_screen(app_name: str = "", max_depth: int = DEFAULT_MAX_DEPTH) -> dict[str, Any]:
    """درخت Accessibility اپ هدف (با نام، یا پیش‌فرض اپ فعال) به‌صورت متن فشرده."""
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        app = _resolve_app(app_name)
        dump = app.dump(max_depth=max_depth)
        truncated = len(dump) > MAX_DUMP_CHARS
        result: dict[str, Any] = {
            "app": app.name,
            "tree": dump[:MAX_DUMP_CHARS],
            "truncated": truncated,
        }
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
    if action not in ELEMENT_ACTIONS:
        return {
            "error": f"Unknown action {action!r} — use one of: "
            + ", ".join(sorted(ELEMENT_ACTIONS))
        }
    try:
        # type_text رویداد کیبورد سنتز می‌کند و به اپِ فوکوس‌شدهٔ سیستم
        # می‌رود — مثل InputSim. بدون فعال‌سازی اپ هدف، متن به اپ اشتباه
        # (مثلاً خودِ ایجنت) تایپ می‌شود.
        if action == "type_text" and app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            time.sleep(0.3)
        app = _resolve_app(app_name)
        loc = app.locator(selector)
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
        # نام/role عنصر برای نمایش به کاربر — بعد از اکشن دوباره resolve می‌شود
        try:
            el = loc.element()
            target = f"{el.role} '{el.name or ''}'".strip()
        except Exception:  # noqa: BLE001 — اکشن موفق بود؛ توصیف عنصر best-effort است
            target = selector
        return {"ok": True, "app": app.name, "action": action, "target": target}
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


def _sim_do(sim, kind: str, **kw: Any) -> None:
    """اجرای یک اکشن InputSim — mapping مشترک برای input_action و sequence."""
    if kind == "click":
        sim.click((kw["x"], kw["y"]))
    elif kind == "double_click":
        sim.double_click((kw["x"], kw["y"]))
    elif kind == "right_click":
        sim.right_click((kw["x"], kw["y"]))
    elif kind == "move_to":
        sim.move_to((kw["x"], kw["y"]))
    elif kind == "drag":
        sim.drag((kw["x"], kw["y"]), (kw["x2"], kw["y2"]))
    elif kind == "scroll":
        sim.scroll((kw["x"], kw["y"]), dx=kw.get("dx", 0), dy=kw.get("dy", 0))
    elif kind == "press_key":
        sim.press(kw["key"])
    elif kind == "chord":
        sim.chord(kw["key"], held=[h for h in kw.get("held", "").split(",") if h.strip()])
    elif kind == "type_text":
        _type_text(sim, kw.get("text", ""))
    # kind های دیگر ("wait") اینجا نمی‌رسند — در run_sequence هندل می‌شوند


def run_sequence(steps: list[dict[str, Any]], app_name: str = "") -> dict[str, Any]:
    """اجرای چند اکشن پشت‌سرهم در یک فراخوانی (و یک پروسهٔ Rust).

    هر step یک dict با کلید ``kind`` است: click/double_click/right_click/
    move_to/drag/scroll/press_key/chord/type_text + ``wait`` (میلی‌ثانیه).
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
        if app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            time.sleep(0.3)  # فرصت برای جلو آمدن پنجره قبل از اولین رویداد
        sim = xa11y.input_sim()
        ran = 0
        for i, step in enumerate(steps):
            kind = step["kind"]
            if kind == "wait":
                time.sleep(max(0, step.get("ms", 0)) / 1000)
                continue
            try:
                _sim_do(
                    sim,
                    kind,
                    x=step.get("x", 0),
                    y=step.get("y", 0),
                    x2=step.get("x2", 0),
                    y2=step.get("y2", 0),
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
        return {"ok": True, "ran": ran}
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def open_app(app_name: str) -> dict[str, Any]:
    """فعال‌سازی (یا اجرای) اپ — مک: AppleScript؛ لینوکس: wmctrl؛
    ویندوز: os.startfile روی نام اپ."""
    if not app_name.strip():
        return {"error": "open_app needs an app name."}
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(
                ["osascript", "-e", f'tell application "{app_name}" to activate'],
                check=True,
                timeout=10,
            )
        elif system == "Linux":
            # wmctrl فعال‌سازی پنجرهٔ اپ را می‌دهد؛ اگر نصب نبود خطا می‌دهد
            subprocess.run(
                ["wmctrl", "-a", app_name],
                check=True,
                timeout=10,
            )
        else:  # Windows — startfile روی نام اپ یا مسیر اجرا
            import os

            os.startfile(app_name)  # راه استاندارد ویندوز
        return {"ok": True, "app": app_name}
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def _render_tree(node: dict, indent: int = 0) -> list[str]:
    """serialize درخت dict خروجی Locator.tree() به همان فرمت indented dump."""
    lines: list[str] = []
    pad = "  " * indent
    role = node.get("role", "")
    name = node.get("name") or ""
    value = node.get("value") or ""
    line = f"{pad}{role}"
    if name:
        line += f" {name!r}" if not name.isascii() or " " in name else f" {name}"
    if value:
        line += f" value={value!r}"
    lines.append(line)
    for child in node.get("children") or []:
        lines.extend(_render_tree(child, indent + 1))
    return lines


def read_element(selector: str, app_name: str = "", max_depth: int = 6) -> dict[str, Any]:
    """فقط زیردرخت عنصر تطبیق‌یافته — نه کل صفحه. ارزان در توکن، دقیق."""
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        app = _resolve_app(app_name)
        tree = app.locator(selector).tree(max_depth=max_depth)
        rendered = "\n".join(_render_tree(tree))
        truncated = len(rendered) > MAX_DUMP_CHARS
        return {
            "app": app.name,
            "selector": selector,
            "tree": rendered[:MAX_DUMP_CHARS],
            "truncated": truncated,
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def screenshot_to_data_uri(png: bytes) -> str:
    """base64 → data:image/png;base64,... برای llm_generate."""
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _downscale_png(png: bytes) -> bytes:
    """اگر عرض تصویر > MAX_IMAGE_WIDTH بود با Pillow به نصف downscale شود."""
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover — Pillow وابستگی موجود است
        return png
    try:
        img = Image.open(io.BytesIO(png))
    except Exception:  # noqa: BLE001 — PNG نامعتبر: دست نزنیم، همان برگردد
        return png
    if img.width <= MAX_IMAGE_WIDTH:
        return png
    ratio = MAX_IMAGE_WIDTH / img.width
    img = img.resize(
        (MAX_IMAGE_WIDTH, int(img.height * ratio)), Image.LANCZOS
    )
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def capture_screenshot(
    app_name: str = "",
    selector: str = "",
    region: tuple[int, int, int, int] | None = None,
    annotate: bool = False,
) -> dict[str, Any]:
    """اسکرین‌شات از صفحه/عنصر/ناحیه — PNG bytes به data URI برای مدل بینایی.

    ``annotate=True`` کادرهای شماره‌دار روی عناصر تطبیق‌یافتهٔ selector
    می‌کشد + legend متنی (selector دقیق هر کادر) — پل بین دید پیکسلی و
    درخت AX. روی مک به پرمیشن Screen Recording نیاز دارد.
    """
    if not _XA11Y_AVAILABLE:
        return {"error": "xa11y is not installed."}
    try:
        kwargs: dict[str, Any] = {}
        element = None
        if selector:
            app = _resolve_app(app_name)
            element = app.locator(selector).element()
            kwargs["element"] = element
        elif region:
            kwargs["region"] = region
        if annotate:
            app = _resolve_app(app_name)
            # annotate به Locator scoped به اپ نیاز دارد (نه selector ریشه‌ای)
            kwargs["annotate"] = [app.locator("button"), app.locator("text_field")]
        shot = xa11y.screenshot(**kwargs)
        png = _downscale_png(shot.to_png())
        result: dict[str, Any] = {
            "ok": True,
            "width": shot.width,
            "height": shot.height,
            "data_uri": screenshot_to_data_uri(png),
        }
        if annotate and getattr(shot, "legend", None):
            legend_lines = []
            for entry in shot.legend:
                legend_lines.append(
                    f"{getattr(entry, 'tag', '')}{getattr(entry, 'index', '')}: "
                    f"{getattr(entry, 'selector', '')}"
                )
            result["legend"] = legend_lines[:100]
        return result
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}


def input_action(
    kind: str,
    x: int = 0,
    y: int = 0,
    x2: int = 0,
    y2: int = 0,
    key: str = "",
    held: str = "",
    text: str = "",
    dx: int = 0,
    dy: int = 0,
    app_name: str = "",
) -> dict[str, Any]:
    """fallback مختصاتی با InputSim — فقط وقتی اکشن معنایی ممکن نیست.

    ``kind`` یکی از ``INPUT_ACTIONS`` است. مختصات‌ها در فضای logical screen
    هستند (همان فضای bounds عناصر در درخت). اگر ``app_name`` داده شود،
    اپ هدف قبل از رویدادها فعال می‌شود تا ورودی به اپ اشتباه نرود.
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
        if app_name.strip():
            activated = open_app(app_name)
            if "error" in activated:
                return activated
            time.sleep(0.3)
        sim = xa11y.input_sim()
        _sim_do(
            sim, kind, x=x, y=y, x2=x2, y2=y2, key=key, held=held, text=text,
            dx=dx, dy=dy,
        )
        return {"ok": True, "input": kind}
    except Exception as exc:  # noqa: BLE001
        return {"error": _friendly_error(exc)}
