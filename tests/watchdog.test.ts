// Quick sanity test for the watchdog tool-counter helpers (src/lib/watchdog.ts).
// The counter (not a boolean) lets parallel tool calls keep the stall watchdog's
// longer leash until ALL of them finish — a single early result must not clear
// the "a tool is still running" flag.
// Run: node tests/watchdog.test.ts
import { bumpToolRunning, dropToolRunning, isToolRunning } from '../src/lib/watchdog.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) شمارنده با boolean اشتباه بود — حالا چند ابزار موازی را مدیریت می‌کند:')
{
  const ref = { current: 0 }
  check('شروع: هیچ ابزاری در حال اجرا نیست', isToolRunning(ref) === false)

  // سه ابزار موازی شروع می‌شوند
  bumpToolRunning(ref)
  bumpToolRunning(ref)
  bumpToolRunning(ref)
  check('بعد از ۳ bump → ref = 3', ref.current === 3, ref.current)
  check('در حال اجرا است (true)', isToolRunning(ref) === true)

  // یکی زود تمام می‌شود — نباید پرچم پاک شود
  dropToolRunning(ref)
  check('بعد از ۱ drop → ref = 2 (هنوز در حال اجرا)', ref.current === 2 && isToolRunning(ref) === true, ref.current)

  // بقیه هم تمام می‌شوند
  dropToolRunning(ref)
  dropToolRunning(ref)
  check('بعد از تخلیه → ref = 0', ref.current === 0, ref.current)
  check('دیگر در حال اجرا نیست (false)', isToolRunning(ref) === false)
}

console.log('2) دفاع در برابر منفی شدن (drop بیش از حد):')
{
  const ref = { current: 0 }
  dropToolRunning(ref)
  dropToolRunning(ref)
  check('ref هرگز منفی نمی‌شود', ref.current === 0, ref.current)
  check('isToolRunning همچنان false', isToolRunning(ref) === false)
}

console.log('3) bump/drop تکی رفتار boolean قدیم را حفظ می‌کند:')
{
  const ref = { current: 0 }
  bumpToolRunning(ref)
  check('بعد از ۱ bump → true', isToolRunning(ref) === true)
  dropToolRunning(ref)
  check('بعد از ۱ drop → false', isToolRunning(ref) === false)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
