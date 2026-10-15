/** Geometry of the Copy/Reply toolbar armed by a text highlight.
 *
 *  Shared by the file viewer and the diff view so both anchor the bar the
 *  same way: just under the highlight, clamped to the viewport so a selection
 *  near an edge never pushes the buttons off-screen. */

/** Toolbar box size in CSS pixels (two 14px icons + padding). */
export const SEL_BAR_W = 76;
export const SEL_BAR_H = 34;

export interface SelBarPos {
  x: number;
  y: number;
}

/** Clamp the toolbar position for a highlight rect in viewport coordinates. */
export function selectionBarPos(
  rect: { left: number; bottom: number },
  vw: number,
  vh: number,
): SelBarPos {
  const width = vw || 800;
  const height = vh || 600;
  return {
    x: Math.min(Math.max(rect.left, 8), Math.max(width - SEL_BAR_W - 8, 8)),
    y: Math.max(8, Math.min(rect.bottom + 6, Math.max(height - SEL_BAR_H - 8, 8))),
  };
}
