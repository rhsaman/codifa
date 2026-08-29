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
console.log('۱) meter = opencode sum of the latest turn (input+output+reasoning+cache):')
{
  // subset: total_tokens == input + output, but the meter uses the hand-summed
  // breakdown (opencode parity), NOT the provider's native total_tokens.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 5900 } },
  ])
  // 5000 + 900 = 5900 (no reasoning/cache here)
  check('used = input+output (5900)', computeContextUsed(chat, 'sys', 200000) === 5900, computeContextUsed(chat, 'sys', 200000))

  // additive: input_tokens excludes cache; the meter adds cache read/write back.
  const chat2 = mkChat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 7100, cacheReadTokens: 1200, cacheWriteTokens: 0 } },
  ])
  // 5000 + 900 + 1200 = 7100
  check(
    'used = input+output+cacheRead (7100)',
    computeContextUsed(chat2, 'sys', 200000) === 7100,
    computeContextUsed(chat2, 'sys', 200000),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱ب) reasoning tokens are included in the meter (opencode parity):')
{
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 5000, outputTokens: 900, reasoningTokens: 1500, cacheReadTokens: 1200, cacheWriteTokens: 300, totalTokens: 8900 },
    },
  ])
  // 5000 + 900 + 1500 + 1200 + 300 = 8900
  check(
    'used = input+output+reasoning+cacheRead+cacheWrite (8900)',
    computeContextUsed(chat, 'sys', 200000) === 8900,
    computeContextUsed(chat, 'sys', 200000),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) meter follows the LATEST turn, not a historical peak (no "stuck at old peak"):')
{
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  // The meter mirrors the latest turn's breakdown (2000 + 10 = 2010) — the same
  // value that drives auto-compaction — rather than the earlier peak (999999).
  check('used = latest turn sum (2010)', computeContextUsed(chat, 'sys', 200000) === 2010, computeContextUsed(chat, 'sys', 200000))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲ب) compacted turns are excluded from the meter:')
{
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 }, compacted: true },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = latest non-compacted sum (2010)', used === 2010, { used })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) usage parts but no input_tokens yet → falls back to the history estimate:')
{
  // The backend always sends input_tokens in practice; if it is absent (or 0)
  // the meter must reflect the TRUE context (history), not collapse to the bare
  // last message's 50 output tokens.
  const chat = mkChat([
    { role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'ok', usage: { outputTokens: 50 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = history estimate, not just last-message parts', used === est(chat) && used > 150, { used, est: est(chat) })
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
console.log('۵) subset provider: backend sends real cache_read but total_tokens already folds it into input:')
{
  // For subset-convention providers (OpenAI / OpenRouter / Google) cache_read is
  // a SUBSET of input_tokens, so the backend surfaces the real cache_read (for
  // cost math) but keeps total_tokens == input + output (cache already counted).
  // The meter uses total_tokens directly (100 + 50 = 150) without double-counting
  // the cache — it only hand-sums (input+output+reasoning+cache) when total_tokens
  // is absent.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 150 },
    },
  ])
  // total_tokens (150) wins — cache is NOT added back (would be 190 if it were).
  check('used = total_tokens (150, cache NOT double-counted for subset)', computeContextUsed(chat, 'sys', 200000) === 150, computeContextUsed(chat, 'sys', 200000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
