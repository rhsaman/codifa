// The 'files' viewer kind: persistence whitelist + the open action.
//
// Two things are locked here:
//   * BOTH kind whitelists in loadPersisted accept the new kinds — 'explore'
//     was missing from them since it was introduced, so an explore tab was
//     silently dropped on every restart. A kind the store can create but not
//     reload is worse than no persistence at all.
//   * openFiles creates exactly one chat-scoped tab and focuses the pane.
//
// Persistence is driven through the REAL load path (seeding localStorage before
// the module loads): zustand hydrates its initial state at import time, so a
// later write could never reach the store.
export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const coder = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      return async () => null
    },
  },
)

const disk = new Map<string, string>([
  [
    'coder:viewerTabs',
    JSON.stringify({
      tabs: [
        { id: 'files:c1', kind: 'files', chatId: 'c1', title: 'Files', createdAt: 200 },
        { id: 'explore:c1', kind: 'explore', chatId: 'c1', title: 'Explore', createdAt: 100 },
        // A kind that never existed must still be rejected on load, so the
        // whitelist is not accidentally widened into "accept anything".
        { id: 'bogus:c1', kind: 'bogus', chatId: 'c1', title: 'Bogus', createdAt: 50 },
      ],
      activeId: 'files:c1',
      closed: [],
    }),
  ],
])

;(globalThis as any).localStorage = {
  getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
  setItem: (k: string, v: string) => {
    disk.set(k, String(v))
  },
  removeItem: (k: string) => {
    disk.delete(k)
  },
}
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  innerWidth: 1440,
  innerHeight: 900,
  coder,
}
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {}, remove: () => {} }),
  head: { appendChild: () => {} },
}

const { useViewerTabs, viewerTabId, viewerTabTitle, visibleTabs } = await import('../src/lib/viewerTabs')

console.log('1) loadPersisted keeps the new kinds (and still rejects unknown ones):')
{
  const tabs = useViewerTabs.getState().tabs
  const kinds = tabs.map((t) => t.kind)
  check('the files tab survives a restart', kinds.includes('files'), kinds)
  check('the explore tab survives too (was silently dropped before)', kinds.includes('explore'), kinds)
  check('an unknown kind is still rejected', !kinds.includes('bogus'), kinds)
  const files = tabs.find((t) => t.kind === 'files')
  check('the files tab keeps its chat scope', files?.chatId === 'c1', files)
  check('the files tab keeps its id', files?.id === 'files:c1', files?.id)
}

console.log('2) id and title follow the shared rules:')
{
  check("viewerTabId scopes files to a chat", viewerTabId('files', 'c1') === 'files:c1', viewerTabId('files', 'c1'))
  check(
    'the files tab shows the shared kind label',
    viewerTabTitle({ kind: 'files', title: 'Files' }) === 'Files',
    viewerTabTitle({ kind: 'files', title: 'Files' }),
  )
}

console.log('3) visibility is chat-scoped:')
{
  const tabs = useViewerTabs.getState().tabs
  const mine = visibleTabs(tabs, 'c1').map((t) => t.kind)
  check('the owning chat sees its files tab', mine.includes('files'), mine)
  const other = visibleTabs(tabs, 'c2').map((t) => t.kind)
  check('another chat does not', !other.includes('files'), other)
}

console.log('4) openFiles creates one tab per chat and reveals the pane:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as any)
  useViewerTabs.getState().openFiles('c9')
  const s = useViewerTabs.getState() as any
  const created = s.tabs.filter((t: any) => t.kind === 'files')
  check('exactly one files tab was created', created.length === 1, s.tabs)
  check('it is named Files', created[0]?.title === 'Files', created[0])
  check('it is owned by the requested chat', created[0]?.chatId === 'c9', created[0])
  check('it became the active tab', s.activeId === 'files:c9', s.activeId)
  check('the pane was revealed', s.paneOpen === true)
  check('panel mode was left', s.panelMode === false)

  useViewerTabs.getState().openFiles('c9')
  const again = useViewerTabs.getState() as any
  check(
    'reopening does not stack a second tab',
    again.tabs.filter((t: any) => t.kind === 'files').length === 1,
    again.tabs,
  )

  useViewerTabs.getState().openFiles('c10')
  check(
    'another chat gets its own tab',
    (useViewerTabs.getState() as any).tabs.filter((t: any) => t.kind === 'files').length === 2,
    (useViewerTabs.getState() as any).tabs,
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
