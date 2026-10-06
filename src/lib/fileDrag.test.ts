// Unit tests for file-drag detection (run: node tests/fileDrag.test.ts via esbuild).
// Run: npx esbuild src/lib/fileDrag.test.ts --bundle --platform=node --format=esm --outfile=/tmp/fileDrag.test.mjs && node /tmp/fileDrag.test.mjs
import { hasFileDrop, isFileDrag } from "./fileDrag";

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

console.log("file drag detection:");
{
  check("Files type is a file drag", isFileDrag(["Files"]));
  check("Files among others is a file drag", isFileDrag(["text/plain", "Files"]));
  check("chat mime is not a file drag", !isFileDrag(["application/x-coder-chat-id"]));
  check("plain text is not a file drag", !isFileDrag(["text/plain"]));
  check("empty types is not a file drag", !isFileDrag([]));
  check("missing types is not a file drag", !isFileDrag(undefined));
  check("non-empty file list is a drop", hasFileDrop({ length: 1 }));
  check("empty file list is not a drop", !hasFileDrop({ length: 0 }));
  check("missing files is not a drop", !hasFileDrop(undefined));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll file drag checks passed");
