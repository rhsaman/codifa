// تست رگرسیون پنجرهٔ نمایش چت:
//  - خلاصهٔ تکراری وسط استریم فقط به‌صورت سگمنت درون‌خطی می‌ماند.
//  - پیام‌های compacted نمایشی می‌مانند (خلاصه جایگزین تاریخچه نیست) و در
//    شمارش «Load earlier» هم می‌آیند.
//  - modeSwitch که ChatMessageView برایش null برمی‌گرداند از شمارش بیرون می‌ماند.
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
  check(
    'پیام‌های compacted در پنجرهٔ نمایش می‌مانند',
    visible.some((m) => m.compacted),
    visible.map((m) => ({ id: m.id, compacted: m.compacted })),
  )
  check(
    'پیام قدیمی فولدشده واقعاً قابل‌رندر است',
    visible.some((m) => m.role === 'user' && m.content === 'قدیمی'),
    visible.map((m) => ({ id: m.id, compacted: m.compacted })),
  )
}

// سناریو ۲: کامپکت بین‌ترن‌ها (بدون پیام استریمینگ) — سگمنتی نیست، پس خلاصهٔ
// مستقل می‌ماند و پیام‌های فولدشده (compacted) هم در تاریخچه دیده می‌شوند.
{
  console.log('── compactDedupe: کامپکت بین‌ترن‌ها خلاصه و تاریخچه را نگه می‌دارد ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const foldedUser = s.addMessage(chatId, { role: 'user', content: 'قدیمی' })
  const keptAssistant = s.addMessage(chatId, {
    role: 'assistant',
    content: 'پاسخ تمام‌شده',
  })
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
    'پیام فولدشده (compacted) در پنجره می‌ماند',
    visible.some((m) => m.id === foldedUser.id),
    visible.map((m) => m.id),
  )
  check(
    'پیام نگه‌داشته‌شده هنوز نمایشی است',
    visible.some((m) => m.id === keptAssistant.id),
    visible.map((m) => m.id),
  )
  check(
    'طول پنجره همهٔ پیام‌های قابل‌رندر (از جمله compacted) را می‌شمارد',
    visible.length === msgs.filter((m) => !m.modeSwitch).length,
    { visible: visible.length, total: msgs.length },
  )
}

// سناریو ۳: modeSwitch فقط برای تاریخچهٔ مدل است و رندر نمی‌شود.
{
  console.log('── compactDedupe: پیام modeSwitch رندر نمی‌شود ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const user = s.addMessage(chatId, { role: 'user', content: 'سلام' })
  const switchNote = s.addMessage(chatId, {
    role: 'assistant',
    content: 'mode switched',
    modeSwitch: true,
  })
  const reply = s.addMessage(chatId, { role: 'assistant', content: 'پاسخ' })

  const visible = visibleChatMessages(
    useStore.getState().chats.find((c) => c.id === chatId)!.messages,
  )
  check(
    'modeSwitch از پنجره حذف شده',
    !visible.some((m) => m.id === switchNote.id),
    visible.map((m) => m.id),
  )
  check(
    'پیام‌های عادی نمایشی می‌مانند',
    visible.some((m) => m.id === user.id) && visible.some((m) => m.id === reply.id),
    visible.map((m) => m.id),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌های compactDedupe پاس شدند ✅')
process.exit(0)
