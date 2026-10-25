// Paging for long, filtered lists.
//
// Pure and dependency-free on purpose: it runs under plain Node in the test
// runner, so the clamp below can be unit-tested without a window or the store.
//
// A marketplace index holds hundreds of entries (the Claude one ships 315), so
// the browse list renders a page at a time.

/** Rows per page in a catalogue browser. */
export const PAGE_SIZE = 10

/** One page of a list, always valid.
 *
 *  The requested page is clamped onto the last real one: the page number is
 *  React state while the list is filtered by a search box, so a page that was in
 *  range before a keystroke can point past the end afterwards — rendering an
 *  empty list with no way back. */
export function paginate<T>(
  items: T[],
  page: number,
  size = PAGE_SIZE,
): { rows: T[]; page: number; pages: number; from: number; total: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const safe = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1)
  const from = safe * size
  return { rows: items.slice(from, from + size), page: safe, pages, from, total: items.length }
}
