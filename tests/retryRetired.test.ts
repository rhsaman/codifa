// Whether a LIVE sub-agent retry banner is retired by a stream event
// (src/lib/retry.ts `retryRetiredByEvent`).
//
// The bug this guards: the sub-agent retry ladder emits NO event when an
// attempt finally SUCCEEDS, so nothing ever cleared the banner — a recovered
// explore left "Provider rate limit (2/10) — retrying…" frozen on screen for
// the rest of the turn, while the agent carried on working normally.
//
// Run: node tests/retryRetired.test.ts
import { retryRetiredByEvent } from '../src/lib/retry.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

/** A live (still-retrying) sub-agent banner. */
function live(extra: Record<string, unknown> = {}) {
  return {
    attempt: 2,
    maxAttempts: 10,
    delay: 10,
    reason: 'explore failed: key rejected (429)',
    agent: 'explore subagent',
    tool: 'explore',
    ...extra,
  }
}

console.log('1) توفیق ساب‌ایجنت → بنر باید پاک شود:')
{
  const ev = { kind: 'tool_result', tool: 'explore' }
  check('result خود explore بنر را پاک میکند', retryRetiredByEvent(live(), ev) === true)
}

console.log('2) رویدادهای دیگر وسط تلاش → بنر باید بماند:')
{
  check(
    'tool_result یک ابزار دیگر',
    retryRetiredByEvent(live(), { kind: 'tool_result', tool: 'write_file' }) === false,
  )
  check(
    'شروع همان ابزار',
    retryRetiredByEvent(live(), { kind: 'tool', tool: 'explore' }) === false,
  )
  check('متن', retryRetiredByEvent(live(), { kind: 'text', tool: 'explore' }) === false)
  check(
    'رویداد نستد داخل خود ساب‌ایجنت',
    retryRetiredByEvent(live(), { kind: 'tool_result', tool: 'explore', sub: true }) === false,
  )
  check('رویداد بی‌نام', retryRetiredByEvent(live(), { kind: 'tool_result' }) === false)
}

console.log('3) بنر ترمینال باید بماند (دکمه Retry از بین نرود):')
{
  const ev = { kind: 'tool_result', tool: 'explore' }
  check('gaveUp → پاک نشود', retryRetiredByEvent(live({ gaveUp: true }), ev) === false)
  check('watchdog → پاک نشود', retryRetiredByEvent(live({ watchdog: true }), ev) === false)
  check('fallback → پاک نشود', retryRetiredByEvent(live({ fallback: true }), ev) === false)
}

console.log('4) بنر ایجنت اصلی (بدون agent) و نبودِ بنر → هیچ کاری:')
{
  const ev = { kind: 'tool_result', tool: 'explore' }
  check('بنر ایجنت اصلی دست‌نخورده', retryRetiredByEvent({ tool: 'explore' }, ev) === false)
  const noTool = live({ tool: undefined })
  check('بنر ساب‌ایجنت بدون نام ابزار', retryRetiredByEvent(noTool, ev) === false)
  check('retry=null', retryRetiredByEvent(null, ev) === false)
  check('retry=undefined', retryRetiredByEvent(undefined, ev) === false)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌ها پاس شدند ✅')
