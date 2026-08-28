import type { ChatMessage, MessageSegment } from '../types'

export type RetrySource = 'message' | 'banner'

export interface RetryTarget {
  userMsgId: string
  content: string
  attachments: string[]
  images: Array<{ path: string; name: string; dataUrl?: string }>
}

export type RetryPlan =
  | { action: 'restart'; target: RetryTarget }
  | { action: 'resume'; target: RetryTarget }

/**
 * Decide what a retry click does. The two retry paths are deliberately
 * different:
 *
 *  - message retry button (`source: 'message'`) → RESTART: a deliberate "redo".
 *    Everything below the clicked user message (including any partial assistant
 *    reply) is deleted and a fresh reply is generated from that message.
 *  - banner error retry (`source: 'banner'`) → RESUME: a recovery. The
 *    interrupted assistant message (partial content + completed tool calls) is
 *    kept and the turn continues from where it was cut off, so completed work
 *    is not redone.
 *
 * Returns null when `userMsgId` doesn't reference a non-empty user message.
 */
export function planRetry(
  messages: ChatMessage[],
  userMsgId: string,
  source: RetrySource,
): RetryPlan | null {
  const msg = messages.find((m) => m.id === userMsgId)
  if (!msg || msg.role !== 'user' || !msg.content.trim()) return null
  const target: RetryTarget = {
    userMsgId,
    content: msg.content,
    attachments: msg.attachments ?? [],
    images: msg.images ?? [],
  }
  return source === 'banner' ? { action: 'resume', target } : { action: 'restart', target }
}

/**
 * وقتی بک‌اند یک رویداد `retry` می‌فرستد، attempt قبلی ممکن است چند chunk متن
 * واقعی را قبلاً stream کرده باشد. آن متن هرگز به تاریخچه (msgs) اضافه نشده —
 * فقط در UI مانده. قبل از شروع attempt بعدی باید پاک شود تا با پاسخ کامل جدید
 * ترکیب نشود. tool/user segments حفظ می‌شوند (کار واقعیِ replay‌شده).
 */
export function resetStreamForRetry(
  content: string,
  segments?: MessageSegment[],
): { content: string; segments: MessageSegment[] } {
  const kept = (segments ?? []).filter((s) => s.kind !== 'text')
  return { content: '', segments: kept }
}