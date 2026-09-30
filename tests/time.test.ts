// Sanity test for src/lib/time.ts (run: node tests/time.test.ts)
import { fmtAgo, fmtClock, fmtClockFull } from '../src/lib/time.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  OK ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const NOW = new Date('2026-09-30T14:32:00').getTime()

console.log('1) fmtAgo (compact English ages):')
{
  check('future clamps to now', fmtAgo(NOW + 5000, NOW) === 'now')
  check('10s -> now', fmtAgo(NOW - 10_000, NOW) === 'now')
  check('59s -> now', fmtAgo(NOW - 59_000, NOW) === 'now')
  check('60s -> 1m', fmtAgo(NOW - 60_000, NOW) === '1m')
  check('5m -> 5m', fmtAgo(NOW - 5 * 60_000, NOW) === '5m')
  check('59m -> 59m', fmtAgo(NOW - 59 * 60_000, NOW) === '59m')
  check('60m -> 1h', fmtAgo(NOW - 60 * 60_000, NOW) === '1h')
  check('23h -> 23h', fmtAgo(NOW - 23 * 3600_000, NOW) === '23h')
  check('24h -> 1d', fmtAgo(NOW - 24 * 3600_000, NOW) === '1d')
  check('6d -> 6d', fmtAgo(NOW - 6 * 86400_000, NOW) === '6d')
  check('29d -> 29d', fmtAgo(NOW - 29 * 86400_000, NOW) === '29d')
  const old = fmtAgo(NOW - 40 * 86400_000, NOW)
  check('40d falls back to a date', /[A-Za-z]{3} \d{1,2}, \d{4}/.test(old), old)
  check('short labels (2-3 chars)', fmtAgo(NOW - 3 * 3600_000, NOW).length <= 3)
  check('no Persian digits anywhere', !/[۰-۹]/.test(fmtAgo(NOW - 3 * 3600_000, NOW)))
}

console.log('')
console.log('2) fmtClock (today -> HH:MM, older -> date + time):')
{
  const today = fmtClock(Date.now())
  check('today matches HH:MM', /^\d{2}:\d{2}$/.test(today), today)
  const oldTs = new Date('2020-01-05T03:04:00').getTime()
  const old = fmtClock(oldTs)
  check('old stamp includes date and time', /\d+\/\d+ \d{2}:\d{2}/.test(old), old)
  check('no Persian digits', !/[۰-۹]/.test(old), old)
}

console.log('')
console.log('3) fmtClockFull (tooltip):')
{
  const full = fmtClockFull(NOW)
  check('non-empty English string', full.length > 8 && !/[۰-۹]/.test(full), full)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll time tests passed')
