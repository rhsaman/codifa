/**
 * Focus ring flash — the visible "you are now HERE" moment.
 *
 * Moving the caret between panes (a chat window, the sidebar, the right panel,
 * the terminal) gives no visible cue of its own, so the jump reads as nothing
 * happening. This paints a short outlined ring around the pane that just
 * received the focus and lets it fade — pure DOM, no React, so it can be
 * called right next to the `focus()` that needs announcing.
 *
 * The ring is a SEPARATE overlay on <body>, positioned over the pane's rect —
 * never a class on the pane itself. A pane is a React-controlled element: its
 * `className` is rewritten on every focus change (`focused`/`dimmed`), which
 * wiped a class-based ring the moment a mouse press moved focus into that
 * window, so a click never flashed.
 */

const RING = 'pane-focus-ring'
const STYLE_ID = 'pane-focus-ring-style'
/** Longer than the animation: the fallback removal if `animationend` never fires. */
const LIFETIME_MS = 800

/** One shared <style> injected once; the ring follows `--accent`. */
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const st = document.createElement('style')
  st.id = STYLE_ID
  st.textContent = `
.${RING} {
  position: fixed;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 9000;
  border: 2px solid var(--accent, #ebbcba);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #ebbcba) 35%, transparent),
    0 0 14px color-mix(in srgb, var(--accent, #ebbcba) 30%, transparent);
  opacity: 0;
  animation: pane-flash-in 620ms ease-out forwards;
}
@keyframes pane-flash-in {
  0%   { opacity: 0;   transform: scale(1); }
  18%  { opacity: 0.9; }
  70%  { opacity: 0.55; }
  100% { opacity: 0;   transform: scale(1.004); }
}
`
  document.head.appendChild(st)
}

/** The pane that got the latest ring. A pointer press inside the SAME pane
 *  must not redraw it (every click in the composer would flash), so
 *  `flashOnEnter` compares against this. */
let lastFlashed: HTMLElement | null = null

/** Remove every ring currently on screen. */
export function clearPaneFlash(): void {
  if (typeof document === 'undefined') return
  document.querySelectorAll('.' + RING).forEach((n) => n.remove())
}

/**
 * Draw the ring around `el` and let it fade (~0.6s). Removes itself; safe to
 * call repeatedly — the previous ring is cleared first, so a jump landing on
 * pane B never leaves pane A's ring half-faded.
 */
export function flashPaneFocus(el: HTMLElement | null | undefined): void {
  if (!el || typeof document === 'undefined') return
  const rect = el.getBoundingClientRect()
  // A hidden/collapsed pane has nothing to ring.
  if (rect.width < 4 || rect.height < 4) return
  ensureStyles()
  clearPaneFlash()
  const ring = document.createElement('div')
  ring.className = RING
  ring.setAttribute('aria-hidden', 'true')
  ring.style.left = `${rect.left}px`
  ring.style.top = `${rect.top}px`
  ring.style.width = `${rect.width}px`
  ring.style.height = `${rect.height}px`
  try {
    ring.style.borderRadius = getComputedStyle(el).borderRadius
  } catch {
    /* no computed style: square corners */
  }
  ring.addEventListener('animationend', () => ring.remove())
  document.body.appendChild(ring)
  window.setTimeout(() => ring.remove(), LIFETIME_MS)
  lastFlashed = el
}

/** Ring a pane the pointer just ENTERED: nothing when it already holds the
 *  latest ring. A press on other chrome (`el` null: terminal, title bar, a
 *  dialog) forgets it, so coming back to the pane rings it again. */
export function flashOnEnter(el: HTMLElement | null | undefined): void {
  if (!el) {
    lastFlashed = null
    return
  }
  if (el === lastFlashed && el.isConnected) return
  flashPaneFocus(el)
}
