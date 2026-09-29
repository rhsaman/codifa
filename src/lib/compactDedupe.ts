import type { ChatMessage } from '../types'

/** پیام‌های قابل‌نمایش لیست چت: خلاصه system که شناسه‌اش در سگمنت درون‌خطی compact یک پیام دیگر هست فقط همان‌جا (درون پیام استریمینگ) رندر می‌شود و نسخه مستقل ته لیست حذف می‌شود تا اتو-کامپکت وسط استریم دو بلوک تکراری نسازد. بین‌ترن‌ها (بدون سگمنت) همان پیام مستقل نمایش داده می‌شود. */
export function visibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const inlineCompactIds = new Set<string>()
  for (const msg of messages) {
    for (const seg of msg.segments ?? []) {
      if (seg.kind === 'compact') inlineCompactIds.add(seg.id)
    }
  }
  if (inlineCompactIds.size === 0) return messages
  return messages.filter((m) => !inlineCompactIds.has(m.id))
}
