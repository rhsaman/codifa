// Unit tests for viewerTabs: file/text viewer tabs (openFile/openText,
// visibleTabs, viewerTabId, persist/load round-trip with text-body stripping).
// Run: npx esbuild src/lib/viewerTabs.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-viewerTabs.mjs && node src/lib/.tmp-viewerTabs.mjs

// viewerTabs.ts touches window/localStorage at module load (loadPersisted,
// loadFullscreen) and useStore reads activeChatId — stub both before import,
// same pattern as tests/retryStore.test.ts.
const memStore = new Map<string, string>()
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1280,
  localStorage: {
    getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      memStore.set(k, v)
    },
    removeItem: (k: string) => {
      memStore.delete(k)
    },
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
;(globalThis as any).document = { documentElement: { style: { setProperty: () => {} } } }

const { useViewerTabs, viewerTabId, viewerTabTitle, visibleTabs, resolveViewerForChat } = await import('./viewerTabs')
const { useStore, normalizeVisibleChats, normalizeChatLayout } = await import('./store')

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

function resetViewer() {
  useViewerTabs.setState({ tabs: [], activeId: null })
  memStore.clear()
}

console.log('1) viewerTabId — file is global, text is chat-scoped:')
{
  check('file id is path-based', viewerTabId('file', 'c1') === 'file')
  check('text id carries chat', viewerTabId('text', 'c1') === 'text:c1')
  check('review stays chat-scoped', viewerTabId('review', 'c9') === 'review:c9')
}

console.log('2) openFile — one global tab per path, reopen retargets line:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  vt().openFile('src/App.tsx', 10, '/root')
  vt().openFile('src/App.tsx', 42, '/root')
  vt().openFile('src/other.ts', undefined, '/root')
  const tabs = vt().tabs
  check('two file tabs (no stacking)', tabs.length === 2, tabs.length)
  const app = tabs.find((t) => t.id === 'file:src/App.tsx')
  check('reopen updates line', app?.fileLine === 42, app?.fileLine)
  check('root captured', app?.fileRoot === '/root', app?.fileRoot)
  check('active is last opened', vt().activeId === 'file:src/other.ts', vt().activeId)
  check('blank path ignored', (() => {
    vt().openFile('   ')
    return vt().tabs.length === 2
  })())
}

console.log('3) openText — one tab per chat, reopen updates in place:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const chatId = useStore.getState().newChat('ask')
  vt().openText('First', 'body-one', 'text')
  vt().openText('Second', 'body-two', 'md')
  const tabs = vt().tabs
  check('single text tab per chat', tabs.filter((t) => t.kind === 'text').length === 1, tabs.length)
  const tab = tabs.find((t) => t.kind === 'text')
  check('title updated', tab?.title === 'Second', tab?.title)
  check('body updated', tab?.textBody === 'body-two', tab?.textBody)
  check('format hint updated', tab?.textFormat === 'md', tab?.textFormat)
  check('chat-scoped id', tab?.id === `text:${chatId}`, tab?.id)
  check('empty body ignored', (() => {
    vt().openText('Empty', '')
    return vt().tabs.length === 1
  })())
  vt().openText('Raw', 'body-four', 'text')
  check('format switches to text', useViewerTabs.getState().tabs.find((t) => t.kind === 'text')?.textFormat === 'text')
}

console.log('4) visibleTabs — file tabs are global, text tabs follow their chat:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const c1 = useStore.getState().newChat('ask')
  vt().openFile('a.ts')
  vt().openText('T1', 'b1')
  const c2 = useStore.getState().newChat('ask')
  vt().openText('T2', 'b2')
  const all = vt().tabs
  const v1 = visibleTabs(all, c1)
  const v2 = visibleTabs(all, c2)
  check('file tab visible in both chats', v1.some((t) => t.kind === 'file') && v2.some((t) => t.kind === 'file'))
  check('chat1 sees its own text', v1.some((t) => t.textBody === 'b1') && !v1.some((t) => t.textBody === 'b2'))
  check('chat2 sees its own text', v2.some((t) => t.textBody === 'b2') && !v2.some((t) => t.textBody === 'b1'))
}

console.log('5) persist — text bodies are stripped from localStorage:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  useStore.getState().newChat('ask')
  vt().openFile('a.ts')
  vt().openText('Big', 'x'.repeat(1000), 'md')
  const raw = memStore.get('coder:viewerTabs') ?? ''
  const parsed = JSON.parse(raw) as { tabs: Array<{ kind: string; textBody?: string; textFormat?: string }> }
  const text = parsed.tabs.find((t) => t.kind === 'text')
  check('persisted text tab has no body', text?.textBody === undefined, text?.textBody)
  check('persisted text tab keeps format hint', text?.textFormat === 'md', text?.textFormat)
  check('file tab persisted', parsed.tabs.some((t) => t.kind === 'file'))
  check('in-memory body kept', vt().tabs.find((t) => t.kind === 'text')?.textBody?.length === 1000)
}

console.log('6) openTraces — sub-agent gets its own filtered trace tab:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const chatId = useStore.getState().newChat('ask')
  vt().openTraces(chatId, 'all')
  vt().openTraces(chatId, 'all', 'task-abc', 'Fix bug')
  const tabs = vt().tabs.filter((t) => t.kind === 'trace')
  check('main + sub-agent trace tabs coexist', tabs.length === 2, tabs.length)
  const sub = tabs.find((t) => t.traceTaskId === 'task-abc')
  check('sub-agent tab carries task id', !!sub, tabs)
  check('sub-agent tab id is per-task', sub?.id === `trace:${chatId}:task-abc`, sub?.id)
  check('active is sub-agent tab', vt().activeId === sub?.id, vt().activeId)
}

console.log('7) viewerTabTitle — sub-agent trace keeps its own title:')
{
  check('main trace shows kind label', viewerTabTitle({ kind: 'trace', title: 'Trace', traceTaskId: undefined } as any) === 'Trace')
  check('sub-agent trace keeps own title', viewerTabTitle({ kind: 'trace', title: 'Trace · Fix bug', traceTaskId: 'task-abc' } as any) === 'Trace · Fix bug')
  check('file tab keeps own title', viewerTabTitle({ kind: 'file', title: 'a.ts', traceTaskId: undefined } as any) === 'a.ts')
}

console.log('8) multi-window visible list — order kept, unknown dropped, fallback to focus:')
{
  const valid = new Set(['c1', 'c2', 'c3'])
  check('keeps order + dedupes', JSON.stringify(normalizeVisibleChats(['c2', 'c1', 'c2', 'zx'], valid, 'c1')) === JSON.stringify(['c2', 'c1']))
  check('empty falls back to active', JSON.stringify(normalizeVisibleChats([], valid, 'c3')) === JSON.stringify(['c3']))
  check('empty + bad active falls back to first', JSON.stringify(normalizeVisibleChats([], valid, 'zx')) === JSON.stringify(['c1']))
  check('layout defaults to vertical', normalizeChatLayout('diagonal') === 'vertical')
  check('layout keeps horizontal', normalizeChatLayout('horizontal') === 'horizontal')
}

console.log('8b) chat split tree — VSCode-like drops in any direction:')
{
  const { appendChat, buildFromList, collectChatIds, dropOnto, leafCount, normalizeTree } = await import('./chatTree')
  const t0 = buildFromList(['c1'], 'col')!
  const t1 = dropOnto(t0, 'c2', 'c1', 'right')!
  check('right edge splits row', t1.kind === 'split' && (t1 as any).dir === 'row' && JSON.stringify(collectChatIds(t1)) === JSON.stringify(['c1', 'c2']), JSON.stringify(collectChatIds(t1)))
  const t2 = dropOnto(t1, 'c3', 'c1', 'bottom')!
  check('bottom edge splits col inside row', leafCount(t2) === 3 && collectChatIds(t2).includes('c3'))
  const t3 = dropOnto(t2, 'c2', 'c3', 'center')!
  check('center swaps windows', collectChatIds(t3).includes('c2') && leafCount(t3) === 3)
  const t4 = dropOnto(t3, 'c2', 'c2', 'left')!
  check('self drop is no-op', collectChatIds(t4).length === 3)
  const flat = appendChat(null, 'c1', 'col')!
  check('append starts a leaf', flat.kind === 'leaf' && collectChatIds(flat).join() === 'c1')
  const norm = normalizeTree(buildFromList(['c1', 'c9', 'c1', 'c2'], 'col'), new Set(['c1', 'c2']))
  check('normalize drops unknown + dupe', JSON.stringify(collectChatIds(norm)) === JSON.stringify(['c1', 'c2']), JSON.stringify(collectChatIds(norm)))
}

console.log('8c) chat window limits — min size constants and max windows:')
{
  const { appendChat, buildFromList, CHAT_WINDOW_MAX, CHAT_WINDOW_MIN_H, CHAT_WINDOW_MIN_W, collectChatIds, dropOnto, leafCount } = await import('./chatTree')
  check('min width sane', CHAT_WINDOW_MIN_W >= 200 && CHAT_WINDOW_MIN_W <= 400, CHAT_WINDOW_MIN_W)
  check('min height sane', CHAT_WINDOW_MIN_H >= 150 && CHAT_WINDOW_MIN_H <= 400, CHAT_WINDOW_MIN_H)
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].slice(0, CHAT_WINDOW_MAX)
  const full = buildFromList(ids, 'row')!
  check('full tree at max', leafCount(full) === CHAT_WINDOW_MAX, leafCount(full))
  const blocked = appendChat(full, 'cX', 'row')
  check('append blocked when full', blocked === full && !collectChatIds(blocked).includes('cX'))
  const blockedDrop = dropOnto(full, 'cX', ids[0], 'right')
  check('drop blocked when full', blockedDrop === full)
  const moved = dropOnto(full, ids[0], ids[1], 'right')
  check('move allowed when full', moved !== full && leafCount(moved!) === CHAT_WINDOW_MAX)
}

console.log('9) resolveViewerForChat — focused chat restores its own tab:')
{
  const tabs = [
    { id: 'review:c1', kind: 'review', chatId: 'c1' },
    { id: 'review:c2', kind: 'review', chatId: 'c2' },
  ] as any[]
  const v2 = visibleTabs(tabs, 'c2')
  check('remembers c2 tab', resolveViewerForChat(v2, { c2: 'review:c2' }, 'c2') === 'review:c2')
  check('stale memory falls back to first visible', resolveViewerForChat(v2, { c2: 'review:c9' }, 'c2') === 'review:c2')
  check('no tabs -> null', resolveViewerForChat([], {}, 'c2') === null)
}

console.log('10) pickNeighborWindow — vim-style directional move:')
{
  const { pickNeighborWindow } = await import('./chatTree')
  const centers = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: 100 }, d: { x: 100, y: 100 } }
  check('right from a is b', pickNeighborWindow(centers, 'a', 'right') === 'b')
  check('down from a is c', pickNeighborWindow(centers, 'a', 'down') === 'c')
  check('left from b is a', pickNeighborWindow(centers, 'b', 'left') === 'a')
  check('up from c is a', pickNeighborWindow(centers, 'c', 'up') === 'a')
  check('right from b is null', pickNeighborWindow(centers, 'b', 'right') === null)
  check('unknown current is null', pickNeighborWindow(centers, 'zx', 'right') === null)
  check('off-axis excluded', pickNeighborWindow({ a: { x: 0, y: 0 }, e: { x: 10, y: 100 } }, 'a', 'right') === null)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll viewerTabs checks passed')
process.exit(0)
