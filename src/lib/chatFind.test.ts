// Unit tests for the find-in-chat core (src/lib/chatFind.ts).
//
// The pure core (runs, matching, index stepping, block classification and the
// paint-owner claim) is plain-node testable with stub text nodes — the DOM
// layer (TreeWalker/Range/CSS.highlights) stays out of these checks on
// purpose, same convention as panePointer/inputSuppress tests.
import {
  findMatches,
  findRunMatches,
  isBlockTag,
  makeRun,
  onFindPaintOwner,
  claimFindPaint,
  releaseFindPaint,
  currentFindOwner,
  stepMatch,
  type FindSeg,
} from "./chatFind";

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

/** A stub standing in for a DOM Text node: only identity matters to the
 *  matching core; `data` mirrors the segment text. */
function seg(text: string): FindSeg {
  return { node: { data: text }, text };
}

function runOf(...texts: string[]) {
  return makeRun(texts.map(seg));
}

/** The match text each result points at (offset sanity in one). */
function texts(runs: ReturnType<typeof findMatches>) {
  return runs.map((m) => m.run.text.slice(m.start, m.start + m.length));
}

console.log("1) single-run matching — case folding and occurrences:");
{
  const run = runOf("Hello hello HELLO world");
  check(
    "case-insensitive finds all three (original case preserved)",
    texts(findMatches([run], "hello", false))
      .map((t) => t.toLowerCase())
      .join("|") === "hello|hello|hello",
    texts(findMatches([run], "hello", false)),
  );
  check(
    "match-case finds exactly one",
    findMatches([run], "hello", true).length === 1,
  );
  check(
    "offsets are non-overlapping and ordered",
    (() => {
      const ms = findMatches([run], "hello", false);
      return (
        ms[0].start === 0 && ms[1].start === 6 && ms[2].start === 12 && ms[1].start > ms[0].start
      );
    })(),
  );
  check("empty query matches nothing", findMatches([run], "", false).length === 0);
  check(
    "no match -> empty",
    findMatches([runOf("nothing here")], "zzz", false).length === 0,
  );
}

console.log("2) runs are matched independently (block granularity):");
{
  // "one" and "two" live in separate blocks; a query spanning them must NOT
  // match across the boundary even though the concatenation would.
  const a = runOf("one ");
  const b = runOf("two");
  check(
    "no cross-run match",
    findMatches([a, b], "one two", false).length === 0,
  );
  check(
    "each run matches on its own",
    findMatches([a, b], "two", false).length === 1 &&
      findMatches([a, b], "one", false).length === 1,
  );
  // Segments within one run are flattened, so inline boundaries disappear:
  const flat = runOf("hello ", "world");
  check(
    "segments flatten inside a run (hello **world**)",
    texts(findMatches([flat], "hello world", false)).join("") === "hello world",
    texts(findMatches([flat], "hello world", false)),
  );
}

console.log("3) match cap:");
{
  const run = runOf("ab ".repeat(100));
  check("cap stops the scan", findMatches([run], "ab", false, 7).length === 7);
  const many = Array.from({ length: 5 }, () => runOf("x"));
  check("cap spans runs", findMatches(many, "x", false, 3).length === 3);
}

console.log("4) stepMatch wrap-around:");
{
  check("first from -1 goes to 0", stepMatch(-1, 1, 3) === 0);
  check("last wraps to 0", stepMatch(2, 1, 3) === 0);
  check("first wraps back to last", stepMatch(0, -1, 3) === 2);
  check("middle steps", stepMatch(1, 1, 3) === 2 && stepMatch(1, -1, 3) === 0);
  check("no matches -> -1", stepMatch(0, 1, 0) === -1);
  check("count 1 stays", stepMatch(0, 1, 1) === 0 && stepMatch(0, -1, 1) === 0);
  check("stale high index clamps", stepMatch(9, 1, 3) === 1);
}

console.log("5) block classification:");
{
  check("p is block", isBlockTag("P"));
  check("pre is block", isBlockTag("pre"));
  check("li is block", isBlockTag("li"));
  check("strong is inline", !isBlockTag("strong"));
  check("code is inline", !isBlockTag("code"));
  check("span is inline", !isBlockTag("span"));
  check("a is inline", !isBlockTag("A"));
}

console.log("6) findRunMatches budget:");
{
  const run = runOf("x x x x");
  check("budget respected", findRunMatches(run, "x", false, 2).length === 2);
  check(
    "findMatches spreads budget over runs",
    findMatches([run, runOf("x")], "x", false, 3).length === 3,
  );
}

console.log("7) paint-owner claim (document-global, one bar at a time):");
{
  const seen: Array<symbol | null> = [];
  const off = onFindPaintOwner((t) => seen.push(t));
  const a = Symbol("a");
  const b = Symbol("b");
  claimFindPaint(a);
  check("claim notifies", currentFindOwner() === a && seen[seen.length - 1] === a);
  claimFindPaint(b);
  check("second claim takes over", currentFindOwner() === b);
  releaseFindPaint(a);
  check("stale release is a no-op", currentFindOwner() === b);
  releaseFindPaint(b);
  check("owner release clears", currentFindOwner() === null && seen[seen.length - 1] === null);
  off();
  claimFindPaint(a);
  releaseFindPaint(a);
  check("unsubscribed listener sees nothing", seen.length === 3);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chatFind checks passed");
