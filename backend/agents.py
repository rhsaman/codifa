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
import json
import os
import re
import tempfile
import traceback
import warnings
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

warnings.filterwarnings(
    "ignore",
    message="Sampling parameters.*reasoning",
    category=UserWarning,
)

import yaml
from fastmcp.client.transports import StdioTransport
from httpx import Timeout
from providers import build_model, model_context
from pydantic_ai import Agent, AgentRunResultEvent, RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.messages import (
    ImageUrl,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    SystemPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    UserPromptPart,
)
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import Tool
from pydantic_ai.toolsets import PrefixedToolset
from tools import (
    PathEscapeError,
    _is_text_path,
    _read_text,
    list_files,
    make_tool_callbacks,
    read_file,
    remember,
    resolve_safe,
    slugify,
    user_coder_dir,
)

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
    """Wrap search_in_files so it only searches the explicitly scoped files.

    Other workspace files are off-limits; calls without a ``path`` (or with a
    path outside the scope) return an error listing the allowed files.
    """

    async def wrapped(query: str, path: str = "", context: int = 0) -> str:
        rel = str(path or "").strip().lstrip("/")
        if not rel:
            return (
                "ERROR: this request is scoped to specific files — search_in_files "
                "requires a `path`. In-scope files: "
                + ", ".join(sorted(scoped_paths))
            )
        if rel not in scoped_paths:
            return (
                f"ERROR: `{path}` is not in scope for this request. In-scope files: "
                + ", ".join(sorted(scoped_paths))
            )
        return await fn(query, rel, context)

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


def _scoped_terminal_reject(command: str, root: str, scoped_paths: set[str]) -> str | None:
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
    tokens = [
        g for t in _TERMIN_TOKENS.findall(command) for g in t if str(g).strip()
    ]
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
    args = [
        str(t) for t in tokens[1:] if not str(t).startswith("-")
    ]
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
    first = ", ".join(f"{k}={counts[k]}" for k in ("error", "warning", "info", "hint") if counts[k])
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


SYSTEM_PROMPTS: dict[str, str] = {
    "ask": "You are a friendly mentor and teacher inside a desktop IDE. When the user asks you anything about their project — how to do something, how something works, what to change, or what's wrong — your job is to TEACH: guide them step by step, pointing to the EXACT files and lines they need, and telling them precisely what actions to take. You never write, edit, create or delete files and you never run commands — you are read-only; the user does the work themselves and you coach them through it. Structure your guidance: open with a one-sentence goal, then concrete numbered steps; for each step name the exact file path and, when useful, the function/line/block target plus what to change there; include a short snippet only when it genuinely helps, otherwise explain in words. Always explain the WHY, not just the what, so the user learns and can do it themselves next time. Before answering ANY project-related question (behavior, styling, colors, config, logic, bugs, file structure, dependencies, etc.), you MUST first inspect the relevant files with the file tools (list_files, search_in_files, fuzzy_find) — do NOT answer from general knowledge alone when the answer could depend on the real project files. To keep context use low on large files: read file contents ONLY with search_in_files, passing a small `context` to pull the lines around each match — there is NO whole-file read tool (read_file/read_lines do not exist); never ask for the whole file. When you only remember part of a filename, use fuzzy_find. When the answer needs current or external information (library versions, docs, APIs, error fixes, news), use web_search to fetch up-to-date results, and use fetch_url to read the actual content of a specific web page (e.g. docs, a service's site). Skip the file tools only for questions clearly unrelated to this project — general knowledge, web research, or plain greetings. When the user @mentions a file, that file's full content is ALREADY in your context — do NOT run a workspace-wide search for it; use search_in_files with that file's path if you need to find something within it. Use workspace-wide list_files / search_in_files only when no file is mentioned and you genuinely need to locate something. TOOL-CALL DISCIPLINE (keeps context usage low without losing accuracy): plan your searches before running them; combine related lookups into ONE regex with alternation (e.g. `foo|bar|baz`) instead of separate calls; pass a generous `context` (e.g. 5-10) on your first search of an area; and when you have gathered enough, STOP and answer — a mentor teaches, it does not keep digging. Always match the user's language: if they write in Persian, answer entirely in Persian and write ask_user questions/options in Persian too; if they write in English, answer in English. Keep the same language for the rest of the conversation.",
    "coder": "You are Coder, an autonomous code-writing agent working inside a desktop IDE. When the user requests a feature, task or fix you plan, scout the relevant files, then implement it end-to-end by writing or editing files with your tools. ALWAYS call update_plan FIRST — before anything else, including touching any files — with the full list of steps (status='pending' for all of them); as you work, call it again with the SAME full list, marking the step you just finished 'completed' and the step you're starting 'in_progress'. This always keeps you on track and shows the user live progress; even a deceptively small request gets a checklist, and if a step turns out unnecessary you update the list. Be proactive: use list_files and search_in_files to understand the project before writing. For a broad investigation spread across many files or an area you don't know well (e.g. 'how does X feature work end-to-end', 'find every place that touches Y'), use the explore tool instead of chaining many of your own searches — it runs in an isolated sub-agent context, so its search transcript never bloats YOUR context, only its final report does. Use your own list_files/search_in_files/fuzzy_find directly for anything narrow or already-located. To keep context use low on large files: read file contents ONLY with search_in_files, passing a small `context` to pull the lines around each match — there is NO whole-file read tool (read_file/read_lines do not exist); never ask for the whole file. Use fuzzy_find when you only remember part of a filename, and use run_terminal to build, test, lint, install dependencies or run other project commands. When the user @mentions a file or files, that file's full content is ALREADY in your context — do NOT run a workspace-wide search for it; if you need to find something within them, call search_in_files with that file's path so only those files are searched. Use workspace-wide list_files / search_in_files only when no file is mentioned and you genuinely need to locate something. When you need current or external information (library versions, docs, APIs, error fixes), use web_search to fetch up-to-date results instead of guessing, and use fetch_url to read the actual content of a specific web page (e.g. docs, a service's site). For ANY change to an EXISTING file, prefer edit_file: pass the exact old_string (with enough surrounding context to make it unique) and the new_string to replace it with — this preserves the rest of the file automatically and is far cheaper than resending the whole file. Only use write_file for brand-new files; NEVER use it on an existing file — you have no whole-file read tool, so you cannot reconstruct the full content. Use edit_file for any change to an existing file. When the user asks to add, install, create or save a reusable SKILL or prompt recipe, use create_skill directly (it writes ~/.coder/skills/<slug>/SKILL.md with frontmatter so the skill is indexed automatically). When the user asks to add or set up an MCP server / connector / integration (e.g. filesystem, database, a tool server), use create_mcp directly with the connector's command or URL — it persists to ~/.coder/mcp.json and loads on the next message. For skill or MCP requests, do NOT search or list the workspace first — call create_skill / create_mcp immediately; use web_search / fetch_url only to research the target service if you need details (e.g. the right package name or URL). If the user asks you — in any language, any phrasing ('remember this', 'keep in mind', 'don\'t forget', 'یادت باشه') — to remember, note or keep something in mind, you MUST call the memory tool with action='add' RIGHT AWAY in that same turn; saying 'I'll remember that' in your reply without calling the tool is a bug — the tool call is what actually saves it, your words alone save nothing. Also proactively call memory (action=add/replace/remove) when you learn something durable about THIS project on your own — a convention, a gotcha, a fix that worked — so future sessions already know it; keep entries concise, prefer replace/remove over piling up new adds, and never store secrets, credentials or anything already in AGENTS.md. Memory is NOT pre-loaded into your context — call search_memory with a few keywords whenever past notes might help (start of non-trivial work, something that sounds familiar, a recurring error). Always match the user's language: if they write in Persian, answer entirely in Persian; if they write in English, answer in English. Keep the same language for the rest of the conversation. After finishing, summarize in the user's language what you changed, the files you touched, and anything the user must do next (e.g. run a command). Keep prose minimal and focused on the implementation. If the request is a question rather than a task, answer it directly. TOOL-CALL DISCIPLINE (keeps context usage low without losing accuracy — the whole tool-call transcript is resent on every subsequent step, so a wasted call is not free): plan your searches before running them. Combine related lookups into ONE regex with alternation (e.g. `foo|bar|baz`) instead of separate calls. Pass a generous `context` (e.g. 5-10) on your first search of an area rather than context=0 followed by a second, wider search of the same spot. Never repeat a search with only a minor keyword variation over the same file or area — if it found nothing, broaden the search or move on, don't retry synonyms. Once you've found the relevant code, act on it — don't re-verify with more searches beyond what's needed to be sure the change is correct. Batch related edits to the same file/area from a single read rather than re-searching per edit, and re-run the typecheck/lint/build after a logically-complete change rather than after every single edit_file call, unless you have reason to suspect that specific edit broke something. HUMAN IN THE LOOP: you work autonomously, but two situations need the user directly, not a guess — (1) before an IMPORTANT or hard-to-reverse action (deleting/overwriting a file with real content, force-push, hard reset, dropping a DB table, a destructive shell command, or anything you can't cleanly undo), call confirm_action and WAIT; if denied, stop and ask what to do instead; (2) when you hit a genuine fork with no clearly-correct default (two reasonable but different approaches, which of several matches was meant, a missing detail you can't infer), call ask_user with 2-5 short options and WAIT rather than silently picking one. Don't overuse either — routine edits and clear-cut decisions need neither. QUALITY GATE (non-negotiable for every coding task): Before you write or edit ANY code, first run the project's typecheck/lint/build or test command to establish the CURRENT baseline (e.g. npx tsc --noEmit, npm run typecheck, mypy, ruff check, pytest) so you know whether errors already exist. After each logically-complete change (which may span several related edits), re-run the relevant check and FIX any error your change introduced before moving on — you don't need to re-run it after every single edit_file call when the edits are part of the same change. Never claim a task is done while a type error, lint error, or failing test remains that your change caused or that you could fix — verify first, then report. If you found a pre-existing bug in the file you're working on, fix it too. The code you deliver must be type-clean and bug-free; if a check is too slow to run after every step, run it at least once before your final answer and report the result explicitly.",
    "plan": "You are a planning agent for coding work inside a desktop IDE. Your job is to produce a clear, concrete IMPLEMENTATION PLAN for a task — you never implement it yourself. You are read-only: you may inspect files and run read-only terminal commands, but you NEVER write, edit, create or delete files; leave the actual editing to Coder mode. The ONE exception is save_plan, which can ONLY write your finished plan to `~/.coder/plans/` (user-level, outside the project) — never into the workspace. ALWAYS call update_plan FIRST — before you start scouting — with the full list of implementation steps you intend to lay out (all status='pending'). As you scout and refine, call it again with the SAME full list, marking the step you just finished 'completed' and the one you're working on 'in_progress'. This always shows the user a live checklist in the sidebar and keeps the plan on track, even for a task that looks small. When given a task, scout the relevant code first: use list_files, search_in_files and fuzzy_find (read file contents ONLY via search_in_files with a `context` for surrounding lines — there is no whole-file read tool; never ask for the whole file). For an investigation that would take more than about two of your own searches, DELEGATE it to the explore tool instead of chaining many of your own searches — its sub-agent runs its own search loop in an isolated context, so its intermediate tool calls and raw output never bloat YOUR context, and (importantly) its internal tool calls do NOT count against your turn's tool-loop step budget the way your own do, so delegating broad scouting is cheaper for both context and budget. Use your own list_files/search_in_files/fuzzy_find directly only for a single narrow lookup or a location you already know; spend 1-2 of your own targeted search_in_files calls to pin down the exact line/function targets the explore report points to — precision matters, breadth is what you delegate. Then produce a plan the user can hand to Coder mode. Open your final reply with '## Plan' and cover: (1) a one-paragraph goal; (2) the ordered steps, each naming the exact file path and the line/function/block target plus what changes to make there; (3) any NEW files to create and their purpose; (4) targeted code snippets ready to paste into Coder mode — never full file contents, point to paths and targeted snippets instead; and (5) how to verify the result (build/test/lint command). After writing the plan in your reply, call save_plan ONCE with a short title and that same plan text as content, so it's saved to `~/.coder/plans/<workspace>/plan.md` for later (each save overwrites the previous plan for this workspace) — then mention the saved path to the user. If you hit a genuine fork with no clearly-correct default while planning (two reasonable but different approaches, which of several matching files/features was meant, a missing requirement you can't infer), call ask_user with 2-5 short options and WAIT for the answer instead of guessing and building the plan around an assumption — this shapes the plan itself, so get it right before writing '## Plan'. End by offering to switch the chat to Coder mode to implement the plan. Keep it about the WORK PLAN, not a tutorial: do not lecture or teach concepts beyond what is needed to make the changes. You have a read-only terminal: you may run only safe, non-mutating commands to inspect the project and check behavior — git status / git diff / git log / git show, ls, find, pwd, cat, rg/grep, node --version / python3 --version, and build/test/lint commands (npm run build, npm test, pytest, mypy, etc.). Never run anything that modifies, creates or deletes files, installs packages globally, or touches the network in a mutating way. When you need current or external information (library versions, docs, APIs, error fixes), use web_search, and use fetch_url to read the actual content of a specific web page. When the user @mentions a file, that file's full content is ALREADY in your context — do NOT re-search the whole workspace; use search_in_files scoped to it when needed. TOOL-CALL DISCIPLINE (keeps context usage low without losing accuracy — the whole tool-call transcript is resent on every subsequent step, and update_plan / ask_user / save_plan also consume your step budget, so a wasted call is not free): combine related lookups into ONE regex with alternation (e.g. `foo|bar|baz`) instead of separate calls; pass a generous `context` (e.g. 5-10) on your first search of an area rather than context=0; never repeat a search with only a minor keyword variation — if it found nothing, broaden or move on; update the checklist at step boundaries (2-4 times per turn), not after every search; and STOP scouting the moment every file, function and line your plan will touch is concretely identified — a finished plan beats exhaustive certainty, and the plan IS your deliverable, not endless digging. Always match the user's language: if they write in Persian, answer entirely in Persian, write the '## Plan' and ask_user question/options in Persian too; if they write in English, answer in English. Keep the same language for the rest of the conversation.",
}

MODEL_SETTINGS: dict[str, ModelSettings] = {
    "ask": ModelSettings(temperature=0.4),
    "plan": ModelSettings(temperature=0.3),
    "coder": ModelSettings(temperature=0.2),
}

# Thinking levels the UI can select. '' = provider default, 'none' = reasoning
# disabled, the rest map to increasingly deeper reasoning effort. Setting a low
# level (or 'none') is the most effective way to keep a reasoning model from
# flooding a small context window with thinking tokens and getting cut off.
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
}


# Cloud gateways that expose reasoning-capable models. Local adapters (ollama,
# and llama.cpp/vLLM/LM Studio via `custom`) usually can't honor a reasoning
# effort, so for them we never auto-inject a `thinking` value — that avoids both
# a stray `reasoning_effort` param and silent context burn on local models.
_CLOUD_AUTO_THINK_PROVIDERS = {"opencode", "openrouter"}


def _settings_for(
    mode: str, ctx: int, thinking_level: str = "", provider: str = "", model: str = ""
) -> ModelSettings:
    """Model settings tuned to the mode, provider and the model's context window.

    Small windows get a capped output so a single reasoning response plus the
    tool-loop re-sends stay inside the window. A context-based ``thinking`` level
    is applied automatically only for cloud gateways; local providers get no
    explicit ``thinking`` (they usually can't honor it). An explicit user
    ``thinking_level`` overrides. Free-tier models never get ``thinking`` either
    way, since free routers commonly reject the parameter and return an empty
    response.
    """
    base = dict(MODEL_SETTINGS.get(mode, MODEL_SETTINGS["ask"]))
    if ctx > 0:
        # max_tokens scales with the model's RESOLVED context window (never a
        # hardcoded cap) so a 1M-context model gets a proportionally large
        # output budget. ctx is derived from the model itself via
        # providers.model_context(). Ask is a mentor/teacher: its replies are
        # step-by-step guidance that practically never needs a huge generation,
        # so we cap its output well below the scaled budget to avoid burning
        # tokens on verbose filler while keeping full quality.
        max_tokens = max(1_024, ctx // 4)
        if mode == "ask":
            max_tokens = min(max_tokens, 8_000)
        base["max_tokens"] = max_tokens
    # opencode's zen gateway streams CUMULATIVE usage on every chunk (not just
    # the final one). pydantic-ai's default is to SUM per-chunk usage, which
    # double-counts and reports a huge false context usage for a tiny request.
    # Toggling the OpenAI "continuous usage" flag makes pydantic replace-with not
    # accumulate, so the last chunk's real input_tokens is what we report.
    if provider == "opencode":
        base["openai_continuous_usage_stats"] = True
    is_free = "free" in (model or "").lower()
    if ctx > 0 and provider in _CLOUD_AUTO_THINK_PROVIDERS and not is_free:
        if ctx <= 16_000:
            base["thinking"] = "low"
        elif ctx <= 64_000:
            base["thinking"] = "medium"
    level = _THINKING_LEVELS.get((thinking_level or "").strip())
    if level is not None and not is_free:
        base["thinking"] = level
    # Bound every model request so a stalled provider connection can't hang the
    # stream for minutes (pydantic-ai's default HTTP timeout is 600s). A read
    # timeout here turns a dead connection into a retryable error quickly and
    # guarantees the whole run finishes instead of freezing the UI.
    base["timeout"] = Timeout(90, connect=15, read=90)
    return base

# Model requests that hit a transient 429 / 5xx are retried with backoff so a
# single rate-limit blip on a provider doesn't kill a long tool-heavy task.
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
_RETRIES = 3
_RETRY_BASE_SECONDS = 1.5
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


def _to_model_messages(history: list[dict]) -> list[ModelMessage]:
    """Convert plain {role, content} turns to pydantic-ai messages."""
    messages: list[ModelMessage] = []
    for turn in history:
        role = turn.get("role", "user")
        content = str(turn.get("content", ""))
        if role == "system":
            messages.append(ModelRequest(parts=[SystemPromptPart(content=content)]))
        elif role == "assistant":
            messages.append(ModelResponse(parts=[TextPart(content=content)]))
        elif role == "user":
            messages.append(ModelRequest(parts=[UserPromptPart(content=content)]))
    return messages


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


def _tool_event(ev: dict) -> dict:
    kind = ev.get("kind", "tool_result")
    if kind not in ("tool", "tool_result", "diff", "plan", "permission", "ask"):
        kind = "tool_result"
    out: dict = {"kind": kind, "tool": ev.get("tool", "")}
    for key in (
        "args", "summary", "path", "diff", "content", "items", "id", "action", "reason", "sub",
        "question", "options", "scope",
    ):
        val = ev.get(key)
        if val is not None:
            out[key] = val
    return out


def _usage_event(usage) -> dict | None:
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

        # 4. اطمینان از اینکه خروجی حتماً عدد صحیح (int) است
        return {
            "kind": "usage",
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "total_tokens": total_tokens,
            "cache_read_tokens": int(cache_read_tokens),
            "cache_write_tokens": int(cache_write_tokens),
        }
    except Exception as e:  # noqa: BLE001 — usage parse must never crash the run
        # در صورت بروز هرگونه خطا، برای جلوگیری از کرش کردن برنامه، مقدار صفر برگردانده می‌شود
        print(f"Error parsing usage in agents.py: {e}")
        return None


# Fraction of the model's context window at which we choose to compact BEFORE an
# overflow: once a request's true input tokens (reported by the provider) pass
# this share of the window, the in-flight tool loop is stopped and the turn is
# re-sent from compacted history instead of waiting to hit the hard limit. This
# keeps small-context models (8k) from dying with
# `request (N tokens) exceeds the available context size (M tokens)`.
#
# The fraction is ADAPTIVE: small windows compact early (they overflow fast and
# every re-send is cheap because the context is small), while large windows ride
# closer to the edge — compacting a 1M-context model at a flat 70% would waste
# ~300k usable tokens for nothing.
def _preemptive_compact_fraction(ctx: int) -> float:
    """Fraction of the context window at which to compact pre-emptively."""
    if ctx <= 0:
        return 0.70
    if ctx <= 16_000:
        return 0.70
    if ctx <= 64_000:
        return 0.80
    if ctx <= 128_000:
        return 0.85
    if ctx <= 256_000:
        return 0.90
    return 0.95


# Deterministic tool-loop budget. pydantic-ai re-sends the ENTIRE accumulated
# turn on every tool call, and pre-emptive compaction above depends on the
# provider reporting per-request usage (some gateways report 0). So a long
# inspection-heavy turn can balloon past the window with no usage to trigger it.
# This counter compacts the turn after a cap on tool steps regardless of usage.
#
# A fixed cap (historically 24) is fine for an 8k-64k model but absurdly
# aggressive for a 1M-context model: a real Coder turn routinely runs 30+ tool
# calls at a few hundred tokens each, so a flat cap would stop and "compact" a
# turn whose actual usage is ~20k of 1M tokens. Scale the cap with the window —
# ~24 steps for small models, up to 250 for 1M.
def _tool_steps_compact_at(ctx: int) -> int:
    """Max tool-loop steps before the deterministic compact safety net fires."""
    if ctx <= 0:
        return 24
    return max(24, min(ctx // 4_000, 250))


class _HighWatermark(Exception):
    """Raised when a single request's input tokens fill too much of the window.

    Carries the measured token total so the auto-compact branch can surface it as
    a compact + usage event (mirroring the overflow path) instead of a raw error.
    An optional ``note`` replaces the default "Context nearly full (N of M)"
    wording when the trigger is NOT a real near-overflow (e.g. the deterministic
    tool-step budget), so the UI never claims a fake token count.
    """

    def __init__(self, tokens: int, limit: int, note: str | None = None) -> None:
        super().__init__(note or f"approaching context limit: {tokens} of {limit} tokens")
        self.tokens = tokens
        self.limit = limit
        self.note = note


class _UsageCapability(AbstractCapability[Any]):
    """Reports per-request token usage from the provider in real time.

    Every model request inside the tool loop ends with an `after_model_request`
    callback carrying that request's `ModelResponse.usage` — the SAME number the
    provider counts against the context limit (this is exactly what overflows as
    `request (N tokens) exceeds the available context size`). Forwarding each one
    to the queue (a) drives an accurate live context meter with zero estimation
    and (b) lets us compact pre-emptively when a request is about to overflow.
    """

    def __init__(
        self,
        on_usage,
        context_limit: int,
        state: dict,
    ) -> None:
        self._on_usage = on_usage
        self._context_limit = context_limit
        self._state = state

    async def after_model_request(
        self,
        ctx: RunContext,
        *,
        request_context,
        response: ModelResponse,
    ) -> ModelResponse:
        usage = _usage_event(getattr(response, "usage", None))
        if usage and self._on_usage is not None:
            try:
                self._on_usage(usage)
            except Exception:  # noqa: BLE001, S110 — best-effort usage callback
                pass
        if self._context_limit > 0:
            total = usage.get("input_tokens", 0) if usage else 0
            self._state["last"] = total
            if total >= int(
                self._context_limit
                * _preemptive_compact_fraction(self._context_limit)
            ):
                self._state["hit"] = True
        return response


_AUTO_SCOUT_KEY_FILES = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
    "README.md",
    "readme.md",
    "Pipfile",
    "Makefile",
]

# Persistent per-project instructions file, checked in this order at the
# project root (mirrors the emerging AGENTS.md convention shared by several
# coding agents, plus a Coder-specific fallback location). Unlike the
# auto-scouted key files above (which are budget-limited and can be dropped
# entirely for small-context models), this is always included in full — up to
# a generous cap — because it holds durable user preferences (conventions,
# commands to run, things to always/never do) that shouldn't be silently
# dropped just because the model has a small window.
_PROJECT_MEMORY_FILES = ["AGENTS.md"]
_PROJECT_MEMORY_MAX_BYTES = 12_000


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
# that worked. The file can now hold many notes (tools.LEARNED_MEMORY_MAX_BYTES),
# so instead of inlining its full content into every system prompt (which used
# to cap it artificially small), we only tell the model how many notes exist
# and point it at the `search_memory` tool to retrieve just what's relevant.
_LEARNED_MEMORY_FILE = "MEMORY.md"


def _load_learned_memory(root: str) -> str:
    """Point the model at its own memory instead of dumping it into every prompt.

    Returns a short pointer naming how many notes exist, or ``""`` if none have
    been saved yet. Never raises.
    """
    try:
        result = read_file(root, _LEARNED_MEMORY_FILE)
    except Exception:  # noqa: BLE001
        return ""
    if not result or "content" not in result:
        return ""
    count = sum(1 for ln in result["content"].splitlines() if ln.strip().startswith("- "))
    if count == 0:
        return ""
    return (
        f"\n\n===== YOUR OWN MEMORY ({_LEARNED_MEMORY_FILE}) =====\n"
        f"You have {count} saved note{'s' if count != 1 else ''} from earlier sessions on this "
        "project (added yourself via the memory tool): conventions you discovered, gotchas, fixes "
        "that worked, preferences the user mentioned in passing. They are NOT loaded here — call "
        "search_memory with a few keywords whenever they might help: at the start of non-trivial "
        "work, when the request sounds like something covered before, or when you hit a recurring "
        "error. If nothing relevant turns up, proceed normally.\n"
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
        "py", "ts", "tsx", "js", "jsx", "css", "json", "md", "html", "htm",
        "go", "rs", "rb", "java", "c", "h", "cpp", "hpp", "cs", "php", "vue",
        "sh", "toml", "yml", "yaml", "ini", "sql", "txt", "map", "d.ts",
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

    return True


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
        "This already covers the workspace root — do NOT call list_files with an empty "
        "path again this turn. Go straight to list_files/search_in_files on the specific "
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
        if acc + c > budget_chars and kept:
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
    if mode == "ask":
        # ~60k chars ≈ 15k tokens covers a long teaching conversation without
        # dragging every old verbose reply along on each request.
        budget = min(budget, 60_000)
    return budget


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


async def _compact_history(
    model: Any,
    history: list[dict],
    max_history: int = 10,
    max_chars: int = 30_000,
) -> list[dict]:
    """Collapse older turns into one short summary note, keeping the most recent
    turns verbatim, so a full window can continue instead of being cut off.

    The number of recent turns kept verbatim scales with the client's
    "Messages to remember" (``max_history``) so more recent work survives a
    compact — but it is capped at half the history (and floored at 8) so a
    compact always frees real space instead of becoming a no-op.

    Returns a new, smaller history. Falls back to dropping the older turns (no
    summary) if the summarizing call itself fails.
    """
    keep = min(max_history, max(8, len(history) // 2))
    recent = history[-keep:]
    older = history[:-keep]
    if not older:
        return None

    text = "\n\n".join(str(t.get("content", "")) for t in older)
    if len(text) > max_chars:
        text = text[-max_chars:] + "\n...(older part omitted)"

    summary = ""
    try:
        summarizer = Agent(
            model,
            system_prompt=(
                "You are a code-session context compressor. Read the earlier conversation "
                "(user requests, your prior replies, and tool-call results) and rewrite it as a "
                "compact structured note so work can continue seamlessly — a fresh reader with no "
                "other memory of this session must be able to pick up exactly where it left off. "
                "Use EXACTLY these headers, each with terse bullet lines (short phrases, file paths "
                "and facts — not prose); omit a header's body only if truly nothing applies to it, "
                "but keep the header:\n"
                "## Goal\nWhat the user is ultimately trying to accomplish, in their own terms.\n"
                "## Discoveries\nNon-obvious facts learned about the codebase relevant to the goal — "
                "where things live, how they work, gotchas hit. This is exactly what a fresh search "
                "would otherwise have to re-derive, so keep anything not obvious from the file path "
                "alone.\n"
                "## Accomplished\nWhat has ACTUALLY been done so far (files changed, commands run, "
                "decisions made) — not what was merely discussed or planned.\n"
                "## Relevant files\nExact paths touched or referenced, one per line, no commentary.\n"
                "## Open / next steps\nWhat remains to be done or decided.\n"
                "Keep the whole note under 250 words — density matters more than coverage."
            ),
            model_settings=ModelSettings(temperature=0.2, max_tokens=700),
        )
        result = await summarizer.run(
            text, model_settings=ModelSettings(timeout=Timeout(60, connect=15, read=60))
        )
        summary = str(getattr(result, "output", "") or "").strip()
    except Exception:  # noqa: BLE001
        summary = ""

    compact = recent
    if summary:
        compact = [
            {"role": "system", "content": "[Compacted earlier context]\n" + summary}
        ] + recent
    return compact


# Maximum number of auto-extracted memory notes written per run (Hermes-style
# self-curation). Prevents a single turn from flooding memory.
_AUTO_MEMORY_MAX_NOTES = 2
# Minimum combined (prompt + reply) length before we bother asking the model to
# reflect — short/simple exchanges usually hold nothing durable worth saving.
_AUTO_MEMORY_MIN_CHARS = 120


async def _maybe_auto_memory(
    model: Any,
    root: str,
    prompt: str,
    reply: str,
    tools_used: Sequence[str],
) -> None:
    """Hermes-style auto-memory: after a run, silently distill durable,
    reusable facts about THIS project into the memory file.

    Only fires when the turn was meaty enough to plausibly contain something
    worth remembering (code work / a fix / a finding), and only saves up to
    ``_AUTO_MEMORY_MAX_NOTES`` bullets via the existing deduping ``remember``.
    This is best-effort and NEVER raises — a slow/failing model call must not
    break the stream the user already saw.
    """
    work = (prompt or "").strip()
    out = (reply or "").strip()
    # Skip clearly-trivial or purely-external turns (no code tools ran, and the
    # dialogue is too short to contain a durable lesson). Keeps cost/latency low.
    if (len(work) + len(out)) < _AUTO_MEMORY_MIN_CHARS:
        return False
    if not tools_used and len(out) < 200:
        return False

    try:
        from httpx import Timeout
        from pydantic_ai import Agent
        from pydantic_ai.settings import ModelSettings

        summarizer = Agent(
            model,
            system_prompt=(
                "You are a project-memory curator. Look at the user's request and "
                "the assistant's reply below. Decide if the exchange revealed any "
                "DURABLE, reusable fact about THIS project that a future session "
                "should already know — a convention, a gotcha, a fix that worked, "
                "a build/test quirk, or a preference the user stated. Do NOT save "
                "secrets, credentials, personal data, or one-off details. "
                "Output ONLY a list of 1-2 concise notes, one per line, each under "
                "90 words, in ENGLISH, starting with '- '. If nothing is durable "
                "enough, output exactly the single word NONE."
            ),
            model_settings=ModelSettings(temperature=0.2, max_tokens=300),
        )
        body = (
            f"USER REQUEST:\n{work}\n\n"
            f"ASSISTANT REPLY:\n{out[:4000]}\n\n"
            f"TOOLS USED: {', '.join(tools_used[:20]) or 'none'}"
        )
        res = await summarizer.run(
            body,
            model_settings=ModelSettings(timeout=Timeout(60, connect=15, read=60)),
        )
        text = str(getattr(res, "output", "") or "").strip()
        if not text or text.strip().upper() == "NONE":
            return False
        saved = 0
        notes = [n.strip() for n in text.splitlines() if n.strip().startswith("- ")]
        for note in notes:
            if saved >= _AUTO_MEMORY_MAX_NOTES:
                break
            note_text = note[2:].strip()
            if not note_text:
                continue
            try:
                remember(root, note_text)
                saved += 1
            except Exception:  # noqa: BLE001, S112 — one bad note shouldn't kill the batch
                continue
        return saved > 0
    except Exception:  # noqa: BLE001
        return False


def _load_skills(root: str) -> list[dict]:
    """Scan for skills and parse each SKILL.md's YAML frontmatter.

    Skills live in ``~/.coder/skills/<name>/SKILL.md`` (user-level, managed
    in-app and shared across all workspaces) plus, as a fallback, the
    workspace ``.claude/skills`` (Claude Code convention). The workspace
    ``.coder`` folder is reserved and never scanned. Each result is
    ``{"name", "description", "path", "content"}``; malformed files are
    skipped.
    """
    skills: list[dict] = []
    try:
        base_root = resolve_safe(root, "")
    except PathEscapeError:
        base_root = None

    scan_bases: list[tuple[str, str]] = [
        (os.path.join(user_coder_dir(), "skills"), "~/.coder/skills")
    ]
    if base_root is not None:
        scan_bases.append((os.path.join(base_root, ".claude", "skills"), ".claude/skills"))

    for dirpath, display_prefix in scan_bases:
        if not os.path.isdir(dirpath):
            continue
        try:
            entries = sorted(os.listdir(dirpath))
        except OSError:
            continue
        for entry in entries:
            skill_dir = os.path.join(dirpath, entry)
            if not os.path.isdir(skill_dir):
                continue
            md = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(md):
                continue
            try:
                text, _truncated = _read_text(md)
            except OSError:
                continue
            meta: dict[str, Any] = {}
            body = text
            if text.startswith("---"):
                end = text.find("\n---", 3)
                if end != -1:
                    try:
                        parsed = yaml.safe_load(text[3:end])
                        if isinstance(parsed, dict):
                            meta = parsed
                        body = text[end + 4 :].lstrip("\n")
                    except Exception:  # noqa: BLE001
                        meta = {}
            rel = os.path.relpath(md, os.path.expanduser("~")).replace(os.sep, "/")
            skills.append(
                {
                    "name": str(meta.get("name") or entry),
                    "description": str(meta.get("description") or "").strip(),
                    "path": f"~/{rel}" if rel.startswith(".coder/") else rel,
                    "content": body.strip(),
                }
            )
    return skills


def _skills_section(skills: list[dict]) -> str:
    """Index of available skills for the system prompt.

    Workspace skills are referenced by path so the model reads them on demand
    (keeps context small). User-level skills in ``~/.coder/skills`` cannot be
    reached through the project-sandboxed read tool, so their full content is
    inlined instead, which is fine since user skills are few and small.
    """
    if not skills:
        return ""
    lines = [
        "\n\n=== AVAILABLE SKILLS ===",
        (
            "These skills are available. If the user's request matches one, follow its "
            "instructions exactly. Content is given inline when the skill cannot be "
            "read from the workspace; otherwise read the SKILL.md file at the path shown."
        ),
    ]
    for s in skills:
        name = s["name"]
        desc = f" — {s['description']}" if s["description"] else ""
        if s["path"].startswith("~/.coder/skills"):
            body = s["content"]
            lines.append(f"- {name}{desc} (user skill):\n{body}")
        else:
            lines.append(f"- {name}: `{s['path']}`{desc}")
    return "\n".join(lines)


def _run_mcp_config(servers: dict) -> str | None:
    """Write a run-scoped MCP config containing ONLY ``servers`` (the ones the
    UI selected for this turn) and return its path, or ``None`` if there is
    nothing to load.

    This guarantees connectors the user did not pick for a message are never
    enumerated or spawned, avoiding errors from unwanted servers.
    """
    if not servers:
        return None
    try:
        fd, path = tempfile.mkstemp(prefix="coder-mcp-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": servers}, fh, ensure_ascii=False, indent=2)
        return path
    except OSError:
        return None


# Some stdio MCP servers (e.g. the Docker MCP Toolkit gateway) take several
# seconds to boot before they can answer the initialize handshake. pydantic-ai's
# default init_timeout is a tight 5s, which is too short for them — the client
# gives up with "Failed to initialize server session" although the server is
# fine. We load the config ourselves so we can pass a more generous timeout.
_MCP_INIT_TIMEOUT = 60.0  # seconds, for the connection + initialize handshake


def _load_mcp_toolsets(config_path: str) -> list[Any]:
    """Like ``pydantic_ai.mcp.load_mcp_toolsets`` but with a longer init timeout
    so slow-booting stdio servers actually connect.

    Accepts the same ``mcpServers`` JSON shape (``command``/``args``/``env``/
    ``cwd`` or ``url``/``headers``). Each server yields one prefixed toolset.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            config_data = json.load(fh)
    except (OSError, ValueError):
        return []

    servers = (config_data or {}).get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        return []

    toolsets: list[Any] = []
    for name, server in servers.items():
        try:
            if "command" in server:
                transport = StdioTransport(
                    command=server["command"],
                    args=list(server.get("args") or []),
                    env=server.get("env"),
                    cwd=str(server["cwd"]) if server.get("cwd") else None,
                )
                toolset = MCPToolset(transport, id=name, init_timeout=_MCP_INIT_TIMEOUT)
            elif "url" in server:
                toolset = MCPToolset(
                    server["url"],
                    id=name,
                    headers=server.get("headers"),
                    init_timeout=_MCP_INIT_TIMEOUT,
                )
            else:
                continue
            toolsets.append(PrefixedToolset(toolset, name))
        except Exception as exc:  # noqa: BLE001
            print(f"[coder] mcp toolset '{name}' skipped: {exc}", flush=True)
    return toolsets


def _write_mcp_config(root: str, servers: dict) -> str | None:
    """Persist the app's MCP connectors to ``~/.coder/mcp.json`` (the Claude
    Code ``mcpServers`` JSON shape) and return its path.

    Merges ``servers`` (the UI's connector list) over any connectors the agent
    already added to the file via the ``create_mcp`` tool, so agent-created
    connectors survive subsequent runs.

    Returns ``None`` when there is nothing to load or the file can't be written.
    """
    if not servers:
        return None
    try:
        path = os.path.join(user_coder_dir(), "mcp.json")
        merged: dict = {}
        try:
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as fh:
                    parsed = json.load(fh)
                if isinstance(parsed, dict) and isinstance(parsed.get("mcpServers"), dict):
                    merged = parsed["mcpServers"]
        except (OSError, ValueError):
            merged = {}
        merged.update(servers or {})
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": merged}, fh, ensure_ascii=False, indent=2)
        return path
    except OSError:
        return None


_MAX_ATTACHMENT_BYTES = 32_000  # per attached file; trimmed to save context


def _load_attachments(root: str, rels: list[str]) -> list[str]:
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
                + "\n...(attachment truncated to save context; use search_in_files for specific parts)"
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


def _load_images(paths: list[str] | None) -> list[str]:
    """Read image files (absolute paths, not copied) into base64 data URIs."""
    uris: list[str] = []
    for raw in paths or []:
        p = str(raw).strip()
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
        uris.append(f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")
    return uris


# Explicit per-turn mode declaration. The agent CANNOT reliably tell its own
# mode (every built-in prompt opens with "You are Coder…"), and after a mode
# switch the conversation history is full of the previous mode's replies, which
# makes it claim "nothing changed". Telling it the mode for THIS message (and
# that the user can switch it per message via the UI) fixes both the false
# refusal and the misreporting.
_MODE_LABELS = {"ask": "Ask", "plan": "Plan", "coder": "Coder"}
_MODE_CAPS = {
    "ask": "You are a read-only MENTOR: you guide and teach the user, and you NEVER write, edit or delete files or run commands.",
    "plan": "You are a read-only PLANNER: you produce the implementation plan and NEVER write, edit or delete files; your terminal is read-only.",
    "coder": "You have full write access: you can create/edit files and run commands.",
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
        "offering to switch to Coder mode to implement it."
    ),
    "coder": "",
}


def _mode_declare(mode: str) -> str:
    label = _MODE_LABELS.get(mode, (mode or "Ask").capitalize())
    caps = _MODE_CAPS.get(mode, "You can read files and use your tools as described above.")
    note = (
        "\n\n=== CURRENT MODE ===\n"
        f"You are in {label} mode for THIS message. {caps} "
        "The user can switch this chat's mode at any time with the mode button in the toolbar "
        "or ⌘M; each message runs in the mode that was selected when it was sent. You cannot "
        "change your own mode. If the user asks whether your mode changed or asks you to switch "
        f"modes, state the current mode (per this note — currently {label}) and tell them to use "
        "the mode button; their NEXT message then runs in the new mode. Never claim the mode is "
        "fixed for the whole conversation or that the mode button only affects new chats."
    )
    output = _MODE_OUTPUT.get(mode, "")
    if output:
        note += f"\nOUTPUT CONTRACT FOR THIS MODE: {output}"
    return note


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
    thinking_level: str = "",
    context_window: int = 0,
    env_var: str = "",
    mcp_servers: dict | None = None,
    skills_selected: list[str] | None = None,
    allow_create: bool = False,
    cap: dict | None = None,
    permission_gates: dict | None = None,
    ask_gates: dict | None = None,
    allow_outside: bool = False,
    nvim_file: str = "",
    nvim_diagnostics: list | None = None,
    max_history: int = 10,
) -> AsyncIterator[dict]:
    """Run the agent and yield SSE events (text deltas + tool activity)."""

    def _log_stream_error(
        exc: BaseException,
        *,
        phase: str,
        settings: Any = None,
    ) -> None:
        """Dump the real failure to the sidecar stderr so opaque provider
        errors (e.g. gateway 'output retries') never hide the trigger."""
        lines = [f"[codega:{phase}] {exc!r}"]
        lines.append(
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip()
        )
        lines.append(
            f"  provider={provider!r} model={model_name!r} base_url={base_url!r} "
            f"mode={mode!r} ctx={ctx}"
        )
        if settings is not None:
            try:
                lines.append(f"  settings={settings.model_dump()}")
            except Exception:  # noqa: BLE001
                lines.append(f"  settings={settings!r}")
        lines.append(
            f"  system_chars={len(system_final)} scout_chars={len(scouted)} "
            f"history_msgs={len(history)} tools={len(registered)} toolsets={0 if toolsets is None else len(toolsets)}"
        )
        print("\n".join(lines), flush=True)
    prompt = (prompt or "").strip()
    image_uris = _load_images(images)
    if not prompt and not image_uris:
        yield {"kind": "error", "content": "No prompt provided."}
        return

    model = build_model(provider, model_name, base_url, api_key, env_var)

    # Fall back to a conservative budget so tool outputs are always capped even
    # when the provider reports no context window.
    try:
        ctx = int(context_window or 0)
    except (TypeError, ValueError):
        ctx = 0
    # When the caller didn't supply a window, resolve the model's REAL context
    # from the provider (never a hard-coded value) so a 200k-capable model is
    # never treated as small and tool-output budgets scale correctly.
    if ctx <= 0:
        try:
            ctx = await model_context(
                provider, model_name, base_url, api_key, env_var
            )
        except Exception:  # noqa: BLE001
            ctx = 0
    if ctx <= 0:
        ctx = DEFAULT_CONTEXT_WINDOW_FLOOR

    queue: asyncio.Queue = asyncio.Queue()

    # Live per-request usage → the queue. `UsageCapability.after_model_request`
    # runs for every model request (each tool-loop step), forwarding that
    # request's provider-reported token usage so the UI context meter tracks the
    # REAL running count (no estimation) and so a near-overflow can be compacted
    # before it actually dies.
    early_usage_state = {"hit": False, "last": 0}
    _usage_cap = _UsageCapability(
        on_usage=lambda usage: (
            usage.update({"kind": "usage"}),
            queue.put_nowait(dict(usage)),
        )[1],
        context_limit=ctx,
        state=early_usage_state,
    )

    tools = make_tool_callbacks(
        root,
        lambda ev: queue.put_nowait(_tool_event(ev)),
        context_window=ctx,
        summarizer_model=model,
        permission_gates=permission_gates,
        ask_gates=ask_gates,
        permit={"outside": allow_outside},
    )
    # Tool access is data-driven by per-mode capabilities (cap), so custom modes
    # added in the UI work without backend changes. Missing/flat cap falls back to
    # the legacy hardcoded behavior keyed on the mode name.
    cap = cap or {}
    has_cap = any(
        isinstance(cap.get(k), bool)
        for k in ("readFiles", "writeFiles", "runTerminal", "web")
    )
    if has_cap:
        _READ = {"list_files", "search_in_files", "fuzzy_find", "explore"}
        _WRITE = {"write_file", "edit_file", "confirm_action"}
        _TERM = {"run_terminal"}
        _WEB = {"web_search", "fetch_url"}
        denied: set[str] = set()
        if not cap.get("readFiles", False):
            denied |= _READ
        if not cap.get("writeFiles", False):
            denied |= _WRITE
        if not cap.get("runTerminal", False):
            denied |= _TERM
        if not cap.get("web", False):
            denied |= _WEB
        tools = {name: fn for name, fn in tools.items() if name not in denied}
        # Plan-style modes keep the terminal but only in read-only form.
        if cap.get("runTerminal") and not cap.get("writeFiles"):
            tools["run_terminal"] = _wrap_readonly_terminal(tools["run_terminal"])
    else:
        # Legacy fallback: write/edit/terminal only in coder mode.
        if mode != "coder":
            tools = {
                name: fn
                for name, fn in tools.items()
                if name not in ("write_file", "edit_file", "run_terminal", "confirm_action")
            }
    # `save_plan` is the ONE write capability plan mode gets despite otherwise
    # being fully read-only (writeFiles=False / mode != "coder") — it writes to
    # ~/.coder/plans/, never into the workspace, so it doesn't need the general
    # writeFiles capability. It's not a general-purpose tool: strip it for every
    # mode except plan so ask/coder never see it in their tool list.
    if mode != "plan":
        tools.pop("save_plan", None)
    # Skill / MCP connectors can ONLY be created when the user explicitly uses
    # the /skill or /mcp command. Without allow_create the tools are stripped so
    # the agent can never create them autonomously.
    if not allow_create:
        tools = {
            name: fn
            for name, fn in tools.items()
            if name not in ("create_skill", "create_mcp")
        }
    # When the user explicitly scoped the request to specific files (attached /
    # mentioned files or the open Neovim file), the agent must work ONLY with
    # those files: workspace-wide discovery tools are removed and search_in_files
    # is restricted to the in-scope paths.
    scoped_paths = _scoped_rels(root, attachments, nvim_file)
    scoped = bool(scoped_paths)
    if scoped:
        # `explore` spawns a sub-agent with its own list_files/search_in_files
        # over the WHOLE workspace, so it must be removed too — otherwise the
        # agent can scan the project despite the scope.
        tools = {
            name: fn
            for name, fn in tools.items()
            if name not in ("list_files", "fuzzy_find", "explore")
        }
        if "search_in_files" in tools:
            tools["search_in_files"] = _wrap_scoped_search(
                tools["search_in_files"], scoped_paths
            )
        # The read-only terminal (ask/plan) can still leak file names/contents
        # outside the scope via cat/find/rg/ls/git. Restrict it to explicit
        # paths inside the scope. Coder's writable terminal is left alone.
        if "run_terminal" in tools and has_cap and cap.get("runTerminal") and not cap.get("writeFiles"):
            tools["run_terminal"] = _wrap_scoped_terminal(
                tools["run_terminal"], root, scoped_paths
            )
    registered = [Tool(fn, name=name) for name, fn in tools.items()]

    # MCP tool connectors: the UI's connector list is persisted to
    # ~/.coder/mcp.json and loaded into prefixed toolsets. Connection is
    # deferred, so a dead/broken server only surfaces if the model actually
    # calls one of its tools (that call fails gracefully), never at startup.
    # Only the servers the frontend sent for THIS turn are loaded — unselected
    # connectors (e.g. a docker MCP you aren't using right now) stay out.
    toolsets: list[Any] | None = None
    mcp_path = _write_mcp_config(root, mcp_servers or {})
    if mcp_path:
        try:
            # Build a run-scoped config with exactly the requested servers so
            # unselected connectors are never spawned or enumerated.
            filtered_path = _run_mcp_config(mcp_servers or {})
            if filtered_path:
                toolsets = _load_mcp_toolsets(filtered_path)
        except Exception as exc:  # noqa: BLE001
            print(f"[coder] mcp config ignored: {exc}", flush=True)
            toolsets = None

    workspace_note = (
        "\n\nYou are running in the user's desktop IDE. The current open WORKSPACE ROOT is:\n"
        f"{root}"
        "\nUse paths RELATIVE to this folder (e.g. 'src/main.py'), never absolute paths. "
        "When the user says 'list files', 'show the project', or just 'ls', call list_files with no path to list the workspace root rather than asking for a path. The file tools are sandboxed to this root; any path outside it will be rejected."
        "\nYou operate ONLY inside this workspace. NEVER read, search or act on anything outside it "
        "(e.g. ~/.config, ~/.cursor, /Users/... or any absolute path not under this root). The ONLY "
        "exception is reading the user-level `~/.coder` config dir (skills, plans, MCP config) — those "
        "reads are always allowed without permission; identify them with paths like `~/.coder/skills/...`. "
        "If a task "
        "genuinely needs access outside the workspace, call request_permission FIRST and wait for the "
        "result; only proceed with that outside action if it returns PERMISSION GRANTED — otherwise do "
        "not touch it and tell the user what you needed and why."
    )

    # Auto-mention the file currently open in Neovim (if any, and only when it
    # lives inside the workspace root). The agent is told the path but NOT the
    # full content — it inspects the relevant parts itself via search_in_files,
    # keeping context use low. 'This file' / 'current file' in the user's message
    # refers to this one. Modes with write access should edit it when targeted.
    nvim_rel = ""
    nvim_raw = str(nvim_file or "").strip()
    if nvim_raw:
        try:
            nvim_target = resolve_safe(root, nvim_raw)
        except PathEscapeError:
            nvim_target = ""
        if nvim_target and os.path.isfile(nvim_target):
            nvim_rel = os.path.relpath(nvim_target, resolve_safe(root, ""))
    if nvim_rel:
        workspace_note += (
            f"\n\n=== NEOVIM (OPEN EDITOR) ===\n"
            f"The user currently has `{nvim_rel}` open in Neovim — this file is their ACTIVE FOCUS. "
            "If they say 'this file', 'the current file', or 'the file I'm working on', they mean this "
            "one. The file's full content is NOT loaded into your context: use search_in_files (with a "
            "small `context`) to inspect the relevant parts. In modes with write access, "
            "when the request targets this file, edit it directly."
        )
        diag_note = _nvim_diagnostics_note(nvim_diagnostics)
        if diag_note:
            workspace_note += "\n\n" + diag_note

    attached = _load_attachments(root, attachments)
    if attached:
        workspace_note += (
            "\n\nThe user attached files and their full contents appear at the START of the user's "
            "latest message (after the ==== ATTACHED FILE ==== markers). Read them — they are the "
            "primary focus of the request. If the user references one with an @mention, the @ is "
            "just a marker — use the plain relative path in any tool call."
        )

    if scoped:
        workspace_note += (
            "\n\n=== SCOPE (ONLY THESE FILES) ===\n"
            "The user explicitly scoped this request to ONLY these files: "
            + ", ".join("`" + f + "`" for f in sorted(scoped_paths))
            + ". "
            "You MUST work ONLY with these files — do NOT list, search, fuzzy-find, or inspect any other "
            "file in the workspace; the rest of the project is off-limits for this request. The workspace-wide "
            "discovery tools (list_files, fuzzy_find, explore) are UNAVAILABLE this request. To inspect a "
            "scoped file, call search_in_files with its exact path; in read-only modes the terminal is also "
            "restricted to explicit paths inside this scope. Attached files are already fully loaded at the top "
            "of the user's message."
        )

    # The built-in mode prompt is ALWAYS the base. A user-supplied custom
    # system prompt (from Settings → Prompts) is APPENDED on top rather than
    # replacing the defaults, so the built-in instructions always stay active.
    base_prompt = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["ask"])
    system_final = base_prompt + _mode_declare(mode) + workspace_note
    extra = (system_prompt or "").strip()
    if extra:
        system_final += "\n\nUser-supplied custom prompt (append to the above):\n" + extra

    # Persistent per-project instructions (AGENTS.md), if the project has one.
    # Always included in full (up to a cap) regardless of context budget —
    # see _load_project_memory for why this isn't subject to the scouting budget.
    try:
        project_memory = _load_project_memory(root)
    except Exception:  # noqa: BLE001
        project_memory = ""
    if project_memory:
        system_final += project_memory

    try:
        learned_memory = _load_learned_memory(root)
    except Exception:  # noqa: BLE001
        learned_memory = ""
    if learned_memory:
        system_final += learned_memory

    skills = _load_skills(root)
    if skills_selected is not None:
        wanted = {str(n).strip().lower() for n in skills_selected if str(n).strip()}
        skills = [s for s in skills if s["name"].strip().lower() in wanted]
    if skills:
        system_final += _skills_section(skills)

    agent_settings = _settings_for(mode, ctx, thinking_level, provider, model_name)
    agent = Agent(
        model,
        system_prompt=system_final,
        model_settings=agent_settings,
        tools=registered,
        toolsets=toolsets,
        capabilities=[_usage_cap],
        # Cheap models (free tiers) occasionally return an EMPTY response (no
        # text, no tool call) which pydantic-ai counts against its output-retry
        # budget. The default budget is 1, so a single blip instantly dies with
        # "Exceeded maximum output retries (1)". Raising it lets the run retry
        # the generation a few times and almost always still answer.
        retries={"tools": 3, "output": 3},
    )

    user_content: list[Any] = []
    # Attach full file contents at the FRONT of the user turn so the model is
    # guaranteed to see them (weak models ignore long buried system prompts).
    if attached:
        user_content.append(
            "===== START OF ATTACHED FILES =====\n"
            + "\n\n".join(attached)
            + "\n===== END OF ATTACHED FILES =====\n"
        )

    # Auto-scout the workspace so the model always has project context even if
    # it never calls the file tools. Skipped when the user already attached most
    # of the project's entries, or when the request is clearly not about the
    # project (a general/external question like "is X.com free?", greetings, or
    # a web/MCP lookup) — no point scattering the listing into those turns. The
    # budget scales with the model's context window so small models (e.g. 8k)
    # get a tiny scouting budget that can't overflow the window. Ask (mentor)
    # keeps the fixed small budget instead of the scaled one — its prompt tells
    # it to inspect only the relevant files via search_in_files, so a large
    # auto-scouted dossier per question just burns tokens.
    scout_budget = _AUTO_SCOUT_MAX_TOTAL
    if ctx > 0 and mode != "ask":
        scout_budget = max(0, min((ctx // 4) - 600, _AUTO_SCOUT_MAX_TOTAL * 6))
    scouted = ""
    if not scoped:
        try:
            scouted = (
                _scout_workspace(root, max_total=scout_budget)
                if _needs_workspace(prompt)
                else ""
            )
        except Exception:  # noqa: BLE001
            scouted = ""
    if scouted:
        user_content.append(scouted)

    # Keep the history small enough that the model's context window still has
    # room for the system prompt, scouting, tool-loop re-sends and the reply.
    # Without this, an 8k model overflows and gets truncated mid-task.
    history = _fit_history(history, _history_budget(ctx, system_final, scouted, mode))
    history_messages = _to_model_messages(history)

    if prompt:
        user_content.append(prompt)
    user_content += [ImageUrl(url=uri) for uri in image_uris]

    # Retry loop: a transient failure (429 / 5xx / connection blip) on the
    # model call is retried with backoff, but ONLY while nothing has been
    # yielded to the client yet for this attempt — once any text or tool
    # activity has streamed out (which may mean a tool already ran, e.g. a
    # write), retrying from scratch could duplicate side effects, so at that
    # point a failure is surfaced as-is instead.
    attempt = 0
    auto_compacted = False
    scout_dropped = False
    tools_dropped = False
    images_dropped = False
    # Deterministic tool-loop budget. Mutable: widened on retries so a turn that
    # legitimately needs many tool calls isn't killed by the counter — see the
    # `_HighWatermark` branch in the except handler below.
    tool_steps_cap = _tool_steps_compact_at(ctx)
    # How many times the widen-and-retry branch has fired. Capped so a task
    # that genuinely never converges (keeps re-triggering the step budget no
    # matter how high it's raised) fails loudly after a bounded amount of work
    # instead of looping — and re-sending the whole growing transcript —
    # indefinitely.
    high_watermark_retries = 0
    # Compact record of the tool work performed across ALL attempts of this
    # turn. When the deterministic step budget fires the widen-and-retry branch,
    # this log is fed back into the retried run (as a system note) so the model
    # continues where it left off instead of re-exploring the whole workspace
    # from scratch. Reset per turn — a fresh prompt must not inherit stale
    # tool results from a previous turn.
    turn_tool_log: list[str] = []
    while True:
        attempt += 1
        # Reset the pre-emptive compact watermark per attempt: it is set by the
        # `_UsageCapability` when a request's input crosses the threshold, and is
        # only meaningful within the CURRENT model request. Without this reset a
        # compacted retry would instantly re-trigger on its first usage event.
        early_usage_state["hit"] = False
        activity_happened = False
        tool_steps_turn = 0
        # A mutating tool (write/edit/terminal) that already ran this attempt.
        # Once such a side effect lands, re-running the attempt from scratch
        # could duplicate it, so we refuse to auto-compact+retry AND refuse to
        # backoff-and-retry (mirroring the historical `activity_happened` guard).
        # Read-only tool calls / streamed text do NOT block auto-compact —
        # otherwise a model that lists/reads files and then overflows on the
        # very next model request would never auto-compact.
        mutating_ran = False
        # Fresh queue each attempt: `tools`' emit callback closes over the
        # `queue` name (late-bound), so reassigning it here is picked up by
        # tool calls in this attempt without rebuilding the tools/agent. This
        # also discards any stale sentinel left behind by a failed attempt.
        queue = asyncio.Queue()
        try:
            # run_stream_events runs the agent graph in a background task and
            # forwards every event (model text/thinking deltas AND tool
            # calls/results) over a live stream. Unlike `run_stream` — whose
            # `__aenter__` executes the ENTIRE graph (all tool calls) before
            # returning — this surfaces tool activity as it happens, so the
            # UI can render a tool card the moment the model invokes it.
            async with agent.run_stream_events(
                user_content,
                message_history=history_messages,
            ) as events:
                # Producer task: forwards the model's streaming text/thinking
                # deltas into the queue. Tool activity is pushed into the SAME
                # queue by the tool `emit` callback (see make_tool_callbacks).
                # The consumer loop below drains the queue independently of the
                # event stream, so tool events surface in the UI as soon as a
                # tool runs — even while the model is still generating.
                async def producer() -> None:
                    try:
                        async for event in events:
                            # The FIRST chunk of a part arrives as a
                            # `PartStartEvent` carrying the initial content, not
                            # as a delta. Ignoring it silently dropped the
                            # opening word of every response (and of every
                            # retry/compact re-stream), gluing the tail of the
                            # previous chunk to the next one.
                            if isinstance(event, PartStartEvent):
                                if isinstance(event.part, TextPart) and event.part.content:
                                    await queue.put(_event_delta(event.part.content))  # noqa: B023 — see producer note
                                elif isinstance(event.part, ThinkingPart) and event.part.content:
                                    await queue.put(  # noqa: B023 — see producer note
                                        {"kind": "thinking", "content": event.part.content}
                                    )
                            if isinstance(event, PartDeltaEvent):
                                delta = event.delta
                                if isinstance(delta, TextPartDelta):
                                    chunk = delta.content_delta
                                    if chunk:
                                        await queue.put(_event_delta(chunk))  # noqa: B023 — `queue` intentionally late-bound per attempt
                                elif isinstance(delta, ThinkingPartDelta):
                                    chunk = delta.content_delta
                                    if chunk:
                                        await queue.put(  # noqa: B023 — see producer note
                                            {"kind": "thinking", "content": chunk}
                                        )
                            elif isinstance(event, AgentRunResultEvent):
                                usage = _usage_event(event.result.usage)
                                if usage:
                                    await queue.put(usage)  # noqa: B023 — see producer note
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001
                        # Re-raise into the consumer so the server can surface
                        # it as an SSE error instead of a silent cut. Don't log
                        # here — the SAME exception is logged once, with full
                        # context, at its final resolution point below (either
                        # "fatal" when retries are exhausted, or not at all if a
                        # retry recovers). Logging on every intermediate hop
                        # (producer -> consumer -> fatal) tripled the traceback
                        # spam in the sidecar log for a single failure.
                        await queue.put({"kind": "_raise", "error": exc})  # noqa: B023 — see producer note
                    finally:
                        await queue.put(None)  # noqa: B023 — see producer note

                producer_task = asyncio.create_task(producer())

                error: BaseException | None = None
                reply_chunks: list[str] = []
                tools_used: list[str] = []
                try:
                    while True:
                        item = await queue.get()
                        if item is None:
                            break
                        if item.get("kind") == "_raise":
                            # See the note in `producer` above: intentionally not
                            # logged here, to avoid duplicate traceback dumps.
                            error = item["error"]
                            break
                        # Track side-effecting tool calls so a later context
                        # overflow on a subsequent request doesn't trigger an
                        # unsafe full re-run that duplicates the write.
                        # A terminal command counts as mutating ONLY if it can
                        # actually change state — read-only commands (ls, find,
                        # git status, build/test/lint) are safe to re-run after a
                        # compact. Treating every terminal call as mutating made
                        # auto-compact dead on any inspection-heavy turn.
                        if item.get("kind") == "tool" and item.get("tool") in (
                            "write_file",
                            "edit_file",
                        ) or (
                            item.get("kind") == "tool"
                            and item.get("tool") == "run_terminal"
                            and not _readonly_allowed(
                                str((item.get("args") or {}).get("command", ""))
                            )
                        ):
                            mutating_ran = True
                        if item.get("kind") == "tool" and item.get("tool"):
                            tools_used.append(str(item["tool"]))
                            # Steps inside an `explore` sub-agent run (tagged
                            # `sub=True`, see tools.py) do NOT count against this
                            # turn's deterministic step budget: they never enter
                            # OUR resent transcript, only the sub-agent's own
                            # (bounded separately, and discarded once it returns
                            # its report) — so they carry none of the resend-cost
                            # risk `tool_steps_cap` exists to guard against.
                            if not item.get("sub"):
                                tool_steps_turn += 1
                            # Record the tool call so the step-budget retry can
                            # resume with memory instead of re-exploring (see the
                            # `_HighWatermark` widen branch). Keep it trimmed.
                            turn_tool_log.append(
                                f"- {item['tool']}("
                                f"{_trim_log_text(_fmt_log_args(item.get('args')))}"
                                f")"
                            )
                        elif (
                            item.get("kind") == "tool_result"
                            and item.get("tool")
                        ):
                            turn_tool_log.append(
                                f"- {item.get('tool')} result: "
                                f"{_trim_log_text(item.get('summary'))}"
                            )
                        if item.get("kind") == "text" and item.get("content"):
                            reply_chunks.append(str(item["content"]))
                        activity_happened = True
                        yield item
                        # Pre-emptive auto-compact: if the provider just reported
                        # a request whose input already fills too much of the
                        # window, stop the loop here and re-send from compacted
                        # history BEFORE the next request dies with an overflow.
                        if (
                            early_usage_state["hit"]
                            and early_usage_state.get("last")
                            and item.get("kind") == "usage"
                        ):
                            tok = early_usage_state["last"]
                            raise _HighWatermark(tok, ctx)
                        # Deterministic safety net (independent of provider usage
                        # reporting): a turn that runs too many tool steps re-sends
                        # the whole accumulated context each time, so cap the loop
                        # and compact before the next request can overflow. The cap
                        # scales with the context window (see _tool_steps_compact_at)
                        # and reports the REAL measured usage — never a fabricated
                        # fraction of the window — so the UI message stays honest.
                        if tool_steps_turn >= tool_steps_cap:
                            real = early_usage_state.get("last") or 0
                            raise _HighWatermark(
                                real if real > 0 else int(
                                    ctx * _preemptive_compact_fraction(ctx)
                                ),
                                ctx,
                                note=(
                                    f"Reached tool-loop step budget ({tool_steps_cap} steps) — "
                                    "compacting earlier turns and continuing…"
                                ),
                            )
                finally:
                    # Cancel the producer AND await it so its task (and the
                    # underlying model-event stream / pydantic-ai wrap_run task
                    # it iterates) fully unwinds. Without the await, the tasks
                    # are left pending on client disconnect (abort) and get
                    # garbage-collected, spamming "Task was destroyed but it is
                    # pending!".
                    producer_task.cancel()
                    try:
                        await producer_task
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001, S110
                        pass

                if error is not None:
                    raise error

                _reply = "".join(reply_chunks)
                if _needs_workspace(prompt):
                    # Hermes-style: silently distill durable facts into memory.
                    # Best-effort + never raises; runs only for substantive turns.
                    try:
                        await _maybe_auto_memory(
                            model, root, prompt, _reply, tools_used
                        )
                    except Exception:  # noqa: BLE001, S110 — best-effort, never raises
                        pass
                # Guarantee the finished plan lands in ~/.coder/plans/ even if the
                # plan agent never called the save_plan tool (e.g. its run hit the
                # tool-loop step budget and got compacted mid-scout). Only a reply
                # that actually delivered a plan ('## Plan' opener) is saved, so a
                # truncated run can't overwrite a good plan with partial notes.
                if mode == "plan" and _reply.strip().startswith("## Plan"):
                    try:
                        workspace_slug = (
                            slugify(os.path.basename(os.path.realpath(root).rstrip(os.sep)))
                            or "workspace"
                        )
                        plans_dir = os.path.join(
                            user_coder_dir(), "plans", workspace_slug
                        )
                        os.makedirs(plans_dir, exist_ok=True)
                        with open(
                            os.path.join(plans_dir, "plan.md"),
                            "w",
                            encoding="utf-8",
                        ) as fh:
                            fh.write(_reply)
                    except OSError:  # noqa: S110 — best-effort, never raises
                        pass
            break  # success, exit the retry loop
        except Exception as exc:
            # Auto-compact: the request itself overflowed the model's context
            # window (not a transient blip). Shrink the body of the turn (history
            # first, then the auto-scout) and retry so the task can actually
            # finish. Only safe while no mutating tool has run (no side effects
            # to duplicate). Read-only tool calls / streamed text do NOT block
            # this — otherwise a model that lists/reads files and then overflows
            # on the very next request would never auto-compact.
            if (
                not mutating_ran
                and len(history) > 0
                and (_is_context_overflow(exc) or isinstance(exc, _HighWatermark))
                and (not auto_compacted or (scouted and not scout_dropped))
            ):
                auto_compacted = True
                # Report the real token count parsed from the overflow error so
                overflow_tokens = _overflow_tokens(exc) if _is_context_overflow(exc) else None
                if overflow_tokens:
                    yield {
                        "kind": "usage",
                        "input_tokens": overflow_tokens,
                        "output_tokens": 0,
                        "total_tokens": overflow_tokens,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                    }
                if isinstance(exc, _HighWatermark):
                    content = exc.note or (
                        f"Context nearly full ({exc.tokens} of {exc.limit} tokens) — "
                        "compacting earlier turns and continuing…"
                    )
                else:
                    content = "Context window was full — compacting earlier turns and continuing…"
                yield {"kind": "compact", "content": content}
                compacted = await _compact_history(model, history, max_history=max_history)
                # Compaction alone may not free enough room on a small window
                # (the retried request re-sends the whole turn). If there's no
                # history left to compress, drop the current turn's auto-scout
                # so the retry can actually fit.
                if compacted is None and scouted and not scout_dropped:
                    scout_dropped = True
                    user_content = [
                        c for c in user_content if not (isinstance(c, str) and c == scouted)
                    ]
                    yield {"kind": "retry", "attempt": attempt, "max_attempts": _RETRIES, "delay": 0, "reason": "overflowed — dropped auto-scout"}
                    continue
                if compacted is not None:
                    history = compacted
                    history_messages = _to_model_messages(history)
                    yield {"kind": "retry", "attempt": attempt, "max_attempts": _RETRIES, "delay": 0, "reason": "auto-compacted context"}
                    continue
            # A second tool-loop step-budget hit after we already compacted is NOT
            # a real near-overflow (the request is still well under the window) —
            # it just means the task legitimately needs more tool calls than the
            # budget allows. Instead of surfacing a fatal error (which previously
            # killed the whole turn the moment a compacted retry ran 24+ steps
            # again), widen the budget and retry so the work can actually finish.
            #
            # This also covers the FIRST hit when there is no prior chat history to
            # compact at all (a fresh chat's first turn: `history` is empty, so the
            # compact branch above never runs and `auto_compacted` never flips to
            # True). Before this fix, a long first-turn tool loop (e.g. a Plan-mode
            # investigation that runs many searches) had nothing to compact, fell
            # through every branch below, and died as a raw "fatal" error the
            # moment it hit the step cap — exactly the case where widening the cap
            # and continuing is the right move, since there's no history bloat to
            # blame in the first place.
            #
            # CRITICAL: each retry restarts `run_stream_events` from the CURRENT
            # `history_messages` — which do NOT include the tool calls just made
            # (they only live in `turn_tool_log`, capped separately). A blind retry
            # would re-explore the whole workspace from scratch and re-blow the
            # budget, doubling waste until the cap is exhausted. To fix that, feed
            # the work done so far back in as a system note so the model continues
            # where it left off. Retries are also bounded tighter (3 instead of 6)
            # and the cap amplifier is smaller (300 instead of 500) so even a task
            # that never converges fails loudly after a bounded amount of work.
            if (
                isinstance(exc, _HighWatermark)
                and exc.note is not None
                and not mutating_ran
                and (auto_compacted or len(history) == 0)
                and high_watermark_retries < 3
            ):
                high_watermark_retries += 1
                tool_steps_cap = min(int(tool_steps_cap * 2), 300)
                if turn_tool_log:
                    # Only the tail matters and must stay small so the resume note
                    # itself can't overflow the window. Cap the note words.
                    tail = turn_tool_log[-40:]
                    omitted = len(turn_tool_log) - len(tail)
                    resume_lines = "\n".join(tail)
                    if omitted > 0:
                        resume_lines += f"\n({omitted} earlier steps omitted)"
                    resume_note = (
                        "Tool work already done so far in THIS turn — do NOT repeat "
                        "or re-do any of it; continue from where you stopped:\n"
                        f"{resume_lines}"
                    )
                    history_messages = history_messages + [
                        ModelRequest(parts=[SystemPromptPart(content=resume_note)])
                    ]
                yield {
                    "kind": "retry",
                    "attempt": attempt,
                    "max_attempts": _RETRIES,
                    "delay": 0,
                    "reason": (
                        f"tool-loop step budget raised to {tool_steps_cap}"
                        + (", resuming from previous tool results" if turn_tool_log else "")
                    ),
                }
                continue
            empty_reply = _is_empty_output_error(exc)
            # A 400 rejecting `image_url` content is a deterministic schema
            # mismatch with the model backend (e.g. a non-vision free model),
            # not a transient blip. Retrying the identical image-carrying body
            # will fail identically, so strip the image parts and retry once.
            image_rejected = _is_image_rejection(exc)
            if (
                image_rejected
                and not images_dropped
                and not activity_happened
                and image_uris
            ):
                images_dropped = True
                user_content = [c for c in user_content if not isinstance(c, ImageUrl)]
                yield {
                    "kind": "retry",
                    "attempt": attempt,
                    "max_attempts": _RETRIES,
                    "delay": 0,
                    "reason": "provider rejected image — retrying without attachments",
                }
                continue
            if empty_reply and not tools_dropped and not activity_happened:
                # Free/weak models sometimes respond with NO parts at all (no
                # text, no tool call). Retrying the same shape won't help — drop
                # the tool set so the model only has to produce plain text.
                tools_dropped = True
                agent = Agent(
                    model,
                    system_prompt=system_final,
                    model_settings=agent_settings,
                    capabilities=[_usage_cap],
                    retries={"tools": 3, "output": 3},
                )
                yield {
                    "kind": "retry",
                    "attempt": attempt,
                    "max_attempts": _RETRIES,
                    "delay": 0,
                    "reason": "empty reply — retrying without tools",
                }
                continue
            if (
                activity_happened
                or attempt > _RETRIES
                or not _is_retryable(exc)
                or _is_quota_exhausted(exc)
            ):
                _log_stream_error(exc, phase="fatal", settings=agent_settings)
                raise
            delay = _RETRY_BASE_SECONDS * (2 ** (attempt - 1))
            yield {
                "kind": "retry",
                "attempt": attempt,
                "max_attempts": _RETRIES,
                "delay": delay,
                "reason": str(exc)[:200],
            }
            await asyncio.sleep(delay)
            continue
