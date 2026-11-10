// SSR test for the file explorer panel.
//
// Scope note: the tree is fetched by an effect, and effects never run during
// SSR — so this test covers the panel's chrome and its no-workspace state.
// (The store's server snapshot is its INITIAL state, whose `chats` are empty,
// so the root is genuinely '' here.) The tree's own logic is covered by
// tests/fileTree.test.ts and the live harness scenario.
const localStorageStub = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).localStorage = localStorageStub
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  innerWidth: 1440,
  innerHeight: 900,
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => null
      },
    },
  ),
}
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { renderToString } = await import('react-dom/server')
const { FilesPanel } = await import('../src/components/FilesPanel')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const html = renderToString(<FilesPanel />)

console.log('1) the panel chrome renders:')
check('root panel class', html.includes('files-panel'), html.slice(0, 200))
check('the panel is LTR (paths read left to right)', html.includes('dir="ltr"'))
check(
  'shares the chat list head: a filter box, no "Files" title',
  html.includes('sidebar-head') &&
    html.includes('sidebar-search-input') &&
    html.includes('Filter files') &&
    !html.includes('files-panel-title'),
  html.slice(0, 400),
)
check('has no refresh button: the tree is live', !html.includes('Refresh the file tree'))
check('does not render a tree with no workspace', !html.includes('files-list'))

console.log('2) the no-workspace state explains itself:')
check('explains that no workspace folder is open', html.includes('No workspace folder is open'))
check(
  'uses the shared viewer empty-state class',
  html.includes('viewer-empty'),
  html.slice(0, 400),
)

console.log('3) the filter box is inert without a workspace root:')
{
  const box = html.match(/<input[^>]*sidebar-search-input[^>]*>/)
  check('the filter box renders', box !== null, html.slice(0, 400))
  check('the filter box starts disabled', box?.[0].includes('disabled') === true, box?.[0])
}

export {}

if (failed > 0) {
  console.error(`filesPanel: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('filesPanel: all checks passed')
