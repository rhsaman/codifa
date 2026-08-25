import './_globals.ts'
import { computeContextUsed } from '../src/lib/context.ts'
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
console.log('۲) meter is CUMULATIVE across all non-compacted assistant turns (like opencode):')
{
  // opencode's TUI sums the whole (non-compacted) conversation, so the meter
  // only ever grows and never drops between turns. Every assistant turn's
  // usage is added, not just the latest.
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', outputTokens: 10, usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  // 1000004 + 2010 = 1002014 (both turns summed, cumulative)
  check('used = sum of all turns (1002014), not just latest', used === 1002014, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲ب) compacted turns are excluded from the cumulative total:')
{
  // After a compaction, the compacted messages are dropped from the sum — the
  // meter resets to the post-compact conversation, exactly like opencode.
  const chat = mkChat([
    { role: 'user', content: 'big' },
    { role: 'assistant', content: 'big', outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 }, compacted: true },
    { role: 'user', content: 'small follow-up' },
    { role: 'assistant', content: 'small', outputTokens: 10, usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 } },
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  // only the non-compacted turn counts → 2010
  check('used = 2010 (compacted turn excluded)', used === 2010, used)
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
console.log('۴) no usage yet → returns 0 (opencode shows empty meter, no estimate fallback):')
{
  const chat = mkChat([
    { role: 'user', content: 'hello there friend' },
    { role: 'assistant', content: 'hi' }, // no usage object
  ])
  const used = computeContextUsed(chat, 'sys', 200000)
  check('used is 0 when no usage event yet', used === 0, used)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۵) reasoning tokens are included in the latest turn total:')
{
  const chat = mkChat([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  ])
  // 100 + 50 + 30 = 180 (reasoning included, like opencode)
  check('used includes reasoning (180)', computeContextUsed(chat, 'sys', 200000) === 180, computeContextUsed(chat, 'sys', 200000))
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
