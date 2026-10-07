"""LSP manager tests with a fake in-process server (no binaries, no sleeps)."""

from __future__ import annotations

import os
import tempfile

from lsp_manager import LspManager


class FakeClient:
    """Minimal fake server: echoes the opened URI with canned payloads."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []

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
