import './_globals.ts'
import {
  computeContextUsed,
  estimateContextTokens,
} from '../src/lib/context.ts'
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
      outputTokens: 900,
      usage: { inputTokens: 5000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = input + output (5900), output included', used === 5900, used)

  // When totalTokens is present it is used directly (it already includes output + cache).
  const chat2 = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: { inputTokens: 5000, outputTokens: 900, totalTokens: 5900, cacheReadTokens: 1200, cacheWriteTokens: 0 },
    },
  ])
  check(
    'used = totalTokens when present (5900 incl. cache)',
    computeContextUsed(chat2, 'sys', 200000) === 5900,
    computeContextUsed(chat2, 'sys', 200000),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) only the LATEST assistant turn drives the meter (no max over history):')
{
  // An earlier, much larger turn must NOT inflate the meter — opencode uses the
  // latest request's total, which already re-sends the whole history.
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', outputTokens: 10, usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used = latest turn total (2010), not the earlier 1M', used === 2010, used)
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
  // no totalTokens → input + output = 100009 (output is included, like opencode).
  check('used includes output (100009)', used === 100009, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) no usage yet → falls back to the estimate (never a dash):')
{
  const chat = mkChat([
    { role: 'user', content: 'hello there friend' },
    { role: 'assistant', content: 'hi' }, // no usage object
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  const est = estimateContextTokens(chat, 'sys', 200000)
  check('used equals the estimate when no usage', used === est, { used, est })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵) estimate grows cumulatively as history grows (fallback path):')
{
  const m = (c: string) => ({ role: 'user', content: c, outputTokens: 0 })
  const a = (c: string) => ({ role: 'assistant', content: c, outputTokens: 0 })
  const base = mkChat([m('seed'), a('seed'), m('seed')])
  const grown = mkChat([m('seed'), a('seed'), m('seed'), a('seed'.repeat(50)), m('seed'.repeat(50)), a('seed'.repeat(50))])
  const e0 = estimateContextTokens(base, 'sys', 200000)
  const e1 = estimateContextTokens(grown, 'sys', 200000)
  check('estimate increases with more history', e1 > e0, { e0, e1 })
  // And computeContextUsed (no usage) tracks that growth.
  check('computeContextUsed grows with history', computeContextUsed(grown, 'sys', 200000) > computeContextUsed(base, 'sys', 200000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
