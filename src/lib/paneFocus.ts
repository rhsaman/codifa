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
 *  The FOCUS RING (src/lib/paneFlash.ts) is opt-in via `{ ring: true }` and
 *  only the explicit Ctrl+X pane jumps pass it. Every other arrival — opening
 *  or closing the sidebar/right pane from a button, Ctrl+B, or a store action —
 *  must land SILENTLY: a ring on a mere toggle reads as a stray border flash.
 */
export function focusAppPane(pane: AppPane, opts?: { ring?: boolean }): void {
  if (typeof document === 'undefined') return
  const ring = opts?.ring === true
  if (pane === 'terminal') {
    useStore.getState().setTerminalPanelOpen(true)
    // Flash the BOTTOM panel once it mounts. The commit can land a frame or
    // two after `setTerminalPanelOpen` (concurrent rendering), so probe
    // briefly instead of betting on one rAF.
    if (ring) {
      let ringTries = 0
      const ringWhenMounted = () => {
        const el = document.querySelector<HTMLElement>('.terminal-panel, .terminal-tab-panel')
        if (el) flashPaneFocus(el)
        else if (ringTries++ < 20) requestAnimationFrame(ringWhenMounted)
      }
      requestAnimationFrame(ringWhenMounted)
    }
    window.dispatchEvent(new CustomEvent('coder:focus-terminal'))
    return
  }
  if (pane === 'viewer') {
    useViewerTabs.getState().setPaneOpen(true)
    // The caret lands in the PAGE BODY, never on the pane's tab strip: the
    // first-focusable probe used to grab the strip's buttons (the tab list
    // chevron, a tab row), which read as "the tabs are focused" on every page
    // but the terminal. The content host is focused on demand (tabindex=-1,
    // same element a mouse click focuses — see App.tsx) so the pane's own
    // scroll keys reach their handler.
    // RETRY: `setPaneOpen` just flipped a store flag — the section mounts on
    // the NEXT React commit. One frame is not always enough (a cold lazy()
    // chunk loads async), and a silent miss reads as "the key did nothing":
    // keep probing briefly, then land.
    let tries = 0
    const land = () => {
      const root = document.querySelector<HTMLElement>('.viewer-pane-body, .viewer-split, .viewer-pane')
      if (!root) {
        if (tries++ < 20) requestAnimationFrame(land)
        return
      }
      // A TERMINAL tab owns the pane: the caret must land in its xterm. The
      // session is mounted a commit or two after the pane opens, so wait for it
      // the same way the pane itself is awaited. Decided from the DOM, not from
      // store bookkeeping: whatever terminal is PAINTED in the pane gets the
      // focus. The check after focus() matters too — a refused focus must not
      // count as arrival.
      const termHost = root.querySelector<HTMLElement>('.terminal-tab-panel')
      if (termHost) {
        const input = termHost.querySelector<HTMLElement>('.xterm-helper-textarea')
        if (input) {
          input.focus({ preventScroll: true })
          if (document.activeElement === input) {
            if (ring) flashPaneFocus(document.querySelector<HTMLElement>('.viewer-group') || root)
            return
          }
        }
        // xterm not opened yet, or it refused the focus this frame: try again.
        if (tries++ < 20) {
          requestAnimationFrame(land)
          return
        }
        console.warn('[paneFocus] a terminal tab is shown but its xterm input could not take the focus', {
          hasInput: !!input,
          active: document.activeElement?.tagName,
        })
      }
      // Every other page: the pane CONTENT body. Single pane = `.viewer-content`
      // (the host App.tsx also focuses on click); a split tree = the focused
      // leaf's body. Falling back to the pane root keeps the keys working even
      // when neither host exists yet.
      const body =
        document.querySelector<HTMLElement>('.viewer-pane-body > .viewer-content') ||
        root.querySelector<HTMLElement>('.viewer-window.focused .viewer-window-body') ||
        root.querySelector<HTMLElement>('.viewer-window-body')
      if (body) {
        if (!body.hasAttribute('tabindex')) body.setAttribute('tabindex', '-1')
        body.focus({ preventScroll: true })
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
      if (ring) flashPaneFocus(document.querySelector<HTMLElement>('.viewer-group') || root)
    }
    requestAnimationFrame(land)
    return
  }
  if (pane === 'sidebar') {
    focusSidebar()
    if (ring) flashPaneFocus(document.querySelector<HTMLElement>('.sidebar'))
    return
  }
  const chatId = useStore.getState().activeChatId
  if (chatId) focusChatInput(chatId)
  // The window wrap (`.chat-window`) rings, not the composer: the ring must
  // show "this chat is active", and wrap the transcript too.
  if (ring && chatId) {
    flashPaneFocus(document.querySelector<HTMLElement>(`[data-chat-window="${CSS.escape(chatId)}"]`))
  }
}
