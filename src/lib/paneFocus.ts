/**
 * DOM half of the Ctrl+X pane ring (see src/lib/paneCycle.ts for the order).
 *
 * Split from the pure ring so that module stays testable without React or a
 * document: this one reads where the caret is and moves it into a pane,
 * opening a closed panel first (a pane that is not on screen cannot be
 * focused).
 */
import { useStore } from './store'
import { useViewerTabs } from './viewerTabs'
import { focusChatInput } from './chatFocus'
import { markVimRegion, paneOwner } from './panePointer'
import { flashPaneFocus } from './paneFlash'
import type { AppPane } from './paneCycle'

/**
 * Focus the sidebar's search box, falling back to the sidebar itself. The box
 * is the natural landing spot but is not always mounted (a narrow window hides
 * it), and a pane we cannot focus reads as "navigation did nothing".
 */
function focusSidebar(): void {
  const sidebar = document.querySelector<HTMLElement>('.sidebar')
  const box = sidebar?.querySelector<HTMLInputElement>('.sidebar-search-input')
  if (box && !box.hidden) {
    box.focus({ preventScroll: true })
    box.select?.()
    return
  }
  if (!sidebar) return
  // The container is not focusable by default; give it a tab stop on demand so
  // the arrow/j-k handlers inside it receive the keys.
  if (!sidebar.hasAttribute('tabindex')) sidebar.setAttribute('tabindex', '-1')
  sidebar.focus({ preventScroll: true })
}

/** Which pane holds the caret right now, read from the live DOM. Mirrors the
 *  regions in `focusAppPane` so a cycle starts where the user actually is. */
export function activePane(): AppPane {
  if (typeof document === 'undefined') return 'chat'
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body || el === document.documentElement) {
    // Nothing focused (a rail tab was just clicked — or a transcript click
    // released the caret to <body>): the pane the user WORKS in is the
    // last-clicked one from panePointer, NOT the tab the right rail happens
    // to show — a file open in the rail would otherwise start every chord
    // from 'viewer' and swallow Ctrl+X l/h pressed from the chat.
    const owner = paneOwner()
    if (owner) {
      if (owner.closest('.sidebar')) return 'sidebar'
      if (owner.closest('.terminal-panel, .terminal-tab-panel')) return 'terminal'
      // `.chat-group` (the chat column) sits INSIDE `.editor-area`, so it is
      // tested before the viewer fallback or every composer reads as 'viewer'.
      if (owner.closest('.chat-group, [data-chat-window], .chat-panel')) return 'chat'
      if (owner.closest('.viewer-pane-body, .viewer-split, .viewer-pane, .editor-area, .file-viewer, .review-docked-wrap, .review-overlay, .text-viewer')) return 'viewer'
    }
    // No pane intent yet (fresh boot, nothing ever clicked): fall back to the
    // tab the viewer rail is showing, exactly as before.
    const vt = useViewerTabs.getState()
    if (!vt.paneOpen) return 'chat'
    const kind = vt.activeId?.split(':')[0]
    if (kind === 'terminal') return 'terminal'
    return kind && kind !== 'files' ? 'viewer' : 'chat'
  }
  if (el.closest('.sidebar')) return 'sidebar'
  // Two hosts run a pty: the bottom panel and a right-pane terminal TAB.
  if (el.closest('.terminal-panel, .terminal-tab-panel')) return 'terminal'
  // `.chat-group` (the chat column) sits INSIDE `.editor-area`, so it has to be
  // tested before the viewer fallback or every composer would read as 'viewer'.
  if (el.closest('.chat-group, [data-chat-window]')) return 'chat'
  if (el.closest('.viewer-pane-body, .viewer-split, .editor-area, .viewer-pane')) return 'viewer'
  return 'chat'
}

/** Move the caret into `pane`, opening a closed panel first. Uses the selectors
 *  the panels already expose; the terminal is asked over an event because its
 *  xterm handles live inside the component.
 *
 *  Every landing also FIRES THE FOCUS RING (src/lib/paneFlash.ts): a pane
 *  without a visible caret gives no feedback at all, so the ring is what makes
 *  `Ctrl+X h/l/j/k` readable — "I am now HERE". */
export function focusAppPane(pane: AppPane): void {
  if (typeof document === 'undefined') return
  if (pane === 'terminal') {
    useStore.getState().setTerminalPanelOpen(true)
    // Flash the BOTTOM panel as soon as it mounts (one rAF is enough here:
    // the panel is a plain conditional render, not a lazy chunk).
    requestAnimationFrame(() => {
      flashPaneFocus(document.querySelector<HTMLElement>('.terminal-panel, .terminal-tab-panel'))
    })
    window.dispatchEvent(new CustomEvent('coder:focus-terminal'))
    return
  }
  if (pane === 'viewer') {
    useViewerTabs.getState().setPaneOpen(true)
    // The pane's panels each bring their own focusable control, so land on the
    // first one there is; the scroll body is the last resort, and is made
    // focusable on demand so the bare scroll keys reach its handler.
    // RETRY: `setPaneOpen` just flipped a store flag — the section mounts on
    // the NEXT React commit. One frame is not always enough (a cold lazy()
    // chunk loads async), and a silent miss reads as "the key did nothing":
    // keep probing briefly, then land on whatever exists first.
    let tries = 0
    const land = () => {
      const root = document.querySelector<HTMLElement>('.viewer-pane-body, .viewer-split, .viewer-pane')
      if (!root) {
        if (tries++ < 20) requestAnimationFrame(land)
        return
      }
      const focusable = root.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, button, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable) {
        focusable.focus({ preventScroll: true })
      } else {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
        root.focus({ preventScroll: true })
      }
      // The arrival also hands the bare vim keys to the pane the user just
      // opened — without a click there is no pointer intent to read.
      const paneRoot = document.querySelector<HTMLElement>(
        '.file-viewer, .review-docked-wrap, .review-overlay, .text-viewer',
      )
      if (paneRoot) markVimRegion(paneRoot)
      // The ring wraps the WHOLE right pane (`.viewer-group`, the same element
      // a mouse press rings — see App.tsx), not the control the caret landed
      // on: a toolbar button would flash one pixel of chrome.
      flashPaneFocus(document.querySelector<HTMLElement>('.viewer-group') || paneRoot || root)
    }
    requestAnimationFrame(land)
    return
  }
  if (pane === 'sidebar') {
    focusSidebar()
    flashPaneFocus(document.querySelector<HTMLElement>('.sidebar'))
    return
  }
  const chatId = useStore.getState().activeChatId
  if (chatId) focusChatInput(chatId)
  // The window wrap (`.chat-window`) flashes, not the composer: the ring must
  // show "this chat is active", and wrap the transcript too.
  const win = chatId
    ? document.querySelector<HTMLElement>(`[data-chat-window="${CSS.escape(chatId)}"]`)
    : null
  flashPaneFocus(win)
}
