"""Logging filter that silences per-run WARNING noise from codifa.server.

Extracted into a standalone module (no heavy dependencies) so tests can import
it without pulling in FastAPI, LangChain, or the rest of the sidecar stack.
"""
from __future__ import annotations

import logging


class ServerErrorOnlyFilter(logging.Filter):
    """Drop WARNING/INFO/DEBUG records emitted by ``codifa.server`` so the
    persistent ``codifa.log`` only carries genuine ERROR/CRITICAL events from
    that module.  Records from other loggers (``codifa.compact``,
    ``codifa.graph``, ``backend.*`` …) pass through unchanged so diagnostics
    like the disconnect trace from ``graph.py`` still land in the file.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return not (record.name == "codifa.server" and record.levelno < logging.ERROR)
