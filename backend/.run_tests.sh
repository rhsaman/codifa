#!/usr/bin/env bash
# Run the backend test suite with the project's own venv and settings.
set -eu
cd "$(dirname "$0")"
exec env -u PYTHONHOME .venv/bin/python -m pytest tests/ -q --no-header -p no:cacheprovider
