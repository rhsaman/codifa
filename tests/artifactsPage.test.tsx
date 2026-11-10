// The Artifacts page as its own viewer kind, plus its list panel.
//
// Locked here:
//   * `artifacts` survives a restart (both load whitelists), and it is a
//     GLOBAL page: no chatId, visible in every chat, still one single tab.
//   * `artifact` (one document) belongs to its chat: the tab is visible ONLY
//     in the owner chat, the owner is recovered from the tab id when an older
//     payload omitted it, and a plan/document from chat A never shows in
//     chat B.
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
        // An artifact tab is chat-scoped. This older payload carries the owner
        // only inside the id (`artifact:<chatId>:<artifactId>`): the load path
        // must recover it instead of dropping the tab as ownerless.
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
    'it is a DOCK page, never a strip row (the dock icon owns it)',
    viewerTabRows([{ kind, id: kind, title: 'Artifacts', createdAt: 1 } as any], { wsKey: 'w', chatId: 'c1' }).length === 0,
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
    'the artifact tab survives with its owner chat recovered from its id',
    tabs.some((t) => t.kind === 'artifact' && t.chatId === 'c1'),
    tabs.map((t) => `${t.id}@${t.chatId}`),
  )
  // A document belongs to a chat, so its tab follows that chat only: another
  // chat must never display chat A's plan/document preview.
  check(
    'an artifact tab is visible in its OWN chat only',
    visibleTabs(tabs, { wsKey: 'w', chatId: 'c1' }).some((t) => t.kind === 'artifact') &&
      !visibleTabs(tabs, { wsKey: 'w', chatId: 'zzz' }).some((t) => t.kind === 'artifact'),
    visibleTabs(tabs, { wsKey: 'w', chatId: 'zzz' }).map((t) => t.id),
  )
  // The LIST page is the cross-chat browser and stays global.
  check(
    'the artifacts page itself stays visible in every chat',
    visibleTabs(tabs, { wsKey: 'w', chatId: 'c1' }).some((t) => t.kind === 'artifacts') &&
      visibleTabs(tabs, { wsKey: 'w', chatId: 'zzz' }).some((t) => t.kind === 'artifacts'),
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

console.log('6) the dock opens the page (the "+" menu only offers Browser/Trace):')
{
  const app = readFileSync('src/App.tsx', 'utf8')
  check('the "+" menu is mounted in the strip', /<ViewerAddButton \/>/.test(app))
  check('the dock is mounted in the pane', /<ViewerDockBar \/>/.test(app))
  const bar = readFileSync('src/components/ViewerTabBar.tsx', 'utf8')
  // Artifacts is a DOCK page now: the dock's fixed icon opens it; the "+"
  // menu only offers the chat-owned Browser/Trace tabs.
  check('the dock offers the artifacts page', /kind: "artifacts"/.test(bar))
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
