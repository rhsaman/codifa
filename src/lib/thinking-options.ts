import type { ThinkingLevel } from '../types'

/**
 * Shared reasoning-effort option list, used by the composer's thinking pill
 * and by the per-tool rows in Settings → Tools. Kept in one module so both
 * surfaces render the exact same labels, order and descriptions.
 */
export const THINKING_OPTIONS: Array<[ThinkingLevel, string]> = [
  ['none', 'None'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  // One top option in the UI. Canonical stored value is `xhigh` (the strongest
  // token cross-provider gateways pass through); the legacy `max` value is an
  // alias that folds onto it (see canonThinkingLevel below).
  ['xhigh', 'Max'],
]

/** Options for a per-tool row in Settings, where the empty value means
 *  "inherit the main model's level" — shown as a Default entry on top. */
export const THINKING_OPTIONS_INHERIT: Array<[ThinkingLevel, string]> = [
  ['', 'Default'],
  ...THINKING_OPTIONS,
]

export const THINKING_LABELS = {
  ...Object.fromEntries(THINKING_OPTIONS),
  // Legacy stored value: still renders as the same "Max" option.
  max: 'Max',
} as Record<ThinkingLevel, string>

export const THINKING_DESCS: Record<ThinkingLevel, string> = {
  '': 'Default reasoning',
  none: 'No reasoning — fastest replies',
  low: 'Light reasoning — faster replies',
  medium: 'Balanced reasoning — good trade-off',
  high: 'Deep reasoning — better answers',
  xhigh: 'Maximum reasoning — strongest answers',
  max: 'Maximum reasoning — strongest answers',
}

/** Collapse a legacy/variant level onto the canonical stored value.
 *  `max` (the old separate option) is an exact alias of `xhigh`. */
export function canonThinkingLevel(level: string | undefined | null): ThinkingLevel {
  return level === 'max' ? 'xhigh' : ((level ?? '') as ThinkingLevel)
}
