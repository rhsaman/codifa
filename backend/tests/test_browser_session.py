"""Unit tests for the per-chat in-app browser sessions (browser_session).

No real Chromium is launched: per-chat ``_sessions`` entries are swapped for
fakes so viewport resizing, virtual-cursor movement and search fallback can
be asserted cheaply.
"""

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    """A failed sweep keeps every channel error and tries bundled Chromium
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
            assert _Chromium.order[0] == "bundled"
        else:
            raise AssertionError("expected RuntimeError")

    asyncio.run(_run())


def test_missing_bundled_error_detection():
    """Only a missing executable triggers the auto-install path."""
    assert browser_session._is_missing_bundled_error(
        RuntimeError("Executable doesn't exist at /cache/ms-playwright")
    )
    assert browser_session._is_missing_bundled_error(
        RuntimeError("Please run `playwright install chromium`")
    )
    assert not browser_session._is_missing_bundled_error(
        RuntimeError("ProcessSingleton: profile locked")
    )


def test_launch_missing_bundled_falls_through_to_chrome(monkeypatch, tmp_path):
    """A missing bundled build kicks a background install and uses system
    Chrome immediately — the launch never waits on the download."""
    installs = {"n": 0}

    def _fake_ensure():
        installs["n"] += 1
        return False

    monkeypatch.setattr(browser_session, "_ensure_bundled_chromium", _fake_ensure)
    monkeypatch.setattr(browser_session, "_profile_dir", lambda chat=None: tmp_path)
    order: list[str] = []
    sentinel = object()

    class _Chromium:
        async def launch_persistent_context(self, **kw):
            order.append(kw.get("channel", "bundled"))
            if not kw.get("channel"):
                raise RuntimeError("Executable doesn't exist - run playwright install")
            return sentinel

    class _PW:
        chromium = _Chromium()

    assert asyncio.run(browser_session._launch_browser(_PW(), "chat-a")) is sentinel
    assert installs["n"] == 1
    assert order == ["bundled", "chrome"]


def test_ensure_bundled_chromium_only_once(monkeypatch):
    """The background install is kicked off at most once per process."""
    monkeypatch.setattr(browser_session, "_CHROMIUM_INSTALL_ATTEMPTED", False)
    created = {"n": 0}

    class _Loop:
        def create_task(self, coro):
            created["n"] += 1
            coro.close()
            return object()

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: _Loop())
    assert browser_session._ensure_bundled_chromium() is False
    assert created["n"] == 1
    assert browser_session._ensure_bundled_chromium() is False
    assert created["n"] == 1


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


def test_search_google_human_path_types_query(monkeypatch):
    """Google is driven like a human (homepage -> type -> Enter): the direct
    /search?q= URL is never fetched when the human path succeeds."""
    import asyncio as _asyncio

    class _HumanPage:
        def __init__(self):
            self.url = "about:blank"
            self.calls: list[str] = []
            self.typed = ""
            self._html = "<html><body>results</body></html>"

        def is_closed(self) -> bool:
            return False

        def locator(self, _sel: str):
            return self

        async def goto(self, url: str, **_kw):
            self.calls.append(url)
            self.url = url

        async def click(self, **_kw):
            return None

        async def fill(self, _text: str, **_kw):
            return None

        async def press_sequentially(self, text: str, **_kw):
            self.typed += text

        async def press(self, key: str, **_kw):
            if key == "Enter":
                self.url = "https://www.google.com/search?q=hello+world"

        async def wait_for_load_state(self, *_a, **_kw):
            return None

        async def content(self) -> str:
            return self._html

    page = _HumanPage()
    _install_page(page)
    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)
    out = asyncio.run(browser_session.search("hello world"))
    assert out["ok"] is True and out["engine"] == "google"
    assert page.typed == "hello world"
    assert page.calls == ["https://www.google.com/"]
    browser_session._sessions.clear()


def test_launch_uses_new_headless_without_window(monkeypatch, tmp_path):
    """Full-build new headless mode: no OS window, far fewer bot tells."""
    monkeypatch.setattr(browser_session, "_profile_dir", lambda chat=None: tmp_path)
    seen: dict = {}
    sentinel = object()

    class _Chromium:
        async def launch_persistent_context(self, **kw):
            seen["headless"] = kw.get("headless")
            seen["args"] = list(kw.get("args") or [])
            return sentinel

    class _PW:
        chromium = _Chromium()

    assert asyncio.run(browser_session._launch_browser(_PW(), "chat-a")) is sentinel
    assert seen["headless"] is False
    assert "--headless=new" in seen["args"]
    assert "--disable-blink-features=AutomationControlled" in seen["args"]


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


def _reset_idle_state():
    browser_session._sessions.clear()
    browser_session._open_chats.clear()
    browser_session._last_used.clear()
    for handle in list(browser_session._evict_timers.values()):
        try:
            handle.cancel()
        except Exception:
            pass
    browser_session._evict_timers.clear()


def test_idle_evict_closes_only_closed_chats(monkeypatch):
    """Closed idle chats are reaped; open chats are exempt from eviction."""
    import time as _time

    _reset_idle_state()
    page_open = _FakePage()
    page_closed = _FakePage()
    browser_session._get("chat-open").page = page_open
    browser_session._get("chat-closed").page = page_closed
    browser_session.set_open_chats(["chat-open"])
    stale = _time.monotonic() - browser_session._BROWSER_IDLE_EVICT_S - 1
    browser_session._last_used["chat-open"] = stale
    browser_session._last_used["chat-closed"] = stale
    closed: list[str] = []

    async def _fake_close(chat_id=None):
        key = browser_session._normalize_chat(chat_id)
        closed.append(key)
        sess = browser_session._sessions.get(key)
        if sess is not None:
            sess.page = None
            sess.context = None
            sess.browser = None
            sess.pw = None

    monkeypatch.setattr(browser_session, "_force_close", _fake_close)
    try:
        assert asyncio.run(browser_session._evict_if_idle("chat-open")) is False
        assert browser_session._get("chat-open").page is page_open
        assert closed == []
        assert asyncio.run(browser_session._evict_if_idle("chat-closed")) is True
        assert closed == ["chat-closed"]
    finally:
        _reset_idle_state()


def test_recent_use_prevents_idle_evict(monkeypatch):
    """A recently used closed chat stays alive until the window passes."""
    import time as _time

    _reset_idle_state()
    page = _FakePage()
    browser_session._get("chat-a").page = page
    browser_session.set_open_chats([])
    closed: list[str] = []

    async def _fake_close(chat_id=None):
        closed.append(browser_session._normalize_chat(chat_id))

    monkeypatch.setattr(browser_session, "_force_close", _fake_close)
    try:
        browser_session._last_used["chat-a"] = _time.monotonic()
        assert asyncio.run(browser_session._evict_if_idle("chat-a")) is False
        assert closed == []
        browser_session._last_used["chat-a"] = (
            _time.monotonic() - browser_session._BROWSER_IDLE_EVICT_S - 1
        )
        assert asyncio.run(browser_session._evict_if_idle("chat-a")) is True
        assert closed == ["chat-a"]
    finally:
        _reset_idle_state()
    browser_session._sessions.clear()


def test_idle_evict_reaps_open_chat_after_long_window(monkeypatch):
    """Open chats are no longer exempt forever: past _OPEN_IDLE_EVICT_S of no
    real use the session is closed too (an opened-then-forgotten chat must not
    pin a Chromium indefinitely). Within the window it stays alive."""
    import time as _time

    _reset_idle_state()
    page = _FakePage()
    browser_session._get("chat-open").page = page
    browser_session.set_open_chats(["chat-open"])
    closed: list[str] = []

    async def _fake_close(chat_id=None):
        key = browser_session._normalize_chat(chat_id)
        closed.append(key)
        sess = browser_session._sessions.get(key)
        if sess is not None:
            sess.page = None
            sess.context = None
            sess.browser = None
            sess.pw = None

    monkeypatch.setattr(browser_session, "_force_close", _fake_close)
    try:
        # 11 idle minutes: beyond the closed-chat window but within the
        # open-chat window — still alive.
        browser_session._last_used["chat-open"] = (
            _time.monotonic() - browser_session._BROWSER_IDLE_EVICT_S - 1
        )
        assert asyncio.run(browser_session._evict_if_idle("chat-open")) is False
        assert browser_session._get("chat-open").page is page
        assert closed == []
        # Past the open-chat window: reaped.
        browser_session._last_used["chat-open"] = (
            _time.monotonic() - browser_session._OPEN_IDLE_EVICT_S - 1
        )
        assert asyncio.run(browser_session._evict_if_idle("chat-open")) is True
        assert closed == ["chat-open"]
    finally:
        _reset_idle_state()


def test_status_poll_touches_session():
    """A visible panel polls /browser/status every ~1.2s; that counts as real
    use and refreshes the idle clock so a watched browser is never closed."""
    _reset_idle_state()
    page = _FakePage()
    key = _install_page(page, "chat-watch")

    async def _run():
        browser_session._last_used[key] = 0.0
        browser_session.status(key)
        assert browser_session._last_used[key] > 0.0

    asyncio.run(_run())
    _reset_idle_state()


def test_open_chat_addition_arms_timer_for_active_session(monkeypatch):
    """Reporting an open chat must (re)arm the eviction timer for a live
    session — cancelling alone would leave it exempt forever."""
    _reset_idle_state()
    page = _FakePage()
    browser_session._get("chat-late").page = page
    fired: list[str] = []

    class _FakeHandle:
        def cancel(self):
            pass

    async def _run():
        loop = asyncio.get_running_loop()
        real_call_later = loop.call_later

        def _fake_call_later(delay, cb, key):
            fired.append((key, delay))
            return _FakeHandle()

        monkeypatch.setattr(loop, "call_later", _fake_call_later)
        try:
            browser_session.set_open_chats(["chat-late"])
        finally:
            monkeypatch.setattr(loop, "call_later", real_call_later)

    try:
        asyncio.run(_run())
        # Armed once, with the LONGER open-chat window (30 min), not 10.
        assert fired == [("chat-late", browser_session._OPEN_IDLE_EVICT_S)]
    finally:
        _reset_idle_state()


class _DevToolsHandler(BaseHTTPRequestHandler):
    """Mimics Chromium's DevTools HTTP server: /json/list advertises the
    appspot-style ABSOLUTE https frontend, while the bundled inspector is
    (optionally) served from the debugging port itself."""

    serve_inspector: ClassVar[bool] = True
    advertise_port: ClassVar[int] = 0

    def do_GET(self) -> None:
        if self.path == "/json/list":
            front = (
                f"http://127.0.0.1:{_DevToolsHandler.advertise_port}"
                "/inspector-remote.html?ws=127.0.0.1:9/devtools/page/ABC"
            )
            body = json.dumps(
                [{"type": "page", "devtoolsFrontendUrl": front}]
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/devtools/inspector.html"):
            if _DevToolsHandler.serve_inspector:
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")
            else:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
        elif self.path.startswith("/inspector-remote.html"):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, *args) -> None:  # keep test output quiet
        pass


def _start_devtools_stub():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _DevToolsHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_devtools_url_prefers_the_bundled_inspector(monkeypatch):
    """The local http:// inspector wins over the advertised https frontend —
    an https page cannot open the loopback ws:// socket (mixed content)."""
    _install_page(_FakePage(), "c1")
    srv = _start_devtools_stub()
    _DevToolsHandler.advertise_port = srv.server_address[1]
    monkeypatch.setattr(
        browser_session, "cdp_endpoint", lambda chat=None: f"http://127.0.0.1:{srv.server_address[1]}"
    )
    try:
        out = asyncio.run(browser_session.devtools_url("c1"))
        assert out["ok"] is True
        assert out["url"] == (
            f"http://127.0.0.1:{srv.server_address[1]}"
            "/devtools/inspector.html?ws=127.0.0.1:9/devtools/page/ABC"
        )

        # Bundled inspector dropped by the build → fall back to the
        # advertised frontend, still absolute and verified.
        _DevToolsHandler.serve_inspector = False
        out = asyncio.run(browser_session.devtools_url("c1"))
        assert out["ok"] is True
        assert out["url"] == (
            f"http://127.0.0.1:{srv.server_address[1]}"
            "/inspector-remote.html?ws=127.0.0.1:9/devtools/page/ABC"
        )
    finally:
        _DevToolsHandler.serve_inspector = True
        srv.shutdown()
        srv.server_close()


def test_devtools_url_errors_when_no_frontend_is_served(monkeypatch):
    """Neither frontend reachable → readable error instead of a white tab."""
    _install_page(_FakePage(), "c1")
    _DevToolsHandler.serve_inspector = False
    _DevToolsHandler.advertise_port = 1  # nothing listens there → connection error
    monkeypatch.setattr(
        browser_session, "cdp_endpoint", lambda chat=None: "http://127.0.0.1:1"
    )
    try:
        out = asyncio.run(browser_session.devtools_url("c1"))
        assert out["ok"] is False
        assert out["error"]
    finally:
        _DevToolsHandler.serve_inspector = True


def test_devtools_url_needs_a_live_session():
    """With no page there is nothing to inspect — structured error."""
    browser_session._sessions.clear()
    out = asyncio.run(browser_session.devtools_url("c1"))
    assert out["ok"] is False
    assert "not running" in out["error"]
