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


class _FakeElement:
    def __init__(self, role: str, name: str | None = None):
        self.role = role
        self.name = name


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

    def __getattr__(self, name: str):
        # اکشن‌های بدون آرگومان (press, focus, toggle, ...)
        def _no_arg(*_args: Any, **_kwargs: Any):
            self.calls.append((name, None))

        return _no_arg


class _FakeApp:
    def __init__(self, name: str, elements: list[_FakeElement] | None = None):
        self.name = name
        self._elements = elements or []

    def dump(self, max_depth: int | None = None) -> str:
        return "window 'Main'\n  button 'OK'\n  textfield 'Search'"

    def locator(self, selector: str) -> _FakeLocator:
        return _FakeLocator(selector, self._elements)


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
    apps = [_FakeApp("Notes"), _FakeApp("Safari")]
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=apps), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen(app_name="Safari")
    assert result["app"] == "Safari"
    assert "button 'OK'" in result["tree"]


def test_read_screen_foreground_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_screen()
    assert result["app"] == "Notes"


def test_read_screen_truncates_large_dump(monkeypatch: pytest.MonkeyPatch):
    class _BigApp(_FakeApp):
        def dump(self, max_depth: int | None = None) -> str:
            return "x" * (cu.MAX_DUMP_CHARS + 100)

    monkeypatch.setattr(
        cu, "xa11y", _make_xa11y(apps=[_BigApp("Big")]), raising=False
    )
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
            cbs["computer"](action="act", selector="button", do="press")
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
            cbs["computer"](action="act", selector="button", do="press")
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
    result = asyncio.run(cbs["computer"](action="act", selector="button", do="press"))
    parsed = json.loads(result)
    assert parsed["ok"] is True
    assert not [e for e in events if e["kind"] == "permission"]


def test_preset_allow_computer_flag_skips_dialog(tool_env):
    """«Always allow» کاربر: پرچم computer از ابتدای turn ست شده (از طریق
    allow_computer در درخواست چت) → هیچ دیالوگی نمایش داده نمی‌شود."""
    cbs, events, _gates, permit = tool_env
    # شبیه‌سازی allow_computer=True که server از UI دریافت می‌کند
    permit["computer"] = True
    result = asyncio.run(
        cbs["computer"](action="input", do="type_text", text="hello")
    )
    parsed = json.loads(result)
    assert parsed["ok"] is True
    assert not [e for e in events if e["kind"] == "permission"]


def test_input_needs_permission(tool_env):
    cbs, events, gates, _permit = tool_env

    async def _run():
        task = asyncio.ensure_future(
            cbs["computer"](action="input", do="click", x=5, y=5)
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
    result = cu.open_app("Google Chrome")
    assert result["ok"] is True
    # osascript با نام اپ درست صدا زده شود
    assert any(
        "osascript" in r[0] and "Google Chrome" in r[2] for r in runs
    )


def test_read_element_subtree(monkeypatch: pytest.MonkeyPatch):
    field = _FakeElement("group", "Container")
    app = _FakeApp("Notes", elements=[field])

    class _TreeLocator(_FakeLocator):
        def tree(self, max_depth: int | None = None) -> dict:
            return {
                "role": "group",
                "name": "Container",
                "value": "",
                "children": [
                    {"role": "button", "name": "OK", "value": "", "children": []},
                    {"role": "textfield", "name": "Search", "value": "q", "children": []},
                ],
            }

    app.locator = lambda sel: _TreeLocator(sel, [field])  # type: ignore[method-assign]
    monkeypatch.setattr(cu, "xa11y", _make_xa11y(apps=[app]), raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.read_element(selector="group", app_name="Notes")
    assert result["ok"] != "error" if "ok" in result else True
    assert "button" in result["tree"]
    assert "textfield" in result["tree"]
    assert "value='q'" in result["tree"]


def test_screenshot_to_data_uri():
    uri = cu.screenshot_to_data_uri(b"\x89PNG fake")
    assert uri.startswith("data:image/png;base64,")


def test_capture_screenshot_full(monkeypatch: pytest.MonkeyPatch):
    class _Shot:
        width = 100
        height = 50
        legend: ClassVar[list] = []

        def to_png(self):
            return b"\x89PNG fake"

    mod = _make_xa11y()
    mod.screenshot = lambda **kw: _Shot()  # type: ignore[attr-defined]
    monkeypatch.setattr(cu, "xa11y", mod, raising=False)
    monkeypatch.setattr(cu, "_XA11Y_AVAILABLE", True)
    result = cu.capture_screenshot()
    assert result["ok"] is True
    assert result["data_uri"].startswith("data:image/png;base64,")
    assert result["width"] == 100


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
