/**
 * Bare vim-style scrolling for the read-only panes: the opened file viewer and
 * the git diff. `h`/`l` scroll sideways, `j`/`k` up/down — the same letters the
 * chat windows use for movement, but here they drive a scroll container
 * instead of the caret.
 *
 * The mapping is PURE (no DOM) so it is unit-testable; the caller resolves the
 * event target to a container and applies the delta.
 */

/** The four scroll keys, as returned by `physicalKey`. */
export type ScrollDir = 'h' | 'j' | 'k' | 'l'

/** A scroll delta in pixels, ready to add to `scrollLeft` / `scrollTop`. */
export interface ScrollDelta {
  dx: number
  dy: number
}

/** How far one keypress travels. Lines, not viewports, so a held key walks the
 *  document at a readable pace. */
export const SCROLL_STEP_PX = 48
/** `Shift` multiplies the step for coarse jumps. */
export const SCROLL_FAST_MULTIPLIER = 4

/**
 * The delta for `dir`, or `null` when the key is not a scroll key. `fast`
 * (Shift held) multiplies the step.
 */
export function scrollDelta(
  dir: string | null | undefined,
  fast = false,
): ScrollDelta | null {
  const k = (dir ?? '').toLowerCase()
  if (k !== 'h' && k !== 'j' && k !== 'k' && k !== 'l') return null
  const step = fast ? SCROLL_STEP_PX * SCROLL_FAST_MULTIPLIER : SCROLL_STEP_PX
  if (k === 'h') return { dx: -step, dy: 0 }
  if (k === 'l') return { dx: step, dy: 0 }
  if (k === 'k') return { dx: 0, dy: -step }
  return { dx: 0, dy: step }
}

/**
 * Whether the bare scroll keys may act on an event whose target is `el`.
 *
 * Typing must never be hijacked: text boxes, selects and content-editable
 * regions keep their letters. `owner` is the pane that would receive the
 * scroll (the viewer / diff root) — the target has to live inside it, so a key
 * pressed in a chat composer or the sidebar leaves this pane alone.
 *
 * `focusIsIdle` covers the common case of nothing being focused at all (the
 * caret sits on `<body>` after clicking a diff line or a rail tab): refusing
 * the key there reads as "the scroll keys do not work", so the pane claims it.
 */
export function canScrollFrom(
  el: Element | null | undefined,
  owner: Element | null | undefined,
  focusIsIdle = false,
): boolean {
  if (!el || !owner) return false
  if (typeof (el as HTMLElement).closest !== 'function') return false
  if (
    (el as HTMLElement).closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    )
  ) {
    return false
  }
  return owner.contains(el) || focusIsIdle
}

/**
 * Smooth-scroll tuning: each animation frame covers this fraction of the
 * remaining distance (ease-out glide), and the glide snaps onto its target
 * once closer than the snap threshold. Held-key auto-repeat always steps
 * INSTANTLY instead — gliding every ~30ms repeat reads as lag.
 */
const SMOOTH_EASE = 0.35
const SMOOTH_SNAP_PX = 1

/** One in-flight glide per element; a new keypress retargets the same glide
 *  instead of stacking competing animations. */
interface ScrollGlide {
  left: number
  top: number
  raf: number
}
const glides = new WeakMap<HTMLElement, ScrollGlide>()

/** Pin a glide target onto the container's real scrollable range, so a burst
 *  of `j` presses cannot leave a target beyond the edge (the glide would then
 *  chase a position the browser clamps away and never converge). */
function clampGlide(
  el: HTMLElement,
  left: number,
  top: number,
): { left: number; top: number } {
  const maxX = Math.max(0, el.scrollWidth - el.clientWidth)
  const maxY = Math.max(0, el.scrollHeight - el.clientHeight)
  return {
    left: Number.isFinite(maxX) ? Math.min(Math.max(0, left), maxX) : left,
    top: Number.isFinite(maxY) ? Math.min(Math.max(0, top), maxY) : top,
  }
}

function glideTo(el: HTMLElement, g: ScrollGlide): void {
  if (g.raf) cancelAnimationFrame(g.raf)
  const step = (): void => {
    // A pane unmounted mid-glide stops the loop here — never animate a
    // detached element.
    if (!el.isConnected) {
      glides.delete(el)
      return
    }
    const dl = g.left - el.scrollLeft
    const dt = g.top - el.scrollTop
    if (Math.abs(dl) < SMOOTH_SNAP_PX && Math.abs(dt) < SMOOTH_SNAP_PX) {
      el.scrollLeft = g.left
      el.scrollTop = g.top
      glides.delete(el)
      return
    }
    el.scrollLeft += dl * SMOOTH_EASE
    el.scrollTop += dt * SMOOTH_EASE
    g.raf = requestAnimationFrame(step)
  }
  g.raf = requestAnimationFrame(step)
}

/**
 * Apply `delta` to a scroll container. `smooth` (the default) glides there;
 * callers pass `false` for held-key auto-repeat so holding `j` stays snappy.
 * In environments without `requestAnimationFrame` (tests, SSR) the glide
 * degrades to the instant step. Returns true when a scroll actually happened,
 * so the caller can decide whether to consume the key (a pane already at its
 * edge lets the key through).
 */
export function applyScroll(
  el: HTMLElement | null | undefined,
  delta: ScrollDelta,
  smooth = true,
): boolean {
  if (!el) return false
  if (!smooth || typeof requestAnimationFrame !== 'function') {
    // A held key steps INSTANTLY — kill any running glide first, or the two
    // writers would fight over scrollTop every frame (stutter, and the
    // position could walk BACKWARDS as the old ease-out eased toward a
    // target the instant step had already jumped past).
    const g = typeof requestAnimationFrame === 'function' ? glides.get(el) : undefined
    if (g?.raf) cancelAnimationFrame(g.raf)
    glides.delete(el)
    const beforeLeft = el.scrollLeft
    const beforeTop = el.scrollTop
    el.scrollLeft = beforeLeft + delta.dx
    el.scrollTop = beforeTop + delta.dy
    return el.scrollLeft !== beforeLeft || el.scrollTop !== beforeTop
  }
  let g = glides.get(el)
  if (!g) {
    g = { left: el.scrollLeft, top: el.scrollTop, raf: 0 }
    glides.set(el, g)
  }
  g.left += delta.dx
  g.top += delta.dy
  const c = clampGlide(el, g.left, g.top)
  g.left = c.left
  g.top = c.top
  glideTo(el, g)
  // The glide runs over the next frames; the key is consumed either way —
  // returning the would-be movement (non-zero delta) is the honest answer.
  return delta.dx !== 0 || delta.dy !== 0
}
