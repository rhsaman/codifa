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
