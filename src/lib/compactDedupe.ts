import type { ChatMessage } from '../types'

/** پیام‌های قابل‌نمایش لیست چت.
 *
 *  فقط رکوردهایی حذف می‌شوند که هیچ‌وقت رندر نمی‌شوند:
 *
 *  - `modeSwitch`ها: فقط برای تاریخچهٔ مدل‌اند و رندر نمی‌شوند.
 *  - خلاصهٔ system که شناسه‌اش در سگمنت درون‌خطی compact یک پیام دیگر است:
 *    فقط همان‌جا (درون پیام استریمینگ) رندر می‌شود و نسخهٔ مستقل ته لیست حذف
 *    می‌شود تا اتو-کامپکت وسط استریم دو بلوک تکراری نسازد. بین‌ترن‌ها (بدون
 *    سگمنت) همان پیام مستقل نمایش داده می‌شود.
 *
 *  پیام‌های `compacted` عمداً نمایشی می‌مانند: خلاصه یک checkpoint است، نه
 *  جایگزین تاریخچه. پنهان‌کردنشان باعث می‌شد چت از روی کارت CONTEXT SUMMARY
 *  شروع شود و دکمهٔ «Load earlier» پیام‌هایی را بشمارد که هرگز ظاهر نمی‌شدند.
 *  پنجرهٔ رندر (`sliceWindow`) حجم DOM را محدود نگه می‌دارد. */
export function visibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const inlineCompactIds = new Set<string>()
  for (const msg of messages) {
    for (const seg of msg.segments ?? []) {
      if (seg.kind === 'compact') inlineCompactIds.add(seg.id)
    }
  }
  return messages.filter(
    (m) => !m.modeSwitch && !inlineCompactIds.has(m.id),
  )
}
