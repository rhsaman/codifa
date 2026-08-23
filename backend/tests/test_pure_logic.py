"""Pure-logic tests: no network, no server, no LLM.

These cover the deterministic parts of the agent — keyword extraction, the
progressive-disclosure skills section, and the sub-agent model resolver. They
run in milliseconds and are the fastest feedback loop in the suite.
"""
from agents import (
    _fts_keywords,
    _is_code_task,
    _is_impl_task,
    _is_test_task,
    _skills_section,
    _subagent_target,
)
from graph import _MEMORY_RECALL_CUES
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
# _skills_section (progressive disclosure)
# ---------------------------------------------------------------------------


def test_skills_section_empty_for_no_skills():
    assert _skills_section([]) == ""


def test_skills_section_compact_when_nothing_picked():
    a = _skill("file://skills/a/skill.md", "Alpha", "توضیح آلفا", "BODY-A")
    b = _skill("file://skills/b/skill.md", "Beta", "توضیح بتا", "BODY-B")
    section = _skills_section([a, b])
    assert "Alpha — توضیح آلفا" in section
    assert "Beta — توضیح بتا" in section
    assert "BODY-A" not in section and "BODY-B" not in section, \
        "no picked skill -> no body may be inlined"


def test_skills_section_never_inlines_bodies():
    # Full bodies are NEVER inlined — they're only attached when the user
    # @mentions a skill. The section is discovery-only (name + description).
    a = _skill("file://skills/a/skill.md", "Alpha", "توضیح آلفا", "BODY-A")
    b = _skill("file://skills/b/skill.md", "Beta", "توضیح بتا", "BODY-B")
    section = _skills_section([a, b])
    assert "BODY-A" not in section and "BODY-B" not in section, \
        "no skill body may ever be inlined"
    assert "@mention" in section, "section must tell the agent skills use @mention"
    assert "read_skill" not in section, "read_skill tool was removed"


def test_skills_section_truncates_long_descriptions():
    long_desc = "این یک توضیح خیلی طولانی است که باید کوتاه شود " * 6
    a = _skill("file://skills/a/skill.md", "Alpha", long_desc, "BODY-A")
    section = _skills_section([a])
    assert "BODY-A" not in section
    line = next(l for l in section.splitlines() if l.startswith("- Alpha"))
    assert len(line) <= 110, f"catalog line must be truncated, got {len(line)} chars"
    assert line.endswith("…")


# ---------------------------------------------------------------------------
# _subagent_target (sub-agent model resolver)
# ---------------------------------------------------------------------------


def _parent(**over):
    base = {
        "parent_provider": "opencode",
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
    # (env-var auth) while the parent is the opencode gateway.
    t = _subagent_target("openrouter/free", **_parent(), provider_lookup=_no_row)
    assert t is not None, "openrouter/free must resolve"
    kind, model, base, key, env, oauth = t
    assert kind == "openrouter", f"kind={kind}"
    assert model == "openrouter/free", f"model={model}"
    assert base == OPENROUTER_BASE, f"base={base}"
    assert key == "" and env == "" and oauth == "", "env-only creds expected"


def test_subagent_target_saved_row_wins_over_meta_defaults():
    row = {
        "id": "openrouter", "kind": "openrouter", "baseUrl": "ignored",
        "apiKey": "sk-saved", "envVar": "", "oauthRefreshToken": "oauth-saved",
    }
    t = _subagent_target("openrouter/free", **_parent(), provider_lookup=lambda _p: row)
    assert t is not None and t[0] == "openrouter" and t[1] == "openrouter/free", t
    assert t[3] == "sk-saved" and t[5] == "oauth-saved", "saved row creds must win"


def test_subagent_target_parent_kind_prefix_keeps_parent_creds():
    t = _subagent_target("opencode/free", **_parent(), provider_lookup=_no_row)
    assert t == ("opencode", "free", "http://parent.example/v1", "parent-key", "", ""), t


def test_subagent_target_bare_model_stays_parent_relative():
    t = _subagent_target("free", **_parent(), provider_lookup=_no_row)
    assert t == ("opencode", "free", "http://parent.example/v1", "parent-key", "", ""), t


def test_subagent_target_openrouter_parent_keeps_parent_creds():
    t = _subagent_target(
        "openrouter/free", **_parent(parent_provider="openrouter"), provider_lookup=_no_row
    )
    assert t == ("openrouter", "free", "http://parent.example/v1", "parent-key", "", ""), t


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


# ---------------------------------------------------------------------------
# Memory auto-recall gating (graph._MEMORY_RECALL_CUES)
# ---------------------------------------------------------------------------


def test_memory_recall_cue_explicit_persian_and_english():
    # The user's own phrase ("از مموری ببین") and common variants must trigger.
    for p in ("از مموری ببین", "ببین تو مموری چی داری", "در حافظه چیزی داری؟",
              "look in memory", "search memory for the auth flow",
              "check memory", "recall what we decided about ports"):
        assert _MEMORY_RECALL_CUES.search(p), p


def test_memory_recall_cue_not_on_plain_chatter():
    # Normal questions / code questions must NOT be treated as a memory request
    # (otherwise the gate would re-fire on every turn and defeat its purpose).
    for p in ("سلام", "how does auth work?", "fix the login bug",
              "what is a closure", "the memory leak is in parser.py"):
        assert not _MEMORY_RECALL_CUES.search(p), p