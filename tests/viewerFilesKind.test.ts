// The 'files' viewer kind: persistence whitelist + the open action.
//
// Three things are locked here:
//   * BOTH kind whitelists in loadPersisted accept the new kinds — 'explore'
//     was missing from them since it was introduced, so an explore tab was
//     silently dropped on every restart. A kind the store can create but not
//     reload is worse than no persistence at all.
//   * openFiles creates exactly ONE global explorer tab and focuses the pane.
//     The explorer is deliberately NOT chat-scoped: a per-chat tab made the
//     rail show one files icon per chat, and activating it pushed the chat's
//     open file tab out of the rail.
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
        { id: 'explore:c1', kind: 'explore', chatId: 'c1', title: 'Explore', createdAt: 100 },
        // The global explorer id carries no chat scope.
        { id: 'files', kind: 'files', title: 'Files', createdAt: 150 },
        // A kind that never existed must still be rejected on load, so the
        // whitelist is not accidentally widened into "accept anything".
        { id: 'bogus:c1', kind: 'bogus', chatId: 'c1', title: 'Bogus', createdAt: 50 },
      ],
      activeId: 'files',
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
  check('the files tab is global (no chat scope)', files?.chatId === undefined, files)
  check('the files tab keeps its id', files?.id === 'files', files?.id)
}

console.log('2) id and title follow the shared rules:')
{
  check("viewerTabId keeps files global (no chat suffix)", viewerTabId('files', 'c1') === 'files', viewerTabId('files', 'c1'))
  check(
    'the files tab shows the shared kind label',
    viewerTabTitle({ kind: 'files', title: 'Files' }) === 'Files',
    viewerTabTitle({ kind: 'files', title: 'Files' }),
  )
}

console.log('3) visibility is global:')
{
  const tabs = useViewerTabs.getState().tabs
  const mine = visibleTabs(tabs, { wsKey: 'w1', chatId: 'c1' }).map((t) => t.kind)
  check('the owning chat sees the files tab', mine.includes('files'), mine)
  const other = visibleTabs(tabs, { wsKey: 'w2', chatId: 'c2' }).map((t) => t.kind)
  check('another chat sees the SAME single files tab', other.includes('files'), other)
  check(
    'no second files tab appears for another chat',
    tabs.filter((t) => t.kind === 'files').length === 1,
    tabs,
  )
}

console.log('4) openFiles creates one GLOBAL tab and reveals the pane:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as any)
  useViewerTabs.getState().openFiles()
  const s = useViewerTabs.getState() as any
  const created = s.tabs.filter((t: any) => t.kind === 'files')
  check('exactly one files tab was created', created.length === 1, s.tabs)
  check('it is named Files', created[0]?.title === 'Files', created[0])
  check('it is NOT owned by a chat', created[0]?.chatId === undefined, created[0])
  check('it became the active tab', s.activeId === 'files', s.activeId)
  check('the pane was revealed', s.paneOpen === true)
  check('the page opened as an ordinary tab (no pane mode to exit)', !('panelMode' in s))

  useViewerTabs.getState().openFiles()
  const again = useViewerTabs.getState() as any
  check(
    'reopening does not stack a second tab',
    again.tabs.filter((t: any) => t.kind === 'files').length === 1,
    again.tabs,
  )

  // The whole point of the global id: another chat's open file tab must
  // survive the explorer being activated.
  useViewerTabs.setState({
    tabs: [
      { id: 'files', kind: 'files', title: 'Files', createdAt: 1 },
      { id: 'file:c2:a.ts', kind: 'file', chatId: 'c2', title: 'a.ts', createdAt: 2 },
    ],
    activeId: 'file:c2:a.ts',
  } as any)
  useViewerTabs.getState().openFiles()
  const after = useViewerTabs.getState() as any
  check(
    "another chat's file tab is not closed by activating the explorer",
    after.tabs.some((t: any) => t.id === 'file:c2:a.ts'),
    after.tabs,
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
