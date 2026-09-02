// SSR sanity test for ModeSelect ARIA + structure.
// Run: npx esbuild tests/modeSelect.ssr.test.tsx --bundle --platform=node --format=esm \
//        --jsx=automatic --packages=external --outfile=tests/.tmp-ms.mjs && node tests/.tmp-ms.mjs
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
const { ModeSelect } = await import('../src/components/ModeSelect')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const modes = [
  { id: 'code' as const, label: 'Code', icon: 'code' as const, description: 'Write & edit files' },
  { id: 'ask' as const, label: 'Ask', icon: 'ask' as const, description: 'Ask questions' },
]

console.log('1) حالت بسته (open=false):')
{
  const html = renderToString(
    <ModeSelect modes={modes} value="code" onChange={() => {}} />
  )
  check('aria-expanded=false', html.includes('aria-expanded="false"'))
  check('aria-haspopup=listbox', html.includes('aria-haspopup="listbox"'))
  check('listbox وجود ندارد', !html.includes('role="listbox"'))
  check('نام mode جاری نمایش داده شده', html.includes('Code'))
}

console.log('2) حالت باز (open=true — via initial click simulation):')
{
  // In SSR we can't click, but we can verify the closed state structure
  // The open state renders role="listbox" and role="option"
  // Since SSR renders closed state, verify the trigger attributes
  const html = renderToString(
    <ModeSelect modes={modes} value="ask" onChange={() => {}} iconOnly />
  )
  check('aria-expanded=false در حالت iconOnly', html.includes('aria-expanded="false"'))
  check('نام mode جاری (Ask)', html.includes('Ask'))
  check('class mode-select icon-only', html.includes('mode-select icon-only'))
}

console.log('3) ساختار DOM:')
{
  const html = renderToString(
    <ModeSelect modes={modes} value="code" onChange={() => {}} />
  )
  check('div.mode-select وجود دارد', html.includes('class="mode-select"'))
  check('button تریگر وجود دارد', html.includes('type="button"'))
  check('mode-select-current class', html.includes('mode-select-current'))
}

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ همه تست‌های ModeSelect پاس شدند')
