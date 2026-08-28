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
