// تست SSR برای SettingsModal: باز کردن مودال تنظیمات (شامل پیکر مدل subagent)
// نباید هیچ فچ شبکه‌ای انجام دهد — لیست مدل‌ها فقط از store خوانده می‌شود
// (پرشده در startup / افزودن پروایدر).
// Run: npx esbuild tests/settingsNoFetch.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external \
//        --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
//        --outfile=tests/.tmp-snf.mjs --external:electron && node tests/.tmp-snf.mjs
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
const { SettingsModal } = await import('../src/components/SettingsModal')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// شمارنده‌ی فراخوانی‌های شبکه: رندر مودال (هر تب) نباید هیچ درخواستی بزند.
let networkCalls = 0
const realFetch = (globalThis as any).fetch
;(globalThis as any).fetch = (...args: unknown[]) => {
  networkCalls++
  return realFetch?.(...(args as []))
}

console.log('1) رندر مودال تنظیمات بدون هیچ فراخوانی شبکه:')
{
  networkCalls = 0
  const html = renderToString(<SettingsModal onClose={() => {}} />)
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('رندر بدون خطا انجام شد', html.length > 0)
}

console.log('2) تب Providers (پیکر مدل subagent) بدون فچ:')
{
  networkCalls = 0
  const html = renderToString(<SettingsModal onClose={() => {}} initialTab="providers" />)
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
  check('رندر بدون خطا انجام شد', html.length > 0)
}

console.log('3) تب Tools: لیبل مدل ابزارها اسم پراویدر است نه id/kind خام:')
{
  const { toolModelLabel } = await import('../src/components/SettingsModal')
  const { useStore } = await import('../src/lib/store')
  const s = useStore.getState()
  useStore.setState({
    settings: {
      ...s.settings,
      providers: [
        {
          id: 'custom-abc123',
          name: 'justwoker',
          kind: 'custom',
          apiKey: '',
          baseUrl: 'http://localhost:8080/v1',
          model: 'main-m',
          pricingMap: {},
        },
      ],
    },
    subagentModels: {
      // مقدار جدید: پیشوند id پراویدر
      web: 'custom-abc123/my-model',
      // مقدار قدیمی: پیشوند kind (قبل از id های صریح)
      vision: 'custom/legacy-model',
    },
  })
  const st = useStore.getState()
  const providers = st.settings.providers
  // تست مستقیم تابع خالص لیبل (در SSR رندر React از getServerSnapshot
  // استفاده می‌کند و state seed شده را نمی‌بیند — به همین دلیل تست‌های SSR
  // قبلی فقط «بدون فچ» را چک می‌کردند).
  check(
    'لیبل مقدار جدید: justwoker/my-model',
    toolModelLabel('custom-abc123/my-model', providers) === 'justwoker/my-model',
  )
  check(
    'لیبل مقدار قدیمی (kind): justwoker/legacy-model',
    toolModelLabel('custom/legacy-model', providers) === 'justwoker/legacy-model',
  )
  check('پیشوند تکراری جمع می‌شود', toolModelLabel('custom-abc123/custom-abc123/my-model', providers) === 'justwoker/my-model')
  check('مقدار خالی → Main model', toolModelLabel('', providers) === 'Main model')
  check('id ناشناخته به‌صورت خام برمی‌گردد', toolModelLabel('other/m', providers) === 'other/m')
  check('هیچ درخواست شبکه‌ای انجام نشد', networkCalls === 0, networkCalls)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های SettingsModal (بدون فچ) پاس شدند')
