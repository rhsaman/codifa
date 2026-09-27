"""Coder mode carries the systematic DEBUGGING PROTOCOL; other modes do not."""

from agents import SYSTEM_PROMPTS


def test_coder_has_debug_protocol():
    assert "DEBUGGING PROTOCOL" in SYSTEM_PROMPTS["coder"]
    assert "REPRODUCE" in SYSTEM_PROMPTS["coder"]


def test_other_modes_have_no_debug_protocol():
    for mode in ("ask", "plan", "reader"):
        assert "DEBUGGING PROTOCOL" not in SYSTEM_PROMPTS[mode]
