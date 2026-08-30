"""Unit test: web_search_tool caches identical queries (no redundant web calls).

Regression guard for the missing web_search cache. fetch_url already had a
24h result cache (tools.py:4301); web_search did not, so repeating the exact
same query burned a real web call every time. After the fix, web_search_tool
checks the result cache before calling web_search and stores the result with
a 24h TTL — identical queries return the cached text with zero extra calls
and byte-for-byte the same output (no quality loss).

Covers:
- Two identical queries -> web_search called exactly once.
- Cached output equals the real output for the same query.
"""

import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-test-webcache-data-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import tools as _tools
from tools import make_tool_callbacks


async def _run_query(query, real_result):
    calls = {"n": 0}

    def _fake_web_search(q, max_results=5):
        calls["n"] += 1
        return real_result

    _orig = _tools.web_search
    _tools.web_search = _fake_web_search
    try:
        cbs = make_tool_callbacks(
            root=os.getcwd(),
            emit=lambda ev: None,
            context_window=0,
        )
        # No web/ main model -> exercises the raw-results path (cache still set).
        out = await cbs["web_search"](query, max_results=5)
    finally:
        _tools.web_search = _orig
    return out, calls["n"]


async def test_web_search_cached_on_repeat():
    real = {
        "results": [
            {"title": "T", "url": "https://example.com", "snippet": "snip"}
        ]
    }
    q = "how does the cache work"
    first, n1 = await _run_query(q, real)
    second, n2 = await _run_query(q, real)
    # Real web_search called once; second hit served from cache.
    assert n1 == 1, f"expected 1 real call, got {n1}"
    assert n2 == 0, f"expected 0 real calls on repeat, got {n2}"
    # Cached output is identical to the real output (no quality loss).
    assert second == first


def main():
    asyncio.run(test_web_search_cached_on_repeat())
    print("OK: web_search_tool caches identical queries (no redundant calls)")


if __name__ == "__main__":
    main()
