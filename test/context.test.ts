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

console.log('۴) trusts the provider when it reports the LARGER full context (incl. cache):')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50, totalTokens: 99999, cacheReadTokens: 5000 }),
    ],
  }
  const used = computeContextUsed(chat as any, '', 200000)
  // estimate ~4000; provider reports 99999 (full context incl. cache) → meter trusts it
  check('متر مقدار بزرگتر گزارش‌شده را می‌پذیرد (99999)', used === 99999, used)
}

console.log('۵) compacted messages are excluded from the estimated context:')
{
  const chat = {
    messages: [
      mkMsg('user', null),
      { ...mkMsg('assistant', { inputTokens: 1, outputTokens: 1 }, 'z'.repeat(400)), compacted: true },
      mkMsg('user', null),
      mkMsg('assistant', { inputTokens: 100, outputTokens: 50 }),
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

if ((globalThis as any).__FAILED) {
  console.error('\nFAILED')
  process.exit(1)
} else {
  console.log('\nALL PASSED')
}
