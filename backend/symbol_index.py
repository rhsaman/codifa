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
    ".tsx": "typescript",
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

# کش: root -> (timestamp, map, signature)
_CACHE: dict[str, tuple[float, dict, tuple[float, int]]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 60.0  # بودن ۱۰ ثانیه باعث miss مدام توی مکالمه‌های عادی می‌شد؛
                   # invalidation بر اساس signature هست پس بالا بردنش امنه.

# نام نماد + مکان (مشابه aider.Tag).
Tag = namedtuple("Tag", ["rel_fname", "fname", "line", "name", "kind"])


# --------------------------------------------------------------------------
# استخراج def + ref با tree-sitter
# --------------------------------------------------------------------------

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
                code = fh.read(200_000)
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

    tags = []
    for line, name, kind in defs:
        tags.append(Tag(rel_fname, fname, line, name, kind))
    # ارجاعات رو به‌عنوان تگ‌های جداگانه (با kind=reference) برمی‌گردونیم تا
    # توی ساخت گراف ارجاع استفاده بشن.
    for line, name in refs:
        tags.append(Tag(rel_fname, fname, line, name, "reference"))
    return tags


def _extract_python(text: str) -> list[tuple[str, int, str]]:
    """استخراج توابع/کلاس‌ها از کد پایتون با AST (fallback برای .py)."""
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

def _get_ranked_tags(chat_fnames, other_fnames, mentioned_fnames, mentioned_idents, root_real: str = ""):
    """رتبه‌بندی تگ‌ها با PageRank + personalization (مثل aider)."""
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
    return [t for _, t in ranked_tags]


def _read_file_tags(fname: str) -> list[Tag]:
    """خوندن تگ‌های یه فایل از کش یا دیسک (برای گراف ارجاع)."""
    cached = _CACHE.get(fname)
    if cached is not None and cached[1] is not None:
        return cached[1]
    return []


# --------------------------------------------------------------------------
# نمایش فشردهٔ امضا (مشابه aider.to_tree — بدون بدنهٔ تابع)
# --------------------------------------------------------------------------

def _to_tree(tags, chat_rel_fnames, root_real: str = "") -> str:
    """ساخت نمایش درختی از تگ‌های رتبه‌بندی‌شده (مثل aider.to_tree).

    فقط امضا (نام + خط + نوع) رو نشون می‌ده — نه بدنهٔ تابع. aider همین‌کار
    رو می‌کنه: نقشه قراره «کجا چی هست» رو سریع نشون بده تا مدل مستقیم بره سراغ
    read(file:line)، نه اینکه خودش کد رو اینجا پیچ کنه. رندر کردن بدنه باعث
    می‌شد بودجهٔ ۱۰۲۴ توکن فقط برای ۱-۲ فایل تموم بشه و بقیهٔ پروژه از نقشه
    حذف بشه → مدل مجبور بود با read تکی دنبال فایل‌ها بگرده.
    """
    if not tags:
        return ""
    # گروه‌بندی بر اساس فایل — ترتیب رو از tags (که قبلاً رتبه‌بندی شد) حفظ می‌کنیم
    by_file: dict[str, list[Tag]] = defaultdict(list)
    file_order: list[str] = []
    for t in tags:
        if t.rel_fname not in by_file:
            file_order.append(t.rel_fname)
        by_file[t.rel_fname].append(t)

    lines = []
    for fname in file_order:
        if fname in chat_rel_fnames:
            continue  # فایل‌های چت رو رد می‌کنیم (aider همین‌کار رو می‌کنه)
        tags_in_file = by_file[fname]
        # محدودیت تگ در فایل: مثل aider و _simple_tree، فقط ۲۰ تا اول رو نشون میدیم
        # تا بودجه توکنی روی فایل‌های بیشتری توزیع بشه
        MAX_TAGS_PER_FILE = 20
        lines.append(f"📄 {fname}")
        for t in tags_in_file[:MAX_TAGS_PER_FILE]:
            line = (t.line + 1) if t.line is not None and t.line >= 0 else 0
            kind = t.kind if t.kind else "def"
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


def _get_ranked_tags_map(chat_fnames, other_fnames, max_map_tokens, mentioned_fnames, mentioned_idents, root_real: str = "") -> str:
    """ساخت نقشه با بودجه توکنی پویا (binary search روی تعداد تگ‌ها)."""
    ranked_tags = _get_ranked_tags(chat_fnames, other_fnames, mentioned_fnames, mentioned_idents, root_real)
    if not ranked_tags:
        return ""

    # binary search: چند تا از بالاترین تگ‌ها رو بگیریم تا نزدیک max_map_tokens بشیم
    lo, hi = 1, len(ranked_tags)
    best = ranked_tags[:1]
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = ranked_tags[:mid]
        tree = _to_tree(candidate, set(), root_real)
        if _token_count(tree) <= max_map_tokens:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return _to_tree(best, set(), root_real)


# --------------------------------------------------------------------------
# API عمومی (سازگار با تست‌های موجود)
# --------------------------------------------------------------------------

def build_symbol_map(root: str) -> dict[str, list[tuple[str, int, str]]]:
    """بساز نقشه‌ی نمادها برای کل درخت ``root``.

    برمی‌گردونه ``{rel_path: [(name, line, type), ...]}``. فقط فایل‌های متنی
    کوچک (زیر ۲۰۰ کیلوبایت) رو می‌خونه تا سریع بمونه. نتیجه ۱۰ ثانیه کش می‌شه.
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
                    text = fh.read(200_000)
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
            chat_fnames, other_fnames, max_map_tokens, mentioned_abs, mentioned_idents, root_real
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
    """نمایش سادهٔ درختی (fallback وقتی رتبه‌بندی خالی شد)."""
    lines = []
    for rel in sorted(sym_map):
        syms = sym_map[rel][:20]
        if not syms:
            continue
        lines.append(f"📄 {rel}")
        for name, line, typ in syms:
            lines.append(f"  ├─ {typ} {name} (L{line})")
    return "\n".join(lines)


def clear_symbol_cache(root: str | None = None) -> None:
    """پاک کردن کش نماد (مثلاً بعد از ویرایش فایل‌ها)."""
    with _CACHE_LOCK:
        if root is None:
            _CACHE.clear()
        else:
            _CACHE.pop(os.path.realpath(os.path.abspath(root)), None)
