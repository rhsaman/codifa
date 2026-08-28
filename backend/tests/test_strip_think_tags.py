"""Tests for literal <think>…</think> tag stripping from streamed content."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph import _strip_think_tags


def test_no_tag_passthrough():
    out, in_think, buf = _strip_think_tags("hello world", False, "")
    assert out == "hello world"
    assert not in_think
    assert buf == ""


def test_complete_tag():
    text = "answer<think>secret reasoning</think>more answer"
    out, in_think, buf = _strip_think_tags(text, False, "")
    assert out == "answermore answer"
    assert not in_think
    assert buf == "secret reasoning"


def test_thinking_variant():
    text = "answer<thinking>secret</think>more"
    out, _in_think, buf = _strip_think_tags(text, False, "")
    assert out == "answermore"
    assert buf == "secret"


def test_unterminated_tag_spans_chunks():
    # First chunk opens the tag but doesn't close it.
    out1, in_think1, buf1 = _strip_think_tags("answer<think>secret", False, "")
    assert out1 == "answer"
    assert in_think1
    assert buf1 == "secret"
    # Second chunk closes it.
    out2, in_think2, buf2 = _strip_think_tags(" more secret</think>tail", in_think1, buf1)
    assert out2 == "tail"
    assert not in_think2
    assert buf2 == "secret more secret"


def test_multiple_tags():
    text = "a<think>r1</think>b<think>r2</think>c"
    out, _in_think, buf = _strip_think_tags(text, False, "")
    assert out == "abc"
    assert buf == "r1r2"


def test_empty():
    out, in_think, _buf = _strip_think_tags("", False, "")
    assert out == ""
    assert not in_think
