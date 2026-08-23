"""Pydantic AI agents for the two UI modes.

* ``chat``      -> conversational coding assistant (conservative tool use)
* ``codewriter``-> autonomous code-writing agent (proactive tool use)

Tools are registered per-run, bound to the sandboxed ROOT, and emit live
activity events that the server forwards over SSE so the UI can render tool
calls as they happen.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import tempfile
import time
import traceback
import warnings
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

warnings.filterwarnings(
    "ignore",
    message="Sampling parameters.*reasoning",
    category=UserWarning,
)

import state_db
from context_builder import build_context
from providers import (
    _expand_base,
    _provider_meta,
)
from retrieval import RetrievalSettings
from secret_utils import decrypt_secret
from tools import (
    _PARENT_TOOLS_CTX,
    _SCOUT_CTX,
    LOG_FILENAME,
    PathEscapeError,
    _is_text_path,
    _read_text,
    _tool_event,
    list_files,
    make_tool_callbacks,
    open_vector_store,
    read_file,
    remember,
    resolve_safe,
    slugify,
    user_coder_dir,
)
from vector_store import KIND_MEMORY, VectorStore

# Steer messages injected into a RUNNING agent without interrupting it. Keyed
# by chat_id; each entry is {"id", "prompt"}. The frontend POSTs here while the
# agent is mid-run; the tool wrapper drains them into the next tool call's
# result, so the model reads the user's message on its very next request after
# the current tool — no abort, no waiting for the answer to finish.
STEER_INBOX: dict[str, list[dict]] = {}
_STEER_LOCK = asyncio.Lock()


async def _drain_steer(chat_id: str) -> list[dict]:
    """Pop and return all pending steer messages for a chat."""
    async with _STEER_LOCK:
        items = STEER_INBOX.get(chat_id) or []
        if items:
            STEER_INBOX[chat_id] = []
        return items


async def _enqueue_steer(chat_id: str, item: dict) -> None:
    async with _STEER_LOCK:
        STEER_INBOX.setdefault(chat_id, []).append(item)


async def _remove_steer(chat_id: str, steer_id: str) -> None:
    """Drop a single pending steer message (user cancelled it before delivery)."""
    async with _STEER_LOCK:
        items = STEER_INBOX.get(chat_id) or []
        STEER_INBOX[chat_id] = [it for it in items if it.get("id") != steer_id]


_READONLY_TERMINAL_PATTERNS = [
    r"^\s*git\s+(status|diff|log|show|ls-files|rev-parse|blame)\b",
    r"^\s*(ls|ls-la|dir|find|pwd|cat|tac|less|more|head|tail|wc|which|where|whoami|date|echo)\b",
    r"^\s*(rg|grep|awk|sed|sort|uniq|cut)\b",
    r"^\s*(node|python(3)?|python3|ruby|php|go|cargo|npm|npx|pnpm|yarn|deno)\s+(-\w+\s+)?(--?version|-v)\b",
    r"^\s*(npm|pnpm|yarn)\s+(test|run\s+\S*(test|lint|build)|lint|build)\b",
    r"^\s*(pytest|mypy|ruff\s+check|flake8|eslint|tsc\s+--noEmit|vitest|jest|ava|xo)\b",
    r"^\s*sdnotes\b",  # placeholder guard against typos
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


def _readonly_allowed(command: str) -> bool:
    # Mutation markers always veto the command, even when its first token would
    # otherwise match an allowlisted prefix.
    if any(re.search(m, command) for m in _MUTATION_MARKERS):
        return False
    for pat in _READONLY_TERMINAL_PATTERNS:
        if re.search(pat, command):
            return True
    return False


def _scoped_rels(root: str, attachments: list[str] | None, nvim_file: str) -> set[str]:
    """Workspace-relative paths this request is explicitly scoped to (attached /
    mentioned files + the open Neovim file). An empty set means NOT scoped —
    the agent keeps full workspace access."""
    rels: set[str] = set()
    base = resolve_safe(root, "")
    for raw in attachments or []:
        target = str(raw).strip()
        if not target:
            continue
        try:
            rels.add(os.path.relpath(resolve_safe(root, target), base))
        except PathEscapeError:
            pass
    raw = str(nvim_file or "").strip()
    if raw:
        try:
            rels.add(os.path.relpath(resolve_safe(root, raw), base))
        except PathEscapeError:
            pass
    return rels


def _wrap_scoped_search(fn: Callable, scoped_paths: set[str]):
    """Wrap grep so it only searches the explicitly scoped files.

    Other workspace files are off-limits; calls without a ``path`` (or with a
    path outside the scope) return an error listing the allowed files.
    """

    async def wrapped(pattern: str, path: str = "", include: str = "") -> str:
        rel = str(path or "").strip().lstrip("/")
        if not rel:
            return (
                "ERROR: this request is scoped to specific files — grep "
                "requires a `path`. In-scope files: " + ", ".join(sorted(scoped_paths))
            )
        if rel not in scoped_paths:
            return (
                f"ERROR: `{path}` is not in scope for this request. In-scope files: "
                + ", ".join(sorted(scoped_paths))
            )
        return await fn(pattern, rel, include)

    return wrapped


def _wrap_scoped_read(fn: Callable, scoped_paths: set[str]):
    """Wrap read so it only reads the explicitly scoped files."""

    async def wrapped(filePath: str, offset: int = 1, limit: int = 2000) -> str:
        rel = str(filePath or "").strip().lstrip("/")
        if rel not in scoped_paths:
            return (
                "ERROR: this path is not in scope for this request: "
                + str(filePath)
                + ". In-scope files: "
                + ", ".join(sorted(scoped_paths))
            )
        return await fn(rel, offset, limit)

    return wrapped


_TERMIN_TOKENS = re.compile(r'"((?:\\.|[^"\\])*)"|\'((?:\\.|[^\'\\])*)\'|(\S+)')

# Commands that never touch the filesystem (no file names leak through them);
# they must still pass the read-only allowlist below.
_FLS_NEUTRAL = {
    "echo",
    "pwd",
    "whoami",
    "date",
    "which",
    "where",
    "true",
    "false",
}

# Commands whose FIRST positional argument is a pattern/script, not a path
# (rg foo path, grep PATTERN file, sed 's//' file ...). For these the first
# positional can never serve as the in-scope path.
_FLS_PATTERN_CMDS = {
    "rg",
    "grep",
    "egrep",
    "fgrep",
    "ag",
    "ack",
    "rgw",
    "awk",
    "sed",
    "perl",
}


def _scoped_terminal_reject(
    command: str, root: str, scoped_paths: set[str]
) -> str | None:
    """Return an error string if ``command`` could reveal files outside the scope.

    The read-only allowlist is enforced first, then ``git`` (its output lists
    file names) and anything without at least one REAL on-disk path inside the
    scope is rejected — a bare search must not fall back to the whole workspace
    root, and absolute/escaped paths (``/etc/..``, ``../..``) are rejected.
    """
    if not _readonly_allowed(command):
        return (
            f"ERROR: run_terminal is read-only in this mode. "
            f"Command not allowlisted: {command!r}"
        )
    allowed = "In-scope files: " + ", ".join(sorted(scoped_paths))
    tokens = [g for t in _TERMIN_TOKENS.findall(command) for g in t if str(g).strip()]
    if not tokens:
        return f"ERROR: empty terminal command. {allowed}"
    prog = str(tokens[0]).split("/")[-1].split()[0]
    if prog == "git":
        return (
            f"ERROR: `git` is not allowed in a scoped request — its output can list files "
            f"outside the scope. {allowed}"
        )
    if prog in _FLS_NEUTRAL:
        return None
    # Version queries (node --version, python -V ...) read no files.
    if re.search(
        r"^\s*(node|python(3)?|python3|ruby|php|go|cargo|npm|npx|pnpm|yarn|deno)\s+(-\w+\s+)?(--?version|-v)\b",
        command,
        re.IGNORECASE,
    ):
        return None
    args = [str(t) for t in tokens[1:] if not str(t).startswith("-")]
    if not args:
        return (
            f"ERROR: run_terminal needs an explicit path of a file inside this request's "
            f"scope — a path-less command would run against the whole workspace. {allowed}"
        )
    # For pattern-taking commands the first positional is the query/script, so
    # it can't be the required in-scope file (e.g. `rg foo src/a.py`).
    if prog in _FLS_PATTERN_CMDS:
        args = args[1:]
        if not args:
            return (
                f"ERROR: run_terminal needs an explicit path of a file inside this "
                f"request's scope after the pattern. {allowed}"
            )
    base = root
    try:
        base = resolve_safe(root, "")
    except Exception:  # noqa: BLE001
        base = root
    seen_in = 0
    for a in args:
        state = _path_lookup(a, base, scoped_paths)
        if state is False:
            return (
                f"ERROR: run_terminal argument {a!r} is not inside this request's scope. "
                f"{allowed}"
            )
        if state is True:
            seen_in += 1
    if seen_in == 0:
        return (
            f"ERROR: run_terminal needs an explicit path of a file inside this request's "
            f"scope — no argument points at an on-disk scoped file. {allowed}"
        )
    return None


def _path_lookup(arg: str, base: str, scoped_paths: set[str]) -> bool | None:
    """Classify an argument against the scope.

    Returns ``True`` when it is a scoped file/dir, ``False`` when it visibly
    escapes the scope (absolute/out-of-root path or an un-scoped existing
    file/dir), or ``None`` when it is not a real path (a search literal — the
    caller still requires at least one ``True`` among the arguments).
    """
    raw = str(arg).strip()
    if not raw:
        return None
    try:
        target = resolve_safe(base, raw)
    except PathEscapeError:
        return False
    except Exception:  # noqa: BLE001
        return False
    if os.path.isfile(target):
        return os.path.relpath(target, base) in scoped_paths
    if os.path.isdir(target):
        dir_rel = os.path.relpath(target, base)
        if not any(p == dir_rel or p.startswith(dir_rel + "/") for p in scoped_paths):
            return False
        budget = 2000
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = [d for d in dirnames if d != ".git"]
            for f in filenames:
                budget -= 1
                if budget <= 0:
                    return False
                if os.path.relpath(os.path.join(dirpath, f), base) not in scoped_paths:
                    return False
        return True
    return None  # not on disk yet -> a literal/query, not a real path


def _wrap_scoped_terminal(fn: Callable, root: str, scoped_paths: set[str]):
    """Wrap a read-only terminal so it also refuses to read files outside the scope."""

    async def wrapped(command: str, _timeout: int = 120) -> str:
        reason = _scoped_terminal_reject(command, root, scoped_paths)
        if reason:
            return reason
        return await fn(command)

    return wrapped


_LSP_SEVERITY_LABELS = {1: "error", 2: "warning", 3: "info", 4: "hint"}


def _nvim_diagnostics_note(diagnostics) -> str:
    """Compact LSP summary for the Neovim file the agent can act on.

    Returns ``""`` when there are no diagnostics. Kept short so it never
    overloads the context window; line numbers are 1-based for humans.
    """
    if not diagnostics:
        return ""
    counts = {"error": 0, "warning": 0, "info": 0, "hint": 0}
    rows: list[str] = []
    for d in diagnostics:
        if not isinstance(d, dict):
            continue
        sev = d.get("severity")
        label = None
        if isinstance(sev, int):
            label = _LSP_SEVERITY_LABELS.get(sev)
        elif isinstance(sev, str):
            key = sev.strip().lower()
            label = key if key in counts else None
        if not label:
            label = "hint"
        counts[label] += 1
        lnum, col = d.get("lnum"), d.get("col")
        if isinstance(lnum, int) and isinstance(col, int):
            loc = f"{lnum + 1}:{col + 1}"
        else:
            loc = "?"
        msg = str(d.get("message") or "").replace("\n", " ").strip()
        if msg:
            rows.append(f"- l{loc} [{label}]: {msg[:200]}")
    first = ", ".join(
        f"{k}={counts[k]}" for k in ("error", "warning", "info", "hint") if counts[k]
    )
    lines = [
        "=== NEOVIM LSP DIAGNOSTICS ===",
        f"Language-server diagnostics for the open file ({'none' if not first else first}):",
    ]
    if rows:
        lines.append("\n".join(rows[:20]))
    return "\n".join(lines)[:2500]


def _wrap_readonly_terminal(fn: Callable):
    """Wrap a terminal tool so only read-only commands are allowed. Any
    non-allowed command returns an error message instead of running."""

    async def wrapped(command: str, _timeout: int = 120) -> str:
        if not _readonly_allowed(command):
            return (
                f"ERROR: run_terminal is read-only in this mode. "
                f"Command not allowlisted: {command!r}"
            )
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
    "for a targeted look, or the task tool (subagent_type='general') for anything "
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
    return None


def _wrap_no_search_bypass(fn: Callable):
    """Wrap a terminal tool so grep-family commands and python file-search
    one-liners are rejected, closing the run_terminal search-cap bypass.
    Applied to EVERY mode's run_terminal (read-only or not — Coder's writable
    terminal had no restriction of this kind at all before this).
    """

    async def wrapped(command: str, _timeout: int = 120) -> str:
        reason = _search_bypass_reject(command)
        if reason:
            return reason
        return await fn(command)

    return wrapped


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
    parent_oauth_token: str,
    provider_lookup: Callable[[str], dict | None],
) -> tuple[str, str, str, str, str, str] | None:
    """Resolve a subagent model entry to (provider_kind, model, base_url,
    api_key, env_var, oauth_token), or None to use the parent model.

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
                # Saved provider row wins (its stored key/base/oauth apply).
                pid, model_part, p = head, tail, row
            elif head == parent_provider:
                # Parent-kind prefix: keep the PARENT's own base/key/oauth.
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
                    "oauthRefreshToken": "",
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
        return (
            kind,
            model_part,
            p.get("baseUrl") or "",
            p.get("apiKey") or "",
            p.get("envVar") or "",
            p.get("oauthRefreshToken") or "",
        )
    return (
        parent_provider,
        model_part,
        parent_base_url,
        parent_api_key,
        parent_env_var,
        parent_oauth_token,
    )


SYSTEM_PROMPTS: dict[str, str] = {
    "ask": "You are a mentor inside a desktop IDE. When a question references a file or clearly needs the codebase (behavior, styling, logic, bugs, file structure, dependencies), the repository is explored for you — a deterministic pipeline gathers the relevant file contents and injects them into your context (REPOSITORY EXPLORATION RESULTS). For casual or general questions no exploration runs; answer from knowledge. USE that context and answer from the real code; you have NO file/search tools and must never re-search from scratch. If a file the user referenced (e.g. backend/graph.py) appears in the injected REPOSITORY EXPLORATION RESULTS / FILE CONTENTS READ, answer from it directly -- never ask the user to paste its contents and never say you cannot read files. Never answer from general knowledge when the answer depends on the real project files. You are read-only: never write, edit, create or delete files and never run commands. Structure answers: open with a one-sentence goal, then numbered steps naming the exact file path and, when useful, the function/line target, and always explain the WHY. For current or external info (versions, docs, APIs, error fixes), use web_search and fetch_url ONLY when the user explicitly asks to search the web - never web-search on your own initiative. Skip file tools for questions unrelated to the project (general knowledge, greetings, or pasted errors from OTHER apps/OS). If the user @mentions a file, its content is already in your context - do not re-search it. Match the user's language (Persian -> Persian, English -> English). If a skill is attached below (=== AVAILABLE SKILLS ===), adopt its role and follow its instructions instead of generic mentoring. OUTPUT DISCIPLINE: teach with steps and references — name exact file paths, functions and line targets — never dump full file contents or large code blocks into your reply; paste only tiny, necessary snippets. If you can answer from the context already in front of you (the auto-injected memory/project-file/web blocks, attached files, earlier tool results, or this conversation), answer directly - do NOT call a tool. Never repeat a search or re-request information already available. Diagrams: whenever your answer contains a flow, process, sequence, architecture, or relationship explanation, render it as a Mermaid diagram inside a ```mermaid fenced code block using valid Mermaid syntax — never as ASCII art or a plain list. This applies even if the user did not explicitly ask for a diagram (keywords include 'فلوچارت', 'نمودار', 'گراف', 'نقشه', 'draw', 'diagram', 'architecture'). Keep replies concise.",
    "coder": "You are Coder, an implementation-only code-writing agent inside a desktop IDE. You receive the plan and the exact implementation context (file paths, symbols, line targets, and the current code snippets to match) from Plan mode - use it directly; you do NOT explore the repository. You have NO discovery or execution tools: you cannot grep, glob, read, browse files, run commands, or run tests. Implement strictly from the provided context. If the provided context is insufficient to make an exact edit, call ask_user ONCE with the specific missing detail - do not search. For multi-step work call update_plan with a checklist; skip it for trivial single-step changes. Tick off each step the moment its implementation is finished — call update_plan marking that item 'completed' (and the next 'in_progress') before starting the next, so every finished task is checked off. When ALL checklist items are completed and you start NEW work that needs its own steps, call update_plan with a FRESH list of the new steps — the completed checklist is cleared and replaced (do not append new steps onto the finished one). Prefer edit_file for changes to an existing file (exact old_string/new_string); write_file only for brand-new files. NEVER edit files through any command - file changes go through edit_file/write_file only. Implement immediately once you have the needed context. Do not make unnecessary intermediate calls. Batch related edits into a single change where one suffices; do not repeatedly edit the same code when one edit accomplishes the task. Do not modify unrelated code. HUMAN IN THE LOOP: before a hard-to-reverse action (deleting a real file) call confirm_action and WAIT. At a genuine fork with no clearly-correct default, call ask_user with 2-5 short options and WAIT; do not overuse either. AUTO-VERIFY: every write/edit is auto-checked (syntax/typecheck) - trust it; do not re-run verification yourself. If the plan specifies creating or updating test files, do so, but running tests is Plan mode's job (it has the read-only terminal) - do not attempt to run them. CODE QUALITY: write maintainable, readable code following the project's existing structure and conventions - small focused files, meaningful names, DRY, no dead/commented-out code, minimal diffs, English comments. Fix any error you introduce and leave the codebase clean. If the user @mentions files, their content is already in your context - do not re-search it. Match the user's language (Persian -> Persian, English -> English). REPLY DISCIPLINE: the write_file/edit_file tool call IS the artifact - never paste full file contents or large code blocks into your visible reply; after writing/editing code, summarize concisely what changed (file, function, short diff-level description), not the code itself.",
    "plan": "You are a planning agent inside a desktop IDE. Produce a concrete IMPLEMENTATION PLAN - you never implement it. Read-only: inspect files and run only safe read-only terminal commands (git status/diff/log/show, pwd, node/python --version, build/test/lint); never modify/create/delete files; never read files through the terminal (cat/sed/grep/awk/head/tail/find - blocked). Stop scouting the moment every file, function and line your plan will touch is identified - the plan is your deliverable. If you hit a genuine fork with no clearly-correct default, call ask_user with 2-5 short options and WAIT. Call update_plan ONCE after writing '## Plan' with the final checklist Coder will execute (every item status='pending'); do not call it while scouting. save_plan saves your finished plan to the app DB (one per workspace); it auto-checks backtick-quoted paths - fix any flagged. Open your final reply with '## Plan' covering: (1) one-paragraph goal; (2) ordered steps naming exact file paths and line/function targets; (3) any new files; (4) paste-ready snippets (never full files); (5) verification commands. Skills/MCP: only if the user explicitly asks to create/install them may you call create_skill/create_mcp; otherwise plan them for Coder. Match the user's language (Persian -> Persian). End by offering to switch to Coder mode. OUTPUT DISCIPLINE: the plan references code — it never restates it. Use targeted snippets (a few lines max), never full file contents; keep the plan scannable. END your plan with a 'Files: path1, path2, ...' line listing every file the implementation will touch (one line, comma-separated exact paths). MINIMIZE EXPLORATION — SEARCH FIRST, THEN READ: do ALL your discovery (glob + grep) up front in ONE batched/parallel turn and review the returned snippets; THEN read only the specific files you actually need. Never alternate search and read (search→read→search→read) — that multiplies tool calls and burns tokens for no gain. Read enough context in a SINGLE call (read with offset/limit, or grep with its exact path) instead of repeatedly reading small sections; never reread a file or location you already have. STOP scouting the moment every file, function and line your plan will touch is identified - the plan is your deliverable. Include in the plan the EXACT current code snippets (with enough surrounding context) at each edit site so Coder can match and edit them without reading the files itself; do NOT paste full file contents.",
}

SYSTEM_PROMPTS["explore"] = (
    "You are a repository-exploration analyst inside a desktop IDE. The relevant "
    "files have ALREADY been discovered for you by a deterministic workflow (glob "
    "+ grep + directory tree + targeted reads); that output is injected above as "
    "'REPOSITORY EXPLORATION RESULTS'. Answer the user's question using ONLY that "
    "context plus your general understanding of code structure - do NOT call "
    "glob/grep/read (already done). You MAY use web_search / fetch_url / vision if "
    "the question needs external docs, versions, or attached images. Structure the "
    "answer: one-sentence goal, then the exact file paths and function/line targets "
    "that answer the question, explaining the WHY. Match the user's language "
    "(Persian -> Persian, English -> English). Keep it concise; cite file:line "
    "references. If the injected context is insufficient, say what is missing rather "
    "than guessing."
)

SYSTEM_PROMPTS["reader"] = (
    "You are a focused CODE READER inside a desktop IDE. The user has pointed at "
    "specific file(s) (attached, open in Neovim, or named directly). The relevant "
    "parts of those exact file(s) have ALREADY been read for you by a deterministic "
    "pipeline (targeted line ranges from path:LINE refs, an in-file grep of the "
    "question's keywords, or a bounded head) and are injected above as 'SPECIFIED "
    "FILE CONTENTS'. Answer using ONLY that context plus your general understanding "
    "of code -- do NOT call glob/grep/read (already done, and you have no such "
    "tools). You MAY use web_search / fetch_url / vision only when the user "
    "explicitly asks for external info or attaches an image. Explain with exact "
    "file:line references and the WHY. Match the user's language (Persian -> "
    "Persian, English -> English). Keep it concise; cite file:line. If the injected "
    "context is insufficient, say what is missing rather than guessing or inventing "
    "file contents."
)

    # Universal rules appended to EVERY mode's system prompt (ask/plan/coder).
# 1) The agent never leaves dead code in the work it does. 2) Dead code or bugs
# that existed BEFORE the agent's work are reported as notes, not silently fixed.
# 3) Replies stay short but precise and complete. 4) Code is written to stay
# extensible for future needs — never a one-off hack for only the current case.
# 5) Persian replies use the half-space (ZWNJ) correctly — the app does NOT
# post-process glued Persian words, so the model must emit ZWNJ itself.
_UNIVERSAL_RULES = (
    "\n\nUNIVERSAL RULES (apply in every mode):\n"
    "1. DEAD CODE: never leave dead code behind in code you write or modify — "
    "no unused variables, functions, imports or parameters, no commented-out "
    "code, no unreachable branches. Remove it as you go.\n"
    "2. PRE-EXISTING ISSUES: if you notice dead code or bugs that existed BEFORE "
    "your work (not caused by you), do NOT silently fix them — report them "
    "briefly as notes/suggestions (e.g. 'this function is unused — should be "
    "deleted', 'there's a bug here: ...').\n"
    "3. CONCISE ANSWERS: keep every reply short but precise and complete — easy "
    "to understand. No verbose filler, no restating what the user already knows, "
    "no long intros or summaries.\n"
    "4. EXTENSIBLE CODE: write, fix and edit code so it stays usable and "
    "extensible for future needs — general, parameterized, configurable, "
    "following the project's existing patterns — never a one-off hack that only "
    "serves the specific case in front of you. When a small generalization (a "
    "parameter, a lookup table/registry, a shared helper) makes the solution "
    "serve a whole class of similar tasks instead of one instance, prefer it.\n"
    "5. PERSIAN TYPOGRAPHY: when replying in Persian, always use the half-space "
    "(ZWNJ, U+200C) between word components — e.g. کتابخانه‌ها, منسوخ‌شده‌اند, "
    "لایه‌به‌لایه, نمی‌خواهم — never glue the components together without it.\n"
    "6. MEMORY IS AUTO-INJECTED: this project's relevant durable memory notes are "
    "loaded into your context automatically every run, so you rarely need "
    "search_memory — the notes are already in front of you. Only call "
    "search_memory when you explicitly need MORE than what's already here (a "
    "different angle, older notes, or a deliberate mid-task re-check). Never call "
    "it routinely or on every step."
)

# The search strategy is a FIRST-CLASS rule: it sits at the very top of
# every mode's prompt (right after the mode declaration + language rule) so the
# agent always picks the right tool for the breadth of the search. It replaces
# the per-mode scout guidance that used to be duplicated inside each
# SYSTEM_PROMPTS entry and the SEARCH rule in the trailing RULES block.
_SEARCH_RULE = (
    "\n\n=== IMPORTANT RULE: SEARCH STRATEGY (every mode) ===\n"
    "Choose the search tool by the BREADTH of what you need:\n"
    "1. TARGETED lookup,keyword: search "
    "directly with grep / glob / read.\n"
    "2. Wide search: use task with subagent_type='general'. Split independent "
    "search areas across multiple general agents and launch them IN PARALLEL. "
    "Use as many as meaningfully reduce search time; avoid redundant agents.\n"
    "in an isolated context and returns a report.\n"
    "3. Fire the searches you already know you need in the SAME turn (parallel "
    "tool calls) instead of one at a time.\n"
    "4. CONTEXT BUDGET: a subagent runs in an isolated context and "
    "only its compact report enters your context — so for multi-file research "
    "DELEGATE to a subagent instead of reading many files yourself. When you do "
    "read a large file, page it with read offset/limit (e.g. limit=300) instead "
    "of dumping the whole file into context.\n"
    "NEVER search or read project files with run_terminal or scripts — only "
    "the file tools (grep / glob / read)."
)

# Thinking levels the UI can select. 'none' = reasoning disabled, the rest map
# to increasingly deeper reasoning effort. Setting a low level (or 'none') is
# the most effective way to keep a reasoning model from flooding a small context
# window with thinking tokens and getting cut off. '' (legacy clients) falls
# back to the provider default / auto-inject behavior.
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
}

# HTTP status codes that are worth retrying (transient server / rate-limit).
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}

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
    # Mid-stream provider 5xx surfaced by some SDKs as a bare `APIError` with
    # NO status code attached (openai's stream-error path raises
    # `APIError("Internal server error", ...)` without `.status_code`) — the
    # message text is the only signal, so match the server-error wording too.
    "internal server error",
    "internal error",
    "server error",
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
    # Prefer the real HTTP status carried on the exception object (openai's
    # APIError / pydantic-ai set `.status_code`) — reliable even when the
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
    return str(exc)[:200]


# Phrases that indicate a hard usage-QUOTA exhaustion (daily/monthly/free-tier
# cap) rather than a brief throttle. Gateways that return these will return the
# identical error for a while (minutes, not seconds), so the normal 1.5s/3s/6s
# backoff just burns the retry budget for nothing before failing identically.
_QUOTA_EXHAUSTED_PHRASES = (
    "freeusagelimiterror",
    "usage limit",
    "quota exceeded",
    "daily limit",
    "monthly limit",
)


def _is_quota_exhausted(exc: BaseException) -> bool:
    """Detect a hard usage-quota error (e.g. a free-tier gateway's
    ``FreeUsageLimitError``) as opposed to a brief 429 throttle that a short
    backoff can ride out. When true, ``run_agent`` skips straight to surfacing
    the friendly error instead of spending the retry budget on 3 attempts that
    will fail identically within ~10 seconds.
    """
    low = str(exc).lower()
    return any(p in low for p in _QUOTA_EXHAUSTED_PHRASES)


# Retry-hints that mark a 429 as a SHORT-LIVED throttle (the gateway asks us to
# wait and try again) rather than a hard daily/monthly/credit exhaustion, which
# will keep failing for minutes or hours.
_THROTTLE_HINT_PHRASES = (
    "try again later",
    "please try again",
    "please retry",
    "retry after",
    "try again in",
    "temporarily",
    "too many requests",
    "slow down",
    "back off",
    "later",
)
# Throttle-markers that narrow the match to generator/rate-limit errors so a
# hard-date quota phrase in the same message can't sneak a real exhaustion into
# the unlimited-retry branch.
_THROTTLE_RATE_PHRASES = (
    "rate limit",
    "ratelimit",
    "too many requests",
    "429",
    "freeusagelimit",
)

# Bounded retry budget for free-tier throttles and the base backoff (seconds).
# The graph's retry loop uses these so transient throttles recover without the
# caller spending the normal retry budget. Configurable so tests can zero it.
_THROTTLE_MAX_ATTEMPTS = 4
_THROTTLE_BASE_SECONDS = 30


def _is_transient_throttle(exc: BaseException) -> bool:
    """Detect a SHORT-lived free-tier rate limit (e.g. ``429
    FreeUsageLimitError: Rate limit exceeded. Please try again later.``) as
    opposed to a hard quota exhaustion. Such throttles are retried without an
    attempt ceiling (the user stops them), so the caller must NOT spend the
    normal bounded retry budget on them — and must NOT write them to the fatal
    log, since they are expected to recur on free tiers.
    """
    # Honor Retry-After when the transport exposes it (e.g. httpx/openai
    # responses carry `.headers`): its presence means "transient, come back
    # then", not "exhausted for the day".
    cur: BaseException | None = exc
    seen: set[int] = set()
    earliest_status = 0
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        try:
            code = int(getattr(cur, "status_code", 0) or 0)
        except (TypeError, ValueError):
            code = 0
        if code:
            earliest_status = earliest_status or code
        headers = getattr(cur, "headers", None)
        if headers:
            try:
                val = headers.get("Retry-After") or headers.get("retry-after")
                if val is not None:
                    return True
            except Exception:  # noqa: BLE001, S110 — headers may be a response object
                pass
        cur = cur.__cause__
    text = str(exc)
    low = text.lower()
    try:
        status = int(getattr(exc, "status_code", 0) or 0) or earliest_status
    except (TypeError, ValueError):
        status = earliest_status or 0
    # Only treat a 429 (or a retryable status) as a throttle; a hard quota with
    # a stray "try again later" inside a 4xx that isn't retryable stays a quota.
    if status and status not in _RETRYABLE_STATUS:
        return False
    if not any(ph in low for ph in _THROTTLE_RATE_PHRASES):
        return False
    return any(hint in low for hint in _THROTTLE_HINT_PHRASES)


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
    """Detect the "model returned nothing usable" failure: pydantic-ai raises
    ``ToolRetryError: Please return text or call a tool.`` when a response has
    NO parts (no text, no tool call), and after the output-retry budget it
    surfaces as ``UnexpectedModelBehavior('Exceeded maximum output retries')``.
    Free/weak model tiers do this intermittently — retrying the same request
    shape usually fails again, so run_agent drops the tool set instead.
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
# limit is known (see _settings_for). Models like opencode's free
# deepseek-v4-flash-free genuinely allow 128K output (models.dev limit.output),
# so the ceiling must sit at 128K — an 8192 ceiling would silently shrink the
# advertised limit and thinking models would hit it before responding.
_MAX_OUTPUT_TOKENS = 128_000

# Conservative cap for the FALLBACK budget (no advertised output limit): a
# budget scaled from the resolved context window (ctx // 4), capped here.
# 8192 output tokens is plenty for a coding assistant; many providers reject
# larger values outright.
_FALLBACK_OUTPUT_TOKENS = 8_192

# Output-token ceiling for NARROW/targeted turns.
# A targeted lookup/fix needs a short direct reply — the code itself is written
# through write_file/edit_file tool results, not the model's text — so capping
# its reply saves real (often expensive) output tokens while keeping full quality.
# Kept for backward-compat but no longer used directly; narrow cap is now
# proportional to the model's actual max_tokens (50% with 2048 floor).
_NARROW_OUTPUT_CAP = 2_048


def _plan_reuse_note(history: list[dict]) -> str:
    """Build a checklist-reuse instruction for a coder turn that follows a plan.

    Walks ``history`` backward for the latest assistant message carrying a
    non-empty ``plan`` (the plan agent's update_plan checklist, carried through
    the frontend history payload). Returns an instruction telling the model to
    reuse those EXACT items — reset to ``pending`` when they came from a
    plan-mode turn (fresh handoff), preserving statuses for coder continuation.
    Returns "" when no checklist exists, so Coder falls back to creating its own.
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
        from_plan = turn.get("mode") == "plan"
        if from_plan:
            rule = (
                "Reuse these EXACT items: call update_plan with the same list, every item "
                "status='pending', then mark steps in_progress/completed as you work."
            )
        else:
            rule = (
                "Continue this checklist: call update_plan with the SAME items preserving "
                "their current statuses, then mark steps in_progress/completed as you work."
            )
        numbered = "\n".join(f"{i}. {it['content']}" for i, it in enumerate(clean, 1))
        return (
            "A task checklist already exists earlier in this conversation (from the previous "
            "step). Do NOT create a new checklist.\n"
            f"{rule}\n"
            "If the checklist does not match the current task, replace it with a new one.\n"
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


def _plan_discovery_note(history: list[dict]) -> str:
    """Build a no-rediscovery instruction for a Coder turn that follows a Plan.

    Plan mode already answered WHICH files are relevant. Coder only needs to
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
        return (
            "A Plan-mode message earlier in this conversation already identified these files as "
            f"relevant: {joined}. Do NOT re-run glob/grep/task to rediscover WHICH files matter — "
            "go straight to read/grep on these exact paths to verify their current content before "
            "editing. Only use glob or the task tool for files Plan did not name."
        )
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
    """
    entries: list[str] = []
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
            summary = _trim_log_text(a.get("summary"), limit=240)
            line = f"- {tool}({arg_str})"
            if summary:
                line += f" → {summary}"
            if status == "error":
                line += " [FAILED]"
            entries.append(line)
            if len(entries) >= 20:  # keep the note bounded
                break
        if len(entries) >= 20:
            break
    if not entries:
        return ""
    return (
        "Earlier in this conversation you ALREADY ran these tool calls (their "
        "results are below). Do NOT call the same tool with the same arguments "
        "again unless the user explicitly asks for a fresh run or new inputs:\n"
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
    Extracts usage statistics from the Pydantic AI result with robust fallback.
    Handles different attribute names used by various LLM providers.
    """
    if not usage:
        return None

    try:
        # 1. تلاش برای استخراج با نام‌های استاندارد pydantic-ai
        input_tokens = getattr(usage, "input_tokens", 0)
        output_tokens = getattr(usage, "output_tokens", 0)
        cache_read_tokens = getattr(usage, "cache_read_tokens", 0)
        cache_write_tokens = getattr(usage, "cache_write_tokens", 0)

        # 2. اگر مقادیر صفر بودند، تلاش برای استخراج از نام‌های رایج در OpenAI/OpenRouter
        if not input_tokens and not output_tokens:
            input_tokens = getattr(usage, "prompt_tokens", 0)
            output_tokens = getattr(usage, "completion_tokens", 0)

            # اگر باز هم صفر بود، سعی می‌کنیم از دیکشنری استفاده کنیم (اگر usage دیکشنری باشد)
            if isinstance(usage, dict):
                input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
                output_tokens = usage.get(
                    "completion_tokens", usage.get("output_tokens", 0)
                )

        # 3. کل واقعی = total_tokens معادل pydantic-ai یعنی input + output.
        #    نکته مهم: input_tokens در pydantic-ai ALREADY شامل cache_read/cache_write
        #    است، بنابراین cache را جدا اضافه نمی‌کنیم تا عدد دو بار نشمارده نشود
        #    (کاملاً منطبق با مستندات pydantic-ai و رویه‌ی opencode).
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
        print(f"Error parsing usage in agents.py: {e}")
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


def _estimate_tokens(text: str) -> int:
    """Heuristic token count (~4 chars/token), matching opencode's Token.estimate."""
    return max(1, len(text or "") // 4)


def _model_max_output(model: Any) -> int:
    """opencode's maxOutputTokens for the model (0 when unknown)."""
    info = getattr(model, "model_info", None)
    val = getattr(info, "max_output_tokens", 0) if info is not None else 0
    try:
        return int(val or 0)
    except (TypeError, ValueError):
        return 0


def _usable_tokens(ctx: int, max_output: int = 0) -> int:
    """opencode `usable`: context window minus the compaction/output reservation."""
    if ctx <= 0:
        return 0
    reserved = min(_COMPACTION_BUFFER, max_output if max_output > 0 else max(ctx // 4, 0))
    return max(0, ctx - reserved)


def _recent_tail_budget(ctx: int, max_output: int = 0) -> int:
    """opencode `preserveRecentBudget`: recent turns kept verbatim, in tokens."""
    usable = _usable_tokens(ctx, max_output)
    return min(_MAX_PRESERVE_RECENT_TOKENS, max(_MIN_PRESERVE_RECENT_TOKENS, int(usable * 0.25)))


def _preemptive_compact_fraction(ctx: int, max_output: int = 0) -> float:
    """Fraction of the window at which to compact — opencode's `usable / ctx`."""
    if ctx <= 0:
        return 0.60  # historical default when the window is unknown
    return _usable_tokens(ctx, max_output) / ctx


# opencode's compaction agent system prompt (verbatim — keeps the source language).
_COMPACTION_SYSTEM_PROMPT = (
    "You are a context summarization agent. You are given a conversation between a user and an agent. "
    "Your goal is to produce a structured summary matching the format specified so another coding agent "
    "can continue the work.\n\n"
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
    "continue, or \"(none)\"]\n\n"
    "## Work State\n"
    "### Completed\n"
    "- [finished work, verified facts, or changes made; otherwise \"(none)\"]\n\n"
    "### Active\n"
    "- [current work, partial changes, or investigation state; otherwise \"(none)\"]\n\n"
    "### Blocked\n"
    "- [blockers, failing commands, or unknowns; otherwise \"(none)\"]\n\n"
    "## Next Move\n"
    "1. [immediate concrete action, or \"(none)\"]\n"
    "2. [next action if known, or \"(none)\"]\n\n"
    "## Relevant Files\n"
    "- [file or directory path: why it matters, or \"(none)\"]\n"
    "</template>\n\n"
    "Rules:\n"
    "- Keep every section, even when empty.\n"
    "- Use terse bullets, not prose paragraphs.\n"
    "- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.\n"
    "- Do not mention the summary process or that context was compacted."
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
    "- Move completed work from \"Active\" to \"Completed\".\n"
    "- If a blocker has been resolved, update the summary to reflect that while keeping any details still "
    "needed to continue the work.\n"
    "- Update \"Objective\" and \"Next Move\" to reflect the current work state."
)


def _summary_output_budget(ctx: int, max_output: int = 0) -> int:
    """opencode's 4096-token summary ceiling, scaled so it fits small windows."""
    usable = _usable_tokens(ctx, max_output)
    return max(1024, min(_SUMMARY_OUTPUT_TOKENS, usable - 1024))


# ProcessHistory sliding-window guard. pydantic-ai re-sends the ENTIRE
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


class _TestVerifyNeeded(Exception):
    """Control-flow signal: a test-related coder task finished WITHOUT running
    the project's tests. The except chain catches it, feeds the completed tool
    work back as a resume note, and re-runs ONCE with an explicit instruction
    to run the tests and confirm green before the final message.
    """


def _load_project_memory(root: str) -> str:
    """Read the project's persistent instructions file, if present.

    Returns a ready-to-append system-prompt section, or ``""`` if no such file
    exists. Never raises — a missing or unreadable file just yields nothing.
    """
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
        if len(body) > _PROJECT_MEMORY_MAX_BYTES:
            body = (
                body[:_PROJECT_MEMORY_MAX_BYTES]
                + "\n…(truncated — file exceeds the auto-included limit; read the "
                "rest with read_file if needed)"
            )
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
# above). Curated via the `memory` tool (add/replace/remove; see tools.py) as
# the agent works, so a later session in the same project starts already
# knowing things it learned before — conventions it discovered, gotchas, fixes
# that worked. Notes are stored as RAG embeddings in the workspace vector store
# (kind ``memory``) and the top few relevant to the CURRENT prompt are
# auto-injected below every run (see _load_learned_memory) — search_memory is
# still available as a tool for pulling in MORE or DIFFERENT notes than what
# was auto-recalled (a different angle, older notes that fell outside top-6).


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


# Learned-memory injection budget. Mirrors the file/web RAG block (build_context
# caps at max_chars / per_section_chars) so one turn can never dump unbounded
# notes into the context. All three modes share this path.
_MEMORY_MAX_CHARS = 2_400
_MEMORY_PER_NOTE_CHARS = 1_200
_MEMORY_SEMANTIC_MIN_SCORE = 0.4
# Lexical floor: bm25 is negative (more negative = more relevant) and its
# magnitude scales with corpus stats (a tiny store scores exact matches near
# -1e-06 while a large one hits -3.6), so an absolute threshold is unreliable.
# Instead we drop a keyword's best hit only when it is several times weaker
# than the strongest lexical hit of the run — a relative band, not an absolute.
_MEMORY_LEXICAL_REL_FLOOR = 0.5
_MEMORY_TOP_K = 8


def _load_learned_memory(store: VectorStore | None, query: str = "") -> str:
    """Always read the project's RAG memory and inject the relevant notes into
    the context, so the model starts every run with its saved knowledge instead
    of having to remember to call search_memory. Never raises.

    Hybrid retrieval: FTS5 lexical match runs FIRST so exact terms (file
    paths, symbol names, specific corrections the user stated) are never
    missed just because their embedding isn't semantically close to the
    query — vector-only search is unreliable for that. Vector/semantic
    results then fill any remaining slots, deduped by chunk id.

    The block is budgeted (``_MEMORY_MAX_CHARS`` total, ``_MEMORY_PER_NOTE_CHARS``
    per note) so a single turn can never inject unbounded memory. Both sources
    are merged and ranked by relevance (bm25-derived for lexical, cosine for
    semantic) rather than lexical-always-first, so a wall of weak lexical hits
    can't crowd out genuinely relevant semantic notes.
    """
    if store is None:
        return ""
    try:
        total = store.count_docs(KIND_MEMORY)
    except Exception:  # noqa: BLE001
        return ""
    if total == 0:
        return ""
    try:
        if (query or "").strip():
            lexical: list[dict] = []
            for kw in _fts_keywords(query):
                try:
                    hits = store.fts_search(kw, KIND_MEMORY, top_k=2)
                except Exception:  # noqa: BLE001, S112 — a failed term just contributes no hits
                    continue
                if hits:
                    # Keep only the single best hit per keyword — the 2nd/3rd
                    # matches of the same term are near-duplicates of it.
                    lexical.append(hits[0])
            # Relative lexical floor: drop hits far weaker than the strongest
            # exact-term match of this run (bm25 magnitude is corpus-dependent,
            # so this is anchored to the best hit rather than an absolute value).
            if lexical:
                best_rank = min(float(h.get("_bm25_rank") or 0.0) for h in lexical)
                floor = _MEMORY_LEXICAL_REL_FLOOR * best_rank
                lexical = [
                    h for h in lexical if float(h.get("_bm25_rank") or 0.0) <= floor
                ]
            semantic = store.search(
                query,
                KIND_MEMORY,
                top_k=_MEMORY_TOP_K,
                min_score=_MEMORY_SEMANTIC_MIN_SCORE,
            )
            seen: set[int] = set()
            scored: list[tuple[float, dict]] = []
            for r in lexical:
                cid = r.get("_chunk_id")
                if cid is not None and cid in seen:
                    continue
                if cid is not None:
                    seen.add(cid)
                rank = float(r.get("_bm25_rank") or 0.0)
                scored.append((-rank, r))  # more negative rank → higher score
            for r in semantic:
                cid = r.get("_chunk_id")
                if cid is not None and cid in seen:
                    continue
                if cid is not None:
                    seen.add(cid)
                scored.append((float(r.get("score", 0.0)), r))
            scored.sort(key=lambda x: x[0], reverse=True)
            notes: list[str] = []
            used = 0
            for _, r in scored:
                if len(notes) >= _MEMORY_TOP_K:
                    break
                text = str(r.get("text", "")).strip()
                if not text:
                    continue
                if len(text) > _MEMORY_PER_NOTE_CHARS:
                    text = text[:_MEMORY_PER_NOTE_CHARS] + "…"
                if notes and used + len(text) > _MEMORY_MAX_CHARS:
                    break
                notes.append(text)
                used += len(text)
        else:
            docs = store.doc_texts(KIND_MEMORY)
            notes = []
            for d in reversed(docs[-_MEMORY_TOP_K:]):
                text = str(d.get("text", "")).strip()
                if not text:
                    continue
                if len(text) > _MEMORY_PER_NOTE_CHARS:
                    text = text[:_MEMORY_PER_NOTE_CHARS] + "…"
                notes.append(text)
    except Exception:  # noqa: BLE001
        return ""
    if not notes:
        return ""
    body = "\n".join(f"- {n}" for n in notes)
    return (
        "\n\n===== YOUR OWN MEMORY =====\n"
        "Saved notes from earlier sessions on this project (retrieved from the vector store):\n"
        f"{body}\n"
        "===== END YOUR OWN MEMORY ====="
    )


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
def _detect_scope(prompt: str) -> str:
    if not prompt:
        return ""
    low = prompt.lower()
    if any(
        k in low
        for k in (
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
        )
    ):
        return "broad"
    if any(
        k in low
        for k in (
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
        )
    ):
        return "narrow"
    return ""


# --- test verification (never finish a test task with red tests) ---------- #
# Prompt-level signal that a coder task is about writing/fixing/running tests.
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
    r"yarn test|pnpm test|bun test|cargo test|go test|mvn test|gradle test|"
    r"\./gradlew test|ant test|dotnet test|flutter test|mix test|rake test|"
    r"rspec|phpunit|tox|nox|python -m unittest|run_tests|test\.py|test\.ts|test\.js)",
    re.IGNORECASE,
)


def _is_test_task(prompt: str, picked_skills: Sequence[dict] | None = None) -> bool:
    """True when the prompt (or an attached skill) is about tests.

    Drives both the prompt-level TEST VERIFICATION RULE and the loop-level
    ``_TestVerifyNeeded`` follow-up in ``run_agent``.
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


# Implementation-task detection: a coder task that CHANGES code (feature, fix,
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
_TRIVIAL_TASK_RE = re.compile(
    r"(?:\b(readme|docs?|documentation|comment|typo|rename|"
    r"style|styling|css|color|font|explain|what|why|how|list|show|"
    r"summar|translate|format)\b|مستند|توضیح|چیست|چطور|خلاصه|ترجمه)",
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
    prompt (no keyword required), so a coder turn that ends up editing code
    is always covered — the user should never have to explicitly ask for
    tests. Trivial/doc-only prompts (README, typo, explain, ...) are
    excluded: they don't need tests. The loop-level guarantee is enforced
    at runtime via ``code_changed`` (see ``run_agent``); this predicate only
    decides whether the prompt-level TEST VERIFICATION RULE is injected.
    """
    p = (prompt or "").strip().lower()
    if not p or len(p) <= 8:
        return False
    if _TRIVIAL_TASK_RE.search(p):
        return False
    return True


def _trivial_prompt(prompt: str) -> bool:
    """True for prompts too trivial to warrant a todo checklist (update_plan).

    Mirrors the shape check in ``_needs_workspace`` — a greeting or one-liner
    (≤ 8 chars) needs no live progress list, so Ask mode skips the
    ``update_plan`` tool for it and saves a whole extra model round-trip
    (pydantic-ai re-sends the full message list on every tool-loop step).
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


def _fit_history(history: list[dict], budget_chars: int) -> list[dict]:
    """Trim prior turns to ``budget_chars`` characters, keeping the most recent.

    Pydantic-ai re-sends the full history on every model request inside the tool
    loop, so keeping the history bounded is the single biggest lever for making
    small-context models (8k) finish without overflowing.
    """
    if budget_chars <= 0:
        return []
    total = sum(len(str(t.get("content", ""))) for t in history)
    if total <= budget_chars:
        return history
    kept: list[dict] = []
    acc = 0
    for turn in reversed(history):
        c = len(str(turn.get("content", "")))
        is_system = turn.get("role") == "system"
        # Compact summaries (system role) stand in for the folded older turns —
        # never drop them to the char budget (mirrors the frontend's
        # sliceToBudget), or the model loses the compacted context and
        # "starts from scratch" on the next turn.
        if acc + c > budget_chars and kept and not is_system:
            break
        kept.append(turn)
        acc += c
    return list(reversed(kept))


def _history_budget(ctx: int, system_text: str, scouted: str, mode: str = "ask") -> int:
    """Char budget for the history given the model's context window.

    Rough char/token ratio of 4. The window must also hold the system prompt,
    tool schemas, scouting, the tool-loop re-sends (pydantic-ai re-sends the
    whole accumulated turn on every tool step) and the reply, so history gets a
    conservative share — and a hard ceiling keeps it from ever eating the whole
    window even when the char/token ratio is worse than 4:1 (mixed/Persian text
    is denser than English).

    Ask (mentor) turns stay conversational and rarely need deep recall of very
    old turns, so their history share is capped lower — keeping the recent
    conversation fully intact while trimming only the extra-long tail of old
    chats. Coder/Plan keep the window-scaled share for rich project context.
    """
    if ctx <= 0:
        return 200_000
    base_chars = len(system_text) + len(scouted or "")
    if ctx <= 16_000:
        share = 0.30
        floor = 800
    else:
        share = 0.35
        floor = 4_000
    budget = max(floor, int(ctx * 4 * share) - base_chars)
    # Hard ceiling (~31% of the window in tokens at 4 chars/token) so a large
    # window never lets the history alone blow past the real token limit.
    budget = min(budget, int(ctx * 1.25))
    # Absolute per-mode ceilings (must mirror the frontend's sliceToBudget):
    # ask stays conversational, coder/plan carry more tool-call history that
    # stays relevant, but both are capped so runaway growth is caught well
    # before the compact threshold even on huge windows.
    budget = min(
        budget, {"ask": 60_000, "plan": 120_000, "coder": 140_000}.get(mode, 200_000)
    )
    return budget


def _is_output_budget_exhausted(exc: BaseException) -> bool:
    """True for pydantic-ai's specific "the model burned its entire per-request
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


async def _compact_history(
    model: Any,
    history: list[dict],
    max_history: int = 10,
    max_chars: int = 30_000,
    usage_cap=None,
    fallback_model: Any = None,
    ctx: int = 0,
    max_output: int = 0,
) -> list[dict] | None:
    """Collapse older turns into one structured summary, keeping a recent tail
    verbatim, so a full window can continue instead of being cut off.

    Mirrors opencode's compaction (anomalyco/opencode): only the OLDER portion
    of the conversation — everything beyond a recent token-budgeted tail — is
    summarized; the most recent turns are kept VERBATIM after the summary. The
    summary uses opencode's exact template and merge behaviour, and its output
    is bounded only by opencode's 4096-token ceiling (scaled for small windows),
    not a 250-word straitjacket — so detail is preserved instead of discarded.

    Returns a tuple ``(new_history, recent_kept)`` — ``recent_kept`` is the exact
    number of recent turns preserved verbatim after the summary, so the caller
    can tell the frontend to fold precisely those older turns and keep the SAME
    recent ones (otherwise the summary and the verbatim tail it renders can
    contradict each other). Returns ``None`` if there is nothing to compact OR
    the summarizing call fails — on failure it does NOT drop the older turns
    (the caller surfaces a ``compact_failed`` event so the user can retry
    manually rather than silently losing context).

    If ``fallback_model`` is provided and differs from ``model``, a failed or
    empty summarizer run on ``model`` (the configured compact subagent) is
    retried once on ``fallback_model`` (the main model) — mirroring the manual
    /compact path, so a flaky compact subagent degrades to the working model
    instead of surfacing ``compact_failed``.
    """
    if ctx <= 0:
        ctx = 8192  # opencode assumes a window is always known; fall back sensibly
    tail_budget = _recent_tail_budget(ctx, max_output)

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
    recent = tail
    older = history[: len(history) - len(tail)]
    if not older:
        return None

    # --- separate any existing "[Compacted earlier context]" summary ----------
    # A previous compact left a summary at the head. On a 2nd+ compact opencode
    # MERGES it (carries forward details) rather than re-compressing it, so we
    # pass it to the model as the <prior-summary> instead of concatenating.
    existing_summary = ""
    older_turns: list[dict] = []
    for t in older:
        content = str(t.get("content", ""))
        if t.get("role") == "system" and content.startswith(
            "[Compacted earlier context]"
        ):
            existing_summary += content.removeprefix("[Compacted earlier context]\n")
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
        if len(content) > _TOOL_OUTPUT_MAX_CHARS:
            content = content[:_TOOL_OUTPUT_MAX_CHARS] + "\n[truncated]"
        return content

    older_turns_text = [_serialize(t) for t in older_turns]
    head_text = "\n\n".join(older_turns_text)

    # Bound the head so the summarize call itself fits the window (opencode
    # refuses to compact when the prompt wouldn't fit; we trim oldest instead).
    max_head_tokens = max(1024, _usable_tokens(ctx, max_output) - tail_budget - 512)
    while _estimate_tokens(head_text) > max_head_tokens and len(older_turns_text) > 1:
        older_turns_text.pop(0)
        head_text = "\n\n".join(older_turns_text)

    async def _summarize(m: Any) -> str:
        from llm import llm_complete

        if existing_summary:
            user_prompt = (
                "Here is the conversation so far:\n\n"
                f"<conversation>\n{head_text}\n</conversation>\n\n"
                "Here is the summary of the conversation before the <conversation> above:\n\n"
                f"<prior-summary>\n{existing_summary}\n</prior-summary>\n\n"
                + _SUMMARY_UPDATE_INSTRUCTIONS
                + "\n\n"
                + _SUMMARY_TEMPLATE
            )
        else:
            user_prompt = (
                "Here is the conversation so far:\n\n"
                f"<conversation>\n{head_text}\n</conversation>\n\n"
                "Create a new anchored summary from the conversation history in the "
                "<conversation> tags above so another coding agent can continue the work.\n\n"
                + _SUMMARY_TEMPLATE
            )
        summary = await llm_complete(
            m, system=_COMPACTION_SYSTEM_PROMPT, user=user_prompt
        )
        return (summary or "").strip()

    summary = ""
    try:
        summary = await _summarize(model)
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
                summary = await _summarize(fallback_model)
            except Exception:  # noqa: BLE001
                summary = ""
            if summary:
                break
    if not summary:
        return None  # compact failed — do NOT drop messages; caller surfaces a retry

    # opencode stores a single merged summary; we keep our "[Compacted earlier
    # context]" system-note convention so the frontend fold logic still works.
    return (
        [{"role": "system", "content": "[Compacted earlier context]\n" + summary}]
        + recent,
        len(recent),
    )


# Maximum number of auto-extracted memory notes written per run (Hermes-style
# self-curation). Prevents a single turn from flooding memory.
_AUTO_MEMORY_MAX_NOTES = 2
# Minimum combined (prompt + reply) length before we bother asking the model to
# reflect — short/simple exchanges usually hold nothing durable worth saving.
_AUTO_MEMORY_MIN_CHARS = 120


def _load_skills(root: str) -> list[dict]:
    """Load all user skills from the app database (single source of truth).

    Skills are stored in ``coder.db`` (managed in-app via Settings or the
    ``/skill`` tool) and shared across all workspaces — there is no filesystem
    scan. Each result is ``{"name", "description", "path", "content"}`` where
    ``path`` is the synthetic ``db://skills/<slug>`` id used by the vector
    store. The ``root`` argument is kept for API compatibility.
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
                "description": str(row.get("description") or "").strip(),
                "path": str(row.get("path") or f"db://skills/{slugify(name)}"),
                "content": body or content,
            }
        )
    return skills


def _skills_section(skills: list[dict]) -> str:
    """Compact skill index for the system prompt (discovery only).

    Skills come from the app database and cannot be reached through the
    project-sandboxed read tool. This section is the discovery half of the
    opencode/codex discovery → activation model: every skill stays as a compact
    name + description line so the agent always knows what exists without paying
    the token cost of every body on every turn. Full bodies are never inlined
    here — skills are used only via @mention, which inlines their full
    instructions.
    """
    if not skills:
        return ""
    lines = [
        "\n\n=== AVAILABLE SKILLS ===",
        (
            "These skills are available. They are used ONLY when the user "
            "explicitly attaches one with @mention in the message (the attached "
            "skill's full instructions are inlined). The rest are listed by "
            "name + description."
        ),
    ]
    for s in skills:
        name = s["name"]
        desc = s["description"] or ""
        if len(desc) > 100:
            desc = desc[:97].rstrip() + "…"
        lines.append(f"- {name} — {desc}" if desc else f"- {name}")
    return "\n".join(lines)


def _load_saved_plan(root: str, chat_id: str = "") -> str:
    """Return the saved implementation plan for this workspace+chat.

    Plans live as per-chat markdown files in the user data folder
    (``<data>/plan/<workspace>/<chat-id>/plan.md``, written by plan-mode's
    ``save_plan``). They are injected into later runs so the user or Coder
    mode can continue without retyping. With an empty ``chat_id`` the most
    recently updated plan in the workspace is returned. Returns an empty
    string when no plan is saved. Never raises.
    """
    try:
        workspace_slug = (
            slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep)))
            or "workspace"
        )
        plan = state_db.get_plan(workspace_slug, chat_id=chat_id)
    except Exception:  # noqa: BLE001
        return ""
    if not plan or not str(plan.get("content") or "").strip():
        return ""
    title = str(plan.get("title") or "").strip()
    return (
        "\n\n=== SAVED PLAN (from an earlier plan-mode run in this workspace) ===\n"
        f"Title: {title}\n"
        f"{plan['content']}\n"
        "If this message continues that task, follow this plan. If it is a new, "
        "unrelated task, ignore it."
    )




_MAX_ATTACHMENT_BYTES = 32_000  # per attached file; trimmed to save context


def _load_attachments(root: str, rels: list[str] | None) -> list[str]:
    """Read attached files (absolute paths) into context blocks, sandboxed to root."""
    blocks: list[str] = []
    for raw in rels or []:
        rel = str(raw).strip()
        if not rel:
            continue
        try:
            target = resolve_safe(root, rel)
        except PathEscapeError:
            continue
        if not os.path.isfile(target) or not _is_text_path(target):
            continue
        try:
            content, truncated = _read_text(target)
        except OSError:
            continue
        if truncated:
            content += "\n... (file truncated)"
        if len(content) > _MAX_ATTACHMENT_BYTES:
            content = (
                content[:_MAX_ATTACHMENT_BYTES]
                + "\n...(attachment truncated to save context; use read with offset/limit for specific parts)"
            )
        display = os.path.relpath(target, resolve_safe(root, ""))
        blocks.append(f"===== ATTACHED FILE: {display} =====\n{content}")
    return blocks


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
_MAX_VISION_DIM = 2000            # longest side sent to a vision model
_MAX_VISION_BYTES = 4 * 1024 * 1024  # decoded bytes; above this we shrink


def _maybe_downscale_image(data_url: str) -> str:
    """Shrink oversized raster image data URIs so vision providers accept them.

    No-op when Pillow is unavailable or the image is already within limits.
    Guarded so a missing Pillow never breaks image loading — the original URI
    is returned untouched on any failure.
    """
    if not data_url.startswith("data:image/"):
        return data_url
    try:
        from io import BytesIO
        from PIL import Image
    except Exception:  # noqa: BLE001
        return data_url
    try:
        _, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return data_url
    if len(raw) <= _MAX_VISION_BYTES:
        try:
            with Image.open(BytesIO(raw)) as img:
                if max(img.size) <= _MAX_VISION_DIM:
                    return data_url
        except Exception:  # noqa: BLE001
            return data_url
    try:
        with Image.open(BytesIO(raw)) as img:
            src = img.copy()
        if max(src.size) > _MAX_VISION_DIM:
            scale = _MAX_VISION_DIM / max(src.size)
            src = src.resize(
                (max(1, int(src.size[0] * scale)), max(1, int(src.size[1] * scale)))
            )
        out = BytesIO()
        fmt = "PNG" if src.mode in ("RGBA", "P", "LA") else "JPEG"
        if fmt == "JPEG" and src.mode in ("RGBA", "P", "LA"):
            src = src.convert("RGB")
        src.save(out, format=fmt, quality=82)
        new_b64 = base64.b64encode(out.getvalue()).decode("ascii")
        mime = "image/png" if fmt == "PNG" else "image/jpeg"
        return f"data:{mime};base64,{new_b64}"
    except Exception:  # noqa: BLE001
        return data_url


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
            uris.append(_maybe_downscale_image(str(data_url)))
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
        uris.append(
            _maybe_downscale_image(
                f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
            )
        )
    return uris


# Explicit per-turn mode declaration. The agent CANNOT reliably tell its own
# mode (every built-in prompt opens with "You are Coder…"), and after a mode
# switch the conversation history is full of the previous mode's replies, which
# makes it claim "nothing changed". Telling it the mode for THIS message (and
# that the user can switch it per message via the UI) fixes both the false
# refusal and the misreporting.
_MODE_LABELS = {"ask": "Ask", "plan": "Plan", "coder": "Coder"}
_MODE_CAPS = {
    "ask": "You are a read-only MENTOR: for project questions the repository is explored automatically and the relevant file contents are placed in your context, so you answer from the real code. You NEVER write, edit or delete files or run commands.",
    "plan": "You are a read-only PLANNER: you produce the implementation plan and NEVER write, edit or delete files; your terminal is read-only.",
    "coder": "You are an implementation-only agent: you create/edit files strictly from the plan's context. You have NO discovery or execution tools — you cannot search, read, browse, or run commands/tests.",
}

# Per-mode output contract appended to the CURRENT-MODE note every turn, so a
# mid-chat mode switch re-orients the agent immediately (history alone can't).
_MODE_OUTPUT = {
    "ask": (
        "Your reply MUST be step-by-step guidance: the exact file paths, line/function targets and actions the "
        "user should take, teaching why — never an implementation, never full file contents."
    ),
    "plan": (
        "Your reply MUST be an implementation plan: open with '## Plan', then ordered steps with exact file paths "
        "and line targets, targeted snippets for Coder mode, and how to verify — never do the work, and end by "
        "offering to switch to Coder mode to implement it. End the plan with a 'Files: path1, path2, ...' line "
        "listing every file the implementation will touch."
    ),
    "coder": "",
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
            "summary, ask_user question and options, and any comment or text inside "
            "generated code/files. Never reply in English when the user writes Persian."
        )
    return (
        "\nLANGUAGE RULE (always follow): Reply entirely in the same language the user "
        "writes in — Persian → Persian, English → English, etc. Never switch languages "
        "for todo lists, plans or summaries."
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
        "only affects new chats."
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
    attachments: list[str] | None = None,
    images: list[str] | None = None,
    system_prompt: str = "",
    thinking_level: str = "medium",
    context_window: int = 0,
    env_var: str = "",
    oauth_token: str = "",
    mcp_servers: dict | None = None,
    skills: list[str] | None = None,
    allow_create: bool = False,
    cap: dict | None = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    allow_outside: bool = False,
    nvim_file: str = "",
    nvim_diagnostics: list | None = None,
    max_history: int = 10,
    vector_db_path: str = "",
    vector_config: dict | None = None,
    retrieval_config: dict | None = None,
    subagent_models: dict | None = None,
    chat_id: str = "",
    compact_threshold: float | None = None,
    providers: dict | None = None,
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
        "model_name": model_name,
        "base_url": base_url,
        "api_key": api_key,
        "root": root,
        "mode": mode or "ask",
        "request": prompt or "",
        "history": list(history or []),
        "attachments": _to_list(attachments),
        "images": _to_list(images),
        "system_prompt": system_prompt,
        "thinking_level": thinking_level,
        "context_window": int(context_window or 0),
        "env_var": env_var,
        "oauth_token": oauth_token,
        "mcp_servers": mcp_servers or {},
        "skills": _to_list(skills),
        "allow_create": allow_create,
        "cap": cap,
        "permission_gates": permission_gates,
        "ask_gates": ask_gates,
        "allow_outside": allow_outside,
        "nvim_file": nvim_file,
        "nvim_diagnostics": _to_list(nvim_diagnostics),
        "max_history": max_history,
        "vector_db_path": vector_db_path,
        "vector_config": vector_config,
        "retrieval_config": retrieval_config,
        "subagent_models": dict(subagent_models or {}),
        "chat_id": chat_id,
        "compact_threshold": compact_threshold,
        "providers": providers or {},
    }
    async for event in run_graph(initial):
        yield event
