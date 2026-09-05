import './_globals.ts'
import {
  computeContextUsed,
  contextPercent,
  estimateContextChars,
  CHARS_PER_TOKEN,
  priceForModel,
  computeUsageCost,
} from '../src/lib/context.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

const est = (chat: any, sp = '') =>
  Math.round(estimateContextChars(chat, sp, 200000) / CHARS_PER_TOKEN)

const mkMsg = (role: string, usage: any, content = '') => ({
  id: Math.random().toString(),
  role,
  content,
  usage,
  compacted: false,
})

console.log('۱) meter reflects the FULL context (system + all history), not just the latest message:')
{
  const small = {
    messages: [
      mkMsg('user', null, 'x'.repeat(200)),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50 }, 'y'.repeat(200)),
    ],
  }
  const big = {
    messages: [
      mkMsg('user', null, 'x'.repeat(200)),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50 }, 'y'.repeat(200)),
      mkMsg('user', null, 'x'.repeat(200)),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50 }, 'y'.repeat(200)),
      mkMsg('user', null, 'x'.repeat(200)),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50 }, 'y'.repeat(200)),
    ],
  }
  const smallUsed = computeContextUsed(small as any, '', 200000)
  const bigUsed = computeContextUsed(big as any, '', 200000)
  // more history → larger true context; the meter is not "just the last message"
  check('چت با تاریخچهٔ بیشتر کانتکست بزرگتری نشان می‌دهد', bigUsed > smallUsed, { smallUsed, bigUsed })
  // the under-reported last-message usage (150) is overridden by the real estimate
  check('متر زیرِ گزارش پروایدر نمی‌افتد (برآورد واقعی)', bigUsed > 150, bigUsed)
}

console.log('۲) contextPercent uses raw window (no reserved subtraction):')
{
  check('100000/200000 = 50% نه 55.5%', contextPercent(100000, 200000) === 50, contextPercent(100000, 200000))
}

console.log('۳) computeContextUsed falls back to a positive estimate when no usage (no 0% collapse):')
{
  const chat = { messages: [mkMsg('user', null), mkMsg('assistant', null)] }
  const used = computeContextUsed(chat as any, 'big system prompt', 200000)
  check('وقتی usage نیست برآورد مثبت برمی‌گردد (نه 0)', used > 0, used)
}

console.log('۴) trusts the provider when it reports the LARGER input_tokens (full context, cache already folded in for subset):')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 99999, outputTokens: 50, cacheReadTokens: 5000 }),
    ],
  }
  const used = computeContextUsed(chat as any, '', 200000)
  // estimate ~4000; provider reports 99999 input_tokens (full context) → meter trusts it
  check('متر مقدار بزرگتر گزارش‌شده را می‌پذیرد (99999)', used === 99999, used)
}

console.log('۴ب) meter follows the LATEST message inputTokens (the backend input):')
{
  // The meter mirrors the latest main request's input_tokens — the same value
  // that drives auto-compaction. Earlier turns' input_tokens are ignored, and the
  // larger middle turn (9000) does not pin it.
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 5000, outputTokens: 50, contextTokens: 1000 }),
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 9000, outputTokens: 400, contextTokens: 2000 }),
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 4000, outputTokens: 60, contextTokens: 3000 }),
    ],
  }
  const used = computeContextUsed(chat as any, '', 200000)
  check('متر آخرین inputTokens را نشان می‌دهد (4000)', used === 4000, used)
}

console.log('۵) compacted messages are excluded from the estimated context:')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      { ...mkMsg('assistant', { inputTokens: 1, outputTokens: 1 }, 'z'.repeat(400)), compacted: true },
      mkMsg('user', null),
      mkMsg('assistant', { outputTokens: 50 }),
    ],
  }
  const used = computeContextUsed(chat as any, '', 200000)
  const expected = est(chat, '')
  check('متر برآورد تاریخچهٔ غیرِفشرده است', used === expected, { used, expected })
}

console.log('۷) pricing lookup tolerates id mismatches (models/ prefix, bare id):')
{
  const pm = { 'hy3-free': { input: 0.5, output: 1.5, cacheRead: 0.05 } }
  check('exact id matches', priceForModel(pm, 'hy3-free')?.input === 0.5)
  check('models/ prefix matches', priceForModel(pm, 'models/hy3-free')?.input === 0.5)
  check('provider-prefixed bare id matches', priceForModel(pm, 'myhost/hy3-free')?.input === 0.5)
  check('unknown model -> null (renders —)', priceForModel(pm, 'nope') === null)
}

console.log('۸) usage cost splits cached tokens at the cheaper rate (subset convention):')
{
  // One turn of the user's hy3-free session: 3 calls, cache is a SUBSET of input.
  const u = { input: 18194, output: 599, cacheRead: 16512, cacheWrite: 0 }
  const price = { input: 0.5, output: 1.5, cacheRead: 0.05 }
  // non-cache input 1682 * .5 + cache 16512 * .05 + output 599 * 1.5 (per 1M)
  const expected = (1682 / 1e6) * 0.5 + (16512 / 1e6) * 0.05 + (599 / 1e6) * 1.5
  const got = computeUsageCost(price, u)!
  check('cost matches hand-computed value', Math.abs(got - expected) < 1e-9, { got, expected })
  check('null price -> null (renders —)', computeUsageCost(null, u) === null)
}

console.log('۹) computeUsageCost clamps fresh input to 0 when cacheRead > input:')
{
  // اگر provider کش را جزئی از input گزارش نکند (قرارداد Anthropic) و cacheRead > input،
  // بخش fresh (input - cacheRead - cacheWrite) منفی می‌شود. clamp باید آن را صفر کند.
  const u = { input: 5000, output: 100, cacheRead: 8000, cacheWrite: 0 }
  const price = { input: 3.0, output: 15.0, cacheRead: 0.3 }
  const got = computeUsageCost(price, u)!
  // fresh = max(0, 5000 - 8000) = 0 → فقط cacheRead + output
  const expected = (8000 / 1e6) * 0.3 + (100 / 1e6) * 15.0
  check('fresh input خالی می‌شود (نه منفی)', Math.abs(got - expected) < 1e-9, { got, expected })
}

if ((globalThis as any).__FAILED) {
  console.error('\nFAILED')
  process.exit(1)
} else {
  console.log('\nALL PASSED')
}
