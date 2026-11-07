// SSR sanity test for the ONE footer notice slot.
//
// The transcript-end RetryBanner is gone; every notice now renders in the
// footer of the last message (or of the message that owns the failure). These
// checks pin the visible contract:
//  - a failed/interrupted TURN offers Retry (resume path),
//  - a failed COMPACTION offers Retry through its own action,
//  - a non-retryable command error offers no Retry button,
//  - compaction renders a determinate percent bar (not a frozen 0%),
//  - the user bubble's action says Regenerate, not Retry.
//
// Run via tests/run-frontend.sh (bundled with esbuild).
;(globalThis as any).window = {
  addEventListener: () => {},
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}
;(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { renderToString } = await import('react-dom/server')
const { ChatMessageView } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

function assistant(extra: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    role: 'assistant' as const,
    content: 'نیمهٔ پاسخ',
    createdAt: 1,
    streaming: false,
    ...extra,
  }
}

console.log('1) نوبت شکست‌خورده → دکمهٔ Retry در فوتر (resume):')
{
  const msg = assistant({
    error: true,
    errorReason: 'provider rejected the request',
  })
  const html = renderToString(
    <ChatMessageView message={msg as never} onResume={() => {}} onRetry={() => {}} />,
  )
  check('دکمهٔ فوتر رندر شد', html.includes('msg-retry-inline-btn'), html)
  check('برچسب Retry دارد', html.includes('Retry'), html)
  check('ردیف failed دارد', html.includes('failed'), html)
}

console.log('2) قطع وسط نوبت (interrupted) → دکمهٔ Retry دارد:')
{
  const msg = assistant({ interrupted: true })
  const html = renderToString(
    <ChatMessageView message={msg as never} onResume={() => {}} />,
  )
  check('دکمهٔ فوتر رندر شد', html.includes('msg-retry-inline-btn'), html)
  check('متن interrupted دارد', html.includes('Interrupted'), html)
}

console.log('3) پیشرفت کامپکت → درصد و نوار determinate:')
{
  const msg = assistant({
    footerStatus: {
      kind: 'compact',
      text: 'summarizing',
      percent: 42,
    },
  })
  const html = renderToString(<ChatMessageView message={msg as never} />)
  check('درصد ۴۲٪ رندر شد', html.includes('42%'), html)
  check('progressbar دارد', html.includes('progressbar'), html)
  check('عرض نوار ۴۲٪ است', html.includes('width:42%'), html)
  check('دکمهٔ Retry ندارد', !html.includes('msg-retry-inline-btn'), html)
}

console.log('4) شکست کامپکت → دکمهٔ Retry مخصوص کامپکت:')
{
  const msg = assistant({
    footerStatus: {
      kind: 'error',
      text: 'Automatic compaction failed — nothing was deleted.',
      action: 'compact-retry',
    },
  })
  const html = renderToString(
    <ChatMessageView
      message={msg as never}
      onResume={() => {}}
      onCompactRetry={() => {}}
      onRetry={() => {}}
    />,
  )
  check('دکمهٔ فوتر رندر شد', html.includes('msg-retry-inline-btn'), html)
}

console.log('5) خطای غیرقابل‌ریترای (cmdError) → بدون دکمه:')
{
  const msg = assistant({
    footerStatus: { kind: 'error', text: 'Microphone unavailable' },
  })
  const html = renderToString(
    <ChatMessageView
      message={msg as never}
      onResume={() => {}}
      onCompactRetry={() => {}}
      onRetry={() => {}}
    />,
  )
  check('دکمهٔ Retry رندر نشد', !html.includes('msg-retry-inline-btn'), html)
  check('متن خطا دیده می‌شود', html.includes('Microphone unavailable'), html)
}

console.log('6) آیکن پیام کاربر → Regenerate (نه Retry):')
{
  const msg = {
    id: 'u1',
    role: 'user' as const,
    content: 'این را از نو بساز',
    createdAt: 1,
  }
  const html = renderToString(
    <ChatMessageView message={msg as never} onRetry={() => {}} />,
  )
  check('title=Regenerate دارد', html.includes('title="Regenerate"'), html)
  check(
    'aria-label توضیح می‌دهد که از نو می‌سازد',
    html.includes('generate it again from scratch'),
    html,
  )
  check('دیگر title=Retry ندارد', !html.includes('title="Retry"'), html)
}

console.log('7) ریترای ساب‌ایجنت → مدل + تول‌ها، ارور فقط در تول‌کارت:')
{
  const msg = assistant({
    streaming: true,
    retry: {
      attempt: 1,
      maxAttempts: 10,
      delay: 0,
      reason: 'error sending request for url — trying the next model',
      model: 'glm-4.6',
      agent: 'explore subagent',
      tool: 'explore',
      fallback: true,
      reconnecting: true,
      inline: true,
    },
    toolActivity: [
      {
        tool: 'explore',
        status: 'running',
        model: 'glm-4.6',
        children: [
          { tool: 'read', status: 'done' },
          { tool: 'read', status: 'done' },
          { tool: 'grep', status: 'done' },
        ],
      },
    ],
  })
  const html = renderToString(<ChatMessageView message={msg as never} />)
  check('اسم مدل ساب‌ایجنت رندر شد', html.includes('glm-4.6'), html)
  check('ردیف تول‌ها رندر شد', html.includes('msg-retry-inline-tools'), html)
  check('شمارش ×2 برای Read File هست', html.includes('×2'), html)
  // خطا در خط جمع‌شده نمایش داده نمی‌شود (درخواست کاربر) اما از طریق
  // کارت hover در دسترس است — وگرنه هیچ‌جا دیده نمی‌شد.
  check('ردیف ارور رندر نشد', !html.includes('msg-retry-inline-reason'), html)
  check('عبارت switched model نیست', !html.includes('switched model'), html)
  check('تول‌کارت full-error هست (خطا با hover دیده می‌شود)', html.includes('data-full-error'), html)
}

console.log('8) تسلیم ساب‌ایجنت (gaveUp) → ارور ترمینال می‌ماند:')
{
  const msg = assistant({
    retry: {
      attempt: 10,
      maxAttempts: 10,
      delay: 0,
      reason: 'error sending request: connect timeout',
      model: 'glm-4.6',
      agent: 'explore subagent',
      tool: 'explore',
      gaveUp: true,
      fallback: true,
      inline: true,
    },
    toolActivity: [{ tool: 'explore', status: 'error', children: [] }],
  })
  const html = renderToString(
    <ChatMessageView message={msg as never} onResume={() => {}} />,
  )
  check('دکمهٔ Retry هست', html.includes('msg-retry-inline-btn'), html)
  check('ارور ترمینال دیده می‌شود', html.includes('error sending request'), html)
}

console.log('9) سوییچ مدل قبل از اولین تول (تالی خالی) → خطا فقط در تول‌کارت:')
{
  const msg = assistant({
    streaming: true,
    retry: {
      attempt: 1,
      maxAttempts: 10,
      delay: 0,
      reason: 'provider sent no response and no retry info — trying the next model',
      model: 'cbai/deepseek-v4.1-flash',
      agent: 'explore subagent',
      tool: 'explore',
      fallback: true,
      reconnecting: true,
      inline: true,
    },
    // The sub-agent's FIRST LLM call failed: the run exists but has called no
    // tools yet — the exact screenshot case where the error used to leak.
    toolActivity: [{ tool: 'explore', status: 'running', children: [] }],
  })
  const html = renderToString(<ChatMessageView message={msg as never} />)
  check('اسم مدل رندر شد', html.includes('cbai/deepseek-v4.1-flash'), html)
  check('ردیف ارور اصلاً رندر نشد', !html.includes('msg-retry-inline-reason'), html)
  check('ردیف تول‌های خالی رندر نشد', !html.includes('msg-retry-inline-tools'), html)
  // خطا در خط دیده نمی‌شود ولی از طریق کارت hover در دسترس است — با این حال
  // یک لبهٔ نردبانِ بدون هیچ اطلاعاتی دیگر، کاملاً بی‌صدا نیست.
  check('تول‌کارت full-error هست (خطا فقط با hover)', html.includes('data-full-error'), html)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌های inlineRetry پاس شدند ✅')
process.exit(0)
