"""Tests: _in_file_grep must produce the SAME set of line numbers whether it
streams the file line-by-line or used to call fp.readlines().

The grep helper in graph.py previously loaded the whole file into memory via
fp.readlines(); this was visible in MEM-GROW output as ``+1319 KiB / 13699
objs / lines = fp.readlines()`` on a single agent run. The streaming rewrite
keeps the same output (a set of matching line numbers) but does not hold the
file content in memory.
"""
import re

from graph import _in_file_grep


def test_streaming_returns_same_lines_as_readlines(tmp_path):
    """For a file with predictable matching/non-matching lines, the streaming
    implementation must return the same set[int] of line numbers that the
    readlines() version produced. The set is built by ``out.add(i); break``
    (first match per line wins) so we check the same property here."""
    lines = [
        "line 1 no match",
        "line 2 matches",
        "line 3 no match",
        "line 4 matches too",
        "line 5 no match",
        "line 6 matches",
    ]
    p = tmp_path / "sample.txt"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    patterns = [re.compile(r"matches")]
    result = _in_file_grep(str(tmp_path), "sample.txt", patterns)
    assert result == {2, 4, 6}


def test_streaming_handles_missing_file(tmp_path):
    """If the file does not exist, _in_file_grep must return an empty set
    (not raise) — same behavior as the readlines() version."""
    patterns = [re.compile(r"anything")]
    assert _in_file_grep(str(tmp_path), "does_not_exist.txt", patterns) == set()


def test_streaming_handles_large_file(tmp_path):
    """For a 2000-line file, the streaming version must still return the
    correct line set. This is a smoke test that the generator-based loop
    enumerates correctly across the whole file (not just the first few)."""
    p = tmp_path / "big.txt"
    body = "\n".join(
        f"line {i} MATCH" if i % 5 == 0 else f"line {i}" for i in range(1, 2001)
    )
    p.write_text(body + "\n", encoding="utf-8")
    patterns = [re.compile(r"MATCH")]
    result = _in_file_grep(str(tmp_path), "big.txt", patterns)
    assert result == {i for i in range(1, 2001) if i % 5 == 0}
    assert len(result) == 400


def test_streaming_closes_file_on_match(tmp_path, monkeypatch):
    """If the file object is still open after the function returns, every
    run leaks a file descriptor. We monkey-patch open() to assert close()
    is called exactly once per successful call."""
    p = tmp_path / "x.txt"
    p.write_text("alpha MATCHES\nbeta\n", encoding="utf-8")

    real_open = open
    state = {"opened": [], "closed": []}

    def spy_open(file, *args, **kwargs):
        fh = real_open(file, *args, **kwargs)
        state["opened"].append(fh)
        real_close = fh.close

        def close_logging():
            state["closed"].append(fh)
            return real_close()

        fh.close = close_logging
        return fh

    monkeypatch.setattr("builtins.open", spy_open)
    patterns = [re.compile(r"MATCHES")]
    result = _in_file_grep(str(tmp_path), "x.txt", patterns)
    assert result == {1}
    assert len(state["opened"]) == 1
    assert len(state["closed"]) == 1, "file handle was not closed — FD leak"
