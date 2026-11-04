// Shared interaction helpers for the editor tab bars (chats + viewers).
// Pure functions so both bars behave identically and stay unit-testable.

import { previewOrder } from "./tabOrder";

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

/** Visual flow direction of a bar: +1 when array order renders left→right
 *  (a ltr flex row), −1 when it renders right→left (rtl). Slide transforms
 *  are physical, so a slide of one ARRAY slot must be mirrored in rtl. */
export function barFlowSign(bar: HTMLElement): 1 | -1 {
  try {
    return getComputedStyle(bar).direction === "rtl" ? -1 : 1;
  } catch {
    return 1;
  }
}

/** Slide distance for one slot: the dragged tab's outer width plus the bar's
 *  flex gap — exactly the hole the dragged tab leaves behind. */
export function slideWidth(dragged: HTMLElement, bar: HTMLElement): number {
  const w = dragged.getBoundingClientRect().width;
  let gap = 0;
  try {
    const cs = getComputedStyle(bar);
    gap = parseFloat(cs.columnGap || cs.gap || "") || 0;
  } catch {
    /* keep 0 */
  }
  return w + gap;
}

/** Slide distance for one slot in a VERTICAL list: the dragged row's outer
 *  height plus the list's row gap — the hole a dragged sidebar folder leaves. */
export function slideHeight(dragged: HTMLElement, list: HTMLElement): number {
  const h = dragged.getBoundingClientRect().height;
  let gap = 0;
  try {
    const cs = getComputedStyle(list);
    gap = parseFloat(cs.rowGap || cs.gap || "") || 0;
  } catch {
    /* keep 0 */
  }
  return h + gap;
}

export interface TabExtent {
  id: string;
  /** Horizontal bar extents (axis "x"). */
  left?: number;
  right?: number;
  /** Vertical list extents (axis "y") — the sidebar folder rows. */
  top?: number;
  bottom?: number;
}

/** Which tab a drop lands on, from the pointer position and the tabs' PHYSICAL
 *  extents: the tab under the pointer (side = which half), else — over a gap
 *  or the empty space past the ends — the nearest tab by center. `sign` is
 *  the bar's flow direction, so "after" stays array-order-correct in rtl bars
 *  (a drop on a tab's right half is AFTER it in ltr, BEFORE it in rtl).
 *  `axis` selects the measured pair: left/right for horizontal bars, top/bottom
 *  for vertical lists (a sidebar's folder rows, where array order always flows
 *  top→bottom, so sign stays 1). This replaces the old "only the space past the
 *  tail drops at the end" rule, which left every inter-tab gap a dead drop zone. */
export function tabForPoint(
  tabs: TabExtent[],
  x: number,
  sign: 1 | -1 = 1,
  axis: TabAxis = "x",
): { id: string; after: boolean } | null {
  if (tabs.length === 0) return null;
  const startOf = (t: TabExtent) => (axis === "y" ? t.top : t.left) ?? 0;
  const endOf = (t: TabExtent) => (axis === "y" ? t.bottom : t.right) ?? 0;
  const sideOf = (t: TabExtent) => {
    const after = x > (startOf(t) + endOf(t)) / 2;
    return sign === 1 ? after : !after;
  };
  for (const t of tabs) {
    if (x >= startOf(t) && x <= endOf(t)) return { id: t.id, after: sideOf(t) };
  }
  let best = tabs[0];
  let bestDist = Infinity;
  for (const t of tabs) {
    const d = Math.abs(x - (startOf(t) + endOf(t)) / 2);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return { id: best.id, after: sideOf(best) };
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

// ---------------------------------------------------------------------------
// Captured drag geometry — the fix for the drag "jump".
//
// The landing preview slides rows with transforms, and the drop target was
// re-measured from LIVE rects on every dragover. Live rects carry those slide
// transforms, so as rows slid under the cursor the next hit-test saw different
// geometry, the target flipped, the slides flipped back — the preview
// oscillated and the drop landed one slot off. Hit-testing must run against
// the ORIGINAL layout, captured once at drag start and only scroll-compensated.
// ---------------------------------------------------------------------------

/** Slot extents captured at drag start: viewport-space start/end per id, the
 *  scroller whose offset can shift the content mid-drag (the bar itself for
 *  tab rails, the nearest scrolling ancestor for in-page lists), and that
 *  scroller's offset at capture time. */
export interface DragSlots {
  ids: string[];
  axis: TabAxis;
  /** Flow sign (barFlowSign) — kept for tabForPoint's before/after semantics. */
  sign: 1 | -1;
  start: Map<string, number>;
  end: Map<string, number>;
  scroller: HTMLElement | null;
  scroll0: number;
}

/** The nearest element that actually scrolls on the axis — `el` itself first
 *  (tab rails scroll their own content), then its ancestors (settings lists
 *  scroll inside .settings-content, not in the list). */
function scrollParentOf(el: HTMLElement, axis: TabAxis): HTMLElement | null {
  const prop = axis === "y" ? "overflowY" : "overflowX";
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    try {
      if (/(auto|scroll)/.test(getComputedStyle(n)[prop] ?? "")) return n;
    } catch {
      /* detached node — stop walking */
      return null;
    }
  }
  return null;
}

/** Measure every row's box ONCE (drag start — all transforms are still at
 *  rest). Returns null when any row is missing (caller falls back to live
 *  measuring rather than half-captured geometry). */
export function captureDragSlots(
  container: HTMLElement | null,
  ids: string[],
  resolve: (id: string, index: number) => HTMLElement | null,
  axis: TabAxis,
  sign: 1 | -1,
): DragSlots | null {
  if (!container || ids.length === 0) return null;
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const el = resolve(id, i);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    start.set(id, axis === "x" ? r.left : r.top);
    end.set(id, axis === "x" ? r.right : r.bottom);
  }
  const scroller = scrollParentOf(container, axis);
  const scroll0 = scroller ? (axis === "x" ? scroller.scrollLeft : scroller.scrollTop) : 0;
  return { ids, axis, sign, start, end, scroller, scroll0 };
}

/** Captured extents mapped to the CURRENT viewport: the captured boxes only
 *  go stale through the scroller's own offset, so shift them by the scroll
 *  delta (sign works out identically for LTR and RTL scroll offsets). The
 *  slide transforms are deliberately NOT reflected — hit-testing must see
 *  the original layout or the preview oscillates. */
export function slotExtents(slots: DragSlots): TabExtent[] {
  const s = slots.scroller
    ? slots.axis === "x"
      ? slots.scroller.scrollLeft
      : slots.scroller.scrollTop
    : slots.scroll0;
  const d = slots.scroll0 - s;
  return slots.ids.map((id) => {
    const a = (slots.start.get(id) ?? 0) + d;
    const b = (slots.end.get(id) ?? 0) + d;
    return slots.axis === "x" ? { id, left: a, right: b } : { id, top: a, bottom: b };
  });
}

/** Exact per-id PIXEL shifts for a landing preview. Each id moves to the
 *  start its preview position really has after the commit reflows — the sum
 *  of the crossed slots' full strides (size + gap), so variable sizes and
 *  list gaps land exactly, in BOTH directions (the delta is physical px; the
 *  old uniform ±slot×sign slides misaligned by one gap per crossed row). */
export function slotShifts(
  slots: DragSlots,
  fromId: string,
  toId: string,
  after: boolean,
): Map<string, number> {
  const shifts = new Map<string, number>();
  const next = previewOrder(slots.ids, fromId, toId, after);
  if (next.every((id, i) => id === slots.ids[i])) return shifts;
  // Original stride of slot i (size + the gap that follows it); the last slot
  // has no follower, so its stride is its own size.
  const stride = (i: number) =>
    i + 1 < slots.ids.length
      ? (slots.start.get(slots.ids[i + 1]) ?? 0) - (slots.start.get(slots.ids[i]) ?? 0)
      : (slots.end.get(slots.ids[i]) ?? 0) - (slots.start.get(slots.ids[i]) ?? 0);
  // Reflowed start of every preview position, walking the preview order.
  const finalStart: number[] = [];
  let acc = slots.start.get(slots.ids[0]) ?? 0;
  for (const id of next) {
    finalStart.push(acc);
    acc += stride(slots.ids.indexOf(id));
  }
  for (let p = 0; p < next.length; p++) {
    const delta = finalStart[p] - (slots.start.get(next[p]) ?? 0);
    if (delta !== 0) shifts.set(next[p], delta);
  }
  return shifts;
}

/** Live-measured extents — the fallback when no captured slots exist (a drag
 *  that started before capture could run, or a test harness without refs).
 *  Carries the same oscillation caveat as ever: prefer captureDragSlots. */
export function liveExtents(
  container: HTMLElement,
  attr: string,
  axis: TabAxis,
): TabExtent[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${attr}]`)).map((el) => {
    const r = el.getBoundingClientRect();
    const id = el.getAttribute(attr) ?? "";
    return axis === "x"
      ? { id, left: r.left, right: r.right }
      : { id, top: r.top, bottom: r.bottom };
  });
}
