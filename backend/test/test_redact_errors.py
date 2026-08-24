"""Regression: app/tool error fragments must not survive into the compact summary.

Tool results (including failures) are embedded inside assistant turns, so a
failed tool leaks its error text into the next compaction. ``_redact_app_errors``
strips error lines but keeps real reasoning and successful tool output.
"""
import agents


def test_redact_drops_tool_error_but_keeps_success():
    turn = (
        "I searched the repo.\n"
        "<grep result>\nsrc/foo.py:12: def bar():\n</grep result>\n"
        "ERROR reading src/missing.py: file not found\n"
        "Then I edited it."
    )
    out = agents._redact_app_errors(turn)
    assert "ERROR reading" not in out
    assert "src/foo.py:12: def bar()" in out  # successful tool output kept
    assert "Then I edited it." in out           # real reasoning kept
    assert "[app/tool error" in out             # breadcrumb present


def test_redact_drops_tool_error_prefix_and_provider_error():
    turn = (
        "Plan:\n"
        "[Tool error]: the read tool raised OSError('boom')\n"
        "Error code: 401 - AuthenticationError: bad key\n"
        "Falling back."
    )
    out = agents._redact_app_errors(turn)
    assert "[Tool error]" not in out
    assert "Error code: 401" not in out
    assert "Falling back." in out


def test_redact_drops_traceback_frames():
    turn = (
        "Traceback (most recent call last):\n"
        '  File "x.py", line 1, in <module>\n'
        "    boom()\n"
        "Recovered after error."
    )
    out = agents._redact_app_errors(turn)
    assert "File \"x.py\"" not in out
    assert "boom()" not in out
    assert "Recovered after error." in out


def test_redact_keeps_real_user_text():
    turn = "My app crashes when I click save. Can you look at src/save.py?"
    assert agents._redact_app_errors(turn) == turn
