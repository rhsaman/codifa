// src/lib/tabBar.ts
function dropSide(clientX, rect, threshold = 0.5) {
  return clientX - rect.left <= rect.width * threshold ? "before" : "after";
}
function tabMove(ids, id, key, altKey) {
  if (!altKey) return null;
  const delta = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (delta === 0) return null;
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return null;
  return { toId: ids[j], after: delta > 0 };
}
function edgeScroll(clientX, bar, edge = 64, speed = 14) {
  const x = Math.min(Math.max(clientX - bar.left, 0), bar.width);
  if (x < edge) return -Math.round(speed * (1 - x / edge));
  if (x > bar.width - edge) return Math.round(speed * ((x - (bar.width - edge)) / edge));
  return 0;
}
function inactiveTabIds(openIds, activeId, streaming, visible) {
  const streamingSet = streaming instanceof Set ? streaming : new Set(streaming);
  const visibleSet = visible instanceof Set ? visible : new Set(visible);
  return openIds.filter(
    (id) => id !== activeId && !streamingSet.has(id) && !visibleSet.has(id)
  );
}

// src/lib/tabBar.test.ts
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}
console.log("1) tabMove \u2014 Alt+Arrow keyboard reorder:");
{
  const ids = ["a", "b", "c"];
  check(
    "Alt+ArrowRight on b drops after c",
    JSON.stringify(tabMove(ids, "b", "ArrowRight", true)) === '{"toId":"c","after":true}'
  );
  check(
    "Alt+ArrowLeft on b drops before a",
    JSON.stringify(tabMove(ids, "b", "ArrowLeft", true)) === '{"toId":"a","after":false}'
  );
  check("without Alt -> null", tabMove(ids, "b", "ArrowLeft", false) === null);
  check("unrelated key -> null", tabMove(ids, "b", "Home", true) === null);
  check(
    "edge tabs do not move",
    tabMove(ids, "a", "ArrowLeft", true) === null && tabMove(ids, "c", "ArrowRight", true) === null
  );
}
console.log("2) dropSide + edgeScroll \u2014 drag position helpers:");
{
  const tab = { left: 100, width: 200 };
  check("pointer on left half -> before", dropSide(150, tab) === "before");
  check("pointer on right half -> after", dropSide(250, tab) === "after");
  const bar = { left: 0, width: 400 };
  check("near left edge scrolls left", edgeScroll(10, bar) < 0);
  check("near right edge scrolls right", edgeScroll(390, bar) > 0);
  check("middle does not scroll", edgeScroll(200, bar) === 0);
}
console.log("3) inactiveTabIds \u2014 bulk cleanup keeps active/streaming/visible:");
{
  const open = ["a", "b", "c", "d", "e"];
  check(
    "closes only idle background tabs",
    JSON.stringify(inactiveTabIds(open, "a", /* @__PURE__ */ new Set(["b"]), /* @__PURE__ */ new Set(["c"]))) === '["d","e"]'
  );
  check("empty open -> empty", inactiveTabIds([], "a", [], []).length === 0);
  check(
    "all protected -> empty",
    inactiveTabIds(["a", "b"], "a", ["b"], []).length === 0
  );
  check(
    "accepts arrays for streaming/visible",
    JSON.stringify(inactiveTabIds(["a", "b"], "x", [], ["a"])) === '["b"]'
  );
}
if (failed > 0) {
  console.error(`
${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tab bar helper checks passed");
