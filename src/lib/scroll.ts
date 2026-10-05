/** فاصلهٔ پیکسلی از پایین که هنوز «در پایین» تلقی می‌شود. */
export const AT_BOTTOM_EPS = 8;

/** آیا نوار اسکرول در انتهای پایین است؟ (با تحمل eps پیکسل) */
export function isAtBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  eps: number = AT_BOTTOM_EPS,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < eps;
}

/** فاصلهٔ فعلی اسکرول از انتهای پایین (پیکسل). */
export function distanceFromBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** هدفِ بازیابیِ ویوپورتِ ذخیرهشده (لنگر + آفست). */
export type RestoreTarget = { id: string; offset: number };

/** رده‌بندی یک رویداد اسکرول نسبت به بازیابیِ در جریانِ ویوپورت:
 *  - بدون بازیابی فعال → رویداد عادی (کاربر/سیستم)
 *  - رویدادِ ناشی از ستِ برنامه‌ایِ scrollTop (پرچم programmatic) → re-anchor
 *  - غیر از آن، حین بازیابی → کاربر خودش اسکرول کرده → بازیابی لغو شود
 *
 *  چرا پرچم و نه مقایسهٔ مقداری با آخرین scrollTopِ ستشده: مرورگر مقدار
 *  خواستهشده را در برابر scrollHeight - clientHeight «clamp» میکند — حین
 *  بازیابی، placeholderهای content-visibility (۱۴۰px) کوتاهتر از ارتفاع
 *  واقعی محتوایند، پس مقدارِ خواستهشده میتواند بزرگتر از حد مجاز باشد و
 *  رویدادِ اسکرولِ ستِ برنامهَای با مقداری «متفاوت» شلیق شود. مقایسهٔ مقداری
 *  آن را «اسکرول کاربر» میپندارد؛ آنگاه isAtBottom در انتهای clampشده
 *  غلطِ «در پایین» میدهد، stickToBottom روشن میشود و اولین بهروزرسانی
 *  پیامها (استریمِ پسزمینه) ویوپورت را به انتها میکشد و موقعیتِ ذخیرهشده
 *  با atBottom بازنویسی میشود — رگرسیونِ «برگشتن به چت و افتادن به انتهای
 *  صفحه». پرچمِ ستِ برنامهَای (که تا rAF بعدی پایین میآید، چون طبق spec
 *  رویدادهای scrollِ یک ست در همان فریم و قبل از rAF شلیق میشوند) در برابر
 *  clamp مصون است. */
export function classifyScrollEvent(
  restoreTarget: RestoreTarget | null,
  programmatic: boolean,
): { cancelRestore: boolean; fromReanchor: boolean } {
  if (programmatic) {
    return { cancelRestore: false, fromReanchor: true };
  }
  if (!restoreTarget) {
    return { cancelRestore: false, fromReanchor: false };
  }
  return { cancelRestore: true, fromReanchor: false };
}

/** Saved scroll position of a chat (structural mirror of `Chat.scrollPos`). */
export type ScrollPos = { id: string; offset: number; atBottom: boolean }

/** Saved position for a chat pinned to the newest messages: the anchor id and
 *  offset are unused for `atBottom` restores, so no DOM scan is needed. */
export function atBottomScrollPos(): ScrollPos {
  return { id: '', offset: 0, atBottom: true }
}

/** Saved position to persist when leaving a chat: a pin to the bottom
 *  outranks the raw capture — the capture can be stale (its rAF may have been
 *  cancelled by the switch flush) or never have happened (entering a chat and
 *  the jump-button arrival don't schedule one), so persisting it as-is would
 *  resurrect an old scrolled-up anchor and the chat would not reopen at the
 *  bottom. Unpinned → the captured position passes through unchanged
 *  (null = nothing captured → caller skips the write). */
export function scrollPosForFlush(
  captured: ScrollPos | null,
  pinned: boolean,
): ScrollPos | null {
  return pinned ? atBottomScrollPos() : captured
}

/** Fingerprint of a chat transcript for "did anything change while away?"
 *  comparisons. Covers a new message, a message that grew in place (streamed
 *  text or tool output appended under the SAME id — the common case for an
 *  agent turn that kept running in a background chat), and added segments or
 *  tool-activity entries. Empty transcript → empty string. */
export function messageFingerprint(
  messages: ReadonlyArray<{
    id: string
    content?: string | null
    segments?: ReadonlyArray<unknown>
    toolActivity?: ReadonlyArray<unknown>
  }>,
): string {
  if (messages.length === 0) return ''
  const last = messages[messages.length - 1]
  const contentLen = typeof last.content === 'string' ? last.content.length : 0
  const segCount = Array.isArray(last.segments) ? last.segments.length : 0
  const toolCount = Array.isArray(last.toolActivity) ? last.toolActivity.length : 0
  return `${messages.length}:${last.id}:${contentLen}+${segCount}+${toolCount}`
}

/** Should opening a chat land on the NEWEST messages instead of restoring
 *  the saved scroll anchor?
 *  - `agentActive` — the agent is live in this chat (streaming, marked busy,
 *    or waiting on the user): the user comes back to watch the turn, so the
 *    view must follow it, not a position saved before they left.
 *  - a `fingerprint` different from `seenFingerprint` (recorded when the user
 *    last LEFT this chat) — the agent posted or updated a message while they
 *    were away, and restoring the old anchor would hide exactly the reply
 *    they came back to read.
 *  No leave record (never viewed this session) or an empty chat → keep the
 *  persisted anchor. */
export function shouldLandOnLatest(input: {
  agentActive: boolean
  fingerprint: string
  seenFingerprint: string | undefined
}): boolean {
  if (input.agentActive) return true
  if (!input.fingerprint || input.seenFingerprint === undefined) return false
  return input.seenFingerprint !== input.fingerprint
}

/** Pixel tolerance when comparing a scroll event's position against the last
 *  programmatic pin: sub-pixel rounding can leave scrollTop a fraction off. */
export const PIN_TOP_EPS = 1

/** Freshness window for a recorded programmatic pin (ms). Late-dispatched
 *  scroll events from a pin arrive within a frame or two; after this window
 *  an identical scrollTop is a coincidence, so the event counts as the user's. */
export const PIN_FRESH_MS = 500

/** True when a scroll event sits exactly where the last programmatic pin put
 *  it (and the pin is still fresh): the event is the pin's own
 *  late-dispatched event or content growth under a pinned viewport — never a
 *  manual scroll-up — so it must not unpin auto-scroll. Compare against the
 *  CLAMPED value read back after the set, never the requested value: the
 *  browser clamps the request to the scroll range, which is what broke the old
 *  value-comparison approach. */
export function scrollMatchesPin(
  scrollTop: number,
  pin: { top: number; at: number } | null,
  now: number = Date.now(),
): boolean {
  if (!pin) return false
  if (now - pin.at > PIN_FRESH_MS) return false
  return Math.abs(scrollTop - pin.top) <= PIN_TOP_EPS
}

/** Visible padding kept around the active popup row after scrolling. */
export const POPUP_ROW_PAD = 8

/** Pure scroll math for popup keyboard navigation: given the container's
 *  current scrollTop/clientHeight and the active row's top/height relative
 *  to the container, return the scrollTop that keeps the row visible.
 *  A row above the view scrolls up, a row below scrolls down, and a
 *  visible row keeps the current scrollTop. */
export function popupRowScrollTop(args: {
  scrollTop: number
  clientHeight: number
  rowTop: number
  rowHeight: number
  padding?: number
}): number {
  const pad = args.padding ?? POPUP_ROW_PAD
  const rowBottom = args.rowTop + args.rowHeight
  const viewBottom = args.scrollTop + args.clientHeight
  if (args.rowTop < args.scrollTop) return Math.max(0, args.rowTop - pad)
  if (rowBottom > viewBottom) return rowBottom - args.clientHeight + pad
  return args.scrollTop
}

/** Scroll the active row of a composer popup into view by adjusting ONLY
 *  the popup container's scrollTop (never the window). Returns true when a
 *  row was found (whether or not scrolling was needed), false otherwise.
 *  Uses the offsetTop chain so rows nested in section wrappers resolve
 *  relative to the container. Falls back to scrollIntoView when layout
 *  metrics are unavailable (zero heights in hidden containers). */
export function scrollPopupRowIntoView(
  container: HTMLElement | null | undefined,
  rowSelector: string,
  padding: number = POPUP_ROW_PAD,
): boolean {
  if (!container) return false
  const row = container.querySelector<HTMLElement>(rowSelector)
  if (!row) return false
  let top = 0
  let el: HTMLElement | null = row
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  if (container.clientHeight <= 0 || row.offsetHeight <= 0) {
    row.scrollIntoView({ block: 'nearest' })
    return true
  }
  container.scrollTop = popupRowScrollTop({
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    rowTop: top,
    rowHeight: row.offsetHeight,
    padding,
  })
  return true
}
