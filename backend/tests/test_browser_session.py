"""Unit tests for the shared in-app browser session (browser_session).

No real Chromium is launched: the module-level ``_page`` is swapped for a fake
so viewport resizing and virtual-cursor movement can be asserted cheaply.
"""

import asyncio
from typing import ClassVar

import browser_session


class _FakeMouse:
    def __init__(self):
        self.moves: list[tuple[float, float]] = []

    async def move(self, x: float, y: float) -> None:
        self.moves.append((x, y))


class _FakePage:
    """Stand-in for Playwright's async Page used by set_viewport/move."""

    def __init__(self) -> None:
        self.url = "https://example.com"
        self.viewport_size = {"width": 1280, "height": 800}
        self.sizes: list[dict] = []
        self.mouse = _FakeMouse()
        self.history_calls: list[str] = []

    def is_closed(self) -> bool:
        return False

    async def set_viewport_size(self, size: dict) -> None:
        self.sizes.append(dict(size))
        self.viewport_size = dict(size)

    async def go_back(self, **_kwargs) -> None:
        self.history_calls.append("go_back")

    async def go_forward(self, **_kwargs) -> None:
        self.history_calls.append("go_forward")

    async def reload(self, **_kwargs) -> None:
        self.history_calls.append("reload")


def test_set_viewport_clamps_and_move_drives_virtual_cursor(monkeypatch):
    """Device presets are clamped to a safe range and mouse moves are routed
    to the page API (virtual cursor), never to the real input stack."""
    page = _FakePage()
    monkeypatch.setattr(browser_session, "_page", page)

    async def _run():
        out = await browser_session.set_viewport(10, 999999)
        assert out["ok"] is True
        assert page.sizes == [{"width": 200, "height": 4320}]
        assert out["viewport"] == {"width": 200, "height": 4320}

        moved = await browser_session.move(12, 34)
        assert moved["ok"] is True
        assert page.mouse.moves == [(12.0, 34.0)]

    asyncio.run(_run())


def test_controls_error_out_when_session_is_down(monkeypatch):
    """With no live page every control returns a structured error instead of
    raising (the panel shows the message, the HTTP API never 500s)."""
    monkeypatch.setattr(browser_session, "_page", None)

    async def _run():
        assert (await browser_session.set_viewport(800, 600))["ok"] is False
        assert (await browser_session.move(1, 2))["ok"] is False
        assert (await browser_session.history("reload"))["ok"] is False

    asyncio.run(_run())


def test_stale_profile_lock_detection_and_clear(tmp_path):
    """A SingletonLock whose owner process died is stale: detected and
    cleared. A LIVE owner's lock is never touched (never delete blindly)."""
    import os

    lock = tmp_path / "SingletonLock"
    # Dead owner: a pid far above any real macOS/Linux pid range.
    lock.symlink_to(f"codifa-{2**30 + 7}")
    assert browser_session._stale_profile_lock(tmp_path) is True
    browser_session._clear_stale_profile_lock(tmp_path)
    assert not lock.is_symlink()  # stale lock removed

    # Live owner (this very process) — must survive the cleanup.
    lock.symlink_to(f"codifa-{os.getpid()}")
    assert browser_session._stale_profile_lock(tmp_path) is False
    browser_session._clear_stale_profile_lock(tmp_path)
    assert lock.is_symlink()  # untouched


def test_launch_reports_every_channel_error(monkeypatch, tmp_path):
    """A failed sweep keeps every channel error and tries system Chrome
    first (no msedge probe: its not-found noise buries the real cause)."""

    class _Chromium:
        order: ClassVar[list] = []

        async def launch_persistent_context(self, **kw):
            type(self).order.append(kw.get("channel", "bundled"))
            raise RuntimeError("boom " + str(kw.get("channel", "bundled")))

    class _PW:
        chromium = _Chromium()

    monkeypatch.setattr(browser_session, "_profile_dir", lambda: tmp_path)

    async def _run():
        try:
            await browser_session._launch_browser(_PW())
        except RuntimeError as exc:
            msg = str(exc)
            assert "chrome: boom chrome" in msg
            assert "bundled: boom bundled" in msg
            assert "msedge" not in msg
            assert _Chromium.order[0] == "chrome"
        else:
            raise AssertionError("expected RuntimeError")

    asyncio.run(_run())


def test_lock_reap_only_touches_dead_or_orphaned_owners(tmp_path, monkeypatch):
    """A live non-orphaned owner (another running instance) is kept; an
    orphaned zombie (ppid 1) is killed and the lock cleared."""
    import os

    lock = tmp_path / "SingletonLock"

    # Live, non-orphaned owner — untouched.
    lock.symlink_to(f"codifa-{os.getpid()}")
    monkeypatch.setattr(browser_session, "_pid_orphaned", lambda pid: False)
    browser_session._clear_stale_profile_lock(tmp_path)
    assert lock.is_symlink()

    # Orphaned zombie — reaped (kill recorded) and the lock removed.
    lock.unlink()
    lock.symlink_to("codifa-424242")
    killed: list[int] = []
    alive = {"v": True}

    def _kill(pid, sig):
        killed.append(pid)
        alive["v"] = False

    monkeypatch.setattr(browser_session, "_pid_orphaned", lambda pid: True)
    monkeypatch.setattr(browser_session, "_pid_alive", lambda pid: alive["v"])
    monkeypatch.setattr(browser_session.os, "kill", _kill)
    browser_session._clear_stale_profile_lock(tmp_path)
    assert killed == [424242]
    assert not lock.is_symlink()


def test_force_close_reaps_surviving_browser(monkeypatch, tmp_path):
    """A chrome that survives context.close() keeps the profile lock —
    _force_close must reap it (and clear the lock) so relaunch works."""
    lock = tmp_path / "SingletonLock"
    lock.symlink_to("codifa-424242")

    class _HalfDeadPage:
        async def close(self):
            raise RuntimeError("context close half-failed")

    killed: list[int] = []
    alive = {"v": True}

    def _kill(pid, sig):
        killed.append(pid)
        alive["v"] = False

    monkeypatch.setattr(browser_session, "_page", _HalfDeadPage())
    monkeypatch.setattr(browser_session, "_context", None)
    monkeypatch.setattr(browser_session, "_browser", None)
    monkeypatch.setattr(browser_session, "_pw_instance", None)
    monkeypatch.setattr(browser_session, "_profile_dir", lambda: tmp_path)
    monkeypatch.setattr(browser_session, "_pid_alive", lambda pid: alive["v"])
    monkeypatch.setattr(browser_session.os, "kill", _kill)

    asyncio.run(browser_session._force_close())

    assert killed == [424242]
    assert not lock.is_symlink()
    assert browser_session._page is None  # state reset


class _SearchPage:
    """Scripted goto() stand-in — each call consumes one scripted outcome.

    Outcomes: ("error", msg) raises, ("http", code) returns that status, and
    ("ok", final_url) lands on final_url with HTTP 200.
    """

    class _Resp:
        def __init__(self, status: int):
            self.status = status

    def __init__(self, script):
        self._script = list(script)
        self.url = "about:blank"
        self.calls: list[str] = []

    def is_closed(self) -> bool:
        return False

    async def goto(self, url: str, **_kw):
        self.calls.append(url)
        kind, value = self._script.pop(0)
        if kind == "error":
            raise RuntimeError(value)
        self.url = value if kind == "ok" else url
        return self._Resp(value if kind == "http" else 200)


def test_search_google_first_then_bing_fallback(monkeypatch):
    """Omnibox searches hit Google first; a failed Google goto falls to Bing."""
    page = _SearchPage(
        [("error", "net down"), ("ok", "https://www.bing.com/search?q=hello+world")]
    )
    monkeypatch.setattr(browser_session, "_page", page)

    async def _run():
        out = await browser_session.search("hello world")
        assert out["ok"] is True and out["engine"] == "bing"
        assert "google.com/search?q=hello+world" in page.calls[0]
        assert "bing.com/search?q=hello+world" in page.calls[1]

    asyncio.run(_run())

    # Happy path: Google answers → no fallback at all.
    ok_page = _SearchPage([("ok", "https://www.google.com/search?q=hello+world")])
    monkeypatch.setattr(browser_session, "_page", ok_page)
    out = asyncio.run(browser_session.search("hello world"))
    assert out["ok"] is True and out["engine"] == "google"
    assert len(ok_page.calls) == 1


def test_search_blocked_google_and_total_failure(monkeypatch):
    """A consent/CAPTCHA wall or HTTP error counts as "Google failed"; when
    every engine is down the error names them instead of raising."""
    page = _SearchPage(
        [
            ("ok", "https://consent.google.com/m?continue=hello"),
            ("http", 500),
            ("ok", "https://duckduckgo.com/?q=hello+world"),
        ]
    )
    monkeypatch.setattr(browser_session, "_page", page)
    out = asyncio.run(browser_session.search("hello world"))
    assert out["ok"] is True and out["engine"] == "duckduckgo"
    assert len(page.calls) == 3  # google → bing → duckduckgo

    dead = _SearchPage([("error", "down"), ("error", "down"), ("error", "down")])
    monkeypatch.setattr(browser_session, "_page", dead)
    out = asyncio.run(browser_session.search("x"))
    assert out["ok"] is False
    assert "google" in out["error"] and "duckduckgo" in out["error"]

    # Empty query never touches the page.
    untouched = _SearchPage([])
    monkeypatch.setattr(browser_session, "_page", untouched)
    assert asyncio.run(browser_session.search("   "))["ok"] is False
    assert untouched.calls == []


def test_history_actions_drive_page_api(monkeypatch):
    """back/forward/reload map onto Playwright page methods with
    wait_until='commit'; an unknown action errors without touching the page."""
    page = _FakePage()
    monkeypatch.setattr(browser_session, "_page", page)

    async def _run():
        for action in ("back", "forward", "reload"):
            out = await browser_session.history(action)
            assert out["ok"] is True, out
        assert page.history_calls == ["go_back", "go_forward", "reload"]

        bad = await browser_session.history("sideways")
        assert bad["ok"] is False and "unknown history action" in bad["error"]
        assert page.history_calls == ["go_back", "go_forward", "reload"]

    asyncio.run(_run())
