// The Artifacts page as its own viewer kind, plus its list panel.
//
// Locked here:
//   * `artifacts` survives a restart (both load whitelists), and it is a
//     GLOBAL page: no chatId, visible in every chat, still one single tab.
//   * `artifact` (one document) is GLOBAL too: opening a row must show the
//     document in whatever chat is on screen, never switch chats, and survive
//     its owner chat being deleted.
//   * it is rail-owned, so it is never ALSO drawn as a rail row (one entry
//     point per page) and its label is its own kind label.
//   * the panel renders chrome + a loading state without a backend (the list
//     fetch is an effect, so SSR stops at the loading state).
//   * without a sidecar the list call reports an error instead of throwing.
//
// Persistence is driven through the REAL load path (localStorage is seeded
// before the module loads, because zustand hydrates at import time).
export {}
import { readFileSync } from 'node:fs'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const disk = new Map<string, string>([
  [
    'coder:viewerTabs',
    JSON.stringify({
      tabs: [
        { id: 'artifacts', kind: 'artifacts', title: 'Artifacts', createdAt: 300 },
        { id: 'schedule', kind: 'schedule', title: 'Schedule', createdAt: 200 },
        // An artifact tab is global: it is kept even without an owner chat,
        // because its id still carries the artifact id the panel re-reads.
        { id: 'artifact:c1:x', kind: 'artifact', title: 'X', createdAt: 100 },
      ],
      activeId: 'artifacts',
      closed: [],
    }),
  ],
])

;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: {
    getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
    setItem: (k: string, v: string) => {
      disk.set(k, String(v))
    },
    removeItem: (k: string) => {
      disk.delete(k)
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
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { viewerTabTitle, viewerTabRows, useViewerTabs, visibleTabs } = await import(
  '../src/lib/viewerTabs'
)
const { listArtifacts } = await import('../src/lib/artifacts')
const { renderToString } = await import('react-dom/server')
const { ArtifactsPanel } = await import('../src/components/ArtifactsPanel')

console.log('1) the kind is a global page opened as an ordinary tab:')
{
  const kind = 'artifacts' as const
  check(
    'it is drawn as a normal rail row (so it can be closed)',
    viewerTabRows([{ kind, id: kind, title: 'Artifacts', createdAt: 1 } as any], 'c1').length === 1,
  )
  check(
    'its tab shows the page label',
    viewerTabTitle({ kind, title: 'whatever' } as any) === 'Artifacts',
  )
}

console.log('2) it survives a restart as ONE global tab:')
{
  const tabs = useViewerTabs.getState().tabs
  const mine = tabs.filter((t) => t.kind === 'artifacts')
  check('exactly one artifacts tab was restored', mine.length === 1, tabs.map((t) => t.id))
  check('it has no owner chat (global)', mine[0]?.chatId === undefined, mine[0])
  check('it is the active tab again', useViewerTabs.getState().activeId === 'artifacts')
  check(
    'the artifact tab is kept as a global one',
    tabs.some((t) => t.kind === 'artifact'),
    tabs.map((t) => t.id),
  )
  // A document belongs to a chat, but the TAB does not: it must show in every
  // chat, or opening a row from the Artifacts page would look like a no-op in
  // any chat but the owner's.
  check(
    'an artifact tab is visible in every chat',
    visibleTabs(tabs, 'c1').some((t) => t.kind === 'artifact') &&
      visibleTabs(tabs, 'zzz').some((t) => t.kind === 'artifact'),
    visibleTabs(tabs, 'zzz').map((t) => t.id),
  )
}

console.log('3) opening it is idempotent and focuses the pane:')
{
  const open = () => useViewerTabs.getState().openArtifacts()
  open()
  open()
  const tabs = useViewerTabs.getState().tabs
  check('still exactly one tab', tabs.filter((t) => t.kind === 'artifacts').length === 1)
  const st = useViewerTabs.getState()
  check('the pane is open in tabs mode', st.paneOpen && !st.panelMode)
  check('the tab is active', st.activeId === 'artifacts')
  const persisted = JSON.parse(disk.get('coder:viewerTabs') ?? '{}')
  check(
    'it persists as a global tab',
    (persisted.tabs ?? []).some((t: any) => t.kind === 'artifacts' && t.chatId === undefined),
  )
}

console.log('4) the panel renders its chrome without a backend:')
{
  const html = renderToString(<ArtifactsPanel />)
  check('root panel class', html.includes('artifacts-panel'), html.slice(0, 200))
  check('it is titled Artifacts', html.includes('artifacts-panel-title') && html.includes('>Artifacts<'))
  check('it offers a refresh action', html.includes('Refresh the artifact list'))
  check(
    'the list fetch has not resolved during SSR',
    html.includes('artifacts-loading'),
    html.slice(0, 400),
  )
  check('no empty-state claim while loading', !html.includes('No artifacts yet'))
  // The search box only exists once there are rows to search, so the loading
  // paint must not show it either.
  check('no search box before the list resolves', !html.includes('review-search-input'))
  // The page lists documents, not chats: no per-row chat chip that would
  // switch the active chat behind the user's back.
  check('no chat chip is rendered', !html.includes('artifacts-chat'))
}

console.log('5) a missing backend is an error, not a crash:')
{
  const out = await listArtifacts()
  check('the list call reports an error', typeof out === 'object' && 'error' in out, out)
}

console.log('6) the rail opens the page from its "+" menu:')
{
  const app = readFileSync('src/App.tsx', 'utf8')
  check('the "+" menu is mounted in the rail', /<ViewerAddButton \/>/.test(app))
  const bar = readFileSync('src/components/ViewerTabBar.tsx', 'utf8')
  check('the menu offers the artifacts page', bar.includes('key: "artifacts"'))
  // Both dispatchers must handle the kind BEFORE the inbox catch-all return.
  // Match the JSX TAG, not the lazy import at the top of the file.
  const content = readFileSync('src/components/ViewerContent.tsx', 'utf8')
  const windows = readFileSync('src/components/ViewerWindows.tsx', 'utf8')
  const before = (src: string, needle: string, guard: string) =>
    src.indexOf(needle) > -1 && src.indexOf(needle) < src.lastIndexOf(guard)
  check(
    'ViewerContent dispatches it before the inbox fallback',
    before(content, 'kind === "artifacts"', '<ScheduleInboxDocked'),
    content.indexOf('kind === "artifacts"'),
  )
  check(
    'ViewerWindows dispatches it before the inbox fallback',
    before(windows, 'kind === "artifacts"', '<ScheduleInboxDocked'),
    windows.indexOf('kind === "artifacts"'),
  )
}

export {}

if (failures > 0) {
  console.error(`artifactsPage: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('artifactsPage: all checks passed')
