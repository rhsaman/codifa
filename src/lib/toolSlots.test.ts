// Unit tests for the Tools → "Other" model group resolution.
// Run: npx esbuild src/lib/toolSlots.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/toolSlots.test.mjs && node /tmp/toolSlots.test.mjs
import {
  OTHER_SLOTS,
  isMainModelEntry,
  otherSlotLevel,
  otherSlotModel,
  withOtherSlotsFilled,
} from "./toolSlots";
import type { ThinkingLevel } from "../types";

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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll toolSlots tests passed");
