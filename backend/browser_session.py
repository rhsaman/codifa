"""Per-chat in-app browser sessions (Playwright).

Each chat owns an isolated headless Chromium backing both the right-side
Browser panel (live JPEG frames + virtual clicks served over HTTP by
``server.py``) and the agent's Playwright MCP server: ``mcp_bridge`` starts
``@playwright/mcp`` with ``--cdp-endpoint`` pointed at that chat's
remote-debugging port, so both sides drive the SAME chat browser and no
window ever opens outside the app.

The user's real mouse/keyboard are never touched — every input goes through
Playwright's page API. All entry points are safe to call while the session
is down: they return ``{"ok": False, "error": ...}`` instead of raising.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
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

DEFAULT_VIEWPORT = {"width": 1280, "height": 800}


class _ChatSession:
    """Live state for one chat's isolated virtual browser.

    Each chat owns its profile directory, CDP port and page, so switching
    chats never shows another chat's browser. The legacy "default" key
    preserves the old single-session behaviour for callers without a chat.
    """

    def __init__(self) -> None:
        self.pw = None
        self.browser = None
        self.context = None
        self.page = None
        self.lock = asyncio.Lock()
        self.cdp_port: int | None = None
        self.ua_override: str | None = None


_sessions: dict[str, _ChatSession] = {}


def _normalize_chat(chat_id: str | None) -> str:
    """Session key for a chat (empty/None falls back to the legacy default)."""
    key = (chat_id or "").strip()
    return key or "default"


def _get(chat_id: str | None = None) -> _ChatSession:
    """Return (creating on first use) the session object for a chat."""
    key = _normalize_chat(chat_id)
    sess = _sessions.get(key)
    if sess is None:
        sess = _ChatSession()
        _sessions[key] = sess
    return sess


# Stealth init script applied to every page: hides the automation markers
# that search engines key on (webdriver flag, missing plugins/languages,
# missing chrome runtime, notification permission fingerprint).
_STEALTH_INIT_SCRIPT = """(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (!window.chrome) window.chrome = { runtime: {} };
    const perms = window.navigator.permissions;
    if (perms && perms.query) {
      const orig = perms.query.bind(perms);
      perms.query = (p) => (
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p)
      );
    }
  } catch (e) {}
})();"""


def _profile_dir(chat_id: str | None = None) -> Path:
    """Per-chat persistent profile root (same CODER_DATA_DIR convention as state_db).

    A durable profile keeps consent/NID cookies between runs: a page the user
    already verified stays verified instead of being challenged again on the
    next launch (a fresh empty profile every run is itself a bot signal).
    Each non-default chat gets its own subdirectory so sessions are isolated.
    """
    root = os.environ.get("CODER_DATA_DIR")
    base = (Path(root) if root else Path.home() / ".codifa") / "browser-profile"
    key = _normalize_chat(chat_id)
    if key == "default":
        return base
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", key)[:64] or "chat"
    return base / f"chat-{safe}"


def _pick_cdp_port() -> int:
    """A free localhost port for the browser's remote-debugging endpoint."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def cdp_endpoint(chat_id: str | None = None) -> str:
    """HTTP CDP endpoint of a chat's session (stable for the process lifetime)."""
    sess = _get(chat_id)
    if sess.cdp_port is None:
        sess.cdp_port = _pick_cdp_port()
    return f"http://127.0.0.1:{sess.cdp_port}"


def is_active(chat_id: str | None = None) -> bool:
    """True while a chat's live page object exists (never raises)."""
    page = _get(chat_id).page
    return page is not None and not page.is_closed()


def status(chat_id: str | None = None) -> dict:
    """Cheap, sync snapshot for GET /browser/status — never raises."""
    key = _normalize_chat(chat_id)
    page = _get(key).page
    active = page is not None and not page.is_closed()
    url = ""
    viewport = dict(DEFAULT_VIEWPORT)
    if active:
        try:
            url = page.url or ""
            size = page.viewport_size or viewport
            viewport = {"width": int(size["width"]), "height": int(size["height"])}
        except Exception:  # noqa: BLE001
            active = False
    return {
        "ok": True,
        "active": active,
        "url": url,
        "viewport": viewport,
        "available": _PW_AVAILABLE,
        "chat": key,
        "cdp": cdp_endpoint(key) if active else None,
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


def _pid_uses_profile(pid: int, profile: Path) -> bool:
    """True when pid's command line references our profile dir.

    The lock symlink stores only a pid, which the OS may have recycled for
    an unrelated process. Killing on pid alone could hit an innocent
    process — only kill when the process is provably a chrome holding OUR
    profile.
    """
    if os.name == "nt":
        return True  # no ps command check on Windows — keep old behavior
    try:
        out = subprocess.run(
            ["ps", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return out.returncode == 0 and str(profile) in (out.stdout or "")
    except Exception:  # noqa: BLE001 — ps missing/failed: never kill blindly
        return False


def _unlink_singleton_files(profile: Path) -> None:
    """Remove Chrome's singleton leftovers unconditionally."""
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        p = profile / name
        try:
            if p.is_symlink() or p.exists():
                p.unlink()
        except OSError:
            logger.debug("stale lock cleanup failed for %s", name, exc_info=True)


def _stale_profile_lock(profile: Path) -> bool:
    """True when ``SingletonLock`` exists but its owner process is gone.

    Chrome writes the lock as a symlink to ``<hostname>-<pid>``. After a crash
    or a rushed close the file can outlive its owner, and every later launch
    fails with "ProcessSingleton" even though nothing holds the profile.
    """
    pid = _lock_owner_pid(profile)
    return pid is not None and not _pid_alive(pid)


def _clear_stale_profile_lock(profile: Path, force: bool = False) -> None:
    """Remove singleton leftovers when nobody can legitimately own them.

    Dead owner → stale, clear. Alive but ORPHANED owner (ppid 1) → chrome
    zombie from an already-dead sidecar: reap it, then clear. A live,
    non-orphaned owner is kept untouched — unless ``force`` is set, which
    the launch path uses when this sidecar holds no live session: any holder
    verified on OUR profile is then a runaway from a half-failed close, so
    it is reaped. A live pid NOT on our profile is pid reuse: its files are
    stale leftovers and are removed, but the innocent process is never
    killed.
    """
    pid = _lock_owner_pid(profile)
    if pid is None:
        return
    if not _pid_alive(pid):
        _unlink_singleton_files(profile)
        return
    if _pid_orphaned(pid):
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
        _unlink_singleton_files(profile)
        return
    if not force:
        return
    # Forced recovery (launch with no live session): a live holder verified
    # on OUR profile is a runaway from a half-failed close — reap it.
    if not _pid_uses_profile(pid, profile):
        logger.warning(
            "stale profile lock held by recycled pid=%s; clearing files without kill",
            pid,
        )
        _unlink_singleton_files(profile)
        return
    logger.warning("reaping runaway browser pid=%s on %s", pid, profile)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        logger.debug("runaway reap failed", exc_info=True)
    for _ in range(30):
        if not _pid_alive(pid):
            break
        time.sleep(0.05)
    _unlink_singleton_files(profile)


async def _launch_browser(pw, chat_key: str | None = None):
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
    key = _normalize_chat(chat_key)
    port = int(cdp_endpoint(key).rsplit(":", 1)[1])
    args = [
        f"--remote-debugging-port={port}",
        "--disable-blink-features=AutomationControlled",
        # Skip first-run flows (welcome pages, choice screens) that look
        # nothing like a real user's settled profile — a bot signal.
        "--no-first-run",
        "--no-default-browser-check",
    ]
    profile = _profile_dir(key)
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
                    # Match the stealth init script (languages) at the HTTP
                    # layer too: mismatched Accept-Language vs navigator is
                    # itself a fingerprint search engines key on.
                    locale="en-US",
                    extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                    **kwargs,
                )
            except Exception as exc:  # noqa: BLE001
                # Keep EVERY failure — reporting only the last one hides the
                # real cause (e.g. a stale profile lock) behind noise.
                errors.append(f"{kwargs.get('channel', 'bundled')}: {exc}")
                logger.warning(
                    "browser launch via %s failed: %s",
                    kwargs.get("channel", "bundled"),
                    exc,
                )
                blocked = blocked or "ProcessSingleton" in str(exc)
        if not blocked:
            break
        # Stale ProcessSingleton: the lock file blocks every browser on this
        # profile. Launch runs only when this sidecar holds no live session,
        # so any holder verified on OUR profile is a runaway from a
        # half-failed close — force-clear it and sweep the channels once more.
        _clear_stale_profile_lock(profile, force=True)
    raise RuntimeError("no Chromium available: " + " | ".join(errors))


async def launch(url: str = "about:blank", chat_id: str | None = None) -> dict:
    """Ensure a chat's browser is running; navigate only on a real URL.

    Idempotent: an already-running session is left untouched unless ``url``
    is a concrete address. The MCP bridge calls this on every (re)connect
    purely to guarantee the session exists — it must not reset the page the
    agent is working on.
    """
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not _PW_AVAILABLE:
        return {"ok": False, "error": "playwright is not installed — run `uv add playwright`"}
    target = (url or "").strip() or "about:blank"
    async with sess.lock:
        if is_active(key):
            if target != "about:blank" and target != sess.page.url:
                try:
                    await sess.page.goto(target)
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": f"navigation failed: {exc}"}
            return status(key)
        try:
            sess.pw = await async_playwright().start()
            # The persistent context IS this browser's default context — the
            # exact one Playwright MCP attaches to over CDP
            # (browser.contexts()[0].pages()[0]), so the panel mirrors the agent.
            sess.context = await _launch_browser(sess.pw, key)
            # `browser` is a PROPERTY (a method call raises TypeError and the
            # panel then stays "stopped" even though the context launched).
            # It is None for persistent contexts — close tolerates that.
            sess.browser = sess.context.browser
            sess.page = sess.context.pages[0] if sess.context.pages else await sess.context.new_page()
            # Stealth markers on every page, including MCP-opened tabs.
            await sess.context.add_init_script(_STEALTH_INIT_SCRIPT)
            await _init_ua_override(sess.context, sess)
            await sess.page.set_viewport_size(dict(DEFAULT_VIEWPORT))
        except Exception as exc:
            logger.exception("browser launch failed")
            await _force_close(key)
            return {"ok": False, "error": str(exc)}
        # Navigation lives OUTSIDE the fatal handler: a bad URL must not tear
        # down a healthy session (the panel just reports it and can retry).
        if target != "about:blank":
            try:
                await sess.page.goto(target)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": f"navigation failed: {exc}"}
    return status(key)


async def _apply_ua(page, sess: _ChatSession | None = None) -> None:
    """Point one page's UA (HTTP + navigator) at the real, de-headed string."""
    override = sess.ua_override if sess is not None else None
    if not override:
        return
    try:
        session = await page.context.new_cdp_session(page)
        await session.send(
            "Emulation.setUserAgentOverride", {"userAgent": override}
        )
    except Exception:
        logger.debug("page UA override failed", exc_info=True)


def _on_new_page(page, sess: _ChatSession | None = None) -> None:
    """Cover tabs created later (e.g. by Playwright MCP) too."""
    try:
        asyncio.get_running_loop().create_task(_apply_ua(page, sess))
    except RuntimeError:  # no running loop — nothing to schedule on
        pass


async def _init_ua_override(context, sess: _ChatSession) -> None:
    """Read the browser's real UA and drop the HeadlessChrome token.

    Version and platform come from ``Browser.getVersion``, so the overridden
    UA stays consistent with the sec-ch-ua headers Chrome sends natively.
    Applied to existing pages and, via a listener, to every future page.
    """
    try:
        cdp = await context.new_browser_cdp_session()
        info = await cdp.send("Browser.getVersion")
        ua = str(info.get("userAgent") or "")
        sess.ua_override = ua.replace("HeadlessChrome", "Chrome") or None
    except Exception:
        logger.debug("UA override skipped", exc_info=True)
        return
    if not sess.ua_override:
        return
    for page in context.pages:
        await _apply_ua(page, sess)
    context.on("page", lambda p: _on_new_page(p, sess))


async def screenshot(chat_id: str | None = None) -> dict:
    """Latest viewport frame as a JPEG data URI for the Browser panel."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            raw = await sess.page.screenshot(type="jpeg", quality=60)
        size = sess.page.viewport_size or DEFAULT_VIEWPORT
        return {
            "ok": True,
            "image": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
            "width": int(size["width"]),
            "height": int(size["height"]),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def click(x: int, y: int, chat_id: str | None = None) -> dict:
    """Virtual click at viewport pixel coordinates — no real mouse involved."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.mouse.click(float(x), float(y))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def type_text(text: str, chat_id: str | None = None) -> dict:
    """Type text into the focused element inside the virtual browser."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.keyboard.type(text)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def press_key(key: str, chat_id: str | None = None) -> dict:
    """Press a key (Enter, Tab, Escape, ...) inside the virtual browser."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.keyboard.press(key)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def navigate(url: str, chat_id: str | None = None) -> dict:
    """Navigate the virtual browser to a URL."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.goto(url)
        return {"ok": True, "url": sess.page.url}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


# Search engines in priority order for omnibox queries: Google first, then
# the fallbacks when it is blocked (consent wall / CAPTCHA) or unreachable.
# hl/gl/pws pin a plain en-US results page: fewer consent redirects and no
# personalization, which itself reduces bot-wall hits on fresh profiles.
SEARCH_ENGINES: tuple[tuple[str, str], ...] = (
    ("google", "https://www.google.com/search?q={}&hl=en&gl=us&pws=0"),
    ("bing", "https://www.bing.com/search?q={}"),
    ("duckduckgo", "https://duckduckgo.com/?q={}"),
)

# URLs that mean "Google refused us" instead of a results page — those fall
# through to the next engine rather than being shown to the user.
_GOOGLE_BLOCKED_MARKERS = ("consent.google.com", "/sorry/", "recaptcha")


def _is_google_blocked(page_url: str) -> bool:
    u = page_url or ""
    return any(m in u for m in _GOOGLE_BLOCKED_MARKERS)


async def search(query: str, chat_id: str | None = None) -> dict:
    """Search the web: Google first, Bing then DuckDuckGo as fallbacks.

    A goto that throws, returns HTTP >= 400, or (on Google) lands on a
    consent/CAPTCHA page counts as a failure and the next engine is tried.
    Content-level walls (recaptcha/unusual-traffic text after a redirect)
    count too, and a short human-like pause separates engine attempts so
    rapid-fire gotos do not look scripted. Returns ``{"ok": True,
    "engine": ..., "url": ...}`` or ``{"ok": False, "error": ...}``
    (never raises).
    """
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "empty search query"}
    key = _normalize_chat(chat_id)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    sess = _get(key)
    encoded = quote_plus(q)
    errors: list[str] = []
    async with sess.lock:
        for idx, (name, template) in enumerate(SEARCH_ENGINES):
            if idx > 0:
                # Human-like gap between engines — back-to-back gotos in the
                # same millisecond are a classic automation tell.
                await asyncio.sleep(0.4 + 0.3 * idx)
            url = template.format(encoded)
            try:
                resp = await sess.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                code = 200 if resp is None else int(getattr(resp, "status", 200))
                if code >= 400:
                    errors.append(f"{name}: HTTP {code}")
                    continue
                # Consent/CAPTCHA walls often redirect a beat after commit —
                # wait briefly, then judge the settled URL, not the first one.
                await asyncio.sleep(0.8)
                try:
                    cur_url = sess.page.url or ""
                except Exception:  # noqa: BLE001
                    cur_url = url
                if name == "google" and _is_google_blocked(cur_url):
                    errors.append(f"{name}: blocked ({cur_url})")
                    continue
                # Content-level wall: URL looks fine but the body is a
                # recaptcha/sorry/consent page (Google serves these with 200).
                try:
                    html = (await sess.page.content())[:8000].lower()
                except Exception:  # noqa: BLE001
                    html = ""
                if name == "google" and any(
                    m in html for m in ("recaptcha", "unusual traffic", "/sorry/", "consent.google.com")
                ):
                    errors.append(f"{name}: blocked (captcha/consent page)")
                    continue
                return {"ok": True, "engine": name, "url": sess.page.url}
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}: {exc}")
    return {"ok": False, "error": "search engines failed — " + " | ".join(errors)}


async def scroll(dx: int, dy: int, chat_id: str | None = None) -> dict:
    """Scroll the virtual browser viewport."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.mouse.wheel(float(dx), float(dy))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def set_viewport(width: int, height: int, chat_id: str | None = None) -> dict:
    """Resize the shared viewport (responsive presets: desktop/tablet/mobile)."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    w = max(200, min(7680, int(width)))
    h = max(200, min(4320, int(height)))
    try:
        async with sess.lock:
            await sess.page.set_viewport_size({"width": w, "height": h})
        return status(key)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def move(x: int, y: int, chat_id: str | None = None) -> dict:
    """Move the virtual cursor (hover) without touching the real mouse."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    try:
        async with sess.lock:
            await sess.page.mouse.move(float(x), float(y))
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def history(action: str, chat_id: str | None = None) -> dict:
    """History control: ``back``, ``forward`` or ``reload``.

    Uses ``wait_until="commit"`` so the call returns as soon as navigation
    starts — the panel refreshes frames through its normal poll instead of
    blocking here. With no history entry Playwright resolves immediately.
    """
    key = _normalize_chat(chat_id)
    sess = _get(key)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    method = {"back": "go_back", "forward": "go_forward", "reload": "reload"}.get(action)
    if method is None:
        return {"ok": False, "error": f"unknown history action {action!r}"}
    try:
        async with sess.lock:
            await getattr(sess.page, method)(wait_until="commit", timeout=10_000)
        return status(key)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def close(chat_id: str | None = None) -> dict:
    """Shut down a chat's virtual browser session (MCP reattaches on next use)."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    async with sess.lock:
        await _force_close(key)
    return {"ok": True}


async def _force_close(chat_id: str | None = None) -> None:
    """Tear everything down; tolerates half-open sessions. Never raises.

    A half-failed ``context.close()`` can leave our chrome ALIVE while the
    module state is already reset — that chrome keeps the profile lock and
    every later launch dies on ProcessSingleton. The lock pid is captured
    first (while the profile is provably ours) and reaped afterwards.
    """
    key = _normalize_chat(chat_id)
    sess = _get(key)
    had_session = sess.page is not None or sess.context is not None or sess.browser is not None
    own_pid = _lock_owner_pid(_profile_dir(key)) if had_session else None
    closers = [
        None if sess.page is None else sess.page.close,
        None if sess.context is None else sess.context.close,
        None if sess.browser is None else sess.browser.close,
        None if sess.pw is None else sess.pw.stop,
    ]
    sess.page = sess.context = sess.browser = sess.pw = None
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
        if not _pid_alive(own_pid):
            # Dead or just reaped → drop the singleton leftovers outright.
            # (No orphan check: this pid was provably ours.)
            _unlink_singleton_files(_profile_dir(key))
        else:
            logger.error(
                "browser pid=%s survived SIGKILL; profile left locked", own_pid
            )
