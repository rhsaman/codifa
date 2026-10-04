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

/** Should opening a chat land on the NEWEST messages instead of restoring
 *  the saved scroll anchor?
 *  - `streaming` — the agent is live in this chat: the user comes back to
 *    watch the turn, so the view must follow it, not a position saved before
 *    they left.
 *  - a `lastMessageId` different from `seenLastMessageId` (recorded when the
 *    user last LEFT this chat) — the agent posted while they were away, and
 *    restoring the old anchor would hide exactly the reply they came back to
 *    read.
 *  No leave record (never viewed this session) or an empty chat → keep the
 *  persisted anchor. */
export function shouldLandOnLatest(input: {
  streaming: boolean
  lastMessageId: string
  seenLastMessageId: string | undefined
}): boolean {
  if (input.streaming) return true
  if (!input.lastMessageId || input.seenLastMessageId === undefined) return false
  return input.seenLastMessageId !== input.lastMessageId
}
