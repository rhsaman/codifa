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

console.log('2) نشانگر Working (ایجنت مشغول ولی think نمی‌کند):')
{
  const html = renderToString(<ThinkingIndicator label="Working" />)
  check('رندر شد', html.length > 0)
  check('کلاس msg-thinking دارد', html.includes('msg-thinking'))
  check('متن Working نمایش داده شد', html.includes('Working'))
  check('متن Thinking ندارد', !html.includes('>Thinking<'))
  check('۳ نقطه لودینگ دارد (.msg-thinking-dots)', html.includes('msg-thinking-dots'))
  const dotCount = (html.match(/<span class="dot"/g) || []).length
  check('دقیقاً ۳ نقطه (.dot) دارد', dotCount === 3, dotCount)
  check('aria-label برابر Working است', html.includes('aria-label="Working"'))
}

console.log('3) تایمر Working از startedAt محاسبه می‌شود (مقاوم در برابر تعویض چت):')
{
  // ۶۵ ثانیه قبل — بدون startedAt تایمر از صفر شروع می‌شد (۰ms)، با startedAt
  // باید «1m 5s» نمایش داده شود حتی بعد از unmount/remount (تعویض چت).
  const startedAt = Date.now() - 65_000
  const html = renderToString(<ThinkingIndicator label="Working" startedAt={startedAt} />)
  const elapsed = html.match(/msg-thinking-elapsed[^>]*>([^<]+)</)?.[1] ?? ''
  check('تایمر ≈ 1m 5s است (نه 0ms)', /^1m\s*5s$/.test(elapsed.trim()), elapsed)
  const fresh = renderToString(<ThinkingIndicator label="Working" startedAt={Date.now() - 300} />)
  const freshElapsed = fresh.match(/msg-thinking-elapsed[^>]*>([^<]+)</)?.[1] ?? ''
  check('startedAt تازه → تایمر زیر ۱ ثانیه', /^\d+m?s/.test(freshElapsed.trim()), freshElapsed)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
