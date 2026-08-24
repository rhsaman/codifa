// Test for the ensureSidecar health-check + restart logic in src/lib/api.ts.
// The cached sidecar URL must be probed with /health before being trusted, and
// dropped (then re-resolved, which restarts the sidecar) when the probe fails —
// otherwise the client keeps hitting a dead port and surfaces "Failed to fetch".
// Run: npx esbuild test/ensureSidecar.test.ts --bundle --platform=node --format=esm \
//        --packages=external --external:electron --outfile=test/.tmp-es.mjs \
//        && node test/.tmp-es.mjs

// Capture the sidecar change/dead callbacks so we can reset the module-level
// cache between cases (onSidecarChanged / onSidecarDead both set sidecarUrl=null).
let onChanged: (() => void) | null = null
let onDead: (() => void) | null = null
let sidecarUrlCalls = 0

;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => {
      sidecarUrlCalls++
      return 'http://127.0.0.1:8899'
    },
    onSidecarChanged: (cb: () => void) => {
      onChanged = cb
      return () => {}
    },
    onSidecarDead: (cb: () => void) => {
      onDead = cb
      return () => {}
    },
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// fetch mock: /health succeeds only when the alive url matches; otherwise it
// throws (simulating a dead port / connection refused).
let aliveUrl: string | null = null
;(globalThis as any).fetch = async (url: string) => {
  if (url.endsWith('/health')) {
    if (aliveUrl && url.startsWith(aliveUrl)) return new Response('', { status: 200 })
    throw new Error('connection refused')
  }
  return new Response('', { status: 200 })
}

const { ensureSidecar } = await import('../src/lib/api.ts')

function reset() {
  aliveUrl = null
  sidecarUrlCalls = 0
  onChanged?.()
}

console.log('۱) اولین فراخوانی → getSidecarUrl صدا زده میشود و آدرس برمیگردد:')
{
  reset()
  aliveUrl = 'http://127.0.0.1:8899'
  const url = await ensureSidecar()
  check('آدرس برگشتی = http://127.0.0.1:8899', url === 'http://127.0.0.1:8899', url)
  check('getSidecarUrl دقیقاً یک بار صدا زده شد', sidecarUrlCalls === 1, sidecarUrlCalls)
}

console.log('۲) کش زنده → health-check موفق، همان آدرس کش برمیگردد (بدون restart):')
{
  reset()
  aliveUrl = 'http://127.0.0.1:8899'
  const first = await ensureSidecar()
  const second = await ensureSidecar()
  check('دو فراخوانی یکساناند (کش استفاده شد)', first === second, { first, second })
  check('getSidecarUrl فقط یک بار صدا زده شد (کش)', sidecarUrlCalls === 1, sidecarUrlCalls)
}

console.log('۳) کش مرده → health-check شکست، کش پاک شده و restart میشود:')
{
  reset()
  aliveUrl = 'http://127.0.0.1:8899'
  const first = await ensureSidecar()
  aliveUrl = null // server crashes (e.g. segfault while loading Whisper)
  const second = await ensureSidecar()
  check('فراخوانی دوم آدرس معتبر برمیگرداند', second === 'http://127.0.0.1:8899', second)
  check('getSidecarUrl دوباره صدا زده شد (restart)', sidecarUrlCalls === 2, sidecarUrlCalls)
}

console.log('۴) عدم دسترسی اولیه → getSidecarUrl null برمیگرداند:')
{
  reset()
  const orig = (globalThis as any).window.coder.getSidecarUrl
  ;(globalThis as any).window.coder.getSidecarUrl = async () => {
    sidecarUrlCalls++
    return null
  }
  const url = await ensureSidecar()
  check('آدرس null برمیگردد', url === null, url)
  ;(globalThis as any).window.coder.getSidecarUrl = orig
}

console.log('۵) رویداد sidecar:dead از سمت Electron → کش پاک میشود و restart انجام میشود:')
{
  reset()
  aliveUrl = 'http://127.0.0.1:8899'
  await ensureSidecar()
  onDead?.() // simulate the electron 'sidecar:dead' IPC event
  aliveUrl = null
  const url = await ensureSidecar()
  check('بعد از sidecar:dead، getSidecarUrl دوباره صدا زده شد', sidecarUrlCalls === 2, sidecarUrlCalls)
  check('آدرس معتبر برمیگردد', url === 'http://127.0.0.1:8899', url)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای ensureSidecar پاس شدند')
