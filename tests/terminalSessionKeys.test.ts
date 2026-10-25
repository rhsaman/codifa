// Session bookkeeping for right-pane terminal tabs (src/lib/terminalSessions.ts).
//
// THE BUG THIS LOCKS: the session map used to be keyed by the BACKEND pty id
// while every consumer — peek, attach, fit, close — only ever knows the TAB id.
// Every lookup therefore missed, so the screen was never fitted (xterm stayed
// on its default 80x24 grid inside a much wider pane: tiny text in the top-left
// corner of a mostly-black box) and closing a tab never found the session to
// kill, leaking the pty and its process tree.
//
// Also locked: closing a tab kills the PTY id (not the tab id it was asked for).
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
    // A stubbed desktop bridge: the store hydrates through it at import time.
    // The Proxy answers ANY method with a harmless value, so a new call added to
    // the hydration path never breaks this test.
    {
      terminalCreate: async (cwd: string, program?: string) => ({
        id: 'pty-1',
        cwd,
        program: program ?? null,
      }),
      terminalList: async () => [],
      terminalWrite: async () => ({ ok: true }),
      terminalResize: async (id: string, cols: number, rows: number) => {
        resizes.push({ id, cols, rows })
        return { ok: true }
      },
      terminalKill: async (id: string) => {
        kills.push(id)
        return { ok: true }
      },
      // Event subscriptions are captured so a test can push REAL pty output
      // through the same callbacks the app registers. Without these the router
      // was never exercised and the pty-id/tab-id mix-up stayed invisible.
      onTerminalData: (cb: (id: string, data: string) => void) => {
        dataListeners.push(cb)
        return () => {
          const i = dataListeners.indexOf(cb)
          if (i >= 0) dataListeners.splice(i, 1)
        }
      },
      onTerminalExit: (cb: (id: string) => void) => {
        exitListeners.push(cb)
        return () => {
          const i = exitListeners.indexOf(cb)
          if (i >= 0) exitListeners.splice(i, 1)
        }
      },
    },
    {
      get: (target: Record<string, unknown>, prop) => {
        if (prop === 'then') return undefined
        return prop in target ? target[prop as string] : async () => {}
      },
    },
  ),
}
;(globalThis as any).document = {
  documentElement: { dataset: {}, style: { setProperty: () => {} } },
  addEventListener: () => {},
  removeEventListener: () => {},
}
// xtermTheme() reads the theme CSS variables through it at spawn time.
;(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => '' })

const resizes: Array<{ id: string; cols: number; rows: number }> = []
const kills: string[] = []
/** The callbacks the app registered through the bridge (see the stub above). */
const dataListeners: Array<(id: string, data: string) => void> = []
const exitListeners: Array<(id: string) => void> = []

const { spies } = await import('./xterm-spy.js')
const { written } = await import('./xterm-spy.js')
const { openTerminalSession, peekTerminalSession, attachTerminalScreen, fitTerminalSession, closeTerminalSession, ownedPtyIds } =
  await import('../src/lib/terminalSessions')
const { NVIM_PROGRAM } = await import('../src/lib/nvimEdit')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

/** A laid-out screen box: fit only acts on a box that has real dimensions.
 *  `ownsXterm` mirrors the DOM probe the session manager uses to detect a
 *  RE-MOUNTED element (an element xterm never painted into is empty).
 *  `moved` collects the nodes re-parented into this box, which is how a
 *  remount keeps the live screen instead of rebuilding it. */
function fakeScreen(width: number, height: number, ownsXterm = false) {
  const moved: unknown[] = []
  const el = {
    dataset: {} as Record<string, string>,
    isConnected: true,
    moved,
    // The manager probes for xterm's own node to know whether THIS element is
    // the one the terminal was opened into.
    querySelector: (sel: string) => (ownsXterm && sel === '.xterm' ? ({} as Element) : null),
    appendChild: (node: unknown) => {
      moved.push(node)
      return node
    },
    getBoundingClientRect: () => ({ width, height, top: 0, left: 0, right: width, bottom: height }),
  }
  return el as unknown as HTMLElement & { moved: unknown[] }
}

const TAB = 'terminal::shell'

console.log('1) a session is keyed by the TAB id, never the pty id:')
{
  const entry = await openTerminalSession(TAB, '/tmp')
  check('the pty was created', entry.id === 'pty-1', entry.id)
  check('peek finds the session by TAB id', peekTerminalSession(TAB) === entry)
  check('the pty id is not a key of its own', peekTerminalSession('pty-1') === null)
}

console.log('2) mounting the screen fits xterm to the box:')
{
  const entry = peekTerminalSession(TAB)!
  // First attach: the element is brand new, so xterm has not painted it yet.
  attachTerminalScreen(entry, fakeScreen(720, 480, false))
  check('the screen was opened once', spies.opened === 1, spies.opened)

  fitTerminalSession(entry)
  check('the box was fitted', spies.fits === 1, spies.fits)
  // 720/8 x 480/16 — i.e. a grid derived from the PANE, not xterm's 80x24 default.
  check('the grid follows the box', entry.term.cols === 90 && entry.term.rows === 30, {
    cols: entry.term.cols,
    rows: entry.term.rows,
  })
  check('the fitted grid reached the pty', resizes.at(-1)?.cols === 90 && resizes.at(-1)?.rows === 30, resizes)
  check('and it went to the PTY id', resizes.at(-1)?.id === 'pty-1', resizes.at(-1))
}

console.log('3) a not-yet-laid-out box is skipped instead of fitting to nothing:')
{
  const entry = peekTerminalSession(TAB)!
  const before = spies.fits
  attachTerminalScreen(entry, fakeScreen(0, 0, true))
  fitTerminalSession(entry)
  check('the zero box was not fitted', spies.fits === before, spies.fits)
}

console.log('3b) a REMOUNTED screen keeps the LIVE terminal (buffer preserved):')
{
  // The tab is switched away and back: React mounts a NEW div while the old one
  // (holding the canvas) is detached. Swapping tabs used to DISPOSE the terminal
  // and build a blank one, so returning to a tab that was running nvim showed an
  // empty screen. The fix MOVES xterm's own node into the new box instead, which
  // keeps the scrollback and everything the program had drawn.
  const entry = peekTerminalSession(TAB)!
  const openedBefore = spies.opened
  const disposedBefore = spies.disposed
  const live = (entry.term as unknown as { element?: unknown }).element
  const next = fakeScreen(720, 480, false)
  // xterm's real `open` paints into the FIRST box, so that box already holds the
  // node; only the re-parent into `next` matters here.
  next.moved.length = 0
  attachTerminalScreen(entry, next)
  check('the live terminal was NOT disposed', spies.disposed === disposedBefore, spies.disposed)
  check('and NOT rebuilt (no second open)', spies.opened === openedBefore, spies.opened)
  check('the same screen node moved into the new box', next.moved.length === 1 && next.moved[0] === live, next.moved)
  check('the entry points at the new box', entry.el === next, entry.el === next)
  fitTerminalSession(entry)
  check('the grid still reached the pty', resizes.at(-1)?.cols === 90 && resizes.at(-1)?.rows === 30, resizes.at(-1))
  check('still under the pty id', resizes.at(-1)?.id === 'pty-1', resizes.at(-1))
}

console.log('3c) re-attaching the SAME element does not rebuild the terminal:')
{
  const entry = peekTerminalSession(TAB)!
  const el = fakeScreen(720, 480, true)
  attachTerminalScreen(entry, el)
  const opened = spies.opened
  const disposed = spies.disposed
  attachTerminalScreen(entry, el)
  check('nothing was disposed on a same-element re-attach', spies.disposed === disposed, spies.disposed)
  check('and nothing was re-opened', spies.opened === opened, spies.opened)
  // This session's pty belongs to the PANE, so the bottom panel's open-sweep
  // (terminalList → adopt) must skip it — otherwise the nvim of the right pane
  // showed up as a bottom chip AND died with that panel.
  check('the pane\'s pty is marked as panel-owned', ownedPtyIds().has('pty-1'), ownedPtyIds())
}

console.log('3d) pty OUTPUT reaches xterm even though ids differ (pty id vs tab id):')
{
  // THE BLANK-PANE BUG: `terminal:data` arrives carrying the BACKEND pty id
  // (`pty-1`), while the session map is keyed by the TAB id. Routing looked the
  // entry up by the pty id, missed every time, and threw the shell's output
  // away — the pane stayed empty with no error anywhere.
  const mark = written.length
  const w = (s: string) => written.slice(mark).join('').includes(s)

  check('the app subscribed to pty data', dataListeners.length > 0, dataListeners.length)
  for (const cb of dataListeners) cb('pty-1', 'hello from the shell\r\n')
  check('the pty output was written to xterm', w('hello from the shell'), written.slice(mark))

  for (const cb of exitListeners) cb('pty-1')
  check('an exit of the SAME pty also reaches this terminal', written.length > mark + 1, written.length - mark)
}

console.log('4) closing the TAB kills its pty:')
{
  closeTerminalSession(TAB)
  await new Promise((r) => setTimeout(r, 0))
  check('the kill used the PTY id', kills[0] === 'pty-1', kills)
  check('the entry is gone', peekTerminalSession(TAB) === null)
  check('the xterm was disposed', spies.disposed >= 1, spies.disposed)

  // A leftover translation would route a NEW session's output into the dead
  // entry if the backend ever handed out the same pty id again.
  const afterClose = written.length
  for (const cb of dataListeners) cb('pty-1', 'late output')
  check('a closed pty routes nowhere', written.length === afterClose, written.length - afterClose)
}

console.log('5) a second open of the same tab reuses its session:')
{
  const a = await openTerminalSession('terminal::nvim', '/tmp', NVIM_PROGRAM, ['+7', '/tmp/a.ts'])
  const b = await openTerminalSession('terminal::nvim', '/tmp', NVIM_PROGRAM, ['+7', '/tmp/a.ts'])
  check('the same entry comes back (no second pty)', a === b)
  check('peek agrees', peekTerminalSession('terminal::nvim') === a)
}

export {}

if (failed > 0) {
  console.error(`\nterminalSessionKeys: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nterminalSessionKeys: all checks passed')
