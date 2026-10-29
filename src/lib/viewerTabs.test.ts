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

const { useViewerTabs, viewerTabId, viewerTabTitle, visibleTabs, resolveViewerForChat, syncViewerToChat, shownViewerTabId } = await import('./viewerTabs')
const { collectChatIds, leafCount } = await import('./chatTree')
const { useStore, normalizeVisibleChats, normalizeChatLayout, workspaceKey } = await import('./store')

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

/** A chat rooted in its own workspace, activated (open* actions scope to the
 *  focused chat's workspace). Returns [chatId, workspaceKey]. */
function chatInWs(root: string): [string, string] {
  const id = useStore.getState().newChatInRoot(root)
  useStore.setState({ activeChatId: id })
  return [id, workspaceKey(root)]
}

function scopeOf(chatId: string, wsKey: string) {
  return { wsKey, chatId }
}

function resetViewer() {
  useViewerTabs.setState({ tabs: [], activeId: null })
  memStore.clear()
}

console.log('1) viewerTabId — the key is opaque (chat id or workspace key):')
{
  check('file id carries its scope key', viewerTabId('file', 'c1') === 'file:c1')
  check('text id carries its scope key', viewerTabId('text', 'c1') === 'text:c1')
  check('review id carries its scope key', viewerTabId('review', 'c9') === 'review:c9')
}

console.log('2) openFile — one tab per file per WORKSPACE, reopen retargets line:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openFile('src/App.tsx', 10, '/ws-a', c1)
  vt().openFile('src/App.tsx', 42, '/ws-a', c1)
  vt().openFile('src/other.ts', undefined, '/ws-a', c1)
  const tabs = vt().tabs
  check('two file tabs (no stacking)', tabs.length === 2, tabs.length)
  const app = tabs.find((t) => t.id === `file:${wsA}:src/App.tsx`)
  check('scoped id carries the workspace key', !!app, tabs.map((t) => t.id))
  check('reopen updates line', app?.fileLine === 42, app?.fileLine)
  check('root captured', app?.fileRoot === '/ws-a', app?.fileRoot)
  check('active is last opened', vt().activeId === `file:${wsA}:src/other.ts`, vt().activeId)
  const [c2] = chatInWs('/ws-a')
  vt().openFile('src/App.tsx', 7, '/ws-a', c2)
  check('same path from another chat of the SAME workspace retargets the tab', vt().tabs.length === 2, vt().tabs.map((t) => t.id))
  const [c3, wsB] = chatInWs('/ws-b')
  vt().openFile('src/App.tsx', 7, '/ws-b', c3)
  check('same path in ANOTHER workspace is a separate tab', vt().tabs.length === 3, vt().tabs.map((t) => t.id))
  check('the other workspace tab carries its own key', vt().tabs.some((t) => t.id === `file:${wsB}:src/App.tsx`), vt().tabs.map((t) => t.id))
  check('blank path ignored', (() => {
    vt().openFile('   ')
    return vt().tabs.length === 3
  })())
}

console.log('3) openText — one tab per WORKSPACE, reopen updates in place:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [, wsA] = chatInWs('/ws-a')
  vt().openText('First', 'body-one', 'text')
  vt().openText('Second', 'body-two', 'md')
  const tabs = vt().tabs
  check('single text tab per workspace', tabs.filter((t) => t.kind === 'text').length === 1, tabs.length)
  const tab = tabs.find((t) => t.kind === 'text')
  check('title updated', tab?.title === 'Second', tab?.title)
  check('body updated', tab?.textBody === 'body-two', tab?.textBody)
  check('format hint updated', tab?.textFormat === 'md', tab?.textFormat)
  check('workspace-scoped id', tab?.id === `text:${wsA}`, tab?.id)
  check('empty body ignored', (() => {
    vt().openText('Empty', '')
    return vt().tabs.length === 1
  })())
  vt().openText('Raw', 'body-four', 'text')
  check('format switches to text', useViewerTabs.getState().tabs.find((t) => t.kind === 'text')?.textFormat === 'text')
}

console.log('4) visibleTabs — tabs follow their WORKSPACE, legacy global file stays visible:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openFile('a.ts', undefined, '/ws-a', c1)
  vt().openText('T1', 'b1')
  const [c2, wsB] = chatInWs('/ws-b')
  vt().openText('T2', 'b2')
  const all = vt().tabs
  const v1 = visibleTabs(all, scopeOf(c1, wsA))
  const v2 = visibleTabs(all, scopeOf(c2, wsB))
  check('file tab visible only in its own workspace', v1.some((t) => t.kind === 'file') && !v2.some((t) => t.kind === 'file'), v2.map((t) => t.id))
  check('ws-a sees its own text', v1.some((t) => t.textBody === 'b1') && !v1.some((t) => t.textBody === 'b2'))
  check('ws-b sees its own text', v2.some((t) => t.textBody === 'b2') && !v2.some((t) => t.textBody === 'b1'))
  check('legacy global file tab visible everywhere', (() => {
    const legacy = [{ id: 'file:old.ts', kind: 'file', title: 'old.ts', filePath: 'old.ts', createdAt: Date.now() }] as any[]
    return visibleTabs(legacy, scopeOf(c1, wsA)).length === 1 && visibleTabs(legacy, scopeOf(c2, wsB)).length === 1
  })())
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

console.log('6b) schedule-run trace — synthetic-chat tab visible from ANY chat:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const chatId = useStore.getState().newChat('ask')
  vt().openTraces('schedule-sch-abc', 'all', undefined, 'Nightly Report')
  const tab = vt().tabs.find((t) => t.id === 'trace:schedule-sch-abc')
  check('schedule trace tab created', !!tab, tab)
  check('title carries the task label', tab?.title === 'Trace · Nightly Report', tab?.title)
  const anyScope = { wsKey: 'ws-other', chatId }
  check('visible while another chat focused', visibleTabs(vt().tabs, anyScope).some((t) => t.id === tab?.id))
  check('rail title keeps the label', viewerTabTitle(tab as any) === 'Trace · Nightly Report')
  // An ordinary chat trace stays scoped as before.
  vt().openTraces(chatId, 'all')
  const otherScope = { wsKey: 'ws-other', chatId: 'c-other' }
  check('ordinary trace hidden from other chats', !visibleTabs(vt().tabs, otherScope).some((t) => t.chatId === chatId))
}

console.log('7) viewerTabTitle — sub-agent trace keeps its own title:')
{
  check('main trace shows kind label', viewerTabTitle({ kind: 'trace', title: 'Trace', traceTaskId: undefined } as any) === 'Trace')
  check('sub-agent trace keeps own title', viewerTabTitle({ kind: 'trace', title: 'Trace · Fix bug', traceTaskId: 'task-abc' } as any) === 'Trace · Fix bug')
  check('file tab keeps own title', viewerTabTitle({ kind: 'file', title: 'a.ts', traceTaskId: undefined } as any) === 'a.ts')
  // One tab per artifact document: the kind label alone would show three
  // identical "Artifact" tabs for three documents of the same chat.
  check('artifact tab keeps own title', viewerTabTitle({ kind: 'artifact', title: 'Q3 Sales' } as any) === 'Q3 Sales')
  check(
    'artifact tab without a title falls back to the kind label',
    viewerTabTitle({ kind: 'artifact', title: '' } as any) === 'Artifact',
  )
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
    { id: 'trace:c1', kind: 'trace', chatId: 'c1' },
    { id: 'trace:c2', kind: 'trace', chatId: 'c2' },
  ] as any[]
  const scope2 = scopeOf('c2', 'w')
  const v2 = visibleTabs(tabs, scope2)
  check('remembers c2 tab', resolveViewerForChat(v2, { c2: 'trace:c2' }, 'c2') === 'trace:c2')
  check('stale memory falls back to first visible', resolveViewerForChat(v2, { c2: 'trace:c9' }, 'c2') === 'trace:c2')
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

console.log('11) viewer multi-window tree — split, focus, close:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [cid, wsA] = chatInWs('/ws-a')
  vt().openGitDiff(cid)
  const gitId = `review:${wsA}`
  vt().openTraces(cid, 'all')
  const traceId = `trace:${cid}`
  vt().ensureViewerTree()
  check('single leaf mirrors active tab', (() => {
    const t = vt().viewerTree
    return !!t && t.kind === 'leaf' && (t as any).chatId === traceId
  })(), vt().viewerTree)
  check('focus mirrors active in single mode', vt().focusedViewerId === traceId, vt().focusedViewerId)
  vt().openViewerInWindow(gitId)
  const { leafCount: vLeaves, collectChatIds: vIds } = await import('./chatTree')
  check('second tab splits to two panes', vt().viewerTree ? vLeaves(vt().viewerTree) === 2 : false, vt().viewerTree)
  check('split holds both tabs', (() => {
    const ids = vt().viewerTree ? vIds(vt().viewerTree) : []
    return ids.includes(gitId) && ids.includes(traceId)
  })())
  vt().focusViewerWindow(gitId)
  check('click focuses pane', vt().focusedViewerId === gitId && vt().activeId === gitId, vt().focusedViewerId)
  vt().closeViewerWindow(traceId)
  check('close collapses to one pane', vt().viewerTree ? vLeaves(vt().viewerTree) === 1 : false)
  check('closed tab stays in tab list', vt().tabs.some((t) => t.id === traceId))
}

console.log('12) split width — drag caps at half viewport:')
{
  const { clampSplitWidth } = await import('./viewerTabs')
  check('drag beyond half clamps to half', clampSplitWidth(900, 1280) === 640, clampSplitWidth(900, 1280))
  check('small drag kept', clampSplitWidth(400, 1280) === 400, clampSplitWidth(400, 1280))
  check('min width kept', clampSplitWidth(100, 1280) === 320, clampSplitWidth(100, 1280))
}

console.log('13) openPlan — one plan tab per CHAT, auto-opens pane:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openPlan(c1)
  const plan1 = `plan:${c1}`
  check('plan tab keyed by chat id', vt().tabs.some((t) => t.id === plan1 && t.kind === 'plan' && t.chatId === c1), vt().tabs)
  check('plan tab is active', vt().activeId === plan1, vt().activeId)
  check('pane auto-opens', vt().paneOpen === true, vt().paneOpen)
  vt().openPlan(c1)
  check('reopen does not duplicate', vt().tabs.filter((t) => t.kind === 'plan').length === 1, vt().tabs.length)
  const [c2] = chatInWs('/ws-a')
  vt().openPlan(c2)
  const plan2 = `plan:${c2}`
  check('a sibling chat gets its OWN plan tab (no retarget)', vt().tabs.filter((t) => t.kind === 'plan').length === 2, vt().tabs.map((t) => t.id))
  check('each plan tab belongs to its chat', vt().tabs.find((t) => t.id === plan1)?.chatId === c1 && vt().tabs.find((t) => t.id === plan2)?.chatId === c2, vt().tabs)
  const [c3, wsB] = chatInWs('/ws-b')
  vt().openPlan(c3)
  check('another WORKSPACE gets its own plan tab', vt().tabs.some((t) => t.id === `plan:${c3}`), vt().tabs.map((t) => t.id))
  const v1 = visibleTabs(vt().tabs, scopeOf(c1, wsA))
  check('plan tab follows its OWN chat only', v1.some((t) => t.id === plan1) && !v1.some((t) => t.id === plan2) && !v1.some((t) => t.id === `plan:${c3}`), v1.map((t) => t.id))
}

console.log('14) syncViewerToChat — trace follows the chat, workspace tabs stick:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  const [c2] = chatInWs('/ws-a')
  vt().openGitDiff(c1)
  vt().openTraces(c1, 'all')
  vt().openTraces(c2, 'all')
  // Put the workspace Git tab on screen (as a deliberate click would), then
  // switch chats inside the workspace: the pane must NOT be yanked away.
  vt().setActiveViewer(`review:${wsA}`)
  syncViewerToChat(c2)
  check('workspace tab sticks across a chat switch', vt().activeId === `review:${wsA}`, vt().activeId)
  syncViewerToChat(c1)
  check('workspace tab sticks back too', vt().activeId === `review:${wsA}`, vt().activeId)
  // Activate chat 1's trace: now a chat-scoped tab owns the pane, and a
  // switch to chat 2 follows the focused chat again.
  vt().setActiveViewer(`trace:${c1}`)
  syncViewerToChat(c2)
  check('switching chat shows its own trace', vt().activeId === `trace:${c2}`, vt().activeId)
  syncViewerToChat(c1)
  check('switching back shows the first chat trace', vt().activeId === `trace:${c1}`, vt().activeId)
}

console.log('14b) a global page tab never takes the pane from an open file:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openSchedule()
  vt().openFile('src/App.tsx', 1, '/ws-a', c1)
  const fileId = `file:${wsA}:src/App.tsx`
  // An untouched chat (no remembered tab, whose `lastActiveByChat` entry is
  // gone after a restart) must resolve to the chat's OWN tab, never to the
  // global schedule tab sitting first in `tabs`.
  check(
    'fallback prefers the chat tab over the global page tab',
    resolveViewerForChat(visibleTabs(vt().tabs, scopeOf(c1, wsA)), {}, c1) === fileId,
    resolveViewerForChat(visibleTabs(vt().tabs, scopeOf(c1, wsA)), {}, c1),
  )
  const remembered = { ...vt().lastActiveByChat, [c1]: 'schedule' }
  check(
    'a remembered page tab is not reused when the chat owns a tab',
    resolveViewerForChat(visibleTabs(vt().tabs, scopeOf(c1, wsA)), {}, c1) === fileId,
    resolveViewerForChat(visibleTabs(vt().tabs, scopeOf(c1, wsA)), {}, c1),
  )
  // Sets activeId aside first (as a restart does), then syncs the chat.
  useViewerTabs.setState({ activeId: 'schedule' })
  syncViewerToChat(c1)
  check('syncing the chat restores the file tab', vt().activeId === fileId, vt().activeId)
  check('the schedule tab is still open (nothing was closed)', vt().tabs.some((t) => t.id === 'schedule'), vt().tabs.map((t) => t.id))
  check(
    'the schedule page is not what the pane shows',
    shownViewerTabId(vt().tabs, vt().activeId, scopeOf(c1, wsA)) === fileId,
    shownViewerTabId(vt().tabs, vt().activeId, scopeOf(c1, wsA)),
  )
}

console.log('14c) a reopened/resumed split tree follows the active tab:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openSchedule()
  vt().openFile('src/App.tsx', 1, '/ws-a', c1)
  const fileId = `file:${wsA}:src/App.tsx`
  // A resumed split: the schedule page and a file, side by side. The panes paint
  // ONLY tree leaves, so a tab without a leaf used to render nowhere and the
  // previous page stayed on screen — the reported "clicking a file closed the
  // tab and opened Schedule".
  useViewerTabs.setState({
    viewerTree: {
      id: 'n1', kind: 'split', dir: 'row', size: 1,
      children: [
        { id: 'n2', kind: 'leaf', size: 1, chatId: 'schedule' },
        { id: 'n3', kind: 'leaf', size: 1, chatId: fileId },
      ],
    } as any,
    focusedViewerId: fileId,
    activeId: fileId,
  })
  vt().openFile('src/lib/bidi.ts', undefined, '/ws-a', c1)
  const bidiId = `file:${wsA}:src/lib/bidi.ts`
  vt().ensureViewerTree()
  const tree = vt().viewerTree
  check('opening a file keeps the split pane count', !!tree && leafCount(tree) === 2, tree)
  check('the new tab is revealed in a pane', !!tree && collectChatIds(tree).includes(bidiId), tree && collectChatIds(tree))
  check('the focused pane is the new tab', vt().focusedViewerId === bidiId, vt().focusedViewerId)
  check('nothing was closed by opening it', vt().tabs.some((t) => t.id === fileId) && vt().tabs.some((t) => t.id === 'schedule'), vt().tabs.map((t) => t.id))
  // Clicking a tab must show THAT tab, not the page that happened to be
  // painted in the focused pane.
  vt().setActiveViewer(fileId)
  check('clicking a tab reveals it in the pane', !!vt().viewerTree && collectChatIds(vt().viewerTree as any).includes(fileId), vt().viewerTree && collectChatIds(vt().viewerTree as any))
  check('clicking a tab focuses it', vt().focusedViewerId === fileId, vt().focusedViewerId)
  check('clicking a tab closed nothing', vt().tabs.length === 3, vt().tabs.map((t) => t.id))
}

console.log('15) closeAllViewers — closes only the focused scope, keeps history:')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  const [c2] = chatInWs('/ws-a')
  vt().openGitDiff(c1)
  vt().openTraces(c1, 'all')
  vt().openTraces(c2, 'all')
  check('three tabs open', vt().tabs.length === 3, vt().tabs.length)
  vt().closeAllViewers(c1)
  // The workspace Git tab + chat 1's trace are visible in c1's scope; chat 2's
  // trace is not.
  check('only the other chat trace remains', vt().tabs.length === 1 && vt().tabs[0].id === `trace:${c2}`, vt().tabs.map((t) => t.id))
  check('closed tabs kept for reopen', vt().closedTabs.length === 2, vt().closedTabs.length)
  check('active falls back to remaining tab', vt().activeId === `trace:${c2}`, vt().activeId)
  vt().closeAllViewers()
  check('close-all empties the list', vt().tabs.length === 0, vt().tabs.length)
  check('no-op on empty list', (() => {
    vt().closeAllViewers()
    return vt().tabs.length === 0
  })())
}

console.log('16) browser tab carries the url the agent opened (not about:blank):')
{
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const c1 = useStore.getState().newChat('ask')

  // The agent's `browser_navigate` arg must reach the tab: docking a blank
  // browser while the agent worked on a real page was the reported bug.
  vt().openBrowser(c1, 'https://example.com/docs')
  const tab = vt().tabs.find((t) => t.kind === 'browser')
  check('browser tab opened', !!tab, vt().tabs.map((t) => t.id))
  check('tab carries the agent url', tab?.browserUrl === 'https://example.com/docs', tab?.browserUrl)

  // A later navigation in the SAME turn moves the panel to the new page.
  vt().setBrowserUrl(c1, 'https://example.com/page2')
  check(
    'setBrowserUrl moves the panel',
    vt().tabs.find((t) => t.kind === 'browser')?.browserUrl === 'https://example.com/page2',
    vt().tabs.find((t) => t.kind === 'browser')?.browserUrl,
  )

  // about:blank is never stored — the panel launches blank on its own.
  resetViewer()
  vt().openBrowser(c1, 'about:blank')
  check(
    'about:blank is not stored as a url',
    vt().tabs.find((t) => t.kind === 'browser')?.browserUrl === undefined,
    vt().tabs.find((t) => t.kind === 'browser')?.browserUrl,
  )

  // setBrowserUrl on a chat with no browser tab must not create one.
  resetViewer()
  vt().setBrowserUrl(c1, 'https://example.com/ghost')
  check('setBrowserUrl never opens a tab', vt().tabs.length === 0, vt().tabs.length)

  // The url survives a persist/load round-trip (tab restore after restart).
  resetViewer()
  vt().openBrowser(c1, 'https://example.com/kept')
  const stored = JSON.parse(memStore.get('coder:viewerTabs') ?? '{}') as {
    tabs?: Array<Record<string, unknown>>
  }
  check(
    'url survives persistence',
    stored.tabs?.some((t) => t.browserUrl === 'https://example.com/kept') === true,
    stored.tabs,
  )
}

console.log('N) nextTerminalTabId — Ctrl+X [ / ] cycles terminal tabs in strip order:')
{
  const { nextTerminalTabId } = await import('./viewerTabs')
  resetViewer()
  const vt = () => useViewerTabs.getState()
  const [c1, wsA] = chatInWs('/ws-a')
  vt().openTerminal({ cwd: '/ws-a', fresh: true })
  vt().openTerminal({ cwd: '/ws-a', fresh: true })
  vt().openTerminal({ cwd: '/ws-a', fresh: true })
  const scope = scopeOf(c1, wsA)
  const ids = visibleTabs(vt().tabs, scope)
    .filter((t) => t.kind === 'terminal')
    .map((t) => t.id)
  check('three terminal tabs opened in scope', ids.length === 3, ids)
  const at = (i: number) => ids[i]
  check('next moves forward', nextTerminalTabId(vt().tabs, scope, at(0), 1) === at(1))
  check('next from the last wraps to the first', nextTerminalTabId(vt().tabs, scope, at(2), 1) === at(0))
  check('prev moves backward', nextTerminalTabId(vt().tabs, scope, at(2), -1) === at(1))
  check('prev from the first wraps to the last', nextTerminalTabId(vt().tabs, scope, at(0), -1) === at(2))
  check('no active terminal lands on the first', nextTerminalTabId(vt().tabs, scope, null, 1) === at(0))
  check('a foreign active id is ignored (lands on the first)', nextTerminalTabId(vt().tabs, scope, 'file:nope', 1) === at(0))
  check('no terminals -> null', nextTerminalTabId([], scope, null, 1) === null)
  // Terminals are WORKSPACE-scoped: another workspace's shells stay out.
  const [c2] = chatInWs('/ws-b')
  vt().openTerminal({ cwd: '/ws-b', fresh: true })
  check('other workspace terminals stay out of scope', nextTerminalTabId(vt().tabs, scope, at(0), 1) === at(1))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll viewerTabs checks passed')
process.exit(0)
