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
 *  Numeric inputs still accept the full VIEWPORT_LIMITS range. */
export const WIDTH_SLIDER_MIN = 320
export const WIDTH_SLIDER_MAX = 1920
export const WIDTH_RULER_STEP = 10

/** Chrome DevTools-style graduated ticks: common responsive breakpoints. */
export const WIDTH_RULER_TICKS: number[] = [320, 375, 425, 768, 1024, 1440, 1920]

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
  return "Desktop"
}

/** Target width for fit-to-pane: follow the pane down, never exceed the cap. Pure (never mutates the cap). */
export function fitWidthTarget(paneW: number, capW: number, minW: number = VIEWPORT_LIMITS.minWidth): number {
  if (!Number.isFinite(paneW) || paneW <= 0) return capW
  return Math.max(minW, Math.min(capW, Math.round(paneW)))
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
