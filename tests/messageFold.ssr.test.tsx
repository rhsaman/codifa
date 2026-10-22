// Folding rule for CHAT MESSAGES (the only place that may open the right-hand
// panel): a merely long message folds to a preview and unfolds IN PLACE, while
// a very long one (a pasted log/dump) keeps the preview and sends the full body
// to the side panel. Tool rows are not involved here — they never leave the
// transcript.
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
const { ChatMessageView, isCollapsibleText, opensInPanel } = await import(
  '../src/components/ChatMessage'
)

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const TAIL = 'tail-marker-not-visible-in-the-folded-bubble'

console.log('1) آستانه‌ها: «قابل تاشدن» جدای از «باز شدن در پنل» است:')
{
  check('۶۰۰ کاراکتر تاشو نیست', !isCollapsibleText('x'.repeat(600)))
  check('۶۰۱ کاراکتر تاشو است', isCollapsibleText('x'.repeat(601)))
  check('۱۰ خط تاشو نیست', !isCollapsibleText(Array(10).fill('a').join('\n')))
  check('۱۱ خط تاشو است', isCollapsibleText(Array(11).fill('a').join('\n')))
  check('۴۰۰۰ کاراکتر در پنل باز نمی‌شود', !opensInPanel('x'.repeat(4000)))
  check('۴۰۰۱ کاراکتر در پنل باز می‌شود', opensInPanel('x'.repeat(4001)))
  check('۲۰۰۰ کاراکتر فقط تاشو است (در پنل نه)', isCollapsibleText('x'.repeat(2000)) && !opensInPanel('x'.repeat(2000)))
}

function userMessage(content: string) {
  return {
    id: 'm-user-fold',
    role: 'user' as const,
    content,
    createdAt: Date.now(),
  }
}

console.log('2) پیام نسبتاً بلند: در چت تا می‌خورد، پنل باز نمی‌شود:')
{
  const long = `${'x'.repeat(800)}\n${TAIL}`
  const html = renderToString(<ChatMessageView message={userMessage(long) as never} />)
  check('دکمهٔ باز کردن هست', html.includes('msg-expand'))
  check('متن تا شده است (دُم دیده نمی‌شود)', !html.includes(TAIL))
}

console.log('3) پیام خیلی بلند: همان دکمه، اما متن کامل در پنل:')
{
  const huge = `${'y'.repeat(6000)}\n${TAIL}`
  const html = renderToString(<ChatMessageView message={userMessage(huge) as never} />)
  check('دکمهٔ «Show more» هست', html.includes('msg-expand'))
  check('پیش‌نمایش کوتاه است', !html.includes(TAIL))
}

console.log('4) پیام کوتاه هیچ دکمه‌ای ندارد:')
{
  const html = renderToString(<ChatMessageView message={userMessage('hello') as never} />)
  check('بدون دکمهٔ باز کردن', !html.includes('msg-expand'), html.slice(0, 300))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log('\nهمهٔ بررسی‌های تاشدن پیام موفق بود')
}
