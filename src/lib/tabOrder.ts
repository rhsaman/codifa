// Ordering math shared by the tab bars' drag previews.
// Pure, so the "where will this tab land" preview is unit-testable without a DOM.

/** Ids reordered so `fromId` lands before `toId` (or after it when `after`).
 *  Mirrors the store's moveTab splice, so the drag preview is exact. */
export function previewOrder(
  ids: string[],
  fromId: string,
  toId: string,
  after: boolean,
): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  // `to` is re-read after the removal: the target may have shifted left.
  const dest = next.indexOf(toId) + (after ? 1 : 0);
  next.splice(Math.max(0, Math.min(next.length, dest)), 0, moved);
  return next;
}

/** Map of id → slot for the previewed order, so a bar can set CSS `order`
 *  without moving the DOM node (moving it cancels the native drag). */
export function previewSlot(
  ids: string[],
  fromId: string,
  toId: string,
  after: boolean,
): Map<string, number> {
  const slot = new Map<string, number>();
  previewOrder(ids, fromId, toId, after).forEach((id, i) => slot.set(id, i));
  return slot;
}
