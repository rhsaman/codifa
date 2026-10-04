// Unit tests for the shared tab-bar reorder helpers.
// Run: npx esbuild src/lib/tabBar.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/tabBar.test.mjs && node /tmp/tabBar.test.mjs
import { dropSide, edgeScroll, tabMove } from "./tabBar";

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

console.log("1) tabMove — Alt+Arrow keyboard reorder:");
{
  const ids = ["a", "b", "c"];
  check(
    "Alt+ArrowRight on b drops after c",
    JSON.stringify(tabMove(ids, "b", "ArrowRight", true)) === '{"toId":"c","after":true}',
  );
  check(
    "Alt+ArrowLeft on b drops before a",
    JSON.stringify(tabMove(ids, "b", "ArrowLeft", true)) === '{"toId":"a","after":false}',
  );
  check("without Alt -> null", tabMove(ids, "b", "ArrowLeft", false) === null);
  check("unrelated key -> null", tabMove(ids, "b", "Home", true) === null);
  check(
    "edge tabs do not move",
    tabMove(ids, "a", "ArrowLeft", true) === null &&
      tabMove(ids, "c", "ArrowRight", true) === null,
  );
}

console.log("2) dropSide + edgeScroll — drag position helpers:");
{
  const tab = { left: 100, width: 200 };
  check("pointer on left half -> before", dropSide(150, tab) === "before");
  check("pointer on right half -> after", dropSide(250, tab) === "after");
  const bar = { left: 0, width: 400 };
  check("near left edge scrolls left", edgeScroll(10, bar) < 0);
  check("near right edge scrolls right", edgeScroll(390, bar) > 0);
  check("middle does not scroll", edgeScroll(200, bar) === 0);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tab bar helper checks passed");
