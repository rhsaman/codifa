import type { ChatMessage, MessageSegment } from '../types'

export type RetrySource = 'message' | 'banner'

/**
 * Resolve the OWNING user message for a restart-from-scratch retry.
 *
 * - `id` on a user message → that message itself (empty content → null).
 * - `id` on a non-user message → the nearest preceding user message.
 * - unknown `id` or empty content → null (caller must do nothing).
 *
 * The caller must truncate to the RETURNED user message's id (never to the
 * raw `id`): truncating to an assistant `id` keeps the user prompt above,
 * and the follow-up send() would then append a second identical user bubble.
 */
export function resolveRestartUser(
  messages: ChatMessage[],
  id: string,
): ChatMessage | null {
  const msg = messages.find((m) => m.id === id)
  if (!msg) return null
  if (msg.role === 'user') return msg.content.trim() ? msg : null
  const idx = messages.findIndex((m) => m.id === id)
  const prev = [...messages.slice(0, idx)]
    .reverse()
    .find((m) => m.role === 'user')
  if (!prev || !prev.content.trim()) return null
  return prev
}

export interface RetryTarget {
  userMsgId: string
  /** Assistant bubble to continue streaming into on resume. Undefined on restart (fresh bubble). */
  continueAssistantId?: string
  content: string
  attachments: string[]
  images: Array<{ path: string; name: string; dataUrl?: string }>
}

export type RetryPlan =
  | { action: 'restart'; target: RetryTarget }
  | { action: 'resume'; target: RetryTarget }

/** True for resume (banner/watchdog): keep transcript, continue same work. */
export function isResumePlan(plan: RetryPlan | null): boolean {
  return plan?.action === 'resume'
}

/** True for restart (message icon): truncate transcript, start fresh. */
export function isRestartPlan(plan: RetryPlan | null): boolean {
  return plan?.action === 'restart'
}

/** Resume preserves completed work (toolActivity, plan, preservedToolSummary); restart drops it. */
export function shouldPreserveWork(action: RetryPlan['action']): boolean {
  return action === 'resume'
}

function findFailedAssistant(messages: ChatMessage[], userMsgId: string): ChatMessage | undefined {
  const idx = messages.findIndex((m) => m.id === userMsgId)
  if (idx === -1) return undefined
  return messages.slice(idx + 1).find(
    (m) =>
      m.role === 'assistant' &&
      (m.retry ||
        m.error ||
        (typeof m.content === 'string' && m.content.includes('[Interrupted before finishing'))),
  )
}

/**
 * Decide what a retry click does. The two retry paths are deliberately
 * different and MUST stay distinct (mixing them causes redo loops):
 *
 *  - message retry button (`source: 'message'`) → RESTART: a deliberate "redo".
 *    Everything at/below the clicked user message is deleted (truncateTo) and a
 *    fresh reply is generated. Backend checkpoint is cleared via `restart: true`
 *    so old tool work is NOT replayed. `plan`, `toolActivity` and
 *    `preservedToolSummary` are dropped.
 *  - banner error retry (`source: 'banner'`) → RESUME: a recovery. The
 *    interrupted assistant message (partial content + completed tool calls +
 *    plan + preservedToolSummary) is KEPT and the turn continues from the
 *    backend checkpoint, so completed work is not redone. Reuses `userMsgId`
 *    (no duplicate user bubble) and continues `continueAssistantId` (no
 *    duplicate assistant bubble).
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
  if (source === 'banner') {
    const failed = findFailedAssistant(messages, userMsgId)
    const target: RetryTarget = {
      userMsgId,
      continueAssistantId: failed?.id,
      content: msg.content,
      attachments: msg.attachments ?? [],
      images: msg.images ?? [],
    }
    return { action: 'resume', target }
  }
  const target: RetryTarget = {
    userMsgId,
    content: msg.content,
    attachments: msg.attachments ?? [],
    images: msg.images ?? [],
  }
  return { action: 'restart', target }
}

/**
 * Reset streamed text/segments before the next attempt.
 *
 * - resume (banner/watchdog): keep tool segments (work was done; the next
 *   attempt continues from the same transcript) but drop text segments (the
 *   next attempt re-streams its own answer). Caller MUST also keep the
 *   message-level `toolActivity`, `plan` and `preservedToolSummary` fields —
 *   they are NOT part of `segments` and are preserved by reusing the same
 *   assistant bubble (`continueAssistantId`).
 * - restart (message icon): new attempt re-issues tool calls and re-streams
 *   text, so text AND tool segments are stale. User/compact segments are
 *   history anchors (steered messages, compaction checkpoints) and are kept.
 */
export type ResetMode = 'resume' | 'restart'

export function resetStreamForRetry(
  content: string,
  segments?: MessageSegment[],
  mode: ResetMode = 'resume',
): { content: string; segments: MessageSegment[] } {
  if (mode === 'restart') {
    // Restart: the model re-issues tool calls and re-streams text, so text and
    // tool segments are stale. BUT user/compact segments are history anchors
    // (steered messages, compaction checkpoints) — not re-issuable. Dropping
    // them here hid the steered bubble (steerInterleaved=true) with no inline
    // copy left: the sudden steer vanish.
    const kept = (segments ?? []).filter((s) => s.kind === 'user' || s.kind === 'compact')
    return { content: '', segments: kept }
  }
  // Resume: keep tool segments (work was done; the next attempt continues
  // from the same transcript) but drop text segments (the next attempt will
  // re-stream its own answer and we don't want a duplicate).
  const kept = (segments ?? []).filter((s) => s.kind !== 'text')
  return { content: '', segments: kept }
}

/**
 * Whether a backend `retry` event must keep already-streamed text.
 *
 * - reconnecting/fallback → keep text (turn still alive, banner is informational).
 * - otherwise → user-triggered restart, wipe text + tool segments.
 */
export function isKeepTextRetry(reconnecting: boolean | undefined, fallback: boolean | undefined): boolean {
  return reconnecting === true || fallback === true
}

/**
 * Epoch-guarded scheduler for automatic retries (watchdog stall resends,
 * banner resends, post-turn drains).
 *
 * A scheduled retry captures the scheduler's epoch when armed and only fires
 * while the epoch is unchanged: an explicit Stop (or a fresh turn) bumps the
 * epoch first, so a timer callback that fires after Stop is dropped instead
 * of restarting the turn and bringing the retry banner back.
 *
 * Timer functions are injectable so unit tests can use fake timers.
 */
export class AutoRetryScheduler {
  private epoch = 0
  private stopped = false
  private timer: unknown = null
  constructor(
    private setTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
    private clearTimerFn: (id: unknown) => void = (id) => clearTimeout(id as number),
  ) {}
  /** True after an explicit Stop, until the next turn begins. */
  get isStopped(): boolean {
    return this.stopped
  }
  /** Arm `cb` after `delayMs`; dropped when Stop/a new turn bumps the epoch. */
  schedule(delayMs: number, cb: () => void): void {
    this.clearPending()
    const epoch = this.epoch
    this.timer = this.setTimer(() => {
      this.timer = null
      if (epoch !== this.epoch) return
      cb()
    }, delayMs)
  }
  /** A new turn started: invalidate stale schedules, allow retries again. */
  beginTurn(): void {
    this.stopped = false
    this.epoch += 1
    this.clearPending()
  }
  /** Explicit Stop: drop pending retries and invalidate armed callbacks. */
  stop(): void {
    this.stopped = true
    this.epoch += 1
    this.clearPending()
  }
  private clearPending(): void {
    if (this.timer !== null) {
      this.clearTimerFn(this.timer)
      this.timer = null
    }
  }
}

/**
 * Whether a late `error`/`retry` stream event arriving after an explicit Stop
 * must be ignored instead of re-arming the retry banner.
 */
export function shouldIgnoreLateRetryEvent(stopped: boolean): boolean {
  return stopped
}
