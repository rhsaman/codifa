import type { Chat, TokenUsage } from '../types'
import { PERSIAN_RANGE } from './bidi'
import { applyHistoryLimit } from './historyWindow'

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
  historyLimit = 0,
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
  const { settled, live } = budgetedSettledHistory(
    applyHistoryLimit(talk, historyLimit),
  )
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
  historyLimit = 0,
): number {
  return Math.round(
    estimateContextChars(chat, systemPrompt, contextWindow, historyLimit) /
      CHARS_PER_TOKEN,
  )
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Compact thousands-separated form: 824100 -> "824K". Megabyte-scale windows
 *  keep up to two decimals (1048576 -> "1.05M", not "1.0M") so the denominator
 *  stays arithmetically consistent with the usage percentage shown next to it
 *  in the popover header. */
export function formatTokensK(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m.toFixed(2).replace(/\.?0+$/, '')}M`
  }
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
 * The meter mirrors opencode's TUI: it shows the LATEST assistant turn's
 * provider-reported token total (`total_tokens`), which already equals the
 * whole context because the full history is re-sent every turn. When the
 * provider has not reported a usage event yet (fresh chat, mid-stream before
 * the first usage arrives, or a usage without input_tokens), we fall back to
 * the local history estimate (`estimateContextTokens`) so the meter never
 * collapses to 0.
 *
 * `chat.usage` (per-model SESSION total, only-ever-growing) is intentionally
 * NOT used here — it is a lifetime counter, not the current context window.
 */
export function computeContextUsed(
  chat: Chat | null,
  systemPrompt: string,
  contextWindow?: number,
  historyLimit = 0,
): number {
  const msgs = chat?.messages ?? []
  const active = msgs.filter((m) => !m.compacted)

  // Find the latest assistant usage event.
  let last: TokenUsage | null = null
  for (const m of active) {
    const u = m.usage
    if (u && m.role === "assistant") last = u
  }

  // The provider's `totalTokens` (the backend's `total_tokens`) is the real
  // measured context: it already encodes whether cache is additive (Anthropic)
  // or a subset of input (OpenAI / OpenRouter / Google). Once it has arrived
  // and is positive it WINS — even when smaller than the local estimate, since
  // the estimate's builtin-prompt floor over-estimates tiny turns. It can never
  // be smaller than the input itself, though (total = input + output, with the
  // cache either folded into input or added on top): a total below inputTokens
  // means the router dropped the cached portion from its total, so clamp up to
  // the real input instead of under-reporting the meter.
  if (last && (last.inputTokens ?? 0) > 0) {
    const providerTotal = Math.max(last.totalTokens ?? 0, last.inputTokens ?? 0)
    if (providerTotal > 0) return providerTotal
  }

  // No usage yet: the local estimate (system prompt + every non-compacted
  // exchange) approximates the context that will be sent this turn.
  return estimateContextTokens(chat, systemPrompt, contextWindow, historyLimit)
}

/** Resolve a model's context window from the provider's maps, trying
 *  both the bare id (what the picker stores) and the provider-prefixed id
 *  (NVIDIA's /models returns "nvidia/<model>" while the picker stores the
 *  bare form, so the map is keyed by the prefixed id). Resolution order:
 *  ۱) مقدار دستی کاربر (manualContextMap — فقط مدل‌های کاستوم) ۲) مقدار
 *  زنده‌ی contextMap (گزارش‌شده از /models پروایدر). */
export function modelContextWindow(
  provider: {
    id?: string
    contextMap?: Record<string, number>
    manualContextMap?: Record<string, number>
    contextWindow?: number
  } | null | undefined,
  model: string,
): number | null {
  if (!provider) return null
  const manual = provider.manualContextMap ?? {}
  const directManual = manual[model]
  if (directManual && directManual > 0) return directManual
  const prefixedManual = manual[`${provider.id ?? ''}/${model}`]
  if (prefixedManual && prefixedManual > 0) return prefixedManual
  const map = provider.contextMap ?? {}
  const direct = map[model]
  if (direct && direct > 0) return direct
  const prefixed = map[`${provider.id ?? ''}/${model}`]
  if (prefixed && prefixed > 0) return prefixed
  return null
}

/** Resolve a model's reasoning-support flag, trying both the bare and
 *  provider-prefixed id forms (see modelContextWindow). Resolution order:
 *  ۱) مقدار دستی کاربر (manualReasoningMap — تاگل دستی در Settings)
 *  ۲) مقدار زنده‌ی reasoningMap (گزارش‌شده از /models یا models.dev).
 *  Returns null when neither knows the model — callers then fall back
 *  to the name-based heuristic. */
export function modelReasoning(
  provider: {
    id?: string
    reasoningMap?: Record<string, boolean>
    manualReasoningMap?: Record<string, boolean>
  } | null | undefined,
  model: string,
): boolean | null {
  if (!provider) return null
  const manual = provider.manualReasoningMap ?? {}
  const directManual = manual[model]
  if (typeof directManual === 'boolean') return directManual
  const prefixedManual = manual[`${provider.id ?? ''}/${model}`]
  if (typeof prefixedManual === 'boolean') return prefixedManual
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
    (Math.max(0, u.input - cacheRead - cacheWrite) / 1_000_000) * price.input +
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

export type ContextBreakdownKey =
  | 'messages'
  | 'systemTools'
  | 'systemPrompt'
  | 'skills'
  | 'mcpTools'
  | 'meta'

export interface ContextBreakdownRow {
  key: ContextBreakdownKey
  label: string
  tokens: number
  percent: number
}

export interface ContextBreakdownResult {
  total: number
  window: number | null
  percent: number | null
  rows: ContextBreakdownRow[]
  cacheHitRate: number | null
}

export const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownKey, string> = {
  messages: 'Messages',
  systemTools: 'System tools',
  systemPrompt: 'System prompt',
  skills: 'Skills',
  mcpTools: 'MCP tools',
  meta: 'Meta context',
}

/** Distinct segment/dot color per breakdown row (used by the popover bar). */
export const CONTEXT_BREAKDOWN_COLORS: Record<ContextBreakdownKey, string> = {
  messages: '#4f8cff',
  systemTools: '#b57bff',
  systemPrompt: '#ffb224',
  skills: '#34d399',
  mcpTools: '#f472b6',
  meta: '#9aa4b2',
}

const CONTEXT_BREAKDOWN_ORDER: ContextBreakdownKey[] = [
  'messages',
  'systemTools',
  'systemPrompt',
  'skills',
  'mcpTools',
  'meta',
]

/** Weighted average prompt-cache hit rate (0-100) across per-turn usages.
 *  Only cache READS are hits — cache WRITES are misses that fill the cache, so
 *  a cold turn (all writes, no reads) correctly rates 0%. Each turn contributes
 *  reads / denominator where the denominator is the full input footprint:
 *  subset-convention providers fold cache into input, so the denominator is
 *  input; additive providers keep cache outside input, so the denominator is
 *  input + reads + writes. Distinguish by whether input covers the cache. */
export function averageCacheHitRate(usages: TokenUsage[]): number | null {
  let hit = 0
  let denom = 0
  for (const u of usages) {
    const read = u.cacheReadTokens ?? 0
    const write = u.cacheWriteTokens ?? 0
    const cache = read + write
    const input = u.inputTokens ?? 0
    if (input <= 0 && cache <= 0) continue
    const base = input >= cache ? Math.max(0, input) : input + cache
    if (base <= 0) continue
    hit += read
    denom += base
  }
  if (denom <= 0) return null
  return Math.min(100, Math.max(0, (hit / denom) * 100))
}

/** Width (%) of one breakdown-bar segment in the popover. Segments are sized
 *  against the WINDOW so the filled portion of the bar equals the usage
 *  percentage shown in the header, with each row's composition visible inside
 *  that fill — sizing them against the used total instead would make the bar
 *  read as 100% full at every usage level. Without a known window the bar
 *  degrades to pure composition (segments sum to 100%). */
export function contextBarSegmentPercent(
  rowTokens: number,
  total: number,
  window: number | null,
): number {
  if (window != null && window > 0) return Math.max(0, (rowTokens / window) * 100)
  if (total > 0) return Math.max(0, (rowTokens / total) * 100)
  return 0
}

/** Split an estimated total into labeled rows with percentages summing to 100.
 *  Pure and testable: callers estimate per-part tokens, this normalizes. */
export function computeContextBreakdown(
  total: number,
  parts: Record<ContextBreakdownKey, number>,
  window: number | null,
  cacheHitRate: number | null,
): ContextBreakdownResult {
  const safeTotal = Math.max(0, Math.round(total))
  const rows: ContextBreakdownRow[] = CONTEXT_BREAKDOWN_ORDER.map((key) => {
    const tokens = Math.max(0, Math.round(parts[key] ?? 0))
    return {
      key,
      label: CONTEXT_BREAKDOWN_LABELS[key],
      tokens,
      percent: safeTotal > 0 ? (tokens / safeTotal) * 100 : 0,
    }
  })
  // Sort heaviest-first so the popup reads like a ranked breakdown.
  rows.sort((a, b) => b.tokens - a.tokens)
  return {
    total: safeTotal,
    window,
    percent: contextPercent(safeTotal, window),
    rows,
    cacheHitRate,
  }
}

export interface BreakdownEstimateOptions {
  /** Real system-prompt size (chars) reported by the backend's ctx_parts
   *  event — wins over the base prompt string used for the meter estimate. */
  systemPromptChars?: number
  skillsChars?: number
  mcpChars?: number
  systemToolsChars?: number
  metaChars?: number
  /** History turn limit (Settings → General): keep the estimate in step with
   *  the trimmed wire history the send path builds. 0 = full history. */
  historyLimit?: number
}

/** Estimate per-part token counts for the breakdown popup.
 *  Messages cover settled + live TALK content (compacted summaries excluded);
 *  meta is those compacted summaries themselves (they stay in the transcript
 *  but are no longer resent as messages); skills/MCP come from the real
 *  configs the caller passes in. No fixed floors — the uncovered remainder is
 *  attributed to messages by buildContextBreakdown. */
export function estimateBreakdownParts(
  chat: Chat | null,
  systemPrompt: string,
  opts: BreakdownEstimateOptions = {},
): Record<ContextBreakdownKey, number> {
  const msgs = chat?.messages ?? []
  let msgChars = 0
  // Compacted summaries are meta context, not messages: measure them from the
  // real stored content instead of a fixed floor.
  let metaChars = 0
  for (const m of msgs) {
    if (!m.compacted) continue
    metaChars += m.content.length
    if (m.thinking) metaChars += m.thinking.length
  }
  if (opts.metaChars != null) metaChars = opts.metaChars
  const active = msgs.filter((m) => !m.compacted)
  const talk = active.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system',
  )
  const { settled, live } = budgetedSettledHistory(
    applyHistoryLimit(talk, opts.historyLimit ?? 0),
  )
  for (const m of settled) {
    msgChars += m.content.length
    if (m.thinking) msgChars += m.thinking.length
    // Past tool results are re-sent every turn (AIMessage tool_calls +
    // ToolMessages), so they occupy context like talk content. Count them
    // here, otherwise the gap lands on System tools and inflates it.
    for (const act of m.toolActivity ?? []) {
      msgChars += act.tool.length
      if (act.args) msgChars += JSON.stringify(act.args).length
      if (act.summary) msgChars += act.summary.length
      if (act.diff) msgChars += act.diff.length
    }
  }
  if (live) {
    msgChars += live.content.length
    if (live.thinking) msgChars += live.thinking.length
    for (const act of live.toolActivity ?? []) {
      msgChars += act.tool.length
      if (act.args) msgChars += JSON.stringify(act.args).length
      if (act.summary) msgChars += act.summary.length
      if (act.diff) msgChars += act.diff.length
    }
  }
  const messages = Math.round(msgChars / CHARS_PER_TOKEN)
  // NO fixed floor here: this function's contract (and its tests) is "no fixed
  // floors" — a fabricated 16k-char prompt would swallow the whole meter total
  // of a fresh chat and pin the System prompt row to a number the backend never
  // reported. The real prompt size arrives via `systemPromptChars`; until then
  // the uncovered remainder is attributed to System tools by
  // buildContextBreakdown, which reconciles every row against the meter total.
  // (estimateContextChars keeps ITS OWN floor on purpose: the meter itself must
  // not read 0% before the first usage event — but the popover only ever SPLITS
  // that total, it does not re-estimate the prompt.)
  const systemPromptTokens =
    opts.systemPromptChars != null
      ? Math.round(opts.systemPromptChars / CHARS_PER_TOKEN)
      : Math.round(systemPrompt.length / CHARS_PER_TOKEN)
  const systemToolsTokens =
    opts.systemToolsChars != null
      ? Math.round(opts.systemToolsChars / CHARS_PER_TOKEN)
      : 0
  const metaTokens = Math.round(metaChars / CHARS_PER_TOKEN)
  const skillsTokens = Math.round((opts.skillsChars ?? 0) / CHARS_PER_TOKEN)
  const mcpTokens = Math.round((opts.mcpChars ?? 0) / CHARS_PER_TOKEN)
  return {
    messages,
    systemTools: systemToolsTokens,
    systemPrompt: systemPromptTokens,
    skills: skillsTokens,
    mcpTools: mcpTokens,
    meta: metaTokens,
  }
}

/** Full breakdown for the composer popup: estimated parts reconciled against
 *  the real meter total (provider total when available). The gap the frontend
 *  cannot measure (full history bodies vs. card summaries, backend-only turn
 *  notes) is attributed to Messages; a too-big local estimate is shrunk
 *  proportionally. */
export function buildContextBreakdown(
  chat: Chat | null,
  systemPrompt: string,
  window: number | null,
  opts: BreakdownEstimateOptions = {},
): ContextBreakdownResult {
  const parts = estimateBreakdownParts(chat, systemPrompt, opts)
  const actual = Math.max(
    0,
    computeContextUsed(chat, systemPrompt, window ?? undefined, opts.historyLimit ?? 0),
  )
  const known =
    parts.messages +
    parts.systemTools +
    parts.systemPrompt +
    parts.skills +
    parts.mcpTools +
    parts.meta
  const hasRealTools = opts.systemToolsChars != null
  let scaled = parts
  if (actual > 0 && known !== actual) {
    if (known <= 0) {
      // Nothing measurable locally and no backend report yet: the total is
      // dominated by the bound tool schemas (re-sent every turn) plus
      // history/prompt — attribute it to System tools as the schema estimate
      // so the row never sticks at 0 before the first turn reports real
      // sizes via systemToolsChars.
      scaled = { ...parts, systemTools: actual }
    } else if (known < actual) {
      // Gap between the provider total and the local estimate. Without a
      // backend report the gap is mostly the unmeasured tool schemas, so it
      // belongs to System tools. With measured schemas (systemToolsChars)
      // the gap is history the frontend cannot measure (full tool-result
      // bodies vs. card summaries, backend-only turn notes), so it belongs
      // to Messages.
      if (hasRealTools) {
        scaled = { ...parts, messages: parts.messages + (actual - known) }
      } else {
        scaled = { ...parts, systemTools: parts.systemTools + (actual - known) }
      }
    } else {
      // The local estimate overshoots the provider total (cache/history diff).
      // Absorb the excess from the ESTIMATED parts first (messages/meta) so
      // real reported sizes (system prompt / skills / MCP) keep their value;
      // scale everything only when the estimates cannot cover the gap.
      const estSum = parts.messages + parts.meta
      const excess = known - actual
      if (estSum > 0 && excess <= estSum) {
        const keep = estSum - excess
        const k = keep / estSum
        scaled = {
          ...parts,
          messages: Math.round(parts.messages * k),
          meta: Math.round(parts.meta * k),
        }
        const estDrift = keep - (scaled.messages + scaled.meta)
        if (estDrift !== 0) {
          scaled = { ...scaled, messages: Math.max(0, scaled.messages + estDrift) }
        }
      } else {
        const k = known > 0 ? actual / known : 0
        scaled = {
          messages: Math.round(parts.messages * k),
          systemTools: Math.round(parts.systemTools * k),
          systemPrompt: Math.round(parts.systemPrompt * k),
          skills: Math.round(parts.skills * k),
          mcpTools: Math.round(parts.mcpTools * k),
          meta: Math.round(parts.meta * k),
        }
        // Fix rounding drift so rows sum exactly to the meter total.
        const sum = Object.values(scaled).reduce((s, v) => s + v, 0)
        const drift = actual - sum
        if (drift !== 0) {
          scaled = { ...scaled, systemTools: Math.max(0, scaled.systemTools + drift) }
        }
      }
    }
  }
  const total = actual
  const usages: TokenUsage[] = (chat?.messages ?? [])
    .filter((m) => !m.compacted && m.role === 'assistant' && m.usage)
    .map((m) => m.usage as TokenUsage)
  return computeContextBreakdown(total, scaled, window, averageCacheHitRate(usages))
}

/** Whether the composer context popover may render (pure so it is testable). */
export function isContextPopoverOpen(
  openForChatId: string | null,
  activeChatId: string | null,
  total: number,
): boolean {
  return openForChatId !== null && openForChatId === activeChatId && total > 0
}

/** Format a 0-100 value for the context popover: at most one decimal place
 *  (0 -> "0%", 2.76 -> "2.8%", 96.8 -> "96.8%", 98.7 -> "98.7%"). */
export function formatBreakdownPercent(pct: number): string {
  const v = Math.round(Math.max(0, pct) * 10) / 10
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`
}
