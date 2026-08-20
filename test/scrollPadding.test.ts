// Quick sanity test for src/lib/scrollPadding.ts (run: node test/scrollPadding.test.ts)
import { composerScrollPadding } from '../src/lib/scrollPadding.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) بدون کارت (حالت عادی):')
{
  const idle = composerScrollPadding(142, null)
  check('کامپوزر خالی → حداقل 210px', idle === 210, idle)
  check('کامپوزر کمی بلندتر هم حداقل 210px میماند', composerScrollPadding(150, null) === 210)
}

console.log('2) با کارت باز (ask/perm):')
{
  const withCard = composerScrollPadding(142, 200)
  check('ارتفاع کارت + فاصله 10px + حاشیه 24px اضافه میشود', withCard === 142 + 200 + 10 + 24, withCard)
  check('کارت بلند (420px) padding را بزرگ میکند', composerScrollPadding(142, 420) === 142 + 420 + 10 + 24)
}

console.log('3) تکستاریای بزرگ (کامپوزر بلند):')
{
  const tall = composerScrollPadding(316, null)
  check('کامپوزر بلند padding را بزرگ میکند', tall === 316 + 24, tall)
  check('کامپوزر بلند + کارت با هم جمع میشوند', composerScrollPadding(316, 200) === 316 + 200 + 10 + 24)
}

console.log('4) کارت با ارتفاع صفر مثل نبودن کارت رفتار میکند:')
{
  check('cardH=0 → بدون فاصله 10px', composerScrollPadding(142, 0) === 210)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست ناموفق`)
  process.exit(1)
}
console.log('\n✅ همه تستهای scrollPadding پاس شدند')