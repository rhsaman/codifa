"""The 'you already ran these tools' note must not claim FULL results are in the
transcript: turn-start trimming replaces old results with placeholders, and the
model must be told it may re-run those once (batched) instead of being blocked."""
from agents import _tool_reuse_note


def _hist(repeat: bool):
    act = {"tool": "read", "args": {"filePath": "a.py"}, "status": "done", "summary": "1 file"}
    acts = [dict(act), dict(act)] if repeat else [dict(act)]
    return [{"role": "assistant", "content": "x", "toolActivity": acts}]


def test_note_admits_truncated_results_single():
    note = _tool_reuse_note(_hist(False))
    assert "FULL results are in the transcript" not in note
    assert "re-issue if still needed" in note and "re-run" in note


def test_note_admits_truncated_results_repeated():
    note = _tool_reuse_note(_hist(True))
    assert "FULL results are in the transcript" not in note
    assert "re-issue if still needed" in note
    assert "read(" in note  # the listing of earlier calls is still there
