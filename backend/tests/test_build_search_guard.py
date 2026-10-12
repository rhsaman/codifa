"""Build search guard: grep/glob are budgeted, targeted read stays free.

Regression test for the loop where Build kept issuing grep/glob batches
without ever editing: the server-side gate must refuse further search calls
past the budget and only allow edit/update_plan/read calls through. read is
NOT budgeted — it self-limits (covering-window stubs + per-file line cap) and
a live trace showed budgeting it wasted 3 rounds fighting the guard.

Run: cd backend && uv run python -m pytest tests/test_build_search_guard.py -q
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import graph


def test_read_not_budgeted_as_search_tool():
    """read self-limits (window stubs + line cap) and is the desired
    convergence move, so it must NOT be gated like grep/glob."""
    assert "read" not in graph._SEARCH_TOOLS
    assert "grep" in graph._SEARCH_TOOLS
    assert "glob" in graph._SEARCH_TOOLS


def test_update_plan_rearms_search_budget():
    """update_plan is the explicit checklist step, so it must reset the budget."""
    assert "update_plan" in graph._EDIT_TOOLS
    assert "edit_file" in graph._EDIT_TOOLS
    assert "write_file" in graph._EDIT_TOOLS


def test_gate_allows_read_past_budget_in_build():
    """Past the budget, a build step with only read calls still runs —
    targeted reads are how the model converges on what it already found."""
    assert graph._search_gate_text("build", 3, ["read"], []) is None


def test_gate_refuses_grep_past_budget_in_build():
    """Past the budget, a build step with only grep calls is refused."""
    text = graph._search_gate_text("build", 3, ["grep"], [])
    assert text is not None
    assert text.startswith("SEARCH BUDGET EXCEEDED")
    assert "update_plan" in text


def test_gate_allows_edit_step_past_budget():
    """A step that edits must pass even when the budget is spent."""
    assert graph._search_gate_text("build", 3, ["edit_file"], []) is None
    assert graph._search_gate_text("build", 3, ["update_plan"], []) is None


def test_gate_never_fires_outside_build():
    """Ask/Plan do read-heavy discovery and must never be gated."""
    assert graph._search_gate_text("ask", 99, ["read"], []) is None
    assert graph._search_gate_text("plan", 99, ["grep"], []) is None


def test_soft_nudge_ask_only_past_budget():
    """Ask gets a model-visible soft nudge past the budget (repeating every
    4th step); plan (scout budget) and build (hard gate) use their own
    mechanisms and never see this nudge."""
    assert graph._soft_search_nudge("ask", 2) is None
    msg = graph._soft_search_nudge("ask", 3)
    assert msg is not None and msg.startswith("SEARCH BUDGET")
    assert "answer now" in msg
    assert graph._soft_search_nudge("ask", 5) is None
    assert graph._soft_search_nudge("ask", 7) is not None
    assert graph._soft_search_nudge("plan", 99) is None
    assert graph._soft_search_nudge("build", 99) is None
