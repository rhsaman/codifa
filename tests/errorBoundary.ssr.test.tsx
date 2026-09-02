// SSR sanity test for ErrorBoundary.
// Note: getDerivedStateFromError is NOT called during renderToString (SSR).
// Error boundary catching only works in client-side (hydrate/render) mode.
// So we only test the happy path here.

const { renderToString } = await import('react-dom/server')
const { ErrorBoundary } = await import('../src/components/ErrorBoundary')
const { createElement: h } = await import('react')

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
{
  const html = renderToString(
    h(ErrorBoundary, null, h('div', null, 'hello child'))
  )
  check('child رندر شده', html.includes('hello child'))
  check('بدون پیام خطا', !html.includes('Something went wrong'))
  check('بدون دکمه Try again', !html.includes('Try again'))
}

console.log('2) children چندگانه:')
{
  const html = renderToString(
    h(ErrorBoundary, null,
      h('span', null, 'one'),
      h('span', null, 'two'),
    )
  )
  check('child اول رندر شده', html.includes('one'))
  check('child دوم رندر شده', html.includes('two'))
}

console.log('3) class component structure:')
{
  // Verify ErrorBoundary is a proper React class component
  check('getDerivedStateFromError وجود دارد', typeof ErrorBoundary.getDerivedStateFromError === 'function')
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های ErrorBoundary پاس شدند')
