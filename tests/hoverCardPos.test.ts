// تست واحد برای موقعیت پاپ‌اپ پیش‌نمایش دیف.
// اجرا: node tests/hoverCardPos.test.ts
import {
  DIFF_POP_H,
  DIFF_POP_MIN_H,
  DIFF_POP_W,
  diffPopupPos,
} from '../src/lib/hoverCardPos.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const rect = (top: number, left = 100, width = 300) => ({
  top,
  bottom: top + 30,
  left,
  width,
})

console.log('۱) زیر کارت باز می‌شود:')
{
  const pos = diffPopupPos(rect(200), 1400, 900)
  check('بالا = زیر کارت + فاصله', pos.top === 238, pos.top)
  check('چپ = لبهٔ کارت', pos.left === 100, pos.left)
  check('عرض پیش‌فرض', pos.width === DIFF_POP_W, pos.width)
  check('ارتفاع محدود', pos.maxHeight === DIFF_POP_H, pos.maxHeight)
}

console.log('۲) نزدیک لبهٔ پایین به بالا می‌چرخد:')
{
  const pos = diffPopupPos(rect(860), 1400, 900)
  check('از بالا باز می‌شود', pos.top < 860, pos.top)
  check('بالا مثبت می‌ماند', pos.top >= 8, pos.top)
  check('ارتفاع از فضای بالا', pos.maxHeight <= 860, pos.maxHeight)
  // فضای پایین کم و بالای زیاد: بالاتر باز شود.
  const mid = diffPopupPos(rect(500), 1400, 900)
  check('فضای کافی زیر: زیر باز می‌شود', mid.top === 538, mid.top)
}

console.log('۳) فضای خیلی کم: حداقل ارتفاع:')
{
  const pos = diffPopupPos(rect(880), 1400, 900)
  check('ارتفاع حداقل رعایت شد', pos.maxHeight >= DIFF_POP_MIN_H, pos.maxHeight)
}

console.log('۴) کلیمپ افقی:')
{
  const right = diffPopupPos(rect(200, 1350), 1400, 900)
  check('از لبهٔ راست بیرون نمی‌زند', right.left + right.width <= 1400, right)
  check('حداقل ۸ پیکسل از چپ', right.left >= 8, right.left)
  const left = diffPopupPos(rect(200, -50), 1400, 900)
  check('چپ منفی کلیمپ شد', left.left === 8, left.left)
}

console.log('۵) پنجرهٔ باریک: عرض کوچک می‌شود:')
{
  const pos = diffPopupPos(rect(200), 500, 800)
  check('عرض داخل پنجره', pos.width <= 500 - 16, pos.width)
  check('عرض حداقلی دارد', pos.width >= 240, pos.width)
  const tiny = diffPopupPos(rect(100), 0, 0)
  check('ابعاد صفر سقوط امن', tiny.width > 0 && tiny.maxHeight > 0, tiny)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌ها پاس شدند ✅')
process.exit(0)
