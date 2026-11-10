// The file explorer lives in the SIDEBAR (its Files view), not in a pane tab.
//
// Locked here:
//   * the old 'files' viewer kind is gone: a 'files' tab persisted by an older
//     build is dropped on load (the explorer would otherwise show up twice),
//     while the other kinds — 'explore' included — still survive a restart and
//     an unknown kind is still rejected;
//   * openFiles / focusFilesFilter / revealFile create NO tab and do not touch
//     the pane: they switch the sidebar to its Files view and open the sidebar
//     when it was collapsed;
//   * the filter / reveal signals still reach the panel through their counters.
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
        // Persisted by an older build, when the explorer was a pane tab.
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

const { useViewerTabs } = await import('../src/lib/viewerTabs')
const { useSidebarView } = await import('../src/lib/sidebarView')
const { useStore } = await import('../src/lib/store')

console.log('1) loadPersisted drops the legacy files tab (and still rejects unknown kinds):')
{
  const kinds = useViewerTabs.getState().tabs.map((t) => t.kind as string)
  check('a persisted files tab is dropped', !kinds.includes('files'), kinds)
  check('the explore tab still survives a restart', kinds.includes('explore'), kinds)
  check('an unknown kind is still rejected', !kinds.includes('bogus'), kinds)
}

console.log('2) openFiles shows the explorer in the sidebar and creates no tab:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as any)
  useSidebarView.setState({ view: 'chats' })
  useStore.setState({ sidebarOpen: false } as any)

  useViewerTabs.getState().openFiles()
  const s = useViewerTabs.getState() as any
  check('the sidebar switched to its Files view', useSidebarView.getState().view === 'files')
  check('a collapsed sidebar was opened', useStore.getState().sidebarOpen === true)
  check('no tab was created', s.tabs.length === 0, s.tabs)
  check('the right pane was NOT revealed', s.paneOpen === false)
  check('the choice is persisted for the next launch', disk.get('coder:sidebarView') === 'files')

  useViewerTabs.getState().openFiles()
  check('asking again is harmless', useSidebarView.getState().view === 'files' && useViewerTabs.getState().tabs.length === 0)
}

console.log('3) the filter and reveal requests reach the panel through their counters:')
{
  useSidebarView.setState({ view: 'chats' })
  useStore.setState({ sidebarOpen: false } as any)
  const before = (useViewerTabs.getState() as any).filesFilterFocusAt as number

  useViewerTabs.getState().focusFilesFilter()
  const after = (useViewerTabs.getState() as any).filesFilterFocusAt as number
  check('the filter counter was bumped', after === before + 1, { before, after })
  check('focusing the filter shows the explorer', useSidebarView.getState().view === 'files')
  check('focusing the filter opens a collapsed sidebar', useStore.getState().sidebarOpen === true)

  useSidebarView.setState({ view: 'chats' })
  useViewerTabs.getState().revealFile('src/App.tsx')
  const reveal = (useViewerTabs.getState() as any).filesReveal as { path: string; at: number } | null
  check('the reveal request carries the file path', reveal?.path === 'src/App.tsx', reveal)
  check('revealing a file shows the explorer', useSidebarView.getState().view === 'files')
  check('revealing creates no tab either', useViewerTabs.getState().tabs.length === 0)

  const firstAt = reveal?.at ?? 0
  useViewerTabs.getState().revealFile('src/App.tsx')
  const again = (useViewerTabs.getState() as any).filesReveal as { at: number } | null
  check('asking twice for the same file re-fires', (again?.at ?? 0) > firstAt, { firstAt, again })
}

console.log('4) Ctrl+X E from an OPEN FILE lands on that file row, not the filter:')
{
  useSidebarView.setState({ view: 'chats' })
  useStore.setState({ sidebarOpen: false } as any)
  useViewerTabs.setState({ tabs: [], activeId: null } as any)
  useViewerTabs.getState().openFile('src/lib/fileTree.ts', undefined, '/repo')
  const before = (useViewerTabs.getState() as any).filesFilterFocusAt as number

  useViewerTabs.getState().focusFilesFilter()
  const reveal = (useViewerTabs.getState() as any).filesReveal as
    | { path: string; focus?: boolean; at: number }
    | null
  check('the open file was revealed in the explorer', reveal?.path === 'src/lib/fileTree.ts', reveal)
  check('the reveal asks the panel to FOCUS the row', reveal?.focus === true, reveal)
  check(
    'the filter counter did NOT change (the box must not open)',
    ((useViewerTabs.getState() as any).filesFilterFocusAt as number) === before,
  )
  check('the explorer is showing', useSidebarView.getState().view === 'files')
  check('the sidebar was opened', useStore.getState().sidebarOpen === true)

  // A file OUTSIDE the workspace root has no explorer row: the shortcut must
  // fall back to the filter instead of probing for a row that cannot exist.
  useViewerTabs.setState({ tabs: [], activeId: null } as any)
  useViewerTabs.getState().openFile('/tmp/outside.txt', undefined, '/repo')
  const beforeOutside = (useViewerTabs.getState() as any).filesFilterFocusAt as number
  const beforeReveal = (useViewerTabs.getState() as any).filesReveal
  useViewerTabs.getState().focusFilesFilter()
  check(
    'a file outside the root leaves the reveal request alone',
    (useViewerTabs.getState() as any).filesReveal?.at === beforeReveal?.at,
  )
  check(
    'and falls back to the filter',
    ((useViewerTabs.getState() as any).filesFilterFocusAt as number) === beforeOutside + 1,
  )

  // No file tab on screen (e.g. a terminal page): the filter is still the
  // entry point.
  useViewerTabs.setState({ tabs: [], activeId: null } as any)
  const beforeFilter = (useViewerTabs.getState() as any).filesFilterFocusAt as number
  useViewerTabs.getState().focusFilesFilter()
  check(
    'without a file the filter counter is bumped',
    ((useViewerTabs.getState() as any).filesFilterFocusAt as number) === beforeFilter + 1,
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
