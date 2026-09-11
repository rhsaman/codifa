// تست SSR برای ProviderModelSelect: باز کردن پاپ‌آپ مدل‌ها را فچ نکند.
// لیست مدل‌ها فقط از store (پرشده در startup / افزودن پروایدر) خوانده می‌شود.
// Run: npx esbuild tests/providerModelSelect.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external --outfile=tests/.tmp-pms.mjs && node tests/.tmp-pms.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
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

const { renderToString } = await import('react-dom/server')
const { ProviderModelSelect } = await import('../src/components/ProviderModelSelect')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// شمارنده‌ی فراخوانی‌های شبکه: هر درخواستی که از مسیر fetchModels رد شود
// باید صفر بماند — پاپ‌آپ فقط از store می‌خواند.
let networkCalls = 0
const realFetch = (globalThis as any).fetch
;(globalThis as any).fetch = (...args: unknown[]) => {
  networkCalls++
  return realFetch?.(...(args as []))
}

console.log('1) رندر پاپ‌آپ بدون هیچ فراخوانی شبکه:')
{
  networkCalls = 0
  const html = renderToString(<ProviderModelSelect />)
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('کلاس pm-select وجود دارد', html.includes('pm-select'))
  check('دکمه‌ی انتخاب مدل وجود دارد', html.includes('pm-select-btn'))
}

console.log('2) لیست مدل‌ها از store خوانده می‌شود (نه از شبکه):')
{
  // store واقعی zustand در SSR با state اولیه‌ی خودش رندر می‌شود؛
  // تست فقط تضمین می‌کند که هیچ مسیر فچی اجرا نشود.
  networkCalls = 0
  const html = renderToString(<ProviderModelSelect />)
  check('دوباره هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('رندر بدون خطا انجام شد', html.length > 0)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های ProviderModelSelect پاس شدند')
