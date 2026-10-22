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
  // Gave-up is a transient, informational line now: it says the turn stopped
  // retrying instead of naming a "limit". Dismissing stays available (the ✕
  // passed as onCancel), and Retry is not offered because the caller passed
  // none — the retries are already exhausted.
  check('متن give-up', html.includes('kept failing after retries'), html.slice(0, 300))
  check('دلیل failure نمایش داده شد', html.includes('boom'))
  check('spinner ندارد', !html.includes('spinner'))
  check('دکمه Retry ندارد', !html.includes('retry-btn'))
  check('دکمه Cancel (✕) دارد', html.includes('retry-cancel'))
  check('متن در کلاس retry-text بسته‌بندی شد', html.includes('retry-text'))
}

console.log('3b) unlimited retries (maxAttempts=0) → countdown, NOT the give-up line:')
{
  // maxAttempts <= 0 means "retry forever", so it must NOT read as a cap: the
  // inverted guard made every unlimited retry render the give-up one-liner and
  // hide the countdown it was meant to show.
  const html = renderToString(
    <RetryBanner
      attempt={3}
      maxAttempts={0}
      delay={30}
      reason="upstream hiccup"
      gaveUp={false}
      stalled={false}
      onRetry={() => {}}
    />,
  )
  check('متن give-up نمایش داده نشد', !html.includes('kept failing after retries'), html.slice(0, 300))
  check('شمارش تلاش نمایش داده شد', html.includes('attempt 3'))
  // The label and the countdown are the point of NOT treating unlimited as a
  // cap: an unlimited retry keeps the ordinary banner (a label naming WHO is
  // retrying, plus time left) instead of collapsing into the give-up line.
  check('بنر عادی با برچسب ماند', html.includes('Provider hiccup') || html.includes('Provider rate limit'), html.slice(0, 300))
  check('شمارش معکوس ماند', html.includes('retry in 30s'), html.slice(0, 300))
  check('دکمه Retry دارد', html.includes('retry-btn'))
}

console.log('4) float delay (backoff jitter) → whole seconds, no decimals:')
{
  const html = renderToString(
    <RetryBanner
      attempt={1}
      maxAttempts={10}
      delay={16.827721066797587}
      reason="upstream connection lost"
      gaveUp={false}
      stalled={false}
      onRetry={() => {}}
      onCancel={() => {}}
    />,
  )
  check('retry in 17s (rounded up)', html.includes('retry in 17s'), html.slice(0, 400))
  check('no fractional seconds shown', !html.includes('16.82'), html.slice(0, 400))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
