// تست رگرسیون حذف رندر تکراری سامری: اتو-کامپکت وسط استریم نباید دو بلوک
// Context summary بسازد — فقط سگمنت درون‌خطی داخل پیام استریمینگ می‌ماند و
// نسخه مستقل ته لیست از رندر حذف می‌شود. بین‌ترن‌ها (بدون سگمنت) همان پیام
// مستقل نمایش داده می‌شود.
// اجرا: npm run test:frontend (از طریق tests/run-frontend.sh)
import './_globals.ts'
const { useStore } = await import('../src/lib/store.ts')
const { visibleChatMessages } = await import('../src/lib/compactDedupe.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// سناریو ۱: کامپکت وسط استریم — خلاصه هم درون‌خطی (سگمنت compact) و هم ته
// لیست هست؛ لیست نمایشی فقط نسخه درون‌خطی را نگه می‌دارد.
{
  console.log('── compactDedupe: کامپکت وسط استریم فقط یک بلوک نمایشی دارد ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'قدیمی' })
  const streamingMsg = s.addMessage(chatId, {
    role: 'assistant',
    content: 'پاسخ در حال استریم',
    streaming: true,
  })
  const streamingId = streamingMsg.id
  s.compactChat(chatId, '[Compacted earlier context]\nخلاصه وسط استریم', 1)

  const msgs = useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const summary = msgs[msgs.length - 1]
  check('خلاصه در انتهای آرایه ذخیره شده', summary.role === 'system', summary)
  const streaming = msgs.find((m) => m.id === streamingId)!
  check(
    'سگمنت compact روی پیام استریمینگ هست',
    (streaming.segments ?? []).some(
      (seg) => seg.kind === 'compact' && seg.id === summary.id,
    ),
    streaming.segments,
  )

  const visible = visibleChatMessages(msgs)
  check(
    'نسخه مستقل ته لیست از رندر حذف شده',
    !visible.some((m) => m.id === summary.id),
    visible.map((m) => m.id),
  )
  check(
    'پیام استریمینگ (حامل سگمنت درون‌خطی) هنوز نمایشی است',
    visible.some((m) => m.id === streamingId),
    visible.map((m) => m.id),
  )
  check(
    'فقط یک بلوک خلاصه قابل‌مشاهده است (درون‌خطی)',
    visible.filter((m) =>
      (m.segments ?? []).some((seg) => seg.kind === 'compact'),
    ).length === 1,
    visible.map((m) => m.segments),
  )
}

// سناریو ۲: کامپکت بین‌ترن‌ها (بدون پیام استریمینگ) — سگمنتی نیست پس همان
// پیام مستقل ته لیست نمایش داده می‌شود.
{
  console.log('── compactDedupe: کامپکت بین‌ترن‌ها پیام مستقل را نگه می‌دارد ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'قدیمی' })
  s.addMessage(chatId, { role: 'assistant', content: 'پاسخ تمام‌شده' })
  s.compactChat(chatId, '[Compacted earlier context]\nخلاصه بین‌ترن', 1)

  const msgs = useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const summary = msgs[msgs.length - 1]
  const visible = visibleChatMessages(msgs)
  check(
    'بدون سگمنت، خلاصه مستقل نمایشی می‌ماند',
    visible.some((m) => m.id === summary.id),
    visible.map((m) => m.id),
  )
  check(
    'بدون سگمنت، همه پیام‌ها نمایشی‌اند',
    visible.length === msgs.length,
    { visible: visible.length, total: msgs.length },
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستهای compactDedupe پاس شدند ✅')
process.exit(0)
