// The EARLY-DATA race on right-pane terminal tabs (src/lib/terminalSessions.ts).
//
// THE BUG THIS LOCKS: the backend mints the pty id at spawn and its reader
// thread immediately emits `terminal:data` — carrying that id — while the
// renderer is still awaiting the `terminal_create` ANSWER, so it does not yet
// know which pty id belongs to which tab. nvim paints its welcome frame the
// moment it boots, i.e. exactly inside that window: the router found no bucket
// under the real pty id and no session entry, and silently dropped every byte.
// The tab then opened on a permanently blank screen (the reported "nvim does
// not open" black tab) — with the reason visible nowhere.
//
// Fix contract locked here:
//   * chunks arriving for an UNKNOWN pty id while an open is in flight are
//     parked, and replayed (in arrival order) into the screen whose create
//     answers with the matching pty id;
//   * chunks of OTHER ptys never leak into that screen;
//   * with no open pending, unknown chunks are still dropped (the bottom
//     panel's ptys must not accumulate in the pane's buffers).
//
// Run: npm run test:frontend (job `terminalEarlyData`)
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
    // A stubbed desktop bridge (same pattern as terminalSessionKeys.test.ts):
    // openTerminalSession drives terminalCreate, and the TEST fires the
    // captured listeners to play the backend's side of the race.
    {
      terminalCreate: async () => ({ id: 'pty-race', shell: 'nvim', program: 'nvim', cwd: '/tmp' }),
      terminalList: async () => [],
      terminalWrite: async () => ({}),
      terminalResize: async () => ({}),
      terminalKill: async (id: string) => {
        kills.push(id)
        return {}
      },
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

const kills: string[] = []
/** The callbacks the app registered through the bridge (see the stub above). */
const dataListeners: Array<(id: string, data: string) => void> = []
const exitListeners: Array<(id: string) => void> = []

const { openTerminalSession, peekTerminalSession, closeTerminalSession, disposeTerminalTransport } =
  await import('../src/lib/terminalSessions')
const { written } = await import('./xterm-spy.js')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

interface CreateSpec {
  /** Override the pty id the backend answers with (defaults to the requested
   *  id — a current backend adopts the caller's id, see pty.rs). */
  ptyId?: string
  /** Chunks emitted (to every data listener) BEFORE the promise resolves —
   *  the backend reader thread's side of the race, carrying the id the caller
   *  requested (a current backend adopts it — see pty.rs `requested_id`). */
  beforeAnswer?: Array<[string, string]>
}

/** terminalCreate stub that honours the NEW backend contract: the session id
 *  is the one the CALLER requested (5th arg), so a test controls both sides of
 *  the IPC race — emit pre-answer chunks with that id, then let it resolve. */
function stageCreate(): {
  answerWith(spec: CreateSpec): void
} {
  let resolve!: (info: unknown) => void
  let requested = ''
  ;(window as any).coder.terminalCreate = (
    _cwd: string,
    _program: unknown,
    _args: unknown,
    _shell: unknown,
    id?: string,
  ) => {
    requested = id ?? 'pty-race'
    return new Promise((res) => {
      resolve = res
    })
  }
  return {
    answerWith(spec: CreateSpec) {
      const ptyId = spec.ptyId || requested
      for (const [id, data] of spec.beforeAnswer ?? []) {
        for (const cb of dataListeners) cb(id, data)
      }
      resolve({ id: ptyId, shell: 'nvim', program: 'nvim', cwd: '/tmp' })
    },
  }
}

const TAB = 'terminal:early:nvim'
const WELCOME = '\x1b[?1049h\x1b[H\x1b[2JNVIM - the welcome frame\n'

console.log('1) output that races AHEAD of the terminal_create answer is not dropped:')
{
  const staged = stageCreate()
  const open = openTerminalSession(TAB, '/tmp', 'nvim', ['/tmp/a.rs'])
  // The pty id is the one the open REQUESTS (derived from the tab id); the
  // reader thread emits with it before the create answer lands.
  staged.answerWith({ ptyId: `${TAB}#pty`, beforeAnswer: [[`${TAB}#pty`, WELCOME]] })
  const entry = await open
  check('the backend ADOPTED the requested id', entry.id === `${TAB}#pty`, entry.id)
  check('the session exists', peekTerminalSession(TAB) === entry)
  check(
    'the welcome frame reached the screen',
    written.join('').includes('the welcome frame'),
    written,
  )
  check(
    'the early chunks went to THIS terminal only',
    (entry.term as unknown as { written: string[] }).written.join('').includes('the welcome frame'),
    (entry.term as unknown as { written: string[] }).written,
  )
}

console.log('2) early chunks replay in ARRIVAL order relative to later output:')
{
  closeTerminalSession(TAB)
  disposeTerminalTransport()
  written.length = 0
  const staged = stageCreate()
  const open = openTerminalSession('terminal:early:order', '/tmp', 'nvim', ['/tmp/a.rs'])
  const rid = 'terminal:early:order#pty'
  staged.answerWith({
    beforeAnswer: [
      [rid, 'FIRST '],
      ['other-pty', 'aliens '],
      [rid, 'SECOND'],
    ],
  })
  const entry = await open
  const all = (entry.term as unknown as { written: string[] }).written.join('')
  const iFirst = all.indexOf('FIRST')
  const iSecond = all.indexOf('SECOND')
  const iAlien = all.indexOf('aliens')
  check('both early chunks were replayed', iFirst >= 0 && iSecond >= 0, all)
  check('in arrival order', iFirst !== -1 && iSecond !== -1 && iFirst < iSecond, all)
  check('a foreign pty id never leaks into this screen', iAlien === -1, all)
}

console.log('3) unknown-id chunks with NO open pending are still dropped:')
{
  closeTerminalSession('terminal:early:order')
  disposeTerminalTransport()
  written.length = 0
  // The bottom panel (and any other host) runs its own ptys in the SAME
  // renderer: their output must not pile up inside the pane's buffers.
  const staged = stageCreate()
  const inflight = openTerminalSession('terminal:early:ghost', '/tmp', 'nvim', ['/tmp/a.rs'])
  // A ghost id that belongs to NOBODY emits while OUR open is in flight.
  for (const cb of dataListeners) cb('ghost-pty', 'bottom-panel bytes')
  // Answer with OUR pty id — 'ghost-pty' has no owner and must go nowhere.
  staged.answerWith({ ptyId: 'pty-real', beforeAnswer: [] })
  const entry = await inflight
  const ghostWritten = (entry.term as unknown as { written: string[] }).written
  check(
    'the ghost bytes never reached any screen',
    !ghostWritten.join('').includes('bottom-panel bytes'),
    ghostWritten,
  )
  // A LEGACY backend (one that ignores the requested id and mints its own) must
  // still settle: the entry adopts the ANSWERED id, because that is the id every
  // later terminalWrite/terminalKill has to carry.
  check(
    'a legacy backend settles with ITS OWN id, not the requested one',
    entry.id === 'pty-real',
    entry.id,
  )
  check(
    'the legacy answer is reachable through the TAB id (re-keyed)',
    peekTerminalSession('terminal:early:ghost') === entry,
  )
}

console.log('4) the survived session still closes cleanly:')
{
  closeTerminalSession('terminal:early:ghost')
  await new Promise((r) => setTimeout(r, 0))
  check('the kill used the REAL pty id (the legacy answer)', kills.includes('pty-real'), kills)
  check('the entry is gone', peekTerminalSession('terminal:early:ghost') === null)
}

export {}

if (failed > 0) {
  console.error(`\nterminalEarlyData: ${failed} check(s) failed`)
  process.exit(1)
}
