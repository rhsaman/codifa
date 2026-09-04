// SSR sanity test for SettingsModal → Storage tab (Data & maintenance + TTL).
// Run: npx esbuild test/settingsStorage.ssr.test.tsx --bundle --platform=node --format=esm
//   --jsx=automatic --packages=external
//   --alias:highlight.js/styles/github-dark.min.css=./test/css-stub.js
//   --outfile=test/.tmp-set.mjs --external:electron >/dev/null 2>&1 && node test/.tmp-set.mjs

// Mock the Electron bridge + api before importing the store/component.
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

// رندر کل مودال (تب پیش‌فرض storage نیست — ولی بخش‌های مهم رو چک می‌کنیم)
console.log('1) رندر SSR بدون خطا (تب Storage):')
let html = ''
try {
  html = renderToString(<SettingsModal onClose={() => {}} initialTab="storage" />)
  check('رندر شد', html.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}

console.log('2) بخش Data & maintenance سالم است (خراب نشده):')
check('عنوان Data & maintenance', html.includes('Data &amp; maintenance') || html.includes('Data & maintenance'))
check('فیلد Data path', html.includes('Data path'))
check('دکمه Apply & move data', html.includes('Apply &amp; move data') || html.includes('Apply & move data'))

console.log('3) تنظیمات TTL ذخیره‌سازی در Storage هست:')
check('RAG web/fetch storage TTL', html.includes('RAG web/fetch storage TTL') || html.includes('RAG web/fetch storage TTL'.toLowerCase()))
check('مقدار پیش‌فرض ۹۰ روز (RAG)', html.includes('Default: <code>90</code> days'))
check('Cache TTL', html.includes('Cache TTL'))

console.log('4) تب Storage وجود دارد:')
check('تب Storage', html.includes('Storage'))

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
