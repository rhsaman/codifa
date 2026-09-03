"""تست endpoint: GET /code-map

این endpoint نقشه‌ی زنده‌ی نمادهای یه workspace رو برمی‌گردونه و توسط
پنل فرانت‌اند `<CodeMapPanel />` استفاده می‌شه. هر بار که کاربر پنل رو
باز می‌کنه، فرانت‌اند یه فچ به این آدرس می‌زنه.

نکتهٔ محیطی: conftest موجود در backend/tests/ یه mock OpenAI server
بالا می‌آره که نیاز به langchain_core و agents داره. در محیط‌هایی که این
deps نصب نیستن (مثلاً یه runner تست minimal)، conftest fail می‌کنه و همهٔ
تست‌های این پوشه skip می‌شن. این رفتار pytest هست، نه مشکل این فایل —
در محیط dev واقعی (`uv sync`) همه چیز در دسترسه و این تست‌ها اجرا
می‌شن.
"""

from __future__ import annotations

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

fastapi = pytest.importorskip("fastapi")
TestClient = pytest.importorskip("fastapi.testclient").TestClient


@pytest.fixture(scope="module")
def client():
    """TestClient رو بالا بیار. هزینه‌ی import بالاست ولی فقط یک‌بار برای کل ماژول."""
    from server import app

    return TestClient(app)


def test_code_map_returns_dict_of_lists(client, tmp_path):
    (tmp_path / "a.py").write_text(
        "def hello():\n    pass\n\n\nclass Foo:\n    def bar(self):\n        return 1\n",
        encoding="utf-8",
    )
    r = client.get(f"/code-map?root={tmp_path}")
    assert r.status_code == 200, r.text
    data = r.json()
    assert isinstance(data, dict)
    assert "a.py" in data
    syms = data["a.py"]
    assert isinstance(syms, list)
    assert any(s["name"] == "hello" for s in syms)
    assert any(s["name"] == "Foo" and s["kind"] == "class" for s in syms)
    # ساختار هر نماد: {name, line, kind} — line باید int مثبت باشه
    for s in syms:
        assert set(s.keys()) == {"name", "line", "kind"}
        assert isinstance(s["line"], int) and s["line"] > 0
        assert isinstance(s["name"], str) and s["name"]


def test_code_map_works_for_multiple_languages(client, tmp_path):
    """endpoint باید چند زبان رایج رو هم‌زمان هندل کنه."""
    (tmp_path / "main.go").write_text("package main\nfunc main() {}\n", encoding="utf-8")
    (tmp_path / "lib.rs").write_text("fn foo() {}\nstruct Bar {}\n", encoding="utf-8")
    (tmp_path / "app.ts").write_text(
        "export class Greeter {\n  greet(name: string) { return `hi ${name}` }\n}\n",
        encoding="utf-8",
    )
    r = client.get(f"/code-map?root={tmp_path}")
    assert r.status_code == 200, r.text
    data = r.json()
    # tree-sitter ممکنه برای بعضی فایل‌ها چیزی پیدا نکنه (مثل app.ts اگر
    # tags.scm شامل class method نباشه)، ولی حداقل main.go و lib.rs باید باشن
    assert "main.go" in data
    assert "lib.rs" in data


def test_code_map_accepts_new_languages_in_text_extensions(client, tmp_path):
    """زبان‌های جدید اضافه‌شده به _TEXT_EXTENSIONS (zig, dart, lua, …) باید
    توسط endpoint شناسایی بشن. اگه tree-sitter نصب نباشه، regex fallback
    باید حداقل یه نماد برگردونه (نه خالی و نه crash)."""
    (tmp_path / "main.zig").write_text(
        'const std = @import("std");\npub fn main() void {}\n',
        encoding="utf-8",
    )
    (tmp_path / "app.dart").write_text(
        "void main() {}\nclass Foo {}\n",
        encoding="utf-8",
    )
    r = client.get(f"/code-map?root={tmp_path}")
    assert r.status_code == 200, r.text
    data = r.json()
    # حداقل یکی از این دو فایل باید ایندکس بشه (هر دو در حالت ایده‌آل)
    indexed = [p for p in ("main.zig", "app.dart") if p in data and len(data[p]) > 0]
    assert indexed, f"no symbols extracted for any new language: {data!r}"


def test_code_map_404_for_missing_workspace(client):
    r = client.get("/code-map?root=/this/path/definitely/does/not/exist/anywhere")
    assert r.status_code == 404
    assert "workspace not found" in r.json()["detail"].lower()


def test_code_map_empty_workspace_returns_empty_dict(client, tmp_path):
    """workspace خالی (بدون فایل کد) → dict خالی، نه crash."""
    r = client.get(f"/code-map?root={tmp_path}")
    assert r.status_code == 200, r.text
    assert r.json() == {}


def test_code_map_500_path_returns_proper_error(client, tmp_path, monkeypatch):
    """اگه build_symbol_map خطا بده (مثلاً permission denied)، endpoint باید
    500 برگردونه نه اینکه exception لو بده."""
    def boom(_root):
        raise RuntimeError("simulated failure")

    # server.py این تابع رو از symbol_index وارد می‌کنه، پس اونجا باید monkeypatch کنیم
    import symbol_index
    monkeypatch.setattr(symbol_index, "build_symbol_map", boom)
    r = client.get(f"/code-map?root={tmp_path}")
    assert r.status_code == 500
    assert "code-map build failed" in r.json()["detail"].lower()
