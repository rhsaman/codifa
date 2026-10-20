// تست واحد برای تشخیص کامنت در خط‌های دیف (کامنت خطی + بلوک چندخطی).
// اجرا: node tests/diffComments.test.ts
import {
  buildCommentSpans,
  commentSyntax,
  scanCommentLine,
  splitCommentSegments,
} from '../src/lib/diffComments.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('۱) commentSyntax: نحو هر پسوند:')
{
  check('ts کامنت خطی + بلوک دارد', commentSyntax('a.ts').line[0] === '//' && commentSyntax('a.ts').block?.open === '/*')
  check('tsx مثل ts است', commentSyntax('a.tsx').line[0] === '//')
  check('py با #', commentSyntax('a.py').line[0] === '#')
  check('sql با --', commentSyntax('a.sql').line[0] === '--')
  check('css فقط بلوک', commentSyntax('a.css').line.length === 0 && commentSyntax('a.css').block?.open === '/*')
  check('html بلوک HTML', commentSyntax('a.html').block?.open === '<!--')
  check('پسوند ناشناخته هیچ', commentSyntax('a.bin').line.length === 0 && !commentSyntax('a.bin').block)
  check('کوئری‌استرینگ نادیده', commentSyntax('a.ts?12').line[0] === '//')
  check('Makefile بدون پسوند', commentSyntax('sub/Makefile').line[0] === '#')
  check('Dockerfile بدون پسوند', commentSyntax('Dockerfile').line[0] === '#')
  check('نام ناشناخته بدون پسوند هیچ', commentSyntax('LICENSE').line.length === 0)
}

console.log('۲) scanCommentLine: کامنت خطی:')
{
  const r = scanCommentLine('const a = 1 // توضیح', commentSyntax('a.ts'))
  check('یک بازه پیدا شد', r.spans.length === 1, r.spans)
  check('بازه از // شروع می‌شود', r.spans[0].start === 12, r.spans[0])
  check('بازه تا آخر خط', r.spans[0].end === 'const a = 1 // توضیح'.length)
  check('بلوک باز نماند', r.open === false)
}

console.log('۳) scanCommentLine: رشته کامنت نیست:')
{
  const r = scanCommentLine('const url = "http://x"', commentSyntax('a.ts'))
  check('اسلش داخل رشته نادیده', r.spans.length === 0, r.spans)
  const r2 = scanCommentLine('const s = "a // b"', commentSyntax('a.ts'))
  check('مارکر داخل رشته نادیده', r2.spans.length === 0, r2.spans)
  const r3 = scanCommentLine('const s = "a \\" // real"', commentSyntax('a.ts'))
  check('به هم ریختن نقل‌قول', r3.spans.length === 0, r3.spans)
}

console.log('۴) scanCommentLine: بلوک یک‌خطی:')
{
  const text = 'const a = 1; /* توضیح */ const b = 2;'
  const r = scanCommentLine(text, commentSyntax('a.ts'))
  check('یک بازه', r.spans.length === 1, r.spans)
  check('شروع درست', r.spans[0].start === 13, r.spans[0])
  check('پایان شامل */', text.slice(r.spans[0].start, r.spans[0].end) === '/* توضیح */')
  check('بلوک بسته شد', r.open === false)
}

console.log('۵) scanCommentLine: بلوک چندخطی (مورد اصلی):')
{
  const syntax = commentSyntax('a.ts')
  const first = scanCommentLine('/** Normalize persisted seen ids.', syntax)
  check('خط اول کامنت است', first.spans.length === 1 && first.spans[0].start === 0, first.spans)
  check('بلوک باز ماند', first.open === true)

  const middle = scanCommentLine(' *  Pure for test. */', syntax, true)
  check('ادامهٔ بلوک کامل کامنت است', middle.spans.length === 1, middle.spans)
  check('ادامه تا آخر */', middle.spans[0].end === ' *  Pure for test. */'.length)
  check('بلوک بسته شد', middle.open === false)

  const after = scanCommentLine('const a = 1', syntax, false)
  check('خط بعدی کد است', after.spans.length === 0, after.spans)
}

console.log('۶) buildCommentSpans: وضعیت بلوک بین خطوط حفظ می‌شود:')
{
  const lines = [
    { lineNo: 30, text: '/** Normalize persisted seen ids to a bounded list.' },
    { lineNo: 31, text: ' *  Pure for test. */' },
    { lineNo: 32, text: 'export function normalizeSeen(ids: string[]) {' },
    { lineNo: 33, text: '  return ids.filter(Boolean) // حذف خالی‌ها' },
  ]
  const map = buildCommentSpans(lines, commentSyntax('src/lib/store.ts'))
  check('سه خط کامنت دارند', map.size === 3, [...map.keys()])
  check('خط ۳۰ کامنت است', map.has(30))
  check('خط ۳۱ کامنت است', map.has(31))
  check('خط ۳۲ کد است', !map.has(32))
  check('خط ۳۳ کامنت خطی دارد', map.has(33))

  // سایتی که کامنت ندارد هیچ ورودی‌ای نمی‌سازد.
  const empty = buildCommentSpans([{ lineNo: 1, text: 'const a = 1' }], commentSyntax('a.ts'))
  check('بدون کامنت خالی است', empty.size === 0)
  // پسوند ناشناخته: هیچ.
  const unknown = buildCommentSpans(lines, commentSyntax('a.bin'))
  check('پسوند ناشناخته هیچ', unknown.size === 0)
}

console.log('۷) بلوک CSS/HTML چندخطی:')
{
  const css = buildCommentSpans(
    [
      { lineNo: 1, text: '/* راهنما' },
      { lineNo: 2, text: '   ادامه */ body { color: red }' },
    ],
    commentSyntax('a.css'),
  )
  check('خط اول کامنت', css.has(1))
  check('خط دوم کامنت دارد', css.has(2))
  const seg = splitCommentSegments('   ادامه */ body { color: red }', css.get(2))
  check('کد بعد از */ جدا شد', seg.length === 2 && seg[1].comment === false, seg)
  check('طول بخش کد درست', seg[1].text === ' body { color: red }', seg[1])
}

console.log('۸) splitCommentSegments: تکه‌بندی:')
{
  const text = 'const a = 1 // x'
  const seg = splitCommentSegments(text, [{ start: 12, end: text.length }])
  check('دو تکه', seg.length === 2, seg)
  check('تکه اول کد', seg[0].comment === false && seg[0].text === 'const a = 1 ')
  check('تکه دوم کامنت', seg[1].comment === true && seg[1].text === '// x')
  check('بدون بازه یک تکه', splitCommentSegments('abc', []).length === 1)
  check('بدون بازه کامنت نیست', splitCommentSegments('abc', [])[0].comment === false)
  const whole = splitCommentSegments('/* all */', [{ start: 0, end: 9 }])
  check('کل خط کامنت', whole.length === 1 && whole[0].comment === true)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌ها پاس شدند ✅')
process.exit(0)
