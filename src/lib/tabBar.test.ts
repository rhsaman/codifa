// Unit tests for the shared tab-bar reorder helpers.
// Run: npx esbuild src/lib/tabBar.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/tabBar.test.mjs && node /tmp/tabBar.test.mjs
import { dropSide, edgeScroll, inactiveTabIds, menuLeft, tabForPoint, tabMove } from "./tabBar";
import { previewShifts } from "./tabOrder";

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

console.log("3) inactiveTabIds — bulk cleanup keeps active/streaming/visible:");
{
  const open = ["a", "b", "c", "d", "e"];
  check(
    "closes only idle background tabs",
    JSON.stringify(inactiveTabIds(open, "a", new Set(["b"]), new Set(["c"]))) === '["d","e"]',
  );
  check("empty open -> empty", inactiveTabIds([], "a", [], []).length === 0);
  check(
    "all protected -> empty",
    inactiveTabIds(["a", "b"], "a", ["b"], []).length === 0,
  );
  check(
    "accepts arrays for streaming/visible",
    JSON.stringify(inactiveTabIds(["a", "b"], "x", [], ["a"])) === '["b"]',
  );
}

console.log("4) vertical rail — axis-aware helpers:");
{
  const tab = { top: 100, height: 200 };
  check("pointer on top half -> before", dropSide(150, tab, "y") === "before");
  check("pointer on bottom half -> after", dropSide(250, tab, "y") === "after");
  const ids = ["a", "b", "c"];
  check(
    "Alt+ArrowDown on b drops after c",
    JSON.stringify(tabMove(ids, "b", "ArrowDown", true, "y")) === '{"toId":"c","after":true}',
  );
  check(
    "Alt+ArrowUp on b drops before a",
    JSON.stringify(tabMove(ids, "b", "ArrowUp", true, "y")) === '{"toId":"a","after":false}',
  );
  check(
    "horizontal arrows are ignored on a vertical rail",
    tabMove(ids, "b", "ArrowLeft", true, "y") === null,
  );
  const rail = { top: 0, height: 400 };
  check("near top edge scrolls up", edgeScroll(10, rail, "y") < 0);
  check("near bottom edge scrolls down", edgeScroll(390, rail, "y") > 0);
  check("middle does not scroll", edgeScroll(200, rail, "y") === 0);
}

console.log("5) menuLeft — dropdown stays inside the viewport:");
{
  check("bottom menu keeps the trigger's left edge", menuLeft(100, 240, 1000) === 100);
  check("bottom menu never pokes past the right edge", menuLeft(990, 240, 1000) === 760);
  check("left menu opens away from the right edge", menuLeft(980, 240, 1000, "left") === 740);
  check("left menu never pokes past the left edge", menuLeft(10, 240, 1000, "left") === 12);
}

console.log("6) previewShifts — animated slide preview:");
{
  const ids = ["a", "b", "c"];
  const end = previewShifts(ids, "a", "c", true);
  check(
    "a to the end: b and c each slide one slot left",
    end.get("b") === -1 && end.get("c") === -1 && end.get("a") === undefined,
  );
  const front = previewShifts(ids, "c", "a", false);
  check("c to the front: a and b slide right", front.get("a") === 1 && front.get("b") === 1);
  const noop = previewShifts(ids, "a", "b", false);
  check("a landing already in place slides nothing", noop.size === 0);
  const swap = previewShifts(ids, "b", "c", true);
  check("b after c: only c slides left", swap.get("c") === -1 && swap.get("a") === undefined);
  check("unknown tab -> empty", previewShifts(ids, "x", "c", true).size === 0);
}

console.log("7) tabForPoint — geometric drop target (gaps are not dead zones):");
{
  const tabs = [
    { id: "a", left: 0, right: 100 },
    { id: "b", left: 106, right: 206 },
    { id: "c", left: 212, right: 312 },
  ];
  check("over a's left half -> a/before", JSON.stringify(tabForPoint(tabs, 30)) === '{"id":"a","after":false}');
  check("over a's right half -> a/after", tabForPoint(tabs, 80)?.after === true);
  const gap = tabForPoint(tabs, 102);
  check("gap nearest a's edge -> a/after", gap?.id === "a" && gap.after === true);
  check("past the end -> last tab/after", tabForPoint(tabs, 400)?.id === "c" && tabForPoint(tabs, 400)?.after === true);
  check("before the start -> first tab/before", tabForPoint(tabs, -20)?.id === "a" && tabForPoint(tabs, -20)?.after === false);
  // rtl: a drop on a tab's right half is BEFORE it in array order.
  check("rtl right half flips to before", tabForPoint(tabs, 80, -1)?.after === false);
  check("rtl past the (visual) end flips to before on first", tabForPoint(tabs, -20, -1)?.after === true);
  check("empty bar -> null", tabForPoint([], 50) === null);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tab bar helper checks passed");
