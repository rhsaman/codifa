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
 * This mirrors `sliceToBudget` in Chat.tsx exactly: slice to the last
 * `maxHistory` settled messages, then trim further to the same char budget
 * (contextWindow * 1.5, capped at 60k for ask mode) the frontend actually
 * sends. Without this second trim the estimate silently overshoots whatever
 * the backend will really receive.
 */
function budgetedSettledHistory(
  talk: Chat['messages'],
  maxHistory: number,
  contextWindow?: number,
  mode?: string,
): { settled: Chat['messages']; live: Chat['messages'][number] | null } {
  const live =
    talk.length > 0 && talk[talk.length - 1].streaming ? talk[talk.length - 1] : null
  const rest = live ? talk.slice(0, -1) : talk

  const ctx = contextWindow && contextWindow > 0 ? contextWindow : 32000
  const budget = Math.floor(ctx * 1.5)
  // Absolute per-mode ceilings — mirrors sliceToBudget in Chat.tsx exactly.
  // ask: mentor guidance needs little scrollback; coder/plan turns carry more
  // tool-call history that stays relevant, so they get higher (but still
  // bounded) caps. Keeps runaway history from blowing past the window on very
  // large-context models before the 80% auto-compact threshold kicks in.
  const MODE_HISTORY_CAPS: Record<string, number> = {
    ask: 60000,
    plan: 120000,
    coder: 140000,
  }
  const capped = Math.min(budget, MODE_HISTORY_CAPS[mode ?? 'ask'] ?? budget)
  // Compact summaries (system role) must always survive the maxHistory slice —
  // mirrors sliceToBudget in Chat.tsx, so the estimate matches what is really
  // sent (the summary stands in for the folded older turns).
  const systems = rest.filter((m) => m.role === 'system')
  const recent = [
    ...systems,
    ...rest.filter((m) => m.role !== 'system').slice(-maxHistory),
  ]
  const kept: Chat['messages'] = []
  let acc = 0
  for (const m of [...recent].reverse()) {
    if (m.role !== 'system' && kept.length > 0 && acc + m.content.length > capped) break
    kept.push(m)
    acc += m.content.length
  }
  return { settled: kept.reverse(), live }
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
  maxHistory: number,
  contextWindow?: number,
  mode?: string,
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
  const { settled, live } = budgetedSettledHistory(talk, maxHistory, contextWindow, mode)
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
  maxHistory: number,
  contextWindow?: number,
  mode?: string,
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
  const { settled, live } = budgetedSettledHistory(talk, maxHistory, contextWindow, mode)
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
  // No 100% cap — mirrors opencode's TUI meter, which reports the raw
  // percentage even past the window (e.g. "105%") so an overflow is visible.
  return Math.round((used / windowSize) * 100)
}

/**
 * Resolve the context-meter token count shown in the sidebar.
 *
 * We take the LARGER of:
 *  - `realTotal`: the provider's reported `input + cache` tokens from the last
 *    assistant turn's `usage` event (opencode's precise count), and
 *  - `estimate`: our full-conversation estimate (system + settled history +
 *    live turn).
 *
 * opencode's proxy may window its reported `input_tokens` to a small slice, so
 * `realTotal` can UNDER-count the real conversation. Using the max keeps the
 * meter cumulative and growing — matching opencode's own TUI meter — while
 * still trusting the provider when it reports more than our estimate. When no
 * real usage has arrived yet (brand-new chat / right after a compact) the
 * estimate is the only signal, so it acts as a floor. Output tokens are
 * EXCLUDED from `realTotal` (they are generated after the prompt and are not
 * part of the context window).
 */
export function computeContextUsed(
  chat: Chat | null,
  systemPrompt: string,
  maxHistory: number,
  contextWindow?: number,
  mode?: string,
): number {
  const msgs = chat?.messages ?? []
  const active = msgs.filter((m) => !m.compacted)
  let realTotal = 0
  for (let i = active.length - 1; i >= 0; i--) {
    const m = active[i]
    const u = m.usage
    if (m.role === 'assistant' && u && u.outputTokens > 0) {
      const cached = (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
      realTotal = (u.inputTokens || 0) + cached
      break
    }
  }
  const estimate = estimateContextTokens(chat, systemPrompt, maxHistory, contextWindow, mode)
  return Math.max(realTotal, estimate)
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
