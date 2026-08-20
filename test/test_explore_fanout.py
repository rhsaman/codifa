"""Unit tests for the explore fan-out decision + report cap (tools.py).

Run: python test/test_explore_fanout.py
"""
import os
import sys
import tempfile

os.environ["CODER_DATA_DIR"] = tempfile.mkdtemp(prefix="explore_fanout_test_")
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
)

from tools import (  # noqa: E402
    MAX_EXPLORE_REPORT_CHARS,
    MAX_EXPLORE_REPORT_CHARS_CONTENT,
    _cap_explore_report,
    _explore_fanout_max,
    _explore_should_fanout,
)

BROAD = (
    "Find all files related to the auth flow, explore the whole project "
    "architecture, and map out every routing and middleware file — give an "
    "overview of how everything fits together."
)
NARROW = "Where is the port config defined?"


def test_fanout_heuristic_still_gates():
    # narrow / quick → never fan out
    assert _explore_should_fanout(NARROW, "medium") is False
    assert _explore_should_fanout(BROAD, "quick") is False
    # broad + medium/very thorough → fan out
    assert _explore_should_fanout(BROAD, "medium") is True
    assert _explore_should_fanout(BROAD, "very thorough") is True


def test_fanout_max_auto():
    assert _explore_fanout_max(NARROW, "medium", 0) == 0
    assert _explore_fanout_max(NARROW, "quick", 0) == 0
    assert _explore_fanout_max(BROAD, "quick", 0) == 0  # quick never auto-fans
    assert _explore_fanout_max(BROAD, "medium", 0) == 3
    assert _explore_fanout_max(BROAD, "very thorough", 0) == 4


def test_main_model_overrides_via_parallel_branches():
    # model forces branches even for a narrow/quick task
    assert _explore_fanout_max(NARROW, "medium", 3) == 3
    assert _explore_fanout_max(BROAD, "quick", 3) == 3
    # model forces single even for a broad task
    assert _explore_fanout_max(BROAD, "medium", 1) == 0
    # cap at 4 branches
    assert _explore_fanout_max(BROAD, "medium", 9) == 4
    assert _explore_fanout_max(NARROW, "medium", 99) == 4


def test_report_cap_short_unchanged():
    short = (
        "<results>\n<files>\nbackend/tools.py:1\n</files>\n"
        "<answer>\nhi\n</answer>\n</results>"
    )
    assert _cap_explore_report(short, False) == short
    assert _cap_explore_report(short, True) == short


def test_report_cap_truncates_long():
    long_report = "\n".join(f"backend/file_{i}.py:{i}" for i in range(5000))
    capped = _cap_explore_report(long_report, False)
    assert "<note>Report truncated" in capped
    assert len(capped) <= MAX_EXPLORE_REPORT_CHARS + 300
    # never splits a path:line ref: every kept line is a full "path:line"
    for line in capped.splitlines():
        if line and not line.startswith("<note>"):
            assert line.startswith("backend/file_") and ":" in line, line


def test_report_cap_content_gets_bigger_ceiling():
    long_report = "x" * (MAX_EXPLORE_REPORT_CHARS_CONTENT + 5000)
    capped = _cap_explore_report(long_report, True)
    assert "<note>Report truncated" in capped
    assert len(capped) <= MAX_EXPLORE_REPORT_CHARS_CONTENT + 300
    normal_capped = _cap_explore_report(long_report, False)
    assert len(normal_capped) < len(capped)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    print(f"\n{len([n for n in globals() if n.startswith('test_') and callable(globals()[n])] ) - failures}/{len([n for n in globals() if n.startswith('test_') and callable(globals()[n])] )} tests passed")
    sys.exit(1 if failures else 0)
