"""Turn-scoped exact-duplicate suppression for grep/glob/read.

Repeating a byte-identical tool call inside one turn re-sends content for
zero benefit (the result is already in the transcript). The tool layer stubs
such repeats deterministically instead of relying on the model to notice
"do NOT re-read" footers. Post-edit repeats always re-execute: the search
generation (bumped on every edit) is folded into the key.
"""
import os
import tempfile
import textwrap
from contextlib import contextmanager

from tool_batching import note_turn_call, reset_turn_seen_calls
from tools import make_tool_callbacks


@contextmanager
def _isolated_calls(active):
    """Hermetic turn-call state: other tests/agent loops may leave the
    process-global ContextVar set; save it, install ours, restore after."""
    import tool_batching

    prev = tool_batching._TURN_CALLS.get()
    if active:
        reset_turn_seen_calls()
    else:
        tool_batching._TURN_CALLS.set(None)
    try:
        yield
    finally:
        tool_batching._TURN_CALLS.set(prev)


def test_note_turn_call_inactive_without_reset():
    # No turn started -> never a duplicate.
    with _isolated_calls(active=False):
        assert note_turn_call(("dup", "grep", 0, "x")) is False
        assert note_turn_call(("dup", "grep", 0, "x")) is False


def test_note_turn_call_repeat_and_reset():
    with _isolated_calls(active=True):
        assert note_turn_call(("dup", "read", 0, "a.py")) is False
        assert note_turn_call(("dup", "read", 0, "a.py")) is True
        assert note_turn_call(("dup", "read", 0, "b.py")) is False
        reset_turn_seen_calls()
        assert note_turn_call(("dup", "read", 0, "a.py")) is False


def test_note_turn_call_empty_key():
    with _isolated_calls(active=True):
        assert note_turn_call(()) is False


def _make_ws():
    d = tempfile.mkdtemp()
    root = os.path.join(d, "ws")
    os.makedirs(root)
    src = textwrap.dedent(
        """\
        def alpha():
            return 1  # MARKER

        def beta():
            return 2
        """
    )
    with open(os.path.join(root, "app.py"), "w") as f:
        f.write(src)
    return root


async def test_grep_exact_repeat_stubbed_in_turn():
    root = _make_ws()
    with _isolated_calls(active=True):
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        first = await cbs["grep"]("MARKER")
        assert first.startswith("MATCHES for"), first
        second = await cbs["grep"]("MARKER")
        assert second.startswith("DUPLICATE"), second
        # A different pattern still executes.
        third = await cbs["grep"]("def beta")
        assert third.startswith("MATCHES for"), third
        # New turn, file unchanged -> cross-turn reuse, nothing re-sent.
        reset_turn_seen_calls()
        fourth = await cbs["grep"]("MARKER")
        assert fourth.startswith("REUSED"), fourth
        assert "MATCHES for" not in fourth, fourth
        # Post-edit repeat re-executes fresh (stat mismatch + new generation).
        await cbs["edit_file"]("app.py", "return 2", "return 2  # MARKER")
        fifth = await cbs["grep"]("MARKER")
        assert fifth.startswith("MATCHES for"), fifth
        assert "return 2  # MARKER" in fifth, fifth


async def test_read_exact_repeat_stubbed_in_turn():
    root = _make_ws()
    with _isolated_calls(active=True):
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        first = await cbs["read"]("app.py", 1, 10)
        assert "def alpha" in first
        second = await cbs["read"]("app.py", 1, 10)
        assert second.startswith("DUPLICATE"), second


async def test_read_repeat_after_edit_reexecutes():
    """The standard post-edit re-read (same args) must NOT stub: a real edit
    changes the file bytes, so the cross-turn signature check misses and the
    read re-serves fresh content (dup key differs too via the new generation)."""
    root = _make_ws()
    with _isolated_calls(active=True):
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        first = await cbs["read"]("app.py", 1, 10)
        assert "def alpha" in first
        await cbs["edit_file"]("app.py", "return 1  # MARKER", "return 1  # MARKER edited")
        second = await cbs["read"]("app.py", 1, 10)
        assert not second.startswith("DUPLICATE"), second
        assert "SKIPPED (already in context)" not in second, second
        assert "MARKER edited" in second, second


async def test_glob_exact_repeat_stubbed_in_turn():
    root = _make_ws()
    with _isolated_calls(active=True):
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        first = await cbs["glob"]("**/*.py")
        assert "app.py" in first
        second = await cbs["glob"]("**/*.py")
        assert second.startswith("DUPLICATE"), second
