// Unit tests for shouldExpandComposer (run: node tests/composerLayout.test.ts)
import {
  compactInputWidth,
  composerHeight,
  shouldExpandComposer,
} from "../src/lib/composerLayout.ts";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("composer expanded state:");
{
  // Single short line fits: stays compact.
  check("short text stays compact", shouldExpandComposer("hello", 32, 32) === false);
  // Explicit newline always expands, even when heights are equal.
  check("newline expands", shouldExpandComposer("a\nb", 32, 32) === true);
  // Trailing newline expands too (scrollHeight may not grow for it).
  check("trailing newline expands", shouldExpandComposer("hello\n", 32, 32) === true);
  // Long wrapped text (scrollHeight grows past one line) expands.
  check("wrapped text expands", shouldExpandComposer("long ".repeat(40), 64, 32) === true);
  // Tiny height jitter within tolerance stays compact.
  check("jitter stays compact", shouldExpandComposer("hello", 35, 32) === false);
  // Hysteresis band: borderline height sticks to the current mode instead of
  // bouncing up and down while typing.
  check("borderline expands from compact", shouldExpandComposer("hello", 37, 32, false) === true);
  check("borderline sticks when expanded", shouldExpandComposer("hello", 35, 32, true) === true);
  check("clearly single line collapses", shouldExpandComposer("hello", 33, 32, true) === false);
  // Empty draft stays compact.
  check("empty stays compact", shouldExpandComposer("", 32, 32) === false);
}

console.log("composer compact width:");
{
  // Uses fixed compact metrics, independent of the live row style.
  check(
    "subtracts actions and gaps",
    compactInputWidth(560, 60, 70) === 560 - 16 - 60 - 70 - 8,
    compactInputWidth(560, 60, 70),
  );
  check("clamps to minimum", compactInputWidth(100, 60, 70) === 80);
}

console.log("composer height:");
{
  // Below the cap: no scrollbar.
  const short = composerHeight(64);
  check("short content hides scrollbar", short.height === 64 && short.overflowY === "hidden", short);
  // At the cap: still no scrollbar.
  const capped = composerHeight(200);
  check("capped content hides scrollbar", capped.height === 200 && capped.overflowY === "hidden", capped);
  // Past the cap: height clamps and scrollbar appears.
  const tall = composerHeight(320);
  check("tall content shows scrollbar", tall.height === 200 && tall.overflowY === "auto", tall);
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll composer layout tests passed");
