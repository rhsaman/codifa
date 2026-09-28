// تست مسیریابی پیام حین compacting: submit باید صف کند نه steer/send مستقیم،
// و تخلیه بعد از compact باید sendQueuedNext را صدا بزند.
// اجرا: npx esbuild tests/queue-during-compact.test.ts --bundle ... && node ...
import './_globals.ts'
const { useStore } = await import('../src/lib/store.ts')
const sends = await import('../src/lib/chatSends.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// سناریو ۱: وقتی compacting روشن است، پیام (متن + عکس + فایل) باید در صف
// با kind: queue ذخیره شود تا بعد از اتمام کامپکت تحویل داده شود.
{
  console.log('── submit حین compacting → queue ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.setChatCompacting(chatId, true)
  // شبیه‌سازی همان کاری که submit در شاخه compacting انجام می‌دهد:
  const v = 'این عکس را بعد کامپکت ببین'
  const atts = ['a.txt']
  const imgs = [{ path: '/tmp/x.png', name: 'x.png', dataUrl: 'data:image/png;base64,AAA' }]
  s.queueMessage(chatId, { id: 'q-compact-1', text: v, attachments: atts, images: imgs, kind: 'queue' })
  const q = useStore.getState().chats.find((c) => c.id === chatId)!.queued![0]
  check('متن در صف است', q.text === v, q)
  check('kind برابر queue است (نه steer)', q.kind === 'queue', q)
  check('عکس با dataUrl حفظ شده', q.images?.length === 1 && q.images[0].dataUrl === 'data:image/png;base64,AAA', q)
  check('فایل حفظ شده', q.attachments?.length === 1 && q.attachments[0] === 'a.txt', q)
  check('هنوز ارسال نشده (sent falsy)', !q.sent, q)
}

// سناریو ۲: بعد از اتمام کامپکت، تخلیه باید پیام صف‌شده را تحویل دهد —
// اول steer معلق (اگر بود)، وگرنه صف. اینجا فقط صف داریم پس sendQueuedNext.
{
  console.log('── تخلیه بعد از compact → sendQueuedNext ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  s.queueMessage(chatId, {
    id: 'q-compact-2',
    text: 'بعد کامپکت',
    attachments: [],
    images: [{ path: '/tmp/y.png', name: 'y.png', dataUrl: 'data:image/png;base64,BBB' }],
    kind: 'queue',
  })
  // رجیستری send خالی است پس sendQueuedNext باید false برگرداند ولی پیام را
  // sent علامت بزند؟ نه — بدون fn باید false و بدون تغییر sent برگردد.
  const drainedWithoutSend = sends.sendQueuedNext(chatId)
  check('بدون send ثبت‌شده، تخلیه false است', drainedWithoutSend === false, drainedWithoutSend)
  // حالا یک send قلابی ثبت می‌کنیم و تخلیه باید متن + عکس + فایل را پاس دهد.
  let got: { text: string; atts: string[]; imgs: Array<{ path: string; name: string; dataUrl?: string }> } | null = null
  sends.registerChatSend(chatId, (text, atts = [], imgs = []) => {
    got = { text, atts, imgs }
  })
  const drained = sends.sendQueuedNext(chatId)
  check('با send ثبت‌شده، تخلیه true است', drained === true, drained)
  check('متن تحویل داده شد', got !== null && (got as typeof got & object).text === 'بعد کامپکت', got)
  check(
    'عکس تحویل داده شد',
    got !== null && (got as typeof got & object).imgs.length === 1 && (got as typeof got & object).imgs[0].dataUrl === 'data:image/png;base64,BBB',
    got,
  )
  const qAfter = useStore.getState().chats.find((c) => c.id === chatId)!.queued![0]
  check('پیام sent علامت خورد', qAfter.sent === true, qAfter)
}

// سناریو ۳: steer معلق بر صف اولویت دارد (همان ترتیب تخلیه پایان ترن).
{
  console.log('── اولویت steer معلق بر صف ──')
  const s = useStore.getState()
  const chatId = s.newChat('ask')
  const pending = s.addMessage(chatId, {
    role: 'user',
    content: 'steer ناتمام',
    attachments: ['b.txt'],
    images: [{ path: '/tmp/z.png', name: 'z.png', dataUrl: 'data:image/png;base64,CCC' }],
    steerPending: true,
  })
  s.queueMessage(chatId, { id: 'q-compact-3', text: 'صفی', kind: 'queue' })
  let gotReuse: string | undefined
  let gotImgs: Array<{ path: string; name: string; dataUrl?: string }> = []
  sends.registerChatSend(chatId, (_text, _atts = [], _imgs = [], _allow, reuseMsgId) => {
    gotReuse = reuseMsgId
    gotImgs = _imgs
  })
  const drainedSteer = sends.sendPendingSteerNext(chatId)
  check('steer معلق تخلیه شد', drainedSteer === true, drainedSteer)
  check('همان پیام visible reuse شد (بدون حباب تکراری)', gotReuse === pending.id, gotReuse)
  check('عکس steer هم پاس داده شد', gotImgs.length === 1 && gotImgs[0].dataUrl === 'data:image/png;base64,CCC', gotImgs)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستهای queue-during-compact پاس شدند ✅')
process.exit(0)
