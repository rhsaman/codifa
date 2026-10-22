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
  // Timer indirection is assigned explicitly instead of using TypeScript
  // parameter properties: those EMIT runtime code, which Node's strip-only
  // TypeScript mode refuses to execute. `tests/retry.test.ts` loads this module
  // with plain `node`, so the whole file must stay erasable-only syntax.
  private setTimer: (cb: () => void, ms: number) => unknown
  private clearTimerFn: (id: unknown) => void
  constructor(
    setTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
    clearTimerFn: (id: unknown) => void = (id) => clearTimeout(id as number),
  ) {
    this.setTimer = setTimer
    this.clearTimerFn = clearTimerFn
  }
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

/**
 * Whether a LIVE sub-agent retry banner is retired by the stream event that
 * just arrived.
 *
 * A sub-agent retries INSIDE the parent turn, so the parent keeps streaming its
 * own tool events the whole time explore works — which is why those events must
 * NOT wipe the banner (`clearTransientRetry` in Chat.tsx skips `retry.agent`).
 * The one event that proves the retry really is over is the OWNING tool's own
 * RESULT: the parent only ever receives one per call, and it is emitted exactly
 * once — after the ladder finally produced a report, or gave up for good.
 *
 * Without this the banner never retired on SUCCESS. The ladder emits no event
 * when an attempt works (it just returns the report), so a recovered sub-agent
 * left "Provider rate limit (2/10) — retrying…" frozen on screen for the rest
 * of the turn while the answer streamed underneath it.
 *
 * Terminal banners (gaveUp / watchdog / model fallback) deliberately survive:
 * they carry the Retry button and the "which model to fix" hint.
 *
 * Matching on the tool NAME rather than a call id is deliberate: a fan-out
 * wraps the call in a `branch`, and a batch can retry several explore calls
 * whose results arrive in any order — every one of them means "that sub-agent
 * is done retrying".
 */
export function retryRetiredByEvent(
  retry:
    | {
        agent?: string
        tool?: string
        gaveUp?: boolean
        watchdog?: boolean
        fallback?: boolean
      }
    | null
    | undefined,
  event: { kind?: string; tool?: string; sub?: boolean },
): boolean {
  if (!retry || !retry.agent) return false
  if (retry.gaveUp === true || retry.watchdog === true) return false
  if (retry.fallback === true) return false
  if (event.kind !== 'tool_result') return false
  // Nested events belong to the sub-agent's OWN tools (read/grep/glob), not to
  // the call being retried — only the parent-level result retires the banner.
  if (event.sub === true) return false
  const owner = (retry.tool ?? '').trim()
  if (!owner) return false
  return (event.tool ?? '').trim() === owner
}

/**
 * Pick the message whose retry banner must be rendered (newest first).
 *
 * Lives here rather than inline in Chat.tsx so the dismissal rule is testable.
 *
 * - `retiring`: the ~100 ms auto-fade skip-list. A banner that is fading out
 *   must leave the scan immediately, otherwise it wins again and re-mounts in
 *   a loop.
 * - `dismissed`: messages whose banner the user closed with the ✕ button during
 *   the CURRENT turn. A live sub-agent ladder re-sets `message.retry` on every
 *   attempt, so without this the banner popped straight back — which is why the
 *   ✕ used to be implemented as "cancel the retry" (and wrongly killed the
 *   whole stream). The dismissal holds until the next turn starts.
 */
export function findRetryBannerMessage<
  T extends { id: string; retry?: object | null },
>(
  messages: T[],
  retiring: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): T | null {
  return (
    [...messages]
      .reverse()
      .find((m) => m.retry && !retiring.has(m.id) && !dismissed.has(m.id)) ??
    null
  )
}
