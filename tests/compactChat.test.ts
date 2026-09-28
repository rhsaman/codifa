// تستِ compactChat: اطمینان از اینکه خلاصه در انتهای آرایه اضافه می‌شود،
// پیام‌های قدیمی فولد می‌شوند و خلاصهٔ قبلی هم فولد می‌شود (بدون حذف/تریم آرایه).
// اجرا: npm run test:frontend (از طریق test/run-frontend.sh)
import './_globals.ts'
const { useStore } = await import('../src/lib/store.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// سناریو ۱: خلاصه در انتهای آرایه اضافه می‌شود و پیام‌های قدیمی فولد می‌شوند.
{
  console.log('── compactChat: فولد پیام‌های قدیمی + افزودن خلاصه در انتها ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  // ۴ پیام غیرسیستم: ۲ قدیمی (باید فولد شوند) + ۲ اخیر (باید verbatim بمانند).
  s.addMessage(chatId, { role: 'user', content: 'قدیمی ۱' })
  s.addMessage(chatId, { role: 'assistant', content: 'قدیمی ۲' })
  s.addMessage(chatId, { role: 'user', content: 'اخیر ۱' })
  s.addMessage(chatId, { role: 'assistant', content: 'اخیر ۲' })

  s.compactChat(chatId, '[Compacted earlier context]\nخلاصه جدید', 2)

  const msgs = useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const summary = msgs[msgs.length - 1]
  check('خلاصه در انتهای آرایه است', summary.role === 'system' && summary.content === '[Compacted earlier context]\nخلاصه جدید', summary)
  check('تعداد پیام‌ها تغییر نکرده (فولد درجا)', msgs.length === 5, msgs.length)
  check('۲ پیام قدیمی فولد شده‌اند', msgs.filter((m) => m.compacted).length === 2, msgs.map((m) => m.compacted))
  check('۲ پیام اخیر verbatim مانده‌اند', msgs.filter((m) => !m.compacted && m.role !== 'system').length === 2, msgs.map((m) => m.compacted))
}

// سناریو ۲: روی کامپکتِ تکراری، خلاصهٔ قبلی هم فولد می‌شود (فقط جدیدترین بلاک نمایش داده شود).
{
  console.log('── compactChat: فولد خلاصهٔ قبلی روی کامپکت تکراری ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.addMessage(chatId, { role: 'user', content: 'اولیه' })
  s.addMessage(chatId, { role: 'assistant', content: 'پاسخ اولیه' })
  // کامپکت اول
  s.compactChat(chatId, '[Compacted earlier context]\nخلاصه اول', 1)
  // یک پیام جدید بعد از کامپکت
  s.addMessage(chatId, { role: 'user', content: 'جدید' })
  s.addMessage(chatId, { role: 'assistant', content: 'پاسخ جدید' })
  // کامپکت دوم
  s.compactChat(chatId, '[Compacted earlier context]\nخلاصه دوم', 1)

  const msgs = useStore.getState().chats.find((c) => c.id === chatId)!.messages
  const summaries = msgs.filter((m) => m.role === 'system')
  // خلاصهٔ قبلی فولد می‌شود اما از آرایه حذف نمی‌شود (در scrollback می‌ماند)؛
  // پس ۲ پیام system داریم: یکی فولدشده (قدیمی) و یکی جدید در انتها (فولد نشده).
  check('۲ پیام system (قدیمی فولدشده + جدید در انتها)', summaries.length === 2, summaries.map((m) => m.content))
  const lastSummary = summaries[summaries.length - 1]
  check('آخرین خلاصه در انتها، فولد نشده', lastSummary.content === '[Compacted earlier context]\nخلاصه دوم' && !lastSummary.compacted, lastSummary)
  check('خلاصهٔ قبلی فولد شده (در scrollback)', msgs.some((m) => m.compacted && m.content === '[Compacted earlier context]\nخلاصه اول'), msgs.map((m) => ({ c: m.content, f: m.compacted })))
}

// سناریو ۳: پیام صف‌شده حین کامپکت باید attachments و images را حفظ کند تا بعد
// از اتمام کامپکت کامل تحویل داده شود (رگرسیون باگ حذف عکس در queue).
{
  console.log('── queue حین compacting: حفظ عکس و فایل ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.setChatCompacting(chatId, true)
  s.queueMessage(chatId, {
    id: 'q-img-1',
    text: 'این عکس را ببین',
    attachments: ['a.txt'],
    images: [{ path: '/tmp/x.png', name: 'x.png', dataUrl: 'data:image/png;base64,AAA' }],
    kind: 'queue',
  })
  const q = useStore.getState().chats.find((c) => c.id === chatId)!.queued![0]
  check('متن صف حفظ شده', q.text === 'این عکس را ببین', q)
  check('attachments حفظ شده', q.attachments?.length === 1 && q.attachments[0] === 'a.txt', q)
  check('images با dataUrl حفظ شده', q.images?.length === 1 && q.images[0].dataUrl === 'data:image/png;base64,AAA', q)
  check('پرچم compacting روشن است', useStore.getState().chats.find((c) => c.id === chatId)!.compacting === true)
  // پایان کامپکت: پرچم می‌افتد ولی صف می‌ماند تا تخلیه شود
  s.setChatCompacting(chatId, false)
  const qAfter = useStore.getState().chats.find((c) => c.id === chatId)!.queued!.filter((x) => !x.sent)
  check('صف بعد از کامپکت هنوز برای تحویل هست', qAfter.length === 1 && qAfter[0].images?.length === 1, qAfter)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستهای compactChat پاس شدند ✅')
process.exit(0)
