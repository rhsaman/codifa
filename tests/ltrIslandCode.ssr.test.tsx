// SSR sanity for the LTR island around a split inline-code chip + URL link
// (mdComponents.code): "/plugin install https://…" must render as ONE
// dir=ltr island so an RTL line keeps the command in left-to-right order.
// Run via tests/run-frontend.sh.
import React from 'react'
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
const { mdComponents } = await import('../src/components/ChatMessage')
const Code = (mdComponents as any).code as React.FC<any>

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const cmd = '/plugin install https://github.com/mnemox-ai/tradememory-plugin.git'

console.log('1) inline code با URL → یک جزیره dir=ltr دور چیپ+لینک:')
{
  const html = renderToString(<Code>{cmd}</Code>)
  check('ltr-island span هست', html.includes('ltr-island'), html.slice(0, 220))
  check('dir="ltr" روی جزیره', /<span[^>]*dir="ltr"[^>]*class="ltr-island"|<span[^>]*class="ltr-island"[^>]*dir="ltr"/.test(html), html.slice(0, 220))
  check('چیپ code داخل جزیره', /ltr-island[\s\S]*?<code[^>]*>[\s\S]*?plugin install/.test(html))
  check('لینک a داخل جزیره', /ltr-island[\s\S]*?<a [^>]*href="https:\/\/github\.com\/mnemox-ai\/tradememory-plugin\.git"/.test(html))
  check('URL متن لینک حاضر است', html.includes('>https://github.com/mnemox-ai/tradememory-plugin.git<'))
}

console.log('2) inline code فقط-URL → لینک تنها، بدون جزیره (CSS خودش isolate می‌کند):')
{
  const html = renderToString(<Code>{'https://github.com/x/y.git'}</Code>)
  check('بدون ltr-island', !html.includes('ltr-island'), html.slice(0, 200))
  check('لینک رندر شد', html.includes('<a '), html.slice(0, 200))
}

console.log('3) inline code بدون URL → چیپ ساده (بدون جزیره):')
{
  const html = renderToString(<Code>{'/plugin install wshobson/agents'}</Code>)
  check('بدون ltr-island', !html.includes('ltr-island'), html.slice(0, 200))
  check('چیپ code رندر شد', html.includes('<code'), html.slice(0, 200))
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks`)
  process.exit(1)
}
console.log('\nAll ltrIslandCode SSR checks passed')
