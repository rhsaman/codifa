// A writer call may carry a WHOLE FAMILY: `edit_file` as
// edits:[{path, old_string, new_string}], `write_file` as files:[{path, content}].
// The backend emits one `diff` event per touched file and `toolActivity` keeps
// them in `diffs`, but the card used to render the whole call as ONE row naming
// the first file and hiding the rest behind a "+N more" pill — so a grouped
// edit read like a one-file edit and the other files' diffs were unreachable
// from the card. These checks run the REAL row builder the card uses.
// Run: npx esbuild tests/toolEditGroupRows.test.ts --bundle --platform=node --format=esm --outfile=tests/.tmp-editrows.mjs && node tests/.tmp-editrows.mjs

import { editFileRows } from "../src/components/toolcall/naming"
import type { ToolActivity } from "../src/types"

/** A minimal writer activity: the row builder reads only these fields. */
function activity(fields: Partial<ToolActivity>): ToolActivity {
  return {
    id: "t1",
    tool: "edit_file",
    status: "done",
    args: { path: "a.ts" },
    ...fields,
  } as ToolActivity
}

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}
function eq<T>(got: T, want: T, what: string) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
}

console.log("edit group rows:")

check("a multi-file call yields ONE ROW PER FILE", () => {
  const rows = editFileRows(
    activity({
      diffs: [
        { path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "b.ts", diff: "@@ -1 +1 @@\n-c\n+d" },
      ],
    }),
  )
  eq(rows.map((r) => r.path), ["a.ts", "b.ts"], "paths")
})

check("each row carries ITS OWN diff and stats, not the aggregate", () => {
  const rows = editFileRows(
    activity({
      diff: "@@ -1 +1 @@\n-a\n+b",
      diffStats: { adds: 99, dels: 99 },
      diffs: [
        { path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "b.ts", diff: "@@ -1,2 +1,2 @@\n-c\n-d\n+e\n+f" },
      ],
    }),
  )
  if (rows[0].diff === rows[1].diff) throw new Error("both rows show the same diff")
  eq([rows[0].adds, rows[0].dels], [1, 1], "a.ts stats")
  eq([rows[1].adds, rows[1].dels], [2, 2], "b.ts stats")
})

check("a single-file call keeps the call's own diffStats", () => {
  const rows = editFileRows(
    activity({ diff: "@@ -1 +1 @@\n-a\n+b", diffStats: { adds: 9, dels: 4 } }),
  )
  eq(rows.length, 1, "row count")
  eq([rows[0].adds, rows[0].dels], [9, 4], "aggregate stats kept")
})

check("a one-entry diffs[] is NOT treated as multi-file", () => {
  const rows = editFileRows(
    activity({
      diff: "@@ -1 +1 @@\n-a\n+b",
      diffs: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }],
    }),
  )
  eq(rows.length, 1, "row count")
})

check("a call with no diff still yields one row (name only)", () => {
  const rows = editFileRows(activity({}))
  eq(rows.length, 1, "row count")
  eq([rows[0].adds, rows[0].dels], [0, 0], "no stats")
})

check("the row path comes from the call's args when diffs are absent", () => {
  const rows = editFileRows(activity({ args: { path: "src/deep/x.ts" } }))
  eq(rows[0].path, "src/deep/x.ts", "path from args")
})

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall edit-group row checks passed")
