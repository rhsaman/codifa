"""Part 3 -- the explore pipeline must not READ root-level ``.md`` docs
(README / CONTRIBUTING / CHANGELOG / ...) except ``AGENTS.md``.

Top-level docs are noise next to the code and bloat the context budget;
``AGENTS.md`` stays readable, and nested ``.md`` (e.g. ``docs/foo.md``) is
unaffected. Attached files bypass this via the Reader, not explore.
"""
from graph import _is_excluded_root_md, _repo_source_files


def test_is_excluded_root_md_only_top_level():
    root = "/tmp/fake-root"
    # Top-level .md docs are excluded ...
    assert _is_excluded_root_md("README.md", root)
    assert _is_excluded_root_md("CONTRIBUTING.md", root)
    assert _is_excluded_root_md("/tmp/fake-root/README.md", root)
    # ... but AGENTS.md and nested .md are kept.
    assert not _is_excluded_root_md("AGENTS.md", root)
    assert not _is_excluded_root_md("docs/foo.md", root)
    assert not _is_excluded_root_md("/tmp/fake-root/docs/guide.md", root)
    # Non-.md files are never excluded by this rule.
    assert not _is_excluded_root_md("README.txt", root)
    assert not _is_excluded_root_md("src/main.py", root)


def test_repo_source_files_skips_root_md_but_keeps_agents_and_nested(tmp_path):
    (tmp_path / "README.md").write_text("# readme\n")
    (tmp_path / "CONTRIBUTING.md").write_text("contribute\n")
    (tmp_path / "AGENTS.md").write_text("agents\n")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "foo.md").write_text("nested doc\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("x = 1\n")

    files = _repo_source_files(str(tmp_path))
    assert "AGENTS.md" in files
    assert "docs/foo.md" in files
    assert "src/main.py" in files
    # root-level docs are NOT discoverable
    assert not any(f == "README.md" for f in files)
    assert not any(f == "CONTRIBUTING.md" for f in files)
