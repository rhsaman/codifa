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
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import quote_plus

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

# Real user agent (the HeadlessChrome token is stripped) applied to every
# page via CDP — HeadlessChrome in the UA is a strong bot signal for sites
# like Google, which then demand the "I'm not a robot" check.
_ua_override: str | None = None


def _profile_dir() -> Path:
    """Persistent browser profile root (same CODER_DATA_DIR convention as state_db).

    A durable profile keeps consent/NID cookies between runs: a page the user
    already verified stays verified instead of being challenged again on the
    next launch (a fresh empty profile every run is itself a bot signal).
    """
    root = os.environ.get("CODER_DATA_DIR")
    return (Path(root) if root else Path.home() / ".codifa") / "browser-profile"


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


def _lock_owner_pid(profile: Path) -> int | None:
    """PID owning ``SingletonLock`` (Chrome writes ``<hostname>-<pid>``)."""
    lock = profile / "SingletonLock"
    if not lock.is_symlink():
        return None
    try:
        return int(str(os.readlink(lock)).rsplit("-", 1)[1])
    except (OSError, ValueError, IndexError):
        return None  # unknown format — never act blindly


def _pid_alive(pid: int) -> bool:
    """signal-0 probe: False only when the process is definitively gone."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True  # alive for us (or undecidable) — keep it
    return True


def _pid_orphaned(pid: int) -> bool:
    """True when the owner's parent is init/launchd: a chrome zombie left
    behind by a sidecar that already exited (POSIX only, never ourselves)."""
    if os.name == "nt" or pid == os.getpid():
        return False
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return out.returncode == 0 and out.stdout.strip().split()[-1] == "1"
    except Exception:  # noqa: BLE001 — ps missing/failed: assume NOT orphaned
        return False


def _stale_profile_lock(profile: Path) -> bool:
    """True when ``SingletonLock`` exists but its owner process is gone.

    Chrome writes the lock as a symlink to ``<hostname>-<pid>``. After a crash
    or a rushed close the file can outlive its owner, and every later launch
    fails with "ProcessSingleton" even though nothing holds the profile.
    """
    pid = _lock_owner_pid(profile)
    return pid is not None and not _pid_alive(pid)


def _clear_stale_profile_lock(profile: Path) -> None:
    """Remove singleton leftovers when nobody can legitimately own them.

    Dead owner → stale, clear. Alive but ORPHANED owner (ppid 1) → chrome
    zombie from an already-dead sidecar: reap it, then clear. A live,
    non-orphaned owner (another running instance) is kept untouched.
    """
    pid = _lock_owner_pid(profile)
    if pid is None:
        return
    if _pid_alive(pid):
        if not _pid_orphaned(pid):
            return
        # Orphaned chrome still on OUR profile dir: it can only outlive a
        # dead sidecar — reap it so the next launch can take the profile.
        logger.warning("reaping orphaned browser zombie pid=%s on %s", pid, profile)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            logger.debug("zombie reap failed", exc_info=True)
        for _ in range(30):
            if not _pid_alive(pid):
                break
            time.sleep(0.05)
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        p = profile / name
        try:
            if p.is_symlink() or p.exists():
                p.unlink()
        except OSError:
            logger.debug("stale lock cleanup failed for %s", name, exc_info=True)


async def _launch_browser(pw):
    """Launch headless Chromium (persistent profile) with CDP exposed.

    Returns the BrowserContext. The automation markers Google keys on are
    stripped: no ``--enable-automation`` switch, AutomationControlled blink
    feature disabled (``navigator.webdriver`` reads as undefined), and the
    profile persists across runs so existing cookies survive.
    Prefers the system Chrome first, then Playwright's bundled build, so a
    machine without ``playwright install`` still works — the panel only
    needs *a* Chromium-family browser. Edge is intentionally not tried:
    most machines lack it and its "not found" error only buries the real
    cause in the logs.
    """
    port = int(cdp_endpoint().rsplit(":", 1)[1])
    args = [
        f"--remote-debugging-port={port}",
        "--disable-blink-features=AutomationControlled",
    ]
    profile = _profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    for sweep in range(2):
        blocked = False
        for kwargs in ({"channel": "chrome"}, {}):
            try:
                return await pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile),
                    headless=True,
                    args=args,
                    ignore_default_args=["--enable-automation"],
                    **kwargs,
                )
            except Exception as exc:  # noqa: BLE001
                # Keep EVERY failure — reporting only the last one hides the
                # real cause (a stale profile lock) behind a useless msedge error.
                errors.append(f"{kwargs.get('channel', 'bundled')}: {exc}")
                logger.warning(
                    "browser launch via %s failed: %s",
                    kwargs.get("channel", "bundled"),
                    exc,
                )
                blocked = blocked or "ProcessSingleton" in str(exc)
        if not blocked:
            break
        # Stale ProcessSingleton: the owner process is dead but the lock file
        # lingers and blocks every browser on this profile — clear it (only
        # when genuinely stale) and sweep the channels once more.
        _clear_stale_profile_lock(profile)
    raise RuntimeError("no Chromium available: " + " | ".join(errors))


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
            # The persistent context IS this browser's default context — the
            # exact one Playwright MCP attaches to over CDP
            # (browser.contexts()[0].pages()[0]), so the panel mirrors the agent.
            _context = await _launch_browser(_pw_instance)
            # `browser` is a PROPERTY (a method call raises TypeError and the
            # panel then stays "stopped" even though the context launched).
            # It is None for persistent contexts — close tolerates that.
            _browser = _context.browser
            _page = _context.pages[0] if _context.pages else await _context.new_page()
            # Belt-and-suspenders on top of the launch flag: navigator.webdriver
            # reads as undefined on every page, including MCP-opened tabs.
            await _context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
            )
            await _init_ua_override(_context)
            await _page.set_viewport_size(dict(DEFAULT_VIEWPORT))
        except Exception as exc:
            logger.exception("browser launch failed")
            await _force_close()
            return {"ok": False, "error": str(exc)}
        # Navigation lives OUTSIDE the fatal handler: a bad URL must not tear
        # down a healthy session (the panel just reports it and can retry).
        if target != "about:blank":
            try:
                await _page.goto(target)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": f"navigation failed: {exc}"}
    return status()


async def _apply_ua(page) -> None:
    """Point one page's UA (HTTP + navigator) at the real, de-headed string."""
    if not _ua_override:
        return
    try:
        session = await page.context.new_cdp_session(page)
        await session.send(
            "Emulation.setUserAgentOverride", {"userAgent": _ua_override}
        )
    except Exception:
        logger.debug("page UA override failed", exc_info=True)


def _on_new_page(page) -> None:
    """Cover tabs created later (e.g. by Playwright MCP) too."""
    try:
        asyncio.get_running_loop().create_task(_apply_ua(page))
    except RuntimeError:  # no running loop — nothing to schedule on
        pass


async def _init_ua_override(context) -> None:
    """Read the browser's real UA and drop the HeadlessChrome token.

    Version and platform come from ``Browser.getVersion``, so the overridden
    UA stays consistent with the sec-ch-ua headers Chrome sends natively.
    Applied to existing pages and, via a listener, to every future page.
    """
    global _ua_override
    try:
        cdp = await context.new_browser_cdp_session()
        info = await cdp.send("Browser.getVersion")
        ua = str(info.get("userAgent") or "")
        _ua_override = ua.replace("HeadlessChrome", "Chrome") or None
    except Exception:
        logger.debug("UA override skipped", exc_info=True)
        return
    if not _ua_override:
        return
    for page in context.pages:
        await _apply_ua(page)
    context.on("page", _on_new_page)


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


# Search engines in priority order for omnibox queries: Google first, then
# the fallbacks when it is blocked (consent wall / CAPTCHA) or unreachable.
SEARCH_ENGINES: tuple[tuple[str, str], ...] = (
    ("google", "https://www.google.com/search?q={}"),
    ("bing", "https://www.bing.com/search?q={}"),
    ("duckduckgo", "https://duckduckgo.com/?q={}"),
)

# URLs that mean "Google refused us" instead of a results page — those fall
# through to the next engine rather than being shown to the user.
_GOOGLE_BLOCKED_MARKERS = ("consent.google.com", "/sorry/", "recaptcha")


def _is_google_blocked(page_url: str) -> bool:
    u = page_url or ""
    return any(m in u for m in _GOOGLE_BLOCKED_MARKERS)


async def search(query: str) -> dict:
    """Search the web: Google first, Bing then DuckDuckGo as fallbacks.

    A goto that throws, returns HTTP >= 400, or (on Google) lands on a
    consent/CAPTCHA page counts as a failure and the next engine is tried.
    Returns ``{"ok": True, "engine": ..., "url": ...}`` or
    ``{"ok": False, "error": ...}`` (never raises).
    """
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "empty search query"}
    if not is_active():
        return {"ok": False, "error": "browser is not running"}
    encoded = quote_plus(q)
    errors: list[str] = []
    async with _lock:
        for name, template in SEARCH_ENGINES:
            url = template.format(encoded)
            try:
                resp = await _page.goto(url, wait_until="commit", timeout=15_000)
                code = 200 if resp is None else int(getattr(resp, "status", 200))
                if code >= 400:
                    errors.append(f"{name}: HTTP {code}")
                    continue
                if name == "google" and _is_google_blocked(_page.url):
                    errors.append(f"{name}: blocked ({_page.url})")
                    continue
                return {"ok": True, "engine": name, "url": _page.url}
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}: {exc}")
    return {"ok": False, "error": "search engines failed — " + " | ".join(errors)}


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
    """Tear everything down; tolerates half-open sessions. Never raises.

    A half-failed ``context.close()`` can leave our chrome ALIVE while the
    module state is already reset — that chrome keeps the profile lock and
    every later launch dies on ProcessSingleton. The lock pid is captured
    first (while the profile is provably ours) and reaped afterwards.
    """
    global _pw_instance, _browser, _context, _page
    had_session = _page is not None or _context is not None or _browser is not None
    own_pid = _lock_owner_pid(_profile_dir()) if had_session else None
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
    if own_pid is not None:
        if _pid_alive(own_pid):
            # Ours by construction (captured above) — reap the runaway so the
            # profile is free for the next launch.
            logger.warning("browser survived close; reaping pid=%s", own_pid)
            try:
                os.kill(own_pid, signal.SIGKILL)
            except OSError:
                logger.debug("reap failed", exc_info=True)
            for _ in range(30):
                if not _pid_alive(own_pid):
                    break
                await asyncio.sleep(0.05)
        # Dead or just reaped → clear the singleton leftovers.
        _clear_stale_profile_lock(_profile_dir())
