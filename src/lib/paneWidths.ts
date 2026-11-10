import type { ViewerKind } from './viewerTabs'
import { CHAT_MIN_WIDTH } from './viewerTabs'

/**
 * PER-PAGE width of the right viewer pane.
 *
 * The pane used to carry ONE global width (`coder:splitWidth`): widening Review
 * silently widened Todos too, and vice versa. Every page now remembers its own
 * width, so a drag on one page never disturbs another — that is the whole point
 * of this module.
 *
 * What counts as "a page" is the WIDTH KEY, not the raw kind:
 *  • Browser and file/text tabs are their own pages, so a wide file and a
 *    narrow Browser can be open side by side without fighting over one width.
 *  • Terminal/artifact tabs each keep their own width too — they are long-lived
 *    surfaces a user drags once and expects to stay put.
 *  • A page with no saved entry falls back to its per-kind default below, and
 *    only then to the caller's `fallback` (the legacy global split width).
 */

const STORAGE_KEY = 'coder:paneWidths'

/** Narrowest the pane may ever render, matching clampSplitWidth's floor. */
export const PANE_MIN_WIDTH = 320

/** Width a page opens at the first time, before the user drags it. */
export const PANE_DEFAULT_WIDTH: Record<string, number> = {
  // A checklist needs no room for code lines: the narrowest the site allows.
  todos: 320,
  schedule: 420,
  inbox: 420,
  plan: 520,
  trace: 520,
  artifacts: 560,
  browser: 620,
  file: 720,
  text: 720,
  review: 820,
  explore: 820,
  artifact: 820,
  media: 620,
  terminal: 640,
}

/** Todos opens at the narrowest sensible checklist width. */
export const TODOS_PANE_DEFAULT = PANE_DEFAULT_WIDTH.todos

export type PaneWidths = Partial<Record<ViewerKind, number>>

/**
 * The width key for a tab. File-ish tabs collapse to `file`, everything else
 * keys on its own kind — so Browser, Todos, Review and a file each hold a
 * separate width.
 */
export function paneWidthKey(kind: ViewerKind | undefined): string | undefined {
  if (!kind) return undefined
  return kind
}

export function loadPaneWidths(): PaneWidths {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: PaneWidths = {}
    for (const [kind, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Reject junk instead of letting NaN reach the layout: one bad entry
      // would otherwise collapse the pane to 0.
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[kind as ViewerKind] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

function persistPaneWidths(map: PaneWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable — in-memory state still works this session */
  }
}

/**
 * Width to paint for `kind`: the user's saved width for that page, else that
 * page's own default, else the caller's fallback (legacy global split width).
 */
export function paneWidthFor(
  map: PaneWidths,
  kind: ViewerKind | undefined,
  fallback: number,
): number {
  const key = paneWidthKey(kind)
  if (key) {
    const saved = map[key as ViewerKind]
    if (typeof saved === 'number' && Number.isFinite(saved) && saved > 0) return saved
    const dflt = PANE_DEFAULT_WIDTH[key]
    if (typeof dflt === 'number') return dflt
  }
  return fallback
}

/** Records the width the user just dragged, for `kind` only. */
export function savePaneWidth(
  map: PaneWidths,
  kind: ViewerKind | undefined,
  width: number,
): PaneWidths {
  const key = paneWidthKey(kind)
  if (!key || !Number.isFinite(width) || width <= 0) return map
  const next: PaneWidths = { ...map, [key as ViewerKind]: Math.round(width) }
  persistPaneWidths(next)
  return next
}

/** Keeps the pane usable when the window shrinks below the saved width. */
export function clampPaneWidth(width: number, availableWidth: number, reserveRight = 0): number {
  const max = availableWidth - CHAT_MIN_WIDTH - Math.max(0, reserveRight)
  // A very narrow window can make `max` < the floor; never return less than a
  // positive width or the flex row collapses to nothing.
  return Math.max(Math.min(PANE_MIN_WIDTH, max > 0 ? max : PANE_MIN_WIDTH), Math.min(max, width))
}
