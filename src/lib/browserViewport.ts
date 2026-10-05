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
