// Unit tests for the Tauri drag-drop path bridge: multi-file drops must
// resolve EVERY dropped File to its own absolute path — unique names directly,
// same-basename occurrences in drop order, and each new drop replacing the
// previous record (a later same-named drag must never reuse the old path).
// Run: npx esbuild tests/fileDragBridge.test.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=tests/.tmp-fileDragBridge.mjs && node tests/.tmp-fileDragBridge.mjs
import { pathForDroppedFile, recordDroppedPaths } from "../src/lib/tauriBridge";

export {};

const file = (name: string) => ({ name }) as File;

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("drag-drop path bridge:");
{
  recordDroppedPaths([
    { name: "a.png", path: "/tmp/x/a.png" },
    { name: "notes.pdf", path: "/tmp/x/notes.pdf" },
  ]);
  check("unique name resolves to its own path", pathForDroppedFile(file("a.png")) === "/tmp/x/a.png");
  check("second unique name resolves too", pathForDroppedFile(file("notes.pdf")) === "/tmp/x/notes.pdf");
  check("unknown name resolves empty", pathForDroppedFile(file("nope.txt")) === "");

  // Two files with the SAME basename dropped together: occurrences hand out in
  // drop order (the DOM handler walks dataTransfer.files in Finder order).
  recordDroppedPaths([
    { name: "report.pdf", path: "/dl/a/report.pdf" },
    { name: "report.pdf", path: "/dl/b/report.pdf" },
    { name: "chart.png", path: "/dl/a/chart.png" },
  ]);
  check("same-name drop #1 → first occurrence", pathForDroppedFile(file("report.pdf")) === "/dl/a/report.pdf");
  check("same-name drop #2 → second occurrence", pathForDroppedFile(file("report.pdf")) === "/dl/b/report.pdf");
  check("other name unaffected between collisions", pathForDroppedFile(file("chart.png")) === "/dl/a/chart.png");

  // A NEW drop resets the record: re-dropping a common name must resolve to
  // the new path, not leak the previous drop's mapping.
  recordDroppedPaths([{ name: "report.pdf", path: "/dl/c/report.pdf" }]);
  check("new drop replaces old same-name mapping", pathForDroppedFile(file("report.pdf")) === "/dl/c/report.pdf");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll drag-drop bridge checks passed");
