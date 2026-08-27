// SSR sanity test for the web-search provider badge (run via test/run-frontend.sh).
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
const { ToolSingleRow } = await import('../src/components/ToolCallView')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const activity = {
  tool: 'web_search',
  engine: 'tavily',
  status: 'success',
} as never

console.log('1) badge پروایدر وب‌سرچ رندر می‌شود:')
let html = ''
try {
  html = renderToString(<ToolSingleRow activity={activity} />)
  check('رندر شد', html.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}

console.log('2) کلاس و نام پروایدر درست رندر شده‌اند:')
check('badge پروایدر کلاس tool-engine-badge دارد', html.includes('tool-engine-badge'))
check('کلاس پایه tool-badge همچنان روی آن است', html.includes('tool-badge'))
check('نام پروایدر (tavily) نمایش داده شد', html.includes('tavily'))

console.log('3) بدون engine → badge نمایش داده نمی‌شود:')
const noEngine = { tool: 'web_search', status: 'success' } as never
let html2 = ''
try {
  html2 = renderToString(<ToolSingleRow activity={noEngine} />)
  check('رندر شد', html2.length > 0)
} catch (e) {
  check('رندر شد', false, e)
}
check('بدون engine کلاس tool-engine-badge نمایش داده نشد', !html2.includes('tool-engine-badge'))

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
