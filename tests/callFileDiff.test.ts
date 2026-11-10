// تست واحد برای ingest دیفِ per-file:
// بک‌اند به‌ازای هر فایلی که یک فراخوانی write/edit نام می‌برد یک ایونت diff
// می‌فرستد (فراخوانی batch ممکن است فایل متفاوت در هر entry داشته باشد). کارت
// باید همه را با کلید path نگه دارد، aggregate را بازمحاسبه کند و ایونت تکراری
// (پخش مجدد استریم) را کپی نکند.
// اجرا: npx esbuild tests/callFileDiff.test.ts --bundle --platform=node \
//        --format=esm --outfile=tests/.tmp-callFileDiff.mjs \
//        && node tests/.tmp-callFileDiff.mjs

import type { ToolActivity } from "../src/types"
import { editTargetOf, editTargetsOf, upsertCallFileDiff } from "../src/lib/toolActivity"

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

console.log('۱) editTargetsOf همهٔ فایل‌های نام‌برده را به‌ترتیب و یکتا می‌دهد:')
{
  check('top-level path', JSON.stringify(editTargetsOf({ path: 'a.ts' })) === '["a.ts"]')
  check(
    'files[] batch, two files',
    JSON.stringify(editTargetsOf({ files: [{ path: 'a.ts', content: '1' }, { path: 'b.ts', content: '2' }] })) ===
      '["a.ts","b.ts"]',
  )
  check(
    'edits[] batch dedupes repeats',
    JSON.stringify(editTargetsOf({ edits: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'a.ts' }] })) ===
      '["a.ts","b.ts"]',
  )
  check(
    'blank/absent paths skipped',
    JSON.stringify(editTargetsOf({ files: [{ path: '' }, { content: 'x' }, { path: 'a.ts' }] })) === '["a.ts"]',
  )
  check('no args at all', JSON.stringify(editTargetsOf(undefined)) === '[]')
  // The FIRST target stays what editTargetOf answers — the two helpers agree.
  check(
    'editTargetOf = first of editTargetsOf',
    editTargetOf({ edits: [{ path: 'b.ts' }, { path: 'a.ts' }] }) === 'b.ts',
  )
}

console.log('۲) upsertCallFileDiff: ایونت دوم فایل، تغییر اول را جایگزین نمی‌کند:')
{
  const card: ToolActivity = ({ tool: "write_file", args: { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }, status: "running" }) as any
  const afterA = upsertCallFileDiff(card, 'a.ts', '--- a/a.ts\n+++ b/a.ts\n@@\n+x\n')
  check('first diff lands on the card', afterA.diff?.includes('+x') === true, afterA)
  const afterB = upsertCallFileDiff(afterA, 'b.ts', '--- a/b.ts\n+++ b/b.ts\n@@\n+y\n')
  check('second diff EXTENDS the aggregate', afterB.diff?.includes('+x') && afterB.diff?.includes('+y'), afterB)
  check('diffStats recomputed from both', afterB.diffStats?.adds === 2, afterB.diffStats)
  check('both per-file entries kept', afterB.diffs?.length === 2, afterB.diffs)
  check('original card untouched (pure)', card.diffs === undefined && card.diff === undefined)
}

console.log('۳) upsertCallFileDiff: ایونت تکراری (پخش مجدد) کپی نمی‌شود:')
{
  const d = '--- a/a.ts\n+++ b/a.ts\n@@\n+x\n'
  const card: ToolActivity = ({ tool: "edit_file", args: { path: 'a.ts' }, status: "running" }) as any
  const once = upsertCallFileDiff(card, 'a.ts', d)
  const twice = upsertCallFileDiff(once, 'a.ts', d)
  check('same event twice = same object', twice === once, twice.diffs)
  check('aggregate not doubled', twice.diffStats?.adds === 1, twice.diffStats)
}

console.log('۴) turn_diff per file: net هر فایل جدا جمع می‌شود:')
{
  const card: ToolActivity = ({ tool: "edit_file", args: { edits: [{ path: 'a.ts' }] }, status: "running" }) as any
  const netA = '--- a/a.ts\n+++ b/a.ts\n@@\n+netA\n'
  const netB = '--- a/b.ts\n+++ b/b.ts\n@@\n+netB\n'
  // Sequence: turn_diff(a) -> diff(a) -> turn_diff(b) -> diff(b).
  let c = upsertCallFileDiff(card, 'a.ts', '', netA)
  check('net lands before the diff event', c.diffs?.[0]?.turnDiff === netA, c.diffs)
  c = upsertCallFileDiff(c, 'a.ts', '--- a/a.ts\n+++ b/a.ts\n@@\n+a\n')
  c = upsertCallFileDiff(c, 'b.ts', '', netB)
  check('second net rides its own entry', c.diffs?.[1]?.turnDiff === netB, c.diffs)
  check('aggregate turnDiff concatenates nets', c.turnDiff?.includes('netA') && c.turnDiff?.includes('netB'), c.turnDiff)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log('\nهمه‌ی تست‌ها سبز شدند')
}
