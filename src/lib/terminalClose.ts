/**
 * What `Ctrl+W` / `Cmd+W` closes while the caret sits in a terminal.
 *
 * Two terminal hosts exist and they are NOT the same kind of tab:
 *
 *  - the BOTTOM panel is a multi-tab host of its own — it owns the gesture
 *    and closes its ACTIVE shell;
 *  - a RIGHT-PANE terminal is one ordinary viewer tab among the pane's tabs
 *    (it shares the strip with files/browser/trace tabs).
 *
 * The reported bug: pressing Ctrl+W inside the right-pane terminal collapsed
 * the whole terminal (the pane fell back to the Todos page) instead of closing
 * that one tab. The window handler resolved the host from the EVENT TARGET's
 * `.terminal-panel` ancestry only, so a pane terminal never matched and fell
 * through to "close whatever the pane shows". This module makes the decision
 * explicit and independent of the DOM.
 *
 * On top of that, which modifier closes is per-host, because the terminal
 * chord must not shadow the shell:
 *
 *  - BOTTOM panel: Ctrl+W AND Cmd+W both close the shell tab (the panel is the
 *    app's own surface, it never sends the chord to the pty);
 *  - RIGHT-PANE terminal: Ctrl+W is Ctrl+W in readline/emacs (kill the word
 *    before the caret) and MUST reach the shell — only Cmd+W (Apple) /
 *    Ctrl+Shift+W (elsewhere) closes the tab. That is the same rule the app
 *    already applies to the other terminal chords (see isReservedTerminalChord).
 */

export type TerminalHost = 'bottom' | 'pane'

export interface TerminalCloseEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/** Which terminal host holds the caret, judged from the element chain of the
 *  event target (and then of `document.activeElement`). `null` → not a
 *  terminal. */
export function terminalHostFor(
  target: { closest?: (sel: string) => unknown } | null | undefined,
  active: { closest?: (sel: string) => unknown } | null | undefined = null,
): TerminalHost | null {
  const inBottom = !!(target?.closest?.('.terminal-panel') || active?.closest?.('.terminal-panel'))
  if (inBottom) return 'bottom'
  const inPane = !!(target?.closest?.('.terminal-tab-panel') || active?.closest?.('.terminal-tab-panel'))
  return inPane ? 'pane' : null
}

/** Does this `W` press close the terminal tab of `host`? (The caller only asks
 *  once `terminalHostFor` said the caret is in a terminal.) */
export function terminalCloseChord(
  host: TerminalHost,
  e: TerminalCloseEvent,
  apple: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'w' || e.altKey) return false
  if (host === 'bottom') {
    // The panel owns both halves: Cmd+W on Apple, Ctrl+W elsewhere, and the
    // crossed-over variant too (users press Ctrl+W out of muscle memory).
    return e.metaKey !== e.ctrlKey && !e.shiftKey
  }
  // Right-pane terminal: plain Ctrl+W is shell input (^W), so it never closes.
  if (apple) return e.metaKey && !e.ctrlKey && !e.shiftKey
  return e.ctrlKey && e.shiftKey === true && !e.metaKey
}
