import './_globals.ts'
import { computeContextUsed, contextPercent } from '../src/lib/context.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

const mkMsg = (role: string, usage: any) => ({
  id: Math.random().toString(),
  role,
  content: '',
  usage,
  compacted: false,
})

console.log('۱) computeContextUsed includes reasoning tokens:')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ],
  }
  // 100 + 50 + 30 = 180 (بدون reasoning می‌شد 150)
  check('reasoning لحاظ می‌شود (180)', computeContextUsed(chat as any, '', 200000) === 180, computeContextUsed(chat as any, '', 200000))
}

console.log('۲) contextPercent uses raw window (no reserved subtraction):')
{
  // opencode: total / limit.context خام
  check('100000/200000 = 50% نه 55.5%', contextPercent(100000, 200000) === 50, contextPercent(100000, 200000))
}

console.log('۳) computeContextUsed returns 0 when no usage (no estimate fallback):')
{
  const chat = {
    messages: [mkMsg('user', null), mkMsg('assistant', null)],
  }
  check('وقتی usage نیست 0 برمی‌گردد', computeContextUsed(chat as any, 'big system prompt', 200000) === 0, computeContextUsed(chat as any, 'big system prompt', 200000))
}

console.log('۴) computeContextUsed prefers totalTokens over sum of parts:')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', {
        totalTokens: 200,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 10,
      }),
    ],
  }
  // totalTokens موجود است → نباید جمع اجزا را دوبرابر حساب کند
  check('totalTokens اولویت دارد (200 نه 200+...)', computeContextUsed(chat as any, '', 200000) === 200, computeContextUsed(chat as any, '', 200000))
}

console.log('۵) computeContextUsed takes the latest assistant turn with usage:')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      mkMsg('user', null),
      mkMsg('assistant', {
        inputTokens: 300,
        outputTokens: 150,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ],
  }
  // فقط آخرین ترن assistant (300 + 150 = 450) لحاظ می‌شود
  check('فقط آخرین ترن assistant (450)', computeContextUsed(chat as any, '', 200000) === 450, computeContextUsed(chat as any, '', 200000))
}

if ((globalThis as any).__FAILED) {
  console.error('\nFAILED')
  process.exit(1)
} else {
  console.log('\nALL PASSED')
}
