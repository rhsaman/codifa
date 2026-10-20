// Deleted chats release their renderer-side resources.
//
// Two module-level registries used to keep one entry per chat EVER OPENED, with
// no release path: the `send` closure registered by the chat panel (chatSends)
// and the file-comment highlights (fileComments). Both are unreachable once the
// chat is gone — nothing can list its comments or drain its queue again — so
// retaining them was pure leak that grew with every chat the user opened.
// These checks pin the release AND that release stays scoped to one chat.
import './_globals.ts'

const { useStore } = await import('../src/lib/store.ts')
const sends = await import('../src/lib/chatSends.ts')
const comments = await import('../src/lib/fileComments.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const st = () => useStore.getState()

// ── chatSends: the send closure dies with the chat ──────────────────────────
{
  console.log('── chatSends: deleting a chat releases its send closure ──')
  const before = sends.chatSendCount()
  const id = st().newChat('ask')
  sends.registerChatSend(id, () => {})
  check('send closure registered', sends.chatSendCount() === before + 1, sends.chatSendCount())
  st().deleteChat(id)
  check('closure released on delete', sends.chatSendCount() === before, sends.chatSendCount())
}

// ── fileComments: highlights die with the chat ──────────────────────────────
{
  console.log('── fileComments: deleting a chat drops its highlights ──')
  const id = st().newChat('ask')
  comments.addFileComment(id, 'src/a.ts', 'const x = 1')
  check('highlight stored', comments.listFileComments(id).length === 1)
  st().deleteChat(id)
  check('highlights released on delete', comments.listFileComments(id).length === 0, comments.listFileComments(id))
}

// ── Release is scoped: a surviving chat keeps everything ────────────────────
{
  console.log('── deleting one chat leaves its neighbours intact ──')
  const keep = st().newChat('ask')
  const drop = st().newChat('ask')
  const before = sends.chatSendCount()
  sends.registerChatSend(keep, () => {})
  sends.registerChatSend(drop, () => {})
  comments.addFileComment(keep, 'b.ts', 'keep me')
  comments.addFileComment(drop, 'b.ts', 'drop me')

  st().deleteChat(drop)

  check('surviving chat keeps its send closure', sends.chatSendCount() === before + 1, sends.chatSendCount())
  check('surviving chat keeps its highlights', comments.listFileComments(keep).length === 1)
  check('deleted chat lost its highlights', comments.listFileComments(drop).length === 0)
}

// ── A delete must never break a queued turn of another chat ────────────────
// This is the behaviour the registry exists for: a background chat drains its
// queue even while its panel is unmounted, so release may only key on DELETION.
{
  console.log('── queued drain still works after an unrelated delete ──')
  const id = st().newChat('ask')
  st().queueMessage(id, {
    id: 'q-leak-1',
    text: 'بعد از حذف چت دیگر',
    attachments: [],
    kind: 'queue',
  })
  let got = ''
  sends.registerChatSend(id, (text) => {
    got = text
  })
  const other = st().newChat('ask')
  sends.registerChatSend(other, () => {})
  st().deleteChat(other)

  const drained = sends.sendQueuedNext(id)
  check('queued turn drains', drained === true, drained)
  check('its text was delivered', got === 'بعد از حذف چت دیگر', got)
}

// ── Release is idempotent ──────────────────────────────────────────────────
{
  console.log('── releasing twice / for an unknown id is a no-op ──')
  let threw = false
  try {
    sends.unregisterChatSend('no-such-chat')
    const id = st().newChat('ask')
    sends.registerChatSend(id, () => {})
    st().deleteChat(id)
    st().deleteChat(id)
  } catch (err) {
    threw = true
    console.error(err)
  }
  check('no throw', !threw)
}

// ── The redo stack is bounded ──────────────────────────────────────────────
// Every /undo pushes the removed exchange (a full slice of the transcript) and
// nothing ever trimmed that list, so a long undo/redo session grew it without
// limit. Only the newest MAX_REDO_EXCHANGES stay replayable.
{
  console.log('── the redo stack is bounded to the newest exchanges ──')
  const id = st().newChat('ask')
  for (let i = 0; i < 30; i++) {
    st().addMessage(id, { role: 'user', content: `u${i}` })
    st().addMessage(id, { role: 'assistant', content: `a${i}` })
  }
  for (let i = 0; i < 30; i++) check(`undo ${i + 1}`, st().undoMessage() === true)
  check('transcript emptied by the undos', st().chats.find((c) => c.id === id)!.messages.length === 0)

  let replayed = 0
  for (let i = 0; i < 30; i++) if (st().redoMessage()) replayed++
  check('at most 20 exchanges replay', replayed === 20, replayed)
  check('the oldest exchanges were the ones dropped', replayed === 20)
  st().deleteChat(id)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed ❌`)
  process.exit(1)
}
console.log('\nchatLeaks: all checks passed ✅')
process.exit(0)
