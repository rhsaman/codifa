#!/usr/bin/env bash
set -u
job="$1"
id="$(cut -d'|' -f1 "$job")"
entry="$(cut -d'|' -f2 "$job")"
flags="$(cut -d'|' -f3- "$job")"
if [ "$flags" = "-" ]; then
  if node "$entry" >"$WORK_LOG/$id.log" 2>&1; then
    echo PASS >"$WORK_LOG/$id.status"
  else
    echo FAIL >"$WORK_LOG/$id.status"
  fi
  exit 0
fi
bundle="$WORK_LOG/$id.mjs"
# shellcheck disable=SC2086 — the flag string must word-split into args
if ! "$ESBUILD" "$entry" --bundle --platform=node --format=esm $flags \
     --outfile="$bundle" >"$WORK_LOG/$id.build" 2>&1; then
  echo FAIL >"$WORK_LOG/$id.status"
  exit 0
fi
if node "$bundle" >"$WORK_LOG/$id.log" 2>&1; then
  echo PASS >"$WORK_LOG/$id.status"
else
  echo FAIL >"$WORK_LOG/$id.status"
fi
