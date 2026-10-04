"""Unit tests for the shared in-app browser session (browser_session).

No real Chromium is launched: the module-level ``_page`` is swapped for a fake
so viewport resizing and virtual-cursor movement can be asserted cheaply.
"""

import asyncio

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
