// تست واحد برای aggregateTurnStats و diffStatsFromUnified:
// جمع +N -M چند فایل (مثل oc.config.toml +2 -0 و openai.config.toml +4 -0)
// باید به +N -M سطح ترن تجمیع شود.
// اجرا: npx esbuild tests/reviewStats.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-reviewStats.mjs \
//        && node tests/.tmp-reviewStats.mjs

import type { ToolActivity } from "../src/types"
import { aggregateTurnStats, diffStatsFromUnified } from "../src/lib/toolActivity"
import { buildReviewTurn, isReviewablePath } from "../src/lib/reviewTurn"

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

console.log('۸) per-file diffs: هر فایلِ یک فراخوانی چندفایلی به مسیر خودش کتاب می‌شود:')
{
  // One edit_file call naming a DIFFERENT file per entry — the backend emits
  // one diff event per touched file, folded into `diffs`. Booking the whole
  // aggregate under the first path (the old behavior) misattributed every
  // later file's +N/-M in the Review panel.
  const perFile = [
    { path: 'a.ts', diff: diffOc },          // +2 -0
    { path: 'b.ts', diff: diffOpenai },      // +4 -0
  ]
  const call: ToolActivity =
    ({ tool: "edit_file", args: { edits: perFile.map((e) => ({ path: e.path })) }, diffs: perFile, diff: perFile.map((e) => e.diff).join(""), status: "done" }) as any

  const t = aggregateTurnStats([call])
  check('aggregateTurnStats sums per file: +6', t.adds === 6, t)

  const turn = buildReviewTurn('m', [call], '/p')
  check('two review rows, one per file', turn?.files.length === 2, turn?.files)
  check('a.ts carries only its own +2', turn?.files[0]?.path === 'a.ts' && turn?.files[0]?.adds === 2, turn?.files[0])
  check('b.ts carries only its own +4', turn?.files[1]?.path === 'b.ts' && turn?.files[1]?.adds === 4, turn?.files[1])
  check('header totals match the rows', turn?.adds === 6 && turn?.dels === 0, turn)

  // A file outside the workspace is dropped by path — not the whole call,
  // which the old first-target filter would have done.
  const withOutside = [
    { path: 'a.ts', diff: diffOc },
    { path: '/tmp/other.py', diff: diffOpenai },
  ]
  const call2: ToolActivity =
    ({ tool: "edit_file", args: { edits: withOutside.map((e) => ({ path: e.path })) }, diffs: withOutside, diff: withOutside.map((e) => e.diff).join(""), status: "done" }) as any
  const turn2 = buildReviewTurn('m', [call2], '/p')
  check('outside file dropped per path', turn2?.files.length === 1 && turn2.files[0].path === 'a.ts', turn2?.files)
  check('kept file keeps its stats', turn2?.adds === 2, turn2)

  // Cards without `diffs` (older transcripts) keep the aggregate attribution.
  const legacyCard: ToolActivity =
    ({ tool: "edit_file", args: { path: 'a.ts' }, diff: diffOc, status: "done" }) as any
  const turn3 = buildReviewTurn('m', [legacyCard], '/p')
  check('legacy aggregate card still lists', turn3?.files.length === 1 && turn3.files[0].adds === 2, turn3)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log('\nهمه‌ی تست‌ها سبز شدند')
}
