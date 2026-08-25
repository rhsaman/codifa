import './_globals.ts'
import { computeContextUsed, estimateContextChars, CHARS_PER_TOKEN } from '../src/lib/context.ts'
import type { Chat } from '../src/types.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

function mkChat(messages: any[], mode = 'ask'): Chat {
  return { id: 'c1', mode, messages } as unknown as Chat
}
const est = (chat: any, sp = 'sys') =>
  Math.round(estimateContextChars(chat, sp, 200000) / CHARS_PER_TOKEN)

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) realTotal includes output + cache (latest turn total, like opencode overflow.ts):')
{
  // opencode's isOverflow uses tokens.total = input + output + cache.read + cache.write.
  // Here usage has no totalTokens, so we sum the parts — output IS included.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 5000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = input + output (5900), output included', used === 5900, used)

  // When totalTokens is present it is used directly. For an additive provider
  // (cache_read separate from input, like Anthropic) the backend folds the cache
  // into totalTokens, so it already includes output + cache.
  const chat2 = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 7100, cacheReadTokens: 1200, cacheWriteTokens: 0 },
    },
  ])
  check(
    'used = cache-inclusive total (7100 = 5000+900+1200)',
    computeContextUsed(chat2, 'sys', 200000) === 7100,
    computeContextUsed(chat2, 'sys', 200000),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) meter reflects the TRUE context (system + full history), not just the latest message:')
{
  // The latest assistant turn reports only 2010, but the real context is the
  // whole history (system + 4 messages). A stateful/under-reporting provider
  // would otherwise make the meter "only show the latest message".
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', outputTokens: 10, usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  // The meter is a running max over the chat's turns (never drops as the
  // conversation grows). The latest turn reports only 2010, but an earlier turn
  // reported a much larger total — the meter must surface that PEAK, not
  // collapse to the latest 2010. So it is at least the full-context estimate
  // and strictly above the latest turn's 2010.
  check(
    'used is the peak context, not just the latest (>= estimate, > 2010)',
    used >= est(chat) && used > 2010,
    { used, est: est(chat) },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲ب) compacted turns are excluded from the estimated context:')
{
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 }, compacted: true },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', outputTokens: 10, usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = estimate of non-compacted history', used === est(chat) && used > 2010, { used, est: est(chat) })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) provider reports a real total → meter trusts it (output included):')
{
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      outputTokens: 10,
      usage: { inputTokens: 99999, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used includes output (100009)', used === 100009, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) no usage yet → returns a positive estimate (no 0% collapse):')
{
  const chat = mkChat([
    { role: 'user', content: 'hello there friend' },
    { role: 'assistant', content: 'hi' }, // no usage object
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used is a positive estimate when no usage event yet', used > 0, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵) meter reflects the true context (system + history), larger than bare message usage:')
{
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 30 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  const expected = est(chat)
  // the estimate (system + full history) dominates the under-reported 180
  check('used = true context estimate (>= message usage)', used === expected && used > 180, { used, expected })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۶) cached provider: cache tokens are counted, not dropped (opencode parity):')
{
  // Mirrors the backend fix: pydantic-ai reports cache_read_input_tokens
  // (the big cached history) separately from input_tokens (only the new part).
  // Before the backend fix cache_read_tokens was 0, so the meter collapsed to
  // just the latest exchange. Now it must equal input + output + cache.read + cache.write.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5000, cacheWriteTokens: 200 },
    },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  // 100 + 50 + 5000 + 200 = 5350 — the REAL context, not just the ~150 new tokens.
  check('used = input + output + cache.read + cache.write (5350)', used === 5350, used)
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
