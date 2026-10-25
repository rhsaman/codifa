/**
 * Pty sessions owned by right-pane TERMINAL TABS.
 *
 * The bottom panel and the side pane are two independent hosts on purpose:
 * closing every bottom shell must never touch a tab's session (and vice versa).
 * Each entry is one pty from src-tauri/src/pty.rs plus its xterm screen; the
 * screens are kept alive while their tab is merely switched away, so switching
 * tabs preserves the scrollback exactly like the bottom panel does.
 *
 * Deliberately NOT React: viewerTabs imports this module to kill a session when
 * its tab closes, so the dependency stays lib -> lib.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebKitDeadKeyAddon } from './webkitDeadKey'
import { suppressField } from './inputSuppress'
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, registerTerminalScreen, xtermTheme } from './xtermTheme'
import { isReservedTerminalChord } from './terminalKeys'
import { registerViewerTabCloseHook } from './viewerTabs'
import { useStore } from './store'

export interface TerminalSessionEntry {
  /** Backend pty id (the tab id is the request key, this is the session). */
  id: string
  term: Terminal
  fit: FitAddon
  /** The screen div, null while the tab is not mounted. */
  el: HTMLElement | null
  /** Whether term.open() already ran. Lives on the entry because a re-mount
   *  hands us a different div for the SAME live terminal. */
  mounted: boolean
  /** Detaches this screen from the live-font registry (Settings → Appearance
   *  re-applies the terminal point size to every registered screen). */
  offFont: () => void
}

const entries = new Map<string, TerminalSessionEntry>()
/**
 * BACKEND pty id -> TAB id, for routing pty events.
 *
 * The two id spaces are different on purpose: the backend mints a pty id when
 * it spawns (`pty-1`), while this map is keyed by the TAB id (`terminal:c1:shell`)
 * because that is all a consumer ever knows. `terminal:data`/`terminal:exit`
 * arrive carrying the PTY id, so a lookup straight into `entries` missed EVERY
 * time — output was never written to xterm and the pane stayed blank. Event
 * routing must therefore translate through this map first.
 */
const tabByPtyId = new Map<string, string>()
/** In-flight creates, so a double mount never spawns two ptys for one tab. */
const pending = new Map<string, Promise<TerminalSessionEntry>>()
let transportOff: (() => void) | null = null

/** Entry behind a PTY id, or null when no tab owns it (already closed). */
function entryByPtyId(ptyId: string): TerminalSessionEntry | null {
  const tabId = tabByPtyId.get(ptyId)
  return tabId ? entries.get(tabId) ?? null : null
}

function hasTerminalApi(): boolean {
  return typeof window !== 'undefined' && typeof window.coder?.terminalCreate === 'function'
}

/** One pair of event subscriptions for EVERY tab session. Output is routed by
 *  pty id; a session whose tab is not on screen simply has no element and drops
 *  nothing — its xterm keeps buffering. */
function ensureTransport(): void {
  if (transportOff || !hasTerminalApi()) return
  const offData = window.coder.onTerminalData((id, data) => {
    entryByPtyId(id)?.term.write(data)
  })
  const offExit = window.coder.onTerminalExit((id) => {
    // The program ended on its own (`exit`): the tab stays and reports the
    // shell's exit, mirroring the bottom panel, which keeps the buffer so the
    // last output is still readable.
    entryByPtyId(id)?.term.write('\r\n')
  })
  transportOff = () => {
    offData()
    offExit()
    transportOff = null
  }
}

/** Drop the shared transport (app teardown / HMR). */
export function disposeTerminalTransport(): void {
  transportOff?.()
}

export function peekTerminalSession(tabId: string): TerminalSessionEntry | null {
  return entries.get(tabId) ?? null
}

/** Spawn (once) the pty behind a terminal tab and return its xterm entry.
 *  `program`/`args` run one program instead of a login shell — that is how the
 *  in-app "Neovim" target works. `shell` picks the SHELL of a plain tab without
 *  pretending to be that program (a `program: "zsh"` would run zsh with no
 *  login flags and leave an empty screen). */
export function openTerminalSession(
  tabId: string,
  cwd: string,
  program?: string,
  args?: string[],
  shell?: string,
): Promise<TerminalSessionEntry> {
  const existing = entries.get(tabId)
  if (existing) return Promise.resolve(existing)
  const inflight = pending.get(tabId)
  if (inflight) return inflight
  if (!hasTerminalApi()) return Promise.reject(new Error('terminal API unavailable'))
  ensureTransport()

  const created = (async () => {
    const info = await window.coder.terminalCreate(cwd, program, args, program ? undefined : shell)
    const id = info?.id
    // The render reads `id`; a malformed reply must not create a phantom entry.
    if (!id || typeof id !== 'string') throw new Error('terminal_create returned no session id')

    const { term, fit } = buildTerminal(id)
    // Register for live point-size changes; the fit makes the new size visible
    // immediately instead of on the next resize.
    const offFont = registerTerminalScreen({ term, refit: fit.fit.bind(fit) })
    const entry: TerminalSessionEntry = { id, term, fit, el: null, mounted: false, offFont }
    // Keyed by the TAB id, never the pty id: every consumer (peek/attach/fit/
    // close) only ever knows the tab id. Keying this map by the pty id made
    // every lookup miss — the screen was never fitted (so xterm stayed on its
    // default 80x24 grid inside a much larger pane) and closing the tab never
    // found the session to kill it.
    entries.set(tabId, entry)
    tabByPtyId.set(id, tabId)
    return entry
  })()

  pending.set(tabId, created)
  const settle = () => pending.delete(tabId)
  created.then(settle, settle)
  return created
}

/** Build the xterm screen for one pty id: the palette, the fit addon, the
 *  dead-key repair and the input/resize wiring. Used both when the session is
 *  created and when it has to be rebuilt against a REPLACED screen element. */
function buildTerminal(id: string): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    // Live size from Settings → Appearance (the right-pane host reads the same
    // setting as the bottom panel, so both screens stay in step).
    fontSize: useStore.getState().terminalFontSize || TERMINAL_FONT_SIZE,
    // Shared stack (see xtermTheme): matches the user's own desktop terminal so
    // a file opened here and in an external terminal read identically.
    fontFamily: TERMINAL_FONT_FAMILY,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 4000,
    convertEol: false,
    theme: xtermTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  // WKWebView dead-key repair, loaded before the hidden textarea exists so the
  // addon can bind to it on open() (see src/lib/webkitDeadKey.ts).
  const deadKey = new WebKitDeadKeyAddon((data) => {
    void window.coder.terminalWrite(id, data)
  })
  term.loadAddon(deadKey)
  term.onData((data) => {
    void window.coder.terminalWrite(id, data)
  })
  let lastCols = -1
  let lastRows = -1
  term.onResize(({ cols, rows }) => {
    // Fit-loop guard: an appearing/disappearing scrollbar oscillates the fit,
    // and re-sending the same grid makes the shell redraw its prompt line.
    if (cols === lastCols && rows === lastRows) return
    lastCols = cols
    lastRows = rows
    void window.coder.terminalResize(id, cols, rows)
  })
  // App chords (Cmd/Ctrl+J / W / M / X) must reach the window-level handler
  // instead of the pty, or Ctrl+J arrives as ^J and Ctrl+M runs the
  // half-typed line.
  term.attachCustomKeyEventHandler((ev) => {
    if (deadKey.repair.handle(ev)) return false
    if (!isReservedTerminalChord(ev)) return true
    ev.preventDefault()
    return false
  })
  return { term, fit }
}

/** Attach a session to a freshly-mounted screen div. The ref callback runs with
 *  null on unmount — the entry survives that and comes back on the next mount. */
export function attachTerminalScreen(entry: TerminalSessionEntry, el: HTMLElement | null): void {
  if (!el) {
    // Keep the entry (buffer + pty) but forget the dead element so a later
    // mount does not fit against a detached node.
    if (entry.el && !entry.el.isConnected) entry.el = null
    return
  }
  // A tab switched away and back (or any React remount) mounts a NEW div while
  // the xterm DOM still lives inside the OLD, detached one — the new div would
  // stay blank and typing would go to a screen nobody can see.
  //
  // MOVE the live screen instead of rebuilding it: xterm only ever references
  // `term.element`, never its parent, so re-parenting that node keeps the whole
  // buffer, the scrollback and whatever the running program (nvim) has drawn.
  // Rebuilding here used to dispose the terminal and start a blank one, which
  // is exactly why returning to a tab showed an empty screen.
  if (entry.el !== el) {
    const screen = entry.term.element
    if (screen) {
      el.appendChild(screen)
    } else {
      entry.term.open(el)
      suppressField(entry.term.textarea)
      entry.mounted = true
    }
  }
  entry.el = el
  if (!entry.mounted) {
    entry.term.open(el)
    // xterm's hidden input ships autocorrect/autocapitalize/spellcheck off but
    // NOT autocomplete, so macOS still offers autofill over the terminal.
    suppressField(entry.term.textarea)
    // Tracked on the ENTRY, not as a data attribute on the element: a tab that
    // is switched away and back mounts a NEW div, so an element-scoped flag
    // would make us call term.open() a second time on a live terminal.
    entry.mounted = true
  }
}

/** Fit the screen to its box and push the new grid to the pty. Skips a box that
 *  is not laid out yet (a hidden tab measures 0). */
export function fitTerminalSession(entry: TerminalSessionEntry): void {
  const el = entry.el
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width < 40 || rect.height < 40) return
  try {
    entry.fit.fit()
  } catch {
    /* xterm refuses to fit before open() */
  }
}

/** Dispose the xterm AND kill its pty. Called when the tab is CLOSED (not when
 *  it is merely switched away) and on app teardown. Takes the TAB id; the pty
 *  id it kills is the one carried by the entry. */
export function closeTerminalSession(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entries.delete(tabId)
  // Drop the pty-id translation too: a leftover mapping would route a NEW
  // session's output into this dead entry if the backend ever reused the id.
  tabByPtyId.delete(entry.id)
  entry.offFont()
  entry.term.dispose()
  const ptyId = entry.id
  if (hasTerminalApi()) void window.coder.terminalKill(ptyId).catch(() => {})
}

/** Kill every tab session. App teardown / HMR safety net — the Rust side
 *  terminates whatever is left when the app quits either way. */
export function closeAllTerminalSessions(): void {
  for (const tabId of [...entries.keys()]) closeTerminalSession(tabId)
  disposeTerminalTransport()
}

// A tab leaving `tabs` is the only "closed for good" signal (a plain unmount
// also happens when the user merely switches tabs), so the session is released
// from that hook rather than from a component lifecycle.
registerViewerTabCloseHook((tabId) => closeTerminalSession(tabId))
