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
