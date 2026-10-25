/** Chord guard shared by every terminal host (the bottom panel and the
 *  right-pane terminal tabs).
 *
 *  Cmd/Ctrl + one of these is an APP chord, never shell input: J = bottom
 *  panel, W = close the active tab, M = terminal fullscreen, X = the app's
 *  prefix. Checked on `keypress` as well as `keydown` — see the caller — and
 *  `code` is checked too so the chords survive non-Latin keyboard layouts.
 *
 *  Pure, for tests: no DOM, no xterm. */
export const RESERVED_TERMINAL_CHORDS = ['j', 'w', 'm', 'x'] as const

export interface TerminalChordEvent {
  type: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
  code: string
}

/** True when the event must be left to the window-level handler instead of
 *  reaching the pty. Returning false to xterm for these is what keeps ^J/^M/^X
 *  out of the shell — typing Ctrl+M used to run the half-typed line. */
export function isReservedTerminalChord(ev: TerminalChordEvent): boolean {
  // `keyup` only clears xterm's own bookkeeping — never suppress it.
  if (ev.type === 'keyup') return false
  // Shift/Alt combinations are ordinary terminal input.
  if (ev.altKey || ev.shiftKey) return false
  // Cmd and Ctrl are each reserved on their OWN (never both), on every
  // platform: Ctrl+J on macOS must not become a newline either.
  const chord = (ev.metaKey && !ev.ctrlKey) || (ev.ctrlKey && !ev.metaKey)
  if (!chord) return false
  const physical = (ev.code || '').replace(/^Key/, '').toLowerCase()
  const pressed = (ev.key || '').toLowerCase()
  return RESERVED_TERMINAL_CHORDS.some((k) => pressed === k || physical === k)
}
