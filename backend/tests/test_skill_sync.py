import os
import shutil

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


# ---------------------------------------------------------------------------
# اسکیل‌های built-in باید انگلیسی باشند + پاکسازی relic تغییرنام‌یافته
# ---------------------------------------------------------------------------


def test_shipped_skills_have_english_names():
    """همهٔ اسکیل‌های shipped باید نام انگلیسی (ASCII) داشته باشند."""
    folder = tools._builtin_skills_dir()
    shipped = [f for f in os.listdir(folder) if f.endswith(".md")]
    assert shipped, "پوشهٔ اسکیل‌های shipped نباید خالی باشد"
    for fn in shipped:
        with open(os.path.join(folder, fn), encoding="utf-8") as fh:
            raw = fh.read()
        name, _desc, _body = tools._parse_skill_markdown(raw)
        assert name and name.isascii(), f"{fn}: نام باید انگلیسی باشد، نه {name!r}"
        assert tools.slugify(name), f"{fn}: نام باید حروف/ارقام انگلیسی داشته باشد"


def test_sync_retires_renamed_builtin_relic(skill_env):
    """بعد از تغییر نام یک built-in، نسخهٔ ذخیره‌شدهٔ قدیمی باید پاک شود."""
    # دادهٔ قدیمی کاربر: نسخهٔ با نام فارسی (پیش از تغییر نام به انگلیسی)
    state_db.save_skill("یادگیری زبان از روی داکیومنت", "", "d", "OLD BODY")
    # فایل shipped جدید را در پوشهٔ built-in موقت قرار بده
    shutil.copy(
        os.path.join(os.path.dirname(tools.__file__), "skills", "learn-from-docs.md"),
        skill_env / "learn-from-docs.md",
    )
    seeded = tools.sync_builtin_skills()
    assert "Learn from Docs" in seeded
    names = {s["name"] for s in state_db.list_skills()}
    assert "Learn from Docs" in names
    assert "یادگیری زبان از روی داکیومنت" not in names, "relic باید پاک شود"


def test_sync_reseeds_when_description_changes(skill_env):
    """تغییر توصیف shipped (حتی بدون تغییر بدنه) باید re-sync شود."""
    tools.sync_builtin_skills()
    changed = BUILTIN_V1.replace(
        "description: a test skill", "description: a NEW description"
    )
    (skill_env / "test-skill.md").write_text(changed, encoding="utf-8")
    seeded = tools.sync_builtin_skills()
    assert "Test Skill" in seeded
    skill = next(s for s in state_db.list_skills() if s["name"] == "Test Skill")
    assert skill["description"] == "a NEW description"


# ---------------------------------------------------------------------------
# اسکیل چندفایلی (Codex-style): فایل‌های اضافه کنار skill.md
# ---------------------------------------------------------------------------


def test_persist_skill_with_extra_files(skill_env):
    """ساخت با فایل اضافه: فایل کنار skill.md ذخیره و در list دیده می‌شود."""
    result = tools.persist_skill(
        "---\nname: Multi File\n---\n\n# Multi File\n\nbody\n",
        extra_files={"notes.md": "HELLO-NOTES"},
    )
    assert result.get("ok"), result
    assert "notes.md" in (result.get("files") or [])
    skill = next(s for s in state_db.list_skills() if s["name"] == "Multi File")
    assert "notes.md" in (skill.get("files") or [])


def test_load_skill_specific_extra_file(skill_env):
    """لود یک فایل خاص با load_skill(name, file) باید محتوای همان فایل را بدهد."""
    import asyncio

    tools.persist_skill(
        "---\nname: Multi File\n---\n\n# Multi File\n\nbody\n",
        extra_files={"notes.md": "HELLO-NOTES"},
    )
    state_db.invalidate_skills_cache()
    cbs = tools.make_tool_callbacks(root="/tmp", emit=lambda e: None)
    out = asyncio.run(cbs["load_skill"]("Multi File", "notes.md"))
    assert "HELLO-NOTES" in out


def test_rewrite_body_keeps_extra_files(skill_env):
    """بازنویسی بدنه اصلی نباید فایل‌های اضافه را پاک کند."""
    tools.persist_skill(
        "---\nname: Multi File\n---\n\n# Multi File\n\nbody one\n",
        extra_files={"notes.md": "HELLO-NOTES"},
    )
    result = tools.persist_skill(
        "---\nname: Multi File\n---\n\n# Multi File\n\nbody two\n",
    )
    assert result.get("ok"), result
    assert "notes.md" in (result.get("files") or [])
    assert state_db.read_skill_extra_file("Multi File", "notes.md") == "HELLO-NOTES"


def test_skills_file_endpoint_returns_extra_file(skill_env):
    """GET /skills/file should return the stored extra file content."""
    import asyncio

    from server import skills_file

    tools.persist_skill(
        "---\nname: Multi File\n---\n\n# Multi File\n\nbody\n",
        extra_files={"notes.md": "HELLO-NOTES"},
    )
    out = asyncio.run(skills_file(name="Multi File", file="notes.md"))
    assert out["content"] == "HELLO-NOTES"


def test_generic_pick_matches_persian_sentence():
    """Generic fallback resolves Persian sentences via fa_keywords (no hardcode)."""
    import graph

    skills = [
        {"name": "translation", "slug": "translation", "description": "translate text", "content": "x", "fa_keywords": ["ترجمه", "ترجمه کن"]},
        {"name": "summarization", "slug": "summarization", "description": "summarize text", "content": "x", "fa_keywords": ["خلاصه", "خلاصه کن"]},
    ]
    picks = graph._skill_generic_pick("لطفا این متن را ترجمه کن", skills)
    assert [s["name"] for s in picks] == ["translation"]


def test_generic_pick_has_no_hardcoded_map():
    """Generic matcher must not carry a hardcoded concept dict."""
    import graph

    assert not hasattr(graph, "_SKILL_FA_CONCEPTS")
    assert not hasattr(graph, "_FA_CONCEPTS")


def test_generic_pick_vague_english_without_overlap_is_empty():
    """Vague requests without data overlap must not hallucinate a skill."""
    import graph

    skills = [
        {"name": "translation", "slug": "translation", "description": "translate text", "content": "x", "fa_keywords": ["ترجمه"]},
    ]
    assert graph._skill_generic_pick("change this icon in header", skills) == []


def test_resolve_skill_match_persian_keywords():
    """tools._resolve_skill_match resolves Persian keywords via skill data."""
    skills = [
        {"name": "translation", "slug": "translation", "description": "translate text", "fa_keywords": ["ترجمه", "ترجمه کن"]},
        {"name": "summarization", "slug": "summarization", "description": "summarize text", "fa_keywords": ["خلاصه"]},
    ]
    assert (tools._resolve_skill_match(skills, "ترجمه کن") or {}).get("name") == "translation"
    assert (tools._resolve_skill_match(skills, "خلاصه کن") or {}).get("name") == "summarization"


def test_lsp_fix_does_not_match_learn_from_docs():
    """LSP / Language Server must not resolve to the language-learning skill."""
    import graph

    skills = [
        {"name": "Learn from Docs", "slug": "learn-from-docs", "description": "When the user wants to learn a programming language directly from its official documentation", "content": "x", "fa_keywords": ["learn programming language"]},
        {"name": "translation", "slug": "translation", "description": "translate text", "content": "x", "fa_keywords": ["ترجمه"]},
    ]
    assert tools._resolve_skill_match(skills, "language server") is None
    assert tools._resolve_skill_match(skills, "fix LSP") is None
    assert graph._skill_generic_pick("fix LSP language server", skills) == []
