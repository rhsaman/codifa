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

/** Map of id → how many slots the tab slides (−1 | 0 | +1) so a bar can show
 *  the landing with animated `transform`s. This REPLACED the `order`-slot
 *  preview: re-sorting with `order` reflows the whole bar every frame — tabs
 *  re-squeeze, labels re-ellipsis, nothing animates — while a transform slide
 *  freezes layout during the drag and animates tabs aside smoothly.
 *  Positive = one slot later in ARRAY order (to the right in a ltr bar). */
export function previewShifts(
  ids: string[],
  fromId: string,
  toId: string,
  after: boolean,
): Map<string, number> {
  const shifts = new Map<string, number>();
  const from = ids.indexOf(fromId);
  if (from < 0 || ids.indexOf(toId) < 0 || fromId === toId) return shifts;
  // The previewed order — the same splice the store's move performs — decides
  // each tab's slide: position change ⇔ one slot toward the freed hole.
  const next = previewOrder(ids, fromId, toId, after);
  for (const id of ids) {
    if (id === fromId) continue;
    const i = ids.indexOf(id);
    const j = next.indexOf(id);
    if (j !== i) shifts.set(id, j > i ? 1 : -1);
  }
  return shifts;
}
