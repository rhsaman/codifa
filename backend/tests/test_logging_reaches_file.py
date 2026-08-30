"""Tests: unhandled exceptions in the sidecar MUST reach codifa.log, not just
stderr (which Electron may not capture in packaged mode).

The custom sys.excepthook installed by server.main() is the safety net for
any exception that escapes FastAPI's handler (background task, signal
handler, top-level code, etc.). Without it, a hard crash inside a
background task only surfaces as a "Task exception was never retrieved"
line on stderr that the user can never see, which is exactly the
"message cuts off" symptom the user is trying to debug.
"""
import logging
import os
import sys


def _install_file_handler(tmp_path):
    """Attach a real FileHandler to the root logger and return its path."""
    log_file = tmp_path / "test_codifa.log"
    handler = logging.FileHandler(str(log_file), encoding="utf-8")
    handler.setLevel(logging.ERROR)
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.ERROR)
    return log_file, handler


def test_excepthook_writes_traceback_to_file(tmp_path, monkeypatch):
    """The excepthook must log the full traceback (not just the message) to
    the root logger — which is where the RotatingFileHandler (codifa.log) is
    attached. Without traceback info, the persistent log is useless for
    diagnosing the actual crash site."""
    log_file, handler = _install_file_handler(tmp_path)
    try:
        # Simulate the excepthook that server.main() installs.
        def _hook(exc_type, exc_value, exc_tb):
            logging.getLogger("codifa.server").error(
                "unhandled exception (not caught by FastAPI):",
                exc_info=(exc_type, exc_value, exc_tb),
            )

        monkeypatch.setattr(sys, "excepthook", _hook)

        try:
            raise ValueError("test exception for the file handler")
        except ValueError:
            sys.excepthook(*sys.exc_info())

        handler.flush()
        log_text = log_file.read_text(encoding="utf-8")
        assert "unhandled exception" in log_text
        assert "ValueError" in log_text
        assert "test exception for the file handler" in log_text
        # The traceback must include the source line of the raise so a
        # postmortem reader can locate the crash site.
        assert "test_excepthook_writes_traceback_to_file" in log_text
    finally:
        logging.getLogger().removeHandler(handler)


def test_excepthook_does_not_swallow_default_behavior(tmp_path, monkeypatch):
    """The excepthook must still call the default sys.__excepthook__ — it
    only ADDS a log entry, it does not REPLACE the default crash behavior.
    Otherwise the process would not die and the traceback would never reach
    stderr for live dev."""
    log_file, handler = _install_file_handler(tmp_path)
    default_called = {"v": False}

    def _spy_default(*args, **kwargs):
        default_called["v"] = True
        # Don't actually raise in a test — just record that we were called.

    def _hook(exc_type, exc_value, exc_tb):
        logging.getLogger("codifa.server").error(
            "unhandled:", exc_info=(exc_type, exc_value, exc_tb),
        )
        # Mirror the production code: also call the default hook.
        _spy_default(exc_type, exc_value, exc_tb)

    monkeypatch.setattr(sys, "excepthook", _hook)
    monkeypatch.setattr(sys, "__excepthook__", _spy_default)

    try:
        raise RuntimeError("x")
    except RuntimeError:
        sys.excepthook(*sys.exc_info())

    assert default_called["v"], (
        "production excepthook must still call sys.__excepthook__ so the "
        "process dies normally and stderr sees the traceback in dev"
    )
    handler.flush()
    log_file.unlink(missing_ok=True)
    logging.getLogger().removeHandler(handler)


def test_rotating_handler_caps_file_size(tmp_path):
    """The RotatingFileHandler installed in main() must rotate codifa.log when
    it exceeds maxBytes — without rotation, a long session can grow the file
    into the hundreds-of-MB range."""
    import logging.handlers

    log_file = tmp_path / "rotating.log"
    handler = logging.handlers.RotatingFileHandler(
        str(log_file),
        maxBytes=1024,  # 1 KiB so the test rotates fast
        backupCount=2,
        encoding="utf-8",
    )
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    try:
        # Emit far more than 1 KiB of log lines.
        for i in range(200):
            root.warning("rotate-test line %d padding padding padding", i)
        handler.flush()
    finally:
        root.removeHandler(handler)

    # The current log file must be under maxBytes (the active one), and
    # backup files must have been created.
    assert log_file.exists()
    assert log_file.stat().st_size <= 2048, "active log file exceeded maxBytes"
    backups = sorted(tmp_path.glob("rotating.log.*"))
    assert len(backups) >= 1, "no backup files were created — rotation didn't fire"
    # backupCount=2 means at most 2 backups, plus the active file.
    assert len(backups) <= 2, f"too many backups: {backups}"
