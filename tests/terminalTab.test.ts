// Terminal TABS in the right pane (kind 'terminal' in viewerTabs).
//
// What this locks, now that the old "dock the terminal into the pane" mode is
// gone (the pane hosts ordinary tabs instead):
//   * a terminal tab is an ORDINARY viewer tab — chat-scoped, closable,
//     reorderable — so the pane's tab machinery treats it like any other;
//   * the run target (program + argv) is part of the tab ID, so asking for the
//     same file again FOCUSES that tab instead of paying for a second Neovim;
//   * a terminal tab is NEVER persisted: restoring one would spawn a shell (or
//     an editor) on the next launch, and its pty session id would be dead;
//   * the bottom panel's height/clamp rule survives untouched, because the
//     bottom terminal (Cmd/Ctrl+J) stays a completely separate host.
;(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: (globalThis as any).localStorage,
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
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: { setProperty: () => {} } },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { useViewerTabs, viewerTabId, visibleTabs, viewerTabTitle, registerViewerTabCloseHook } = await import('../src/lib/viewerTabs')
const { clampTerminalHeight, DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT } = await import('../src/lib/store')
const { NVIM_PROGRAM, nvimArgs, runTargetKey } = await import('../src/lib/nvimEdit')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const vt = () => useViewerTabs.getState()

console.log('1) a terminal tab is an ORDINARY, chat-scoped tab:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  vt().openTerminal({ chatId: 'c1', cwd: '/w' })
  const tabs = vt().tabs
  check('exactly one tab was opened', tabs.length === 1, tabs)
  check('its kind is terminal', tabs[0]?.kind === 'terminal', tabs[0])
  check('it carries its chat', tabs[0]?.chatId === 'c1', tabs[0])
  check('it carries its cwd for the pty', tabs[0]?.terminalCwd === '/w', tabs[0])
  check('a bare terminal asks for NO program (a login shell runs)', !tabs[0]?.terminalProgram, tabs[0])
  check('it becomes the active tab', vt().activeId === tabs[0]?.id)
  check('opening it reveals the pane', vt().paneOpen === true)
  // NOT chat-scoped like a file tab: the tab owns a LIVE pty, so hiding it
  // with the chat that spawned it stranded a running shell — and because
  // `active` then resolved to null, the pane fell back to the todos page and
  // looked like a blank terminal.
  check('it is visible in its own chat', visibleTabs(tabs, 'c1').length === 1)
  check('and still visible in another chat (its pty is alive)', visibleTabs(tabs, 'c2').length === 1)
}

console.log('2) the run target is the tab IDENTITY — same file focuses, not duplicates:')
{
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  const args = nvimArgs('/w/a.ts', 42)
  vt().openTerminal({ chatId: 'c1', cwd: '/w', program: NVIM_PROGRAM, args })
  const first = vt().tabs[0]
  check('the editor tab is titled after its program', first?.title === NVIM_PROGRAM, first?.title)
  check('it keeps the requested argv for reuse', first?.terminalArgs?.join(' ') === args.join(' '), first)

  // Same request again: focus, never a second Neovim (one instance of the user's
  // config with its language servers measured ~600 MB).
  vt().setPaneOpen(false)
  vt().openTerminal({ chatId: 'c1', cwd: '/w', program: NVIM_PROGRAM, args })
  check('the same file does not open a second tab', vt().tabs.length === 1, vt().tabs)
  check('and the request re-reveals the pane', vt().paneOpen === true)

  // A different LINE is a different target, so it gets its own tab.
  vt().openTerminal({ chatId: 'c1', cwd: '/w', program: NVIM_PROGRAM, args: nvimArgs('/w/a.ts', 7) })
  check('another line is a second target', vt().tabs.length === 2, vt().tabs.map((t) => t.id))
  const idA = viewerTabId('terminal', 'c1', runTargetKey([NVIM_PROGRAM, ...args]))
  check('the id encodes program + argv', vt().tabs.some((t) => t.id === idA), idA)
}

console.log('2b) the SAME file in another chat reuses the running editor:')
{
  // The tab id is chat-scoped, so an id-only lookup minted a second tab — and a
  // SECOND Neovim — for one file when the file was opened from a second chat.
  // The run target (program + argv) is the identity that saves the RAM.
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  const args = nvimArgs('/w/a.ts', 3)
  vt().openTerminal({ chatId: 'c1', cwd: '/w', program: NVIM_PROGRAM, args })
  const firstId = vt().tabs[0]?.id
  vt().openTerminal({ chatId: 'c2', cwd: '/w', program: NVIM_PROGRAM, args })
  check('another chat does not open a second nvim tab', vt().tabs.length === 1, vt().tabs.map((t) => t.id))
  check('it focuses the tab already running that file', vt().activeId === firstId, { activeId: vt().activeId, firstId })
  // A different program or argv is still a separate tab.
  vt().openTerminal({ chatId: 'c1', cwd: '/w', program: NVIM_PROGRAM, args: nvimArgs('/w/b.ts', 3) })
  check('a different file is still its own tab', vt().tabs.length === 2, vt().tabs.map((t) => t.id))
}

console.log('3) a terminal tab is NEVER persisted (a pty cannot be restored):')
{
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  const memStore = new Map<string, string>()
  ;(globalThis as any).localStorage.getItem = (k: string) => memStore.get(k) ?? null
  ;(globalThis as any).localStorage.setItem = (k: string, v: string) => {
    memStore.set(k, String(v))
  }
  vt().openFile('a.ts', undefined, 'c1')
  vt().openTerminal({ chatId: 'c1', cwd: '/w' })
  const raw = memStore.get('coder:viewerTabs') ?? ''
  check('something was persisted (the file tab)', raw.includes('a.ts'), raw.slice(0, 200))
  check('the terminal tab is not in storage', !raw.includes('terminal'), raw.slice(0, 400))
}

console.log('4) the rail can tell two terminal tabs apart:')
{
  const shell = { kind: 'terminal' as const, title: '', createdAt: 1 } as any
  const editor = { kind: 'terminal' as const, title: 'nvim — a.ts', createdAt: 2 } as any
  check('an untitled tab falls back to its kind label', viewerTabTitle(shell) === 'Terminal', viewerTabTitle(shell))
  check('a titled tab keeps its own title', viewerTabTitle(editor) === 'nvim — a.ts')
}

console.log('5) the BOTTOM panel is untouched — it is a separate host:')
{
  // The bottom terminal's height rule (Cmd/Ctrl+J) must survive the tab rework
  // untouched: the two hosts are independent by design.
  check('the default height is unchanged', DEFAULT_TERMINAL_HEIGHT === 300)
  check('below the floor the strip would eat the shell', clampTerminalHeight(10) === MIN_TERMINAL_HEIGHT)
  check('a sane value passes through', clampTerminalHeight(420) === 420)
  check('garbage falls back to the default', clampTerminalHeight(Number.NaN) === DEFAULT_TERMINAL_HEIGHT)
}

export {}

console.log('7) capping tabs never leaks a session (and never resurrects one):')
{
  // A terminal tab dropped by the tab cap leaves `tabs` for good, so its pty
  // must be closed at that moment — capping is otherwise a silent leak.
  const closed: string[] = []
  registerViewerTabCloseHook((id) => {
    if (id.startsWith('terminal::')) closed.push(id)
  })
  useViewerTabs.setState({ tabs: [], activeId: null, closedTabs: [] })
  // More tabs than TOTAL_TAB_CAP (30). Distinct run targets, because a terminal
  // tab's id is its program + argv (a bare shell dedupes to one tab).
  for (let i = 0; i < 35; i++) {
    useViewerTabs.getState().openTerminal({ cwd: '/tmp', program: 'nvim', args: [`+${i}`, `/tmp/f${i}.ts`] })
  }
  const st = useViewerTabs.getState()
  check('the tab cap holds', st.tabs.length <= 30, st.tabs.length)
  check('the cap really dropped tabs', closed.length > 0, { closed: closed.length, open: st.tabs.length })
  check(
    'no capped-away terminal tab is still open',
    st.tabs.every((t) => !closed.includes(t.id)),
    closed,
  )

  // A terminal tab in "Recently closed" is a tombstone: reopening it must not
  // create a tab whose session id points at a dead pty.
  const v = useViewerTabs.getState()
  v.openTerminal({ cwd: '/tmp', program: 'nvim', args: ['+1', '/tmp/g.ts'] })
  const termId = useViewerTabs.getState().tabs.find((t) => t.kind === 'terminal')?.id ?? ''
  v.closeViewer(termId)
  check('the closed terminal tab is advertised', useViewerTabs.getState().closedTabs.some((c) => c.tab.id === termId))
  useViewerTabs.getState().reopenClosedViewerTab(termId)
  const after = useViewerTabs.getState()
  check('reopening a terminal tab does NOT resurrect it', !after.tabs.some((t) => t.id === termId))
  check('and its tombstone is dropped', !after.closedTabs.some((c) => c.tab.id === termId))
}

if (failed > 0) {
  console.error(`\nterminalTab: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nterminalTab: all checks passed')
