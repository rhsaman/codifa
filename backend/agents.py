"""LangGraph agents for the two UI modes.

* ``ask``   -> conversational coding assistant (conservative tool use)
* ``build`` -> autonomous code-writing agent (proactive tool use)

Tools are registered per-run, bound to the sandboxed ROOT, and emit live
activity events that the server forwards over SSE so the UI can render tool
calls as they happen.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import warnings
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

logger = logging.getLogger(__name__)

warnings.filterwarnings(
    "ignore",
    message="Sampling parameters.*reasoning",
    category=UserWarning,
)

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

import state_db
from providers import (
    _expand_base,
    _provider_meta,
)
from tools import (
    LOG_FILENAME,
    _is_terminal_search,
    list_files,
    read_file,
    resolve_safe,
    slugify,
    user_coder_dir,
)

# Steer messages injected into a RUNNING agent without interrupting it. Keyed
# by chat_id; each entry is {"id", "prompt", "attachments", "images",
# "mcp_servers", "skills"}. The frontend POSTs here while the agent is
# mid-run; the tool wrapper drains them into the next tool call's result, so
# the model reads the user's message on its very next request after the
# current tool — no abort, no waiting for the answer to finish.
STEER_INBOX: dict[str, list[dict]] = {}
_STEER_LOCK = asyncio.Lock()


async def _drain_steer(chat_id: str) -> list[dict]:
    """Pop and return all pending steer messages for a chat.

    Also drops the chat's entry from the inbox so long-running sessions don't
    accumulate empty buckets for every chat that ever received a steer.
    """
    async with _STEER_LOCK:
        items = STEER_INBOX.pop(chat_id, [])
        return items


async def _enqueue_steer(chat_id: str, item: dict) -> None:
    async with _STEER_LOCK:
        STEER_INBOX.setdefault(chat_id, []).append(item)


async def _remove_steer(chat_id: str, steer_id: str) -> None:
    """Drop a single pending steer message (user cancelled it before delivery)."""
    async with _STEER_LOCK:
        items = STEER_INBOX.get(chat_id) or []
        STEER_INBOX[chat_id] = [it for it in items if it.get("id") != steer_id]


# Read-only terminal is for *review/verification only*, NEVER for code
# discovery. Code search/discovery (ls/find/cat/sed/awk/head/tail/wc/grep and
# git history) is rejected by the inner `_wrap_no_search_bypass` — and we also
# don't even allowlist it here, so a planner in plan/ask mode physically cannot
# shell out to `ls`/`cat`/`sed`/`wc` to hunt for files (it must use the
# sub-agent context or ask_user instead).
_READONLY_TERMINAL_PATTERNS = [
    r"^\s*git\s+(status|diff)\b",  # git status + plain git diff (working-tree review)
    r"^\s*pwd\b",
    r"^\s*(node|python(3)?|python3|ruby|php|go|cargo|npm|npx|pnpm|yarn|deno|flutter|dart)\s+(-\w+\s+)?(--?version|-v)\b",
    r"^\s*(npm|pnpm|yarn)\s+(run\s+)?\S*test\S*\b",  # test, test:frontend, test:e2e
    r"^\s*(npm|pnpm|yarn)\s+(run\s+)?(lint|build)\b",
    (
        r"^\s*(pytest|mypy|ruff\s+check|flake8|eslint|tsc\s+--noEmit|vitest|jest|"
        r"vitest run|jest run|ava|xo|playwright test|cypress run|flutter test|dart test)\b"
    ),
]

# ANY match on the FULL command string makes it unsafe for a read-only terminal.
# This is the authoritative second layer: a command is allowed only when its
# first token matches an allowlisted prefix above AND none of these markers
# appear anywhere. Without this, e.g. `echo x && rm -rf y`, `sed -i ...` or
# `echo foo > file` would slip through the prefix check and mutate the project.
_MUTATION_MARKERS = [
    r"[>;]|&&|\|\||\$\(",
    r"`",
    r"\b(tee|touch|mkdir|rm|mv|cp|ln|dd|chmod|chown|chgrp|truncate|unlink|printf|install|yes|unzip|tar|xargs|sudo)\b",
    r"\bsed\b[^|]*\s+-i\b",
    r"\bgit\s+(add|commit|push|pull|fetch|checkout|reset|stash|clean|merge|rebase|switch|restore|rm|mv|init|clone|apply|revert|branch\s+-[dD])\b",
    r"\b(sh|bash|zsh|fish|source|exec)\b",
    r"\s-{1,2}(fix|write|in-place|delete|exec|ok)\b",
]

def _is_background_launch(command: str) -> bool:
    """True when the command requests detached background execution.

    Generic across stacks: a leading ``bg:`` request prefix or a background
    marker (trailing ``&``, leading ``nohup``, ``[background]`` /
    ``CODIFA_BACKGROUND``) marks a long-lived launch of the project's own
    start command (discovered from its manifest, never assumed here).
    """
    text = str(command or "")
    if text.strip().lower().startswith("bg:"):
        return True
    return bool(_BACKGROUND_MARKER_RE.search(text))

# Background-execution marker exempt from the mutation filter. Dev servers run
# detached (trailing `&`, leading `nohup`, or an explicit [background] /
# CODIFA_BACKGROUND token); the marker itself is not a mutation and must not
# veto an otherwise allowlisted dev launch.
_BACKGROUND_MARKER_RE = re.compile(
    r"\s*\[background\]\s*|\s*CODIFA_BACKGROUND\s*|\s+&\s*$|^\s*nohup\s+",
    re.IGNORECASE,
)


def _readonly_allowed(command: str) -> bool:
    # Mutation markers always veto the command, even when its first token would
    # otherwise match an allowlisted prefix. A background-execution marker is
    # stripped first so a detached launch is not vetoed by its own marker.
    check = _BACKGROUND_MARKER_RE.sub(" ", command or "")
    if check.strip().lower().startswith("bg:"):
        check = check.strip()[3:]
    if any(re.search(m, check) for m in _MUTATION_MARKERS):
        return False
    # A detached background launch of the project's own start command is
    # allowed for any stack (discovered from its manifest, never assumed);
    # the dangerous-command blacklist in tools still applies.
    if _is_background_launch(command):
        return True
    for pat in _READONLY_TERMINAL_PATTERNS:
        if re.search(pat, check):
            return True
    return False


_TERMIN_TOKENS = re.compile(r'"((?:\\.|[^"\\])*)"|\'((?:\\.|[^\'\\])*)\'|(\S+)')


























def _wrap_readonly_terminal(fn: Callable):
    """Wrap a terminal tool so only read-only commands are allowed. Any
    non-allowed command returns an error message instead of running."""

    async def wrapped(command: str, timeout: int = 120, _timeout: int | None = None, **kwargs) -> str:
        if not _readonly_allowed(command):
            return (
                f"ERROR: run_terminal is read-only in this mode. "
                f"Command not allowlisted: {command!r}"
            )
        _eff = _timeout if _timeout is not None else timeout
        try:
            return await fn(command, timeout=_eff)
        except TypeError:
            return await fn(command)

    return wrapped


# grep-family tools reachable via run_terminal — all fully replaced by
# grep (single-file/dir). Left
# reachable through the terminal, a model could just shell out to `grep -r`
# instead and keep searching with no isolation — a complete, silent bypass of
# the system prompt's own "use grep" instruction.
# This closes that specific hole; it intentionally does NOT touch find/cat/ls
# (legitimate narrow uses: checking one file exists, reading a build log,
# listing a directory).
_SEARCH_BYPASS_PROGS = {"rg", "grep", "egrep", "fgrep", "ag", "ack", "ack-grep"}
_SEARCH_BYPASS_MSG = (
    "ERROR: {prog} via run_terminal is not allowed — it bypasses the search-call "
    "cap and isolation that grep gives you. Use grep "
    "for a targeted look, or the task tool (subagent_type='subagent') for anything "
    "broader."
)
# A python one-liner doing its own file-walk-and-match is the same bypass in
# a different shape (`python3 -c "import os,re; ..."`). Heuristic, not exact:
# flags `-c`/`-m` python invocations whose inline script mentions file-walk or
# regex-search primitives, which covers the common ad-hoc "grep in python"
# pattern without touching legitimate scripted build/test/tooling commands.
_PY_WALK_RE = re.compile(
    r"\b(os\.walk|glob\.glob|pathlib\.Path\([^)]*\)\.rglob|\.rglob\(|re\.search|re\.findall|re\.match)\b"
)

# git subcommands that are *discovery / history* — they must go through the
# explore pipeline (repo_derive + glob/grep), not be re-implemented by shelling
# out through run_terminal. `git status` and plain `git diff` (working-tree /
# staged review) stay allowed (handled below).
_GIT_SEARCH_SUBS = {
    "log",
    "show",
    "blame",
    "rev-list",
    "whatchanged",
    "shortlog",
    "grep",
    "reflog",
    "ls-files",
    "ls-tree",
}
# A following non-flag token that looks like a historical ref (vs a real file
# path) turns `git diff` into history search that we reject.
_GIT_DIFF_REF_RE = re.compile(r"[~^:]|(\.\.)|^[0-9a-f]{7,40}$", re.IGNORECASE)


def _git_is_history_search(command: str) -> str | None:
    """Reject git commands that do code discovery / history through the
    terminal. Returns an error string or ``None``.

    Applied via ``_wrap_no_search_bypass`` to EVERY mode's run_terminal, so it
    closes the hole where a planner (which has no glob/grep/read of its own in
    plan mode) loops on ``git log`` / ``git show`` / ``git ls-files`` to hunt
    for code instead of using the explore context or asking the user.
    """
    tokens = [g for t in _TERMIN_TOKENS.findall(command) for g in t if str(g).strip()]
    if not tokens:
        return None
    sub = None
    for i, tok in enumerate(tokens):
        if tok == "git":
            for nxt in tokens[i + 1 :]:
                if nxt in ("&&", ";", "|"):
                    continue
                sub = nxt
                break
            break
    if sub is None:
        return None
    sub_base = sub.split("/")[-1].split()[0]
    if sub_base in _GIT_SEARCH_SUBS:
        return (
            "ERROR: `git " + sub_base + "` via run_terminal is not allowed — it "
            "bypasses the explore pipeline. Use the explore context you were given; "
            "if it does not contain what you need, call ask_user with the specific "
            "missing detail (or ask for a fresh explore). `git status` and plain "
            "`git diff` (working-tree review) are allowed."
        )
    if sub_base == "diff":
        # Block diff against a commit/range ref; allow plain / --cached / <path>.
        for tok in tokens:
            if tok.startswith("-") or tok in ("diff", "git", "&&", ";", "|"):
                continue
            if _GIT_DIFF_REF_RE.search(tok) or tok.lower().startswith(
                ("head", "origin/", "upstream/")
            ):
                return (
                    "ERROR: `git diff <ref>` via run_terminal is not allowed — "
                    "comparing against a historical commit/range bypasses the explore "
                    "pipeline. Use the explore context; if insufficient, call ask_user. "
                    "Plain `git diff` / `git diff --cached` / `git diff <path>` "
                    "(working-tree review) are allowed."
                )
            break  # first real arg is a path -> allow
    return None


def _search_bypass_reject(command: str) -> str | None:
    tokens = [g for t in _TERMIN_TOKENS.findall(command) for g in t if str(g).strip()]
    if not tokens:
        return None
    prog = str(tokens[0]).split("/")[-1].split()[0]
    if prog in _SEARCH_BYPASS_PROGS:
        return _SEARCH_BYPASS_MSG.format(prog=prog)
    if (
        prog in ("python", "python3")
        and ("-c" in tokens or "-m" in tokens)
        and _PY_WALK_RE.search(command)
    ):
        return _SEARCH_BYPASS_MSG.format(prog="a python file-search one-liner")
    git_reason = _git_is_history_search(command)
    if git_reason:
        return git_reason
    return None


def _wrap_no_search_bypass(fn: Callable):
    """Wrap a terminal tool so grep-family commands and python file-search
    one-liners are rejected, closing the run_terminal search-cap bypass.
    Applied to EVERY mode's run_terminal (read-only or not — Build's writable
    terminal had no restriction of this kind at all before this).
    """

    async def wrapped(command: str, timeout: int = 120, _timeout: int | None = None, **kwargs) -> str:
        # A detached background launch is not a search bypass — allow it
        # through to the read-only allowlist check (generic, any stack).
        _eff = _timeout if _timeout is not None else timeout
        if _is_background_launch(command or ""):
            try:
                return await fn(command, timeout=_eff)
            except TypeError:
                return await fn(command)
        reason = _search_bypass_reject(command)
        if reason:
            return reason
        # Block ANY code-search/inspection command run through run_terminal.
        # The dedicated search tools (grep/glob/read) and the background sub-agent
        # are the only sanctioned ways to search the codebase — running searches
        # through run_terminal is slow, token-heavy, and bypasses the search path.
        # git working-tree inspection (status/diff/log/show/blame) stays allowed
        # because it is a sanctioned read-only inspection command (and the
        # history-search variants are already rejected by _search_bypass_reject).
        _first = command.strip().split()[0].lower() if command.strip().split() else ""
        if _first != "git" and _is_terminal_search(command):
            return (
                "ERROR: code search/inspection via run_terminal is not allowed — "
                "it is slow and wastes tokens. Use grep/glob/read for targeted "
                "lookups, or delegate broad/multi-file work to the "
                "sub-agent via task(subagent_type='subagent')."
            )
        try:
            return await fn(command, timeout=_eff)
        except TypeError:
            return await fn(command)

    return wrapped


# ---------------------------------------------------------------------------
# NOTE: there is intentionally NO auto-router. The background sub-agent is ONLY
# triggered when the agent explicitly calls task(subagent_type='subagent').
# The model is free to use grep/glob/read/web_search/fetch_url directly for
# any search — broad or targeted — without being steered/blocked.
# ---------------------------------------------------------------------------


# OpenRouter requires "vendor/model" ids, so a bare "free" shortcut in a
# subagent entry ("openrouter/free") can't build directly. Resolve it to the
# REAL model id the user picked: `openrouter/free` is OpenRouter's "Free Models
# Router" (routes among free models, $0) — never a hardcoded substitute, so
# usage reports the exact model.
_OPENROUTER_FREE_FALLBACK = "openrouter/free"


def _subagent_target(
    entry: str,
    parent_provider: str,
    parent_base_url: str,
    parent_api_key: str,
    parent_env_var: str,
    provider_lookup: Callable[[str], dict | None],
    parent_provider_id: str = "",
    parent_api_keys: list[str] | None = None,
) -> tuple[str, str, str, str, str, str, list[str]] | None:
    """Resolve a subagent model entry to (provider_kind, model, base_url,
    api_key, env_var, provider_id, api_keys), or None to use the parent
    model.

    ``entry`` may be a bare model id ("Qwen3.5-4B-Q4_K_S.gguf") resolved
    against the parent provider, or a "providerId/model" pair routing the
    subagent through that provider's own base URL / key. A legacy leading
    "providerKind/" prefix (from the old UI picker labels) is dropped when
    it matches the parent provider or a configured provider id.

    ``provider_lookup(pid)`` returns the saved Settings → Providers row for an
    id, or None. A prefixed entry whose head is NOT a saved row but IS a known
    built-in gateway kind (e.g. "openrouter/free" while the parent is the
    opencode gateway and OpenRouter auth is env-only) still routes through
    that kind's own defaults — built-in base URL and the env credential chain
    (build_model reads OPENROUTER_API_KEY etc.) — so a manually-entered model
    is honored instead of being dumped onto the parent provider.
    """
    entry = (entry or "").strip()
    if not entry:
        return None
    pid: str | None = None
    model_part = entry
    p: dict | None = None
    if "/" in entry:
        head, _, tail = entry.partition("/")
        if head and tail:
            row = provider_lookup(head)
            if row is not None:
                # Saved provider row wins (its stored key/base apply).
                pid, model_part, p = head, tail, row
            elif head == parent_provider:
                # Parent-kind prefix: keep the PARENT's own base/key.
                model_part = tail
            elif _provider_meta(head).get("base_url"):
                # Known built-in gateway kind with no saved row (env-var-only
                # auth). Resolve through the kind's defaults; the credential
                # comes from the env chain inside build_model.
                meta = _provider_meta(head)
                pid, model_part = head, tail
                p = {
                    "id": head,
                    "kind": head,
                    "baseUrl": _expand_base(meta.get("base_url") or "", head),
                    "apiKey": "",
                    "envVar": "",
                    "apiKeys": [],
                }
            else:
                # Unrecognized provider prefix: drop it and fall back to the
                # parent provider with just the model id. Without stripping, the
                # full "provider/model" string is sent as the model id and the
                # server rejects it (e.g. llama.cpp: 401 "Model 'local/...' is
                # not supported"). A saved row (sent by the frontend) would have
                # routed it to the right provider above.
                model_part = tail
        if p is None and pid:
            p = provider_lookup(pid)
    if p is not None:
        kind = p.get("kind") or "custom"
        # A legacy/typo'd entry may carry the provider prefix TWICE
        # ("openrouter/openrouter/free") — collapse it to the bare model id
        # before routing, so the "free" shortcut (and any real model) still
        # resolves through its own provider.
        own_prefix = f"{p.get('id') or pid}/"
        while model_part.startswith(own_prefix):
            model_part = model_part[len(own_prefix) :]
        # OpenRouter model ids must include the upstream vendor
        # ("vendor/model"), so a bare "free" shortcut can't build. Resolve
        # it to the exact id the user picked — `openrouter/free`, OpenRouter's
        # Free Models Router — instead of silently falling back to the parent.
        if kind == "openrouter" and "/" not in model_part:
            model_part = _OPENROUTER_FREE_FALLBACK
        row_keys: list[str] = []
        raw_keys = p.get("apiKeys")
        if isinstance(raw_keys, list):
            row_keys = [k for k in raw_keys if isinstance(k, str) and k]
        if not row_keys and isinstance(p.get("apiKey"), str) and p.get("apiKey"):
            row_keys = [str(p.get("apiKey"))]
        return (
            kind,
            model_part,
            p.get("baseUrl") or "",
            p.get("apiKey") or (row_keys[0] if row_keys else ""),
            p.get("envVar") or "",
            str(p.get("id") or pid or kind),
            row_keys,
        )
    return (
        parent_provider,
        model_part,
        parent_base_url,
        parent_api_key,
        parent_env_var,
        parent_provider_id,
        list(parent_api_keys or []),
    )


SYSTEM_PROMPTS: dict[str, str] = {
    "ask": (
        "You are a simple, friendly assistant inside a desktop IDE. Answer in the SAME LANGUAGE the user writes in. Use plain words and define technical terms. Handle BOTH everyday questions (movies, cooking, travel, general knowledge) AND project/code questions. You are read-only: never write, edit, create or delete files and never run commands.\n"
        "Keep answers short (1-3 lines) unless the user asks for detail; scale length to the question, never pad or restate it. Give step-by-step guidance ONLY when an attached skill requires it; do not force a numbered-step structure.\n"
        "Project/code questions (behavior, styling, logic, bugs, file structure, dependencies): check JUST-IN-TIME following the SEARCH STRATEGY rule (parallelizable work goes to task(subagent_type='subagent')) and answer from real code; never answer about the real project from general knowledge when the code is a grep/read away. Do NOT call any tool when the answer is already in front of you (conversation, memory, attached files, earlier tool results) or the question is unrelated to the project (greetings, general knowledge, pasted errors from OTHER apps/OS). For code/project questions use web_search only when the user explicitly asks. @mentioned or attached files are already noted: read them with the read tool instead of re-searching. You have full workspace access. If a skill is attached or auto-matched below (=== ATTACHED SKILLS === / === AUTO-MATCHED SKILLS ===), adopt its role and follow its instructions instead of generic mentoring. If an entry in === AVAILABLE SKILLS === matches the request, call load_skill for it first (a skill lookup is not a project lookup, so the no-tool rule above does not apply to it).\n"
        "External content (movies, trailers, images, videos, current events, docs, APIs, links): you MUST first use web_search (or the browser MCP tools when a browser connector is connected) to get REAL, VERIFIED URLs. NEVER fabricate URLs; every image/video URL must come from an actual web_search or fetch_url result. Images: ![description](verified-url); videos: a bare YouTube/Vimeo link on its own line (the frontend renders clickable cards).\n"
        "Multi-step work: call update_plan with a short checklist and tick each step completed the moment it is done. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work.\n"
        "OUTPUT DISCIPLINE: never dump full files or large code blocks; paste only tiny necessary snippets and name file paths. Cite line numbers in prose only when truly necessary. A snippet taken from the read tool starts with the file's path as a comment (e.g. // src/App.tsx) and is fenced as ```lang:START-END with the REAL line numbers from the read output (e.g. ```python:42-58) so the UI shows the file name and real line numbers. Any flow, process, sequence, architecture or relationship explanation must be a valid ```mermaid fenced diagram, never ASCII art or a plain list."
    ),
    "build": (
        "You are Build, an implementation agent inside a desktop IDE. You receive the plan and implement it. Spawning tasks counts as starting work. Do only targeted lookups yourself following the SEARCH STRATEGY rule: nothing is pre-read, so try LSP first, else ONE targeted grep (path/include limited to the area you are working on) with context, then read only the pointed windows via symbols=[...] or ranges=[...] right before you edit. You have FULL access to every file inside the workspace. Targeted checks are BOUNDED: after at most 2-3 search batches you MUST start editing in the SAME turn — never keep searching when you already know which files to touch. Tools: edit_file / write_file / run_terminal (read-only build/test/lint) plus grep / glob / read for targeted checks and task(subagent_type='subagent') ONLY for several parallel research chunks with different areas.\n"
        "CHECKLIST: for multi-step work call update_plan (skip it for trivial single-step changes). Always include a 'write and run tests' step for any change that introduces or alters BEHAVIOR or LOGIC (new functions, branches, edge cases, bug fixes); skip tests for pure cosmetic/refactor/doc changes unless they touch existing tested behavior, and prefer extending existing tests over adding trivial new ones. Mark each item 'completed' (and the next 'in_progress') the moment it is finished, before starting the next. NEVER send update_plan alone when there IS next work — always batch it with your next tool calls in the SAME step. Solo is only for the final tick with no further work. Finish the whole list in THIS turn — never end with pending items still doable. When ALL items are completed and new work needs its own steps, call update_plan with a FRESH list.\n"
        "EDITING: prefer edit_file (exact old_string/new_string) for existing files; write_file only for brand-new files. NEVER edit files through any command. Implement immediately once you have the needed context. When editing, always copy the clean file text from read (no line numbers, no wrappers or footers); if an edit reports old_string not found, re-read and copy the exact text shown in the error hint. Batch ALL edits to the SAME file in ONE edit_file call via edits=[{'old_string': ..., 'new_string': ...}, ...] (atomic, applied in list order, one checkpoint/diff/verify); edits you kept for yourself across DIFFERENT files go as parallel edit_file calls in the SAME turn — NEVER edit files you delegated to a subagent. Do not repeatedly edit the same code or modify unrelated code.\n"
        "HUMAN IN THE LOOP: before a hard-to-reverse action (deleting a real file) call confirm_action and WAIT. When a dependency, package, or server binary is missing, never stop with 'not installed' — ask with confirm_action (or request_permission for package installs) and WAIT, then retry the work; only stop if DENIED. At a genuine fork with no clearly-correct default call ask_user with 2-5 short options and WAIT. Do not overuse either.\n"
        "AUTO-VERIFY: every write/edit is auto-checked (syntax/typecheck) -- trust it; do not re-run verification yourself.\n"
        "CODE QUALITY: write maintainable, readable code following the project's existing structure and conventions: small focused files, meaningful names, DRY, no dead/commented-out code, minimal diffs, English comments. Fix any error you introduce and leave the codebase clean.\n"
        "REPLY DISCIPLINE: the edit_file/write_file tool call IS the artifact -- never paste full file contents or large code blocks into your visible reply; after writing/editing code, summarize concisely what changed (file, function, short diff-level description)."
    ),
    "plan": (
        "You are a planning agent inside a desktop IDE. Produce a SHORT, scannable IMPLEMENTATION PLAN -- you never implement it.\n"
        "MANDATORY RESEARCH: before writing ## Plan, search the real codebase with LSP/grep/glob/read (LSP first for precise jumps, then scoped grep; task(subagent_type='subagent') is ONLY for parallel research chunks, never for file lookups) to find the files, functions and lines the plan will touch -- never plan from memory. If you delegated any scope to a subagent, do NOT write ## Plan until its [background sub-agent report] arrives; then revise using it instead of re-searching that scope. When the user EXPLICITLY asks to research the web ('research this on the web', 'search online', 'look it up'), that request is MANDATORY: call web_search -- and fetch_url to open the promising hits -- BEFORE writing ## Plan and cite the real URLs in the plan; a codebase-only answer never satisfies an explicit web-research request. When the task needs external docs/APIs/versions, call web_search/fetch_url first and cite real results. When the request is ambiguous or you hit a genuine fork with no clearly-correct default, call ask_user with 2-5 short options and WAIT -- never pick silently. Do all file lookups (glob + grep) up front in ONE batched parallel turn, then read only the specific files you need: enough context in a SINGLE call (read with offset/limit), never rereading a location. Stop the moment every file the plan will touch is identified.\n"
        "TERMINAL: read-only inspection only -- git status, plain git diff (working-tree/staged), pwd, node/python --version, and build/test/lint. Never modify/create/delete files and never use it to read files (no ls/find/cat/sed/awk/head/tail/wc/grep).\n"
        "CHECKLIST: call update_plan ONCE, after writing '## Plan', with the final checklist Build will execute (every item status='pending': one item per file/group below plus a 'write and run tests' item); never while scouting.\n"
        "PREVIOUS PLAN: your finished plan is saved automatically (one per chat), OVERWRITING that chat's previous one. If the conversation already contains a previous ## Plan (in history or a SAVED PLAN block) AND the new message continues the same task, REVISE it instead of starting over: keep the bullets that are still correct, update/add/remove only what the user's new message affects, and open with 1-2 lines saying what changed. If the new message is a new, unrelated task, ignore the previous plan entirely and create a fresh one.\n"
        "FORMAT: open your final reply with '## Plan' and keep the WHOLE plan under ~25 lines in exactly this shape: (1) goal: 1-2 lines max; (2) one bullet PER FILE: `path` + what changes + why (function/line target, no prose dump, never repeating the same change in several bullets); (3) new files, if any, as bullets in the same list; (4) test: 1-3 verification commands only. Write the ## Plan document EXACTLY ONCE in your final message — never emit a second copy, never repeat the summary, never restate bullets as prose.\n"
        "AUDIENCE: write for the USER first, Build second -- every bullet understandable by a non-programmer: plain words, one reason ('why') per bullet, no bare symbol/line dumps without one short clause saying what they mean, no jargon without a 3-word explanation in parentheses.\n"
        "SNIPPETS: at most ONE tiny snippet (a few lines) per file, ONLY when Coder cannot infer the change from the bullet -- never one that restates a bullet -- followed by one short plain-language line saying what the user will SEE change. A snippet taken from the read tool starts with the file's path as a comment (e.g. // src/App.tsx) and is fenced as ```lang:START-END with the REAL line numbers from the read output (e.g. ```python:42-58).\n"
        "SKILLS/MCP: call create_skill/create_mcp only if the user explicitly asks to create/edit/install them (to edit a skill, load_skill first, then create_skill with the SAME name to overwrite it); otherwise plan them for Build.\n"
        "ENDING: finish the plan with a single 'Files: path1, path2, ...' line (one line, comma-separated exact paths of every file the implementation will touch), then a single summary of MAX 3 bullets (same language as the plan) covering goal, changed files and outcome -- never repeating step text, never a second summary. Each section appears EXACTLY ONCE: one goal, one bullet list, one test line, one Files line, one summary. Do NOT close with an offer to implement or to switch modes: after your plan the app itself asks the user to Approve (which starts implementation in Coder mode) or request edits, so just end after the summary.\n"
        "OUTPUT DISCIPLINE: short beats complete -- cut every line the reader can skip; never restate the request, explain your scouting, or pad."
    ),
}

# HARD-CODING IS AN ABSOLUTE LIMIT FOR THE IMPLEMENTATION AGENT.
SYSTEM_PROMPTS["build"] += (
    "\n\nHARD-CODING (ABSOLUTE): NEVER hard-code anything: no magic values or environment-specific assumptions in logic -- no hard-coded paths, credentials, URLs, feature flags, deployment/host settings, project-specific data, or behavior tied to one particular case. Source them from the project's configuration, environment variables, existing constants/registries, data files, or explicit parameters/dependencies, following the project's existing patterns."
)

# DEBUGGING PROTOCOL — makes Coder debug like a systematic debugger (Codex-style).
SYSTEM_PROMPTS["build"] += (
    "\n\nDEBUGGING PROTOCOL (when fixing a bug): follow this loop strictly, like a systematic debugger. (1) REPRODUCE first: run the failing test or a minimal script with run_terminal to see the actual error/traceback -- never guess the cause from a description alone. (2) Form a root-cause hypothesis, then confirm or refute it by reading the exact code/log lines it points to. (3) Apply the MINIMAL fix that addresses the root cause, not the symptom. (4) VERIFY by re-running the same test/script (bug gone) and the related test file (no regression); if verification fails, return to step (2) with the new evidence. Never claim a fix without having run it."
)

# PROJECT STRUCTURE AND EFFICIENCY — continue existing patterns, keep files focused.
SYSTEM_PROMPTS["build"] += (
    "\n\nPROJECT STRUCTURE AND EFFICIENCY: Read the project structure first and continue the existing pattern; never create duplicate files or needless folders. Group by responsibility: each file has a single responsibility (one reason to change); keep related files together (e.g. agent_registry.py beside agents.py, retrieval.py beside memory_manager.py, git_tools.py beside doc_tools.py); keep UI, logic and helpers separate, never mix them in one place. Write efficient yet readable code: stream/chunk large data instead of holding it all in memory, avoid repeated computation by reusing results, prefer early exit over nested conditions. Use clear names and explicit errors, never put secrets/keys in code, and never add a needless dependency."
)

# CODING RULES — exact user-supplied rules, kept verbatim as a named block so
# accidental deletion is caught by tests (see test_prompt_brevity.py).
_CODING_RULES = (
    "\n\nCODING RULES (always follow when writing or modifying code):\n"
    "Write simple, readable, maintainable, and idiomatic code.\n"
    "Follow the best practices and conventions of the language and framework.\n"
    "Keep files, modules, functions, and components small and focused.\n"
    "Maintain a clean, logical, and scalable project structure. Organize code by responsibility/domain; do not put unrelated functionality into one file.\n"
    "Separate concerns such as business logic, UI, data access, configuration, and utilities.\n"
    "Reuse existing project patterns; avoid unnecessary duplication and over-abstraction.\n"
    "Make the smallest necessary change and preserve existing behavior.\n"
    "Write CPU- and memory-efficient code. Avoid unnecessary allocations, copies, loops, I/O, network calls, and expensive operations.\n"
    "Prefer efficient algorithms and data structures when they materially improve performance.\n"
    "Handle errors explicitly and validate external/user input.\n"
    "Avoid security vulnerabilities, race conditions, resource leaks, and blocking operations where inappropriate.\n"
    "Keep types strict; avoid unnecessary `any`, casts, and disabled checks.\n"
    "Do not add dependencies unless clearly necessary.\n"
    "Add or update relevant tests when appropriate.\n"
    "Before finishing, review the code for correctness, structure, readability, security, CPU usage, memory usage, performance, and maintainability."
)
SYSTEM_PROMPTS["build"] += _CODING_RULES

# PERSIAN REPLY — exact user-supplied HARD RULE, kept verbatim as a named block
# so it cannot be silently dropped (guarded by tests). It intentionally repeats
# the skills-English and code-comments-English exceptions from _UNIVERSAL_RULES
# and _language_directive because the user requires this exact wording in build.
_PERSIAN_REPLY_RULE = (
    "\n\nHARD RULE (always follow): The user writes in Persian (فارسی). Reply "
    "ENTIRELY in Persian — every message, todo/checklist item, plan content, "
    "summary, and ask_user question and options. Never reply in English "
    "when the user writes Persian. "
    "EXCEPTION — SKILLS ARE ALWAYS ENGLISH (HARD): when you create a skill via "
    "create_skill, its `name`, `description` and `content` (full markdown body) "
    "MUST be entirely in English, even though the chat is Persian. Never create "
    "Persian skills. "
    "EXCEPTION — CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD): "
    "docstrings and comments in any code you write MUST be entirely in "
    "English, even though the chat is Persian. Never write Persian docstrings "
    "or comments. These hard rules override the Persian reply rule for skills "
    "and code docstrings/comments."
)
SYSTEM_PROMPTS["build"] += _PERSIAN_REPLY_RULE

SYSTEM_PROMPTS["reader"] = (
    "You are a focused CODE READER inside a desktop IDE. The user has pointed at "
    "specific file(s) -- attached, or named directly. Read them with the read tool (and grep/read within them as "
    "needed) to answer; the search tools are available but stay focused on the "
    "pointed-at files unless the user asks to broaden. You MAY use web_search / "
    "fetch_url / vision only when the user explicitly asks for external info or "
    "attaches an image. Explain with exact file:line references and the WHY. Keep it concise; "
    "cite file:line. If the pointed-at context is insufficient, say what is missing "
    "rather than inventing file contents."
)

# Legacy / UI mode names mapped to the canonical workflow modes. The frontend
# historically sent "chat" and "codewriter"; normalize them so they resolve to
# the right prompt and tool set instead of silently collapsing to "ask". This is
# the single source of truth for mode aliasing — both the API boundary
# (server.py) and the graph router (graph.py) import it from here.
MODE_ALIASES: dict[str, str] = {
    "chat": "ask",
    "codewriter": "build",
}

# Canonical workflow modes that have a real system prompt and tool set.
_VALID_MODES = frozenset(SYSTEM_PROMPTS.keys())


def normalize_mode(mode: str, fallback: str = "ask") -> str:
    """Normalize a UI/legacy mode name to a canonical workflow mode.

    Applies ``MODE_ALIASES`` then validates against the known modes; any
    remaining invalid value collapses to ``fallback`` (default "ask"). Use this
    at every boundary where a raw mode string enters the backend so downstream
    code only ever sees canonical keys.
    """
    mode = (mode or "").strip().lower()
    mode = MODE_ALIASES.get(mode, mode)
    return mode if mode in _VALID_MODES else fallback


# 1) The agent never leaves dead code in the work it does. 2) Dead code or bugs
# that existed BEFORE the agent's work are reported as notes, not silently fixed.
# 3) Replies stay short but precise and complete. 4) Code is written to stay
# extensible for future needs — never a one-off hack for only the current case.
# 5) Persian replies use the half-space (ZWNJ) correctly — the app does NOT
# post-process glued Persian words, so the model must emit ZWNJ itself.
_UNIVERSAL_RULES = (
    "\n\nUNIVERSAL RULES (apply in every mode):\n"
    "1. DEAD CODE: never leave dead code in code you write or modify -- no unused variables, functions, imports or parameters, no commented-out code, no unreachable branches.\n"
    "2. PRE-EXISTING ISSUES: dead code or bugs that existed BEFORE your work (not caused by you) are NOT silently fixed -- report them briefly as notes/suggestions (e.g. 'this function is unused — should be deleted', 'there's a bug here: ...').\n"
    "3. EXTENSIBLE CODE: write general, parameterized, configurable code that follows the project's existing patterns -- never a one-off hack serving only the case in front of you. When a small generalization (a parameter, a lookup table/registry, a shared helper) serves a whole class of similar tasks, prefer it.\n"
    "4. PERSIAN TYPOGRAPHY: when replying in Persian, always use the half-space "
    "(ZWNJ, U+200C) between word components — e.g. کتابخانه‌ها, منسوخ‌شده‌اند, "
    "لایه‌به‌لایه, نمی‌خواهم — never glue the components together without it.\n"
    "5. CURRENT TIME: Today's date is stamped in this turn's [Context] line — treat it as current without calling any tool. Call the `current_time` tool ONLY for a clock-precision answer (current hour, weekday, countdowns, 'how long until X'); never guess times from training data.\n"
    "6. TOOL NARRATION: before EVERY tool call (or batch of parallel tool calls) write ONE short plain-text line (under ~15 words, in the user's language, no markdown/headers/code fences) saying what you are about to do and why (e.g. 'بذار ببینم X کجا تعریف شده...'). It renders as the caption of the tool row (Claude.ai-style), so never call a tool silently.\n"
    "7. SKILLS ARE ALWAYS ENGLISH (HARD): skills created via create_skill (`name`, `description`, `content`) must be written entirely in English regardless of the user's chat language; never create Persian skills. This overrides the language-matching rules for skills only.\n"
    "8. CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD): docstrings and comments in any code you write must be entirely in English regardless of the user's chat language; never write Persian ones. This overrides the language-matching rules for code docstrings and comments.\n"
    "9. LINKS ARE NEVER CODE (HARD): never wrap http(s) URLs in backticks, inline code, or fenced code blocks -- emit links only as inline markdown [text](url) or as a bare https:// URL on its own line."
)

# Length rule for plan/build ONLY — these modes need full, complete deliverables
# (a complete plan, full code, thorough explanation) for quality. It is NOT part
# of _UNIVERSAL_RULES so ask mode stays short by default. Appended to the base
# prompt only for plan/build in graph.py.
_LENGTH_RULE = (
    "\n\nLENGTH RULE (plan/build only):\n"
    "MATCH LENGTH TO NEED: be precise and complete first -- never sacrifice correctness, detail, or the full deliverable your mode requires (a complete plan, full code, thorough explanation) for brevity. Cut FILLER only: long intros, restating the question, repeated caveats, padding prose. Quick questions: 1-3 sentences; tasks needing depth (debugging, architecture, planning, explanations): full detail. Prefer tight bullets and code snippets over prose; lead with the direct answer, then only the context needed to act."
)

# Test files must live with the code they test, inside that package's own test
# directory — regardless of how many packages the repo contains. Appended to
# the plan and build prompts (graph.py): plan must reference the right test
# path, and build writes the test there.
_TEST_DIR_RULE = (
    "\n\nTEST LOCATION RULE (plan & build):\n"
    "Place each test file inside the SAME package/sub-package as the code it tests, in that package's own `test/` (or `tests/`) directory at its root -- regardless of how many packages the repo contains. Never put tests in unrelated folders or far from the code under test."
)

# How tests must be WRITTEN so the suites the agent creates stay fast to run.
# A slow suite makes every later turn slower (the agent keeps re-running its
# own tests), so this is a first-class rule like _TEST_DIR_RULE. Appended to
# the plan and build prompts (graph.py).
_TEST_STYLE_RULE = (
    "\n\nTEST STYLE RULE (plan & build):\n"
    "Keep test suites FAST -- every test you add is re-run on later turns. Prefer unit tests over full-pipeline integration tests; a new test should finish in well under a few seconds. NEVER synchronize tests with real time: no fixed time.sleep / asyncio.sleep, no polling loops with generous timeouts -- inject fake clocks, monkeypatch delay/TTL constants to tiny values, or wait on events/conditions. Use table-driven tests (parametrize) for near-duplicate cases and extend the existing test file instead of creating new ones. Clean up every temp dir/file a test creates. Tests must not hang: give every wait a small, bounded timeout."
)

# Doing-tasks guidance (mirrors opencode's "Doing tasks" section): how to use the
# search tools, verify work, and what NOT to do. Appended to every mode's prompt
# via graph.py so the agent behaves consistently across ask/build/plan.
_DOING_TASKS = (
    "\n\nDOING TASKS (every implementation/search mode):\n"
    "1. Follow the SEARCH STRATEGY rule above (parallel work → subagent; "
    "targeted → grep/glob/read). After delegating a chunk to a subagent, "
    "NEVER redo the same chunk yourself; wait for its report and do "
    "only targeted follow-ups for files it names.\n"
    "2. You are the manager of any sub-agents you spawn: do your own parallel "
    "work on UNRELATED chunks while they run, and do NOT write the final "
    "answer (in plan mode: do NOT write ## Plan) until every "
    "report has arrived and you have verified the task is done. "
    "After merging their reports, you MUST run the relevant tests yourself "
    "covering every delegated chunk before finishing (sub-agents NEVER run "
    "tests — testing delegated work is always your job).\n"
    "3. Implement the solution using all tools available to you.\n"
    "4. Verify with tests when the change alters behavior/logic (see TEST "
    "VERIFICATION RULE above).\n"
    "5. The pipeline auto-checks syntax/typecheck after each write/edit — trust "
    "it; do not re-run verification yourself unless a test fails or the user "
    "asks.\n"
    "6. NEVER commit changes unless the user explicitly asks you."
)

# The search strategy is a FIRST-CLASS rule: it sits at the very top of
# every mode's prompt (right after the mode declaration + language rule) so the
# agent always picks the right tool for the breadth of the search. It replaces
# the per-mode scout guidance that used to be duplicated inside each
# SYSTEM_PROMPTS entry and the SEARCH rule in the trailing RULES block.
_SEARCH_RULE = (
    "\n\n=== SEARCH STRATEGY (every mode) ===\n"
    "Pick tools by search BREADTH; targeted only, no blind scans.\n"
    "1. TARGETED (known file/symbol/keyword), fixed order: (a) LSP first: lsp_definition/references/hover/symbols; symbol NAME without a file -> read(symbols=[...]) project-wide, never grep names; server installing -> retry, never search without LSP. (b) filename -> glob first, never grep filenames. (c) else ONE grep (prefer BOTH path and include for precision); hits carry bodies, don't re-read; never repeat a pattern/path/include in one turn -- batch via patterns=[...], paths=[...], includes=[...] in ONE call. (d) read only pointed windows in ONE call via symbols=[...]/ranges=[...] (whole files: filePaths=[...]); never re-read a window; never read the workspace root.\n"
    "FORBIDDEN: grep with >3 `|` alternatives; mixed-language OR (one language/concept, max 3); grep for filenames; searching/reading files via run_terminal/scripts.\n"
    "2. DELEGATION: task(subagent_type='subagent') only for parallelizable chunks (one per chunk, ONE block), never file lookups; named Files -> skip discovery, ONE read via filePaths/ranges.\n"
    "3. BATCHING: all known searches in ONE parallel turn: terms/scopes/filters via ONE grep call (patterns/paths/includes), globs via patterns, files via ONE read (filePaths or ranges+symbols), never two reads of one window.\n"
    "4. STOP: after 2-3 search batches start editing in the same turn; report exact errors.\n"
)

# The DISCOVERY block is appended to ask/plan modes. It MUST NOT contradict
# _SEARCH_RULE above: broad / multi-file exploration is delegated to the
# background sub-agent (which runs in an isolated context and returns a compact
# report), so the parent never floods its own context with raw grep/glob hits.
# grep/glob/read are the TARGETED path only. This mirrors opencode's design
# where discovery is the agent's job but wide searches are fanned out to
# isolated sub-agents instead of being done inline.
_DISCOVERY_BLOCK = (
    "\n\nCODE CONTEXT: nothing about the codebase is pre-loaded into this message. When the question touches the project, check JUST-IN-TIME per the SEARCH STRATEGY rule above (grep/glob/read for file lookups; parallelizable work goes to task(subagent_type='subagent')). web_search / fetch_url / vision / skills are available on demand; MCP connector tools are live when their chip is toggled on."
)

# Hard guardrail injected on the FINAL allowed step (mirrors opencode's
# `MAX_STEPS_PROMPT` / `isLastStep` in session/prompt.ts). When the agent hits
# its step budget the model is forced to STOP tool-calling and emit a text
# summary instead of burning more reads/searches. Kept in ENGLISH on purpose:
# the model parses the hard limit more reliably in English than in Persian.
_MAX_STEPS_PROMPT = (
    "CRITICAL WARNING - You have reached the maximum step limit.\n\n"
    "The maximum number of steps for this task has been reached. Tools are "
    "disabled until the next user input. Respond with text only.\n\n"
    "Hard requirements:\n"
    "1. Do NOT make any tool calls (no read, no write, no search).\n"
    "2. You MUST provide a text summary of work completed.\n"
    "3. This limit overrides all other instructions.\n\n"
    "Your response must include: confirmation of limit reached, summary of "
    "completed work, remaining tasks, and suggested next step."
)

# Thinking levels the UI can select. 'none' = reasoning disabled, the rest map
# to increasingly deeper reasoning effort. Setting a low level (or 'none') is
# the most effective way to keep a reasoning model from flooding a small context
# window with thinking tokens and getting cut off. '' (legacy clients) falls
# back to the provider default / auto-inject behavior.
# Extra top rungs ('xhigh' for gpt-5.1 style routes, 'max' for agentrouter /
# some OpenRouter routes) are passed through verbatim; routes that reject one
# are remapped to the nearest allowed value by the reasoning-effort 400 retry
# path in llm.py / graph.py. 'minimal' is rejected by always-thinking gateways
# (agentrouter-style 400s), so it stays omitted here.
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max",
}

# HTTP status codes that are worth retrying (transient server / rate-limit).
# 400 is included because some upstream gateways (e.g. minimax-m3:free on
# OpenRouter) return 400 for transient conditions (rate-limit-style throttling,
# temporary model unavailability) that resolve on retry — treating it as fatal
# would surface a hard error for what is effectively a transient blip.
_RETRYABLE_STATUS = {400, 429, 502, 503, 504}

# Files the workspace memory loader pulls in, and the cap on each (bytes).
_PROJECT_MEMORY_FILES = ["AGENTS.md"]
_PROJECT_MEMORY_MAX_BYTES = 12_000

# Extra files the auto-scout should prioritise; empty = just the root listing.
_AUTO_SCOUT_KEY_FILES: list[str] = []


# Cloud gateways that expose reasoning-capable models. Local adapters (ollama,
# and llama.cpp/vLLM/LM Studio via `custom`) usually can't honor a reasoning
# effort, so for them we never auto-inject a `thinking` value — that avoids both
# a stray `reasoning_effort` param and silent context burn on local models.
# Which providers are "cloud" is a `_provider_meta(...).auto_think` flag.


def _resume_prompt_key(p: str) -> str:
    """Normalize a turn prompt for resume-matching.

    The frontend may append a skills section ("=== USER-SELECTED SKILLS/TOOLS
    FOR THIS TURN ===") or an interrupted-plan reminder ("[SYSTEM: a task was
    interrupted mid-way") to the prompt it sends. Gate (a) of the resume
    injection compares the retried prompt against the prompt saved when the
    tools ran, so those suffixes would make an otherwise-identical retry fail
    the match and re-run the tools. Strip them so resume fires on a genuine
    retry even when the prompt carries such suffixes.
    """
    p = str(p or "").strip()
    cut = p.split("\n\n=== USER-SELECTED SKILLS/TOOLS FOR THIS TURN ===", 1)[0]
    cut = cut.split("\n\n[SYSTEM: a task was interrupted mid-way", 1)[0]
    return cut.strip()


_RETRYABLE_PHRASES = (
    "rate limit",
    "ratelimit",
    "timeout",
    "timed out",
    "connection reset",
    "connection aborted",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "overloaded",
    "at capacity",
    "ttft target",
    "all providers",
    "no providers",
    "capacity",
    "transiently",
    # NOTE: "internal server error" / "server error" / "internal error" are
    # deliberately EXCLUDED — they match provider 5xx (e.g. 500 Internal Server
    # Error) which should NOT auto-retry.  Only rate-limit (429) and server
    # busy (502/503/504) are retryable.  Genuine transient connection errors
    # that happen to mention "server error" in their text are already covered
    # by _RETRYABLE_EXC_NAMES (class-based matching).
    "gateway timeout",
    # Upstream capacity / worker exhaustion (e.g. OpenRouter wrapping a Nvidia
    # provider overload as `ResourceExhausted: Worker local total request limit
    # reached (33/32)`). This is a transient concurrency cap — backoff rides it
    # out — NOT a hard failure, and NOT a daily quota (handled separately below).
    "resource exhausted",
    "resourceexhausted",
    "worker local",
    "request limit reached",
    "upstream error",
    "upstream connection lost",
    "connection lost",
    # Transport-level stream drops: the upstream TCP/TLS connection closes
    # mid-body with no HTTP status attached (often "peer closed connection
    # without sending complete message body (incomplete chunked read)").
    "incomplete chunked read",
    "chunked read",
    "peer closed connection",
    "connection closed",
    "connection was closed",
    "remote protocol error",
    "broken pipe",
    "zero length read",
)

# Exception CLASS names whose *type* indicates a transient connection/flow
# problem regardless of the message text (httpx/httpcore transport errors,
# openai connection errors, ...). `_is_retryable` walks the __cause__ chain and
# matches these so a plain `httpx.RemoteProtocolError` is retried even though
# its `.status_code` is absent and its message text falls outside the phrase
# list above.
_RETRYABLE_EXC_NAMES = (
    "RemoteProtocolError",
    "ConnectError",
    "ReadError",
    "ReadTimeout",
    "WriteTimeout",
    "TimeoutException",
    "TimeoutError",
    "NetworkError",
    "TransportError",
    "APIConnectionError",
    "APITimeoutError",
    "TryAgain",
    "IncompleteRead",
    "RemoteDisconnected",
    "BrokenPipeError",
    "ConnectionResetError",
    "ConnectionAbortedError",
    "ConnectionRefusedError",
    "ConnectionError",
    "ServiceUnavailable",
)


def _retryable_by_type(exc: BaseException) -> bool:
    """Walk ``exc`` and its ``__cause__`` chain checking each class name against
    ``_RETRYABLE_EXC_NAMES``. Transport errors (httpx/httpcore) are often
    re-wrapped so the innermost type holds the tell."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        name = type(cur).__name__
        if any(frag in name for frag in _RETRYABLE_EXC_NAMES):
            return True
        cur = cur.__cause__
    return False


def _is_read_timeout(exc: BaseException) -> bool:
    """True when ``exc`` (or its ``__cause__`` chain) is a read timeout — the
    provider sent no data for the whole read window (httpx.ReadTimeout /
    httpcore.ReadTimeout). The server uses this to show the "tap Retry" hint
    instead of the generic "just wait" message."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if "ReadTimeout" in type(cur).__name__:
            return True
        cur = cur.__cause__
    return False


def _is_retryable(exc: BaseException) -> bool:
    """Best-effort check for whether ``exc`` looks like a transient provider
    error worth retrying (429 / 5xx / connection blips) rather than a hard
    failure (bad API key, invalid model, bad request) that would just fail
    identically on retry.
    """
    # ── Hard-fail: transcript / payload validation errors ──────────────
    # 400 "Validation: missing results for tool_call_id" (and similar) are
    # *permanent* transcript bugs — retrying burns the full budget (~5 min)
    # for nothing.  Check BEFORE any status-code path so this works even
    # when status_code is absent (fallback regex/code-in-text paths).
    _low = str(exc).lower()
    _validation_patterns = (
        "validation",
        "tool_call_id",
        "missing results",
        "duplicate",
        "function_call_output",
    )
    if any(p in _low for p in _validation_patterns):
        return False
    # ── Hard-fail: context overflow ───────────────────────────────────
    # 400 "exceeds the available context size" / "context_length_exceeded"
    # means the *entire request* is too big — retrying the same oversized
    # payload burns budget for nothing.  The caller should compact first.
    if _is_context_overflow(exc):
        return False
    # Prefer the real HTTP status carried on the exception object (openai's
    # APIError sets `.status_code`) — reliable even when the
    # message text omits it.
    try:
        code = int(getattr(exc, "status_code", 0) or 0)
    except (TypeError, ValueError):
        code = 0
    if code in _RETRYABLE_STATUS:
        return True
    text = str(exc)
    status_match = re.search(r"status[_ ]code[:=]?\s*(\d{3})", text, re.IGNORECASE)
    if status_match:
        try:
            return int(status_match.group(1)) in _RETRYABLE_STATUS
        except ValueError:
            pass
    for code in _RETRYABLE_STATUS:
        if re.search(rf"(?<!\d){code}(?!\d)", text):
            return True
    # e.g. `httpx.RemoteProtocolError`/`httpcore.RemoteProtocolError` carry no
    # status code and their text may be generic; fail-fast text checks already
    # ran above, so trust the exception type here.
    if _retryable_by_type(exc):
        return True
    low = text.lower()
    return any(phrase in low for phrase in _RETRYABLE_PHRASES)


def _friendly_retry_reason(exc: BaseException) -> str:
    """Human-friendly reason for the retry banner. Connection errors get an
    actionable hint instead of the raw exception text (which is often cryptic,
    e.g. ``ConnectError: All connection attempts failed``).
    """
    low = str(exc).lower()
    if (
        "all connection attempts failed" in low
        or "connection refused" in low
        or "connecterror" in low
        or "getaddrinfo" in low
        or "no connection could be made" in low
        or "name or service not known" in low
        or "unable to connect" in low
        or "connect call failed" in low
        or "connection reset" in low
        or "connection aborted" in low
        or "connection closed" in low
        or "peer closed connection" in low
        or "incomplete chunked read" in low
    ):
        return (
            "Can't reach the provider — check your internet connection and that "
            "the base URL/port in Settings are correct. Retrying…"
        )
    # HTTP 401 — almost always one of two things: a missing/revoked key, or a
    # model id the gateway doesn't recognize (opencode.ai/zen rejects a bare id
    # with "Model is not supported"). Surface the right hint instead of the raw
    # "Error code: 401 - {...}" payload.
    code = int(getattr(exc, "status_code", 0) or 0)
    if code == 401:
        if "model" in low or "not supported" in low:
            return (
                "The model isn't recognized by this provider — check the model id "
                "in Settings (it may be missing its provider prefix, e.g. "
                "'opencode/...'). Retrying won't help until it's fixed."
            )
        return (
            "Authentication failed (401) — check the API key in Settings. "
            "Retrying won't help until it's fixed."
        )
    # An empty 200 stream (gateway returned no chunks at all — e.g. a
    # quota-exhausted route that swallows the real error inside the stream).
    # LangChain surfaces it as ValueError("No generation chunks were returned").
    # Retrying the same request usually fails identically, so tell the user
    # what actually happened instead of the cryptic raw text.
    if "no generation chunks" in low:
        return (
            "The provider returned an empty response (no content was generated). "
            "This usually means the model's quota/budget pool is exhausted or the "
            "route is unavailable — switch to another model in Settings and retry."
        )
    # Any other recognized status (400, 403, 404, 5xx that wasn't caught by
    # the phrase check, etc.) gets a clean one-liner prefix so the user sees
    # the HTTP code up front instead of having to dig it out of the raw
    # exception text. The detailed exception text is appended below the
    # prefix for diagnosis. Skipped for 401 (handled above with a specific
    # actionable message) and 0 (no status code at all — likely a
    # connection or transport error, handled by the phrase check above).
    if code and code != 401:
        raw = str(exc)[:200]
        # Avoid double-prefixing when the raw text already leads with the
        # code (some LangChain wrappers format as "Error code: 400 - {...}").
        if raw.lower().lstrip().startswith(f"error code: {code}"):
            return raw
        return f"Provider returned HTTP {code}. {raw}".strip()
    return str(exc)[:200]


# Phrases that indicate a hard usage-QUOTA exhaustion (daily/monthly/free-tier
# cap) rather than a brief throttle. Gateways that return these will return the
# identical error for a while (minutes, not seconds), so the normal 30s backoff
# just burns the retry budget for nothing before failing identically.
_QUOTA_EXHAUSTED_PHRASES = (
    "usage limit",
    "quota exceeded",
    "daily limit",
    "monthly limit",
    # Billing locks: the identical error repeats until the user pays, so the
    # 30s backoff only burns the retry budget (seen in practice: a 429
    # ``model_requires_purchase`` / ``insufficient_quota`` retried after 30s).
    "requires_purchase",
    "insufficient_quota",
    "insufficient balance",
)

# Class names / messages that *look* like a hard quota cap but are actually a
# brief 429 throttle the unified 30s backoff can ride out (e.g. a free-tier
# gateway's ``FreeUsageLimitError`` carrying "Rate limit exceeded. Please try
# again later."). When any of these appear the error is NOT a hard quota cap, so
# the retry loop should handle it instead of giving up immediately.
_QUOTA_TRANSIENT_PHRASES = (
    "rate limit",
    "try again later",
    "too many requests",
)


def _is_quota_exhausted(exc: BaseException) -> bool:
    """Detect a hard usage-quota error (e.g. a free-tier gateway's
    ``FreeUsageLimitError``) as opposed to a brief 429 throttle that a short
    backoff can ride out. When true, ``run_agent`` skips straight to surfacing
    the friendly error instead of spending the retry budget on attempts that
    will fail identically for minutes.

    A ``FreeUsageLimitError`` carrying a "Rate limit exceeded" message is a
    transient 429, not a permanent cap, so it must NOT be treated as exhausted.
    """
    low = str(exc).lower()
    # A brief throttle is NOT a hard quota cap — let the retry loop handle it.
    if any(p in low for p in _QUOTA_TRANSIENT_PHRASES):
        return False
    return any(p in low for p in _QUOTA_EXHAUSTED_PHRASES)


# Unified retry budget for ALL transient provider failures (throttle 429, 5xx,
# timeout, network blip). The graph's retry loop uses these so any transient
# failure recovers automatically instead of giving up on the first blip.
# Configurable so tests can zero the backoff. Base can be overridden via
# CODIFA_RETRY_BASE_SECONDS env for slow/free-tier providers.
_RETRY_MAX_ATTEMPTS = 10
_RETRY_BASE_SECONDS = int(os.environ.get("CODIFA_RETRY_BASE_SECONDS", "30"))
# Cap == base so every retry waits a fixed ~30s (10 attempts, 30s apart).
_RETRY_MAX_DELAY_SECONDS = int(os.environ.get("CODIFA_RETRY_MAX_DELAY", "30"))


def _retry_delay(attempt: int) -> float:
    """Backoff delay before retry attempt N (1-based).

    Exponential starting at _RETRY_BASE_SECONDS, capped at
    _RETRY_MAX_DELAY_SECONDS, with small jitter so concurrent turns do not
    retry in lockstep. Returns 0 immediately when base is 0 (tests).
    """
    try:
        base = float(_RETRY_BASE_SECONDS)
    except (TypeError, ValueError):
        base = 30.0
    if base <= 0:
        return 0.0
    try:
        cap = float(_RETRY_MAX_DELAY_SECONDS)
    except (TypeError, ValueError):
        cap = 60.0
    if cap <= 0:
        cap = 60.0
    delay = base * (2.0 ** max(0, int(attempt) - 1))
    delay = min(delay, cap)
    try:
        import random as _random

        delay = delay + _random.uniform(0.0, min(1.0, delay * 0.1))
    except Exception:  # noqa: BLE001, S110 — jitter never breaks retry
        pass
    return float(delay)


def _is_image_rejection(exc: BaseException) -> bool:
    """Detect a 400 where the provider's upstream schema rejects ``image_url``
    message parts (e.g. ``deepseek-v4-flash-free`` only accepts ``text``). This
    is a hard, deterministic 400 — the current user turn carried an image the
    model backend can't parse. The fix is to drop the image parts and retry,
    not to retry the identical body that has already been rejected.
    """
    text = str(exc)
    status_match = re.search(r"status[_ ]code[:=]?\s*(\d{3})", text, re.IGNORECASE)
    if status_match:
        try:
            if int(status_match.group(1)) not in (400, 422):
                return False
        except ValueError:
            pass
    low = text.lower()
    return (
        "unknown variant" in low
        and "image_url" in low
        and ("expected" in low or "forgot to set a default message" in low)
    ) or (
        "image_url" in low
        and (
            "field is required" in low
            or "not supported" in low
            or "does not support" in low
            or "unexpected" in low
            or "unrecognized" in low
        )
    )


def _is_empty_output_error(exc: BaseException) -> bool:
    """Detect the "model returned nothing usable" failure: some LangChain
    chat models raise ``ToolRetryError: Please return text or call a tool.``
    when a response has NO parts (no text, no tool call), and after the
    output-retry budget it surfaces as
    ``UnexpectedModelBehavior('Exceeded maximum output retries')``.
    Free/weak model tiers do this intermittently — retrying the same request
    shape usually fails again, so the loop drops the tool set instead.
    """
    text = str(exc).lower()
    return (
        "return text or call a tool" in text
        or "exceeded maximum output retries" in text
        or "unexpectedmodelbehavior" in text
    )


# When the provider doesn't advertise a context window, assume a conservative
# FLOOR (not a cap) so tool-output budgeting still kicks in (prevents runaway
# token burn on small free models). The real window reported by the provider's
# /models endpoint always takes precedence and can be far larger.
DEFAULT_CONTEXT_WINDOW_FLOOR = 32_000

# Universal ceiling for max_tokens when the model's REAL advertised output
# limit is known (see _settings_for). Mirrors opencode's OUTPUT_TOKEN_MAX:
# an unknown output limit falls back to 32k, never a ctx-derived 8192 clamp
# that would truncate ("context length exceeded") even on an empty context.
_MAX_OUTPUT_TOKENS = 32_000

# Output-token ceiling for NARROW/targeted turns.
# A targeted lookup/fix needs a short direct reply — the code itself is written
# through write_file/edit_file tool results, not the model's text — so capping
# its reply saves real (often expensive) output tokens while keeping full quality.
# Kept for backward-compat but no longer used directly; narrow cap is now
# proportional to the model's actual max_tokens (50% with 2048 floor).
_NARROW_OUTPUT_CAP = 2_048


_PLAN_REUSE_STOPWORDS = frozenset(
    {
        "the", "and", "for", "with", "from", "that", "this", "have",
        "will", "would", "should", "could", "please", "create", "make",
        "build", "implement", "update", "edit", "delete", "remove",
        "change", "modify", "continue", "same", "task", "plan", "code",
        "file", "files", "project", "workspace", "feature", "test", "tests",
    }
)


def _plan_text_tokens(text: str) -> set[str]:
    """Significant tokens for plan relevance (English and Persian)."""
    import re

    tokens: set[str] = set()
    for tok in re.findall(r"\w+", str(text or "").lower(), flags=re.UNICODE):
        t = tok.strip("._-/")
        if len(t) < 3:
            continue
        if t in _PLAN_REUSE_STOPWORDS:
            continue
        tokens.add(t)
    return tokens


def _plan_reuse_relevant(prompt: str, texts: list[str]) -> bool:
    """True when prompt shares significant tokens with plan texts."""
    prompt_tokens = _plan_text_tokens(prompt)
    if not prompt_tokens:
        return True
    doc_tokens: set[str] = set()
    for text in texts or []:
        doc_tokens |= _plan_text_tokens(text)
    if not doc_tokens:
        return True
    return bool(prompt_tokens & doc_tokens)


def _plan_reuse_note(history: list[dict], prompt: str = "") -> str:
    """Build a checklist-reuse instruction for a build turn that follows a plan.

    Walks ``history`` backward for the latest assistant message carrying a
    non-empty ``plan`` (the plan agent's update_plan checklist, carried through
    the frontend history payload). Returns an instruction telling the model to
    reuse those EXACT items — reset to ``pending`` when they came from a
    plan-mode turn (fresh handoff), preserving statuses for build continuation.
    Returns "" when no checklist exists, when every checklist is completed,
    or when ``prompt`` is a new unrelated task sharing no significant tokens
    with the checklist, so Build falls back to creating its own.
    """
    for turn in reversed(history):
        items = turn.get("plan")
        if not isinstance(items, list) or not items:
            continue
        clean: list[dict] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            content = str(it.get("content", "")).strip()
            if not content:
                continue
            status = str(it.get("status", "pending")).strip().lower()
            if status not in ("pending", "in_progress", "completed"):
                status = "pending"
            clean.append({"content": content[:200], "status": status})
        if not clean:
            continue
        # All steps already completed: nothing to continue. Return "" so the
        # model starts fresh instead of re-executing finished work.
        if all(it["status"] == "completed" for it in clean):
            return ""
        # New unrelated task must not reuse an old checklist (plan loop).
        if (prompt or "").strip() and not _plan_reuse_relevant(
            prompt, [it["content"] for it in clean]
        ):
            continue
        from_plan = turn.get("mode") == "plan"
        if from_plan:
            rule = (
                "Reuse these EXACT items: call update_plan with the same list, every item "
                "status='pending', then mark steps in_progress/completed as you work."
            )
        else:
            rule = (
                "Continue this checklist: call update_plan with the SAME items preserving "
                "their current statuses, then mark steps in_progress/completed as you work. "
                "Steps already marked completed must NOT be re-executed — only do the "
                "pending/in_progress ones. NEVER send update_plan alone when there IS next "
                "work — always batch it with your next tool calls in the SAME step. Solo "
                "is only for the final tick with no further work."
            )
        numbered = "\n".join(
            f"{i}. [{it['status']}] {it['content']}" for i, it in enumerate(clean, 1)
        )
        return (
            "A task checklist already exists earlier in this conversation (from the previous "
            "step). Do NOT create a new checklist.\n"
            f"{rule}\n"
            "If the user narrowed the scope (fewer items wanted), EDIT the list down "
            "to the matching items via update_plan instead of keeping stale ones; "
            "if this message is a new, unrelated task, ignore the checklist above "
            "and create a fresh one instead of reusing it.\n"
            f"EXISTING CHECKLIST:\n{numbered}"
        )
    return ""


# Path-like token scan for extracting file references from a Plan-mode message's
# prose. The reliable source is the plan's own trailing `Files:` line, but plans
# written before that contract don't have one, so prose + checklist items are
# scanned as a fallback.
_PLAN_PATH_RE = re.compile(
    r"(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|css|scss|json|md|html|go|rs|rb|c|h|cpp|sql|sh))"
)


def _plan_file_paths(history: list[dict]) -> list[str]:
    """Plan Files mentioned in the latest plan turn (display hint only, no access control)."""
    seen: list[str] = []
    for turn in reversed(history or []):
        if not isinstance(turn, dict):
            continue
        content = str(turn.get("content", ""))
        is_plan = turn.get("mode") == "plan" or content.lstrip().startswith("## Plan")
        if not is_plan:
            continue
        candidates: list[str] = []
        files_line = re.search(
            r"(?:^|\n)[ \t]*Files?[ \t]*:[ \t]*(.+?)[ \t]*\r?$",
            content,
            flags=re.IGNORECASE | re.MULTILINE,
        )
        if files_line:
            for part in re.split(r"[,\n]", files_line.group(1)):
                p = part.strip().strip("`").lstrip("/").lstrip("./")
                if p and len(p) < 160:
                    candidates.append(p)
        if not candidates:
            candidates = list(_PLAN_PATH_RE.findall(content))
            for it in turn.get("plan") or []:
                if isinstance(it, dict):
                    candidates += _PLAN_PATH_RE.findall(str(it.get("content", "")))
        for p in candidates:
            q = str(p or "").strip().strip("`").lstrip("/").lstrip("./")
            if q and q not in seen:
                seen.append(q)
            if len(seen) >= 12:
                break
        if seen:
            break
    return seen

# Line anchors handed to the Build turn: without them the build opens every
# plan file head-to-toe (file map), then greps for symbols — one wasted
# round-trip per file. Capped: the note must stay a nudge, not a transcript.
_PLAN_ANCHOR_MAX = 16


def _plan_line_anchors(turn: dict) -> list[str]:
    """``path:line`` hits the Plan turn's own grep/read calls surfaced.

    Collected from the turn's ``toolActivity``: grep items contribute
    ``path:line`` hits, read args contribute window starts (offset > 1 and
    ``ranges=`` entries — a head read at offset 1 is just "the file" and adds
    nothing). Deduped, chronological, capped at ``_PLAN_ANCHOR_MAX``.
    """
    anchors: list[str] = []
    seen: set[str] = set()

    def _add(path: str, line: str) -> None:
        key = f"{path}:{line}"
        if path and key not in seen:
            seen.add(key)
            anchors.append(key)

    for ta in turn.get("toolActivity") or []:
        if not isinstance(ta, dict) or str(ta.get("status", "")).lower() == "error":
            continue
        tool = str(ta.get("tool", "")).lower()
        if tool == "grep":
            items = ta.get("items") or ta.get("results") or []
            if not isinstance(items, list):
                continue
            for it in items:
                if not isinstance(it, dict):
                    continue
                line = it.get("line")
                if line is None:
                    continue
                _add(
                    str(it.get("path") or it.get("file") or "").strip(),
                    str(line),
                )
        elif tool == "read":
            args = ta.get("args")
            if not isinstance(args, dict):
                continue
            offset = args.get("offset")
            if isinstance(offset, int) and offset > 1:
                _add(str(args.get("filePath") or "").strip(), str(offset))
            for rng in args.get("ranges") or []:
                parts = str(rng).split(":")
                if len(parts) >= 2 and parts[1].isdigit():
                    _add(parts[0], parts[1])
        if len(anchors) >= _PLAN_ANCHOR_MAX:
            break
    return anchors[:_PLAN_ANCHOR_MAX]


def _plan_discovery_note(history: list[dict]) -> str:
    """Build a no-rediscovery instruction for a Build turn that follows a Plan.

    Plan mode already answered WHICH files are relevant. Build only needs to
    verify their current content before editing — re-running glob/grep/task to
    rediscover them wastes tokens and repeats work. Walks ``history`` backward
    for the latest Plan-mode assistant message, extracts the file paths it
    identified (its trailing ``Files:`` line, else a regex scan of the plan prose
    and checklist items), and returns a short instruction naming those paths.
    Returns "" when no plan or no paths were found.
    """
    for turn in reversed(history):
        if turn.get("role") != "assistant":
            continue
        content = str(turn.get("content", ""))
        is_plan = turn.get("mode") == "plan" or content.lstrip().startswith("## Plan")
        if not is_plan:
            continue
        paths: list[str] = []
        files_line = re.search(
            r"(?:^|\n)[ \t]*Files?[ \t]*:[ \t]*(.+?)[ \t]*\r?$",
            content,
            flags=re.IGNORECASE | re.MULTILINE,
        )
        if files_line:
            raw = files_line.group(1)
            for part in re.split(r"[,\n]", raw):
                p = part.strip().strip("`")
                if p and len(p) < 160:
                    paths.append(p)
        if not paths:
            candidates = list(_PLAN_PATH_RE.findall(content))
            for it in turn.get("plan") or []:
                if isinstance(it, dict):
                    candidates += _PLAN_PATH_RE.findall(str(it.get("content", "")))
            paths = candidates
        uniq: list[str] = []
        for p in paths:
            if p not in uniq:
                uniq.append(p)
        paths = uniq[:12]
        if not paths:
            continue
        joined = ", ".join(f"`{p}`" for p in paths)
        note = (
            "A Plan-mode message earlier in this conversation already identified these files as "
            f"relevant: {joined}. Do NOT re-run glob/grep/task to find WHICH files matter again — "
            "go straight to read/grep on these exact paths to verify their current content before "
            "editing. Only use glob or the task tool for files Plan did not name."
        )
        anchors = _plan_line_anchors(turn)
        if anchors:
            note += (
                "\n\nLine anchors from the Plan's own searches: "
                + ", ".join(anchors)
                + ".\nStart from these exact regions — read(ranges=['path:start:count']) "
                "or read(symbols=[...]) — instead of scanning files from line 1."
            )
        return note
    return ""


def _tool_reuse_note(history: list[dict]) -> str:
    """Build a tool-activity recap for a turn that follows earlier tool calls.

    Walks ``history`` backward collecting ``toolActivity`` entries from assistant
    turns (the frontend now sends these in the history payload). Returns one
    instruction listing which tools already ran this conversation with their
    args/summaries, so the model KNOWS the work was done and does not re-issue
    the identical tool calls (the classic 'ادامه بده repeats the same fetch_url'
    bug when only plain text history was sent). Returns "" when nothing useful
    exists.
    Two tiers (deterministic, no model call needed): the full listing is only
    worth its tokens when the model ALREADY repeated something — the same tool
    with the same arguments succeeding twice means real loop risk. Otherwise a
    one-line reminder preserves the preventive value for ~40 tokens instead of
    up to ~12k. Error entries never count as repetition: retrying a failed call
    is legitimate, not a loop.
    """
    entries: list[str] = []
    seen: set[str] = set()
    repeated = False
    for turn in reversed(history):
        acts = turn.get("toolActivity")
        if not isinstance(acts, list):
            continue
        for a in acts:
            if not isinstance(a, dict):
                continue
            status = str(a.get("status", "")).lower()
            if status not in ("done", "error"):
                continue
            tool = str(a.get("tool", "")).strip()
            if not tool:
                continue
            args = a.get("args")
            arg_str = _fmt_log_args(args) if args else ""
            summary = _trim_log_text(a.get("summary"), limit=400)
            line = f"- {tool}({arg_str})"
            if summary:
                line += f" → {summary}"
            if status == "error":
                line += " [FAILED]"
            entries.append(line)
            if status == "done" and not repeated:
                try:
                    sig = (
                        f"{tool}("
                        f"{json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)}"
                        ")"
                    )
                except Exception:  # noqa: BLE001 — signature is best-effort
                    sig = f"{tool}({arg_str})"
                if sig in seen:
                    repeated = True
                else:
                    seen.add(sig)
            if len(entries) >= 30:  # keep the note bounded
                break
        if len(entries) >= 30:
            break
    if not entries:
        return ""
    if not repeated:
        return (
            "Earlier in this conversation you already ran tools and their FULL "
            "results are in the transcript above — re-read them there instead "
            "of re-running the same calls. Only use tools for NEW information "
            "this turn actually needs."
        )
    return (
        "Earlier in this conversation you ALREADY ran these tool calls and their "
        "FULL results are in the transcript above — re-read them there instead of "
        "re-running the tools. Do NOT call the same tool with the same arguments "
        "again, and do NOT re-search/re-read what is already answered above, "
        "unless the user explicitly asks for a fresh run or new inputs. "
        "Only use tools for NEW information this turn actually needs:\n"
        + "\n".join(entries)
    )


def _trim_log_text(text: Any, limit: int = 160) -> str:
    """Collapse a tool arg / summary into one short, single-line string."""
    if text is None:
        return ""
    s = str(text).replace("\n", " ").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "…"


def _fmt_log_args(args: Any) -> str:
    """Format tool call args compactly for the resume log."""
    if isinstance(args, dict):
        parts = []
        for k, v in args.items():
            parts.append(f"{k}={_trim_log_text(v)}")
        return ", ".join(parts)
    return _trim_log_text(args)


def _event_delta(text: str) -> dict:
    return {"kind": "text", "content": text}


def _json_safe(value: Any) -> Any:
    """Recursively coerce a tool-arg value into JSON-serializable form.

    Tool args come from the model's JSON schema (already serializable), but a
    tool wrapper may hand us richer objects (paths, datetime, enums), so coerce
    anything unrecognized to its string form rather than failing the write.
    """
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


# Compact log of tool work performed so far in the CURRENT turn. Fed back as a
# system note on retry so the model continues where it left off instead of
# re-exploring from scratch (the tool calls themselves never enter
# `history_messages` — they only accumulate here between attempts).
def _build_resume_note(
    turn_tool_log: Sequence[str],
    max_entries: int = 40,
    partial_reply: str = "",
) -> str:
    """Build the "resume from previous tool results" note from the tool log tail.

    Only the tail matters and must stay small so the note itself can't overflow
    the window. Returns "" when there is nothing to resume from. When a reply
    was already streaming (e.g. connection dropped mid-turn), the partial text
    is included so the model continues EXACTLY from where it stopped instead
    of restarting the answer.
    """
    parts: list[str] = []
    if turn_tool_log:
        tail = turn_tool_log[-max_entries:]
        omitted = len(turn_tool_log) - len(tail)
        resume_lines = "\n".join(tail)
        if omitted > 0:
            resume_lines += f"\n({omitted} earlier steps omitted)"
        parts.append(
            "Tool work already done so far in THIS turn — do NOT repeat "
            "or re-do any of it; continue from where you stopped:\n"
            f"{resume_lines}"
        )
    partial = partial_reply.strip()
    if partial:
        # Cap the tail so a long streamed reply can't overflow the window on a
        # retry — the END is what matters for continuing, so keep the last chunk.
        if len(partial) > 2000:
            partial = "…" + partial[-2000:]
        parts.append(
            "Your reply was cut off mid-stream. Continue it EXACTLY from where it "
            "stopped — do NOT restart from the beginning:\n"
            f"{partial}"
        )
    return "\n\n".join(parts)


# Persian/Arabic letters that are legally NON-connecting: they never join to a
# following letter, so a lone one at the end of a reply can be a real word
# ("و" = and, "ا" = a/the marker, "د"/"ر"/"ز"/"ژ" after a space are fragments
# of روند but more often standalone). Only the CONNECTING letters are flagged:
# a lone connecting letter (ک، م، ن…) at the end is always a mid-word cut —
# no Persian word is a single connecting letter.
_NON_CONNECTING_PERSIAN = set("اآدذرزژو")


def _dangling_fragment(text: str) -> str:
    """Return the trailing lone Persian/Arabic letter if ``text`` looks like a
    reply cut off mid-word (the ``مشکل ک`` pattern), else "".

    Detects a single connecting letter preceded by whitespace at the very end.
    Non-connecting letters (و، ا، د، ر، ز، ژ) are never flagged — they can be
    legitimate standalone words. A letter glued to a preceding letter (``کتاب``)
    is not matched because it isn't preceded by whitespace. Trailing ZWNJ/ZWNJ+
    (Persian half-space) is stripped first so a cut after ``ک`` + half-space is
    still caught.
    """
    if not text:
        return ""
    cleaned = text.strip().rstrip("\u200c\u200d")
    if not cleaned:
        return ""
    m = re.search(r"\s+([\u0600-\u06FF])\s*$", cleaned)
    if not m:
        return ""
    letter = m.group(1)
    if letter in _NON_CONNECTING_PERSIAN:
        return ""
    return letter


def _usage_event(usage, model: str = "") -> dict | None:
    """
    Extracts usage statistics from the LangChain usage metadata with robust
    fallback. Handles different attribute names used by various LLM providers.
    """
    if not usage:
        return None

    try:
        # 1. Try the standard names used by our LangChain chat-model wrappers.
        input_tokens = getattr(usage, "input_tokens", 0)
        output_tokens = getattr(usage, "output_tokens", 0)
        cache_read_tokens = getattr(usage, "cache_read_tokens", 0)
        cache_write_tokens = getattr(usage, "cache_write_tokens", 0)

        # 2. If both are zero, fall back to the common OpenAI / OpenRouter names.
        if not input_tokens and not output_tokens:
            input_tokens = getattr(usage, "prompt_tokens", 0)
            output_tokens = getattr(usage, "completion_tokens", 0)

            # Last-ditch: usage might be a dict, not an object.
            if isinstance(usage, dict):
                input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
                output_tokens = usage.get(
                    "completion_tokens", usage.get("output_tokens", 0)
                )

        # 3. total_tokens = input + output. input_tokens ALREADY includes
        #    cache_read/cache_write, so we do NOT add cache on top (matches
        #    the opencode convention used by our LangChain wrappers).
        #    Otherwise the context meter would double-count cached tokens.
        total_tokens = int(input_tokens) + int(output_tokens)

        # 3b. یک رکورد usage با صفر توکن، دژنره است (درخواست ردشده/خالی که
        #     provider هیچ توکنی برایش حساب نکرده). اگر emit شود، متر کانتکست
        #     فرانت‌اند را به ۰٪ گمراه‌کننده می‌برد (و بعد با رسیدن usage واقعی
        #     «خودش درست می‌شود»). پس آن را emit نمی‌کنیم تا متر به آخرین
        #     usage واقعی برگردد.
        if total_tokens <= 0:
            return None

        # 4. اطمینان از اینکه خروجی حتماً عدد صحیح (int) است
        return {
            "kind": "usage",
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "total_tokens": total_tokens,
            "cache_read_tokens": int(cache_read_tokens),
            "cache_write_tokens": int(cache_write_tokens),
            "model": model or "",
        }
    except Exception as e:  # noqa: BLE001 — usage parse must never crash the run
        # در صورت بروز هرگونه خطا، برای جلوگیری از کرش کردن برنامه، مقدار صفر برگردانده می‌شود
        logger.warning("Error parsing usage: %s", e)
        return None


# Fraction of the model's context window at which we choose to compact BEFORE an
# overflow: once a request's true input tokens (reported by the provider) pass
# this share of the window, the in-flight tool loop is stopped and the turn is
# re-sent from compacted history instead of waiting to hit the hard limit. This
# --- opencode-compat compaction ------------------------------------------------
# Mirrored from anomalyco/opencode (dev): packages/opencode/src/session/{compaction,overflow}.ts,
# packages/core/src/session/compaction.ts, packages/opencode/src/agent/prompt/compaction.txt.
# The auto-compact trigger is opencode's `isOverflow`: compaction fires when accumulated tokens
# >= `usable`, where `usable = ctx - min(COMPACTION_BUFFER, maxOutputTokens)`. For an 8k model
# (max output ~2k) that's 8192 - 2048 = 6144 (~75% of the window); for a 200k model it is ~96% —
# exactly opencode's behaviour. Recent turns are kept VERBATIM up to a token budget
# (`preserveRecentBudget`) instead of collapsing the whole conversation into one note.
_COMPACTION_BUFFER = 20_000
_TOOL_OUTPUT_MAX_CHARS = 2_000
_SUMMARY_OUTPUT_TOKENS = 8_192
_MIN_PRESERVE_RECENT_TOKENS = 2_000
_MAX_PRESERVE_RECENT_TOKENS = 15_000

# --- Small-context optimisation (local models with tight windows) -----------
# When the configured model context window is below the threshold below we
# switch to a token-frugal prompt assembly: half-size RAG,
# skill index without descriptions, tighter project-memory cap, and tighter
# tool-output trim. Models with ctx ≥ threshold keep the full prompt unchanged.
# Threshold 32k catches qwen2.5-coder:7b (32k), llama3.1:8b (8k/16k),
# gemma2:9b (8k), phi-3/4 (4k-16k). Larger models (Claude/GPT-4 / 200k ctx)
# are unaffected. context_window=0 means "unknown" → safe default (no opt).
_SMALL_CTX_THRESHOLD = 32_000
_SMALL_CTX_RAG_MAX_CHARS = 1_500  # half of _DEFAULT_MAX_CHARS=3_600
_SMALL_CTX_TOOL_OUTPUT_MAX = 1_200  # tighter than _TOOL_OUTPUT_MAX_CHARS=2_000
_SMALL_CTX_PROJECT_MEMORY_MAX = 4_000  # tighter than _PROJECT_MEMORY_MAX_BYTES=12_000


def is_small_context(ctx: int | None) -> bool:
    """True when the configured context window is below the small-model threshold.

    A value of 0 (or non-numeric) means "unknown" and returns False so the
    caller keeps the existing (full) prompt — we never optimise blindly.
    """
    try:
        return 0 < int(ctx or 0) < _SMALL_CTX_THRESHOLD
    except (TypeError, ValueError):
        return False


def _estimate_tokens(text: str) -> int:
    """Heuristic token count. Latin ~4 chars/token; Persian/Arabic ~2.5
    chars/token (opencode's Token.estimate assumes ~4 for latin text)."""
    text = text or ""
    if not text:
        return 1
    persian = len(
        re.findall(
            r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]", text
        )
    )
    latin = max(0, len(text) - persian)
    return max(1, latin // 4 + (persian + 2) // 3)


def _messages_to_dicts(msgs: list) -> list[dict]:
    """Serialize LangChain messages back to the plain ``{role, content}`` dicts
    the compaction algorithm (and the frontend) expect.

    Kept here (not in graph.py) so the sub-agent loop in ``llm.py`` can reuse it
    without importing graph.py (which would be a circular import).
    """
    # Pre-build tool name lookup from AIMessage.tool_calls keyed by id, so
    # each ToolMessage can be tagged with the originating tool name. Without
    # this, downstream code (e.g. _prune_history's protected-tools check)
    # can never identify which tool produced a result, and the protection is
    # silently bypassed for every tool (the dict only carries role/content
    # /tool_call_id otherwise).
    tool_names: dict[str, str] = {}
    for _m in msgs or []:
        if isinstance(_m, AIMessage):
            for _tc in getattr(_m, "tool_calls", None) or []:
                _tcid = _tc.get("id")
                _tname = _tc.get("name")
                if _tcid and _tname:
                    tool_names[_tcid] = _tname
    out: list[dict] = []
    for m in msgs or []:
        if isinstance(m, SystemMessage):
            role = "system"
        elif isinstance(m, HumanMessage):
            role = "user"
        elif isinstance(m, AIMessage):
            role = "assistant"
        elif isinstance(m, ToolMessage):
            role = "tool"
        else:
            continue
        content = getattr(m, "content", "")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append(part.get("text", ""))
                elif isinstance(part, str):
                    parts.append(part)
            content = "".join(parts)
        d = {"role": role, "content": str(content or "")}
        # Preserve the tool-call linkage so a compacted transcript can still be
        # continued by the model. Older summarized turns carry no tool_calls, so
        # this only enriches the in-flight / recent tail that must stay verbatim.
        if isinstance(m, AIMessage):
            tcs = getattr(m, "tool_calls", None) or []
            if tcs:
                d["tool_calls"] = [
                    {
                        "id": tc.get("id"),
                        "name": tc.get("name"),
                        "args": tc.get("args"),
                    }
                    for tc in tcs
                ]
        elif isinstance(m, ToolMessage):
            tcid = getattr(m, "tool_call_id", None)
            if tcid:
                d["tool_call_id"] = tcid
            # Tag the originating tool name so downstream consumers
            # (_prune_history, the frontend history view, etc.) can identify
            # it. Prefer ToolMessage.name (LangChain sets it directly); fall
            # back to the lookup built above from the matching AIMessage's
            # tool_calls.
            _tool_name = getattr(m, "name", None) or tool_names.get(tcid or "")
            if _tool_name:
                d["tool"] = _tool_name
        out.append(d)
    return out


def _model_max_output(model: Any) -> int:
    """opencode's maxOutputTokens for the model (0 when unknown)."""
    info = getattr(model, "model_info", None)
    val = getattr(info, "max_output_tokens", 0) if info is not None else 0
    try:
        return int(val or 0)
    except (TypeError, ValueError):
        return 0


def _usable_tokens(ctx: int, max_output: int = 0, reserved: int | None = None) -> int:
    """opencode `usable`: context window minus the compaction/output reservation.

    When ``reserved`` is provided (the UI's "compaction headroom" in tokens) it is
    used directly, clamped to ``[0, ctx]``. Otherwise opencode's default applies:
    ``reserved = min(COMPACTION_BUFFER, maxOutputTokens)`` where
    ``maxOutputTokens = min(model.limit.output, 32000)`` — i.e. ``0`` when the
    model's output limit is unknown, so compaction only fires near the hard limit.
    """
    if ctx <= 0:
        return 0
    if reserved is None:
        reserved = min(_COMPACTION_BUFFER, max_output) if max_output > 0 else 0
    else:
        reserved = max(0, min(int(reserved), ctx))
    return max(0, ctx - reserved)


def _recent_tail_budget(
    ctx: int, max_output: int = 0, reserved: int | None = None
) -> int:
    """opencode `preserveRecentBudget`: recent turns kept verbatim, in tokens."""
    usable = _usable_tokens(ctx, max_output, reserved)
    return min(
        _MAX_PRESERVE_RECENT_TOKENS,
        max(_MIN_PRESERVE_RECENT_TOKENS, int(usable * 0.25)),
    )


# opencode's compaction agent system prompt (verbatim — keeps the source language).
_COMPACTION_SYSTEM_PROMPT = (
    "You are a context summarization agent. You are given a conversation between a user and an agent. "
    "Your goal is to produce a structured summary matching the format specified so another coding agent "
    "can continue the work.\n\n"
    "The older turns you summarize may describe work that was ALREADY completed — put it in Completed, "
    "and put ONLY still-remaining work in Next Move. Never relist finished work as pending. "
    "Preserve the Task checklist statuses exactly as shown (completed stays completed); "
    "the model resumes from tool results already in context, so carry the checklist forward.\n\n"
    "Always follow the exact output structure requested by the user prompt. Keep every section, preserve "
    "exact file paths and identifiers when known, and prefer terse bullets over paragraphs.\n\n"
    "Do not continue the conversation. Do not respond to any questions in the conversation. Only output the "
    "structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation."
)


# opencode's SUMMARY_TEMPLATE (verbatim structure + rules).
_SUMMARY_TEMPLATE = (
    "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. "
    "Do not include the <template> tags in your response.\n"
    "<template>\n"
    "## Objective\n"
    "- [one or two brief sentences describing what the user is trying to accomplish]\n\n"
    "## Important Details\n"
    "- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to "
    'continue, or "(none)"]\n\n'
    "## Work State\n"
    "### Completed\n"
    '- [finished work, verified facts, or changes made; otherwise "(none)"]\n\n'
    "### Active\n"
    '- [current work IN PROGRESS, including the exact tool call / step being executed right now (so another agent resumes without re-running everything), partial changes, or investigation state; otherwise "(none)"]\n\n'
    "### Blocked\n"
    '- [blockers, failing commands, or unknowns; otherwise "(none)"]\n\n'
    "## Next Move\n"
    '1. [immediate concrete action — the specific next tool call to make, or "(none)"]\n'
    '2. [next action if known, or "(none)"]\n\n'
    "## Relevant Files\n"
    '- [file or directory path: why it matters, or "(none)"]\n'
    "</template>\n\n"
    "Rules:\n"
    "- Keep every section, even when empty.\n"
    "- Use terse bullets, not prose paragraphs.\n"
    "- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.\n"
    "- Do not mention the summary process or that context was compacted.\n"
    "- Completed = work ALREADY finished/verified in the conversation. Active = work CURRENTLY in "
    "flight. Next Move = work NOT yet started.\n"
    "- Next Move MUST list ONLY remaining work. Before writing any step, confirm it is absent from "
    "Completed and Active. Never repeat finished or in-progress work in Next Move.\n"
    "- If a step could fit in both Completed and Next Move, put it in Completed (with a '(verify)' "
    "note if unsure) and OMIT it from Next Move.\n"
    "- Only state that code was added/removed/changed if the conversation explicitly shows the edit "
    "applied AND verified (e.g. ruff/tests passed). Otherwise mark it '(intended, not yet applied to "
    "code)' and do not list acting on it as a pending step.\n"
)


# Worked example shown to the summarizer so it learns the Completed-vs-Next-Move
# separation by imitation (few-shot), not just from the rules above. The retry and
# logging work is FINISHED, so it lives in Completed; only the still-open timeout task
# appears in Next Move.
_SUMMARY_EXAMPLE = (
    "Example of a correct summary (finished work stays in Completed; only the open task is in Next Move):\n"
    "<conversation>\n"
    "User: add a retry to the uploader\n"
    "Agent: added a retry loop in upload.py; ran pytest, all green\n"
    "Agent: also added logging\n"
    "User: now also handle timeouts\n"
    "</conversation>\n"
    "-> Summary:\n"
    "## Objective\n"
    "- Add resilience to the uploader (retry + timeout handling)\n"
    "## Important Details\n"
    "- upload.py holds the uploader\n"
    "## Work State\n"
    "### Completed\n"
    "- retry loop added in upload.py; pytest green\n"
    "- logging added\n"
    "### Active\n"
    "- (none)\n"
    "### Blocked\n"
    "- (none)\n"
    "## Next Move\n"
    "1. add timeout handling to the uploader in upload.py\n"
    "## Relevant Files\n"
    "- upload.py: uploader logic\n"
    "\n"
)


# opencode's SUMMARY_UPDATE_INSTRUCTIONS (used when merging a prior summary).
_SUMMARY_UPDATE_INSTRUCTIONS = (
    "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new "
    "summary that combines both. The <prior-summary> is discarded after this: anything you do not carry "
    "into the new summary is lost.\n\n"
    "When combining:\n"
    "- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the "
    "<prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no "
    "longer needed.\n"
    "- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation "
    "wins: state the corrected fact and drop the old claim.\n"
    "- Add new progress, decisions, constraints, and context from the conversation.\n"
    '- Move completed work from "Active" to "Completed".\n'
    "- If a blocker has been resolved, update the summary to reflect that while keeping any details still "
    "needed to continue the work.\n"
    '- Update "Objective" and "Next Move" to reflect the current work state.'
)


def _summary_output_budget(
    ctx: int, max_output: int = 0, reserved: int | None = None
) -> int:
    """opencode's 4096-token summary ceiling, scaled so it fits small windows."""
    usable = _usable_tokens(ctx, max_output, reserved)
    return max(1024, min(_SUMMARY_OUTPUT_TOKENS, usable - 1024))


# ProcessHistory sliding-window guard. LangGraph re-sends the ENTIRE
# accumulated message history on every model request, so even with the reactive
# _UsageCapability (which compacts at 60% of the window) a long tool-loop turn
# re-sends a growing context on every step — the dominant token cost. This
# processor proactively trims the history BEFORE each request once the run's
# accumulated usage crosses a threshold, keeping the first message (system
# prompt + current user prompt), any existing "[Compacted earlier context]"
# summary, and a recent tail (opencode-style sliding window).
#
# The trigger sits ABOVE the reactive 60% compact so the stop-and-retry compact
# (which builds the summary) fires first; after that, every subsequent request
# stays bounded to the summary + tail instead of re-sending the whole turn.
# A message-count fallback covers providers that report 0 usage (the same gap
# the deterministic tool-step budget covers) so a long turn still gets bounded.
_HISTORY_TRIGGER_FRACTION = 0.70
_HISTORY_MAX_MESSAGES = 40


def _tool_steps_compact_at(ctx: int) -> int:
    """Max tool-loop steps before the deterministic compact safety net fires."""
    if ctx <= 0:
        return 12
    return max(12, min(ctx // 4_000, 30))


class _HighWatermark(Exception):
    """Raised when a single request's input tokens fill too much of the window.

    Carries the measured token total so the auto-compact branch can surface it as
    a compact + usage event (mirroring the overflow path) instead of a raw error.
    An optional ``note`` replaces the default "Context nearly full (N of M)"
    wording when the trigger is NOT a real near-overflow (e.g. the deterministic
    tool-step budget), so the UI never claims a fake token count.
    """

    def __init__(self, tokens: int, limit: int, note: str | None = None) -> None:
        super().__init__(
            note or f"approaching context limit: {tokens} of {limit} tokens"
        )
        self.tokens = tokens
        self.limit = limit
        self.note = note


_PROJECT_MEMORY_CACHE: OrderedDict[str, tuple[float, str]] = OrderedDict()
_PROJECT_MEMORY_CACHE_MAX = 64


def _load_project_memory(root: str, max_bytes: int = _PROJECT_MEMORY_MAX_BYTES) -> str:
    """Read the project's persistent instructions file, if present.

    Returns a ready-to-append system-prompt section, or ``""`` if no such file
    exists. Never raises — a missing or unreadable file just yields nothing.

    Cached per ``root`` keyed on the newest file's mtime, so repeated turns in
    the same session skip the disk read + string assembly (the content is
    static across turns unless the file is edited). The cache is bounded so
    long sessions that touch many workspaces don't grow it without bound.

    ``max_bytes`` lets small-context callers use a tighter cap; the cache only
    holds the trimmed result for the latest caller, so cross-session re-entry
    with a different cap simply re-runs the read.
    """
    mtime = 0.0
    for rel in _PROJECT_MEMORY_FILES:
        try:
            mtime = max(mtime, os.path.getmtime(os.path.join(root, rel)))
        except OSError:
            pass
    cached = _PROJECT_MEMORY_CACHE.get(root)
    if cached is not None and cached[0] >= mtime:
        # Touch — move to the back so the LRU eviction keeps the active workspace.
        _PROJECT_MEMORY_CACHE.move_to_end(root)
        return cached[1]
    result = _read_project_memory(root, max_bytes=max_bytes)
    _PROJECT_MEMORY_CACHE[root] = (mtime, result)
    _PROJECT_MEMORY_CACHE.move_to_end(root)
    while len(_PROJECT_MEMORY_CACHE) > _PROJECT_MEMORY_CACHE_MAX:
        _PROJECT_MEMORY_CACHE.popitem(last=False)
    return result


def _read_project_memory(root: str, max_bytes: int = _PROJECT_MEMORY_MAX_BYTES) -> str:
    """Read the project memory file (uncached core of _load_project_memory).

    The full file is always returned: project memory holds the owner's
    persistent instructions and is part of the system prompt, so it must
    never be truncated. ``max_bytes`` is retained for backward compatibility
    and no longer caps the output."""
    for rel in _PROJECT_MEMORY_FILES:
        try:
            result = read_file(root, rel)
        except Exception:  # noqa: BLE001, S112 — missing/unreadable memory file is fine
            continue
        if not result or "content" not in result:
            continue
        body = result["content"].strip()
        if not body:
            continue
        return (
            f"\n\n===== PROJECT MEMORY ({rel}) =====\n"
            "The project owner left these persistent instructions. Follow them for "
            "every request in this project unless the user explicitly overrides one "
            "in the current message.\n"
            f"{body}\n"
            "===== END PROJECT MEMORY ====="
        )
    return ""


# The agent's OWN self-written memory (distinct from the user-authored AGENTS.md
_FTS_STOPWORDS = frozenset(
    [
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "to",
        "of",
        "in",
        "on",
        "at",
        "for",
        "and",
        "or",
        "but",
        "not",
        "this",
        "that",
        "these",
        "those",
        "i",
        "you",
        "he",
        "she",
        "it",
        "we",
        "they",
        "my",
        "your",
        "his",
        "her",
        "its",
        "our",
        "their",
        "with",
        "as",
        "by",
        "from",
        "up",
        "down",
        "out",
        "about",
        "into",
        "over",
        "after",
        "before",
        "again",
        "then",
        "once",
        "here",
        "there",
        "when",
        "where",
        "why",
        "how",
        "all",
        "any",
        "both",
        "each",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "no",
        "nor",
        "only",
        "own",
        "same",
        "so",
        "than",
        "too",
        "very",
        "can",
        "will",
        "just",
        "should",
        "now",
        "do",
        "does",
        "did",
        "have",
        "has",
        "had",
        "if",
        "need",
        "needs",
        "want",
        "wants",
        "look",
        "looks",
        "check",
        "checks",
        "actually",
        "really",
        "را",
        "به",
        "از",
        "که",
        "این",
        "آن",
        "با",
        "برای",
        "تا",
        "یا",
        "و",
        "اگر",
        "است",
        "بود",
        "شد",
        "کن",
        "کنم",
        "میخوام",
        "میخواهم",
        "باید",
        "رو",
        "هم",
        "یک",
        "چه",
        "چطور",
        "کجا",
        "شده",
        "نیست",
        "نبود",
        "چیزی",
        "همه",
        "هر",
        "خیلی",
        "توی",
        "شما",
        "اون",
        "اینو",
    ]
)


def _fts_keywords(query: str, max_terms: int = 6) -> list[str]:
    """Extract significant words from a free-text query for OR-style lexical
    search. fts_search ANDs every word it is given, so feeding it a whole
    natural-language sentence (a user's actual turn) almost always yields
    zero matches. Searching each keyword separately gets OR semantics while
    reusing fts_search unchanged.
    """
    stop = _FTS_STOPWORDS
    tokens = re.findall(r"[\w\u0600-\u06FF]+", query or "")
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        low = t.lower()
        if len(t) < 3 or low in stop or low in seen:
            continue
        seen.add(low)
        out.append(t)
    out.sort(key=len, reverse=True)
    return out[:max_terms]


# Conservative defaults so even small-context local models (e.g. 8k) fit.
# Larger context windows unlock richer scouting (see run_agent).
_AUTO_SCOUT_MAX_KEY_BYTES = 6_000
_AUTO_SCOUT_MAX_TOTAL = 8_000


def _needs_workspace(prompt: str) -> bool:
    """Structural heuristic for when auto-scouting is worth doing.

    Workspace scouting only helps when the user's request is about the project.
    We skip it for turns that are clearly external or trivial — no keyword lists,
    just shape:

    * contains a host/domain / URL / IP (a web, availability or whois lookup);
    * is a very short message (greeting, punctuation like "?", one-liner).

    File paths (src/main.py) and code identifiers are NOT treated as domains, so
    real project work still gets the overview.
    """
    try:
        text = prompt.strip()
    except AttributeError:
        return False
    if not text:
        return False

    if len(text) <= 8:
        return False

    # Host/domain/IP tokens. Each whitespace token is checked standalone:
    #   - scheme://host… URLs,
    #   - host:port (e.g. localhost:1234, 127.0.0.1:8000),
    #   - name.tld hostnames — but NOT file paths (leading "/") and NOT code
    #     identifiers that merely end in a dotted code extension (x.py, y.ts).
    # Common code file extensions are excluded from the "tld" match.
    code_exts = {
        "py",
        "ts",
        "tsx",
        "js",
        "jsx",
        "css",
        "json",
        "md",
        "html",
        "htm",
        "go",
        "rs",
        "rb",
        "java",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "php",
        "vue",
        "sh",
        "toml",
        "yml",
        "yaml",
        "ini",
        "sql",
        "txt",
        "map",
        "d.ts",
    }
    for tok in re.split(r"\s+", text):
        low = tok.lower()
        if re.match(r"https?://", low):
            return False
        if re.match(r"localhost:\d+$", low):
            return False
        if re.match(r"^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$", low):
            return False
        if low.startswith(("/", "./", "../")):
            continue  # file path
        m = re.match(r"^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.([a-z]{2,6})$", low)
        if m and m.group(2) not in code_exts:
            return False

    # Explicitly-labeled EXTERNAL log dump: the user says the error comes from
    # another application / the OS — "این خطای لاگ از electron هست", "console
    # error from docker" — and the text carries a runtime-error signature (a JS
    # ReferenceError/TypeError/etc., `ERROR:`, `Error Domain=`, traceback,
    # panic). That is a knowledge question about the OTHER app, so scouting THIS
    # repo only burns tokens and tempts the model into irrelevant file hunting.
    # The stack frame names the foreign app's own file (`app.js:2`) — it is not
    # this project, so it must NOT count as a project hook here.
    _EXT_SOURCES = (
        "electron",
        "chromium",
        "browser",
        "docker",
        "node",
        "v8",
        "مک",
        "ویندوز",
        "اندروید",
        "سیستم",
        "مرورگر",
    )
    _PROJECT_WORDS = (
        "پروژه",
        "ورک‌اسپیس",
        "workspace",
        "repo",
        "این برنامه",
        "برنامه من",
        "کد من",
        "my app",
    )
    _LOG_FRAMING = (
        "خطای لاگ",
        "ارور لاگ",
        "لاگ از",
        "error from",
        "console error",
        "terminal error",
        "comes from",
        "is coming from",
    )
    if any(s in text.lower() for s in _LOG_FRAMING) and re.search(
        r"(ReferenceError|TypeError|SyntaxError|RangeError|Uncaught (?:Error|Exception)|"
        r"Error Domain=|Traceback \(most recent call last\)|\bpanic:|\bERROR:)",
        text,
        re.IGNORECASE,
    ):
        # A named external source settles it — external, no scouting — UNLESS
        # the same message also ties the log to this project ("خطای لاگ از
        # electron پروژه خودم"), in which case fall through to the hook check.
        if any(s in text.lower() for s in _EXT_SOURCES) and not any(
            w in text.lower() for w in _PROJECT_WORDS
        ):
            return False
        # No named source: only treat it as external if there is also no project
        # hook (path / dotted code-extension token) pointing at repo files.
        for tok in re.split(r"\s+", text):
            low = tok.lower().strip("[]():,;\"'`*_")
            if low.startswith(("/", "./", "../")):
                return True
            if low.endswith(tuple("." + ext for ext in code_exts)):
                return True
        return False

    # A self-contained EXTERNAL error/log dump with a question — but NO hook
    # into the project (no file path, no code-symbol token) — is a knowledge
    # question, not a project task: e.g. a pasted macOS console line
    # ``[1234:0814/..:ERROR:system_services.cc(34)] ... Error Domain=...``
    # with a Persian "این مشکل چیه؟". Scouting the workspace for it only burns
    # tokens and nudges the model into irrelevant exploration of a repo the
    # error has nothing to do with. Shape-only test using the distinctive
    # externals: a process-prefixed log line, a Cocoa ``Error Domain=...``
    # pair, a Python traceback, or a Rust panic — plus a question intent.
    if re.search(
        r"(\[\d{1,6}:[\d./]+:[A-Z]+:[^\]]*\])"
        r"|(Error Domain=[A-Za-z_.]+ Code=-?\d+)"
        r"|(Traceback \(most recent call last\))"
        r"|\bpanic\b",
        text,
        re.IGNORECASE,
    ) and re.search(
        r"what is|what does|what's|why|how do|چیه|چیست|چرا|مشکل|خطا|اشکال|علت|چه",
        text,
        re.IGNORECASE,
    ):
        # Project hook? A path or a dotted code-extension token means the user
        # IS pointing at project files — keep scouting for those.
        for tok in re.split(r"\s+", text):
            low = tok.lower().strip("[]():,;\"'`*_")
            if low.startswith(("/", "./", "../")):
                return True
            if low.endswith(tuple("." + ext for ext in code_exts)):
                return True
        return False

    return True


# --- output-budget scope (narrow tasks get a tighter reply ceiling) -------- #
# Classifies a task as "narrow" (targeted lookup/fix — the answer is short and
# the code lands via tool results) vs "broad" (architecture/overview — the
# reply can legitimately be long). Drives the proportional narrow cap in
# _settings_for. Keyword-based on purpose — cheap and stable, not a classifier.
# Broad is checked FIRST so "how does the whole architecture work end to end"
# stays broad even though it contains "how does". Unclear prompts return ""
# (full budget) — safer than cutting off a long answer.
def _scope_contains(text: str, hint: str) -> bool:
    """تطبیق سرنخ با مرز کلمه تا زیررشته حدس غلط نزند («کلیک»/«نشانه»/«کلیه»)."""
    hint = (hint or "").strip().lower()
    if not hint:
        return False
    if any(ch.isalnum() or ch == "_" for ch in hint):
        try:
            return re.search(r"(?<!\w)" + re.escape(hint) + r"(?!\w)", text) is not None
        except re.error:
            return hint in text
    return hint in text


def _detect_scope(prompt: str) -> str:
    """Detect question scope (broad/narrow) with keyword + word boundaries.

    Keyword rules only (near-zero milliseconds). Never raises.
    """
    if not prompt:
        return ""
    low = prompt.lower()
    _broad_hits = (
        "architecture",
        "overview",
        "end to end",
        "whole",
        "entire codebase",
        "entire project",
        "how does everything",
        "how does the whole",
        "how everything",
        "understand the codebase",
        "full picture",
        "deep dive",
        "comprehensive",
        "explain the system",
        "design",
        "all the files",
        "every file",
        "all files",
        "how do all",
        "what are all",
        "list all",
        "compare",
        "differences between",
        "refactor",
        "migrate",
        "restructure",
        "rewrite",
        "plan",
        # معادل‌های فارسی دامنه گسترده — فقط عبارت‌های چندکلمه‌ای/دقیق تا
        # زیررشته حدس غلط نزند («کلی» در «کلیک»، «برنامه» در «تو برنامه یه باگ هست»)
        "معماری",
        "کل پروژه",
        "کل کد",
        "همه فایل",
        "مقایسه",
        "تفاوت",
        "بازطراحی",
        "مهاجرت",
        "بازنویسی",
        "طراحی",
        "نقشه",
        "برنامه‌ریزی",
        "برنامه ریزی",
    )
    if any(_scope_contains(low, k) for k in _broad_hits):
        return "broad"
    _narrow_hits = (
        "find",
        "where is",
        "where's",
        "what is",
        "what's",
        "which file",
        "which function",
        "which class",
        "locate",
        "search",
        "show me",
        "how is",
        "how does",
        "why does",
        "why is",
        "is there",
        "does it",
        "fix",
        "bug",
        "error",
        "typo",
        "rename",
        "delete",
        "remove",
        "add",
        "change",
        "update",
        "parameter",
        "argument",
        "signature",
        "definition",
        "defined",
        "implement",
        "usage",
        "call",
        "function",
        "class",
        "variable",
        "import",
        "export",
        "test",
        "run",
        "explain briefly",
        "short",
        "quick",
        "what does",
        "what happens",
        # معادل‌های فارسی دامنه محدود — فقط دقیق‌ها («نشان» در «نشانه» نه)
        "پیدا",
        "کجاست",
        "کدام فایل",
        "کدام تابع",
        "جستجو",
        "نشان بده",
        "نشانم بده",
        "نمایش بده",
        "چرا",
        "چطور",
        "چگونه",
        "رفع",
        "خطا",
        "باگ",
        "اشکال",
        "تغییر",
        "اضافه",
        "حذف",
        "اصلاح",
        "توضیح کوتاه",
        "خلاصه",
        "کوتاه",
        "سریع",
    )
    if any(_scope_contains(low, k) for k in _narrow_hits):
        return "narrow"
    # Ambiguous input returns full budget (""): this sync helper runs inside
    # the async path, so the safest default is the full budget.
    return ""


# --- test verification (never finish a test task with red tests) ---------- #
# Prompt-level signal that a build task is about writing/fixing/running tests.
# English "test" is matched as a whole word so "latest"/"contest" never trip
# it; Persian "تست" is unambiguous and matched as a substring.
_TEST_TASK_RE = re.compile(
    r"(?:\btest(?:s|ing)?\b|pytest|vitest|jest|junit|\bspec\b)",
    re.IGNORECASE,
)

# Terminal commands that actually run the project's tests. A `run_terminal`
# call matching this satisfies the test-verification step.
_TEST_CMD_RE = re.compile(
    r"(pytest|vitest|jest|node --test|node:test|npm test|npm run test|"
    r"npm run test:|pnpm test|pnpm run test|yarn test|yarn run test|"
    r"bun test|deno test|nx test|cargo test|go test|mvn test|gradle test|"
    r"\./gradlew test|ant test|dotnet test|flutter test|dart test|mix test|"
    r"rake test|rspec|phpunit|tox|nox|python -m unittest|playwright test|"
    r"cypress run|mocha|ava|run_tests|test\.py|test\.ts|test\.js)",
    re.IGNORECASE,
)


def _is_test_task(prompt: str, picked_skills: Sequence[dict] | None = None) -> bool:
    """True when the prompt (or an attached skill) is about tests.

    Drives the prompt-level TEST VERIFICATION RULE injection in ``graph.py``.
    """
    p = (prompt or "").lower()
    if "تست" in p:
        return True
    if _TEST_TASK_RE.search(p):
        return True
    if picked_skills:
        for s in picked_skills:
            slug = slugify(s.get("name", ""))
            if "test" in slug or "تست" in slug:
                return True
    return False


# Live user-like testing intent (generic across projects and stacks).
# Matches explicit live-test requests in English and Persian so the graph can
# inject the LIVE TEST RULE instead of the unit-test verification rule.
_LIVE_TEST_RE = re.compile(
    r"(?:live[\s_\-]*test|test[\s_\-]*live|live[\s_\-]*run|run[\s_\-]*live|"
    r"as[\s_\-]+a[\s_\-]+user|like[\s_\-]+a[\s_\-]+user|real[\s_\-]+browser|"
    r"\be2e\b|end[\s_\-]+to[\s_\-]+end|"
    r"تست[\s_]*لایو|لایو[\s_]*تست|تست[\s_]*زنده|اجرای[\s_]*زنده|"
    r"مثل[\s_]*کاربر|همچون[\s_]*کاربر|بالا[\s_]*بیار)",
    re.IGNORECASE,
)


def _is_live_test_task(prompt: str) -> bool:
    """True when the user asks for live user-like testing, not code tests."""
    p = (prompt or "").strip()
    if not p:
        return False
    return bool(_LIVE_TEST_RE.search(p))


# Implementation-task detection: a build task that CHANGES code (feature, fix,
# refactor, implement, add, ...) must write/update tests and run them before
# finishing. Broader than `_is_test_task` (which only fires when the prompt
# explicitly mentions tests) so the agent doesn't "forget" tests on ordinary
# feature/bugfix work — the exact gap the user reported. Trivial/doc-only
# prompts (README, typo, rename, config, styling, "explain") are excluded:
# they don't need tests.
_IMPL_TASK_RE = re.compile(
    r"(?:\b(feature|fix|bug|implement|implementation|refactor|add|create|"
    r"build|write|update|change|modify|improve|extend|support|handle|migrate|"
    r"upgrade|optimize|rewrite|rework|repair|resolve|correct)\b|"
    r"بساز|بنویس|درست|رفع|اضافه|ساخت|اصلاح|بهبود|تغییر)",
    re.IGNORECASE,
)

# Prompts that are clearly NOT implementation work — no tests needed.
# NOTE: this is intentionally narrow. A change that alters behavior/logic
# (even a one-line bug fix) DOES need a test; only pure cosmetic/refactor/doc
# work is excluded. The coder prompt tells the agent to skip tests for those.
_TRIVIAL_TASK_RE = re.compile(
    r"(?:\b(readme|docs?|documentation|comment|typo|rename|"
    r"style|styling|css|color|font|explain|what|why|how|list|show|"
    r"summar|translate|format|"
    r"config|setting|env|environment|variable|constant|flag|option|preference|"
    r"log|logging|error.?message|warn|info.?message|"
    r"import|sort|order|organize|clean.?up|remove.?dead)\b|"
    r"مستند|توضیح|چیست|چطور|خلاصه|ترجمه|"
    r"پیکربندی|متغیر|ورودی|پیام|خطا|ورود)",
    re.IGNORECASE,
)


def _is_impl_task(prompt: str) -> bool:
    """True when the prompt asks for code changes that need tests.

    Complements ``_is_test_task``: catches ordinary feature/bugfix/refactor
    requests so the TEST VERIFICATION RULE and the loop-level follow-up also
    apply to them, while skipping trivial/doc-only prompts.
    """
    p = (prompt or "").strip().lower()
    if not p or len(p) <= 8:
        return False
    if _TRIVIAL_TASK_RE.search(p):
        return False
    return bool(_IMPL_TASK_RE.search(p))


def _is_code_task(prompt: str) -> bool:
    """True when the prompt plausibly involves code changes that need tests.

    Broader than ``_is_impl_task``: fires on ANY non-trivial, non-doc-only
    prompt (no keyword required), so a build turn that ends up editing code
    is always covered — the user should never have to explicitly ask for
    tests. Trivial/doc-only prompts (README, typo, explain, ...) are
    excluded: they don't need tests. This predicate only decides whether the
    prompt-level TEST VERIFICATION RULE is injected in ``graph.py``.
    """
    p = (prompt or "").strip().lower()
    if not p or len(p) <= 8:
        return False
    return not _TRIVIAL_TASK_RE.search(p)


def _trivial_prompt(prompt: str) -> bool:
    """True for prompts too trivial to warrant a todo checklist (update_plan).

    Mirrors the shape check in ``_needs_workspace`` — a greeting or one-liner
    (≤ 8 chars) needs no live progress list, so Ask mode skips the
    ``update_plan`` tool for it and saves a whole extra model round-trip
    (LangGraph re-sends the full message list on every tool-loop step).
    Real questions keep the tool; RAG and skills are never affected.
    """
    return len((prompt or "").strip()) <= 8


def _scout_workspace(root: str, max_total: int = _AUTO_SCOUT_MAX_TOTAL) -> str:
    """Build a compact workspace overview (root listing + small key files) so weak
    models see the project even if they never call the file tools.

    The listing reuses ``list_files``/``read_file`` (already sandboxed to root);
    any error is swallowed so scouting is purely additive. ``max_total`` caps the
    total encoded size so it never overflows a small model's context window.
    """
    try:
        listing = list_files(root, "")
    except Exception:  # noqa: BLE001
        listing = {}
    lines: list[str] = []
    lines.append(
        "=== AUTO-SCOUTED WORKSPACE OVERVIEW (do not take this as exhaustive) ===\n"
        "This already covers the workspace root — do NOT list the root again "
        "this turn. Go straight to glob/read on the specific "
        "subdirectories or files you actually need."
    )
    try:
        root_real = resolve_safe(root, "")
    except Exception:  # noqa: BLE001
        root_real = root
    if listing.get("error"):
        lines.append(f"root: {root_real}  (listing unavailable: {listing['error']})")
    else:
        entries = listing.get("entries", [])
        names = ", ".join(e["name"] for e in entries) if entries else "(empty)"
        lines.append(f"root: {root_real} — top-level entries: {names}")

    if max_total <= 0:
        return "\n".join(lines)

    header = len("\n".join(lines)) + 24
    total = 0
    for key in _AUTO_SCOUT_KEY_FILES:
        try:
            result = read_file(root, key)
        except Exception:  # noqa: BLE001, S112 — a missing key file just isn't scouted
            continue
        if not result or "content" not in result:
            continue
        body = result["content"]
        # Cap a single file and the cumulative budget.
        budget = min(_AUTO_SCOUT_MAX_KEY_BYTES, max_total - header - total)
        if budget <= 0:
            break
        if len(body) > budget:
            body = body[:budget] + "\n…(truncated)"
        lines.append(f"\n### {key} (auto-scouted)\n{body}")
        total += len(body)
        if total >= max_total - header:
            break
    return "\n".join(lines)


# chat_id -> (staleness signature, max_total used, cached scout text). Kept in
# memory only (cleared on backend restart) — that's fine, a fresh scout on the
# first turn of a new process is negligible next to doing it EVERY turn.
_SCOUT_CACHE: dict[str, tuple[str, int, str]] = {}
_SCOUT_CACHE_MAX_CHATS = 500


def _scout_signature(root: str) -> str:
    """Cheap staleness signature for the scout cache: the workspace root's own
    mtime (catches files/dirs added, removed or renamed at the top level) plus
    each auto-scouted key file's mtime (catches edits to their content). Never
    raises — a failure just returns a sentinel that never matches a cached
    signature, so it always falls back to a fresh (correct) scan instead of
    ever serving stale content.
    """
    try:
        parts = [str(os.path.getmtime(root))]
    except Exception:  # noqa: BLE001
        return "unknown"
    for key in _AUTO_SCOUT_KEY_FILES:
        try:
            full = resolve_safe(root, key)
            parts.append(f"{key}:{os.path.getmtime(full)}")
        except Exception:  # noqa: BLE001, S112 — unreadable key just isn't part of the fingerprint
            continue
    return "|".join(parts)


def _scout_workspace_cached(root: str, chat_id: str, max_total: int) -> str:
    """Same output as `_scout_workspace`, but skips the actual directory
    listing + key-file reads — the expensive part that gets re-encoded and
    re-sent to the model on EVERY turn — when nothing in the workspace has
    changed since the last turn in this chat. This is the single biggest fixed
    per-turn token cost (up to ~12k tokens on a large-context model), and it's
    almost always identical turn-to-turn within one session, so re-scanning it
    every message was pure waste, not fresher information.

    Falls back to always-fresh (no caching) when there's no chat_id to key on,
    e.g. the standalone /compact summarizer call.
    """
    if not chat_id:
        return _scout_workspace(root, max_total=max_total)
    sig = _scout_signature(root)
    cached = _SCOUT_CACHE.get(chat_id)
    if cached and cached[0] == sig and cached[1] == max_total:
        return cached[2]
    result = _scout_workspace(root, max_total=max_total)
    if len(_SCOUT_CACHE) >= _SCOUT_CACHE_MAX_CHATS and chat_id not in _SCOUT_CACHE:
        _SCOUT_CACHE.pop(next(iter(_SCOUT_CACHE)))
    _SCOUT_CACHE[chat_id] = (sig, max_total, result)
    return result


def _is_output_budget_exhausted(exc: BaseException) -> bool:
    """True for LangChain's "the model burned its entire per-request
    `max_tokens` output budget on invisible reasoning/thinking tokens and
    produced no visible reply" error.

    This is DELIBERATELY checked separately from `_is_context_overflow`: that
    function's heuristic ("token" + "limit"/"exceed") also matches this
    message's wording, but the two are not the same failure. A context
    overflow means the request's INPUT was too big — compacting history
    genuinely frees room and fixes it. This error means the input was FINE;
    the model simply spent its whole OUTPUT budget on reasoning before saying
    anything. Compacting history does nothing for that (the retried request
    hits the exact same empty-output wall), so callers must not route this
    into the auto-compact branch — see the dedicated handling in the retry
    loop, which instead turns reasoning down.
    """
    return "exceeded before any response was generated" in str(exc).lower()


def _is_context_overflow(exc: BaseException) -> bool:
    """Best-effort detection of a "context window is full" model error.

    Providers report this in varied wording (context_length_exceeded, "prompt
    is too long", "exceeded the context", "token limit", "exceeds available
    context size" ...). This is NOT a transient blip to backoff-and-retry; it
    means the request itself is too big to complete, so the only way to
    continue is to compact first.

    Instead of an exhaustive phrase whitelist (which misses the long tail of
    provider wordings), we look for a context/token concept COMBINED with an
    exhaustion signal ("exceed/exceeds/exceeded", "too long/large", "limit",
    "available size", "increase", ...). Missing either side → not a context
    overflow.
    """
    low = str(exc).lower()
    if not any(k in low for k in ("context", "token")):
        return False

    # Exhaustion signals — stop early on generic long strings that merely
    # mention the word "context" but aren't an overflow (e.g. we don't want a
    # normal "watch the context" instruction matched).
    signals = (
        "exceed",
        "too long",
        "too large",
        "too many",
        "maximum context",
        "max context",
        "context length",
        "context window",
        "context_limit",
        "context_size",
        "available context size",
        "token limit",
        "token_limit",
        "reduce the length",
        "reducing available tokens",
        "window is too small",
        "increase it",
        "try reducing",
        "please reduce",
        "needs to be smaller",
        "truncat",
    )
    return any(s in low for s in signals)


def _overflow_tokens(exc: BaseException) -> int | None:
    """Extract the token count from an overflow error message like
    ``request (9253 tokens) exceeds the available context size (8192 tokens)``.

    Used to report an accurate context meter even when the request was
    rejected before the provider returned real usage.
    """
    text = str(exc)
    m = re.search(r"(\d{1,3}(?:,\d{3})*|\d+)\s+tokens", text, re.IGNORECASE)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _mechanical_summary(older: list[dict], text: str) -> str:
    """Degraded-but-non-empty summary when the LLM summarizer fails, so older
    context is never dropped with no note at all. Builds an opencode-style note
    (Objective / Work State / Next Move / Relevant Files) from the older turns."""
    import re

    def _text(m: dict) -> str:
        content = m.get("content") or ""
        if isinstance(content, list):
            content = " ".join(
                str(c.get("text", "")) if isinstance(c, dict) else str(c)
                for c in content
            )
        return str(content).strip()

    parts: list[str] = []

    # The compacted note must read in ENGLISH (headers are already); drop
    # verbatim user/assistant prose when it isn't ASCII (e.g. Persian/Farsi),
    # since this fallback has no translation ability — paths & commands below
    # are already English and carry the substance.
    def _english_safe(raw: str, fallback: str) -> str:
        return raw if raw.isascii() else fallback

    # Objective: the most recent user request (fall back to the first user turn).
    objective = ""
    for m in reversed(older):
        if m.get("role") == "user":
            objective = _text(m)[:400]
            if objective:
                break
    if not objective:
        for m in older:
            if m.get("role") == "user":
                objective = _text(m)[:400]
                if objective:
                    break
    objective = _english_safe(
        objective,
        "(LLM summarizer unavailable — mechanical fallback; original request was not in English)",
    )
    parts.append(
        "## Objective\n"
        + (objective or "(LLM summarizer unavailable — mechanical fallback)")
    )

    # Relevant files — also the best mechanical evidence of what was touched.
    paths = sorted(
        set(
            re.findall(
                r"(?:^|[\s\"'`(])((?:[A-Za-z0-9_./-]+/)+[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|css|html|sh|toml|yaml|yml))",
                text,
            )
        )
    )

    # Work State / Completed: past-tense action lines from assistant turns
    # (files edited, commands run); fall back to the touched file list.
    completed: list[str] = []
    action_re = re.compile(
        r"(?:Edited|Created|Added|Updated|Fixed|Removed|Renamed|Moved|Deleted|Wrote|"
        r"Refactored|Rewrote|Implemented|Introduced|Configured|Installed|Bumped|Merged)\s+"
        r"((?:[A-Za-z0-9_./-]+/)+[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|json|md|css|html|sh|toml|yaml|yml))",
        re.IGNORECASE,
    )
    cmd_re = re.compile(
        r"(?:Ran|ran|Running)\s+([`'\"]([^`'\"]+)[`'\"]|[\w@./-]+(?:\s+[\w@./-]+){0,2})"
    )
    for m in older:
        if m.get("role") != "assistant":
            continue
        content = _text(m)
        for match in action_re.finditer(content):
            line = "- " + match.group(0).strip()
            if line not in completed:
                completed.append(line)
        for match in cmd_re.finditer(content):
            cmd = re.sub(
                r"^(?:Ran|Running)\s+", "", match.group(0), flags=re.IGNORECASE
            ).strip("`'\"")
            line = f"- ran: {cmd[:100]}"
            if line not in completed:
                completed.append(line)
    if not completed and paths:
        completed = [f"- touched: {p}" for p in paths[:15]]

    # Work State / Active: the last assistant action (English-only).
    last_action = ""
    for m in reversed(older):
        if m.get("role") == "assistant":
            last_action = _english_safe(_text(m)[:400], "")
            if last_action:
                break

    work_state: list[str] = []
    if completed:
        work_state.append("**Completed**\n" + "\n".join(completed[:15]))
    if last_action:
        work_state.append("**Active**\n" + last_action)
    if work_state:
        parts.append("## Work State\n" + "\n\n".join(work_state))

    # Next Move: continue the objective.
    parts.append(
        "## Next Move\nContinue: " + (objective or "see the most recent messages.")
    )

    if paths:
        parts.append("## Relevant Files\n" + "\n".join(f"- {p}" for p in paths[:25]))

    return "\n".join(parts)


# Application / tool error fragments that must NOT survive into the compact
# summary. Tool results are embedded inside assistant turns (the frontend only
# sends user/assistant/system roles to the backend), so a failed tool leaks its
# error text straight into the next compaction. We strip those lines but keep
# the surrounding real reasoning and any SUCCESSFUL tool output.
_APP_ERROR_LINE = re.compile(
    r"^(\[Tool error\]|ERROR\b|Error code:|Traceback \(most recent call last\))",
    re.IGNORECASE,
)


def _redact_app_errors(text: str) -> str:
    """Drop app/tool error lines from a message so they don't poison the compact
    summary. Real user/assistant reasoning and successful tool output are kept.

    A contiguous run of error lines is collapsed to a single breadcrumb so the
    summarizer still knows a step failed, without inheriting the raw error.
    Python tracebacks (``Traceback (most recent call last)``) consume their
    frame lines until the next blank line.
    """
    out: list[str] = []
    in_traceback = False
    for line in text.splitlines():
        s = line.strip()
        low = s.lower()
        if in_traceback:
            if s == "":
                in_traceback = False
                out.append("")
                continue
            # frame/continuation lines are indented or start with File/raise/at
            if line[:1] in (" ", "\t") or low.startswith(
                ("file ", "at ", "raise ", "except ")
            ):
                continue
            in_traceback = False
        if _APP_ERROR_LINE.match(s):
            if "traceback" in low:
                in_traceback = True
                if not out or not out[-1].startswith("[app/tool error"):
                    out.append("[app/tool error — details omitted from summary]")
                continue
            if not out or not out[-1].startswith("[app/tool error"):
                out.append("[app/tool error — details omitted from summary]")
            continue
        out.append(line)
    return "\n".join(out)


_PRUNE_PROTECT_TOKENS = 40_000
_PRUNE_MIN_TOKENS = 20_000
# Short checklist ticks must survive pruning while large outputs are cleared,
# so post-compact context still shows progress without an extra roundtrip.
_PRUNE_PROTECTED_TOOLS = frozenset({"skill", "load_skill", "update_plan"})

# Marker for the previous-turn outcome note (see trace_store.format_turn_outcome_note).
# This evidence must survive pruning and compaction so the next turn can report
# from it instead of re-executing finished work.
_TURN_OUTCOME_MARKER = "[Previous turn"

_STATUS_CHECK_RE = re.compile(
    r"^\s*(تموم\s*شد\??|تمام\s*شد\??|done\??|finished\??|is\s+it\s+done\??|"
    r"all\s*done\??|status\??|ready\??)\s*[؟?!.\s]*$",
    re.IGNORECASE,
)


def _is_status_check(prompt: str) -> bool:
    """True for short confirmation prompts asking whether work is done."""
    p = (prompt or "").strip().lower()
    if not p or len(p) > 40:
        return False
    return bool(_STATUS_CHECK_RE.search((prompt or "").strip()))


def _turn_terminal_state(plan_items: list | None, prompt: str = "") -> str:
    """Explicit terminal state for a finished turn: completed or incomplete."""
    if _is_status_check(prompt or ""):
        return "completed"
    items = plan_items if isinstance(plan_items, list) else []
    clean = [it for it in items if isinstance(it, dict) and str(it.get("content") or "").strip()]
    if clean and all(str(it.get("status") or "").strip().lower() == "completed" for it in clean):
        return "completed"
    if not clean:
        return "completed"
    return "incomplete"


def _prune_history(history: list[dict], enabled: bool = True) -> list[dict]:
    """Drop old, large tool outputs so a long transcript sheds context before the
    heavier summarization pass (mirrors opencode's prune: only tool outputs from
    turns older than the final two are cleared, and protected tools never are).

    Runs in place on ``history`` and returns it. Nothing is touched when pruning is
    disabled, the transcript has fewer than two user turns, or the old tool output
    is below ``_PRUNE_PROTECT_TOKENS``.
    """
    if not enabled:
        return history
    user_idx = [i for i, m in enumerate(history) if m.get("role") == "user"]
    if len(user_idx) < 2:
        return history
    # Tool outputs inside the final two user turns stay (recent context).
    protected_start = user_idx[-2]
    candidates = [
        i
        for i, m in enumerate(history)
        if m.get("role") == "tool"
        and i < protected_start
        and m.get("tool") not in _PRUNE_PROTECTED_TOOLS
        and _TURN_OUTCOME_MARKER not in str(m.get("content", ""))
    ]
    old_tokens = sum(
        _estimate_tokens(str(m.get("content", "")))
        for m in (history[i] for i in candidates)
    )
    if old_tokens < _PRUNE_PROTECT_TOKENS:
        return history
    for i in candidates:
        history[i] = {
            **history[i],
            "content": "[Old tool result content cleared]",
            "compacted": True,
        }
    return history


def _normalize_history_order(history: list[dict]) -> list[dict]:
    """Move system messages (e.g. the '[Compacted earlier context]' summary) to
    the FRONT of the array.

    The frontend appends the compact summary at the END of the conversation so it
    renders below the agent's reply. But ``_compact_history`` walks the history
    backwards from the tail to pick the recent turns to keep verbatim, and only
    looks for a prior summary in the head. If the summary sits at the tail it gets
    swallowed into the recent tail (and counted in ``keep``), so the next compact
    never finds/merges it and the history grows every turn — the "compact loop".
    Normalizing here makes the backend independent of array order from the client.
    """
    system = [m for m in history if m.get("role") == "system"]
    rest = [m for m in history if m.get("role") != "system"]
    return system + rest


async def _compact_history(
    model: Any,
    history: list[dict],
    max_chars: int = 30_000,
    usage_cap=None,
    fallback_model: Any = None,
    ctx: int = 0,
    max_output: int = 0,
    reserved: int | None = None,
    last_error: list | None = None,
    force: bool = False,
) -> tuple[list[dict], int, dict | None] | None:
    """Collapse older turns into one structured summary, keeping a recent tail
    verbatim, so a full window can continue instead of being cut off.

    Mirrors opencode's compaction (anomalyco/opencode): only the OLDER portion
    of the conversation — everything beyond a recent token-budgeted tail — is
    summarized; the most recent turns are kept VERBATIM after the summary. The
    summary uses opencode's exact template and merge behaviour, and its output
    is bounded only by opencode's 4096-token ceiling (scaled for small windows),
    not a 250-word straitjacket — so detail is preserved instead of discarded.

    Returns a tuple ``(new_history, recent_kept, usage)`` — ``recent_kept`` is the
    exact number of recent turns preserved verbatim after the summary, so the
    caller can tell the frontend to fold precisely those older turns and keep the
    SAME recent ones (otherwise the summary and the verbatim tail it renders can
    contradict each other); ``usage`` is the summarizer's token usage dict (or
    ``None``). Returns ``None`` if there is nothing to compact OR the summarizing
    call fails — on failure it does NOT drop the older turns (the caller surfaces
    a ``compact_failed`` event so the user can retry manually rather than
    silently losing context).

    If ``fallback_model`` is provided and differs from ``model``, a failed or
    empty summarizer run on ``model`` (the configured compact subagent) is
    retried once on ``fallback_model`` (the main model) — mirroring the manual
    /compact path, so a flaky compact subagent degrades to the working model
    instead of surfacing ``compact_failed``.
    """
    if ctx <= 0:
        ctx = 8192  # opencode assumes a window is always known; fall back sensibly
    tail_budget = _recent_tail_budget(ctx, max_output, reserved)

    # ROOT FIX for the compact loop: ensure any prior compact summary sits at the
    # head, not wherever the frontend appended it. Without this the reversed tail
    # walk below swallows the summary into `recent`, so the next compact never
    # finds/merges it and the history grows every turn.
    history = _normalize_history_order(history)

    # --- select the recent tail (kept verbatim) -------------------------------
    # Walk backward keeping whole messages until the token budget is hit
    # (opencode's `select`/`preserveRecentBudget`).
    tail: list[dict] = []
    tail_tokens = 0
    for m in reversed(history):
        est = _estimate_tokens(str(m.get("content", "")))
        if tail and tail_tokens + est > tail_budget:
            break
        tail.append(m)
        tail_tokens += est
    tail.reverse()
    # --- clean up orphaned tool messages / assistant tool_calls ---------------
    # The token-budget cutoff can split an assistant tool_calls step from its
    # ToolMessage results, landing the assistant in `older` (summarized away)
    # while the tool results stay in `tail`.  The provider then sees a `tool`
    # message with no matching `tool_calls` before it and 400s (e.g. Anthropic:
    # "Tool messages starting at messages[N] are missing results for
    # tool_call_id(s): …").
    #
    # Old approach: walk only leading orphaned tool messages back into `tail`
    # (broke when orphans appeared after non-tool messages).
    # New approach: remove orphaned tool messages from `tail` entirely — the
    # summary contains no structured tool_calls, so there is no way to pair
    # them.  Also strip tool_calls from assistant messages with ANY missing
    # result, so the API never sees a tool_calls block without matching tool
    # results.
    #
    # Step 1 — collect ALL tool_call_ids referenced by assistant messages in
    # the tail (needed for orphan detection).
    _all_tail_tc_ids: set[str] = set()
    for _m in tail:
        if _m.get("role") == "assistant":
            for _tc in _m.get("tool_calls") or []:
                _tid = _tc.get("id")
                if _tid:
                    _all_tail_tc_ids.add(_tid)
    # Step 2 — remove tool messages whose tool_call_id is NOT referenced by
    # any assistant message in the tail (orphaned = their assistant is in
    # `older` and was summarized away).
    orphaned_ids: list[str] = []
    _cleaned: list[dict] = []
    for _m in tail:
        if (
            _m.get("role") == "tool"
            and _m.get("tool_call_id") not in _all_tail_tc_ids
        ):
            orphaned_ids.append(_m.get("tool_call_id", "?"))
        else:
            _cleaned.append(_m)
    tail = _cleaned
    if orphaned_ids:
        logger.debug(
            "_compact_history: removed %d orphaned tool messages (ids: %s)",
            len(orphaned_ids),
            orphaned_ids,
        )
    # Step 3 — strip tool_calls from assistant messages when ANY of their
    # results were removed.  We detect this by checking each assistant's
    # tool_call_ids against the ACTUAL tool results that remain in tail (not
    # against _all_tail_tc_ids which contains assistant-referenced ids).
    _kept_result_ids: set[str] = {
        _m.get("tool_call_id")
        for _m in tail
        if _m.get("role") == "tool" and _m.get("tool_call_id")
    }
    _stripped_count = 0
    for _m in tail:
        if _m.get("role") == "assistant" and _m.get("tool_calls"):
            _own_ids = {
                _tc.get("id") for _tc in _m["tool_calls"] if _tc.get("id")
            }
            # If any of this message's tool_call_ids have no result in tail,
            # the API will 400 — strip the entire tool_calls block.  The
            # assistant text content is still useful context for the model.
            if _own_ids - _kept_result_ids:
                _m.pop("tool_calls", None)
                _stripped_count += 1
    if _stripped_count:
        logger.debug(
            "_compact_history: stripped tool_calls from %d assistant messages "
            "with missing results",
            _stripped_count,
        )
    # --- protect the in-flight step (mid-turn auto-compact) -----------------
    # When auto-compact fires DURING a turn, the transcript ends with the current
    # step: an assistant message carrying tool_calls followed by its tool results.
    # If the budget-selected tail stops in the middle of that step, the assistant's
    # tool_calls get summarized away while the tool results are dropped — leaving a
    # dangling tool_call_id with no ToolMessage. The model then re-issues the same
    # call on the next step, trips the repetition-loop guard, and the turn STOPS
    # instead of continuing. Keep the entire final step verbatim so the turn resumes
    # seamlessly after compaction (opencode parity: compaction never breaks a step).
    _in_flight = -1
    for _i in range(len(history) - 1, -1, -1):
        if history[_i].get("role") == "assistant":
            if any(m.get("role") == "tool" for m in history[_i + 1 :]):
                _in_flight = _i
            break
    if _in_flight >= 0 and _in_flight < len(history) - len(tail):
        tail = history[_in_flight:]
    recent = tail
    older = history[: len(history) - len(tail)]
    if not older:
        if not force:
            # Auto-compact only runs when the window actually overflows, so a
            # conversation that fits in the tail has nothing to do.
            return None
        # Manual /compact: the user explicitly asked to summarize, even when the
        # whole conversation currently fits in the recent tail. Keep only the
        # final turn verbatim and summarize everything before it; a single
        # message is summarized whole (no verbatim tail).
        if len(history) > 1:
            older = history[:-1]
            recent = history[-1:]
        else:
            older = history
            recent = []

    # --- separate any existing "[Compacted earlier context]" summary ----------
    # A previous compact left a summary at the head. On a 2nd+ compact opencode
    # MERGES it (carries forward details) rather than re-compressing it, so we
    # pass it to the model as the <prior-summary> instead of concatenating.
    #
    # The summary arrives as its OWN system dict at the head (opencode parity:
    # never folded into the system prompt). Legacy transcripts from before that
    # change may still carry it appended to the system prompt content
    # ("<prompt>\n\n[Compacted earlier context]\n…"), so .find() locates the
    # marker anywhere in the content as a fallback.
    _marker = "[Compacted earlier context]"
    existing_summary = ""
    older_turns: list[dict] = []
    for t in older:
        content = str(t.get("content", ""))
        if t.get("role") == "system":
            _idx = content.find(_marker)
            if _idx >= 0:
                # Extract the summary after the marker for merge. When the
                # marker sits at the head of its own message (the normal case)
                # this is the whole content; when appended to a legacy system
                # prompt it is just the summary tail.
                existing_summary += content[_idx + len(_marker):].lstrip("\n")
            else:
                # No compaction history yet — keep the system prompt in
                # older_turns so the summarizer has context.
                older_turns.append(t)
        else:
            older_turns.append(t)
    if not older_turns:
        # The head is already a compact summary and there is nothing new to
        # compress — don't re-compress the old summary, report nothing to do.
        return None

    # --- serialize the head (older turns) for the summarizer, truncating -------
    # tool outputs to opencode's TOOL_OUTPUT_MAX_CHARS so one huge result can't
    # dominate the summary budget.
    def _serialize(msg: dict) -> str:
        content = str(msg.get("content", ""))
        # Drop app/tool error fragments (failed tool output, provider errors,
        # tracebacks) so the summarizer only sees real reasoning + successful
        # tool output — this is what the user asked for ("keep real
        # user/assistant, not app errors", including tool errors).
        content = _redact_app_errors(content)
        if len(content) > _TOOL_OUTPUT_MAX_CHARS:
            content = content[:_TOOL_OUTPUT_MAX_CHARS] + "\n[truncated]"
        # Structured work the prose alone doesn't carry: the task checklist
        # (when a plan exists — build-direct turns without update_plan simply
        # have none and skip this) and the tool calls already executed with
        # their results. Without these the post-compact summary says "work was
        # done" but not WHAT was run, so the next turn re-searches/re-reads
        # everything from scratch. Plan-independent: each block is appended
        # only when present, so plan-less turns still contribute their tools.
        extras: list[str] = []
        plan_items = msg.get("plan")
        if isinstance(plan_items, list) and plan_items:
            lines = []
            for it in plan_items:
                if not isinstance(it, dict):
                    continue
                text = str(it.get("content", "")).strip()
                if not text:
                    continue
                status = str(it.get("status", "pending")).strip().lower()
                if status not in ("pending", "in_progress", "completed"):
                    status = "pending"
                lines.append(f"- [{status}] {text[:200]}")
            if lines:
                extras.append(
                    "Task checklist (statuses as of this turn):\n" + "\n".join(lines)
                )
        acts = msg.get("toolActivity")
        if isinstance(acts, list) and acts:
            lines = []
            for a in acts:
                if not isinstance(a, dict):
                    continue
                status = str(a.get("status", "")).lower()
                if status not in ("done", "error"):
                    continue
                tool = str(a.get("tool", "")).strip()
                if not tool:
                    continue
                args = a.get("args")
                arg_str = _fmt_log_args(args) if args else ""
                summary = _trim_log_text(a.get("summary"), limit=240)
                line = f"- {tool}({arg_str})"
                if summary:
                    line += f" → {summary}"
                if status == "error":
                    line += " [FAILED]"
                lines.append(line)
                if len(lines) >= 40:
                    break
            if lines:
                extras.append(
                    "Tool calls already executed this conversation "
                    "(do NOT list these as pending work):\n" + "\n".join(lines)
                )
        if extras:
            content = content + "\n\n" + "\n\n".join(extras)
        return content

    older_turns_text = [_serialize(t) for t in older_turns]
    head_text = "\n\n".join(older_turns_text)

    # Bound the head so the summarize call itself fits the window (opencode
    # refuses to compact when the prompt wouldn't fit; we trim oldest instead).
    max_head_tokens = max(
        1024, _usable_tokens(ctx, max_output, reserved) - tail_budget - 512
    )
    while _estimate_tokens(head_text) > max_head_tokens and len(older_turns_text) > 1:
        older_turns_text.pop(0)
        head_text = "\n\n".join(older_turns_text)

    _exc: list[str] = []

    async def _summarize(m: Any) -> tuple[str, dict | None]:
        from llm import llm_complete

        if existing_summary:
            user_prompt = (
                "Here is the conversation so far:\n\n"
                f"<conversation>\n{head_text}\n</conversation>\n\n"
                "Here is the summary of the conversation before the <conversation> above:\n\n"
                f"<prior-summary>\n{existing_summary}\n</prior-summary>\n\n"
                + _SUMMARY_UPDATE_INSTRUCTIONS
                + "\n\n"
                + _SUMMARY_EXAMPLE
                + _SUMMARY_TEMPLATE
            )
        else:
            user_prompt = (
                "Here is the conversation so far:\n\n"
                f"<conversation>\n{head_text}\n</conversation>\n\n"
                "Create a new anchored summary from the conversation history in the "
                "<conversation> tags above so another coding agent can continue the work.\n\n"
                + _SUMMARY_EXAMPLE
                + _SUMMARY_TEMPLATE
            )
        try:
            summary, usage = await llm_complete(
                m, system=_COMPACTION_SYSTEM_PROMPT, user=user_prompt,
            )
        except Exception as exc:  # noqa: BLE001
            _exc.append(f"summarizer error: {str(exc) or repr(exc)}")
            return "", None
        summary = (summary or "").strip()
        if not summary:
            _exc.append("summarizer returned an empty summary")
        return summary, usage

    summary = ""
    compact_usage: dict | None = None
    try:
        summary, compact_usage = await _summarize(model)
    except Exception:  # noqa: BLE001
        summary = ""
    # The configured compact subagent failed (bad key, provider down, rate
    # limit, timeout, empty output) — fall back to the MAIN model and retry
    # up to 3 times, mirroring the manual /compact path in the frontend.
    # Without this, auto-compact fails whenever the compact subagent is flaky,
    # while the same turn retried manually (or /compact) succeeds.
    if not summary and fallback_model is not None and fallback_model is not model:
        for _ in range(3):
            try:
                summary, compact_usage = await _summarize(fallback_model)
            except Exception:  # noqa: BLE001
                summary = ""
            if summary:
                break
    if not summary:
        if last_error is not None and _exc:
            # Surface the real failure reason (e.g. an auth/timeout/empty-output
            # error from the summarizer) so the manual /compact path can tell the
            # user *why* it failed instead of a generic "empty summary". Auto-
            # compact ignores this (passes None) and keeps its no-op fallback.
            last_error.extend(_exc)
        return None  # compact failed — do NOT drop messages; caller surfaces a retry

    # opencode stores a single merged summary; we keep our "[Compacted earlier
    # context]" system-note convention so the frontend fold logic still works.
    # Preserve previous-turn outcome evidence verbatim at the head so
    # summarization never drops the completion signal (e.g. exit 0).
    _outcome_notes = [
        m for m in history
        if isinstance(m, dict) and _TURN_OUTCOME_MARKER in str(m.get("content", ""))
    ]
    return (
        _outcome_notes
        + [{"role": "system", "content": "[Compacted earlier context]\n" + summary}]
        + recent,
        len(recent),
        compact_usage,
    )


def _load_skills(root: str) -> list[dict]:
    """Load all user skills from the app's skill store (single source of truth).

    Skills are stored as ``skills/<slug>/skill.md`` files in the user data
    folder (managed in-app via Settings or the ``/skill`` tool) and shared
    across all workspaces. Each result is ``{"name", "slug", "description",
    "path", "content", "fa_keywords"}`` where ``path`` is the on-disk ``skill.md``
    location. The ``root`` argument is kept for API compatibility.
    """
    skills: list[dict] = []
    try:
        rows = state_db.list_skills()
    except Exception:  # noqa: BLE001
        return skills
    for row in rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        content = str(row.get("content") or "").strip()
        # Extract the body (drop the frontmatter) for inlining.
        body = content
        if body.startswith("---"):
            end = body.find("\n---", 3)
            if end != -1:
                body = body[end + 4 :].lstrip("\n").strip()
        skills.append(
            {
                "name": name,
                "slug": str(row.get("slug") or "").strip(),
                "description": str(row.get("description") or "").strip(),
                "path": str(row.get("path") or ""),
                "content": body or content,
                "fa_keywords": [str(k or "").strip() for k in (row.get("fa_keywords") or []) if str(k or "").strip()],
            }
        )
    return skills


# ---------------------------------------------------------------------------
# Deterministic skill auto-match
# ---------------------------------------------------------------------------
# Free/flash models rarely call the optional ``load_skill`` tool on their own,
# so the AVAILABLE SKILLS catalog alone never "auto-loads" anything. These
# helpers pick skills IN CODE from the user's request; the caller inlines the
# winners exactly like an @mention. Set ``_SKILL_AUTO_MAX`` to 0 to turn it off.

_SKILL_AUTO_MAX = 2  # skills auto-matched per turn
_SKILL_AUTO_MIN_SCORE = 4  # a name word hit = 2, a one-word name = 4, fa_keywords = 4
_SKILL_AUTO_MAX_BODY_CHARS = 16000  # longer bodies are loaded via load_skill instead
_SKILL_AUTO_SCAN_CHARS = 1200  # pasted logs/code past this are not scanned

# A request ABOUT making/changing skills (incl. the /create-skill prompt) must
# not inline unrelated skill bodies just because its description mentions
# "summarize" or "git".
_SKILL_META_RE = re.compile(
    r"\b(?:create|edit|update|modify|delete|remove|rename)\b[^.\n]{0,60}\bskills?\b"
    r"|(?:اسکیل|مهارت)[^.\n]{0,40}(?:بساز|ساخت|ایجاد|ویرایش|اصلاح|حذف|تغییر)"
    r"|(?:بساز|ساخت|ایجاد|ویرایش|اصلاح|حذف)[^.\n]{0,40}(?:اسکیل|مهارت)"
)

_SKILL_AUTO_STOP = frozenset({
    "the", "and", "for", "with", "from", "that", "this", "these", "those",
    "your", "you", "are", "was", "not", "how", "what", "when", "into", "than",
    "then", "can", "has", "have", "will", "should", "could", "would", "please",
    "just", "also", "about", "use", "using", "make", "need", "want", "like",
    "some", "any", "all", "new", "get", "set", "add", "fix", "skill", "skills",
    "code", "file", "files", "task", "help", "give", "show", "tell",
})







def _load_saved_plan(root: str, chat_id: str = "", prompt: str = "") -> str:
    """Return the saved implementation plan for this workspace+chat.

    Plans live as per-chat markdown files in the user data folder
    (``<data>/plan/<workspace>/<chat-id>/plan.md``, written by plan-mode's
    ``save_plan``). They are injected into later runs so the user or Coder
    mode can continue without retyping. With an empty ``chat_id`` returns an
    empty string (never falls back to another chat's plan). Returns an empty
    string when no plan is saved or when ``prompt`` is a new unrelated task
    sharing no significant tokens with the saved plan. Never raises.
    """
    if not (chat_id or "").strip():
        return ""
    try:
        workspace_slug = state_db.workspace_slug_for_root(root)
        plan = state_db.get_plan(workspace_slug, chat_id=chat_id)
    except Exception:  # noqa: BLE001
        return ""
    if not plan or not str(plan.get("content") or "").strip():
        return ""
    content_text = str(plan.get("content") or "")
    if (prompt or "").strip() and not _plan_reuse_relevant(
        prompt, [content_text, str(plan.get("title") or "")]
    ):
        return ""
    title = str(plan.get("title") or "").strip()
    return (
        "\n\n=== SAVED PLAN (from an earlier plan-mode run in this workspace) ===\n"
        f"Title: {title}\n"
        f"{plan['content']}\n"
        "If this message continues that task, follow this plan. If it is a new, "
        "unrelated task, ignore it."
    )


_IMAGE_EXTS: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
# Vision providers reject (or choke on) huge base64 images. Screenshots are
# often several MB; shrink them to sane limits before sending.
_MAX_VISION_DIM = 1536  # longest side sent to a vision model
_MAX_VISION_BYTES = 3 * 1024 * 1024  # decoded bytes; above this we shrink


def _sanitize_image_data_url(data_url: str) -> str | None:
    """Validate a base64 data URL and return a clean version, or None if corrupt.

    Drops truncated payloads (persisted snapshots cut with an ellipsis),
    whitespace/newlines, and non-base64 chars; repairs missing padding.
    Never raises. Callers must drop None instead of forwarding it: sending a
    corrupt data URL makes the provider reject the whole request with
    "400 invalid base64 in data URI".
    """
    if not isinstance(data_url, str):
        return None
    text = data_url.strip()
    if not text.startswith("data:") or "," not in text:
        return None
    if "\u2026" in text:
        return None
    head, _, payload = text.partition(",")
    payload = "".join(payload.split())
    if not payload:
        return None
    if ";base64" not in head.lower():
        # Not a base64 URL (e.g. inline SVG): vision needs base64, so an
        # image URL without the marker is dropped; anything else passes
        # through untouched.
        return None if head.startswith("data:image/") else text
    if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=" for c in payload):
        return None
    if len(payload) % 4 == 1:
        return None
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        base64.b64decode(payload, validate=True)
    except Exception:  # noqa: BLE001
        return None
    return f"{head},{payload}"


def _maybe_downscale_image(data_url: str) -> str | None:
    """Shrink oversized raster image data URIs so vision providers accept them.

    No-op when Pillow is unavailable or the image is already within limits.
    Never raises and never emits a corrupt URL: invalid base64 returns None
    (callers drop it instead of sending it to the provider).
    """
    cleaned = _sanitize_image_data_url(data_url)
    if cleaned is None:
        return None
    if not cleaned.startswith("data:image/"):
        return cleaned
    try:
        from io import BytesIO

        from PIL import Image
    except Exception:  # noqa: BLE001
        return cleaned
    try:
        _, b64 = cleaned.split(",", 1)
        raw = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return None
    if len(raw) <= _MAX_VISION_BYTES:
        try:
            with Image.open(BytesIO(raw)) as img:
                if max(img.size) <= _MAX_VISION_DIM:
                    return cleaned
        except Exception:  # noqa: BLE001
            return cleaned
    try:
        with Image.open(BytesIO(raw)) as img:
            src = img.copy()
        if max(src.size) > _MAX_VISION_DIM:
            scale = _MAX_VISION_DIM / max(src.size)
            src = src.resize(
                (max(1, int(src.size[0] * scale)), max(1, int(src.size[1] * scale)))
            )
        out = BytesIO()
        # Lossless PNG keeps on-screen text / code crisp (the common case for
        # screenshots the agent must read); JPEG is only a fallback for opaque
        # photos, and at high quality so text stays legible.
        fmt = "PNG" if src.mode in ("RGBA", "P", "LA") else "JPEG"
        if fmt == "JPEG" and src.mode in ("RGBA", "P", "LA"):
            src = src.convert("RGB")
        if fmt == "PNG":
            src.save(out, format="PNG")
        else:
            src.save(out, format="JPEG", quality=95)
        new_b64 = base64.b64encode(out.getvalue()).decode("ascii")
        mime = "image/png" if fmt == "PNG" else "image/jpeg"
        return f"data:{mime};base64,{new_b64}"
    except Exception:  # noqa: BLE001
        return cleaned


def _load_images(items: list | None) -> list[str]:
    """Load attached images into base64 data URIs.

    Each item may be either a string path OR a dict with a ``dataUrl``
    (preferred — avoids any filesystem/sandbox dependency on the temp file the
    frontend normalized) and an optional ``path``. A dict's inline ``dataUrl``
    is used directly when present; otherwise we fall back to reading the path.
    Oversized images are downscaled so vision providers accept them.
    """
    uris: list[str] = []
    for raw in items or []:
        data_url = None
        path = None
        if isinstance(raw, dict):
            data_url = raw.get("dataUrl") or raw.get("data_url")
            path = raw.get("path") or raw.get("src")
        else:
            path = str(raw).strip()
        if data_url and str(data_url).startswith("data:"):
            cleaned = _sanitize_image_data_url(str(data_url))
            if cleaned is None:
                continue
            scaled = _maybe_downscale_image(cleaned)
            if scaled:
                uris.append(scaled)
            continue
        p = (path or "").strip()
        if not p:
            continue
        ext = os.path.splitext(p)[1].lower()
        mime = _IMAGE_EXTS.get(ext)
        if not mime:
            continue
        try:
            with open(p, "rb") as fh:
                data = fh.read(_MAX_IMAGE_BYTES + 1)
        except OSError:
            continue
        if len(data) > _MAX_IMAGE_BYTES:
            continue
        scaled = _maybe_downscale_image(
            f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        )
        if scaled:
            uris.append(scaled)
    return uris


# Explicit per-turn mode declaration. The agent CANNOT reliably tell its own
# mode (every built-in prompt opens with "You are Build…"), and after a mode
# switch the conversation history is full of the previous mode's replies, which
# makes it claim "nothing changed". Telling it the mode for THIS message (and
# that the user can switch it per message via the UI) fixes both the false
# refusal and the misreporting.
_MODE_LABELS = {"ask": "Ask", "plan": "Plan", "build": "Build", "reader": "Reader"}
_MODE_CAPS = {
    "ask": "You are a simple, read-only assistant. Answer BOTH everyday questions AND project/code questions, in whatever language the user writes in. Explain things clearly and simply — no jargon without definition. NEVER write, edit, or delete files or run commands. For project/code questions follow the SEARCH STRATEGY rule (parallelizable work goes to task(subagent_type='subagent')).\n"
           "CRITICAL RULE — VERIFIED URLs ONLY:\n"
           "• You MUST NEVER fabricate, guess, or hallucinate any URL from memory — every single external URL you output MUST come from a web_search or fetch_url result you JUST called in THIS turn.\n"
           "• EXCEPTION — open-site requests: when the user asks (in any language) to open/show/visit a site (e.g. 'open digikala'), you MUST call browser_navigate directly with the canonical URL (e.g. https://www.digikala.com) — do NOT call web_search first and do NOT answer with web_search alone.\n"
           "• BEFORE outputting any movie trailer, poster image, or video link, you MUST first call web_search with a specific query (e.g. 'movie_name official trailer youtube') and use ONLY the real URL from the results.\n"
           "• If web_search does not return a working URL, say so honestly — NEVER make one up.\n"
           "• NEVER use markdown reference-style links like [label]: url — they render as broken raw text. ONLY use inline links [text](url) and inline images ![alt](url).\n"
           "The frontend automatically renders bare YouTube/Vimeo URLs on their own line as clickable video thumbnail cards, and ![alt](url) as inline images.",
    "plan": "You are a read-only PLANNER: you produce the implementation plan and NEVER write, edit or delete files. Check the codebase following the SEARCH STRATEGY rule (parallelizable work goes to task(subagent_type='subagent')) and inspect state with the read-only terminal (git status/diff/build/lint/test, plus detached live launch of the project's own start command via bg:).",
    "build": "You are an implementation agent: create/edit files from the plan. Follow the SEARCH STRATEGY rule: use task(subagent_type='subagent') ONLY for several parallel chunks needing DIFFERENT research (2+ independent files/groups, each with its own scope) — FIRST launch one task per delegated chunk in ONE parallel block, each with a DIFFERENT scope/Files and never overlapping; NEVER a single task for single-chunk work — do that yourself directly. Sub-agents are read-only researchers (search/read/web only — no edits, no terminal; you edit and run all tests after merging reports); order each sub-agent to use targeted search only (LSP first in build mode, no blind scans, batched: ONE grep via patterns/paths/includes, ONE read via filePaths, ONE read via ranges+symbols); do only targeted checks yourself right before you edit, then edit your kept chunk(s) yourself in parallel (several files via parallel edit_file calls, never delegated files) after at most 2-3 search batches. You also have the read-only terminal for build/test/lint and detached live launch (the project's own start command from its manifest via bg:, logs in OS temp dir, background marker exempt). If a dependency must be installed to run or test, ask permission with request_permission and explain why before installing.",
    "reader": "You are a FOCUSED CODE READER: the user pointed you at specific file(s) — read them and explain with file:line references. Focus on those files; you have full workspace access and may read related files when needed.",
}

# Per-mode output contract appended to the CURRENT-MODE note every turn, so a
# mid-chat mode switch re-orients the agent immediately (history alone can't).
_MODE_OUTPUT = {
    "ask": (
        "For code/project questions: give step-by-step guidance with exact file paths and line targets — "
        "never an implementation, never full file contents.\n"
        "FOR EXTERNAL CONTENT (movies, trailers, images, videos):\n"
        "• You MUST call web_search FIRST for EVERY URL you output, EXCEPT open-site requests which MUST use browser_navigate directly without web_search.\n"
        "• Output ONLY URLs that appear in the actual web_search results you just received.\n"
        "• NEVER output reference-style markdown links like [text]: url — they render as broken raw text. "
        "ONLY use inline [text](url) for links and ![alt](url) for images.\n"
        "• For movie trailers: search for the movie + 'official trailer youtube', then put the bare verified "
        "YouTube URL on its own line (e.g. https://www.youtube.com/watch?v=REAL_ID). The frontend renders it as a clickable thumbnail card.\n"
        "• For movie posters: search for the movie + 'poster', then use ![movie name](verified-url).\n"
        "• If you cannot find a verified URL, say so honestly instead of fabricating one."
    ),
    "plan": (
        "EXISTING PLAN: a follow-up message REVISES it — keep every still-valid item, add/update/remove only what "
        "the new message affects, and open with 1-2 lines saying what changed; write a fresh plan replacing the old "
        "one ONLY when the user explicitly says to discard it ('delete the old plan', 'start over'). "
        "Your reply MUST be a SHORT implementation plan: open with '## Plan', then goal (1-2 lines), one bullet "
        "per file (`path` + change + why), and 1-3 verification commands — never do the work. Snippets: at most "
        "one tiny snippet per file and ONLY when the bullet alone is ambiguous. End the plan with a 'Files: "
        "path1, path2, ...' line listing every file the implementation will touch, then a summary of MAX 3 "
        "bullets in the SAME language as the plan (e.g. '## خلاصه' for Persian, '## Summary' for English) — "
        "never repeat step text there. Close with one sentence offering to switch to Build mode, and one sentence inviting corrections (e.g. 'بگو کجاش ایراد داره یا چی اضافه/کم بشه تا پلن رو اصلاح کنم')."
    ),
    "build": (
        "PLAN HANDLING: implement, don't re-plan. When the conversation already has an "
        "implementation plan (a '## Plan' document or the plan checklist), execute it — "
        "never reply with a new '## Plan' document instead of doing the work. A follow-up "
        "request ('do X too', 'also Y', 'change Z') EDITS the existing plan: keep every "
        "existing item and add/update only what the new message affects, then implement — "
        "when the plan text is written out, output the FULL revised plan (all previous "
        "items plus the new one), never dropping earlier items. Replace it with a fresh "
        "'## Plan' ONLY when the user explicitly says to discard the old plan ('delete the "
        "old plan', 'start over', 'write a new plan'). If NO plan exists yet, write a "
        "SHORT '## Plan' first and immediately continue implementing it in the same turn — "
        "never stop at the plan. The deliverable is the edited files (plus tests when "
        "behavior changes), not a plan document."
    ),
    "reader": (
        "Your reply MUST explain the pointed-at code with exact file:line references and the WHY — "
        "concise, scoped to the referenced files, never a full rewrite."
    ),
}


_HAS_PERSIAN = re.compile(r"[\u0600-\u06FF]")


def _language_directive(text: str) -> str:
    """A short, prominent reply-language rule placed right after the mode
    declaration so even weak models can't miss it. Detects Persian by script
    and otherwise falls back to 'match the user's language'."""
    if text and _HAS_PERSIAN.search(text):
        return (
            "\nHARD RULE (always follow): The user writes in Persian (فارسی). Reply "
            "ENTIRELY in Persian — every message, todo/checklist item, plan content, "
            "summary, and ask_user question and options. Never reply in English "
            "when the user writes Persian. "
            "EXCEPTION — SKILLS ARE ALWAYS ENGLISH (HARD): when you create a skill via "
            "create_skill, its `name`, `description` and `content` (full markdown body) "
            "MUST be entirely in English, even though the chat is Persian. Never create "
            "Persian skills. "
            "EXCEPTION — CODE DOCSTRINGS AND COMMENTS ARE ALWAYS ENGLISH (HARD): "
            "docstrings and comments in any code you write MUST be entirely in "
            "English, even though the chat is Persian. Never write Persian docstrings "
            "or comments. These hard rules override the Persian reply rule for skills "
            "and code docstrings/comments."
        )
    return (
        "\nLANGUAGE RULE (always follow): Reply entirely in the same language the user "
        "writes in — Persian → Persian, English → English, etc. Never switch languages "
        "for todo lists, plans or summaries. EXCEPTION — SKILLS ARE ALWAYS ENGLISH (HARD): "
        "skill `name`/`description`/`content` via create_skill must always be English, "
        "regardless of chat language. EXCEPTION — CODE DOCSTRINGS AND COMMENTS ARE "
        "ALWAYS ENGLISH (HARD): docstrings and comments in any code you write "
        "must always be English, regardless of chat language."
    )


def _mode_declare(mode: str) -> str:
    label = _MODE_LABELS.get(mode, (mode or "Ask").capitalize())
    caps = _MODE_CAPS.get(
        mode, "You can read files and use your tools as described above."
    )
    note = (
        f"\n\n=== CURRENT MODE: {label} ===\n"
        f"You are in {label} mode for THIS message. {caps} "
        "The user can switch this chat's mode anytime with the toolbar mode button or ⌘M; "
        "each message runs in the mode selected when it was sent. You cannot change your own mode. "
        "If asked whether your mode changed or to switch modes, state the current mode (per this note — "
        f"currently {label}) and tell them to use the mode button; their NEXT message then runs in the "
        "new mode. Never claim the mode is fixed for the whole conversation or that the mode button "
        "only affects new chats.\n"
        "NEVER write a mode tag (e.g. ``<!-- mode:… -->`` or ``[Mode: …]``) at the start of your "
        "reply — the mode for THIS message is already declared above by ``=== CURRENT MODE: … ===``. "
        "Do not copy the style, length, or actions of any past turn; your job is defined ONLY by the "
        "CURRENT MODE above. The conversation history may contain turns produced in a DIFFERENT mode "
        "(the user may have switched modes between messages). Those earlier turns are historical "
        "CONTEXT only — never infer your current mode from them, never imitate their style/format, and "
        "never carry their mode's constraints into THIS message; your mode is the one declared above."
    )
    output = _MODE_OUTPUT.get(mode, "")
    if output:
        note += f"\nOUTPUT CONTRACT FOR THIS MODE: {output}"
    return note


def _append_app_log(line: str) -> None:
    """Best-effort append to the app log file codifa.log (run via asyncio.to_thread)."""
    try:
        with open(
            os.path.join(user_coder_dir(), LOG_FILENAME),
            "a",
            encoding="utf-8",
        ) as fh:
            fh.write(line)
    except OSError:
        pass





async def run_agent(
    provider: str,
    model_name: str,
    base_url: str,
    api_key: str,
    root: str,
    mode: str,
    prompt: str,
    history: list[dict],
    # User-configured provider id (distinct from `provider` which is the kind).
    # Several providers can share the same kind (e.g. two openrouter accounts
    # with different ids); we propagate this into the usage event so the
    # sidebar groups per-usage entries under the exact id the user picked.
    provider_id: str = "",
    attachments: list[str] | None = None,
    images: list[str] | None = None,
    system_prompt: str = "",
    thinking_level: str = "medium",
    model_reasoning: bool = False,
    context_window: int = 0,
    env_var: str = "",
    api_keys: list[str] | None = None,
    mcp_servers: dict | None = None,
    skills: list[str] | None = None,
    allow_create: bool = False,
    cap: dict | None = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    allow_outside: bool = False,
    allow_computer: bool = False,
    allow_outside_folders: list[str] | None = None,
    vector_db_path: str = "",
    vector_config: dict | None = None,
    retrieval_config: dict | None = None,
    lsp_config: dict | None = None,
    subagent_models: dict | None = None,
    chat_id: str = "",
    reserved: int | None = None,
    providers: dict | None = None,
    compact_trigger_fraction: float = 0.8,
    compact_at_percent: int | None = None,
    restart: bool = False,
    goal: str = "",
    goal_turns: int = 0,
) -> AsyncIterator[dict]:
    """Run the agent via the LangGraph workflow and yield SSE events.

    The orchestration (state machine, tool loop, retries, scout, RAG, mode
    routing) now lives in ``graph.py``; this thin wrapper adapts the original
    ``run_agent`` call signature into the graph's ``AgentState`` and streams the
    events it produces. Preserves the exact event protocol the frontend relies on.
    """
    from graph import run_graph

    def _to_list(x):
        if x is None:
            return []
        if isinstance(x, (list, tuple)):
            return list(x)
        return [x]

    initial: dict = {
        "provider": provider,
        "provider_id": provider_id,
        "model_name": model_name,
        "base_url": base_url,
        "api_key": api_key,
        "api_keys": list(api_keys or []),
        "root": root,
        "mode": mode or "ask",
        "request": prompt or "",
        "history": list(history or []),
        "attachments": _to_list(attachments),
        "images": _to_list(images),
        "system_prompt": system_prompt,
        "thinking_level": thinking_level,
        "model_reasoning": model_reasoning,
        "context_window": int(context_window or 0),
        "env_var": env_var,
        "mcp_servers": mcp_servers or {},
        "skills": _to_list(skills),
        "allow_create": allow_create,
        "cap": cap,
        "permission_gates": permission_gates,
        "ask_gates": ask_gates,
        "allow_outside": allow_outside,
        "allow_computer": allow_computer,
        "allow_outside_folders": list(allow_outside_folders or []),
        "vector_db_path": vector_db_path,
        "vector_config": vector_config,
        "retrieval_config": retrieval_config,
        "lsp_config": dict(lsp_config or {}),
        "subagent_models": dict(subagent_models or {}),
        "chat_id": chat_id,
        "reserved": reserved,
        "compact_trigger_fraction": compact_trigger_fraction,
        "compact_at_percent": compact_at_percent,
        "providers": providers or {},
        "restart": bool(restart),
        "goal": goal or "",
        "goal_turns": int(goal_turns or 0),
        # Mutable flag shared between graph._run_mode_turn (detects a hard
        # failure) and graph.run_graph._drive (decides whether to clear the
        # durable resume file). Seeded HERE — on the original `initial` that is
        # passed straight into run_graph — because LangGraph hands nodes a copy
        # of the state, so a setdefault inside run_graph would never reach them.
        "_run_flags": {"hard_error": False},
        # Shared permit dict ({"outside", "computer", "folders"}) — seeded
        # here for the same reason as _run_flags: LangGraph copies state per
        # node, so the shared dict must exist on the original `initial` before
        # the graph runs, letting grants survive coder-node re-entry within a
        # turn. "folders" holds the per-folder outside-workspace grants.
        "_permit": {
            "outside": bool(allow_outside),
            "computer": bool(allow_computer),
            "folders": list(allow_outside_folders or []),
        },
    }
    async for event in run_graph(initial):
        yield event
