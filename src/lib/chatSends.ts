/**
 * Registry of the latest `send` implementation per chat id, so a queued turn
 * can be started even while that chat's panel is unmounted (user is viewing
 * another chat). Registered on every render of the ChatPanel via useEffect and
 * NEVER deregistered on unmount — otherwise a background auto-drained turn
 * could not start after the user switches chats.
 *
 * The stored function must only depend on (a) its chatId argument and (b)
 * mutable store state read at call time — NOT on React component state that
 * goes stale when the panel unmounts.
 */

import type { McpServerConfig, QueuedMessage } from "../types"
import { registerChatDeleteHook, useStore } from "./store"

type SendFn = (
  text: string,
  attachments?: string[],
  images?: Array<{ path: string; name: string; dataUrl?: string }>,
  allowCreate?: boolean,
  reuseMsgId?: string,
  continueAssistantId?: string,
  forceScroll?: boolean,
  overrides?: { mcpServers?: Record<string, McpServerConfig>; skills?: string[] },
) => void

const registry = new Map<string, SendFn>()

export function uid2(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function registerChatSend(chatId: string, fn: SendFn): void {
  registry.set(chatId, fn)
}

/** Drop a chat's registered send closure. Exported for tests; in production the
 *  store's delete hook below is the caller. */
export function unregisterChatSend(chatId: string): void {
  registry.delete(chatId)
}

/** How many chats hold a live send closure (test/diagnostics only). */
export function chatSendCount(): number {
  return registry.size
}

// A DELETED chat can never drain a queued turn again — `sendQueuedNext` bails
// on the missing chat row — so its retained `send` closure (and the whole panel
// render scope it closes over, drafts and images included) was pure leak: it
// lived for the rest of the session. Now it dies with the chat. Unmount is
// deliberately NOT a release point: a background chat must still be able to
// start its queued turn while its panel is unmounted.
registerChatDeleteHook(unregisterChatSend)

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
  fn(next.text, next.attachments ?? [], next.images ?? [], undefined, undefined, undefined, undefined, {
    mcpServers: next.mcpServers,
    skills: next.skills,
  })
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
    undefined,
    undefined,
    {
      mcpServers: pending.mcpServers,
      skills: pending.skills,
    },
  )
  return true
}
