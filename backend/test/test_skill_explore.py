"""Skill-name leakage into the explore search-pattern derivation.

When a skill is @mentioned (e.g. ``@vision-workflow``), its name must not
become a glob/grep keyword — otherwise the deterministic/LLM explorer searches
for skill-name files and finds nothing, which in plan mode then pushes the
planner into looping git to "find what it wants".
"""

import graph
from graph import _derive_explore_patterns, _strip_skill_mentions


def test_strip_removes_at_mention_token():
    out = _strip_skill_mentions("@vision-workflow review the auth flow", ["vision-workflow"])
    assert "@vision-workflow" not in out
    assert "review the auth flow" in out


def test_strip_removes_bare_skill_name():
    out = _strip_skill_mentions("use the code-expert skill on graph.py", ["code-expert"])
    assert "code-expert" not in out
    assert "graph.py" in out


def test_strip_is_noop_without_skills():
    p = "@vision-workflow do X"
    assert _strip_skill_mentions(p, None) == p
    assert _strip_skill_mentions(p, []) == p


def test_skill_words_excluded_from_patterns():
    clean = _strip_skill_mentions(
        "@vision-workflow find the login handler", ["vision-workflow"]
    )
    spec = _derive_explore_patterns(clean)
    joined = " ".join(spec["grep"] + spec["glob"]).lower()
    assert "vision" not in joined
    assert "workflow" not in joined
    # legitimate code terms are preserved
    assert "login" in joined or "handler" in joined


def test_mention_of_unrelated_skill_is_kept():
    # only ATTACHED skill names are stripped, not every @token
    out = _strip_skill_mentions("@someone review graph.py", ["vision-workflow"])
    assert "@someone" in out


def test_strip_handles_spaced_title_form():
    # The skill is attached as a slug but referenced in the prompt by its
    # human-readable title (spaces). The explorer must not grep its words.
    out = _strip_skill_mentions(
        "use the Anthropic Frontend Design skill to review login",
        ["anthropic-frontend-design"],
    )
    assert "Anthropic" not in out
    assert "Frontend" not in out
    assert "Design" not in out
    assert "review login" in out


def test_spaced_title_words_excluded_from_patterns():
    clean = _strip_skill_mentions(
        "Anthropic Frontend Design: where is the auth handler",
        ["anthropic-frontend-design"],
    )
    spec = _derive_explore_patterns(clean)
    joined = " ".join(spec["grep"] + spec["glob"]).lower()
    assert "anthropic" not in joined
    assert "frontend" not in joined
    assert "design" not in joined
    assert "auth" in joined or "handler" in joined


def test_at_mention_with_spaced_title():
    # "@Anthropic Frontend Design ..." — the @ stops at the space, so the title
    # words must still be scrubbed via the phrase variant.
    out = _strip_skill_mentions(
        "@Anthropic Frontend Design review the button",
        ["anthropic-frontend-design"],
    )
    assert "Anthropic" not in out
    assert "Frontend" not in out
    assert "Design" not in out
    assert "review the button" in out


def test_comma_permutation_form_is_stripped():
    # The model rephrases the attached skill name as a comma-joined, reordered
    # list (Anthropic, Design, Frontend). The stripper must catch this exact
    # permutation so the words don't leak into glob/grep queries.
    out = _strip_skill_mentions(
        "repo_search glob: grep:Anthropic, Design, Frontend queries:Anthropic, Design, Frontend",
        ["anthropic-frontend-design"],
    )
    assert "Anthropic" not in out
    assert "Frontend" not in out
    assert "Design" not in out


def test_comma_form_excluded_from_patterns():
    clean = _strip_skill_mentions(
        "Anthropic, Design, Frontend — where is the auth handler",
        ["anthropic-frontend-design"],
    )
    spec = _derive_explore_patterns(clean)
    joined = " ".join(spec["grep"] + spec["glob"]).lower()
    assert "anthropic" not in joined
    assert "frontend" not in joined
    assert "design" not in joined
    assert "auth" in joined or "handler" in joined


def test_mentioned_skill_stripped_when_state_skills_empty(monkeypatch):
    # A skill referenced only via an @mention in the text may not land in
    # state["skills"] (the frontend can send skills: []). The model still knows
    # the name from the AVAILABLE SKILLS section, so it must still be scrubbed
    # from search keywords. _skill_names_to_strip pulls every known skill name
    # from the DB so the @mention form is caught even with empty state["skills"].
    from graph import _skill_names_to_strip, _strip_skill_mentions

    monkeypatch.setattr(
        graph._agents, "_load_skills",
        lambda root: [{"name": "Anthropic Frontend Design", "content": ""}],
    )
    state = {
        "skills": None,
        "root": "",
        "request": "@Anthropic Frontend Design نام فایل هارو میخوام با ui زیبا نمیاش بده",
    }
    names = _skill_names_to_strip(state)
    assert "Anthropic Frontend Design" in names
    out = _strip_skill_mentions(
        "@Anthropic Frontend Design نام فایل هارو میخوام با ui زیبا نمیاش بده",
        names,
    )
    assert "Anthropic" not in out
    assert "Frontend" not in out
    assert "Design" not in out
    assert "نام فایل" in out


def test_unmentioned_skill_not_scrubbed(monkeypatch):
    # Only skills referenced by name / @mention in the request are scrubbed.
    # An unrelated skill whose name coincides with a real request word must NOT
    # be deleted from the derive keywords (keeps precise, correct search words).
    from graph import _skill_names_to_strip, _strip_skill_mentions

    monkeypatch.setattr(
        graph._agents, "_load_skills",
        lambda root: [
            {"name": "Anthropic Frontend Design", "content": ""},
            {"name": "ui-ux-pro-max", "content": ""},
        ],
    )
    # Only "Anthropic Frontend Design" is mentioned; "ui-ux-pro-max" is not.
    state = {"skills": [], "root": "", "request": "@Anthropic Frontend Design redesign the login ui"}
    names = _skill_names_to_strip(state)
    assert "Anthropic Frontend Design" in names
    assert "ui-ux-pro-max" not in names
    # "ui" (a real request word) survives stripping.
    out = _strip_skill_mentions(
        "@Anthropic Frontend Design redesign the login ui", names
    )
    assert "ui" in out
    assert "redesign" in out
    assert "Anthropic" not in out


def test_attached_skill_body_is_inlined(monkeypatch):
    # Even though skill names are stripped from the *search* derivation, the
    # skill BODY must still be fully inlined so the agent uses the skill.
    monkeypatch.setattr(
        graph._agents, "_load_skills",
        lambda root: [
            {"name": "Anthropic Frontend Design", "description": "UI helper",
             "content": "FOLLOW-THESE-INSTRUCTIONS"},
        ],
    )
    section = graph._build_skills_section(["Anthropic Frontend Design"], "/x")
    assert "=== ATTACHED SKILLS ===" in section
    assert "FOLLOW-THESE-INSTRUCTIONS" in section
    assert "Anthropic Frontend Design" in section


def test_unattached_skill_body_not_inlined(monkeypatch):
    # A known but unattached skill must NOT have its body inlined (only listed
    # compactly) -- keeps the token cost down and proves inlining is gated on
    # actual attachment, not just presence in the DB.
    monkeypatch.setattr(
        graph._agents, "_load_skills",
        lambda root: [
            {"name": "Anthropic Frontend Design", "description": "UI helper",
             "content": "SECRET-BODY"},
        ],
    )
    section = graph._build_skills_section([], "/x")
    assert "=== ATTACHED SKILLS ===" not in section
    assert "SECRET-BODY" not in section


def test_skill_used_but_name_excluded_from_search(monkeypatch):
    # The end-to-end invariant: an attached skill is (a) fully USED (body
    # inlined) and (b) its name is still stripped from the search keywords so
    # it never leaks into glob/grep.
    monkeypatch.setattr(
        graph._agents, "_load_skills",
        lambda root: [
            {"name": "Anthropic Frontend Design", "description": "UI helper",
             "content": "FOLLOW-THESE-INSTRUCTIONS"},
        ],
    )
    state = {"skills": ["Anthropic Frontend Design"], "root": "/x",
             "request": "@Anthropic Frontend Design show me the login button"}
    # (a) skill is used
    assert "FOLLOW-THESE-INSTRUCTIONS" in graph._build_skills_section(
        state["skills"], state["root"]
    )
    # (b) skill name is excluded from search keywords
    assert "Anthropic Frontend Design" in graph._skill_names_to_strip(state)
    from graph import _derive_explore_patterns, _strip_skill_mentions
    clean = _strip_skill_mentions(state["request"], graph._skill_names_to_strip(state))
    spec = _derive_explore_patterns(clean)
    joined = " ".join(spec["glob"] + spec["grep"]).lower()
    assert "anthropic" not in joined
    assert "frontend" not in joined
    assert "design" not in joined
    # real request words still produce search terms
    assert "login" in joined or "button" in joined
