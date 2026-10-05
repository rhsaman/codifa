// Unit tests for the context-breakdown helpers behind the composer popover
// (the hover ring next to Send): part percentages, cache-hit rate, estimate
// scaling, and the popover's open-state gate.
import './_globals.ts'
import {
  computeContextBreakdown,
  averageCacheHitRate,
  estimateBreakdownParts,
  buildContextBreakdown,
  isContextPopoverOpen,
  formatBreakdownPercent,
  formatTokensK,
  contextBarSegmentPercent,
} from '../src/lib/context.ts'
import type { Chat } from '../src/types.ts'

function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

function mkChat(messages: unknown[]): Chat {
  return { id: 'c1', mode: 'ask', messages } as unknown as Chat
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) computeContextBreakdown: percentages, ordering, window:')
{
  const bd = computeContextBreakdown(
    1000,
    {
      messages: 960,
      systemTools: 30,
      systemPrompt: 2,
      skills: 1,
      mcpTools: 1,
      meta: 6,
    },
    10000,
    87.5,
  )
  check('total passthrough', bd.total === 1000, bd.total)
  check('window passthrough', bd.window === 10000, bd.window)
  check('window percent (1000/10000 = 10%)', bd.percent === 10, bd.percent)
  check('cache hit rate passthrough', bd.cacheHitRate === 87.5, bd.cacheHitRate)
  check('rows sorted heaviest first', bd.rows[0]?.key === 'messages', bd.rows.map((r) => r.key))
  check(
    'second row is system tools (30 > 6 > 2)',
    bd.rows[1]?.key === 'systemTools' && bd.rows[2]?.key === 'meta',
    bd.rows.map((r) => r.key),
  )
  check('messages = 96%', Math.abs(bd.rows[0].percent - 96) < 1e-9, bd.rows[0].percent)
  check('system tools = 3%', Math.abs(bd.rows[1].percent - 3) < 1e-9, bd.rows[1].percent)
  const sum = bd.rows.reduce((s, r) => s + r.percent, 0)
  check('row percentages sum to 100', Math.abs(sum - 100) < 1e-9, sum)
  check('labels come from CONTEXT_BREAKDOWN_LABELS', bd.rows[0].label === 'Messages', bd.rows[0].label)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) computeContextBreakdown edge cases (zero total, negative parts):')
{
  const zero = computeContextBreakdown(
    0,
    { messages: 0, systemTools: 0, systemPrompt: 0, skills: 0, mcpTools: 0, meta: 0 },
    100000,
    null,
  )
  check('total 0 -> all row percents 0', zero.rows.every((r) => r.percent === 0), zero.rows.map((r) => r.percent))
  check('total 0 -> window percent 0', zero.percent === 0, zero.percent)
  check('no cache rate -> null', zero.cacheHitRate === null)

  const neg = computeContextBreakdown(
    100,
    { messages: -50, systemTools: 10, systemPrompt: 0, skills: 0, mcpTools: 0, meta: 0 },
    null,
    null,
  )
  check('negative part clamped to 0', neg.rows.find((r) => r.key === 'messages')?.tokens === 0)
  check('unknown window -> percent null', neg.percent === null, neg.percent)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) averageCacheHitRate: subset vs additive convention + empty:')
{
  // Subset (OpenAI-like): cache sits INSIDE input -> denominator is input.
  const subset = averageCacheHitRate([
    { inputTokens: 90000, outputTokens: 0, totalTokens: 90000, cacheReadTokens: 87000 },
  ])
  check('subset: 87000/90000 = 96.67%', subset != null && Math.abs(subset - (87000 / 90000) * 100) < 1e-9, subset)

  // Additive (Anthropic-like): cache sits OUTSIDE input -> input + cache.
  const additive = averageCacheHitRate([
    { inputTokens: 3000, outputTokens: 0, totalTokens: 9000, cacheReadTokens: 6000 },
  ])
  check('additive: 6000/(3000+6000) = 66.67%', additive != null && Math.abs(additive - (6000 / 9000) * 100) < 1e-9, additive)

  // Weighted across turns: a zero-usage turn contributes nothing.
  const mixed = averageCacheHitRate([
    { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cacheReadTokens: 500 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])
  check('zero-usage turn skipped', mixed != null && Math.abs(mixed - 50) < 1e-9, mixed)

  check('no usages -> null', averageCacheHitRate([]) === null)

  // Cache WRITES are misses that fill the cache, not hits: a cold additive
  // turn (all writes, no reads) must rate 0%, not write/footprint.
  const coldWrite = averageCacheHitRate([
    { inputTokens: 3000, outputTokens: 0, totalTokens: 9000, cacheWriteTokens: 6000 },
  ])
  check('additive cold write-only turn -> 0% hit', coldWrite === 0, coldWrite)

  // Warm turn with a write: reads are the hits, writes widen the footprint.
  const warmWrite = averageCacheHitRate([
    { inputTokens: 3000, outputTokens: 0, totalTokens: 9500, cacheReadTokens: 6000, cacheWriteTokens: 500 },
  ])
  check(
    'additive warm: 6000/(3000+6000+500)',
    warmWrite != null && Math.abs(warmWrite - (6000 / 9500) * 100) < 1e-9,
    warmWrite,
  )

  // Subset convention with a write still divides by input (cache inside it).
  const subsetWrite = averageCacheHitRate([
    { inputTokens: 90000, outputTokens: 0, totalTokens: 90000, cacheReadTokens: 87000, cacheWriteTokens: 2000 },
  ])
  check(
    'subset with write: 87000/90000',
    subsetWrite != null && Math.abs(subsetWrite - (87000 / 90000) * 100) < 1e-9,
    subsetWrite,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) estimateBreakdownParts: defaults and caller overrides:')
{
  const compacted = 'old summary that was compacted'
  const chat = mkChat([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'system', content: compacted, compacted: true },
  ])
  const d = estimateBreakdownParts(chat, 'sys')
  check('messages exclude compacted summaries (9 chars / 4)', d.messages === Math.round(9 / 4), d.messages)
  check('system prompt = 3 chars / 4', d.systemPrompt === Math.round(3 / 4), d.systemPrompt)
  check('systemTools has NO fixed floor (default 0)', d.systemTools === 0, d.systemTools)
  check('meta = compacted summary content', d.meta === Math.round(compacted.length / 4), d.meta)
  check('skills/mcp default to 0', d.skills === 0 && d.mcpTools === 0, d)

  const o = estimateBreakdownParts(chat, 'sys', {
    systemToolsChars: 8,
    metaChars: 4,
    skillsChars: 12,
    mcpChars: 4,
  })
  check('override system tools', o.systemTools === 2, o.systemTools)
  check('override meta', o.meta === 1, o.meta)
  check('override skills', o.skills === 3, o.skills)
  check('override mcp', o.mcpTools === 1, o.mcpTools)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵) buildContextBreakdown: scales estimates to the real meter total:')
{
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: {
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      },
    },
  ])
  const bd = buildContextBreakdown(chat, 'sys', 10000)
  check('total = provider-reported meter total (2000)', bd.total === 2000, bd.total)
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0)
  check('scaled rows sum exactly to the total (no rounding drift)', sum === 2000, sum)
  check('six rows', bd.rows.length === 6, bd.rows.length)
  check('window percent = 2000/10000 = 20%', bd.percent === 20, bd.percent)
  check('cache hit rate = 800/1000 = 80%', bd.cacheHitRate != null && Math.abs(bd.cacheHitRate - 80) < 1e-9, bd.cacheHitRate)
  const tools = bd.rows.find((r) => r.key === 'systemTools')
  check('remainder = 2000 - messages(1) - prompt(1) = 1998', tools?.tokens === 1998, tools?.tokens)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵ب) buildContextBreakdown: estimate overshoot shrinks proportionally:')
{
  const chat = mkChat([
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 } },
  ])
  const bd = buildContextBreakdown(chat, 'sys', 10000)
  check('total = provider total (1000)', bd.total === 1000, bd.total)
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0)
  check('rows sum to the real total after shrink', sum === 1000, sum)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵ج) fresh chat: no fake floors — remainder is exactly the real total:')
{
  const chat = mkChat([])
  const bd = buildContextBreakdown(chat, '', 200000)
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0)
  check('rows sum to the meter total', sum === bd.total, { sum, total: bd.total })
  const tools = bd.rows.find((r) => r.key === 'systemTools')
  check('systemTools holds the whole remainder', tools?.tokens === bd.total, tools?.tokens)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۶) isContextPopoverOpen: chat-scoped and requires a non-zero total:')
{
  check('same chat + total > 0 -> open', isContextPopoverOpen('c1', 'c1', 100) === true)
  check('different chat -> closed', isContextPopoverOpen('c1', 'c2', 100) === false)
  check('never opened -> closed', isContextPopoverOpen(null, 'c1', 100) === false)
  check('zero total -> closed', isContextPopoverOpen('c1', 'c1', 0) === false)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۷) formatBreakdownPercent: at most one decimal:')
{
  check('0 -> "0%"', formatBreakdownPercent(0) === '0%', formatBreakdownPercent(0))
  check('96.78 -> "96.8%"', formatBreakdownPercent(96.78) === '96.8%', formatBreakdownPercent(96.78))
  check('98.7 -> "98.7%"', formatBreakdownPercent(98.7) === '98.7%', formatBreakdownPercent(98.7))
  check('0.6 -> "0.6%"', formatBreakdownPercent(0.6) === '0.6%', formatBreakdownPercent(0.6))
  check('0.04 -> "0%"', formatBreakdownPercent(0.04) === '0%', formatBreakdownPercent(0.04))
  check('100 -> "100%"', formatBreakdownPercent(100) === '100%', formatBreakdownPercent(100))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۸) real reported parts (ctx_parts) beat estimates:')
{
  const chat = mkChat([{ role: 'user', content: 'hi' }])
  const bd = buildContextBreakdown(chat, 'sys', 10000, {
    systemPromptChars: 8000,
    skillsChars: 1200,
    mcpChars: 400,
  })
  const find = (k: string) => bd.rows.find((r) => r.key === k)?.tokens
  check('system prompt = 8000/4 = 2000', find('systemPrompt') === 2000, find('systemPrompt'))
  check('skills = 1200/4 = 300', find('skills') === 300, find('skills'))
  check('mcp = 400/4 = 100', find('mcpTools') === 100, find('mcpTools'))
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0)
  check('rows still sum to the meter total', sum === bd.total, { sum, total: bd.total })

  // Overshoot: reported real parts keep their size (only estimates shrink).
  const chat2 = mkChat([
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 } },
  ])
  const bd2 = buildContextBreakdown(chat2, 'sys', 10000, { systemPromptChars: 800 })
  const sp2 = bd2.rows.find((r) => r.key === 'systemPrompt')?.tokens
  check('real system prompt preserved on overshoot', sp2 === 200, sp2)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('9) contextBarSegmentPercent: fill-scaled against the window:')
{
  const total = 108124
  const window = 1048576
  // The filled portion of the bar must equal the header usage percentage.
  check(
    'segment = tokens/window (105900/1M ~ 10.1%)',
    Math.abs(contextBarSegmentPercent(105900, total, window) - (105900 / window) * 100) < 1e-9,
    contextBarSegmentPercent(105900, total, window),
  )
  const sum = [105900, 1300, 910, 14, 0, 0].reduce(
    (s, t) => s + contextBarSegmentPercent(t, total, window),
    0,
  )
  check('segments sum to the usage percent (10.31%)', Math.abs(sum - (total / window) * 100) < 1e-9, sum)
  check(
    'no window -> falls back to composition (sums to 100%)',
    Math.abs(
      [105900, 1300, 910, 14, 0, 0].reduce(
        (s, t) => s + contextBarSegmentPercent(t, total, null),
        0,
      ) - 100,
    ) < 1e-9,
  )
  check('zero total without window -> 0', contextBarSegmentPercent(50, 0, null) === 0)
  check('negative row clamped to 0', contextBarSegmentPercent(-5, total, window) === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('10) formatTokensK: window label keeps percent-consistent precision:')
{
  check('1048576 -> "1.05M"', formatTokensK(1048576) === '1.05M', formatTokensK(1048576))
  check('1000000 -> "1M"', formatTokensK(1_000_000) === '1M', formatTokensK(1_000_000))
  check('2000000 -> "2M"', formatTokensK(2_000_000) === '2M', formatTokensK(2_000_000))
  check('2500000 -> "2.5M"', formatTokensK(2_500_000) === '2.5M', formatTokensK(2_500_000))
  check('200000 -> "200K"', formatTokensK(200_000) === '200K', formatTokensK(200_000))
  check('824100 -> "824K"', formatTokensK(824_100) === '824K', formatTokensK(824_100))
  check('2365100 -> "2.37M"', formatTokensK(2_365_100) === '2.37M', formatTokensK(2_365_100))
  check('900 -> "900"', formatTokensK(900) === '900', formatTokensK(900))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
