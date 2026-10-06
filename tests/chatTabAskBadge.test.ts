// SSR test for the chat-tab ask/permission badges (run via tests/run-frontend.sh).
// ChatTabBar shows the same sidebar ask / PERMISSION REQUIRED badge on each
// tab, so a chat waiting on the user stays visible while the sidebar is closed.
//
// Mock the Electron/browser bridge before importing the component (the store
// module touches `window.coder` at import time).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { TabPendingBadges } = await import('../src/components/ChatTabBar')
const { windowStatusFor } = await import('../src/lib/chatWindowStatus')

const el = React.createElement

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

console.log('1) permission tab badge (amber shield, same as sidebar):')
{
  const html = renderToString(
    el(TabPendingBadges, {
      pendingPermission: { action: 'rm', path: '/tmp/x' },
      pendingAsk: null,
    }),
  )
  check('renders', html.length > 0)
  check('has chat-item-pending permission class', html.includes('chat-item-pending permission'))
  check('has no ask class', !html.includes('chat-item-pending ask'))
  check('title names the action and path', html.includes('Needs permission: rm') && html.includes('/tmp/x'))
  check('has the shield icon', html.includes('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'))
}

console.log('2) ask tab badge (blue question mark, same as sidebar):')
{
  const html = renderToString(
    el(TabPendingBadges, { pendingPermission: null, pendingAsk: { question: 'Continue?' } }),
  )
  check('renders', html.length > 0)
  check('has chat-item-pending ask class', html.includes('chat-item-pending ask'))
  check('has no permission class', !html.includes('chat-item-pending permission'))
  check('title shows the question', html.includes('Asks you:') && html.includes('Continue?'))
}

console.log('3) both pending at once (permission first, like the sidebar):')
{
  const html = renderToString(
    el(TabPendingBadges, {
      pendingPermission: { action: 'write' },
      pendingAsk: { question: 'Which file?' },
    }),
  )
  check('has both badges', html.includes('chat-item-pending permission') && html.includes('chat-item-pending ask'))
  check(
    'permission badge comes first',
    html.indexOf('chat-item-pending permission') < html.indexOf('chat-item-pending ask'),
  )
}

console.log('4) nothing pending renders nothing:')
{
  const html = renderToString(el(TabPendingBadges, { pendingPermission: null, pendingAsk: null }))
  check('renders empty', html.trim() === '', JSON.stringify(html))
}

console.log('5) window header status (same language as sidebar and tabs):')
{
  const streaming = { messages: [{ streaming: true }], pendingPermission: null, pendingAsk: null }
  const s1 = windowStatusFor(streaming, 'c1', 'c2', [])
  check('streaming dot while agent works', s1.streaming === true && s1.unread === false)
  const done = { messages: [{}], pendingPermission: null, pendingAsk: null }
  const s2 = windowStatusFor(done, 'c1', 'c2', ['c1'])
  check('green dot when turn finished elsewhere', s2.streaming === false && s2.unread === true)
  const s3 = windowStatusFor(done, 'c1', 'c1', ['c1'])
  check('no unread dot on the focused chat', s3.unread === false)
  const asking = { messages: [{}], pendingPermission: null, pendingAsk: { question: 'Continue?' } }
  const s4 = windowStatusFor(asking, 'c1', 'c2', ['c1'])
  check('ask badge wins over unread dot', s4.pendingAsk?.question === 'Continue?' && s4.unread === false)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll chat tab badge checks passed')
process.exit(0)
