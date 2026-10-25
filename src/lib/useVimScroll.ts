/**
 * React binding for the bare vim scroll keys (src/lib/scrollKeys.ts).
 *
 * The opened file and the git diff hand `h`/`j`/`k`/`l` to their scroll
 * container while the pane is the one the user is WORKING in, and leave every
 * other context alone: typing, the sidebar chat list, dialogs.
 *
 * "Working in" is decided by src/lib/panePointer.ts (last click / real caret),
 * NOT by `document.activeElement` alone — the Tauri webview is WebKit, where
 * clicking diff content keeps the caret in a stale input (the composer or the
 * sidebar search), so focus alone reads the wrong pane: nothing scrolls and
 * the letter types into nowhere.
 */
import { useEffect } from 'react'
import { applyScroll, scrollDelta } from './scrollKeys'
import { physicalKey } from './shortcuts'
import { isPrefixArmed, watchPrefixFlag } from './prefixState'
import {
  decideVimOwner,
  isEditableTarget,
  registerVimRegion,
  snapshotIntent,
  unregisterVimRegion,
} from './panePointer'

/** Whether `el` is itself a scroller (visible overflow on an overflowing axis). */
function isScroller(el: HTMLElement): boolean {
  const cs = getComputedStyle(el)
  const scrollsY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
  const scrollsX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
  return scrollsY || scrollsX
}

/**
 * The element the keys should actually scroll.
 *
 * With the caret on a real node (or a click on one), that node's nearest
 * scrollable ANCESTOR wins: a click on a diff line means "scroll the box this
 * line lives in". Fallback is the pane's own scroller, found by searching
 * DOWNWARD from the root: the docked git diff's root is `display: contents`
 * (no box at all) and its real scroller (`.review-files`) sits several levels
 * deeper.
 */
function scrollableHost(from: HTMLElement, root: HTMLElement): HTMLElement | null {
  // Walk up from the starting node (never past the pane root).
  let node: HTMLElement | null = from
  while (node && node !== root) {
    if (isScroller(node)) return node
    node = node.parentElement
  }
  if (isScroller(root)) return root
  // Downward: the deepest-first scroller that actually overflows. DOM order
  // keeps the main body ahead of small inner boxes where both overflow.
  const walk = (el: HTMLElement): HTMLElement | null => {
    for (const child of Array.from(el.children)) {
      const c = child as HTMLElement
      if (isScroller(c)) return c
      const found = walk(c)
      if (found) return found
    }
    return null
  }
  return walk(root)
}

export function useVimScroll(
  rootRef: React.RefObject<HTMLElement | null>,
  /** Ownership intent root — defaults to the scroll root. Pass the wider
   *  window/panel element when the pane's typing surface (a composer) sits
   *  OUTSIDE the scroll container: the caret must resolve against the whole
   *  pane, or typing is judged by a stale pane click instead. */
  intentRef?: React.RefObject<HTMLElement | null>,
): void {
  // The Ctrl+X prefix is armed by the FIRST key and runs on the second. This
  // listener is a CAPTURE one, so it would see that second key before the
  // chord handler does and swallow it as a scroll. Stand down while the
  // prefix waits for its key.
  useEffect(() => watchPrefixFlag(), [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // The intent boundary: the wider pane (chat window incl. its composer, or
    // the whole viewer panel), falling back to the scroll root. panePointer
    // resolves the caret against THIS element, so an input outside the scroll
    // box but inside the pane still reads as "the user is typing here".
    const intent = intentRef?.current ?? root
    // Announce this pane so panePointer knows which panes exist; an intent
    // (a click on it, or a programmatic mark) then hands the keys over.
    registerVimRegion(intent)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (isPrefixArmed()) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Only the pane the user is working in may take the letters — judged
      // by panePointer's intent race (last click vs typing), because the
      // keydown target in WebKit is the STALE input the caret never left.
      // A second mounted (split) pane stays inert, and the sidebar/chat keep
      // their own strokes when the last interaction was theirs.
      // Typing is absolute: a letter that belongs to a text field is never a
      // scroll. Checked BEFORE the intent race so a stale pane click can never
      // steal `j`/`k` from the composer the caret is actually sitting in.
      if (isEditableTarget(e.target as Node | null)) return
      if (decideVimOwner(snapshotIntent(), intent, e.target as Node | null) !== 'scroll') return
      const delta = scrollDelta(physicalKey(e), e.shiftKey)
      if (!delta) return
      const target = e.target instanceof Element && root.contains(e.target) ? (e.target as HTMLElement) : root
      const el = document.activeElement as HTMLElement | null
      const focusInside = !!el && el !== document.body && el !== document.documentElement && root.contains(el)
      const host = scrollableHost(focusInside && el ? el : target, root)
      if (!host) return
      // Bare press only: consume it so nothing else (caret movement, the
      // chat list) also reacts.
      e.preventDefault()
      e.stopPropagation()
      // Single taps glide (smooth); held-key auto-repeat steps instantly so
      // holding `j` stays snappy instead of lagging behind its own glide.
      const moved = applyScroll(host, delta, !e.repeat)
      if (moved) {
        // The user scrolled with the keyboard — let scroll consumers know, so
        // behaviours like the transcript's stick-to-bottom (which snaps the
        // viewport back on every content resize) release the pin. A glide
        // spans several frames, so this fires once per KEYPRESS, before the
        // first frame moves.
        window.dispatchEvent(new CustomEvent('coder:vim-scroll', { detail: host }))
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      unregisterVimRegion(intent)
    }
  }, [])
}
