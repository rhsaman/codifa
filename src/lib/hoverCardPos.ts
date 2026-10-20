/** Geometry of the diff preview popup shown when hovering an edit/write card.
 *
 *  Pure so it is testable: the popup is portaled to `document.body` and
 *  positioned with inline `position: fixed`, so it must be clamped to the
 *  viewport by hand — a card near the bottom edge would otherwise push the
 *  diff off-screen.
 */

/** Preferred popup width in CSS pixels. */
export const DIFF_POP_W = 720;
/** Preferred popup height in CSS pixels (newer cards get room for a few hunks). */
export const DIFF_POP_H = 440;
/** Smallest sensible height: below this it is not worth opening below the card. */
export const DIFF_POP_MIN_H = 150;

export interface DiffPopPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** Position the diff popup for an anchor rect in viewport coordinates.
 *
 *  Prefers opening just under the card, and flips above it when there is not
 *  enough room below. Horizontally it is clamped to the viewport, so a card in
 *  a narrow window never pushes the popup past an edge.
 */
export function diffPopupPos(
  rect: { top: number; bottom: number; left: number; width: number },
  vw: number,
  vh: number,
  width = DIFF_POP_W,
  gap = 8,
): DiffPopPos {
  const viewW = vw || 1200;
  const viewH = vh || 800;
  const w = Math.max(240, Math.min(width, viewW - 16));
  const left = Math.min(Math.max(rect.left, 8), Math.max(viewW - w - 8, 8));

  const below = viewH - rect.bottom - gap - 8;
  const above = rect.top - gap - 8;
  // Flip above only when below is genuinely unusable AND above is better.
  if (below < DIFF_POP_MIN_H && above > below) {
    const maxHeight = Math.max(DIFF_POP_MIN_H, Math.min(DIFF_POP_H, above));
    return { top: Math.max(8, rect.top - gap - maxHeight), left, width: w, maxHeight };
  }
  const maxHeight = Math.max(DIFF_POP_MIN_H, Math.min(DIFF_POP_H, below));
  return { top: rect.bottom + gap, left, width: w, maxHeight };
}

