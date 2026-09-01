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
 * ترکیب نشود.
 *
 * به‌طور پیش‌فرض، همه‌چیز غیر از متن (tool / tool_result) حفظ می‌شود: در
 * حالت resume (banner retry) کار واقعی replay می‌شود. در حالت restart (دکمهٔ
 * retry روی پیام) attempt جدید tool callهای تازه می‌سازد، پس segments
 * و toolActivity هم باید پاک شوند. فراخوان با ``mode`` کنترل می‌کند.
 */
export type ResetMode = 'resume' | 'restart'

export function resetStreamForRetry(
  content: string,
  segments?: MessageSegment[],
  mode: ResetMode = 'resume',
): { content: string; segments: MessageSegment[] } {
  if (mode === 'restart') {
    // Restart: tool calls are about to be re-issued by the model, so EVERY
    // segment is stale. Drop them all so the new stream starts on a clean
    // transcript and segments stay in 1:1 order with the new tool/text
    // events.
    return { content: '', segments: [] }
  }
  // Resume: keep tool segments (work was done; the next attempt continues
  // from the same transcript) but drop text segments (the next attempt will
  // re-stream its own answer and we don't want a duplicate).
  const kept = (segments ?? []).filter((s) => s.kind !== 'text')
  return { content: '', segments: kept }
}