// The schedule page as its own viewer kind, and the "one entry point per page"
// rule for the pane rail.
//
// Locked here:
//   * `schedule` survives a restart (BOTH load whitelists), while an unknown
//     kind is still rejected — the whitelist must never widen to "anything".
//   * `openSchedule` creates exactly ONE global tab and focuses the pane.
//   * pages are ORDINARY tabs now: the rail's "+" menu opens them and each one
//     can be closed from its own row.
//   * both viewer dispatchers handle `schedule` BEFORE their inbox fall-through
//     (the catch-all return that silently rendered the schedule inbox for any
//     kind it did not know).
//   * the todos page and the schedule page each hold exactly one section:
//     schedules were split out of the todos page.
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
        { id: 'schedule', kind: 'schedule', title: 'Schedule', createdAt: 300 },
        { id: 'inbox', kind: 'inbox', title: 'Inbox', createdAt: 200 },
        // A kind that never existed must still be dropped on load.
        { id: 'bogus', kind: 'bogus', title: 'Bogus', createdAt: 100 },
      ],
      activeId: 'schedule',
      closed: [{ tab: { id: 'schedule', kind: 'schedule', title: 'Schedule' }, closedAt: 5 }],
    }),
  ],
])

const coder = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      return async () => null
    },
  },
)

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

const { shownViewerTabId, useViewerTabs, viewerTabId, viewerTabTitle, visibleTabs } = await import('../src/lib/viewerTabs')

console.log('1) the schedule kind survives a restart, unknown kinds do not:')
{
  const tabs = useViewerTabs.getState().tabs
  const kinds = tabs.map((t) => t.kind)
  check('the schedule tab is reloaded', kinds.includes('schedule'), kinds)
  check('the inbox tab is reloaded', kinds.includes('inbox'), kinds)
  check('an unknown kind is still rejected', !kinds.includes('bogus'), kinds)
  const schedule = tabs.find((t) => t.kind === 'schedule')
  check('the schedule page is one GLOBAL tab (no chat scope)', schedule?.chatId === undefined, schedule)
  check('its id is the bare kind', schedule?.id === 'schedule', schedule?.id)
}

console.log('2) id, title and visibility follow the shared rules:')
{
  check("viewerTabId keeps 'schedule' global", viewerTabId('schedule', 'c1') === 'schedule', viewerTabId('schedule', 'c1'))
  check(
    'the tab shows the shared kind label',
    viewerTabTitle({ kind: 'schedule', title: 'whatever' }) === 'Schedule',
    viewerTabTitle({ kind: 'schedule', title: 'whatever' }),
  )
  const tabs = useViewerTabs.getState().tabs
  check('the schedule page is visible in every chat', visibleTabs(tabs, 'c1').some((t) => t.kind === 'schedule'))
  check('…including one with no tabs of its own', visibleTabs(tabs, 'zzz').some((t) => t.kind === 'schedule'))
}

console.log('3) openSchedule creates exactly one tab and reveals the pane:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, paneOpen: false } as any)
  useViewerTabs.getState().openSchedule()
  const s = useViewerTabs.getState() as any
  const created = s.tabs.filter((t: any) => t.kind === 'schedule')
  check('exactly one schedule tab was created', created.length === 1, s.tabs)
  check('it is named Schedule', created[0]?.title === 'Schedule', created[0])
  check('it became the active tab', s.activeId === 'schedule', s.activeId)
  check('the pane was revealed', s.paneOpen === true)

  useViewerTabs.getState().openSchedule()
  const again = useViewerTabs.getState() as any
  check(
    'reopening does not stack a second tab',
    again.tabs.filter((t: any) => t.kind === 'schedule').length === 1,
    again.tabs,
  )

  // The page is a plain tab: it has no "pane mode" of its own to exit.
  check('the page needs no panel mode', !('panelMode' in again))
}

console.log('4) the "+" menu is the single entry point, and every page is a tab:')
{
  const barSrc = readFileSync('src/components/ViewerTabBar.tsx', 'utf8')
  check('the "+" menu exists', barSrc.includes('export function ViewerAddButton'))
  check('it is mounted in the rail', readFileSync('src/App.tsx', 'utf8').includes('<ViewerAddButton />'))
  // Every page the menu offers must be a REAL tab kind, so the row it lands on
  // can be closed: the eight fixed icons are gone, nothing is icon-owned.
  for (const kind of ['files', 'todos', 'artifacts', 'review', 'trace', 'browser', 'schedule', 'inbox']) {
    check(`the menu can open the ${kind} page`, barSrc.includes(`key: "${kind}"`), kind)
  }
  // No page owns a fixed icon any more: those buttons are gone from the file.
  for (const btn of [
    'ViewerFilesButton',
    'ViewerTodosButton',
    'ViewerArtifactsButton',
    'ViewerScheduleButton',
    'ViewerInboxButton',
    'ViewerReviewButton',
    'ViewerTraceButton',
    'ViewerBrowserButton',
  ]) {
    check(`${btn} is gone`, !barSrc.includes(`export function ${btn}`), btn)
  }
  // Every visible tab is a row now — pages included — so each one has a ✕.
  check(
    'the rail draws rows from viewerTabRows',
    /const tabs = viewerTabRows\(allTabs, activeChatId\)/.test(barSrc),
    barSrc.slice(0, 0),
  )
}

console.log('5) both dispatchers render the schedule page above the inbox fallback:')
{
  const contentSrc = readFileSync('src/components/ViewerContent.tsx', 'utf8')
  const scheduleAt = contentSrc.indexOf('active.kind === "schedule"')
  const fallbackAt = contentSrc.indexOf('<ScheduleInboxDocked')
  check('ViewerContent handles the schedule kind', scheduleAt !== -1)
  check('…before its inbox catch-all', scheduleAt !== -1 && fallbackAt !== -1 && scheduleAt < fallbackAt)
  check('it renders the schedule page', contentSrc.includes('<SchedulePage'))
  check(
    'the todos page renders as its own tab kind',
    /active\.kind === "todos"/.test(contentSrc),
    contentSrc.slice(0, 0),
  )

  const windowsSrc = readFileSync('src/components/ViewerWindows.tsx', 'utf8')
  const wScheduleAt = windowsSrc.indexOf('tab.kind === "schedule"')
  const wFallbackAt = windowsSrc.indexOf('<ScheduleInboxDocked')
  check('ViewerLeafBody handles the schedule kind', wScheduleAt !== -1)
  check('…before its inbox catch-all', wScheduleAt !== -1 && wFallbackAt !== -1 && wScheduleAt < wFallbackAt)
  check('the split pane renders the todos tab body', /tab\.kind === "todos"/.test(windowsSrc))
}

console.log('6) the schedule page and the todos page are separate:')
{
  const pagesSrc = readFileSync('src/components/ViewerPages.tsx', 'utf8')
  const todosPageAt = pagesSrc.indexOf('export function TodosPage')
  const schedulePageAt = pagesSrc.indexOf('export function SchedulePage')
  check('both pages exist', todosPageAt !== -1 && schedulePageAt !== -1)
  const todosBody = pagesSrc.slice(todosPageAt, schedulePageAt)
  const scheduleBody = pagesSrc.slice(schedulePageAt)
  check('the todos page holds ONLY the todos section', todosBody.includes('<TodosSection') && !todosBody.includes('<ScheduleSection'))
  check('the schedule page holds ONLY the schedule section', scheduleBody.includes('<ScheduleSection') && !scheduleBody.includes('<TodosSection'))
  // What the turn RAN with leads: the card changes every turn and is the
  // reason the page is opened, so it sits above the checklist instead of under
  // a plan that can be a dozen rows long.
  const usageAt = todosBody.indexOf('<TurnUsagePanel')
  const todosAt = todosBody.indexOf('<TodosSection')
  check(
    'the usage card sits above the plan checklist',
    usageAt !== -1 && todosAt !== -1 && usageAt < todosAt,
    { usageAt, todosAt },
  )

  const todosSrc = readFileSync('src/components/TodosPanel.tsx', 'utf8')
  check(
    'the todos card no longer embeds the schedule section',
    !todosSrc.includes('<ScheduleSection'),
    todosSrc.includes('<ScheduleSection'),
  )
  check(
    'an empty todo list renders an empty state instead of nothing',
    /if \(todos\.length === 0\) \{/.test(todosSrc) && todosSrc.includes('sidebar-todos-empty'),
  )
}

console.log('7) a rail icon marks the page ON SCREEN, not merely an open tab:')
{
  // The bug this locks: with several tabs open, pressing the icon of a page
  // that was open but NOT the one on screen closed its tab (the pressed state
  // was "a tab with this id exists"), so the page vanished and a second press
  // was needed to see it again.
  // `chatId` matters here: a chat-scoped kind (files, review…) without one is
  // filtered out of EVERY chat, so the checks below would pass for the wrong
  // reason (the tab would be invisible, not merely inactive).
  const tab = (id: string, kind: string, extra: Record<string, unknown> = {}): any => ({
    id,
    kind,
    title: id,
    createdAt: 1,
    ...extra,
  })
  const tabs: any[] = [tab('files:c1', 'files', { chatId: 'c1' }), tab('inbox', 'inbox')]

  check('the active tab is the shown one', shownViewerTabId(tabs, 'inbox', 'c1') === 'inbox')
  check(
    'an open tab that is not active is NOT shown',
    shownViewerTabId(tabs, 'inbox', 'c1') !== 'files:c1',
  )
  check(
    'promoting the open tab makes it the shown one',
    shownViewerTabId(tabs, 'files:c1', 'c1') === 'files:c1',
  )
  check('an empty pane shows no page', shownViewerTabId([], null, 'c1') === null)
  check(
    'a stale activeId falls back to the first visible tab',
    shownViewerTabId(tabs, 'gone', 'c1') === 'files:c1',
  )
  check(
    "another chat's tab is not the shown one",
    shownViewerTabId([tab('review:c2', 'review', { chatId: 'c2' })], 'review:c2', 'c1') === null,
  )

  // …and the rail really consumes that rule: the shown tab is the one the pane
  // paints. A page opened from the "+" menu is a normal tab in that list, so
  // it can be closed from its own row like any other.
  const barSrc = readFileSync('src/components/ViewerTabBar.tsx', 'utf8')
  check(
    'the highlighted row comes from the shared "shown tab" rule',
    barSrc.includes('shownViewerTabId(allTabs, activeId, activeChatId)'),
  )
  check('rows are drawn from every visible tab', barSrc.includes('viewerTabRows('))
  check(
    'no page icon tests for an open tab instead of a shown one',
    !barSrc.includes('s.tabs.some((t) => t.id === id)') &&
      !barSrc.includes("tabs.some((t) => t.kind === 'schedule')") &&
      !barSrc.includes("tabs.some((t) => t.kind === 'inbox')"),
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
