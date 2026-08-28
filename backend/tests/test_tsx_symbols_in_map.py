"""تست: فایل‌های .tsx/.jsx/.vue/.svelte باید تو نقشه ظاهر بشن.

قبلاً filename_to_lang("Sidebar.tsx") → "tsx" برمی‌گردوند که گرامرش توی
tree-sitter-language-pack نصب نیست → _get_tags_raw قبل از رسیدن به fallback
regex برمی‌گشت به [] → فایل اصلاً تو نقشه نمی‌اومد و مدل مجبور بود دستی بخوندش.
"""

import os

from symbol_index import build_symbol_map


def _write(root, rel, content):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(content)


def test_tsx_symbols_extracted(tmp_path):
    _write(
        tmp_path,
        "src/components/Sidebar.tsx",
        "export function Sidebar() {\n  const x = 1\n}\n"
        "export const useStore = () => ({})\n",
    )
    sym_map = build_symbol_map(str(tmp_path))
    assert "src/components/Sidebar.tsx" in sym_map, sym_map
    names = {n for n, _, _ in sym_map["src/components/Sidebar.tsx"]}
    assert "Sidebar" in names, names


def test_jsx_symbols_extracted(tmp_path):
    _write(
        tmp_path,
        "src/Button.jsx",
        "export function Button() { return null }\n",
    )
    sym_map = build_symbol_map(str(tmp_path))
    assert "src/Button.jsx" in sym_map, sym_map
    names = {n for n, _, _ in sym_map["src/Button.jsx"]}
    assert "Button" in names, names


def test_vue_symbols_extracted(tmp_path):
    _write(
        tmp_path,
        "src/App.vue",
        "<script setup>\nconst msg = 'hi'\nfunction greet() {}\n</script>\n",
    )
    sym_map = build_symbol_map(str(tmp_path))
    assert "src/App.vue" in sym_map, sym_map
