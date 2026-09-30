// Persisted inbox badge: seen run ids must survive a reload.
// Run: npx esbuild src/lib/store.seen.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-seen.mjs && node src/lib/.tmp-seen.mjs

;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).document = { documentElement: { style: { setProperty: () => {} } } }

const { normalizeScheduleRunsSeen, MAX_SCHEDULE_RUNS_SEEN } = await import('./store')
const { unseenRunCount } = await import('../components/ScheduleInbox')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

console.log('1) normalize keeps string ids:')
{
  const out = normalizeScheduleRunsSeen(['a', 'b'])
  check('keeps ids', out.join(',') === 'a,b', out)
}

console.log('2) normalize drops non-strings and dedupes:')
{
  const out = normalizeScheduleRunsSeen(['a', '', '  ', 1, null, 'a', 'b'])
  check('drops junk + dedupes', out.join(',') === 'a,b', out)
}

console.log('3) normalize caps at max (newest win):')
{
  const raw = Array.from({ length: MAX_SCHEDULE_RUNS_SEEN + 10 }, (_, i) => `r${i}`)
  const out = normalizeScheduleRunsSeen(raw)
  check('capped', out.length === MAX_SCHEDULE_RUNS_SEEN, out.length)
  check('newest win', out[out.length - 1] === `r${raw.length - 1}`, out.slice(-2))
}

console.log('4) seen ids keep badge at zero after reload:')
{
  const runs = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] as any[]
  const reloaded = normalizeScheduleRunsSeen(['r1', 'r2', 'r3'])
  check('badge stays zero', unseenRunCount(runs, reloaded) === 0)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll tests passed.')
}
