// Test for src/lib/singleFlight.ts: one async job at a time, extra requests ride along.
// Run: npx esbuild tests/singleFlight.test.ts --bundle --platform=node --format=esm
//        --outfile=tests/.tmp-single-flight.mjs && node tests/.tmp-single-flight.mjs

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const { singleFlight } = await import('../src/lib/singleFlight')

console.log('1) a second run while one is in flight does not start a job:')
{
  const sf = singleFlight()
  let started = 0
  let release!: () => void
  const first = sf.run(
    () =>
      new Promise<void>((resolve) => {
        started++
        release = resolve
      }),
  )
  const second = sf.run(async () => {
    started++
  })
  check('only the first job started', started === 1, { started })
  check('the second caller gets the running promise', first === second)
  check('current() reports the job in flight', sf.current() === first)
  release()
  await first
  check('idle again after it finished', sf.current() === null)
}

console.log('2) a failing job never wedges the guard:')
{
  const sf = singleFlight()
  let rejected = false
  await sf.run(async () => {
    throw new Error('boom')
  }).catch(() => {
    rejected = true
  })
  check('the returned promise does not reject', !rejected)
  check('idle after the failure', sf.current() === null)
  let ran = false
  await sf.run(async () => {
    ran = true
  })
  check('the next job runs', ran)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall single-flight checks passed')
