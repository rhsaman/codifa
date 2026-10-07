"""Unit tests for the detached dev-server registry (no real processes)."""

import os
import tempfile
import time

import pytest

import dev_server


class FakePopen:
    """Minimal Popen stand-in: never spawns, never sleeps."""

    instances: list["FakePopen"] = []  # noqa: RUF012 — test double, reset per test

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.pid = 1000 + len(FakePopen.instances)
        self._alive = True
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_calls = 0
        FakePopen.instances.append(self)

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminate_calls += 1
        self._alive = False

    def kill(self):
        self.kill_calls += 1
        self._alive = False

    def wait(self, timeout=None):
        self.wait_calls += 1
        self._alive = False
        return 0


@pytest.fixture(autouse=True)
def _clean_registry(monkeypatch):
    monkeypatch.setattr(dev_server.subprocess, "Popen", FakePopen)
    FakePopen.instances.clear()
    dev_server._REGISTRY.clear()
    yield
    for name in list(dev_server._REGISTRY.keys()):
        try:
            dev_server.stop(name, grace_s=0)
        except Exception:  # noqa: BLE001, S110 — isolation never breaks setup
            pass
    dev_server._REGISTRY.clear()
    FakePopen.instances.clear()


def test_start_status_stop_without_blocking(tmp_path):
    info = dev_server.start("web", ["node", "server.js"], port=5174, cwd=str(tmp_path))
    assert info["name"] == "web"
    assert info["port"] == 5174
    assert info["running"] is True
    # Spawned detached with output redirected to a log file next to cwd.
    spawned = FakePopen.instances[-1]
    assert spawned.kwargs.get("start_new_session") is True
    assert spawned.wait_calls == 0  # start() never waits -> non-blocking
    assert os.path.isfile(info["log_path"])
    assert info["log_path"].startswith(tempfile.gettempdir())
    assert str(tmp_path) not in info["log_path"]

    listed = dev_server.status()
    assert [e["name"] for e in listed] == ["web"]

    assert dev_server.stop("web", grace_s=0) is True
    assert spawned.terminate_calls == 1
    assert dev_server.status() == []
    assert dev_server.stop("missing") is False


def test_idle_sweep_evicts_only_stale_entry(tmp_path):
    base = time.monotonic()
    dev_server.start("fresh", ["vite"], port=5174, cwd=str(tmp_path))
    dev_server.start("stale", ["vite"], port=3001, cwd=str(tmp_path))
    dev_server._REGISTRY["stale"].last_used = base - (dev_server.IDLE_EVICT_S + 1)
    dev_server._REGISTRY["fresh"].last_used = base

    evicted = dev_server.sweep_idle(now=base + 1)

    assert evicted == ["stale"]
    assert [e["name"] for e in dev_server.status()] == ["fresh"]


def test_custom_log_file_stays_in_temp_dir(tmp_path):
    info = dev_server.start(
        "custom", ["vite"], port=5174, cwd=str(tmp_path),
        log_file="/elsewhere/custom.log",
    )
    assert info["log_path"].startswith(tempfile.gettempdir())
    assert os.path.basename(info["log_path"]) == "custom.log"
    assert dev_server.stop("custom", grace_s=0) is True


def test_log_path_ignores_cwd(tmp_path):
    path = dev_server._log_path("web", str(tmp_path))
    assert path.startswith(tempfile.gettempdir())
    assert str(tmp_path) not in path


def test_temp_subdir_log_file_kept_as_is(tmp_path):
    """Log paths already under the OS temp dir keep their subdir.

    Regression for the terminal_logs ENOENT: _terminal_bg_start stores
    <tmp>/codifa-terminal/terminal-<job>.log but the registry stripped it
    to <tmp>/terminal-<job>.log, so terminal_logs opened a missing file.
    """
    wanted = os.path.join(tempfile.gettempdir(), "codifa-terminal", "terminal-abc123.log")
    info = dev_server.start(
        "subdir", ["vite"], port=5174, cwd=str(tmp_path), log_file=wanted
    )
    assert os.path.realpath(info["log_path"]) == os.path.realpath(wanted)
    assert os.path.isfile(info["log_path"])
    assert dev_server.stop("subdir", grace_s=0) is True


def test_outside_temp_log_file_reduced_to_basename(tmp_path):
    """Paths outside temp never escape: only the basename is kept."""
    info = dev_server.start(
        "outside", ["vite"], port=5174, cwd=str(tmp_path),
        log_file="/elsewhere/nested/custom.log",
    )
    assert info["log_path"].startswith(tempfile.gettempdir())
    assert os.path.basename(info["log_path"]) == "custom.log"
    assert dev_server.stop("outside", grace_s=0) is True


def test_terminal_logs_falls_back_to_basename():
    """terminal_logs recovers when the job points at a pre-fix subdir path."""
    import tools as _tools

    jid = "fallback7x"
    missing = os.path.join(
        tempfile.gettempdir(), "codifa-terminal", f"terminal-{jid}.log"
    )
    fallback = os.path.join(tempfile.gettempdir(), f"terminal-{jid}.log")
    # Isolation: another test creates terminal-abc123.log; use a unique job
    # id and make sure the stale subdir path really does not exist.
    try:
        os.remove(missing)
    except OSError:
        pass
    with open(fallback, "w", encoding="utf-8") as fh:
        fh.write("hello-live")
    _tools._TERMINAL_BG_JOBS[jid] = {
        "pid": 0,
        "command": "echo hi",
        "log_file": missing,
        "status": "exited",
        "returncode": 0,
    }
    try:
        out = _tools.terminal_logs(jid)
        assert out.get("output") == "hello-live"
        assert out.get("log_file") == fallback
    finally:
        _tools._TERMINAL_BG_JOBS.pop(jid, None)
        try:
            os.remove(fallback)
        except OSError:
            pass
