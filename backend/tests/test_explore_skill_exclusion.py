"""Skill methodology files must never be discovered or read by the explore pipeline.

Skills (e.g. ``backend/skills/anthropic-frontend-design.md``) are injected via
the system prompt, so re-discovering/reading them as project code wastes
context and can confuse the planner. The skills directory must be excluded from
every discovery surface: the source-file ranking set, glob/grep result parsing,
the project tree, and the read candidate lists.
"""
from graph import (
    _build_tree,
    _is_skill_path,
    _parse_glob_files,
    _parse_grep_files,
    _repo_source_files,
)


def test_is_skill_path_detects_skill_dirs():
    assert _is_skill_path("backend/skills/anthropic-frontend-design.md")
    assert _is_skill_path(
        "release/mac-arm64/Codifa.app/Contents/Resources/backend/skills/foo.md"
    )
    assert not _is_skill_path("src/components/Button.tsx")
    assert not _is_skill_path("skills.py")  # a file named skills, not a dir


def test_repo_source_files_excludes_skills(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "bar.py").write_text("def bar(): pass")
    skills = tmp_path / "backend" / "skills"
    skills.mkdir(parents=True)
    (skills / "anthropic-frontend-design.md").write_text("# skill")
    (skills / "helper.py").write_text("def skill_helper(): pass")
    files = _repo_source_files(str(tmp_path))
    # _repo_source_files returns paths relative to root.
    assert "src/bar.py" in files
    assert "backend/skills/anthropic-frontend-design.md" not in files
    assert "backend/skills/helper.py" not in files


def test_parse_glob_files_excludes_skills():
    text = "backend/skills/foo.md\nsrc/components/Button.tsx\nbackend/skills/bar.py"
    out = _parse_glob_files(text)
    assert "backend/skills/foo.md" not in out
    assert "backend/skills/bar.py" not in out
    assert "src/components/Button.tsx" in out


def test_parse_grep_files_excludes_skills():
    text = (
        "backend/skills/foo.md:1: x\n"
        "src/bar.py:12: y\n"
        "backend/skills/baz.py:3: z"
    )
    out = _parse_grep_files(text)
    assert "backend/skills/foo.md" not in out
    assert "backend/skills/baz.py" not in out
    assert "src/bar.py" in out


def test_build_tree_excludes_skills(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "bar.py").write_text("x")
    skills = tmp_path / "skills"
    skills.mkdir()
    (skills / "foo.md").write_text("# skill")
    tree = _build_tree(str(tmp_path))
    assert "src/bar.py" in tree
    assert "skills/foo.md" not in tree
    assert "/skills/" not in tree
