// Test for the manual context-window feature (Settings → Providers → custom model):
// a user typing a model id by hand on a `custom` provider can ALSO type the
// model's context window in tokens. That manual value:
//   1. wins over the live per-model `contextMap` in `modelContextWindow`
//      (so the meter and the `context_window` sent to the backend use it),
//   2. lives in a SEPARATE map (`manualContextMap`), so a live `/models` fetch
//      can never wipe it,
//   3. is only added for custom providers — other kinds keep the old behavior.
// Run: npx esbuild tests/manualContext.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-mc.mjs --external:electron \
//        && node tests/.tmp-mc.mjs
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

const { useStore } = await import('../src/lib/store.ts')
const { modelContextWindow } = await import('../src/lib/context.ts')
const { fetchAndPersist } = await import('../src/lib/provider-fetch.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const providerOf = (id: string) =>
  useStore.getState().settings.providers.find((p) => p.id === id)!

// ---------------------------------------------------------------------------
console.log('۱) modelContextWindow — مقدار دستی بر contextMap زنده اولویت دارد:')
{
  check(
    'کلید bare: مقدار دستی برنده است',
    modelContextWindow(
      { id: 'p1', manualContextMap: { 'gpt-4o': 32000 }, contextMap: { 'gpt-4o': 128000 } },
      'gpt-4o',
    ) === 32000,
  )
  check(
    'کلید پیشونددار id/model: مقدار دستی برنده است',
    modelContextWindow(
      { id: 'nvidia', manualContextMap: { 'nvidia/deepseek-v3': 16000 }, contextMap: {} },
      'deepseek-v3',
    ) === 16000,
  )
  check(
    'بدون مقدار دستی، contextMap زنده استفاده میشود',
    modelContextWindow({ id: 'p1', contextMap: { m: 64000 } }, 'm') === 64000,
  )
  check(
    'مقدار صفر/منفیِ دستی نادیده گرفته میشود (به contextMap برمیگردد)',
    modelContextWindow(
      { id: 'p1', manualContextMap: { m: 0 }, contextMap: { m: 64000 } },
      'm',
    ) === 64000,
  )
}

// ---------------------------------------------------------------------------
console.log('\n۲) addManualModel با کانتکست دستی (فقط پروایدر کاستوم):')
const customId = useStore.getState().addProvider()
useStore.getState().updateProvider(customId, { baseUrl: 'http://localhost:9999/v1' })

{
  useStore.getState().addManualModel(customId, 'my-model', 64000)
  const p = providerOf(customId)
  check('مدل در addedModels ثبت شد', (p.addedModels ?? []).includes('my-model'), p.addedModels)
  check('مدل در لیست models هست', (p.models ?? []).includes('my-model'), p.models)
  check('کانتکست دستی با کلید bare ذخیره شد', p.manualContextMap?.['my-model'] === 64000, p.manualContextMap)
  check('متر کانتکست مقدار دستی را میبیند', modelContextWindow(p, 'my-model') === 64000)
}

{
  // شناسهی پیشونددار (مثل چیزی که /models برمیگرداند) → همان کلید bare
  useStore.getState().addManualModel(customId, `${customId}/prefixed-model`, 8192)
  const p = providerOf(customId)
  check('شناسه پیشونددار به کلید bare نرمال شد', p.manualContextMap?.['prefixed-model'] === 8192, p.manualContextMap)
  check('کلید پیشونددار دو مقدار جدا نساخت', p.manualContextMap?.[`${customId}/prefixed-model`] === undefined)
}

{
  // بدون عدد معتبر → مدل اضافه میشود ولی مقدار دستی ثبت نمیشود
  useStore.getState().addManualModel(customId, 'no-ctx-model')
  const p = providerOf(customId)
  check('مدل بدون عدد هم اضافه میشود', (p.addedModels ?? []).includes('no-ctx-model'))
  check('مقدار دستی برای مدل بدون عدد ثبت نشد', p.manualContextMap?.['no-ctx-model'] === undefined)
}

// ---------------------------------------------------------------------------
console.log('\n۳) مقدار دستی بعد از فچ زنده و بعد از updateProvider باقی میماند:')
{
  // contextMap زنده مقدار دیگری گزارش میکند؛ مقدار دستی باید در متر بماند.
  useStore.getState().setProviderContextMap(customId, { 'my-model': 128000 })
  const p = providerOf(customId)
  check('setProviderContextMap به manualContextMap دست نزد', p.manualContextMap?.['my-model'] === 64000)
  check('مقدار دستی بر مقدار زنده اولویت دارد', modelContextWindow(p, 'my-model') === 64000)
}
{
  useStore.getState().updateProvider(customId, { name: 'Renamed' })
  check(
    'updateProvider (normalizeProvider) مقدار دستی را پاک نکرد',
    providerOf(customId).manualContextMap?.['my-model'] === 64000,
    providerOf(customId).manualContextMap,
  )
}
{
  // فچ موفق: کاتالوگ زنده میآید ولی مدل دستی و مقدار دستیاش میمانند.
  const res = await fetchAndPersist(providerOf(customId), {
    fetchFn: async () => ({
      models: ['catalog-model'],
      context: { 'catalog-model': 200000 },
      pricing: {},
      reasoning: {},
    }),
    store: { getState: () => useStore.getState() },
  })
  const p = providerOf(customId)
  check('فچ موفق انجام شد', res.ok === true, res)
  check('مدل دستی پس از فچ موفق ماند', (p.addedModels ?? []).includes('my-model'), p.addedModels)
  check('مقدار دستی پس از فچ موفق ماند', p.manualContextMap?.['my-model'] === 64000, p.manualContextMap)
  check('متر همچنان مقدار دستی را میدهد', modelContextWindow(p, 'my-model') === 64000)
}
{
  // فچ ناموفق: ndata ذخیرهشده دست نمیخورد.
  const res = await fetchAndPersist(providerOf(customId), {
    fetchFn: async () => {
      throw new Error('gateway unreachable')
    },
    store: { getState: () => useStore.getState() },
  })
  const p = providerOf(customId)
  check('فچ ناموفق گزارش شد', res.ok === false, res)
  check('مقدار دستی پس از فچ ناموفق ماند', p.manualContextMap?.['my-model'] === 64000, p.manualContextMap)
  check('متر پس از فچ ناموفق مقدار دستی را میدهد', modelContextWindow(p, 'my-model') === 64000)
}

// ---------------------------------------------------------------------------
console.log('\n۴) ویرایش و حذف مقدار دستی هر مدل:')
{
  // فچ موفق قبلی contextMap را با کاتالوگ زنده جایگزین کرده؛ برای اینکه
  // fallback بعد از حذف مقدار دستی قطعی باشد، دوباره مقدار زنده می‌گذاریم.
  useStore.getState().setProviderContextMap(customId, { 'my-model': 128000 })
  useStore.getState().setManualModelContext(customId, 'my-model', 32000)
  check('ویرایش مقدار دستی', providerOf(customId).manualContextMap?.['my-model'] === 32000)
  check('مقدار ویرایش‌شده بر مقدار زنده اولویت دارد', modelContextWindow(providerOf(customId), 'my-model') === 32000)
}
{
  useStore.getState().setManualModelContext(customId, 'my-model', null)
  const p = providerOf(customId)
  check('null مقدار دستی را حذف میکند', p.manualContextMap?.['my-model'] === undefined, p.manualContextMap)
  check('بعد از حذف، مقدار زندهی contextMap برمیگردد', modelContextWindow(p, 'my-model') === 128000)
}
{
  useStore.getState().removeManualModel(customId, 'my-model')
  const p = providerOf(customId)
  check('مدل از addedModels حذف شد', !(p.addedModels ?? []).includes('my-model'), p.addedModels)
  check('مدل از models حذف شد', !(p.models ?? []).includes('my-model'), p.models)
}

// ---------------------------------------------------------------------------
console.log('\n۵) پروایدرهای غیرکاستوم: ورودی دستی اثری ندارد (رفتار قبلی حفظ میشود):')
{
  const builtinId = useStore.getState().settings.providers.find((p) => p.kind === 'nvidia')?.id
  if (!builtinId) {
    check('پروایدر nvidia پیشفرض موجود است', false)
  } else {
    // SettingsModal فقط وقتی cfg.kind === 'custom' است عدد را پاس میدهد؛
    // اینجا همان مسیر غیرکاستوم شبیهسازی میشود.
    useStore.getState().addManualModel(builtinId, 'nvidia-only-model', 64000)
    const p = providerOf(builtinId)
    check('برای kind غیرکاستوم مقدار دستی ثبت نشد', p.manualContextMap?.['nvidia-only-model'] === undefined, p.manualContextMap)
    useStore.getState().setManualModelContext(builtinId, 'nvidia-only-model', 32000)
    check(
      'setManualModelContext برای kind غیرکاستوم بی‌اثر است',
      providerOf(builtinId).manualContextMap?.['nvidia-only-model'] === undefined,
    )
    check(
      'متر از contextMap زنده استفاده میکند (نه مقدار دستی)',
      modelContextWindow({ ...p, contextMap: { 'nvidia-only-model': 131072 } }, 'nvidia-only-model') === 131072,
    )
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تستهای کانتکست دستی مدل کاستوم پاس شدند')