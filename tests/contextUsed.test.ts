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
console.log('۱) meter = latest turn input_tokens (from langgraph):')
{
  // subset: total_tokens == input + output
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 5900 } },
  ])
  check('used = latest input_tokens (5000)', computeContextUsed(chat, 'sys', 200000) === 5000, computeContextUsed(chat, 'sys', 200000))

  // additive: input_tokens excludes cache; the meter shows the reported
  const chat2 = mkChat([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 7100, cacheReadTokens: 1200, cacheWriteTokens: 0 } },
  ])
  check(
    'used = input_tokens (5000)',
    computeContextUsed(chat2, 'sys', 200000) === 5000,
    computeContextUsed(chat2, 'sys', 200000),
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
  // The meter mirrors the latest turn's input_tokens (2000) — the same value
  // that drives auto-compaction — rather than the earlier peak (999999).
  check('used = latest turn input_tokens (2000)', computeContextUsed(chat, 'sys', 200000) === 2000, computeContextUsed(chat, 'sys', 200000))
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
  check('used = latest non-compacted input_tokens (2000)', used === 2000, { used })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) usage parts but no total_tokens yet → falls back to the history estimate:')
{
  // The backend always sends input_tokens in practice; if it is absent (or 0)
  // the meter must reflect the TRUE context (history), not collapse to the bare
  // last message's 100 tokens.
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
console.log('۵) subset provider: input_tokens already includes cache_read (no separate add):')
{
  // For subset-convention providers (OpenAI / OpenRouter / Google) cache_read is
  // a SUBSET of input_tokens, so the reported input_tokens (100) already counts
  // the cached portion. The meter uses input_tokens directly.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5000, cacheWriteTokens: 200, totalTokens: 5350 },
    },
  ])
  check('used = input_tokens (100, cache already folded into input for subset)', computeContextUsed(chat, 'sys', 200000) === 100, computeContextUsed(chat, 'sys', 200000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
