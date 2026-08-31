"""Tests: codifa.log must be free of per-run WARNING noise from codifa.server
("agent run start/complete", "stream DISCONNECTED", rss snapshots …) while
preserving real ERROR/CRITICAL events from codifa.server AND WARNING+
diagnostics from other loggers (codifa.graph, codifa.compact, …).

The filter is installed on the RotatingFileHandler in server.main() and is
gated by env var CODFA_LOG_FILE_SERVER_ERROR_ONLY (default "1").
"""
import logging
import os
import sys

# Ensure backend/ is on sys.path so we can import _log_filter.py directly.
_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, os.path.abspath(_BACKEND_DIR))

from _log_filter import ServerErrorOnlyFilter


def _install_filtered_file_handler(tmp_path, *, env_value: str | None = "1"):
    """Mirror what server.main() does for codifa.log: a FileHandler on the
    root logger that has the ServerErrorOnlyFilter attached, and an env var
    that controls whether the filter is on."""
    if env_value is not None:
        os.environ["CODFA_LOG_FILE_SERVER_ERROR_ONLY"] = env_value
    else:
        os.environ.pop("CODFA_LOG_FILE_SERVER_ERROR_ONLY", None)

    log_file = tmp_path / "test_codifa.log"
    handler = logging.FileHandler(str(log_file), encoding="utf-8")
    handler.setLevel(logging.DEBUG)
    if env_value != "0":
        handler.addFilter(ServerErrorOnlyFilter())

    root = logging.getLogger()
    prior_handlers = list(root.handlers)
    prior_level = root.level
    root.handlers = [handler]
    root.setLevel(logging.DEBUG)
    return log_file, prior_handlers, prior_level


def _restore_root(prior_handlers, prior_level):
    root = logging.getLogger()
    for h in list(root.handlers):
        try:
            h.close()
        except Exception:  # noqa: BLE001, S110
            pass
    root.handlers = prior_handlers
    root.setLevel(prior_level)


def test_filter_drops_server_warnings_keeps_errors(tmp_path):
    log_file, prior_h, prior_l = _install_filtered_file_handler(tmp_path, env_value="1")
    try:
        server = logging.getLogger("codifa.server")
        graph = logging.getLogger("codifa.graph")
        server.setLevel(logging.DEBUG)
        graph.setLevel(logging.DEBUG)

        server.warning("agent run start chat_id=abc rss_mb=237.5")
        server.warning("stream DISCONNECTED (client/sidecar drop) keepalives_sent=0")
        server.error("unhandled exception (not caught by FastAPI):")
        server.critical("disk full")
        graph.warning("[run_graph] run cancelled (client/sidecar disconnect)")

        for h in logging.getLogger().handlers:
            h.flush()

        text = log_file.read_text(encoding="utf-8")
        assert "agent run start" not in text
        assert "stream DISCONNECTED" not in text
        assert "unhandled exception" in text
        assert "disk full" in text
        assert "run cancelled" in text
    finally:
        _restore_root(prior_h, prior_l)


def test_filter_disabled_when_env_var_zero(tmp_path):
    log_file, prior_h, prior_l = _install_filtered_file_handler(tmp_path, env_value="0")
    try:
        server = logging.getLogger("codifa.server")
        server.setLevel(logging.DEBUG)
        server.warning("agent run start chat_id=xyz rss_mb=100.0")
        server.error("real error that should appear")

        for h in logging.getLogger().handlers:
            h.flush()

        text = log_file.read_text(encoding="utf-8")
        assert "agent run start" in text
        assert "real error that should appear" in text
    finally:
        _restore_root(prior_h, prior_l)


def test_filter_class_unit():
    """Unit-test the filter directly to lock the contract:
    codifa.server + level < ERROR -> drop, everything else -> keep."""
    f = ServerErrorOnlyFilter()

    def _rec(name: str, level: int) -> logging.LogRecord:
        return logging.LogRecord(
            name=name,
            level=level,
            pathname=__file__,
            lineno=1,
            msg="x",
            args=(),
            exc_info=None,
        )

    assert f.filter(_rec("codifa.server", logging.DEBUG)) is False
    assert f.filter(_rec("codifa.server", logging.INFO)) is False
    assert f.filter(_rec("codifa.server", logging.WARNING)) is False
    assert f.filter(_rec("codifa.server", logging.ERROR)) is True
    assert f.filter(_rec("codifa.server", logging.CRITICAL)) is True
    assert f.filter(_rec("codifa.graph", logging.WARNING)) is True
    assert f.filter(_rec("codifa.compact", logging.INFO)) is True
    assert f.filter(_rec("backend.graph", logging.DEBUG)) is True
