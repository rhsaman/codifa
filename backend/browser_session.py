"""Shared in-app browser session (Playwright).

One headless Chromium backs both the right-side Browser panel (live JPEG
frames + virtual clicks served over HTTP by ``server.py``) and the agent's
Playwright MCP server: ``mcp_bridge`` starts ``@playwright/mcp`` with
``--cdp-endpoint`` pointed at this session's remote-debugging port, so both
sides drive the SAME browser and no window ever opens outside the app.

The user's real mouse/keyboard are never touched — every input goes through
Playwright's page API. All entry points are safe to call while the session
is down: they return ``{"ok": False, "error": ...}`` instead of raising.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import socket

logger = logging.getLogger("codifa.browser_session")

try:
    from playwright.async_api import async_playwright

    _PW_AVAILABLE = True
except Exception:  # noqa: BLE001 — optional dependency (uv add playwright)
    async_playwright = None  # type: ignore[assignment]
    _PW_AVAILABLE = False

_pw_instance = None
_browser = None
_context = None
_page = None
_lock = asyncio.Lock()

DEFAULT_VIEWPORT = {"width": 1280, "height": 800}

# CDP port for the whole sidecar run — picked lazily once so the Playwright
# MCP config (whose hash must stay stable) keeps pointing at the same
# endpoint across panel close/reopen cycles.
_cdp_port: int | None = None


def _pick_cdp_port() -> int:
    """A free localhost port for the browser's remote-debugging endpoint."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def cdp_endpoint() -> str:
    """HTTP CDP endpoint of this session (stable for the process lifetime)."""
    global _cdp_port
    if _cdp_port is None:
        _cdp_port = _pick_cdp_port()
    return f"http://127.0.0.1:{_cdp_port}"


def is_active() -> bool:
    """True while a live page object exists (never raises)."""
    return _page is not None and not _page.is_closed()


def status() -> dict:
    """Cheap, sync snapshot for GET /browser/status — never raises."""
    active = is_active()
    url = ""
    viewport = dict(DEFAULT_VIEWPORT)
    if active:
        try:
            url = _page.url or ""
            size = _page.viewport_size or viewport
            viewport = {"width": int(size["width"]), "height": int(size["height"])}
        except Exception:  # noqa: BLE001
            active = False
    return {
        "ok": True,
        "active": active,
        "url": url,
        "viewport": viewport,
        "available": _PW_AVAILABLE,
        "cdp": cdp_endpoint() if active else None,
    }


async def _launch_browser(pw):
    """Launch headless Chromium with the remote-debugging port exposed.

    Prefers Playwright's bundled build, then falls back to the system
    Chrome/Edge channel so a machine without ``playwright install`` still
    works — the panel only needs *a* Chromium-family browser.
    """
    port = int(cdp_endpoint().rsplit(":", 1)[1])
    args = [f"--remote-debugging-port={port}"]
    last: Exception | None = None
    for kwargs in ({}, {"channel": "chrome"}, {"channel": "msedge"}):
        try:
            return await pw.chromium.launch(headless=True, args=args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            last = exc
            logger.warning(
                "browser launch via %s failed: %s", kwargs.get("channel", "bundled"), exc
            )
    raise RuntimeError(f"no Chromium available: {last}")


async def launch(url: str = "about:blank") -> dict:
    """Ensure the shared browser is running; navigate only on a real URL.

    Idempotent: an already-running session is left untouched unless ``url``
    is a concrete address. The MCP bridge calls this on every (re)connect
    purely to guarantee the session exists — it must not reset the page the
    agent is working on.
    """
    global _pw_instance, _browser, _context, _page
    if not _PW_AVAILABLE:
        return {"ok": False, "error": "playwright is not installed — run `uv add playwright`"}
    target = (url or "").strip() or "about:blank"
    async with _lock:
        if is_active():
            if target != "about:blank" and target != _page.url:
                try:
                    await _page.goto(target)
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": f"navigation failed: {exc}"}
            return status()
        try:
            _pw_instance = await async_playwright().start()
            _browser = await _launch_browser(_pw_instance)
            # Drive the DEFAULT context/page (not a fresh one): Playwright MCP
            # attaches over CDP to browser.contexts()[0].pages()[0], so sharing
            # that exact page is what makes the panel mirror the agent live.
            _context = _browser.contexts[0] if _browser.contexts else await _browser.new_context()
            _page = _context.pages[0] if _context.pages else await _context.new_page()
            await _page.set_viewport_size(dict(DEFAULT_VIEWPORT))
            await _page.goto(target)
        except Exception as exc:
            logger.exception("browser launch failed")
            await _force_close()
            return {"ok": False, "error": str(exc)}
    return status()


async def screenshot() -> dict:
    """Latest viewport frame as a JPEG data URI for the Browser panel."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            raw = await _page.screenshot(type="jpeg", quality=60)
        size = _page.viewport_size or DEFAULT_VIEWPORT
        return {
            "ok": True,
            "image": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
            "width": int(size["width"]),
            "height": int(size["height"]),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def click(x: int, y: int) -> dict:
    """Virtual click at viewport pixel coordinates — no real mouse involved."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.mouse.click(float(x), float(y))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def type_text(text: str) -> dict:
    """Type text into the focused element inside the virtual browser."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.keyboard.type(text)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def press_key(key: str) -> dict:
    """Press a key (Enter, Tab, Escape, ...) inside the virtual browser."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.keyboard.press(key)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def navigate(url: str) -> dict:
    """Navigate the virtual browser to a URL."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.goto(url)
        return {"ok": True, "url": _page.url}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def scroll(dx: int, dy: int) -> dict:
    """Scroll the virtual browser viewport."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.mouse.wheel(float(dx), float(dy))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def set_viewport(width: int, height: int) -> dict:
    """Resize the shared viewport (responsive presets: desktop/tablet/mobile)."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    w = max(200, min(7680, int(width)))
    h = max(200, min(4320, int(height)))
    try:
        async with _lock:
            await _page.set_viewport_size({"width": w, "height": h})
        return status()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def move(x: int, y: int) -> dict:
    """Move the virtual cursor (hover) without touching the real mouse."""
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    try:
        async with _lock:
            await _page.mouse.move(float(x), float(y))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def history(action: str) -> dict:
    """History control: ``back``, ``forward`` or ``reload``.

    Uses ``wait_until="commit"`` so the call returns as soon as navigation
    starts — the panel refreshes frames through its normal poll instead of
    blocking here. With no history entry Playwright resolves immediately.
    """
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    method = {"back": "go_back", "forward": "go_forward", "reload": "reload"}.get(action)
    if method is None:
        return {"ok": False, "error": f"unknown history action {action!r}"}
    try:
        async with _lock:
            await getattr(_page, method)(wait_until="commit", timeout=10_000)
        return status()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def close() -> dict:
    """Shut down the virtual browser session (MCP reattaches on next use)."""
    async with _lock:
        await _force_close()
    return {"ok": True}


async def _force_close() -> None:
    """Tear everything down; tolerates half-open sessions. Never raises."""
    global _pw_instance, _browser, _context, _page
    closers = [
        None if _page is None else _page.close,
        None if _context is None else _context.close,
        None if _browser is None else _browser.close,
        None if _pw_instance is None else _pw_instance.stop,
    ]
    _page = _context = _browser = _pw_instance = None
    for closer in closers:
        if closer is None:
            continue
        try:
            res = closer()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            logger.debug("browser close step failed", exc_info=True)
