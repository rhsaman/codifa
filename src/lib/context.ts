import type { Chat } from '../types'
import { PERSIAN_RANGE } from './bidi'

export const CHARS_PER_TOKEN = 4

// Tokenizers consume far more tokens per character for certain scripts:
// - Latin/digits/whitespace:            ~4 chars per token  -> weight 1
// - Persian/Arabic (incl. ZWNJ/ZWJ):    ~2 chars per token  -> weight 2
// - CJK / full-width ideographs:        ~1 char per token   -> weight 4
const PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`)
const CJK_CHAR =
  /[\u2E80-\u2EFF\u3000-\u30FF\u31C0-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF01-\uFF60]/

/** Count characters weighted by script, so Persian/CJK text is not
 *  under-estimated by the flat "4 chars per token" rule. */
function weightedCharCount(text: string): number {
  let w = 0
  for (const ch of text) {
    if (PERSIAN_CHAR.test(ch)) w += 2
    else if (CJK_CHAR.test(ch)) w += 4
    else w += 1
  }
  return w
}

/**
 * Split the talk-only (user/assistant/system) messages into the settled tail
 * that would become `history` on the NEXT turn, and the currently-streaming
 * message (if any) which is the turn still in flight.
 *
 * opencode sends the FULL history every turn and compacts on overflow — it
 * never drops messages by count or by a per-mode char budget. We mirror that
 * exactly: keep every non-streaming message (system summaries already survive
 * at the head), and let the backend compact on overflow. This fixes two bugs:
 * switching mode no longer shrinks the context (no MODE_HISTORY_CAPS), and
 * messages no longer disappear every turn (no maxHistory tail slice).
 */
function budgetedSettledHistory(
  talk: Chat['messages'],
): { settled: Chat['messages']; live: Chat['messages'][number] | null } {
  const live =
    talk.length > 0 && talk[talk.length - 1].streaming ? talk[talk.length - 1] : null
  const rest = live ? talk.slice(0, -1) : talk
  // opencode sends the whole settled history; system summaries (compacted
  // context) stay at the head so the estimate matches what is really sent.
  const settled = rest
  return { settled, live }
}

/**
 * Estimate the characters that would be sent to the model this turn:
 * system prompt + builtin/workspace note + the budget-trimmed settled
 * history (mirrors what `sliceToBudget` actually sends as `history`) + the
 * in-flight turn's own content and tool payload (name, args, result
 * summary, diff) — only the LIVE turn's tool activity counts, since past
 * turns' tool calls are never resent once a turn has finished.
 */
export function estimateContextChars(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
): number {
  const msgs = chat?.messages ?? []
  let chars = 0
  chars += systemPrompt.length
  // Builtin system prompt + auto-scout/workspace note. The real prompt is
  // several thousand chars (mode prompt + tool guidance + workspace note), so
  // a flat 2200-char floor under-estimates a fresh chat to ~0% on large
  // windows — which is exactly what the meter showed during thinking (before
  // the first real usage event arrives). Use a realistic floor so the estimate
  // lands in the same ballpark as the post-reply usage.
  chars += 16000
  const active = msgs.filter((m) => !m.compacted)
  const talk = active.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system',
  )
  const { settled, live } = budgetedSettledHistory(talk)
  for (const m of settled) {
    chars += m.content.length
    // Reasoning text is round-tripped to the model as a ThinkingPart on every
    // resend (see _to_model_messages), so it occupies context — count it too.
    if (m.thinking) chars += m.thinking.length
  }
  if (live) {
    chars += live.content.length
    if (live.thinking) chars += live.thinking.length
    for (const act of live.toolActivity ?? []) {
      chars += act.tool.length
      if (act.args) chars += JSON.stringify(act.args).length
      if (act.summary) chars += act.summary.length
      if (act.diff) chars += act.diff.length
    }
  }
  return chars
}

export function estimateContextTokens(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
): number {
  const msgs = chat?.messages ?? []
  let weight = 0
  weight += weightedCharCount(systemPrompt)
  // Same realistic floor as estimateContextChars (see note there): the builtin
  // prompt + workspace note is thousands of chars, not 2200.
  weight += 16000
  const active = msgs.filter((m) => !m.compacted)
  const talk = active.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system',
  )
  const { settled, live } = budgetedSettledHistory(talk)
  for (const m of settled) {
    weight += weightedCharCount(m.content)
    if (m.thinking) weight += weightedCharCount(m.thinking)
  }
  if (live) {
    weight += weightedCharCount(live.content)
    if (live.thinking) weight += weightedCharCount(live.thinking)
    for (const act of live.toolActivity ?? []) {
      weight += weightedCharCount(act.tool)
      if (act.args) weight += weightedCharCount(JSON.stringify(act.args))
      if (act.summary) weight += weightedCharCount(act.summary)
      if (act.diff) weight += weightedCharCount(act.diff)
    }
  }
  return Math.floor(weight / CHARS_PER_TOKEN)
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Compact thousands-separated form for big cumulative chips: 2365.1 -> "2,365K". */
export function formatTokensK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString("en-US")}K`
  return Math.round(n).toLocaleString("en-US")
}

export function contextPercent(used: number, windowSize: number | null): number | null {
  if (!windowSize || windowSize <= 0) return null
  // No 100% cap — opencode's overflow check is a raw `count >= usable`, which
  // can exceed the window, so an overflow stays visible. Report the raw %.
  return Math.round((used / windowSize) * 100)
}

/**
 * Resolve the context-meter token count shown in the sidebar.
 *
 * Mirrors opencode's server-side accounting in
 * `packages/opencode/src/session/overflow.ts` (`isOverflow`): the context size
 * is the LATEST assistant turn's token total —
 *   total || input + output + cache.read + cache.write
 * i.e. output AND cache are INCLUDED, and ONLY the most recent request is
 * used. Each new model call re-sends the entire history, so the latest turn's
 * total already reflects the full current context (and is exactly what opencode
 * compares against `usable()` to decide compaction). opencode's `dev` TUI has
 * no separate percentage meter — this is the underlying accounting it relies
 * on.
 *
 * We take the LAST assistant message that carries a `usage` event (the most
 * recent completed request). `chat.usage` is a per-model SESSION total that
 * only ever grows, so it must NOT be used here.
 *
 * Before the first real usage event arrives (brand-new chat / right after a
 * compact) there is no turn total, so we fall back to the full-conversation
 * `estimate`. opencode has no estimate, but the sidebar meter still needs a
 * value in that window.
 */
export function computeContextUsed(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
): number {
  const msgs = chat?.messages ?? []
  const active = msgs.filter((m) => !m.compacted)

  // Latest assistant turn's token total — matches opencode's `tokens.total`.
  let realTotal = 0
  for (let i = active.length - 1; i >= 0; i--) {
    const m = active[i]
    const u = m.usage
    if (m.role !== 'assistant' || !u) continue
    const has = u.totalTokens != null || u.inputTokens != null || u.outputTokens != null
    if (!has) continue
    realTotal =
      (u.totalTokens ?? 0) ||
      (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
    break
  }

  // No real usage yet → fall back to the estimate (see note above).
  if (realTotal <= 0) {
    realTotal = estimateContextTokens(chat, systemPrompt, contextWindow)
  }
  return realTotal
}

/** Resolve a model's context window from the provider's contextMap, trying
 *  both the bare id (what the picker stores) and the provider-prefixed id
 *  (NVIDIA's /models returns "nvidia/<model>" while the picker stores the
 *  bare form, so the map is keyed by the prefixed id). Falls back to the
 *  provider-wide contextWindow. */
export function modelContextWindow(
  provider: {
    id?: string
    contextMap?: Record<string, number>
    contextWindow?: number
  } | null | undefined,
  model: string,
): number | null {
  if (!provider) return null
  const map = provider.contextMap ?? {}
  const direct = map[model]
  if (direct && direct > 0) return direct
  const prefixed = map[`${provider.id ?? ''}/${model}`]
  if (prefixed && prefixed > 0) return prefixed
  return provider.contextWindow && provider.contextWindow > 0
    ? provider.contextWindow
    : null
}

/** Resolve a model's reasoning-support flag from the provider's reasoningMap,
 *  trying both the bare and provider-prefixed id forms (see modelContextWindow).
 *  Returns null when the map doesn't know the model — callers then fall back
 *  to the name-based heuristic. */
export function modelReasoning(
  provider: { id?: string; reasoningMap?: Record<string, boolean> } | null | undefined,
  model: string,
): boolean | null {
  if (!provider) return null
  const map = provider.reasoningMap ?? {}
  const direct = map[model]
  if (typeof direct === 'boolean') return direct
  const prefixed = map[`${provider.id ?? ''}/${model}`]
  return typeof prefixed === 'boolean' ? prefixed : null
}

/** Format a USD amount for the context-meter cost chip. Tiny amounts (most
 *  single turns) show 4 decimals so they don't all collapse to "$0.00". */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/**
 * Scale the compaction headroom (reserved tokens) to the model's context window.
 *
 * opencode clamps its `COMPACTION_BUFFER` to `maxOutputTokens`, so the reserved
 * buffer never dominates a small window. We mirror that: keep the UI's default
 * headroom (usually 20k) for large windows, but clamp it down for small windows
 * so auto-compaction never fires near the start of a conversation.
 *
 * - `cw <= 0` (unknown window): pass the headroom through unchanged.
 * - otherwise: `min(headroom, max(2000, 10% of cw))`.
 */
export function scaleReserved(cw: number, headroom: number): number {
  if (cw <= 0) return headroom
  const cap = Math.max(2000, Math.round(cw * 0.1))
  return Math.min(headroom, cap)
}
