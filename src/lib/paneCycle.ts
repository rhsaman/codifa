/**
 * Ctrl+X pane navigation: move the caret between the app's panes — sidebar,
 * chat column, right viewer pane and bottom terminal.
 *
 * The movement is DIRECTION-BASED, mirroring the screen layout, not a linear
 * ring: the sidebar is left of the chat column, the viewer pane right of it,
 * and the terminal below it. So
 *
 *   h / l  move horizontally  sidebar ↔ chat ↔ viewer
 *   k / j  move vertically    any pane → terminal → back to the chat
 *
 * The sidebar lays its list out as rows, so `j`/`k` there walk that list (see
 * src/lib/sidebarStep.ts) and only reach the pane ring when the list is empty:
 * this ring owns the *pane* hop, the caller decides when the list gets the key.
 *
 * A pane that is CLOSED is still a valid target — the caller opens it first
 * (src/lib/paneFocus.ts), which is what makes `Ctrl+X j` reach the terminal
 * even when the panel was hidden. The logic here is PURE (no React, no store,
 * no DOM) so the mapping is unit-testable.
 */

/** The four app panes the chord moves between. */
export const APP_PANES = ['sidebar', 'chat', 'viewer', 'terminal'] as const
export type AppPane = (typeof APP_PANES)[number]

/** A movement key, as returned by `physicalKey`. */
export type PaneDir = 'h' | 'j' | 'k' | 'l'

/**
 * The pane one step from `current` in `dir`, or `current` itself when the
 * direction has no neighbour (e.g. `h` from the sidebar, `k` from the chat
 * column) — the caller treats "unchanged" as "nothing to do" and lets the key
 * fall through to its other binding.
 *
 * Absent panes are NOT filtered here: a closed viewer/terminal is a perfectly
 * good destination because the caller opens it on arrival.
 */
export function cyclePane(current: AppPane, dir: PaneDir): AppPane {
  switch (current) {
    case 'chat':
      if (dir === 'h') return 'sidebar'
      if (dir === 'l') return 'viewer'
      // The terminal sits BELOW the chat column: both `j` (down) and `k` (up)
      // reach it, matching muscle memory from either direction.
      return 'terminal'
    case 'sidebar':
      // Only rightwards from the sidebar; there is nothing to its left. Down
      // and up reach the terminal: the sidebar spans the full height, so its
      // "below" is the bottom panel, exactly like the chat column's.
      if (dir === 'l') return 'chat'
      return dir === 'j' || dir === 'k' ? 'terminal' : 'sidebar'
    case 'viewer':
      // Leftwards is the chat column; there is nothing to the right. Like the
      // sidebar the right pane is full height, so down/up reach the terminal.
      if (dir === 'h') return 'chat'
      return dir === 'j' || dir === 'k' ? 'terminal' : 'viewer'
    case 'terminal':
      // The terminal is below everything: any direction returns to the chat.
      return dir === 'k' || dir === 'h' || dir === 'l' ? 'chat' : 'terminal'
    default:
      return current
  }
}
