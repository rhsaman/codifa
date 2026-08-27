"""FastAPI sidecar serving the Pydantic AI agent over SSE.

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
import traceback
from typing import Annotated
from urllib.parse import quote

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# Pending permission requests: id -> asyncio.Future. Resolved by the
# /permission/respond endpoint and awaited by the agent's request_permission /
# confirm_action tools.
PERMISSION_GATES: dict[str, asyncio.Future] = {}
# Pending multiple-choice / open questions the agent asked the user mid-task.
# Resolved by /ask/respond and awaited by the agent's ask_user tool.
ASK_GATES: dict[str, asyncio.Future] = {}
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
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, model_validator

import providers
from agents import (
    _compact_history,
    _drain_steer,
    _enqueue_steer,
    _is_read_timeout,
    _prune_history,
    _remove_steer,
    normalize_mode,
    run_agent,
)
from llm import build_chat_model


def wants_skill_or_mcp(text: str) -> bool:
    """True when a prompt asks to create/install/import skills or MCP connectors,
    so the agent gets the `create_skill` / `create_mcp` tools for the turn.
    Matches English AND Persian intent words (نصب/ساخت/بساز/ایجاد/ذخیره/اضافه →
    action; اسکیل/مهارت → skill target)."""
    low = text.lower()
    action = re.search(
        r"\b(install|add|create|import|save|set up|setup|copy|نصب|ساخت|بساز|ایجاد|ذخیره|اضافه)\b",
        low,
    )
    target = re.search(r"\b(skill|mcp|connector)s?\b|(اسکیل|مهارت|سورس)", low)
    return bool(action and target)


async def _oauth_access_token(req: ModelsRequest | ChatRequest) -> str:
    """Resolve a live OAuth access token when the request uses OAuth (Google).

    Returns "" for the plain API-key path so key-based flows are untouched.
    """
    if (req.auth_type or "").strip() != "oauth":
        return ""
    client_id = (req.oauth_client_id or "").strip()
    client_secret = (req.oauth_client_secret or "").strip()
    refresh = (req.oauth_refresh_token or "").strip()
    if not client_id or not refresh:
        return ""
    return await providers.google_access_token(client_id, client_secret, refresh)


# Sidecar's own listening port, set in main(). Used to build the loopback
# redirect_uri for Google OAuth (the consent page lands back on this process).
_SIDECAR_PORT = 0


def _oauth_redirect_uri() -> str:
    """Loopback URI Google redirects to after consent. The Electron main catches
    this navigation in-process, so the path only needs to be unique per sidecar."""
    return f"http://127.0.0.1:{_SIDECAR_PORT}/oauth/google/callback"


app = FastAPI(title="Codifa agent sidecar")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    provider: str = "custom"

    @model_validator(mode="after")
    def _normalize_mode(self) -> ChatRequest:
        # Normalize legacy/UI mode names (e.g. "chat", "codewriter") to the
        # canonical workflow modes at the API boundary, so downstream code only
        # ever sees keys that exist in SYSTEM_PROMPTS.
        self.mode = normalize_mode(self.mode)
        return self
    api_key: str = ""
    env_var: str = ""
    base_url: str = ""
    # Google OAuth login (provider kind "google"): resolve a live access token
    # from a stored refresh token instead of using an API key. Empty strings =
    # key-based path unchanged.
    auth_type: str = ""
    oauth_client_id: str = ""
    oauth_client_secret: str = ""
    oauth_refresh_token: str = ""
    model: str = ""
    root: str = ""
    mode: str = "chat"
    prompt: str = ""
    history: list[dict] = []
    attachments: list[str] = []
    # Each image may be a string path OR an object {path, dataUrl}; the backend
    # prefers an inline dataUrl so it never depends on reading the frontend's temp
    # file (uploaded images and screenshots both carry one).
    images: list = []
    system_prompt: str = ""
    thinking_level: str = "medium"
    # Whether the selected model is reasoning-capable (from the /models
    # `reasoning` flag). The backend uses this to emit a lightweight composer
    # glow signal while the model reasons, instead of streaming raw thinking
    # text. No model names are inferred here — the flag comes straight from the
    # provider payload / models.dev catalog.
    model_reasoning: bool = False
    mcp_servers: dict = {}
    # Names of skills the user explicitly attached this turn (via @mention).
    # These are the only skills inlined in full; when empty, no skill body is
    # loaded (skills are never auto-selected).
    skills: list[str] = []
    context_window: int = 0
    allow_create: bool = False
    # Mode capabilities: tool access per mode, so the backend can gate tools
    # data-driven instead of hardcoding mode names. Optional for backward compat.
    cap: dict = {}
    # User pre-approved outside-workspace access for this session (workspace).
    allow_outside: bool = False
    # Absolute path of the file currently open in Neovim (auto-mentioned unless
    # the user disabled it). Resolved against the workspace root; ignored if it
    # escapes the root or the auto-mention is off.
    nvim_file: str = ""
    # LSP diagnostics Neovim reported for the open file (array of dicts with
    # lnum/col/severity/source/code/message). Summarized into the agent's
    # context so it can see what's wrong in the active file.
    nvim_diagnostics: list[dict] = []
    # Chat id (renderer-side) so plans can be stored per chat
    # (<data>/plan/<workspace>/<chat-id>/plan.md) instead of per workspace.
    chat_id: str = ""
    # Directory for the per-workspace RAG vector store (memory + web chunks).
    # Empty string = default (~/.codifa/vector-db).
    vector_db_path: str = ""
    # Size / TTL bounds for the RAG store (max_docs, max_chunks, ttl_days).
    # None = backend defaults.
    vector_config: dict | None = None
    # Retrieval knobs (auto_index, auto_recall, top_k, include_* toggles).
    # None = backend defaults.
    retrieval_config: dict | None = None
    # Per-subagent model overrides: {"search": "model-id", "web": "...", "vision": "...", "compact": "..."}.
    # Missing / empty dict = use the parent model for every subagent.
    subagent_models: dict = {}
    # Cross-provider routing: full provider configs keyed by provider id, so a
    # "providerId/model" subagent entry can be run on that provider's own base
    # URL / key (not the parent provider's).
    providers: dict = {}
    # Compaction headroom (tokens) reserved below the context window — opencode's
    # `reserved`/`COMPACTION_BUFFER`. Auto-compaction fires when the conversation
    # reaches `ctx - reserved` (opencode's `usable`). Default 20_000.
    reserved: int = 20_000


class CompactRequest(BaseModel):
    """Manual ``/compact`` — runs opencode's compaction (structured summary,
    token-budgeted tail, prior-summary merge) on the supplied history."""

    # Primary summarizer (the user's configured compact subagent if any).
    provider: str = "custom"
    model: str = ""
    base_url: str = ""
    api_key: str = ""
    env_var: str = ""
    oauth_token: str = ""
    # Fallback summarizer (the active chat model) — mirrors opencode's
    # subagent -> main-model retry when the compact subagent is unavailable.
    fallback_provider: str = ""
    fallback_model: str = ""
    fallback_base_url: str = ""
    fallback_api_key: str = ""
    fallback_env_var: str = ""
    fallback_oauth_token: str = ""
    # Conversation history to compact, as plain {role, content} turns.
    history: list[dict] = []
    context_window: int = 0
    # Default matches the auto-compact `reserved` (20_000) and the UI's
    # `compactHeadroom` default, so a manual /compact without an explicit
    # headroom behaves identically to auto-compaction. The frontend always
    # sends the user's actual `compactHeadroom` here, so this is only a fallback.
    reserved: int = 20_000


class ModelsRequest(BaseModel):
    provider: str = "custom"
    api_key: str = ""
    env_var: str = ""
    base_url: str = ""
    auth_type: str = ""
    oauth_client_id: str = ""
    oauth_client_secret: str = ""
    oauth_refresh_token: str = ""


class ModelDownloadRequest(BaseModel):
    """Download a managed on-device model (whisper / embedding)."""

    kind: str = ""
    model: str = ""
    base_url: str = ""


class ModelRemoveRequest(BaseModel):
    """Delete a downloaded model. ``model`` = repo id (embeddings) or "". """

    kind: str = ""
    model: str = ""


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


@app.post("/permission/respond")
async def permission_respond(req: PermissionResponse) -> dict:
    """Resolve a pending outside-workspace permission / confirm_action request from the agent."""
    fut = PERMISSION_GATES.pop(req.id, None)
    if fut is None or fut.done():
        raise HTTPException(status_code=404, detail="permission request not found or already resolved")
    fut.set_result(req.allowed)
    return {"status": "ok"}


@app.post("/ask/respond")
async def ask_respond(req: AskResponse) -> dict:
    """Resolve a pending ask_user question (multiple-choice or free-text) from the agent."""
    fut = ASK_GATES.pop(req.id, None)
    if fut is None or fut.done():
        raise HTTPException(status_code=404, detail="question not found or already answered")
    fut.set_result(req.answer)
    return {"status": "ok"}


# --- app state (settings + chats/messages) ------------------------------ #
# Persisted as plain files in the user data root (backend/state_db.py): a
# settings.json plus per-chat JSON files under chats/<workspace>/. Electron's
# main process reads/writes state through these endpoints; the data root
# defaults to ~/.codifa (configurable via CODER_DATA_DIR).


@app.get("/app/state")
async def app_state() -> dict:
    import state_db

    return state_db.get_state()


@app.post("/app/state")
async def app_save(req: StateRequest) -> dict:
    import state_db

    if req.settings is not None:
        state_db.save_settings(req.settings)
    if req.chats is not None or req.deleted_chats is not None:
        state_db.save_chats(req.chats or [], deleted_ids=req.deleted_chats)
    if req.deleted_workspaces:
        state_db.remove_workspace_vectors(req.deleted_workspaces)
    return {"ok": True}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "1.0.0"}


class OAuthStartRequest(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    # Optional override of the requested OAuth scopes. Empty = the default
    # Gemini scopes (GOOGLE_OAUTH_SCOPES). Non-empty = e.g. the Search Console
    # scope (GOOGLE_SEARCH_CONSOLE_SCOPES) for the search_console tool, so the
    # same OAuth flow signs in to different Google APIs with the open
    # consent that its own scope set.
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
    scope = (req.scope or "").strip() or providers.GOOGLE_OAUTH_SCOPES
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
        oauth = await _oauth_access_token(req)
        ids = await providers.list_models(
            req.provider, req.base_url, req.api_key, req.env_var, oauth_token=oauth
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"models": ids}


@app.get("/credits")
async def credits(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        oauth = await _oauth_access_token(req)
        return await providers.fetch_credits(
            req.provider, req.base_url, req.api_key, req.env_var, oauth_token=oauth
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- managed on-device models (whisper / embedding) --------------------- #
# Download & removal are user-initiated from Settings → Models (never
# automatic). Downloads run on a background thread; /models/status is polled
# while one is in flight.


@app.post("/models/download")
async def models_download(req: ModelDownloadRequest) -> dict:
    import model_download

    kind = (req.kind or "").strip() or model_download.KIND_EMBEDDING
    if kind not in (model_download.KIND_WHISPER, model_download.KIND_EMBEDDING):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    model = (req.model or "").strip() or (
        model_download.WHISPER_DEFAULT_REPO
        if kind == model_download.KIND_WHISPER
        else model_download.EMBEDDING_DEFAULT_REPO
    )
    if not model_download.start_download(kind, model, req.base_url):
        raise HTTPException(status_code=400, detail="empty model repo id")
    return {"ok": True, "kind": kind, "model": model}


@app.get("/models/status")
async def models_status() -> dict:
    import model_download

    return model_download.status()


@app.get("/models/embedding-status")
async def models_embedding_status() -> dict:
    """RAG embedder diagnostics: model loaded? what dimension? why not?."""
    from embeddings import status as embed_status

    return embed_status()


@app.post("/models/remove")
async def models_remove(req: ModelRemoveRequest) -> dict:
    import model_download

    kind = (req.kind or "").strip().lower()
    if kind not in (model_download.KIND_WHISPER, model_download.KIND_EMBEDDING):
        raise HTTPException(status_code=400, detail=f"unknown model kind: {kind!r}")
    removed = model_download.remove(kind, req.model)
    return {"ok": True, "kind": kind, "removed": removed}


@app.get("/system-prompts")
async def system_prompts() -> dict:
    from agents import MODE_ALIASES, SYSTEM_PROMPTS

    # The frontend requests legacy keys ("chat", "codewriter"); map them back to
    # the canonical prompts via MODE_ALIASES so this endpoint never raises
    # KeyError and stays in sync with the single source of truth.
    return {key: SYSTEM_PROMPTS[canonical] for key, canonical in MODE_ALIASES.items()}


# --- skills (stored in the app database) ---------------------------------- #


class SkillSyncRequest(BaseModel):
    name: str = ""
    previous_name: str = ""
    content: str = ""
    description: str = ""
    delete: bool = False


@app.get("/skills")
async def skills_list() -> dict:
    import state_db

    try:
        skills = state_db.list_skills()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not read skills: {exc}") from exc
    return {"skills": skills}


@app.post("/skills/sync")
async def skills_sync(req: SkillSyncRequest) -> dict:
    from tools import persist_skill, remove_skill

    name = (req.name or "").strip()
    if req.delete:
        if not name:
            raise HTTPException(status_code=400, detail="missing skill name")
        return remove_skill(name)
    content = (req.content or "").strip()
    if not content:
        # Rebuild a full skill from structured fields when no raw markdown came.
        name = name or (req.description or "").strip()[:60] or "skill"
        content = (
            "---\n"
            f"name: {name}\n"
            f"description: {(req.description or '').strip()}\n"
            "---\n\n"
            f"# {name}\n"
        )
    result = persist_skill(content, fallback_name=name, previous_name=req.previous_name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("note", "save failed"))
    return result


# --- MCP connectors (stored in the app database) --------------------------- #


class McpSaveRequest(BaseModel):
    name: str = ""
    cfg: dict = {}


class McpDeleteRequest(BaseModel):
    name: str = ""


@app.get("/mcp")
async def mcp_list() -> dict:
    import state_db
    from tools import _BUILTIN_MCP_SERVERS

    try:
        return {
            "mcpServers": state_db.list_mcp(),
            "builtins": sorted(_BUILTIN_MCP_SERVERS),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not read MCP config: {exc}") from exc


@app.post("/mcp")
async def mcp_save(req: McpSaveRequest) -> dict:
    from tools import upsert_mcp_server

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="missing connector name")
    if not isinstance(req.cfg, dict):
        raise HTTPException(status_code=400, detail="invalid connector config")
    return upsert_mcp_server("", name, req.cfg)


@app.post("/mcp/delete")
async def mcp_delete(req: McpDeleteRequest) -> dict:
    import state_db

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="missing connector name")
    removed = state_db.delete_mcp(name)
    return {"ok": True, "removed": removed}


# Lazy-loaded faster-whisper model (the CTranslate2 model downloaded into
# backend/whisper/, see Settings → Models). Loaded once on first transcription
# and cached, so the first request pays the load cost but every later one is
# fast and fully local+offline.
_whisper_model = None
_whisper_model_lock = asyncio.Lock()


async def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        async with _whisper_model_lock:
            if _whisper_model is None:
                import model_download

                if not model_download.whisper_ready():
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
    return _whisper_model


@app.post("/transcribe")
async def transcribe(request: Request) -> dict:
    """Transcribe a recorded audio clip (multipart 'file') using the local Whisper
    model. Returns {"text": "..."} or an HTTP error. Fully local and offline.

    Tuned for clean, hallucination-free dictation on short clips:
    * Silero VAD trims silence and skips pure-silence clips (no ghost text).
    * An explicit `lang` hint (fa/en) beats auto-detection on short clips.
    * Temperature fallback + conservative thresholds fix repeated-text stutters.
    """
    import io

    from faster_whisper.audio import decode_audio

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
        lang = (form.get("lang") or "").strip().lower() or None

        model = await _get_whisper_model()
        # faster-whisper's decode_audio uses `av` to decode webm/ogg/opus/wav/mp3
        # to a float32 16 kHz PCM array, so any container the browser MediaRecorder
        # emits is handled without extra conversion code here.
        pcm = decode_audio(io.BytesIO(data))
        vad_parameters = {
            "min_silence_duration_ms": 250,
            "speech_pad_ms": 200,
        }
        # For Persian, steer the model toward correct punctuation and away
        # from filler words. The previous prompt ("no punctuation") hurt
        # readability and accuracy for Persian, so it is replaced here.
        fa_prompt = (
            "رونویسی فارسی با نشانه‌گذاری صحیح. متن را بدون کلمات اضافه و "
            "پرکننده بنویسید:"
        )
        segments, _info = model.transcribe(
            pcm,
            beam_size=10,
            language=lang,
            vad_filter=True,
            vad_parameters=vad_parameters,
            initial_prompt=fa_prompt if lang == "fa" else None,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8),
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-0.8,
            without_timestamps=True,
        )
        text = " ".join(seg.text for seg in segments).strip()
        return {"text": text}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


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
    # A bare `asyncio.TimeoutError` (and similar) has an EMPTY str() — the type
    # name is the only clue. Turn it into a readable timeout message so the user
    # isn't left with the generic fallback at the bottom.
    if not text.strip():
        text = "The model request timed out (no data arrived from the provider for an extended period)."
    # pydantic-ai HTTP errors render as: status_code: 400, model_name: ...,
    # body: {'message': '...'} (or body: [{'error': {'message': '...'}}] from
    # Gemini's OpenAI-compat endpoint). Pull out the server's own message.
    detail = ""
    m = re.search(r"body:\s*(\{.*\})", text, re.DOTALL)
    if m:
        try:
            body = ast.literal_eval(m.group(1))
            detail = body.get("message") or body.get("error") or ""
            if isinstance(detail, dict):
                detail = str(detail)
        except (ValueError, SyntaxError, TypeError):
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
            "Settings → Providers and check the API key field (or the env var it "
            "references)."
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
            "Try the 'opencode' provider instead — it uses its own gateway (opencode.ai/zen)."
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
            "Google and EITHER set a real environment variable (GOOGLE_API_KEY or "
            "GOOGLE_GENERATIVE_AI_API_KEY) that exists in your environment, OR paste your "
            "Gemini API key in 'Saved API key'. A variable name alone is not a key."
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


@app.post("/chat/compact")
async def chat_compact(req: CompactRequest):
    """Manual ``/compact`` — opencode-style compaction of the supplied history.

    Returns ``{"summary": <text>, "keep": <n>}`` on success, or
    ``{"summary": null, "error": <reason>}`` when there is nothing to compact or
    the summarizer failed (the frontend then surfaces the reason as a retry).
    """
    import sys

    # Route through the standard logging module so informational messages land
    # on stdout (not red stderr) while genuine problems still surface at
    # WARNING/ERROR on stderr. A dedicated, non-propagating logger keeps this
    # isolated from the root file handler configured at startup.
    #
    # Handlers resolve their stream dynamically (at emit time) so they always
    # target the *current* sys.stdout/sys.stderr — important under test
    # frameworks that swap those streams (e.g. pytest's capsys).
    class _DynamicStreamHandler(logging.StreamHandler):
        def __init__(self, stream_getter):
            super().__init__(stream=sys.stderr)  # placeholder; resolved per emit
            self._stream_getter = stream_getter

        def emit(self, record):
            # Resolve the *current* stream at emit time so pytest's capsys (and
            # any other stdout/stderr swap) is honoured.
            self.stream = self._stream_getter()
            super().emit(record)

    _logger = logging.getLogger("codifa.compact")
    if not _logger.handlers:
        _logger.propagate = False
        _logger.setLevel(logging.DEBUG)

        _info_handler = _DynamicStreamHandler(lambda: sys.stdout)
        _info_handler.setLevel(logging.DEBUG)
        _info_handler.addFilter(lambda r: r.levelno < logging.WARNING)
        _info_handler.setFormatter(logging.Formatter("[compact] %(message)s"))

        _err_handler = _DynamicStreamHandler(lambda: sys.stderr)
        _err_handler.setLevel(logging.WARNING)
        _err_handler.setFormatter(logging.Formatter("[compact] %(levelname)s %(message)s"))

        _logger.addHandler(_info_handler)
        _logger.addHandler(_err_handler)

    def _log(msg: str, level: int = logging.INFO) -> None:
        _logger.log(level, msg)

    _log(
        f"request: provider={req.provider!r} model={req.model!r} "
        f"fallback={req.fallback_provider!r}/{req.fallback_model!r} "
        f"history={len(req.history or [])} ctx={req.context_window} reserved={req.reserved}"
    )
    if not req.history:
        _log("empty history -> nothing to do", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "no messages to compact"}

    def _build(provider: str, model: str, base_url: str, api_key: str, env_var: str, oauth: str):
        if not model:
            return None
        try:
            return build_chat_model(
                provider,
                model,
                base_url,
                api_key,
                env_var,
                oauth,
                temperature=0.0,
                thinking_level="off",
                max_tokens=8192,
                # Bounded so a slow/unreachable provider fails fast with a clear
                # error instead of hanging until the client disconnects.
                timeout=50,
            )
        except Exception as exc:  # noqa: BLE001
            _log(f"model build failed (provider={provider!r} model={model!r}): {exc!r}", level=logging.WARNING)
            return None

    model = _build(req.provider, req.model, req.base_url, req.api_key, req.env_var, req.oauth_token)
    if model is None:
        _log(f"primary model failed to build (provider={req.provider!r} model={req.model!r})", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "invalid primary model"}
    fallback = _build(
        req.fallback_provider, req.fallback_model, req.fallback_base_url,
        req.fallback_api_key, req.fallback_env_var, req.fallback_oauth_token,
    )
    _log(f"primary built={bool(model)} fallback built={bool(fallback)}; running _compact_history")
    ctx = int(req.context_window or 0)
    last_error: list[str] = []
    # opencode prune: clear old tool outputs before the summarization pass.
    history = list(req.history)
    _prune_history(history)
    try:
        result = await _compact_history(
            model,
            history,
            ctx=ctx,
            reserved=req.reserved,
            fallback_model=fallback,
            last_error=last_error,
            force=True,
        )
    except Exception as exc:  # noqa: BLE001
        _log(f"_compact_history raised: {exc!r}", level=logging.ERROR)
        return {"summary": None, "keep": 0, "error": str(exc)}
    if result is None:
        if last_error:
            _log(f"failed: {last_error[-1]}", level=logging.WARNING)
            return {"summary": None, "keep": 0, "error": last_error[-1]}
        _log("nothing to compact (history too short / head already summarized)", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "nothing to compact"}
    new_history, keep, compact_usage = result
    summary = new_history[0]["content"] if new_history else ""
    if not summary:
        _log("empty summary after success", level=logging.WARNING)
        return {"summary": None, "keep": 0, "error": "empty summary"}
    _log(f"success: keep={keep} summary_len={len(summary)}")
    return {"summary": summary, "keep": int(keep), "usage": compact_usage}


async def _with_keepalive(agent_iter, timeout: float = 15.0):
    """Yield agent SSE events, injecting a keepalive sentinel whenever the agent
    goes silent for `timeout` seconds so idle sockets survive proxy/OS/TCP
    timeouts mid-stream. The frontend forwards `: `-prefixed lines as a
    `keepalive` event and refreshes its stall watchdog, so a long-running tool is
    never mistaken for a dead connection.

    IMPORTANT: `shield` only protects `pending` from the keepalive timeout —
    it does NOT mean a real outer cancellation (client disconnect / aborted
    fetch) should leave the agent running. If this generator itself gets
    cancelled (or closed) while `pending` is in flight, we must explicitly
    cancel `pending` too, otherwise the underlying run_graph/_drive task keeps
    running orphaned in the background with nobody consuming its events. Left
    alone, it eventually reaches a "clean finish" and clears the durable
    turn-resume file even though the user never saw the result — the bug
    behind "interrupts with no log/error and the resume file is gone"."""
    pending = None
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
                yield event
            except asyncio.TimeoutError:
                yield {"kind": "_keepalive"}
            except StopAsyncIteration:
                return
    except asyncio.CancelledError:
        # Real disconnect/abort (not a keepalive timeout): cancel the shielded
        # agent task instead of letting it run orphaned to completion.
        if pending is not None and not pending.done():
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pending
        raise


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")

    # Safety net: messages that ask to create/install skills or MCP connectors
    # grant the create_skill/create_mcp tools even if the frontend didn't flag
    # them. Available in EVERY mode (ask, plan, coder) — as long as the current
    # prompt (or the recent history, so a "continue" follow-up keeps the grant)
    # expresses the intent.
    if not req.allow_create:
        if wants_skill_or_mcp(req.prompt):
            req.allow_create = True
        else:
            for turn in (req.history or [])[-6:]:
                if turn.get("role") == "user" and wants_skill_or_mcp(
                    str(turn.get("content", ""))
                ):
                    req.allow_create = True
                    break

    async def event_gen():
        try:
            async for event in _with_keepalive(
                run_agent(
                provider=req.provider,
                model_name=req.model,
                base_url=req.base_url,
                api_key=req.api_key,
                env_var=req.env_var,
                root=req.root,
                mode=req.mode,
                prompt=req.prompt,
                history=req.history,
                attachments=req.attachments,
                images=req.images,
                system_prompt=req.system_prompt,
                thinking_level=req.thinking_level,
                model_reasoning=req.model_reasoning,
                mcp_servers=req.mcp_servers,
                skills=req.skills,
                context_window=req.context_window,
                allow_create=req.allow_create,
                cap=req.cap,
                permission_gates=PERMISSION_GATES,
                ask_gates=ASK_GATES,
                allow_outside=req.allow_outside,
                nvim_file=req.nvim_file,
                nvim_diagnostics=req.nvim_diagnostics,
                vector_db_path=req.vector_db_path,
                vector_config=req.vector_config,
                retrieval_config=req.retrieval_config,
                subagent_models=req.subagent_models,
                chat_id=req.chat_id,
                reserved=req.reserved,
                providers=req.providers,
                )
            ):
                if event.get("kind") == "_keepalive":
                    yield ": keepalive\n\n"
                else:
                    yield _sse(event)

        except asyncio.CancelledError:
            # Client disconnected (aborted the stream): the run_agent generator
            # and its background producer task are unwound inside run_agent's
            # finally block, so just stop iterating cleanly — do NOT emit a
            # trailing "done" event, since the user closed the stream themselves.
            return
        except Exception as exc:  # noqa: BLE001 — must always surface an SSE error
            # Full traceback to the sidecar stderr so an opaque upstream message
            # ("Exceeded maximum output retries (1)", ...) never hides the real
            # trigger; the user still sees a readable error over SSE.
            traceback.print_exc()
            yield _sse({"kind": "error", "content": _friendly_error(exc, req.model, req.base_url)})
        finally:
            # ارسال سیگنال پایان برای بستن استریم در فرانت‌اند
            # Clear any unconsumed steers for this chat so they don't leak into
            # a future run of the same chat (the frontend re-sends them as the
            # next turn via its own queue).
            await _drain_steer(req.chat_id)
            yield _sse({"kind": "done"})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class SteerRequest(BaseModel):
    chat_id: str = ""
    id: str = ""
    prompt: str = ""


@app.post("/chat/steer")
async def chat_steer(req: SteerRequest) -> dict:
    """Queue a user message for injection into a RUNNING agent (no abort).

    The message sits in the per-chat STEER_INBOX until the run's next tool
    call, at which point the tool wrapper appends it to the tool result so the
    model reads it immediately. If the run ends before any tool call (e.g. the
    agent is already streaming its final answer), the message stays queued and
    the frontend auto-sends it as the next turn.
    """
    if not req.chat_id or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="chat_id and prompt are required")
    await _enqueue_steer(req.chat_id, {"id": req.id, "prompt": req.prompt.strip()})
    return {"ok": True}


class SteerCancelRequest(BaseModel):
    chat_id: str = ""
    id: str = ""


@app.post("/chat/steer/cancel")
async def chat_steer_cancel(req: SteerCancelRequest) -> dict:
    """Drop a pending steer from the inbox (user cancelled it before delivery)."""
    if not req.chat_id or not req.id:
        raise HTTPException(status_code=400, detail="chat_id and id are required")
    await _remove_steer(req.chat_id, req.id)
    return {"ok": True}


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
    budget: int = 0  # 0 = unlimited (index everything this run)


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
    expired_notes: int = 0
    vacuumed: bool = False
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
    from embeddings import embedder_available
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
    try:
        result = index_workspace(
            store,
            req.root,
            budget=req.budget or 0,
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Codifa agent sidecar")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    # Central file logging: every Python logger (retrieval, vector_store, and any
    # future module) appends WARNING+ to <data root>/codifa.log so a packaged app
    # whose stderr is not captured still leaves a persistent error trail behind.
    try:
        import logging

        from tools import user_coder_dir

        _log_dir = user_coder_dir()
        os.makedirs(_log_dir, exist_ok=True)
        _handler = logging.FileHandler(
            os.path.join(_log_dir, "codifa.log"), encoding="utf-8"
        )
        _handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s: %(message)s"
            )
        )
        _root = logging.getLogger()
        _root.setLevel(logging.WARNING)
        _root.addHandler(_handler)
    except Exception:  # noqa: BLE001, S110 — logging must never kill the sidecar
        pass

    # Disable broken stdio MCP connectors (e.g. a docker MCP with invalid flags)
    # as soon as the sidecar starts, so they never spam errors during use.
    try:
        from tools import validate_mcp_servers

        validate_mcp_servers()
    except Exception:  # noqa: BLE001, S110 — broken connectors are handled lazily
        pass

    # Seed built-in skills from backend/skills/*.md on every startup (no-op for
    # skills that already exist, so user edits/deletions are never overwritten).
    try:
        from tools import sync_builtin_skills

        sync_builtin_skills()
    except Exception:  # noqa: BLE001, S110 — a seed failure must not kill the sidecar
        pass

    # Install the built-in MCP connectors (e.g. the Docker MCP) on first run.
    try:
        from tools import seed_builtin_mcp

        seed_builtin_mcp()
    except Exception:  # noqa: BLE001, S110 — a seed failure must not kill the sidecar
        pass

    import uvicorn

    # Ensure essential data-root dirs exist (settings.json, skills/, mcp/, plan/).
    try:
        import state_db

        state_db.bootstrap()
    except Exception:  # noqa: BLE001, S110
        pass

    # Prune orphaned resume files (older than 24h) only on shutdown — never
    # per-turn — so finishing one chat never touches another chat's in-flight
    # resume file.
    try:
        import atexit

        import state_db as _state_db

        atexit.register(lambda: _state_db.prune_stale_resume_files())
    except Exception:  # noqa: BLE001, S110
        pass

    global _SIDECAR_PORT
    _SIDECAR_PORT = args.port
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
