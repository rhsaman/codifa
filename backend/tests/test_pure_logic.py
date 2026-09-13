"""Pure-logic tests: no network, no server, no LLM.

These cover the deterministic parts of the agent — keyword extraction, the
picked-skills injection, and the sub-agent model resolver. They run in
milliseconds and are the fastest feedback loop in the suite.
"""
import agents
import graph
from agents import (
    _fts_keywords,
    _is_code_task,
    _is_impl_task,
    _is_test_task,
    _subagent_target,
)
from providers import OPENROUTER_BASE


def _skill(path, name, desc="", content=""):
    return {"path": path, "name": name, "description": desc, "content": content}


# ---------------------------------------------------------------------------
# _fts_keywords
# ---------------------------------------------------------------------------


def test_fts_keywords_extracts_significant_words():
    assert "تست" in _fts_keywords("تست بنویس برای پروژه")
    assert "بنویس" in _fts_keywords("تست بنویس برای پروژه")
    assert "testing" in _fts_keywords("write testing for this project")


def test_fts_keywords_drops_stopwords_and_short_tokens():
    # "برای" is a stopword, "ok" is too short — neither survives.
    tokens = _fts_keywords("برای تست ok")
    assert "برای" not in tokens
    assert "ok" not in tokens
    assert "تست" in tokens


def test_fts_keywords_dedupes_and_caps_terms():
    tokens = _fts_keywords("تست تست تست بنویس بنویس", max_terms=1)
    assert tokens == ["بنویس"], tokens


# ---------------------------------------------------------------------------
# _build_skills_section (کاتالوگ AVAILABLE SKILLS + تزریق انتخاب‌شده‌ها با @)
# ---------------------------------------------------------------------------


def test_skills_section_no_picks_returns_empty(monkeypatch):
    """بدون انتخاب و بدون اسکیل ذخیره‌شده: خروجی خالی."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [])
    assert graph._build_skills_section([], "/x") == ""


def test_skills_section_catalog_lists_names_and_descriptions(monkeypatch):
    """کاتالوگ پیش‌فرض: نام + توضیح همهٔ اسکیل‌ها بدون بدنه‌ها."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح آلفا", "BODY-A"),
        _skill("file://skills/b/skill.md", "Beta", "توضیح بتا", "BODY-B"),
    ])
    out = graph._build_skills_section([], "/x")
    assert "AVAILABLE SKILLS" in out
    assert "Alpha" in out and "توضیح آلفا" in out
    assert "Beta" in out and "توضیح بتا" in out
    assert "BODY-A" not in out and "BODY-B" not in out, "بدنه‌ها نباید در کاتالوگ باشند"
    assert "load_skill" in out, "راهنمای auto-trigger باید ابزار را معرفی کند"


def test_skills_section_catalog_disabled(monkeypatch):
    """catalog=False (مدل‌های با کانتکست کوچک): کاتالوگ ساخته نمی‌شود."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح", "BODY-A"),
    ])
    out = graph._build_skills_section([], "/x", catalog=False)
    assert out == ""


def test_skills_section_picked_skill_body_inlined(monkeypatch):
    """با انتخاب: بدنهٔ کامل همان اسکیل تزریق می‌شود؛ بدنهٔ بقیه غایب است."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح آلفا", "BODY-A"),
        _skill("file://skills/b/skill.md", "Beta", "توضیح بتا", "BODY-B"),
    ])
    out = graph._build_skills_section(["Alpha"], "/x")
    assert "BODY-A" in out
    assert "BODY-B" not in out, "اسکیل انتخاب‌نشده نباید تزریق شود"
    assert "AVAILABLE SKILLS" in out, "کاتالوگ باید همراه انتخاب دستی باشد"


def test_skills_section_duplicate_picks_inlined_once(monkeypatch):
    """انتخاب تکراری یک اسکیل، فقط یک‌بار تزریق می‌شود."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح", "BODY-A"),
    ])
    out = graph._build_skills_section(["Alpha", "alpha", "ALPHA"], "/x")
    assert out.count("BODY-A") == 1


def test_skills_section_unknown_pick_returns_empty(monkeypatch):
    """انتخاب ناشناخته: فقط کاتالوگ برمی‌گردد — بدون بدنه و بدون جایگزین."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح", "BODY-A"),
    ])
    out = graph._build_skills_section(["ناموجود"], "/x")
    assert "BODY-A" not in out
    assert "AVAILABLE SKILLS" in out


def test_skills_section_missing_pick_emits_skill_event(monkeypatch):
    """اسکیل گم‌شده: رویداد skill با note هشدار صادر می‌شود تا کاربر بفهمد چرا اعمال نشد."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح", "BODY-A"),
    ])
    events: list[dict] = []
    out = graph._build_skills_section(["ناموجود"], "/x", emit=events.append)
    assert "BODY-A" not in out, "بدنهٔ اسکیل گم‌شده نباید تزریق شود"
    assert len(events) == 1
    assert events[0]["kind"] == "skill"
    assert events[0]["skills"] == []
    assert events[0]["manual"] is True
    assert "ناموجود" in events[0]["note"]


def test_skills_section_partial_missing_still_inlines_found(monkeypatch):
    """جفت (پیدا‌شده + گم‌شده): بدنهٔ پیدا‌شده تزریق و رویداد skill نام‌های گم‌شده را می‌دهد."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [
        _skill("file://skills/a/skill.md", "Alpha", "توضیح", "BODY-A"),
    ])
    events: list[dict] = []
    out = graph._build_skills_section(["Alpha", "Beta"], "/x", emit=events.append)
    assert "BODY-A" in out
    assert len(events) == 1
    assert events[0]["kind"] == "skill"
    assert events[0]["skills"] == ["Alpha"]
    assert "beta" in events[0]["note"]


def test_skills_section_no_emit_backward_compatible(monkeypatch):
    """بدون emit (فراخوانی‌های قدیمی/تست‌ها): رفتار قبلی حفظ می‌شود."""
    monkeypatch.setattr(agents, "_load_skills", lambda _r: [])
    assert graph._build_skills_section(["Alpha"], "/x") == ""


# ---------------------------------------------------------------------------
# _subagent_target (sub-agent model resolver)
# ---------------------------------------------------------------------------


def _parent(**over):
    base = {
        "parent_provider": "custom",
        "parent_base_url": "http://parent.example/v1",
        "parent_api_key": "parent-key",
        "parent_env_var": "",
        "parent_oauth_token": "",
    }
    base.update(over)
    return base


def _no_row(_pid):
    return None


def test_subagent_target_openrouter_free_routes_through_openrouter():
    # User's exact case: openrouter/free with NO saved OpenRouter row
    # (env-var auth) while the parent is a custom gateway.
    t = _subagent_target("openrouter/free", **_parent(), provider_lookup=_no_row)
    assert t is not None, "openrouter/free must resolve"
    kind, model, base, key, env, oauth, pid = t
    assert kind == "openrouter", f"kind={kind}"
    assert model == "openrouter/free", f"model={model}"
    assert base == OPENROUTER_BASE, f"base={base}"
    assert key == "" and env == "" and oauth == "", "env-only creds expected"
    assert pid == "openrouter", f"pid={pid}"


def test_subagent_target_saved_row_wins_over_meta_defaults():
    row = {
        "id": "openrouter", "kind": "openrouter", "baseUrl": "ignored",
        "apiKey": "sk-saved", "envVar": "", "oauthRefreshToken": "oauth-saved",
    }
    t = _subagent_target("openrouter/free", **_parent(), provider_lookup=lambda _p: row)
    assert t is not None and t[0] == "openrouter" and t[1] == "openrouter/free", t
    assert t[3] == "sk-saved" and t[5] == "oauth-saved", "saved row creds must win"


def test_subagent_target_parent_kind_prefix_keeps_parent_creds():
    t = _subagent_target("custom/free", **_parent(), provider_lookup=_no_row)
    assert t == ("custom", "free", "http://parent.example/v1", "parent-key", "", "", ""), t


def test_subagent_target_bare_model_stays_parent_relative():
    t = _subagent_target("free", **_parent(), provider_lookup=_no_row)
    assert t == ("custom", "free", "http://parent.example/v1", "parent-key", "", "", ""), t


def test_subagent_target_openrouter_parent_keeps_parent_creds():
    t = _subagent_target(
        "openrouter/free", **_parent(parent_provider="openrouter"), provider_lookup=_no_row
    )
    assert t == ("openrouter", "free", "http://parent.example/v1", "parent-key", "", "", ""), t


# ---------------------------------------------------------------------------
# _is_code_task / _is_impl_task / _is_test_task (test-verification gating)
# ---------------------------------------------------------------------------


def test_is_code_task_catches_prompts_without_impl_keywords():
    # The user's exact gap: "the login is broken" has no fix/implement/add
    # keyword, so `_is_impl_task` misses it — but it IS code work and must be
    # covered by test verification.
    assert _is_code_task("the login button is broken")
    assert _is_code_task("app crashes when I click submit")
    assert _is_code_task("make the button green")
    assert _is_code_task("لاگین خرابه")


def test_is_code_task_excludes_trivial_and_doc_only_prompts():
    assert not _is_code_task("explain this function")
    assert not _is_code_task("fix the typo in README")
    assert not _is_code_task("what does this do")
    assert not _is_code_task("hi")
    assert not _is_code_task("")
    assert not _is_code_task("   ")


def test_is_code_task_broader_than_is_impl_task():
    # Every impl task is a code task, but code task also covers keyword-less
    # bug reports that impl-task regex misses.
    for p in ("fix the bug", "implement login", "add tests", "refactor auth"):
        assert _is_impl_task(p), p
        assert _is_code_task(p), p
    assert _is_impl_task("the login button is broken") is False
    assert _is_code_task("the login button is broken") is True


def test_is_test_task_still_detects_test_prompts():
    assert _is_test_task("run the tests")
    assert _is_test_task("تست بنویس")
    assert _is_test_task("add unit tests for the parser")
    assert not _is_test_task("fix the login bug")