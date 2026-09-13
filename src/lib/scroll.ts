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
  if (!restoreTarget) {
    return { cancelRestore: false, fromReanchor: false };
  }
  if (programmatic) {
    return { cancelRestore: false, fromReanchor: true };
  }
  return { cancelRestore: true, fromReanchor: false };
}
