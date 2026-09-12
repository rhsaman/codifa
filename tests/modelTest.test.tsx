// تست testModel (src/lib/api.ts) + رندر SSR دکمهٔ ModelTestButton.
// ۱) پاسخ موفق → {ok, reply} برمی‌گردد؛ ۲) خطای ۴۰۰ با detail → همان detail
// throw می‌شود تا UI خطای واقعی پروایدر را نشان دهد؛ ۳) دکمهٔ تست با کلاس
// pm-model-test رندر می‌شود.
// Run: npx esbuild tests/modelTest.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external --outfile=tests/.tmp-mt.mjs \
//        --external:electron && node tests/.tmp-mt.mjs

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// Minimal sidecar wiring so ensureSidecar resolves a URL without touching the
// real Electron runtime (الگوی tests/transcribe.test.ts).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => 'http://127.0.0.1:8899',
    onSidecarChanged: () => () => {},
    onSidecarDead: () => () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// fetch mock: /health always succeeds; /models/test returns the configured
// response so we can exercise the 400 + detail path.
let testResponse: { ok: boolean; status: number; detail?: string; reply?: string } = {
  ok: true,
  status: 200,
  reply: 'OK',
}
;(globalThis as any).fetch = async (url: string) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  if (url.endsWith('/models/test')) {
    return {
      ok: testResponse.ok,
      status: testResponse.status,
      json: async () => ({
        ok: testResponse.ok,
        reply: testResponse.reply,
        detail: testResponse.detail,
      }),
    } as any
  }
  return new Response('', { status: 200 })
}

const { testModel } = await import('../src/lib/api.ts')

const cfg = {
  id: 'p1',
  name: 'Test Provider',
  kind: 'custom',
  apiKey: 'k',
  baseUrl: 'http://x',
  model: 'm',
} as any

console.log('۱) پاسخ موفق → {ok, reply}:')
{
  testResponse = { ok: true, status: 200, reply: 'OK' }
  const r = await testModel(cfg, 'test-model')
  check('ok=true و reply=OK', r.ok === true && r.reply === 'OK', r)
}

console.log('۲) خطای ۴۰۰ با detail → همان detail throw می‌شود:')
{
  testResponse = { ok: false, status: 400, detail: 'RuntimeError: boom' }
  let thrown: unknown = null
  try {
    await testModel(cfg, 'test-model')
  } catch (err) {
    thrown = err
  }
  check(
    'خطا پیام detail را دارد',
    thrown instanceof Error && thrown.message === 'RuntimeError: boom',
    thrown,
  )
}

console.log('۳) رندر SSR دکمهٔ تست:')
{
  const { renderToString } = await import('react-dom/server')
  const { ModelTestButton } = await import('../src/components/ModelTestButton')
  const html = renderToString(<ModelTestButton cfg={cfg} model="test-model" />)
  check('کلاس pm-model-test در HTML است', html.includes('pm-model-test'), html)
  check('آیکون رعد SVG در حالت idle رندر می‌شود', html.includes('pm-test-bolt'), html)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های modelTest پاس شدند')
