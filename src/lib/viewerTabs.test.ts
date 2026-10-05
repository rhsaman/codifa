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

const { useViewerTabs, viewerTabId, viewerTabTitle, visibleTabs } = await import('./viewerTabs')
const { useStore } = await import('./store')

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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll viewerTabs checks passed')
process.exit(0)
