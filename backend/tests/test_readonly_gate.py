"""Read-only streak guard (build): single-call exploration steps are refused
past the budget; batched steps and non-build modes are never refused."""
import graph
from graph import (
    _MAX_READONLY_STEPS_WITHOUT_ACTION as MAX,
)
from graph import (
    _is_readonly_refusal,
    _readonly_gate_text,
)


def test_below_budget_never_refused():
    assert _readonly_gate_text("build", MAX - 1, ["read"]) is None


def test_single_call_past_budget_refused():
    text = _readonly_gate_text("build", MAX, ["read"])
    assert text and _is_readonly_refusal(text)
    assert _readonly_gate_text("build", MAX + 5, ["grep"])


def test_batched_step_always_allowed():
    assert _readonly_gate_text("build", MAX + 5, ["read", "read"]) is None
    assert _readonly_gate_text("build", MAX + 5, ["read", "grep", "glob"]) is None


def test_non_exploration_and_other_modes_untouched():
    assert _readonly_gate_text("build", MAX + 5, ["edit_file"]) is None
    assert _readonly_gate_text("build", MAX + 5, ["run_terminal"]) is None
    assert _readonly_gate_text("plan", MAX + 5, ["read"]) is None
    assert _readonly_gate_text("ask", MAX + 5, ["read"]) is None


def test_refusal_prefix_is_not_search_refusal():
    text = _readonly_gate_text("build", MAX, ["read"])
    assert not graph._is_search_refusal(text)


def test_single_call_with_batched_args_never_refused():
    # Multi-file read
    assert _readonly_gate_text(
        "build", MAX + 5, [{"name": "read", "args": {"filePaths": ["a.py", "b.py"]}}]
    ) is None
    # Multi-range read
    assert _readonly_gate_text(
        "build", MAX + 5, [{"name": "read", "args": {"filePath": "a.py", "ranges": ["1:10", "20:30"]}}]
    ) is None
    # Multi-pattern grep
    assert _readonly_gate_text(
        "build", MAX + 5, [{"name": "grep", "args": {"patterns": ["foo", "bar"], "path": "src"}}]
    ) is None


def test_single_call_unbatched_args_past_budget_refused():
    text = _readonly_gate_text(
        "build", MAX, [{"name": "read", "args": {"filePath": "a.py"}}]
    )
    assert text and _is_readonly_refusal(text)
    grep_text = _readonly_gate_text(
        "build", MAX, [{"name": "grep", "args": {"pattern": "foo", "path": "src"}}]
    )
    assert grep_text and _is_readonly_refusal(grep_text)
