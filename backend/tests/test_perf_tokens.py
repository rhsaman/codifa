"""Perf/token regression tests: per-step usage fields, fetch cap, scope dedup.

Locks in the surgical perf changes: every model step exposes the token
breakdown needed for cache-hit measurement, one fetch cannot flood history,
and near-duplicate search scopes share a single scan.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from typing import ClassVar

import pytest
from langchain_core.messages import AIMessage

from graph import _usage_event_from_ai
from tools import (
    FETCH_EXCERPT_CHARS,
    WEB_SEARCH_FETCH_CHARS,
    _normalize_search_scope,
    fetch_url,
)


def _ai(**usage):
    return AIMessage(content="x", usage_metadata=usage)


def test_usage_event_carries_step_log_fields():
    """The per-step log line needs all six numbers from the usage event."""
    ev = _usage_event_from_ai(
        _ai(
            input_tokens=350,
            output_tokens=40,
            total_tokens=5400,
            input_token_details={
                "cache_read_input_tokens": 5000,
                "cache_creation_input_tokens": 10,
            },
            output_token_details={"reasoning_tokens": 7},
        ),
        "anthropic/claude",
    )
    assert ev is not None
    for key in (
        "input_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "output_tokens",
        "reasoning_tokens",
        "total_tokens",
    ):
        assert key in ev
    assert ev["input_tokens"] == 350
    assert ev["cache_read_tokens"] == 5000
    assert ev["cache_write_tokens"] == 10
    assert ev["reasoning_tokens"] == 7
    # Additive provider: total is the hand-sum including cache + reasoning.
    assert ev["total_tokens"] == 350 + 40 + 5000 + 10 + 7


def test_usage_event_subset_total_uses_provider_total():
    """Subset providers (OpenAI-style) keep the provider total, not a sum."""
    ev = _usage_event_from_ai(
        _ai(
            input_tokens=5776,
            output_tokens=71,
            total_tokens=5847,
            input_token_details={"cache_read": 5568},
        ),
        "openrouter/anthropic",
    )
    assert ev is not None
    assert ev["cache_read_tokens"] == 5568
    assert ev["total_tokens"] == 5847
    # Cache-hit ratio for measurement: cache_read / input.
    assert ev["cache_read_tokens"] / ev["input_tokens"] > 0.9


def test_fetch_cap_matches_codex():
    """fetch_url returns the full page like codex (100k cap), with paging."""
    assert WEB_SEARCH_FETCH_CHARS == 4000
    assert FETCH_EXCERPT_CHARS == 100_000


class _FakeResp:
    status_code: int = 200
    headers: ClassVar[dict] = {"content-type": "text/plain"}

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_bytes(self, _n):
        yield self._body


class _FakeClient:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def stream(self, *args, **kwargs):
        return _FakeResp(self._body)


def _patch_httpx(monkeypatch, body: bytes):
    import httpx

    monkeypatch.setattr(httpx, "Client", lambda *a, **k: _FakeClient(body))


_BODY = ("0123456789abcdef\n" * 20000).strip()
assert len(_BODY) > FETCH_EXCERPT_CHARS


def test_fetch_url_truncates_and_pages(monkeypatch):
    """First page truncates with a next-offset marker; offset pages follow."""
    _patch_httpx(monkeypatch, _BODY.encode())
    first = fetch_url("https://example.com/big")
    assert first["offset"] == 0
    assert first["total_chars"] == len(_BODY)
    assert len(first["content"]) <= FETCH_EXCERPT_CHARS + 200
    assert f"re-fetch with offset={FETCH_EXCERPT_CHARS}" in first["content"]

    second = fetch_url("https://example.com/big", offset=FETCH_EXCERPT_CHARS)
    assert second["offset"] == FETCH_EXCERPT_CHARS
    assert second["content"][:50] == _BODY[FETCH_EXCERPT_CHARS : FETCH_EXCERPT_CHARS + 50]
    # Pages differ — pagination actually advances through the document.
    assert second["content"][:50] != first["content"][:50]


def test_fetch_url_last_page_has_no_marker(monkeypatch):
    """The final page is returned whole with no further-offset marker."""
    _patch_httpx(monkeypatch, _BODY.encode())
    total = len(_BODY)
    last_start = (total // FETCH_EXCERPT_CHARS) * FETCH_EXCERPT_CHARS
    last = fetch_url("https://example.com/big", offset=last_start)
    assert last["content"] == _BODY[last_start:]
    assert "re-fetch with offset" not in last["content"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("backend/", "backend"),
        ("./backend", "backend"),
        ("./backend/", "backend"),
        ("backend", "backend"),
        ("", ""),
        ("/", ""),
        ("  backend// ", "backend"),
    ],
)
def test_normalize_search_scope(raw, expected):
    assert _normalize_search_scope(raw) == expected


async def test_grep_near_duplicate_scope_shares_cache(tmp_path):
    """'sub/' then 'sub' must hit the cache instead of re-scanning."""
    from tools import make_tool_callbacks

    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "a.py").write_text("hello world\n", encoding="utf-8")
    events: list = []
    tools = make_tool_callbacks(str(tmp_path), events.append)
    first = await tools["grep"](pattern="hello", path="sub/")
    assert "hello" in first
    events.clear()
    second = await tools["grep"](pattern="hello", path="sub")
    assert second == first
    assert any(e.get("summary") == "cached" for e in events)


async def test_glob_near_duplicate_scope_shares_cache(tmp_path):
    """'sub/' then 'sub' must hit the cache instead of re-scanning."""
    from tools import make_tool_callbacks

    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "a.py").write_text("hello world\n", encoding="utf-8")
    events: list = []
    tools = make_tool_callbacks(str(tmp_path), events.append)
    first = await tools["glob"](pattern="*.py", path="sub/")
    assert "a.py" in first
    events.clear()
    second = await tools["glob"](pattern="*.py", path="sub")
    assert second == first
    assert any(e.get("summary") == "cached" for e in events)
