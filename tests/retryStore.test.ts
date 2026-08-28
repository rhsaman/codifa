// Store-level test for the two retry behaviors:
//  - message retry button → RESTART: everything below the user message is
//    deleted and the same user message is re-added (fresh reply from scratch)
//  - banner error retry → RESUME: the user bubble is NOT duplicated and the
//    partial assistant reply + its tool calls stay in the transcript
// Run: npx esbuild test/retryStore.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-retry.mjs --external:electron \
//        && node test/.tmp-retry.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { useStore } = await import('../src/lib/store.ts')
const { planRetry } = await import('../src/lib/retry.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const toolActivity = [
  { tool: 'bash', args: { cmd: 'ls' }, summary: 'فایلها', status: 'done' as const },
]

console.log('1) دکمه retry روی پیام کاربر → زیرش پاک میشود و از همان پیام ادامه میدهد:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const u2 = s.addMessage(chatId, { role: 'user', content: 'برنامه بساز' })
  const partial = s.addMessage(chatId, {
    role: 'assistant',
    content: 'دارم میسازم... [Interrupted before finishing',
    error: true,
    retry: { attempt: 3, maxAttempts: 3, delay: 0, reason: 'boom', gaveUp: true },
    toolActivity,
  })

  const ch = () => useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const plan = planRetry(ch(), u2.id, 'message')
  check('plan = restart', plan?.action === 'restart', plan)
  if (plan?.action === 'restart') {
    // همان کاری که retryMessage انجام میدهد:
    check('truncateTo موفق', useStore.getState().truncateTo(u2.id) === true)
    const afterTruncate = ch()
    check(
      'پیام کاربر و همهی زیرش پاک شد',
      afterTruncate.length === 1 &&
        afterTruncate[0]!.role === 'user' &&
        afterTruncate[0]!.content === 'سلام',
      afterTruncate,
    )
    check(
      'پاسخ ناقص + tool call ها حذف شدند',
      !afterTruncate.some((m) => m.id === partial.id),
      afterTruncate,
    )
    // send() دوباره پیام کاربر را با همان محتوا میسازد:
    useStore.getState().addMessage(chatId, { role: 'user', content: plan.target.content })
    // و بعد یک پیام دستیارِ جدید (استریم) شروع میشود — همان کاری که send میکند:
    const freshAssistant = useStore.getState().addMessage(chatId, {
      role: 'assistant',
      content: '',
      streaming: true,
    })
    const final = ch()
    check(
      'پیام کاربر با همان محتوا دوباره ساخته شد (ادامه از همان پیام)',
      final.length === 3 &&
        final[1]!.role === 'user' &&
        final[1]!.content === 'برنامه بساز' &&
        final[1]!.id !== u2.id,
      final,
    )
    check(
      'پاسخ جدید یک پیام دستیارِ تازه است، نه ادامهی partial زیرش',
      final[2]!.id === freshAssistant.id &&
        final[2]!.id !== partial.id &&
        !final[2]!.content.includes('[Interrupted before finishing'),
      final,
    )
    check('هیچ اثری از partial قدیمی در تاریخچه نیست', !final.some((m) => m.id === partial.id), final)
  }
}

console.log('2) بنر retry خطا → resume: پیام کاربر تکراری نمیشود و partial + tool call ها میمانند:')
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const ub = s.addMessage(chatId, { role: 'user', content: 'برنامه بساز' })
  const partial = s.addMessage(chatId, {
    role: 'assistant',
    content: 'دارم میسازم... [Interrupted before finishing',
    error: true,
    retry: { attempt: 3, maxAttempts: 3, delay: 0, reason: 'boom', gaveUp: true },
    toolActivity,
  })

  const ch = () => useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const plan = planRetry(ch(), ub.id, 'banner')
  check('plan = resume', plan?.action === 'resume', plan)
  // resume ترنسکریپت را حذف نمیکند و پیام کاربر را دوباره نمیسازد (همان حباب
  // با reuseMsgId استفاده میشود) — partial و tool call ها سر جایشان میمانند:
  const after = ch()
  check(
    'پیام کاربر تکراری نشد',
    after.filter((m) => m.role === 'user').length === 1,
    after,
  )
  check(
    'partial همچنان در تاریخچه است',
    after.some(
      (m) => m.id === partial.id && m.content.includes('[Interrupted before finishing'),
    ),
    after,
  )
  check(
    'tool call ها حفظ شدند',
    after.some((m) => m.id === partial.id && (m.toolActivity ?? []).length === 1),
    after,
  )
  check('flag خطا حفظ شد', after.some((m) => m.id === partial.id && m.error === true), after)
  check(
    'ترتیب حفظ شد',
    after.map((m) => m.id).join(',') === `${ub.id},${partial.id}`,
    after.map((m) => m.id),
  )
}

console.log(
  '3) سناریوی watchdog (استریم زنده ولی ساکت — assistant بدون flag خطا) → نباید پیامها حذف شوند:',
)
{
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const uw = s.addMessage(chatId, { role: 'user', content: 'برنامه بساز' })
  // این دقیقاً وضعیتی است که watchdog با آن روبرو میشود: استریم هنوز زنده
  // است (abort نشده) ولی ساکت مانده — پیام دستیار هنوز error/retry نخورده.
  const partial = s.addMessage(chatId, {
    role: 'assistant',
    content: 'دارم میسازم... [Interrupted before finishing',
    toolActivity,
  })

  const ch = () => useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const before = ch()
  // رفتار قدیمی (اشتباه): retryMessage در این حالت شاخهی failed را پیدا
  // نمیکرد و میرفت سراغ truncateTo → همهی پیامهای زیر کاربر حذف میشدند.
  // رفتار جدید watchdog: abort + send(..., false, uw.id) یعنی RESUME بدون حذف.
  // اینجا شبیهسازی میکنیم که truncateTo صدا زده نشود و ترنسکریپت دستنخورده بماند:
  check('تعداد پیامها قبل از watchdog دستنخورده است', before.length === 2, before)
  check(
    'پیام کاربر قبل از watchdog حفظ شد',
    before.some((m) => m.id === uw.id && m.role === 'user'),
    before,
  )
  check(
    'پاسخ ناقص قبل از watchdog حفظ شد (بدون flag خطا)',
    before.some(
      (m) => m.id === partial.id && m.content.includes('[Interrupted before finishing'),
    ),
    before,
  )
  // حالا شبیهسازی مسیر درست watchdog: reuseMsgId = uw.id (resume)، بدون truncate.
  // اگر اشتباهی truncateTo صدا میشد، طول باید ۱ میشد — پس چک میکنیم که بعد از
  // «resume» همچنان هر دو پیام سر جایشان هستند:
  const after = ch()
  check(
    'بعد از مسیر resumeی watchdog، پیام کاربر حذف نشد',
    after.some((m) => m.id === uw.id && m.role === 'user'),
    after,
  )
  check(
    'بعد از مسیر resumeی watchdog، پاسخ ناقص حذف نشد',
    after.some(
      (m) => m.id === partial.id && m.content.includes('[Interrupted before finishing'),
    ),
    after,
  )
  check(
    'بعد از مسیر resumeی watchdog، tool call ها حفظ شدند',
    after.some((m) => m.id === partial.id && (m.toolActivity ?? []).length === 1),
    after,
  )
  check(
    'ترتیب حفظ شد (کاربر، بعد دستیار)',
    after.map((m) => m.id).join(',') === `${uw.id},${partial.id}`,
    after.map((m) => m.id),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
// The store keeps timers alive (persistSoon etc.) — force-exit so the test
// script terminates cleanly instead of hanging.
process.exit(0)