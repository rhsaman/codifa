"""Pure-logic tests: no network, no server, no LLM.

These cover the deterministic parts of the agent — keyword extraction, skill
selection (keyword + semantic tiers), the progressive-disclosure skills
section, and the sub-agent model resolver. They run in milliseconds and are
the fastest feedback loop in the suite.
"""
from agents import (
    _SKILL_GAP_MIN,
    _auto_select_skills,
    _fts_keywords,
    _is_code_task,
    _is_impl_task,
    _is_test_task,
    _skill_keyword_matches,
    _skills_section,
    _subagent_target,
)
from providers import OPENROUTER_BASE


def _skill(path, name, desc="", content=""):
    return {"path": path, "name": name, "description": desc, "content": content}


class FakeStore:
    """Minimal stand-in for the vector store: returns canned hits."""

    def __init__(self, hits=None, db_path=":memory:", fail=False):
        self.hits = hits or []
        self.db_path = db_path
        self.fail = fail

    def search(self, prompt, kind=None, top_k=8, min_score=0.0):
        if self.fail:
            raise RuntimeError("store down")
        return self.hits


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
# _skill_keyword_matches
# ---------------------------------------------------------------------------


def test_skill_keyword_matches_name_hits_rank_first():
    testing = _skill("db://skills/testing", "Testing (تستنویسی)", "نوشتن تست", "بدنه")
    brainstorming = _skill("db://skills/brainstorming", "Brainstorming", "ایدهپردازی", "بدنه")
    hits = [s for _, s, _ in _skill_keyword_matches("تست بنویس", [brainstorming, testing])]
    assert hits == [testing], f"name hit must win, got {[s['name'] for s in hits]}"


def test_skill_keyword_matches_plural_fallback():
    # "tests" -> "test" matches a description that says "testing".
    skill = _skill("db://skills/testing", "QA", "writing testing for projects", "بدنه")
    hits = [s for _, s, _ in _skill_keyword_matches("run the tests", [skill])]
    assert hits == [skill]


def test_skill_keyword_matches_name_hit_dominates_desc_only():
    # "test" appears in decision-making's description ("test assumptions") but
    # only Testing is NAMED after it — the desc-only match must be dropped.
    testing = _skill("db://skills/testing", "Testing (تستنویسی)", "نوشتن تست", "بدنه")
    decision = _skill("db://skills/decision", "decision-making",
                      "weigh options, test assumptions, and commit", "بدنه")
    hits = [s for _, s, _ in _skill_keyword_matches("تست بنویس برای پروژه", [decision, testing])]
    assert hits == [testing], f"name hit must dominate, got {[s['name'] for s in hits]}"


def test_skill_keyword_matches_persian_alias_matches_english_name():
    # "گیت" (Persian for git) reaches the English-named git-workflow via the
    # alias map — the exact case that used to pick design skills.
    git = _skill("db://skills/git-workflow", "git-workflow",
                 "Follow a clean, safe git workflow: status, branch, staged commits, push.")
    design = _skill("db://skills/ui-ux", "UI/UX Pro Max", "هوش طراحی UI/UX", "بدنه")
    hits = [s for _, s, _ in _skill_keyword_matches("پروژه رو پوش کن تو گیت", [design, git])]
    assert hits == [git], f"alias must reach git-workflow, got {[s['name'] for s in hits]}"


def test_skill_keyword_matches_weak_word_does_not_false_positive():
    # "رسمی" is a homonym ("formal email" vs "راهنمای رسمی" = official guide in
    # a design skill). The weak-keyword filter must stop the literal match.
    design = _skill("db://skills/design", "Anthropic Frontend Design",
                    "راهنمای رسمی Anthropic برای طراحی بصری", "بدنه")
    assert _skill_keyword_matches("یه ایمیل رسمی بنویس", [design]) == []


def test_skill_keyword_matches_skill_word_does_not_false_positive():
    # "اسکیل" (skill) is self-referential: it appears in nearly every Persian
    # skill description ("اسکیل طراحی فرانتاند..."), so a meta-conversation
    # about skills must not attach a design skill just because both sides
    # contain the word "skill".
    design = _skill("db://skills/ckw-design", "CKW Design Skill",
                    "اسکیل طراحی فرانتاند Conner K. Ward برای طراحی UI", "بدنه")
    assert _skill_keyword_matches("اسکیل همچنان اشتباه صدا زده میشه", [design]) == []
    assert _skill_keyword_matches("یک اسکیل جدید بساز", [design]) == []
    assert _skill_keyword_matches("create a new skill for testing", [design]) == []


def test_skill_keyword_matches_new_skill_works_via_alias():
    # The user's real concern: "whatever skill I add later, it must work".
    # Simulate ADDING a brand-new English-named skill (docker-deploy) and a
    # Persian prompt about it — the alias map must reach it with no per-skill
    # hardcoding. This is the mechanism, not a one-off for the git sentence.
    docker = _skill("db://skills/docker-deploy", "docker-deploy",
                    "Build, run and deploy Docker containers to a server.", "بدنه")
    design = _skill("db://skills/ui-ux", "UI/UX Pro Max", "هوش طراحی UI/UX", "بدنه")
    hits = [s for _, s, _ in _skill_keyword_matches("داکر رو روی سرور دیپلوی کن", [design, docker])]
    assert hits == [docker], f"new skill must be found, got {[s['name'] for s in hits]}"


def test_skill_keyword_matches_empty_when_no_hit():
    skill = _skill("db://skills/design", "Design", "رنگ و چیدمان", "بدنه")
    assert _skill_keyword_matches("سلام خوبی", [skill]) == []


# ---------------------------------------------------------------------------
# _skills_section (progressive disclosure)
# ---------------------------------------------------------------------------


def test_skills_section_empty_for_no_skills():
    assert _skills_section([]) == ""


def test_skills_section_compact_when_nothing_picked():
    a = _skill("db://skills/a", "Alpha", "توضیح آلفا", "BODY-A")
    b = _skill("db://skills/b", "Beta", "توضیح بتا", "BODY-B")
    section = _skills_section([a, b])
    assert "Alpha — توضیح آلفا" in section
    assert "Beta — توضیح بتا" in section
    assert "BODY-A" not in section and "BODY-B" not in section, \
        "no picked skill -> no body may be inlined"


def test_skills_section_never_inlines_bodies():
    # Option B: full bodies are NEVER inlined — the model loads them on demand
    # via read_skill. The section is discovery-only (name + description).
    a = _skill("db://skills/a", "Alpha", "توضیح آلفا", "BODY-A")
    b = _skill("db://skills/b", "Beta", "توضیح بتا", "BODY-B")
    section = _skills_section([a, b])
    assert "BODY-A" not in section and "BODY-B" not in section, \
        "no skill body may ever be inlined"
    assert "read_skill" in section, "section must point the agent at read_skill"


def test_skills_section_truncates_long_descriptions():
    long_desc = "این یک توضیح خیلی طولانی است که باید کوتاه شود " * 6
    a = _skill("db://skills/a", "Alpha", long_desc, "BODY-A")
    section = _skills_section([a])
    assert "BODY-A" not in section
    line = next(l for l in section.splitlines() if l.startswith("- Alpha"))
    assert len(line) <= 110, f"catalog line must be truncated, got {len(line)} chars"
    assert line.endswith("…")


# ---------------------------------------------------------------------------
# _auto_select_skills
# ---------------------------------------------------------------------------


def test_auto_select_skills_empty_inputs():
    assert _auto_select_skills(None, [], "تست") == []
    assert _auto_select_skills(FakeStore(), [], "تست") == []
    assert _auto_select_skills(FakeStore(), [_skill("p", "X")], "") == []


def test_auto_select_skills_keyword_tier_wins_over_semantic_noise():
    testing = _skill("db://skills/testing", "Testing (تستنویسی)", "نوشتن تست", "بدنه")
    brainstorming = _skill("db://skills/brainstorming", "Brainstorming", "ایدهپردازی", "بدنه")
    # Semantic tier would pick brainstorming (higher score) — the keyword tier
    # must override it because the prompt literally says "تست".
    store = FakeStore(hits=[
        {"key": "db://skills/brainstorming", "score": 0.81},
        {"key": "db://skills/testing", "score": 0.80},
    ])
    picked = _auto_select_skills(store, [testing, brainstorming], "تست بنویس برای پروژه")
    assert picked == [testing], f"keyword tier must win, got {[s['name'] for s in picked]}"


def test_auto_select_skills_semantic_below_floor_returns_nothing():
    store = FakeStore(hits=[{"key": "db://skills/a", "score": 0.5}])
    skill = _skill("db://skills/a", "Alpha", "توضیح", "بدنه")
    assert _auto_select_skills(store, [skill], "سلام خوبی") == []


def test_auto_select_skills_semantic_noise_gap_returns_nothing():
    # Compressed-band noise: top-1 beats runner-up by less than _SKILL_GAP_MIN.
    a = _skill("db://skills/a", "Alpha", "توضیح", "بدنه")
    b = _skill("db://skills/b", "Beta", "توضیح", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/a", "score": 0.81},
        {"key": "db://skills/b", "score": 0.807},
    ])
    assert 0.81 - 0.807 < _SKILL_GAP_MIN
    assert _auto_select_skills(store, [a, b], "یه کد پایتون بنویس") == []


def test_auto_select_skills_single_skill_needs_no_gap():
    a = _skill("db://skills/a", "Alpha", "توضیح", "بدنه")
    store = FakeStore(hits=[{"key": "db://skills/a", "score": 0.85}])
    assert _auto_select_skills(store, [a], "طراحی داشبورد") == [a]


def test_auto_select_skills_near_ties_all_returned():
    a = _skill("db://skills/a", "Alpha", "توضیح", "بدنه")
    b = _skill("db://skills/b", "Beta", "توضیح", "بدنه")
    c = _skill("db://skills/c", "Gamma", "توضیح", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/a", "score": 0.85},
        {"key": "db://skills/b", "score": 0.84},
        {"key": "db://skills/c", "score": 0.70},  # long tail -> dropped
    ])
    picked = _auto_select_skills(store, [a, b, c], "طراحی UI برای داشبورد")
    assert [s["path"] for s in picked] == ["db://skills/a", "db://skills/b"], \
        f"near-ties must all be returned, got {[s['path'] for s in picked]}"


def test_auto_select_skills_semantic_below_high_floor_returns_nothing():
    # The semantic tier is a high-confidence safety net: compressed-band noise
    # (0.79-0.83) must never attach a skill. "یه کد پایتون بنویس" measured
    # Testing at 0.831 — below the 0.84 floor, so nothing is picked.
    a = _skill("db://skills/a", "Testing (تستنویسی)", "نوشتن تست", "بدنه")
    store = FakeStore(hits=[{"key": "db://skills/a", "score": 0.831}])
    assert _auto_select_skills(store, [a], "یه کد پایتون بنویس") == []


def test_auto_select_skills_persian_alias_reaches_english_skill():
    # "گیت" (Persian for git) must reach the English-named git-workflow skill
    # via the alias map — the exact case that used to pick design skills.
    git = _skill("db://skills/git-workflow", "git-workflow",
                 "Follow a clean, safe git workflow: status, branch, staged commits, push.")
    design = _skill("db://skills/ui-ux", "UI/UX Pro Max", "هوش طراحی UI/UX", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/ui-ux", "score": 0.80},
        {"key": "db://skills/git-workflow", "score": 0.79},
    ])
    picked = _auto_select_skills(store, [git, design], "پروژه رو پوش کن تو گیت")
    assert picked == [git], f"alias must reach git-workflow, got {[s['name'] for s in picked]}"


def test_auto_select_skills_weak_keyword_does_not_false_positive():
    # "رسمی" is a homonym: "formal email" vs "راهنمای رسمی" (official guide) in
    # a design skill's description. The weak-keyword filter must stop the
    # literal match so a formal-email request never attaches a design skill.
    design = _skill("db://skills/design", "Anthropic Frontend Design",
                    "راهنمای رسمی Anthropic برای طراحی بصری", "بدنه")
    writing = _skill("db://skills/writing", "professional-writing",
                     "Write clear, professional emails, reports, articles", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/design", "score": 0.80},
        {"key": "db://skills/writing", "score": 0.86},
    ])
    picked = _auto_select_skills(store, [design, writing], "یه ایمیل رسمی بنویس")
    assert picked == [writing], \
        f"weak 'رسمی' must not match design, got {[s['name'] for s in picked]}"


def test_auto_select_skills_skill_word_does_not_false_positive():
    # The exact reported bug: a meta-conversation about skills ("اسکیل همچنان
    # اشتباه صدا زده میشه") used to attach CKW Design Skill because its
    # description contains the word "اسکیل". The self-referential skill words
    # must be dropped so no unrelated skill is injected into the prompt.
    design = _skill("db://skills/ckw-design", "CKW Design Skill",
                    "اسکیل طراحی فرانتاند Conner K. Ward برای طراحی UI", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/ckw-design", "score": 0.80},
    ])
    assert _auto_select_skills(store, [design], "اسکیل همچنان اشتباه صدا زده میشه") == []
    assert _auto_select_skills(store, [design], "یک اسکیل جدید بساز") == []


def test_auto_select_skills_store_failure_returns_nothing():
    a = _skill("db://skills/a", "Alpha", "توضیح", "بدنه")
    store = FakeStore(fail=True)
    assert _auto_select_skills(store, [a], "تست بنویس") == []


def test_auto_select_skills_desc_hit_non_distinctive_low_sem_rejected():
    # A generic word ("طراحی") in TWO skills' descriptions is not distinctive
    # and neither clears the description floor -> nothing may be attached.
    a = _skill("db://skills/a", "Alpha", "طراحی رابط کاربری برای داشبورد", "بدنه")
    b = _skill("db://skills/b", "Beta", "طراحی بصری و رنگ", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/a", "score": 0.75},
        {"key": "db://skills/b", "score": 0.74},
    ])
    assert _auto_select_skills(store, [a, b], "طراحی") == []


def test_auto_select_skills_future_skill_found_via_name_hit():
    # The user's real concern: a skill added LATER must still be found. The
    # sound mechanism is a NAME hit: a well-named skill ("docker-deploy")
    # reached through the Persian alias ("داکر" -> docker) is unambiguous and
    # passes outright — no per-skill tuning involved. This is what keeps future
    # skills auto-selectable without relying on the embedding (weak for Persian)
    # or on description distinctiveness (which is not a relevance signal).
    docker = _skill("db://skills/docker-deploy", "docker-deploy",
                    "Build, run and deploy Docker containers to a server.", "بدنه")
    design = _skill("db://skills/ui-ux", "UI/UX Pro Max", "هوش طراحی UI/UX", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/docker-deploy", "score": 0.76},
        {"key": "db://skills/ui-ux", "score": 0.75},
    ])
    picked = _auto_select_skills(store, [design, docker], "داکر رو روی سرور دیپلوی کن")
    assert picked == [docker], \
        f"name-hit future skill must be found, got {[s['name'] for s in picked]}"


def test_auto_select_skills_desc_hit_below_floor_rejected_even_when_distinctive():
    # The reported bug: "چجوری این ریپو رو کاری کنم دیده بشه و ادم ها بهش استار
    # بدن؟" picked Frontend Design Principles because "ادم" (people) appears in
    # its description (df == 1) — distinctiveness is NOT relevance. A
    # description-only hit must clear _SKILL_DESC_FLOOR regardless of how few
    # skills share the token; otherwise nothing is attached. The skill name
    # deliberately does NOT contain the prompt token, so this exercises the
    # description-only path.
    design = _skill("db://skills/frontend-design", "Frontend Design Principles",
                    "اصول طراحی فرانتاند برای دیده شدن بهتر در وب", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/frontend-design", "score": 0.77},
    ])
    picked = _auto_select_skills(
        store, [design], "چجوری این ریپو رو کاری کنم دیده بشه و ادم ها بهش استار بدن؟"
    )
    assert picked == [], \
        f"distinctive-but-irrelevant desc hit must be rejected, got {[s['name'] for s in picked]}"


def test_auto_select_skills_desc_hit_above_floor_accepted():
    # A description-only hit that clears _SKILL_DESC_FLOOR is accepted even
    # when the token is not distinctive.
    a = _skill("db://skills/a", "Alpha", "طراحی رابط کاربری برای داشبورد", "بدنه")
    b = _skill("db://skills/b", "Beta", "طراحی بصری و رنگ", "بدنه")
    store = FakeStore(hits=[
        {"key": "db://skills/a", "score": 0.86},
        {"key": "db://skills/b", "score": 0.74},
    ])
    picked = _auto_select_skills(store, [a, b], "طراحی")
    assert picked == [a], \
        f"desc hit above floor must be accepted, got {[s['name'] for s in picked]}"


def test_auto_select_skills_top_k_caps_picks():
    # Three skills NAMED after the prompt keyword — top_k caps the picks.
    # (Descriptions avoid the token so the name hit isn't short-circuited by a
    # Persian description match inside _skill_keyword_matches.)
    a = _skill("db://skills/a", "Testing (تستنویسی)", "نوشتن تست", "بدنه")
    b = _skill("db://skills/b", "Test Runner", "اجرای سریع", "بدنه")
    c = _skill("db://skills/c", "Test Plan", "برنامهریزی", "بدنه")
    store = FakeStore(hits=[])
    picked = _auto_select_skills(store, [a, b, c], "تست بنویس", top_k=2)
    assert len(picked) == 2, f"top_k must cap picks, got {len(picked)}"


def test_skill_keyword_matches_maharat_weak_word():
    # «مهارت» is self-referential like «اسکیل» — a meta-conversation about
    # skills must not attach a skill whose description mentions it.
    skill = _skill("db://skills/design", "Design",
                   "اسکیل و مهارت طراحی فرانتاند برای UI", "بدنه")
    assert _skill_keyword_matches("یه مهارت جدید بساز", [skill]) == []


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