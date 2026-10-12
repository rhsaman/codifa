// Contract: history popup rows send directly via submit (no setInput-only path).
// Click / Enter / Tab on a history row must call submit(row), so picking a
// past prompt re-sends it instead of only filling the composer.
// Run: npx esbuild tests/historySubmit.test.ts --bundle --platform=node
//        --format=esm --packages=external --external:electron
//        --outfile=tests/.tmp-history-submit.mjs && node tests/.tmp-history-submit.mjs
import fs from "node:fs";

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

const src = fs.readFileSync("src/components/Chat.tsx", "utf8");

// Enter/Tab on a history row sends the picked row directly.
check(
  "history Enter/Tab calls submit(picked)",
  /const picked = rows\[historyIdx\] \?\? rows\[0\];\s*setHistoryOpen\(false\);\s*submit\(picked\);/.test(
    src,
  ),
);

// Click insert sends the row directly (no setInput-only insert path).
check(
  "history insert calls submit(row)",
  /const insert = \(row: string\) => \{\s*setHistoryOpen\(false\);\s*submit\(row\);\s*\};/.test(
    src,
  ),
);

// No leftover setInput-only insert path for history rows.
check(
  "no setInput(picked) history path remains",
  !src.includes("setInput(picked)"),
);

// ArrowDown on the bottom-most row exits history: closes popup + clears input.
check(
  "history ArrowDown past bottom closes and clears",
  /if \(d > 0 && historyIdx >= rows\.length - 1\)[\s\S]*?setHistoryOpen\(false\);\s*setInput\(""\)/.test(
    src,
  ),
);

// Hint reflects send (not insert).
check("history hint says Enter send", src.includes("Enter send"));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll history submit checks passed");
process.exit(0);
