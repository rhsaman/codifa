// تست واحد برای filterCodeMap — قلب منطق پنل code map.
// به همین دلیل از کامپوننت جدا export شده تا بدون render کردن React قابل
// تست باشه. الگوی اجرا مثل retry.test.ts: esbuild → node.
//   npx esbuild src/components/CodeMapPanel.test.ts --bundle --platform=node \
//     --format=esm --outfile=src/components/.tmp-codemap.mjs && \
//     node src/components/.tmp-codemap.mjs

// CodeMapPanel از useStore (از store.ts) استفاده می‌کنه که به نوبهٔ خودش
// از window.coder (در fs.ts) وابسته‌ست. در محیط Node باید window رو پیش
// از import تعریف کنیم (هم‌الگو با store.dedupe.test.ts). نکتهٔ کلیدی:
// باید از dynamic import استفاده کنیم تا esbuild اون رو به بالای فایل
// hoist نکنه (static importها قبل از window تعریف می‌شن).
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
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

import type { CodeMap } from '../types'
// dynamic import: بعد از window
const { filterCodeMap } = await import('./CodeMapPanel')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const SAMPLE: CodeMap = {
  'src/components/Sidebar.tsx': [
    { name: 'Sidebar', line: 1, kind: 'function' },
    { name: 'buildGroups', line: 56, kind: 'function' },
  ],
  'src/lib/store.ts': [
    { name: 'useStore', line: 100, kind: 'variable' },
    { name: 'toggleSidebar', line: 1309, kind: 'function' },
    { name: 'toggleCodeMapPanel', line: 1319, kind: 'function' },
  ],
  'src/components/CodeMapPanel.tsx': [
    { name: 'CodeMapPanel', line: 50, kind: 'function' },
    { name: 'fetchCodeMap', line: 20, kind: 'function' },
    { name: 'filterCodeMap', line: 32, kind: 'function' },
  ],
  'backend/server.py': [
    { name: 'get_code_map', line: 1612, kind: 'function' },
  ],
}

console.log('۱) query خالی → کل map برمی‌گرده:')
{
  const out = filterCodeMap(SAMPLE, '')
  check('همه‌ی فایل‌ها برمی‌گردن', Object.keys(out).length === 4)
  check('تعداد نمادها درسته', Object.values(out).flat().length === 9)
}

console.log('۲) query فقط فایل‌ها رو فیلتر می‌کنه:')
{
  const out = filterCodeMap(SAMPLE, 'store')
  check('src/lib/store.ts هست', 'src/lib/store.ts' in out)
  check('Sidebar.tsx حذف شد', !('src/components/Sidebar.tsx' in out))
  check('server.py حذف شد', !('backend/server.py' in out))
  check('همه‌ی نمادهای store.ts موندن (match فایل)', out['src/lib/store.ts']?.length === 3)
}

console.log('۳) query فقط روی نام نماد فیلتر می‌کنه:')
{
  const out = filterCodeMap(SAMPLE, 'toggle')
  check('store.ts با toggle*ها هست', 'src/lib/store.ts' in out)
  check('server.py نیست (هیچ toggle نداره)', !('backend/server.py' in out))
  check('دو نماد toggle تو store.ts', out['src/lib/store.ts']?.length === 2)
}

console.log('۴) case-insensitive:')
{
  const upper = filterCodeMap(SAMPLE, 'CODEMAP')
  const lower = filterCodeMap(SAMPLE, 'codemap')
  check('uppercase = lowercase', JSON.stringify(upper) === JSON.stringify(lower))
  // فایل CodeMapPanel.tsx به query match داره → کل نمادهای فایل (۳ تا) برمی‌گرده
  check('فقط فایل CodeMapPanel.tsx', Object.keys(upper).length === 1)
  check('هر سه نماد CodeMapPanel.tsx', Object.values(upper).flat().length === 3)
}

console.log('۵) query که به فایل + نماد match داره:')
{
  const out = filterCodeMap(SAMPLE, 'panel')
  check('CodeMapPanel.tsx هست', 'src/components/CodeMapPanel.tsx' in out)
  check('همه‌ی نمادهاش (match فایل)', out['src/components/CodeMapPanel.tsx']?.length === 3)
}

console.log('۶) query که هیچ match نداره:')
{
  const out = filterCodeMap(SAMPLE, 'xyznotfound')
  check('map خالی برمی‌گرده', Object.keys(out).length === 0)
}

console.log('۷) map null:')
{
  const out = filterCodeMap(null, 'anything')
  check('map خالی برمی‌گرده، crash نمی‌کنه', Object.keys(out).length === 0)
}

console.log('۸) query با فاصله trim می‌شه:')
{
  const trimmed = filterCodeMap(SAMPLE, '  store  ')
  check('نتیجه مثل query تمیز', Object.keys(trimmed).length === 1)
}

if (failed > 0) {
  console.error(`\n${failed} تست fail شد.`)
  process.exit(1)
}
console.log('\nهمه‌ی تست‌ها pass شدن ✅')
