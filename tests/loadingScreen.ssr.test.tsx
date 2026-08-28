// SSR sanity test for LoadingScreen error/retry state.
// Run: npx esbuild test/loadingScreen.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external --outfile=test/.tmp-ls.mjs && node test/.tmp-ls.mjs
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
const { LoadingScreen } = await import('../src/components/LoadingScreen')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) حالت عادی (بدون خطا):')
const okHtml = renderToString(<LoadingScreen />)
check('role=status', okHtml.includes('role="status"'))
check('نشانگر لودینگ', okHtml.includes('Loading workspace'))
check('بدون دکمه Retry', !okHtml.includes('Retry'))
check('بدون پیام خطا', !okHtml.includes('Failed to load'))

console.log('2) حالت خطا با Retry:')
const errHtml = renderToString(
  <LoadingScreen error="sidecar not reachable" onRetry={() => {}} />,
)
check('role=alert', errHtml.includes('role="alert"'))
check('پیام خطا', errHtml.includes('Failed to load your data'))
check('جزئیات خطا', errHtml.includes('sidecar not reachable'))
check('دکمه Retry', errHtml.includes('Retry'))

console.log('3) حالت خطا بدون onRetry → بدون دکمه:')
const noRetryHtml = renderToString(<LoadingScreen error="boom" />)
check('بدون دکمه Retry', !noRetryHtml.includes('Retry'))

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')