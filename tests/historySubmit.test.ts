// Contract: history popup rows are KEYBOARD-ONLY. Enter/Tab send the picked
// row via submit; the mouse has NO effect on the rows — no hover fill, no
// click-to-send (a stray hover used to overwrite the draft and a click fired
// the prompt). Only the pin button stays mouse-operable.
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

// The mouse insert path is gone: no `insert` closure, no mouse handlers on
// the history rows.
check(
  "history rows are keyboard-only (no mouse insert path)",
  !src.includes("const insert = (row: string)") &&
    !/onMouseEnter=\{\(\) => \{\s*setHistoryIdx\(i\);/.test(src) &&
    !/onMouseDown=\{\(e\) => \{\s*e\.preventDefault\(\);\s*insert\(row\);/.test(src),
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
