/** فاصلهٔ پیکسلی از پایین که هنوز «در پایین» تلقی می‌شود. */
export const AT_BOTTOM_EPS = 8;

/** آیا نوار اسکرول در انتهای پایین است؟ (با تحمل eps پیکسل) */
export function isAtBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  eps: number = AT_BOTTOM_EPS,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < eps;
}
