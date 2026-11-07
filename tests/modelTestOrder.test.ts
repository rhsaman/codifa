// تست مرتب‌سازی تب «Checked» پیکر مدل + مُهر زمان تست:
//  - orderCheckedModels باید مدل‌ها و گروه‌ها را بر اساس «آخرین تست موفق»
//    از بالا به پایین مرتب کند — ✓ زنده با okAt واقعیِ لحظهٔ نتیجه، بقیه با
//    lastOkAt ماندگار. نه Date.nowِ رندر (که همهٔ تست‌شده‌های همزمان را گره
//    می‌زند و عملاً مرتب‌سازی را از کار می‌اندازد).
//  - runModelTest باید روی نتیجهٔ ok مُهر okAt بگذارد (زمانِ نتیجه، نه زمان رندر).
// Run: npx esbuild tests/modelTestOrder.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-mto.mjs && node tests/.tmp-mto.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  // پل IPC جعلی: فقط sidecar_url یک پورت جواب می‌دهد — بقیه بی‌صدا.
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'getSidecarUrl') return async () => 'http://127.0.0.1:59991'
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// فچ جعلی: /health زنده، /models/test همیشه ok — تا runModelTest واقعاً تا
// مسیر setEntryFor پیش برود و مُهر okAt را بگذارد.
const realFetch = (globalThis as any).fetch
;(globalThis as any).fetch = (url: unknown, init?: unknown) => {
  const u = String(url)
  if (u.includes('/health')) {
    return Promise.resolve(new Response('ok', { status: 200 }))
  }
  if (u.includes('/models/test')) {
    return Promise.resolve(
      new Response(JSON.stringify({ reply: 'pong' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
  }
  return realFetch?.(url as string, init as RequestInit)
}

const { orderCheckedModels } = await import('../src/components/ProviderModelSelect')
const { runModelTest, getTestEntry } = await import('../src/lib/useModelTests')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// ————— ۱) orderCheckedModels: مرتب‌سازی بر اساس آخرین تست موفق —————
console.log('۱) orderCheckedModels — جدیدترین تست بالا (مدل و گروه):')
{
  const mk = (id: string, models: string[]) =>
    ({ id, kind: 'custom', name: id, baseUrl: 'https://x', apiKeys: ['k'], models })
  const pA = mk('prov-a', ['a-old', 'a-new'])
  const pB = mk('prov-b', ['b-old'])
  const pC = mk('prov-c', ['c-live'])
  const pD = mk('prov-d', ['d-idle']) // نه ✓ زنده نه در لیست ماندگار → نباید بیاید
  const T0 = 1_000_000
  const checked = [
    { providerId: 'prov-a', model: 'a-old', lastOkAt: T0 + 10 },
    { providerId: 'prov-a', model: 'a-new', lastOkAt: T0 + 15 },
    { providerId: 'prov-b', model: 'b-old', lastOkAt: T0 + 7 },
  ]
  const status = (p: { id: string }, m: string) => {
    if (p.id === 'prov-c') return { status: 'ok', msg: '', okAt: T0 + 20 }
    return { status: 'idle', msg: '' }
  }
  const groups = orderCheckedModels(
    [pA, pB, pC, pD] as never,
    checked as never,
    status as never,
  )
  check('گروه prov-c (تازه‌ترین ✓ زنده) اول است', groups[0]?.p.id === 'prov-c', groups.map((g) => g.p.id))
  check('گروه prov-a (lastOkAt 10) دوم است', groups[1]?.p.id === 'prov-a', groups.map((g) => g.p.id))
  check('گروه prov-b (lastOkAt 7) سوم است', groups[2]?.p.id === 'prov-b', groups.map((g) => g.p.id))
  check('مدل بی‌تیک و بی‌ذخیره (prov-d) اصلاً نمیآید', !groups.some((g) => g.p.id === 'prov-d'), groups.map((g) => g.p.id))
  const a = groups.find((g) => g.p.id === 'prov-a')!
  check('درون گروه: a-new (تست جدیدتر) بالای a-old', a.models[0] === 'a-new' && a.models[1] === 'a-old', a.models)
}

console.log('۲) orderCheckedModels — ✓ زندهٔ بدون مُهر، تازه‌تر از lastOkAt قدیمی حساب میشود:')
{
  const p = { id: 'prov', kind: 'custom', name: 'prov', baseUrl: 'https://x', apiKeys: ['k'], models: ['m1', 'm2'] }
  const checked = [{ providerId: 'prov', model: 'm1', lastOkAt: 500 }]
  const status = (_p: unknown, m: string) =>
    m === 'm2' ? { status: 'ok', msg: '' } : { status: 'idle', msg: '' }
  const groups = orderCheckedModels([p] as never, checked as never, status as never)
  check('m2 با ✓ زنده بالای m1 (lastOkAt قدیمی) است', groups[0]?.models[0] === 'm2', groups[0]?.models)
}

console.log('۳) orderCheckedModels — fail زنده از تب حذف میشود:')
{
  const p = { id: 'prov', kind: 'custom', name: 'prov', baseUrl: 'https://x', apiKeys: ['k'], models: ['m1'] }
  const checked = [{ providerId: 'prov', model: 'm1', lastOkAt: 500 }]
  const groups = orderCheckedModels(
    [p] as never,
    checked as never,
    (() => ({ status: 'fail', msg: 'boom' })) as never,
  )
  check('گروه خالی شد (fail بیرون ماند)', groups.length === 0, groups)
}

// ————— ۴) runModelTest مُهر okAt میگذارد —————
console.log('۴) runModelTest — نتیجهٔ ok مُهر okAt دارد:')
{
  const cfg = { id: 'prov-x', kind: 'custom', name: 'prov-x', baseUrl: 'https://x', apiKeys: ['k'] } as never
  await runModelTest(cfg, 'm-ok')
  const e = getTestEntry(cfg, 'm-ok')
  check('وضعیت ok است', e.status === 'ok', e)
  check('okAt عدد و نزدیک الان است', typeof e.okAt === 'number' && Math.abs(Date.now() - (e.okAt ?? 0)) < 5_000, e.okAt)
  const t0 = e.okAt
  await new Promise((r) => setTimeout(r, 15))
  await runModelTest(cfg, 'm-ok')
  const e2 = getTestEntry(cfg, 'm-ok')
  check('تست دوباره okAt تازه میگیرد (تست مجدد = تازگی جدید)', (e2.okAt ?? 0) > (t0 ?? 0), { t0, t1: e2.okAt })
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تستهای modelTestOrder پاس شدند')
// استور تست و تایمرهای persist پروسه را زنده نگه میدارند — خروج اجباری.
process.exit(0)
