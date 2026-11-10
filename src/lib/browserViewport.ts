/** Manual viewport sizing for the in-app virtual browser (Chrome-style).
 *
 * No device-name presets: like Chrome DevTools' Dimensions bar the panel
 * exposes numeric width/height inputs plus a horizontal width slider.
 * Sizes are CSS pixels of the shared Chromium viewport and are clamped
 * to the same safe range the backend enforces in set_viewport.
 */

export const VIEWPORT_LIMITS = {
  minWidth: 200,
  maxWidth: 7680,
  minHeight: 200,
  maxHeight: 4320,
} as const

export const DEFAULT_VIEWPORT_SIZE = { width: 1280, height: 800 } as const

/** Slider bounds for the horizontal width bar (usable drag range).
 *  The right end is 4K UHD (3840); numeric inputs still accept the full
 *  VIEWPORT_LIMITS range. */
export const WIDTH_SLIDER_MIN = 320
export const WIDTH_SLIDER_MAX = 3840
export const WIDTH_RULER_STEP = 10

/** Chrome DevTools-style graduated ticks: common responsive breakpoints,
 *  through QHD (2560) up to 4K UHD (3840). */
export const WIDTH_RULER_TICKS: number[] = [320, 375, 425, 768, 1024, 1440, 1920, 2560, 3840]

/** Minimum distance (px) between two tick LABELS before they overlap. */
export const RULER_LABEL_MIN_GAP = 34

/** Which ticks get a printed label at this track width. All ticks keep their
 *  mark, but a 320→3840 scale squeezes the small breakpoints (320/375/425)
 *  into a few pixels on a narrow panel; labelling every one of them printed
 *  overlapping numbers. Greedy left-to-right thinning keeps the scale legible,
 *  and the widest tick is always labelled so the 4K end is anchored. */
export function visibleRulerTicks(
  trackW: number,
  min: number = WIDTH_SLIDER_MIN,
  max: number = WIDTH_SLIDER_MAX,
  ticks: number[] = widthRulerTicks(min, max),
  minGap: number = RULER_LABEL_MIN_GAP,
): number[] {
  if (!Number.isFinite(trackW) || trackW <= 0) return ticks
  const x = (w: number): number => (rulerPctForWidth(w, min, max) / 100) * trackW
  const kept: number[] = []
  for (const w of ticks) {
    if (kept.length === 0 || x(w) - x(kept[kept.length - 1]) >= minGap) kept.push(w)
  }
  const last = ticks[ticks.length - 1]
  if (last !== undefined && kept[kept.length - 1] !== last) {
    while (kept.length > 1 && x(last) - x(kept[kept.length - 1]) < minGap) kept.pop()
    kept.push(last)
  }
  return kept
}

/** Tick widths for the ruler bar (Chrome breakpoints inside min/max). */
export function widthRulerTicks(
  min: number = WIDTH_SLIDER_MIN,
  max: number = WIDTH_SLIDER_MAX,
): number[] {
  return WIDTH_RULER_TICKS.filter((w) => w >= min && w <= max)
}

/** Width -> ruler position percent (0-100, clamped). */
export function rulerPctForWidth(
  width: number,
  min: number = WIDTH_SLIDER_MIN,
  max: number = WIDTH_SLIDER_MAX,
): number {
  if (!(max > min)) return 0
  const pct = ((width - min) / (max - min)) * 100
  return Math.min(100, Math.max(0, pct))
}

/** Ruler position percent -> width (snapped to step, clamped). */
export function rulerWidthForPct(
  pct: number,
  min: number = WIDTH_SLIDER_MIN,
  max: number = WIDTH_SLIDER_MAX,
  step: number = WIDTH_RULER_STEP,
): number {
  const clamped = Math.min(100, Math.max(0, pct))
  const raw = min + (clamped / 100) * (max - min)
  return clampViewportSize(Math.round(raw / step) * step, 800).width
}

/** Device-size name for a ruler width, like Chrome's "Laptop - 1024px" tip. */
export function rulerLabelForWidth(width: number): string {
  if (width <= 360) return "Mobile S"
  if (width <= 400) return "Mobile M"
  if (width <= 480) return "Mobile L"
  if (width <= 800) return "Tablet"
  if (width <= 1100) return "Laptop"
  if (width <= 1500) return "Laptop L"
  if (width <= 2000) return "Desktop"
  if (width <= 2800) return "QHD"
  if (width <= 3600) return "Ultrawide"
  return "4K"
}

/** Target width for fit-to-pane: the pane's content width, clamped to the
 *  backend's safe range. Follow mode means FOLLOW — there is deliberately no
 *  manual cap here: a stale cap (e.g. 320 from an earlier fixed-size choice)
 *  pinned the page at that width and made the Fit toggle look dead. */
export function fitWidthTarget(
  paneW: number,
  minW: number = VIEWPORT_LIMITS.minWidth,
  maxW: number = VIEWPORT_LIMITS.maxWidth,
): number {
  if (!Number.isFinite(paneW) || paneW <= 0) return DEFAULT_VIEWPORT_SIZE.width
  return Math.max(minW, Math.min(maxW, Math.round(paneW)))
}

/** Target height for fit-to-pane. Auto-fit follows BOTH axes: a width-only
 *  fit left a fixed 800px page in a taller panel, so the frame was letterboxed
 *  with empty bands above/below it. Clamped to the backend's safe range. */
export function fitHeightTarget(
  paneH: number,
  minH: number = VIEWPORT_LIMITS.minHeight,
  maxH: number = VIEWPORT_LIMITS.maxHeight,
): number {
  if (!Number.isFinite(paneH) || paneH <= 0) return DEFAULT_VIEWPORT_SIZE.height
  return Math.max(minH, Math.min(maxH, Math.round(paneH)))
}

/** On-screen zoom for the emulated frame: never upscale past 1:1, shrink to
 *  fit the pane on either axis. Pure so the responsive fit is unit-tested.
 *
 *  The frame must be RENDERED at this scale instead of being stretched to the
 *  pane: stretching made every viewport change invisible (a 375px viewport and
 *  a 1600px one both filled the pane), which is why the ruler looked dead. */
export function frameZoom(paneW: number, paneH: number, vw: number, vh: number): number {
  if (!Number.isFinite(paneW) || !Number.isFinite(paneH) || paneW <= 0 || paneH <= 0) return 1
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return 1
  return Math.min(1, paneW / vw, paneH / vh)
}

/** True when an incoming viewport size should overwrite the manual drafts: only on a real change and never while editing. */
export function shouldSyncViewportDrafts(prevW: number, prevH: number, nextW: number, nextH: number, editing: boolean): boolean {
  if (editing) return false
  return prevW !== nextW || prevH !== nextH
}

export interface ClampedViewport {
  width: number
  height: number
}

function toFinite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

/** Clamp a raw width/height pair to the safe backend range (rounded). */
export function clampViewportSize(width: number, height: number): ClampedViewport {
  const w = toFinite(Math.round(width), DEFAULT_VIEWPORT_SIZE.width)
  const h = toFinite(Math.round(height), DEFAULT_VIEWPORT_SIZE.height)
  return {
    width: Math.max(VIEWPORT_LIMITS.minWidth, Math.min(VIEWPORT_LIMITS.maxWidth, w)),
    height: Math.max(VIEWPORT_LIMITS.minHeight, Math.min(VIEWPORT_LIMITS.maxHeight, h)),
  }
}
