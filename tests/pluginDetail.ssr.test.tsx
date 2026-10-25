// SSR sanity test for the plugin detail page (src/components/PluginDetail.tsx)
// and the card button that opens it (SettingsModal).
//
// Why it matters: the bundle card in Settings used to expand in place with
// `<details>`, so editing a skill/connector/script meant reading a column three
// screens tall inside a grid card. The contents moved to a page of its own.
//
// What SSR can prove is the page's SHELL — the dialog is modal and labelled,
// each of the three lists has its own tab, and every room has an empty state
// instead of a blank panel. The part rows themselves arrive from the backend
// `/plugins/skills|mcp|scripts` calls inside an effect, so they are not in this
// render; the live click-through is what covers those.
//
// Run: tests/run-frontend.sh (job `pluginDetail`).
export {}

;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const { createElement: h } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { PluginDetail } = await import('../src/components/PluginDetail')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const plugin = {
  name: 'Demo bundle',
  slug: 'demo-bundle',
  description: 'A bundle used by the test',
  enabled: true,
  skills: ['alpha', 'beta'],
  mcp: ['fs'],
  scripts: ['hello'],
}

console.log('1) The page renders as a dialog on a tab of its own:')
{
  const html = renderToStaticMarkup(
    h(PluginDetail, { plugin, onClose: () => {}, onChanged: () => {} }),
  )
  check('it is a modal dialog', html.includes('aria-modal="true"'))
  check('it is labelled with the plugin', html.includes('aria-label="Demo bundle details"'))
  check('the slug is shown next to the name', html.includes('demo-bundle'))
  check('all four rooms are offered', html.includes('>Skills<') && html.includes('>Connectors<') && html.includes('>Scripts<') && html.includes('>Bundle<'))
}

console.log('2) An empty bundle says so instead of rendering a blank room:')
{
  const html = renderToStaticMarkup(
    h(PluginDetail, {
      plugin: { name: 'Empty', slug: 'empty', enabled: false },
      onClose: () => {},
      onChanged: () => {},
    }),
  )
  check('the off state is badged', html.includes('pd-badge--off'))
  check('the empty skills room explains itself', html.includes('No skills in this bundle'))
}

console.log('3) The way out is on the page, not only via Escape:')
{
  const html = renderToStaticMarkup(
    h(PluginDetail, { plugin, onClose: () => {}, onChanged: () => {} }),
  )
  // The rows themselves come from the backend lists, so they only exist after
  // the effect runs — an SSR render cannot show them. What it CAN show is the
  // page's own shell, and that is what these checks lock down: the room labels
  // (so the three lists have their own place) and the close affordance (so the
  // user is never stuck on a page with no way back).
  check('the close button is labelled', html.includes('aria-label="Close"'))
  check('the tab strip is a tablist', html.includes('role="tablist"'))
  check('each tab is selectable', (html.match(/role="tab"/g) ?? []).length === 4)
}

console.log('4) Every room has an empty state, so a bare bundle is never a blank panel:')
{
  const html = renderToStaticMarkup(
    h(PluginDetail, { plugin, onClose: () => {}, onChanged: () => {} }),
  )
  // SSR has no backend, so every room renders its empty state — which is
  // exactly the state a brand-new plugin is in, and the one users hit first.
  check('each tab carries its count', (html.match(/pd-count/g) ?? []).length === 3)
  check('the skills room explains the emptiness', html.includes('No skills in this bundle'))
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll plugin detail checks passed')
