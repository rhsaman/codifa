// Unit test for watchdog waiting-for-model helpers.
// Run: npx esbuild src/lib/watchdog.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-watchdog.mjs && node src/lib/.tmp-watchdog.mjs

import { contentElapsedMs, shouldShowWaitingForModel } from "./watchdog"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? "")
  }
}

console.log("1) keepalive keeps socket fresh but content goes stale -> show pill:")
{
  // 60s without real content, socket alive (keepalive every ~15s)
  check("shows waiting pill", shouldShowWaitingForModel(60_000, 5_000, 300_000) === true)
}

console.log("2) fresh content -> no pill:")
{
  check("hides pill", shouldShowWaitingForModel(5_000, 5_000, 300_000) === false)
}

console.log("3) dead socket (no keepalive) -> no early pill (stall path owns it):")
{
  check("hides pill", shouldShowWaitingForModel(400_000, 400_000, 300_000) === false)
}

console.log("4) contentElapsedMs is pure subtraction:")
{
  check("elapsed", contentElapsedMs(1000, 26000) === 25000)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log("\nAll tests passed.")
}
