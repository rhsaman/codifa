"""LSP manager tests with a fake in-process server (no binaries, no sleeps)."""

from __future__ import annotations

import os
import tempfile
import threading

import lsp_manager
from lsp_manager import LspManager


class FakeClient:
    """Minimal fake server: echoes the opened URI with canned payloads."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []
        self.capabilities: dict = {
            "workspaceSymbolProvider": True,
            "diagnosticProvider": True,
        }

    def request(self, method: str, params: dict, timeout: float | None = None):
        self.requests.append((method, params))
        uri = ((params.get("textDocument") or {}) if isinstance(params, dict) else {}).get(
            "uri", "file:///a.py"
        )
        if method == "textDocument/definition":
            return [
                {
                    "uri": uri,
                    "range": {
                        "start": {"line": 0, "character": 4},
                        "end": {"line": 2, "character": 10},
                    },
                }
            ]
        if method == "textDocument/documentSymbol":
            rng = {
                "start": {"line": 0, "character": 0},
                "end": {"line": 2, "character": 8},
            }
            return [{"name": "Foo", "kind": 5, "range": rng, "selectionRange": rng}]
        return None

    def notify(self, method: str, params: dict) -> None:
        self.notified.append((method, params))

    def close(self) -> None:
        pass


def _write(root: str, rel: str, content: str) -> str:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return os.path.realpath(path)


def test_timeout_message_classifies_as_timeout():
    """Regression (live trace): request() raised 'documentSymbol timed out
    after 5.0s' but classify_lsp_error returned the generic 'error' — the
    default kind short-circuited the message checks — so the failing
    lsp_symbols call told the model to 'use lsp_symbols' (circular)."""
    from lsp_manager import LspError, classify_lsp_error

    # No explicit kind: the message alone must classify as a timeout.
    assert (
        classify_lsp_error(
            LspError("textDocument/documentSymbol timed out after 5.0s")
        )
        == "timeout"
    )
    # Explicit kind keeps working.
    assert classify_lsp_error(LspError("x timed out", kind="timeout")) == "timeout"


async def test_lsp_symbols_transient_timeout_retried_in_tool(tmp_path):
    """A transient documentSymbol timeout is retried once INSIDE the same
    tool call — a slow server must not cost a full LLM round-trip (every
    request re-sends the whole context)."""
    from lsp_manager import LspError, get_manager
    from tools import make_tool_callbacks

    root = str(tmp_path)
    _write(root, "a.py", "def foo():\n    pass\n")
    mgr = get_manager(root)
    calls = {"n": 0}

    def flaky(abs_path):
        calls["n"] += 1
        if calls["n"] == 1:
            raise LspError(
                "textDocument/documentSymbol timed out after 5.0s",
                kind="timeout",
            )
        return {"foo": (1, 2, "function")}

    mgr.document_symbols = flaky
    try:
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["lsp_symbols"]("a.py")
        assert calls["n"] == 2, f"expected one in-tool retry, saw {calls['n']} calls"
        assert "- function foo (L1-2)" in out, out
    finally:
        mgr.shutdown()


async def test_wait_for_server_recovers_from_stale_start_event(tmp_path):
    """Regression (live probe): a stale SET start event left by a finished
    start made wait_for_server return False forever without ever kicking a
    fresh start — every later call saw 'server never became ready'."""
    root = str(tmp_path)
    path = _write(root, "a.py", "def foo():\n    pass\n")
    fake = FakeClient()
    mgr = LspManager(root, timeout=2.0, starter=lambda l, c, r: fake)
    stale = threading.Event()
    stale.set()
    lsp_manager._STARTING[(mgr._root, "python")] = stale
    try:
        assert mgr.wait_for_server(path, 5.0) is True
        assert mgr.client_if_running("python") is not None
    finally:
        mgr.shutdown()
        with lsp_manager._STARTING_LOCK:
            lsp_manager._STARTING.pop((mgr._root, "python"), None)


async def test_evict_server_drops_client_and_bookkeeping(tmp_path):
    """evict_server closes the wedged server, clears open-doc state, and
    lets the next call start fresh instead of poisoning the language."""
    root = str(tmp_path)
    path = _write(root, "a.py", "def foo():\n    pass\n")
    fake = FakeClient()
    mgr = LspManager(root, timeout=2.0, starter=lambda l, c, r: fake)
    mgr.definition(path, 2, 4)  # lazy start + didOpen
    assert mgr.client_if_running("python") is not None
    assert mgr.evict_server(path) is True
    assert mgr.client_if_running("python") is None
    assert mgr._open_versions == {}
    # Fresh start on the next call (a different file: results are cached
    # per file+position, so a.py would be served from cache without a server).
    path2 = _write(root, "b.py", "def bar():\n    return 2\n")
    hits = mgr.definition(path2, 2, 4)
    assert hits and mgr.client_if_running("python") is not None
    # Unknown extension / nothing left to drop -> False.
    assert mgr.evict_server(os.path.join(root, "nope.xyz")) is False
    assert mgr.evict_server(path) is True
    assert mgr.evict_server(path) is False
    mgr.shutdown()


async def test_lsp_symbols_wedged_server_evicted_after_two_timeouts(tmp_path):
    """Two consecutive timeouts = wedged server: the tool retries once
    in-process, then evicts the server so later calls start fresh, and
    tells the model a fresh server is coming (never a blind grep)."""
    from lsp_manager import LspError, get_manager
    from tools import make_tool_callbacks

    root = str(tmp_path)
    _write(root, "a.py", "def foo():\n    pass\n")
    mgr = get_manager(root)
    calls = {"n": 0}
    evicted = {"n": 0}

    def wedged(abs_path):
        calls["n"] += 1
        raise LspError(
            "textDocument/documentSymbol timed out after 5.0s", kind="timeout"
        )

    def counting_evict(abs_path):
        evicted["n"] += 1
        return True

    mgr.document_symbols = wedged
    mgr.evict_server = counting_evict
    try:
        cbs = make_tool_callbacks(root, lambda ev: None, main_model=None)
        out = await cbs["lsp_symbols"]("a.py")
        assert calls["n"] == 2, f"expected one in-tool retry, saw {calls['n']}"
        assert evicted["n"] == 1, f"expected one eviction, saw {evicted['n']}"
        assert "wedged" in out, out
        assert "was stopped" in out, out
    finally:
        mgr.shutdown()


def test_definition_starts_server_lazily_and_maps_positions():
    fake = FakeClient()
    started: dict[str, tuple] = {}

    def starter(language: str, command: list[str], root: str):
        started[language] = (command, root)
        return fake

    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "a.py", "def foo():\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=starter)
        assert started == {}
        hits = mgr.definition(path, 2, 4)
        assert "python" in started  # server started lazily on first use
        method, params = fake.requests[0]
        assert method == "textDocument/definition"
        assert params["position"] == {"line": 1, "character": 4}  # 1-based -> 0-based
        assert hits[0]["line"] == 1  # 0-based -> 1-based
        assert hits[0]["path"] == "a.py"
        mgr.shutdown()


def test_symbol_ranges_from_document_symbols():
    fake = FakeClient()

    def starter(language: str, command: list[str], root: str):
        return fake

    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "b.py", "class Foo:\n    pass\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=starter)
        windows, missing = mgr.symbol_ranges(path, ["Foo", "nope"])
        assert windows == [(1, 3)]
        assert missing == ["nope"]
        mgr.shutdown()


def test_diagnostics_pull_unsupported_returns_empty():
    from lsp_manager import LspError

    class DiagFake(FakeClient):
        def request(self, method: str, params: dict, timeout: float | None = None):
            if method == "textDocument/diagnostic":
                raise LspError(
                    "textDocument/diagnostic failed: "
                    "{'code': -32601, 'message': 'Unhandled method textDocument/diagnostic'}"
                )
            return super().request(method, params, timeout)

    fake = DiagFake()

    def starter(language: str, command: list[str], root: str):
        return fake

    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "c.py", "x = 1\n")
        mgr = LspManager(root, timeout=2.0, starter=starter)
        assert mgr.diagnostics(path) == []
        mgr.shutdown()


def test_find_symbols_skips_without_workspace_provider():
    class NoProviderFake(FakeClient):
        def __init__(self) -> None:
            super().__init__()
            self.capabilities = {"workspaceSymbolProvider": False}

    fake = NoProviderFake()
    with tempfile.TemporaryDirectory() as root:
        mgr = LspManager(root, timeout=2.0, starter=lambda lang, cmd, r: fake)
        mgr._clients["python"] = fake
        out = mgr.find_symbols(["Foo"])
        assert out == {"Foo": []}
        assert all(m != "workspace/symbol" for m, _ in fake.requests)
        mgr.shutdown()


def test_find_symbols_queries_when_provider_advertised():
    class SymFake(FakeClient):
        def request(self, method: str, params: dict, timeout: float | None = None):
            if method == "workspace/symbol":
                self.requests.append((method, params))
                return [
                    {
                        "name": "Foo",
                        "kind": 5,
                        "location": {
                            "uri": "file:///b.py",
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 2, "character": 8},
                            },
                        },
                    }
                ]
            return super().request(method, params, timeout)

    fake = SymFake()
    with tempfile.TemporaryDirectory() as root:
        mgr = LspManager(root, timeout=2.0, starter=lambda lang, cmd, r: fake)
        mgr._clients["python"] = fake
        out = mgr.find_symbols(["Foo"])
        assert len(out["Foo"]) == 1
        assert out["Foo"][0][3] == "Foo"
        mgr.shutdown()


def test_diagnostics_skips_pull_without_provider():
    class PushFake(FakeClient):
        def __init__(self) -> None:
            super().__init__()
            self.capabilities = {}

        def published_diagnostics(self, uri: str):
            return [
                {
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 1},
                    },
                    "severity": 1,
                    "message": "oops",
                    "source": "t",
                }
            ]

        def wait_for_diagnostics(self, uri: str, timeout: float):
            return ([], False)

    fake = PushFake()
    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "d.py", "x = 1\n")
        mgr = LspManager(root, timeout=2.0, starter=lambda lang, cmd, r: fake)
        diags = mgr.diagnostics(path)
        assert len(diags) == 1
        assert diags[0]["message"] == "oops"
        assert all(m != "textDocument/diagnostic" for m, _ in fake.requests)
        mgr.shutdown()


def _dup_symbol_payload():
    rng_a = {
        "start": {"line": 0, "character": 0},
        "end": {"line": 5, "character": 0},
    }
    rng_a_init = {
        "start": {"line": 1, "character": 4},
        "end": {"line": 2, "character": 10},
    }
    rng_b = {
        "start": {"line": 6, "character": 0},
        "end": {"line": 10, "character": 0},
    }
    rng_b_init = {
        "start": {"line": 7, "character": 4},
        "end": {"line": 8, "character": 10},
    }
    return [
        {
            "name": "A",
            "kind": 5,
            "range": rng_a,
            "selectionRange": rng_a,
            "children": [
                {
                    "name": "__init__",
                    "kind": 12,
                    "range": rng_a_init,
                    "selectionRange": rng_a_init,
                }
            ],
        },
        {
            "name": "B",
            "kind": 5,
            "range": rng_b,
            "selectionRange": rng_b,
            "children": [
                {
                    "name": "__init__",
                    "kind": 12,
                    "range": rng_b_init,
                    "selectionRange": rng_b_init,
                }
            ],
        },
    ]


def test_document_symbols_keeps_qualified_duplicates():
    class DupFake(FakeClient):
        def request(self, method: str, params: dict, timeout: float | None = None):
            if method == "textDocument/documentSymbol":
                self.requests.append((method, params))
                return _dup_symbol_payload()
            return super().request(method, params, timeout)

    fake = DupFake()
    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "e.py", "class A:\n    pass\nclass B:\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=lambda lang, cmd, r: fake)
        syms = mgr.document_symbols(path)
        assert "A.__init__" in syms
        assert "B.__init__" in syms
        assert "__init__" in syms
        assert "__init__#2" in syms
        assert syms["A.__init__"] != syms["B.__init__"]
        mgr.shutdown()


def test_document_symbols_if_running_keeps_qualified():
    class DupFake(FakeClient):
        def request(self, method: str, params: dict, timeout: float | None = None):
            if method == "textDocument/documentSymbol":
                self.requests.append((method, params))
                return _dup_symbol_payload()
            return super().request(method, params, timeout)

    fake = DupFake()
    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "f.py", "class A:\n    pass\nclass B:\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=lambda lang, cmd, r: fake)
        mgr._clients["python"] = fake
        syms = mgr.document_symbols_if_running(path)
        assert "A.__init__" in syms
        assert "B.__init__" in syms
        mgr.shutdown()


def test_start_failure_cache_defaults_to_none_and_cold_start_succeeds(tmp_path, monkeypatch):
    """Fresh boot must not look like a recent start failure."""
    import time

    fake = FakeClient()
    calls: list[str] = []

    def starter(language: str, command: list[str], root: str):
        calls.append(language)
        return fake

    mgr = LspManager(str(tmp_path), timeout=2.0, starter=starter)
    assert mgr._start_failed_at.get("python") is None
    # Simulate fresh boot: monotonic uptime well below the 300s TTL.
    monkeypatch.setattr(time, "monotonic", lambda: 10.0)
    path = tmp_path / "a.py"
    path.write_text("def foo():\n    pass\n", encoding="utf-8")
    hits = mgr.definition(str(path), 2, 4)
    assert calls == ["python"]
    assert hits[0]["line"] == 1
    mgr.shutdown()


def test_start_failure_blocks_retry_within_ttl(tmp_path, monkeypatch):
    """A real failure is cached; the starter is not called again."""
    import time

    calls: list[str] = []

    def failing_starter(language: str, command: list[str], root: str):
        calls.append(language)
        raise RuntimeError("boom")

    mgr = LspManager(str(tmp_path), timeout=2.0, starter=failing_starter)
    now = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    path = tmp_path / "fail.py"
    path.write_text("x = 1\n", encoding="utf-8")
    import pytest

    from lsp_manager import LspError

    with pytest.raises(LspError):
        mgr.definition(str(path), 1, 0)
    assert calls == ["python"]
    assert mgr._start_failed_at.get("python") == 1000.0
    # Second call inside the TTL must not retry the starter.
    with pytest.raises(LspError):
        mgr.definition(str(path), 1, 0)
    assert calls == ["python"]
    mgr.shutdown()


def test_definition_clamps_character_to_line_length(tmp_path):
    """Characters past end-of-line are clamped before the request."""
    fake = FakeClient()
    mgr = LspManager(str(tmp_path), timeout=2.0, starter=lambda lang, cmd, r: fake)
    path = tmp_path / "clamp.py"
    path.write_text("hi\n", encoding="utf-8")
    mgr.definition(str(path), 1, 100)
    _, params = fake.requests[-1]
    assert params["position"] == {"line": 0, "character": 2}
    # Negative characters clamp to zero.
    mgr.definition(str(path), 1, -5)
    _, params = fake.requests[-1]
    assert params["position"] == {"line": 0, "character": 0}
    mgr.shutdown()


def test_references_and_hover_clamp_character(tmp_path):
    """References and hover share the same clamping helper."""
    fake = FakeClient()
    mgr = LspManager(str(tmp_path), timeout=2.0, starter=lambda lang, cmd, r: fake)
    path = tmp_path / "clamp2.py"
    path.write_text("abc\n", encoding="utf-8")
    assert mgr.references(str(path), 1, 50) == []
    _, params = fake.requests[-1]
    assert params["position"] == {"line": 0, "character": 3}
    assert mgr.hover(str(path), 1, 50) == ""
    _, params = fake.requests[-1]
    assert params["position"] == {"line": 0, "character": 3}
    mgr.shutdown()


def test_position_out_of_range_line_raises(tmp_path):
    """Out-of-range lines raise a clear error without a round-trip."""
    import pytest

    from lsp_manager import LspError

    fake = FakeClient()
    mgr = LspManager(str(tmp_path), timeout=2.0, starter=lambda lang, cmd, r: fake)
    path = tmp_path / "short.py"
    path.write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(LspError, match="out of range"):
        mgr.definition(str(path), 99, 0)
    with pytest.raises(LspError, match="out of range"):
        mgr.references(str(path), 99, 0)
    with pytest.raises(LspError, match="out of range"):
        mgr.hover(str(path), 99, 0)
    with pytest.raises(LspError, match="out of range"):
        mgr.definition(str(path), 0, 0)
    assert fake.requests == []
    mgr.shutdown()


def test_install_retry_after_consent():
    """A denied-then-approved install must be retried, not stuck as attempted."""
    import lsp_manager as _lm

    lang = "test-retry-lang"
    with tempfile.TemporaryDirectory() as root:
        mgr = LspManager(root, timeout=2.0, starter=lambda l, c, r: FakeClient())
        try:
            with _lm._INSTALL_ATTEMPTED_LOCK:
                _lm._INSTALL_ATTEMPTED.discard(lang)
                _lm._INSTALL_EVENTS.pop(lang, None)
            with _lm._INSTALL_CONFIRMED_LOCK:
                _lm._INSTALL_CONFIRMED.discard(lang)
            assert not _lm.has_install_consent(lang)
            mgr._maybe_auto_install(lang)
            with _lm._INSTALL_ATTEMPTED_LOCK:
                assert lang in _lm._INSTALL_ATTEMPTED
                first = _lm._INSTALL_EVENTS.get(lang)
            assert first is not None
            assert first.wait(timeout=2)
            _lm.grant_install_consent(lang)
            assert _lm.has_install_consent(lang)
            mgr._maybe_auto_install(lang)
            with _lm._INSTALL_ATTEMPTED_LOCK:
                second = _lm._INSTALL_EVENTS.get(lang)
            assert second is not None
            assert second is not first
        finally:
            with _lm._INSTALL_ATTEMPTED_LOCK:
                _lm._INSTALL_ATTEMPTED.discard(lang)
                _lm._INSTALL_EVENTS.pop(lang, None)
            with _lm._INSTALL_CONFIRMED_LOCK:
                _lm._INSTALL_CONFIRMED.discard(lang)
            mgr.shutdown()


def test_wait_for_server_blocks_until_start_finishes():
    """wait_for_server absorbs the lazy-start latency: it blocks on the
    in-progress start event and returns True once the client is live."""
    import threading
    import time as _time

    import lsp_manager as _lm

    fake = FakeClient()
    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "w.py", "def bar():\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=lambda l, c, r: fake)
        # FakeClient has no process to poll — force the liveness check.
        mgr._is_alive = lambda client: True
        evt = threading.Event()
        with _lm._STARTING_LOCK:
            _lm._STARTING[(mgr._root, "python")] = evt

        def _finish():
            _time.sleep(0.05)
            with mgr._lock:
                mgr._clients["python"] = fake
            evt.set()

        try:
            threading.Thread(target=_finish, daemon=True).start()
            assert mgr.wait_for_server(path, timeout_s=2.0) is True
        finally:
            with _lm._STARTING_LOCK:
                _lm._STARTING.pop((mgr._root, "python"), None)
            mgr.shutdown()


def test_wait_for_server_times_out_without_client():
    """A start that never produces a client must not hang: bounded timeout,
    False return — the tool surfaces the precise error instead."""
    import threading

    import lsp_manager as _lm

    with tempfile.TemporaryDirectory() as root:
        path = _write(root, "w2.py", "def baz():\n    pass\n")
        mgr = LspManager(root, timeout=2.0, starter=lambda l, c, r: FakeClient())
        mgr._is_alive = lambda client: False  # never live -> pure timeout path
        evt = threading.Event()
        with _lm._STARTING_LOCK:
            _lm._STARTING[(mgr._root, "python")] = evt
        try:
            assert mgr.wait_for_server(path, timeout_s=0.1) is False
        finally:
            with _lm._STARTING_LOCK:
                _lm._STARTING.pop((mgr._root, "python"), None)
            mgr.shutdown()
