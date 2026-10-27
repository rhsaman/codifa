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

/**
 * Force the chat windows' painted borders to re-rasterize — one frame, no
 * lasting style. WebKit (the Tauri webview) leaves a STALE border tile behind
 * when a sibling animates: the sidebar/right-pane width transitions keep the
 * chat windows resizing for ~0.3s, and the focused window's border is last
 * painted at an intermediate geometry that never gets repainted (it only
 * catches up on the next hover/keystroke). Toggling a transform on the windows'
 * container for one frame re-rasterizes the whole subtree, which clears the
 * stale tile without any persistent side effect.
 *
 * Call it from the animated panes' `transitionend` (width/flex-basis).
 */
export function nudgeChatWindowRepaint(): void {
  if (typeof document === 'undefined') return
  const el = document.querySelector<HTMLElement>('.chat-windows')
  if (!el) return
  el.style.transform = 'translateZ(0)'
  requestAnimationFrame(() => {
    el.style.transform = ''
  })
}

/**
 * While ANY pane width animation runs, keep forcing the chat windows to
 * repaint every frame. `transform`/`opacity` are compositable and do NOT
 * re-rasterize, so the toggle here is `outline` — a pure paint property that
 * never affects layout: its invalidation covers the element's bounds, so each
 * frame repaints the window (border, background and all) from scratch. This is
 * the hammer that makes the WKWebView stale-border artifact impossible during
 * the ~0.3s transition, whatever the tiling decides to keep.
 *
 * Refcounted: the sidebar and the right pane run their animations
 * independently; the loop lives while either is animating.
 */
let repaintLoopCount = 0
let repaintLoopRaf = 0
export function setBorderRepaintLoop(on: boolean): void {
  if (typeof document === 'undefined') return
  repaintLoopCount = Math.max(0, repaintLoopCount + (on ? 1 : -1))
  if (repaintLoopCount > 0) {
    if (repaintLoopRaf) return
    let flip = false
    const tick = () => {
      flip = !flip
      const style = flip ? '1px solid transparent' : 'none'
      document.querySelectorAll<HTMLElement>('.chat-window').forEach((w) => {
        w.style.outline = style
      })
      repaintLoopRaf = requestAnimationFrame(tick)
    }
    repaintLoopRaf = requestAnimationFrame(tick)
    return
  }
  if (repaintLoopRaf) {
    cancelAnimationFrame(repaintLoopRaf)
    repaintLoopRaf = 0
  }
  // Back to stylesheet-driven painting — and one final full repaint.
  document.querySelectorAll<HTMLElement>('.chat-window').forEach((w) => {
    w.style.outline = ''
  })
}
