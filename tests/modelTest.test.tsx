// تست testModel (src/lib/api.ts) + استور مشترک useModelTests + دکمه‌های تست.
// ۱) testModel موفق → {ok, reply}؛ خطای ۴۰۰ با detail → همان detail throw می‌شود.
// ۲) runModelTest نتیجه را در استور مشترک می‌نویسد (ok / fail با پیام).
// ۳) runProviderTests همهٔ مدل‌ها را با استخر همزمانی تست می‌کند و دکمه‌های
//    تکی همان مدل‌ها را هم پیش می‌برد (هم‌نمایی استور مشترک).
// ۴) رندر SSR دکمهٔ تکی ModelTestButton و دکمهٔ ProviderTestButton.
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

console.log('۱) testModel — پاسخ موفق و خطای ۴۰۰:')
{
  testResponse = { ok: true, status: 200, reply: 'OK' }
  const r = await testModel(cfg, 'test-model')
  check('ok=true و reply=OK', r.ok === true && r.reply === 'OK', r)

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

console.log('۲) استور مشترک useModelTests — runModelTest:')
{
  const { runModelTest, getTestEntry, clearModelTests } = await import('../src/lib/useModelTests.ts')
  clearModelTests()

  testResponse = { ok: true, status: 200, reply: 'OK' }
  await runModelTest(cfg, 'm1')
  check('m1 → ok با پیام OK', getTestEntry(cfg, 'm1').status === 'ok' && getTestEntry(cfg, 'm1').msg.includes('OK'), getTestEntry(cfg, 'm1'))

  testResponse = { ok: false, status: 400, detail: 'RuntimeError: boom' }
  await runModelTest(cfg, 'm2')
  check('m2 → fail با پیام خطا', getTestEntry(cfg, 'm2').status === 'fail' && getTestEntry(cfg, 'm2').msg.includes('boom'), getTestEntry(cfg, 'm2'))

  // مدل در حال تست دوباره فایر نمی‌شود: m3 در حال testing می‌ماند و fetch
  // جدیدی زده نمی‌شود (پاسخ mock همیشه sync برمی‌گردد، پس فقط وضعیت را چک
  // می‌کنیم که testing است و runModelTest دوم no-op است).
  clearModelTests()
  let calls = 0
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.endsWith('/models/test')) {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, status: 200, json: async () => ({ ok: true, reply: 'OK' }) } as any
    }
    return new Response('', { status: 200 })
  }
  const p1 = runModelTest(cfg, 'm3')
  const p2 = runModelTest(cfg, 'm3')
  await Promise.all([p1, p2])
  check('مدل در حال تست دوباره فایر نمی‌شود (۱ fetch)', calls === 1, calls)
  check('m3 → ok', getTestEntry(cfg, 'm3').status === 'ok', getTestEntry(cfg, 'm3'))
}

console.log('۳) runProviderTests — استخر همزمانی و پیش‌بردن دکمه‌های تکی:')
{
  const { runProviderTests, getTestEntry, clearModelTests } = await import('../src/lib/useModelTests.ts')
  clearModelTests()

  // ۵ مدل: m0 و m2 خطا می‌دهند، بقیه OK — نتیجه باید روی هر ۵ دکمهٔ تکی بنشیند.
  const models = ['m0', 'm1', 'm2', 'm3', 'm4']
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.endsWith('/models/test')) {
      const body = JSON.parse((globalThis as any).__lastBody ?? '{}')
      const model = (body as any).model ?? ''
      if (model === 'm0' || model === 'm2') {
        return { ok: false, status: 400, json: async () => ({ detail: 'boom-' + model }) } as any
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, reply: 'OK' }) } as any
    }
    return new Response('', { status: 200 })
  }
  // fetch body را ضبط کن تا مدل درخواستی معلوم شود.
  const origFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init?: any) => {
    if (url.endsWith('/models/test') && init?.body) (globalThis as any).__lastBody = init.body
    return origFetch(url, init)
  }

  await runProviderTests(cfg, models)
  check('هر ۵ مدل نتیجه گرفتند', models.every((m) => getTestEntry(cfg, m).status !== 'idle'))
  check('m0 و m2 → fail', getTestEntry(cfg, 'm0').status === 'fail' && getTestEntry(cfg, 'm2').status === 'fail')
  check('m1، m3، m4 → ok', ['m1', 'm3', 'm4'].every((m) => getTestEntry(cfg, m).status === 'ok'))
  check('پیام خطا حفظ می‌شود', getTestEntry(cfg, 'm0').msg.includes('boom-m0'), getTestEntry(cfg, 'm0'))
}

console.log('۴) رندر SSR دکمه‌ها:')
{
  const { renderToString } = await import('react-dom/server')
  const { ModelTestButton } = await import('../src/components/ModelTestButton')
  const { ProviderTestButton } = await import('../src/components/ProviderTestButton')
  const html = renderToString(<ModelTestButton cfg={cfg} model="test-model" />)
  check('کلاس pm-model-test در HTML است', html.includes('pm-model-test'), html)
  check('آیکون رعد SVG در حالت idle رندر می‌شود', html.includes('pm-test-bolt'), html)
  const phtml = renderToString(<ProviderTestButton cfg={cfg} models={['a', 'b']} />)
  check('کلاس pm-provider-test در HTML است', phtml.includes('pm-provider-test'), phtml)
  check('دکمهٔ پروایدر هم آیکون رعد دارد', phtml.includes('pm-test-bolt'), phtml)
  check('دکمهٔ پروایدر در حالت idle هیچ ✓ ندارد', !phtml.includes('✓'), phtml)
  check('دکمهٔ پروایدر در حالت idle هیچ ✕ ندارد', !phtml.includes('✕'), phtml)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های modelTest پاس شدند')
