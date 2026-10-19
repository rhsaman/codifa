// Test for the native-error reader in src/lib/api.ts.
//
// The Commit button above the composer used to report only
// "autocommit failed (400)": the native routes answered a plain-text body but
// the renderer read `body.detail`, so the real cause (e.g. "nothing to
// commit", or a provider rejection) never reached the UI. These cases pin the
// reader that now surfaces it, for both body shapes.
// Run: npx esbuild tests/gitApiError.test.ts --bundle --platform=node --format=esm \
//        --packages=external --external:electron --outfile=test/.tmp-ge.mjs \
//        && node test/.tmp-ge.mjs

;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: {
    getSidecarUrl: async () => 'http://127.0.0.1:8899',
    onSidecarChanged: () => () => {},
    onSidecarDead: () => () => {},
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// fetch mock: the route under test answers whatever the current case sets.
let nextResponse: Response = new Response('', { status: 200 })
let lastUrl = ''
let lastBody: unknown = null
;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  if (url.endsWith('/health')) return new Response('', { status: 200 })
  lastUrl = url
  if (init?.body) lastBody = JSON.parse(String(init.body))
  return nextResponse
}

const { gitAutoCommit, gitPush } = await import('../src/lib/api.ts')

console.log('۱) بدنه‌ی JSON با detail → همان پیام نمایش داده می‌شود:')
{
  nextResponse = new Response(JSON.stringify({ detail: 'nothing to commit' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
  const res = await gitAutoCommit('/tmp/repo', {
    kind: 'custom',
    model: 'm',
    baseUrl: 'https://x/v1',
    apiKeys: ['k'],
  })
  check('پیام واقعی برگردانده شد', 'error' in res && res.error === 'nothing to commit', res)
  check('به مسیر autocommit زده شد', lastUrl.endsWith('/git/autocommit'), lastUrl)
}

console.log('۲) بدنه‌ی متن ساده (مسیرهای قدیمی/خطای JSON) → خود متن پیام است:')
{
  nextResponse = new Response('invalid project root', { status: 400 })
  const res = await gitAutoCommit('/tmp/repo', {
    kind: 'custom',
    model: 'm',
    baseUrl: 'https://x/v1',
    apiKeys: ['k'],
  })
  check('متن ساده نمایش داده شد', 'error' in res && res.error === 'invalid project root', res)
}

console.log('۳) بدنه‌ی JSON با کلید error → همان کلید خوانده می‌شود:')
{
  nextResponse = new Response(JSON.stringify({ error: 'disk full' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
  const res = await gitPush('/tmp/repo')
  check('کلید error پشتیبانی می‌شود', 'error' in res && res.error === 'disk full', res)
}

console.log('۴) بدنه‌ی خالی → پیام عمومی با کد وضعیت باقی می‌ماند:')
{
  nextResponse = new Response('', { status: 400 })
  const res = await gitPush('/tmp/repo')
  check('پیام عمومی درست است', 'error' in res && res.error === 'push failed (400)', res)
}

console.log('۵) پاسخ موفق → نتیجه parse می‌شود (خطا ساخته نمی‌شود):')
{
  nextResponse = new Response(JSON.stringify({ commit: 'abc123', summary: 'ok', message: 'feat: x' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  const res = await gitAutoCommit('/tmp/repo', {
    kind: 'custom',
    model: 'm',
    baseUrl: 'https://x/v1',
    apiKeys: ['k'],
  })
  check('نتیجه‌ی موفق برگشت', 'commit' in res && res.commit === 'abc123', res)
  check(
    'provider/kind و model در بدنه ارسال شد',
    (lastBody as any)?.provider === 'custom' && (lastBody as any)?.model === 'm',
    lastBody,
  )
}

if (failed > 0) {
  console.error(`\n❌ ${failed} تست شکست خورد`)
  process.exit(1)
}
console.log('\n✅ همهٔ تست‌های gitApiError پاس شدند')
