// SSR sanity for the shared chat bubble (ChatBubble) and actions row
// (MessageActionsBar) — the components the schedule inbox and reading mode
// render through, so their bubbles look and behave exactly like chat.
// Run via tests/run-frontend.sh.
import React from 'react'
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

const { renderToString } = await import('react-dom/server')
const { ChatBubble } = await import('../src/components/ChatBubble')
const { MessageActionsBar } = await import('../src/components/MessageActionsBar')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) ChatBubble — محتوای فارسی:')
{
  const html = renderToString(
    <ChatBubble id="run-1" content="سلام این **متن** فارسی است با 1.10–1.16" />,
  )
  check('کلاس chat-bubble دارد', html.includes('chat-bubble'), html.slice(0, 200))
  check('dir=rtl از خود محتوا', /class="msg chat-bubble[^"]*" dir="rtl"/.test(html))
  check('حباب msg-bubble دارد', html.includes('msg-bubble'))
  check('متن رندر شده', html.includes('متن'))
  check('ردیف اکشن‌ها هست', html.includes('msg-actions'), html.slice(0, 400))
  check('دکمه کپی هست', html.includes('Copy message'))
  check('بدون فورک در حالت پیش‌فرض', !html.includes('Fork chat'))
  check('بدون خواندن در حالت پیش‌فرض', !html.includes('Reading mode'))
}

console.log('2) ChatBubble — محتوای انگلیسی → dir=ltr:')
{
  const html = renderToString(<ChatBubble id="run-2" content="Hello world" />)
  check('dir=ltr', /class="msg chat-bubble[^"]*" dir="ltr"/.test(html))
}

console.log('3) ChatBubble — usage و ساعت:')
{
  const html = renderToString(
    <ChatBubble
      id="run-3"
      content="گزارش"
      usage={{ inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }}
      turnElapsedMs={32800}
    />,
  )
  check('UsageBadge رندر شد', html.includes('msg-usage'), html.slice(0, 400))
  // ساعت/تاریخ حذف شده — فقط تایمر مدت (msg-elapsed) می‌ماند.
  check('تایمر رندر شد', html.includes('msg-elapsed'))
  check('ساعت/تاریخ دیگر نیست', !html.includes('msg-clocks') && !html.includes('msg-time'))
}

console.log('4) MessageActionsBar — fork/read با پراپ فعال می‌شوند:')
{
  const html = renderToString(
    <MessageActionsBar
      text="سلام"
      fork
      onFork={() => {}}
      read
      onRead={() => {}}
    />,
  )
  check('فورک هست', html.includes('Fork chat'))
  check('خواندن هست', html.includes('Reading mode'))
  // هندسه ثابت: گروه وضعیت چپ، گروه ابزار راست — ردیف دیگر dir نمی‌گیرد.
  check('گروه ابزار هست', html.includes('msg-actions-tools'))
}

console.log('5) MessageActionsBar — بدون متن فقط children:')
{
  const html = renderToString(
    <MessageActionsBar text="">
      <span className="x-notice">notice</span>
    </MessageActionsBar>,
  )
  check('کپی نمی‌آید', !html.includes('Copy message'))
  check('children رندر شد', html.includes('x-notice'))
  check('گروه وضعیت با children هست', html.includes('msg-actions-status'))
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks`)
  process.exit(1)
}
console.log('\nAll chatBubble SSR checks passed')
