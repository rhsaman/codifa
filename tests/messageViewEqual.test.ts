// Regression test for the ChatMessageView memo comparator.
//
// The compaction footer is rebuilt once a second with a fresh `footerStatus`
// object. The comparator used to look at `.text` and `.kind` only, so every
// tick compared EQUAL and the determinate progress bar stayed frozen at its
// opening 0% for the whole job. `.percent` must stay part of the equality test.
//
// Run: node tests/messageViewEqual.test.ts (plain node, type-stripped).
import type { ChatMessage } from '../src/types.ts'
import {
  chatMessageViewPropsEqual,
  type ChatMessageViewPropsLike,
} from '../src/lib/messageViewEqual.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

function message(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'پاسخ',
    createdAt: 1,
    ...extra,
  }
}

function props(
  msg: ChatMessage,
  extra: Partial<ChatMessageViewPropsLike> = {},
): ChatMessageViewPropsLike {
  return { message: msg, ...extra }
}

console.log('messageViewEqual: footer percent must repaint the message')
{
  const base = message({
    footerStatus: { kind: 'compact', text: 'summarizing', percent: 0 },
  })
  const next = message({
    footerStatus: { kind: 'compact', text: 'summarizing', percent: 1 },
  })
  check('same message object → equal', chatMessageViewPropsEqual(props(base), props(base)))
  check(
    'only percent changed → NOT equal (the 0% freeze bug)',
    chatMessageViewPropsEqual(props(base), props(next)) === false,
  )
  check(
    'identical footer fields on different objects → equal',
    chatMessageViewPropsEqual(
      props(base),
      props(
        message({
          footerStatus: { kind: 'compact', text: 'summarizing', percent: 0 },
        }),
      ),
    ),
  )
}

console.log('messageViewEqual: every footer field that changes the row repaints it')
{
  const base = message({
    footerStatus: {
      kind: 'compact',
      text: 'summarizing',
      percent: 10,
      attempt: 1,
    },
  })
  const text = message({
    footerStatus: {
      kind: 'compact',
      text: 'merging',
      percent: 10,
      attempt: 1,
    },
  })
  const kind = message({
    footerStatus: { kind: 'info', text: 'summarizing', percent: 10, attempt: 1 },
  })
  const attempt = message({
    footerStatus: {
      kind: 'compact',
      text: 'summarizing',
      percent: 10,
      attempt: 2,
    },
  })
  const action = message({
    footerStatus: {
      kind: 'error',
      text: 'compact failed',
      action: 'compact-retry',
    },
  })
  const actionTwo = message({
    footerStatus: {
      kind: 'error',
      text: 'compact failed',
      action: undefined,
    },
  })
  check('text changed → NOT equal', chatMessageViewPropsEqual(props(base), props(text)) === false)
  check('kind changed → NOT equal', chatMessageViewPropsEqual(props(base), props(kind)) === false)
  check(
    'attempt changed → NOT equal',
    chatMessageViewPropsEqual(props(base), props(attempt)) === false,
  )
  check(
    'action changed → NOT equal',
    chatMessageViewPropsEqual(props(action), props(actionTwo)) === false,
  )
}

console.log('messageViewEqual: failed-turn markers and handler identity')
{
  const clean = message()
  const failed = message({ error: true, errorReason: 'boom' })
  const interrupted = message({ interrupted: true })
  check('error flag changed → NOT equal', chatMessageViewPropsEqual(props(clean), props(failed)) === false)
  check(
    'errorReason changed → NOT equal',
    chatMessageViewPropsEqual(
      props(message({ error: true, errorReason: 'a' })),
      props(message({ error: true, errorReason: 'b' })),
    ) === false,
  )
  check(
    'interrupted changed → NOT equal',
    chatMessageViewPropsEqual(props(clean), props(interrupted)) === false,
  )

  const onRetryA = () => {}
  const onRetryB = () => {}
  check(
    'a recreated onRetry defeats the memo (expected false)',
    chatMessageViewPropsEqual(
      props(clean, { onRetry: onRetryA }),
      props(clean, { onRetry: onRetryB }),
    ) === false,
  )
  check(
    'stable onRetry → equal',
    chatMessageViewPropsEqual(
      props(clean, { onRetry: onRetryA }),
      props(clean, { onRetry: onRetryA }),
    ),
  )
  const onResume = () => {}
  check(
    'onResume identity is part of the comparison',
    chatMessageViewPropsEqual(
      props(clean, { onResume }),
      props(clean, { onResume: () => {} }),
    ) === false,
  )
  const onCompactRetry = () => {}
  check(
    'onCompactRetry identity is part of the comparison',
    chatMessageViewPropsEqual(
      props(clean, { onCompactRetry }),
      props(clean, { onCompactRetry: () => {} }),
    ) === false,
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تست‌های messageViewEqual پاس شدند ✅')
process.exit(0)
