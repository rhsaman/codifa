// SSR sanity test for ReadingMode (run: npx esbuild ... && node ...)
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
const { ReadingMode } = await import('../src/components/ReadingMode')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const message = {
  id: 'm1',
  role: 'assistant',
  content: '## بخش الف\n\nمتن الف\n\n## بخش ب\n\nمتن ب',
  createdAt: Date.now(),
} as never

console.log('1) رندر SSR بدون خطا:')
let html = ''
try {
  html = renderToString(<ReadingMode message={message} onClose={() => {}} />)
  check('رندر شد', html.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}

console.log('2) محتوای مودال درست است:')
check('تیتر بخش اول در فهرست', html.includes('بخش الف'), html.slice(0, 400))
check('تیتر بخش دوم در فهرست', html.includes('بخش ب'))
check('متن بخش فعال رندر شده', html.includes('متن الف'))
check('دکمه سوال حذف شده', !html.includes('Ask about this section'))
check('کلاس مودال', html.includes('reading-mode'))

console.log('3) پیام بدون بخش → null (بدون خطا):')
try {
  const empty = renderToString(
    <ReadingMode message={{ id: 'm2', role: 'assistant', content: 'بدون تیتر', createdAt: Date.now() } as never} onClose={() => {}} />,
  )
  check('خروجی خالی است', empty === '')
} catch (e) {
  check('خروجی خالی است', false, e)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')