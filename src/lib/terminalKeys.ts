/** Chord guard shared by every terminal host (the bottom panel and the
 *  right-pane terminal tabs).
 *
 *  Cmd/Ctrl + one of these is an APP chord, never shell input: the platform's
 *  close chord (Cmd+W on Apple, Ctrl+W elsewhere) closes the active tab,
 *  M = fullscreen (bottom panel; a right-pane terminal tab fullscreens the
 *  pane), X = the app's prefix (Ctrl+X J is the ONLY way to toggle the bottom
 *  panel). J stays reserved so ^J never reaches the shell as a newline that
 *  would run the half-typed line. The OTHER half of the W chord is NOT
 *  reserved: bare Ctrl+W on Apple is the shell's delete-previous-word (^W).
 *  Checked on
 *  `keypress` as well as `keydown` — see the caller — and `code` is checked
 *  too so the chords survive non-Latin keyboard layouts.
 *
 *  Pure, for tests: no DOM, no xterm. */
import { isPrefixArmed } from './prefixState'
import { isApplePlatform } from './shortcuts'
export const RESERVED_TERMINAL_CHORDS = ['j', 'm', 'x'] as const

/** W is NOT in the list above: only ONE modifier half of the chord is the
 *  app's close (Cmd on Apple, Ctrl elsewhere) — the other half is the shell's
 *  own delete-previous-word (^W) and must reach the pty untouched. */
const CLOSE_CHORD_KEY = 'w'

/** The second key of the Ctrl+X prefix, as ran inside the terminal: xterm must
 *  NOT send it to the shell, and App.tsx runs the chord with it (`j` toggles
 *  the terminal panel). Declared here so the guard stays the single source of
 *  what the shell never sees. `v` toggles the live voice session. */
export const PREFIX_SECOND_KEYS = ['j', 'u', 'r', 'c', 'v', ' '] as const

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
  const physical = (ev.code || '').replace(/^Key/, '').toLowerCase()
  const pressed = (ev.key || '').toLowerCase()
  const matches = (keys: readonly string[]) => keys.some((k) => pressed === k || physical === k)
  // The second key of the Ctrl+X prefix: no modifier on it, but the app's
  // prefix is armed (App.tsx sets `coder:prefix`), so xterm must hand it to
  // the window handler instead of sending it to the shell.
  if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
    if (isPrefixArmed() && matches(PREFIX_SECOND_KEYS)) return true
  }
  // Cmd and Ctrl are each reserved on their OWN (never both), on every
  // platform: Ctrl+J on macOS must not become a newline either.
  const chord = (ev.metaKey && !ev.ctrlKey) || (ev.ctrlKey && !ev.metaKey)
  if (!chord) return false
  if (pressed === CLOSE_CHORD_KEY || physical === CLOSE_CHORD_KEY) {
    return isApplePlatform() ? ev.metaKey : ev.ctrlKey
  }
  return matches(RESERVED_TERMINAL_CHORDS)
}
