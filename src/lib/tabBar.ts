// Shared interaction helpers for the editor tab bars (chats + viewers).
// Pure functions so both bars behave identically and stay unit-testable.

/** Side of the hovered tab where a drop lands. `threshold` is the fraction of
 *  the tab width (measured from its left edge) that counts as "before". */
export type DropSide = "before" | "after";

export function dropSide(
  clientX: number,
  rect: { left: number; width: number },
  threshold = 0.5,
): DropSide {
  return clientX - rect.left <= rect.width * threshold ? "before" : "after";
}

/** Keyboard reorder: Alt+ArrowLeft / Alt+ArrowRight move the focused tab.
 *  Returns the tab to drop onto (`toId`) and on which side (`after`), or
 *  null when the chord does not apply or the tab sits at the bar's edge. */
export function tabMove(
  ids: string[],
  id: string,
  key: string,
  altKey: boolean,
): { toId: string; after: boolean } | null {
  if (!altKey) return null;
  const delta = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (delta === 0) return null;
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return null;
  return { toId: ids[j], after: delta > 0 };
}

/** Horizontal auto-scroll (px) applied while dragging near a tab bar's edges,
 *  so a long overflowing bar can be traversed without releasing the drag.
 *  Returns 0 away from the edges. */
export function edgeScroll(
  clientX: number,
  bar: { left: number; width: number },
  edge = 64,
  speed = 14,
): number {
  const x = Math.min(Math.max(clientX - bar.left, 0), bar.width);
  if (x < edge) return -Math.round(speed * (1 - x / edge));
  if (x > bar.width - edge) return Math.round(speed * ((x - (bar.width - edge)) / edge));
  return 0;
}
