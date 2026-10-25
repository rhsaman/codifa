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

/**
 * Whether the mounted transcript window may be shrunk back to one page.
 *
 * `msgLimit` only ever grew: every scroll-to-top raised it, nothing lowered it,
 * and it reset only on a chat switch. So once a user had scrolled up through a
 * long chat, every message they had passed stayed in the DOM for the rest of the
 * session. Each mounted message keeps a laid-out subtree and its paint
 * resources, which is why the renderer's footprint tracked the longest scroll
 * ever performed rather than what was on screen.
 *
 * The trim is only safe while the viewport is pinned to the NEWEST message:
 * there, removing content above the viewport is invisible (the scroll offset is
 * already clamped at the maximum). While the user is reading history, shrinking
 * would delete content under their viewport and immediately re-trigger the
 * scroll-to-top auto-load, oscillating between mount and unmount.
 *
 * Pure so the policy is testable without a DOM — `nowPinned` is the caller's
 * live `stickToBottom` ref, `isActive` whether this panel owns the focus.
 *
 * An INACTIVE panel trims unconditionally: nothing is reading it, so its
 * mounted transcript is pure footprint. Keeping a scrolled-up window warm in a
 * background pane multiplied the renderer's cost by the number of open chats —
 * measured, the WebContent footprint grew with every extra pane that had ever
 * been scrolled, while only one of them was on screen. The window paged back in
 * the moment the pane regains focus (its saved scroll anchor restores the same
 * viewport), so no visible history is lost.
 */
export function shouldTrimMountedWindow(
  msgLimit: number,
  msgPage: number,
  nowPinned: boolean,
  isActive = true,
): boolean {
  return (nowPinned || !isActive) && msgLimit > msgPage
}
