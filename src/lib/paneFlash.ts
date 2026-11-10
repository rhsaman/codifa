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
 *
 * The overlay TRACKS the pane while it is visible. A pane can be mid-resize
 * when it receives the focus (the sidebar/pane open animation, a per-page
 * width transition): a one-shot snapshot left the ring behind at the old edge
 * while the pane glided away from it. One rect read per frame for the ~0.6s
 * lifetime keeps the two edges together.
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
  /* 1px: the ring marks the edge, it must not stack a second wide border on
     the pane's own 1px chrome. */
  border: 1px solid var(--accent, #ebbcba);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #ebbcba) 20%, transparent),
    0 0 10px color-mix(in srgb, var(--accent, #ebbcba) 22%, transparent);
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

/** Tear-down of the live ring (its rAF loop + timer). Only one ring exists at
 *  a time, so one slot is enough; `clearPaneFlash` uses it to stop the loop. */
let stopTracking: (() => void) | null = null

/** Remove every ring currently on screen. */
export function clearPaneFlash(): void {
  if (typeof document === 'undefined') return
  stopTracking?.()
  stopTracking = null
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
  try {
    ring.style.borderRadius = getComputedStyle(el).borderRadius
  } catch {
    /* no computed style: square corners */
  }
  // Follow the pane's live rect: an open/close or per-page width transition
  // moves the edge for ~0.25-0.3s after the ring is drawn, and a frozen
  // snapshot would peel away from it.
  let raf = 0
  let timer = 0
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    window.clearTimeout(timer)
    ring.remove()
    if (stopTracking === stop) stopTracking = null
  }
  const sync = () => {
    if (!el.isConnected) {
      stop()
      return
    }
    const r = el.getBoundingClientRect()
    ring.style.left = `${r.left}px`
    ring.style.top = `${r.top}px`
    ring.style.width = `${r.width}px`
    ring.style.height = `${r.height}px`
    raf = requestAnimationFrame(sync)
  }
  ring.addEventListener('animationend', stop)
  document.body.appendChild(ring)
  stopTracking = stop
  sync()
  timer = window.setTimeout(stop, LIFETIME_MS)
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
