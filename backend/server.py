"""FastAPI sidecar serving the Pydantic AI agent over SSE.

Runs on 127.0.0.1:<ephemeral port>, spawned by the Electron main process. Only
reachable from the local machine. All file access is confined to the ROOT
provided in each request.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import json
import os
import re
import traceback
from typing import Annotated

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# Pending permission requests: id -> asyncio.Future. Resolved by the
# /permission/respond endpoint and awaited by the agent's request_permission /
# confirm_action tools.
PERMISSION_GATES: dict[str, asyncio.Future] = {}
# Pending multiple-choice / open questions the agent asked the user mid-task.
# Resolved by /ask/respond and awaited by the agent's ask_user tool.
ASK_GATES: dict[str, asyncio.Future] = {}

import providers
from agents import run_agent
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="CODEFA agent sidecar")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    provider: str = "custom"
    api_key: str = ""
    env_var: str = ""
    base_url: str = ""
    model: str = ""
    root: str = ""
    mode: str = "chat"
    prompt: str = ""
    history: list[dict] = []
    attachments: list[str] = []
    images: list[str] = []
    system_prompt: str = ""
    thinking_level: str = ""
    mcp_servers: dict = {}
    context_window: int = 0
    skills: list[str] = []
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
    # Recent-message budget from the client ("Messages to remember"). The
    # backend uses it to decide how many recent turns to keep verbatim when it
    # auto-compacts an overflowing context, so recent work is never lost.
    max_history: int = 10


class ModelsRequest(BaseModel):
    provider: str = "custom"
    api_key: str = ""
    env_var: str = ""
    base_url: str = ""


class PermissionResponse(BaseModel):
    id: str
    allowed: bool


class AskResponse(BaseModel):
    id: str
    answer: str


@app.post("/permission/respond")
async def permission_respond(req: PermissionResponse) -> dict:
    """Resolve a pending outside-workspace permission / confirm_action request from the agent."""
    fut = PERMISSION_GATES.pop(req.id, None)
    if fut is None or fut.done():
        return {"status": "missing"}
    fut.set_result(req.allowed)
    return {"status": "ok"}


@app.post("/ask/respond")
async def ask_respond(req: AskResponse) -> dict:
    """Resolve a pending ask_user question (multiple-choice or free-text) from the agent."""
    fut = ASK_GATES.pop(req.id, None)
    if fut is None or fut.done():
        return {"status": "missing"}
    fut.set_result(req.answer)
    return {"status": "ok"}


@app.get("/health")
async def health() -> dict:
    import pydantic_ai

    return {"status": "ok", "version": pydantic_ai.__version__}


@app.get("/models")
async def models(req: Annotated[ModelsRequest, Query()]) -> dict:
    try:
        ids = await providers.list_models(
            req.provider, req.base_url, req.api_key, req.env_var
        )
    except providers.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"models": ids}


@app.get("/system-prompts")
async def system_prompts() -> dict:
    from agents import SYSTEM_PROMPTS

    return {"chat": SYSTEM_PROMPTS["chat"], "codewriter": SYSTEM_PROMPTS["codewriter"]}


# Lazy-loaded faster-whisper model (the CTranslate2 "small" model shipped under
# backend/whisper/). Loaded once on first transcription and cached, so the first
# request pays the load cost but every later one is fast and fully local+offline.
_whisper_model = None
_whisper_model_lock = asyncio.Lock()


async def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        async with _whisper_model_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel

                model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whisper")
                _whisper_model = WhisperModel(
                    model_dir, device="cpu", compute_type="int8"
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

    form = await request.form()
    audio = form.get("audio")
    if audio is None:
        raise HTTPException(status_code=400, detail="missing 'audio' field")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio")
    lang = (form.get("lang") or "").strip().lower() or None

    try:
        model = await _get_whisper_model()
        # faster-whisper's decode_audio uses `av` to decode webm/ogg/opus/wav/mp3
        # to a float32 16 kHz PCM array, so any container the browser MediaRecorder
        # emits is handled without extra conversion code here.
        pcm = decode_audio(io.BytesIO(data))
        vad_parameters = {
            "min_silence_duration_ms": 250,
            "speech_pad_ms": 200,
        }
        segments, _info = model.transcribe(
            pcm,
            beam_size=5,
            language=lang,
            vad_filter=True,
            vad_parameters=vad_parameters,
            initial_prompt="## Persian dictation, no punctuation and no filler words" if lang == "fa" else None,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8),
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
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


def _friendly_error(exc: Exception, model: str) -> str:
    text = str(exc)
    # pydantic-ai HTTP errors render as: status_code: 400, model_name: ...,
    # body: {'message': '...'}. Pull out the server's own message when present.
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
    if detail:
        text = detail
    low = text.lower()
    if (
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


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    if not req.root or not os.path.isdir(req.root):
        raise HTTPException(status_code=400, detail="invalid project root")

    async def event_gen():
        try:
            last_usage = None

            async for event in run_agent(
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
                mcp_servers=req.mcp_servers,
                context_window=req.context_window,
                skills_selected=req.skills,
                allow_create=req.allow_create,
                cap=req.cap,
                permission_gates=PERMISSION_GATES,
                ask_gates=ASK_GATES,
                allow_outside=req.allow_outside,
                nvim_file=req.nvim_file,
                nvim_diagnostics=req.nvim_diagnostics,
                max_history=req.max_history,
            ):
                # --- بخش اصلاح شده برای جلوگیری از خطای AttributeError ---
                # ابتدا چک می‌کنیم آیا event یک دیکشنری است یا یک شیء
                if isinstance(event, dict):
                    if "usage" in event:
                        last_usage = event["usage"]
                else:
                    # اگر شیء است، با استفاده از getattr بدون خطا مقدار را می‌گیریم
                    usage_val = getattr(event, "usage", None)
                    if usage_val:
                        last_usage = usage_val
                # -------------------------------------------------------

                yield _sse(event)

            # ارسال usage در انتهای استریم
            if last_usage:
                try:
                    from agents import _usage_event

                    usage_data = _usage_event(last_usage)
                    if usage_data:
                        yield _sse(usage_data)
                except Exception:  # noqa: BLE001 — fallback if the helper is unavailable
                    # اگر تابع در agents.py نبود، به صورت دستی ارسال کن
                    yield _sse({"kind": "usage", "content": str(last_usage)})

        except asyncio.CancelledError:
            # Client disconnected (aborted the stream): the run_agent generator
            # and its background producer task are unwound inside run_agent's
            # finally block, so just stop iterating cleanly.
            raise
        except Exception as exc:  # noqa: BLE001 — must always surface an SSE error
            # Full traceback to the sidecar stderr so an opaque upstream message
            # ("Exceeded maximum output retries (1)", ...) never hides the real
            # trigger; the user still sees a readable error over SSE.
            traceback.print_exc()
            yield _sse({"kind": "error", "content": _friendly_error(exc, req.model)})
        finally:
            # ارسال سیگنال پایان برای بستن استریم در فرانت‌اند
            yield _sse({"kind": "done"})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="CODEFA agent sidecar")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    # Disable broken stdio MCP connectors (e.g. a docker MCP with invalid flags)
    # as soon as the sidecar starts, so they never spam errors during use.
    try:
        from tools import validate_mcp_servers

        validate_mcp_servers()
    except Exception:  # noqa: BLE001, S110 — broken connectors are handled lazily
        pass

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
