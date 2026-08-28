// SSR sanity test for RetryBanner (run via test/run-frontend.sh).
// Covers the unified error-notification UI:
//  - stalled (no give-up) shows "still waiting for the provider" + a Retry button
//  - rate-limit shows the countdown + Retry button
//  - gave-up shows no spinner and no Retry button
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
const { RetryBanner } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) حالت stalled (بدون give-up) → متن «still waiting» + دکمه Retry:')
{
  const html = renderToString(
    <RetryBanner
      attempt={1}
      maxAttempts={10}
      delay={30}
      reason="Still waiting for the provider…"
      gaveUp={false}
      stalled={true}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  )
  check('رندر شد', html.length > 0)
  check('کلاس retry-banner دارد', html.includes('retry-banner'))
  check('متن still waiting نمایش داده شد', html.includes('still waiting for the provider'))
  check('دکمه Retry دارد', html.includes('retry-btn') && html.includes('Retry'))
  check('spinner دارد (در حال تلاش)', html.includes('spinner'))
  check('متن در کلاس retry-text بسته‌بندی شد', html.includes('retry-text'))
}

console.log('2) حالت rate-limit → countdown + دکمه Retry:')
{
  const html = renderToString(
    <RetryBanner
      attempt={2}
      maxAttempts={10}
      delay={30}
      reason="Rate limit exceeded"
      gaveUp={false}
      stalled={false}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  )
  check('برچسب rate limit', html.includes('Provider rate limit'))
  check('دکمه Retry دارد', html.includes('retry-btn'))
  check('spinner دارد', html.includes('spinner'))
}

console.log('3) حالت gave-up → بدون spinner و بدون دکمه Retry:')
{
  const html = renderToString(
    <RetryBanner
      attempt={10}
      maxAttempts={10}
      delay={0}
      reason="boom"
      gaveUp={true}
      stalled={false}
      onCancel={() => {}}
    />,
  )
  check('برچسب give-up', html.includes('Retry limit reached'))
  check('spinner ندارد', !html.includes('spinner'))
  check('دکمه Retry ندارد', !html.includes('retry-btn'))
  check('دکمه Cancel (✕) دارد', html.includes('retry-cancel'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
