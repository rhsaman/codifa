import os

import pytest

import state_db
import tools

BUILTIN_V1 = """---
name: Test Skill
description: a test skill
---

# Test Skill

Body version one.
"""

BUILTIN_V2 = """---
name: Test Skill
description: a test skill
---

# Test Skill

Body version two.
"""


@pytest.fixture
def skill_env(tmp_path, monkeypatch):
    # Point the builtin source folder + the app skill store at temp dirs so we
    # never touch the real shipped skills or the user's data.
    src = tmp_path / "src"
    src.mkdir()
    (src / "test-skill.md").write_text(BUILTIN_V1, encoding="utf-8")
    monkeypatch.setattr(tools, "_builtin_skills_dir", lambda: str(src))
    monkeypatch.setenv("CODER_DATA_DIR", str(tmp_path / "data"))
    yield src


def _body(name: str) -> str | None:
    for s in state_db.list_skills():
        if s["name"] == name:
            return s["content"]
    return None


def test_sync_seeds_builtin_skill(skill_env):
    seeded = tools.sync_builtin_skills()
    assert "Test Skill" in seeded
    assert _body("Test Skill").strip().endswith("Body version one.")


def test_sync_reseeds_when_source_changes(skill_env):
    tools.sync_builtin_skills()
    assert _body("Test Skill").strip().endswith("Body version one.")
    # The shipped source file changed — the fix must propagate without manual delete.
    (skill_env / "test-skill.md").write_text(BUILTIN_V2, encoding="utf-8")
    seeded2 = tools.sync_builtin_skills()
    assert "Test Skill" in seeded2
    assert _body("Test Skill").strip().endswith("Body version two.")


def test_sync_skips_when_unchanged(skill_env):
    tools.sync_builtin_skills()
    # Rewrite identical content; an unchanged builtin must NOT be re-seeded.
    (skill_env / "test-skill.md").write_text(BUILTIN_V1, encoding="utf-8")
    seeded3 = tools.sync_builtin_skills()
    assert "Test Skill" not in seeded3


def test_shipped_anthropic_skill_is_clean():
    """Regression guard: the shipped skill must not contain a stray duplicate
    frontmatter block inside its body (that previously broke inlining)."""
    path = os.path.join(
        os.path.dirname(tools.__file__), "skills", "anthropic-frontend-design.md"
    )
    with open(path, encoding="utf-8") as _f:
        raw = _f.read()
    name, _desc, body = tools._parse_skill_markdown(raw)
    assert name == "Anthropic Frontend Design"
    assert "---name: frontend-design" not in body, "stray frontmatter leaked into body"
    assert body.lstrip().startswith("# Anthropic Frontend Design")


# ---------------------------------------------------------------------------
# کش list_skills (اثر انگشت mtime/حجم پوشه)
# ---------------------------------------------------------------------------


def test_list_skills_caches_between_calls(skill_env, monkeypatch):
    """فراخوانی دوم نباید دوباره از دیسک بخواند تا وقتی اثر انگشت تغییر نکند."""
    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    calls = {"n": 0}
    orig = state_db._list_skills_uncached

    def counting():
        calls["n"] += 1
        return orig()

    monkeypatch.setattr(state_db, "_list_skills_uncached", counting)
    first = state_db.list_skills()
    second = state_db.list_skills()
    assert first is second, "خروجی کش باید همان شیء باشد"
    assert calls["n"] == 1, "خواندن دومی باید از کش بیاید"


def test_save_skill_invalidates_cache(skill_env):
    """بعد از save_skill، list_skills باید skill جدید را بلافاصله ببیند."""
    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    before = {s["name"] for s in state_db.list_skills()}
    state_db.save_skill("Fresh Skill", "fresh-skill", "d", "BODY-FRESH")
    after = {s["name"] for s in state_db.list_skills()}
    assert "Fresh Skill" in after
    assert "Fresh Skill" not in before


def test_delete_skill_invalidates_cache(skill_env):
    """بعد از delete_skill، list_skills نباید skill حذف‌شده را نشان دهد."""
    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    assert any(s["name"] == "Test Skill" for s in state_db.list_skills())
    assert state_db.delete_skill("Test Skill") is True
    assert not any(s["name"] == "Test Skill" for s in state_db.list_skills())


# ---------------------------------------------------------------------------
# ابزار load_skill (افشای تدریجی — مدل بدنه را با tool call لود می‌کند)
# ---------------------------------------------------------------------------


def test_load_skill_tool_returns_body(skill_env):
    """لود با نام دقیق: بدنهٔ کامل با قالب SKILL برمی‌گردد."""
    import asyncio

    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
    assert "load_skill" in cbs, "ابزار باید در رجیستری ثبت شود"
    out = asyncio.run(cbs["load_skill"]("Test Skill"))
    assert "===== SKILL: Test Skill =====" in out
    assert "Body version one." in out


def test_load_skill_tool_case_insensitive(skill_env):
    """تطبیق نام باید casefold باشد (مثل @mention و کاتالوگ)."""
    import asyncio

    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
    out = asyncio.run(cbs["load_skill"]("test skill"))
    assert "===== SKILL: Test Skill =====" in out


def test_load_skill_tool_unknown_name_lists_available(skill_env):
    """نام ناشناخته: خطا + فهرست اسکیل‌های موجود برای خوداصلاحی مدل."""
    import asyncio

    tools.sync_builtin_skills()
    state_db.invalidate_skills_cache()
    cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
    out = asyncio.run(cbs["load_skill"]("No Such Skill"))
    assert out.startswith("ERROR:")
    assert "Test Skill" in out, "فهرست موجودها باید در خطا باشد"


# ---------------------------------------------------------------------------
# نام اسکیل باید انگلیسی باشد (slug پوشه از نام ساخته می‌شود)
# ---------------------------------------------------------------------------


def test_persist_skill_rejects_non_english_name(skill_env):
    """نام فارسی باید رد شود، نه اینکه در پوشهٔ fallback مشترک ذخیره شود."""
    result = tools.persist_skill(
        "---\nname: قرارداد نویسی\n---\n\n# قرارداد نویسی\n\nbody\n",
    )
    assert not result.get("ok"), "نام غیرانگلیسی باید رد شود"
    assert "English" in result.get("note", "")
    # هیچ پوشهٔ fallback مشترکی نباید ساخته شود.
    assert not any(s["name"] == "قرارداد نویسی" for s in state_db.list_skills())


def test_persist_skill_english_name_gets_real_path(skill_env):
    """نام انگلیسی: مسیر واقعی فایل روی دیسک برگردانده می‌شود، نه db://."""
    result = tools.persist_skill(
        "---\nname: Code Review\n---\n\n# Code Review\n\nbody\n",
    )
    assert result.get("ok"), result
    assert result["slug"] == "code-review"
    assert result["path"].endswith(os.path.join("skills", "code-review", "skill.md"))
    assert os.path.isfile(result["path"]), "فایل باید واقعاً روی دیسک باشد"


def test_create_skill_tool_rejects_non_english_name(skill_env):
    """ابزار create_skill باید نام فارسی را با خطای روشن رد کند."""
    import asyncio

    cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
    out = asyncio.run(cbs["create_skill"]("قرارداد نویسی", "d", "body"))
    assert out.startswith("ERROR"), out
    assert "English" in out


def test_save_skill_non_ascii_name_gets_distinct_folder(skill_env):
    """ایمنی state_db: نام غیر ASCII نباید در پوشهٔ مشترک «skill» بریزد."""
    state_db.save_skill("قرارداد نویسی", "", "d", "BODY-FA")
    state_db.save_skill("خلاصه‌سازی", "", "d", "BODY-SUM")
    skills = {s["name"]: s["content"] for s in state_db.list_skills()}
    assert skills.get("قرارداد نویسی") == "BODY-FA"
    assert skills.get("خلاصه‌سازی") == "BODY-SUM", "دو اسکیل نباید همدیگر را overwrite کنند"
    # هیچ پوشهٔ «skill» خالی/مشترکی نباید ساخته شود.
    entries = os.listdir(state_db.skills_dir())
    assert "skill" not in entries, entries
