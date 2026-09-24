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
const { ToolSingleRow, ToolGroupView } = await import('../src/components/ToolCallView')

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
check('badge پروایدر کلاس trace-row-engine دارد', html.includes('trace-row-engine'))
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
check('بدون engine کلاس trace-row-engine نمایش داده نشد', !html2.includes('trace-row-engine'))

console.log('4) badge پروایدر در ردیف سرچ گروهی هم نمایش داده می‌شود:')
let groupedHtml = ''
try {
  groupedHtml = renderToString(
    <ToolGroupView
      activities={[
        { activity: { ...activity, status: 'done' }, index: 0 },
        {
          activity: { tool: 'web_search', engine: 'duckduckgo', status: 'done' } as never,
          index: 1,
        },
      ]}
    />,
  )
  check('ردیف trace رندر شد', groupedHtml.length > 0)
} catch (e) {
  check('ردیف trace رندر شد', false, e)
}
check('هدر گروه کلاس badge پروایدر دارد', groupedHtml.includes('trace-row-engine'))
check('هدر گروه provider تِیولی را نشان می‌دهد', groupedHtml.includes('tavily'))
check('هدر گروه provider داک‌داک‌گو را هم نشان می‌دهد', groupedHtml.includes('duckduckgo'))

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
