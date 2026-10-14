"""Lazy per-language LSP client manager (opencode-style).

Replaces the static code-map index with on-demand language servers: a
server process starts only when the agent first asks about a file of that
language, then stays cached per workspace root. All requests are stdio
JSON-RPC with a timeout bound, and server binaries resolve through PATH
(no hard-coded install locations).
"""

from __future__ import annotations

import atexit
import itertools
import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.parse
from typing import Any, Callable

logger = logging.getLogger("codifa.lsp")

# Default bound for any single LSP request (seconds).
LSP_TIMEOUT = 5.0

# Dedicated bound for the initialize handshake (slow servers need more).
_LSP_INIT_TIMEOUT = 25.0

# How long diagnostics waits for fresh publishDiagnostics after a sync.
_LSP_DIAG_WAIT = 2.0

# Failed server starts are not retried for a few minutes.
_LSP_START_FAIL_TTL = 300.0

# Idle servers are evicted after ~10 minutes.
_LSP_IDLE_TIMEOUT = 600.0

# Cap on simultaneously open (synced) files per manager.
_LSP_MAX_OPEN_FILES = 30

# Cap on file bytes sent in textDocument/didOpen.
_LSP_MAX_BYTES = 1_000_000

# Deterministic result cache: identical calls reuse results (no round-trip,
# no extra tokens). TTL keeps stale file signatures from serving forever.
_LSP_RESULT_TTL = 300.0
_LSP_RESULT_CACHE_MAX = 512
# Background update throttle (at most once a week per language). Stamps are
# persisted in the user data root so an app restart does not re-run updates.
_UPDATE_INTERVAL = 7 * 24 * 3600.0
_UPDATE_STAMPS: dict[str, float] = {}
_UPDATE_STAMPS_LOADED = False

# Registry: language -> server command (opencode-style built-ins).
# Bare binary names only; resolved through PATH via shutil.which so no
# install path is hard-coded. Users can override per language via lsp
# config (disabled/command/extensions/env/initialization) or add custom
# servers not listed here.
LANGUAGE_SERVERS: dict[str, list[str]] = {
    "python": ["pylsp"],
    "typescript": ["typescript-language-server", "--stdio"],
    "javascript": ["typescript-language-server", "--stdio"],
    "astro": ["astro-ls", "--stdio"],
    "bash": ["bash-language-server", "start"],
    "c": ["clangd"],
    "cpp": ["clangd"],
    "csharp": ["csharp-ls"],
    "css": ["vscode-css-language-server", "--stdio"],
    "dart": ["dart", "language-server"],
    "elixir": ["elixir-ls"],
    "elm": ["elm-language-server"],
    "erlang": ["erlang_ls"],
    "go": ["gopls"],
    "haskell": ["haskell-language-server-wrapper", "--lsp"],
    "html": ["vscode-html-language-server", "--stdio"],
    "java": ["jdtls"],
    "json": ["vscode-json-language-server", "--stdio"],
    "kotlin": ["kotlin-language-server"],
    "lua": ["lua-language-server"],
    "markdown": ["marksman"],
    "nix": ["nil"],
    "ocaml": ["ocamllsp"],
    "php": ["intelephense", "--stdio"],
    "ruby": ["solargraph", "stdio"],
    "rust": ["rust-analyzer"],
    "scala": ["metals"],
    "svelte": ["svelteserver", "--stdio"],
    "swift": ["sourcekit-lsp"],
    "terraform": ["terraform-ls", "serve"],
    "toml": ["taplo", "lsp", "stdio"],
    "vue": ["vue-language-server", "--stdio"],
    "yaml": ["yaml-language-server", "--stdio"],
    "zig": ["zls"],
    "tailwind": ["tailwindcss-language-server", "--stdio"],
    "eslint": ["vscode-eslint-language-server", "--stdio"],
}

# File suffix -> registry language.
SUFFIX_TO_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".astro": "astro",
    ".sh": "bash",
    ".bash": "bash",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".scss": "css",
    ".less": "css",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
    ".elm": "elm",
    ".erl": "erlang",
    ".hrl": "erlang",
    ".go": "go",
    ".hs": "haskell",
    ".html": "html",
    ".htm": "html",
    ".java": "java",
    ".json": "json",
    ".jsonc": "json",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".lua": "lua",
    ".md": "markdown",
    ".markdown": "markdown",
    ".nix": "nix",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".rb": "ruby",
    ".php": "php",
    ".rs": "rust",
    ".scala": "scala",
    ".sbt": "scala",
    ".svelte": "svelte",
    ".swift": "swift",
    ".tf": "terraform",
    ".tfvars": "terraform",
    ".toml": "toml",
    ".vue": "vue",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zig": "zig",
}

# LSP languageId sent in textDocument/didOpen. Registry languages are
# coarse (typescript covers .ts and .tsx) but servers expect the exact
# VSCode language identifiers per suffix, otherwise requests like
# documentSymbol may stay empty.
_SUFFIX_TO_LANGUAGE_ID: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".astro": "astro",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
    ".elm": "elm",
    ".erl": "erlang",
    ".hrl": "erlang",
    ".go": "go",
    ".hs": "haskell",
    ".html": "html",
    ".htm": "html",
    ".java": "java",
    ".json": "json",
    ".jsonc": "jsonc",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".lua": "lua",
    ".md": "markdown",
    ".markdown": "markdown",
    ".nix": "nix",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".rb": "ruby",
    ".php": "php",
    ".rs": "rust",
    ".scala": "scala",
    ".sbt": "scala",
    ".svelte": "svelte",
    ".swift": "swift",
    ".tf": "terraform",
    ".tfvars": "terraform-vars",
    ".toml": "toml",
    ".vue": "vue",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zig": "zig",
}

# Install hints shown when a server binary is missing (also used as
# fallback text when no safe auto-install command exists).
INSTALL_HINTS: dict[str, str] = {
    "python": "pip install python-lsp-server",
    "typescript": "npm i -g typescript-language-server typescript",
    "javascript": "npm i -g typescript-language-server typescript",
    "astro": "npm i -g astro-language-server",
    "bash": "npm i -g bash-language-server",
    "c": "install clangd (llvm)",
    "cpp": "install clangd (llvm)",
    "csharp": "dotnet tool install -g csharp-ls",
    "css": "npm i -g vscode-langservers-extracted",
    "dart": "install dart SDK",
    "elixir": "install elixir-ls",
    "elm": "npm i -g elm-language-server",
    "erlang": "install erlang_ls",
    "go": "go install golang.org/x/tools/gopls@latest",
    "haskell": "install haskell-language-server",
    "html": "npm i -g vscode-langservers-extracted",
    "java": "install jdtls",
    "json": "npm i -g vscode-langservers-extracted",
    "kotlin": "install kotlin-language-server",
    "lua": "install lua-language-server",
    "markdown": "install marksman",
    "nix": "install nil",
    "ocaml": "install ocaml-lsp",
    "php": "npm i -g intelephense",
    "ruby": "gem install solargraph",
    "rust": "rustup component add rust-analyzer",
    "scala": "install metals",
    "svelte": "npm i -g svelte-language-server",
    "swift": "install sourcekit-lsp (xcode toolchain)",
    "terraform": "install terraform-ls",
    "toml": "cargo install taplo-cli --features lsp",
    "vue": "npm i -g vue-language-server",
    "yaml": "npm i -g yaml-language-server",
    "zig": "install zls",
    "tailwind": "npm i -g @tailwindcss/language-server",
    "eslint": "npm i -g vscode-langservers-extracted",
}

# Auto-install: missing servers are installed automatically on first use
# (best-effort, once per language per process). CODIFA_LSP_AUTOINSTALL=0
# opts out and restores hint-only behaviour.
_LSP_AUTOINSTALL_ENV = "CODIFA_LSP_AUTOINSTALL"

# Safe auto-install commands per language (run when the server binary is
# missing from PATH). Languages without a reliable one-click installer are
# intentionally absent: command_for then returns None and the caller shows
# the human-readable INSTALL_HINTS entry instead.
_INSTALL_COMMANDS: dict[str, list[str]] = {
    "python": ["pip", "install", "python-lsp-server"],
    "typescript": ["npm", "i", "-g", "typescript-language-server", "typescript"],
    "javascript": ["npm", "i", "-g", "typescript-language-server", "typescript"],
    "astro": ["npm", "i", "-g", "astro-language-server"],
    "bash": ["npm", "i", "-g", "bash-language-server"],
    "csharp": ["dotnet", "tool", "install", "-g", "csharp-ls"],
    "css": ["npm", "i", "-g", "vscode-langservers-extracted"],
    "elm": ["npm", "i", "-g", "elm-language-server"],
    "go": ["go", "install", "golang.org/x/tools/gopls@latest"],
    "html": ["npm", "i", "-g", "vscode-langservers-extracted"],
    "json": ["npm", "i", "-g", "vscode-langservers-extracted"],
    "php": ["npm", "i", "-g", "intelephense"],
    "ruby": ["gem", "install", "solargraph"],
    "rust": ["rustup", "component", "add", "rust-analyzer"],
    "svelte": ["npm", "i", "-g", "svelte-language-server"],
    "toml": ["cargo", "install", "taplo-cli", "--features", "lsp"],
    "vue": ["npm", "i", "-g", "vue-language-server"],
    "yaml": ["npm", "i", "-g", "yaml-language-server"],
    "tailwind": ["npm", "i", "-g", "@tailwindcss/language-server"],
    "eslint": ["npm", "i", "-g", "vscode-eslint-language-server"],
    "c": ["brew", "install", "llvm"],
    "cpp": ["brew", "install", "llvm"],
    "dart": ["brew", "install", "dart"],
    "elixir": ["brew", "install", "elixir-ls"],
    "erlang": ["brew", "install", "erlang-ls"],
    "haskell": ["brew", "install", "haskell-language-server"],
    "java": ["brew", "install", "jdtls"],
    "kotlin": ["brew", "install", "kotlin-language-server"],
    "lua": ["brew", "install", "lua-language-server"],
    "markdown": ["brew", "install", "marksman"],
    "nix": ["brew", "install", "nil"],
    "ocaml": ["brew", "install", "ocaml-lsp"],
    "scala": ["brew", "install", "metals"],
    "swift": ["brew", "install", "swift"],
    "terraform": ["brew", "install", "terraform-ls"],
    "zig": ["brew", "install", "zls"],
}

_INSTALL_ATTEMPTED: set[str] = set()
_INSTALL_ATTEMPTED_LOCK = threading.Lock()
_INSTALL_EVENTS: dict[str, threading.Event] = {}

# In-progress background server starts: (root, lang) -> Event set when the
# start finishes (success or failure). Lets concurrent callers fail fast
# with a "starting" status instead of queueing behind a 25s initialize
# handshake inside the tool call.
_STARTING: dict[tuple[str, str], threading.Event] = {}
_STARTING_LOCK = threading.Lock()

# Global installs (pip/npm/brew/go/gem/cargo/rustup all write outside the
# workspace) run automatically without asking: a missing server is installed
# on first use and an installed one is refreshed weekly. Opt out entirely
# with CODIFA_LSP_AUTOINSTALL=0. Every stage is logged (logger) and fanned
# out via _notify_progress so the progress log is preserved.
_LSP_INSTALL_CONSENT_ENV = "CODIFA_LSP_INSTALL_CONSENT"
_INSTALL_CONFIRMED: set[str] = set()
_INSTALL_CONFIRMED_LOCK = threading.Lock()


def has_install_consent(lang: str) -> bool:
    """True when a global install for lang was approved (or pre-approved)."""
    try:
        if os.environ.get(_LSP_INSTALL_CONSENT_ENV) == "1":
            return True
    except Exception:  # noqa: BLE001 - env check never fails
        pass
    try:
        with _INSTALL_CONFIRMED_LOCK:
            return str(lang) in _INSTALL_CONFIRMED
    except Exception:  # noqa: BLE001 - check never fails
        return False


def grant_install_consent(lang: str) -> None:
    """Record one-time approval for a global install (idempotent)."""
    try:
        with _INSTALL_CONFIRMED_LOCK:
            _INSTALL_CONFIRMED.add(str(lang))
    except Exception:  # noqa: BLE001 - grant never fails
        pass


def classify_lsp_error(exc: BaseException) -> str:
    """Classify an LSP failure: timeout, dead server, missing, or generic."""
    text = str(exc or "").lower()
    if "starting" in text or "retry shortly" in text:
        return "starting"
    kind = getattr(exc, "kind", "")
    # "error" is the LspError default and carries no signal: never let it
    # short-circuit the message checks below (a "timed out" message must
    # classify as "timeout" even when the raise site omitted the kind).
    if isinstance(kind, str) and kind in ("timeout", "dead", "missing", "unavailable", "starting", "wedged"):
        return kind
    if "timed out" in text or "timeout" in text:
        return "timeout"
    if "unsupported" in text or "disabled" in text:
        return "unavailable"
    if "-32601" in text or "method not found" in text or "unhandled method" in text:
        return "unavailable"
    if "gone" in text or "closed" in text or "write failed" in text or "cannot start" in text:
        return "dead"
    if "binary missing" in text or "no server" in text:
        return "missing"
    return "error"

# Progress hook for long installs/updates (package-manager installs can take
# minutes). Listeners receive {"lang": ..., "stage": ..., "content": ...}
# where stage is one of installing/installed/install_failed/updating/updated.
# The tools layer polls install_state()/pending_install_language() instead of
# registering a global listener, so concurrent tool calls each emit their own
# status event without leaking callbacks across turns. All notifications are
# best-effort and never break install/update.
_PROGRESS_CALLBACKS: list[Callable[[dict], None]] = []
_PROGRESS_LOCK = threading.Lock()


def register_progress_callback(cb: Callable[[dict], None]) -> None:
    """Register a listener for LSP install/update progress (best-effort)."""
    try:
        with _PROGRESS_LOCK:
            if cb not in _PROGRESS_CALLBACKS:
                _PROGRESS_CALLBACKS.append(cb)
    except Exception:  # noqa: BLE001 - registration never fails
        pass


def unregister_progress_callback(cb: Callable[[dict], None]) -> None:
    """Remove a previously registered progress listener."""
    try:
        with _PROGRESS_LOCK:
            if cb in _PROGRESS_CALLBACKS:
                _PROGRESS_CALLBACKS.remove(cb)
    except Exception:  # noqa: BLE001 - unregistration never fails
        pass


def _notify_progress(lang: str, stage: str, content: str) -> None:
    """Fan out one progress event; a failing listener never breaks install."""
    try:
        with _PROGRESS_LOCK:
            listeners = list(_PROGRESS_CALLBACKS)
    except Exception:  # noqa: BLE001 - notify never fails
        return
    event = {"lang": str(lang), "stage": stage, "content": content}
    for cb in listeners:
        try:
            cb(dict(event))
        except Exception:  # noqa: BLE001, S110 - listener is best-effort
            pass


def get_install_state(lang: str) -> str:
    """Synchronous install state for a language: "installing" or "idle"."""
    try:
        with _INSTALL_ATTEMPTED_LOCK:
            event = _INSTALL_EVENTS.get(str(lang))
            if event is not None and not event.is_set():
                return "installing"
    except Exception:  # noqa: BLE001 - state check never fails
        pass
    return "idle"

# Auto-update on app startup for the language in use (best-effort,
# once per language per process, in a background thread so the first
# request never blocks). CODIFA_LSP_AUTOUPDATE=0 opts out.
_LSP_AUTOUPDATE_ENV = "CODIFA_LSP_AUTOUPDATE"

# Update commands for already-installed servers. Languages without a
# reliable one-click update are intentionally absent (no update attempted).
# brew, rustup and go are never auto-updated: system toolchains must not
# change under the user on startup.
_UPDATE_COMMANDS: dict[str, list[str]] = {
    "python": ["pip", "install", "-U", "python-lsp-server"],
    "typescript": ["npm", "update", "-g", "typescript-language-server", "typescript"],
    "javascript": ["npm", "update", "-g", "typescript-language-server", "typescript"],
    "astro": ["npm", "update", "-g", "astro-language-server"],
    "bash": ["npm", "update", "-g", "bash-language-server"],
    "csharp": ["dotnet", "tool", "update", "-g", "csharp-ls"],
    "css": ["npm", "update", "-g", "vscode-langservers-extracted"],
    "elm": ["npm", "update", "-g", "elm-language-server"],
    "html": ["npm", "update", "-g", "vscode-langservers-extracted"],
    "json": ["npm", "update", "-g", "vscode-langservers-extracted"],
    "php": ["npm", "update", "-g", "intelephense"],
    "ruby": ["gem", "update", "solargraph"],
    "svelte": ["npm", "update", "-g", "svelte-language-server"],
    "toml": ["cargo", "install", "taplo-cli", "--features", "lsp"],
    "vue": ["npm", "update", "-g", "vue-language-server"],
    "yaml": ["npm", "update", "-g", "yaml-language-server"],
    "tailwind": ["npm", "update", "-g", "@tailwindcss/language-server"],
    "eslint": ["npm", "update", "-g", "vscode-eslint-language-server"],
}

_UPDATE_ATTEMPTED: set[str] = set()
_UPDATE_ATTEMPTED_LOCK = threading.Lock()


def _update_stamps_path() -> str:
    """Weekly-update stamps persist in the user data root (survive restarts)."""
    try:
        from state_db import data_root

        return os.path.join(data_root(), "lsp-update-stamps.json")
    except Exception:  # noqa: BLE001 - state_db unavailable (standalone use)
        root = os.environ.get("CODER_DATA_DIR") or os.path.expanduser("~/.codifa")
        return os.path.join(root, "lsp-update-stamps.json")


def _load_update_stamps_once() -> None:
    """Load persisted stamps the first time an update check runs."""
    global _UPDATE_STAMPS_LOADED
    with _UPDATE_ATTEMPTED_LOCK:
        if _UPDATE_STAMPS_LOADED:
            return
        _UPDATE_STAMPS_LOADED = True
    try:
        with open(_update_stamps_path(), encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            for key, val in raw.items():
                _UPDATE_STAMPS[str(key)] = float(val)
    except Exception:  # noqa: BLE001, S110 - no stamps file yet is normal
        pass


def _mark_updated(lang: str) -> None:
    """Record now as the last install/update time for lang (memory + disk)."""
    _UPDATE_STAMPS[str(lang)] = time.time()
    try:
        with open(_update_stamps_path(), "w", encoding="utf-8") as fh:
            json.dump(_UPDATE_STAMPS, fh)
    except Exception:  # noqa: BLE001, S110 - persistence is best-effort
        pass

# Global lsp config overrides (opencode-style lsp section). Shape:
# {"python": {"disabled": bool, "command": [...], "extensions": [...],
#             "env": {...}, "initialization": {...}}, ...}
_LSP_CONFIG: dict[str, dict] = {}
_LSP_CONFIG_LOCK = threading.Lock()


# Default initializationOptions for python (pylsp): linters and formatters
# off, jedi-powered navigation on. Prevents wedge on heavy files while
# keeping documentSymbol/definition/references/hover fast.
_DEFAULT_PYTHON_INIT: dict = {
    "pylsp": {
        "plugins": {
            "pycodestyle": {"enabled": False},
            "pyflakes": {"enabled": False},
            "pylint": {"enabled": False},
            "flake8": {"enabled": False},
            "pydocstyle": {"enabled": False},
            "autopep8": {"enabled": False},
            "yapf": {"enabled": False},
            "rope_autoimport": {"enabled": False},
            "rope_completion": {"enabled": False},
            "jedi_completion": {"enabled": False},
            "mccabe": {"enabled": False},
        }
    }
}


def configure_lsp(config: dict | None) -> None:
    """Set global lsp config overrides (opencode-style lsp section)."""
    with _LSP_CONFIG_LOCK:
        _LSP_CONFIG.clear()
        if isinstance(config, dict):
            for lang, entry in config.items():
                if isinstance(entry, dict):
                    _LSP_CONFIG[str(lang)] = dict(entry)


def _config_for(lang: str, extra: dict | None = None) -> dict:
    """Merged config for a language: global overrides plus manager config."""
    out: dict = {}
    with _LSP_CONFIG_LOCK:
        base = _LSP_CONFIG.get(lang)
        if isinstance(base, dict):
            out.update(base)
    if isinstance(extra, dict):
        entry = extra.get(lang)
        if isinstance(entry, dict):
            out.update(entry)
    return out

# LSP SymbolKind (3.17) number -> short label.
_SYMBOL_KIND_LABELS: dict[int, str] = {
    1: "file", 2: "module", 3: "namespace", 4: "package",
    5: "class", 6: "method", 7: "property", 8: "field",
    9: "constructor", 10: "enum", 11: "interface", 12: "function",
    13: "variable", 14: "constant", 15: "string", 16: "number",
    17: "boolean", 18: "array", 19: "object", 20: "key",
    21: "null", 22: "enummember", 23: "struct", 24: "event",
    25: "operator", 26: "typeparameter",
}

_DIAGNOSTIC_SEVERITY: dict[int, str] = {
    1: "error", 2: "warning", 3: "info", 4: "hint",
}


class LspError(Exception):
    """Raised when an LSP server is missing, crashes, or times out."""

    def __init__(self, message: str = "", kind: str = "error") -> None:
        super().__init__(message)
        self.kind = kind


class _LspClient:
    """One stdio JSON-RPC connection to a language server process."""

    def __init__(
        self,
        command: list[str],
        root: str,
        timeout: float = LSP_TIMEOUT,
        env: dict[str, str] | None = None,
        initialization: dict | None = None,
        init_timeout: float = _LSP_INIT_TIMEOUT,
    ) -> None:
        self._timeout = float(timeout or LSP_TIMEOUT)
        self._ids = itertools.count(1)
        self._pending: dict[int, queue.Queue] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._diagnostics: dict[str, list[dict]] = {}
        self._diag_events: dict[str, threading.Event] = {}
        self._diag_lock = threading.Lock()
        self._closed = False
        # Kept initialize result and server capabilities so callers can
        # choose between pull and push diagnostics.
        self.initialization_result: dict = {}
        self.capabilities: dict = {}
        try:
            merged_env = None
            if env:
                merged_env = dict(os.environ)
                for k, v in env.items():
                    merged_env[str(k)] = str(v)
            self._proc = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=root,
                env=merged_env,
            )
        except OSError as exc:
            raise LspError(f"cannot start {' '.join(command)}: {exc}") from exc
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._pump_stderr, daemon=True)
        self._stderr_reader.start()
        # Minimal initialize handshake with opencode-style initializationOptions.
        root_uri = "file://" + urllib.parse.quote(os.path.abspath(root))
        try:
            result = self.request(
                "initialize",
                {
                    "processId": os.getpid(),
                    "rootUri": root_uri,
                    "capabilities": {
                        "textDocument": {
                            "documentSymbol": {
                                "hierarchicalDocumentSymbolSupport": True
                            },
                            "publishDiagnostics": {
                                "relatedInformation": True,
                                "versionSupport": True,
                            },
                            "diagnostic": {"relatedInformation": True},
                        },
                        "workspace": {"configuration": True},
                    },
                    "initializationOptions": dict(initialization or {}),
                },
                timeout=float(init_timeout or _LSP_INIT_TIMEOUT),
            )
            if isinstance(result, dict):
                self.initialization_result = result
                caps = result.get("capabilities")
                if isinstance(caps, dict):
                    self.capabilities = caps
            self.notify("initialized", {})
        except LspError:
            self.close()
            raise

    def request(self, method: str, params: dict, timeout: float | None = None) -> Any:
        """Send a request and wait for its result (raises LspError on failure)."""
        if self._closed:
            raise LspError(f"{method}: client is closed")
        wait = float(timeout if timeout is not None else self._timeout)
        rid = next(self._ids)
        box: queue.Queue = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[rid] = box
        body = json.dumps(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        ).encode("utf-8")
        started = time.monotonic()
        try:
            with self._write_lock:
                stdin = self._proc.stdin
                if stdin is None or self._proc.poll() is not None:
                    raise LspError(f"{method}: server process is gone")
                stdin.write(b"Content-Length: %d\r\n\r\n" % len(body))
                stdin.write(body)
                stdin.flush()
        except LspError:
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise
        except OSError as exc:
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise LspError(f"{method}: write failed: {exc}") from exc
        try:
            msg = box.get(timeout=wait)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(rid, None)
            logger.warning(
                "lsp call method=%s outcome=timeout after=%.2fs",
                method,
                time.monotonic() - started,
            )
            raise LspError(
                f"{method} timed out after {wait}s", kind="timeout"
            ) from None
        elapsed = time.monotonic() - started
        if isinstance(msg, dict) and "error" in msg:
            err = msg.get("error") or {}
            logger.warning(
                "lsp call method=%s outcome=error after=%.2fs err=%s",
                method,
                elapsed,
                err,
            )
            raise LspError(f"{method} failed: {err}")
        result = msg.get("result") if isinstance(msg, dict) else None
        outcome = "result" if result is not None else "empty"
        logger.debug(
            "lsp call method=%s outcome=%s after=%.2fs", method, outcome, elapsed
        )
        return result

    def notify(self, method: str, params: dict) -> None:
        """Fire-and-forget notification (never raises)."""
        try:
            body = json.dumps(
                {"jsonrpc": "2.0", "method": method, "params": params}
            ).encode("utf-8")
            with self._write_lock:
                stdin = self._proc.stdin
                if stdin is None or self._proc.poll() is not None:
                    return
                stdin.write(b"Content-Length: %d\r\n\r\n" % len(body))
                stdin.write(body)
                stdin.flush()
        except OSError:  # noqa: BLE001, S110 - notifications are best-effort
            pass

    def published_diagnostics(self, uri: str) -> list[dict]:
        """Last pushed diagnostics for a document URI (may be empty)."""
        return list(self._diagnostics.get(uri, []))

    def reset_diagnostics(self, uri: str) -> None:
        """Arm a fresh event so the next sync waits for new publishDiagnostics."""
        try:
            with self._diag_lock:
                self._diag_events[str(uri)] = threading.Event()
        except Exception:  # noqa: BLE001, S110 - arming never fails
            pass

    def wait_for_diagnostics(
        self, uri: str, timeout: float | None = None
    ) -> tuple[list[dict], bool]:
        """Wait for fresh pushed diagnostics; returns (diags, arrived)."""
        wait = float(timeout if timeout is not None else _LSP_DIAG_WAIT)
        try:
            with self._diag_lock:
                event = self._diag_events.get(str(uri))
                if event is None:
                    event = threading.Event()
                    self._diag_events[str(uri)] = event
            arrived = event.wait(timeout=wait)
            return list(self._diagnostics.get(str(uri), [])), bool(arrived)
        except Exception:  # noqa: BLE001 - wait never fails
            return [], False

    def close(self) -> None:
        """Terminate the server process (idempotent)."""
        self._closed = True
        proc = getattr(self, "_proc", None)
        if proc is None:
            return
        try:
            self.notify("exit", {})
        except Exception:  # noqa: BLE001, S110 - exit is best-effort
            pass
        try:
            with self._pending_lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for box in pending:
                try:
                    box.put_nowait({"error": {"message": "client closed"}})
                except queue.Full:  # noqa: S110 - waiter already timed out
                    pass
        except Exception:  # noqa: BLE001, S110 - wake-up is best-effort
            pass
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except OSError:  # noqa: BLE001, S110 - closing is best-effort
            pass
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:  # noqa: BLE001, S110 - fall through to kill
            try:
                proc.kill()
            except OSError:  # noqa: BLE001, S110 - already gone
                pass

    def _read_loop(self) -> None:
        """Background reader: routes responses to waiters, stores diagnostics."""
        stdout = self._proc.stdout
        if stdout is None:
            return
        while True:
            try:
                length = self._read_headers(stdout)
                if length is None:
                    return
                raw = stdout.read(length)
                if not raw:
                    return
                try:
                    msg = json.loads(raw.decode("utf-8", errors="replace"))
                except ValueError:
                    continue
                self._dispatch(msg)
            except Exception:  # noqa: BLE001, S110 - reader never crashes the caller
                return

    @staticmethod
    def _read_headers(stream: Any) -> int | None:
        length: int | None = None
        while True:
            line = stream.readline()
            if not line:
                return None
            text = line.decode("ascii", errors="replace").strip()
            if not text:
                return length
            if text.lower().startswith("content-length:"):
                try:
                    length = int(text.split(":", 1)[1].strip())
                except ValueError:
                    length = None

    def _pump_stderr(self) -> None:
        """Forward server stderr to the codifa.lsp log (never DEVNULL)."""
        proc = getattr(self, "_proc", None)
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return
        for line in iter(stream.readline, b""):
            try:
                text = line.decode("utf-8", errors="replace").rstrip()
            except Exception:  # noqa: BLE001, S110 - decoding never fails
                continue
            if text:
                logger.debug("lsp stderr: %s", text)
        try:
            stream.close()
        except Exception:  # noqa: BLE001, S110 - close is best-effort
            pass

    def _send_response(self, rid: Any, result: Any) -> None:
        """Answer a server-to-client request (never raises)."""
        try:
            body = json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}).encode(
                "utf-8"
            )
            with self._write_lock:
                stdin = self._proc.stdin
                if stdin is None or self._proc.poll() is not None:
                    return
                stdin.write(b"Content-Length: %d\r\n\r\n" % len(body))
                stdin.write(body)
                stdin.flush()
        except OSError:  # noqa: BLE001, S110 - response is best-effort
            pass

    def _handle_server_request(self, msg: dict) -> Any:
        """Result for a server-to-client request (workspace/configuration et al)."""
        method = str(msg.get("method") or "")
        params = msg.get("params")
        if method == "workspace/configuration":
            items = params.get("items") if isinstance(params, dict) else None
            if isinstance(items, list):
                return [{} for _ in items]
            return []
        if method in (
            "client/registerCapability",
            "client/unregisterCapability",
            "window/workDoneProgress/create",
        ):
            return None
        if method == "workspace/workspaceFolders":
            return None
        return None

    def _dispatch(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        if "id" in msg and ("result" in msg or "error" in msg):
            with self._pending_lock:
                box = self._pending.pop(msg["id"], None)
            if box is not None:
                try:
                    box.put_nowait(msg)
                except queue.Full:  # noqa: S110 - waiter already timed out
                    pass
            return
        if "id" in msg and isinstance(msg.get("method"), str):
            # Server-to-client request: answer so the server never hangs.
            try:
                self._send_response(msg["id"], self._handle_server_request(msg))
            except Exception:  # noqa: BLE001, S110 - answer is best-effort
                pass
            return
        if msg.get("method") == "textDocument/publishDiagnostics":
            params = msg.get("params") or {}
            uri = str(params.get("uri") or "")
            diags = params.get("diagnostics") or []
            if uri and isinstance(diags, list):
                self._diagnostics[uri] = [d for d in diags if isinstance(d, dict)]
                try:
                    with self._diag_lock:
                        event = self._diag_events.get(uri)
                        if event is None:
                            event = threading.Event()
                            self._diag_events[uri] = event
                        event.set()
                except Exception:  # noqa: BLE001, S110 - event never fails
                    pass


def _kind_label(kind: Any) -> str:
    """Map an LSP SymbolKind number to a short label."""
    try:
        return _SYMBOL_KIND_LABELS.get(int(kind), "symbol")
    except (TypeError, ValueError):
        return "symbol"


class LspManager:
    """Owns lazily-started LSP clients, one per language, for a workspace root."""

    def __init__(
        self,
        root: str,
        timeout: float = LSP_TIMEOUT,
        starter: Callable[[str, list[str], str], Any] | None = None,
        lsp_config: dict | None = None,
    ) -> None:
        self._root = os.path.realpath(os.path.abspath(root))
        self._timeout = float(timeout or LSP_TIMEOUT)
        # Test seam: starter(language, command, root) -> client with
        # request/notify/close. When set, the PATH check is skipped.
        self._starter = starter
        self._lsp_config: dict = dict(lsp_config) if isinstance(lsp_config, dict) else {}
        self._clients: dict[str, Any] = {}
        self._lock = threading.Lock()
        # Open document versions for didOpen/didChange/didClose sync.
        self._open_versions: dict[str, int] = {}
        self._open_lock = threading.Lock()
        # Single sync lock: version bump and didOpen/didChange send stay
        # atomic so parallel calls on one file cannot reorder versions.
        self._sync_lock = threading.Lock()
        # Last known (mtime, size) per uri to skip duplicate didChange sends.
        self._open_meta: dict[str, tuple[float, int]] = {}
        # uri -> registry language for idle eviction and didClose routing.
        self._uri_lang: dict[str, str] = {}
        # Dedicated lock per language: a slow install/start blocks only
        # that language, never every other server.
        self._lang_locks: dict[str, threading.Lock] = {}
        self._lang_locks_guard = threading.Lock()
        # Failed start cache: a dead server is not respawned for minutes.
        self._start_failed_at: dict[str, float] = {}
        # Last use per language for ~10 minute idle eviction.
        self._last_used: dict[str, float] = {}
        # Deterministic result cache: identical inputs reuse results so
        # repeated tool calls cost no round-trip and no extra tokens.
        self._result_cache: dict[tuple, tuple[float, Any]] = {}
        self._result_cache_lock = threading.Lock()
        # Last served call key: back-to-back duplicates return cached copy.
        self._last_call_key: tuple | None = None

    @staticmethod
    def language_for(path: str) -> str | None:
        """Registry language for a file path, or None when unsupported."""
        return SUFFIX_TO_LANGUAGE.get(os.path.splitext(path)[1].lower())

    def _resolve_language(self, path: str) -> str | None:
        """Language for a path including config extensions and custom servers."""
        suffix = os.path.splitext(path)[1].lower()
        for source in (self._lsp_config, _LSP_CONFIG):
            if not isinstance(source, dict):
                continue
            for lang, entry in source.items():
                if not isinstance(entry, dict):
                    continue
                exts = entry.get("extensions")
                if isinstance(exts, list) and suffix in [str(e).lower() for e in exts]:
                    return str(lang)
        return self.language_for(path)

    def is_disabled(self, lang: str) -> bool:
        """True when lsp config disables this language server."""
        cfg = _config_for(lang, self._lsp_config)
        return bool(cfg.get("disabled", False))

    def effective_env(self, lang: str) -> dict[str, str] | None:
        """Extra env for a language server, or None for inherited env."""
        cfg = _config_for(lang, self._lsp_config)
        env = cfg.get("env")
        if isinstance(env, dict) and env:
            return {str(k): str(v) for k, v in env.items()}
        return None

    def effective_initialization(self, lang: str) -> dict:
        """initializationOptions for a language server (minimal by default)."""
        cfg = _config_for(lang, self._lsp_config)
        init = cfg.get("initialization")
        custom = dict(init) if isinstance(init, dict) else {}
        # Python default: disable slow linters/formatters so pylsp never
        # wedges on heavy files (e.g. local_tts.py); symbols/definition/
        # references/hover only need jedi. Custom config merges on top.
        if str(lang) == "python":
            merged: dict = dict(_DEFAULT_PYTHON_INIT)
            pylsp_custom = custom.get("pylsp")
            if isinstance(pylsp_custom, dict):
                base_plugins = dict(merged.get("pylsp", {}).get("plugins", {}))
                custom_plugins = pylsp_custom.get("plugins")
                if isinstance(custom_plugins, dict):
                    base_plugins.update(custom_plugins)
                merged_plugins = dict(merged.get("pylsp", {}))
                merged_plugins["plugins"] = base_plugins
                merged["pylsp"] = merged_plugins
                for key, value in custom.items():
                    if key != "pylsp":
                        merged[key] = value
            else:
                merged.update(custom)
            return merged
        return custom

    def install_hint(self, lang: str) -> str:
        """Human-readable install hint for a missing server binary."""
        return INSTALL_HINTS.get(lang, f"install a language server for {lang}")

    def pending_install_language(self, path: str) -> str | None:
        """Language whose server binary is missing, or None when ready.

        Synchronous and cheap (PATH lookup only): tools call this BEFORE the
        blocking install so they can stream a status event first.
        """
        try:
            lang = self._resolve_language(path)
            if lang is None or self.is_disabled(lang):
                return None
            if self._starter is not None:
                return None
            cfg = _config_for(lang, self._lsp_config)
            custom = cfg.get("command")
            if (
                isinstance(custom, list)
                and custom
                and all(isinstance(c, str) for c in custom)
            ):
                binary = str(custom[0])
            else:
                cmd = LANGUAGE_SERVERS.get(lang)
                if not cmd:
                    return None
                binary = cmd[0]
            if shutil.which(binary) is None:
                return lang
        except Exception:  # noqa: BLE001 - check never breaks tools
            pass
        return None

    def install_state(self, lang: str) -> str:
        """Synchronous install state for a language: "installing" or "idle"."""
        return get_install_state(lang)

    def _absent_reason(self, abs_path: str) -> str:
        """Why no client exists: starting/unsupported/disabled/missing/start-failed."""
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - reason never fails
            return "unknown language"
        if lang is None:
            return "unsupported language"
        if self.is_disabled(lang):
            return "server disabled"
        try:
            with _STARTING_LOCK:
                starting = _STARTING.get((self._root, str(lang)))
            if starting is not None and not starting.is_set():
                return "server starting, retry shortly"
        except Exception:  # noqa: BLE001 - reason never fails
            pass
        if self._starter is None:
            cfg = _config_for(lang, self._lsp_config)
            custom = cfg.get("command")
            if isinstance(custom, list) and custom and all(isinstance(c, str) for c in custom):
                binary = str(custom[0])
            else:
                cmd = LANGUAGE_SERVERS.get(lang)
                binary = cmd[0] if cmd else ""
            if binary and shutil.which(binary) is None:
                return f"server binary missing: {self.install_hint(lang)}"
        return "cannot start server"

    def client_if_running(self, lang: str) -> Any | None:
        """Cached live client for a language, or None without starting anything."""
        try:
            with self._lock:
                client = self._clients.get(str(lang))
            if client is None:
                return None
            if not self._is_alive(client):
                return None
            return client
        except Exception:  # noqa: BLE001 - check never fails
            return None

    def wait_for_server(self, abs_path: str, timeout_s: float = 30.0) -> bool:
        """Block until the background start for this file's language finishes.

        Returns True once a live client exists, False when the start failed,
        the language is unsupported, or ``timeout_s`` elapsed. The LSP tools
        use this to absorb the lazy-start latency in-process instead of
        failing the tool call and burning an LLM round-trip on a retry.
        """
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - lookup never fails
            return False
        if lang is None:
            return False
        deadline = time.monotonic() + max(0.0, float(timeout_s or 0.0))
        while True:
            if self.client_if_running(lang) is not None:
                return True
            evt = None
            try:
                with _STARTING_LOCK:
                    evt = _STARTING.get((self._root, str(lang)))
            except Exception:  # noqa: BLE001 - check never fails
                return False
            if evt is None:
                # No start in progress: kick one off (idempotent) and pick
                # up the event it registers — or finish now when the start
                # was synchronous (test seam / already cached).
                try:
                    self._client_for(abs_path)
                except Exception:  # noqa: BLE001 - start never fails the wait
                    return False
                if self.client_if_running(lang) is not None:
                    return True
                try:
                    with _STARTING_LOCK:
                        evt = _STARTING.get((self._root, str(lang)))
                except Exception:  # noqa: BLE001 - check never fails
                    return False
                if evt is None:
                    return False
            if evt.is_set():
                if time.monotonic() >= deadline:
                    return False
                # Stale event from a start that already finished (failed,
                # died, or an earlier manager instance) with no live client
                # left: drop it — only when it is still the same object, so
                # a fresh start another thread just registered survives —
                # and loop; the next iteration kicks a fresh start instead
                # of failing every wait from now on.
                try:
                    with _STARTING_LOCK:
                        if _STARTING.get((self._root, str(lang))) is evt:
                            _STARTING.pop((self._root, str(lang)), None)
                except Exception:  # noqa: BLE001 - cleanup never fails the wait
                    return False
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                evt.wait(timeout=remaining)
            except Exception:  # noqa: BLE001 - wait never fails
                return False

    def is_server_running(self, abs_path: str) -> bool:
        """True when the server for a file is already started and alive."""
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - check never fails
            return False
        if not lang:
            return False
        return self.client_if_running(lang) is not None

    def server_state(self, abs_path: str) -> str:
        """One of running/unsupported/disabled/missing/stopped (never raises)."""
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - state never fails
            return "unsupported"
        if lang is None:
            return "unsupported"
        if self.is_disabled(lang):
            return "disabled"
        if self.client_if_running(lang) is not None:
            return "running"
        try:
            with _STARTING_LOCK:
                starting = _STARTING.get((self._root, str(lang)))
            if starting is not None and not starting.is_set():
                return "starting"
        except Exception:  # noqa: BLE001 - state never fails
            pass
        if self._starter is None:
            cfg = _config_for(lang, self._lsp_config)
            custom = cfg.get("command")
            if isinstance(custom, list) and custom and all(isinstance(c, str) for c in custom):
                binary = str(custom[0])
            else:
                cmd = LANGUAGE_SERVERS.get(lang)
                binary = cmd[0] if cmd else ""
            if binary and shutil.which(binary) is None:
                return "missing"
        return "stopped"

    def warmup(self, abs_paths: list[str] | None) -> None:
        """Warm up language servers for file paths in background.

        Starts servers for the distinct languages of the given files in a
        single daemon thread. Never installs missing binaries, never blocks
        the caller, and never raises: every check is best-effort so grep and
        other background paths stay fast.
        """
        try:
            paths = [str(p) for p in (abs_paths or []) if str(p or "").strip()]
        except Exception:  # noqa: BLE001 - warmup never fails
            return
        if not paths:
            return

        def _run() -> None:
            try:
                seen: set[str] = set()
                for abs_path in paths[:32]:
                    try:
                        lang = self._resolve_language(abs_path)
                    except Exception:  # noqa: BLE001 - lookup never breaks warmup
                        continue
                    if not lang or lang in seen:
                        continue
                    seen.add(lang)
                    try:
                        if self.is_disabled(lang):
                            continue
                        if self.client_if_running(lang) is not None:
                            continue
                    except Exception:  # noqa: BLE001 - check never breaks warmup
                        continue
                    # Capability check without install: skip when the server
                    # binary is missing. No auto-install is triggered here.
                    try:
                        if self._starter is None:
                            cfg = _config_for(lang, self._lsp_config)
                            custom = cfg.get("command")
                            if (
                                isinstance(custom, list)
                                and custom
                                and all(isinstance(c, str) for c in custom)
                            ):
                                binary = str(custom[0])
                            else:
                                cmd = LANGUAGE_SERVERS.get(lang)
                                binary = cmd[0] if cmd else ""
                            if binary and shutil.which(binary) is None:
                                continue
                    except Exception:  # noqa: BLE001 - check never breaks warmup
                        continue
                    try:
                        self._client_for(os.path.abspath(abs_path))
                    except Exception:  # noqa: BLE001 - start never breaks warmup
                        continue
            except Exception:  # noqa: BLE001 - warmup never fails
                pass

        try:
            thread = threading.Thread(target=_run, daemon=True)
            thread.start()
        except Exception:  # noqa: BLE001 - spawn never breaks callers
            pass

    def _file_sig(self, abs_path: str) -> tuple[float, int]:
        """File signature for the deterministic result cache (never raises)."""
        try:
            st = os.stat(abs_path)
            return (float(st.st_mtime), int(st.st_size))
        except OSError:
            return (0.0, -1)

    def _cache_get(self, key: tuple) -> Any | None:
        """Cached result for an identical call, or None on miss/expiry."""
        try:
            with self._result_cache_lock:
                entry = self._result_cache.get(key)
                if entry is None:
                    return None
                ts, value = entry
                if time.monotonic() - float(ts) > _LSP_RESULT_TTL:
                    self._result_cache.pop(key, None)
                    return None
                return value
        except Exception:  # noqa: BLE001 - cache never fails
            return None

    def _cache_put(self, key: tuple, value: Any) -> None:
        """Store a result; evicts oldest entries past the cap."""
        try:
            with self._result_cache_lock:
                if len(self._result_cache) >= _LSP_RESULT_CACHE_MAX:
                    oldest = next(iter(self._result_cache))
                    self._result_cache.pop(oldest, None)
                self._result_cache[key] = (time.monotonic(), value)
                self._last_call_key = key
        except Exception:  # noqa: BLE001 - cache never fails
            pass

    def document_symbols_if_running(self, abs_path: str) -> dict[str, tuple[int, int, str]]:
        """Symbol map without starting or installing a server.

        Only queries an already-running server for the file language; when
        the server is not running returns {} immediately. Background paths
        (grep expansion, file maps) must use this so they never trigger an
        install or block without a status event.
        """
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - lookup never fails
            return {}
        if not lang:
            return {}
        client = self.client_if_running(lang)
        if client is None:
            return {}
        try:
            uri = self._did_open(client, abs_path)
        except Exception:  # noqa: BLE001 - sync never breaks background paths
            return {}
        try:
            result = client.request(
                "textDocument/documentSymbol",
                {"textDocument": {"uri": uri}},
                timeout=self._timeout,
            )
        except LspError:
            return {}
        out: dict[str, tuple[int, int, str]] = {}

        def _collect(items: Any, parent: str = "") -> None:
            if not isinstance(items, list):
                return
            for item in items:
                if not isinstance(item, dict):
                    continue
                loc = item.get("location")
                rng = loc.get("range") if isinstance(loc, dict) else item.get("range")
                if not isinstance(rng, dict):
                    continue
                start = rng.get("start", {})
                end = rng.get("end", {})
                if not isinstance(start, dict) or not isinstance(end, dict):
                    continue
                name = str(item.get("name", ""))
                if not name:
                    _collect(item.get("children"), parent)
                    continue
                qualified = f"{parent}.{name}" if parent else name
                try:
                    value = (
                        int(start.get("line", 0)) + 1,
                        int(end.get("line", 0)) + 1,
                        _kind_label(item.get("kind")),
                    )
                except (TypeError, ValueError):
                    _collect(item.get("children"), qualified)
                    continue
                key_name = qualified
                suffix_n = 2
                while key_name in out:
                    key_name = f"{qualified}#{suffix_n}"
                    suffix_n += 1
                out[key_name] = value
                if name != qualified:
                    plain_key = name
                    suffix_p = 2
                    while plain_key in out:
                        plain_key = f"{name}#{suffix_p}"
                        suffix_p += 1
                    out[plain_key] = value
                _collect(item.get("children"), qualified)

        try:
            _collect(result)
        except Exception:  # noqa: BLE001 - parse never fails
            return {}
        return out

    def command_for(self, path: str) -> list[str] | None:
        """Server command for a file, or None when unsupported/disabled/missing."""
        lang = self._resolve_language(path)
        if lang is None:
            return None
        if self.is_disabled(lang):
            return None
        cfg = _config_for(lang, self._lsp_config)
        custom = cfg.get("command")
        if isinstance(custom, list) and custom and all(isinstance(c, str) for c in custom):
            cmd = [str(c) for c in custom]
        else:
            cmd = LANGUAGE_SERVERS.get(lang)
            if not cmd:
                return None
            cmd = list(cmd)
        if self._starter is not None:
            return list(cmd)
        if shutil.which(cmd[0]) is None:
            self._maybe_auto_install(lang)
            if shutil.which(cmd[0]) is None:
                return None
        return list(cmd)

    def _maybe_auto_install(self, lang: str) -> None:
        """Trigger a background install for a missing server (never blocks).

        The first caller spawns a daemon thread running the package-manager
        command; all callers (including the first) return immediately so the
        tool call fails fast with an installing status instead of blocking
        up to 180s inside the request. The next tool call after the install
        finds the binary via PATH.
        """
        try:
            if os.environ.get(_LSP_AUTOINSTALL_ENV) == "0":
                return
        except Exception:  # noqa: BLE001 - env check never fails
            return
        with _INSTALL_ATTEMPTED_LOCK:
            if lang in _INSTALL_ATTEMPTED:
                _prev_event = _INSTALL_EVENTS.get(lang)
                try:
                    _prev_done = _prev_event is None or _prev_event.is_set()
                except Exception:  # noqa: BLE001 - state check never fails
                    _prev_done = True
                if _prev_done and has_install_consent(lang):
                    try:
                        _INSTALL_ATTEMPTED.discard(lang)
                    except Exception:  # noqa: BLE001 - reset never fails
                        pass
            if lang in _INSTALL_ATTEMPTED:
                is_owner = False
                event = _INSTALL_EVENTS.get(lang)
            else:
                _INSTALL_ATTEMPTED.add(lang)
                event = threading.Event()
                _INSTALL_EVENTS[lang] = event
                is_owner = True
        if not is_owner:
            try:
                _notify_progress(lang, "installing", f"installing language server for {lang}...")
            except Exception:  # noqa: BLE001 - notify never fails
                pass
            return
        def _run_install() -> None:
            cmd = _INSTALL_COMMANDS.get(lang)
            announced = False
            succeeded = False
            try:
                if cmd:
                    logger.warning("lsp auto-install start lang=%s cmd=%s", lang, " ".join(cmd))
                    _notify_progress(lang, "installing", f"installing language server for {lang}...")
                    announced = True
                    proc = subprocess.run(cmd, capture_output=True, timeout=180)
                    if proc.returncode == 0:
                        succeeded = True
                        # A fresh install counts as up to date: skip the
                        # weekly update for this language.
                        _mark_updated(lang)
                        logger.warning("lsp auto-install ok lang=%s", lang)
                    else:
                        logger.warning(
                            "lsp auto-install failed lang=%s rc=%s stderr=%s",
                            lang,
                            proc.returncode,
                            (proc.stderr or b"")[-500:].decode("utf-8", errors="replace"),
                        )
            except Exception as exc:  # noqa: BLE001 - install is best-effort
                logger.warning("lsp auto-install error lang=%s: %s", lang, exc)
            finally:
                try:
                    if announced:
                        _notify_progress(
                            lang,
                            "installed" if succeeded else "install_failed",
                            f"language server for {lang} ready"
                            if succeeded
                            else f"language server install failed for {lang}",
                        )
                except Exception:  # noqa: BLE001 - notify never fails
                    pass
                try:
                    event.set()
                except Exception:  # noqa: BLE001 - set never fails
                    pass
        try:
            _notify_progress(lang, "installing", f"installing language server for {lang}...")
            thread = threading.Thread(target=_run_install, daemon=True)
            thread.start()
        except Exception:  # noqa: BLE001 - spawn never breaks tools
            try:
                event.set()
            except Exception:  # noqa: BLE001 - set never fails
                pass

    def _maybe_auto_update(self, lang: str) -> None:
        """Background update for an installed server (at most once a week)."""
        try:
            if os.environ.get(_LSP_AUTOUPDATE_ENV) == "0":
                return
        except Exception:  # noqa: BLE001 - env check never fails
            return
        _load_update_stamps_once()
        with _UPDATE_ATTEMPTED_LOCK:
            now = time.time()
            if lang in _UPDATE_ATTEMPTED:
                return
            if now - _UPDATE_STAMPS.get(lang, 0.0) < _UPDATE_INTERVAL:
                return
            _UPDATE_ATTEMPTED.add(lang)
        cmd = _UPDATE_COMMANDS.get(lang)
        if not cmd:
            return
        def _run() -> None:
            try:
                logger.warning("lsp auto-update start lang=%s", lang)
                _notify_progress(lang, "updating", f"updating language server for {lang}...")
                proc = subprocess.run(cmd, capture_output=True, timeout=180)
                if proc.returncode == 0:
                    _mark_updated(lang)
                logger.warning("lsp auto-update done lang=%s rc=%s", lang, proc.returncode)
                _notify_progress(lang, "updated", f"language server for {lang} updated")
            except Exception as exc:  # noqa: BLE001 - update is best-effort
                logger.warning("lsp auto-update error lang=%s: %s", lang, exc)
        try:
            thread = threading.Thread(target=_run, daemon=True)
            thread.start()
        except Exception:  # noqa: BLE001 - update never breaks startup
            pass

    def shutdown(self) -> None:
        """Send didClose for open docs, then stop every server (idempotent)."""
        with self._sync_lock:
            uris = list(self._open_versions.keys())
            self._open_versions.clear()
            self._open_meta.clear()
            self._uri_lang.clear()
        with self._lock:
            clients = dict(self._clients)
            self._clients.clear()
            try:
                self._last_used.clear()
            except Exception:  # noqa: BLE001 - clear never fails
                pass
        for client in clients.values():
            for uri in uris:
                try:
                    client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
                except Exception:  # noqa: BLE001, S110 - close is best-effort
                    pass
        for client in clients.values():
            try:
                client.close()
            except Exception:  # noqa: BLE001, S110 - shutdown is best-effort
                pass

    @staticmethod
    def _is_alive(client: Any) -> bool:
        """True when a cached client still has a running server process."""
        try:
            proc = getattr(client, "_proc", None)
            if proc is None:
                return True
            return proc.poll() is None
        except Exception:  # noqa: BLE001 - liveness defaults to alive
            return True

    def _lang_lock_for(self, lang: str) -> threading.Lock:
        """Dedicated lock per language so installs never block other languages."""
        with self._lang_locks_guard:
            lock = self._lang_locks.get(lang)
            if lock is None:
                lock = threading.Lock()
                self._lang_locks[lang] = lock
            return lock

    def _touch(self, lang: str) -> None:
        """Mark a language as used for idle eviction."""
        try:
            self._last_used[str(lang)] = time.monotonic()
        except Exception:  # noqa: BLE001 - touch never fails
            pass

    def _evict_uri(self, uri: str) -> None:
        """Best-effort didClose for one uri on every cached client."""
        try:
            with self._lock:
                clients = list(self._clients.values())
        except Exception:  # noqa: BLE001 - eviction never fails
            return
        for client in clients:
            try:
                client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
            except Exception:  # noqa: BLE001, S110 - close is best-effort
                pass

    def _sweep_idle(self) -> None:
        """Close servers idle for ~10 minutes (didClose first, best-effort)."""
        try:
            now = time.monotonic()
            with self._lock:
                stale = [
                    lang
                    for lang, used in self._last_used.items()
                    if now - used >= _LSP_IDLE_TIMEOUT and lang in self._clients
                ]
                if not stale:
                    return
                uris = [u for u, lang in self._uri_lang.items() if lang in stale]
                victims = {lang: self._clients.pop(lang) for lang in stale}
                for lang in stale:
                    self._last_used.pop(lang, None)
                for uri in uris:
                    self._open_versions.pop(uri, None)
                    self._open_meta.pop(uri, None)
                    self._uri_lang.pop(uri, None)
        except Exception:  # noqa: BLE001 - sweep never fails
            return
        for client in victims.values():
            for uri in uris:
                try:
                    client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
                except Exception:  # noqa: BLE001, S110 - close is best-effort
                    pass
        for client in victims.values():
            try:
                client.close()
            except Exception:  # noqa: BLE001, S110 - close is best-effort
                pass

    def evict_server(self, abs_path: str) -> bool:
        """Close and drop the server for a file's language (wedged server).

        A server that stops answering (repeated timeouts on one request,
        e.g. stuck analyzing a pathological file) stays wedged for every
        later call of that language until restart — evicting it lets the
        next call start a fresh server. Returns True when one was dropped.
        """
        try:
            lang = self._resolve_language(abs_path)
        except Exception:  # noqa: BLE001 - lookup never fails
            return False
        if lang is None:
            return False
        with self._sync_lock:
            uris = [u for u, l in self._uri_lang.items() if l == lang]
            for uri in uris:
                self._open_versions.pop(uri, None)
                self._open_meta.pop(uri, None)
                self._uri_lang.pop(uri, None)
        with self._lock:
            client = self._clients.pop(str(lang), None)
            self._last_used.pop(str(lang), None)
        try:
            with _STARTING_LOCK:
                evt = _STARTING.get((self._root, str(lang)))
                if evt is not None and evt.is_set():
                    _STARTING.pop((self._root, str(lang)), None)
        except Exception:  # noqa: BLE001 - event cleanup never fails
            pass
        if client is None:
            return False
        for uri in uris:
            try:
                client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
            except Exception:  # noqa: BLE001, S110 - close is best-effort
                pass
        try:
            client.close()
        except Exception:  # noqa: BLE001, S110 - close is best-effort
            pass
        logger.warning("lsp evicted wedged server lang=%s root=%s", lang, self._root)
        return True

    def _client_for(self, abs_path: str) -> Any | None:
        """Return the cached client for a file, starting its server in background."""
        lang = self._resolve_language(abs_path)
        if lang is None:
            return None
        if self.is_disabled(lang):
            return None
        with self._lock:
            client = self._clients.get(lang)
            if client is not None:
                if self._is_alive(client):
                    self._touch(lang)
                    return client
                try:
                    self._clients.pop(lang, None)
                except Exception:  # noqa: BLE001 - pop never fails
                    pass
        # Fast fail when a background start is already in progress: the
        # tool call returns immediately with a starting status instead of
        # queueing behind a 25s initialize handshake.
        try:
            with _STARTING_LOCK:
                _evt = _STARTING.get((self._root, str(lang)))
            if _evt is not None and not _evt.is_set():
                return None
        except Exception:  # noqa: BLE001 - check never fails
            pass
        with self._lang_lock_for(lang):
            with self._lock:
                client = self._clients.get(lang)
                if client is not None:
                    if self._is_alive(client):
                        self._touch(lang)
                        return client
                    try:
                        self._clients.pop(lang, None)
                    except Exception:  # noqa: BLE001 - pop never fails
                        pass
            try:
                with _STARTING_LOCK:
                    _evt2 = _STARTING.get((self._root, str(lang)))
                if _evt2 is not None and not _evt2.is_set():
                    return None
            except Exception:  # noqa: BLE001 - check never fails
                pass
            try:
                failed_at = self._start_failed_at.get(lang)
                if failed_at is not None and time.monotonic() - float(failed_at) < _LSP_START_FAIL_TTL:
                    return None
            except Exception:  # noqa: BLE001 - cache check never fails
                pass
            cmd = self.command_for(abs_path)
            if cmd is None:
                return None
            # Test seam stays synchronous so unit tests stay deterministic.
            if self._starter is not None:
                try:
                    client = self._starter(lang, cmd, self._root)
                except Exception as exc:  # noqa: BLE001 - starter failure is cached
                    logger.warning("lsp start failed lang=%s cmd=%s: %s", lang, " ".join(cmd), exc)
                    try:
                        self._start_failed_at[lang] = time.monotonic()
                    except Exception:  # noqa: BLE001 - stamp never fails
                        pass
                    return None
                with self._lock:
                    self._clients[lang] = client
                self._touch(lang)
                logger.warning("lsp started lang=%s cmd=%s", lang, " ".join(cmd))
                return client
            # Real servers start in a daemon thread: first call returns None
            # immediately (starting status), later calls hit the cache.
            try:
                with _STARTING_LOCK:
                    _existing = _STARTING.get((self._root, str(lang)))
                    if _existing is not None and not _existing.is_set():
                        return None
                    _done = threading.Event()
                    _STARTING[(self._root, str(lang))] = _done
            except Exception:  # noqa: BLE001 - event setup never fails
                return None
            _cmd = list(cmd)
            _env = self.effective_env(lang)
            _init = self.effective_initialization(lang)
            _timeout = self._timeout
            _root = self._root
            def _run_start() -> None:
                try:
                    _client = _LspClient(_cmd, _root, _timeout, env=_env, initialization=_init)
                except LspError as exc:
                    logger.warning("lsp start failed lang=%s cmd=%s: %s", lang, " ".join(_cmd), exc)
                    try:
                        self._start_failed_at[lang] = time.monotonic()
                    except Exception:  # noqa: BLE001 - stamp never fails
                        pass
                    try:
                        _done.set()
                    except Exception:  # noqa: BLE001 - set never fails
                        pass
                    return
                with self._lock:
                    self._clients[lang] = _client
                self._touch(lang)
                logger.warning("lsp started lang=%s cmd=%s", lang, " ".join(_cmd))
                try:
                    self._sweep_idle()
                except Exception:  # noqa: BLE001 - sweep never breaks startup
                    pass
                try:
                    self._maybe_auto_update(lang)
                except Exception:  # noqa: BLE001 - update never breaks startup
                    pass
                try:
                    _done.set()
                except Exception:  # noqa: BLE001 - set never fails
                    pass
            try:
                _notify_progress(str(lang), "starting", f"starting language server for {lang}...")
                _t = threading.Thread(target=_run_start, daemon=True)
                _t.start()
            except Exception:  # noqa: BLE001 - spawn never breaks tools
                try:
                    _done.set()
                except Exception:  # noqa: BLE001 - set never fails
                    pass
            return None

    def _uri(self, abs_path: str) -> str:
        return "file://" + urllib.parse.quote(os.path.abspath(abs_path))

    def _rel(self, uri: str) -> str:
        path = urllib.parse.unquote(str(uri).removeprefix("file://"))
        try:
            return os.path.relpath(path, self._root).replace(os.sep, "/")
        except ValueError:
            return path

    def _did_open(self, client: Any, abs_path: str) -> str:
        """Sync the file to the server; didOpen once, didChange afterwards."""
        uri = self._uri(abs_path)
        try:
            stat = os.stat(abs_path)
            meta = (stat.st_mtime, stat.st_size)
        except OSError:
            return uri
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read(_LSP_MAX_BYTES + 1)[:_LSP_MAX_BYTES]
        except OSError:
            return uri
        suffix = os.path.splitext(abs_path)[1].lower()
        lang_id = _SUFFIX_TO_LANGUAGE_ID.get(suffix) or self._resolve_language(abs_path) or "plaintext"
        reg_lang = self._resolve_language(abs_path)
        reset = getattr(client, "reset_diagnostics", None)
        evict_uri: str | None = None
        with self._sync_lock:
            version = self._open_versions.get(uri)
            first_open = version is None
            if not first_open and self._open_meta.get(uri) == meta:
                return uri
            if first_open and len(self._open_versions) >= _LSP_MAX_OPEN_FILES:
                evict_uri = next(iter(self._open_versions))
                self._open_versions.pop(evict_uri, None)
                self._open_meta.pop(evict_uri, None)
                self._uri_lang.pop(evict_uri, None)
            next_version = 1 if first_open else int(version or 0) + 1
            self._open_versions[uri] = next_version
            self._open_meta[uri] = meta
            if reg_lang is not None:
                self._uri_lang[uri] = reg_lang
            if callable(reset):
                try:
                    reset(uri)
                except Exception:  # noqa: BLE001, S110 - arming is best-effort
                    pass
            try:
                if first_open:
                    client.notify(
                        "textDocument/didOpen",
                        {
                            "textDocument": {
                                "uri": uri,
                                "languageId": lang_id,
                                "version": next_version,
                                "text": text,
                            }
                        },
                    )
                else:
                    client.notify(
                        "textDocument/didChange",
                        {
                            "textDocument": {"uri": uri, "version": next_version},
                            "contentChanges": [{"text": text}],
                        },
                    )
            except Exception:  # noqa: BLE001, S110 - sync is best-effort
                pass
        if evict_uri is not None:
            try:
                self._evict_uri(evict_uri)
            except Exception:  # noqa: BLE001, S110 - eviction is best-effort
                pass
        return uri

    def did_close(self, abs_path: str) -> None:
        """Send textDocument/didClose for a file and drop its version."""
        uri = self._uri(abs_path)
        with self._sync_lock:
            self._open_versions.pop(uri, None)
            self._open_meta.pop(uri, None)
            self._uri_lang.pop(uri, None)
        lang = self._resolve_language(abs_path)
        if lang is None:
            return
        with self._lock:
            client = self._clients.get(lang)
        if client is None:
            return
        try:
            client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        except Exception:  # noqa: BLE001, S110 - close is best-effort
            pass

    def notify_change(self, abs_path: str) -> None:
        """Re-sync an edited file so the server never serves stale content."""
        with self._lock:
            clients = dict(self._clients)
        if not clients:
            return
        lang = self._resolve_language(abs_path)
        if lang is None:
            return
        client = clients.get(lang)
        if client is None:
            return
        self._touch(lang)
        self._did_open(client, abs_path)

    @staticmethod
    def _as_locations(result: Any) -> list[dict]:
        if result is None:
            return []
        items = result if isinstance(result, list) else [result]
        return [loc for loc in items if isinstance(loc, dict)]

    def _hit(self, loc: dict) -> dict:
        uri = str(loc.get("uri", loc.get("targetUri", "")))
        rng = loc.get("range", loc.get("targetRange", {}))
        if not isinstance(rng, dict):
            rng = {}
        start = rng.get("start", {}) if isinstance(rng.get("start"), dict) else {}
        end = rng.get("end", {}) if isinstance(rng.get("end"), dict) else {}
        return {
            "path": self._rel(uri),
            "line": int(start.get("line", 0)) + 1,
            "character": int(start.get("character", 0)),
            "endLine": int(end.get("line", 0)) + 1,
        }

    def _clamp_position(self, abs_path: str, line1: int, char1: int) -> tuple[int, int]:
        """Clamp a 1-based line / 0-based character position to file text.

        Reads the file (up to the sync cap) and clamps the character to the
        target line length so tsserver never sees an out-of-bounds position
        (which raises a Debug Failure in computePositionOfLineAndCharacter).
        Raises LspError with a clear message when the line is out of range
        or the position is not numeric. Returns the 0-based pair to send.
        """
        try:
            line_num = int(line1)
        except (TypeError, ValueError):
            raise LspError(
                f"invalid position: line={line1!r} character={char1!r}", kind="error"
            ) from None
        try:
            char_num = int(char1)
        except (TypeError, ValueError):
            raise LspError(
                f"invalid position: line={line1!r} character={char1!r}", kind="error"
            ) from None
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read(_LSP_MAX_BYTES + 1)[:_LSP_MAX_BYTES]
        except OSError:
            # File unreadable: sanitize without clamping so callers still
            # send a non-negative position instead of crashing the server.
            return (max(0, line_num - 1), max(0, char_num))
        if text == "":
            line_lengths = [0]
        else:
            raw_lines = text.split("\n")
            line_lengths = [
                len(ln[:-1]) if ln.endswith("\r") else len(ln) for ln in raw_lines
            ]
        line_count = len(line_lengths)
        if line_num < 1 or line_num > line_count:
            raise LspError(
                f"position out of range: line {line_num} out of range "
                f"1..{line_count} for {abs_path}",
                kind="error",
            )
        line0 = line_num - 1
        clamped_char = max(0, min(char_num, line_lengths[line0]))
        return (line0, clamped_char)

    def definition(self, abs_path: str, line1: int, char1: int = 0) -> list[dict]:
        """Definition locations for a 1-based line / 0-based character position.

        Raises LspError when no server is available (unsupported/disabled/
        missing binary/start failure) or when the request times out or the
        server died; returns [] only when the server answered with no
        locations (a genuine empty result).
        """
        line0, char0 = self._clamp_position(abs_path, line1, char1)
        sig = self._file_sig(abs_path)
        key = ("definition", abs_path, sig[0], sig[1], int(line0 + 1), int(char0))
        cached = self._cache_get(key)
        if isinstance(cached, list):
            return [dict(h) for h in cached]
        client = self._client_for(abs_path)
        if client is None:
            raise LspError(f"no server for {abs_path}: {self._absent_reason(abs_path)}", kind="missing")
        uri = self._did_open(client, abs_path)
        try:
            result = client.request(
                "textDocument/definition",
                {
                    "textDocument": {"uri": uri},
                    "position": {"line": line0, "character": char0},
                },
                timeout=self._timeout,
            )
        except LspError as exc:
            raise LspError(str(exc), kind=classify_lsp_error(exc)) from exc
        hits = [self._hit(loc) for loc in self._as_locations(result)]
        hits.sort(key=lambda h: (h["path"], h["line"], h["character"]))
        self._cache_put(key, [dict(h) for h in hits])
        return hits

    def references(self, abs_path: str, line1: int, char1: int = 0) -> list[dict]:
        """Reference locations (including the declaration) for a position.

        Raises LspError on timeout/dead/missing server; returns [] only when
        the server answered with no locations (a genuine empty result).
        """
        line0, char0 = self._clamp_position(abs_path, line1, char1)
        sig = self._file_sig(abs_path)
        key = ("references", abs_path, sig[0], sig[1], int(line0 + 1), int(char0))
        cached = self._cache_get(key)
        if isinstance(cached, list):
            return [dict(h) for h in cached]
        client = self._client_for(abs_path)
        if client is None:
            raise LspError(f"no server for {abs_path}: {self._absent_reason(abs_path)}", kind="missing")
        uri = self._did_open(client, abs_path)
        try:
            result = client.request(
                "textDocument/references",
                {
                    "textDocument": {"uri": uri},
                    "position": {"line": line0, "character": char0},
                    "context": {"includeDeclaration": True},
                },
                timeout=self._timeout,
            )
        except LspError as exc:
            raise LspError(str(exc), kind=classify_lsp_error(exc)) from exc
        hits = [self._hit(loc) for loc in self._as_locations(result)]
        hits.sort(key=lambda h: (h["path"], h["line"], h["character"]))
        self._cache_put(key, [dict(h) for h in hits])
        return hits

    def hover(self, abs_path: str, line1: int, char1: int = 0) -> str:
        """Hover text for a position; empty only when the server answered empty.

        Raises LspError on timeout/dead/missing server.
        """
        line0, char0 = self._clamp_position(abs_path, line1, char1)
        sig = self._file_sig(abs_path)
        key = ("hover", abs_path, sig[0], sig[1], int(line0 + 1), int(char0))
        cached = self._cache_get(key)
        if isinstance(cached, str):
            return cached
        client = self._client_for(abs_path)
        if client is None:
            raise LspError(f"no server for {abs_path}: {self._absent_reason(abs_path)}", kind="missing")
        uri = self._did_open(client, abs_path)
        try:
            result = client.request(
                "textDocument/hover",
                {
                    "textDocument": {"uri": uri},
                    "position": {"line": line0, "character": char0},
                },
                timeout=self._timeout,
            )
        except LspError as exc:
            raise LspError(str(exc), kind=classify_lsp_error(exc)) from exc
        if not isinstance(result, dict):
            self._cache_put(key, "")
            return ""
        contents = result.get("contents")
        if isinstance(contents, str):
            self._cache_put(key, contents)
            return contents
        if isinstance(contents, dict):
            value = str(contents.get("value", ""))
            self._cache_put(key, value)
            return value
        if isinstance(contents, list):
            parts: list[str] = []
            for item in contents:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and item.get("value"):
                    parts.append(str(item["value"]))
            text = "\n".join(parts)
            self._cache_put(key, text)
            return text
        self._cache_put(key, "")
        return ""

    def document_symbols(self, abs_path: str) -> dict[str, tuple[int, int, str]]:
        """Map symbol name -> (start1, end1, kind) for one file.

        Raises LspError on timeout/dead/missing server; returns {} only when
        the server answered with no symbols. Background callers that must not
        start a server use document_symbols_if_running instead.
        """
        sig = self._file_sig(abs_path)
        key = ("document_symbols", abs_path, sig[0], sig[1])
        cached = self._cache_get(key)
        if isinstance(cached, dict):
            return dict(cached)
        client = self._client_for(abs_path)
        if client is None:
            raise LspError(f"no server for {abs_path}: {self._absent_reason(abs_path)}", kind="missing")
        uri = self._did_open(client, abs_path)
        try:
            result = client.request(
                "textDocument/documentSymbol",
                {"textDocument": {"uri": uri}},
                timeout=self._timeout,
            )
        except LspError as exc:
            raise LspError(str(exc), kind=classify_lsp_error(exc)) from exc
        out: dict[str, tuple[int, int, str]] = {}

        def _collect(items: Any, parent: str = "") -> None:
            if not isinstance(items, list):
                return
            for item in items:
                if not isinstance(item, dict):
                    continue
                loc = item.get("location")
                rng = loc.get("range") if isinstance(loc, dict) else item.get("range")
                if not isinstance(rng, dict):
                    continue
                start = rng.get("start", {})
                end = rng.get("end", {})
                if not isinstance(start, dict) or not isinstance(end, dict):
                    continue
                name = str(item.get("name", ""))
                if not name:
                    _collect(item.get("children"), parent)
                    continue
                # Qualify nested names with the parent so duplicate
                # __init__ / render symbols from different classes survive.
                qualified = f"{parent}.{name}" if parent else name
                try:
                    value = (
                        int(start.get("line", 0)) + 1,
                        int(end.get("line", 0)) + 1,
                        _kind_label(item.get("kind")),
                    )
                except (TypeError, ValueError):
                    _collect(item.get("children"), qualified)
                    continue
                key_name = qualified
                suffix_n = 2
                while key_name in out:
                    key_name = f"{qualified}#{suffix_n}"
                    suffix_n += 1
                out[key_name] = value
                if name != qualified:
                    plain_key = name
                    suffix_p = 2
                    while plain_key in out:
                        plain_key = f"{name}#{suffix_p}"
                        suffix_p += 1
                    out[plain_key] = value
                _collect(item.get("children"), qualified)

        _collect(result)
        self._cache_put(key, dict(out))
        return out

    def symbol_ranges(
        self, abs_path: str, names: list[str]
    ) -> tuple[list[tuple[int, int]], list[str]]:
        """Split symbol names into ([(start1, line_count)], [missing])."""
        try:
            syms = self.document_symbols(abs_path)
        except LspError:
            syms = {}
            # Local AST fallback for Python when no server is running
            # (tests, missing binary, starting server): keeps read(symbols=)
            # fast and deterministic without waiting on LSP.
            try:
                if str(abs_path or "").endswith(".py"):
                    import ast as _ast

                    with open(abs_path, "r", encoding="utf-8", errors="replace") as _fh:
                        _tree = _ast.parse(_fh.read())
                    _local: dict[str, tuple[int, int, str]] = {}
                    for _nd in _ast.walk(_tree):
                        if isinstance(_nd, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                            _e = int(getattr(_nd, "end_lineno", 0) or 0) or _nd.lineno
                            _local.setdefault(_nd.name, (_nd.lineno, _e, "function"))
                        elif isinstance(_nd, _ast.ClassDef):
                            _e2 = int(getattr(_nd, "end_lineno", 0) or 0) or _nd.lineno
                            _local.setdefault(_nd.name, (_nd.lineno, _e2, "class"))
                    if _local:
                        syms = dict(_local)
            except Exception:  # noqa: BLE001 - fallback never breaks symbols
                syms = {}
            if not syms:
                return [], [str(n) for n in names or []]
        lower = {k.lower(): (k, v) for k, v in syms.items()}
        windows: list[tuple[int, int]] = []
        missing: list[str] = []
        for name in names or []:
            hit = lower.get(str(name).strip().lower())
            if hit is None:
                missing.append(str(name))
            else:
                start, end, _ = hit[1]
                windows.append((max(1, start), max(1, end - start + 1)))
        return windows, missing

    def find_symbols(
        self, names: list[str]
    ) -> dict[str, list[tuple[str, int, str, str]]]:
        """Workspace-wide symbol search across started servers (no disk scan).

        Only servers already running are queried; when nothing has started
        yet every name maps to [] so the caller can steer to lsp_symbols/grep.
        """
        wanted = [str(n).strip() for n in (names or []) if str(n).strip()]
        out: dict[str, list[tuple[str, int, str, str]]] = {n: [] for n in wanted}
        if not wanted:
            return out
        with self._lock:
            clients = list(self._clients.values())
        for client in clients:
            caps = getattr(client, "capabilities", {}) or {}
            if caps and not caps.get("workspaceSymbolProvider"):
                continue
            for name in wanted:
                try:
                    result = client.request(
                        "workspace/symbol", {"query": name}, timeout=self._timeout
                    )
                except LspError:
                    continue
                items = result if isinstance(result, list) else []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    loc = item.get("location") or {}
                    uri = str(loc.get("uri", "")) if isinstance(loc, dict) else ""
                    rng = loc.get("range", {}) if isinstance(loc, dict) else {}
                    start = rng.get("start", {}) if isinstance(rng, dict) else {}
                    real = str(item.get("name", ""))
                    if not uri or not real:
                        continue
                    try:
                        line1 = int(start.get("line", 0)) + 1
                    except (TypeError, ValueError):
                        line1 = 1
                    out[name].append((self._rel(uri), line1, _kind_label(item.get("kind")), real))
        for name, hits in out.items():
            seen: set[tuple[str, int, str]] = set()
            unique: list[tuple[str, int, str, str]] = []
            for h in hits:
                sig_key = (h[0], h[1], h[3])
                if sig_key not in seen:
                    seen.add(sig_key)
                    unique.append(h)
            # workspace/symbol is fuzzy: prefer exact matches so a unique
            # name is not reported as ambiguous because of fuzzy neighbors.
            exact = [h for h in unique if h[3] == name]
            if exact:
                unique = exact
            else:
                lowered = name.lower()
                ci = [h for h in unique if h[3].lower() == lowered]
                unique = ci if ci else []
            unique.sort(key=lambda h: (h[0], h[1]))
            out[name] = unique
        return out

    def diagnostics(self, abs_path: str) -> list[dict]:
        """Diagnostics for a file: pull when supported, else last pushed batch.

        Raises LspError when no server is available or the pull fails with
        no pushed batch; returns [] only for a genuine empty result.
        """
        client = self._client_for(abs_path)
        if client is None:
            raise LspError(f"no server for {abs_path}: {self._absent_reason(abs_path)}", kind="missing")
        uri = self._did_open(client, abs_path)
        # Wait briefly for fresh publishDiagnostics after the sync above;
        # _did_open re-armed the per-file event so this waits for the new
        # batch, not a stale one.
        wait_for = getattr(client, "wait_for_diagnostics", None)
        fresh: list[dict] = []
        arrived = False
        if callable(wait_for):
            try:
                fresh, arrived = wait_for(uri, _LSP_DIAG_WAIT)
                fresh = [d for d in fresh if isinstance(d, dict)]
            except Exception:  # noqa: BLE001 - wait never fails
                fresh, arrived = [], False
        caps = getattr(client, "capabilities", {}) or {}
        # Per LSP spec pull requires an advertised diagnosticProvider;
        # empty/unknown capabilities means use pushed diagnostics only.
        supports_pull = bool(caps.get("diagnosticProvider"))
        items: list[dict] = []
        failed: BaseException | None = None
        if not supports_pull:
            if arrived:
                items = fresh
            elif fresh:
                items = fresh
            else:
                pushed = getattr(client, "published_diagnostics", None)
                if callable(pushed):
                    try:
                        got = pushed(uri)
                        items = [d for d in got if isinstance(d, dict)]
                    except Exception:  # noqa: BLE001, S110 - diagnostics are best-effort
                        items = []
        else:
            try:
                result = client.request(
                    "textDocument/diagnostic",
                    {"textDocument": {"uri": uri}},
                    timeout=self._timeout,
                )
                if isinstance(result, dict) and isinstance(result.get("items"), list):
                    items = [d for d in result["items"] if isinstance(d, dict)]
            except Exception as exc:  # noqa: BLE001 - any pull failure falls back to pushed
                failed = exc
                # A fresh push is authoritative even when empty (clean file).
                if arrived:
                    items = fresh
                elif fresh:
                    items = fresh
                else:
                    pushed = getattr(client, "published_diagnostics", None)
                    if callable(pushed):
                        try:
                            got = pushed(uri)
                            items = [d for d in got if isinstance(d, dict)]
                        except Exception:  # noqa: BLE001, S110 - diagnostics are best-effort
                            items = []
        if failed is not None and not items:
            # Pull unsupported (e.g. -32601 Unhandled method): the server
            # never implements pull; pushed (possibly empty) is the answer.
            # Return [] instead of an ERROR card so the model does not burn
            # a retry round-trip.
            _failed_text = str(failed).lower()
            if "32601" in _failed_text or "unhandled method" in _failed_text or "method not found" in _failed_text:
                return []
            if not arrived:
                raise LspError(
                    f"{abs_path}: diagnostics unknown (server did not publish yet)",
                    kind="unknown",
                ) from failed
            raise LspError(str(failed), kind=classify_lsp_error(failed)) from failed
        rel = self._rel(uri)
        out: list[dict] = []
        for diag in items:
            rng = diag.get("range") if isinstance(diag.get("range"), dict) else {}
            start = rng.get("start", {}) if isinstance(rng, dict) else {}
            try:
                line1 = int(start.get("line", 0)) + 1
            except (TypeError, ValueError):
                line1 = 1
            try:
                sev = _DIAGNOSTIC_SEVERITY.get(int(diag.get("severity", 2)), "info")
            except (TypeError, ValueError):
                sev = "info"
            out.append(
                {
                    "path": rel,
                    "line": line1,
                    "severity": sev,
                    "message": str(diag.get("message", "")),
                    "source": str(diag.get("source", "")),
                }
            )
        out.sort(key=lambda d: (d["line"], d["severity"]))
        return out


_MANAGERS: dict[str, LspManager] = {}
_MANAGERS_LOCK = threading.Lock()


def get_manager(
    root: str,
    timeout: float = LSP_TIMEOUT,
    lsp_config: dict | None = None,
) -> LspManager:
    """Shared manager per workspace root (servers start lazily on first use)."""
    key = os.path.realpath(os.path.abspath(root))
    with _MANAGERS_LOCK:
        mgr = _MANAGERS.get(key)
        if mgr is None:
            mgr = LspManager(key, timeout=timeout, lsp_config=lsp_config)
            _MANAGERS[key] = mgr
        elif isinstance(lsp_config, dict) and lsp_config:
            try:
                mgr._lsp_config.update(lsp_config)
            except Exception:  # noqa: BLE001 - config merge never fails
                pass
        return mgr


def shutdown(root: str) -> None:
    """Stop servers for a workspace root and drop its manager."""
    key = os.path.realpath(os.path.abspath(root))
    with _MANAGERS_LOCK:
        mgr = _MANAGERS.pop(key, None)
    if mgr is not None:
        try:
            mgr.shutdown()
        except Exception:  # noqa: BLE001, S110 - shutdown is best-effort
            pass


def get_status(root: str, lsp_config: dict | None = None) -> dict:
    """Lazy manager status: started servers, missing binaries, hints."""
    import shutil as _shutil

    key = os.path.realpath(os.path.abspath(root))
    with _MANAGERS_LOCK:
        mgr = _MANAGERS.get(key)
        started = sorted(mgr._clients.keys()) if mgr is not None else []
    extra: dict = dict(lsp_config) if isinstance(lsp_config, dict) else {}
    if mgr is not None and isinstance(getattr(mgr, "_lsp_config", None), dict):
        for k, v in mgr._lsp_config.items():
            if k not in extra and isinstance(v, dict):
                extra[k] = v
    with _LSP_CONFIG_LOCK:
        for k, v in _LSP_CONFIG.items():
            if k not in extra and isinstance(v, dict):
                extra[k] = v
    langs = sorted(set(LANGUAGE_SERVERS) | {k for k, v in extra.items() if isinstance(v, dict) and v.get("command")})
    servers: dict[str, dict] = {}
    for lang in langs:
        base = LANGUAGE_SERVERS.get(lang) or []
        cfg = extra.get(lang) if isinstance(extra.get(lang), dict) else {}
        custom = cfg.get("command") if isinstance(cfg, dict) else None
        if isinstance(custom, list) and custom:
            cmd = [str(c) for c in custom]
        else:
            cmd = list(base)
        binary = cmd[0] if cmd else ""
        disabled = bool(isinstance(cfg, dict) and cfg.get("disabled", False))
        available = bool(binary and _shutil.which(binary)) and not disabled
        entry: dict = {
            "command": list(cmd),
            "available": available,
            "started": lang in started,
            "disabled": disabled,
        }
        if not available and not disabled:
            entry["install"] = INSTALL_HINTS.get(lang, "")
        if lang not in LANGUAGE_SERVERS:
            entry["custom"] = True
        servers[lang] = entry
    return {"available": True, "root": key, "started": started, "servers": servers}
