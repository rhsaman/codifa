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

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های SettingsModal (بدون فچ) پاس شدند')
