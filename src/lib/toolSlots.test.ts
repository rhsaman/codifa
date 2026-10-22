// Unit tests for the Tools → "Other" model group resolution.
// Run: npx esbuild src/lib/toolSlots.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/toolSlots.test.mjs && node /tmp/toolSlots.test.mjs
import {
  OTHER_SLOTS,
  TOOL_FALLBACK_SLOTS,
  isMainModelEntry,
  moveFallback,
  otherSlotFallbacks,
  otherSlotLevel,
  otherSlotModel,
  toolChainRows,
  toolChainSet,
  toolFallbackEntries,
  toolFallbackToModel,
  toolFallbackValue,
  withOtherSlotsFilled,
} from "./toolSlots";
import type { ThinkingLevel, ToolFallback } from "../types";

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

// The real-world case this module exists for: the Tools → "Other" row stores
// its pick under `title`/`web`, and `compact` was never written. Consumers that
// read only `subagentModels.compact` fell back to the main chat model, so the
// commit message and the compactor silently ignored the user's choice.
const onDisk = {
  explore: "prov-a/explore-model",
  title: "prov-b/side-model",
  vision: "prov-a/vision-model",
  web: "prov-b/side-model",
};
check("resolves the group when compact is missing", otherSlotModel(onDisk) === "prov-b/side-model");
check(
  "explicit compact wins over the other group members",
  otherSlotModel({ compact: "prov-c/first", web: "prov-b/second" }) === "prov-c/first",
);
check("an empty map means the main model", otherSlotModel({}) === "");
check("undefined means the main model", otherSlotModel(undefined) === "");
check(
  "main-model sentinels mean the main model",
  otherSlotModel({ compact: "main model", web: "main_model", title: "main" }) === "",
);
check(
  "a sentinel in one slot does not hide the group's model",
  otherSlotModel({ compact: "main model", web: "prov-b/side-model" }) === "prov-b/side-model",
);
check(
  "sentinels are detected case-insensitively and trimmed",
  isMainModelEntry("  Main  ") && isMainModelEntry("MAIN MODEL") && !isMainModelEntry("prov/m"),
);
check("every slot keeps the providerId/model format", otherSlotModel({ title: "p/m" }) === "p/m");

check("level defaults to none when unset", otherSlotLevel({}) === "none");
check("level defaults to none for undefined", otherSlotLevel(undefined) === "none");
check(
  "the group's own level wins regardless of key",
  otherSlotLevel({ title: "low" as ThinkingLevel }) === "low",
);
check(
  "compact level wins over the later group members",
  otherSlotLevel({ compact: "high", web: "low" } as Record<string, ThinkingLevel>) === "high",
);

// Backfill: after loading, every group key must point at the same model, so a
// consumer reading any single key lands on the user's pick.
const filled = withOtherSlotsFilled(onDisk);
check(
  "backfill writes the group model into every slot",
  OTHER_SLOTS.every((k) => filled[k] === "prov-b/side-model"),
  filled,
);
check("backfill keeps unrelated slots untouched", filled.explore === "prov-a/explore-model");
check("backfill does not invent a group when none is set", withOtherSlotsFilled({}).compact === undefined);
check(
  "backfill overwrites stale main-model sentinels",
  withOtherSlotsFilled({ compact: "main model", title: "p/m" }).compact === "p/m",
);
check(
  "backfill returns a copy (no mutation of the input)",
  (() => {
    const src = { title: "p/m" };
    withOtherSlotsFilled(src);
    return src.title === "p/m" && !("web" in src);
  })(),
);

// Per-tool fallback lists (Settings → Tools): the wire mapping must keep the
// user's arranged order and drop rows that cannot address a provider.
const slots: Record<string, ToolFallback[]> = {
  explore: [
    { providerId: "prov-b", model: "backup-1" },
    { providerId: "prov-c", model: "backup-2" },
  ],
  // A half-filled row (the picker was opened but no model chosen yet) cannot be
  // routed, so it must not travel as "prov-d/".
  vision: [{ providerId: "prov-d", model: "" }],
  // The "Other" row writes one list under every group key.
  compact: [{ providerId: "prov-e", model: "side-model" }],
  web: [{ providerId: "prov-e", model: "side-model" }],
  title: [{ providerId: "prov-e", model: "side-model" }],
};
check("every tool slot can carry a fallback list", TOOL_FALLBACK_SLOTS.includes("explore"));
check(
  // Four Tools ROWS: explore / vision / schedule / "Other", the last of which
  // writes its one list under all three of its keys — exactly like the row.
  "the fallback slots mirror the four Tools rows",
  TOOL_FALLBACK_SLOTS.length === 3 + OTHER_SLOTS.length &&
    (["explore", "vision", "schedule"] as const).every((s) => TOOL_FALLBACK_SLOTS.includes(s)) &&
    OTHER_SLOTS.every((s) => TOOL_FALLBACK_SLOTS.includes(s)),
  TOOL_FALLBACK_SLOTS,
);
const wire = toolFallbackEntries(slots);
check(
  "the arranged order is the wire order",
  JSON.stringify(wire.explore) === JSON.stringify(["prov-b/backup-1", "prov-c/backup-2"]),
  wire.explore,
);
check("a half-filled row is not sent", wire.vision === undefined && !("vision" in wire));
check("the Other group is sent under its own key", wire.compact?.[0] === "prov-e/side-model");
check(
  // The "Other" row is ONE list for three consumers, so each of them reads its
  // own key — all three must travel, or the title/compactor/distiller would
  // each disagree with the row.
  "the Other group's list travels under every key it owns",
  OTHER_SLOTS.every((k) => wire[k]?.[0] === "prov-e/side-model"),
  wire,
);
check("slots with no list are omitted entirely", !("schedule" in wire), Object.keys(wire));
check(
  "a bare model id (no provider) is dropped from the wire",
  Object.keys(toolFallbackEntries({ explore: [{ providerId: "p", model: "m" }] })).length === 1 &&
    Object.keys(toolFallbackEntries({ explore: [{ providerId: "", model: "m" }] })).length === 0,
);
check("no map means no entries", Object.keys(toolFallbackEntries(undefined)).length === 0);
check(
  "the Other row shows the group's first non-empty list",
  otherSlotFallbacks(slots)?.length === 1 && otherSlotFallbacks(slots)?.[0].providerId === "prov-e",
);
check("the Other row has no list when nothing is set", otherSlotFallbacks({})?.length === 0);
check("the Other row has no list for undefined", otherSlotFallbacks(undefined)?.length === 0);

// ---- one list: the tool's own model IS row 1 -------------------------------

const chain = toolChainRows("prov-a/own-model", [
  { providerId: "prov-b", model: "backup-1" },
  { providerId: "", model: "" },
]);
check(
  "row 1 is the tool's own model",
  chain[0].providerId === "prov-a" && chain[0].model === "own-model",
  chain[0],
);
check("a tool's list always has at least one row", chain.length === 3);

const moved = moveFallback(chain, 0, 1);
check(
  "row 1 can be moved down like any other rung",
  moved[0].providerId === "prov-b" && moved[1].model === "own-model",
  moved,
);
check("a move keeps the row count", moved.length === chain.length);
check(
  "a move past the end is a no-op",
  moveFallback(chain, 0, -1) === chain && moveFallback(chain, 2, 1) === chain,
);

const split = toolChainSet(moved);
check(
  "whatever lands in row 1 becomes the tool's model",
  split.own === "prov-b/backup-1",
  split.own,
);
check(
  "the rows below row 1 are the fallback list",
  split.fallbacks.length === 2 && split.fallbacks[0].model === "own-model",
  split.fallbacks,
);

const round = toolChainSet(
  toolChainRows("prov-a/own-model", [{ providerId: "prov-b", model: "b" }]),
);
check(
  "settings → list → settings is lossless",
  round.own === "prov-a/own-model" &&
    round.fallbacks.length === 1 &&
    round.fallbacks[0].providerId === "prov-b",
  round,
);

check(
  "a bare model id keeps the provider resolved at call time",
  toolChainSet(toolChainRows("own-model", [])).own === "own-model",
  toolChainSet(toolChainRows("own-model", [])),
);

const inheriting = toolChainRows("", []);
check(
  "a tool on the composer's model still shows one row",
  inheriting.length === 1 && toolFallbackToModel(inheriting[0]) === "",
  inheriting,
);

check(
  "a half-filled row shows its provider so the picker can finish it",
  toolFallbackValue({ providerId: "prov-b", model: "" }) === "prov-b/",
  toolFallbackValue({ providerId: "prov-b", model: "" }),
);

const withMain = toolFallbackEntries({
  explore: [
    { providerId: "", model: "" },
    { providerId: "prov-b", model: "backup" },
  ],
});
check(
  "a main-model rung travels by name, in its place in the order",
  JSON.stringify(withMain.explore) ===
    JSON.stringify(["main model", "prov-b/backup"]),
  withMain.explore,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll toolSlots tests passed");
