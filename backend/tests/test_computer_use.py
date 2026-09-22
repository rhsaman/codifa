"""تست‌های ماژول computer_use و ابزار computer — کاملاً با mock xa11y.

CI دسترسی به UI واقعی ندارد؛ همهٔ فراخوانی‌های xa11y با monkeypatch
جایگزین می‌شوند تا فقط منطق لایهٔ خودمان تست شود.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import types
from typing import Any, ClassVar

import pytest

import computer_use as cu

# ---------------------------------------------------------------------------
# ابزارهای ساخت mock xa11y
# ---------------------------------------------------------------------------


class _FakeRect:
    """Rect ساختگی — مختصات logical screen، همان شکل واقعی xa11y."""

    def __init__(self, x: int, y: int, width: int, height: int):
        self.x = x
        self.y = y
        self.width = width
        self.height = height


class _FakeElement:
    """Element ساختگی — با children lazy و bounds، همان شکل واقعی xa11y."""

    def __init__(
        self,
        role: str,
        name: str | None = None,
        bounds: _FakeRect | None = None,
        children: list[_FakeElement] | None = None,
        value: str | None = None,
    ):
        self.role = role
        self.name = name
        self.bounds = bounds
        self.value = value
        self._children = children or []

    def children(self) -> list[_FakeElement]:
        return list(self._children)

    def dump(self, max_depth: int | None = None) -> str:
        # مسیر fallback (درخت بیش از بودجه): xa11y خودش بدون bounds رندر می‌کند
        return f"{self.role} {self.name or ''}".strip()


class _FakeLocator:
    """Locator ساختگی — اکشن‌های اجراشده را ثبت می‌کند."""

    def __init__(self, selector: str, elements: list[_FakeElement]):
        self.selector = selector
        self._elements = elements
        self.calls: list[tuple[str, Any]] = []

    def element(self) -> _FakeElement:
        if not self._elements:
            raise RuntimeError("no element")
        return self._elements[0]

    def elements(self) -> list[_FakeElement]:
        return list(self._elements)

    def __getattr__(self, name: str):
        # اکشن‌های بدون آرگومان (press, focus, toggle, ...)
        def _no_arg(*_args: Any, **_kwargs: Any):
            self.calls.append((name, None))

        return _no_arg


class _FakeApp:
    def __init__(self, name: str, elements: list[_FakeElement] | None = None):
        self.name = name
        self._elements = elements or []
        self.is_foreground = True

    def dump(self, max_depth: int | None = None) -> str:
        return "window 'Main'\n  button 'OK'\n  text_field 'Search'"

    def as_element(self) -> _FakeElement:
        # اپ ریشهٔ درخت است و عناصرش فرزند مستقیمش (پنجره‌ها در xa11y همین‌جا
        # می‌آیند) — read_screen از این مسیر با bounds هر گره رندر می‌کند
        return _FakeElement("application", self.name, children=list(self._elements))

    def locator(self, selector: str) -> _FakeLocator:
        # فیلتر سبک‌وزن روی roleِ آخرین جزء ترکیب: «button[name=...]» و
        # «group >> button» هر دو به عناصر هم‌نقش می‌رسند — تا
        # _actionable_targets (که selector با پیشوند scope می‌سازد) در
        # تست‌ها رفتار واقعی داشته باشد.
        last = selector.strip().split(">>")[-1].strip()
        role = last.split("[", 1)[0].split(" ", 1)[0]
        matched = [e for e in self._elements if not role or e.role == role]
        return _FakeLocator(selector, matched)


class _FakeSim:
    """InputSim ساختگی — کلیک‌ها را ثبت می‌کند."""

    def __init__(self):
        self.clicks: list[Any] = []
        self.calls: list[tuple[str, Any]] = []

    def click(self, target):
        self.clicks.append(target)
        self.calls.append(("click", target))

    def double_click(self, target):
        self.calls.append(("double_click", target))

    def right_click(self, target):
        self.calls.append(("right_click", target))

    def move_to(self, target):
        self.calls.append(("move_to", target))

    def drag(self, a, b):
        self.calls.append(("drag", (a, b)))

    def scroll(self, target, dx=0, dy=0):
        self.calls.append(("scroll", (target, dx, dy)))

    def press(self, key):
        self.calls.append(("press", key))

    def chord(self, key, held=None):
        self.calls.append(("chord", (key, held)))

    def type_text(self, text):
        self.calls.append(("type_text", text))


def _make_xa11y(
    *,
    apps: list[_FakeApp] | None = None,
    foreground_error: Exception | None = None,
):
    """ساخت یک ماژول xa11y ساختگی با همان شکل واقعی."""
    apps = apps if apps is not None else [_FakeApp("Notes")]

    class _App:
        @staticmethod
        def foreground(*, timeout: float = 0.0) -> _FakeApp:
            if foreground_error is not None:
                raise foreground_error
            return apps[0]

        @staticmethod
        def by_name(name: str, *, timeout: float = 0.0) -> _FakeApp:
            for a in apps:
                if a.name == name:
                    return a
            raise RuntimeError(f"app not found: {name}")

        @staticmethod
        def list() -> list[_FakeApp]:
            return apps

    mod = types.ModuleType("xa11y")
    mod.App = _App  # type: ignore[attr-defined]
    return mod


# ---------------------------------------------------------------------------
# تست‌های computer_use (لایهٔ نازک)
# ---------------------------------------------------------------------------


def test_check_access_ok(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.check_access()
    assert result["ok"] is True
    assert result["foreground_app"] == "Notes"


def test_check_access_denied_hint(monkeypatch: pytest.MonkeyPatch):
    err = type("PermissionDeniedError", (Exception,), {})("access denied")
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(foreground_error=err), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.check_access()
    assert result["ok"] is False
    # پیام راهنمای پرمیشن باید در خروجی باشد
    assert "Accessibility" in result["note"] or result["platform"] != "Darwin"


def test_read_screen_named_app(monkeypatch: pytest.MonkeyPatch):
    ok = _FakeElement("button", "OK", _FakeRect(100, 200, 80, 24))
    apps = [_FakeApp("Notes"), _FakeApp("Safari", elements=[ok])]
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=apps), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Safari")
    assert result["app"] == "Safari"
    assert "button 'OK'" in result["tree"]


def test_read_screen_prints_bounds_on_every_line(monkeypatch: pytest.MonkeyPatch):
    """هر خط درخت باید bounds خودش را داشته باشد — مرجع مختصاتی بدون حدس پیکسل.

    ریشه‌ی سوم «کلیک دور از هدف»: dump xa11y فقط role/name/value می‌دهد، پس
    مدل هیچ نقطهٔ مرجعی نداشت و مجبور بود مکان را از روی اسکرین‌شات حدس بزند
    (که با مقیاس رتینا و downscale خراب می‌شود)."""
    ok = _FakeElement("button", "OK", _FakeRect(100, 200, 80, 24))
    win = _FakeElement("window", "Main", _FakeRect(0, 0, 800, 600), children=[ok])
    app = _FakeApp("Notes", elements=[win])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Notes")
    assert result["bounds_in_tree"] is True
    lines = result["tree"].splitlines()
    assert "window 'Main' bounds=(0,0,800,600)" in lines[1]
    # فرزند تورفته است و bounds خودش را دارد
    assert lines[2].startswith("  ")
    assert "button 'OK' bounds=(100,200,80,24)" in lines[2]


def test_tree_without_bounds_is_marked_not_assumed_zero(
    monkeypatch: pytest.MonkeyPatch,
):
    """عنصر بی‌bounds باید بدون suffix چاپ شود، نه bounds=(0,0).

    اگر صفر پیش‌فرض بگیریم، مدل فکر می‌کند عنصر در گوشهٔ صفحه است و همان‌جا
    کلیک می‌کند."""
    ghost = _FakeElement("group", "Ghost")
    app = _FakeApp("Notes", elements=[ghost])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Notes")
    assert "group 'Ghost'" in result["tree"]
    assert "bounds=(0,0" not in result["tree"]


def test_dump_with_bounds_falls_back_over_budget(monkeypatch: pytest.MonkeyPatch):
    """درخت خیلی بزرگ: به dump سریع xa11y برمی‌گردیم و flag می‌زند.

    پیمایش lazy برای هر گره چند فراخوانی native دارد؛ بدون سقف، read_screen
    روی IDE/مرورگر چند ثانیه طول می‌کشید."""
    kids = [_FakeElement("button", f"b{i}") for i in range(cu.MAX_BOUNDED_TREE_NODES + 5)]
    root = _FakeElement("application", "Big", children=kids)
    root.dump = lambda max_depth=None: "FAST DUMP"  # type: ignore[method-assign]
    app = _FakeApp("Big")
    app.as_element = lambda: root  # type: ignore[method-assign]
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Big")
    assert result["tree"] == "FAST DUMP"
    assert result["bounds_in_tree"] is False


def test_read_screen_foreground_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen()
    assert result["app"] == "Notes"


def test_read_screen_truncates_large_dump(monkeypatch: pytest.MonkeyPatch):
    """درخت بلندتر از سقف کاراکتر باید برش بخورد و truncated بزند."""
    wide = cu.MAX_DUMP_CHARS // 40
    kids = [_FakeElement("group", "x" * wide) for _ in range(60)]
    app = _FakeApp("Big", elements=kids)
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Big")
    assert result["truncated"] is True
    assert len(result["tree"]) == cu.MAX_DUMP_CHARS


def test_find_and_act_unknown_action(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.find_and_act(selector="button", action="explode")
    assert "error" in result


def test_find_and_act_press_and_element_name(monkeypatch: pytest.MonkeyPatch):
    ok_button = _FakeElement("button", "OK")
    app = _FakeApp("Notes", elements=[ok_button])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.find_and_act(selector="button[name='OK']", action="press")
    assert result["ok"] is True
    assert result["target"] == "button 'OK'"


def test_find_and_act_set_value(monkeypatch: pytest.MonkeyPatch):
    field = _FakeElement("textfield", "Search")
    app = _FakeApp("Notes", elements=[field])

    captured: dict[str, Any] = {}

    class _SetLocator(_FakeLocator):
        def set_value(self, value: str):
            captured["value"] = value
            self.calls.append(("set_value", value))

        def type_text(self, text: str):
            captured["text"] = text
            self.calls.append(("type_text", text))

    app.locator = lambda sel: _SetLocator(sel, [field])  # type: ignore[method-assign]
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.find_and_act(selector="textfield", action="set_value", value="سلام")
    assert result["ok"] is True
    assert captured["value"] == "سلام"


def test_input_action_click(monkeypatch: pytest.MonkeyPatch):
    clicks: list[Any] = []

    class _Sim:
        def click(self, target):
            clicks.append(target)

    mod = _make_xa11y()
    mod.input_sim = lambda: _Sim()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.input_action(kind="click", x=10, y=20)
    assert result["ok"] is True
    assert clicks == [(10, 20)]
    # نقطهٔ کلیک گزارش شود تا مدل بداند کجا نشست
    assert result["at"] == (10, 20)


def test_input_action_click_by_selector_uses_element(
    monkeypatch: pytest.MonkeyPatch,
):
    """با selector باید خودِ Element به InputSim برود، نه مختصات.

    ریشه‌ی اصلی «کلیک در جای اشتباه»: هر تبدیل مختصاتی (پیکسل فیزیکی،
    downscale، رتینا) منبع خطاست. xa11y روی Element خودش مرکز bounds را
    انتخاب می‌کند، پس این مسیر اصلاً مختصاتی ندارد."""
    clicks: list[Any] = []

    class _Sim:
        def click(self, target):
            clicks.append(target)

    btn = _FakeElement("button", "OK", _FakeRect(100, 200, 80, 24))
    app = _FakeApp("Notes", elements=[btn])
    mod = _make_xa11y(apps=[app])
    mod.input_sim = lambda: _Sim()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.input_action("click", selector="button[name='OK']")
    assert result["ok"] is True
    assert clicks == [btn]
    # مختصات گزارش نمی‌شود چون هدف عنصر بود
    assert "at" not in result


def test_input_action_selector_scrolls_into_view_first(
    monkeypatch: pytest.MonkeyPatch,
):
    """عنصر بیرون viewport bounds نامعتبر دارد؛ باید اول اسکرول شود."""
    btn = _FakeElement("button", "OK", _FakeRect(1, 2, 3, 4))
    app = _FakeApp("Notes", elements=[btn])
    loc = _FakeLocator("button", [btn])
    app.locator = lambda sel: loc  # type: ignore[method-assign]
    mod = _make_xa11y(apps=[app])
    mod.input_sim = lambda: _FakeSim()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.input_action("click", selector="button")
    assert result["ok"] is True
    assert ("scroll_into_view", None) in loc.calls


def test_input_action_missing_coords_is_an_error(monkeypatch: pytest.MonkeyPatch):
    """مختصات غایب نباید بی‌صدا (0,0) شود — کلیک روی گوشهٔ صفحه.

    ریشه‌ی باگ: قبلاً x/y پیش‌فرض 0 داشتند، پس هر step فراموش‌شده یک کلیک
    واقعی در گوشهٔ بالا-چپ تولید می‌کرد و کاربر جای اشتباه را می‌دید."""
    mod = _make_xa11y()
    mod.input_sim = lambda: _FakeSim()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.input_action("click")
    assert "error" in result
    assert "selector" in result["error"]
    # خطای راهنما باید پیشنهاد درست بدهد، نه فقط «نیاز به x دارد»
    assert "LOGICAL" in result["error"]


def test_sequence_missing_coords_fails_at_step(monkeypatch: pytest.MonkeyPatch):
    """step بی‌مختصات باید در همان index شکست بخورد، نه کلیک در (0,0)."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)
    result = cu.run_sequence([{"kind": "wait", "ms": 1}, {"kind": "click"}])
    assert result["ok"] is False
    assert result["failed_at"] == 1
    assert result["ran"] == 1
    assert not sim.clicks


def test_normalize_key_aliases():
    """نام‌های متعارف مدل باید به امضای Pascal xa11y تبدیل شوند."""
    assert cu._normalize_key("enter") == "Enter"
    assert cu._normalize_key("ESC") == "Escape"
    assert cu._normalize_key("arrow up") == "ArrowUp"
    assert cu._normalize_key("page_down") == "PageDown"
    assert cu._normalize_key("f12") == "F12"
    assert cu._normalize_key("a") == "a"  # حرفی عیناً
    with pytest.raises(ValueError):
        cu._normalize_key("  ")


def test_normalize_modifiers_aliases():
    assert cu._normalize_modifiers("cmd") == ["Meta"]
    assert cu._normalize_modifiers("control") == ["Ctrl"]
    assert cu._normalize_modifiers("meta, shift") == ["Meta", "Shift"]
    assert cu._normalize_modifiers(["option"]) == ["Alt"]
    assert cu._normalize_modifiers("") == []
    with pytest.raises(ValueError):
        cu._normalize_modifiers("hyper")


def test_press_key_with_held_becomes_chord(monkeypatch: pytest.MonkeyPatch):
    """press_key با held نباید مودیفایر را دور بیندازد."""
    sim = _FakeSim()
    cu._sim_do(sim, "press_key", key="o", held="cmd")
    assert ("chord", ("o", ["Meta"])) in sim.calls
    sim2 = _FakeSim()
    cu._sim_do(sim2, "press_key", key="enter")
    assert ("press", "Enter") in sim2.calls


def test_read_screen_lists_targets_with_logical_centers(
    monkeypatch: pytest.MonkeyPatch,
):
    """read_screen باید مرکز منطقی عناصر تعاملی را بدهد تا حدس پیکلی لازم نشود."""
    btn = _FakeElement("button", "OK", _FakeRect(100, 200, 80, 24))
    field = _FakeElement("text_field", "Search", _FakeRect(10, 20, 200, 30))
    app = _FakeApp("Notes", elements=[btn, field])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Notes")
    assert result["targets"] == [
        "button[name='OK'] -> center=(140,212)",
        "text_field[name='Search'] -> center=(110,35)",
    ]
    assert "LOGICAL" in result["targets_hint"]


def test_read_screen_dedupes_same_name_targets(monkeypatch: pytest.MonkeyPatch):
    """عناصر هم‌نام باید با :nth یکتا شوند، وگرنه selector دوسو دارد."""
    a = _FakeElement("button", "OK", _FakeRect(0, 0, 10, 10))
    b = _FakeElement("button", "OK", _FakeRect(100, 100, 10, 10))
    app = _FakeApp("Notes", elements=[a, b])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    targets = cu.read_screen(app_name="Notes")["targets"]
    assert targets[0].startswith("button[name='OK']:nth(1)")
    assert targets[1].startswith("button[name='OK']:nth(2)")


def test_read_element_scopes_targets(monkeypatch: pytest.MonkeyPatch):
    """targets در read_element باید scoped به همان selector باشند."""
    btn = _FakeElement("button", "OK", _FakeRect(300, 400, 20, 10))
    field = _FakeElement("group", "Container", _FakeRect(50, 60, 20, 10), children=[btn])
    app = _FakeApp("Notes", elements=[field, btn])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_element(selector="group", app_name="Notes")
    assert "button" in result["tree"]
    assert "button" in result["tree"]
    # مرکز خود عنصر هم گزارش شود
    assert result["center"] == "(60,65)"
    # targets با پیشوند scope برمی‌گردند تا مستقیم قابل استفاده باشند
    assert result["targets"][0].startswith("group >> button")


# ---------------------------------------------------------------------------
# تست‌های ابزار computer (گیت پرمیشن)
# ---------------------------------------------------------------------------


@pytest.fixture
def tool_env(monkeypatch: pytest.MonkeyPatch):
    """ساخت make_tool_callbacks با mock xa11y و گیت پرمیشن واقعی."""
    ok_button = _FakeElement("button", "OK")
    app = _FakeApp("Notes", elements=[ok_button])
    mod = _make_xa11y(apps=[app])
    mod.input_sim = lambda: _FakeSim()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    # فعال‌سازی اپ باید mock شود: input/sequence/act با app_name از این
    # مسیر می‌گذرند و بدون mock، pytest روی مک واقعاً اپ را با osascript
    # باز می‌کند (همان بازشدن Notes هنگام تست).
    monkeypatch.setattr(
        cu, "open_app", lambda name: {"ok": True, "app": name}
    )
    # صبر foreground هم mock می‌شود: در تست‌ها اپ هدف همیشه در فهرست fake
    # نیست و poll واقعی تا ACTIVATE_TIMEOUT_S زمان می‌برد.
    monkeypatch.setattr(cu, "_wait_foreground", lambda name, timeout=None: True)

    import tools as tools_mod

    events: list[dict] = []
    gates: dict[str, asyncio.Future] = {}
    permit: dict[str, Any] = {"outside": False}
    cbs = tools_mod.make_tool_callbacks(
        root=".",
        emit=events.append,
        permission_gates=gates,
        permit=permit,
    )
    return cbs, events, gates, permit


def test_read_screen_no_permission_needed(tool_env):
    cbs, events, _gates, _permit = tool_env
    result = asyncio.run(cbs["computer"](action="read_screen"))
    parsed = json.loads(result)
    assert "tree" in parsed
    # هیچ ایونت permission نباید منتشر شود
    assert not [e for e in events if e["kind"] == "permission"]


def test_act_denied_before_permission(tool_env):
    cbs, events, gates, _permit = tool_env

    async def _run():
        task = asyncio.ensure_future(
            cbs["computer"](action="act", selector="button", do="press", app="Notes")
        )
        # اجازه بده ابزار تا گیت پرمیشن برسد
        await asyncio.sleep(0.05)
        # ایونت permission باید منتشر شده باشد
        perm_events = [e for e in events if e["kind"] == "permission"]
        assert perm_events, "permission event should have been emitted"
        pid = perm_events[-1]["id"]
        gates[pid].set_result(False)
        return await task

    result = asyncio.run(_run())
    parsed = json.loads(result)
    assert "permission denied" in parsed["error"]


def test_act_granted_then_runs(tool_env):
    cbs, events, gates, permit = tool_env

    async def _run():
        task = asyncio.ensure_future(
            cbs["computer"](action="act", selector="button", do="press", app="Notes")
        )
        await asyncio.sleep(0.05)
        perm_events = [e for e in events if e["kind"] == "permission"]
        pid = perm_events[-1]["id"]
        gates[pid].set_result(True)
        return await task

    result = asyncio.run(_run())
    parsed = json.loads(result)
    assert parsed["ok"] is True
    # پس از اولین تأیید، پرمیشن برای بقیهٔ turn کش می‌شود
    assert permit["computer"] is True


def test_second_act_needs_no_new_permission(tool_env):
    cbs, events, _gates, permit = tool_env
    permit["computer"] = True
    result = asyncio.run(cbs["computer"](action="act", selector="button", do="press", app="Notes"))
    parsed = json.loads(result)
    assert parsed["ok"] is True
    assert not [e for e in events if e["kind"] == "permission"]


def test_preset_allow_computer_flag_skips_dialog(tool_env):
    """«Always allow» کاربر: پرچم computer از ابتدای turn ست شده (از طریق
    allow_computer در درخواست چت) → هیچ دیالوگی نمایش داده نمی‌شود."""
    cbs, events, _gates, permit = tool_env
    permit["computer"] = True  # شبیه‌سازی allow_computer=True که server از UI دریافت می‌کند
    result = asyncio.run(
        cbs["computer"](action="input", do="type_text", text="hello", app="Notes")
    )
    parsed = json.loads(result)
    assert parsed["ok"] is True
    assert not [e for e in events if e["kind"] == "permission"]


def test_failed_action_keeps_grant_no_new_dialog(tool_env):
    """اکشن شکست‌خورده بعد از تأیید کاربر نباید گرانت را باطل کند.

    ریشه‌ی باگ «Always allow زدم باز هم اجازه می‌خواد»: قبلاً گرانت فقط
    بعد از موفقیت اکشن کش می‌شد؛ در جلسه‌ای که اکشن‌ها مدام خطا می‌دادند
    (AXPress -25205 و…) هر تأیید کاربر بی‌اثر می‌ماند و اکشن بعدی دوباره
    دیالوگ می‌آورد. حالا گرانت بلافاصله بعد از تأیید کش می‌شود."""
    cbs, events, gates, permit = tool_env

    # اکشن اول: find_and_act را طوری mock می‌کنیم که شکست بخورد (مثل
    # AXPress -25205 در جلسهٔ Word) — ولی گرانت باید بعد از تأیید کش شود
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        cu, "find_and_act", lambda **kw: {"error": "PlatformError: AXPress failed"}
    )

    async def _run_failing():
        task = asyncio.ensure_future(
            cbs["computer"](action="act", selector="button", do="press", app="Notes")
        )
        await asyncio.sleep(0.05)
        perm_events = [e for e in events if e["kind"] == "permission"]
        assert perm_events, "permission event should have been emitted"
        gates[perm_events[-1]["id"]].set_result(True)
        return await task

    result = asyncio.run(_run_failing())
    parsed = json.loads(result)
    # اکشن شکست خورد ولی گرانت کش شد
    assert "error" in parsed
    assert permit["computer"] is True

    # اکشن دوم: نباید دیالوگ جدید بیاورد — گرانت زنده است
    perm_count_before = len([e for e in events if e["kind"] == "permission"])
    result2 = asyncio.run(cbs["computer"](action="act", selector="button", do="press", app="Notes"))
    parsed2 = json.loads(result2)
    assert "error" in parsed2  # باز هم شکست می‌خورد (همان mock)
    perm_count_after = len([e for e in events if e["kind"] == "permission"])
    assert perm_count_after == perm_count_before, (
        "after a failed-but-granted action, no new permission dialog"
    )
    monkeypatch.undo()


def test_input_needs_permission(tool_env):
    cbs, events, gates, _permit = tool_env

    async def _run():
        task = asyncio.ensure_future(
            cbs["computer"](action="input", do="click", x=5, y=5, app="Notes")
        )
        await asyncio.sleep(0.05)
        perm_events = [e for e in events if e["kind"] == "permission"]
        assert perm_events
        gates[perm_events[-1]["id"]].set_result(True)
        return await task

    result = asyncio.run(_run())
    parsed = json.loads(result)
    assert parsed["ok"] is True


def test_unknown_action(tool_env):
    cbs, _events, _gates, _permit = tool_env
    result = asyncio.run(cbs["computer"](action="explode"))
    parsed = json.loads(result)
    assert "Unknown action" in parsed["error"]


# ---------------------------------------------------------------------------
# تست‌های فاز ۲: sequence، تایپ یونیکد، open_app، read_element، see
# ---------------------------------------------------------------------------


def test_sequence_runs_all_steps(monkeypatch: pytest.MonkeyPatch):
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)  # بدون تاخیر واقعی

    steps = [
        {"kind": "click", "x": 10, "y": 20},
        {"kind": "type_text", "text": "ls"},
        {"kind": "press_key", "key": "Enter"},
    ]
    result = cu.run_sequence(steps)
    assert result["ok"] is True
    assert result["ran"] == 3
    kinds = [c[0] for c in sim.calls]
    assert kinds == ["click", "type_text", "press"]


def test_sequence_stops_on_failure(monkeypatch: pytest.MonkeyPatch):
    sim = _FakeSim()

    class _FailingSim(_FakeSim):
        def type_text(self, text):
            raise RuntimeError("boom")

    sim = _FailingSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)

    steps = [
        {"kind": "click", "x": 1, "y": 2},
        {"kind": "type_text", "text": "x"},
        {"kind": "press_key", "key": "Enter"},  # نباید اجرا شود
    ]
    result = cu.run_sequence(steps)
    assert result["ok"] is False
    assert result["ran"] == 1
    assert result["failed_at"] == 1
    # step سوم اجرا نشده
    kinds = [c[0] for c in sim.calls]
    assert "press" not in kinds


def test_sequence_unknown_kind_rejected(monkeypatch: pytest.MonkeyPatch):
    mod = _make_xa11y()
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.run_sequence([{"kind": "explode"}])
    assert "error" in result


def test_sequence_activates_target_app_first(monkeypatch: pytest.MonkeyPatch):
    """sequence با app_name باید اول اپ هدف را فعال کند، بعد رویدادها را بفرستد.

    ریشه‌ی باگ «Ctrl+O در اپ اشتباه زده شد»: InputSim رویدادها را به اپِ
    فوکوس‌شدهٔ سیستم می‌فرستد؛ اگر sequence اپ هدف را فعال نکند، کلیدها به
    اپ دیگری (مثلاً خودِ ایجنت) می‌روند."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)
    activated: list[str] = []
    monkeypatch.setattr(
        cu, "open_app", lambda name: activated.append(name) or {"ok": True}
    )
    monkeypatch.setattr(cu, "_wait_foreground", lambda name, timeout=None: True)

    result = cu.run_sequence(
        [{"kind": "press_key", "key": "o", "held": "Meta"}], app_name="Safari"
    )
    assert result["ok"] is True
    assert activated == ["Safari"]
    # مودیفایر به امضای xa11y نرمال شده: Meta (نه meta/cmd) و کلید حرفی عیناً
    assert ("chord", ("o", ["Meta"])) in sim.calls


def test_input_action_activates_target_app(monkeypatch: pytest.MonkeyPatch):
    """input با app_name باید اول اپ هدف را فعال کند — همان ریشه‌ی sequence."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)
    activated: list[str] = []
    monkeypatch.setattr(
        cu, "open_app", lambda name: activated.append(name) or {"ok": True}
    )

    result = cu.input_action("type_text", text="hello", app_name="Notes")
    assert result["ok"] is True
    assert activated == ["Notes"]
    assert ("type_text", "hello") in sim.calls


def test_find_and_act_type_text_activates_app(monkeypatch: pytest.MonkeyPatch):
    """act با do='type_text' باید اول اپ هدف را فعال کند.

    ریشه‌ی باگ «به جای Word در Codifa تایپ می‌شود»: Locator.type_text رویداد
    کیبورد سنتز می‌کند و به اپِ فوکوس‌شدهٔ سیستم می‌رود. مسیر act (برخلاف
    input/sequence) هیچ فعال‌سازی‌ای نداشت؛ اگر Codifa فوکوس داشت، متن
    تایپی به آن می‌رفت."""
    field = _FakeElement("text_field", "Body")
    app = _FakeApp("Microsoft Word", elements=[field])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)
    activated: list[str] = []
    monkeypatch.setattr(
        cu, "open_app", lambda name: activated.append(name) or {"ok": True}
    )

    result = cu.find_and_act(
        selector="text_field[name='Body']", action="type_text",
        value="سلام", app_name="Microsoft Word",
    )
    assert result["ok"] is True
    assert activated == ["Microsoft Word"]


def test_keyboard_actions_without_app_rejected(tool_env):
    """اکشن‌های کیبوردی بدون پارامتر app باید خطای راهنما بدهند.

    بدون این گاردریل، کلیدها به اپِ فوکوس‌شدهٔ سیستم (خودِ ایجنت/Codifa)
    می‌روند — همان باگی که Ctrl+O و تایپ‌ها به اشتباه در Codifa می‌رفتند."""
    cbs, _events, _gates, permit = tool_env
    permit["computer"] = True  # پرمیشن از قبل داده شده — گاردریل مستقل از آن

    # act + type_text بدون app
    r1 = asyncio.run(
        cbs["computer"](action="act", selector="text_field", do="type_text", value="hi")
    )
    assert "app" in json.loads(r1)["error"]

    # input + press_key بدون app
    r2 = asyncio.run(cbs["computer"](action="input", do="press_key", key="enter"))
    assert "app" in json.loads(r2)["error"]

    # sequence با step کیبوردی بدون app
    r3 = asyncio.run(
        cbs["computer"](
            action="sequence", steps=[{"kind": "type_text", "text": "ls"}]
        )
    )
    assert "app" in json.loads(r3)["error"]


def test_type_text_unicode_via_clipboard(monkeypatch: pytest.MonkeyPatch):
    """متن فارسی باید از کلیپ‌بورد برود، نه sim.type_text مستقیم."""
    sim = _FakeSim()
    runs: list[Any] = []

    def _fake_run(cmd, **kw):
        runs.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(cu.subprocess, "run", _fake_run)
    monkeypatch.setattr(cu.platform, "system", lambda: "Darwin")
    cu._type_text(sim, "سلام")
    # pbcopy باید صدا زده شده باشد و chord paste — نه type_text مستقیم
    assert any("pbcopy" in r[0] for r in runs)
    assert ("chord", ("v", ["Meta"])) in sim.calls
    assert ("type_text", "سلام") not in sim.calls


def test_type_text_ascii_direct(monkeypatch: pytest.MonkeyPatch):
    sim = _FakeSim()
    monkeypatch.setattr(cu.subprocess, "run", lambda *a, **k: None)
    cu._type_text(sim, "ls -la")
    assert ("type_text", "ls -la") in sim.calls


def test_open_app_macos(monkeypatch: pytest.MonkeyPatch):
    runs: list[Any] = []

    def _fake_run(cmd, **kw):
        runs.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(cu.subprocess, "run", _fake_run)
    monkeypatch.setattr(cu.platform, "system", lambda: "Darwin")
    # poll foreground mock می‌شود — در تست‌ها اپ fake در فهرست واقعی نیست
    monkeypatch.setattr(cu, "_wait_foreground", lambda name, timeout=None: True)
    # میان‌بر «از قبل foreground» باید برای این تست خاموش باشد تا osascript
    # (مسیر activate) قطعاً اجرا شود — حتی اگر Chrome واقعاً جلو باشد.
    monkeypatch.setattr(cu, "_is_foreground_app", lambda name: False)
    result = cu.open_app("Google Chrome")
    assert result["ok"] is True
    # osascript با نام اپ درست صدا زده شود
    assert any(
        "osascript" in r[0] and "Google Chrome" in r[2] for r in runs
    )


def test_open_app_skips_when_already_foreground(monkeypatch: pytest.MonkeyPatch):
    """اپ از قبل جلو است → نه osascript، نه poll — بزرگ‌ترین برد سرعت."""
    app = _FakeApp("Google Chrome")
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)

    def _boom(*_a, **_k):
        raise AssertionError("subprocess must not run when app is already front")

    monkeypatch.setattr(cu.subprocess, "run", _boom)
    result = cu.open_app("Google Chrome")
    assert result["ok"] is True
    assert result["foreground"] is True
    assert result["already_active"] is True


def test_open_app_activates_when_background(monkeypatch: pytest.MonkeyPatch):
    """اپ جلو نیست → همچنان osascript فعال می‌شود (رفتار قبل حفظ شود)."""
    fg = _FakeApp("Notes")
    target = _FakeApp("Google Chrome")
    monkeypatch.setattr(
        cu, "xa11y", _make_xa11y(apps=[fg, target]), raising=False
    )
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    runs: list[Any] = []

    def _fake_run(cmd, **kw):
        runs.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(cu.subprocess, "run", _fake_run)
    monkeypatch.setattr(cu.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(cu, "_wait_foreground", lambda name, timeout=None: True)
    result = cu.open_app("Google Chrome")
    assert result["ok"] is True
    assert any("osascript" in r[0] for r in runs)


def test_sequence_no_double_foreground_wait(monkeypatch: pytest.MonkeyPatch):
    """open_app خودش صبر می‌کند — sequence نباید دوباره poll کند (+۲s تلفات)."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu.time, "sleep", lambda _s: None)
    open_calls: list[str] = []
    wait_calls: list[str] = []
    monkeypatch.setattr(
        cu,
        "open_app",
        lambda name: open_calls.append(name) or {"ok": True, "foreground": True},
    )
    monkeypatch.setattr(
        cu,
        "_wait_foreground",
        lambda name, timeout=None: wait_calls.append(name) or True,
    )
    result = cu.run_sequence(
        [{"kind": "press_key", "key": "o", "held": "Meta"}], app_name="Safari"
    )
    assert result["ok"] is True
    assert open_calls == ["Safari"]
    assert wait_calls == []  # poll دوم حذف شد


def test_sequence_skips_gap_before_wait(monkeypatch: pytest.MonkeyPatch):
    """کنارِ step «wait» gap اضافه نشود — وگذره ۱۵۰ms روی هر wait انباشته می‌شد."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    sleeps: list[float] = []
    monkeypatch.setattr(cu.time, "sleep", sleeps.append)
    steps = [
        {"kind": "press_key", "key": "a"},
        {"kind": "wait", "ms": 100},
        {"kind": "press_key", "key": "b"},
    ]
    result = cu.run_sequence(steps)
    assert result["ok"] is True
    # فقط خودِ wait (0.1s) — نه gap قبل/بعد آن، نه gap بعد از آخرین step
    assert sleeps == [0.1]


def test_sequence_default_gap_between_actions(monkeypatch: pytest.MonkeyPatch):
    """بین دو اکشن عادی هنوز gap پیش‌فرض هست (UI فرصت واکنش داشته باشد)."""
    sim = _FakeSim()
    mod = _make_xa11y()
    mod.input_sim = lambda: sim  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    sleeps: list[float] = []
    monkeypatch.setattr(cu.time, "sleep", sleeps.append)
    result = cu.run_sequence(
        [
            {"kind": "press_key", "key": "a"},
            {"kind": "press_key", "key": "b"},
            {"kind": "press_key", "key": "c"},
        ]
    )
    assert result["ok"] is True
    gap_s = cu.SEQUENCE_DEFAULT_GAP_MS / 1000
    assert sleeps == [gap_s, gap_s]  # بینها، نه بعد از آخرین


def test_is_foreground_app_matches_canonical(monkeypatch: pytest.MonkeyPatch):
    app = _FakeApp("Google Chrome")
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    assert cu._is_foreground_app("chrome") is True
    assert cu._is_foreground_app("Google Chrome") is True


def test_is_foreground_app_false_when_other_app_front(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        cu, "xa11y", _make_xa11y(apps=[_FakeApp("Notes")]), raising=False
    )
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    assert cu._is_foreground_app("Safari") is False


def test_read_element_subtree(monkeypatch: pytest.MonkeyPatch):
    ok = _FakeElement("button", "OK")
    field = _FakeElement(
        "group",
        "Container",
        _FakeRect(10, 20, 300, 200),
        children=[ok, _FakeElement("text_field", "Search", value="q")],
    )
    app = _FakeApp("Notes", elements=[field])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_element(selector="group", app_name="Notes")
    assert "error" not in result
    assert "button 'OK'" in result["tree"]
    assert "text_field 'Search'" in result["tree"]
    assert "value='q'" in result["tree"]
    # ریشه با bounds خودش، فرزندان تورفته (یک indent بیشتر)
    assert "group 'Container' bounds=(10,20,300,200)" in result["tree"]
    assert result["bounds_in_tree"] is True
    assert result["center"] == "(160,120)"


def test_read_element_respects_max_depth(monkeypatch: pytest.MonkeyPatch):
    """``depth`` باید پیمایش را قطع کند — وگرنه هر read_element کل صفحه را می‌خواند."""
    deep = _FakeElement(
        "group",
        "L1",
        children=[_FakeElement("group", "L2", children=[_FakeElement("button", "L3")])],
    )
    app = _FakeApp("Notes", elements=[deep])
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_element(selector="group", app_name="Notes", max_depth=1)
    assert "L2" in result["tree"]
    assert "L3" not in result["tree"]


def test_screenshot_to_data_uri():
    uri = cu.screenshot_to_data_uri(b"\x89PNG fake")
    assert uri.startswith("data:image/png;base64,")


def test_capture_screenshot_reports_all_coordinate_spaces(
    monkeypatch: pytest.MonkeyPatch,
):
    """هر سه فضای مختصات باید گزارش شود — ریشه‌ی «کلیک دور از هدف».

    xa11y عرض/قد را در پیکسل فیزیکی می‌دهد (روی رتینا ۲×) ولی InputSim در
    نقطهٔ منطقی کلیک می‌کند؛ قبلاً فقط همان عدد فیزیکی به مدل برمی‌گشت، پس
    هر مختصاتی که مدل از روی تصویر می‌خواند دو برابر خطا داشت."""

    class _Shot:
        width = 3000
        height = 2000
        scale = 2.0
        legend: ClassVar[list] = []
        omitted: ClassVar[list] = []

        def to_png(self):
            return b"\x89PNG fake"

    mod = _make_xa11y()
    mod.screenshot = lambda **kw: _Shot()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    # downscale را جداگانه mock می‌کنیم تا نسبت معلوم تست شود
    monkeypatch.setattr(cu, "_downscale_png", lambda png: (png, 1.0))
    result = cu.capture_screenshot()
    assert result["ok"] is True
    assert result["data_uri"].startswith("data:image/png;base64,")
    assert result["physical_width"] == 3000
    assert result["display_scale"] == 2.0
    # فضای واقعی کلیک = logical point
    assert result["logical_width"] == 1500
    assert result["image_width"] == 3000
    # تبدیل: pixel_in_image / image_scale = logical
    assert result["image_scale"] == 2.0
    assert "image_scale" in result["hint"]


def test_capture_screenshot_accounts_for_downscale(monkeypatch: pytest.MonkeyPatch):
    """اگر تصویر کوچک شد، image_scale باید هر دو ضریب را یکجا بدهد.

    ریشه‌ی دوم خطای مکان کلیک: تصویری که به مدل می‌رسد downscale شده، ولی
    ابعاد گزارش‌شده خام بود — یعنی مدل روی ۱۶۰۰ پیکسل حدس می‌زد در حالی که
    صفحه ۳۰۲۴ پیکسل فیزیکی بود."""

    class _Shot:
        width = 3024
        height = 1964
        scale = 2.0
        legend: ClassVar[list] = []
        omitted: ClassVar[list] = []

        def to_png(self):
            return b"\x89PNG fake"

    mod = _make_xa11y()
    mod.screenshot = lambda **kw: _Shot()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    ratio = cu.MAX_IMAGE_WIDTH / 3024
    monkeypatch.setattr(cu, "_downscale_png", lambda png: (png, ratio))
    result = cu.capture_screenshot()
    assert result["image_width"] == cu.MAX_IMAGE_WIDTH
    # logical = 3024/2 = 1512؛ image_scale = 1600/1512 ≈ 1.058
    assert result["logical_width"] == 1512
    assert abs(result["image_scale"] - cu.MAX_IMAGE_WIDTH / 1512) < 1e-6
    # نقطهٔ وسط تصویر ارسالی باید به وسط صفحهٔ منطقی برسد
    assert round(result["image_width"] / result["image_scale"]) == result[
        "logical_width"
    ]


def test_capture_screenshot_region_passes_logical_rect(
    monkeypatch: pytest.MonkeyPatch,
):
    """``region`` باید به همان مستطیل منطقی برود و مبدأ گزارش شود.

    docstring ابزار «full screen, selector element, or region» را تبلیغ
    می‌کرد ولی پارامتر region اصلاً وجود نداشت — تبلیغ بی‌پشتوانه."""
    captured: dict[str, Any] = {}

    class _Shot:
        width = 800
        height = 600
        scale = 2.0
        legend: ClassVar[list] = []
        omitted: ClassVar[list] = []

        def to_png(self):
            return b"\x89PNG fake"

    mod = _make_xa11y()
    mod.screenshot = lambda **kw: captured.update(kw) or _Shot()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    monkeypatch.setattr(cu, "_downscale_png", lambda png: (png, 1.0))
    result = cu.capture_screenshot(region=[120, 40, 400, 300])
    assert captured["region"] == (120, 40, 400, 300)
    # مختصاتِ روی این تصویر نسبی به برش است؛ مبدأ باید گزارش شود
    assert result["origin_x"] == 120
    assert result["origin_y"] == 40


def test_capture_screenshot_rejects_selector_and_region(
    monkeypatch: pytest.MonkeyPatch,
):
    """همزمان selector و region خطاست (xa11y هم ValueError می‌دهد)."""
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.capture_screenshot(selector="window", region=[0, 0, 10, 10])
    assert "not both" in result["error"]


def test_screenshot_bounded_timeout(monkeypatch: pytest.MonkeyPatch):
    """xa11y.screenshot که hang می‌کند باید بعد از سقف TimeoutError بدهد."""
    import time as _time

    mod = _make_xa11y()

    def _hang(**_kw):
        _time.sleep(60)  # به اندازهٔ sleep کوتاه‌تر از join نیست

    mod.screenshot = _hang  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    shot, err = cu._screenshot_bounded({}, timeout=0.2)
    assert shot is None
    assert isinstance(err, TimeoutError)
    assert "hung" in str(err)


def test_screenshot_bounded_passes_through_exception(monkeypatch: pytest.MonkeyPatch):
    mod = _make_xa11y()

    def _boom(**_kw):
        raise RuntimeError("screen capture failed")

    mod.screenshot = _boom  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    shot, err = cu._screenshot_bounded({}, timeout=1.0)
    assert shot is None
    assert isinstance(err, RuntimeError)


def test_capture_screenshot_cli_fallback_on_hang(
    monkeypatch: pytest.MonkeyPatch,
):
    """hang در xa11y باید به screencapture CLI fallback برود و result برگردد."""
    import time as _time

    mod = _make_xa11y()

    def _hang(**_kw):
        _time.sleep(60)

    mod.screenshot = _hang  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)

    def _fake_cli(rect):
        # rect باید همان region خواسته‌شده باشد
        assert rect == (10, 20, 300, 200)
        return {
            "ok": True,
            "fallback": "screencapture",
            "image_width": 600,
            "image_height": 400,
            "image_scale": 2.0,
            "logical_width": 300,
            "logical_height": 200,
            "origin_x": 10,
            "origin_y": 20,
            "data_uri": "data:image/png;base64,AA==",
            "hint": "h",
        }

    monkeypatch.setattr(cu, "_capture_cli", _fake_cli)
    monkeypatch.setattr(cu, "SCREENSHOT_TIMEOUT", 0.2)
    result = cu.capture_screenshot(region=[10, 20, 300, 200])
    assert result["ok"] is True
    assert result["fallback"] == "screencapture"
    assert result["origin_x"] == 10


def test_capture_cli_result_shape(monkeypatch: pytest.MonkeyPatch):
    """_capture_cli باید همان کلیدهای see را برگرداند."""
    import io as _io

    from PIL import Image as _Image

    # PNG واقعی (۲۰۰×۱۰۰ فیزیکی) — subprocess ساختگی در فایل خروجی می‌نویسد
    img = _Image.new("RGB", (200, 100), "red")
    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    captured_cmd: list[str] = []

    def _fake_run(cmd, **_kw):
        captured_cmd.extend(cmd)
        out_path = cmd[-1]
        with open(out_path, "wb") as fh:
            fh.write(png_bytes)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(cu.subprocess, "run", _fake_run)
    monkeypatch.setattr(cu.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(cu, "_desktop_logical_bounds", lambda: (0, 0, 100, 50))
    result = cu._capture_cli((10, 20, 100, 50))
    assert result is not None
    assert result["ok"] is True
    assert result["fallback"] == "screencapture"
    # physical = PNG اندازه
    assert result["physical_width"] == 200
    # logical = rect
    assert result["logical_width"] == 100
    # display_scale = 200/100 = 2.0
    assert result["display_scale"] == 2.0
    assert result["origin_x"] == 10
    assert result["data_uri"].startswith("data:image/png;base64,")
    # -R باید با rect خواسته‌شده رفته باشد
    assert any(c.startswith("-R10,20,100,50") for c in captured_cmd)


def test_see_outer_capture_timeout(tool_env, monkeypatch: pytest.MonkeyPatch):
    """اگر capture_screenshot خودش hang کند، ابزار see باید خطا برگرداند."""
    _cbs, events, gates, permit = tool_env
    import tools as tools_mod

    cbs = tools_mod.make_tool_callbacks(
        root=".",
        emit=events.append,
        vision_model=object(),
        permission_gates=gates,
        permit=permit,
    )

    def _hang_capture(**_kw):
        import time as _time

        _time.sleep(60)

    monkeypatch.setattr(cu, "capture_screenshot", _hang_capture)
    monkeypatch.setattr(tools_mod, "SEE_CAPTURE_TIMEOUT", 0.2)
    result = asyncio.run(cbs["computer"](action="see", value="what?"))
    parsed = json.loads(result)
    assert "error" in parsed
    assert "exceeded" in parsed["error"]
    assert "Screen" in parsed["error"] or "Recording" in parsed["error"]


@pytest.mark.parametrize(
    "bad",
    [
        [10, 20, 30],  # کم‌عضو
        "not a list",  # نوع اشتباه
        [0, 0, 0, 10],  # عرض صفر
        [0, 0, 10, -5],  # ارتفاع منفی
        ["a", "b", "c", "d"],  # غیرعددی
    ],
)
def test_normalize_region_rejects_bad_input(bad):
    """region باید همین‌جا خطای خوانا بدهد، نه داخل پل Rust."""
    with pytest.raises(ValueError):
        cu._normalize_region(bad)


def test_normalize_region_accepts_floats_and_tuple():
    assert cu._normalize_region((1.0, 2.0, 3.0, 4.0)) == (1, 2, 3, 4)
    assert cu._normalize_region([10, 20, 30, 40]) == (10, 20, 30, 40)


def test_see_forwards_region_through_tool(tool_env, monkeypatch: pytest.MonkeyPatch):
    """ابزار باید region را به capture_screenshot برساند و مبدأ را برگرداند."""
    _cbs, events, gates, permit = tool_env
    import tools as tools_mod

    # see بدون مدل بینایی در همان ابتدای شاخه خطا می‌دهد — برای این تست یک
    # فیک کافی است (llm_generate پایین‌تر mock می‌شود).
    cbs = tools_mod.make_tool_callbacks(
        root=".",
        emit=events.append,
        vision_model=object(),
        permission_gates=gates,
        permit=permit,
    )
    seen: dict[str, Any] = {}

    def _fake_capture(**kw):
        seen.update(kw)
        return {
            "ok": True,
            "data_uri": "data:image/png;base64,AA==",
            "image_width": 100,
            "image_height": 80,
            "image_scale": 1.0,
            "logical_width": 100,
            "logical_height": 80,
            "origin_x": 5,
            "origin_y": 6,
            "hint": "h",
        }

    monkeypatch.setattr(cu, "capture_screenshot", _fake_capture)

    async def _generate(*_a, **_k):
        return "canvas shows a chart", None

    import llm

    monkeypatch.setattr(llm, "llm_generate", _generate)
    result = asyncio.run(
        cbs["computer"](action="see", region=[5, 6, 100, 80], value="what?")
    )
    parsed = json.loads(result)
    assert seen["region"] == (5, 6, 100, 80)
    assert parsed["origin_x"] == 5
    assert parsed["origin_y"] == 6


def test_see_caches_identical_vision_calls(tool_env, monkeypatch: pytest.MonkeyPatch):
    """see تکراری روی همان PNG+سؤال نباید دوباره مدل بینایی صدا بزند."""
    _cbs, events, gates, permit = tool_env
    import tools as tools_mod

    cbs = tools_mod.make_tool_callbacks(
        root=".",
        emit=events.append,
        vision_model=object(),
        permission_gates=gates,
        permit=permit,
    )

    def _fake_capture(**_kw):
        return {
            "ok": True,
            "data_uri": "data:image/png;base64,AA==",
            "image_width": 100,
            "image_height": 80,
            "image_scale": 1.0,
            "logical_width": 100,
            "logical_height": 80,
            "origin_x": 0,
            "origin_y": 0,
            "hint": "",
        }

    monkeypatch.setattr(cu, "capture_screenshot", _fake_capture)
    calls = {"n": 0}

    async def _generate(*_a, **_k):
        calls["n"] += 1
        return "screen is fine", None

    import llm

    monkeypatch.setattr(llm, "llm_generate", _generate)
    first = json.loads(asyncio.run(cbs["computer"](action="see", value="q?")))
    second = json.loads(asyncio.run(cbs["computer"](action="see", value="q?")))
    assert first["ok"] is True
    assert second["ok"] is True
    assert second.get("cached") is True
    assert second["analysis"] == first["analysis"]
    assert calls["n"] == 1  # فقط اولین بار vision رفت
    # سؤال متفاوت → کش نباید بخورد
    third = json.loads(asyncio.run(cbs["computer"](action="see", value="other?")))
    assert third.get("cached") is not True
    assert calls["n"] == 2


def test_downscale_png_returns_ratio():
    """_downscale_png باید نسبت واقعی ارسالی را برگرداند (۱.۰ = دست‌نخورده)."""
    import io as _io

    from PIL import Image

    img = Image.new("RGB", (400, 200), "white")
    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    _out, ratio = cu._downscale_png(buf.getvalue())
    assert ratio == 1.0  # زیر سقف، پس تغییر نمی‌کند

    big = Image.new("RGB", (cu.MAX_IMAGE_WIDTH * 2, 800), "white")
    buf2 = _io.BytesIO()
    big.save(buf2, format="PNG")
    out2, ratio2 = cu._downscale_png(buf2.getvalue())
    assert 0 < ratio2 < 1.0
    small = Image.open(_io.BytesIO(out2))
    assert small.width == cu.MAX_IMAGE_WIDTH
    assert abs(small.width - 2 * cu.MAX_IMAGE_WIDTH * ratio2) <= 1


def test_see_no_vision_model_hint(tool_env):
    cbs, _events, _gates, _permit = tool_env
    # بدون vision model → پیام راهنما
    result = asyncio.run(
        cbs["computer"](action="see", value="what is on screen?")
    )
    parsed = json.loads(result)
    # main_model در fixture نیست → باید پیام راهنمای تنظیم مدل بینایی بیاید
    assert "error" in parsed
    assert "Vision model" in parsed["error"] or "vision" in parsed["error"].lower()


def test_sequence_permission_gate(tool_env):
    cbs, events, gates, _permit = tool_env

    async def _run():
        task = asyncio.ensure_future(
            cbs["computer"](
                action="sequence",
                app="Notes",
                steps=[
                    {"kind": "click", "x": 1, "y": 2},
                    {"kind": "type_text", "text": "ls"},
                ],
            )
        )
        await asyncio.sleep(0.05)
        perm_events = [e for e in events if e["kind"] == "permission"]
        assert perm_events
        # توصیف پرمیشن باید تعداد steps را داشته باشد
        assert "2 steps" in perm_events[-1]["action"]
        gates[perm_events[-1]["id"]].set_result(True)
        return await task

    result = asyncio.run(_run())
    parsed = json.loads(result)
    assert parsed["ok"] is True
    assert parsed["ran"] == 2


def test_see_without_permission_gate(tool_env):
    """see فقط‌خواندنی است — نباید گیت پرمیشن بزند."""
    cbs, events, _gates, _permit = tool_env
    asyncio.run(cbs["computer"](action="see"))
    assert not [e for e in events if e["kind"] == "permission"]


def test_open_app_action_via_tool(tool_env, monkeypatch: pytest.MonkeyPatch):
    """open_app بدون گیت پرمیشن — و بدون اجرای osascript واقعی.

    open_app باید mock شود وگرنه pytest روی مک واقعاً اپ Notes را
    باز می‌کند (osascript activate)."""
    cbs, events, _gates, _permit = tool_env
    monkeypatch.setattr(
        cu, "open_app", lambda app_name: {"ok": True, "app": app_name}
    )
    result = asyncio.run(cbs["computer"](action="open_app", app="Notes"))
    parsed = json.loads(result)
    assert parsed.get("ok") is True
    # فعال‌سازی اپ فقط پنجره جلو می‌آورد — گیت پرمیشن نمی‌زند
    assert not [e for e in events if e["kind"] == "permission"]


def test_shared_permit_survives_tool_rebuild():
    """گرانت پرمیشن باید بین rebuildهای ابزار در طول یک turn زنده بماند.

    ریشه‌ی باگ «Always allow که باز هم اجازه می‌خواد»: گره‌ی coder در
    LangGraph در هر step دوباره اجرا می‌شود و ``make_tool_callbacks`` با
    dict تازه‌ی ``permit`` ساخته می‌شد؛ گرانتِ ست‌شده در step قبل می‌پرید.
    ``_shared_permit`` همان dict موجود در ``state["_permit"]`` را
    برمی‌گرداند و پرچم‌های session را به‌عنوان کف اعمال می‌کند."""
    import graph as graph_mod

    state: dict = {}
    p1 = graph_mod._shared_permit(state, allow_outside=False)
    p1["computer"] = True  # شبیه‌سازی تأیید کاربر («Allow once» / «Always allow»)

    # rebuild بعدی (step جدید از گره coder) باید همان dict را ببیند
    p2 = graph_mod._shared_permit(state, allow_outside=False)
    assert p2 is p1
    assert p2.get("computer") is True


def test_unknown_key_name_hint():
    """خطای Unknown key name باید راهنمای فرمت درست کلیدها را بدهد.

    ریشه‌ی گیج‌شدن ایجنت: مدل 'command+t'/'cmd+n'/'ctrl' می‌فرستاد و ۸ بار
    پشت‌سرهم خطای خام ValueError می‌گرفت. حالا خطا می‌گوید کلید تکی lowercase
    و ترکیب‌ها از مسیر chord با held بروند."""
    exc = ValueError("Unknown key name: command+t")
    msg = cu._friendly_error(exc)
    assert "Unknown key name" in msg
    assert "chord" in msg
    assert "held" in msg
    # خطای غیرکلیدیِ ValueError نباید هینت کلید بگیرد
    plain = cu._friendly_error(ValueError("some other error"))
    assert "chord" not in plain


def test_read_screen_empty_tree_hint(monkeypatch: pytest.MonkeyPatch):
    """درخت خالی (اپ بدون پنجره) باید هینت open_app بدهد نه فقط درخت خالی."""
    root = types.SimpleNamespace(
        role="application",
        name="Chrome",
        value=None,
        bounds=None,
        children=list,
        dump=lambda max_depth=None: 'application "Chrome"',
    )
    app = types.SimpleNamespace(name="Chrome", as_element=lambda: root)
    monkeypatch.setattr(cu, "_resolve_app", lambda name: app)
    result = cu.read_screen("Chrome")
    assert result["app"] == "Chrome"
    assert "open_app" in result["hint"]


def test_shared_permit_session_floor():
    """پرچم‌های session (از UI) کف هستند و هر rebuild دوباره اعمال می‌شوند."""
    import graph as graph_mod

    state2: dict = {}
    p3 = graph_mod._shared_permit(state2, allow_outside=True)
    assert p3.get("outside") is True
    p3.pop("outside")
    p4 = graph_mod._shared_permit(state2, allow_outside=True)
    assert p4.get("outside") is True  # کف session دوباره اعمال شد


def test_shared_permit_session_folder_floor():
    """پوشه‌های pre-approved از UI (دکمه «همیشه اجازه» روی دیالوگ per-folder)
    هم مثل پرچم‌ها کف‌اند: rebuild ابزار نباید آن‌ها را از permit بپراند."""
    import graph as graph_mod

    state: dict = {"allow_outside_folders": ["/tmp/pre-approved"]}
    p1 = graph_mod._shared_permit(state, allow_outside=False)
    assert p1.get("folders") == ["/tmp/pre-approved"]
    # شبیه‌سازی rebuild: dict همان می‌ماند ولی فرض کن پوشه‌ها پاک شده باشند
    p1["folders"] = []
    p2 = graph_mod._shared_permit(state, allow_outside=False)
    assert p2 is p1
    assert "/tmp/pre-approved" in p2["folders"]  # کف دوباره تزریق شد
