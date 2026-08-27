"""نقشه‌ی نماد لحظه‌ای (Code Map) — استخراج سبک نمادها از روی فایل‌های فعلی.

هدف: کاهش واقعی تعداد فراخوانی‌های ابزار (grep/glob/read) با دادن یک نمای
کلی از محل توابع/کلاس‌ها به مدل، قبل از اولین نوبت. مدل به‌جای جستجوی کورکورانه
در کل پروژه، مستقیماً می‌ره سراغ فایل و خط مشخص (۱ call به‌جای ~۱۲ call).

طراحی:
* برای فایل‌های ``.py`` از ``ast`` استفاده می‌کنیم (دقیق، بدون اجرای کد).
* برای فایل‌های ``.ts/.tsx/.js/.jsx`` از regex ساده (سریع، بدون پارسر کامل).
* **بدون embedding** — فقط اسم + خط + نوع. سبک و آنی.
* کش ۱۰ ثانیه‌ای (مثل ``_walk_files``) برای جلوگیری از rebuild در هر نوبت.
"""

from __future__ import annotations

import ast
import os
import re
import threading
import time

# لیست پسوندهای متنی که نماد استخراج می‌کنیم (مطابق با ابزارهای فایل).
_TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".c", ".cc",
    ".cpp", ".h", ".hpp", ".cs", ".sql", ".sh", ".bash", ".vue", ".svelte",
}

# پوشه‌هایی که نباید پیمایش بشن (مطابق با ابزارهای فایل).
# دسته‌بندی‌شده برای پوشه‌های خروجی/وابستگی همه‌ی زبان‌های رایج.
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
    # (target بالا پوشه‌ده)
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

# الگوهای regex برای زبان‌های غیرپایتون (نام + نوع).
_TS_JS_PATTERNS = [
    (re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"), "function"),
    (re.compile(r"^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>)"), "function"),
    (re.compile(r"^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)"), "type"),
]
_GENERIC_PATTERNS = [
    (re.compile(r"^(?:func|fn)\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"), "function"),
    (re.compile(r"^(?:class|struct|interface|enum|trait|type|object|impl|extension)\s+([A-Za-z_]\w*)"), "type"),
    (re.compile(r"^\s*(?:[\w<>\[\],\s]+?)\s+([A-Za-z_]\w*)\s*\("), "function"),
]

# کش: root -> (timestamp, map, signature)
# signature = (mtime کل درخت, تعداد فایل) — وقتی فایلی واقعاً تغییر کنه
# عوض می‌شه، پس نقشه رو فقط در این صورت rebuild می‌کنیم (نه هر ۱۰ ثانیه).
_CACHE: dict[str, tuple[float, dict[str, list[tuple[str, int, str]]], tuple[float, int]]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 10.0


def _extract_python(text: str) -> list[tuple[str, int, str]]:
    """استخراج توابع/کلاس‌ها از کد پایتون با AST."""
    out: list[tuple[str, int, str]] = []
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return out
    # فقط فرزندان مستقیم ماژول (نمادهای سطح‌بالا) — توابع/کلاس‌های تودرتو نه.
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append((node.name, node.lineno, "function"))
        elif isinstance(node, ast.ClassDef):
            out.append((node.name, node.lineno, "class"))
    return out


def _extract_regex(text: str, patterns: list[tuple[re.Pattern, str]]) -> list[tuple[str, int, str]]:
    """استخراج نماد با regex (برای زبان‌های غیرپایتون)."""
    out: list[tuple[str, int, str]] = []
    for i, line in enumerate(text.split("\n"), 1):
        # فقط خطوط با indentation صفر = نمادهای سطح‌بالا (توابع/کلاس‌های تودرتو نه).
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
    """انتخاب روش استخراج بر اساس پسوند فایل."""
    ext = os.path.splitext(rel_path)[1].lower()
    if ext == ".py":
        return _extract_python(text)
    if ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"):
        return _extract_regex(text, _TS_JS_PATTERNS)
    return _extract_regex(text, _GENERIC_PATTERNS)


def build_symbol_map(root: str) -> dict[str, list[tuple[str, int, str]]]:
    """بساز نقشه‌ی نمادها برای کل درخت ``root``.

    برمی‌گردونه ``{rel_path: [(name, line, type), ...]}``. فقط فایل‌های متنی
    کوچک (زیر ۲۰۰ کیلوبایت) رو می‌خونه تا سریع بمونه. نتیجه ۱۰ ثانیه کش می‌شه.
    """
    root_real = os.path.realpath(os.path.abspath(root))
    # امضای سبک درخت: (جدیدترین mtime، تعداد کل فایل). فقط وقتی اینا عوض بشن
    # نقشه رو rebuild می‌کنیم — نه صرفاً به‌خاطر گذشت زمان.
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
            if name.startswith("."):  # فایل‌های مخفی مثل .tmp-*.mjs
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in _TEXT_EXTENSIONS:
                continue
            # رد کردن build artifacts (مثل dump-ssr.out.mjs که خروجی bundler هست).
            if ".out." in name or name.endswith((".min.js", ".min.mjs")):
                continue
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root_real).replace(os.sep, "/")
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read(200_000)
            except OSError:
                continue
            # رد کردن فایل‌های minify‌شده: یه خط خیلی طولانی با فاصله‌ی کم
            # (مثل main.js که توابع q/D/Le داره) — نمادش برای agent بی‌فایده‌ست.
            first = text.split("\n", 1)[0]
            if len(first) > 600 and " " not in first[:300]:
                continue
            syms = _extract_symbols(rel, text)
            if syms:
                result[rel] = syms

    with _CACHE_LOCK:
        _CACHE[root_real] = (time.time(), result, signature)
    return result


def format_symbol_map(
    root: str,
    max_files: int = 30,
    max_symbols_per_file: int = 20,
    max_folders: int | None = None,
) -> str:
    """فرمت‌بندی نقشه به متن درختی فشرده برای الصاق به پرامپت.

    فایل‌ها رو بر اساس پوشهٔ بالا گروه‌بندی می‌کنه (structure → folder → file →
    symbol) تا مدل سریع‌تر ساختار رو بفهمه. فقط فایل‌هایی که نماد دارن نشون
    داده می‌شن (با سقف برای جلوگیری از باد کردن context).

    نقشه همیشه **کامل** فرستاده می‌شه (بدون فیلتر بر اساس سوال) — فیلتر کردن
    نقشه باعث می‌شد ایجنت فایل موردنظرش رو توی نقشه نبینه و مجبور بشه با
    grep/read دنبالش بگرده → tool call بیشتر. کاهش توکنِ تورن‌های تکراری از
    طریق کش هش نقشه (در graph.py) انجام می‌شه، نه فیلتر کردن محتوا.
    """
    try:
        sym_map = build_symbol_map(root)
    except Exception:  # noqa: BLE001 — هرگز نباید اجرای اصلی رو متوقف کنه
        return ""
    if not sym_map:
        return ""
    # گروه‌بندی بر اساس پوشهٔ بالا (توی پروژه‌های تخت = ".").
    folders: dict[str, list[str]] = {}
    for rel in sym_map:
        top = rel.split("/", 1)[0] if "/" in rel else "."
        folders.setdefault(top, []).append(rel)

    lines: list[str] = []
    for folder in sorted(folders)[:max_folders]:
        lines.append(f"📁 {folder}/")
        for rel in sorted(folders[folder])[:max_files]:
            syms = sym_map[rel][:max_symbols_per_file]
            if not syms:
                continue
            lines.append(f"  📄 {rel}")
            for name, line, typ in syms:
                lines.append(f"    ├─ {typ} {name} (L{line})")
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "\n\n===== CODE MAP (live symbol index — go straight to read, no grep needed) =====\n"
        + body
    )


def clear_symbol_cache(root: str | None = None) -> None:
    """پاک کردن کش نماد (مثلاً بعد از ویرایش فایل‌ها)."""
    with _CACHE_LOCK:
        if root is None:
            _CACHE.clear()
        else:
            _CACHE.pop(os.path.realpath(os.path.abspath(root)), None)
