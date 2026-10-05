"""Unit tests for the per-chat in-app browser sessions (browser_session).

No real Chromium is launched: per-chat ``_sessions`` entries are swapped for
fakes so viewport resizing, virtual-cursor movement and search fallback can
be asserted cheaply.
"""

import asyncio
from typing import ClassVar

import browser_session


class _FakeMouse:
    def __init__(self):
        self.moves: list[tuple[float, float]] = []

    async def move(self, x: float, y: float) -> None:
        self.moves.append((x, y))

    async def click(self, x: float, y: float) -> None:
        self.moves.append((x, y))

    async def wheel(self, dx: float, dy: float) -> None:
        self.moves.append((dx, dy))


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

    async def content(self) -> str:
        return "<html><body>results</body></html>"


def _install_page(page, chat_id: str | None = None):
    """Put a fake page into the per-chat session registry."""
    browser_session._sessions.clear()
    key = browser_session._normalize_chat(chat_id)
    sess = browser_session._get(key)
    sess.page = page
    return key


def test_set_viewport_clamps_and_move_drives_virtual_cursor():
    """Device presets are clamped to a safe range and mouse moves are routed
    to the page API (virtual cursor), never to the real input stack."""
    page = _FakePage()
    _install_page(page)

    async def _run():
        out = await browser_session.set_viewport(10, 999999)
        assert out["ok"] is True
        assert page.sizes == [{"width": 200, "height": 4320}]
        assert out["viewport"] == {"width": 200, "height": 4320}

        moved = await browser_session.move(12, 34)
        assert moved["ok"] is True
        assert page.mouse.moves == [(12.0, 34.0)]

    asyncio.run(_run())


def test_controls_error_out_when_session_is_down():
    """With no live page every control returns a structured error instead of
    raising (the panel shows the message, the HTTP API never 500s)."""
    browser_session._sessions.clear()

    async def _run():
        assert (await browser_session.set_viewport(800, 600))["ok"] is False
        assert (await browser_session.move(1, 2))["ok"] is False
        assert (await browser_session.history("reload"))["ok"] is False

    asyncio.run(_run())


def test_sessions_are_isolated_per_chat():
    """Each chat owns its page: actions on chat-a never touch chat-b."""
    browser_session._sessions.clear()
    page_a = _FakePage()
    page_b = _FakePage()
    page_b.url = "https://other.example"
    browser_session._get("chat-a").page = page_a
    browser_session._get("chat-b").page = page_b

    async def _run():
        assert browser_session.is_active("chat-a") is True
        assert browser_session.is_active("chat-b") is True
        assert browser_session.is_active("chat-c") is False
        out = await browser_session.set_viewport(900, 700, "chat-a")
        assert out["ok"] is True
        assert page_a.sizes == [{"width": 900, "height": 700}]
        assert page_b.sizes == []
        moved = await browser_session.move(5, 6, "chat-b")
        assert moved["ok"] is True
        assert page_b.mouse.moves == [(5.0, 6.0)]
        assert page_a.mouse.moves == []
        st_a = browser_session.status("chat-a")
        st_b = browser_session.status("chat-b")
        assert st_a["url"] == "https://example.com"
        assert st_b["url"] == "https://other.example"
        assert st_a["chat"] == "chat-a"
        assert st_b["chat"] == "chat-b"

    asyncio.run(_run())
    browser_session._sessions.clear()


def test_normalize_chat_falls_back_to_default():
    assert browser_session._normalize_chat(None) == "default"
    assert browser_session._normalize_chat("") == "default"
    assert browser_session._normalize_chat("  ") == "default"
    assert browser_session._normalize_chat("chat-a") == "chat-a"


def test_profile_dir_is_per_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path))
    default = browser_session._profile_dir(None)
    other = browser_session._profile_dir("chat-a")
    assert default.name == "browser-profile"
    assert other.parent == default
    assert "chat-a" in other.name
    assert browser_session._profile_dir("chat-a") == other


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

    monkeypatch.setattr(browser_session, "_profile_dir", lambda chat=None: tmp_path)

    async def _run():
        try:
            await browser_session._launch_browser(_PW(), "chat-a")
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

    browser_session._sessions.clear()
    sess = browser_session._get("chat-a")
    sess.page = _HalfDeadPage()
    sess.context = None
    sess.browser = None
    sess.pw = None
    monkeypatch.setattr(browser_session, "_profile_dir", lambda chat=None: tmp_path)
    monkeypatch.setattr(browser_session, "_pid_alive", lambda pid: alive["v"])
    monkeypatch.setattr(browser_session.os, "kill", _kill)

    asyncio.run(browser_session._force_close("chat-a"))

    assert killed == [424242]
    assert not lock.is_symlink()
    assert sess.page is None  # state reset
    browser_session._sessions.clear()


def test_force_clear_reaps_live_owner_on_our_profile(tmp_path, monkeypatch):
    """force=True reaps a LIVE non-orphaned holder verified on our profile.

    The relaunch scenario: a runaway chrome from a half-failed close still
    holds the lock (alive, parented to us, so NOT orphaned) while this
    sidecar has no live session. Launch passes force=True because any holder
    on our profile is then stale by construction."""
    lock = tmp_path / "SingletonLock"
    lock.symlink_to("codifa-424242")
    killed: list[int] = []
    alive = {"v": True}

    def _kill(pid, sig):
        killed.append(pid)
        alive["v"] = False

    monkeypatch.setattr(browser_session, "_pid_alive", lambda pid: alive["v"])
    monkeypatch.setattr(browser_session, "_pid_orphaned", lambda pid: False)
    monkeypatch.setattr(
        browser_session, "_pid_uses_profile", lambda pid, prof: True
    )
    monkeypatch.setattr(browser_session.os, "kill", _kill)
    browser_session._clear_stale_profile_lock(tmp_path, force=True)
    assert killed == [424242]
    assert not lock.is_symlink()


def test_force_clear_never_kills_recycled_pid(tmp_path, monkeypatch):
    """force=True never kills a live pid that is NOT on our profile.

    Pids get recycled: the lock stores only a number, which may now belong
    to an unrelated process. The stale files are still removed (no live
    chrome holds the profile), but the innocent process must survive."""
    lock = tmp_path / "SingletonLock"
    lock.symlink_to("codifa-424242")
    killed: list[int] = []
    monkeypatch.setattr(browser_session, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(browser_session, "_pid_orphaned", lambda pid: False)
    monkeypatch.setattr(
        browser_session, "_pid_uses_profile", lambda pid, prof: False
    )
    monkeypatch.setattr(
        browser_session.os, "kill", lambda pid, sig: killed.append(pid)
    )
    browser_session._clear_stale_profile_lock(tmp_path, force=True)
    assert killed == []
    assert not lock.is_symlink()


def test_pid_uses_profile_false_when_ps_fails(tmp_path, monkeypatch):
    """Unverifiable pid is treated as NOT ours: never kill blindly."""

    def _boom(*_a, **_k):
        raise RuntimeError("no ps here")

    monkeypatch.setattr(browser_session.subprocess, "run", _boom)
    assert browser_session._pid_uses_profile(424242, tmp_path) is False


class _SearchPage:
    """Scripted goto() stand-in — each call consumes one scripted outcome.

    Outcomes: ("error", msg) raises, ("http", code) returns that status, and
    ("ok", final_url) lands on final_url with HTTP 200. Content defaults to
    a plain results page unless ("ok-html", (url, html)) is used.
    """

    class _Resp:
        def __init__(self, status: int):
            self.status = status

    def __init__(self, script):
        self._script = list(script)
        self.url = "about:blank"
        self.calls: list[str] = []
        self._html = "<html><body>results</body></html>"

    def is_closed(self) -> bool:
        return False

    async def goto(self, url: str, **_kw):
        self.calls.append(url)
        kind, value = self._script.pop(0)
        if kind == "error":
            raise RuntimeError(value)
        if kind == "ok-html":
            final_url, html = value
            self.url = final_url
            self._html = html
        else:
            self.url = value if kind == "ok" else url
        return self._Resp(value if kind == "http" else 200)

    async def content(self) -> str:
        return self._html


async def _no_sleep(_delay: float) -> None:
    return None


def test_search_google_first_then_bing_fallback(monkeypatch):
    """Omnibox searches hit Google first; a failed Google goto falls to Bing."""
    import asyncio as _asyncio

    page = _SearchPage(
        [("error", "net down"), ("ok", "https://www.bing.com/search?q=hello+world")]
    )
    _install_page(page)
    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)

    async def _run():
        out = await browser_session.search("hello world")
        assert out["ok"] is True and out["engine"] == "bing"
        assert "google.com/search?q=hello+world" in page.calls[0]
        assert "hl=en" in page.calls[0]
        assert "bing.com/search?q=hello+world" in page.calls[1]

    asyncio.run(_run())

    # Happy path: Google answers → no fallback at all.
    ok_page = _SearchPage([("ok", "https://www.google.com/search?q=hello+world")])
    _install_page(ok_page)

    async def _run_ok():
        out = await browser_session.search("hello world")
        assert out["ok"] is True and out["engine"] == "google"
        assert len(ok_page.calls) == 1

    asyncio.run(_run_ok())
    browser_session._sessions.clear()


def test_search_blocked_google_and_total_failure(monkeypatch):
    """A consent/CAPTCHA wall or HTTP error counts as "Google failed"; when
    every engine is down the error names them instead of raising."""
    import asyncio as _asyncio

    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)
    page = _SearchPage(
        [
            ("ok", "https://consent.google.com/m?continue=hello"),
            ("http", 500),
            ("ok", "https://duckduckgo.com/?q=hello+world"),
        ]
    )
    _install_page(page)
    out = asyncio.run(browser_session.search("hello world"))
    assert out["ok"] is True and out["engine"] == "duckduckgo"
    assert len(page.calls) == 3  # google → bing → duckduckgo

    dead = _SearchPage([("error", "down"), ("error", "down"), ("error", "down")])
    _install_page(dead)
    out = asyncio.run(browser_session.search("x"))
    assert out["ok"] is False
    assert "google" in out["error"] and "duckduckgo" in out["error"]

    # Content-level captcha wall (URL looks fine, body is a sorry page).
    captcha = _SearchPage(
        [
            ("ok-html", ("https://www.google.com/search?q=hi", "<html>recaptcha challenge</html>")),
            ("ok", "https://www.bing.com/search?q=hi"),
        ]
    )
    _install_page(captcha)
    out = asyncio.run(browser_session.search("hi"))
    assert out["ok"] is True and out["engine"] == "bing"

    # Empty query never touches the page.
    untouched = _SearchPage([])
    _install_page(untouched)
    assert asyncio.run(browser_session.search("   "))["ok"] is False
    assert untouched.calls == []
    browser_session._sessions.clear()


def test_search_uses_per_chat_session(monkeypatch):
    """Search runs on the calling chat's page, not the shared default."""
    import asyncio as _asyncio

    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)
    browser_session._sessions.clear()
    page_a = _SearchPage([("ok", "https://www.google.com/search?q=a")])
    page_b = _SearchPage([("ok", "https://www.google.com/search?q=b")])
    browser_session._get("chat-a").page = page_a
    browser_session._get("chat-b").page = page_b
    out_a = asyncio.run(browser_session.search("a", "chat-a"))
    out_b = asyncio.run(browser_session.search("b", "chat-b"))
    assert out_a["ok"] is True and len(page_a.calls) == 1
    assert out_b["ok"] is True and len(page_b.calls) == 1
    browser_session._sessions.clear()


def test_history_actions_drive_page_api():
    """back/forward/reload map onto Playwright page methods with
    wait_until='commit'; an unknown action errors without touching the page."""
    page = _FakePage()
    _install_page(page)

    async def _run():
        for action in ("back", "forward", "reload"):
            out = await browser_session.history(action)
            assert out["ok"] is True, out
        assert page.history_calls == ["go_back", "go_forward", "reload"]

        bad = await browser_session.history("sideways")
        assert bad["ok"] is False and "unknown history action" in bad["error"]
        assert page.history_calls == ["go_back", "go_forward", "reload"]

    asyncio.run(_run())
    browser_session._sessions.clear()
