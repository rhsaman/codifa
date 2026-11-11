// Sanity test for the resume-clock decision (src/lib/retry.ts).
// Run: node tests/retryResumeClock.test.ts
//
// Background (the "Working time keeps resetting" report): a build turn that
// hit two 60s provider drops reset the Working pill to ~0 on every auto
// re-send, while the tool-group clock kept the true 24m span. The fix keeps
// `workingStartedAt` alive across retry-armed closes; this helper decides
// when a resume may NOT keep it (a manual Retry long after the failure).
import {
  RESUME_CLOCK_GAP_MS,
  resumeClockRestart,
  RETRY_BACKOFF_MS,
} from '../src/lib/retry.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) ریسیلای خودکار (inside the ladder wait) → پایه ساعت حفظ می‌شود:')
{
  const base = Date.now() - 24 * 60_000 // turn started 24m ago
  const parked = 23 * 60_000 // failed 1m ago (elapsed parked at close)
  // Every ladder wait (max 60s) + a slack margin stays inside the gap.
  check(
    'بزرگترین انتظار نردبان + حاشیه → restart=false',
    resumeClockRestart(base, parked, Date.now()) === false,
    { base, parked },
  )
  check(
    'RETRY_BACKOFF_MS زیر RESUME_CLOCK_GAP_MS است',
    RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] < RESUME_CLOCK_GAP_MS,
    { RETRY_BACKOFF_MS, RESUME_CLOCK_GAP_MS },
  )
}

console.log('2) ریزوم خیلی دیر (manual Retry بعد از ساعاتی) → ساعت از نو:')
{
  const base = Date.now() - 26 * 3600_000
  const parked = 10 * 60_000 // the turn worked 10m, then failed
  check('شکاف چند ساعته → restart=true', resumeClockRestart(base, parked, Date.now()) === true)
}

console.log('3) دقیقاً روی مرز شکاف:')
{
  const now = 1_000_000_000_000
  const base = now - 60_000
  // base + elapsed == now → idle 0 → keep.
  check('شکاف صفر → restart=false', resumeClockRestart(base, 60_000, now) === false)
  // One second past the gap → restart.
  check(
    'شکاف ۵ دقیقه + ۱ ثانیه → restart=true',
    resumeClockRestart(base - RESUME_CLOCK_GAP_MS - 1_000, 60_000, now) === true,
  )
}

console.log('4) بدون مدت پارک‌شده (هنوز streaming یا state قدیمی) → همیشه حفظ:')
{
  const base = Date.now() - 48 * 3600_000
  check('turnElapsedMs=undefined → restart=false', resumeClockRestart(base, undefined) === false)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
