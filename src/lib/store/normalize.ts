import type { Chat, ChatMessage, QueuedMessage, ToolActivity } from '../../types'
import { capCompactedMessages } from './data'
import { trimPersistImageValue, trimToolActivity } from './sanitize'
// Extracted verbatim from store.ts (pure helpers, no store access).

export const QUEUED_SENT_GRACE_MS = 10 * 60 * 1000

/** Drop queue entries that have already been handed to the agent.
 *
 *  A queued message is a PENDING send: once `markQueuedSent` flipped `sent` the
 *  transcript owns the content and the queue copy is dead weight — the UI hides
 *  it (`Chat.tsx` filters `!q.sent`), yet nothing deleted it. Entries therefore
 *  accumulated forever, complete with their base64 screenshots: on one real
 *  profile that was 5.4 MB of a 5.5 MB settings.json, i.e. the whole chat index
 *  was dead queue copies, re-serialized on every persist.
 */
export function pruneQueued(
  queued: QueuedMessage[] | undefined,
  now = Date.now(),
): QueuedMessage[] | undefined {
  if (!queued || queued.length === 0) return queued
  const kept = queued.filter((q) => !q.sent || now - (q.createdAt ?? 0) < QUEUED_SENT_GRACE_MS)
  return kept.length === queued.length ? queued : kept
}

// Strip transient, in-memory-only fields from messages AND chats before
// persisting so they never reappear after a restart (e.g. the rate-limit retry
// banner, or a stale ask/permission popup whose agent is long gone).
// Chats with zero messages are dropped entirely: a fresh "new chat" tab only
// becomes real (sidebar row + file on disk) once the first message is sent.
export function sanitizeChats(chats: Chat[]): Chat[] {
  const out: Chat[] = []
  const now = Date.now()
  for (const original of chats) {
    const pruned = pruneQueued(original.queued, now)
    const c = pruned === original.queued ? original : { ...original, queued: pruned }
    const hasBody = Array.isArray(c.messages) && c.messages.length > 0
    // INDEX ROW (the transcript lives in its own file and is not in memory):
    // persist the metadata verbatim, with `messages` REMOVED. This is the
    // structural safety net for the split-storage layout — neither an
    // unhydrated chat NOR a paged window may produce a body write, because a
    // fragment would overwrite the real transcript file.
    if (c.hydrated === false || (c.bodyStart ?? 0) > 0) {
      const {
        messages: _omitted,
        hydrated: _h,
        bodyStart: _bs,
        bodyTotal: _bt,
        ...meta
      } = c as Chat & {
        messages?: ChatMessage[]
        hydrated?: boolean
        bodyStart?: number
        bodyTotal?: number
      }
      out.push(meta as Chat)
      continue
    }
    // A chat with no messages at all is in-memory only (a fresh tab): never a
    // sidebar row, never a file on disk.
    if (!hasBody) continue
    // A PENDING fork (seeded but no user turn yet) is in-memory only too: it
    // has messages, so the `hasBody` check above alone would persist it the
    // moment the fork was created. The user-message guard is belt-and-suspenders
    // — addMessage already clears the flag on the first user turn, so a fork
    // that somehow gained one still persists.
    if (c.pendingFirstMessage && !c.messages.some((m) => m.role === 'user')) continue
    const clean = { ...c }
    delete clean.pendingAsk
    delete clean.pendingPermission
    // Window bookkeeping is runtime-only; the body file stores the full
    // transcript and the next open derives these again.
    delete clean.bodyStart
    delete clean.bodyTotal
    out.push({
      ...clean,
      messages: capCompactedMessages(c.messages.map((m) => {
        const msg = { ...m } as Record<string, unknown>
        delete msg.retry
        // A message persisted mid-stream (heartbeat snapshot) is marked so the
        // UI can show it as "interrupted" after a crash/power cut instead of
        // looking like a complete reply. The final write once the turn ends
        // (streaming=false) clears the flag naturally.
        if (msg.streaming) msg.interrupted = true
        delete msg.streaming
        delete msg.thinking
        delete msg.lspStatus
        // Keep toolActivity (trimmed) so tool cards survive a restart — it was
        // previously stripped as transient, which is why tool calls vanished
        // after any reload, not just after a power cut.
        if (Array.isArray(msg.toolActivity)) {
          msg.toolActivity = trimToolActivity(msg.toolActivity as ToolActivity[])
        }
        // Cap base64 image payloads on the persisted copy only (see
        // MAX_PERSIST_IMAGE_CHARS): keeps chat JSON + heartbeat IPC small.
        if (Array.isArray(msg.images)) {
          msg.images = (msg.images as unknown[]).map(trimPersistImageValue) as ChatMessage['images']
        }
        return msg as unknown as ChatMessage
      })),
    })
  }
  return out
}

// ── Mid-stream persistence (heartbeat) ────────────────────────────────────────
// While a reply is streaming, the store defers full writes (see persist()) so
// per-token updates don't hammer the DB. But that alone means a power cut loses
// the ENTIRE in-flight turn — it never reached disk. The heartbeat below writes
// a throttled chats-only snapshot at most once every MID_STREAM_MS while a run
// is active, so a crash loses at most the last ~2s instead of the whole turn.
