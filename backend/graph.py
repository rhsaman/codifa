"""LangGraph orchestration for the Codifa agent workflow.

This replaces the old single ``Agent`` pydantic-ai ``run_agent`` loop with an
explicit LangGraph state machine:

    Router
    +-- Ask   (web_search / fetch_url / vision / read / grep / glob)
    +-- Plan  (web_search / fetch_url / vision / glob / grep / read / terminal)
    +-- Coder (edit_file / write_file / create / delete)
              -> Review -> Done

The Coder runs the project's tests itself (via run_terminal) before finishing —
there is NO automatic test/debug loop in the graph. The graph only routes
Coder -> Review -> Done.

The graph controls the *high-level* flow (routing, the tool-permission
boundaries). Each node runs ONE LLM turn for its mode via a
shared LangChain tool-loop runner (``_run_mode_turn``). That runner:

* builds the system prompt / history / RAG / skills using the SAME helpers the
  old ``run_agent`` used (so the prompts stay identical);
* binds ONLY the tools allowed for that mode (enforced here, not just in text);
* streams text/thinking/tool events into a shared queue;
* applies the *essential* resilience from the old runner: free-tier throttle
  retry, context-window auto-compact, interrupted-turn resume, and live steer
  injection.

The existing tool implementations (``tools.make_tool_callbacks``) are reused
unchanged -- only the LLM client and the orchestration changed.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import itertools
import json
import logging
import os
import re
import time
import traceback
from collections.abc import AsyncIterator, Callable
from typing import Any, TypedDict

logger = logging.getLogger(__name__)

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph

import agents as _agents
import state_db
from agents import normalize_mode
from llm import (
    _is_stream_options_error,
    _strip_stream_options,
    build_chat_model,
    chat_model_settings,
    llm_generate,
)
from mcp_bridge import build_mcp_tools
from tools import _PARENT_TOOLS_CTX, make_tool_callbacks

# Tool calls in this set mutate persistent state (files, terminal, saved
# memory/skills/connectors) or block on a real human (ask_user) -- they run
# SEQUENTIALLY, each waiting for the previous to finish, so two writes can
# never race and a blocking question never overlaps another call. Everything
# else (grep/glob/read/web_search/fetch_url/vision/search_memory/task -- all
# read-only) runs CONCURRENTLY via asyncio.gather when the model requests
# several in the same step, matching opencode's own behavior (regular tool
# calls run via Promise.all; only Task calls are serialized there, which is a
# known opencode bug -- github.com/anomalyco/opencode/issues/14195). This does
# NOT increase token cost: the provider still gets exactly the same set of
# ToolMessages either way -- only wall-clock latency changes.
_SEQUENTIAL_TOOLS = {
    "write_file",
    "edit_file",
    "run_terminal",
    "confirm_action",
    "memory",
    "create_skill",
    "create_mcp",
    "ask_user",
}

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class AgentState(TypedDict, total=False):
    # Routing / request
    mode: str
    request: str
    # Conversation + attachments
    history: list[dict]
    attachments: list[str]
    images: list[str]
    # Provider / model config (preserved verbatim from the UI request)
    provider: str
    model_name: str
    base_url: str
    api_key: str
    env_var: str
    oauth_token: str
    context_window: int
    thinking_level: str
    # Whether the selected model is reasoning-capable (from the /models
    # `reasoning` flag). Drives the lightweight composer glow signal.
    model_reasoning: bool
    system_prompt: str
    root: str
    chat_id: str
    # Capability / permission gating (from the UI)
    cap: dict
    permission_gates: dict
    ask_gates: dict
    allow_outside: bool
    allow_create: bool
    nvim_file: str
    nvim_diagnostics: list
    skills: list[str]
    vector_db_path: str
    vector_config: dict
    retrieval_config: dict
    subagent_models: dict
    providers: dict
    reserved: int | None
    # MCP connectors the user toggled on in the composer chip. Passed through
    # verbatim from the UI request; consumed by build_turn_context to attach
    # live MCP tools. MUST be declared on the state or LangGraph drops it
    # before the node runs (and the model would see no MCP tools).
    mcp_servers: dict
    # Workflow scratch state
    web_search_results: list
    fetched_content: list
    vision_results: list
    candidate_files: list[str]
    grep_results: list
    read_context: str
    plan: str
    coder_result: str
    changed_files: list[str]
    review_result: str
    final_response: str
    # Explore (deterministic repo-discovery) scratch state
    search_spec: dict
    explore_glob: list[str]
    explore_grep: list[str]
    explore_tree: str
    explore_answer: str
    plan_attempts: int
    # Internal transport (NOT serialised by the graph runner; in-memory only)
    _queue: Any
    # Mutable flag shared between _run_mode_turn (detects a hard failure) and
    # run_graph._drive (decides whether to clear the durable resume file). MUST
    # be declared on the state or LangGraph drops it before the node runs.
    _run_flags: dict


# ---------------------------------------------------------------------------
# Message-history conversion (frontend plain-text turns -> LangChain messages)
# ---------------------------------------------------------------------------


def history_to_langchain_messages(
    history: list[dict], current_mode: str | None = None
) -> list[BaseMessage]:
    """Convert plain ``{role, content}`` turns to LangChain messages.

    Assistant turns may carry a ``toolActivity`` array (the frontend sends it on
    every assistant message: tool name, args, ``callId``, and the completed
    result). We reconstruct those as real ``AIMessage(tool_calls=[...])`` +
    ``ToolMessage`` pairs so the model SEES what it already did and does NOT
    re-run the tool calls after a reconnect/interrupt -- the transcript alone
    (no synthetic "you already did X" injection) carries the prior work forward.

    When ``current_mode`` is supplied, any turn whose own ``mode`` differs from it
    is wrapped in a ``<!-- mode:x -->`` metadata comment (prefix only). This keeps
    the model from blending a previous mode's behavior into the current turn after
    a mid-chat mode switch (e.g. a Coder turn following Plan history must not look
    like the model was already implementing). The comment is metadata ONLY -- the
    model must NEVER echo it at the start of its own reply; the system prompt
    already declares the authoritative mode.
    """
    out: list[BaseMessage] = []
    for turn in history or []:
        role = turn.get("role", "user")
        content = str(turn.get("content", ""))
        tool_activity = turn.get("toolActivity") or []
        # Tag turns that were produced under a different mode than the current
        # one, so the model can tell past-mode behavior apart from this turn.
        turn_mode = turn.get("mode")
        if current_mode and turn_mode and turn_mode != current_mode:
            content = f"<!-- mode:{turn_mode} -->\n{content}"
        # Reconstruct assistant tool calls from the carried toolActivity so a
        # resumed turn continues instead of redoing completed work.
        if role == "assistant" and tool_activity:
            tool_calls: list[dict] = []
            tool_msgs: list[BaseMessage] = []
            for ta in tool_activity:
                if not isinstance(ta, dict):
                    continue
                tc_id = str(ta.get("callId") or f"ta-{len(tool_calls)}")
                tool_calls.append(
                    {
                        "name": ta.get("tool", "tool"),
                        "args": ta.get("args", {}) or {},
                        "id": tc_id,
                    }
                )
                # Prefer the full tool result (items); fall back to the summary.
                # `items` may be a plain string (e.g. "MATCHES for 'foo'") OR a
                # list of dicts (e.g. [{"snippet": "..."}]) — flatten either into
                # readable text so the model sees the real result and does NOT
                # re-execute the tool on reconnect (which would waste context).
                items = ta.get("items")
                if isinstance(items, str):
                    result = items
                elif isinstance(items, list) and items:
                    parts = []
                    for _it in items:
                        if isinstance(_it, dict):
                            parts.append(
                                str(
                                    _it.get("snippet")
                                    or _it.get("content")
                                    or _it.get("text")
                                    or _it.get("result")
                                    or _it
                                )
                            )
                        else:
                            parts.append(str(_it))
                    result = "\n".join(parts)
                else:
                    result = ta.get("summary") or ""
                tool_msgs.append(ToolMessage(content=str(result), tool_call_id=tc_id))
            if tool_calls:
                out.append(AIMessage(content=content, tool_calls=tool_calls))
                out.extend(tool_msgs)
                continue
        if not content:
            continue
        if role == "system":
            out.append(SystemMessage(content=content))
        elif role == "assistant":
            out.append(AIMessage(content=content))
        else:
            out.append(HumanMessage(content=content))
    return out


# ---------------------------------------------------------------------------
# Mode routing
# ---------------------------------------------------------------------------
# The UI/toolbar mode is authoritative. We only honor an explicit slash command
# (/plan, /code, /ask, /reader) in the prompt — never infer the mode from
# keywords (that would override the user's explicit selection and make the agent
# think it's in Coder while the user picked Plan). See ``router`` below.


# ---------------------------------------------------------------------------
# Per-mode tool filtering (faithful port of agents.py's data-driven gating)
# ---------------------------------------------------------------------------


def filter_tools_for_mode(
    mode: str,
    tools: dict[str, Callable],
    cap: dict | None,
    scoped_paths: set[str],
    allow_create: bool,
    allow_outside: bool,
    prompt: str = "",
    root: str = "",
) -> dict[str, Callable]:
    """Return the mode-appropriate subset of ``tools``.

    Mirrors the original agents.py gating exactly: capability-driven denying
    (readFiles/writeFiles/runTerminal/web), the coder-only write restriction,
    plan-mode persistence (handled by the plan_build node, not a tool), ask-mode drops (read/memory/trivial-prompt schemas),
    ``allow_create`` gating of skill/MCP creation, and file-scope stripping.
    """
    cap = cap or {}
    _WEB = {"web_search", "fetch_url", "search_console"}
    has_cap = any(
        isinstance(cap.get(k), bool)
        for k in ("readFiles", "writeFiles", "runTerminal", "web")
    )
    if has_cap:
        _READ = {"grep", "glob", "read", "task"}
        _WRITE = {"write_file", "edit_file", "confirm_action"}
        _TERM = {"run_terminal"}
        denied: set[str] = set()
        if not cap.get("readFiles", False):
            denied |= _READ
        if not cap.get("writeFiles", False):
            denied |= _WRITE
        if not cap.get("runTerminal", False):
            denied |= _TERM
        tools = {n: fn for n, fn in tools.items() if n not in denied}
        if "run_terminal" in tools:
            tools["run_terminal"] = _agents._wrap_no_search_bypass(
                tools["run_terminal"]
            )
        if cap.get("runTerminal") and not cap.get("writeFiles"):
            tools["run_terminal"] = _agents._wrap_readonly_terminal(
                tools["run_terminal"]
            )
    else:
        if mode != "coder":
            tools = {
                n: fn
                for n, fn in tools.items()
                if n
                not in ("write_file", "edit_file", "run_terminal", "confirm_action")
            }
        if "run_terminal" in tools:
            tools["run_terminal"] = _agents._wrap_no_search_bypass(
                tools["run_terminal"]
            )

    # Web tools (web_search / fetch_url / search_console) are exposed to the
    # model whenever the web capability is not explicitly denied. The agent may
    # use them on its own initiative when it judges a web lookup is needed. They
    # are only stripped when ``cap["web"]`` is explicitly ``False`` (e.g. a
    # capability map that denies web access). When no capability map is supplied
    # (the common case), web tools stay available.
    if cap.get("web", True) is False:
        tools = {n: fn for n, fn in tools.items() if n not in _WEB}

    # Repo search tools (grep/glob/read/task) are now available to the Main
    # Agent for every mode that needs repo access (coder/plan/ask/reader). The
    # LLM decides iteratively which to call — there is NO mandatory
    # glob->grep->read order (this matches OpenCode). Write/terminal tools stay
    # coder-only (handled in the blocks above); non-coder modes therefore keep
    # only read/search/web/vision capabilities. The Explore subagent reuses the
    # same tool runtime in an isolated context.
    if mode == "ask":
        tools.pop("memory", None)
    if mode == "ask" and _agents._trivial_prompt(prompt):
        for n in (
            "update_plan",
            "ask_user",
            "request_permission",
        ):
            tools.pop(n, None)
    if not allow_create:
        tools = {
            n: fn for n, fn in tools.items() if n not in ("create_skill", "create_mcp")
        }

    scoped = bool(scoped_paths)
    if scoped:
        tools = {n: fn for n, fn in tools.items() if n not in ("glob", "task")}
        if "grep" in tools:
            tools["grep"] = _agents._wrap_scoped_search(tools["grep"], scoped_paths)
        if "read" in tools:
            tools["read"] = _agents._wrap_scoped_read(tools["read"], scoped_paths)
        if (
            "run_terminal" in tools
            and has_cap
            and cap.get("runTerminal")
            and not cap.get("writeFiles")
        ):
            tools["run_terminal"] = _agents._wrap_scoped_terminal(
                tools["run_terminal"], root, scoped_paths
            )
    # Auto-router: steer BROAD / repeated searches to the explore sub-agent.
    # وقتی تعداد callهای grep/glob/read/web_search/fetch_url از _AUTO_EXPLORE_THRESHOLD
    # (cross-turn) رد شد، یا یه جستجوی broad شناسایی شد، wrapper اجازه نمی‌ده
    # مستقیم اجرا بشه و مدل رو می‌فرسته سمت explore sub-agent. فقط توی حالت
    # coder اعمال می‌شه — توی plan/ask/reader مدل فقط ۱-۲ بار جستجو می‌زنه و
    # نباید مسدود بشه.
    if mode == "coder":
        tools = _agents._wrap_auto_explore_router(tools)

    # Record the PARENT's actual (mode-filtered) toolset so a sub-agent spawned
    # via `task` inherits exactly these tools — not the full registry. This is
    # what closes the read-only bypass: an explore/plan-mode `task` call can no
    # longer hand the sub-agent write tools. tools.py reads this contextvar in
    # _run_subagent_task and falls back to the full registry only when it is
    # unset (which should never happen now).
    _PARENT_TOOLS_CTX.set(tools)
    return tools


# ---------------------------------------------------------------------------
# Sub-agent model resolution (web / compact / vision) -> LangChain models
# ---------------------------------------------------------------------------


def resolve_subagent_model(
    provider: str,
    entry: Any,
    base_url: str,
    api_key: str,
    env_var: str,
    oauth_token: str,
    parent_model_name: str = "",
    default_to_parent: bool = True,
    provider_lookup: Any = None,
    timeout: float | None = None,
) -> Any:
    """Resolve a single sub-agent slot entry to a LangChain model.

    Cross-provider routing is delegated to ``agents._subagent_target`` so a
    ``"providerId/model"`` entry runs on THAT provider's own base URL / key —
    not silently dumped onto the parent (main) provider. This is the fix for
    the bug where a configured vision/web/compact model was ignored and the
    main model was used instead.

    * ``""`` / whitespace / ``None`` -> the parent model when
      ``default_to_parent`` is ``True`` (web / compact slots), otherwise
      ``None`` (vision slot, which has no parent default).
    * ``"main model"`` / ``"main_model"`` / ``"main"`` -> the parent model.
    * ``"provider/model"`` -> that provider's config + model (real routing).
    * bare model id -> the parent provider.
    """
    if entry is None:
        return (
            build_chat_model(
                provider,
                parent_model_name,
                base_url,
                api_key,
                env_var,
                oauth_token,
                temperature=0.2,
                timeout=timeout,
            )
            if (default_to_parent and parent_model_name)
            else None
        )
    if isinstance(entry, str):
        entry = entry.strip()
        if not entry:
            return (
                build_chat_model(
                    provider,
                    parent_model_name,
                    base_url,
                    api_key,
                    env_var,
                    oauth_token,
                    temperature=0.2,
                    timeout=timeout,
                )
                if (default_to_parent and parent_model_name)
                else None
            )
        if entry.lower() in ("main model", "main_model", "main"):
            entry = parent_model_name or entry
    target = _agents._subagent_target(
        entry,
        provider,
        base_url,
        api_key,
        env_var,
        oauth_token,
        provider_lookup or (lambda pid: None),
    )
    if not target:
        return None
    kind, model, burl, akey, env, oauth = target
    if not model:
        return None
    return build_chat_model(
        kind, model, burl, akey, env, oauth, temperature=0.2, timeout=timeout
    )


async def _vision_analyze(model: Any, image_uris: list[str]) -> str | None:
    """One-shot vision analysis of attached images using ``model`` (the
    configured vision model). Returns the analysis text, or ``None`` on any
    failure. The caller injects the result into the main model's context so it
    can "see" the image without having to call a vision tool.

    Uses the vision model directly — there is deliberately NO fallback to the
    main model (a configured vision model is the contract; if it fails the
    caller surfaces that).

    Transient provider errors (rate-limit / 5xx / timeout / network blip) are
    retried with backoff so a single flaky request doesn't silently drop the
    image. Every failure is logged so the drop is diagnosable instead of silent.
    """
    from llm import llm_generate

    system = (
        "You are a vision analysis sub-agent. The user attached image(s) to their "
        "message. Examine them carefully and transcribe what you see VERBATIM and "
        "completely, because this analysis is the main agent's ONLY view of the "
        "image. Priorities, in order:\n"
        "1. TRANSCRIBE ALL visible text exactly as written — especially file paths, "
        "filenames, code, terminal output, error messages, stack traces, URLs, "
        "numbers, and UI labels. Do not paraphrase or summarize text; quote it.\n"
        "2. Describe layout, structure and UI elements (buttons, panels, lists,\n"
        "   tables) and any colors/icons that carry meaning.\n"
        "3. If the image is a UI mockup or design reference, note the visual style.\n"
        "Be literal and exhaustive. Keep prose tight but never drop visible text."
    )
    user = (
        "Analyze the attached image(s). Transcribe every piece of on-screen text "
        "verbatim (file paths, code, errors), then describe layout/UI."
    )
    model_name = getattr(model, "model_name", "") or "unknown"
    # Retry ONLY transient provider failures (429 / 5xx / timeout / network
    # blip) so a single flaky vision request doesn't silently make the image
    # invisible. Permanent errors (e.g. 400 image-rejected) are NOT retried —
    # they surface immediately so the caller can tell the user to fix config.
    _start = time.monotonic()
    for attempt in range(_VISION_MAX_ATTEMPTS):
        # Stop early if we've burned the whole wall-clock budget — don't start
        # another (expensive) attempt that would blow past the 90s cap.
        if time.monotonic() - _start >= _VISION_TOTAL_BUDGET:
            logger.warning(
                "vision analyze (%s) hit the %ds total budget after %d attempt(s)",
                model_name,
                int(_VISION_TOTAL_BUDGET),
                attempt,
            )
            break
        try:
            text, _ = await llm_generate(
                model,
                system=system,
                user=user,
                images=image_uris,
                sub=True,
            )
            result = (text or "").strip()
            if result:
                return result
            # Empty/whitespace-only reply is not transient — don't retry, but
            # log it so a misbehaving vision model is visible.
            logger.warning(
                "vision analyze (%s) returned empty text on attempt %d/%d",
                model_name,
                attempt + 1,
                _VISION_MAX_ATTEMPTS,
            )
            return None
        except Exception as exc:  # noqa: BLE001
            if not _is_transient_error(exc):
                logger.warning(
                    "vision analyze (%s) failed with a non-transient error: %s",
                    model_name,
                    exc,
                )
                return None
            if attempt < _VISION_MAX_ATTEMPTS - 1:
                _elapsed = time.monotonic() - _start
                _remaining = _VISION_TOTAL_BUDGET - _elapsed
                if _remaining <= 0:
                    logger.warning(
                        "vision analyze (%s) exhausted the %ds budget before retry",
                        model_name,
                        int(_VISION_TOTAL_BUDGET),
                    )
                    break
                delay = min(_VISION_BACKOFF_BASE * (2**attempt), _remaining)
                logger.warning(
                    "vision analyze (%s) failed (attempt %d/%d): %s — retrying in %.1fs",
                    model_name,
                    attempt + 1,
                    _VISION_MAX_ATTEMPTS,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
            else:
                logger.warning(
                    "vision analyze (%s) failed after %d attempts: %s",
                    model_name,
                    _VISION_MAX_ATTEMPTS,
                    exc,
                )
    return None


def _is_transient_error(exc: Exception) -> bool:
    """Return True for retryable provider errors (429 / 5xx / timeout / network).

    Permanent client errors (4xx other than 429) are NOT transient — retrying
    them just wastes time and hides a real config problem."""
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
    if status is not None:
        return status == 429 or 500 <= status < 600
    # No status code -> treat as a network/timeout blip (retryable).
    msg = str(exc).lower()
    return any(
        k in msg
        for k in ("timeout", "timed out", "connection", "reset", "eof", "broken pipe")
    )


# Per-process cache of vision analyses, keyed by the sorted set of image URIs,
# so an image attached earlier in a conversation is analyzed ONCE and reused on
# every follow-up turn instead of being re-sent to the vision model each turn.
_VISION_CACHE: dict[str, str] = {}
_VISION_CACHE_MAX = 40

# Transient-failure resilience for the server-side vision analysis: a single
# flaky provider request (429 / 5xx / timeout / network blip) must not silently
# drop the attached image. Retry with exponential backoff, capped.
_VISION_MAX_ATTEMPTS = 3
_VISION_BACKOFF_BASE = 1.0
# Hard wall-clock cap on the ENTIRE vision analysis (all attempts + backoff).
# Prevents a slow/unreachable vision provider from locking the turn for minutes
# (3 attempts × 30s timeout + backoff ≈ 90s worst case).
_VISION_TOTAL_BUDGET = 90.0


async def _vision_analyze_cached(model: Any, image_uris: list[str]) -> str | None:
    if not image_uris:
        return None
    import hashlib

    key = hashlib.sha256("|".join(sorted(image_uris)).encode("utf-8")).hexdigest()
    cached = _VISION_CACHE.get(key)
    if cached is not None:
        return cached
    result = await _vision_analyze(model, image_uris)
    if result:
        _VISION_CACHE[key] = result
        if len(_VISION_CACHE) > _VISION_CACHE_MAX:
            # Evict the oldest entry (insertion order preserved in dicts).
            _VISION_CACHE.pop(next(iter(_VISION_CACHE)))
    return result


def _build_skills_section(picked_names: list[str], root: str) -> str:
    """Assemble the SKILLS section for ``build_turn_context``.

    Attached/picked skills have their FULL body inlined (so the agent adopts
    the skill's role and follows its instructions); every other known skill is
    listed compactly in ``AVAILABLE SKILLS`` (name + description only). When
    nothing is loaded, returns an empty string.

    This is intentionally independent of ``_skill_names_to_strip``: stripping a
    skill's *name* out of the search-keyword derivation must never prevent its
    *body* from being inlined here — the skill is still fully used."""
    all_skills = _agents._load_skills(root)
    if not all_skills:
        return ""
    picked: list[dict] = []
    manual_names = [n.strip() for n in picked_names if n and n.strip()]
    if manual_names:
        by_name = {s["name"].lower(): s for s in all_skills}
        picked = [by_name[n.lower()] for n in manual_names if n.lower() in by_name]
    section = _agents._skills_section(
        [s for s in all_skills if s["name"] not in {p["name"] for p in picked}]
    )
    if picked:
        bodies = "\n\n".join(
            f"===== SKILL: {s['name']} =====\nDescription: {s['description'] or ''}"
            f"\n\n{s['content']}\n===== END SKILL: {s['name']} ====="
            for s in picked
        )
        section = "\n\n=== ATTACHED SKILLS ===\n" + bodies + section
    return section


def _dedup_code_map(
    code_map_block: str,
    map_hash: str,
    chat_id: str,
    lc_history: list,
) -> str:
    """اگه نقشهٔ CODE MAP نسبت به turn قبلی تغییر نکرده، به‌جای ارسال کامل فقط
    یه marker کوتاه می‌فرسته — مگر اینکه نقشهٔ کاملِ قبلی دیگه تو recent tail
    (lc_history) نباشه (مثلاً به‌خاطر historyLimit یا auto-compact حذف/خلاصه
    شده باشه) که اون‌وقت نقشهٔ کامل رو دوباره می‌فرستیم تا مدل با marker
    بی‌محتوا گمراه نشه. کش هش per-chat هست (chat_id کلید dict)."""
    try:
        _cache = getattr(build_turn_context, "_code_map_hash_cache", None)
        if not isinstance(_cache, dict):
            _cache = {}
        _prev = _cache.get(chat_id)
        _full_still_in_history = any(
            isinstance(m, HumanMessage) and "CODE MAP" in str(getattr(m, "content", ""))
            for m in lc_history
        )
        if _prev == map_hash and _full_still_in_history:
            return (
                "\n\n===== CODE MAP (live symbol index — unchanged since last turn) =====\n"
                "[see previous turn's CODE MAP — no files changed]"
            )
        _cache[chat_id] = map_hash
        build_turn_context._code_map_hash_cache = _cache
    except Exception:  # noqa: BLE001, S110
        pass
    return code_map_block


async def build_turn_context(state: AgentState, queue: asyncio.Queue) -> dict:
    """Assemble everything one mode-turn needs: system prompt, history messages,
    the mode-filtered tool set, and the LangChain chat model.

    Reuses the SAME helpers ``run_agent`` used so prompts / RAG / skills stay
    equivalent to the previous behaviour.
    """
    import os

    root = state["root"]
    mode = state["mode"]
    prompt = (state.get("request") or "").strip()
    chat_id = state.get("chat_id", "")
    cap = state.get("cap") or {}
    allow_create = bool(state.get("allow_create"))
    allow_outside = bool(state.get("allow_outside"))
    attachments = state.get("attachments")
    images = state.get("images")
    nvim_file = state.get("nvim_file", "")
    skills = state.get("skills")
    system_extra = (state.get("system_prompt") or "").strip()

    # Gather images from the CURRENT turn AND every earlier message in the
    # conversation that carried an image. History is converted to text only
    # (history_to_langchain_messages drops image content), so without this the
    # model would "forget" an attached image on the very next turn and claim it
    # can't see anything. Re-analyzing historical images keeps the image context
    # alive across follow-up turns.
    _img_items: list = list(images or [])
    for _turn in state.get("history") or []:
        if isinstance(_turn, dict):
            _ti = _turn.get("images")
            if _ti:
                _img_items.extend(_ti)
    image_uris = _agents._load_images(_img_items)
    # Deduplicate by content so the same image isn't analyzed repeatedly within
    # a single turn (current + historical copies). Cross-turn de-duplication is
    # handled by the vision cache below.
    _seen: set[str] = set()
    _deduped: list[str] = []
    for _u in image_uris:
        if _u and _u not in _seen:
            _seen.add(_u)
            _deduped.append(_u)
    image_uris = _deduped

    # Context window (resolve live when the UI did not supply one).
    ctx = int(state.get("context_window") or 0)
    if ctx <= 0:
        try:
            from providers import model_context

            ctx = await model_context(
                state["provider"],
                state["model_name"],
                state["base_url"],
                state["api_key"],
                state["env_var"],
                oauth_token=state["oauth_token"],
            )
        except Exception:  # noqa: BLE001
            ctx = 0
    ctx = max(0, ctx)

    cap = state.get("cap")
    # All sub-agents (search / web / explore / vision / compact distills) and the
    # PARENT LLM loop run on LangChain models built from ``build_chat_model``.
    subagent_models = state.get("subagent_models") or {}
    # Cross-provider routing: a "providerId/model" sub-agent entry must run on
    # that provider's OWN base URL / key. The frontend sends the full provider
    # configs (keyed by id) so we can look them up here.
    _providers = state.get("providers") or {}
    _provider_lookup = lambda pid: (
        _providers.get(pid) if isinstance(_providers, dict) else None
    )
    web_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("web"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        state["model_name"],
        provider_lookup=_provider_lookup,
    )
    compact_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("compact"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        state["model_name"],
        provider_lookup=_provider_lookup,
        # Bounded so an auto-compact summarizer fails fast (and is skipped)
        # instead of hanging the turn when the provider is slow/unreachable.
        timeout=50,
    )
    vision_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("vision"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        state["model_name"],
        default_to_parent=False,
        provider_lookup=_provider_lookup,
        # Bounded so a slow/unreachable vision provider fails fast (and is
        # surfaced to the user) instead of hanging the turn. The retry/backoff
        # in _vision_analyze covers transient blips within this budget.
        timeout=30,
    )
    explore_model = resolve_subagent_model(
        state["provider"],
        subagent_models.get("explore"),
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        state["model_name"],
        default_to_parent=True,
        provider_lookup=_provider_lookup,
    )

    settings = await chat_model_settings(
        mode,
        ctx,
        state.get("thinking_level", ""),
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        _agents._detect_scope(prompt),
    )
    model = build_chat_model(
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
        temperature=settings["temperature"],
        max_tokens=settings["max_tokens"],
        thinking_level=settings["thinking_level"],
        model_reasoning=state.get("model_reasoning", False),
        timeout=model_timeout_for(state),
    )

    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(ev),
        context_window=ctx,
        web_model=web_model,
        main_model=model,
        vision_model=vision_model,
        explore_model=explore_model,
        image_uris=image_uris,
        reserved=state.get("reserved"),
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit={"outside": allow_outside},
        chat_id=chat_id,
        history=state.get("history") or [],
    )

    scoped_paths = _agents._scoped_rels(root, attachments, nvim_file)
    filtered = filter_tools_for_mode(
        mode,
        tools,
        cap,
        scoped_paths,
        allow_create,
        allow_outside,
        prompt=prompt,
        root=root,
    )

    # --- MCP bridge -------------------------------------------------------
    # Previously the runtime never opened a connection to the configured MCP
    # servers, so their tools (e.g. the Docker MCP connector) were unreachable
    # and the frontend only injected a no-op text note. We now connect for real
    # and merge the live tools into the same `filtered` dict the tool loop
    # reads, plus expose a cleanup coroutine so the caller can close the
    # sessions when the turn ends.
    mcp_tools, mcp_cleanup = await build_mcp_tools(
        state.get("mcp_servers") or {}, lambda ev: queue.put_nowait(ev)
    )
    for t in mcp_tools:
        filtered[t.name] = t.func
    # Whether the `vision` tool survived mode filtering (e.g. coder mode
    # strips it). When it is NOT available we must fall back to attaching the
    # image directly to the main model, otherwise the model could never see it.
    vision_tool_available = "vision" in filtered

    workspace_note = (
        "\n\nYou are running in the user's desktop IDE. The current open WORKSPACE "
        f"ROOT is:\n{root}\nUse paths RELATIVE to this folder (e.g. 'src/main.py'), "
        "never absolute paths. You operate ONLY inside this workspace. NEVER read, "
        "search or act on anything outside it. Skills, plans and MCP connectors are "
        "stored in the app database and are given to you inline."
    )
    if nvim_file:
        with contextlib.suppress(Exception):
            tgt = _agents.resolve_safe(root, nvim_file)
            if tgt and os.path.isfile(tgt):
                nvim_rel = os.path.relpath(tgt, _agents.resolve_safe(root, ""))
                workspace_note += (
                    f"\n\n=== NEOVIM (OPEN EDITOR) ===\nThe user currently has `{nvim_rel}` "
                    "open in Neovim -- this file is their ACTIVE FOCUS."
                )
    # Attached files are UNIFIED with Neovim: they enter the agent exactly like
    # the Neovim open file -- as a scoped path + a focus note -- so the agent
    # reads them on demand via the read/grep tools instead of force-reading
    # their full contents into the prompt. This keeps the tool runtime the
    # single source of file access (spec §2/§13) and saves tokens. The actual
    # scoping is applied via `_scoped_rels` -> `scoped_paths` below.
    if attachments:
        try:
            _att_rels = [
                os.path.relpath(
                    _agents.resolve_safe(root, a), _agents.resolve_safe(root, "")
                )
                for a in (attachments or [])
                if a and os.path.isfile(_agents.resolve_safe(root, a))
            ]
        except Exception:  # noqa: BLE001
            _att_rels = []
        if _att_rels:
            workspace_note += (
                "\n\n=== ATTACHED FILES ===\nThe user attached these file(s) as their "
                "focus: "
                + ", ".join("`" + f + "`" for f in _att_rels)
                + ". They are in SCOPE — read them with the read tool when relevant."
            )
    if scoped_paths:
        workspace_note += (
            "\n\n=== SCOPE (ONLY THESE FILES) ===\nThe user explicitly scoped this "
            "request to ONLY these files: "
            + ", ".join("`" + f + "`" for f in sorted(scoped_paths))
            + ". You MUST work ONLY with these files."
        )

    base_prompt = (
        _agents.SYSTEM_PROMPTS.get(mode, _agents.SYSTEM_PROMPTS["ask"])
        + _agents._UNIVERSAL_RULES
        + _agents._DOING_TASKS
        + (_agents._LENGTH_RULE if mode in ("plan", "coder") else "")
        + (_agents._TEST_DIR_RULE if mode in ("plan", "coder") else "")
    )
    # Language directive depends on the CURRENT prompt (Persian/English
    # detection), so it must NOT live in the system prompt — otherwise the cache
    # prefix breaks every turn and prefix caching never hits. It is injected into
    # the user turn instead (see user_parts below). Same for the per-turn RAG
    # block.
    lang_directive = _agents._language_directive(prompt)
    system_final = (
        _agents._mode_declare(mode)
        + _agents._SEARCH_RULE
        + base_prompt
        + workspace_note
    )
    system_final += (
        "\n\nRULES (strict, always follow, in every mode):\n"
        "1. CLARIFY: when the request is ambiguous, call ask_user FIRST.\n"
        "2. CONTEXT-FIRST: before any search/discovery tool, check what is ALREADY "
        "in your context (RAG blocks, conversation, files you already read)."
    )
    if system_extra:
        system_final += (
            "\n\nUser-supplied custom prompt (append to the above):\n" + system_extra
        )
    if image_uris:
        system_final += (
            "\n\nIMAGE ATTACHED: the user included image(s) in this conversation "
            "(this turn or an earlier one). A verbatim ATTACHED IMAGE ANALYSIS block "
            "is included in your message — treat it as ground truth. Transcribe any "
            "visible file paths / filenames / code / text EXACTLY as analyzed; never "
            "invent or omit what the image shows."
        )
    if mode in ("ask", "plan"):
        system_final += _agents._DISCOVERY_BLOCK
    if mode == "reader":
        system_final += (
            "\n\nFOCUSED READING: the user pointed you at specific file(s) (open in "
            "Neovim, attached, or @mentioned). They are in SCOPE -- read them with the "
            "read tool (and grep/read within them as needed) to answer. The search "
            "tools are available, but stay focused on the pointed-at files unless the "
            "user asks to broaden. vision / skills / MCP connectors are available on "
            "demand when the question needs external info or attached images."
        )

    try:
        project_memory = _agents._load_project_memory(root)
    except Exception:  # noqa: BLE001
        project_memory = ""
    if project_memory:
        system_final += project_memory

    # Skills.
    system_final += _build_skills_section(skills or [], root)

    if mode in ("plan", "coder"):
        try:
            saved = _agents._load_saved_plan(root, chat_id=chat_id)
        except Exception:  # noqa: BLE001
            saved = ""
        if saved:
            system_final += saved

    # نقشه‌ی نماد لحظه‌ای (CODE MAP) — مدل مستقیماً می‌ره سراغ read،
    # بدون نیاز به grep/glob کورکورانه. جایگزین ایندکس کد در RAG.
    # فقط برای مودهای کد تزریق می‌شه (ask/reader/chat نماد نمی‌خوان) و
    # به user turn اضافه می‌شه (نه سیستم‌پرامپت) تا کشِ پیشوند نشکنه.
    code_map_block = ""
    if mode in ("coder", "plan", "ask"):
        try:
            from symbol_index import format_symbol_map

            # استخراج فایل‌های ذکرشده از تاریخچه (مثل aider.get_repo_map که از
            # پیام فعلی می‌گیره — ما از کل تاریخچه می‌گیریم چون context کامل‌تره).
            # این باعث می‌شه نقشه بر اساس سوال/چت رتبه‌بندی بشه (PageRank با
            # personalization) بدون اینکه فایلی کلاً حذف بشه.
            _mentioned_fnames: set[str] = set()
            _mentioned_idents: set[str] = set()
            _hist_for_map = state.get("history") or []
            for _turn in _hist_for_map:
                for _ta in (_turn.get("toolActivity") or []):
                    _p = _ta.get("args", {}).get("path") or _ta.get("args", {}).get("filePath")
                    if _p:
                        _mentioned_fnames.add(os.path.relpath(_p, root))
                _content = _turn.get("content") or ""
                if isinstance(_content, str):
                    for _m in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", _content):
                        _mentioned_idents.add(_m)

            # ask توکن‌حساس‌تره → بودجه کمتر.
            max_map_tokens = 512 if mode == "ask" else 1024
            # نقشه کامل فرستاده می‌شه (بدون فیلتر بر اساس سوال) — فیلتر کردن
            # نقشه باعث می‌شد ایجنت فایل موردنظرش رو توی نقشه نبینه و مجبور بشه
            # با grep/read دنبالش بگرده → tool call بیشتر. پس نقشه رو کامل
            # می‌فرستیم و فقط به کش هش (پایین) تکیه می‌کنیم تا توکن تورن‌های
            # تکراری کم بشه.
            code_map_block = (
                format_symbol_map(
                    root,
                    max_map_tokens=max_map_tokens,
                    mentioned_fnames=_mentioned_fnames,
                    mentioned_idents=_mentioned_idents,
                )
                if root
                else ""
            )
        except Exception:  # noqa: BLE001
            code_map_block = ""

    # کش هش نقشه: اگه نقشه نسبت به تورن قبلی عوض نشده، کل نقشه رو نمی‌فرستیم
    # بلکه یه marker کوتاه می‌فرستیم (توکن کمتر، چون محتوای یکسانه). این با
    # prefix-cache هم تداخل نداره چون نقشه توی user turn هست نه سیستم‌پرامپت.
    _map_hash = ""
    if code_map_block:
        try:
            import hashlib

            _map_hash = hashlib.md5(code_map_block.encode("utf-8", "ignore")).hexdigest()[:12]
        except Exception:  # noqa: BLE001, S110
            pass

    # No pre-injected workspace scout: discovery is the agent's job now (it has
    # glob/grep/read and the Explore sub-agent), matching the OpenCode-style
    # design where nothing is force-read into the prompt before the model runs.
    # opencode sends the FULL history every turn and compacts on overflow — it
    # never trims history by a char/token budget before sending (that caused
    # messages to disappear every turn and mode switches to shrink context).
    # The backend's auto-compact (_maybe_auto_compact) still fires on real
    # overflow, so large windows are handled without silently dropping turns.
    history = state.get("history") or []
    # historyLimit (General setting): 0 = full history (default, unchanged
    # behaviour); N > 0 = send only the last N turns verbatim + a compact
    # summary of the older turns. The summary is prefixed with
    # "[Compacted earlier context]" so the auto-compactor (_maybe_auto_compact
    # -> _compact_history) MERGES it on a later overflow instead of
    # re-expanding it — keeping historyLimit and auto-compact compatible.
    _history_limit = 0
    with contextlib.suppress(Exception):
        _history_limit = int((state_db.get_settings() or {}).get("historyLimit", 0) or 0)
    if _history_limit > 0 and len(history) > _history_limit:
        _recent = history[-_history_limit:]
        _older = history[:-_history_limit]
        _summary = await _summarize_history_head(compact_model, _older, root)
        lc_history = history_to_langchain_messages(_recent, current_mode=mode)
        lc_history.insert(0, SystemMessage(content=_summary))
        # بخش خلاصه‌شده ممکنه شامل turnی با نقشهٔ کامل بوده باشه → محتوای نقشه
        # از context افتاده. کش هش رو پاک می‌کنیم تا turn بعدی نقشهٔ کامل بفرسته
        # نه marker بی‌محتوای «see previous turn».
        _code_map_hash_cache = getattr(build_turn_context, "_code_map_hash_cache", None)
        if isinstance(_code_map_hash_cache, dict) and chat_id in _code_map_hash_cache:
            _code_map_hash_cache.pop(chat_id, None)
    else:
        lc_history = history_to_langchain_messages(history, current_mode=mode)
    # CODE MAP dedup: فقط وقتی marker "unchanged" بفرست که نقشهٔ کامل هنوز
    # تو recent tail (lc_history) هست — وگرنه (اگه historyLimit یا auto-compact
    # turn حاوی نقشه رو حذف/خلاصه کرده باشه) نقشهٔ کامل رو دوباره می‌فرستیم تا
    # مدل با یه marker بی‌محتوا ("see previous turn") که به هیچی اشاره نمی‌کنه
    # گمراه نشه. کش هش per-chat هست (chat_id کلید dict) نه یه scalar global.
    if code_map_block and mode in ("coder", "plan", "ask") and _map_hash:
        code_map_block = _dedup_code_map(
            code_map_block, _map_hash, chat_id, lc_history
        )
    with contextlib.suppress(Exception):
        _hist_chars = sum(len(str(getattr(m, "content", ""))) for m in lc_history)
        _tool_items_chars = 0
        for _h in history:
            for _ta in _h.get("toolActivity") or []:
                _its = _ta.get("items")
                if isinstance(_its, list):
                    for _it in _its:
                        if isinstance(_it, dict):
                            _tool_items_chars += len(str(_it.get("snippet", "")))
                        else:
                            _tool_items_chars += len(str(_it))
        print(
            f"[CTX_DEBUG] history_msgs={len(history)} lc_msgs={len(lc_history)} "
            f"est_tokens={_hist_chars // 4} tool_items_chars={_tool_items_chars}",
            flush=True,
        )

    if mode == "coder":
        reuse = _agents._plan_reuse_note(history)
        if reuse:
            lc_history.insert(0, SystemMessage(content=reuse))
        disc = _agents._plan_discovery_note(history)
        if disc:
            lc_history.insert(0, SystemMessage(content=disc))
        # Enforce the test-verification rule at runtime for any code-changing
        # coder task (feature/bugfix/refactor), not only when the prompt
        # literally says "test". This closes the gap the user reported: coder
        # must write/update and run tests before finishing, even on ordinary
        # code work. The pure-logic predicates live in agents.py.
        if _agents._is_code_task(prompt):
            stack = detect_frontend_stack(root)
            fw_note = ""
            if stack:
                fw_note = (
                    f" This workspace is a {stack} frontend — write component tests "
                    f"with @testing-library/react (or that framework's testing library) "
                    f"and run the project's frontend command (npm run test:frontend / "
                    f"npx vitest run / npx jest). "
                )
            # Tell the Coder the EXACT commands to run so it runs the project's
            # tests itself (there is no automatic test gate in the graph). This
            # also keeps detect_test_commands() in active use instead of dead code.
            cmds = detect_test_commands(root)
            cmd_note = ""
            if cmds:
                cmd_note = (
                    " Run these project test command(s) yourself via run_terminal "
                    "before finishing: " + "; ".join(cmds) + ". "
                )
            lc_history.insert(
                0,
                SystemMessage(
                    content=(
                        "TEST VERIFICATION RULE: this is code-changing work. "
                        "Write/update the relevant test(s) for the language(s) you "
                        "touched and run them yourself (uv run pytest / npm test / "
                        "cargo test / go test / mvn test / dotnet test / flutter test / "
                        "dart test / ..." + fw_note + ")." + cmd_note + "Do NOT finish "
                        "with red tests — keep fixing until all tests pass."
                    )
                ),
            )
    reuse_tool = _agents._tool_reuse_note(history)
    if reuse_tool:
        lc_history.insert(0, SystemMessage(content=reuse_tool))

    # User content (prompt; images as content parts). Attached FILE
    # contents are no longer force-injected here — they enter via scope + the
    # focus note above and are read on demand (unified with Neovim). No workspace
    # scout is injected either; the agent discovers via its tools.
    user_parts: list[Any] = []
    if prompt:
        user_parts.append(prompt)
    # Prompt-dependent blocks (language directive + per-turn RAG context) are
    # injected HERE, into the user turn, instead of the system prompt. This keeps
    # the system prompt fully static so prefix caching hits consistently across
    # turns (previously these prompt-derived strings sat inside the system
    # message and changed the cache prefix every turn, causing cache_read=0
    # spikes and unstable input_tokens).
    if lang_directive:
        user_parts.append(lang_directive)
    if code_map_block:
        user_parts.append(code_map_block)
    # SERVER-SIDE vision analysis of attached images. Prefer the dedicated
    # vision model, but FALL BACK to the main model (mirroring the `vision`
    # tool's own fallback) so an attached image is ALWAYS analyzed
    # automatically — the agent must not need to be told "look at the image".
    # If even the fallback model can't analyze it, we surface a note rather
    # than attaching raw bytes that would just 400.
    prefetch_model = vision_model or model
    _analysis = None
    if image_uris and prefetch_model:
        _analysis = await _vision_analyze_cached(prefetch_model, image_uris)
        if _analysis:
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s); this is exactly what they show — treat it as part of the "
                f"request and ground your answer on it]\n{_analysis}\n\n"
                "INSTRUCTION: You MUST use the ATTACHED IMAGE ANALYSIS above. "
                "Transcribe any visible file paths / filenames / code / text VERBATIM "
                "into your reply; do not invent or omit them. If a design skill is "
                "mentioned, apply its guidance to render what the image depicts."
            )
        else:
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s) but the vision model "
                f"({getattr(prefetch_model, 'model_name', '') or 'unknown'}) could "
                f"not analyze them. The model likely does not support images or is "
                f"misconfigured. ACTION: tell the user to set a Vision model in "
                f"Settings → Subagents → Vision, or paste the image's text directly. "
                f"Do NOT guess what the image contains.]"
            )
    elif image_uris:
        # No model available at all (only if `model` itself failed to build).
        user_parts.append(
            f"[context] {len(image_uris)} image(s) are attached but no vision model "
            "is configured, so you cannot see them. ACTION: tell the user to set a "
            "Vision model in Settings → Subagents → Vision, or ask them to paste the "
            "image's text."
        )
    user_content: Any
    if (
        image_uris
        and (not prefetch_model or not vision_tool_available)
        and not _analysis
    ):
        content_blocks = [{"type": "text", "text": "\n\n".join(user_parts)}]
        for uri in image_uris:
            content_blocks.append({"type": "image_url", "image_url": {"url": uri}})
        user_content = content_blocks
    else:
        user_content = "\n\n".join(user_parts)

    messages: list[BaseMessage] = [SystemMessage(content=system_final)]
    messages.extend(lc_history)
    messages.append(HumanMessage(content=user_content))

    with contextlib.suppress(Exception):
        _sys_chars = len(str(system_final))
        _user_chars = (
            len(user_content)
            if isinstance(user_content, str)
            else sum(
                len(str(c.get("text", ""))) for c in user_content if isinstance(c, dict)
            )
        )
        print(
            f"[CTX_DEBUG] sys_chars={_sys_chars} hist_chars={_hist_chars} "
            f"user_chars={_user_chars} total_chars={_sys_chars + _hist_chars + _user_chars}",
            flush=True,
        )

    # Convert the mode-filtered fns to LangChain StructuredTools. MCP tools are
    # already StructuredTools (built in build_mcp_tools), so they pass through.
    lc_tools = [
        (
            t
            if isinstance(t, StructuredTool)
            else StructuredTool.from_function(
                func=t, name=name, description=(t.__doc__ or name)
            )
        )
        for name, t in filtered.items()
    ]

    return {
        "model": model,
        "messages": messages,
        "tools": filtered,
        "lc_tools": lc_tools,
        "system_final": system_final,
        "ctx": ctx,
        "scoped_paths": scoped_paths,
        "web_model": web_model,
        "compact_model": compact_model,
        "vision_model": vision_model,
        "main_model": model,
        "prompt": prompt,
        "mcp_cleanup": mcp_cleanup,
    }


def model_timeout_for(state: AgentState) -> float:
    from providers import model_timeout

    mt = model_timeout(provider=state["provider"], total=300)
    if isinstance(mt, tuple(mt.__class__ for mt in ()) or ()):
        pass
    # httpx.Timeout (non-Google) -> use its read component as the request timeout.
    with contextlib.suppress(Exception):
        import httpx

        if isinstance(mt, httpx.Timeout):
            return float(mt.read)
    return float(mt)


# ---------------------------------------------------------------------------
# Shared LLM tool-loop runner (LangChain)
# ---------------------------------------------------------------------------


def _estimate_content_tokens(content: Any) -> int:
    """Token estimate for a message content that may be a string or a list of
    content blocks (text/image)."""
    if not content:
        return 0
    if isinstance(content, str):
        return _agents._estimate_tokens(content)
    if isinstance(content, list):
        total = 0
        for p in content:
            if isinstance(p, dict):
                total += _agents._estimate_tokens(p.get("text", "") or "")
            else:
                total += _agents._estimate_tokens(str(p))
        return total
    return _agents._estimate_tokens(str(content))


def _estimate_prompt_tokens(messages: list) -> int | None:
    """Local, stable token estimate of the FULL input prompt sent this turn
    (every message in `messages`: system + history + current user turn + tools).

    This — not the provider's per-request input+output total — is what the
    context meter should reflect: it grows monotonically with the conversation
    history and is independent of how long the model's OUTPUT happens to be
    this turn (output length otherwise makes the running-max meter pin to an
    old value and stop moving). Mirrors opencode's message-list based context
    count."""
    try:
        total = 0
        for m in messages or []:
            total += _estimate_content_tokens(getattr(m, "content", ""))
        return total
    except Exception:  # noqa: BLE001
        return None


def _usage_event_from_ai(
    ai: Any, model: str, prompt_tokens: int | None = None
) -> dict | None:
    """Build a frontend ``usage`` event from a LangChain ``AIMessage``.

    LangChain surfaces token counts in ``usage_metadata`` (OpenAI/Google),
    or sometimes under ``response_metadata.token_usage``. Returns ``None``
    when there is nothing usable so a degenerate (zero-token) event is never
    emitted — a zero event would drag the frontend context meter to a
    misleading 0%.
    """
    um = getattr(ai, "usage_metadata", None)
    if not um:
        rm = getattr(ai, "response_metadata", None) or {}
        um = rm.get("token_usage") or rm.get("usage") or None
    if not um:
        return None
    try:
        input_tokens = int(um.get("input_tokens") or um.get("prompt_tokens") or 0)
        output_tokens = int(um.get("output_tokens") or um.get("completion_tokens") or 0)
    except (TypeError, ValueError):
        return None
    if input_tokens <= 0 and output_tokens <= 0:
        return None
    cache_read, cache_write, key_additive = _extract_cache_tokens(um)
    # Additive (cache must be added to input) when the cache key is Anthropic-native
    # (cache_read_input_tokens / cache_creation_input_tokens, where input excludes
    # it), OR when the cached portion is LARGER than input_tokens (proving input
    # excludes the cache). Otherwise the cache is a SUBSET of input_tokens and the
    # provider's total_tokens already counts it (adding it back would double-count).
    additive = (
        key_additive
        or (cache_read > 0 and input_tokens < cache_read)
        or (cache_write > 0 and input_tokens < cache_write)
    )
    if additive:
        # Cache is separate from input_tokens -> add it back for the true total.
        total_tokens = input_tokens + output_tokens + cache_read + cache_write
    else:
        provided_total = um.get("total_tokens") or 0
        total_tokens = (
            provided_total if provided_total else input_tokens + output_tokens
        )
    import json as _json

    try:
        _um_dump = _json.dumps(um, default=str)
    except Exception:  # noqa: BLE001
        _um_dump = repr(um)
    # `context_tokens` is the LOCAL estimate of the full input prompt sent this
    # turn (system + history + current user turn + tools), independent of how
    # long the model's OUTPUT happens to be. The frontend takes a running max
    # over the chat's assistant messages so the meter reflects the true
    # (monotonic) context and never drops as the conversation grows — and
    # because this estimate excludes output, a long-output turn can no longer
    # pin the running-max to an old value and stop the meter from moving.
    return {
        "kind": "usage",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "context_tokens": prompt_tokens,
        "model": model or "",
    }


def _extract_cache_tokens(um: dict) -> tuple[int, int, bool]:
    """Extract cache read/write token counts from ANY provider's usage metadata.

    Provider conventions handled (read-side / write-side):

    * Anthropic (LangChain): ``cache_read_input_tokens`` / ``cache_creation_input_tokens``
      at top level OR nested under ``input_token_details`` — ADDITIVE with
      ``input_tokens`` (the cached history is sent separately each turn).
    * OpenRouter-style ``input_token_details.cache_read`` / ``cache_creation`` and
      OpenAI / Google ``input_token_details.cached_tokens`` (or ``cache_read_tokens``)
      — a SUBSET of ``input_tokens``; the provider's ``total_tokens`` already
      includes them, so they must NOT be added back.
    * OpenAI raw: ``prompt_tokens_details.cached_tokens``.

    Returns ``(cache_read, cache_write, additive)`` where ``additive`` is True when
    the cache is reported separately from ``input_tokens`` and must be summed in.
    Any unrecognised ``cache*`` key falls through to the generic scan below.
    """
    details = um.get("input_token_details") or {}
    if not isinstance(details, dict):
        details = {}
    prompt_details = um.get("prompt_tokens_details") or {}
    if not isinstance(prompt_details, dict):
        prompt_details = {}

    # Anthropic-style (additive): input_tokens excludes the cached history.
    anthropic_read = (
        details.get("cache_read_input_tokens") or um.get("cache_read_input_tokens") or 0
    )
    anthropic_write = (
        details.get("cache_creation_input_tokens")
        or um.get("cache_creation_input_tokens")
        or 0
    )
    # OpenAI / Google-style (subset of input_tokens; total already counts it).
    openai_read = (
        details.get("cached_tokens")
        or details.get("cache_read")
        or details.get("cache_read_tokens")
        or prompt_details.get("cached_tokens")
        or um.get("cache_read_tokens")
        or 0
    )
    openai_write = (
        details.get("cache_creation")
        or details.get("cache_creation_tokens")
        or details.get("cache_write_tokens")
        or um.get("cache_write_tokens")
        or 0
    )
    cache_read = int(anthropic_read or openai_read or 0)
    cache_write = int(anthropic_write or openai_write or 0)
    key_additive = bool(anthropic_read or anthropic_write)
    return cache_read, cache_write, key_additive


def _strip_think_tags(
    text: str, in_think: bool, think_buf: str
) -> tuple[str, bool, str]:
    """Remove literal ``<think>…</think>`` reasoning from streamed text.

    Some models (DeepSeek/Qwen/llama.cpp and a few OpenAI-compatible gateways)
    emit their chain-of-thought as a literal ``<think>…</think>`` block inside
    the ``content`` stream instead of using a dedicated reasoning field. We drop
    it from the visible text so it never leaks to the frontend. The tag may span
    multiple streamed deltas, so the ``in_think`` / ``think_buf`` state is
    preserved across calls.
    """
    if not text:
        return text, in_think, think_buf
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if not in_think:
            start = text.find("<think", i)
            if start == -1:
                out.append(text[i:])
                break
            out.append(text[i:start])
            in_think = True
            i = start + len("<think")
            # Consume the optional 'i' of the <thinking> variant, then skip to
            # the closing '>' of the opening tag.
            if i < n and text[i] == "i":
                i += 1
            gt = text.find(">", i)
            if gt == -1:
                think_buf += text[i:]
                i = n
            else:
                i = gt + 1
        else:
            end = text.find("</think>", i)
            if end == -1:
                think_buf += text[i:]
                i = n
            else:
                think_buf += text[i:end]
                in_think = False
                i = end + len("</think>")
    return "".join(out), in_think, think_buf


def _is_repeating(
    text: str, min_len: int = 20, max_len: int = 200, min_reps: int = 3
) -> bool:
    """Detect a degenerate text loop at the tail of ``text``.

    Models sometimes emit the same sentence/phrase dozens of times with no
    tool call (e.g. "Let me check that. Let me check that. …"). The existing
    guards only watch the tool-call signature, so this text-only check catches
    it. It only flags *exact* back-to-back repetition of a bounded-length unit,
    so normal prose that happens to reuse a phrase (or even a sentence) a couple
    of times never trips it.

    ``min_len``/``max_len`` bound the repeated unit so a single repeated
    character or a huge block can't false-positive. ``min_reps`` is how many
    consecutive copies we need to call it a loop.
    """
    if not text or len(text) < min_len * min_reps:
        return False
    # Scan candidate unit lengths from longest to shortest so we match the
    # largest repeated phrase first (e.g. a whole sentence, not one word).
    for unit in range(min(max_len, len(text) // min_reps), min_len - 1, -1):
        tail = text[-(unit * min_reps) :]
        if len(tail) < unit * min_reps:
            continue
        first = tail[:unit]
        if all(tail[i * unit : (i + 1) * unit] == first for i in range(1, min_reps)):
            return True
    return False


def _thinking_from_chunk(chunk: Any) -> str | None:
    """Extract reasoning/thinking text from a streamed LangChain chunk.

    Reasoning-capable gateways (OpenAI o-series, DeepSeek reasoner, Gemini
    thinking, …) surface their chain-of-thought in different places: a
    ``reasoning_content`` field on the chunk, a ``thinking`` part inside a
    list-typed ``content``, or under ``additional_kwargs`` /
    ``response_metadata``. Returns the text when present, else ``None`` so the
    caller can skip emitting a frontend ``thinking`` event; never raises on
    unexpected shapes.
    """
    if chunk is None:
        return None

    def _coerce(val: Any) -> str | None:
        # A nested mapping like response_metadata={"reasoning": {"text": ...}}
        # is flattened to its inner string value.
        if isinstance(val, dict):
            for k in ("text", "thinking", "reasoning", "content"):
                inner = val.get(k)
                if isinstance(inner, str) and inner:
                    return inner
            return None
        if isinstance(val, str) and val:
            return val
        return None

    # 1) Direct attribute (OpenAI o-series / DeepSeek via langchain-openai).
    rc = getattr(chunk, "reasoning_content", None)
    out = _coerce(rc)
    if out:
        return out
    # 2) List-typed content with a "thinking"/"reasoning" part.
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("thinking", "reasoning"):
                txt = _coerce(
                    part.get("text") or part.get("thinking") or part.get("reasoning")
                )
                if txt:
                    return txt
    # 3) additional_kwargs / response_metadata fallbacks.
    for bag in (
        getattr(chunk, "additional_kwargs", None) or {},
        getattr(chunk, "response_metadata", None) or {},
    ):
        if not isinstance(bag, dict):
            continue
        for key in ("reasoning_content", "reasoning", "thinking"):
            out = _coerce(bag.get(key))
            if out:
                return out
    return None


_HISTORY_SUMMARY_CACHE: dict = {}  # key=(root, hash) -> summary text


async def _summarize_history_head(compact_model: Any, older: list, root: str) -> str:
    """Summarize the OLDER turns (dropped by historyLimit) into one block.

    The block is prefixed with "[Compacted earlier context]" so the
    auto-compactor merges it on a later overflow instead of re-expanding it
    (see agents.py _compact_history). Cached per (root, content-hash) so we
    don't re-summarize identical older history every turn (only new turns are
    appended, so the older slice is stable across turns).
    """
    _key = (
        root,
        hashlib.md5(
            json.dumps(older, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:16],
    )
    if _key in _HISTORY_SUMMARY_CACHE:
        return _HISTORY_SUMMARY_CACHE[_key]
    if compact_model is None:
        # Fallback without an LLM: keep the last few user messages + first line
        # of each assistant reply so the model still has the gist.
        _parts = [
            f"{t.get('role')}: {str(t.get('content', ''))[:200]}"
            for t in older[-12:]
        ]
        _summary = "[Compacted earlier context]\n" + "\n".join(_parts)
    else:
        try:
            _serialized = "\n\n".join(
                f"{t.get('role')}: {t.get('content', '')}" for t in older
            )
            _summary, _ = await llm_generate(
                compact_model,
                system=(
                    "Summarize this coding-agent conversation history into ONE "
                    "concise block preserving user requests, file paths, decisions, "
                    "and errors. Prefix the summary with '[Compacted earlier context]'."
                ),
                user=_serialized[:20000],
            )
            if not str(_summary).startswith("[Compacted earlier context]"):
                _summary = "[Compacted earlier context]\n" + str(_summary)
        except Exception:  # noqa: BLE001 — degrade to a plain omission note
            _summary = "[Compacted earlier context]\n[history omitted by historyLimit]"
    _HISTORY_SUMMARY_CACHE[_key] = _summary
    return _summary


async def _compact_tool_history(
    msgs: list, compact_model: Any, budget_chars: int
) -> bool:
    """Compress older tool results in place when the transcript exceeds the
    budget. All but the two most-recent ToolMessages are summarized by the
    compact model into a single compressed ToolMessage; if no compact model is
    configured they are dropped outright. Returns True if a compaction ran.

    This is the in-turn half of context management (spec §10 / invariant #12):
    it stops the provider from re-receiving an ever-growing raw tool history on
    every step. The Explore sub-agent keeps its own isolated transcript, so this
    only ever touches the Main Agent's own turn loop.
    """
    total = sum(len(getattr(m, "content", "") or "") for m in msgs)
    if total <= budget_chars:
        return False
    tool_idx = [i for i, m in enumerate(msgs) if isinstance(m, ToolMessage)]
    if len(tool_idx) <= 2:
        return False
    old_idx = tool_idx[:-2]
    old_text = "\n".join(
        f"<tool_result>\n{msgs[i].content}\n</tool_result>" for i in old_idx
    )
    # Drop the old tool messages first so we always shrink, even if the
    # summarization call below fails.
    for i in reversed(old_idx):
        del msgs[i]
    if compact_model is None:
        msgs.append(
            ToolMessage(
                content=(
                    f"[Earlier tool results compacted to save context: "
                    f"{len(old_idx)} tool outputs removed.]"
                ),
                tool_call_id="__compact__",
            )
        )
        return True
    try:
        summary, _ = await llm_generate(
            compact_model,
            system=(
                "You are a context compressor for a coding agent. The following "
                "are EARLIER tool results from this session. Produce ONE concise "
                "summary (under ~1500 chars) that preserves only what the agent "
                "still needs: exact file paths, line numbers, symbol/function "
                "names, and concrete findings. Drop duplicates and raw noise."
            ),
            user=old_text,
        )
    except Exception:  # noqa: BLE001 — degrade to a plain removal
        msgs.append(
            ToolMessage(
                content=f"[Earlier tool results compacted; {len(old_idx)} outputs removed.]",
                tool_call_id="__compact__",
            )
        )
        return True
    msgs.append(
        ToolMessage(
            content="[Compressed earlier tool results]\n" + (summary or ""),
            tool_call_id="__compact__",
        )
    )
    return True


def _apply_compaction_in_place(msgs: list, new_history: list[dict]) -> None:
    """Rebuild ``msgs`` in place from a compacted history dict list.

    Keeps the original leading ``SystemMessage`` (the assembled system prompt)
    and converts each compacted dict back to a LangChain message, mirroring
    ``llm._auto_compact_subagent``. Tool/assistant turns lose their structured
    ``tool_calls`` (they become plain text), which is exactly what a compacted
    summary tail should be — the model only needs the distilled context, not
    the original callable tool signatures.
    """
    rebuilt: list[BaseMessage] = []
    had_system = bool(msgs) and isinstance(msgs[0], SystemMessage)
    if had_system:
        rebuilt.append(msgs[0])
    for d in new_history:
        role = d.get("role")
        content = str(d.get("content") or "")
        if role == "system" and had_system:
            # The compacted head is itself a "[Compacted earlier context]"
            # system note; fold it into the existing system prompt slot rather
            # than appending a second system message.
            continue
        if role == "assistant":
            rebuilt.append(AIMessage(content=content))
        elif role == "tool":
            rebuilt.append(HumanMessage(content=f"[tool result]\n{content}"))
        else:
            rebuilt.append(HumanMessage(content=content))
    msgs[:] = rebuilt


async def _maybe_auto_compact(
    state: AgentState,
    queue: asyncio.Queue,
    model: Any,
    compact_model: Any,
    msgs: list,
    ctx: int,
    last_input_tokens: int | None = None,
) -> None:
    """opencode `isOverflow` -> auto-compaction.

    Once the assembled transcript reaches the usable window (``ctx - reserved``),
    summarize the older turns — keeping a recent tail verbatim — and emit the
    ``compact_start`` / ``compact`` / ``compact_failed`` events the frontend
    already folds on. The summarizer is the configured compact subagent, falling
    back to the main model (mirrors opencode's compaction agent + retry).
    """
    if ctx <= 0:
        return
    max_output = _agents._model_max_output(model)
    reserved = state.get("reserved")
    usable = _agents._usable_tokens(ctx, max_output, reserved)
    dicts = _agents._messages_to_dicts(msgs)
    # Auto-compaction fires off the SAME `input_tokens` the context meter
    # displays (tracked on `state["last_input_tokens"]` at the usage-emit site),
    # so the meter and the compaction trigger always agree. `input_tokens` is the
    # provider's (langgraph's) count of tokens actually sent in the prompt this
    # turn — the true context size (excludes output). Fall back to the stable
    # local estimate of the whole transcript when no usage has been reported yet
    # (e.g. the very first turn, or a provider that reports none).
    total = (
        last_input_tokens
        if last_input_tokens and last_input_tokens > 0
        else _estimate_prompt_tokens(msgs)
    )
    if total is None or total <= 0:
        # Fallback to the char estimate when the local estimate is unavailable
        # (e.g. un-tokenizable message content, or local models with no usage).
        total = sum(_agents._estimate_tokens(d["content"]) for d in dicts)
    # Diagnostic: surface the real window/threshold so we can confirm compaction
    # only fires when the prompt genuinely nears the window (and not spuriously).
    print(
        f"[CTX_DEBUG] auto_compact ctx={ctx} reserved={reserved} usable={usable} "
        f"total={total} msgs={len(msgs)}",
        flush=True,
    )
    # opencode fires compaction when the latest turn reaches `usable`
    # (ctx - reserved). We mirror that exactly: a single setting
    # (compactHeadroom / reserved) controls when auto-compaction runs.
    if total < usable:
        return
    # opencode prune: clear old tool outputs (not the whole turn) before the
    # heavier summarization pass, so a large-but-not-overflowing transcript
    # still sheds context. Runs in place on the serialized history.
    _agents._prune_history(dicts)
    summarizer = compact_model or model
    queue.put_nowait({"kind": "compact_start"})
    try:
        result = await _agents._compact_history(
            summarizer,
            dicts,
            ctx=ctx,
            max_output=max_output,
            reserved=reserved,
            fallback_model=model,
        )
    except Exception:  # noqa: BLE001
        result = None
    if result is None:
        queue.put_nowait({"kind": "compact_failed"})
        return
    new_history, keep, compact_usage = result
    summary = new_history[0]["content"] if new_history else ""
    queue.put_nowait({"kind": "compact", "content": summary, "keep": int(keep)})
    # Accrue the tokens the summarizer itself consumed so the session total
    # (the "Model usage" sidebar) is complete.
    if compact_usage:
        queue.put_nowait(compact_usage)
    # Apply the compaction IN PLACE on the live transcript so the very next step
    # (and the next turn) sends the compressed history instead of the full one.
    # Without this the function only emitted a `compact` event while the model
    # kept receiving the un-compacted `msgs` — so the context never actually
    # shrank and the turn still overflowed. Mirrors llm._auto_compact_subagent.
    _apply_compaction_in_place(msgs, new_history)
    # compaction واقعی انجام شد → نقشهٔ کامل ممکنه از context افتاده باشه.
    # کش هش رو پاک می‌کنیم تا turn بعدی نقشهٔ کامل بفرسته نه marker بی‌محتوا.
    _code_map_hash_cache = getattr(build_turn_context, "_code_map_hash_cache", None)
    if isinstance(_code_map_hash_cache, dict):
        _cid = state.get("chat_id", "")
        if _cid in _code_map_hash_cache:
            _code_map_hash_cache.pop(_cid, None)


async def _run_mode_turn(
    state: AgentState,
    mode: str,
    queue: asyncio.Queue,
    extra_instruction: str = "",
    run_flags: dict | None = None,
) -> str:
    """Run ONE LLM turn for ``mode`` with the mode-filtered tools.

    Streams text/tool events into ``queue``. Applies the *essential* resilience:
    live steer injection, interrupted-turn resume, free-tier throttle retry, and
    a bounded context auto-compact. Returns the final reply text.
    """
    chat_id = state.get("chat_id", "")
    ctx = state.get("context_window") or 0
    # The `mode` parameter is authoritative for THIS turn. `reader_answer` and
    # other nodes mutate `state["mode"]` on the shared LangGraph state, so we
    # copy it and override with the parameter before building the context —
    # otherwise a previous node's mode would leak into this turn's system prompt.
    state = dict(state)
    state["mode"] = mode
    tctx = await build_turn_context(state, queue)
    model = tctx["model"]
    # The real model id the LangChain client will hit (e.g. a sub-agent model
    # resolved for web/compact/vision), used to attribute usage correctly.
    model_id = getattr(model, "model_name", None) or state.get("model_name", "")
    lc_tools = tctx["lc_tools"]
    filtered = tctx["tools"]
    mcp_cleanup = tctx.get("mcp_cleanup")
    messages: list[BaseMessage] = list(tctx["messages"])
    # Compact model used for in-turn tool-history compaction (spec §10). May be
    # None when the user hasn't configured a compact/subagent model — in that
    # case obsolete tool results are dropped outright instead of summarized.
    compact_model = tctx.get("compact_model")

    if extra_instruction:
        messages.insert(1, SystemMessage(content=extra_instruction))

    # NOTE: on a (re)started/interrupted turn we intentionally do NOT inject a
    # "here is what you already did" resume note or persist a durable replay
    # file. The model continues from the real message transcript (tool results
    # are already in `messages`); feeding it synthetic learned context on error
    # is undesirable. Transient throttles are retried below without any such
    # injection.

    MAX_STEPS = max(12, min(int(ctx) // 4000 if ctx else 24, 40))

    async def _execute_tool(name: str, args: dict) -> str:
        import inspect

        fn = filtered.get(name)
        if fn is None:
            return f"ERROR: unknown tool {name!r}"
        try:
            res = fn(**(args or {}))
            if inspect.isawaitable(res):
                res = await res
            return res
        except Exception as exc:  # noqa: BLE001
            return f"ERROR running {name}: {exc}"

    def _existing_tool_result(tool_call_id: str) -> str | None:
        """اگر نتیجهٔ این tool_call قبلاً در transcript (msgs) هست، آن را
        برگردان تا دوباره اجرا نشود — مخصوصاً روی reconnect/interrupt که
        هیستوری شامل ToolMessageهای بازسازی‌شده از toolActivity است."""
        for m in messages:
            if isinstance(m, ToolMessage) and m.tool_call_id == tool_call_id:
                return m.content
        return None

    # --- Interrupted-turn resume (replay already-done work) -----------------
    # On a reconnect/interrupt the frontend only sends COMPLETED turns' history
    # (it has no toolActivity for the turn that was cut off), so the in-RAM tool
    # results from that turn are gone. Re-inject them from the durable resume
    # file as AIMessage(tool_calls)+ToolMessage pairs so the model SEES what it
    # already did and does NOT re-run the tools (which would lose context and
    # waste tokens). history_to_langchain_messages already handles the same
    # reconstruction for completed turns; this covers the interrupted one.
    _resume_chat = state.get("chat_id", "")
    _resume_root = state.get("root", "")
    if _resume_chat:
        with contextlib.suppress(Exception):
            _resume = state_db.load_turn_resume(_resume_root, _resume_chat)
        if _resume and isinstance(_resume.get("tools"), list) and _resume.get("tools"):
            for _ta in _resume["tools"]:
                if not isinstance(_ta, dict):
                    continue
                # Prefer an explicit callId; fall back to a stable id derived from
                # the tool+args so hand-written / older resume files (which only
                # carry `tool`/`args`/`result`) still replay instead of being skipped.
                _tc_id = str(_ta.get("callId") or "")
                if not _tc_id:
                    _tc_id = "r-" + hashlib.md5(
                        json.dumps(
                            {"tool": _ta.get("tool", ""), "args": _ta.get("args", {}) or {}},
                            sort_keys=True,
                        ).encode("utf-8")
                    ).hexdigest()[:12]
                if not _tc_id:
                    continue
                # Prefix the replayed call id with `resume-` so the frontend /
                # tests can distinguish a replayed (already-done) tool call from a
                # fresh one, and so the dedup guard never treats it as a new call.
                _replay_id = f"resume-{_tc_id}"
                # Skip if the transcript already carries this result (e.g. the
                # frontend DID send toolActivity for this turn after all).
                if _existing_tool_result(_replay_id) is not None:
                    continue
                messages.append(
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": _ta.get("tool", "tool"),
                                "args": _ta.get("args", {}) or {},
                                "id": _replay_id,
                            }
                        ],
                    )
                )
                _items = _ta.get("items")
                _result = (
                    str(_ta.get("result"))
                    if _ta.get("result")
                    else (str(_items) if _items else str(_ta.get("summary") or ""))
                )
                messages.append(
                    ToolMessage(content=_result, tool_call_id=_replay_id)
                )

    # Interrupted-turn partial reply: if the turn was cut off mid-generation
    # (hard app close / disconnect) and the partial assistant text was never
    # persisted to history, replay it as an assistant message so the model
    # CONTINUES from where it left off instead of restarting from zero. The
    # `partial` key is written by the durable resume file on a hard close where
    # no tool completed (so `tools` is empty) but text had already streamed.
    if _resume_chat:
        _partial = (_resume or {}).get("partial") if "_resume" in dir() else None
        if _partial and isinstance(_partial, str) and _partial.strip():
            # Don't duplicate a partial that the frontend already kept in
            # history (it folds an "[Interrupted before finishing...]" marker
            # into the failed assistant message). Only inject when the text is
            # genuinely absent from the transcript.
            _partial_already = any(
                isinstance(m, AIMessage)
                and isinstance(getattr(m, "content", ""), str)
                and _partial.strip()[:40] in (m.content or "")
                for m in messages
            )
            if not _partial_already:
                messages.append(AIMessage(content=_partial))
            messages.append(
                SystemMessage(
                    content=(
                        "[SYSTEM: Your previous reply was cut off mid-generation. "
                        "The text above is what you had already produced. Continue "
                        "it naturally from where it ends — do NOT repeat it.]"
                    )
                )
            )

    _astream_count = 0

    async def _inner() -> str:
        nonlocal model
        # NOTE: `msgs` aliases the OUTER `messages` list so completed tool work
        # (tool calls + their results) survives a retry. On a transient throttle
        # we re-run the loop from the SAME accumulated transcript -- the model
        # continues from what it actually did, with no synthetic replay/no
        # "learned" resume note injected.
        msgs = messages
        steps = 0
        reply = ""
        _no_so = False
        # --- Interrupted-turn resume (durable, step-by-step) -----------------
        # Every completed tool result is persisted to a per-chat resume file so a
        # mid-turn disconnect/reconnect can replay the already-done work instead
        # of re-running the tools from scratch (which loses context and wastes
        # tokens). The file is cleared on a clean finish (see run_graph._drive).
        _resume_root = state.get("root", "")
        _resume_chat = state.get("chat_id", "")
        _resume_prompt = state.get("request", "")

        def _record_resume_tool(name: str, args: dict, call_id: str, result: str) -> None:
            if not _resume_chat:
                return
            # Append ONLY the new record (save_turn_resume writes it as one JSONL
            # line). We no longer keep a growing in-memory list and rewrite the
            # whole file — that made an interrupt mid-write wipe the resume state.
            rec = {
                "tool": name,
                "args": args or {},
                "callId": call_id,
                "items": str(result),
                "result": str(result),
                "summary": "",
            }
            with contextlib.suppress(Exception):
                state_db.save_turn_resume(
                    _resume_root,
                    _resume_chat,
                    {"prompt": _resume_prompt, "tools": [rec]},
                )
        # --- Repetition-loop guard (opencode-aligned) -----------------------
        # opencode stops a degenerate loop via MAX_STEPS + finish_reason=="length"
        # and has no text-comparison guard. We keep a guard but base it on the
        # TOOL-CALL SIGNATURE (name + args), not emitted text: a real loop repeats
        # the SAME tool call with IDENTICAL arguments, whereas genuine multi-step
        # work varies the args (e.g. reading different files). The old text
        # comparison false-positived on models that emit similar phrasing while
        # doing real work.
        _last_tool_sig = ""
        _repeat_count = 0
        _MAX_REPEAT = 3
        while steps < MAX_STEPS:
            steps += 1
            # Hard guardrail (opencode's isLastStep -> MAX_STEPS_PROMPT): on the
            # final allowed step, force the model to stop tool-calling and
            # summarize instead of burning more reads/searches. Without this the
            # loop just breaks at MAX_STEPS and returns an empty reply, so the
            # model never learns it should stop and tends to spam reads first.
            if steps >= MAX_STEPS:
                msgs.append(AIMessage(content=_agents._MAX_STEPS_PROMPT))
            # Live steer injection: user messages typed mid-run.
            steers = await _agents._drain_steer(chat_id)
            if steers:
                msgs.append(
                    HumanMessage(
                        content=(
                            "[NEW USER MESSAGE DURING THIS TASK -- INTERRUPTION]\n"
                            + "\n".join(f"- {s.get('prompt')}" for s in steers)
                            + "\nAddress it before the next step."
                        )
                    )
                )
                queue.put_nowait(
                    {"kind": "steer_applied", "ids": [s.get("id", "") for s in steers]}
                )
            try:
                bound = model.bind_tools(lc_tools)
                ai: Any = None
                _astream_count_local = 0
                _thinking_active = False
                _answer_started = False
                _saw_real_reasoning = False
                _model_reasoning = bool(state.get("model_reasoning"))
                # Literal <think>…</think> tags some models emit inline (DeepSeek/
                # Qwen/llama.cpp). State is preserved across chunks because the tag
                # may span multiple streamed deltas.
                _in_think = False
                _think_buf = ""
                # Degenerate text-loop guard: accumulate the visible reply in a
                # buffer and, every few chunks, check whether the model has
                # started repeating itself verbatim (e.g. "Let me check. Let me
                # check." 80 times). The existing guards only watch tool-call
                # signatures, so a no-tool-call text loop slips through. We break
                # the stream early and surface a warning instead of emitting the
                # full duplicated output.
                _reply_buf = ""
                _repeat_check_every = 4
                _chunk_idx = 0
                # Emit the lightweight "thinking" toggle ONLY when the model
                # actually produces reasoning content (a dedicated reasoning
                # field caught by _thinking_from_chunk) — NOT merely because it
                # is flagged reasoning-capable. A reasoning model that goes
                # straight to text (or an auto-think gateway sending no thinking
                # chunks) shows no indicator. The window closes on the first
                # answer text (below) and as a safety net at stream end.
                async for chunk in bound.astream(msgs):
                    _astream_count_local += 1
                    # LangChain accumulates streamed deltas via AIMessageChunk.__add__
                    # (the standard, documented mechanism). We rely on it rather than
                    # hand-rolling delta/cumulative detection, which was fragile.
                    ai = chunk if ai is None else ai + chunk
                    # Drop raw chain-of-thought. The backend only emits a
                    # lightweight "thinking" toggle, never the reasoning text.
                    # _thinking_from_chunk catches reasoning surfaced in a
                    # dedicated field (reasoning_content / thinking part /
                    # additional_kwargs) — the OpenAI-compatible subclass in
                    # llm.py normalizes delta.reasoning into that field.
                    if _model_reasoning and _thinking_from_chunk(chunk):
                        _saw_real_reasoning = True
                        if not _thinking_active:
                            _thinking_active = True
                            queue.put_nowait({"kind": "thinking", "active": True})
                        continue
                    content = chunk.content
                    if isinstance(content, str) and content:
                        # Some gateways emit CoT as a literal <think>…</think>
                        # block inside content (LangChain does NOT normalize this
                        # for arbitrary OpenAI-compatible servers), so strip it.
                        content, _in_think, _think_buf = _strip_think_tags(
                            content, _in_think, _think_buf
                        )
                        if not content:
                            continue
                        # First answer token closes the thinking window.
                        if _thinking_active:
                            _thinking_active = False
                            queue.put_nowait({"kind": "thinking", "active": False})
                        # Scan for a degenerate text loop (the model repeating
                        # itself with no tool call). The tool-call guard below
                        # only watches signatures, so this catches the no-tool
                        # case; we abort mid-stream instead of dumping it all.
                        _reply_buf += content
                        _chunk_idx += 1
                        if _chunk_idx % _repeat_check_every == 0 and _is_repeating(
                            _reply_buf
                        ):
                            queue.put_nowait(
                                {
                                    "kind": "warn",
                                    "content": (
                                        "The model entered a text repetition loop; "
                                        "showing partial output."
                                    ),
                                }
                            )
                            break
                        # Gateways that null reasoning_content and stream CoT as
                        # plain content before the real answer: while reasoning is
                        # enabled and we haven't seen a genuine reasoning field,
                        # treat this pre-answer content as thinking and drop it.
                        if _model_reasoning and not _saw_real_reasoning:
                            continue
                        queue.put_nowait({"kind": "text", "content": content})
                    elif isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                if _thinking_active:
                                    _thinking_active = False
                                    queue.put_nowait(
                                        {"kind": "thinking", "active": False}
                                    )
                                queue.put_nowait(
                                    {"kind": "text", "content": part["text"]}
                                )
                if ai is None:
                    break
                # Safety net for models that only reason and emit no text: make
                # sure the thinking window is always closed at stream end.
                if _thinking_active:
                    _thinking_active = False
                    queue.put_nowait({"kind": "thinking", "active": False})
                # If reasoning was enabled but we never saw a real reasoning field,
                # the pre-answer plain-content we dropped above was actually the
                # answer (opencode sent no reasoning at all). Re-emit it so the
                # user never gets an empty reply.
                if _model_reasoning and not _saw_real_reasoning:
                    dropped = ai.content if isinstance(ai.content, str) else ""
                    if dropped and _is_repeating(dropped):
                        queue.put_nowait(
                            {
                                "kind": "warn",
                                "content": (
                                    "The model entered a text repetition loop; "
                                    "showing partial output."
                                ),
                            }
                        )
                        # Truncate to the non-repeating prefix so the user never
                        # sees the full 80x loop dumped at stream end.
                        _unit = min(200, len(dropped) // 3)
                        while _unit >= 20 and _is_repeating(dropped[: _unit * 3]):
                            _unit = max(20, _unit // 2)
                        dropped = (
                            dropped[: _unit * 3] + " … [repetition loop truncated]"
                        )
                    if dropped:
                        queue.put_nowait({"kind": "text", "content": dropped})
                _astream_count_local_val = _astream_count_local
                # Surface token usage so the frontend can show per-model cost in
                # the sidebar and a real consumed-context meter in the title bar.
                usage_ev = _usage_event_from_ai(
                    ai, model_id, prompt_tokens=_estimate_prompt_tokens(messages)
                )
                if usage_ev:
                    state["last_input_tokens"] = usage_ev["input_tokens"]
                    queue.put_nowait(usage_ev)
            except Exception as exc:  # surfaced to the retry wrapper
                # A few local OpenAI-compatible servers (old llama.cpp / custom
                # builds) reject `stream_options` even though most accept or
                # ignore it. Retry the current step once with a model built
                # without that param so local-model usage still works.
                if not _no_so and _is_stream_options_error(exc):
                    _no_so = True
                    model = _strip_stream_options(model)
                    continue
                raise
            if not getattr(ai, "tool_calls", None):
                meta = getattr(ai, "response_metadata", {}) or {}
                if meta.get("finish_reason") == "length":
                    # opencode treats length-truncation as a normal (partial) stop,
                    # not an error. Return the partial reply so the user still gets
                    # output instead of a fatal "context length exceeded" error.
                    queue.put_nowait(
                        {
                            "kind": "warn",
                            "content": (
                                "Response truncated by the model (max output tokens "
                                "reached). Showing partial output."
                            ),
                        }
                    )
                    # The turn did not complete cleanly (output was cut off), so
                    # leave the durable resume file behind for a reconnect/retry.
                    if run_flags is not None:
                        with contextlib.suppress(Exception):
                            run_flags["error"] = True
                    reply = (
                        ai.content if isinstance(ai.content, str) else str(ai.content)
                    )
                    break
                reply = ai.content if isinstance(ai.content, str) else str(ai.content)
                if _is_repeating(reply if isinstance(reply, str) else ""):
                    queue.put_nowait(
                        {
                            "kind": "warn",
                            "content": (
                                "The model entered a text repetition loop; "
                                "showing partial output."
                            ),
                        }
                    )
                break
            # --- Repetition-loop detection (tool-call signature) -------------
            # A real loop repeats the SAME tool call with IDENTICAL arguments on
            # every step. Genuine multi-step work varies the args (e.g. reading
            # different files), so it never trips this guard. The old text
            # comparison false-positived on models that emit similar phrasing
            # while doing real work.
            _tool_sig = json.dumps(
                [(tc.get("name"), tc.get("args")) for tc in (ai.tool_calls or [])],
                sort_keys=True,
                ensure_ascii=False,
            )
            if _tool_sig and _tool_sig == _last_tool_sig:
                _repeat_count += 1
            else:
                _repeat_count = 0
            _last_tool_sig = _tool_sig
            if _repeat_count >= _MAX_REPEAT:
                queue.put_nowait(
                    {
                        "kind": "error",
                        "content": (
                            "The model entered a repetition loop (it kept calling the "
                            "same tool with identical arguments on every step). "
                            "Stopping to avoid an endless, duplicated response. Try "
                            "rephrasing your request or breaking it into smaller steps."
                        ),
                    }
                )
                # Mark the turn as failed so run_graph._drive leaves the durable
                # resume file behind (a reconnect/retry can replay the already-done
                # tool work instead of re-running it from zero).
                if run_flags is not None:
                    with contextlib.suppress(Exception):
                        run_flags["error"] = True
                break
            msgs.append(ai)
            # Partition this step's tool calls: read-only ones (grep/glob/read/
            # web/vision/task/...) run CONCURRENTLY via gather -- they cannot
            # race each other since none of them mutate anything. Mutating /
            # blocking calls (_SEQUENTIAL_TOOLS) still run one at a time, in
            # order, AFTER the concurrent batch, so a write can never race
            # another write and ask_user never overlaps another call. Order in
            # `msgs` doesn't need to match request order -- each ToolMessage
            # carries its own tool_call_id, so the model matches results by id
            # regardless of position.
            _tcs = ai.tool_calls
            # روی reconnect/interrupt، هیستوری ممکن است شامل ToolMessageهای
            # بازسازی‌شده از toolActivity باشد. اگر نتیجهٔ یک tool_call قبلاً
            # در transcript هست، آن را دوباره اجرا نکن — مستقیماً reuse کن
            # (صرفه‌جویی در context و جلوگیری از اجرای تکراریِ کارهای انجام‌شده).
            _pending = [
                tc for tc in _tcs if _existing_tool_result(tc.get("id", "")) is None
            ]
            _parallel = [
                tc for tc in _pending if (tc.get("name") or "") not in _SEQUENTIAL_TOOLS
            ]
            _sequential = [
                tc for tc in _pending if (tc.get("name") or "") in _SEQUENTIAL_TOOLS
            ]
            if len(_parallel) > 1:
                _results = await asyncio.gather(
                    *[
                        _execute_tool(tc.get("name") or "", tc.get("args") or {})
                        for tc in _parallel
                    ]
                )
            else:
                _results = [
                    await _execute_tool(tc.get("name") or "", tc.get("args") or {})
                    for tc in _parallel
                ]
            for tc, result in zip(_parallel, _results):
                msgs.append(
                    ToolMessage(content=str(result), tool_call_id=tc.get("id", ""))
                )
                _record_resume_tool(
                    tc.get("name") or "", tc.get("args") or {}, tc.get("id", ""), result
                )
            for tc in _sequential:
                name = tc.get("name") or ""
                args = tc.get("args") or {}
                # The tool callback emits its own `tool` / `tool_result` events
                # (via the emit callback wired into make_tool_callbacks), so we
                # only execute it and feed the result back to the model.
                result = await _execute_tool(name, args)
                msgs.append(
                    ToolMessage(content=str(result), tool_call_id=tc.get("id", ""))
                )
                _record_resume_tool(name, args, tc.get("id", ""), result)
            # In-turn context management: if the transcript (including every
            # tool result so far this turn) has grown past the budget, compress
            # the older tool results so we don't keep re-sending the whole raw
            # history to the provider on every subsequent step (spec §10).
            await _compact_tool_history(
                msgs, compact_model, max(30_000, int(ctx or 0) * 3)
            )
            # Bounded context auto-compact: once the assembled prompt reaches the
            # usable window (ctx - reserved), summarize the older turns in place
            # so a long-running turn never overflows the model's context. Driven
            # by the SAME input_tokens the context meter displays
            # (state["last_input_tokens"], set at the usage-emit site above), so
            # the meter and the trigger always agree. No-op below the threshold.
            if ctx > 0:
                await _maybe_auto_compact(
                    state,
                    queue,
                    model,
                    compact_model,
                    msgs,
                    ctx,
                    last_input_tokens=state.get("last_input_tokens"),
                )
        return reply

    # Unified retry: ANY transient provider failure (429 throttle, 5xx, timeout,
    # network blip) is retried up to the budget, 30s apart, so the turn keeps
    # trying to continue instead of giving up on the first blip. Hard failures
    # (bad request / quota exhausted / auth) surface as a fatal error event
    # without burning the retry budget.
    reply = ""
    attempt = 0
    try:
        while True:
            attempt += 1
            try:
                reply = await _inner()
                break
            except Exception as exc:  # noqa: BLE001
                # A client abort (CancelledError) means the user closed the stream —
                # do NOT retry or emit an error event (it would never be read anyway,
                # since the SSE socket is already torn down). Just stop cleanly.
                if isinstance(exc, asyncio.CancelledError):
                    break
                # Hard, non-recoverable failures: don't retry (would fail identically).
                if _agents._is_quota_exhausted(exc) or not _agents._is_retryable(exc):
                    queue.put_nowait(
                        {
                            "kind": "error",
                            "content": _agents._friendly_retry_reason(exc),
                        }
                    )
                    # Mark the turn as failed so run_graph._drive leaves the
                    # durable resume file behind (a reconnect/retry can replay the
                    # already-done tool work instead of re-running it from zero).
                    # `run_flags` is the SAME mutable dict seeded on `initial`
                    # (passed through from the node), so this reaches _drive.
                    if run_flags is not None:
                        try:
                            run_flags["hard_error"] = True
                        except Exception:  # noqa: BLE001, S110
                            pass
                    break
                # Transient failure: retry up to the budget, 30s apart.
                if attempt >= _agents._RETRY_MAX_ATTEMPTS:
                    queue.put_nowait(
                        {
                            "kind": "retry_giveup",
                            "attempt": attempt,
                            "max_attempts": _agents._RETRY_MAX_ATTEMPTS,
                            "reason": _agents._friendly_retry_reason(exc),
                        }
                    )
                    # Mark the turn as failed so run_graph._drive leaves the
                    # durable resume file behind (a reconnect/retry can replay the
                    # already-done tool work instead of re-running it from zero).
                    if run_flags is not None:
                        with contextlib.suppress(Exception):
                            run_flags["error"] = True
                    break
                delay = _agents._RETRY_BASE_SECONDS
                if not isinstance(delay, (int, float)) or delay < 0:
                    delay = 30
                queue.put_nowait(
                    {
                        "kind": "retry",
                        "attempt": attempt,
                        "max_attempts": _agents._RETRY_MAX_ATTEMPTS,
                        "delay": delay,
                        "reason": _agents._friendly_retry_reason(exc),
                    }
                )
                await asyncio.sleep(delay)
                continue
    finally:
        # Close every opened MCP session so stdio subprocesses / HTTP
        # connections don't leak across turns.
        if mcp_cleanup is not None:
            with contextlib.suppress(Exception):
                await mcp_cleanup()
    # opencode-style proactive auto-compaction: once the conversation reaches the
    # usable window, summarize the older turns and tell the frontend to fold.
    if reply and ctx and ctx > 0:
        with contextlib.suppress(Exception):
            await _maybe_auto_compact(
                state,
                queue,
                model,
                compact_model,
                messages,
                ctx,
                last_input_tokens=state.get("last_input_tokens"),
            )
    return reply


# ---------------------------------------------------------------------------
# Test command detection + Test / Debug / Review nodes
# ---------------------------------------------------------------------------


def detect_test_commands(root: str) -> list[str]:
    """Return every test/build/type-check command for languages present in root.

    Multi-language aware: a workspace may contain a Python backend, a JS/TS
    frontend, a Rust crate, etc. Each detected language contributes its own
    command so the test gate covers the whole project, not just one stack.
    """
    import os

    cmds: list[str] = []

    # --- Python (uv is preferred per AGENTS.md) ---
    if os.path.isfile(os.path.join(root, "uv.lock")) or os.path.isfile(
        os.path.join(root, "pyproject.toml")
    ):
        cmds.append("uv run pytest")
    elif os.path.isfile(os.path.join(root, "pytest.ini")) or os.path.isfile(
        os.path.join(root, "setup.py")
    ):
        cmds.append("python -m pytest")

    # --- Node / JS / TS (framework-aware) ---
    pkg = os.path.join(root, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, encoding="utf-8") as _f:
                data = json.loads(_f.read())
        except Exception:  # noqa: BLE001
            data = {}
        if isinstance(data, dict):
            scripts = data.get("scripts") or {}
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            has = lambda n: n in deps
            # Avoid double-running a Python suite that a node script merely delegates to.
            python_cmd_added = any(
                c.startswith(("uv run pytest", "python -m pytest")) for c in cmds
            )
            for key in scripts:
                if not re.match(r"^test(\b|:)", key):
                    continue
                val = str(scripts[key])
                if python_cmd_added and ("pytest" in val or "python -m unittest" in val):
                    continue
                cmds.append(f"npm run {key}")
            test_script = str(scripts.get("test", ""))
            if test_script:
                # The `test` script is already covered by the loop above; only
                # infer a runner-specific command when there is no `test` script.
                pass
            elif has("vitest"):
                cmds.append("npx vitest run")
            elif has("jest") or has("react-scripts"):
                cmds.append("npx jest")
            elif has("@playwright/test"):
                cmds.append("npx playwright test")
            elif has("cypress"):
                cmds.append("npx cypress run")

    # --- Rust ---
    if os.path.isfile(os.path.join(root, "Cargo.toml")):
        cmds.append("cargo test")

    # --- Go ---
    if os.path.isfile(os.path.join(root, "go.mod")):
        cmds.append("go test ./...")

    # --- Java (Maven / Gradle) ---
    if os.path.isfile(os.path.join(root, "pom.xml")):
        cmds.append("mvn -q test")
    if os.path.isfile(os.path.join(root, "build.gradle")) or os.path.isfile(
        os.path.join(root, "build.gradle.kts")
    ):
        cmds.append("./gradlew test")

    # --- .NET ---
    try:
        if any(f.endswith((".csproj", ".sln")) for f in os.listdir(root)):
            cmds.append("dotnet test")
    except OSError:
        pass

    # --- Ruby ---
    if os.path.isfile(os.path.join(root, "Gemfile")):
        cmds.append("bundle exec rspec")
    if os.path.isfile(os.path.join(root, "Rakefile")):
        cmds.append("rake test")

    # --- PHP ---
    if os.path.isfile(os.path.join(root, "composer.json")):
        cmds.append("vendor/bin/phpunit")

    # --- Elixir ---
    if os.path.isfile(os.path.join(root, "mix.exs")):
        cmds.append("mix test")

    # --- Dart / Flutter ---
    if os.path.isfile(os.path.join(root, "pubspec.yaml")):
        try:
            with open(os.path.join(root, "pubspec.yaml"), encoding="utf-8") as _f:
                _pub = _f.read()
            if "flutter:" in _pub or "sdk: flutter" in _pub:
                cmds.append("flutter test")
            else:
                cmds.append("dart test")
        except OSError:
            cmds.append("dart test")

    # --- C / C++ ---
    if os.path.isfile(os.path.join(root, "CMakeLists.txt")):
        cmds.append("ctest --output-on-failure")
    elif os.path.isfile(os.path.join(root, "Makefile")):
        cmds.append("make test")
    # C/C++ files without CMake/Make have no standard test runner; leave cmds
    # empty so the Coder is told there are no project tests to run.

    return cmds


def detect_frontend_stack(root: str) -> str:
    """Best-effort label like 'React + Vite (vitest)' or '' if no frontend.

    Reads package.json deps to identify the framework (React/Vue/Svelte/
    Next/Angular) and the test runner (vitest/jest/playwright/cypress) so the
    agent can be told exactly which testing library and command to use.
    """
    import json
    import os

    pkg = os.path.join(root, "package.json")
    if not os.path.isfile(pkg):
        return ""
    try:
        with open(pkg, encoding="utf-8") as _f:
            data = json.loads(_f.read())
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(data, dict):
        return ""
    deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
    has = lambda n: n in deps
    runner = (
        "vitest"
        if has("vitest")
        else "jest"
        if has("jest") or has("react-scripts")
        else "playwright"
        if has("@playwright/test")
        else "cypress"
        if has("cypress")
        else ""
    )
    if has("next"):
        fw = "Next.js"
    elif has("vue"):
        fw = "Vue"
    elif has("svelte") or has("@sveltejs/kit"):
        fw = "Svelte"
    elif has("@angular/core"):
        fw = "Angular"
    elif has("react"):
        fw = "React"
    else:
        return ""
    return f"{fw} ({runner})" if runner else f"{fw}"


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------


def router(state: AgentState) -> dict:
    """Determine the requested mode (ASK / PLAN / CODER / READER).

    The UI/toolbar mode is authoritative. We only honor an explicit slash
    command (/plan, /code, /ask, /reader) in the prompt — never infer the
    mode from keywords like "write/fix/edit" (that would override the user's
    explicit Plan selection and make the agent think it's in Coder).
    """
    prompt = state.get("request", "") or ""
    text = prompt.strip().lower()
    if text.startswith("/plan") and (len(text) == 5 or text[5] in " \n\t"):
        return {"mode": "plan"}
    if text.startswith("/code") and (len(text) == 5 or text[5] in " \n\t"):
        return {"mode": "coder"}
    if text.startswith("/ask") and (len(text) == 4 or text[4] in " \n\t"):
        return {"mode": "ask"}
    if text.startswith("/reader") and (len(text) == 7 or text[7] in " \n\t"):
        return {"mode": "reader"}
    # UI mode wins — no keyword inference (fixes mode confusion bug).
    return {"mode": _agents.normalize_mode(state.get("mode", "ask"))}


async def ask_node(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "ask", queue, run_flags=state.get("_run_flags"))
    return {"final_response": reply}


async def coder_entry(state: AgentState) -> dict:
    # If a plan already exists (in state or persisted), Coder implements from it
    # and skips the repo-discovery pipeline. Otherwise Coder runs discovery just
    # like plan, then implements from the gathered context. The coder->test->
    # debug->coder loop never re-enters this node, so discovery runs at most once.
    return {}


def _route_coder_entry(state: AgentState) -> str:
    # Coder now performs its own repo exploration via grep/glob/read tools
    # directly (OpenCode-style), so it never needs the removed discovery
    # pipeline. It simply implements (from a plan when one exists).
    return "coder"


async def coder_node(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "coder", queue, run_flags=state.get("_run_flags"))
    return {"coder_result": reply, "final_response": reply}


def review_node(state: AgentState) -> dict:
    """Verify the implementation against the request / plan.

    Read-only. Produces a structured review result. The Coder is responsible for
    running the project's tests itself (via run_terminal) before finishing, so
    the graph does not run a separate test gate — the review just checks that an
    implementation was produced.
    """
    queue = state["_queue"]
    plan = state.get("plan", "")
    coder = state.get("coder_result", "")
    notes = []
    if not coder:
        notes.append("no implementation produced")
    if plan and "## Plan" not in plan and not coder:
        notes.append("no plan/implementation to review")
    result = "APPROVED" if not notes else "NEEDS WORK: " + "; ".join(notes)
    queue.put_nowait({"kind": "review", "result": result})
    return {"review_result": result}


def done_node(state: AgentState) -> dict:
    """Finalize the run."""
    queue = state["_queue"]
    final = state.get("final_response", "")
    if state.get("review_result"):
        final = final + "\n\n[Review] " + state["review_result"]
    queue.put_nowait({"kind": "done"})
    return {"final_response": final}


# ---------------------------------------------------------------------------
# Graph assembly + driver
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Deterministic repository-exploration workflow (REPO SEARCH subgraph)
# ---------------------------------------------------------------------------
#
# This is the "exploration OUT of the agent" piece: instead of letting the LLM
# call glob/grep/read ad-hoc, the request is turned into search patterns by a
# pure heuristic (no extra LLM call), and those run as deterministic nodes that
# fan out (glob || grep || tree) -> collect -> read. The gathered context is
# then handed to the mode's LLM, which may still use WEB / FETCH / VISION /
# SKILL / MCP capabilities on demand but never glob/grep/read again.

_EXTS = {
    "py",
    "js",
    "ts",
    "tsx",
    "jsx",
    "go",
    "rs",
    "java",
    "c",
    "cpp",
    "cc",
    "h",
    "hpp",
    "rb",
    "php",
    "cs",
    "swift",
    "kt",
    "kts",
    "md",
    "mdx",
    "json",
    "yaml",
    "yml",
    "toml",
    "sh",
    "bash",
    "zsh",
    "sql",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "lua",
    "r",
    "m",
    "pl",
    "pm",
    "dart",
    "ex",
    "exs",
    "erl",
    "clj",
    "scm",
    "hs",
    "ml",
    "fs",
    "fsx",
    "nim",
    "zig",
    "groovy",
    "gradle",
    "xml",
    "ini",
    "cfg",
    "conf",
    "env",
}

# Files that are useless to read for comprehension: lockfiles, minified /
# bundled output, source maps, binaries, archives, build artifacts. They can
# still match glob/grep, so we skip them at read time -- unless the user named
# the file explicitly (then it stays in `named` and is always read).
_SKIP_READ_NAMES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "gemfile.lock",
    "composer.lock",
    "cargo.lock",
    "go.sum",
    "pip.lock",
    ".ds_store",
    "thumbs.db",
}
_SKIP_READ_EXTS = {
    "lock",
    "min.js",
    "min.css",
    "map",
    "min",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "ico",
    "webp",
    "svg",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "otf",
    "pdf",
    "zip",
    "gz",
    "tar",
    "tgz",
    "rar",
    "7z",
    "bin",
    "exe",
    "dll",
    "so",
    "dylib",
    "wasm",
    "mp4",
    "mp3",
    "wav",
    "avi",
    "mov",
    "log",
    "cache",
    "pyc",
    "class",
    "o",
    "obj",
    "jar",
    "war",
}


def _should_skip_read(rel: str) -> bool:
    import os

    name = os.path.basename(rel).lower()
    if name in _SKIP_READ_NAMES:
        return True
    if ".min." in name:
        return True
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    return ext in _SKIP_READ_EXTS


_STOPWORDS = {
    "what",
    "where",
    "which",
    "when",
    "how",
    "does",
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "you",
    "are",
    "is",
    "it",
    "of",
    "to",
    "a",
    "an",
    "do",
    "i",
    "we",
    "they",
    "file",
    "files",
    "code",
    "function",
    "class",
    "mode",
    "plan",
    "ask",
    "use",
    "using",
    "need",
    "want",
    "find",
    "search",
    "show",
    "list",
    "explain",
    "describe",
    "trace",
    "understand",
    "investigate",
    "look",
    "looking",
    "who",
    "why",
    "can",
    "could",
    "should",
    "would",
    "may",
    "might",
    "repo",
    "repository",
    "project",
    "inside",
    "their",
    "our",
    "its",
    "as",
    "at",
    "by",
    "be",
    "been",
    "has",
    "have",
    "had",
    "will",
    "not",
    "no",
    "yes",
}


def _strip_skill_mentions(prompt: str, skills: list[str] | None) -> str:
    """Drop attached-skill names from a prompt so the skill's own words don't
    leak into the glob/grep search-pattern derivation.

    A skill can surface in many forms — an ``@slug`` mention, the raw slug
    (``anthropic-frontend-design``), the human-readable TITLE with spaces
    (``Anthropic Frontend Design``), or a reordered / comma-joined variant the
    model echoes back (``Anthropic, Design, Frontend``). We scrub every
    permutation of the name's words across space / comma / hyphen / underscore
    separators as a whole phrase, so the explorer never extracts the title's
    words (Anthropic/Frontend/Design) as grep keywords. The skill BODY still
    drives the agent via the system prompt; only the skill's *name* leaves the
    keywords."""
    prompt = prompt or ""
    names = [s.strip() for s in (skills or []) if s and s.strip()]
    if not names:
        return prompt
    lowered = {n.lower() for n in names}

    # Every textual variant of an attached skill name we should scrub.
    phrases: set[str] = set()
    for n in names:
        phrases.add(n)
        words = [w for w in re.split(r"[\s_\-]+", n) if w]
        if not words:
            continue
        spaced = " ".join(words)
        phrases.add(spaced)
        phrases.add(" ".join(w[:1].upper() + w[1:] for w in words))
        # Every permutation of the name's words, joined by each separator —
        # catches reordered / comma-joined echoes (Anthropic, Design, Frontend)
        # exactly instead of only the canonical ordering.
        if len(words) > 1:
            for perm in itertools.permutations(words):
                for sep in (" ", ", ", "-", "_"):
                    phrases.add(sep.join(perm))

    def _at(m: re.Match) -> str:
        tok = m.group(1).lower()
        if tok in lowered:
            return " "
        return m.group(0)

    prompt = re.sub(r"@([A-Za-z0-9_\-]+)", _at, prompt)
    for v in phrases:
        if not v:
            continue
        prompt = re.sub(rf"(?i)\b{re.escape(v)}\b", " ", prompt)
    return prompt


def _skill_name_appears_in_text(name: str, text: str) -> bool:
    """True if any textual form of ``name`` (spaced / hyphen / underscore /
    comma-permuted) appears in ``text``.

    Used to scrub ONLY skills the user actually referenced, so an unrelated
    skill whose name happens to coincide with a legitimate request word is
    never deleted from the derive keywords."""
    text = (text or "").lower()
    words = [w for w in re.split(r"[\s_\-]+", (name or "").lower()) if w]
    if not words:
        return False
    forms = {name.lower(), " ".join(words)}
    if len(words) > 1:
        for perm in itertools.permutations(words):
            forms.add(", ".join(perm))
    return any(f and f in text for f in forms)


def _skill_names_to_strip(state: AgentState) -> list[str]:
    """Skill names to keep out of search keywords.

    The attached skills (``state["skills"]``) are always scrubbed, plus any
    skill the user referenced by name / @mention directly in the request. A
    skill referenced only through an @mention may not appear in
    ``state["skills"]`` (the frontend can send ``skills: []``), but its name is
    still echoed in the message text — so we scrub it too.

    We deliberately do NOT blanket-scrub every skill in the workspace: that
    would wrongly delete legitimate request words that merely coincide with an
    unrelated skill's name. The derive should keep only the words that help
    locate files precisely and correctly."""
    names = [s for s in (state.get("skills") or []) if s]
    request = state.get("request") or ""
    with contextlib.suppress(Exception):
        for s in _agents._load_skills(state.get("root", "")):
            n = (s.get("name") or "").strip()
            if not n or n in names:
                continue
            if _skill_name_appears_in_text(n, request):
                names.append(n)
    return names


def _derive_explore_patterns(prompt: str) -> dict:
    """Turn a request into deterministic search patterns (no LLM)."""
    prompt = (prompt or "").strip()
    glob_p: set[str] = set()
    grep_p: set[str] = set()
    tree_root = ""

    # 1. Quoted literals -> path/glob when they look like one, else keyword.
    for q in re.findall(r"['\"`]([^'\"`\n]{1,200})['\"`]", prompt):
        q = q.strip()
        if not q:
            continue
        if (
            "/" in q
            or "\\" in q
            or "*" in q
            or q.lower().endswith(tuple("." + e for e in _EXTS))
        ):
            glob_p.add(q)
        else:
            grep_p.add(re.escape(q))

    # 2. File extensions -> **/*.<ext>  (e.g. "app.py", "src/a.ts")
    for ext in re.findall(r"\.([A-Za-z][A-Za-z0-9+#\-]{1,9})\b", prompt):
        ext = ext.lower()
        if ext in _EXTS:
            glob_p.add(f"**/*.{ext}")

    # 3. Path-like tokens (a/b/c, a/b/c.py, bare file.py, and **/ globs).
    for tok in re.findall(
        r"\b(?:[\w\-]+\/)+[\w\-.]+(?:\.\w+)?\b|"
        r"\b[\w\-]+\.[A-Za-z][A-Za-z0-9+#\-]{1,9}\b|"
        r"\*\*?/[\w\-./*?]+",
        prompt,
    ):
        glob_p.add(tok)

    # 4. Identifiers: CamelCase, snake_case, UPPER_CASE -> grep.
    for ident in re.findall(
        r"\b([A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|"
        r"[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+|[A-Z][A-Z0-9_]{2,})\b",
        prompt,
    ):
        if len(ident) >= 3:
            grep_p.add(re.escape(ident))

    # 5. Keyword fallback (skip stopwords; cap to keep grep cheap).
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", prompt):
        if w.lower() not in _STOPWORDS and len(w) >= 4:
            grep_p.add(re.escape(w))
            if len(grep_p) >= 16:
                break

    # 6. Semantic glob patterns from salient terms, so the deterministic
    #    fallback still returns useful globs when the request has no explicit
    #    path/extension (avoids near-empty globs that force the planner to
    #    shell out to the terminal). Grounded in the request's own nouns.
    salient: list[str] = []
    for ident in re.findall(
        r"\b([A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|"
        r"[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+)\b",
        prompt,
    ):
        if len(ident) >= 3 and ident.lower() not in _STOPWORDS:
            salient.append(ident)
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", prompt):
        if w.lower() not in _STOPWORDS and len(w) >= 4:
            salient.append(w)
    seen_s: set[str] = set()
    for term in salient:
        tl = term.lower()
        if tl in seen_s:
            continue
        seen_s.add(tl)
        glob_p.add(f"**/*{term}*")
        if len(glob_p) >= 20:
            break

    # 7. tree root from a mentioned top-level dir (a/b/...).
    m = re.search(r"\b([a-z][a-z0-9_\-]+)\/[\w\-]", prompt)
    if m:
        tree_root = m.group(1)

    return {
        "glob": sorted(glob_p)[:20],
        "grep": sorted(grep_p)[:24],
        "queries": sorted(grep_p)[:24],
        "tree_root": tree_root,
        "question": prompt,
    }


def _as_list(x) -> list[str]:
    """Coerce a JSON value into a deduplicated list of non-empty strings."""
    if not x:
        return []
    if isinstance(x, str):
        return [x] if x.strip() else []
    out: list[str] = []
    seen: set[str] = set()
    for v in x:
        s = str(v).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _extract_json_object(text: str) -> dict | None:
    """Best-effort extraction of the first JSON object from an LLM reply.

    Tolerates ```json fences and surrounding prose. Returns None if no valid
    object can be parsed.
    """
    if not text:
        return None
    t = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.DOTALL)
    if fenced:
        t = fenced.group(1)
    else:
        start = t.find("{")
        end = t.rfind("}")
        if start == -1 or end <= start:
            return None
        t = t[start : end + 1]
    try:
        obj = json.loads(t)
    except Exception:  # noqa: BLE001
        return None
    return obj if isinstance(obj, dict) else None


def _make_explore_tools(state: AgentState, queue: asyncio.Queue) -> dict:
    """Build the glob/grep/read tool callbacks (no network, no extra LLM)."""
    root = state["root"]
    image_uris = _agents._load_images(state.get("images"))
    ctx = int(state.get("context_window") or 0) or _agents.DEFAULT_CONTEXT_WINDOW_FLOOR
    model = build_chat_model(
        state["provider"],
        state["model_name"],
        state["base_url"],
        state["api_key"],
        state["env_var"],
        state["oauth_token"],
    )
    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(ev),
        context_window=ctx,
        web_model=model,
        main_model=model,
        vision_model=None,
        image_uris=image_uris,
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit={"outside": bool(state.get("allow_outside"))},
        chat_id=state.get("chat_id", ""),
        history=state.get("history") or [],
    )
    # Capture ask_user answers so a clarifying reply can re-trigger planning
    # (e.g. the planner asked "where is the current frontend?" and the user
    # answered). Kept in a module dict keyed by chat_id and consumed by
    # _route_plan_build.
    base_ask = tools.get("ask_user")
    if base_ask is not None:
        cid = state.get("chat_id", "")

        async def _ask_wrapper(question, options=None):
            answer = await base_ask(question, options)
            if answer:
                _ASK_ANSWERS[cid] = answer
            return answer

        tools["ask_user"] = _ask_wrapper
    return tools


async def _run_repo_tool(tools: dict, name: str, **kwargs) -> str:
    fn = tools.get(name)
    if fn is None:
        return f"ERROR: unknown tool {name!r}"
    try:
        res = fn(**kwargs)
        if inspect.isawaitable(res):
            res = await res
        return res
    except Exception as exc:  # noqa: BLE001
        return f"ERROR running {name}: {exc}"


def _parse_glob_files(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith(("GLOB MATCHES", "(")):
            continue
        if (
            "/" in line or re.match(r"^[\w.\-]+\.\w+$", line)
        ) and not _is_excluded_discovery_path(line):
            out.append(line)
    return out


def _parse_grep_files(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        m = re.match(r"^([^\s:]+):\d+:", line)
        if m and not _is_excluded_discovery_path(m.group(1)):
            out.append(m.group(1))
    return out


def _build_tree(root: str, max_depth: int = 3, max_entries: int = 400) -> str:
    import os

    lines: list[str] = []
    count = 0
    skip_dirs = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        "skills",
        "release",
    }
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base) :].count(os.sep)
        if depth > max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in skip_dirs
        )
        rel = os.path.relpath(dirpath, root)
        prefix = "" if rel == "." else rel + "/"
        for f in sorted(filenames):
            if f.startswith("."):
                continue
            lines.append(prefix + f)
            count += 1
            if count >= max_entries:
                lines.append("... (truncated)")
                return "\n".join(lines)
    return "\n".join(lines)


def _repo_source_files(root: str, max_files: int = 600) -> list[str]:
    """Flat list of source-file relative paths (vendored dirs skipped).

    Used to backfill candidate files when the derived glob/grep patterns return
    little or nothing, so the agent always gets a repo map instead of an empty
    discovery result.
    """
    import os

    skip_dirs = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        ".next",
        "out",
        "coverage",
        ".idea",
        ".vscode",
        ".turbo",
        "skills",
        "release",
    }
    out: list[str] = []
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base) :].count(os.sep)
        if depth > 7:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in skip_dirs
        )
        for f in sorted(filenames):
            if f.startswith("."):
                continue
            ext = f.rsplit(".", 1)[-1].lower() if "." in f else ""
            if ext not in _EXTS:
                continue
            rel = os.path.relpath(os.path.join(dirpath, f), root)
            # Skip root-level .md docs (README/CONTRIBUTING/...) but keep
            # AGENTS.md and any nested .md (project rule, Part 3).
            if (
                os.path.dirname(rel) in ("", ".")
                and rel.lower().endswith(".md")
                and rel.lower() != "agents.md"
            ):
                continue
            out.append(rel)
            if len(out) >= max_files:
                return out
    return out


def _is_skill_path(path: str) -> bool:
    """True for skill methodology files (e.g. ``backend/skills/*.md``).

    Skills are already injected via the system prompt (AVAILABLE SKILLS /
    inlined body), so the explore pipeline must never re-discover or read them
    as project code — that wastes context and can confuse the planner into
    treating a skill's instructions as something to modify."""
    return "skills" in re.split(r"[/\\]", (path or "").strip())


# Directories that must never be surfaced as project code during repo
# discovery. Note: ``backend/tests/*.py`` (real test source) is intentionally
# NOT excluded — test files are needed when the user asks to write tests.
_EXCLUDED_DISCOVERY_DIRS = {"skills", "release"}


def _is_excluded_discovery_path(path: str) -> bool:
    """True for paths inside discovery-junk directories:

    * ``skills`` — methodology, already injected via the system prompt.
    * ``release`` — a full *bundled duplicate copy* of the app that ships
      inside the repo (e.g. ``release/mac-arm64/.../backend/...``); walking it
      double-counts the whole codebase and blows the discovery budget.

    Test source (``backend/tests/*.py``) stays discoverable on purpose."""
    return any(
        p in _EXCLUDED_DISCOVERY_DIRS for p in re.split(r"[/\\]", (path or "").strip())
    )


def _is_excluded_root_md(path: str, root: str) -> bool:
    """True for a root-level ``.md`` file OTHER than AGENTS.md.

    Per project rule, the explore pipeline must not read top-level docs
    (README, CONTRIBUTING, CHANGELOG, ...) -- they are noise next to the code
    and bloat the context budget -- while AGENTS.md stays readable. Attached
    files bypass this entirely (they are read via the Reader, not explore).

    ``path`` is root-relative in the real callers; an absolute path is also
    accepted (normalized via ``relpath``)."""
    base = os.path.basename(path or "").lower()
    if not base.endswith(".md") or base == "agents.md":
        return False
    rel = path if not os.path.isabs(path) else os.path.relpath(path, root)
    return os.path.dirname(rel) in ("", ".")


# Captured ask_user answers, keyed by chat_id, so the search pipeline can
# re-derive against a freshly-answered clarifying question (see repo_derive +
# _route_plan_build). Cleared by run_graph at the start of each run.
_ASK_ANSWERS: dict[str, str] = {}


def _rank_files_by_prompt(files: list[str], prompt: str) -> list[str]:
    """Rank files by how many salient prompt tokens appear in their path."""
    toks = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", prompt or "")}
    toks -= _STOPWORDS
    if not toks:
        return list(files)
    scored = []
    for f in files:
        fl = f.lower()
        score = sum(1 for t in toks if t in fl)
        scored.append((score, -len(fl), f))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [f for _, _, f in scored]


_IMPORT_RE = re.compile(r"""(?mx)
    ^[^\S\n]*(?:
        from\s+([.\w]+)\s+import\s+([\w,\s]+)
      | import\s+([.\w]+)
      | import\s+[^\n'"]*?from\s+['"]([^'"]+)['"]
      | require\(\s*['"]([^'"]+)['"]\s*\)
      | import\s+['"]([^'"]+)['"]
      | export[^\n'"]*?from\s+['"]([^'"]+)['"]
    )""")


def _resolve_module(root: str, from_file: str, spec: str) -> str | None:
    """Resolve a module/relative specifier to a repo file (existence-checked)."""
    import os

    if not spec:
        return None
    if spec.startswith("."):
        n = 0
        while n < len(spec) and spec[n] == ".":
            n += 1
        rest = spec[n:].replace(".", os.sep)
        base = os.path.dirname(from_file)
        for _ in range(max(0, n - 1)):
            base = os.path.dirname(base)
        cand = os.path.normpath(os.path.join(base, rest))
    else:
        cand = spec.replace(".", os.sep)
    exts = (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt")
    for ext in exts:
        p = os.path.join(root, cand + ext)
        if os.path.exists(p):
            return os.path.relpath(p, root)
    for ext in (".py", ".ts", ".tsx", ".js", ".jsx"):
        idx = (
            os.path.join(root, cand, "__init__" + ext)
            if ext == ".py"
            else os.path.join(root, cand, "index" + ext)
        )
        if os.path.exists(idx):
            return os.path.relpath(idx, root)
    return None


def _expand_imports(root: str, files: list[str], budget: int = 80) -> list[str]:
    """Backfill directly-imported local files so the agent gets cross-file context.

    Only specifiers that resolve to a real repo file are added (relative imports
    like `./x` / `../x` / `from . import x`, absolute module paths that exist in
    the repo, and JS `require`/ESM imports). Bare stdlib/dependency imports are
    skipped because they don't resolve to a project file.
    """
    import os

    have = set(files)
    extra: list[str] = []
    seen_extra: set[str] = set()
    for f in files:
        if len(have) + len(extra) >= budget:
            break
        try:
            with open(os.path.join(root, f), "r", errors="ignore") as fh:
                head = fh.read(4000)
        except OSError:
            continue
        for m in _IMPORT_RE.finditer(head):
            mod = m.group(1)
            names = m.group(2)
            if mod is not None:
                spec = mod
                if mod.startswith(".") and set(mod) == {"."} and names:
                    # `from . import name` -> module ".name"
                    first = names.split(",")[0].strip()
                    spec = mod + first
                target = _resolve_module(root, f, spec)
            else:
                spec = next((g for g in m.groups()[2:] if g), None)
                target = _resolve_module(root, f, spec) if spec else None
            if target and target not in have and target not in seen_extra:
                extra.append(target)
                seen_extra.add(target)
    return files + extra


def _fully_read_files(read_context: str) -> set[str]:
    """Files present as a FULL read in ``read_context`` (``=== <file> ===``).

    Partial reads (``--- <file>:a-b ---``) are intentionally excluded: they may
    not cover the grep-hit line, so their grep matches must stay."""
    return {
        m.group(1) for m in re.finditer(r"^=== (.+?) ===$", read_context, re.MULTILINE)
    }


def _dedup_grep_results(grep_results: list[str], fully_read: set[str]) -> list[str]:
    """Drop grep-hit lines whose file was already injected in full via
    ``read_context`` -- otherwise that file's content appears twice (once as
    FILE CONTENTS READ, once as GREP MATCHES)."""
    if not fully_read:
        return list(grep_results)
    out: list[str] = []
    for block in grep_results:
        kept: list[str] = []
        for line in block.splitlines():
            m = re.match(r"^([^\s:]+):\d+:", line)
            if m and m.group(1) in fully_read:
                continue
            kept.append(line)
        if kept:
            out.append("\n".join(kept))
    return out


def _resolve_file_refs(texts, root) -> list[str]:
    """Return repo-relative paths of REAL files referenced anywhere in `texts`
    (the current request + all prior conversation turns).

    Used to force a named file into the discovery read set even when the LLM
    planner misses it. Only tokens that resolve to an actual file inside the
    project are kept, so prose like "v1.2" or "foo.bar" never forces a bogus
    read. Capped so the exploration budget stays bounded.
    """
    if not texts:
        return []
    joined = "\n".join(str(t) for t in texts if t)
    cands: set[str] = set()
    # Path-like tokens: a/b/c, a/b/c.py, bare file.py, **/ globs.
    for tok in re.findall(
        r"\b(?:[\w\-]+\/)+[\w\-.]+(?:\.\w+)?\b|"
        r"\b[\w\-]+\.[A-Za-z][A-Za-z0-9+#\-]{1,9}\b|"
        r"\*\*?/[\w\-./*?]+",
        joined,
    ):
        cands.add(tok.strip())
    # Quoted literals that look like a path.
    for q in re.findall(r"['\"`]([^'\"`\n]{1,200})['\"`]", joined):
        q = q.strip()
        if "/" in q or "\\" in q or q.lower().endswith(tuple("." + e for e in _EXTS)):
            cands.add(q)
    out: list[str] = []
    seen: set[str] = set()
    for c in cands:
        try:
            abs_p = _agents.resolve_safe(root, c)
        except Exception:  # noqa: BLE001, S112
            continue
        if not abs_p or not os.path.isfile(abs_p):
            continue
        rel = os.path.relpath(abs_p, _agents.resolve_safe(root, ""))
        if rel in seen:
            continue
        seen.add(rel)
        out.append(rel)
        if len(out) >= 12:
            break
    return out


# ----- Reader (targeted file reading, no repo discovery) -------------------

READER_CONTEXT_LINES = 30
READER_HEAD_LINES = 200
READER_MAX_FILES = 15
MAX_EXPLORE_READ_CHARS = 24_000


def _explicit_files(state: AgentState) -> list[str]:
    """Workspace-relative paths the user explicitly pointed at THIS turn:
    attachments + the open Neovim file + any file named directly in the request.
    Used both for routing (ask -> reader) and for the reader's read set."""
    root = state["root"]
    attachments = state.get("attachments")
    nvim_file = state.get("nvim_file", "")
    files = list(_agents._scoped_rels(root, attachments, nvim_file))
    for f in _resolve_file_refs([state.get("request", "")], root):
        if f not in files:
            files.append(f)
    return files


def _parse_line_refs(
    request: str, files: list[str]
) -> dict[str, list[tuple[int, int | None]]]:
    """Map each explicit file to ``(start, end|None)`` line ranges cited in the
    request as ``path:123``, ``path#L123`` or ``path:123-145``."""
    refs: dict[str, list[tuple[int, int | None]]] = {}
    for rel in files:
        esc = re.escape(rel)
        for m in re.finditer(rf"{esc}[:#]L?(\d+)(?:-(\d+))?", request):
            a = int(m.group(1))
            b = int(m.group(2)) if m.group(2) else None
            refs.setdefault(rel, []).append((a, b))
    return refs


def _in_file_grep(root: str, rel: str, patterns: list[re.Pattern]) -> set[int]:
    """Return 1-indexed line numbers of ``rel`` matching any of ``patterns``."""
    try:
        target = _agents.resolve_safe(root, rel)
    except Exception:  # noqa: BLE001
        return set()
    try:
        with open(target, "r", errors="ignore") as fh:
            lines = fh.readlines()
    except OSError:
        return set()
    out: set[int] = set()
    for i, line in enumerate(lines, 1):
        for rx in patterns:
            if rx.search(line):
                out.add(i)
                break
    return out


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ranges:
        return []
    rs = sorted(ranges)
    merged: list[list[int]] = [list(rs[0])]
    for a, b in rs[1:]:
        if a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


# ----- Repo-discovery nodes (deterministic) -------------------------------


_TREE_CACHE: dict[str, tuple[str, str]] = {}
_TREE_CACHE_MAX_ROOTS = 500

_MTIME_SIG_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    "out",
    "coverage",
    ".idea",
    ".vscode",
    ".turbo",
}


def _repo_mtime_signature(root: str, max_entries: int = 4000) -> str:
    """Cheap staleness signature for the whole tree: file count + the latest
    mtime seen (bounded walk, same skip-dirs as `_build_tree`). Catches edits
    and additions directly (a changed/new file bumps `latest`); catches
    deletions/renames indirectly via the changed `count`. Never hashes file
    CONTENT — only used to decide whether a cached SEARCH PLAN is still worth
    reusing, never to skip an actual glob/grep/read.
    """
    count = 0
    latest = 0.0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d
            for d in dirnames
            if not d.startswith(".") and d not in _MTIME_SIG_SKIP_DIRS
        )
        for f in filenames:
            if f.startswith("."):
                continue
            try:
                mtime = os.path.getmtime(os.path.join(dirpath, f))
            except OSError:
                continue
            latest = max(latest, mtime)
            count += 1
            if count >= max_entries:
                return f"{count}:{latest}"
    return f"{count}:{latest}"


def _spec_keyword_signature(request: str) -> str:
    """Order-independent keyword-set signature for spec-cache matching, so a
    reworded but semantically identical follow-up in the same chat still hits
    (e.g. "where is the auth timeout handled" vs "auth timeout, where's that
    handled")."""
    toks = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", request or "")}
    toks -= _STOPWORDS
    return "|".join(sorted(toks))


def _build_tree_cached(
    root: str, root_sig: str, max_depth: int = 3, max_entries: int = 400
) -> str:
    """Same output as `_build_tree`, skipping the walk when `root_sig` (an
    already-computed `_repo_mtime_signature`) matches the last build for this
    root — the tree walk repeats on every single repo_derive call otherwise.
    """
    cached = _TREE_CACHE.get(root)
    if cached and cached[0] == root_sig:
        return cached[1]
    tree = _build_tree(root, max_depth=max_depth, max_entries=max_entries)
    if len(_TREE_CACHE) >= _TREE_CACHE_MAX_ROOTS and root not in _TREE_CACHE:
        _TREE_CACHE.pop(next(iter(_TREE_CACHE)))
    _TREE_CACHE[root] = (root_sig, tree)
    return tree


def _rank_files_semantic(
    root: str, prompt: str, files: list[str], state: AgentState
) -> list[str]:
    """Rank `files` by embedding similarity to `prompt` using the project's own
    vector store (the same index already built for RAG) instead of naive
    keyword-overlap counting — no extra LLM call, just an embedding lookup.
    Files the semantic search doesn't surface keep their keyword-ranked order,
    appended after the semantic hits. Falls back to pure keyword ranking on
    any failure or an empty/missing index — never raises.
    """
    # کد پروژه دیگه ایندکس نمی‌شه (KIND_FILE حذف شد) — فقط keyword ranking.
    return _rank_files_by_prompt(files, prompt)


_GREP_HIT_FILE_RE = re.compile(r"^([^\s:]+):\d+:")


def _grep_hit_file(line: str) -> str:
    m = _GREP_HIT_FILE_RE.match(line)
    return m.group(1) if m else ""


def _read_context_files(read_context: str) -> set[str]:
    """File paths already fully present in `read_context` (both repo_read's
    `=== path ===` and reader_read's `--- path:a-b ---` markers), so the grep
    dump can skip duplicating their content."""
    files: set[str] = set()
    for m in re.finditer(r"^=== (.+?) ===$", read_context, re.MULTILINE):
        files.add(m.group(1))
    for m in re.finditer(r"^--- (.+?):\d+-\d+ ---$", read_context, re.MULTILINE):
        files.add(m.group(1))
    return files


_REFERENCE_CUES = re.compile(
    r"ببین|نشون بده|نمایش بده|اون فایل|همون فایل|آن فایل|"
    r"look at it|that file|this file|show me|show it|open it",
    re.IGNORECASE,
)


def _has_reference_cue(text: str) -> bool:
    """True when the message refers to a file mentioned EARLIER in the
    conversation (e.g. "ببینش", "look at that file") rather than naming it
    directly."""
    return bool(_REFERENCE_CUES.search(text or ""))


# Messages that only refer back to a PRIOR answer in the conversation rather
# than introducing a new, searchable entity (e.g. "look at the paths you
# mentioned", "همون مسیرهاییکه گفتی رو ببین"). Used to keep a broadened
# _ASK_REPO_CUES from routing a no-op follow-up into an empty re-explore.
_FOLLOWUP_CUES = re.compile(
    r"look at|the paths|mentioned|refer|همون|اون|گفتی|ببین|نشون بده",
    re.IGNORECASE,
)


def _history_has_assistant_answer(state: AgentState) -> bool:
    return any(
        (m.get("role") in ("assistant", "agent")) and (m.get("content") or "").strip()
        for m in (state.get("history") or [])
    )


def _is_prior_reference_followup(state: AgentState) -> bool:
    """True for a short follow-up that only refers back to prior discussion and
    carries no new searchable entity. Such a message matches the broadened
    _ASK_REPO_CUES (e.g. "مسیر") but would yield an empty exploration, so we
    let the agent re-state from the prior answer already in history instead of
    looping on a pointless re-explore."""
    return bool(_FOLLOWUP_CUES.search(state.get("request", "") or "")) and (
        _history_has_assistant_answer(state)
    )


def _ask_needs_repo(text: str) -> bool:
    """True when an ask-mode question is about the project/codebase and should
    run the deterministic repo-discovery pipeline (instead of answering from
    general knowledge). Deliberately excludes chit-chat ("who/they are you",
    "hello", plain conceptual questions like "what is a closure")."""
    return bool(_ASK_REPO_CUES.search(text or ""))


async def ask_entry(state: AgentState) -> dict:
    # Ask is a GENERAL assistant. It has grep/glob/read tools directly
    # (OpenCode-style), so it explores the repo itself when the question is
    # project/code-related; for general questions it answers directly. It
    # consumes its own tool results and never re-searches from scratch.
    return {}


def _route_ask_entry(state: AgentState) -> str:
    state.get("request", "")
    # When the user explicitly points at file(s) THIS turn -- an attachment, the
    # open Neovim file, or a file named directly in the message -- the question is
    # about THOSE files, so route to the Reader agent, which reads only the needed
    # parts (no repo-wide discovery / glob).
    if _explicit_files(state):
        return "reader"
    # Otherwise the agent decides for itself whether to search. A strong repo cue
    # or an explicit file reference means it likely should; either way it answers
    # directly with whatever tools it calls.
    return "ask_answer"


async def ask_answer(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "ask", queue, run_flags=state.get("_run_flags"))
    return {"final_response": reply}


async def reader_read(state: AgentState) -> dict:
    """Deterministically gather ONLY the needed parts of the explicitly specified
    file(s) -- no LLM, no repo-wide glob/grep.

    Per file, in order of preference:
      * explicit ``path:LINE`` / ``path#L123`` / ``path:123-145`` refs -> read that range;
      * otherwise an in-file grep of the question's deterministic keywords -> read each
        match expanded by ``READER_CONTEXT_LINES``;
      * fallback (no refs, no keywords) -> a bounded head, never the whole file.
    """
    queue = state["_queue"]
    root = state["root"]
    request = state.get("request", "")
    files = _explicit_files(state)[:READER_MAX_FILES]
    if not files:
        return {"read_context": ""}
    # same skill-name stripping as repo_derive: the skill's own words must not
    # become in-file grep keywords.
    spec = _derive_explore_patterns(
        _strip_skill_mentions(request, _skill_names_to_strip(state))
    )
    patterns: list[re.Pattern] = []
    for p in (spec.get("grep", []) or [])[:24]:
        try:
            patterns.append(re.compile(p))
        except re.error:
            continue
    line_refs = _parse_line_refs(request, files)
    tools = _make_explore_tools(state, queue)
    # Build every (file, range) read spec up front, then run ALL reads
    # concurrently via asyncio.gather — opencode-style parallel tool execution.
    # The read tool offloads the disk read to a worker thread (tools.read_file
    # -> asyncio.to_thread), so gathered reads overlap instead of running
    # one-at-a-time. The read tool emits its own tool/tool_result events, so no
    # manual queue events are needed here.
    read_specs: list[tuple[str, int, int]] = []  # (file, a, b)
    for f in files:
        ranges: list[tuple[int, int]] = []
        if f in line_refs:
            for a, b in line_refs[f]:
                end = b or a
                ranges.append(
                    (max(1, a - READER_CONTEXT_LINES), end + READER_CONTEXT_LINES)
                )
        elif patterns:
            for n in sorted(_in_file_grep(root, f, patterns)):
                ranges.append(
                    (max(1, n - READER_CONTEXT_LINES), n + READER_CONTEXT_LINES)
                )
        else:
            ranges.append((1, READER_HEAD_LINES))
        for a, b in _merge_ranges(ranges):
            read_specs.append((f, a, b))

    async def _read(spec: tuple[str, int, int]) -> str:
        f, a, b = spec
        limit = b - a + 1
        res = await _run_repo_tool(tools, "read", filePath=f, offset=a, limit=limit)
        return f"--- {f}:{a}-{b} ---\n{res}"

    chunks = await asyncio.gather(*(_read(s) for s in read_specs)) if read_specs else []
    # Assemble in input order and cap to MAX_EXPLORE_READ_CHARS (trims trailing
    # parts once the budget is reached — gather keeps order, so the head wins).
    parts: list[str] = []
    total = 0
    for chunk in chunks:
        if total + len(chunk) > MAX_EXPLORE_READ_CHARS and parts:
            break
        parts.append(chunk)
        total += len(chunk)
    return {"read_context": "\n\n".join(parts), "reader_files": files}


def _build_reader_context(state: AgentState) -> str:
    rc = state.get("read_context", "")
    if not rc:
        return ""
    return (
        "SPECIFIED FILE CONTENTS (read deterministically -- do NOT call "
        "glob/grep/read; use only this context):\n" + rc
    )


async def reader_answer(state: AgentState) -> dict:
    # Reader is a distinct agent persona; make build_turn_context treat it as such
    # (correct system note + tool gating), even when auto-triggered from ask mode.
    state["mode"] = "reader"
    queue = state["_queue"]
    extra = _build_reader_context(state)
    reply = await _run_mode_turn(state, "reader", queue, extra_instruction=extra, run_flags=state.get("_run_flags"))
    return {"final_response": reply}


async def plan_understand(state: AgentState) -> dict:
    # Deterministic comprehension is folded into repo_derive; this node exists so
    # the PLAN flow has an explicit "understand -> discover" shape.
    return {}


def _route_plan_understand(state: AgentState) -> str:
    # When the user points at specific file(s) in PLAN mode, read ONLY those
    # (targeted, no repo-wide discovery) and let the planner build from that
    # context. Otherwise the planner explores the repo itself via grep/glob/read
    # tools (OpenCode-style) and then builds the plan.
    if _explicit_files(state):
        return "reader_read"
    return "plan_build"


def _route_reader_dispatch(state: AgentState) -> str:
    # After the targeted read, hand off to the right consumer: PLAN mode feeds
    # the read context to the planner; everything else gets the Reader answer.
    if state.get("mode") == "plan":
        return "plan_build"
    return "reader_answer"


async def plan_build(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "plan", queue, run_flags=state.get("_run_flags"))
    # Guard against a non-string reply (e.g. None when the turn fails) so we
    # don't crash on .strip() — and never silently swallow a save failure.
    if not isinstance(reply, str):
        reply = "" if reply is None else str(reply)
    if reply.strip():
        from tools import slugify

        ws = (
            slugify(os.path.basename(os.path.realpath(state["root"]).rstrip(os.sep)))
            or "workspace"
        )
        plan_body = _normalize_plan_reply(reply)
        try:
            state_db.save_plan(ws, "plan", plan_body, chat_id=state.get("chat_id", ""))
        except Exception:
            # Surface the failure instead of swallowing it: a silent drop is
            # exactly the "plan sometimes isn't saved" bug.
            logging.getLogger(__name__).exception("plan_build: save_plan failed")
        reply = plan_body
    return {"plan": reply, "plan_attempts": int(state.get("plan_attempts", 0)) + 1}


def _normalize_plan_reply(reply: str) -> str:
    """Return the plan body to persist.

    The model is told to open with ``## Plan``, but it sometimes prefixes a
    short lead-in or uses a variant header (``## plan``, ``### Plan``,
    ``## Plan:``). We still persist the plan in those cases instead of silently
    dropping it (the "plan sometimes isn't saved" bug). If no header is present
    at all but we're in plan mode, the whole reply IS the plan.
    """
    import re

    text = (reply or "").strip()
    if not text:
        return ""
    m = re.search(r"^#{1,3}\s*plan\b\s*:?", text, re.IGNORECASE | re.MULTILINE)
    return text[m.start() :] if m else text


def _route_plan_build(state: AgentState) -> str:
    # After the planner asked a clarifying question and the user answered, the
    # answer was captured into _ASK_ANSWERS. Re-run the planner against the new
    # info so the plan gets UPDATED instead of looping on an empty/bad plan.
    # Bounded by plan_attempts so a run of unhelpful answers can't loop forever.
    if state.get("mode") == "plan":
        ans = _ASK_ANSWERS.get(state.get("chat_id", ""), "")
        if (
            ans
            and ans != state.get("_explored_ask_answer")
            and int(state.get("plan_attempts", 0)) < 3
        ):
            return "plan_build"
    # Plan mode is a read-only deliverable: present the plan once and STOP, so
    # the user can review / extend it or switch to Coder manually. Other modes
    # (e.g. coder invoked with a plan in history) jump straight to coder.
    return "done" if state.get("mode") == "plan" else "coder"


def _route_mode(state: AgentState) -> str:
    return normalize_mode(state.get("mode", "ask"))


def build_graph():
    """Compile the LangGraph state machine for the agent workflow.

    OpenCode-style architecture: every agent mode (coder/plan/ask/reader) has
    direct access to the grep/glob/read tool runtime and decides iteratively
    which to call — there is NO forced derive stage and NO separate explore
    pipeline. Broad exploration is delegated to an isolated Explore subagent via
    the Task tool, whose history never enters the Main Agent context.
    """
    g = StateGraph(AgentState)
    g.add_node("router", router)
    g.add_node("coder", coder_node)
    g.add_node("coder_entry", coder_entry)
    g.add_conditional_edges("coder_entry", _route_coder_entry, {"coder": "coder"})
    g.add_node("review", review_node)
    g.add_node("done", done_node)
    # ASK flow: general assistant with repo tools; answers directly, searching
    # itself when the question is project-related.
    g.add_node("ask_entry", ask_entry)
    g.add_node("ask_answer", ask_answer)
    g.add_node("reader_read", reader_read)
    g.add_node("reader_answer", reader_answer)
    g.add_conditional_edges(
        "ask_entry",
        _route_ask_entry,
        {"ask_answer": "ask_answer", "reader": "reader_read"},
    )
    g.add_edge("ask_answer", "done")
    g.add_conditional_edges(
        "reader_read",
        _route_reader_dispatch,
        {"reader_answer": "reader_answer", "plan_build": "plan_build"},
    )
    g.add_edge("reader_answer", "done")
    # PLAN flow: the planner explores via grep/glob/read itself, then builds.
    g.add_node("plan_understand", plan_understand)
    g.add_node("plan_build", plan_build)
    g.add_conditional_edges(
        "plan_understand",
        _route_plan_understand,
        {"reader_read": "reader_read", "plan_build": "plan_build"},
    )
    g.add_conditional_edges(
        "plan_build",
        _route_plan_build,
        {"plan_build": "plan_build", "coder": "coder", "done": "done"},
    )

    g.add_edge(START, "router")
    g.add_conditional_edges(
        "router",
        _route_mode,
        {
            "ask": "ask_entry",
            "plan": "plan_understand",
            "coder": "coder_entry",
            "reader": "reader_read",
        },
    )

    # CODER tail: Coder runs the project's tests itself (via run_terminal) before
    # finishing, so there is no automatic test/debug loop here — just review.
    g.add_edge("coder", "review")
    g.add_edge("review", "done")
    g.add_edge("done", END)
    return g.compile()


async def run_graph(initial: AgentState) -> AsyncIterator[dict]:
    """Drive the compiled graph, yielding SSE events as they are produced.

    The event protocol matches the old ``run_agent`` generator (dicts with a
    ``kind`` key), so ``server.py`` is unchanged.
    """
    queue: asyncio.Queue = asyncio.Queue()
    initial = dict(initial)
    initial["_queue"] = queue
    # Mutable flag shared between _run_mode_turn (which detects a hard failure)
    # and _drive (which decides whether to clear the durable resume file). A
    # plain attribute on `initial` would be invisible to _drive because
    # _run_mode_turn works on a *copy* of the state, so we use a nested dict.
    initial.setdefault("_run_flags", {})["hard_error"] = False
    initial["_run_flags"]["error"] = False
    # Drop any stale captured ask_user answer for this chat from a previous run
    # so Part A re-exploration only fires for answers given in THIS run.
    _ASK_ANSWERS.pop(initial.get("chat_id", ""), None)
    # Reset the cross-turn search counter at the START of each user message
    # (not per model-turn), so the auto-router's "repeated calls" threshold is
    # measured across the whole conversation, not reset every model turn.
    _agents.reset_auto_explore_counter()
    if not (initial.get("request") or "").strip():
        yield {
            "kind": "error",
            "content": "empty or whitespace-only prompt — refusing to run",
        }
        return
    graph = build_graph()

    async def _drive() -> None:
        # Tracks whether the run ended cleanly (no error AND no cancellation).
        # A user abort / client disconnect cancels this task, which surfaces as
        # a BaseException (CancelledError / GeneratorExit) — NOT an Exception —
        # so it would otherwise slip past the `except Exception` and fall into
        # the `else` branch below, wiping the durable resume file on an
        # *interrupted* turn. We must only clear the file on a genuine clean
        # finish, so we gate the `else` on this flag.
        _clean = True
        try:
            async for _ in graph.astream(initial, stream_mode="updates"):
                pass
        except asyncio.CancelledError:
            # User aborted / client disconnected mid-turn: LEAVE the resume file
            # behind so a reconnect can replay the already-done tool work.
            _clean = False
            return
        except GeneratorExit:
            # Consumer (run_graph generator) closed early — same as a disconnect.
            _clean = False
            return
        except Exception as _exc:  # noqa: BLE001 — surface the real failure
            # Never swallow the error silently: a bare `queue.put(None)` would
            # end the stream with NO error event, so the frontend sees a sudden
            # "disconnect" (the message just cuts off) instead of a real error
            # it can show as a Retry banner. This is the root cause of the
            # intermittent "first/any message disconnects instantly" reports.
            _clean = False
            traceback.print_exc()
            await queue.put(
                {
                    "kind": "error",
                    "content": f"agent crashed before producing output: {_exc!r}",
                }
            )
        else:
            # Clean finish: the turn completed, so the durable resume file is no
            # longer needed. On an error/interrupt we deliberately LEAVE it behind
            # so a reconnect can replay the already-done tool work (the file is
            # written step-by-step during the run, so it always holds the most
            # recent interrupted state).
            if _clean:
                _flags = initial.get("_run_flags") or {}
                _hard = bool(_flags.get("hard_error"))
                _errored = bool(_flags.get("error"))
                # Only clear the durable resume file on a GENUINE clean finish:
                # no cancellation, no hard error, AND no soft failure (repetition
                # loop / length truncation / retry-giveup / any turn that broke
                # out without completing). On any of those we LEAVE the file
                # behind so a reconnect/retry can replay the already-done tool
                # work instead of re-running it from zero.
                if not _hard and not _errored:
                    with contextlib.suppress(Exception):
                        state_db.clear_turn_resume(
                            initial.get("root", ""), initial.get("chat_id", "")
                        )
        finally:
            await queue.put(None)

    task = asyncio.create_task(_drive())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        # Reap the background drive task so it can never outlive this generator
        # (e.g. on GeneratorExit when the consumer stops early) and bleed model
        # requests into a subsequent test's mock capture.
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


# Repo-discovery cue (used by `_ask_needs_repo` and follow-up routing): a strong
# signal the question is about the project/codebase rather than general chat.
_ASK_REPO_CUES = re.compile(
    r"where is|where are|find|locate|trace|investigate|"
    r"which function|which class|which module|which file|which files|"
    r"what file|what module|what class|what function|"
    r"path of|implementation of|how does .* work|explain .* code|what does .* do|"
    r"codebase|source code|component|"
    r"کجا|پیدا کن|کدوم تابع|کدوم فانکشن|کدوم کلاس|کدوم ماژول|"
    r"پیاده سازی|چطور کار|کامپوننت",
    re.IGNORECASE,
)


# Explicit user cues that mean "look at the saved memory now" (so we recall it
# outside the first-message auto-recall). Persian + English.
_MEMORY_RECALL_CUES = re.compile(
    r"از مموری|مموری|در حافظه|یادآوری|حافظه|"
    r"look in memory|from memory|search memory|check memory|what.?s in memory|"
    r"recall|remember",
    re.IGNORECASE,
)
