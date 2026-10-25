// argv for the in-app Neovim target (src/lib/nvimEdit.ts).
// The line flag is the whole contract: `+N` parks the cursor on N, and `+0`
// means "last line" to nvim, so a missing/zero/negative line must be dropped
// rather than passed through.
import { NVIM_PROGRAM, findOpenRunTarget, nvimArgs, runTargetKey } from "../src/lib/nvimEdit.ts";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

check("the program is a bare nvim (resolved on PATH backend-side)", NVIM_PROGRAM === "nvim", NVIM_PROGRAM);

console.log("1) a line becomes a +N flag before the path:");
{
  const args = nvimArgs("/w/src/a.ts", 12);
  check("line passed first", JSON.stringify(args) === JSON.stringify(["+12", "/w/src/a.ts"]), args);
  check("line 1 is kept", JSON.stringify(nvimArgs("/w/a.ts", 1)) === JSON.stringify(["+1", "/w/a.ts"]));
  check("a fractional line is floored", JSON.stringify(nvimArgs("/w/a.ts", 7.9)) === JSON.stringify(["+7", "/w/a.ts"]));
}

console.log("2) no usable line -> just the path (never +0):");
{
  check("undefined", JSON.stringify(nvimArgs("/w/a.ts")) === JSON.stringify(["/w/a.ts"]));
  check("zero", JSON.stringify(nvimArgs("/w/a.ts", 0)) === JSON.stringify(["/w/a.ts"]));
  check("negative", JSON.stringify(nvimArgs("/w/a.ts", -3)) === JSON.stringify(["/w/a.ts"]));
  check("NaN", JSON.stringify(nvimArgs("/w/a.ts", Number.NaN)) === JSON.stringify(["/w/a.ts"]));
}

console.log("3) paths are passed verbatim (no shell quoting: argv, not a command line):");
{
  const tricky = "/w/my dir/a'b$(x).ts";
  check("kept as one arg", JSON.stringify(nvimArgs(tricky)) === JSON.stringify([tricky]), nvimArgs(tricky));
  check("padding is trimmed", JSON.stringify(nvimArgs("  /w/a.ts  ")) === JSON.stringify(["/w/a.ts"]));
}

console.log("4) re-requesting the same target reuses the open tab (never a 2nd editor):");
{
  const tabs = [
    { id: "t1", argv: ["nvim", "+12", "/w/a.ts"] },
    { id: "t2", argv: ["nvim", "+9", "/w/b.ts"] },
    { id: "shell" },
  ];
  check("same argv finds its tab", findOpenRunTarget(tabs, ["nvim", "+12", "/w/a.ts"])?.id === "t1");
  check("other line is a different target", findOpenRunTarget(tabs, ["nvim", "+1", "/w/a.ts"]) === null);
  check("other file is a different target", findOpenRunTarget(tabs, ["nvim", "+12", "/w/b.ts"]) === null);
  check("a shell tab is never a match", findOpenRunTarget(tabs, ["nvim"]) === null);
  check("an empty list matches nothing", findOpenRunTarget(tabs, []) === null);
  // A space in one path must not FORGE a match with a two-arg request: joining
  // the argv with spaces (the tooltip form) would make these look identical.
  const spaced = [{ id: "s", argv: ["nvim", "/w/my dir/a.ts"] }];
  check("spaces cannot forge a match", findOpenRunTarget(spaced, ["nvim", "/w/my", "dir/a.ts"]) === null);
  check("NUL-joins parts", runTargetKey(["a", "b"]) === "a\u0000b");
}

if (failed > 0) {
  console.error(`\nnvimEdit: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nnvimEdit: all checks passed");
