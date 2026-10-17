// Shared interaction helpers for the editor tab bars (chats + viewers).
// Pure functions so both bars behave identically and stay unit-testable.

/** Side of the hovered tab where a drop lands. `threshold` is the fraction of
 *  the tab extent (measured from its start edge) that counts as "before". */
export type DropSide = "before" | "after";

/** Bar axis: "x" for the horizontal chat/viewer bars, "y" for a vertical rail. */
export type TabAxis = "x" | "y";

/** Box of a tab or bar. Only the fields of the measured axis are required, so
 *  callers may pass a bare {left,width} / {top,height} or a full DOMRect. */
export interface TabBox {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** Pointer offset and extent of `box` along `axis`. */
function measure(axis: TabAxis, client: number, box: TabBox) {
  return axis === "y"
    ? { pos: client - (box.top ?? 0), size: box.height ?? 0 }
    : { pos: client - (box.left ?? 0), size: box.width ?? 0 };
}

export function dropSide(
  client: number,
  box: TabBox,
  axis: TabAxis = "x",
  threshold = 0.5,
): DropSide {
  const { pos, size } = measure(axis, client, box);
  return pos <= size * threshold ? "before" : "after";
}

/** Keyboard reorder: Alt+ArrowLeft/Right (horizontal bars) or Alt+ArrowUp/Down
 *  (vertical rails) move the focused tab. Returns the tab to drop onto
 *  (`toId`) and on which side (`after`), or null when the chord does not
 *  apply or the tab sits at the bar's edge. */
export function tabMove(
  ids: string[],
  id: string,
  key: string,
  altKey: boolean,
  axis: TabAxis = "x",
): { toId: string; after: boolean } | null {
  if (!altKey) return null;
  const [back, forward] = axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const delta = key === back ? -1 : key === forward ? 1 : 0;
  if (delta === 0) return null;
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return null;
  return { toId: ids[j], after: delta > 0 };
}

/** Auto-scroll (px) along the bar's own axis, applied while dragging near its
 *  edges so a long overflowing bar/rail can be traversed without releasing the
 *  drag. Returns 0 away from the edges. */
export function edgeScroll(
  client: number,
  bar: TabBox,
  axis: TabAxis = "x",
  edge = 64,
  speed = 14,
): number {
  const { pos, size } = measure(axis, client, bar);
  const x = Math.min(Math.max(pos, 0), size);
  if (x < edge) return -Math.round(speed * (1 - x / edge));
  if (x > size - edge) return Math.round(speed * ((x - (size - edge)) / edge));
  return 0;
}

/** Where a fixed dropdown anchored to a trigger opens. "bottom" keeps the
 *  trigger's own left edge; "left" flips the menu toward the window's left,
 *  for triggers hugging the right edge (vertical pane rail). */
export type MenuPlacement = "bottom" | "left";

/** Left offset (px) of a fixed dropdown anchored at `anchorLeft`, clamped so
 *  the menu never pokes out of the viewport on either side. */
export function menuLeft(
  anchorLeft: number,
  width: number,
  viewportWidth: number,
  placement: MenuPlacement = "bottom",
): number {
  const left = placement === "left" ? anchorLeft - width : anchorLeft;
  return Math.max(12, Math.min(left, viewportWidth - width));
}

/** Top offset (px) of a fixed dropdown anchored just below `anchorTop`,
 *  clamped so a menu of `height` never pokes out of the viewport top or
 *  bottom (the vertical rail's menus open near the window's right edge,
 *  where the pane is short). */
export function menuTop(
  anchorTop: number,
  height: number,
  viewportHeight: number,
  margin = 12,
): number {
  const max = Math.max(margin, viewportHeight - height - margin);
  return Math.round(Math.min(Math.max(anchorTop, margin), max));
}

/** Tabs eligible for bulk cleanup: open tabs that are not the active tab,
 *  not currently streaming, and not open in a multi-window pane. Closing a
 *  tab never deletes the chat (the sidebar keeps it). */
export function inactiveTabIds(
  openIds: string[],
  activeId: string | null | undefined,
  streaming: Set<string> | string[],
  visible: Set<string> | string[],
): string[] {
  const streamingSet = streaming instanceof Set ? streaming : new Set(streaming);
  const visibleSet = visible instanceof Set ? visible : new Set(visible);
  return openIds.filter(
    (id) => id !== activeId && !streamingSet.has(id) && !visibleSet.has(id),
  );
}
