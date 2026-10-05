// SSR sanity test for WebResultLinks / FileResultLinks (run via test/run-frontend.sh).
// Mock the Electron bridge before importing the store.
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
const { WebResultLinks, FileResultLinks } = await import('../src/components/ToolCallView')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const items = [
  {
    title: 'مستندات React',
    url: 'https://react.dev/learn',
    snippet: 'یادگیری مفاهیم پایهٔ React با مثال‌های عملی.',
  },
  {
    title: 'GitHub',
    url: 'https://github.com/facebook/react',
    snippet: 'مخزن رسمی کتابخانهٔ React روی گیت‌هاب.',
  },
] as never

console.log('1) رندر لینک‌ها با محتوا:')
let html = ''
try {
  html = renderToString(<WebResultLinks items={items} />)
  check('رندر شد', html.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}

console.log('2) لینک‌ها و متادیتا درست رندر شده‌اند:')
check('href اول', html.includes('href="https://react.dev/learn"'), html.slice(0, 600))
check('عنوان اول', html.includes('مستندات React'))
check('href دوم', html.includes('href="https://github.com/facebook/react"'))
check('عنوان دوم', html.includes('GitHub'))
check('snippet اول', html.includes('یادگیری مفاهیم پایه'))
check('کلاس لیست', html.includes('web-results'))
check('کلاس لینک', html.includes('web-result-link'))
check('نمایش host (react.dev)', html.includes('react.dev'))
check('target=_blank', html.includes('target="_blank"'))

console.log('3) لیست خالی → خروجی خالی (بدون خطا):')
try {
  const empty = renderToString(<WebResultLinks items={[] as never} />)
  check('خروجی خالی است', empty === '')
} catch (e) {
  check('خروجی خالی است', false, e)
}

console.log('4) FileResultLinks: نتایج grep/glob مسیر فایل نمایش می‌دهند (نه آیکون لینک):')
const fileItems = [
  { file: 'src/foo.ts', line: 12, text: 'const x = 1' },
  { file: 'src/bar.ts', line: 40, text: 'export function y() {}' },
] as never
let fileHtml = ''
try {
  fileHtml = renderToString(<FileResultLinks tool="grep" items={fileItems} />)
  check('رندر شد', fileHtml.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}
check('مسیر فایل اول', fileHtml.includes('src/foo.ts'))
check('شماره خط اول (src/foo.ts ... :12)', fileHtml.includes('src/foo.ts') && fileHtml.includes(':12'))
check('مسیر فایل دوم', fileHtml.includes('src/bar.ts') && fileHtml.includes(':40'))
check('متن خط نمایش داده شد', fileHtml.includes('const x = 1'))
check('کلاس لیست فایل', fileHtml.includes('file-results'))
check('کلاس آیتم فایل', fileHtml.includes('file-result'))
check('آیکون لینک وب (🔗) نمایش داده نشد', !fileHtml.includes('🔗'))
check('کلاس لینک وب (web-result-link) نمایش داده نشد', !fileHtml.includes('web-result-link'))

console.log('4b) چیپ فایل: آیکن همیشه سمت چپ مسیر است — در RTL و LTR (dir=ltr):')
{
  const chipIdx = fileHtml.indexOf('class="file-chip"')
  check('چیپ فایل رندر شد', chipIdx >= 0, fileHtml.slice(0, 400))
  check('dir=ltr دارد (آیکن در RTL هم سمت چپ می‌ماند)',
    fileHtml.indexOf('dir="ltr"') >= 0)
  // title حاوی نام فایل است و قبل از آیکن می‌آید؛ بعد از file-chip-name بگرد.
  const nameIdx = fileHtml.indexOf('file-chip-name', chipIdx)
  check('نام مسیر داخل file-chip-name است', nameIdx > chipIdx,
    fileHtml.slice(chipIdx, chipIdx + 300))
  const iconChunk = fileHtml.slice(chipIdx, nameIdx > 0 ? nameIdx : fileHtml.length)
  check('آیکن svg قبل از نام مسیر رندر شده است',
    nameIdx > chipIdx && iconChunk.includes('<svg'), iconChunk.slice(0, 200))
  check('متن مسیر بعد از آیکن می‌آید',
    nameIdx > 0 && fileHtml.indexOf('src/foo.ts', nameIdx) > nameIdx)
}

console.log('4c) آیکون فایل: نشان برند هر زبان (بدون گرادیان/متن DOM بیرون svg):')
{
  const { FileIcon } = await import('../src/components/FileIcon')
  const tsxHtml = renderToString(<FileIcon path="src/App.tsx" size={16} />)
  check('اتم React برای tsx رندر شد', tsxHtml.includes('file-icon-svg') && tsxHtml.includes('#61dafb'), tsxHtml.slice(0, 300))
  const tsHtml = renderToString(<FileIcon path="src/lib/store.ts" size={16} />)
  check('مونوگرام TS داخل svg است', tsHtml.includes('>TS<'), tsHtml.slice(0, 300))
  check('بدون گرادیان defs (بدون تداخل id)', !tsxHtml.includes('<linearGradient') && !tsxHtml.includes('<defs'))
  const pyHtml = renderToString(<FileIcon path="backend/agents.py" size={16} />)
  check('لوگوی Python برای py رندر شد', pyHtml.includes('#3776ab') && pyHtml.includes('#ffd43b'), pyHtml.slice(0, 300))
  const imgHtml = renderToString(<FileIcon path="a/photo.png" size={16} />)
  check('آیکون تصویری تایل رنگی دارد', imgHtml.includes('#a074c4'))
  const unknownHtml = renderToString(<FileIcon path="README" size={16} />)
  check('پسوند ناشناخته: آیکون خنثی بدون تایل رنگی', !unknownHtml.includes('#a074c4') && unknownHtml.includes('<svg'))
  const dockerHtml = renderToString(<FileIcon path="Dockerfile" size={16} />)
  check('Dockerfile بدون پسوند: تایل DK', dockerHtml.includes('>DK<'))
}

console.log('5) FileResultLinks: آیتم glob (فقط path، بدون line/text) درست رندر می‌شود:')
const globItems = [{ path: 'src/components/Baz.tsx' }] as never
let globHtml = ''
try {
  globHtml = renderToString(<FileResultLinks tool="glob" items={globItems} />)
  check('رندر شد', globHtml.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}
check('مسیر glob نمایش داده شد', globHtml.includes('src/components/Baz.tsx'))
check('بدون شماره خط اضافه', !globHtml.includes('src/components/Baz.tsx:'))

console.log('6) FileResultLinks: لیست خالی → خروجی خالی (بدون خطا):')
try {
  const empty = renderToString(<FileResultLinks tool="grep" items={[] as never} />)
  check('خروجی خالی است', empty === '')
} catch (e) {
  check('خروجی خالی است', false, e)
}

console.log('7) FileResultLinks: فقط ۳ مورد اول نمایش داده می‌شود و بقیه truncate می‌شوند:')
const manyItems = Array.from({ length: 8 }, (_, i) => ({
  file: `src/module_${i}.ts`,
  line: i + 1,
  text: `const v${i} = ${i}`,
})) as never
let manyHtml = ''
try {
  manyHtml = renderToString(<FileResultLinks tool="grep" items={manyItems} />)
  check('رندر شد', manyHtml.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}
check('مورد اول نمایش داده شد', manyHtml.includes('src/module_0.ts'))
check('مورد سوم نمایش داده شد', manyHtml.includes('src/module_2.ts'))
check('مورد چهارم (module_3) نمایش داده نشد', !manyHtml.includes('src/module_3.ts'))
check('خط truncate (more) نمایش داده شد', manyHtml.includes('more'))
check('تعداد محدود (۳ آیتم + ۱ more) رعایت شد', (manyHtml.match(/class="file-result"/g) || []).length === 3)

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
