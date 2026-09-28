// تست واحد برای جست‌وجو داخل دیف (هایلایت + فیلتر فایل‌ها).
// اجرا: node tests/diffSearch.test.ts
import { countDiffHits, countOccurrences, fileMatchesQuery, filterFilesByQuery, locateHit, splitHighlightParts, stepHitIndex } from '../src/lib/diffSearch.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) splitHighlightParts: شکستن متن به تکه‌های عادی/هایلایت:')
{
  const parts = splitHighlightParts('const b = 2', 'const')
  check('دو تکه دارد', parts.length === 2, parts)
  check('تکه اول hit است', parts[0]?.hit === true && parts[0]?.text === 'const')
  check('تکه دوم عادی است', parts[1]?.hit === false)
}

console.log('۲) splitHighlightParts: case-insensitive + چند رخداد:')
{
  const parts = splitHighlightParts('Const x = CONST', 'const')
  const hits = parts.filter((p) => p.hit)
  check('دو رخداد هایلایت شد', hits.length === 2, parts)
  check('کوئری خالی یعنی بدون هایلایت', splitHighlightParts('abc', '  ').every((p) => !p.hit))
}

console.log('۳) countOccurrences: شمارش case-insensitive:')
{
  check('دو رخداد', countOccurrences('const a\nConst b', 'const') === 2)
  check('کوئری خالی صفر است', countOccurrences('abc', '') === 0)
  check('متن خالی صفر است', countOccurrences('', 'a') === 0)
}

console.log('۴) fileMatchesQuery: مسیر یا دیف:')
{
  check('تطابق در مسیر', fileMatchesQuery({ path: 'src/a.ts', diff: '' }, 'a.ts'))
  check('تطابق در دیف', fileMatchesQuery({ path: 'x.ts', diff: '+const b = 2' }, 'const'))
  check('عدم تطابق', !fileMatchesQuery({ path: 'x.ts', diff: 'hello' }, 'const'))
  check('کوئری خالی یعنی همه', fileMatchesQuery({ path: 'x.ts', diff: '' }, '  '))
}

console.log('۵) filterFilesByQuery: فیلتر لیست:')
{
  const files = [
    { path: 'a.ts', diff: '+const b = 2' },
    { path: 'b.css', diff: '.x { color: red; }' },
  ]
  check('کوئری خالی همان لیست است', filterFilesByQuery(files, '') === files)
  const out = filterFilesByQuery(files, 'const')
  check('فقط یک فایل ماند', out.length === 1 && out[0]?.path === 'a.ts', out)
}

console.log('۶) stepHitIndex: جلو/عقب با wrap-around مثل VSCode:')
{
  check('جلو از هیچ‌کدام → اول', stepHitIndex(-1, 3, 1) === 0)
  check('جلو از آخر → اول (wrap)', stepHitIndex(2, 3, 1) === 0)
  check('عقب از اول → آخر (wrap)', stepHitIndex(0, 3, -1) === 2)
  check('بدون رخداد → ‎-1‎', stepHitIndex(0, 0, 1) === -1)
}

console.log('۷) locateHit: نگاشت ایندکس سراسری به فایل:')
{
  const loc = locateHit([2, 0, 1], 2)
  check('رخداد سوم در فایل سوم است', loc?.fileIndex === 2 && loc?.localIndex === 0, loc)
  check('wrap-around', locateHit([2, 1], 3)?.fileIndex === 0)
  check('بدون رخداد → null', locateHit([0, 0], 0) === null)
}

console.log('۸) countDiffHits: فقط خط‌های دیف (نه سرفصل هانک):')
{
  const rows = [
    { type: 'hunk' as const, text: '@@ -1,2 +1,2 @@ const header' },
    { type: 'same' as const, before: 'ctx line', after: 'ctx line' },
    { type: 'del' as const, before: 'old const one', after: '' },
    { type: 'add' as const, before: '', after: 'new const two' },
  ]
  // سرفصل هانک (`const header`) شمرده نمی‌شود؛ دو خط تغییر هر کدام یک رخداد.
  check('دو رخداد بدنه', countDiffHits(rows, 'const') === 2, countDiffHits(rows, 'const'))
  check('کوئری خالی صفر است', countDiffHits(rows, '  ') === 0)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد`)
  process.exit(1)
} else {
  console.log('\nهمه‌ی تست‌ها سبز شدند')
}
