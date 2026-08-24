// SSR sanity test for ThinkingIndicator (run via test/run-frontend.sh).
// Covers the new thinking indicator shown in the message footer row:
//  - renders the "Thinking" label
//  - renders 3 loading dots (no ✦ spark, no spinner)
//  - dots are inside .msg-thinking-dots (fill from the right)
//  - order is Thinking → dots → timer (dots between text and timer)
// Mock the Electron bridge before importing the component.
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
const { ThinkingIndicator } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) نشانگر Thinking رندر می‌شود:')
{
  const html = renderToString(<ThinkingIndicator />)
  check('رندر شد', html.length > 0)
  check('کلاس msg-thinking دارد', html.includes('msg-thinking'))
  check('متن Thinking نمایش داده شد', html.includes('Thinking'))
  check('۳ نقطه لودینگ دارد (.msg-thinking-dots)', html.includes('msg-thinking-dots'))
  check('هیچ آیکون ✦ ندارد', !html.includes('✦'))
  check('هیچ spinner ندارد', !html.includes('spinner'))
  // 3 dots (only one dots wrapper exists in the output)
  const dotCount = (html.match(/<span class="dot"/g) || []).length
  check('دقیقاً ۳ نقطه (.dot) دارد', dotCount === 3, dotCount)
  // order: text → dots → elapsed timer (dots between text and timer)
  const textIdx = html.indexOf('msg-thinking-text')
  const dotsIdx = html.indexOf('msg-thinking-dots')
  const elapsedIdx = html.indexOf('msg-thinking-elapsed')
  check(
    'ترتیب: متن → نقطه‌ها → تایمر',
    textIdx > -1 && dotsIdx > textIdx && elapsedIdx > dotsIdx,
    { textIdx, dotsIdx, elapsedIdx },
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
