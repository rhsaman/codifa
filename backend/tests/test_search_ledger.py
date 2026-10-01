"""Step-level search ledger: grep/glob searches already run this turn.

The model re-searches patterns it already ran. One line per step names each
search (pattern, scope, filter, outcome) so repeats are recognizable.
Live messages only; silent until at least two searches ran.
"""
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from tool_message_projection import search_ledger_line


def _call(cid, name, args):
    return {"name": name, "args": args, "id": cid, "type": "tool_call"}


def _ai(*calls):
    return AIMessage(content="", tool_calls=list(calls))


def _tm(content, cid, status="success"):
    return ToolMessage(content=content, tool_call_id=cid, status=status)


_GREP_HIT = (
    "MATCHES for 'foo|bar'\n"
    "a.py:1: foo here\n"
    "\nFound 53 matches.\nShowing the first 30 relevant matches (23 more not shown).\n"
)
_GREP_MISS = "No matches for 'zzz' under src"
_GLOB_HIT = "GLOB MATCHES for '*.py'\na.py\nb.py\n(12 matches found, showing the first 100)"
_GLOB_MISS = "No files match '*.zzz' under src."


def test_search_ledger_silent_until_two_searches():
    assert search_ledger_line([]) == ""
    msgs = [
        _ai(_call("g1", "grep", {"pattern": "foo", "path": "backend"})),
        _tm(_GREP_HIT, "g1"),
    ]
    assert search_ledger_line(msgs) == ""


def test_search_ledger_exact_line():
    msgs = [
        _ai(
            _call("g1", "grep", {"pattern": "foo", "path": "backend"}),
            _call("g2", "grep", {"pattern": "zzz", "path": "src"}),
        ),
        _tm(_GREP_HIT, "g1"),
        _tm(_GREP_MISS, "g2"),
    ]
    assert search_ledger_line(msgs) == (
        "[already searched \u2014 do NOT re-search: "
        "grep 'foo|bar' in backend: 53 hits | grep 'zzz' in src: no matches]"
    )


def test_search_ledger_glob_and_filter():
    msgs = [
        _ai(
            _call("g1", "glob", {"pattern": "*.py", "path": "src"}),
            _call("g2", "glob", {"pattern": "*.zzz", "path": "src"}),
            _call("g3", "grep", {"pattern": "q", "path": "backend", "include": "*.py"}),
        ),
        _tm(_GLOB_HIT, "g1"),
        _tm(_GLOB_MISS, "g2"),
        _tm("MATCHES for 'q'\nx.py:1: q", "g3"),
    ]
    assert search_ledger_line(msgs) == (
        "[already searched \u2014 do NOT re-search: "
        "glob '*.py' in src: 12 hits | glob '*.zzz' in src: no matches | "
        "grep 'q' in backend (*.py): hits]"
    )


def test_search_ledger_dedups_repeats_and_ignores_noise():
    hit2 = _GREP_HIT.replace("g1", "x")
    msgs = [
        HumanMessage(content="noise"),
        _ai(
            _call("g1", "grep", {"pattern": "foo", "path": "backend"}),
            _call("g2", "grep", {"pattern": "foo", "path": "backend"}),
            _call("g3", "read", {"filePath": "a.py"}),
        ),
        _tm(_GREP_HIT, "g1"),
        _tm(hit2, "g2"),
        _tm("ERROR reading a.py: file not found", "g3", status="error"),
        _tm("DUPLICATE of this turn's earlier `grep` call", "g4"),
    ]
    line = search_ledger_line(msgs)
    assert line.count("grep 'foo|bar'") == 1, line
    assert "g4" not in line and "DUPLICATE" not in line


def test_search_ledger_caps_with_counter():
    msgs = [_ai(*[_call(f"g{n}", "grep", {"pattern": f"pat{n:02d}", "path": "backend"}) for n in range(8)])]
    for n in range(8):
        msgs.append(_tm(f"MATCHES for 'pat{n:02d}'\na.py:{n + 1}: x", f"g{n}"))
    line = search_ledger_line(msgs)
    assert "(+2 more)" in line
    assert len(line) <= 410
