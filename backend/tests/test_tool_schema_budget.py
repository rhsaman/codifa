"""Native tool-schema token budget (regression for the System tools meter).

Every bound tool definition is re-sent to the provider on EVERY turn and
every step, so verbose descriptions/schemas dominate context (the reported
131k-token System tools blowup). This test measures the real footprint with
the same short-description + schema path as build_turn_context and fails
when it grows past budget.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import graph as G
import tools as T
from langchain_core.tools import StructuredTool


def _short_desc(fn, name: str) -> str:
    # Same opencode-style minimal description as build_turn_context.
    doc = (getattr(fn, "__doc__", "") or name).strip()
    for line in doc.split("\n"):
        s = line.strip()
        if len(s) >= 20 and s.isascii():
            return s[:200]
    head = doc.split("\n\n")[0].strip().split("\n")[0].strip()
    return head[:200] if head else name


def test_native_tool_schema_budget():
    cbs = T.make_tool_callbacks(root="backend", emit=lambda e: None)
    f = G.filter_tools_for_mode(
        "build", dict(cbs), None, set(), False, False, "", "backend", False, []
    )
    lc = []
    for n, t in sorted(f.items()):
        lc.append(
            t
            if isinstance(t, StructuredTool)
            else StructuredTool.from_function(
                coroutine=t, name=n, description=_short_desc(t, n)
            )
        )
    rows = sorted([(G._tool_def_chars(t), t.name) for t in lc], reverse=True)
    total = sum(c for c, _ in rows)
    print(f"\nNATIVE TOOL SCHEMA CHARS: {total} (~{total // 4} tokens)")
    for c, n in rows[:15]:
        print(f"  {c:6d}  {n}")
    # Generous ceiling: native definitions must stay far below the blowup.
    assert total < 120_000, (
        f"native tool definitions too large: {total} chars (~{total // 4} tokens)"
    )
