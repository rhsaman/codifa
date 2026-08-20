// Quick sanity test for the retry decision logic (src/lib/retry.ts).
// Run: node test/retry.test.ts
import type { ChatMessage } from '../src/types.ts'
import { planRetry } from '../src/lib/retry.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

function user(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, createdAt: Date.now() }
}
function assistant(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content, createdAt: Date.now(), ...extra }
}

const messages: ChatMessage[] = [
  user('u1', 'سلام'),
  user('u2', 'برنامه بساز'),
  assistant('a1', 'دارم میسازم... [Interrupted before finishing', {
    error: true,
    retry: { attempt: 3, maxAttempts: 3, delay: 0, reason: 'boom', gaveUp: true },
  }),
]

console.log('1) دکمه retry روی پیام کاربر → RESTART (پاک کردن زیرش + از نو):')
{
  const plan = planRetry(messages, 'u2', 'message')
  check('action = restart', plan?.action === 'restart', plan)
  check(
    'محتوا حفظ میشود',
    plan?.action === 'restart' && plan.target.content === 'برنامه بساز',
    plan,
  )
  check(
    'attachments/images خالی',
    plan?.action === 'restart' &&
      plan.target.attachments.length === 0 &&
      plan.target.images.length === 0,
    plan,
  )
}

console.log('2) بنر retry خطا → RESUME (ادامه از محل قطع):')
{
  const plan = planRetry(messages, 'u2', 'banner')
  check('action = resume', plan?.action === 'resume', plan)
  check(
    'userMsgId همان پیام کاربر است',
    plan?.action === 'resume' && plan.target.userMsgId === 'u2',
    plan,
  )
  check(
    'محتوا حفظ میشود',
    plan?.action === 'resume' && plan.target.content === 'برنامه بساز',
    plan,
  )
}

console.log('3) گاردها:')
{
  check('پیام پیدا نشد → null', planRetry(messages, 'nope', 'message') === null)
  check('پیام غیر user → null', planRetry(messages, 'a1', 'message') === null)
  check('محتوای خالی → null', planRetry([user('u3', '   ')], 'u3', 'message') === null)
  check('لیست خالی → null', planRetry([], 'u1', 'message') === null)
}

console.log('4) ریترای پیام با attachment/image → محتوا حفظ میشود:')
{
  const withAttach: ChatMessage = {
    id: 'u4',
    role: 'user',
    content: 'این فایل را بخوان',
    createdAt: Date.now(),
    attachments: ['a.txt', 'b.txt'],
    images: [{ path: '/tmp/x.png', name: 'x.png' }],
  }
  const plan = planRetry([withAttach], 'u4', 'message')
  check('action = restart', plan?.action === 'restart', plan)
  check(
    'attachments حفظ شدند',
    plan?.action === 'restart' &&
      plan.target.attachments.length === 2 &&
      plan.target.attachments[0] === 'a.txt',
    plan,
  )
  check(
    'images حفظ شدند',
    plan?.action === 'restart' &&
      plan.target.images.length === 1 &&
      plan.target.images[0].name === 'x.png',
    plan,
  )
}

console.log('5) بنر retry → resume: پیام کاربر همان است (partial + tool call ها در store میمانند):')
{
  const plan = planRetry(messages, 'u2', 'banner')
  check('action = resume', plan?.action === 'resume', plan)
  check(
    'userMsgId همان پیام کاربر است',
    plan?.action === 'resume' && plan.target.userMsgId === 'u2',
    plan,
  )
  check(
    'محتوا حفظ میشود',
    plan?.action === 'resume' && plan.target.content === 'برنامه بساز',
    plan,
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')