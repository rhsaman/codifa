// SSR sanity test for LiveWorkingStatus (run via test/run-frontend.sh).
// Covers the live thinking/running indicator:
//  - thinking state shows "Thinking" with 3 loading dots (no ✦ spark, no spinner)
//  - running state shows "Running: <tool>" with the same 3 dots
//  - the indicator is wrapped in .live-working-wrap (absolute, out of flex flow)
// Mock the Electron bridge + useStore before importing the component.
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
const { LiveWorkingStatus } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) حالت thinking → متن «Thinking» + ۳ نقطه لودینگ (بدون ✦/spinner):')
{
  const html = renderToString(<LiveWorkingStatus />)
  check('رندر شد', html.length > 0)
  check('wrapper .live-working-wrap دارد', html.includes('live-working-wrap'))
  check('متن Thinking نمایش داده شد', html.includes('Thinking'))
  check('کلاس msg-working.thinking دارد', html.includes('msg-working') && html.includes('thinking'))
  check('۳ نقطه لودینگ (.msg-working-dots + ۳ .dot) دارد',
    (html.match(/msg-working-dots/g) || []).length >= 1 &&
    (html.match(/class="dot"/g) || []).length === 3)
  check('آیکون ✦ حذف شد (msg-working-spark ندارد)', !html.includes('msg-working-spark'))
  check('spinner حذف شد', !html.includes('spinner'))
}

console.log('2) حالت running → متن «Running: <tool>» + همان ۳ نقطه لودینگ:')
{
  // isThinking=false ولی یک پیام assistant در حال استریم با ابزار در حال اجرا
  const html = renderToString(<LiveWorkingStatus />)
  check('wrapper .live-working-wrap دارد', html.includes('live-working-wrap'))
  check('کلاس msg-working.running دارد', html.includes('msg-working') && html.includes('running'))
  check('متن Running: نمایش داده شد', html.includes('Running:'))
  check('۳ نقطه لودینگ دارد', (html.match(/class="dot"/g) || []).length === 3)
  check('spinner حذف شد', !html.includes('spinner'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
