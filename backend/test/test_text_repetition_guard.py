"""Tests for the degenerate text-loop guard and literal <think> tag stripping.

These cover the no-tool-call repetition case (e.g. a model emitting the same
sentence 80 times) and inline reasoning tags that some models leak into the
visible content stream.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph import _is_repeating, _strip_think_tags  # noqa: E402


def test_repeating_sentence_triggers():
    text = "Let me check that. " * 80
    assert _is_repeating(text) is True


def test_repeating_word_triggers():
    text = "loop " * 60
    assert _is_repeating(text) is True


def test_natural_text_does_not_trigger():
    text = (
        "First I read the file. Then I searched for the symbol. "
        "After that I refactored the helper. Finally I ran the tests."
    )
    assert _is_repeating(text) is False


def test_repeat_across_chunks_detected():
    # Simulate the model emitting the same phrase across many streamed chunks.
    buf = ""
    for _ in range(80):
        buf += "Let me check that. "
        if len(buf) % 4 == 0 and _is_repeating(buf):
            break
    assert _is_repeating(buf) is True


def test_strip_think_complete_tag():
    text = "Before <think>secret reasoning</think> After"
    out, in_think, buf = _strip_think_tags(text, False, "")
    assert out == "Before  After"
    assert in_think is False
    assert "secret reasoning" in buf


def test_strip_think_spanning_chunks():
    out1, in_think, buf1 = _strip_think_tags("A <think>partial ", False, "")
    assert out1 == "A "
    assert in_think is True
    out2, in_think, buf2 = _strip_think_tags("rest</think> B", in_think, buf1)
    assert out2 == " B"
    assert in_think is False
    assert "partial rest" in buf2


def test_strip_think_thinking_variant():
    text = "x <thinking>hidden</think> y"
    out, in_think, buf = _strip_think_tags(text, False, "")
    assert out == "x  y"
    assert "hidden" in buf
