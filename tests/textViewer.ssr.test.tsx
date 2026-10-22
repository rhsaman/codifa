// SSR sanity test for TextViewerPanel: the markdown view turns backticked
// file paths into clickable file chips and renders bold/links; the raw view
// keeps a verbatim pre. Mirrors tests/readingMode.ssr.test.tsx (window stub +
// hljs css alias) since mdComponents lives in ChatMessage.
// Run: bash tests/run-frontend.sh (job "textViewer")
;(globalThis as any).window = {
  addEventListener: () => {},
  innerWidth: 1280,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
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
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { renderToString } = await import('react-dom/server')
const { TextViewerPanel } = await import('../src/components/TextViewerPanel')

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const mdBody =
  'Results:\n\n- `src/App.tsx` — entry\n- `src/lib/store.ts:12` — state\n\n**Done**'

console.log('1) markdown view — paths become clickable chips:')
let html = ''
try {
  html = renderToString(<TextViewerPanel title="glob results" body={mdBody} />)
  check('rendered', html.length > 0)
  check('toggle present', html.includes('tv-view-toggle'))
  check('MD button active by default', /tv-view-toggle[^]*?class="active"[^]*?>MD</.test(html))
  check('file chip rendered for src/App.tsx', html.includes('file-chip') && html.includes('src/App.tsx'))
  check('path:line chip keeps the line', html.includes('src/lib/store.ts:12'))
  check('bold rendered as strong', html.includes('<strong>Done</strong>'))
  check('no raw pre in md view', !html.includes('text-viewer-pre'))
} catch (err) {
  failed++
  console.error('  FAIL markdown view threw', err)
}

console.log('2) raw view — verbatim pre:')
try {
  const body = 'line one\nline two  |  pipes'
  const raw = renderToString(
    <TextViewerPanel title="Terminal output" body={body} format="text" />,
  )
  check('pre rendered', raw.includes('text-viewer-pre'))
  check('text verbatim (pipes intact)', raw.includes('line one') && raw.includes('line two  |  pipes'))
  check('Raw button active', /tv-view-toggle[^]*?class="active"[^]*?>Raw</.test(raw))
  check('no markdown strong', !raw.includes('<strong>'))
} catch (err) {
  failed++
  console.error('  FAIL raw view threw', err)
}

console.log('3) markdown links to files become chips, not navigable anchors:')
try {
  const linkBody =
    '- [foo.ts](src/foo.ts) — code path\n- [`store.ts:12`](src/lib/store.ts:12) — path with line\n- [report.pdf](report.pdf) — document\n\n[site](https://example.com) and [docs](docs) stay links'
  const linked = renderToString(<TextViewerPanel title="links" body={linkBody} />)
  check('path link rendered as a chip', linked.includes('file-chip'))
  check('path link keeps no navigable href', !linked.includes('href="src/foo.ts"'))
  check('path link chip keeps the line', linked.includes('src/lib/store.ts:12'))
  check('document link is a chip', linked.includes('report.pdf'))
  check('external link stays an anchor', linked.includes('href="https://example.com"'))
  check('plain relative link stays an anchor', linked.includes('href="docs"'))
} catch (err) {
  failed++
  console.error('  FAIL link chips threw', err)
}

console.log('4) cap note for huge bodies:')
try {
  const big = 'x'.repeat(400_001)
  const capped = renderToString(<TextViewerPanel title="Big" body={big} format="text" />)
  check('cap note shown', capped.includes('file-viewer-note'))
} catch (err) {
  failed++
  console.error('  FAIL cap view threw', err)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll textViewer checks passed')
process.exit(0)
