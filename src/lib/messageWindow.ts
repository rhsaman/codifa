// Window the rendered transcript by BOTH count and characters.
//
// Switching chats mounts every rendered message fresh (react-markdown parses
// each one: ~100ms per 30KB, ~300ms per 300KB measured via SSR). A count-only
// page (30 messages) still mounts megabytes on giant chats, so the initial
// window is also capped by total text. "Load older" grows both caps together,
// so the button can never get stuck showing messages it cannot reveal.
export const MSG_WINDOW_MIN_KEEP = 5
export const MSG_WINDOW_FIRST = 150_000
export const MSG_WINDOW_PER_PAGE = 250_000

// Char budget for a window holding `msgLimit` messages: the first page is
// small (fast initial paint after a chat switch); every expansion adds a
// generous page so giant chats reveal several more messages per click/scroll
// instead of crawling one message at a time. Pure function of msgLimit, so
// scroll-loading, the button and scroll-restore all agree with no extra state.
export function windowBudget(msgLimit: number, msgPage: number): number {
  const pages = Math.max(1, Math.ceil(msgLimit / msgPage))
  return MSG_WINDOW_FIRST + MSG_WINDOW_PER_PAGE * (pages - 1)
}

export function sliceWindow<T>(
  items: T[],
  msgLimit: number,
  charBudget: number,
  minKeep: number,
  lenOf: (item: T) => number,
): T[] {
  if (items.length === 0) return items
  const countStart = Math.max(0, items.length - msgLimit)
  // Walk back from the newest, always keeping the newest message itself (the
  // streaming tail must render even when one message alone exceeds budget).
  let start = items.length
  let chars = 0
  while (start > 0) {
    const len = Math.max(0, lenOf(items[start - 1]) || 0)
    if (chars + len > charBudget && start < items.length) break
    chars += len
    start--
  }
  // Never keep fewer than minKeep newest, never more than the count page.
  const minStart = Math.max(0, items.length - minKeep)
  return items.slice(Math.max(countStart, Math.min(start, minStart)))
}
