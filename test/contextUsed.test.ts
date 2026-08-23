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
console.log('۱) realTotal excludes output tokens (context-window basis):')
{
  // Provider reports input=5000, output=900 — only input+cache counts.
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      outputTokens: 900,
      usage: { inputTokens: 5000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ])
  const sys = 'system'
  const used = computeContextUsed(chat, sys, 50, 200000, 'ask')
  // estimate is non-trivial (system + 2 messages + 16k floor), so used >= 5000.
  check('used ≥ provider input (5000), ignores output', used >= 5000, used)
  check('used is NOT input+output (5900)', used !== 5900, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) windowed provider input → meter uses the larger full-conversation estimate (cumulative, like opencode):')
{
  // opencode/hy3-free reports a windowed ~5.3K input; the real conversation is
  // much larger. The meter must NOT collapse to the 5.3K slice.
  const big = 'x'.repeat(40000) // ~10k tokens of history
  const chat = mkChat([
    { role: 'user', content: big },
    { role: 'assistant', content: big, outputTokens: 100, usage: { inputTokens: 5300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { role: 'user', content: 'follow-up' },
  ])
  const used = computeContextUsed(chat, 'sys', 50, 200000, 'ask')
  const est = estimateContextTokens(chat, 'sys', 50, 200000, 'ask')
  check('used equals max(realTotal, estimate)', used === Math.max(5300, est), { used, est })
  check('used is cumulative (>> windowed 5300)', used > 5300, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) provider sends full history (realTotal > estimate) → trust the provider:')
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
  const used = computeContextUsed(chat, 'sys', 50, 200000, 'ask')
  const est = estimateContextTokens(chat, 'sys', 50, 200000, 'ask')
  check('used equals the larger provider count', used === Math.max(99999, est), { used, est })
  check('used reflects provider (99999)', used === 99999 || used === Math.max(99999, est), used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) no usage yet → falls back to the estimate (never a dash):')
{
  const chat = mkChat([
    { role: 'user', content: 'hello there friend' },
    { role: 'assistant', content: 'hi' }, // no usage object
  ])
  const used = computeContextUsed(chat, 'sys', 50, 200000, 'ask')
  const est = estimateContextTokens(chat, 'sys', 50, 200000, 'ask')
  check('used equals the estimate when no usage', used === est, { used, est })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵) estimate grows cumulatively as history grows (the core "like opencode" behavior):')
{
  const m = (c: string) => ({ role: 'user', content: c, outputTokens: 0 })
  const a = (c: string) => ({ role: 'assistant', content: c, outputTokens: 0 })
  const base = mkChat([m('seed'), a('seed'), m('seed')])
  const grown = mkChat([m('seed'), a('seed'), m('seed'), a('seed'.repeat(50)), m('seed'.repeat(50)), a('seed'.repeat(50))])
  const e0 = estimateContextTokens(base, 'sys', 50, 200000, 'ask')
  const e1 = estimateContextTokens(grown, 'sys', 50, 200000, 'ask')
  check('estimate increases with more history', e1 > e0, { e0, e1 })
  // And computeContextUsed (no usage) tracks that growth.
  check('computeContextUsed grows with history', computeContextUsed(grown, 'sys', 50, 200000, 'ask') > computeContextUsed(base, 'sys', 50, 200000, 'ask'))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
