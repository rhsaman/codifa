/**
 * Bare `j`/`k` walking the sidebar's chat list — the same muscle memory the
 * chat windows and the file explorer already use, applied to the conversation
 * list so chats can be selected without the mouse.
 *
 * The index arithmetic is PURE (no React, no store) so it is unit-testable; the
 * caller maps the chosen id to `openChat`.
 */

/** Clamp `next` into `[0, count)`, or -1 for an empty list. */
function clamp(next: number, count: number): number {
  if (count <= 0) return -1
  if (next < 0) return 0
  if (next >= count) return count - 1
  return next
}

/**
 * The id `delta` rows away from `currentId` in `ids`.
 *
 * A missing/unknown `currentId` starts from the top of the list (going down) or
 * the bottom (going up), so the first press always lands somewhere useful.
 * The result never wraps: reaching an end keeps the caret there.
 */
export function stepChatId(
  ids: readonly string[],
  currentId: string | null | undefined,
  delta: number,
): string | null {
  if (ids.length === 0 || delta === 0) return null
  const idx = currentId ? ids.indexOf(currentId) : -1
  if (idx === -1) return ids[delta > 0 ? 0 : ids.length - 1] ?? null
  const next = clamp(idx + delta, ids.length)
  const id = ids[next]
  return id === undefined || id === currentId ? null : id
}
