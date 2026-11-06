// The persisted provider maps must be BOUNDED, not monotonic:
//
// `mergeContextMap` used to seed the map with every previous entry, so keys of
// models the provider dropped or renamed survived forever and every fetch could
// add two more (qualified + bare). Measured on a real profile: one provider's
// maps alone had grown past 355 KB of settings.json. These tests lock the
// prune: only keys whose bare id belongs to the CURRENT catalog (or a
// user-added model) may survive a fetch.
//
// `checkedModels` gets the same treatment from the other side: a hard cap keeps
// the newest entries, so decades of model testing cannot bloat settings.json.
import './_globals.ts'

let pass = 0
let fail = 0
function assert(name: string, cond: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

// Same bridge stub as contextCapacityPersist.test.ts: a real AES key for
// encryptSettings, an inert catch-all for everything else.
const KEY = '0123456789abcdef0123456789abcdef'
;(globalThis as any).window.coder = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      if (prop === 'secretsGetKey') return async () => btoa(KEY)
      return async () => ({ ok: true, data: null })
    },
  },
)

const { mergeContextMap } = await import('../src/lib/provider-fetch.ts')
const { useStore } = await import('../src/lib/store.ts')

function mk(p: Partial<any> = {}): any {
  return { id: 'acme', name: 'Acme', kind: 'custom', baseUrl: 'https://acme.test/v1', ...p }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) کلیدهای مدل‌های حذف‌شده بعد از هر فچ هرس می‌شوند:')
{
  const p = mk()
  // The provider used to serve `ghost-old`; the fresh catalog only lists two
  // models. Previous entries for the ghost must not survive — under either
  // key spelling.
  const out = mergeContextMap(
    p,
    ['big-1m', 'mid-200k'],
    { 'big-1m': 1_000_000, 'mid-200k': 200_000 },
    { 'big-1m': 500_000, 'ghost-old': 128_000, 'acme/ghost-old': 128_000 },
  )
  assert('مدل‌های کاتالوگ تازه سر جایشان هستند', out['big-1m'] === 1_000_000 && out['mid-200k'] === 200_000)
  assert('کلید یتیم bare حذف شد', out['ghost-old'] === undefined)
  assert('کلید یتیم qualified حذف شد', out['acme/ghost-old'] === undefined)
  assert('دو کلید بیشتر باقی نمی‌ماند', Object.keys(out).length === 2)
}

console.log('\n۲) مدل‌های دستی کاربر (addedModels) با ظرفیت قبلی می‌مانند:')
{
  const p = mk({ addedModels: ['manual-1'] })
  const out = mergeContextMap(
    p,
    ['big-1m'],
    { 'big-1m': 1_000_000 },
    { 'manual-1': 64_000 },
  )
  assert('مدل دستی ظرفیت قبلی را نگه داشت', out['manual-1'] === 64_000)
  assert('مدل کاتالوگ هم هست', out['big-1m'] === 1_000_000)
}

console.log('\n۳) مدل دستیِ بدون ظرفیت قبلی دیفالت می‌گیرد، نه بی‌ظرفیت:')
{
  const { DEFAULT_CONTEXT_WINDOW } = await import('../src/lib/context.ts')
  const p = mk({ addedModels: ['manual-new'] })
  const out = mergeContextMap(p, ['big-1m'], { 'big-1m': 1_000_000 }, undefined)
  assert('مدل دستی جدید دیفالت ۲۰۰ هزار گرفت', out['manual-new'] === DEFAULT_CONTEXT_WINDOW)
  assert('هر دو املای کلید برای مدل دستی نوشته شد', out['acme/manual-new'] === DEFAULT_CONTEXT_WINDOW)
}

console.log('\n۴) کاتالوگ خالی (فچ شکسته) نقشهٔ قبلی را دست‌نخورده برمی‌گرداند:')
{
  const p = mk()
  const previous = { 'big-1m': 1_000_000, 'ghost-old': 128_000 }
  const out = mergeContextMap(p, [], {}, previous)
  assert('کاتالوگ خالی = «نامعلوم»، نه «صفر مدل»', JSON.stringify(out) === JSON.stringify(previous))
}

console.log('\n۵) مدل‌های removed و خارج از پروایدر هرس می‌شوند:')
{
  const p = mk({ removedModels: ['removed-model'] })
  const out = mergeContextMap(
    p,
    ['big-1m', 'removed-model'],
    { 'big-1m': 1_000_000, 'removed-model': 200_000 },
    { 'removed-model': 300_000, 'acme/removed-model': 300_000 },
  )
  assert('مدل removed ذخیره نشد', out['removed-model'] === undefined)
  assert('کلید قبلی مدل removed هم حذف شد', out['acme/removed-model'] === undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n۶) سقف checkedModels — تازه‌ترین‌ها می‌مانند:')
{
  const { MAX_CHECKED_MODELS } = await import('../src/lib/store.ts')
  const st = useStore.getState()
  const many: any[] = []
  for (let i = 0; i < 250; i++) {
    many.push({ providerId: 'p', model: `m-${String(i).padStart(3, '0')}`, lastOkAt: 1_000 + i })
  }
  st.setCheckedModels(many)
  const saved = useStore.getState().checkedModels
  assert('لیست به سقف ۲۰۰ محدود شد', saved.length === MAX_CHECKED_MODELS)
  assert(
    'تازه‌ترین‌ها ماندند و قدیمی‌ترین‌ها رفتند',
    saved.some((c: any) => c.model === 'm-249') && !saved.some((c: any) => c.model === 'm-000'),
  )
  // Below the cap the list is passed through untouched.
  st.setCheckedModels([{ providerId: 'p', model: 'only', lastOkAt: 5 }])
  assert('زیر سقف دست نمی‌خورد', useStore.getState().checkedModels.length === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
