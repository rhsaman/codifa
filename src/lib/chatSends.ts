/**
 * Registry of the latest `send` implementation per chat id, so a queued turn
 * can be started even while that chat's panel is unmounted (user is viewing
 * another chat). Registered on every render of the ChatPanel via useEffect and
 * NEVER deregistered on unmount — otherwise a background auto-drained turn
 * could not start after the user switches chats.
 *
 * The stored function must only depend on (a) its chatId argument and (b)
 * mutable store state read at call time — NOT on React component state that
 * goes stale when the panel unmounts (see the nvimMentioned draft changes in
 * Chat.tsx for why).
 */

import type { QueuedMessage } from "../types"
import { useStore } from "./store"

type SendFn = (
  text: string,
  attachments?: string[],
  images?: Array<{ path: string; name: string; dataUrl?: string }>,
  allowCreate?: boolean,
  reuseMsgId?: string,
) => void

const registry = new Map<string, SendFn>()

export function uid2(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function registerChatSend(chatId: string, fn: SendFn): void {
  registry.set(chatId, fn)
}

/** Start the NEXT queued (unsent) message of a chat as a normal turn. Returns
 *  true if a message was sent, false if there's nothing left to drain. */
export function sendQueuedNext(chatId: string): boolean {
  const store = useStore.getState()
  const chat = store.chats.find((c) => c.id === chatId)
  const queued = chat?.queued?.filter((q) => !q.sent)
  if (!chat || !queued || queued.length === 0) return false
  const fn = registry.get(chatId)
  if (!fn) return false
  const next: QueuedMessage = queued[0]
  // Mark sent BEFORE calling send so re-entrant drains don't re-pick it.
  store.markQueuedSent(chatId, next.id)
  fn(next.text, next.attachments ?? [], next.images ?? [])
  return true
}

/** Start the FIRST undelivered steer message of a chat as a normal turn,
 *  REUSING the user message that is already visible in the transcript (no
 *  duplicate bubble). Returns true if a message was sent. */
export function sendPendingSteerNext(chatId: string): boolean {
  const store = useStore.getState()
  const chat = store.chats.find((c) => c.id === chatId)
  const pending = chat?.messages.find((m) => m.role === "user" && m.steerPending)
  if (!chat || !pending) return false
  const fn = registry.get(chatId)
  if (!fn) return false
  fn(
    pending.content,
    pending.attachments ?? [],
    pending.images ?? [],
    undefined,
    pending.id,
  )
  return true
}
