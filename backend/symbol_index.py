"""نقشه‌ی نماد لحظه‌ای (Code Map) — استخراج غنی نمادها به سبک aider.

هدف: کاهش واقعی تعداد فراخوانی‌های ابزار (grep/glob/read) با دادن یک نمای
کلی از محل توابع/کلاس‌ها به مدل، قبل از اولین نوبت. مدل به‌جای جستجوی کورکورانه
در کل پروژه، مستقیماً می‌ره سراغ فایل و خط مشخص (۱ call به‌جای ~۱۲ call).

طراحی (مشابه aider.repomap):
* برای همه‌ی زبان‌های پشتیبانی‌شده از tree-sitter استفاده می‌کنیم تا هم
  تعاریف (def) و هم ارجاعات (ref) رو استخراج کنیم.
* گراف ارجاع می‌سازیم (نود = فایل، یال = ref → def) و با PageRank + personalization
  رتبه‌بندی می‌کنیم — فایل‌هایی که توی چت/تاریخچه ذکر شدن یا بیشترین ارجاع رو
  دارن بالاتر میان (بدون اینکه فایلی کلاً حذف بشه).
* بودجه توکنی پویا (مثل --map-tokens در aider): با binary search روی تعداد
  تگ‌ها، نقشه رو تا نزدیک سقف توکن باز می‌کنیم.
* نمایش فشردهٔ امضا (نام + خط + نوع): بدنهٔ تابع رو نشون نمی‌ده تا بودجهٔ
  توکنی شامل صدها فایل بشه، نه فقط ۱-۲ فایل.
* کش سبک بر اساس mtime+file_count برای جلوگیری از rebuild در هر نوبت.

تفاوت با aider: به‌جای main_model.token_count از تقریب ارزان len//4 استفاده
می‌کنیم (مدل توی این ماژول در دسترس نیست؛ برای binary search بودجه کافیه).
"""

from __future__ import annotations

import ast
import os
import re
import threading
import time
from collections import defaultdict, namedtuple
from typing import Any

import networkx as nx

# پکیج‌های aider-style (نصب‌شده در backend/pyproject.toml).
from grep_ast import filename_to_lang
from grep_ast.tsl import get_language, get_parser
from tree_sitter import Query, QueryCursor


def _looks_like_code_ident(ident: str) -> bool:
    """فیلتر «شبیه identifier کد بودن» — دقیقاً همون معیاری که توی رتبه‌بندی
    PageRank (_get_ranked_tags) استفاده می‌شه، تا استخراج mentioned_idents هم
    سیگنال رو رقیق نکنه (فقط snake_case / camelCase / PascalCase واقعی)."""
    return len(ident) >= 8 and ("_" in ident or "-" in ident or ident != ident.lower())


def rank_with_laya(query: str, candidates: list[dict] | list[str], top_k: int | None = None) -> list[dict]:
    """رتبه‌بندی معنایی با laya rank — امن با fallback به [] در نبود سیگنال."""
    if not query or not str(query).strip() or not candidates:
        return []
    try:
        from laya_decide import rank as _laya_rank

        k = int(top_k) if top_k is not None else len(candidates)  # type: ignore[arg-type]
        return _laya_rank(str(query), candidates, top_k=k)
    except Exception:  # noqa: BLE001 — ranking is best-effort
        return []


# Rerank result cache: (query, files fingerprint) -> (timestamp, file order).
# Repeat turns ("continue", retries) re-rank the same files with the same
# query — without this every one of those turns pays the full ONNX embedding
# cost again (~15s seen in traces). Nothing is ever hidden by the cache: on a
# miss the ranking is recomputed exactly as before. Staleness is bounded by
# _RERANK_CACHE_TTL and by the fingerprint (file add/remove or symbol-count
# changes miss immediately).
_RERANK_CACHE: dict[tuple[str, tuple], tuple[float, list[str]]] = {}
_RERANK_CACHE_LOCK = threading.Lock()
_RERANK_CACHE_TTL = 120.0


def _apply_laya_rerank(
    query: str,
    ranked_tags: list[Tag],
    root_real: str = "",
    rank_info: dict | None = None,
) -> list[Tag]:
    """اعمال laya rank روی فایل‌ها — در نبود سیگنال ترتیب قبلی حفظ می‌شود.

    The embedding rerank runs before the LLM call on every turn, so it must
    stay off the slow path: only the top files by PageRank order are embedded
    (bounded work regardless of repo size) and the rest keep their order.
    Embedding the whole repo (hundreds of files through ONNX on CPU) is what
    made the first token take 10s+ on large workspaces.
    """
    if not query or not str(query).strip() or not ranked_tags:
        return ranked_tags
    # Bound embedding work: rerank at most this many top files, keep the tail
    # in PageRank order. 120 files ≈ 4 ONNX batches — ~1s on CPU instead of 10s+.
    _RERANK_MAX_FILES = 120
    try:
        by_file: dict[str, list[Tag]] = defaultdict(list)
        for t in ranked_tags:
            by_file[t.rel_fname].append(t)
        # by_file preserves first-occurrence order of the PageRank-sorted tags,
        # so candidates are already best-first: head gets embedded, tail stays.
        all_rels = list(by_file.keys())
        head_rels = all_rels[:_RERANK_MAX_FILES]
        candidates: list[dict] = []
        for rel in head_rels:
            tags = by_file[rel]
            desc = " ".join(t.name for t in tags[:20])
            candidates.append({"name": rel, "description": desc})
        _fingerprint = (str(query), tuple(sorted((r, len(by_file[r])) for r in all_rels)))
        with _RERANK_CACHE_LOCK:
            _cached = _RERANK_CACHE.get(_fingerprint)
            if _cached is not None and (time.monotonic() - _cached[0]) < _RERANK_CACHE_TTL:
                _order_names = _cached[1]
                _elapsed = 0
                ranked = [{"name": _n} for _n in _order_names]
            else:
                _cached = None
        if _cached is None:
            _start = time.monotonic()
            ranked = rank_with_laya(str(query), candidates, top_k=len(candidates))
            try:
                _elapsed = int((time.monotonic() - _start) * 1000)
            except Exception:  # noqa: BLE001
                _elapsed = 0
            if ranked:
                with _RERANK_CACHE_LOCK:
                    _RERANK_CACHE[_fingerprint] = (
                        time.monotonic(),
                        [str(r.get("name") or "") for r in ranked],
                    )
        if rank_info is not None:
            try:
                rank_info["ranked"] = ranked
                rank_info["elapsed_ms"] = _elapsed
                rank_info["query"] = str(query)
                rank_info["candidates"] = [str(c.get("name") or "") for c in candidates]
                rank_info["total_files"] = len(all_rels)
            except Exception:  # noqa: BLE001, S110
                pass
        if not ranked:
            return ranked_tags
        order = {str(r.get("name") or ""): i for i, r in enumerate(ranked)}
        base = len(order)
        return sorted(ranked_tags, key=lambda t: (order.get(t.rel_fname, base), ranked_tags.index(t)))
    except Exception:  # noqa: BLE001 — ranking is best-effort
        return ranked_tags


# لیست پسوندهای متنی که نماد استخراج می‌کنیم (مطابق با ابزارهای فایل).
_TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".c", ".cc",
    ".cpp", ".h", ".hpp", ".cs", ".sql", ".sh", ".bash", ".vue", ".svelte",
    # زبان‌های جدید (اضافه‌شده برای پوشش چندزبانه)
    ".zig", ".dart", ".lua", ".scala", ".sbt",
    ".ex", ".exs", ".erl", ".hrl",
    ".hs", ".ml", ".mli",
    ".clj", ".cljs", ".cljc",
    ".groovy", ".gradle",
    ".jl", ".r", ".R", ".pl", ".pm",
    ".nim", ".cr",
}

# نگاشت پسوند → زبانِ پشتیبانی‌شده توسط tree-sitter-language-pack.
# filename_to_lang برای .tsx/.jsx ممکنه "tsx"/"jsx" برگردونه که گرامرش
# توی language-pack نصب نیست (فقط "typescript"/"javascript" هست)؛ پس صریحاً
# نگاشت می‌کنیم تا parser/tags.query پیدا بشه.
_LANG_ALIASES = {
    ".tsx": "tsx",
    ".jsx": "javascript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".vue": "html",
    ".svelte": "html",
    # زبان‌های جدید — اگر tree-sitter-language-pack اسمشون رو متفاوت می‌ده، صریح نگاشت می‌کنیم
    ".zig": "zig",
    ".dart": "dart",
    ".lua": "lua",
    ".scala": "scala",
    ".sbt": "scala",
    ".ex": "elixir",
    ".exs": "elixir",
    ".erl": "erlang",
    ".hrl": "erlang",
    ".hs": "haskell",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    ".groovy": "groovy",
    ".gradle": "groovy",
    ".jl": "julia",
    ".r": "r",
    ".R": "r",
    ".pl": "perl",
    ".pm": "perl",
    ".nim": "nim",
    ".cr": "crystal",
}

# پوشه‌هایی که نباید پیمایش بشن (مطابق با ابزارهای فایل).
_SKIP_DIRS = {
    # کنترل نسخه / سیستم
    ".git", ".svn", ".hg", ".bzr",
    # IDE / ویرایشگر
    ".idea", ".vscode", ".vs", ".fleet", ".settings",
    # JavaScript / TypeScript
    "node_modules", "bower_components", "dist", "dist-electron", "build",
    "out", "release", ".next", ".nuxt", ".svelte-kit", ".output", ".vercel",
    ".turbo", ".parcel-cache", ".angular", ".cache", "tmp",
    # Python
    "__pycache__", ".venv", "venv", "env", "site-packages", ".eggs",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".ipynb_checkpoints",
    ".tox", ".nox",
    # Java / Kotlin / Scala / Groovy
    ".gradle", ".mvn",
    # Go (گولنگ)
    "vendor",
    # Rust
    ".cargo", "zig-cache", ".zig-cache", "zig-out",
    # C / C++
    "cmake-build-debug", "cmake-build-release", "obj",
    # Ruby
    ".bundle",
    # PHP
    # (vendor بالا پوشه‌ده)
    # C# / .NET
    "bin",
    # Swift / Objective-C
    ".build", "DerivedData", ".swiftpm", "Packages",
    # Dart / Flutter (فلاتر)
    ".dart_tool", ".flutter-plugins", ".flutter-plugins-dependencies",
    ".packages", ".pub-cache", "Pods",
    # Haskell
    ".stack-work", "dist-newstyle",
    # Elixir
    "_build", "deps",
    # Lua / Neovim
    ".luarocks", "lua_modules", ".nvim", "lazy-lock", "packer_compiled",
    # Android
    "captures", ".externalNativeBuild",
    # عمومی (کش / لاگ / موقت)
    "coverage", ".nyc_output", "logs", "log", "temp",
}

# الگوهای regex برای زبان‌هایی که tree-sitter برای‌شون tags.scm نداره
# (مثل c_sharp/bash/sql/vue) یا وقتی parser/query در دسترس نیست — فقط تعاریف سطح‌بالا.
_GENERIC_PATTERNS = [
    (re.compile(r"^(?:func|fn)\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^(?:class|struct|interface|enum|trait|type|object|impl|extension)\s+([A-Za-z_]\w*)"), "type"),
    (re.compile(r"^(?:CREATE\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"\[]?([A-Za-z_]\w*))", re.IGNORECASE), "type"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_]\w*)"), "class"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)\s*\("), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=]"), "variable"),
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_]\w*)"), "interface"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_]\w*)"), "class"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)\s*\("), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=]"), "variable"),
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{"), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_]\w*)"), "interface"),
]

# Cache: root -> (timestamp, map, signature)
_CACHE: dict[str, tuple[float, dict, tuple[float, int]]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 300.0  # Signature-based invalidation (mtime + file count) keeps
# raising this safe: slow multi-minute turns reuse a warm map instead of
# paying a full walk + parse + PageRank rebuild on every turn. Was 60s.

# Symbol name + location (aider.Tag-like). ``end_line`` is the 0-indexed
# closing line of the definition (-1 when unknown); ``top_level`` marks
# module/class-scope definitions — nested helpers are resolvable for
# read(symbols=) but hidden from the 20 display slots so top-level names
# like DiffView are not buried behind inner closures.
Tag = namedtuple(
    "Tag",
    ["rel_fname", "fname", "line", "name", "kind", "end_line", "top_level"],
    defaults=[-1, True],
)


# --------------------------------------------------------------------------
# استخراج def + ref با tree-sitter
# --------------------------------------------------------------------------

# Max bytes read per file for symbol extraction. Backend sources run past
# 300 KB (tools.py ~322k chars); the old 200 KB cap truncated them
# mid-statement, so AST parsing raised SyntaxError and the file silently
# indexed to ZERO symbols (cached that way until mtime changed).
_MAX_SYMBOL_BYTES = 2_000_000

# کش queryهای زبان (get_tags_query کنده — برای هر زبان یه بار).
_SCM_CACHE: dict[str, str | None] = {}
_SCM_CACHE_LOCK = threading.Lock()

# کش آبجکت‌های سنگین tree-sitter (language/parser/Query) — اینا به ازای هر
# زبان ثابت‌ان و دوباره‌سازیشون در هر فراخوانیِ _get_tags_raw گرونه (لاگِ
# MEM-GROW نشون داد Query توی هر اجرای ایجنت ~۱۳ هزار بار ساخته می‌شه).
_LANG_OBJ_CACHE: dict[str, tuple[object, object, object | None]] = {}
_LANG_OBJ_LOCK = threading.Lock()


def _get_lang_objs(lang: str):
    """برمی‌گردونه (language, parser, query) کش‌شده برای یه زبان.

    language/parser/Query آبجکت‌های سنگینی هستن که فقط به lang بستگی دارن؛
    کش شدنشون جلویِ ساختِ هزاران تا Query توی یه اجرای ایجنت رو می‌گیره.
    هر جزء ممکنه بخاطر گرامرِ نصب‌نشده None برگرده (فراخوان‌کننده fallback می‌کنه).
    """
    with _LANG_OBJ_LOCK:
        cached = _LANG_OBJ_CACHE.get(lang)
        if cached is not None:
            return cached
    try:
        language = get_language(lang)
        parser = get_parser(lang)
        scm = _get_scm_fname(lang)
        query = Query(language, scm) if scm else None
    except Exception:  # noqa: BLE001 — گرامر/query نامعتبر
        return (None, None, None)
    with _LANG_OBJ_LOCK:
        _LANG_OBJ_CACHE[lang] = (language, parser, query)
    return (language, parser, query)


def _get_scm_fname(lang: str):
    """مسیر فایل tags.scm برای یه زبان (مثل aider.get_scm_fname).

    چون tree-sitter-language-pack فایل‌های scm رو مستقیماً نمی‌ده، از
    تابع get_tags_query خودش استفاده می‌کنیم (رشتهٔ scm رو برمی‌گردونه).
    نتیجه کش می‌شه چون get_tags_query برای هر زبان کنده.
    """
    with _SCM_CACHE_LOCK:
        if lang in _SCM_CACHE:
            return _SCM_CACHE[lang]
    try:
        from tree_sitter_language_pack import get_tags_query

        scm = get_tags_query(lang)
    except Exception:  # noqa: BLE001 — زبان پشتیبانی‌نشده → None
        scm = None
    with _SCM_CACHE_LOCK:
        _SCM_CACHE[lang] = scm
    return scm


def _get_tags_raw(fname: str, rel_fname: str, code: str = ""):
    """استخراج def + ref با tree-sitter (مشابه aider.get_tags_raw).

    برمی‌گردونه لیستی از Tag. برای زبان‌هایی که tags.scm ندارن به [] برمی‌گرده
    (فراخوان‌کننده به regex/AST فعلی برمی‌گرده). ``code`` متن فایل هست — اگه
    خالی باشه از دیسک خونده می‌شه.
    """
    lang = filename_to_lang(fname)
    if not lang:
        return []
    # نگاشت صریح پسوند → زبانِ پشتیبانی‌شده (مثل .tsx → typescript) تا
    # گرامر/tags.query پیدا بشه. اگه filename_to_lang زبان نصب‌نشده برگردونده
    # بود، اینجا اصلاح می‌شه.
    ext = os.path.splitext(fname)[1].lower()
    if ext in _LANG_ALIASES:
        lang = _LANG_ALIASES[ext]
    language, parser, query = _get_lang_objs(lang)
    if language is None or parser is None:
        # به‌جای قطع کامل، اجازه می‌دیم فراخوان‌کننده به fallback regex برگرده.
        return []

    if query is None:
        # tags.scm نداریم → فراخوان‌کننده به regex/AST فعلی برمی‌گرده.
        return []

    if not code:
        try:
            with open(fname, "r", encoding="utf-8", errors="replace") as fh:
                code = fh.read(_MAX_SYMBOL_BYTES)
        except OSError:
            return []

    try:
        tree = parser.parse(bytes(code, "utf-8"))
    except Exception:  # noqa: BLE001 — متن نامعتبر
        return []

    # tree-sitter 0.26: QueryCursor(query).captures(node) مستقیماً dict[name] -> [nodes]
    # برمی‌گردونه. فرمت queryهای tree-sitter-language-pack:
    #   (identifier) @name  +  @definition.class / @definition.function / @definition.constant
    #   (call ...) @reference.call
    # یعنی نام و نوع تعریف روی دو capture جدا (ولی روی همون نود) میاد.
    defs = []
    refs = []
    try:
        captures = QueryCursor(query).captures(tree.root_node)
    except Exception:  # noqa: BLE001
        captures = {}

    # ابتدا نام‌ها رو جمع‌آوری می‌کنیم (نود -> نام)
    node_name: dict[int, str] = {}
    for tag, nodes in captures.items():
        if tag == "name":
            for node in nodes:
                node_name[id(node)] = node.text.decode("utf-8", "replace")

    _nested: dict[tuple[str, int], bool] = {}
    for tag, nodes in captures.items():
        if tag.startswith("definition."):
            kind = tag.split(".")[-1]
            for node in nodes:
                # نود definition معمولاً بچهٔ identifier داره که نام رو می‌ده
                name = node_name.get(id(node), "")
                if not name:
                    ident = node.child_by_field_name("name")
                    if ident is None and node.child_count:
                        ident = node.children[0]
                    if ident is not None:
                        name = ident.text.decode("utf-8", "replace")
                if name:
                    defs.append((node.start_point[0], name, kind))
                    _nested.setdefault(
                        (name, node.start_point[0]), _is_nested(node)
                    )
        elif tag.startswith("reference."):
            for node in nodes:
                # نود reference معمولاً خودش بچهٔ identifier داره که نام رو می‌ده
                name = node_name.get(id(node), "")
                if not name:
                    ident = node.child_by_field_name("function")
                    if ident is None and node.child_count:
                        ident = node.children[0]
                    if ident is not None:
                        name = ident.text.decode("utf-8", "replace")
                if name:
                    refs.append((node.start_point[0], name))

    # Direct TypeScript/JavaScript range extraction (no query string): the
    # language-pack tags query only knows function_signature/interface/module,
    # so function_declaration / arrow declarators / methods never appear and
    # the model cannot learn where DiffView-style symbols live. Merge ranges
    # here so both the prompt map and read(symbols=) see start AND end lines.
    _ts_ends: dict[tuple[str, int], int] = {}
    try:
        _ts_ranges = _get_ts_ranges(lang, code)
        _seen = {(n, s) for s, n, _ in defs}
        for _ts_name, _ts_start, _ts_end, _ts_kind, _ts_top in _ts_ranges:
            _ts_ends[(_ts_name, _ts_start)] = _ts_end
            _nested.setdefault((_ts_name, _ts_start), not _ts_top)
            if (_ts_name, _ts_start) not in _seen:
                defs.append((_ts_start, _ts_name, _ts_kind))
                _seen.add((_ts_name, _ts_start))
    except Exception:  # noqa: BLE001, S110 — range merge must never break tags
        pass

    # Python end lines via AST (tree-sitter Tags carry start only): map
    # (name, start1) -> end0 so the map shows Lstart-end like TS does.
    # Module-level assignments are also indexed here as constants.
    _py_ends: dict[tuple[str, int], int] = {}
    if lang == "python":
        try:
            _py_tree = ast.parse(code)
            _py_seen = {(n, s) for s, n, _ in defs}
            for _nd in ast.walk(_py_tree):
                if isinstance(
                    _nd, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                ):
                    _e = int(getattr(_nd, "end_lineno", 0) or 0) or _nd.lineno
                    _py_ends.setdefault((_nd.name, _nd.lineno), _e - 1)
            for _nd in _py_tree.body:
                if isinstance(_nd, ast.Assign):
                    _targets = _nd.targets
                elif isinstance(_nd, (ast.AnnAssign, ast.AugAssign)):
                    _targets = [_nd.target]
                else:
                    continue
                for _t in _targets:
                    if isinstance(_t, ast.Name) and (_t.id, _nd.lineno - 1) not in _py_seen:
                        defs.append((_nd.lineno - 1, _t.id, "constant"))
                        _py_seen.add((_t.id, _nd.lineno - 1))
                        _nested.setdefault((_t.id, _nd.lineno - 1), False)
                        _e = int(getattr(_nd, "end_lineno", 0) or 0) or _nd.lineno
                        _py_ends.setdefault((_t.id, _nd.lineno), _e - 1)
        except Exception:  # noqa: BLE001, S110 — ends are best-effort
            pass

    tags = []
    for line, name, kind in defs:
        _end = _ts_ends.get((name, line), -1)
        if _end < 0 and lang == "python":
            _end = _py_ends.get((name, line + 1), -1)
        tags.append(Tag(
            rel_fname, fname, line, name, kind, _end,
            not _nested.get((name, line), False),
        ))
    # ارجاعات رو به‌عنوان تگ‌های جداگانه (با kind=reference) برمی‌گردونیم تا
    # توی ساخت گراف ارجاع استفاده بشن.
    for line, name in refs:
        tags.append(Tag(rel_fname, fname, line, name, "reference"))
    return tags


# Node types that define a named symbol in the TypeScript/JavaScript grammar.
_TS_DEF_KINDS = {
    "function_declaration": "function",
    "function_signature": "function",
    "class_declaration": "class",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
    "method_definition": "method",
}

# Value node types that make a variable_declarator a function definition.
_TS_FUNC_VALUES = {"arrow_function", "function_expression", "function"}

# Ancestor node types that make a definition nested (a closure inside a
# function body). Methods (parent: class body) have no such ancestor and
# count as top-level display symbols.
_TS_FUNC_SCOPES = {
    "arrow_function", "function_expression", "function",
    "function_declaration", "function_definition", "statement_block",
    "method_definition",
}


def _is_nested(node: Any) -> bool:
    """True when a definition node sits inside a function body."""
    try:
        parent = node.parent
        while parent is not None:
            if parent.type in _TS_FUNC_SCOPES:
                return True
            parent = parent.parent
    except Exception:  # noqa: BLE001, S110 — unknown shape counts as top-level
        pass
    return False


def _get_ts_ranges(lang: str, code: str) -> list[tuple[str, int, int, str, bool]]:
    """Direct-tree ranges for TS/JS-family languages.

    Returns ``(name, start0, end0, kind, is_top)`` with 0-indexed lines.
    Walks the parse tree instead of a query string so grammar-version drift
    cannot silently drop node types again. Top-level non-function
    declarators (``const X = ...``) are indexed as ``constant`` so names
    like DIFF_SIDE_BY_SIDE_THRESHOLD resolve; nested non-function
    declarators are noise and skipped. Non-TS/JS languages return [].
    """
    if lang not in ("typescript", "javascript", "tsx"):
        return []
    _, parser, _ = _get_lang_objs(lang)
    if parser is None:
        return []
    try:
        tree = parser.parse(bytes(code, "utf-8"))
    except Exception:  # noqa: BLE001 — invalid text
        return []
    out: list[tuple[str, int, int, str, bool]] = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        try:
            children = node.children
        except Exception:  # noqa: BLE001, S112
            continue
        t = node.type
        if t == "variable_declarator":
            try:
                value = node.child_by_field_name("value")
                is_func = value is not None and value.type in _TS_FUNC_VALUES
                top = not _is_nested(node)
                if not is_func and not top:
                    continue
                name_node = node.child_by_field_name("name")
                if name_node is not None:
                    out.append((
                        name_node.text.decode("utf-8", "replace"),
                        node.start_point[0],
                        node.end_point[0],
                        "function" if is_func else "constant",
                        top,
                    ))
            except Exception:  # noqa: BLE001, S110
                pass
        elif t in _TS_DEF_KINDS:
            try:
                name_node = node.child_by_field_name("name")
                if name_node is None:
                    for c in children:
                        if c.type in ("identifier", "type_identifier", "property_identifier"):
                            name_node = c
                            break
                if name_node is not None:
                    out.append((
                        name_node.text.decode("utf-8", "replace"),
                        node.start_point[0],
                        node.end_point[0],
                        _TS_DEF_KINDS[t],
                        not _is_nested(node),
                    ))
            except Exception:  # noqa: BLE001, S110
                pass
        stack.extend(children)
    return out


def _extract_python(text: str) -> list[tuple[str, int, str]]:
    """Top-level functions/classes + class methods (fallback for .py).

    Nested closures are intentionally excluded here: this feeds the display
    map (and the server endpoint), where they would crowd out top-level
    names. Nested definitions stay resolvable via get_symbol_ranges, which
    walks the full tree for read(symbols=).
    """
    out: list[tuple[str, int, str]] = []
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return out
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append((node.name, node.lineno, "function"))
        elif isinstance(node, ast.ClassDef):
            out.append((node.name, node.lineno, "class"))
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.append((sub.name, sub.lineno, "method"))
    return out


def _extract_regex(text: str, patterns: list[tuple[re.Pattern, str]]) -> list[tuple[str, int, str]]:
    """استخراج نماد با regex (برای زبان‌های بدون tags.scm)."""
    out: list[tuple[str, int, str]] = []
    for i, line in enumerate(text.split("\n"), 1):
        if line[:1] in (" ", "\t"):
            continue
        stripped = line.lstrip()
        if not stripped or stripped.startswith(("#", "//", "/*", "*", "<!--")):
            continue
        for pat, typ in patterns:
            m = pat.search(line)
            if m:
                out.append((m.group(1), i, typ))
                break
    return out


def _extract_symbols(rel_path: str, text: str) -> list[tuple[str, int, str]]:
    """انتخاب روش استخراج: tree-sitter اول، بعد AST/regex (fallback)."""
    ext = os.path.splitext(rel_path)[1].lower()
    # تلاش با tree-sitter (def + ref) — فقط defها رو برمی‌گردونیم.
    try:
        tags = _get_tags_raw(rel_path, rel_path, text)
        defs = [(t.name, t.line + 1, t.kind) for t in tags if t.kind != "reference" and t.name]
        if defs:
            return defs
    except Exception:  # noqa: BLE001, S110 - tree-sitter may fail on odd syntax; fall back to AST/regex
        pass
    # fallback: وقتی tree-sitter هیچ تگی نداد (زبان پشتیبانی‌نشده یا tags.scm
    # نداشت) یا exception داد، با AST (برای .py) یا regex عمومی ادامه می‌دیم.
    if ext == ".py":
        return _extract_python(text)
    return _extract_regex(text, _GENERIC_PATTERNS)


# --------------------------------------------------------------------------
# گراف ارجاع + PageRank (مشابه aider.get_ranked_tags)
# --------------------------------------------------------------------------

def _get_ranked_tags(
    chat_fnames,
    other_fnames,
    mentioned_fnames,
    mentioned_idents,
    root_real: str = "",
    query: str | None = None,
    rank_info: dict | None = None,
):
    """رتبه‌بندی تگ‌ها با PageRank + personalization (مثل aider) + laya rank اختیاری."""
    defines = defaultdict(set)
    references = defaultdict(list)
    definitions = defaultdict(set)

    for fname in list(chat_fnames) + list(other_fnames):
        # tags واقعی رو از فایل می‌خونیم (توی build_symbol_map کش شدن)
        file_tags = _read_file_tags(fname)
        for t in file_tags:
            if t.kind == "reference":
                references[t.name].append(t.rel_fname)
            else:
                defines[t.name].add(t.rel_fname)
                definitions[t.rel_fname].add(t)

    # گراف چندگانه جهت‌دار
    G = nx.MultiDiGraph()
    for ident, referencing_fnames in references.items():
        for referencing_fname in referencing_fnames:
            for defining_fname in defines[ident]:
                if referencing_fname == defining_fname:
                    continue
                G.add_edge(referencing_fname, defining_fname, ident=ident)

    # personalization: فایل‌های چت + mentioned وزن بالا
    personalization = {}
    fnames = list(chat_fnames) + list(other_fnames)
    if fnames:
        chat_weight = 100 / len(fnames)
        for f in chat_fnames:
            personalization[f] = chat_weight
        for f in mentioned_fnames:
            if f in fnames:
                personalization[f] = chat_weight
    if not personalization and fnames:
        personalization = {f: 1 / len(fnames) for f in fnames}

    try:
        ranked = nx.pagerank(G, weight=None, personalization=personalization)
    except Exception:  # noqa: BLE001
        ranked = {f: 1.0 for f in fnames}

    # وقتی گراف خالیه (هیچ ارجاعی بین فایل‌ها نیست)، pagerank هم خالیه —
    # پس مستقیماً از personalization برای رتبه‌بندی استفاده می‌کنیم.
    if not ranked and personalization:
        ranked = dict(personalization)

    # توزیع رتبه روی یال‌های خروجی → رتبهٔ تعاریف
    ranked_definitions = defaultdict(float)
    for src, dst, data in G.edges(data=True):
        ident = data["ident"]
        mul = 1.0
        if ident in mentioned_idents:
            mul *= 10
        if _looks_like_code_ident(ident):
            mul *= 10
        if ident.startswith("_"):
            mul *= 0.1
        if src in chat_fnames:
            mul *= 50
        ranked_definitions[(dst, ident)] += ranked.get(src, 0) * mul

    # وقتی گراف خالیه (هیچ ارجاعی نیست)، مستقیماً از personalization
    # برای رتبه‌بندی فایل‌های mentioned/chat استفاده می‌کنیم.
    if not G.edges:
        # mentioned_fnames/chat_fnames مطلقه، definitions با rel_fname کلید می‌شه
        rel_mentioned = {os.path.relpath(f, root_real) for f in mentioned_fnames} if root_real else set()
        rel_chat = {os.path.relpath(f, root_real) for f in chat_fnames} if root_real else set()
        for f in rel_mentioned:
            if f in definitions:
                for t in definitions[f]:
                    ranked_definitions[(f, t.name)] += personalization.get(os.path.join(root_real, f), 0) if root_real else 0
        for f in rel_chat:
            if f in definitions:
                for t in definitions[f]:
                    ranked_definitions[(f, t.name)] += personalization.get(os.path.join(root_real, f), 0) if root_real else 0

    # مرتب‌سازی نهایی تگ‌ها: همهٔ defها رو نگه می‌داریم، فقط رتبه‌شون رو
    # بر اساس گراف ارجاع تنظیم می‌کنیم (تگ‌های بدون ref رتبهٔ پایه می‌گیرن).
    ranked_tags = []
    for fname, tags in definitions.items():
        for t in tags:
            rank = ranked_definitions.get((fname, t.name), 0.0)
            ranked_tags.append((rank, t))
    ranked_tags.sort(key=lambda x: -x[0])
    out = [t for _, t in ranked_tags]
    if query and str(query).strip():
        out = _apply_laya_rerank(str(query), out, root_real, rank_info=rank_info)
    return out


def _read_file_tags(fname: str) -> list[Tag]:
    """خوندن تگ‌های یه فایل از کش یا دیسک (برای گراف ارجاع)."""
    cached = _CACHE.get(fname)
    if cached is not None and cached[1] is not None:
        return cached[1]
    return []


# --------------------------------------------------------------------------
# نمایش فشردهٔ امضا (مشابه aider.to_tree — بدون بدنهٔ تابع)
# --------------------------------------------------------------------------

def _to_tree(tags, chat_rel_fnames, root_real: str = "",
             mentioned: set[str] | None = None) -> str:
    """ساخت نمایش درختی از تگ‌های رتبه‌بندی‌شده (مثل aider.to_tree).

    فقط امضا (نام + خط + نوع) رو نشون می‌ده — نه بدنهٔ تابع. aider همین‌کار
    رو می‌کنه: نقشه قراره «کجا چی هست» رو سریع نشون بده تا مدل مستقیم بره سراغ
    read(file:line)، نه اینکه خودش کد رو اینجا پیچ کنه. رندر کردن بدنه باعث
    می‌شد بودجهٔ ۱۰۲۴ توکن فقط برای ۱-۲ فایل تموم بشه و بقیهٔ پروژه از نقشه
    حذف بشه → مدل مجبور بود با read تکی دنبال فایل‌ها بگرده.

    فقط نمادهای سطح بالا (top-level + class methods) نمایش داده می‌شن —
    closureهای تودرتو اسلات‌های ۲۰تایی رو پر نمی‌کنن. نمادهای هم‌نام با
    ``mentioned`` (شناسه‌های تاریخچه/سؤال) اول میان.
    """
    if not tags:
        return ""
    try:
        _mentioned = {str(m).lower() for m in (mentioned or set())}
    except Exception:  # noqa: BLE001
        _mentioned = set()
    # گروه‌بندی بر اساس فایل — ترتیب رو از tags (که قبلاً رتبه‌بندی شد) حفظ می‌کنیم
    by_file: dict[str, list[Tag]] = defaultdict(list)
    file_order: list[str] = []
    for t in tags:
        try:
            if not getattr(t, "top_level", True):
                continue  # nested helper: resolvable, not displayable
        except Exception:  # noqa: BLE001, S110
            pass
        if t.rel_fname not in by_file:
            file_order.append(t.rel_fname)
        by_file[t.rel_fname].append(t)

    lines = []
    for fname in file_order:
        if fname in chat_rel_fnames:
            continue  # فایل‌های چت رو رد می‌کنیم (aider همین‌کار رو می‌کنه)
        tags_in_file = sorted(
            by_file[fname],
            key=lambda t: (
                0 if str(t.name or "").lower() in _mentioned else 1,
                t.line if isinstance(t.line, int) else 0,
            ),
        )
        # محدودیت تگ در فایل: مثل aider و _simple_tree، فقط ۲۰ تا اول رو نشون میدیم
        # تا بودجه توکنی روی فایل‌های بیشتری توزیع بشه
        MAX_TAGS_PER_FILE = 20
        lines.append(f"📄 {fname}")
        for t in tags_in_file[:MAX_TAGS_PER_FILE]:
            line = (t.line + 1) if t.line is not None and t.line >= 0 else 0
            kind = t.kind if t.kind else "def"
            try:
                _end = getattr(t, "end_line", -1)
            except Exception:  # noqa: BLE001
                _end = -1
            if isinstance(_end, int) and _end >= 0 and (_end + 1) > line:
                lines.append(f"  ├─ {kind} {t.name} (L{line}-{_end + 1})")
            else:
                lines.append(f"  ├─ {kind} {t.name} (L{line})")
        if len(tags_in_file) > MAX_TAGS_PER_FILE:
            lines.append(f"  └─ ... و {len(tags_in_file) - MAX_TAGS_PER_FILE} نماد دیگر")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# بودجه توکنی پویا (مشابه aider.get_ranked_tags_map_uncached)
# --------------------------------------------------------------------------

def _token_count(text: str) -> int:
    """تقریب ارزان توکن (بدون مدل): len//4."""
    return len(text) // 4


def _get_ranked_tags_map(
    chat_fnames,
    other_fnames,
    max_map_tokens,
    mentioned_fnames,
    mentioned_idents,
    root_real: str = "",
    query: str | None = None,
    rank_info: dict | None = None,
) -> str:
    """ساخت نقشه با بودجه توکنی پویا (binary search روی تعداد تگ‌ها)."""
    ranked_tags = _get_ranked_tags(
        chat_fnames, other_fnames, mentioned_fnames, mentioned_idents, root_real, query=query, rank_info=rank_info
    )
    if not ranked_tags:
        return ""

    # binary search: چند تا از بالاترین تگ‌ها رو بگیریم تا نزدیک max_map_tokens بشیم
    lo, hi = 1, len(ranked_tags)
    best = ranked_tags[:1]
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = ranked_tags[:mid]
        tree = _to_tree(candidate, set(), root_real, mentioned_idents)
        if _token_count(tree) <= max_map_tokens:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return _to_tree(best, set(), root_real, mentioned_idents)


# --------------------------------------------------------------------------
# API عمومی (سازگار با تست‌های موجود)
# --------------------------------------------------------------------------

def build_symbol_map(root: str) -> dict[str, list[tuple[str, int, str]]]:
    """بساز نقشه‌ی نمادها برای کل درخت ``root``.

    برمی‌گردونه ``{rel_path: [(name, line, type), ...]}``. فقط فایل‌های متنی
    زیر ۲ مگابایت رو می‌خونه تا سریع بمونه. نتیجه ۱۰ ثانیه کش می‌شه.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    tree_mtime = 0.0
    file_count = 0
    for dirpath, dirnames, filenames in os.walk(root_real):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            file_count += 1
            try:
                tree_mtime = max(tree_mtime, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    signature = (tree_mtime, file_count)

    with _CACHE_LOCK:
        cached = _CACHE.get(root_real)
        if (
            cached is not None
            and cached[2] == signature
            and (time.time() - cached[0]) < _CACHE_TTL
        ):
            return cached[1]

    result: dict[str, list[tuple[str, int, str]]] = {}
    for dirpath, dirnames, filenames in os.walk(root_real):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in _TEXT_EXTENSIONS:
                continue
            if ".out." in name or name.endswith((".min.js", ".min.mjs")):
                continue
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root_real).replace(os.sep, "/")
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read(_MAX_SYMBOL_BYTES)
            except OSError:
                continue
            first = text.split("\n", 1)[0]
            if len(first) > 600 and " " not in first[:300]:
                continue
            syms = _extract_symbols(rel, text)
            if syms:
                result[rel] = syms
                # کش تگ‌های کامل (با ref) برای گراف ارجاع
                with _CACHE_LOCK:
                    _CACHE[abs_path] = (time.time(), _tags_for_file(rel, abs_path, text), signature)

    with _CACHE_LOCK:
        _CACHE[root_real] = (time.time(), result, signature)
    return result


def _tags_for_file(rel: str, abs_path: str, text: str) -> list[Tag]:
    """ساخت تگ‌های کامل (def + ref) برای یه فایل — برای گراف ارجاع."""
    try:
        raw = _get_tags_raw(abs_path, rel, text)
        if raw:
            return raw
    except Exception:  # noqa: BLE001, S110 - tree-sitter may fail on odd syntax; fall back to AST/regex
        pass
    # fallback: فقط defها رو به‌عنوان تگ برمی‌گردونیم
    tags = []
    syms = _extract_symbols(rel, text)
    for name, line, kind in syms:
        tags.append(Tag(rel, abs_path, line - 1, name, kind))
    return tags


def format_symbol_map(
    root: str,
    max_map_tokens: int = 1024,
    chat_files: list[str] | None = None,
    mentioned_fnames: set[str] | None = None,
    mentioned_idents: set[str] | None = None,
    query: str | None = None,
    rank_info: dict | None = None,
) -> str:
    """فرمت‌بندی نقشه به متن درختی فشرده برای الصاق به پرامپت (مثل aider.get_repo_map).

    نقشه با PageRank + personalization رتبه‌بندی می‌شه (فایل‌های چت/ذکرشده
    بالاتر میان) و با بودجه توکنی پویا محدود می‌شه. فایل‌ها کلاً حذف نمی‌شن —
    فقط اولویت‌بندی می‌شن (برخلاف فیلتر سخت قبلی که باعث گم‌شدن فایل و tool call
    بیشتر می‌شد).

    پارامترها:
        root: ریشهٔ پروژه
        max_map_tokens: سقف توکن نقشه (پیش‌فرض ۱۰۲۴، مثل aider)
        chat_files: فایل‌های الان توی چت (وزن بالا در رتبه‌بندی)
        mentioned_fnames: فایل‌های ذکرشده در تاریخچه (وزن بالا)
        mentioned_idents: شناسه‌های ذکرشده در تاریخچه (وزن بالا)
    """
    chat_files = chat_files or []
    mentioned_fnames = mentioned_fnames or set()
    mentioned_idents = mentioned_idents or set()

    try:
        sym_map = build_symbol_map(root)
    except Exception:  # noqa: BLE001
        return ""
    if not sym_map:
        return ""

    # تبدیل به مسیرهای مطلق برای گراف ارجاع (sorted برای رتبه‌بندی پایدار)
    root_real = os.path.realpath(os.path.abspath(root))
    all_fnames = sorted({os.path.join(root_real, rel) for rel in sym_map})
    chat_fnames = {os.path.realpath(f) for f in chat_files if os.path.isabs(f)}
    chat_fnames |= {os.path.join(root_real, f) for f in chat_files if not os.path.isabs(f)}
    other_fnames = sorted(set(all_fnames) - chat_fnames)
    mentioned_abs = {
        os.path.realpath(f) if os.path.isabs(f) else os.path.join(root_real, f)
        for f in mentioned_fnames
    }

    try:
        tree = _get_ranked_tags_map(
            chat_fnames,
            other_fnames,
            max_map_tokens,
            mentioned_abs,
            mentioned_idents,
            root_real,
            query=query,
            rank_info=rank_info,
        )
    except Exception:  # noqa: BLE001
        tree = ""

    if not tree:
        # fallback: اگه رتبه‌بندی خالی شد، نقشهٔ ساده رو بده (مثل aider)
        tree = _simple_tree(sym_map)

    if not tree:
        return ""
    return (
        "\n\n===== CODE MAP (live symbol index — go straight to read, no grep needed) =====\n"
        + tree
    )


def _simple_tree(sym_map: dict[str, list[tuple[str, int, str]]]) -> str:
    """Simple tree view (fallback when ranking is empty)."""
    lines = []
    for rel in sorted(sym_map):
        syms = sym_map[rel][:20]
        if not syms:
            continue
        lines.append(f"📄 {rel}")
        for _sym in syms:
            # 3-tuple (name, line, kind); tolerate a 4th end-line element.
            name, line, typ = _sym[0], _sym[1], _sym[2]
            _end = _sym[3] if len(_sym) > 3 else line
            if isinstance(_end, int) and _end > line:
                lines.append(f"  ├─ {typ} {name} (L{line}-{_end})")
            else:
                lines.append(f"  ├─ {typ} {name} (L{line})")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Symbol ranges for read(symbols=) and grep annotation
# --------------------------------------------------------------------------

# abs_path -> (mtime, {lower_name: (start1, end1, kind)}, {lower_name: orig})
_SYMBOL_RANGE_CACHE: dict[
    str, tuple[float, dict[str, tuple[int, int, str]], dict[str, str]]
] = {}
_SYMBOL_RANGE_LOCK = threading.Lock()

_TS_EXT_LANG = {
    ".ts": "typescript", ".tsx": "tsx", ".mts": "typescript",
    ".cts": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
}


def get_symbol_ranges(abs_path: str) -> dict[str, tuple[int, int, str]]:
    """Map lowercase symbol name to (start1, end1, kind) for one file.

    1-indexed inclusive lines. TS/JS uses the direct tree walk (precise
    ends); Python uses AST end_lineno (nested included); other languages
    fall back to names with end == start. mtime-guarded cache.
    """
    try:
        mtime = os.path.getmtime(abs_path)
    except OSError:
        return {}
    with _SYMBOL_RANGE_LOCK:
        cached = _SYMBOL_RANGE_CACHE.get(abs_path)
        if cached is not None and cached[0] == mtime:
            return cached[1]
    ranges: dict[str, tuple[int, int, str]] = {}
    orig: dict[str, str] = {}
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read(_MAX_SYMBOL_BYTES)
    except OSError:
        return {}
    ext = os.path.splitext(abs_path)[1].lower()

    def _add(name: str, s: int, e: int, kind: str) -> None:
        key = name.lower()
        if key not in ranges:
            ranges[key] = (s, e, kind)
            orig[key] = name

    try:
        if ext == ".py":
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    _end = int(getattr(node, "end_lineno", 0) or 0) or node.lineno
                    _add(node.name, node.lineno, _end, "function")
                elif isinstance(node, ast.ClassDef):
                    _end = int(getattr(node, "end_lineno", 0) or 0) or node.lineno
                    _add(node.name, node.lineno, _end, "class")
            for node in tree.body:
                # Module-level assignments (MAX_FOO = 1, x: int = 2) as
                # constants so read(symbols=) and grep resolve them.
                if isinstance(node, ast.Assign):
                    _targets = node.targets
                elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                    _targets = [node.target]
                else:
                    continue
                for _t in _targets:
                    if isinstance(_t, ast.Name):
                        _end = int(getattr(node, "end_lineno", 0) or 0) or node.lineno
                        _add(_t.id, node.lineno, _end, "constant")
        elif ext in _TS_EXT_LANG:
            for name, s0, e0, kind, _top in _get_ts_ranges(_TS_EXT_LANG[ext], text):
                _add(name, s0 + 1, e0 + 1, kind)
        else:
            for name, line, kind in _extract_symbols(abs_path, text):
                _add(name, line, line, kind)
    except Exception:  # noqa: BLE001 — ranges are best-effort
        # A parse failure (e.g. truncated text) must NOT be cached: an empty
        # map cached by mtime would hide every symbol until the file changes.
        return dict(ranges)
    with _SYMBOL_RANGE_LOCK:
        _SYMBOL_RANGE_CACHE[abs_path] = (mtime, ranges, orig)
    return ranges


def symbol_display_name(abs_path: str, lower_name: str) -> str:
    """Original-case symbol name for display (falls back to the key)."""
    try:
        mtime = os.path.getmtime(abs_path)
    except OSError:
        return lower_name
    with _SYMBOL_RANGE_LOCK:
        cached = _SYMBOL_RANGE_CACHE.get(abs_path)
        if cached is not None and cached[0] == mtime:
            return cached[2].get(lower_name, lower_name)
    get_symbol_ranges(abs_path)
    with _SYMBOL_RANGE_LOCK:
        cached = _SYMBOL_RANGE_CACHE.get(abs_path)
        if cached is not None:
            return cached[2].get(lower_name, lower_name)
    return lower_name


def find_symbol_range(abs_path: str, name: str) -> tuple[int, int, str] | None:
    """(start1, end1, kind) for ``name`` in the file, or None."""
    if not name:
        return None
    return get_symbol_ranges(abs_path).get(str(name).strip().lower())


def enclosing_symbol(abs_path: str, line1: int) -> tuple[str, int, int, str] | None:
    """Innermost (name, start1, end1, kind) containing 1-indexed ``line1``."""
    try:
        ln = int(line1)
    except (TypeError, ValueError):
        return None
    best: tuple[str, int, int, str] | None = None
    for key, (s, e, kind) in get_symbol_ranges(abs_path).items():
        if s <= ln <= e and (best is None or (e - s) < (best[2] - best[1])):
            best = (symbol_display_name(abs_path, key), s, e, kind)
    return best


def resolve_symbol_ranges(
    abs_path: str, names: list[str]
) -> tuple[list[tuple[int, int]], list[str]]:
    """Split symbol names into ([(start1, line_count)], [missing])."""
    windows: list[tuple[int, int]] = []
    missing: list[str] = []
    for n in names or []:
        hit = find_symbol_range(abs_path, n)
        if hit is None:
            missing.append(str(n))
        else:
            s, e, _ = hit
            windows.append((max(1, s), max(1, e - s + 1)))
    return windows, missing


def clear_symbol_cache(root: str | None = None) -> None:
    """Clear the symbol cache (e.g. after editing files)."""
    with _CACHE_LOCK:
        if root is None:
            _CACHE.clear()
        else:
            _CACHE.pop(os.path.realpath(os.path.abspath(root)), None)
    with _SYMBOL_RANGE_LOCK:
        if root is None:
            _SYMBOL_RANGE_CACHE.clear()
        else:
            _prefix = os.path.realpath(os.path.abspath(root)) + os.sep
            for _k in [k for k in _SYMBOL_RANGE_CACHE if k.startswith(_prefix)]:
                _SYMBOL_RANGE_CACHE.pop(_k, None)
