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
import random
import re
import signal
import socket
import subprocess
import sys
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

# Idle eviction (Whisper pattern): each chat owns a full Chromium process,
# so idle sessions are reaped after a window of no real use. Closed chats
# get the short window; open chats a longer one (the user may come back to
# the tab), but no longer exempt-forever — an opened-then-forgotten chat
# must not pin a full Chromium (~130MB RSS) indefinitely. Timers are per
# chat_id, eviction uses _force_close only.
_BROWSER_IDLE_EVICT_S = 10 * 60
_OPEN_IDLE_EVICT_S = 30 * 60
_open_chats: set[str] = set()
_last_used: dict[str, float] = {}
_evict_timers: dict[str, asyncio.TimerHandle] = {}


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


def set_open_chats(chat_ids: list[str] | set[str] | tuple | None = None) -> None:
    """Mark which chats are currently open in the UI (exempt from eviction)."""
    global _open_chats
    try:
        new_open = {_normalize_chat(c) for c in (chat_ids or []) if str(c or "").strip()}
    except Exception:
        new_open = set()
    added = new_open - _open_chats
    removed = _open_chats - new_open
    _open_chats = new_open
    for key in added:
        _cancel_timer(key)
        if is_active(key):
            # Arm the (longer) open-chat window: without this the cancel
            # above would leave a live session with NO timer — exempt forever.
            _schedule_evict(key)
    for key in removed:
        if is_active(key):
            _last_used[key] = time.monotonic()
            _schedule_evict(key)


def _idle_window(key: str) -> int:
    """Idle-seconds budget for one chat: open chats get the longer window."""
    return _OPEN_IDLE_EVICT_S if key in _open_chats else _BROWSER_IDLE_EVICT_S


def _cancel_timer(key: str) -> None:
    """Cancel a pending idle timer without touching last-used state."""
    handle = _evict_timers.pop(key, None)
    if handle is not None:
        try:
            handle.cancel()
        except Exception:
            pass


def _schedule_evict(key: str) -> None:
    """(Re)arm the idle timer for one chat on the running loop."""
    _cancel_timer(key)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        _evict_timers[key] = loop.call_later(
            _idle_window(key), _on_idle_timeout, key
        )
    except Exception:
        pass


def _touch(key: str) -> None:
    """Record activity and re-arm the idle timer for one chat."""
    _last_used[_normalize_chat(key)] = time.monotonic()
    _schedule_evict(_normalize_chat(key))


def _on_idle_timeout(key: str) -> None:
    """Loop callback: hand the async eviction check to a task."""
    _evict_timers.pop(key, None)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        loop.create_task(_evict_if_idle(key))
    except Exception:
        pass


async def _evict_if_idle(key: str) -> bool:
    """Close one chat's browser when idle for its whole window.

    The window depends on the chat's open state (see _idle_window): a chat
    the user still has open is only reaped after the longer one. Real use
    (agent tool call, or a visible panel's status poll) refreshes the clock
    via _touch, so a browser being watched or driven is never closed.
    """
    norm = _normalize_chat(key)
    if not is_active(norm):
        _cancel_timer(norm)
        # The backend lost the session (page closed under us) but the profile
        # may still be held by an ORPHANED chrome (ppid 1) from a half-failed
        # close: reap it so RAM is not leaked until the next launch. Live,
        # parented holders are left untouched — they belong to a live owner.
        try:
            _clear_stale_profile_lock(_profile_dir(norm))
        except Exception:  # noqa: BLE001, S110 — orphan reaping is best-effort
            pass
        return False
    last = _last_used.get(norm, 0.0)
    if time.monotonic() - last < _idle_window(norm):
        # Touched since the timer was armed (e.g. the window grew when the
        # chat was opened): wait out the fresh window instead of evicting.
        _schedule_evict(norm)
        return False
    sess = _sessions.get(norm)
    if sess is None:
        return False
    async with sess.lock:
        # Re-check under the lock: a tool call or panel poll may have landed
        # while we waited — in-use wins over eviction.
        if time.monotonic() - _last_used.get(norm, 0.0) < _idle_window(norm):
            _schedule_evict(norm)
            return False
        await _force_close(norm)
    _cancel_timer(norm)
    _last_used.pop(norm, None)
    return True


# Stealth init script applied to every page: hides the automation markers
# that search engines key on (webdriver flag, fake plugin arrays,
# missing chrome runtime, headless WebGL vendor, notification fingerprint).
# Every value mimics a real desktop Chrome so content-level bot checks fail
# closed instead of serving a captcha wall.
_STEALTH_INIT_SCRIPT = """(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => {
      const mk = (name, filename, desc) => ({ name, filename, description: desc, length: 1 });
      const arr = [mk('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
                   mk('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
                   mk('Native Client', 'internal-nacl-plugin', 'Native Client Executable')];
      arr.namedItem = (n) => arr.find((p) => p.name === n || p.filename === n) || null;
      arr.item = (i) => arr[i] || null;
      return arr;
    }});
    Object.defineProperty(navigator, 'mimeTypes', { get: () => {
      const arr = [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }];
      arr.namedItem = (n) => arr.find((m) => m.type === n) || null;
      arr.item = (i) => arr[i] || null;
      return arr;
    }});
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    if (!window.chrome || !window.chrome.runtime) {
      window.chrome = { runtime: {}, csi: () => ({}), loadTimes: () => ({}), app: {} };
    }
    const perms = window.navigator.permissions;
    if (perms && perms.query) {
      const orig = perms.query.bind(perms);
      perms.query = (p) => (
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p)
      );
    }
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Google Inc. (Intel)';
        if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParam.call(this, p);
      };
    } catch (e) {}
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
    if active:
        # A panel polling status (every ~1.2s while visible) is REAL use:
        # refresh the idle clock so a browser the user is watching is never
        # auto-closed underneath them. Sync context: _schedule_evict inside
        # _touch just no-ops when there is no running loop.
        _touch(key)
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


async def devtools_url(chat_id: str | None = None) -> dict:
    """Verified DevTools frontend URL for a live session's page target.

    Modern Chromium advertises the appspot-hosted (https) frontend in
    ``devtoolsFrontendUrl`` — but an https page cannot open the loopback
    ``ws://`` debugging socket (mixed content), so it dies with "WebSocket
    disconnected". The bundled inspector served by the debugging port itself
    (``http://127.0.0.1:PORT/devtools/inspector.html``) has no such problem,
    so it is preferred and serve-checked; the advertised https URL is only a
    last-resort fallback. Resolving here (not in the renderer) also sidesteps
    Chromium's rejection of cross-origin ``/json/list`` fetches.
    """
    key = _normalize_chat(chat_id)
    if not is_active(key):
        return {"ok": False, "error": "browser is not running"}
    cdp = cdp_endpoint(key)
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"{cdp}/json/list")
            targets = res.json() if res.status_code == 200 else []
            if not isinstance(targets, list):
                targets = []
            page = next(
                (
                    t
                    for t in targets
                    if isinstance(t, dict)
                    and t.get("type") == "page"
                    and t.get("devtoolsFrontendUrl")
                ),
                None,
            )
            if page is None:
                return {"ok": False, "error": "no debuggable page target"}
            front = str(page["devtoolsFrontendUrl"]).strip()
            if front.startswith("devtools://"):
                # Not openable from an OS browser — no usable frontend.
                return {"ok": False, "error": "Chromium only exposes a devtools:// frontend"}
            ws_arg = _devtools_ws_arg(front, page)
            if not ws_arg:
                return {"ok": False, "error": "no debugging websocket for the page target"}
            # Preferred: the bundled inspector from the debugging port — the
            # http:// origin may open ws:// to the same loopback endpoint.
            local = f"{cdp}/devtools/inspector.html?ws={ws_arg}"
            check = await client.get(local.split("?", 1)[0])
            if check.status_code < 400:
                return {"ok": True, "url": local}
            # Last resort: the advertised frontend (works only where the OS
            # browser allows the loopback ws from its https origin).
            advertised = front if front.startswith("http") else f"{cdp}{front}"
            check = await client.get(advertised.split("?", 1)[0])
            if check.status_code < 400:
                return {"ok": True, "url": advertised}
            return {
                "ok": False,
                "error": f"DevTools frontend not served (HTTP {check.status_code})",
            }
    except Exception as exc:  # noqa: BLE001 — surfaced in the panel status line
        return {"ok": False, "error": str(exc)}


def _devtools_ws_arg(front: str, page: dict) -> str:
    """``host:port/path`` the inspector frontend should connect to."""
    match = re.search(r"[?&]ws=([^&]+)", front)
    if match:
        return match.group(1)
    ws_url = str(page.get("webSocketDebuggerUrl") or "").strip()
    if ws_url.startswith("ws://"):
        return ws_url[len("ws://") :]
    return ""


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


_CHROMIUM_INSTALL_ATTEMPTED = False
_CHROMIUM_INSTALL_TASK: asyncio.Task | None = None


def _is_missing_bundled_error(exc: Exception) -> bool:
    """True when Playwright reports its bundled Chromium is not installed."""
    msg = str(exc)
    return "Executable doesn't exist" in msg or "playwright install" in msg.lower()


async def _install_bundled_chromium() -> None:
    """Download bundled Chromium in the background (never blocks a launch)."""
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, "-m", "playwright", "install", "chromium"],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except Exception:
        logger.warning("bundled Chromium auto-install failed", exc_info=True)
        return
    if proc.returncode != 0:
        detail = proc.stderr[-500:] if proc.stderr else proc.returncode
        logger.warning("bundled Chromium auto-install failed: %s", detail)
        return
    logger.warning("bundled Chromium auto-install finished")


def _ensure_bundled_chromium() -> bool:
    """Kick off the background Chromium install; never blocks the caller.

    Always returns False so the launch path falls through to the system
    Chrome fallback immediately — the agent answer must never wait on a
    ~170MB download. The next launch after the background install finishes
    picks up the bundled build. Only attempted once per process.
    """
    global _CHROMIUM_INSTALL_ATTEMPTED, _CHROMIUM_INSTALL_TASK
    if _CHROMIUM_INSTALL_ATTEMPTED:
        return False
    _CHROMIUM_INSTALL_ATTEMPTED = True
    logger.warning("bundled Chromium missing - installing in background via playwright")
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    _CHROMIUM_INSTALL_TASK = loop.create_task(_install_bundled_chromium())
    return False


async def _launch_browser(pw, chat_key: str | None = None):
    """Launch headless Chromium (persistent profile) with CDP exposed.

    Runs the full browser build in new headless mode (``headless=False``
    plus ``--headless=new``): far fewer automation tells than the
    headless-shell binary, while no window ever opens outside the app.
    The automation markers Google keys on are stripped: no
    ``--enable-automation`` switch, AutomationControlled blink feature
    disabled (``navigator.webdriver`` reads as false), and the profile
    persists across runs so existing cookies survive.
    Prefers Playwright's bundled Chromium first, then the system Chrome as
    a fallback for machines without ``playwright install`` — the panel only
    needs *a* Chromium-family browser. Bundled-first keeps the virtual
    browser off the system Chrome binary, so clicking the system Chrome
    icon while the app runs never hangs behind our headless process.
    Edge is intentionally not tried:
    most machines lack it and its "not found" error only buries the real
    cause in the logs.
    """
    key = _normalize_chat(chat_key)
    port = int(cdp_endpoint(key).rsplit(":", 1)[1])
    # Chrome 111+ rejects DevTools websocket clients that send an Origin
    # header (the bundled inspector page sends its own http origin) with
    # 403 — "WebSocket disconnected" in Open DevTools. Allow this port's
    # own origin plus the appspot fallback frontend.
    allow_origins = (
        f"--remote-allow-origins=http://127.0.0.1:{port}"
        ",https://chrome-devtools-frontend.appspot.com"
    )
    args = [
        f"--remote-debugging-port={port}",
        allow_origins,
        # New headless mode on a headed launch: the FULL browser build
        # renders (far fewer automation tells than the headless-shell
        # binary) while no window ever opens outside the app.
        "--headless=new",
        "--disable-blink-features=AutomationControlled",
        # Skip first-run flows (welcome pages, choice screens) that look
        # nothing like a real user's settled profile — a bot signal.
        "--no-first-run",
        "--no-default-browser-check",
    ]
    profile = _profile_dir(key)
    profile.mkdir(parents=True, exist_ok=True)
    # Pre-launch recovery: a leftover SingletonLock from a half-failed close
    # would fail BOTH channel attempts and push the turn past the 8s MCP
    # connect timeout (continuing without MCP tools). Clear it up-front so
    # the first attempt can take the profile immediately. Launch runs only
    # when this sidecar holds no live session, so force=True is safe here —
    # same guarantee as the post-failure sweep below. Per-chat profile
    # isolation is preserved: only this chat's profile dir is touched.
    try:
        _clear_stale_profile_lock(profile, force=True)
    except Exception:  # noqa: BLE001, S110 — pre-launch cleanup is best-effort
        pass
    errors: list[str] = []
    for sweep in range(2):
        blocked = False
        for kwargs in ({}, {"channel": "chrome"}):
            try:
                return await pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile),
                    headless=False,
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
                if not kwargs.get("channel") and _is_missing_bundled_error(exc):
                    # Fire-and-forget: install in the background and fall
                    # through to system Chrome immediately, so the agent
                    # answer never waits on the download.
                    _ensure_bundled_chromium()
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
            _touch(key)
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
            # Stealth first: the init script must exist before any page or
            # document loads, otherwise the first page misses it entirely.
            await sess.context.add_init_script(_STEALTH_INIT_SCRIPT)
            await _init_ua_override(sess.context, sess)
            sess.page = sess.context.pages[0] if sess.context.pages else await sess.context.new_page()
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
    _touch(key)
    return status(key)


async def _apply_ua(page, sess: _ChatSession | None = None) -> None:
    """Point one page's UA (HTTP + navigator) at the real, de-headed string."""
    override = sess.ua_override if sess is not None else None
    if not override:
        return
    try:
        import re as _re

        session = await page.context.new_cdp_session(page)
        params: dict = {"userAgent": override}
        m = _re.search(r"Chrome/(\d+)", override)
        if m and "Mobile" not in override:
            ver = m.group(1)
            params["userAgentMetadata"] = {
                "brands": [
                    {"brand": "Chromium", "version": ver},
                    {"brand": "Google Chrome", "version": ver},
                    {"brand": "Not-A.Brand", "version": "99"},
                ],
                "fullVersion": f"{ver}.0.0.0",
                "platform": "Windows",
                "platformVersion": "15.0.0",
                "architecture": "x86",
                "model": "",
                "mobile": False,
            }
        await session.send("Emulation.setUserAgentOverride", params)
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
        _touch(key)
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
        _touch(key)
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
        _touch(key)
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
        _touch(key)
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
        _touch(key)
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
_GOOGLE_BLOCKED_MARKERS = ("consent.google.com", "/sorry", "recaptcha", "captcha", "sorry/index")

# Body text that means the same even when the URL looks like results
# (Google serves these walls with HTTP 200).
_GOOGLE_BLOCKED_CONTENT = (
    "recaptcha",
    "unusual traffic",
    "our systems have detected",
    "not a robot",
    "captcha",
    "/sorry/",
    "sorry/index",
    "consent.google.com",
)


def _is_google_blocked(page_url: str) -> bool:
    u = page_url or ""
    return any(m in u for m in _GOOGLE_BLOCKED_MARKERS)


async def _accept_google_consent(page) -> None:
    """Click Google's consent accept button when it appears (best-effort).

    Fresh profiles often land on a consent wall before the homepage box
    is usable; accepting sets the consent cookies in the persistent
    profile so later searches skip the wall entirely.
    """
    try:
        locator = page.locator(
            'button:has-text("Accept all"), button:has-text("I agree"), '
            'button:has-text("\u0642\u0628\u0648\u0644 \u062f\u0627\u0631\u0645"), [aria-label="Accept all"]'
        )
    except Exception:
        return
    try:
        btn = locator.first if hasattr(locator, "first") else locator
        await btn.click(timeout=3_000)
        await asyncio.sleep(0.6)
    except Exception:
        pass


async def _try_google_human(page, query: str) -> str | None:
    """Human-like Google search: homepage -> click box -> type -> Enter.

    Direct GETs to /search?q= are the top automation tell; typing into the
    homepage box looks like a real user. Returns the settled URL, or None
    when the human path failed (caller falls back to the direct URL).
    Pages without locator support (unit fakes) return None immediately.
    """
    try:
        locator = page.locator('textarea[name="q"], input[name="q"]')
    except Exception:
        return None
    try:
        await page.goto("https://www.google.com/", wait_until="domcontentloaded", timeout=15_000)
        await _accept_google_consent(page)
        await asyncio.sleep(random.uniform(0.5, 1.1))
        box = locator.first if hasattr(locator, "first") else locator
        # Glide the virtual mouse to the box in steps: trusted pointer
        # input with a human-like path before the click.
        try:
            target = await box.bounding_box()
        except Exception:
            target = None
        if target is not None:
            try:
                await page.mouse.move(
                    target["x"] + target["width"] / 2,
                    target["y"] + target["height"] / 2,
                    steps=random.randint(8, 20),
                )
                await asyncio.sleep(random.uniform(0.1, 0.35))
            except Exception:
                pass
        await box.click(timeout=5_000)
        await asyncio.sleep(random.uniform(0.2, 0.5))
        try:
            await box.fill("", timeout=3_000)
        except Exception:
            pass
        # Jittered typing in small chunks: a uniform 35ms cadence is
        # itself a bot tell.
        for i in range(0, len(query), 3):
            await box.press_sequentially(query[i : i + 3], delay=random.uniform(25, 90), timeout=15_000)
            await asyncio.sleep(random.uniform(0.05, 0.25))
        await asyncio.sleep(random.uniform(0.3, 0.7))
        await box.press("Enter", timeout=5_000)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        await asyncio.sleep(0.8)
        return page.url or ""
    except Exception:
        return None


async def search(query: str, chat_id: str | None = None) -> dict:
    """Search the web: Google first, Bing then DuckDuckGo as fallbacks.

    Google is driven like a human (homepage -> type -> Enter); a direct
    GET to /search is only the fallback. A goto that throws, returns
    HTTP >= 400, or lands on a consent/CAPTCHA page counts as a failure
    and the next engine is tried. Returns ``{"ok": True, "engine": ...,
    "url": ...}`` or ``{"ok": False, "error": ...}`` (never raises).
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
                if name == "google":
                    # Human path first: typing into the homepage box looks
                    # like a real user; a direct GET to /search is the top
                    # automation tell. None means the human path failed —
                    # fall through to the direct URL below.
                    human_url = await _try_google_human(sess.page, q)
                    if human_url is not None:
                        url = human_url
                        resp = None
                    else:
                        resp = await sess.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                else:
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
                    rescued = False
                    if "consent" in cur_url:
                        # Consent wall, not a captcha: accept it (sets the
                        # cookie in our persistent profile) and re-check.
                        await _accept_google_consent(sess.page)
                        await asyncio.sleep(0.8)
                        try:
                            cur_url = sess.page.url or ""
                        except Exception:  # noqa: BLE001
                            pass
                        rescued = not _is_google_blocked(cur_url)
                    if not rescued:
                        errors.append(f"{name}: blocked ({cur_url})")
                        continue
                # Content-level wall: URL looks fine but the body is a
                # recaptcha/sorry/consent page (Google serves these with 200).
                try:
                    html = (await sess.page.content())[:8000].lower()
                except Exception:  # noqa: BLE001
                    html = ""
                if name == "google" and any(m in html for m in _GOOGLE_BLOCKED_CONTENT):
                    errors.append(f"{name}: blocked (captcha/consent page)")
                    continue
                _touch(key)
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
        _touch(key)
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
        _touch(key)
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
        _touch(key)
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
        _touch(key)
        return status(key)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def close(chat_id: str | None = None) -> dict:
    """Shut down a chat's virtual browser session (MCP reattaches on next use)."""
    key = _normalize_chat(chat_id)
    sess = _get(key)
    async with sess.lock:
        await _force_close(key)
    _cancel_timer(key)
    _last_used.pop(key, None)
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
