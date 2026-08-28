"""Incremental workspace file indexing into the vector store (mtime+size + SHA-256).

The agent's file tools (glob / grep / read) already see the live tree, so this indexer is NOT for navigation — it feeds the RAG
retrieval engine (``retrieval.py`` / ``context_builder.py``) so the agent can
auto-recall *relevant project files* for the current prompt without a
workspace-wide search.

Design notes:

* **Content hashing.** Change detection starts with ``mtime + size`` (cheap, no
  full-file reads). When those match the DB record the file is skipped. When
  either changed the file is read, hashed (SHA-256) and re-indexed — so a
  build-tool touch that changes mtime but not content is caught and skipped.
* **Incremental by design.** Each run walks the tree (fast: stat only), diffs
  against the docs already in the store (``all_doc_meta``), and touches only
  new / changed / deleted files. An unchanged large repo costs a stat() walk
  and zero embeddings.
* **Bounded per run.** ``budget`` caps how many documents are embedded per call
  so a cold first index (or a huge repo) never stalls the agent's startup;
  remaining files are picked up on later runs.
* **Only text files are indexed.** Binary extensions and known junk/third-party
  dirs are skipped (same list as the file tools), plus a per-file size cap.

Files are stored as ``kind=file`` docs with key ``file:<relpath>`` and the
metadata the store already carries (file_path, mtime, file_size, language,
content_hash), so ``exact_lookup`` on a path finds them and the retrieval
engine can map a hit back to a real file.
"""

from __future__ import annotations

import hashlib
import os
import re

# Reuse the file tools' text-extension / skip-dir lists so the indexer and the
# agent's own navigation agree on what is a code file.
from tools import _BINARY_EXTENSIONS, _SKIP_DIRS, _TEXT_EXTENSIONS, MAX_FILES
from vector_store import KIND_FILE, VectorStore

INDEX_MAX_FILE_BYTES = 2_000_000  # per-file cap: don't embed giant files
INDEX_CHUNK_CHARS = 1_200  # target chars per embedded chunk
INDEX_CHUNK_OVERLAP = 120  # overlap so symbol boundaries don't split meaning

# Language label per extension (best effort; used for display + retrieval).
_LANGUAGE_BY_EXT = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".json": "json", ".jsonc": "json",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown",
    ".mdx": "markdown", ".txt": "text", ".html": "html", ".css": "css",
    ".scss": "scss", ".less": "less", ".vue": "vue", ".svelte": "svelte",
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin",
    ".swift": "swift", ".rb": "ruby", ".php": "php", ".sh": "bash",
    ".bash": "bash", ".zsh": "bash", ".fish": "fish", ".sql": "sql",
    ".xml": "xml", ".ini": "ini", ".cfg": "ini", ".conf": "ini",
    ".env": "dotenv", ".csv": "csv", ".tsv": "csv", ".ipynb": "jupyter",
}

_REL_SKIP_PATTERNS = [
    # package-manager lockfiles and generated files are noise for RAG
    re.compile(r"(^|/)package-lock\.json$"),
    re.compile(r"(^|/)pnpm-lock\.yaml$"),
    re.compile(r"(^|/)yarn\.lock$"),
    re.compile(r"(^|/)uv\.lock$"),
    re.compile(r"(^|/)poetry\.lock$"),
    re.compile(r"(^|/)Cargo\.lock$"),
    re.compile(r"(^|/)go\.sum$"),
    re.compile(r"(^|/)\.env\.local$"),
    re.compile(r"(^|/)\.env\.production$"),
    re.compile(r"(^|/)coverage\.xml$"),
    # AGENTS.md is already injected IN FULL into every system prompt via
    # _load_project_memory (agents.py) — indexing it would surface its chunks
    # again through the RAG file block, duplicating the same content.
    re.compile(r"(^|/)AGENTS\.md$"),
]


def should_index(rel_path: str, size: int | None = None) -> bool:
    """True when ``rel_path`` (posix, relative to root) is worth indexing."""
    if not rel_path or rel_path.startswith("../") or "/../" in rel_path:
        return False
    name = os.path.basename(rel_path)
    if name.startswith(".") and name not in (".env", ".gitignore", ".dockerignore"):
        return False
    ext = os.path.splitext(name)[1].lower()
    if ext in _BINARY_EXTENSIONS:
        return False
    if ext not in _TEXT_EXTENSIONS:
        # No known extension: only index if it looks textual (no NUL bytes).
        # Cheap heuristic: skip unknown extensions entirely unless tiny.
        return False
    if size is not None and size > INDEX_MAX_FILE_BYTES:
        return False
    return not any(p.search(rel_path) for p in _REL_SKIP_PATTERNS)


def scan_workspace(root: str, max_files: int = MAX_FILES) -> list[dict]:
    """Walk ``root`` and return stat info for every indexable text file.

    Returns ``[{"rel": "src/main.py", "abs": "/…/src/main.py", "mtime": float,
    "size": int}]`` sorted by path (stable order → deterministic budgets).
    """
    root_real = os.path.realpath(os.path.abspath(root))
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root_real):
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in _SKIP_DIRS
        ]
        for name in filenames:
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root_real).replace(os.sep, "/")
            if not should_index(rel):
                continue
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            if not st.st_size or not should_index(rel, st.st_size):
                continue
            out.append(
                {"rel": rel, "abs": abs_path,
                 "mtime": float(st.st_mtime), "size": int(st.st_size)}
            )
            if len(out) >= max_files:
                break
        if len(out) >= max_files:
            break
    out.sort(key=lambda f: f["rel"])
    return out


def _chunk_text(text: str, size: int = INDEX_CHUNK_CHARS,
                overlap: int = INDEX_CHUNK_OVERLAP) -> list[str]:
    """Split file text into overlapping chunks on line boundaries."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []
    if len(text) <= size:
        return [text]
    lines = text.split("\n")
    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for line in lines:
        if buf and buf_len + len(line) + 1 > size:
            chunk = "\n".join(buf)
            chunks.append(chunk)
            # carry the tail as overlap
            tail = chunk[-overlap:].lstrip("\n")
            buf = [tail] if tail else []
            buf_len = len(tail)
        buf.append(line)
        buf_len += len(line) + 1
    if buf:
        chunks.append("\n".join(buf))
    return [c for c in chunks if c.strip()]


# Languages whose content is NOT embedded — only symbol/location pointers
# are stored (the "code map" design): the file is the source of truth, the
# index records what-is-where, and content_hash invalidates stale pointers
# when the code changes.
#
# توجه: auto-index کد خاموش شده (نگاه کن به پایین `AUTO_INDEX_CODE`). کد
# پروژه از طریق CODE MAP (نقشه نماد لحظه‌ای در symbol_index.py) به مدل داده
# می‌شه، نه از طریق ایندکس RAG. این باعث می‌شه context سبک‌تر بمونه و مدل
# مستقیماً بره سراغ read.

# آیا ایندکس خودکار کد فعال باشه؟ (خاموش — کد از طریق CODE MAP تزریق می‌شه)
AUTO_INDEX_CODE = False
_CODE_LANGUAGES = {
    "python", "javascript", "typescript", "jsx", "tsx", "vue", "svelte",
    "go", "rust", "java", "kotlin", "swift", "ruby", "php", "c", "cpp",
    "csharp", "bash", "fish", "sql", "scss", "less",
}

# Words that never start a symbol definition (avoid false positives like
# "return foo(" or "if (x)").
_SYMBOL_STOPWORDS = {
    "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
    "instanceof", "new", "delete", "throw", "try", "except", "elif", "assert",
    "import", "from", "include", "define", "require", "using", "namespace",
    "package", "module", "case", "default", "break", "continue", "yield",
    "await", "async", "raise", "with", "lambda", "del", "pass", "global",
    "nonlocal", "self", "this", "super", "in", "of", "as", "is", "not", "and",
    "or", "None", "True", "False", "void", "int", "char", "float", "double",
    "bool", "string", "long", "short", "byte", "auto", "const", "let", "var",
    "val", "fun", "func", "def", "function", "class", "struct", "interface",
    "enum", "trait", "impl", "type", "object", "extension", "public",
    "private", "protected", "internal", "static", "final", "abstract",
    "sealed", "data", "export", "readonly", "extern", "virtual", "partial",
    "unsafe", "fixed", "template", "typename", "unsigned", "signed",
    "register", "inline", "volatile", "mutable", "explicit", "friend",
    "noexcept", "finally",
}


def _extract_symbols(text: str, language: str) -> list[dict]:
    """Best-effort symbol extraction (functions/classes/types) with line ranges.

    Returns ``[{"name", "type", "start", "end"}]`` (1-based lines). Regex based
    on purpose — no full parser — and the index is only a pointer, so a miss
    just means the file falls back to a single location chunk.
    """
    lines = text.split("\n")
    patterns: list[tuple[re.Pattern, str]] = []
    if language == "python":
        patterns = [
            (re.compile(r"^(?:async\s+)?def\s+([A-Za-z_]\w*)"), "function"),
            (re.compile(r"^class\s+([A-Za-z_]\w*)"), "class"),
        ]
    elif language in ("javascript", "typescript", "jsx", "tsx", "vue", "svelte"):
        patterns = [
            (re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$]\w*)"), "function"),
            (re.compile(r"^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$]\w*)"), "class"),
            (re.compile(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>)"), "function"),
            (re.compile(r"^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$]\w*)"), "type"),
        ]
    elif language == "go":
        patterns = [
            (re.compile(r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"), "function"),
            (re.compile(r"^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)"), "type"),
        ]
    elif language == "rust":
        patterns = [
            (re.compile(r"^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"), "function"),
            (re.compile(r"^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)"), "type"),
        ]
    elif language in ("java", "kotlin", "c", "cpp", "csharp", "swift", "php", "ruby"):
        patterns = [
            (re.compile(r"^\s*(?:[\w<>\[\],\s]+?)\s+([A-Za-z_]\w*)\s*\("), "function"),
            (re.compile(r"^\s*(?:class|struct|interface|enum|trait|type|object|impl|extension)\s+([A-Za-z_]\w*)"), "type"),
        ]
    else:
        patterns = [(re.compile(r"^([A-Za-z_][\w$]*)\s*\("), "function")]

    syms: list[dict] = []
    for i, line in enumerate(lines, 1):
        stripped = line.lstrip()
        if not stripped or stripped.startswith(("#", "//", "/*", "*", "<!--", "\"\"\"", "'''")):
            continue
        for pat, typ in patterns:
            m = pat.search(line)
            if not m:
                continue
            name = m.group(1)
            if not name or name in _SYMBOL_STOPWORDS:
                continue
            # C-like / generic patterns: only accept definition-looking lines
            # (a call like "return foo(x);" ends with ';' and is not a def).
            if typ == "function" and language in ("java", "kotlin", "c", "cpp", "csharp", "swift", "php", "ruby"):
                tail = line.rstrip()
                if not tail.endswith(("{", ")", "(")):
                    continue
            indent = len(line) - len(line.lstrip())
            end = i
            for j in range(i + 1, len(lines) + 1):
                l2 = lines[j - 1]
                if not l2.strip():
                    continue
                ind2 = len(l2) - len(l2.lstrip())
                if ind2 <= indent and not l2.lstrip().startswith((")", "]", "}", "else", "elif", "except", "finally", "catch", "case", "default", ";")):
                    break
                end = j
            syms.append({"name": name, "type": typ, "start": i, "end": end})
            break
    return syms


def index_file(store: VectorStore, root: str, info: dict) -> int:
    """Index one file into ``store`` as a ``file`` doc. Returns chunk count.

    ``info`` is one entry from ``scan_workspace``. Never raises: on any error
    the file is simply skipped so one bad file can't break a batch.
    """
    rel = info["rel"]
    try:
        with open(info["abs"], "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read(INDEX_MAX_FILE_BYTES + 1)
    except OSError:
        return 0
    if len(text) > INDEX_MAX_FILE_BYTES:
        text = text[:INDEX_MAX_FILE_BYTES]
    ext = os.path.splitext(rel)[1].lower()
    language = _LANGUAGE_BY_EXT.get(ext, "")
    meta = {
        "source_type": "file",
        "file_path": rel,
        "language": language,
        "mtime": float(info["mtime"]),
        "file_size": int(info["size"]),
        "content_hash": hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24],
    }
    if language in _CODE_LANGUAGES:
        # Code map: store symbol/location POINTERS, not the code body. The file
        # is the source of truth; content_hash invalidates stale pointers when
        # the code changes. Each chunk is a compact "what is where" line.
        syms = _extract_symbols(text, language)
        chunks = [
            f"{s['type']} {s['name']} in {rel} (lines {s['start']}-{s['end']})"
            for s in syms
        ]
        if not chunks:
            chunks = [f"file {rel} ({language})"]
        if syms:
            meta["symbol_name"] = syms[0]["name"]
            meta["symbol_type"] = syms[0]["type"]
            meta["start_line"] = syms[0]["start"]
            meta["end_line"] = syms[0]["end"]
    else:
        # Docs/configs: keep content chunks (useful for RAG; content_hash
        # handles changes).
        chunks = _chunk_text(text)
    if not chunks:
        return 0
    try:
        return store.upsert_doc(f"file:{rel}", KIND_FILE, rel, chunks, meta)
    except Exception:  # noqa: BLE001 — embedder down / db hiccup: skip file
        return 0


def index_workspace(
    store: VectorStore,
    root: str,
    budget: int = 120,
    max_files: int = MAX_FILES,
) -> dict:
    """Incrementally index changed/new files; prune deleted ones.

    One stat-walk + one ``all_doc_meta`` query; embeds at most ``budget``
    documents this run (new/changed first, rest next time). Returns a stats
    dict ``{"total": int, "indexed": int, "pruned": int, "skipped": int,
    "unchanged": int}``. Never raises.

    وقتی ``AUTO_INDEX_CODE`` خاموش باشه (پیش‌فرض فعلی)، فقط اسناد قدیمی
    KIND_FILE رو پاک‌سازی می‌کنه و ایندکس جدیدی نمی‌سازه — چون کد از طریق
    CODE MAP تزریق می‌شه.
    """
    stats = {"total": 0, "indexed": 0, "pruned": 0, "skipped": 0, "unchanged": 0}
    if not AUTO_INDEX_CODE:
        # فقط پاک‌سازی اسناد KIND_FILE قدیمی (اگه موجود باشن)
        try:
            existing = store.all_doc_meta(KIND_FILE)
        except Exception:  # noqa: BLE001
            return stats
        for key in existing:
            if key.startswith("file:"):
                try:
                    store.remove(key)
                    stats["pruned"] += 1
                except Exception:  # noqa: BLE001, S110
                    pass
        return stats
    try:
        scan = scan_workspace(root, max_files)
    except Exception:  # noqa: BLE001
        return stats
    stats["total"] = len(scan)
    try:
        existing = store.all_doc_meta(KIND_FILE)
    except Exception:  # noqa: BLE001
        return stats
    live_keys = {f"file:{f['rel']}" for f in scan}
    try:
        for key in existing:
            if key.startswith("file:") and key not in live_keys:
                try:
                    store.remove(key)
                    stats["pruned"] += 1
                except Exception:  # noqa: BLE001, S110 — best-effort
                    pass
    except Exception:  # noqa: BLE001, S110 — best-effort, never raises
        pass

    for info in scan:
        if stats["indexed"] >= budget:
            break
        key = f"file:{info['rel']}"
        prev = existing.get(key)
        if prev:
            try:
                same_mtime = abs(float(prev.get("mtime") or 0)
                                 - float(info["mtime"])) < 0.001
                same_size = int(prev.get("file_size") or 0) == int(info["size"])
            except (TypeError, ValueError):
                same_mtime = same_size = False
            if same_mtime and same_size:
                stats["unchanged"] += 1
                continue
        count = index_file(store, root, info)
        if count:
            stats["indexed"] += 1
        else:
            stats["skipped"] += 1
    return stats


def needs_index(store: VectorStore, root: str) -> bool:
    """Cheap check: does the workspace have zero ``file`` docs? (first run)"""
    try:
        return store.count_docs(KIND_FILE) == 0
    except Exception:  # noqa: BLE001
        return False


__all__ = [
    "INDEX_MAX_FILE_BYTES",
    "index_file",
    "index_workspace",
    "needs_index",
    "scan_workspace",
    "should_index",
]
