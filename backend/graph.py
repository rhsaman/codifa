"""LangGraph orchestration for the Codifa agent workflow.

This replaces the old single ``Agent`` pydantic-ai ``run_agent`` loop with an
explicit LangGraph state machine:

    Router
    +-- Ask   (web_search / fetch_url / vision / read / grep / glob)
    +-- Plan  (web_search / fetch_url / vision / glob / grep / read / terminal)
    +-- Coder (edit_file / write_file / create / delete)
              -> Test (existing project test/build/type-check)
                  -- pass -> Review -> Done
                  -- fail -> Debug -> Coder -> ...  (bounded, MAX_DEBUG_ATTEMPTS)

The graph controls the *high-level* flow (routing, the test/debug/review loop,
the tool-permission boundaries). Each node runs ONE LLM turn for its mode via a
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
import inspect
import json
import os
import re
from collections.abc import AsyncIterator, Callable
from typing import Any, TypedDict

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
from context_builder import build_context as _build_rag_context
from llm import (
    ProviderError,
    _is_stream_options_error,
    _strip_stream_options,
    build_chat_model,
    chat_model_settings,
    llm_generate,
)
from tools import make_tool_callbacks

MAX_DEBUG_ATTEMPTS = 3

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
    max_history: int
    skills: list[str]
    vector_db_path: str
    vector_config: dict
    retrieval_config: dict
    subagent_models: dict
    providers: dict
    compact_threshold: float | None
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
    test_results: dict
    test_status: str
    debug_info: str
    debug_attempts: int
    review_result: str
    final_response: str
    max_debug_attempts: int
    # Explore (deterministic repo-discovery) scratch state
    search_spec: dict
    explore_glob: list[str]
    explore_grep: list[str]
    explore_tree: str
    explore_answer: str
    plan_attempts: int
    plan_valid: bool
    # Internal transport (NOT serialised by the graph runner; in-memory only)
    _queue: Any


# ---------------------------------------------------------------------------
# Message-history conversion (frontend plain-text turns -> LangChain messages)
# ---------------------------------------------------------------------------


def history_to_langchain_messages(history: list[dict]) -> list[BaseMessage]:
    """Convert plain ``{role, content}`` turns to LangChain messages.

    Tool/plan/resume metadata carried on assistant turns is dropped here -- it is
    re-injected as system notes by the turn runner (essentials-only resume), not
    as real tool-call messages.
    """
    out: list[BaseMessage] = []
    for turn in history or []:
        role = turn.get("role", "user")
        content = str(turn.get("content", ""))
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
# Mode classification (Router)
# ---------------------------------------------------------------------------

_CODE_HINTS = (
    r"\b(write|implement|create|add|fix|refactor|edit|delete|change|update|"
    r"rename|migrate|patch)\b"
)
_EXPLORE_HINTS = (
    r"\b(where is|find|locate|how does|trace|investigate|explore|understand|"
    r"what files|which file|search the repo|plan)\b"
)


def classify_mode(prompt: str, fallback: str = "ask") -> str:
    """Determine the workflow mode from the request.

    Explicit ``/plan``, ``/code`` and ``/ask`` prefixes in the prompt always win
    (so chat commands can override the toolbar mode); otherwise we trust the
    mode the UI selected. Invalid fallbacks collapse to ``ask``.
    """
    text = (prompt or "").strip().lower()
    if text.startswith("/plan") and (len(text) == 5 or text[5] in " \n\t"):
        return "plan"
    if text.startswith("/code") and (len(text) == 5 or text[5] in " \n\t"):
        return "coder"
    if text.startswith("/ask") and (len(text) == 4 or text[4] in " \n\t"):
        return "ask"
    if text.startswith("/explore") and (len(text) == 8 or text[8] in " \n\t"):
        return "explore"
    if fallback in ("ask", "plan", "coder", "explore"):
        return fallback
    return "ask"


# Phrases that mean the user EXPLICITLY asked the agent to search the web. Web
# tools (web_search / fetch_url / search_console) are only exposed to the model
# when this is true — the agent must never web-search on its own initiative.
_WEB_REQUEST_RE = re.compile(
    r"\b(search the web|web search|search online|look up online|google it|"
    r"browse the web|search google|find on the web|web results?|"
    r"search for (it|that) online)\b"
    r"|جستجو\s*(در|توی|کن)?\s*وب|از وب|گوگل\s*کن|سرچ\s*(وب|کن)|بگرد\s*(توی|در)?\s*وب",
    re.I,
)


def is_explicit_web_request(prompt: str) -> bool:
    """True only when the user clearly asked to web-search (e.g. "search the web
    for X", a ``/web`` command, or the Persian equivalents)."""
    text = (prompt or "").strip().lower()
    if text.startswith("/web") and (len(text) == 4 or text[4] in " \n\t"):
        return True
    return bool(_WEB_REQUEST_RE.search(prompt or ""))


# ---------------------------------------------------------------------------
# Per-mode tool filtering (faithful port of agents.py's data-driven gating)
# ---------------------------------------------------------------------------


def filter_tools_for_mode(
    mode: str,
    tools: dict[str, Callable],
    cap: dict | None,
    scoped_paths: set[str],
    allow_create: bool,
    allow_outside: bool,  # noqa: ARG001 - reserved for parity with agents.py
    prompt: str = "",
    root: str = "",
    explicit_web: bool = False,
) -> dict[str, Callable]:
    """Return the mode-appropriate subset of ``tools``.

    Mirrors the original agents.py gating exactly: capability-driven denying
    (readFiles/writeFiles/runTerminal/web), the coder-only write restriction,
    plan-only ``save_plan``, ask-mode drops (read/memory/trivial-prompt schemas),
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
            tools["run_terminal"] = _agents._wrap_no_search_bypass(tools["run_terminal"])
        if cap.get("runTerminal") and not cap.get("writeFiles"):
            tools["run_terminal"] = _agents._wrap_readonly_terminal(tools["run_terminal"])
    else:
        if mode != "coder":
            tools = {
                n: fn
                for n, fn in tools.items()
                if n not in ("write_file", "edit_file", "run_terminal", "confirm_action")
            }
        if "run_terminal" in tools:
            tools["run_terminal"] = _agents._wrap_no_search_bypass(tools["run_terminal"])

    # Web tools (web_search / fetch_url / search_console) are only exposed when
    # the user EXPLICITLY asks to search the web AND the web capability is
    # granted. This is enforced unconditionally (outside the `has_cap` block) so
    # the agent never web-searches on its own initiative, even when no capability
    # map is supplied.
    if not (cap.get("web", False) if cap else False) or not explicit_web:
        tools = {n: fn for n, fn in tools.items() if n not in _WEB}

    # Deterministic repo exploration: the LLM must NOT call glob/grep/read/task
    # in plan/explore/ask. Explore/plan always run the discovery workflow; ask
    # runs it only when the question is project-related (gated in ask_entry),
    # otherwise it answers directly. Skills injected as system context are the
    # only ask special-case.
    if mode in ("plan", "explore", "ask"):
        for _n in ("glob", "grep", "read", "task"):
            tools.pop(_n, None)
    if mode == "coder":
        tools = {
            n: fn
            for n, fn in tools.items()
            if n in ("write_file", "edit_file", "confirm_action", "update_plan", "ask_user")
        }
    if mode != "plan":
        tools.pop("save_plan", None)
    if mode == "ask":
        tools.pop("memory", None)
    if mode == "explore":
        # Exploration is already done; only on-demand capabilities remain.
        tools = {
            n: fn
            for n, fn in tools.items()
            if n in ("web_search", "fetch_url", "search_console", "vision")
        }
    if mode == "ask" and _agents._trivial_prompt(prompt):
        for n in (
            "update_plan",
            "web_search",
            "fetch_url",
            "search_console",
            "memory",
            "search_memory",
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
        return build_chat_model(
            provider, parent_model_name, base_url, api_key, env_var,
            oauth_token, temperature=0.2,
        ) if (default_to_parent and parent_model_name) else None
    if isinstance(entry, str):
        entry = entry.strip()
        if not entry:
            return build_chat_model(
                provider, parent_model_name, base_url, api_key, env_var,
                oauth_token, temperature=0.2,
            ) if (default_to_parent and parent_model_name) else None
        if entry.lower() in ("main model", "main_model", "main"):
            entry = parent_model_name or entry
    target = _agents._subagent_target(
        entry, provider, base_url, api_key, env_var, oauth_token,
        provider_lookup or (lambda pid: None),
    )
    if not target:
        return None
    kind, model, burl, akey, env, oauth = target
    if not model:
        return None
    return build_chat_model(kind, model, burl, akey, env, oauth, temperature=0.2)


async def _vision_analyze(model: Any, image_uris: list[str]) -> str | None:
    """One-shot vision analysis of attached images using ``model`` (the
    configured vision model). Returns the analysis text, or ``None`` on any
    failure. The caller injects the result into the main model's context so it
    can "see" the image without having to call a vision tool.

    Uses the vision model directly — there is deliberately NO fallback to the
    main model (a configured vision model is the contract; if it fails the
    caller surfaces that)."""
    from llm import llm_generate

    system = (
        "You are a vision analysis sub-agent. The user attached image(s) to their "
        "message. Examine them carefully and reply with a precise, concise analysis "
        "(under ~400 words) describing exactly what the image shows that is relevant "
        "to a coding / UI task: on-screen text, numbers, layout, colors, UI elements, "
        "error messages, stack traces, code. Be literal and complete — this analysis "
        "is the main agent's only view of the image."
    )
    try:
        text, _ = await llm_generate(
            model, system=system, user="Analyze the attached image(s).",
            images=image_uris, sub=True,
        )
        return (text or "").strip() or None
    except Exception:  # noqa: BLE001
        return None


async def build_turn_context(state: AgentState, queue: asyncio.Queue) -> dict:
    """Assemble everything one mode-turn needs: system prompt, history messages,
    the mode-filtered tool set, and the LangChain chat model.

    Reuses the SAME helpers ``run_agent`` used so prompts / RAG / skills stay
    equivalent to the previous behaviour.
    """
    import os

    from tools import open_vector_store

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

    image_uris = _agents._load_images(images)

    # Context window (resolve live when the UI did not supply one).
    ctx = int(state.get("context_window") or 0)
    if ctx <= 0:
        try:
            from providers import model_context

            ctx = await model_context(
                state["provider"], state["model_name"], state["base_url"],
                state["api_key"], state["env_var"], oauth_token=state["oauth_token"],
            )
        except Exception:  # noqa: BLE001
            ctx = 0
    if ctx <= 0:
        ctx = _agents.DEFAULT_CONTEXT_WINDOW_FLOOR

    store = open_vector_store(
        root, state.get("vector_db_path", ""), state.get("vector_config")
    )

    cap = state.get("cap")
    # All sub-agents (search / web / explore / vision / compact distills) and the
    # PARENT LLM loop run on LangChain models built from ``build_chat_model``.
    subagent_models = state.get("subagent_models") or {}
    # Cross-provider routing: a "providerId/model" sub-agent entry must run on
    # that provider's OWN base URL / key. The frontend sends the full provider
    # configs (keyed by id) so we can look them up here.
    _providers = state.get("providers") or {}
    _provider_lookup = (
        lambda pid: (_providers.get(pid) if isinstance(_providers, dict) else None)
    )
    web_model = resolve_subagent_model(
        state["provider"], subagent_models.get("web"), state["base_url"],
        state["api_key"], state["env_var"], state["oauth_token"], state["model_name"],
        provider_lookup=_provider_lookup,
    )
    compact_model = resolve_subagent_model(
        state["provider"], subagent_models.get("compact"), state["base_url"],
        state["api_key"], state["env_var"], state["oauth_token"], state["model_name"],
        provider_lookup=_provider_lookup,
    )
    vision_model = resolve_subagent_model(
        state["provider"], subagent_models.get("vision"), state["base_url"],
        state["api_key"], state["env_var"], state["oauth_token"], state["model_name"],
        default_to_parent=False, provider_lookup=_provider_lookup,
    )

    settings = await chat_model_settings(
        mode, ctx, state.get("thinking_level", ""), state["provider"],
        state["model_name"], state["base_url"], state["api_key"],
        state["env_var"], state["oauth_token"], _agents._detect_scope(prompt),
    )
    model = build_chat_model(
        state["provider"], state["model_name"], state["base_url"],
        state["api_key"], state["env_var"], state["oauth_token"],
        temperature=settings["temperature"], max_tokens=settings["max_tokens"],
        thinking_level=settings["thinking_level"],
        timeout=model_timeout_for(state),
    )

    tools = make_tool_callbacks(
        root, lambda ev: queue.put_nowait(ev),
        context_window=ctx, web_model=web_model, main_model=model,
        vision_model=vision_model, image_uris=image_uris,
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit={"outside": allow_outside}, store=store, chat_id=chat_id,
    )

    scoped_paths = _agents._scoped_rels(root, attachments, nvim_file)
    filtered = filter_tools_for_mode(
        mode, tools, cap, scoped_paths, allow_create, allow_outside,
        prompt=prompt, root=root,
        explicit_web=is_explicit_web_request(prompt),
    )
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
        try:
            tgt = _agents.resolve_safe(root, nvim_file)
            if tgt and os.path.isfile(tgt):
                nvim_rel = os.path.relpath(tgt, _agents.resolve_safe(root, ""))
                workspace_note += (
                    f"\n\n=== NEOVIM (OPEN EDITOR) ===\nThe user currently has `{nvim_rel}` "
                    "open in Neovim -- this file is their ACTIVE FOCUS."
                )
        except Exception:  # noqa: BLE001
            pass
    attached = _agents._load_attachments(root, attachments)
    if attached:
        workspace_note += (
            "\n\nThe user attached files and their full contents appear at the START "
            "of the user's latest message. Read them -- they are the primary focus."
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
    )
    system_final = (
        _agents._mode_declare(mode)
        + _agents._language_directive(prompt)
        + ("" if mode in ("coder", "ask", "plan", "explore") else _agents._SEARCH_RULE)
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
        system_final += "\n\nUser-supplied custom prompt (append to the above):\n" + system_extra
    if mode in ("ask", "plan", "explore"):
        system_final += (
            "\n\nREPO CONTEXT: relevant files are auto-discovered (deterministic "
            "glob + grep + directory tree + targeted reads) and injected above as "
            "'REPOSITORY EXPLORATION RESULTS' before your answer. Use THAT context. "
            "The search tools (glob/grep/read) are NOT available to you -- never try "
            "to call them. web_search / fetch_url are ONLY present when the user "
            "explicitly asks to search the web (e.g. 'search the web for X') -- never "
            "web-search on your own initiative. vision / skills / MCP connectors are "
            "available on demand when the question needs external info or attached "
            "images."
        )

    try:
        project_memory = _agents._load_project_memory(root)
    except Exception:  # noqa: BLE001
        project_memory = ""
    if project_memory:
        system_final += project_memory

    # RAG auto-recall (learned memory + project-file/web context).
    try:
        from retrieval import RetrievalSettings

        rag_settings = RetrievalSettings.from_dict(state.get("retrieval_config"))
    except Exception:  # noqa: BLE001
        rag_settings = None
    learned_memory = ""
    if rag_settings and getattr(rag_settings, "auto_recall", False):
        # Recall the saved memory (learned notes) automatically ONLY on the
        # FIRST message of a chat, or when the user EXPLICITLY asks to look at
        # memory (e.g. "از مموری ببین"). Every recall re-sends the whole context
        # to the provider, so injecting memory on every turn quietly multiplies
        # token cost — it must not happen automatically after the first message.
        # An explicit request recalls exactly that one turn (it is re-evaluated
        # per message, so it does not flip on a persistent "always recall" flag).
        _history = state.get("history") or []
        _first_msg = len(_history) == 0
        _explicit_recall = bool(_MEMORY_RECALL_CUES.search(prompt or ""))
        if _first_msg or _explicit_recall:
            try:
                learned_memory = _agents._load_learned_memory(store, prompt)
            except Exception:  # noqa: BLE001
                learned_memory = ""
            if learned_memory:
                system_final += learned_memory
                queue.put_nowait(
                    _agents._tool_event(
                        {
                            "kind": "tool", "tool": "search_memory",
                            "args": {"query": prompt[:300], "auto": True},
                            "summary": "recalled saved memory notes from the vector store",
                        }
                    )
                )
        # Project file/web RAG context is a SEPARATE mechanism from the learned
        # memory recall above and continues to be injected when enabled.
        try:
            if rag_settings.active_kinds():
                rag_block = _build_rag_context(
                    store, prompt, rag_settings, max_chars=2600,
                    per_section_chars=1200, kinds=("file", "web"),
                )
                if rag_block:
                    system_final += rag_block
        except Exception:  # noqa: BLE001
            pass

    # Skills.
    all_skills = _agents._load_skills(root)
    picked: list[dict] = []
    manual_names = [n.strip() for n in (skills or []) if n and n.strip()]
    if manual_names:
        by_name = {s["name"].lower(): s for s in all_skills}
        picked = [by_name[n.lower()] for n in manual_names if n.lower() in by_name]
    if all_skills:
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
        system_final += section

    if mode in ("plan", "coder"):
        try:
            saved = _agents._load_saved_plan(root, chat_id=chat_id)
        except Exception:  # noqa: BLE001
            saved = ""
        if saved:
            system_final += saved

    # Workspace scout + history fit.
    scout_budget = _agents._AUTO_SCOUT_MAX_TOTAL
    scouted = ""
    if not scoped_paths and _agents._needs_workspace(prompt):
        try:
            scouted = _agents._scout_workspace_cached(root, chat_id, max_total=scout_budget)
        except Exception:  # noqa: BLE001
            scouted = ""

    history = _agents._fit_history(
        state.get("history") or [],
        _agents._history_budget(ctx, system_final, scouted, mode),
    )
    lc_history = history_to_langchain_messages(history)

    if mode == "coder":
        reuse = _agents._plan_reuse_note(history)
        if reuse:
            lc_history.insert(0, SystemMessage(content=reuse))
        disc = _agents._plan_discovery_note(history)
        if disc:
            lc_history.insert(0, SystemMessage(content=disc))
    reuse_tool = _agents._tool_reuse_note(history)
    if reuse_tool:
        lc_history.insert(0, SystemMessage(content=reuse_tool))

    # User content (attached files + scout + prompt; images as content parts).
    user_parts: list[Any] = []
    if attached:
        user_parts.append(
            "===== START OF ATTACHED FILES =====\n" + "\n\n".join(attached)
            + "\n===== END OF ATTACHED FILES ====="
        )
    if scouted:
        user_parts.append(scouted)
    if prompt:
        user_parts.append(prompt)
    # When a vision model is configured we analyze the attached images
    # SERVER-SIDE (with the vision model) and inject the result, so the main
    # model always "sees" them — it cannot view the raw image (stripped below)
    # and must not have to remember to call a vision tool. The vision model is
    # used directly; there is no fallback to the main model.
    if image_uris and vision_model:
        _analysis = await _vision_analyze(vision_model, image_uris)
        if _analysis:
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s); this is what they show]\n{_analysis}"
            )
        else:
            user_parts.append(
                f"[ATTACHED IMAGE ANALYSIS — the user attached {len(image_uris)} "
                f"image(s) but the configured vision model "
                f"({getattr(vision_model, 'model_name', '') or 'unknown'}) failed to "
                f"analyze them. It may not support images or is misconfigured in "
                f"Settings → Subagents → Vision.]"
            )
    elif image_uris:
        # No vision model: the raw images are attached directly to the main
        # model below, so just note their presence.
        user_parts.append(
            f"[context] {len(image_uris)} image(s) are attached and visible to you as "
            "image content."
        )
    user_content: Any
    if image_uris and (not vision_model or not vision_tool_available):
        content_blocks = [{"type": "text", "text": "\n\n".join(user_parts)}]
        for uri in image_uris:
            content_blocks.append({"type": "image_url", "image_url": {"url": uri}})
        user_content = content_blocks
    else:
        user_content = "\n\n".join(user_parts)

    messages: list[BaseMessage] = [SystemMessage(content=system_final)]
    messages.extend(lc_history)
    messages.append(HumanMessage(content=user_content))

    # Convert the mode-filtered fns to LangChain StructuredTools.
    lc_tools = [
        StructuredTool.from_function(func=fn, name=name, description=(fn.__doc__ or name))
        for name, fn in filtered.items()
    ]

    return {
        "model": model,
        "messages": messages,
        "tools": filtered,
        "lc_tools": lc_tools,
        "system_final": system_final,
        "ctx": ctx,
        "scoped_paths": scoped_paths,
        "store": store,
        "web_model": web_model,
        "compact_model": compact_model,
        "vision_model": vision_model,
        "main_model": model,
        "prompt": prompt,
    }


def model_timeout_for(state: AgentState) -> float:
    from providers import model_timeout

    mt = model_timeout(provider=state["provider"], total=300)
    if isinstance(mt, tuple(mt.__class__ for mt in ()) or ()):
        pass
    # httpx.Timeout (non-Google) -> use its read component as the request timeout.
    try:
        import httpx

        if isinstance(mt, httpx.Timeout):
            return float(mt.read)
    except Exception:  # noqa: BLE001
        pass
    return float(mt)


# ---------------------------------------------------------------------------
# Shared LLM tool-loop runner (LangChain)
# ---------------------------------------------------------------------------


def _usage_event_from_ai(ai: Any, model: str) -> dict | None:
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
    cache_read = 0
    cache_write = 0
    details = um.get("input_token_details") or {}
    if isinstance(details, dict):
        cache_read = int(
            details.get("cached_tokens") or details.get("cache_read_tokens") or 0
        )
    return {
        "kind": "usage",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "model": model or "",
    }


async def _run_mode_turn(
    state: AgentState,
    mode: str,
    queue: asyncio.Queue,
    extra_instruction: str = "",
) -> str:
    """Run ONE LLM turn for ``mode`` with the mode-filtered tools.

    Streams text/tool events into ``queue``. Applies the *essential* resilience:
    live steer injection, interrupted-turn resume, free-tier throttle retry, and
    a bounded context auto-compact. Returns the final reply text.
    """
    chat_id = state.get("chat_id", "")
    ctx = state.get("context_window") or 0
    tctx = await build_turn_context(state, queue)
    model = tctx["model"]
    # The real model id the LangChain client will hit (e.g. a sub-agent model
    # resolved for web/compact/vision), used to attribute usage correctly.
    model_id = getattr(model, "model_name", None) or state.get("model_name", "")
    lc_tools = tctx["lc_tools"]
    filtered = tctx["tools"]
    messages: list[BaseMessage] = list(tctx["messages"])

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
        while steps < MAX_STEPS:
            steps += 1
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
                async for chunk in bound.astream(msgs):
                    _astream_count_local += 1
                    ai = chunk if ai is None else ai + chunk
                    content = chunk.content
                    if isinstance(content, str) and content:
                        queue.put_nowait({"kind": "text", "content": content})
                    elif isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                queue.put_nowait({"kind": "text", "content": part["text"]})
                if ai is None:
                    break
                _astream_count_local_val = _astream_count_local
                # Surface token usage so the frontend can show per-model cost in
                # the sidebar and a real consumed-context meter in the title bar.
                usage_ev = _usage_event_from_ai(ai, model_id)
                if usage_ev:
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
                raise exc
            if not getattr(ai, "tool_calls", None):
                meta = getattr(ai, "response_metadata", {}) or {}
                if meta.get("finish_reason") == "length":
                    raise ProviderError(
                        "model response truncated (context length exceeded)"
                    )
                reply = ai.content if isinstance(ai.content, str) else str(ai.content)
                break
            msgs.append(ai)
            for tc in ai.tool_calls:
                name = tc.get("name") or ""
                args = tc.get("args") or {}
                # The tool callback emits its own `tool` / `tool_result` events
                # (via the emit callback wired into make_tool_callbacks), so we
                # only execute it and feed the result back to the model.
                result = await _execute_tool(name, args)
                msgs.append(
                    ToolMessage(content=str(result), tool_call_id=tc.get("id", ""))
                )
        return reply

    # Essentials retry: free-tier throttle (429 transient) with backoff.
    reply = ""
    attempt = 0
    while True:
        attempt += 1
        try:
            reply = await _inner()
            break
        except Exception as exc:  # noqa: BLE001
            if _agents._is_transient_throttle(exc) and attempt < _agents._THROTTLE_MAX_ATTEMPTS:
                delay = _agents._THROTTLE_BASE_SECONDS
                if not isinstance(delay, (int, float)) or delay < 0:
                    delay = 30
                queue.put_nowait(
                    {
                        "kind": "retry", "attempt": attempt,
                        "max_attempts": _agents._THROTTLE_MAX_ATTEMPTS, "delay": delay,
                        "reason": "free-tier rate limit -- waiting and retrying",
                    }
                )
                await asyncio.sleep(delay)
                continue
            # Non-retryable failure: surface a friendly error event.
            queue.put_nowait(
                {"kind": "error", "content": _agents._friendly_retry_reason(exc)}
            )
            break
    return reply


# ---------------------------------------------------------------------------
# Test command detection + Test / Debug / Review nodes
# ---------------------------------------------------------------------------


def detect_test_command(root: str) -> str | None:
    """Find the project's existing test/build/type-check command."""
    import os

    pkg = os.path.join(root, "package.json")
    if os.path.isfile(pkg):
        try:
            data = json.loads(open(pkg, encoding="utf-8").read())
        except Exception:  # noqa: BLE001
            data = {}
        scripts = (data.get("scripts") or {}) if isinstance(data, dict) else {}
        if "test" in scripts:
            test = str(scripts["test"])
            if "vitest" in test or "jest" in test:
                return "npm test"
            return "npm test"
    if os.path.isfile(os.path.join(root, "pyproject.toml")):
        return "uv run pytest"
    if os.path.isfile(os.path.join(root, "pytest.ini")) or os.path.isfile(
        os.path.join(root, "setup.py")
    ):
        return "pytest"
    if os.path.isfile(os.path.join(root, "Cargo.toml")):
        return "cargo test"
    if os.path.isfile(os.path.join(root, "go.mod")):
        return "go test ./..."
    return None


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------


def router(state: AgentState) -> dict:
    """Determine the requested mode (ASK / PLAN / CODER)."""
    mode = classify_mode(state.get("request", ""), state.get("mode", "ask"))
    return {"mode": mode}


async def ask_node(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "ask", queue)
    return {"final_response": reply}


async def plan_node(state: AgentState) -> dict:
    queue = state["_queue"]
    reply = await _run_mode_turn(state, "plan", queue)
    # Persist the plan so Coder can pick it up next turn / this turn.
    try:
        if reply.strip().startswith("## Plan"):
            from tools import slugify

            ws = slugify(os.path.basename(os.path.realpath(state["root"]).rstrip(os.sep))) or "workspace"
            state_db.save_plan(ws, "plan", reply, chat_id=state.get("chat_id", ""))
    except Exception:  # noqa: BLE001
        pass
    return {"plan": reply, "final_response": reply}


async def coder_entry(state: AgentState) -> dict:
    # If a plan already exists (in state or persisted), Coder implements from it
    # and skips the repo-discovery pipeline. Otherwise Coder runs discovery just
    # like plan, then implements from the gathered context. The coder->test->
    # debug->coder loop never re-enters this node, so discovery runs at most once.
    return {}


def _route_coder_entry(state: AgentState) -> str:
    if state.get("plan") or state.get("read_context"):
        return "coder"
    try:
        saved = _agents._load_saved_plan(
            state["root"], chat_id=state.get("chat_id", "")
        )
    except Exception:  # noqa: BLE001
        saved = ""
    return "coder" if saved else "repo_derive"


async def coder_node(state: AgentState) -> dict:
    queue = state["_queue"]
    extra = (
        _build_explore_context(state)
        if (state.get("read_context") or state.get("grep_results"))
        else ""
    )
    reply = await _run_mode_turn(state, "coder", queue, extra_instruction=extra)
    return {"coder_result": reply, "final_response": reply}


def test_node(state: AgentState) -> dict:
    """Run the project's existing test/build/type-check tooling.

    Uses ``tools.run_terminal`` (the same tool the agent uses) so the command is
    sandboxed to the workspace root. Produces structured results.
    """
    queue = state["_queue"]
    root = state["root"]
    cmd = detect_test_command(root)
    if not cmd:
        # Nothing to run — don't emit a misleading error event. The turn simply
        # proceeds to review with no test gate.
        return {
            "test_results": {"passed": True, "errors": [], "output": "no tests configured"},
            "test_status": "pass",
        }
    queue.put_nowait({"kind": "tool", "tool": "run_terminal", "args": {"command": cmd}})
    from tools import run_terminal

    result = run_terminal(root, cmd, timeout=300)
    exit_code = result.get("exit_code", 1)
    output = str(result.get("output", ""))
    passed = exit_code == 0
    queue.put_nowait(
        {
            "kind": "tool_result", "tool": "run_terminal",
            "summary": f"exit={exit_code} ({'pass' if passed else 'fail'})",
            "status": "ok" if passed else "error",
        }
    )
    return {
        "test_results": {
            "passed": passed,
            "failed": not passed,
            "errors": [] if passed else [output[-2000:]],
            "output": output[-4000:],
        },
        "test_status": "pass" if passed else "fail",
    }


def debug_node(state: AgentState) -> dict:
    """Analyze the test failure and produce instructions for Coder.

    DEBUG must not modify files -- it only inspects the failure and increments
    the bounded attempt counter.
    """
    queue = state["_queue"]
    attempts = int(state.get("debug_attempts", 0)) + 1
    results = state.get("test_results") or {}
    info = (
        "TESTS FAILED. Fix the code so the project's tests pass.\n"
        f"Exit: {'pass' if results.get('passed') else 'fail'}\n"
        f"Output (tail):\n{str(results.get('output', ''))[-2000:]}"
    )
    queue.put_nowait({"kind": "debug", "attempt": attempts, "info": info[:1500]})
    return {"debug_info": info, "debug_attempts": attempts}


def review_node(state: AgentState) -> dict:
    """Verify the implementation against the request / plan / tests.

    Read-only. Produces a structured review result. When tests passed and a
    Coder result exists, the review is marked approved.
    """
    queue = state["_queue"]
    test_status = state.get("test_status", "pass")
    plan = state.get("plan", "")
    coder = state.get("coder_result", "")
    approved = test_status == "pass" and bool(coder)
    notes = []
    if test_status != "pass":
        notes.append("tests did not pass")
    if not coder:
        notes.append("no implementation produced")
    if plan and "## Plan" not in plan and not coder:
        notes.append("no plan/implementation to review")
    result = "APPROVED" if approved else "NEEDS WORK: " + "; ".join(notes)
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
    "py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp", "cc",
    "h", "hpp", "rb", "php", "cs", "swift", "kt", "kts", "md", "mdx", "json",
    "yaml", "yml", "toml", "sh", "bash", "zsh", "sql", "html", "htm", "css",
    "scss", "less", "vue", "svelte", "lua", "r", "m", "pl", "pm", "dart",
    "ex", "exs", "erl", "clj", "scm", "hs", "ml", "fs", "fsx", "nim", "zig",
    "groovy", "gradle", "xml", "ini", "cfg", "conf", "env",
}

_STOPWORDS = set(
    """
    what where which when how does the and for with that this from into your you
    are is it of to a an do i we they file files code function class mode plan
    ask use using need want find search show list explain describe trace
    understand investigate look looking who why can could should would may
    might repo repository project inside their our its as at by be been has have
    had will would not no yes
    """.split()
)


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

    # 6. tree root from a mentioned top-level dir (a/b/...).
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
        t = t[start:end + 1]
    try:
        obj = json.loads(t)
    except Exception:  # noqa: BLE001
        return None
    return obj if isinstance(obj, dict) else None


_LLM_DERIVE_SYSTEM = (
    "You are a repository SEARCH PLANNER. Given the user's REQUEST and a "
    "truncated REPO TREE, output ONLY a JSON object (no prose, no markdown "
    'fences) with these keys:\n'
    '  "queries":  [natural-language phrases to investigate, e.g. '
    '"authentication timeout"],\n'
    '  "globs":    [glob patterns, e.g. "**/*auth*", "src/**/*.ts"],\n'
    '  "keywords": [regex terms to grep, e.g. "timeout", "session"].\n'
    "Prefer real paths that appear in the REPO TREE. Keep it focused: "
    "queries<=8, globs<=10, keywords<=12. If the request is not about the "
    "repository, return empty lists."
)


async def _llm_derive_explore_patterns(request: str, tree_str: str, model) -> dict | None:
    """Single LLM call that turns the request into a search plan.

    Returns {"glob":[...], "grep":[...], "queries":[...]} or None on any
    failure, so the caller can fall back to the deterministic derivation.
    """
    user = f"REQUEST:\n{request or ''}\n\nREPO TREE (truncated):\n{tree_str or '(empty)'}"
    try:
        text, _ = await llm_generate(model, system=_LLM_DERIVE_SYSTEM, user=user)
    except Exception:  # noqa: BLE001
        return None
    obj = _extract_json_object(text)
    if not obj:
        return None
    glob = _as_list(obj.get("globs"))
    grep = _as_list(obj.get("keywords"))
    queries = _as_list(obj.get("queries"))
    if not (glob or grep or queries):
        return None
    return {"glob": glob, "grep": grep, "queries": queries}


def _make_explore_tools(state: AgentState, queue: asyncio.Queue) -> dict:
    """Build the glob/grep/read tool callbacks (no network, no extra LLM)."""
    root = state["root"]
    image_uris = _agents._load_images(state.get("images"))
    ctx = int(state.get("context_window") or 0) or _agents.DEFAULT_CONTEXT_WINDOW_FLOOR
    model = build_chat_model(
        state["provider"], state["model_name"], state["base_url"],
        state["api_key"], state["env_var"], state["oauth_token"],
    )
    from tools import open_vector_store

    store = open_vector_store(
        root, state.get("vector_db_path", ""), state.get("vector_config")
    )
    return make_tool_callbacks(
        root, lambda ev: queue.put_nowait(ev),
        context_window=ctx, web_model=model, main_model=model,
        vision_model=None, image_uris=image_uris,
        permission_gates=state.get("permission_gates"),
        ask_gates=state.get("ask_gates"),
        permit={"outside": bool(state.get("allow_outside"))},
        store=store, chat_id=state.get("chat_id", ""),
    )


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
        if not line or line.startswith("GLOB MATCHES") or line.startswith("("):
            continue
        if "/" in line or re.match(r"^[\w.\-]+\.\w+$", line):
            out.append(line)
    return out


def _parse_grep_files(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").splitlines():
        m = re.match(r"^([^\s:]+):\d+:", line)
        if m:
            out.append(m.group(1))
    return out


def _build_tree(root: str, max_depth: int = 3, max_entries: int = 400) -> str:
    import os

    lines: list[str] = []
    count = 0
    skip_dirs = {
        ".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
        "build", "target", ".mypy_cache", ".pytest_cache",
    }
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base):].count(os.sep)
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
        ".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
        "build", "target", ".mypy_cache", ".pytest_cache", ".next", "out",
        "coverage", ".idea", ".vscode", ".turbo",
    }
    out: list[str] = []
    base = root.rstrip(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(base):].count(os.sep)
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
            out.append(os.path.relpath(os.path.join(dirpath, f), root))
            if len(out) >= max_files:
                return out
    return out


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


_IMPORT_RE = re.compile(
    r"""(?mx)
    ^[^\S\n]*(?:
        from\s+([.\w]+)\s+import\s+([\w,\s]+)
      | import\s+([.\w]+)
      | import\s+[^\n'"]*?from\s+['"]([^'"]+)['"]
      | require\(\s*['"]([^'"]+)['"]\s*\)
      | import\s+['"]([^'"]+)['"]
      | export[^\n'"]*?from\s+['"]([^'"]+)['"]
    )"""
)


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


def _build_explore_context(state: AgentState) -> str:
    parts = [
        "REPOSITORY EXPLORATION RESULTS (gathered deterministically -- do NOT "
        "call glob/grep/read; use web_search/fetch_url/vision only if the "
        "question needs external info or attached images):"
    ]
    if state.get("explore_tree"):
        parts.append("PROJECT TREE:\n" + state["explore_tree"])
    greps = state.get("grep_results") or []
    if greps:
        parts.append("GREP MATCHES:\n" + "\n\n".join(greps)[:40000])
    rc = state.get("read_context", "")
    if rc:
        parts.append("FILE CONTENTS READ:\n" + rc)
    return "\n\n".join(parts)


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
        except Exception:  # noqa: BLE001
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


# ----- Repo-discovery nodes (deterministic) -------------------------------


async def repo_derive(state: AgentState) -> dict:
    queue = state["_queue"]
    request = state.get("request", "")
    # Single LLM call to PLAN the search; falls back to the deterministic
    # derivation on any failure (empty/garbled reply, provider error, timeout).
    spec: dict | None = None
    try:
        model = build_chat_model(
            state["provider"], state["model_name"], state["base_url"],
            state["api_key"], state["env_var"], state["oauth_token"],
            temperature=0, thinking_level="none",
            max_tokens=1000, timeout=model_timeout_for(state),
        )
        spec = await _llm_derive_explore_patterns(
            request, _build_tree(state["root"]), model
        )
    except Exception:  # noqa: BLE001
        spec = None
    if spec is None:
        spec = _derive_explore_patterns(request)
        spec["queries"] = spec.get("grep", [])
    # Force any file the user referenced (in THIS turn OR earlier in the
    # conversation) into the search plan, so the LLM planner can't silently drop
    # it (e.g. it focused on the frontend and missed backend/graph.py). This is
    # deterministic post-processing of the SINGLE planner call -- it adds NO
    # extra LLM calls, keeping the budget at one.
    named = _resolve_file_refs(
        [request] + [m.get("content", "") for m in (state.get("history") or [])],
        state["root"],
    )
    if named:
        glob = list(spec.get("glob", []))
        grep = list(spec.get("grep", []))
        for f in named:
            if f not in glob:
                glob.append(f)
            stem = os.path.splitext(os.path.basename(f))[0]
            if stem and stem not in grep:
                grep.append(re.escape(stem))
        spec["glob"] = glob
        spec["grep"] = grep
    queue.put_nowait(
        {
            "kind": "tool", "tool": "repo_search",
            "args": {
                "glob": spec["glob"], "grep": spec["grep"], "queries": spec["queries"],
            },
            "summary": "deriving search patterns (LLM planner + deterministic fallback)",
        }
    )
    queue.put_nowait(
        {
            "kind": "tool_result", "tool": "repo_search",
            "summary": (
                f"{len(spec['glob'])} glob / {len(spec['grep'])} grep / "
                f"{len(spec['queries'])} queries"
            ),
            "status": "ok",
        }
    )
    return {"search_spec": spec, "named_files": named}


async def repo_glob(state: AgentState) -> dict:
    queue = state["_queue"]
    tools = _make_explore_tools(state, queue)
    spec = state.get("search_spec", {}) or {}
    files: list[str] = []
    for pat in spec.get("glob", []):
        queue.put_nowait({"kind": "tool", "tool": "glob", "args": {"pattern": pat}})
        res = await _run_repo_tool(tools, "glob", pattern=pat)
        found = _parse_glob_files(res)
        files.extend(found)
        queue.put_nowait(
            {"kind": "tool_result", "tool": "glob", "summary": f"{len(found)} files", "status": "ok"}
        )
    seen: set[str] = set()
    uniq = [f for f in files if not (f in seen or seen.add(f))]
    return {"explore_glob": uniq}


async def repo_grep(state: AgentState) -> dict:
    queue = state["_queue"]
    tools = _make_explore_tools(state, queue)
    spec = state.get("search_spec", {}) or {}
    # LLM planner "queries" become verbatim phrase-grep patterns, on top of the
    # structural "keywords" (the grep field).
    patterns = list(
        dict.fromkeys((spec.get("grep", []) or []) + (spec.get("queries", []) or []))
    )
    files: list[str] = []
    raw: list[str] = []
    for pat in patterns:
        queue.put_nowait({"kind": "tool", "tool": "grep", "args": {"pattern": pat}})
        res = await _run_repo_tool(tools, "grep", pattern=pat)
        raw.append(res)
        files.extend(_parse_grep_files(res))
        queue.put_nowait(
            {"kind": "tool_result", "tool": "grep", "summary": "done", "status": "ok"}
        )
    seen: set[str] = set()
    uniq = [f for f in files if not (f in seen or seen.add(f))]
    return {"explore_grep": uniq, "grep_results": raw}


async def repo_collect(state: AgentState) -> dict:
    """Backfill + expand the discovered candidate set (kept as a standalone node
    for callers that still fan-out; the default pipeline folds this into
    ``repo_read``)."""
    queue = state["_queue"]
    spec = state.get("search_spec", {}) or {}
    rank_text = " ".join(spec.get("queries", []) or []) or (state.get("request", "") or "")
    files = list(
        dict.fromkeys(
            (state.get("explore_glob", []) or []) + (state.get("explore_grep", []) or [])
        )
    )
    MIN_CANDIDATES = 18
    if len(files) < MIN_CANDIDATES:
        ranked = _rank_files_by_prompt(_repo_source_files(state["root"]), rank_text)
        seen = set(files)
        for f in ranked:
            if f not in seen:
                files.append(f)
                seen.add(f)
            if len(files) >= 80:
                break
    files = _expand_imports(state["root"], files)
    top = files[:80]
    queue.put_nowait(
        {
            "kind": "tool", "tool": "collect",
            "args": {"candidates": len(top)},
            "summary": f"collected {len(top)} candidate files",
        }
    )
    queue.put_nowait(
        {"kind": "tool_result", "tool": "collect", "summary": f"{len(top)} files", "status": "ok"}
    )
    return {"candidate_files": top}


MAX_EXPLORE_READ_FILES = 30
MAX_EXPLORE_READ_CHARS = 60_000


async def repo_read(state: AgentState) -> dict:
    queue = state["_queue"]
    # Gather candidates from the deterministic glob + grep passes, backfill when
    # they surface little, and expand directly-imported files -- then read the
    # top candidates. This folds the old `repo_tree`/`repo_collect` fan-out into a
    # single sequential step so the pipeline is: derive -> glob -> grep -> read.
    spec = state.get("search_spec", {}) or {}
    rank_text = " ".join(spec.get("queries", []) or []) or (state.get("request", "") or "")
    files = list(
        dict.fromkeys(
            (state.get("explore_glob", []) or []) + (state.get("explore_grep", []) or [])
        )
    )
    # Force any referenced file(s) to the FRONT of the read list so they are
    # always read, even if glob/grep/ranking did not surface them. Defense in
    # depth on top of the repo_derive augmentation above.
    named = state.get("named_files")
    if named is None:
        named = _resolve_file_refs(
            [state.get("request", "")]
            + [m.get("content", "") for m in (state.get("history") or [])],
            state["root"],
        )
    if named:
        files = list(dict.fromkeys(list(named) + files))
    MIN_CANDIDATES = 18
    if len(files) < MIN_CANDIDATES:
        ranked = _rank_files_by_prompt(_repo_source_files(state["root"]), rank_text)
        seen = set(files)
        for f in ranked:
            if f not in seen:
                files.append(f)
                seen.add(f)
            if len(files) >= 80:
                break
    files = _expand_imports(state["root"], files)
    top = files[:MAX_EXPLORE_READ_FILES]
    tools = _make_explore_tools(state, queue)
    parts: list[str] = []
    total = 0
    for f in top:
        queue.put_nowait({"kind": "tool", "tool": "read", "args": {"filePath": f}})
        res = await _run_repo_tool(tools, "read", filePath=f, limit=400)
        snippet = f"=== {f} ===\n{res}"
        parts.append(snippet)
        total += len(snippet)
        queue.put_nowait(
            {"kind": "tool_result", "tool": "read", "summary": f"read {f}", "status": "ok"}
        )
        if total >= MAX_EXPLORE_READ_CHARS:
            break
    return {"read_context": "\n\n".join(parts)}


# ----- Mode nodes that consume the deterministic context ------------------


_ASK_REPO_CUES = re.compile(
    r"what files|which file|which files|where is|where are|locate|"
    r"search the repo|how does .* work|trace|investigate|implementation of|"
    r"explain .* code|which module|which function|which class|codebase|"
    r"repository|repo\b|this project|the project|source code|what does .* do|"
    r"کجا(ست)?|پیدا کن|تابع|فایل|کد|پروژه|مخزن|پیاده|چطور کار|ماژول|کلاس",
    re.I,
)


# Explicit user cues that mean "look at the saved memory now" (so we recall it
# outside the first-message auto-recall). Persian + English; the user's own word
# for memory is "مموری".
_MEMORY_RECALL_CUES = re.compile(
    r"از مموری|مموری|در حافظه|یادآوری|حافظه|"
    r"look in memory|from memory|search memory|check memory|what.?s in memory|"
    r"recall|remember",
    re.I,
)


def _ask_needs_repo(text: str) -> bool:
    """True when an ask-mode question is about the project/codebase and should
    run the deterministic repo-discovery pipeline (instead of answering from
    general knowledge). Deliberately excludes chit-chat ("who/they are you",
    "hello", plain conceptual questions like "what is a closure")."""
    return bool(_ASK_REPO_CUES.search(text or ""))


async def ask_entry(state: AgentState) -> dict:
    # Ask is a GENERAL assistant. It runs the deterministic repo-discovery
    # pipeline only when the question is project/code-related (gated in
    # _route_ask_entry); for general questions it answers directly. Ask is
    # denied glob/grep/read, so when it DOES discover it consumes the result
    # and never re-searches from scratch.
    return {}


def _route_ask_entry(state: AgentState) -> str:
    request = state.get("request", "")
    # Explore when a real file is referenced (this turn OR earlier in the
    # conversation) -- e.g. the user says "ببینش" about a file named turns ago.
    if _resolve_file_refs(
        [request] + [m.get("content", "") for m in (state.get("history") or [])],
        state["root"],
    ):
        return "repo_derive"
    if _ask_needs_repo(request):
        return "repo_derive"
    return "ask_answer"


async def ask_answer(state: AgentState) -> dict:
    queue = state["_queue"]
    extra = (
        _build_explore_context(state)
        if (state.get("read_context") or state.get("grep_results"))
        else ""
    )
    reply = await _run_mode_turn(state, "ask", queue, extra_instruction=extra)
    return {"final_response": reply}


async def plan_understand(state: AgentState) -> dict:
    # Deterministic comprehension is folded into repo_derive; this node exists so
    # the PLAN flow has an explicit "understand -> discover" shape.
    return {}


async def plan_build(state: AgentState) -> dict:
    queue = state["_queue"]
    extra = _build_explore_context(state)
    reply = await _run_mode_turn(state, "plan", queue, extra_instruction=extra)
    try:
        if reply.strip().startswith("## Plan"):
            from tools import slugify

            ws = slugify(os.path.basename(os.path.realpath(state["root"]).rstrip(os.sep))) or "workspace"
            state_db.save_plan(ws, "plan", reply, chat_id=state.get("chat_id", ""))
    except Exception:  # noqa: BLE001
        pass
    return {"plan": reply, "plan_attempts": int(state.get("plan_attempts", 0)) + 1}


async def plan_validate(state: AgentState) -> dict:
    queue = state["_queue"]
    plan = state.get("plan", "")
    valid = plan.strip().startswith("## Plan") and "Files:" in plan
    queue.put_nowait({"kind": "plan_validate", "valid": valid})
    return {"plan_valid": valid}


async def explore_analyze(state: AgentState) -> dict:
    queue = state["_queue"]
    extra = _build_explore_context(state)
    reply = await _run_mode_turn(state, "explore", queue, extra_instruction=extra)
    return {"explore_answer": reply, "final_response": reply}


def _route_repo_dispatch(state: AgentState) -> str:
    mode = state.get("mode")
    if mode == "plan":
        return "plan_build"
    if mode == "explore":
        return "explore_analyze"
    if mode == "coder":
        return "coder"
    return "ask_answer"


def _route_plan_validate(state: AgentState) -> str:
    if state.get("plan_valid"):
        return "coder"
    if int(state.get("plan_attempts", 0)) < 2:
        return "plan_build"
    return "coder"


def _route_mode(state: AgentState) -> str:
    return state.get("mode", "ask")


def _route_test(state: AgentState) -> str:
    return "pass" if state.get("test_status") == "pass" else "fail"


def _route_debug(state: AgentState) -> str:
    if int(state.get("debug_attempts", 0)) < int(state.get("max_debug_attempts", MAX_DEBUG_ATTEMPTS)):
        return "coder"
    return "review"


def build_graph():
    """Compile the LangGraph state machine for the agent workflow."""
    g = StateGraph(AgentState)
    # Router + existing test/debug/review/done tail.
    g.add_node("router", router)
    g.add_node("coder", coder_node)
    # CODER entry: if a plan exists, implement from it (skip discovery);
    # otherwise run the repo-discovery pipeline first, then implement.
    g.add_node("coder_entry", coder_entry)
    g.add_conditional_edges(
        "coder_entry", _route_coder_entry,
        {"coder": "coder", "repo_derive": "repo_derive"},
    )
    g.add_node("test", test_node)
    g.add_node("debug", debug_node)
    g.add_node("review", review_node)
    g.add_node("done", done_node)
    # ASK flow: general assistant that runs the deterministic repo-discovery
    # pipeline ONLY when the question is project-related (ask_entry gate);
    # otherwise it answers directly. Ask is denied glob/grep/read, so when it
    # does discover it consumes the result and never re-searches from scratch.
    g.add_node("ask_entry", ask_entry)
    g.add_node("ask_answer", ask_answer)
    g.add_conditional_edges(
        "ask_entry", _route_ask_entry,
        {"repo_derive": "repo_derive", "ask_answer": "ask_answer"},
    )
    g.add_edge("ask_answer", "done")
    # PLAN flow.
    g.add_node("plan_understand", plan_understand)
    g.add_node("plan_build", plan_build)
    g.add_node("plan_validate", plan_validate)
    # EXPLORE flow.
    g.add_node("explore_analyze", explore_analyze)
    # Shared deterministic repo-discovery workflow (sequential).
    g.add_node("repo_derive", repo_derive)
    g.add_node("repo_glob", repo_glob)
    g.add_node("repo_grep", repo_grep)
    g.add_node("repo_read", repo_read)

    g.add_edge(START, "router")
    g.add_conditional_edges(
        "router", _route_mode,
        {"ask": "ask_entry", "plan": "plan_understand", "coder": "coder_entry", "explore": "repo_derive"},
    )

    # PLAN: understand -> discover -> build -> validate (loop) -> coder.
    g.add_edge("plan_understand", "repo_derive")
    g.add_edge("plan_build", "plan_validate")
    g.add_conditional_edges(
        "plan_validate", _route_plan_validate,
        {"plan_build": "plan_build", "coder": "coder"},
    )

    # EXPLORE: discover -> analyze -> done.
    g.add_edge("explore_analyze", "done")

    # Shared repo-discovery pipeline: ONE LLM planner call, then sequential
    # glob -> grep -> read. The agent (plan_build / explore_analyze) consumes the
    # gathered context and has NO glob/grep/read tools, so it never re-searches
    # the repo from scratch.
    g.add_edge("repo_derive", "repo_glob")
    g.add_edge("repo_glob", "repo_grep")
    g.add_edge("repo_grep", "repo_read")
    g.add_conditional_edges(
        "repo_read", _route_repo_dispatch,
        {"plan_build": "plan_build", "explore_analyze": "explore_analyze",
         "coder": "coder", "ask_answer": "ask_answer"},
    )

    # CODER tail (unchanged).
    g.add_edge("coder", "test")
    g.add_conditional_edges("test", _route_test, {"pass": "review", "fail": "debug"})
    g.add_conditional_edges("debug", _route_debug, {"coder": "coder", "review": "review"})
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
    initial.setdefault("debug_attempts", 0)
    initial.setdefault("max_debug_attempts", MAX_DEBUG_ATTEMPTS)
    if not (initial.get("request") or "").strip():
        yield {"kind": "error", "content": "empty or whitespace-only prompt — refusing to run"}
        return
    graph = build_graph()

    async def _drive() -> None:
        try:
            async for _ in graph.astream(initial, stream_mode="updates"):
                pass
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
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass









