"""Pure-logic tests for the read_skill tool helpers (no DB, no server).

The tool itself (``read_skill_tool``) is a thin async wrapper around two pure
helpers — ``_find_skill_row`` (lookup) and ``_format_skill_body`` (rendering) —
so the deterministic parts are tested here directly.
"""
from tools import _find_skill_row, _format_skill_body


def _row(name, slug, desc="", content="", path=None):
    return {
        "name": name,
        "slug": slug,
        "description": desc,
        "path": path or f"db://skills/{slug}",
        "content": content,
    }


def test_find_skill_row_by_name_case_insensitive():
    rows = [_row("Testing (تستنویسی)", "testing", "نوشتن تست", "بدنه")]
    assert _find_skill_row(rows, "testing (تستنویسی)") is rows[0]
    assert _find_skill_row(rows, "TESTING (تستنویسی)") is rows[0]


def test_find_skill_row_by_slug_and_path_suffix():
    rows = [_row("docker-deploy", "docker-deploy", "Docker", "بدنه")]
    assert _find_skill_row(rows, "docker-deploy") is rows[0]
    assert _find_skill_row(rows, "db://skills/docker-deploy") is rows[0]


def test_find_skill_row_missing_returns_none():
    rows = [_row("Alpha", "alpha", "توضیح", "بدنه")]
    assert _find_skill_row(rows, "Beta") is None
    assert _find_skill_row(rows, "") is None


def test_format_skill_body_strips_frontmatter():
    row = _row(
        "Testing",
        "testing",
        "نوشتن تست",
        "---\nname: Testing\ndescription: نوشتن تست\n---\n\n# Testing\n\nبدنه کامل",
    )
    out = _format_skill_body(row)
    assert out.startswith("# Testing")
    assert "بدنه کامل" in out
    assert "---" not in out.split("\n\n")[0], "frontmatter must be stripped"


def test_format_skill_body_plain_content():
    row = _row("Alpha", "alpha", "توضیح", "بدنه ساده")
    out = _format_skill_body(row)
    assert out == "# Alpha\n\nتوضیح\n\nبدنه ساده\n"