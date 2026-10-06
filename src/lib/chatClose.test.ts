// Unit tests for Ctrl+W chat close resolution.
// Run: node_modules/.bin/esbuild src/lib/chatClose.test.ts --bundle --platform=node --format=esm --outfile=/tmp/chatClose.test.mjs && node /tmp/chatClose.test.mjs
import { resolveChatClose } from "./chatClose";

export {};

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("1) resolveChatClose — multi closes window, single closes tab:");
{
  const multi = resolveChatClose("b", ["a", "b"], "b");
  check("multi -> window", multi?.kind === "window" && multi?.id === "b", multi);
  const single = resolveChatClose("a", ["a"], "a");
  check("single -> tab", single?.kind === "tab" && single?.id === "a", single);
  check("empty -> null", resolveChatClose("", [], "") === null);
  // Focused window id wins over stale active id when provided.
  const focused = resolveChatClose("c", ["a", "b", "c"], "a");
  check("focused window closes", focused?.kind === "window" && focused?.id === "c", focused);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat close checks passed");
