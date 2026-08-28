import './_globals.ts'
import { estimateContextTokens } from '../src/lib/context.ts'
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

const SYSTEM = 'system prompt base'

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) سوییچ mode نباید کانتکست را کم کند (بدون MODE_HISTORY_CAPS):')
{
  // opencode has NO per-mode history cap — the full history is sent every turn
  // regardless of mode. So estimateContextTokens must be identical for ask/coder.
  const msgs = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${i} with some reasonable length text`,
  }))
  const ask = estimateContextTokens(mkChat(msgs, 'ask'), SYSTEM, 200000)
  const coder = estimateContextTokens(mkChat(msgs, 'coder'), SYSTEM, 200000)
  check('ask و coder یکسان محاسبه می‌کنند (سقف به‌ازای mode نداریم)', ask === coder, { ask, coder })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) هر turn پیام کم نمی‌شود (بدون پنجرهٔ لغزان maxHistory):')
{
  // opencode sends the FULL history every turn — it never drops messages by
  // count. With 30 messages (far more than the old 10-cloud / 3-local cap), the
  // estimate must count ALL of them, not just the last 10. The fixed 16k-char
  // floor makes the ratio <3x, so we assert the extra 20 messages actually
  // contribute (~250 tokens here) rather than a 3x multiple.
  const msgs = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${i} with some reasonable length text`,
  }))
  const all = estimateContextTokens(mkChat(msgs, 'ask'), SYSTEM, 200000)
  const first10 = estimateContextTokens(mkChat(msgs.slice(0, 10), 'ask'), SYSTEM, 200000)
  check('۳۰ پیام بیشتر از ۱۰ پیام محاسبه می‌شود (پیام‌های ۱۱ تا ۳۰ ریخته نشده‌اند)', all > first10 + 150, { all, first10 })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) تاریخچهٔ کامل ارسال می‌شود (مثل opencode):')
{
  // A long history must scale with message count — every message contributes,
  // proving no tail slice is applied. 20 extra ~100-token messages ≈ +2000 tokens.
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(400), // ~100 tokens each
    }))
  const ten = estimateContextTokens(mkChat(mk(10), 'ask'), SYSTEM, 200000)
  const thirty = estimateContextTokens(mkChat(mk(30), 'ask'), SYSTEM, 200000)
  check('۳۰ پیام حدود ۲۰ پیام اضافه نسبت به ۱۰ پیام دارد (خطی، بدون slice)', thirty > ten + 1500, { ten, thirty })
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
