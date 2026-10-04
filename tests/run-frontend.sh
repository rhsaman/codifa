#!/usr/bin/env bash
# Frontend sanity tests — parallel runner.
#
# Every test is bundled with esbuild (plain-node ones excepted) and executed
# in its own node process, JOBS at a time. Replaces the old sequential runner
# that spawned a fresh `npx esbuild` per test one after another.
# Run: npm run test:frontend
set -u
cd "$(dirname "$0")/.."

# Keep the temp dir INSIDE the project: bundles marked --packages=external
# resolve their imports at runtime, so node must be able to walk up from the
# bundle to the project's node_modules.
WORK="$(mktemp -d tests/.fe-run.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Resolve the local esbuild binary directly — much faster than spawning
# `npx esbuild` (npm exec) once per test.
if [ -x node_modules/.bin/esbuild ]; then
  ESBUILD="node_modules/.bin/esbuild"
else
  ESBUILD="npx esbuild"
fi
export ESBUILD
WORK_LOG="$WORK"
export WORK_LOG

NCPU="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
JOBS=$(( NCPU > 8 ? 8 : NCPU ))

# ---------------------------------------------------------------------------
# Worker: bundle one job (id|entry|esbuild-extra-args) and run it.
# "-" in the flags column = run the entry directly with plain node.
# ---------------------------------------------------------------------------
cat > "$WORK/one.sh" <<'ONE'
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
ONE
chmod +x "$WORK/one.sh"

# ---------------------------------------------------------------------------
# Job list: id|entry|esbuild-extra-args  ("-" = plain node, no bundling)
# Same tests, same esbuild flags as the previous sequential runner.
# ---------------------------------------------------------------------------
JOBS_LIST="$WORK/jobs.txt"
cat > "$JOBS_LIST" <<'EOF'
sections|tests/sections.test.ts|-
forkSection|tests/forkSection.test.ts|--external:electron
readingMode|tests/readingMode.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
loadingScreen|tests/loadingScreen.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
updater-core|tests/updater-core.test.ts|-
retry|tests/retry.test.ts|-
retryStore|tests/retryStore.test.ts|--packages=external --external:electron
retryStream|tests/retryStream.test.ts|--packages=external --external:electron
contextWindow|tests/contextWindow.test.ts|--packages=external --external:electron
contextBreakdown|tests/contextBreakdown.test.ts|--packages=external --external:electron
persistHeartbeat|tests/persistHeartbeat.test.ts|--packages=external --external:electron
scrollPos|tests/scrollPos.test.ts|--packages=external --external:electron
scrollPadding|tests/scrollPadding.test.ts|--packages=external --external:electron
usageContext|tests/usageContext.test.ts|--packages=external --external:electron
contextUsed|tests/contextUsed.test.ts|--packages=external --external:electron
link|tests/link.test.ts|-
skills|tests/skills.test.ts|--packages=external --external:electron
skillsCache|tests/skillsCache.test.ts|--packages=external --external:electron
thinking|tests/thinking.test.ts|-
ensureSidecar|tests/ensureSidecar.test.ts|--packages=external --external:electron
transcribe|tests/transcribe.test.ts|--packages=external --external:electron
voice|tests/voice.test.ts|-
webResults|tests/webResults.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
engineBadge|tests/engineBadge.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
retryBanner|tests/retryBanner.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
streamChatReconnect|tests/streamChatReconnect.test.ts|--packages=external --external:electron
thinkingIndicator|tests/thinkingIndicator.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
contextBudget|tests/contextBudget.test.ts|--packages=external --external:electron
compactChat|tests/compactChat.test.ts|--packages=external --external:electron
emptyChats|tests/emptyChats.test.ts|--packages=external --external:electron
messageWindow|tests/messageWindow.test.ts|-
renderCap|tests/renderCap.test.ts|-
queue-during-compact|tests/queue-during-compact.test.ts|--packages=external --external:electron
compactDedupe|tests/compactDedupe.test.ts|--packages=external --external:electron
sidebar|tests/sidebar.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --alias:src/lib/store=./src/lib/store --external:electron
usage|tests/usage.test.ts|-
bidi|tests/bidi.test.ts|-
tabBar|src/lib/tabBar.test.ts|
diffContrast|tests/diffContrast.test.ts|-
settingsStorage|tests/settingsStorage.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
toolNesting|tests/toolNesting.test.ts|
codeBlock|tests/codeBlock.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
lineCaption|tests/lineCaption.test.ts|--external:electron
watchdog|tests/watchdog.test.ts|-
fetchAndPersist|tests/fetchAndPersist.test.ts|--packages=external --external:electron
usageChip|tests/usageChip.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
traceNarration|tests/traceNarration.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
planApproval|tests/planApproval.test.ts|--packages=external --external:electron
toolEditGroup|tests/toolEditGroup.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
todosPanel|tests/todosPanel.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
providerModelSelect|tests/providerModelSelect.ssr.test.tsx|--jsx=automatic --packages=external --external:electron
settingsNoFetch|tests/settingsNoFetch.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
modelTest|tests/modelTest.test.tsx|--jsx=automatic --packages=external --external:electron
manualContext|tests/manualContext.test.ts|--packages=external --external:electron
reviewDiff|tests/reviewDiff.test.ts|--packages=external --external:electron
reviewStats|src/lib/reviewStats.test.ts|--packages=external --external:electron
reviewAccordion|tests/reviewAccordion.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
diffSearch|tests/diffSearch.test.ts|-
uncommitted|tests/uncommitted.test.ts|--packages=external --external:electron
tts|src/lib/tts.test.ts|--packages=external --external:electron
schedule|tests/schedule.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
fetchModels|src/components/SettingsModal.fetchModels.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
chatLag|tests/chatLag.test.ts|--packages=external --external:electron
diffResponsive|tests/diffResponsive.ssr.test.tsx|--jsx=automatic --packages=external --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js --external:electron
chatLoad|tests/chatLoad.test.ts|--packages=external --external:electron
chatTabAskBadge|tests/chatTabAskBadge.test.ts|--jsx=automatic --packages=external --external:electron
time|tests/time.test.ts|-
EOF

# Split into per-job files (zero-padded so glob order == list order).
i=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i + 1))
  printf '%s\n' "$line" > "$WORK/$(printf '%03d' "$i").job"
done < "$JOBS_LIST"
TOTAL=$i

echo "Frontend tests: $TOTAL jobs, running $JOBS at a time..."
ls "$WORK"/*.job | xargs -P "$JOBS" -n 1 "$WORK/one.sh"

# Report in the original list order; show output only for failures.
echo ""
fail=0
for f in "$WORK"/*.job; do
  id="$(cut -d'|' -f1 "$f")"
  entry="$(cut -d'|' -f2 "$f")"
  status="$(cat "$WORK/$id.status" 2>/dev/null || echo FAIL)"
  if [ "$status" = "PASS" ]; then
    echo "PASS  $id ($entry)"
  else
    fail=$((fail + 1))
    echo "FAIL  $id ($entry)"
    if [ -s "$WORK/$id.build" ]; then
      echo "  -- esbuild output --"
      sed -n '1,25p' "$WORK/$id.build" | sed 's/^/  /'
    fi
    if [ -s "$WORK/$id.log" ]; then
      echo "  -- test output --"
      tail -n 25 "$WORK/$id.log" | sed 's/^/  /'
    fi
  fi
done
echo ""
if [ "$fail" -gt 0 ]; then
  echo "FAILED: $fail of $TOTAL frontend tests"
  exit 1
fi
echo "All $TOTAL frontend tests passed"
