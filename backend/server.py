"""FastAPI sidecar serving the LangGraph agent over SSE.

Runs on 127.0.0.1:<ephemeral port>, spawned by the Electron main process. Only
reachable from the local machine. All file access is confined to the ROOT
provided in each request.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import time
import tracemalloc
from collections.abc import AsyncIterator, Callable
from typing import Annotated
from urllib.parse import quote

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

logger = logging.getLogger("codifa.server")

# tracemalloc instrumentation state. Tracing is started once at sidecar boot
# (see _maybe_start_tracemalloc) and a snapshot is taken after every agent run
# so codifa.log can show *which* allocator is growing between runs — the key to
# diagnosing the RSS climb flagged by the "agent run complete rss_mb=..." line.
_TRACE_PREV_SNAPSHOT = None
# frame depth must be small: in production self-cost is dominated by per-allocation
# bookkeeping, and 5 frames is enough to locate any allocator.
_TRACE_FRAMES = 5
# Skip snapshot above this RSS — tracemalloc's own materialization can push a
# near-OOM process over the edge. 1200 MB matches Electron's typical heap cap.
_TRACE_RSS_SNAPSHOT_MAX_MB = 1200.0


def _rss_mb() -> float | None:
    """Peak resident memory in MB, best-effort (unix only). Helpful for spotting
    the OOM crashes that manifest as a silent sidecar drop mid-turn."""
    try:
        import resource
        import sys

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS reports bytes; Linux reports KB.
        if sys.platform == "darwin":
            return rss / (1024 * 1024)
        return rss / 1024
    except Exception:  # noqa: BLE001 — RSS is best-effort diagnostics only
        return None


def _maybe_start_tracemalloc() -> None:
    """Start allocation tracing once, if enabled via env or DEBUG logging.

    tracemalloc overhead is modest but non-zero, so tracing stays OFF unless the
    operator opts in (CODFA_TRACE_MALLOC=1) or runs a DEBUG diagnostic session
    (CODFA_LOG_LEVEL=DEBUG). Once started it is never stopped for the process
    lifetime; snapshots are diffed run-over-run in _log_memory_snapshot.
    """
    global _TRACE_PREV_SNAPSHOT
    if tracemalloc.is_tracing():
        return
    _enabled = os.environ.get("CODFA_TRACE_MALLOC", "").strip() in ("1", "true", "yes")
    _debug = os.environ.get("CODFA_LOG_LEVEL", "WARNING").upper() == "DEBUG"
    if not (_enabled or _debug):
        return
    try:
        tracemalloc.start(_TRACE_FRAMES)
        _TRACE_PREV_SNAPSHOT = None
        logger.warning("tracemalloc tracing started (run-complete snapshots enabled)")
    except Exception:  # noqa: BLE001, S110 — tracing must never break the sidecar
        pass


def _log_memory_snapshot(chat_id: str) -> None:
    """Log the top allocation growth since the last run, and top overall holders.

    Only does work when tracemalloc is actually tracing. Emits a compact,
    grep-friendly block so the dominant allocator between runs is visible in
    codifa.log without external tooling.
    """
    global _TRACE_PREV_SNAPSHOT
    if not tracemalloc.is_tracing():
        return
    try:
        # Guard: skip the snapshot when RSS is already too high. take_snapshot()
        # materializes every live trace and can transiently spike RSS by hundreds
        # of MB; on a near-OOM sidecar that materialization can be the trigger
        # that finally tips the process over the edge.
        _rss = _rss_mb() or 0.0
        if _rss > _TRACE_RSS_SNAPSHOT_MAX_MB:
            logger.warning(
                "tracemalloc snapshot skipped chat_id=%s rss_mb=%.1f (above %.0f MiB cap)",
                chat_id, _rss, _TRACE_RSS_SNAPSHOT_MAX_MB,
            )
            return

        # Drop the previous snapshot reference FIRST so its trace frames are
        # reclaimable before we allocate the next one. Without this, the old
        # trace stays alive in tracemalloc's internal bookkeeping and RSS
        # high-water accumulates run-over-run.
        prev = _TRACE_PREV_SNAPSHOT
        _TRACE_PREV_SNAPSHOT = None
        del prev

        # NOTE: take_snapshot() materializes every live trace (hundreds of
        # thousands here) and can transiently spike RSS by hundreds of MB. On
        # macOS ru_maxrss is a monotonic high-water mark, so that transient spike
        # shows up as a fake "jump" in the next "agent run start rss_mb". Log RSS
        # around the snapshot so the instrumentation's own cost is visible and
        # not mistaken for a leak.
        _rss_before = _rss
        _snap = tracemalloc.take_snapshot()
        _rss_after = _rss_mb() or 0.0
        if _rss_after - _rss_before > 50.0:
            logger.warning(
                "tracemalloc snapshot self-cost chat_id=%s ~%.0f MiB (transient, RSS high-water only)",
                chat_id,
                _rss_after - _rss_before,
            )

        def _loc_of(stat) -> str:
            # statistics() -> Statistic (traceback attr); compare_to() ->
            # StatisticDiff (trace attr). Normalize so both render the same.
            _tb = getattr(stat, "traceback", None) or getattr(stat, "trace", None)
            if not _tb:
                return "?"
            _frames = _tb.format()
            return _frames[-1] if _frames else "?"

        if _TRACE_PREV_SNAPSHOT is not None:
            _top = _snap.compare_to(_TRACE_PREV_SNAPSHOT, "lineno")[:8]
            _lines = [
                f"MEM-GROW chat_id={chat_id} top allocators since last run (size KiB / count):"
            ]
            for _st in _top:
                _lines.append(
                    f"  +{_st.size / 1024:.0f} KiB  {_st.count} objs  {_loc_of(_st)}"
                )
            logger.warning("\n".join(_lines))
        # Top overall current holders (where the memory lives right now).
        _overall = _snap.statistics("lineno")[:8]
        _olines = [
            f"MEM-NOW chat_id={chat_id} top current allocations (size KiB / count):"
        ]
        for _st in _overall:
            _olines.append(
                f"  {_st.size / 1024:.0f} KiB  {_st.count} objs  {_loc_of(_st)}"
            )
        logger.warning("\n".join(_olines))
        _TRACE_PREV_SNAPSHOT = _snap
    except Exception:  # noqa: BLE001, S110 — diagnostics must never break the run
        pass

# Pending permission requests: id -> asyncio.Future. Resolved by the
# /permission/respond endpoint and awaited by the agent's request_permission /
# confirm_action tools.
# Gate id -> chat_id so the silence-cap pause is per-chat. Without this, a
# permission pending in chat A would suspend the stall timeout for chat B too,
# leaving B on "waiting for model" forever while A waits for the user.
PERMISSION_GATE_CHAT: dict[str, str] = {}
# Pending multiple-choice / open questions the agent asked the user mid-task.
# Resolved by /ask/respond and awaited by the agent's ask_user tool.
# Gate id -> chat_id, same per-chat isolation as above.


# Cap (seconds) on CONTINUOUS model silence while the SSE socket stays alive
# via keepalives. Past it, _with_keepalive raises _ModelSilenceTimeout so the
# stream is torn down and the frontend auto-resumes from its checkpoint
# instead of ticking "waiting for model" forever. Kept above the 900s tool
# deadline so a healthy long-running tool is never killed by it. Not counted
# while the model's reasoning window is open (see `_with_keepalive`).
MODEL_SILENCE_CAP_S = 1200
# Google OAuth sign-in state: generated `state` token -> dict(client_id,
# client_secret, redirect_uri, expiry). Populated by /oauth/google/start (when
# the Electron main opens the consent window) and consumed by the callback that
# exchanges the resulting authorization code for tokens.
OAUTH_STATES: dict[str, dict] = {}
# Authorization codes received via the callback, keyed by `state` so the
# renderer can pick them up once the exchange lands.
OAUTH_CODES: dict[str, str] = {}
# Completed OAuth exchanges, keyed by `state`: {refresh_token, access_token,
# expires_in, error}. Written by /oauth/google/callback (called by the OS
# browser), polled by /oauth/google/result (called by the Electron main).
OAUTH_RESULTS: dict[str, dict] = {}

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, model_validator

import providers



# Sidecar's own listening port, set in main(). Used to build the loopback
# redirect_uri for Google OAuth (the consent page lands back on this process).
_SIDECAR_PORT = 0


def _oauth_redirect_uri() -> str:
    """Loopback URI Google redirects to after consent. The Electron main catches
    this navigation in-process, so the path only needs to be unique per sidecar."""
    return f"http://127.0.0.1:{_SIDECAR_PORT}/oauth/google/callback"


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Preload models.dev catalog and start the schedule loop at startup.

    The catalog is fetched once and cached in memory. The schedule loop
    runs due tasks every 30 seconds (background, headless).
    """

    async def _bg() -> None:
        try:
            from providers import _models_dev_catalog

            await _models_dev_catalog()
        except Exception:
            logger.warning(
                "models.dev catalog preload failed (non-fatal)", exc_info=True
            )

    _spawn_tracked(_bg(), "models-dev-preload")

    # Prune orphaned plan dirs at startup too: the atexit prune never runs
    # after a hard kill (crash / kill -9), so plans of deleted chats stayed
    # on disk until the next graceful shutdown.
    try:
        import state_db as _startup_state_db

        _startup_state_db.prune_orphan_plans()
    except Exception:
        logger.debug("startup plan prune failed", exc_info=True)

    async def _warm_local_voices() -> None:
        # Preload G2P + pocket TTS weights in the background so the first
        # speaker-icon click never pays the cold-load cost inside the
        # user-visible request timeout. Best-effort, never crashes startup.
        try:
            import asyncio as _aio
            import local_tts as _warm_mod

            await _aio.to_thread(_warm_mod.warmup_local_tts)
        except Exception:
            logger.debug("local TTS warmup spawn failed", exc_info=True)

    # Opt-in: preloading G2P (T5) + pocket weights pins several GB of RAM on
    # EVERY launch (and again for every extra sidecar), even when TTS is never
    # used. Default is lazy: the first speaker click loads the models once and
    # they are evicted after idle. Set TTS_WARMUP_AT_START=1 to restore preload.
    if os.environ.get("TTS_WARMUP_AT_START", "").strip().lower() in ("1", "true", "yes"):
        _spawn_tracked(_warm_local_voices(), "local-tts-warmup")
    pass  # schedule loop moved to the native Rust scheduler
    # The embedding ONNX model (~1.1 GB resident) is deliberately NOT preloaded
    # here: it loads lazily on the first real embed call (embeddings._load) and
    # is evicted after idle. Preloading pinned that memory on every launch even
    # when RAG / indexing was never used.
    yield
    try:
        pass  # schedule loop moved to the native Rust scheduler
    except Exception:  # noqa: BLE001, S110 — best-effort shutdown signal
        pass

    # MCP sessions are owned by the native Rust client (src-tauri/src/mcp.rs)
    # and closed per turn, so there is nothing to shut down here.


app = FastAPI(title="Codifa agent sidecar", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- زمان‌بندی تسک‌های خودکار (مثل Codex) ---------------------------------- #
# حلقه پس‌زمینه هر SCHEDULE_POLL_SECONDS سررسیدها را چک می‌کند؛ اجرای هر تسک
# headless است (بدون ask_user/permission — گیت‌ها None) و نتیجه در
# schedules/runs ثبت می‌شود.

SCHEDULE_POLL_SECONDS = 30
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def _spawn_tracked(coro, name: str) -> asyncio.Task:
    """Track a fire-and-forget task so it is not GC-collected and failures log."""
    task = asyncio.create_task(coro, name=name)
    _BACKGROUND_TASKS.add(task)

    def _done(t: asyncio.Task) -> None:
        _BACKGROUND_TASKS.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.warning("background task %s failed: %s", name, exc, exc_info=exc)

    task.add_done_callback(_done)
    return task


# Time window (seconds) during which a run counts as fresh "running".
# A task with a running run started inside this window does not start again.
# Disk-backed guard, works across processes and restarts
# (unlike _SCHEDULE_RUNNING which is memory-only).
_SCHEDULE_RUNNING_WINDOW = 15 * 60
# Runs older than this (seconds) count as orphaned at startup and turn to error
# (previous sidecar died mid-run).
_SCHEDULE_ORPHAN_AFTER = 60 * 60


class ScheduleUpsertRequest(BaseModel):
    """ساخت/ویرایش تسک زمان‌بندی."""

    id: str = ""
    name: str = ""
    prompt: str = ""
    cron: str = ""
    enabled: bool = True
    root: str = ""
    mode: str = "build"
    provider_id: str = ""
    model: str = ""


class CompactRequest(BaseModel):
    """Manual ``/compact`` — runs opencode's compaction (structured summary,
    token-budgeted tail, prior-summary merge) on the supplied history."""

    # Primary summarizer (the user's configured compact subagent if any).
    provider: str = "custom"
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    # The user-configured provider id (several rows can share a kind) so the
    # returned usage event groups under the REAL provider. Mirrors
    # ChatRequest.provider_id.
    provider_id: str = ""
    # Fallback summarizer (the active chat model) — mirrors opencode's
    # subagent -> main-model retry when the compact subagent is unavailable.
    fallback_provider: str = ""
    fallback_model: str = ""
    fallback_base_url: str = ""
    fallback_api_key: str = ""
    fallback_env_var: str = ""
    fallback_api_keys: list[str] = []
    fallback_provider_id: str = ""
    # Conversation history to compact — full-fidelity turns (role, content,
    # toolActivity, plan, mode, preservedToolSummary) so the summarizer sees
    # WHAT tools ran, not just prose.
    history: list[dict] = []
    context_window: int = 0
    # Default matches the auto-compact `compact_at_percent` (80) and the UI's
    # default, so a manual /compact without an explicit percent behaves
    # identically to auto-compaction. The frontend always sends the user's
    # actual `compactAtPercent` here, so this is only a fallback.
    compact_at_percent: int = 80


class ModelsRequest(BaseModel):
    provider: str = "custom"
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    base_url: str = ""
    provider_id: str = ""


class ModelDownloadRequest(BaseModel):
    """Download a managed on-device model (whisper / embedding / piper)."""

    kind: str = ""
    model: str = ""
    base_url: str = ""


class ModelRemoveRequest(BaseModel):
    """Delete a downloaded model. ``model`` = repo id (embeddings) or "". """

    kind: str = ""
    model: str = ""


class ModelControlRequest(BaseModel):
    """Pause / resume / cancel a running model download."""

    kind: str = ""


class TtsRequest(BaseModel):
    """POST /tts — synthesize text via OpenAI-compatible endpoint or local Piper."""

    text: str = ""
    provider: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    model: str = ""
    voice: str = ""
    ttsProvider: str = ""
    ttsProviderId: str = ""
    ttsModel: str = ""
    ttsBaseUrl: str = ""
    ttsVoice: str = ""


class PermissionResponse(BaseModel):
    id: str
    allowed: bool


class AskResponse(BaseModel):
    id: str
    answer: str


class StateRequest(BaseModel):
    """Whole-state write from Electron main: settings and/or chat snapshot."""

    settings: dict | None = None
    chats: list | None = None
    deleted_chats: list | None = None
    deleted_workspaces: list | None = None


# --- app state (settings + chats/messages) ------------------------------ #
# Persisted as plain files in the user data root (backend/state_db.py): a
# settings.json plus per-chat JSON files under chats/<workspace>/. Electron's
# main process reads/writes state through these endpoints; the data root
# defaults to ~/.codifa (configurable via CODER_DATA_DIR).


class DocReadRequest(BaseModel):
    """Read a document for the UI viewer. ``path`` may be workspace-relative
    or absolute (imported uploads under the data root are allowed).
    ``format``: text (default) | html (styled Word/Excel view) | pages
    (PDF pages as JPEG data URLs). ``sheet`` selects one Excel sheet,
    ``pages`` selects PDF pages like "1-3,7"."""

    root: str = ""
    path: str = ""
    format: str = "text"
    sheet: str = ""
    pages: str = ""


# Small mtime-keyed cache for /doc/read so repeated viewer polls do not
# re-parse the file while edits still refresh via mtime change.
_DOC_READ_CACHE: dict[tuple[str, str, str, str], tuple[float, dict]] = {}
_DOC_READ_CACHE_MAX = 64


@app.post("/doc/read")
async def doc_read(req: DocReadRequest) -> dict:
    """Extract or render a PDF / Word / Excel / text file for the right-hand
    file viewer (which cannot parse those formats itself)."""
    import doc_tools
    from tools import PathEscapeError, resolve_safe

    p = (req.path or "").strip()
    if not p:
        return {"error": "path is required"}
    try:
        target = resolve_safe((req.root or "").strip() or os.getcwd(), p, allow_coder=True)
    except PathEscapeError as exc:
        return {"error": str(exc)}
    sheet = (req.sheet or "").strip()
    pages = (req.pages or "").strip()
    fmt = (req.format or "text").strip() or "text"
    cache_key = (target, fmt, sheet, pages)
    try:
        mtime = os.path.getmtime(target)
    except OSError:
        mtime = -1.0
    cached = _DOC_READ_CACHE.get(cache_key)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    try:
        if fmt == "html":
            result = {"html": await asyncio.to_thread(doc_tools.render_document, target, sheet, pages)}
        elif fmt == "pages":
            result = {
                "pages": await asyncio.to_thread(doc_tools.render_pdf_pages, target, pages)
            }
        else:
            content = await asyncio.to_thread(doc_tools.read_document, target, sheet, pages)
            result = {"content": content}
        if len(_DOC_READ_CACHE) >= _DOC_READ_CACHE_MAX:
            _DOC_READ_CACHE.pop(next(iter(_DOC_READ_CACHE)))
        _DOC_READ_CACHE[cache_key] = (mtime, result)
        return result
    except doc_tools.DocError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surfaced verbatim in the viewer
        return {"error": f"{type(exc).__name__}: {exc}"}


# --- checkpoints (Undo) -------------------------------------------------- #
# Content snapshots before each model write/edit (backend/checkpoints.py).
# Frontend fetches the list for the Undo button and restore returns files.


class CheckpointRestoreRequest(BaseModel):
    """Restore a checkpoint in the given workspace."""

    root: str


# --- traces (LangSmith-style per-chat log) -------------------------------- #
# Temporary per-chat log for the Trace panel (LLM / prompt / tool) - memory only, no persist.


# --- virtual browser (Playwright) ------------------------------------------ #
# The session is NATIVE now (src-tauri/src/browser.rs): the Rust router owns
# the headless Chromium and serves /browser/* itself, so no Python route or
# model remains here.

# --- git ------------------------------------------------------------------- #
# ابزارهای git برای پنل فرانت‌اند (GitPanel) — همان توابع امنِ
# backend/git_tools.py که ابزارهای مدل هم استفاده می‌کنند.

class GitRootRequest(BaseModel):
    root: str


class GitCommitRequest(BaseModel):
    root: str
    message: str
    add_all: bool = False


class GitCheckoutRequest(BaseModel):
    root: str
    branch: str = ""
    create: bool = False


class GitPushRequest(BaseModel):
    root: str
    remote: str = "origin"
    branch: str = ""
    set_upstream: bool = False


class GitAutoCommitRequest(BaseModel):
    root: str
    provider: str = "custom"
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    provider_id: str = ""


class OAuthStartRequest(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    # Optional override of the requested OAuth scopes. Empty = the default
    # Search Console scope (GOOGLE_SEARCH_CONSOLE_SCOPES) for the
    # search_console tool.
    scope: str = ""


@app.post("/oauth/google/start")
async def oauth_google_start(req: OAuthStartRequest) -> dict:
    """Begin a Google OAuth sign-in: build the consent URL for the client, keyed
    by a random `state`. The redirect_uri points back at THIS sidecar's loopback
    URL so the Electron main can catch the authorization code locally."""
    client_id = (req.client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="missing Google OAuth client id")
    state = secrets.token_urlsafe(24)
    redirect_uri = _oauth_redirect_uri()
    scope = (req.scope or "").strip() or providers.GOOGLE_SEARCH_CONSOLE_SCOPES
    url = (
        f"{providers.GOOGLE_OAUTH_AUTH_URL}"
        f"?client_id={quote(client_id, safe='')}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&response_type=code"
        f"&scope={quote(scope, safe='')}"
        f"&access_type=offline"
        f"&prompt=consent"
        f"&state={state}"
    )
    OAUTH_STATES[state] = {
        "client_id": client_id,
        "client_secret": (req.client_secret or "").strip(),
        "expires": time.monotonic() + 15 * 60,
    }
    return {"url": url, "state": state}


@app.get("/oauth/google/callback")
async def oauth_google_callback(
    code: str = "", state: str = "", error: str = ""
) -> PlainTextResponse:
    """The OS browser lands here after Google consent (via the loopback
    redirect_uri). Exchange the code for refresh/access tokens, cache the result
    by ``state`` for /oauth/google/result to pick up, and tell the user to close
    the tab."""
    entry = OAUTH_STATES.pop(state or "", None)
    if error:
        OAUTH_RESULTS[state or ""] = {"error": f"Google sign-in cancelled ({error})"}
        return PlainTextResponse(
            "Sign-in cancelled. You can close this tab.", status_code=200
        )
    if not entry or entry.get("expires", 0) < time.monotonic():
        OAUTH_RESULTS[state or ""] = {"error": "oauth state expired; try signing in again"}
        return PlainTextResponse("Sign-in expired. You can close this tab.", status_code=200)
    if not code:
        OAUTH_RESULTS[state or ""] = {"error": "Google returned no authorization code"}
        return PlainTextResponse("No authorization code. You can close this tab.", status_code=200)
    try:
        data = await providers.google_exchange_code(
            entry["client_id"],
            entry["client_secret"],
            code,
            _oauth_redirect_uri(),
        )
    except providers.ProviderError as exc:
        OAUTH_RESULTS[state or ""] = {"error": str(exc)}
        return PlainTextResponse(
            f"Sign-in failed: {exc} You can close this tab.", status_code=200
        )
    refresh = data.get("refresh_token") or ""
    if not refresh:
        OAUTH_RESULTS[state or ""] = {
            "error": "Google returned no refresh token (was `access_type=offline` honored?)"
        }
        return PlainTextResponse("Sign-in failed. You can close this tab.", status_code=200)
    OAUTH_RESULTS[state or ""] = {
        "refresh_token": refresh,
        "access_token": data.get("access_token") or "",
        "expires_in": int(data.get("expires_in") or 3600),
    }
    return PlainTextResponse("Signed in! You can close this tab.", status_code=200)


@app.get("/oauth/google/result")
async def oauth_google_result(state: str = "") -> dict:
    """Polled by the Electron main: returns the completed OAuth exchange for
    ``state`` (or a pending marker) and clears it once consumed."""
    result = OAUTH_RESULTS.pop(state or "", None)
    if result is None:
        return {"status": "pending"}
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return {"status": "ok", **result}


@app.get("/models")
async def models(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        ids = await providers.list_models(
            req.provider, req.base_url, req.api_key, req.env_var, req.api_keys
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"models": ids}


@app.get("/credits")
async def credits(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        return await providers.fetch_credits(
            req.provider, req.base_url, req.api_key, req.env_var, req.api_keys
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# تست مدل (POST /models/test): کل پرامپت کوچک باید در MODEL_TEST_TIMEOUT ثانیه
# جواب بدهد؛ سقف کلاینت HTTP عمداً کوچک‌تر از آن است تا خطای خودِ پرووایدر
# زودتر (و با پیام خودش) به UI برسد و سقف بیرونی فقط ترمز دستی باشد.
MODEL_TEST_TIMEOUT = 15  # ثانیه — بودجه کل تست
MODEL_TEST_CLIENT_TIMEOUT = 12  # ثانیه — سقف کلاینت (کوچک‌تر از بودجه کل)


class ModelTestBatchRequest(ModelsRequest):
    """POST /models/test-batch — probe many models in one round trip.

    Served natively by the Rust router (src-tauri/src/backend_light.rs); the
    model probe was the last live consumer of the LangChain model factory, so
    moving it native let the whole langchain/langgraph dependency tree go.
    """

    models: list[str] = []


# --- managed on-device models (whisper / embedding) --------------------- #
# Download & removal are user-initiated from Settings → Models (never
# automatic). Downloads run on a background thread; /models/status is polled
# while one is in flight.


@app.post("/models/download")
async def models_download(req: ModelDownloadRequest) -> dict:
    if (req.kind or "").strip().lower() == _PIPER_KIND:
        voice = _normalize_piper_voice_id((req.model or "").strip() or DEFAULT_PIPER_VOICE)
        if not _local_tts.start_download(voice):
            raise HTTPException(status_code=400, detail="empty local TTS voice id")
        return {"ok": True, "kind": _PIPER_KIND, "model": voice}
    import model_download

    kind = (req.kind or "").strip() or model_download.KIND_EMBEDDING
    if kind not in (
        model_download.KIND_WHISPER,
        model_download.KIND_EMBEDDING,
        model_download.KIND_DECISION,
    ):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    if kind == model_download.KIND_WHISPER:
        default_repo = model_download.WHISPER_DEFAULT_REPO
    elif kind == model_download.KIND_DECISION:
        default_repo = model_download.DECISION_DEFAULT_REPO
    else:
        default_repo = model_download.EMBEDDING_DEFAULT_REPO
    model = (req.model or "").strip() or default_repo
    if not model_download.start_download(kind, model, req.base_url):
        raise HTTPException(status_code=400, detail="empty model repo id")
    return {"ok": True, "kind": kind, "model": model}


@app.get("/models/status")
async def models_status() -> dict:
    import model_download

    data = model_download.status()
    try:
        snapshot = _local_tts.download_snapshot()
    except Exception:
        snapshot = {"state": "idle", "model": "", "progress": 0.0, "error": ""}
    if isinstance(data, dict):
        return {**data, "piper": snapshot}
    return {"status": data, "piper": snapshot}


@app.get("/models/embedding-status")
async def models_embedding_status() -> dict:
    """RAG embedder diagnostics: model loaded? what dimension? why not?."""
    from embeddings import status as embed_status

    return embed_status()


@app.post("/models/unload")
async def models_unload() -> dict:
    """Drop cached local-model weights immediately, freeing idle RAM.

    Unloads the embedding ONNX session (~1.1 GB), the Whisper model
    (1.5-3 GB), the local TTS weights and the Laya decision weights.
    Safe anytime; next use reloads lazily. Used by the manual free-memory
    action in Settings.
    """
    freed: dict[str, bool] = {}
    try:
        from embeddings import unload as _unload_embed

        freed["embedding"] = bool(_unload_embed())
    except Exception:  # noqa: BLE001 -- unload is best-effort, never fail the endpoint
        freed["embedding"] = False
    try:
        freed["whisper"] = bool(unload_whisper())
    except Exception:  # noqa: BLE001 -- unload is best-effort, never fail the endpoint
        freed["whisper"] = False
    try:
        import local_tts as _tts

        _unload_tts = getattr(_tts, "unload", None)
        freed["tts"] = bool(_unload_tts()) if callable(_unload_tts) else False
    except Exception:  # noqa: BLE001 -- unload is best-effort, never fail the endpoint
        freed["tts"] = False
    try:
        import laya_router as _laya

        _unload_laya = getattr(_laya, "unload", None)
        freed["laya"] = bool(_unload_laya()) if callable(_unload_laya) else False
    except Exception:  # noqa: BLE001 -- unload is best-effort, never fail the endpoint
        freed["laya"] = False
    return {"ok": True, "freed": freed}


class ModelPreloadRequest(BaseModel):
    kind: str = ""


@app.post("/models/preload")
async def models_preload(req: ModelPreloadRequest) -> dict:
    """Warm a local model in the background without blocking the caller.

    Called fire-and-forget when live voice starts, so Whisper/G2P/pocket
    weights load in parallel with the user speaking instead of inside the
    first transcription/synthesis timeout. Never pins RAM at boot: it only
    runs on explicit live/dictate start, and the idle-eviction timers still
    free the weights after the idle window.
    """
    kind = (req.kind or "").strip().lower()
    if kind in ("whisper", "stt"):
        async def _warm_stt() -> None:
            try:
                await _get_whisper_model()
            except Exception:
                logger.debug("whisper preload failed", exc_info=True)
        _spawn_tracked(_warm_stt(), "whisper-preload")
        return {"ok": True, "kind": kind}
    if kind in ("piper", "tts", "pocket", "local-tts"):
        async def _warm_tts() -> None:
            try:
                import local_tts as _warm_mod

                await asyncio.to_thread(_warm_mod.warmup_local_tts)
            except Exception:
                logger.debug("local TTS preload failed", exc_info=True)
        _spawn_tracked(_warm_tts(), "local-tts-preload")
        return {"ok": True, "kind": kind}
    raise HTTPException(status_code=400, detail=f"unknown preload kind: {req.kind!r}")


@app.post("/models/remove")
async def models_remove(req: ModelRemoveRequest) -> dict:
    kind = (req.kind or "").strip().lower()
    if kind == _PIPER_KIND:
        raw = (req.model or "").strip()
        voice = _normalize_piper_voice_id(raw) if raw else ""
        removed = _local_tts.remove_files(voice)
        return {"ok": True, "kind": kind, "removed": removed}
    import model_download

    if kind not in (
        model_download.KIND_WHISPER,
        model_download.KIND_EMBEDDING,
        model_download.KIND_DECISION,
    ):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    removed = model_download.remove(kind, req.model)
    return {"ok": True, "kind": kind, "removed": removed}


def _require_model_kind(kind: str) -> str:
    import model_download

    kind = (kind or "").strip().lower()
    if kind not in (
        model_download.KIND_WHISPER,
        model_download.KIND_EMBEDDING,
        model_download.KIND_DECISION,
        _PIPER_KIND,
    ):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    return kind


@app.post("/models/pause")
async def models_pause(req: ModelControlRequest) -> dict:
    """Pause a running model download (downloaded bytes are kept)."""
    kind = _require_model_kind(req.kind)
    if kind == _PIPER_KIND:
        if not _local_tts.pause_download():
            raise HTTPException(status_code=404, detail="no running download to pause")
        return {"ok": True, "kind": kind}
    import model_download

    if not model_download.pause_download(kind):
        raise HTTPException(status_code=404, detail="no running download to pause")
    return {"ok": True, "kind": kind}


@app.post("/models/resume")
async def models_resume(req: ModelControlRequest) -> dict:
    """Resume a paused download from the same offset."""
    kind = _require_model_kind(req.kind)
    if kind == _PIPER_KIND:
        if not _local_tts.resume_download():
            raise HTTPException(status_code=404, detail="no paused download to resume")
        return {"ok": True, "kind": kind}
    import model_download

    if not model_download.resume_download(kind):
        raise HTTPException(status_code=404, detail="no paused download to resume")
    return {"ok": True, "kind": kind}


@app.post("/models/cancel")
async def models_cancel(req: ModelControlRequest) -> dict:
    """Stop an in-flight download; partial files stay for later resume."""
    kind = _require_model_kind(req.kind)
    if kind == _PIPER_KIND:
        _local_tts.cancel_download()
        return {"ok": True, "kind": kind}
    import model_download

    # Idempotent: stopping when nothing runs is still success so the
    # Stop button never looks dead (no 404 when state already cleared).
    model_download.cancel_download(kind)
    return {"ok": True, "kind": kind}


# --- skills (file-based store in the user data folder) ---------------------- #


class SkillSyncRequest(BaseModel):
    name: str = ""
    previous_name: str = ""
    content: str = ""
    description: str = ""
    fa_keywords: list[str] = []
    delete: bool = False
    extra_files: dict | None = None
    files: dict | None = None
    deleted_files: list[str] | None = None
    deletedFiles: list[str] | None = None


# --- MCP connectors (file-based store in the user data folder) ------------- #


class McpSaveRequest(BaseModel):
    name: str = ""
    cfg: dict = {}


class McpDeleteRequest(BaseModel):
    name: str = ""


# Lazy-loaded faster-whisper model (the CTranslate2 model downloaded into
# backend/whisper/, see Settings → Models). Loaded once on first transcription
# and cached, so the first request pays the load cost but every later one is
# fast and fully local+offline. The cached model is EVICTED after an idle
# window (it holds 1.5-3 GB of RAM in a long-lived sidecar); the next
# transcription simply reloads it lazily.
_whisper_model = None
_whisper_model_lock = asyncio.Lock()
try:
    _WHISPER_IDLE_EVICT_S = float(os.environ.get("WHISPER_IDLE_EVICT_S") or 60)
except (TypeError, ValueError):
    _WHISPER_IDLE_EVICT_S = float(5 * 60)
_whisper_last_used = 0.0
_whisper_evict_timer: asyncio.TimerHandle | None = None


def _schedule_whisper_evict() -> None:
    """Record activity and (re)arm the idle-eviction timer on the event loop."""
    global _whisper_last_used, _whisper_evict_timer
    _whisper_last_used = time.monotonic()
    if _whisper_evict_timer is not None:
        _whisper_evict_timer.cancel()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # no running loop (e.g. tests) — eviction stays off
        _whisper_evict_timer = None
        return
    _whisper_evict_timer = loop.call_later(_WHISPER_IDLE_EVICT_S, _evict_whisper_if_idle)


def _evict_whisper_if_idle() -> None:
    """Drop the cached Whisper model when it has been idle for the whole window.

    A model used within the window is left alone — the use already re-armed
    the timer, so touching the clock here would wrongly restart the idle
    window. Evicting mid-transcription is safe: the in-flight handler holds
    its own local reference, only the module cache is cleared.
    """
    global _whisper_model
    if _whisper_model is None:
        return
    if time.monotonic() - _whisper_last_used < _WHISPER_IDLE_EVICT_S:
        return
    _whisper_model = None
    import gc

    gc.collect()


def unload_whisper() -> bool:
    """Drop the cached Whisper model immediately, freeing 1.5-3 GB RAM.

    Returns True when a loaded model was dropped. Safe anytime; the next
    transcription reloads lazily. Used by the manual free-memory endpoint.
    """
    global _whisper_model, _whisper_evict_timer
    had_model = _whisper_model is not None
    _whisper_model = None
    if _whisper_evict_timer is not None:
        try:
            _whisper_evict_timer.cancel()
        except Exception:  # noqa: BLE001, S110 -- timer cancel never fails
            pass
        _whisper_evict_timer = None
    if had_model:
        import gc

        gc.collect()
    return had_model


async def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        async with _whisper_model_lock:
            if _whisper_model is None:
                import model_download

                if not model_download.whisper_ready():
                    try:
                        _wdir = model_download.whisper_dir()
                    except Exception:
                        _wdir = "?"
                    _wsize = 0
                    _wfiles: list[str] = []
                    try:
                        import os as _os

                        if _os.path.isdir(_wdir):
                            _wfiles = list(sorted(_os.listdir(_wdir))[:20])
                            for _root, _dirs, _fs in _os.walk(_wdir):
                                for _f in _fs:
                                    try:
                                        _wsize += _os.path.getsize(_os.path.join(_root, _f))
                                    except OSError:
                                        continue
                    except Exception:  # noqa: BLE001, S110 - diagnostic scan is best-effort
                        pass
                    print(f"[stt] whisper not ready dir={_wdir} size={_wsize} files={_wfiles}", flush=True)
                    logger.warning("whisper not ready dir=%s size=%d files=%s", _wdir, _wsize, _wfiles)
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "Whisper model is not downloaded. Open Settings → Models and "
                            f"download it ({model_download.WHISPER_DEFAULT_REPO})."
                        ),
                    )
                from faster_whisper import WhisperModel

                model_dir = model_download.whisper_dir()
                _whisper_model = WhisperModel(
                    model_dir, device="auto", compute_type="auto"
                )
    _schedule_whisper_evict()
    return _whisper_model


@app.post("/transcribe")
async def transcribe(request: Request) -> dict:
    """Transcribe a recorded audio clip (multipart 'audio').

    Local (no `provider` form field): on-device Whisper, fully offline.
    Remote (`provider` + `base_url` fields): forwarded to
    `POST {base_url}/audio/transcriptions` (OpenAI-compatible, e.g. a custom
    9router gateway at `http://localhost:20128/v1`).
    Returns {"text": "..."} or an HTTP error.

    Tuned for clean, hallucination-free dictation on short clips:
    * Silero VAD trims silence and skips pure-silence clips (no ghost text).
    * An explicit `lang` hint (fa/en) beats auto-detection on short clips.
    * Temperature fallback + conservative thresholds fix repeated-text stutters.
    * A strict VAD gate + low no-speech threshold reject ambient noise.
    """
    import io

    try:
        # Parsing the multipart form (and every downstream step) lives inside the
        # try so that failures — e.g. a missing `python-multipart` dependency, or
        # a malformed upload — surface as a 500 with a `detail` message instead of
        # an unhandled AssertionError that FastAPI turns into a bare 500.
        form = await request.form()
        audio = form.get("audio")
        if audio is None:
            raise HTTPException(status_code=400, detail="missing 'audio' field")
        data = await audio.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty audio")
        lang = str(form.get("lang") or "").strip().lower() or None
        provider_kind = str(form.get("provider") or "").strip()
        base_url = str(form.get("base_url") or "").strip()
        api_key = str(form.get("api_key") or "").strip()
        env_var = str(form.get("env_var") or "").strip()
        stt_model = str(form.get("model") or "").strip() or "whisper-1"

        if provider_kind and provider_kind != "local":
            return await _transcribe_remote(
                data, provider_kind, base_url, api_key, env_var, stt_model, lang,
            )

        from faster_whisper.audio import decode_audio

        model = await _get_whisper_model()
        # faster-whisper's decode_audio uses `av` to decode webm/ogg/opus/wav/mp3
        # to a float32 16 kHz PCM array, so any container the browser MediaRecorder
        # emits is handled without extra conversion code here.
        pcm = decode_audio(io.BytesIO(data))
        # PCM energy gate: pure silence / room tone never reaches Whisper,
        # so it cannot hallucinate words from noise. Speech RMS sits far
        # above this floor; silence is ~0.
        try:
            import numpy as _np_energy

            _rms = float(_np_energy.sqrt(_np_energy.mean(_np_energy.square(pcm), dtype=_np_energy.float64)))
        except Exception:  # noqa: BLE001 — energy gate is best-effort
            _rms = 1.0
        if _rms < 0.01:
            return {"text": ""}
        # Balanced Silero VAD gate: threshold 0.5 keeps quiet word edges
        # (a stricter gate chopped syllables into wrong words), while
        # min_speech_duration_ms still drops sub-300ms blips (clicks,
        # bumps). Ambient-noise rejection lives in the layers that never
        # chop speech: the PCM energy gate above, the frontend
        # sustained-onset gate, and the hallucination filter below.
        vad_parameters = {
            "threshold": 0.5,
            "min_speech_duration_ms": 300,
            "min_silence_duration_ms": 400,
            "speech_pad_ms": 300,
        }
        # For Persian, steer the model toward correct punctuation. The
        # prompt must describe the task only: telling the model to drop
        # "filler" words made it delete real spoken words. The previous
        # prompt ("no punctuation") hurt readability, so it is replaced.
        fa_prompt = "رونویسی فارسی با نشانه‌گذاری صحیح:"
        segments, _info = model.transcribe(
            pcm,
            beam_size=5,
            language=lang,
            vad_filter=True,
            vad_parameters=vad_parameters,
            initial_prompt=fa_prompt if lang == "fa" else None,
            temperature=(0.0, 0.2, 0.4),
            condition_on_previous_text=False,
            # Below the 0.6 default so room noise stops becoming ghost
            # text, but not so low that quiet real words are skipped
            # (which surfaced as wrong/missing words).
            no_speech_threshold=0.5,
            compression_ratio_threshold=2.0,
            log_prob_threshold=-0.8,
            without_timestamps=True,
        )
        text = " ".join(seg.text for seg in segments).strip()
        # Hallucination filter: Whisper loops a token on noise (repeated
        # words). A real short reply ("yes") is kept; only loops and
        # single-char ghosts are dropped so noise never becomes text.
        if len(text) <= 1:
            return {"text": ""}
        words = text.split()
        if len(words) >= 4 and len(set(words)) == 1:
            return {"text": ""}
        if len(words) >= 6:
            repeat = 1
            for i in range(1, len(words)):
                if words[i] == words[i - 1]:
                    repeat += 1
                    if repeat >= 4:
                        return {"text": ""}
                else:
                    repeat = 1
        return {"text": text}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc


def _sniff_audio_upload(data: bytes) -> tuple[str, str]:
    """Pick a remote-STT filename and MIME matching the recorded bytes.

    Browsers record webm/opus for both live and dictate, but the upload
    field carries no reliable name. Some OpenAI-compatible STT gateways pick
    the decoder from the filename extension, so webm bytes forwarded as
    clip.wav are rejected with "could not process file". Sniff the magic
    bytes so the forwarded file always carries the right extension.
    """
    head = bytes(data[:12])
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "clip.webm", "audio/webm"
    if head.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WAVE":
        return "clip.wav", "audio/wav"
    if head.startswith(b"OggS"):
        return "clip.ogg", "audio/ogg"
    if head.startswith(b"fLaC"):
        return "clip.flac", "audio/flac"
    if head.startswith(b"ID3") or (
        len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0
    ):
        return "clip.mp3", "audio/mpeg"
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return "clip.mp4", "audio/mp4"
    # Keep the previous contract for unknown bytes.
    return "clip.wav", "application/octet-stream"


async def _transcribe_remote(
    data: bytes,
    provider_kind: str,
    base_url: str,
    api_key: str,
    env_var: str,
    model: str,
    lang: str | None,
) -> dict:
    """Forward an audio clip to an OpenAI-compatible /audio/transcriptions endpoint."""
    import httpx

    if not base_url:
        raise HTTPException(status_code=400, detail="remote STT needs 'base_url'")
    url = f"{base_url.rstrip('/')}/audio/transcriptions"
    key = api_key or providers.env_key(provider_kind, env_var)
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    filename, mime = _sniff_audio_upload(data)
    files = {"file": (filename, data, mime)}
    payload: dict[str, str] = {"model": model or "whisper-1"}
    if lang:
        payload["language"] = lang
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, files=files, data=payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote transcription failed: {exc}") from exc
    if resp.status_code >= 400:
        # Gateways often return an HTML error page here; strip tags so raw
        # markup never reaches the frontend (it must not land in the composer).
        import re as _re_transcribe_html

        raw_detail = resp.text.strip()[:500]
        raw_detail = _re_transcribe_html.sub(r"<[^>]*>", " ", raw_detail)
        raw_detail = " ".join(raw_detail.split())[:300]
        detail = raw_detail or f"remote transcription failed ({resp.status_code})"
        raise HTTPException(status_code=502, detail=detail)
    try:
        body = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote transcription bad response: {exc}") from exc
    text = str(body.get("text", "")).strip()
    # Never return HTML error pages as successful transcription: gateways
    # sometimes embed an HTML page in a 200 JSON payload; it must surface
    # as an error (banner) instead of polluting the composer input.
    lowered = text.lower()
    if text and ("<link" in lowered or "/_next/" in text or "&lt;" in lowered or "<html" in lowered):
        raise HTTPException(status_code=502, detail="remote transcription returned an error page — please try again")
    return {"text": text}


# Local TTS defaults delegate to backend/local_tts.py (swappable provider).
# Active provider is pocket-tts-farsi-v2; Piper constants stay as legacy aliases.
import local_tts as _local_tts

DEFAULT_PIPER_VOICE = _local_tts.default_voice_id()
PIPER_VOICES_REPO = _local_tts.POCKET_REPO
_PIPER_KIND = "piper"


def _normalize_piper_voice_id(voice_id: str) -> str:
    """Normalize a local TTS voice id (delegates to local_tts)."""
    return _local_tts.normalize_voice_id(voice_id)


def _piper_voice_dir() -> str:
    """Return the local TTS model dir (delegates to local_tts)."""
    return _local_tts.local_tts_dir()


def _piper_download_snapshot() -> dict:
    """Return a JSON-serializable copy of the local TTS download state."""
    return _local_tts.download_snapshot()


def _resolve_tts_voice_id(req: TtsRequest) -> str:
    """Resolve the requested local voice id (delegates to local_tts)."""
    return _local_tts.resolve_voice_id(req.model, req.voice, req.ttsModel, req.ttsVoice)


def _resolve_piper_voice_path_legacy(voice_id: str) -> str:
    """Resolve a Piper voice id to a local .onnx file under ~/.codifa/models/piper-voices."""
    import os
    from pathlib import Path

    cleaned = (voice_id or "").strip() or DEFAULT_PIPER_VOICE
    if cleaned.endswith(".onnx.json"):
        cleaned = cleaned[: -len(".onnx.json")]
    elif cleaned.endswith(".onnx"):
        cleaned = cleaned[: -len(".onnx")]
    if cleaned.lower() == "local":
        cleaned = DEFAULT_PIPER_VOICE
    # Direct .onnx path (absolute or relative) wins when it exists.
    direct = Path(f"{cleaned}.onnx")
    try:
        if direct.is_file():
            return str(direct)
    except OSError:
        pass
    candidates: list[Path] = []
    env_dir = os.environ.get("PIPER_VOICE_DIR", "").strip()
    if env_dir:
        candidates.append(Path(env_dir) / f"{cleaned}.onnx")
    home = Path.home()
    candidates.extend(
        [
            home / ".codifa" / "models" / f"{cleaned}.onnx",
            home / ".codifa" / "models" / "piper" / f"{cleaned}.onnx",
            home / ".codifa" / "models" / "piper-voices" / f"{cleaned}.onnx",
            Path("models") / "piper" / f"{cleaned}.onnx",
        ]
    )
    for path in candidates:
        try:
            if path.is_file():
                return str(path)
        except OSError:
            continue
    # Cloned piper-voices repo layout (e.g. fa/fa_IR/amir/medium/<voice>.onnx):
    # lightweight recursive search limited to the piper roots only.
    search_roots = [
        home / ".codifa" / "models" / "piper-voices",
        home / ".codifa" / "models" / "piper",
    ]
    for root in search_roots:
        try:
            if not root.is_dir():
                continue
            for match in root.rglob(f"{cleaned}.onnx"):
                try:
                    if match.is_file():
                        return str(match)
                except OSError:
                    continue
        except OSError:
            continue
    # Build a helpful error listing every checked location plus what is
    # actually on disk (filename mismatches are the common cause).
    checked = [str(p) for p in candidates]
    present: list[str] = []
    for root in search_roots:
        try:
            if not root.is_dir():
                continue
            import os as _os

            for name in sorted(_os.listdir(root))[:20]:
                present.append(name)
            break
        except OSError:
            continue
    hint = (
        f"Piper voice '{cleaned}' is not downloaded. Checked: "
        f"{'; '.join(checked)}. "
        f"Place '{cleaned}.onnx' and '{cleaned}.onnx.json' from "
        f"'{PIPER_VOICES_REPO}' directly under ~/.codifa/models/piper-voices/ "
        f"(also accepted: ~/.codifa/models/, ~/.codifa/models/piper/, $PIPER_VOICE_DIR, "
        f"or a cloned repo layout fa/fa_IR/... under piper-voices/). "
        f"Or download via POST /models/download with kind 'piper' and model '{cleaned}'."
    )
    if present:
        hint += f" Files in piper dir: {', '.join(present)}."
    raise HTTPException(status_code=400, detail=hint)


def _synthesize_piper_wav(text: str, voice_path: str) -> bytes:
    """Synthesize WAV bytes with the active local TTS provider (pocket v2)."""
    voice_id = (voice_path or "").strip() or DEFAULT_PIPER_VOICE
    return _local_tts.synthesize_wav(text, voice_id)


@app.post("/tts")
async def text_to_speech(req: TtsRequest) -> Response:
    """Synthesize text to speech locally (Piper) or via a remote endpoint.

    Local (`provider` or `ttsProvider`/`ttsProviderId` equal to "local"):
    on-device pocket-tts-farsi-v2 with the bundled default voice (`ttsModel`
    selects the voice, default `default`). `ttsBaseUrl` is accepted as an
    optional mirror hint; models are never auto-downloaded
    (use POST /models/download with kind 'piper').
    Remote (any other provider): forwarded to `POST {base_url}/audio/speech`
    with {"model", "input", "voice"} and streamed back as audio bytes.
    Local failures return a transparent error `detail`; the frontend falls
    back to a remote provider.
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="missing 'text' field")
    provider_kind = (req.provider or "").strip()
    tts_provider = (req.ttsProvider or "").strip()
    tts_provider_id = (req.ttsProviderId or "").strip()
    if provider_kind == "local" or tts_provider == "local" or tts_provider_id == "local":
        import asyncio

        voice_id = _resolve_tts_voice_id(req)
        # Pocket synthesis (G2P + model load + vocoding) blocks the CPU for
        # many seconds: run it off the event loop so one speaker-icon click
        # never hangs the whole server (models/status polls, chat, ...).
        wav_bytes = await asyncio.to_thread(_local_tts.synthesize_wav, text, voice_id)
        return Response(content=wav_bytes, media_type="audio/wav")
    if not provider_kind:
        # Empty provider is a malformed request, not a remote one: without a
        # kind there is nothing to route to (kept from the pre-local-TTS
        # contract so misconfigured callers fail fast with a clear cause).
        raise HTTPException(status_code=400, detail="missing 'provider' field")
    import httpx

    base_url = (req.base_url or "").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="remote TTS needs 'base_url'")
    url = f"{base_url.rstrip('/')}/audio/speech"
    key = (req.api_key or "").strip() or providers.env_key(provider_kind, (req.env_var or "").strip())
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    # Some OpenAI-compatible gateways (e.g. multi-vendor routers like 9router)
    # block unknown HTTP clients by User-Agent (HTTP 401 "unauthorized client")
    # while allowing well-known agent CLIs — same UA the chat path sends for
    # custom gateways (see llm._request_headers). Harmless for servers that
    # don't filter (llama.cpp/Ollama/LM Studio just ignore the header).
    headers["User-Agent"] = providers.UA_LADDER[0]
    payload: dict = {"input": text}
    # Skip empty model/voice: some providers reject unknown extra fields.
    # When set, they are forwarded as before.
    tts_model = (req.model or "").strip()
    if tts_model:
        payload["model"] = tts_model
    tts_voice = (req.voice or "").strip()
    if tts_voice:
        payload["voice"] = tts_voice
    # Open the upstream in streaming mode so bytes are forwarded immediately.
    # The client/response pair is closed in the generator's finally block after
    # the stream ends (or the downloader disconnects and FastAPI cancels us).
    try:
        client = httpx.AsyncClient(timeout=120.0)
        upstream_req = client.build_request("POST", url, headers=headers, json=payload)
        upstream = await client.send(upstream_req, stream=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"remote speech synthesis failed: {exc}") from exc
    if upstream.status_code >= 400:
        try:
            err_body = (await upstream.aread()).decode("utf-8", errors="replace").strip()[:500]
        except Exception:  # noqa: BLE001 — error body is best-effort
            err_body = ""
        try:
            await upstream.aclose()
        except Exception:  # noqa: BLE001, S110 — cleanup must not raise
            pass
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001, S110 — cleanup must not raise
            pass
        detail = err_body or f"remote speech synthesis failed ({upstream.status_code})"
        raise HTTPException(status_code=502, detail=detail)
    media_type = (upstream.headers.get("content-type") or "audio/mpeg").split(";")[0].strip() or "audio/mpeg"

    async def _audio_stream():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=32 * 1024):
                if chunk:
                    yield chunk
        finally:
            try:
                await upstream.aclose()
            except Exception:  # noqa: BLE001, S110 — cleanup must not raise
                pass
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001, S110 — cleanup must not raise
                pass

    return StreamingResponse(_audio_stream(), media_type=media_type)


class RealtimeSessionRequest(BaseModel):
    """POST /realtime/session — mint an ephemeral realtime token without exposing the master key."""

    provider: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: dict | list | str | None = None
    model: str = ""
    voice: str = ""


def _resolve_realtime_key(req: RealtimeSessionRequest) -> str:
    """Resolve the master key server-side from explicit fields, a key map, or env."""
    direct = (req.api_key or "").strip()
    if direct:
        return direct
    keys = req.api_keys
    if isinstance(keys, str) and keys.strip():
        stripped = keys.strip()
        if stripped.startswith("[") or stripped.startswith("{"):
            try:
                import json as _json_keys

                parsed = _json_keys.loads(stripped)
                if isinstance(parsed, list):
                    for value in parsed:
                        if isinstance(value, str) and value.strip():
                            return value.strip()
                elif isinstance(parsed, dict):
                    keys = parsed
                else:
                    return stripped
            except Exception:
                return stripped
        else:
            return stripped
    if isinstance(keys, dict) and keys:
        provider = (req.provider or "").strip()
        if provider and isinstance(keys.get(provider), str) and keys[provider].strip():
            return keys[provider].strip()
        for fallback in ("default", "openai", "realtime"):
            value = keys.get(fallback)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in keys.values():
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(keys, list) and keys:
        for value in keys:
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(keys, str) and keys.strip():
        return keys.strip()
    return providers.env_key((req.provider or "").strip(), (req.env_var or "").strip()) or ""


def _realtime_websocket_url(base_url: str, model: str) -> str:
    """Derive a realtime websocket URL from an HTTP(S) base URL."""
    base = base_url.rstrip("/")
    ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
    if ws_base.endswith("/realtime"):
        url = ws_base
    else:
        url = f"{ws_base}/realtime"
    if model:
        url = f"{url}?model={quote(model)}"
    return url


@app.post("/realtime/session")
async def realtime_session(req: RealtimeSessionRequest) -> dict:
    """Create an ephemeral realtime session server-side and return only the temporary token."""
    import httpx

    base_url = (req.base_url or "").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="remote realtime needs 'base_url'")
    model = (req.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="missing 'model' field")
    master_key = _resolve_realtime_key(req)
    if not master_key:
        raise HTTPException(status_code=400, detail="missing api key for realtime session")
    url = f"{base_url.rstrip('/')}/realtime/client_secrets"
    payload: dict = {"session": {"type": "realtime", "model": model}}
    voice = (req.voice or "").strip()
    if voice:
        payload["session"]["audio"] = {"output": {"voice": voice}}
    headers = {"Authorization": f"Bearer {master_key}"}
    headers["User-Agent"] = providers.UA_LADDER[0]
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.post(url, headers=headers, json=payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"realtime session failed: {exc}") from exc
    if upstream.status_code >= 400:
        try:
            err_body = upstream.text.strip()[:500]
        except Exception:
            err_body = ""
        # Gateways often return an HTML error page here; strip tags so the
        # frontend hint never shows raw markup.
        import re as _re_html

        err_body = _re_html.sub(r"<[^>]*>", " ", err_body)
        err_body = " ".join(err_body.split())[:300]
        detail = err_body or f"realtime session failed ({upstream.status_code})"
        raise HTTPException(status_code=502, detail=detail)
    try:
        body = upstream.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    ephemeral_token = ""
    expires_at: int | None = None
    client_secret = body.get("client_secret")
    if isinstance(client_secret, dict):
        value = client_secret.get("value")
        if isinstance(value, str):
            ephemeral_token = value.strip()
        raw_expires = client_secret.get("expires_at")
        if isinstance(raw_expires, (int, float)):
            expires_at = int(raw_expires)
    for key in ("ephemeral_token", "token", "client_token", "value"):
        if not ephemeral_token and isinstance(body.get(key), str):
            ephemeral_token = body[key].strip()
    if not ephemeral_token:
        raise HTTPException(status_code=502, detail="realtime session failed: upstream did not return a token")
    raw_url = body.get("websocket_url")
    if isinstance(raw_url, str) and raw_url.strip():
        websocket_url = raw_url.strip()
    else:
        websocket_url = _realtime_websocket_url(base_url, model)
    if expires_at is None:
        raw_expires = body.get("expires_at")
        if isinstance(raw_expires, (int, float)):
            expires_at = int(raw_expires)
        else:
            expires_at = int(time.time()) + 60
    return {"ephemeral_token": ephemeral_token, "websocket_url": websocket_url, "expires_at": expires_at}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _is_read_timeout(exc: BaseException) -> bool:
    """True when ``exc`` (or its ``__cause__`` chain) is a read timeout.

    The provider sent no data for the whole read window (httpx.ReadTimeout /
    httpcore.ReadTimeout). Used to show the "tap Retry" hint instead of the
    generic "just wait" message.
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if "ReadTimeout" in type(cur).__name__:
            return True
        cur = cur.__cause__
    return False


def _friendly_error(exc: Exception, model: str, base_url: str = "") -> str:
    text = str(exc)
    # httpx.ReadTimeout / httpcore.ReadTimeout: the provider sent no data for
    # the whole read window (300s). The run already retried + resumed, so the
    # actionable advice is "tap Retry", not the generic "just wait" hint below.
    if _is_read_timeout(exc):
        return (
            "The provider didn't send any data for over 5 minutes (read timeout). "
            "Tap Retry to resume from where it left off — or switch to a faster "
            "model in Settings if this keeps happening."
        )
    # _ModelSilenceTimeout from _with_keepalive: the socket stayed alive via
    # keepalives but the model produced nothing for MODEL_SILENCE_CAP_S. The
    # generic branches below would bury this under a misleading hint, so give
    # it its own actionable message.
    if isinstance(exc, _ModelSilenceTimeout):
        return (
            "The model went silent mid-stream and the run was closed to recover "
            f"({exc}). Tap Retry to resume from where it left off, or switch to "
            "another model in Settings if this keeps happening."
        )
    # A bare `asyncio.TimeoutError` (and similar) has an EMPTY str() — the type
    # name is the only clue. Turn it into a readable timeout message so the user
    # isn't left with the generic fallback at the bottom.
    if not text.strip():
        text = "The model request timed out (no data arrived from the provider for an extended period)."
    # LangChain HTTP errors render as: status_code: 400, model_name: ...,
    # body: {'message': '...'} (or body: [{'error': {'message': '...'}}] from
    # Gemini's OpenAI-compat endpoint). Pull out the server's own message.
    detail = ""
    m = re.search(r"body:\s*(\{.*\})", text, re.DOTALL)
    if m:
        try:
            body = ast.literal_eval(m.group(1))
            if not isinstance(body, dict):
                detail = ""
            else:
                detail = body.get("message") or body.get("error") or ""
                if isinstance(detail, dict):
                    detail = str(detail)
                # OpenRouter / ai-gateway-style wrappers bury the REAL upstream
                # error inside `metadata.raw` as an escaped JSON string. When the
                # outer message is the generic "Provider returned error" (their
                # default wrapper), dig one level deeper to surface the actual
                # failure — otherwise the user sees a useless "Provider returned
                # error" with no clue what went wrong.
                meta = body.get("metadata") if isinstance(body, dict) else None
                raw = meta.get("raw") if isinstance(meta, dict) else None
                if (
                    isinstance(raw, str)
                    and (detail or "").strip().lower() in ("provider returned error", "")
                ):
                    try:
                        inner = ast.literal_eval(raw)
                        inner_msg = (
                            inner.get("message")
                            if isinstance(inner, dict)
                            else None
                        )
                        if isinstance(inner_msg, str) and inner_msg.strip():
                            detail = inner_msg
                    except (ValueError, SyntaxError, TypeError, AttributeError):
                        pass
        except (ValueError, SyntaxError, TypeError, AttributeError):
            detail = ""
    if not detail:
        # Array form: body: [{'error': {'code': ..., 'message': ..., 'status': ...}}]
        m = re.search(r"body:\s*(\[.*\])", text, re.DOTALL)
        if m:
            try:
                arr = ast.literal_eval(m.group(1))
                if isinstance(arr, list) and arr:
                    err = arr[0].get("error") or {} if isinstance(arr[0], dict) else {}
                    if isinstance(err, dict):
                        detail = err.get("message") or str(err)
                    else:
                        detail = str(err)
            except (ValueError, SyntaxError, TypeError):
                detail = ""
    if detail:
        text = detail
    low = text.lower()
    # Credential errors raised by providers.build_model are already actionable
    # (they tell the user exactly what to fix in Settings) — never wrap them in
    # a generic hint on top.
    if "settings → providers" in low:
        return text
    if (
        "all connection attempts failed" in low
        or "connection refused" in low
        or "connecterror" in low
        or "getaddrinfo" in low
        or "no connection could be made" in low
        or "name or service not known" in low
        or "unable to connect" in low
        or "connect call failed" in low
    ):
        endpoint = (base_url or "").strip()
        hint = f" at {endpoint}" if endpoint else ""
        text += (
            f"\n\nCouldn't connect to the provider endpoint{hint}. For a local server "
            "(llama.cpp/Ollama) make sure it's actually running and the base URL/port in "
            "Settings are correct. For a cloud provider, check the base URL and your "
            "internet connection."
        )
    elif (
        "401" in low
        or "invalid api key" in low
        or "unauthorized" in low
        or "auth error" in low
        or "authentication" in low
    ):
        text += (
            "\n\nThe API key for this provider is invalid, expired, or missing. Open "
            "Settings → Providers and check the API keys list."
        )
    elif (
        "incomplete chunked read" in low
        or "peer closed connection" in low
        or "connection was closed" in low
        or "remote protocol error" in low
        or "connection dropped" in low
    ):
        text += (
            "\n\nThe connection to the model was dropped mid-stream (the upstream closed the "
            "request while streaming a reply). This is usually transient — retry the same "
            "message, or switch to another model in Settings if it keeps happening."
        )
    elif "timed out" in low or "timeout" in low:
        text += (
            "\n\nThe connection stalled mid-stream (the provider was slow to send the "
            "next chunk). The run auto-resumes from the tool work already done, so "
            "just wait; if it keeps happening, switch to a faster model in Settings "
            "or compact the conversation."
        )
    elif "output retries" in low or "return text or call a tool" in low or "unexpectedmodelbehavior" in low:
        text += (
            "\n\nThe model returned no usable reply (empty or invalid response). This model/provider"
            " is unreliable for this turn — switch model in Settings and retry."
        )
    elif "no generation chunks" in low:
        text = (
            "The provider returned an empty response (no content was generated). "
            "This usually means the model's quota/budget pool is exhausted or the "
            "route is unavailable — switch to another model in Settings and retry."
        )
    elif "unknown variant" in low and "image_url" in low:
        text += (
            "\n\nThe selected model does not support image/batch attachments (it rejects image"
            " content, only accepting text). Screenshots and attached images were ignored for"
            " this turn — switch to a vision-capable model in Settings to send them."
        )
    elif "429" in low or "rate limit" in low or "freeusagelimit" in low or "quota" in low or "request limit reached" in low or "resource exhausted" in low or "worker local" in low or "upstream error" in low:
        text += (
            "\n\nThis is a provider rate/request limit (the upstream is throttling or at "
            "capacity right now — e.g. 'ResourceExhausted: Worker local total request "
            "limit reached'). Wait ~30s and retry, or switch to another model in Settings."
        )
    elif "capacity" in low or "ttft" in low or "all providers" in low or "overloaded" in low:
        text += (
            "\n\nAll upstream providers for this model are temporarily at capacity (free tiers are "
            "routed to a small pool that fills fast). Wait a moment and retry, or switch to a "
            "another model in Settings."
        )
    elif ("context" in low or "context_length" in low or "token" in low) and any(
        w in low
        for w in (
            "maximum context length",
            "max context",
            "context length",
            "context window",
            "context_length_exceeded",
            "too large",
            "exceeded the context",
            "token limit",
            "reduce the length",
            "reducing available tokens",
            "prompt is too long",
        )
    ):
        text += (
            "\n\nThe conversation is too long for this model's context window. "
            "Use /compact to summarize it (or start a new chat with /new), then retry."
        )
    elif "tool-loop step budget" in low or "compacting earlier turns" in low:
        text += (
            "\n\nThis task needed more tool calls (file searches, edits, etc.) than the safety "
            "budget allows, even after the budget was raised and the conversation was compacted "
            "automatically. Try breaking the request into smaller steps, or continue by asking to "
            "pick up where it left off."
        )
    elif "403" in low or "access denied" in low or "security policy" in low:
        text += (
            "\n\nThis looks like an OpenRouter gateway block (some regions/keys can't reach it). "
            "Try a different provider (Settings → Providers), or a custom OpenAI-compatible "
            "gateway with your own base URL and key."
        )
    elif "thought_signature" in low:
        text = (
            "Gemini 3.x models require a thought signature to be echoed back on every "
            "tool call. The app's native Google connector handles this automatically — "
            "restart the app and retry the same message. If it still fails, switch to a "
            "Gemini 2.x model or another provider."
        )
    elif (
        "no google credential configured" in low
        or "set the google_api_key" in low
        or "pass it via googleprovider" in low
        or "googleprovider(api_key" in low
    ):
        text += (
            "\n\nThe Google provider has no usable credential. Open Settings → Providers → "
            "Google and add an API key."
        )
    elif any(
        word in low
        for word in (
            "not a valid model",
            "model not found",
            "unknown model",
            "404",
            "400",
        )
    ):
        text += (
            f"\n\nThe model '{model}' was rejected by the server. Open Settings and "
            "pick a valid model for the selected provider, or check your API key/base URL."
        )
    else:
        text += (
            "\n\nUnexpected provider error. Wait a moment and retry; if it persists, "
            "verify your API key and provider settings in Settings."
        )
    return text[:2000]


# --- chat titles (Title generator tool) ----------------------------------- #
# One tiny LLM call naming a new chat from its first message. Runs on the
# "title" tool slot (Settings -> Tools), falling back to "compact" then the
# main model. Input is capped (~500 chars) and output to ~24 tokens so the
# call costs almost nothing and never touches the main turn's context.
TITLE_TIMEOUT = 25  # seconds — outer budget for the whole call
TITLE_CLIENT_TIMEOUT = 20  # seconds — model client ceiling (below the budget)
# System prompt for the title call. The raw first message is wrapped as data
# ("Message: ... / Title:") so the model names the chat instead of answering
# it — bare user text made some models reply to the question ("Sorry, ...").
TITLE_SYSTEM = (
    "You name chats. The text below is the FIRST message of a new chat. "
    "Do NOT answer it, do NOT explain, do NOT apologize. "
    "Reply with ONLY a very short noun-phrase title of at most 4 words, "
    "plain text, no quotes."
)


# Reply openers proving the model answered the message instead of naming the
# chat ("Sorry, ...", "متأسفانه ..."). Such replies are rejected so the next
# candidate or the heuristic fallback is used instead.
_APOLOGY_PREFIXES = (
    "sorry", "i'm sorry", "i am sorry", "i can't", "i cannot",
    "as an ai", "unfortunately", "متاسفانه", "متأسفانه",
    "ببخشید", "شرمنده",
)


def _clean_title(text: str) -> str | None:
    """Normalize a raw title reply to one short line (<=4 words, <=60 chars)."""
    lines = (text or "").strip().splitlines()
    first = lines[0].strip() if lines else ""
    first = first.strip("\"'“”‘’").strip()
    first = re.sub(r"\s+", " ", first)
    if first.lower().startswith("title:"):
        first = first[6:].strip().strip("\"'").strip()
        first = re.sub(r"\s+", " ", first)
    if first.lower().startswith(_APOLOGY_PREFIXES):
        return None
    words = [w for w in first.split(" ") if w]
    if len(words) > 4:
        words = words[:4]
    first = " ".join(words).rstrip(" ,.:;-").strip()
    if len(first) > 60:
        first = first[:60].rstrip()
    return first or None


class TitleRequest(BaseModel):
    """POST /chats/title — name a new chat from its first user message."""

    provider: str = "custom"
    provider_id: str = ""
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    api_keys: list[str] = []
    subagent_models: dict = {}
    providers: dict = {}
    text: str = ""
    chat_id: str = ""


class _ModelSilenceTimeout(Exception):
    """The model stayed silent past MODEL_SILENCE_CAP_S while the socket was
    still alive (keepalives kept flowing). Raised by `_with_keepalive` so the
    stream is closed and the frontend can auto-resume from its checkpoint
    instead of ticking "waiting for model" forever."""


async def _with_keepalive(
    agent_iter,
    timeout: float = 15.0,
    max_silence: float | None = None,
    is_paused: Callable[[], bool] | None = None,
):
    """Yield agent SSE events, injecting a keepalive sentinel whenever the agent
goes silent for `timeout` seconds so idle sockets survive proxy/OS/TCP
timeouts mid-stream. The frontend forwards `: `-prefixed lines as a
`keepalive` event and refreshes its stall watchdog, so a long-running tool is
never mistaken for a dead connection.

    `max_silence` caps the TOTAL continuous silence (measured from the first
    keepalive, not from stream start): once exceeded, `_ModelSilenceTimeout`
    is raised so the run is torn down and surfaced as an error event instead of
    keepaliving forever on a wedged provider stream. `is_paused` suspends the
    cap while the agent legitimately waits on a permission/ask gate — the user
    can take arbitrarily long to answer, and that silence is not a stall.

    IMPORTANT: `shield` only protects `pending` from the keepalive timeout —
    it does NOT mean a real outer cancellation (client disconnect / aborted
    fetch) should leave the agent running. If this generator itself gets
    cancelled (or closed) while `pending` is in flight, we must explicitly
    cancel `pending` too, otherwise the underlying run_graph/_drive task keeps
    running orphaned in the background with nobody consuming its events. Left
    alone, it eventually reaches a "clean finish" and clears the interrupted-turn
    resume checkpoint (LangGraph checkpointer) even though the user never saw the
    result — the bug behind "interrupts with no log/error and the resume state is
    gone"."""
    pending = None
    silence_started: float | None = None
    # True while the model's reasoning window is open (a `thinking active:True`
    # event arrived and no `active:False` followed). Silence in that window is
    # legitimate thinking, never a stall, so it is not counted against the cap.
    thinking_active = False
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(agent_iter.__anext__())
            try:
                # shield keeps the in-flight __anext__() alive across the
                # keepalive TIMEOUT specifically — we just keep waiting and
                # emit sentinels. A genuine outer cancellation is handled by
                # the try/except CancelledError wrapping the whole loop below.
                event = await asyncio.wait_for(asyncio.shield(pending), timeout=timeout)
                pending = None
                if isinstance(event, dict) and event.get("kind") == "thinking":
                    thinking_active = bool(event.get("active"))
                yield event
                # A real event resets the silence clock: the model produced
                # something, so any cap accumulated so far no longer counts.
                silence_started = None
            except asyncio.TimeoutError:
                if thinking_active:
                    # Model is thinking: no silence cap, however long it takes.
                    # Keep the socket alive and don't start/accumulate the clock;
                    # the next real event (end of thinking / first token) resets it.
                    silence_started = None
                    yield {"kind": "_keepalive"}
                    continue
                if silence_started is None:
                    silence_started = time.monotonic()
                if (
                    max_silence is not None
                    and not (is_paused and is_paused())
                    and time.monotonic() - silence_started > max_silence
                ):
                    raise _ModelSilenceTimeout(
                        f"model silent for {int(time.monotonic() - silence_started)}s "
                        "(no events while keepalives kept the socket alive)"
                    )
                yield {"kind": "_keepalive"}
            except StopAsyncIteration:
                return
    finally:
        # Runs on EVERY exit path — CancelledError (Starlette aborts with this
        # in some paths), GeneratorExit (Starlette aborts with this in others),
        # or plain exhaustion. Without this, a GeneratorExit raised while
        # `await asyncio.shield(pending)` is suspended leaves `pending` (the
        # in-flight agent_iter.__anext__(), i.e. run_graph's queue.get()) alive:
        # shield deliberately does NOT propagate the cancellation into it, and
        # the old except-CancelledError-only handler never fired. The orphaned
        # task then keeps pulling tokens from the LLM provider, and the later
        # agent_gen.aclose() in _stream_drive fails with "async generator is
        # already running" (silently suppressed) — so run_graph's finally never
        # runs, _drive is never cancelled, and the provider stream keeps
        # token-burning after Stop. Cancel + reap it here so aclose() can
        # actually unwind the chain.
        if pending is not None and not pending.done():
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pending


async def _abort_close(ka_gen, agent_gen) -> None:
    """Tear down a stream on abort: close the keepalive wrapper FIRST, then the
    agent generator.

    Order matters. Closing ``ka_gen`` runs ``_with_keepalive``'s ``finally``,
    which cancels any in-flight ``agent_iter.__anext__()`` task. Only then is
    ``agent_gen`` no longer being driven, so ``agent_gen.aclose()`` can actually
    throw GeneratorExit into ``run_agent`` → ``run_graph``'s ``finally`` →
    ``_drive`` cancelled → the provider HTTP stream is aborted. Closing the
    agent first (while the __anext__ task is still driving it) fails with
    "async generator is already running" and — silently suppressed — leaves the
    provider stream token-burning after Stop.
    """
    with contextlib.suppress(Exception):
        await ka_gen.aclose()
    with contextlib.suppress(Exception):
        await agent_gen.aclose()


class SteerRequest(BaseModel):
    chat_id: str = ""
    id: str = ""
    prompt: str = ""
    attachments: list[str] = []
    images: list = []  # قرارداد یکسان با ChatRequest شامل path و dataUrl
    skills: list[str] = []
    # Full-fidelity history snapshot (same shape as ChatRequest.history).
    # Accepted for forward-compat but intentionally NOT enqueued: a running
    # turn already holds the live transcript, so re-attaching history here
    # would duplicate context and waste tokens.
    history: list[dict] = []


class SteerCancelRequest(BaseModel):
    chat_id: str = ""
    id: str = ""


# ---------------------------------------------------------------------------
# Background sub-agents (per-chat) — right-panel live view + stop/steer from
# the UI, mirroring the main agent's task_steer/task_stop tools.
# ---------------------------------------------------------------------------


class SubagentSteerRequest(BaseModel):
    message: str = ""


def _subagent_job_view(job: dict) -> dict:
    """Public JSON shape of one background sub-agent job (no live internals)."""
    return {
        "task_id": str(job.get("task_id") or ""),
        "branch": int(job.get("branch") or 0),
        "description": str(job.get("description") or ""),
        "subagent_type": str(job.get("subagent_type") or ""),
        "status": str(job.get("status") or ""),
        "created_at": float(job.get("created_at") or 0.0),
        "steering": bool(job.get("steer_inbox")),
        "stop_requested": bool(job.get("stop_requested")),
        "report": str(job.get("report") or "")[:400],
        "events": [
            {
                "text": str(e.get("text") or ""),
                "tool": str(e.get("tool") or ""),
                "kind": str(e.get("kind") or "status"),
            }
            for e in (job.get("events") or [])[-14:]
        ],
    }


class MemoryRequest(BaseModel):
    """Root + optional vector-store folder for memory stats / clear."""

    root: str = ""
    vector_db_path: str = ""


class MemoryStatsResponse(BaseModel):
    available: bool = False
    db: str = ""
    docs: int = 0
    chunks: int = 0
    kinds: dict[str, int] = {}
    max_docs: int = 0
    max_chunks: int = 0
    ttl_days: int = 0


class MemoryClearResponse(BaseModel):
    ok: bool = False
    error: str = ""


@app.get("/memory/stats")
async def memory_stats(
    root: Annotated[str, Query(min_length=1, description="Workspace root")] = "",
    vector_db_path: Annotated[str, Query(description="Optional vector-store folder")] = "",
) -> MemoryStatsResponse:
    from tools import open_vector_store

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(root, vector_db_path)
    if store is None:
        return MemoryStatsResponse()
    try:
        return MemoryStatsResponse(available=True, **store.stats())
    except Exception as exc:  # noqa: BLE001
        return MemoryStatsResponse(available=False, db="", error=str(exc))


@app.post("/memory/clear")
async def memory_clear(req: MemoryRequest) -> MemoryClearResponse:
    from tools import open_vector_store

    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(req.root, req.vector_db_path)
    if store is None:
        raise HTTPException(status_code=503, detail="could not open vector store")
    try:
        store.clear()
        return MemoryClearResponse(ok=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not clear vector store: {exc}") from exc


# ---------------------------------------------------------------------------
# Index / retrieval / cleanup endpoints
# ---------------------------------------------------------------------------


class IndexStatusResponse(BaseModel):
    available: bool = False
    db: str = ""
    docs: int = 0
    chunks: int = 0
    kinds: dict[str, int] = {}
    embedder: bool = False
    needs_index: bool = False


class IndexRunRequest(BaseModel):
    root: str = ""
    vector_db_path: str = ""
    vector_config: dict | None = None
    budget: int = 0  # 0 = default limited budget (avoid waking embedder on open)


class IndexRunResponse(BaseModel):
    ok: bool = False
    total: int = 0
    indexed: int = 0
    pruned: int = 0
    skipped: int = 0
    unchanged: int = 0
    error: str = ""


class CleanupRunRequest(BaseModel):
    root: str = ""
    vector_db_path: str = ""


class CleanupRunResponse(BaseModel):
    ok: bool = False
    evicted: int = 0
    pruned_files: int = 0
    vacuumed: bool = False
    cache_purged: int = 0
    error: str = ""


def _open_store(root: str, vector_db_path: str):
    """Open the workspace store or raise 400 with a clear message."""
    from tools import open_vector_store

    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="invalid project root")
    store = open_vector_store(root, vector_db_path)
    if store is None:
        raise HTTPException(status_code=503, detail="vector store unavailable")
    return store


@app.get("/index/status")
async def index_status(
    root: Annotated[str, Query(min_length=1, description="Workspace root")] = "",
    vector_db_path: Annotated[str, Query(description="Optional vector-store folder")] = "",
) -> IndexStatusResponse:
    # Lightweight gate: file-presence check only, never loads the model so
    # status polling does not pin the ~1.1 GB session in RAM.
    from embeddings import is_available as embedder_available
    from indexer import needs_index

    try:
        store = _open_store(root, vector_db_path)
    except HTTPException:
        return IndexStatusResponse()
    try:
        stats = store.stats()
        return IndexStatusResponse(
            available=True,
            db=str(getattr(store, "_db_path", "")),
            docs=int(stats.get("docs", 0)),
            chunks=int(stats.get("chunks", 0)),
            kinds=dict(stats.get("by_kind", {})),
            embedder=embedder_available(),
            needs_index=bool(needs_index(store, root)),
        )
    except Exception as exc:  # noqa: BLE001
        return IndexStatusResponse(available=False, error=str(exc))


@app.post("/index/run")
async def index_run(req: IndexRunRequest) -> IndexRunResponse:
    from indexer import index_workspace

    store = _open_store(req.root, req.vector_db_path)
    # Cap the per-run embed budget so opening a workspace never wakes the
    # ~1.1 GB embedder for the whole repo; manual runs can still pass an
    # explicit budget up to the max.
    _default_budget = 120
    _max_budget = 500
    try:
        raw_budget = int(req.budget or 0)
    except (TypeError, ValueError):
        raw_budget = 0
    if raw_budget <= 0:
        budget = _default_budget
    else:
        budget = min(raw_budget, _max_budget)
    try:
        result = index_workspace(
            store,
            req.root,
            budget=budget,
        )
        return IndexRunResponse(ok=True, **result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"indexing failed: {exc}") from exc


@app.post("/cleanup/run")
async def cleanup_run(req: CleanupRunRequest) -> CleanupRunResponse:
    from cleanup import run_cleanup

    store = _open_store(req.root, req.vector_db_path)
    try:
        report = run_cleanup(store, req.root)
        return CleanupRunResponse(ok=True, **report)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"cleanup failed: {exc}") from exc


def _start_parent_watchdog() -> None:
    """Exit when the Electron parent dies, so no orphan sidecar survives.

    A hard restart / crash / kill -9 of the app skips Electron's graceful
    ``stopSidecar()``, leaving this Python process alive on its old port with
    torch + TTS + embedding weights resident (GBs each) and any in-flight turn
    still burning tokens. Electron passes its pid in CODIFA_PARENT_PID; when
    unset (standalone / tests) no watchdog runs.
    """
    import threading
    import time as _time

    raw = os.environ.get("CODIFA_PARENT_PID", "").strip()
    try:
        parent = int(raw) if raw else 0
    except ValueError:
        parent = 0
    if parent <= 1:
        return

    def _alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return True
        return True

    def _watch() -> None:
        while True:
            _time.sleep(3.0)
            if _alive(parent):
                continue
            logger.warning("parent process %s is gone; sidecar exiting", parent)
            try:
                import signal as _signal

                os.kill(os.getpid(), _signal.SIGTERM)  # graceful uvicorn shutdown
            except Exception:  # noqa: BLE001, S110
                pass
            _time.sleep(5.0)
            os._exit(0)  # graceful path hung: hard exit

    threading.Thread(target=_watch, name="parent-watchdog", daemon=True).start()


class SkillRouteRequest(BaseModel):
    """Request text plus the prefiltered skill candidates to route over."""

    prompt: str = ""
    rows: list[dict] = []
    chat_id: str = ""


class SkillRouteResponse(BaseModel):
    """Routed skill names; ``skills`` is null when Laya is unavailable."""

    skills: list[str] | None = None
    error: str = ""


@app.post("/skills/route")
async def skills_route(req: SkillRouteRequest) -> SkillRouteResponse:
    """Route a request to skills with the on-device Laya classifier.

    The native Rust agent owns the turn loop AND candidate ranking (it hands
    over an already-ranked slice), but Laya is a torch/transformers checkpoint
    with no Rust runtime, so the agent asks this endpoint instead of dropping
    back to the keyword matcher (which silently ignored the user's
    Decision-model choice). ``skills: null`` means routing is unavailable (not
    downloaded / load failure) so the caller inlines nothing.
    """
    try:
        import laya_router
    except Exception as exc:  # noqa: BLE001 — routing never breaks the turn
        return SkillRouteResponse(error=f"laya unavailable: {exc}")
    rows = [r for r in (req.rows or []) if str(r.get("name") or "").strip()]
    if not rows:
        return SkillRouteResponse(skills=[])
    try:
        picks = laya_router.predict(req.prompt, rows, req.chat_id)
    except Exception as exc:  # noqa: BLE001 — routing never breaks the turn
        return SkillRouteResponse(error=f"laya route failed: {exc}")
    if picks is None:
        return SkillRouteResponse(error="laya unavailable")
    return SkillRouteResponse(skills=[str(n) for n in picks])


@app.get("/health")
async def health() -> dict:
    """Liveness probe for the Rust shell.

    The public router serves its own native /health; this one lives on the
    sidecar's private port and is what sidecar.rs polls while waiting for the
    process to come up (and for its liveness probe afterwards).
    """
    return {"status": "ok", "version": "1.0.0"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Codifa agent sidecar")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    _start_parent_watchdog()

    # Dump a C-level traceback to stderr on segfault/abort so a hard crash (e.g.
    # in onnxruntime/CTranslate2) is diagnosable instead of silent. The Electron
    # sidecar pipes this stderr to the app logs.
    try:
        import faulthandler

        faulthandler.enable()
    except Exception:  # noqa: BLE001, S110
        pass

    # Central file logging: every Python logger (retrieval, vector_store, and any
    # future module) appends WARNING+ to <data root>/codifa.log so a packaged app
    # whose stderr is not captured still leaves a persistent error trail behind.
    try:
        import logging
        import logging.handlers

        from _log_filter import ServerErrorOnlyFilter
        from tools import user_coder_dir

        _log_dir = user_coder_dir()
        os.makedirs(_log_dir, exist_ok=True)
        # Rotating handler: cap each log at 5 MB and keep 3 backups (15 MB total).
        # Without rotation, repeated run-start/complete lines + MEM-NOW/MEM-GROW
        # snapshot blocks push codifa.log into the hundreds-of-MB range over a
        # long session, and the file keeps growing forever.
        _handler = logging.handlers.RotatingFileHandler(
            os.path.join(_log_dir, "codifa.log"),
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s: %(message)s"
            )
        )
        # Default-on: silence the noisy per-run WARNING lines from codifa.server
        # ("agent run start/complete", "stream DISCONNECTED", rss snapshots …)
        # so codifa.log keeps only the genuine errors. Disconnect diagnostics
        # from graph.py / codifa.graph are unaffected (they reach the file
        # because they are emitted by a different logger name). Operators can
        # turn this off with CODFA_LOG_FILE_SERVER_ERROR_ONLY=0 if they need
        # the full per-run trail in the persistent log again.
        if os.environ.get("CODFA_LOG_FILE_SERVER_ERROR_ONLY", "1") != "0":
            _handler.addFilter(ServerErrorOnlyFilter())
        _root = logging.getLogger()
        # Allow raising the file-log verbosity via CODFA_LOG_LEVEL (e.g. "DEBUG"
        # or "WARNING") so diagnostic lines like graph.py's "[CTX_DEBUG]
        # auto_compact ..." reach the persistent log when needed. Defaults to
        # WARNING+ so every exception (logger.exception / logger.error / logger.warning)
        # lands in codifa.log — the persistent record the user reviews when a
        # run cuts off or errors silently.  Operators can raise to ERROR via
        # CODFA_LOG_LEVEL=ERROR to suppress warnings in the file.
        _level_name = os.environ.get("CODFA_LOG_LEVEL", "WARNING").upper()
        _root.setLevel(getattr(logging, _level_name, logging.WARNING))
        _root.addHandler(_handler)
        # Third-party libraries (httpx/httpcore transport noise, the openai SDK's
        # request/response debug, and aiosqlite's per-statement logging) emit an
        # enormous volume of DEBUG lines that bury the real signal and bloat the
        # persistent log (MBs of header dumps per agent run). Keep their file-log
        # verbosity capped at WARNING regardless of CODFA_LOG_LEVEL so a DEBUG
        # diagnostic session still produces a readable codifa.log. Our own
        # "codifa.*" modules are unaffected and follow CODFA_LOG_LEVEL as before.
        for _noisy in (
            "httpx",
            "httpcore",
            "openai",
            "openai._base_client",
            "aiosqlite",
        ):
            logging.getLogger(_noisy).setLevel(logging.WARNING)
        # Start allocation tracing when asked (off by default: tracemalloc adds a
        # small CPU/memory overhead). Enable via CODFA_TRACE_MALLOC=1, or
        # automatically when CODFA_LOG_LEVEL=DEBUG so a diagnostic session also
        # captures per-run allocation diffs.
        _maybe_start_tracemalloc()
    except Exception:  # noqa: BLE001, S110 — logging must never kill the sidecar
        pass

    # MCP connector validation and builtin seeding are native now — see
    # src-tauri/src/skills.rs (seed_builtin_mcp) and src-tauri/src/mcp.rs.

    # Seed built-in skills from backend/skills/*.md on every startup (no-op for
    # skills that already exist, so user edits/deletions are never overwritten).
    try:
        from tools import sync_builtin_skills

        sync_builtin_skills()
    except Exception:  # noqa: BLE001, S110 — a seed failure must not kill the sidecar
        pass

    import uvicorn

    # Ensure essential data-root dirs exist (settings.json, skills/, mcp/, plan/).
    try:
        import state_db

        state_db.bootstrap()
    except Exception:  # noqa: BLE001, S110
        pass

    # Resume state is held in LangGraph's checkpointer (a SQLite DB under the
    # data root). On startup, reclaim any checkpoint left behind by an
    # interrupted turn that was never resumed (errors/crashes), keyed by age.

    # Still prune orphaned plan dirs on shutdown.
    try:
        import atexit

        import state_db as _state_db

        atexit.register(lambda: _state_db.prune_orphan_plans())
    except Exception:  # noqa: BLE001, S110
        pass

    # Make sure any unhandled exception (e.g. in a background task, signal
    # handler, or top-level code path that bypasses FastAPI) still reaches the
    # persistent codifa.log — not just stderr, which Electron may not capture
    # in packaged mode. Without this, a hard crash inside a background task
    # only shows up as a single "Task exception was never retrieved" line that
    # the user can never see, which is exactly the "message cuts off" symptom.
    try:
        import sys

        def _excepthook(exc_type, exc_value, exc_tb):
            logging.getLogger("codifa.server").error(
                "unhandled exception (not caught by FastAPI):",
                exc_info=(exc_type, exc_value, exc_tb),
            )
            # Also call the default hook so the process still dies normally
            # and the traceback reaches stderr for live dev.
            sys.__excepthook__(exc_type, exc_value, exc_tb)

        sys.excepthook = _excepthook
    except Exception:  # noqa: BLE001, S110
        pass

    # Same for asyncio: an orphaned background task that raises will print
    # "Task exception was never retrieved" to stderr (often dropped by
    # Electron) and otherwise disappear. Wire the loop's exception handler so
    # the same traceback lands in codifa.log.
    try:

        def _asyncio_excepthook(loop, context):
            logging.getLogger("codifa.server").error(
                "asyncio task exception: %s",
                context,
                exc_info=context.get("exception"),
            )
            loop.default_exception_handler(context)

        # Defer until uvicorn creates the loop — installing it here would be
        # overwritten by uvicorn's own loop setup. We register it via an
        # atexit-like boot hook by wrapping the existing handler install path
        # after uvicorn.run starts; the simplest approach is to monkey-patch
        # asyncio.get_event_loop_policy later. Instead, install a one-shot
        # factory that wires the handler as soon as a loop is created.
        _orig_get_event_loop_policy = asyncio.get_event_loop_policy

        class _PolicyWithHandler:
            def __init__(self, inner):
                self._inner = inner
                self._installed = False

            def get_event_loop(self):
                loop = self._inner.get_event_loop()
                self._install(loop)
                return loop

            def new_event_loop(self):
                loop = self._inner.new_event_loop()
                self._install(loop)
                return loop

            def _install(self, loop):
                if self._installed:
                    return
                self._installed = True
                try:
                    loop.set_exception_handler(_asyncio_excepthook)
                except Exception:  # noqa: BLE001, S110
                    pass

            def __getattr__(self, name):
                return getattr(self._inner, name)

        asyncio.set_event_loop_policy(_PolicyWithHandler(_orig_get_event_loop_policy()))
    except Exception:  # noqa: BLE001, S110
        pass

    global _SIDECAR_PORT
    _SIDECAR_PORT = args.port
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
