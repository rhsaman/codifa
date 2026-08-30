import type { Chat, TokenUsage } from '../types'
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

/** Token-estimate variant of {@link estimateContextChars}: divides the weighted
 *  character count by the Latin chars-per-token ratio so callers can compare
 *  against provider token budgets. Used by the context-meter tests and as the
 *  source for {@link computeContextUsed}'s post-compact / fresh-chat fallback. */
export function estimateContextTokens(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
): number {
  return Math.round(estimateContextChars(chat, systemPrompt, contextWindow) / CHARS_PER_TOKEN)
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

/**
 * Context-meter percentage, aligned 100% with opencode.
 *
 * opencode's TUI shows `tokens.total / limit.context` — i.e. the RAW window,
 * NOT `usable` (window minus the reserved compaction buffer). The meter is a
 * raw display of how full the model's context window is, independent of where
 * auto-compaction fires. So we divide by the raw `windowSize` here.
 *
 * `reserved` is kept in the signature for call-site compatibility (the UI still
 * passes `compactHeadroom`), but it is intentionally NOT used in the
 * calculation — opencode does not subtract it from the meter's denominator.
 *
 * No 100% cap: opencode's overflow check is a raw `count >= usable`, which can
 * exceed the window, so an overflow stays visible. Report the raw %.
 */
export function contextPercent(
  used: number,
  windowSize: number | null,
  reserved = 0,
): number | null {
  if (!windowSize || windowSize <= 0) return null
  return Math.round((used / windowSize) * 100)
}

/**
 * Decide whether the context meter should show its warning (yellow) state.
 *
 * Warn when the used context reaches the usable window (`window - reserved`),
 * i.e. the SAME point where backend auto-compaction fires — NOT at a fixed
 * percentage of the raw window. `usable` may be null when the window is unknown.
 */
export function contextWarn(used: number, usable: number | null): boolean {
  if (usable == null || usable <= 0) return false
  return used >= usable
}

/**
 * Resolve the context-meter token count shown in the sidebar.
 *
 * The meter must show the TRUE context sent to the model this turn — the full
 * non-compacted history (system prompt + every user/assistant exchange) — NOT
 * just the last message's provider-reported `usage`.
 *
 * Some providers are stateful or only surface billable (non-cached) tokens, so
 * their per-turn `usage` can be far smaller than the real context (the meter
 * would then "only show the latest message" and keep shrinking). We therefore
 * estimate the real context directly from the history we actually send
 * (`estimateContextChars`) — provider-independent and always correct — and use
 * that as the baseline. When the provider reports a usage for the latest
 * assistant turn that is at least as large as our estimate (i.e. it reports the
 * full context, cache included), we trust it for precision; otherwise the
 * estimate wins. This is the opencode-faithful behaviour: opencode's TUI shows
 * the last message's `tokens.total`, which already equals the whole context
 * because the full history is re-sent every turn — and when a provider
 * under-reports, our estimate restores that true context instead of collapsing
 * to a single message.
 *
 * `chat.usage` (per-model SESSION total, only-ever-growing) is intentionally
 * NOT used here — it is a lifetime counter, not the current context window.
 */
export function computeContextUsed(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
): number {
  const msgs = chat?.messages ?? []
  const active = msgs.filter((m) => !m.compacted)

  // `estimated` is the local history estimate (system prompt + every non-compacted
  // exchange). It is only the fallback used before the first usage event arrives
  // (or a fixture that omits `total_tokens`); in normal operation the meter uses
  // the backend's `total_tokens`, described below.
  const estimated = Math.round(
    estimateContextChars(chat, systemPrompt, contextWindow) / CHARS_PER_TOKEN,
  )

  // The title-bar meter reflects the CURRENT turn's backend-reported token
  // breakdown, summed exactly like opencode's session `Tokens()`:
  //
  //   used = input + output + reasoning + cache.read + cache.write
  //
  // opencode's TUI shows `tokens.total / limit.context`, and its `total` is the
  // hand-summed breakdown above (NOT the provider's native `total_tokens`, which
  // double-counts cache under AI-SDK-v6-style input accounting). We mirror that
  // here so the meter is faithful to opencode: reasoning/thinking tokens are
  // billable output that occupy the window, and cache read/write are part of the
  // real footprint. The meter tracks the live conversation and may only drop
  // when the context genuinely shrinks (e.g. after auto-compaction).
  //
  // Before the first usage event arrives (a brand-new chat) there is no
  // breakdown yet, so we fall back to the local history estimate.
  let last: TokenUsage | null = null
  for (const m of active) {
    const u = m.usage
    if (u && m.role === "assistant") last = u
  }
  // Only trust the provider breakdown when it actually reports the input
  // context (inputTokens > 0). Some providers only surface billable
  // (non-cached) output tokens, or omit input_tokens entirely — in those
  // cases the breakdown under-reports the real context, so the local
  // history estimate wins (it reflects the true window size).
  if (last && (last.inputTokens ?? 0) > 0) {
    // Prefer the provider's `totalTokens` (the backend's `total_tokens`): it
    // already encodes whether cache is additive (Anthropic: total = input +
    // output + reasoning + cache) or a SUBSET of input (OpenAI / OpenRouter /
    // Google: total = input + output, cache already folded into input). Using
    // it directly avoids double-counting cache for subset providers. We only
    // fall back to the opencode hand-sum (input + output + reasoning +
    // cache.read + cache.write) when the provider omits total_tokens entirely.
    const providerTotal = last.totalTokens ?? 0
    if (providerTotal > 0) return providerTotal
    const used =
      (last.inputTokens ?? 0) +
      (last.outputTokens ?? 0) +
      (last.reasoningTokens ?? 0) +
      (last.cacheReadTokens ?? 0) +
      (last.cacheWriteTokens ?? 0)
    if (used > 0) return used
  }
  // No usage breakdown on the latest main turn yet (only happens before the
  // first usage event, or a fixture that omits it — the real app always sets
  // it): fall back to the local history estimate, which reflects the true
  // context window size rather than just the last message's raw token count.
  return estimated
}

/** Resolve a model's context window from the provider's contextMap, trying
 *  both the bare id (what the picker stores) and the provider-prefixed id
 *  (NVIDIA's /models returns "nvidia/<model>" while the picker stores the
 *  bare form, so the map is keyed by the prefixed id). The window comes solely
 *  from the model (reported by the provider's /models endpoint) — there is no
 *  manual override. */
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
  return null
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

export type ModelPricing = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Look up a model's pricing from a provider `pricingMap`, tolerating the small
 * id mismatches that occur between the id the backend records usage under and
 * the id a provider's `/models` endpoint advertises pricing under
 * (`models/` prefix, provider prefix, bare last path segment, etc.).
 *
 * Returns `null` when no price is known — callers should render "—" rather than
 * guess, so a missing live price is visible instead of silently mispriced.
 */
export function priceForModel(
  pricingMap: Record<string, ModelPricing> | undefined,
  model: string,
): ModelPricing | null {
  if (!pricingMap || !model) return null
  const norm = (m: string) => (m || '').replace(/^models\//, '')
  const bare = (m: string) => norm(m).split('/').pop() || m
  const candidates = [model, norm(model), bare(model)]
  for (const c of candidates) {
    const hit = pricingMap[c]
    if (hit) return hit
  }
  const targetBare = bare(model)
  for (const [k, v] of Object.entries(pricingMap)) {
    if (norm(k) === norm(model) || bare(k) === targetBare) return v
  }
  return null
}

/**
 * Billed cost (USD) for one model's accumulated usage.
 *
 * `input` already INCLUDES the cached portion for subset-convention providers
 * (OpenAI / OpenRouter / Google: `cache_read` is a subset of `input_tokens`),
 * so the cached tokens are split out and billed at their own (usually cheaper)
 * rate. The provider never reports a usage event with an `additive` cache flag
 * to the frontend, and every provider the app talks to uses the subset
 * convention, so this is the only correct formula here.
 */
export function computeUsageCost(
  price: ModelPricing | null,
  u: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number | null {
  if (!price) return null
  const cacheRead = u.cacheRead ?? 0
  const cacheWrite = u.cacheWrite ?? 0
  return (
    ((u.input - cacheRead - cacheWrite) / 1_000_000) * price.input +
    (cacheRead / 1_000_000) * (price.cacheRead ?? price.input) +
    (cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input) +
    (u.output / 1_000_000) * price.output
  )
}

/**
 * Same billed total as `computeUsageCost`, but split into the "fresh" portion
 * (non-cached input + all output, billed at the full input/output rate) and
 * the "cached" portion (cache-read/cache-write, billed at the provider's
 * cheaper cache rate when advertised). Lets the UI show WHY the total is what
 * it is, instead of just the combined number.
 */
export function computeUsageCostBreakdown(
  price: ModelPricing | null,
  u: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): { total: number; fresh: number; cached: number } | null {
  if (!price) return null
  const cacheRead = u.cacheRead ?? 0
  const cacheWrite = u.cacheWrite ?? 0
  const fresh =
    (Math.max(0, u.input - cacheRead - cacheWrite) / 1_000_000) * price.input +
    (u.output / 1_000_000) * price.output
  const cached =
    (cacheRead / 1_000_000) * (price.cacheRead ?? price.input) +
    (cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input)
  return { total: fresh + cached, fresh, cached }
}
