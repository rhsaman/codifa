import './_globals.ts'
import { useStore } from '../src/lib/store.ts'
import { modelContextWindow, contextPercent } from '../src/lib/context.ts'

function check(name: string, cond: any, extra?: any) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    if (extra !== undefined) console.log('    got:', JSON.stringify(extra))
    ;(globalThis as any).__FAILED = true
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۱) modelContextWindow — پنجرهی کانتکست مدل عدد واقعی را برمیگرداند (نوار بالا):')
{
  // Per-model lookup from the provider's contextMap (bare id).
  const p1 = {
    id: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o'],
    contextMap: { 'gpt-4o': 128000 },
    contextWindow: 0,
  } as any
  check('از contextMap (id خالص) عدد واقعی برمیگردد', modelContextWindow(p1, 'gpt-4o') === 128000, modelContextWindow(p1, 'gpt-4o'))

  // Prefixed key lookup (model stored as "provider/model").
  const p2 = {
    id: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o'],
    contextMap: { 'openai/gpt-4o': 128000 },
    contextWindow: 0,
  } as any
  check('از contextMap (id پیشونددار) عدد واقعی برمیگردد', modelContextWindow(p2, 'gpt-4o') === 128000, modelContextWindow(p2, 'gpt-4o'))

  // Provider-level fallback when no per-model entry exists.
  const p3 = {
    id: 'x',
    name: 'X',
    models: ['m1'],
    contextMap: {},
    contextWindow: 200000,
  } as any
  check('fallback روی provider.contextWindow عدد واقعی است', modelContextWindow(p3, 'm1') === 200000, modelContextWindow(p3, 'm1'))

  // When the backend supplies ANY context (our fix guarantees this), the bar must
  // never fall back to showing a blank/“—”. A genuinely unknown provider returns
  // null only when nothing is configured at all.
  check('اگر کانتکستی هست خالی برنمیگردد', modelContextWindow(p1, 'gpt-4o') != null)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۲) contextPercent — درصد مصرف کانتکست عدد واقعی است (نوار بالا):')
{
  check('۵۰٪ برای نیمه پنجره', contextPercent(50000, 100000) === 50, contextPercent(50000, 100000))
  check('۰٪ برای مصرف صفر', contextPercent(0, 100000) === 0, contextPercent(0, 100000))
  check('درصد رند شدهٔ واقعی (۱۲٪ برای ۱۲٫۳۴۵٪)', contextPercent(12345, 100000) === 12, contextPercent(12345, 100000))
  check('اگر پنجره نامعلوم است null برمیگردد', contextPercent(100, null) == null, contextPercent(100, null))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۳) فروشگاه — accrueChatUsage مصرف واقعی هر (پرووایدر، مدل) را (تجمعی) نگه میدارد (ستون کناری):')
{
  const st = useStore.getState()
  const chatId = st.newChat('ask')
  // Simulate two real `usage` events for the same model across turns.
  useStore.getState().accrueChatUsage(chatId, 'openai', 'gpt-4o', { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
  useStore.getState().accrueChatUsage(chatId, 'openai', 'gpt-4o', { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 })
  const entries = useStore.getState().chats.find((c) => c.id === chatId)!.usage!.entries
  const u1 = entries.find((e) => e.providerId === 'openai' && e.model === 'gpt-4o')!
  check('مجموع تجمعیِ input درست است (۱۵۰)', u1?.input === 150, u1)
  check('مجموع تجمعیِ output درست است (۱۵)', u1?.output === 15, u1)

  // A different model accrues into its own entry (sidebar lists per-model).
  useStore.getState().accrueChatUsage(chatId, 'anthropic', 'claude-3-5-sonnet', { input: 200, output: 20, cacheRead: 100, cacheWrite: 0 })
  const ch = useStore.getState().chats.find((c) => c.id === chatId)!
  check('مدل دوم دانهی جداگانه دارد', ch.usage!.entries.find((e) => e.providerId === 'anthropic' && e.model === 'claude-3-5-sonnet')?.input === 200, ch.usage)
  check('مدل اول تغییر نکرده', ch.usage!.entries.find((e) => e.providerId === 'openai' && e.model === 'gpt-4o')?.input === 150, ch.usage)
  check('cache read واقعی ثبت شده', ch.usage!.entries.find((e) => e.providerId === 'anthropic' && e.model === 'claude-3-5-sonnet')?.cacheRead === 100, ch.usage)

  // resetChatUsage clears the sidebar counters.
  useStore.getState().resetChatUsage(chatId)
  const cleared = useStore.getState().chats.find((c) => c.id === chatId)!.usage
  check('resetChatUsage همه را پاک میکند', cleared == null || cleared.entries.length === 0, cleared)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('۴) پیام دستیار — usage رویداد عدد مصرفشدهی واقعی را نگه میدارد (نوار بالا contextUsed):')
{
  const st = useStore.getState()
  const chatId = st.newChat('ask')
  const msg = useStore.getState().addMessage(chatId, { role: 'assistant', content: 'done' })
  // This is exactly what Chat.tsx does on a `usage` event (line ~1798).
  useStore.getState().updateMessage(msg.id, {
    usage: { inputTokens: 7321, outputTokens: 412, totalTokens: 7733, cacheReadTokens: 5000, cacheWriteTokens: 0 },
  })
  const updated = useStore.getState().chats.find((c) => c.id === chatId)!.messages.find((m) => m.id === msg.id)!
  // App bar consumed context = inputTokens + outputTokens of the last assistant msg.
  const consumed = (updated.usage?.inputTokens ?? 0) + (updated.usage?.outputTokens ?? 0)
  check('inputTokens واقعی روی پیام نشسته', updated.usage?.inputTokens === 7321, updated.usage)
  check('outputTokens واقعی روی پیام نشسته', updated.usage?.outputTokens === 412, updated.usage)
  check('contextUsed واقعی است (۷۷۳۳ نه تخمین)', consumed === 7733, consumed)
  check('cache read واقعی روی پیام نشسته', updated.usage?.cacheReadTokens === 5000, updated.usage)
}

console.log((globalThis as any).__FAILED ? '\n✗ برخی تستها شکست خوردند' : '\n✓ همه تستها پاس شدند')
process.exit((globalThis as any).__FAILED ? 1 : 0)
