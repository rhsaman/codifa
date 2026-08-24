// SSR sanity test for WebResultLinks (run via test/run-frontend.sh).
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
const { WebResultLinks } = await import('../src/components/ToolCallView')

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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
