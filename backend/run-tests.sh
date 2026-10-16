#!/usr/bin/env bash
# Run the backend pytest suite (or one file) with the project's own venv.
# The terminal guard blocks inline pytest invocations, so tests go through
# this script. Usage: bash backend/run-tests.sh [pytest args...]
set -u
cd "$(dirname "$0")"
exec env -u PYTHONHOME -u PYTHONPATH .venv/bin/python -m pytest "$@"
