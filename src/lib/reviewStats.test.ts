// تست واحد برای aggregateTurnStats و diffStatsFromUnified:
// جمع +N -M چند فایل (مثل oc.config.toml +2 -0 و openai.config.toml +4 -0)
// باید به +N -M سطح ترن تجمیع شود.
// اجرا: npx esbuild src/lib/reviewStats.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-reviewStats.mjs \
//        && node src/lib/.tmp-reviewStats.mjs

import type { ToolActivity } from "../types"
import { aggregateTurnStats, diffStatsFromUnified } from "./toolActivity"
import { buildReviewTurn, isReviewablePath } from "./reviewTurn"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// یک unified diff نمونه با ۲ افزودن و ۰ حذف (مثل oc.config.toml).
const diffOc = [
  "--- a/oc.config.toml",
  "+++ b/oc.config.toml",
  "@@ -1,1 +1,3 @@",
  ' model_provider = "openai"',
  '+# کامنت',
  '+model = "gpt-6-sol"',
].join("\n")

// یک unified diff نمونه با ۴ افزودن و ۰ حذف (مثل openai.config.toml).
const diffOpenai = [
  "--- a/openai.config.toml",
  "+++ b/openai.config.toml",
  "@@ -0,0 +1,4 @@",
  '+a = "1"',
  '+b = "2"',
  '+c = "3"',
  '+d = "4"',
].join("\n")

console.log('۱) diffStatsFromUnified روی یک فایل:')
{
  const s = diffStatsFromUnified(diffOc)
  check('adds = 2', s.adds === 2, s)
  check('dels = 0', s.dels === 0, s)
}

console.log('۲) diffStatsFromUnified خطوط +++/--- را نمی‌شمارد:')
{
  const s = diffStatsFromUnified(diffOpenai)
  check('adds = 4', s.adds === 4, s)
  check('dels = 0', s.dels === 0, s)
}

console.log('۳) aggregateTurnStats جمع چند فایل را به +10 -0 می‌رساند:')
{
  const mk = (path: string, diff: string): ToolActivity =>
    ({ tool: "edit_file", args: { path }, diff, status: "done" }) as any
  const acts: ToolActivity[] = [mk("oc.config.toml", diffOc), mk("openai.config.toml", diffOpenai)]
  const t = aggregateTurnStats(acts)
  check('adds = 6', t.adds === 6, t)
  check('dels = 0', t.dels === 0, t)
}

console.log('۴) aggregateTurnStats فعالیت‌های بدون diff را نادیده می‌گیرد:')
{
  const acts: ToolActivity[] = [
    ({ tool: "grep", args: {}, status: "done" }) as any,
    ({ tool: "edit_file", args: { path: "x" }, diff: diffOc, status: "done" }) as any,
  ]
  const t = aggregateTurnStats(acts)
  check('adds = 2', t.adds === 2, t)
}

console.log('۵) aggregateTurnStats داخل children را هم می‌خواند:')
{
  const child: ToolActivity = ({ tool: "write_file", args: { path: "y" }, diff: diffOpenai, status: "done" }) as any
  const parent: ToolActivity = ({ tool: "explore", args: {}, status: "done", children: [child] }) as any
  const t = aggregateTurnStats([parent])
  check('adds = 4', t.adds === 4, t)
}

console.log('۶) ویرایش بیرون ورک‌اسپیس از پنل Review حذف می‌شود:')
{
  const root = '/Users/u/proj'
  check('absolute inside root', isReviewablePath(root, '/Users/u/proj/src/a.ts'))
  check('relative is always in', isReviewablePath(root, 'src/a.ts'))
  check('trailing slash on root still matches', isReviewablePath('/Users/u/proj/', '/Users/u/proj/a.ts'))
  check('outside root is OUT', !isReviewablePath(root, '/tmp/split_tests.py'))
  check('sibling prefix is not "inside"', !isReviewablePath(root, '/Users/u/proj-two/a.ts'))
  check('home script is OUT', !isReviewablePath(root, '/Users/u/local-models-server/stt.py'))

  const mk = (path: string, diff: string): ToolActivity =>
    ({ tool: "edit_file", args: { path }, diff, status: "done" }) as any
  const inside = mk('src/a.ts', diffOc)
  const outside = mk('/tmp/split_tests.py', diffOpenai)

  const turn = buildReviewTurn('m', [inside, outside], root)
  check('only the workspace file is listed', turn?.files.length === 1, turn?.files)
  check('it is the inside one', turn?.files[0]?.path === 'src/a.ts', turn?.files[0])
  // The header total must match the list, or it advertises files that are not shown.
  check('totals exclude the outside edit', turn?.adds === 2 && turn?.dels === 0, turn)

  const onlyOutside = buildReviewTurn('m', [outside], root)
  check('a turn of only-outside edits has no review', onlyOutside === null, onlyOutside)

  // No root known (first paint, split panel): nothing absolute can be proven
  // inside, so relative paths still list and absolute ones wait.
  const noRoot = buildReviewTurn('m', [inside, outside], undefined)
  check('without a root, relative still lists', noRoot?.files.length === 1, noRoot?.files)
}

console.log('۷) buildReviewTurn: net diff of the turn replaces the sum of every edit:')
{
  const mkN = (path: string, diff: string, turnDiff?: string): ToolActivity =>
    ({ tool: "edit_file", args: { path }, diff, turnDiff, status: "done" }) as any
  const ab = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n")
  const bc = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-b", "+c"].join("\n")
  const ac = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-a", "+c"].join("\n")
  const ba = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-b", "+a"].join("\n")

  // a -> b, then b -> c: summed that is +2 -2, but git sees one line a -> c.
  const two = buildReviewTurn('m', [mkN('x.ts', ab, ab), mkN('x.ts', bc, ac)], '/p')
  check('one row for the file', two?.files.length === 1, two?.files)
  check('net is +1 -1, not +2 -2', two?.adds === 1 && two?.dels === 1, two)
  check('row shows the net diff', two?.files[0]?.diff === ac, two?.files[0])
  check('row counts match the header', two?.files[0]?.adds === 1 && two?.files[0]?.dels === 1, two?.files[0])

  // a -> b, then b -> a: nothing changed overall, so nothing to review.
  const undone = buildReviewTurn('m', [mkN('y.ts', ab, ab), mkN('y.ts', ba, "")], '/p')
  check('edits that cancel out leave no review', undone === null, undone)

  // An undone file must not hide another file that really changed.
  const mixed = buildReviewTurn('m', [mkN('y.ts', ab, ab), mkN('y.ts', ba, ""), mkN('z.ts', ab, ab)], '/p')
  check('only the really-changed file is listed', mixed?.files.length === 1 && mixed.files[0].path === 'z.ts', mixed?.files)
  check('totals follow the listed files', mixed?.adds === 1 && mixed?.dels === 1, mixed)

  // Older transcripts carry no turnDiff: keep the old per-edit sum.
  const legacy = buildReviewTurn('m', [mkN('x.ts', ab), mkN('x.ts', bc)], '/p')
  check('without a net diff the edits are summed', legacy?.adds === 2 && legacy?.dels === 2, legacy)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log('\nهمه‌ی تست‌ها سبز شدند')
}
