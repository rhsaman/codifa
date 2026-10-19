// /undo and /redo exchange semantics: the stacks live per chat, undo removes
// the last user message plus everything after it, redo restores it, a new user
// message invalidates redo, and a live stream blocks both.
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

/** Seed a fresh chat with alternating turns and return its id. */
function seed(pairs: Array<[string, string]>): string {
  const id = useStore.getState().newChat('ask')
  for (const [role, content] of pairs) {
    useStore.getState().addMessage(id, { role: role as 'user' | 'assistant', content })
  }
  return id
}

const contents = (id: string) =>
  (useStore.getState().chats.find((c) => c.id === id)?.messages ?? []).map((m) => m.content)

console.log('1) undo removes the last exchange (user message + its reply):')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
    ['user', 'q2'],
    ['assistant', 'a2'],
  ])
  useStore.getState().setActiveChat(id)
  check('undo reports success', useStore.getState().undoMessage() === true)
  check('history truncated at the last user turn', JSON.stringify(contents(id)) === JSON.stringify(['q1', 'a1']), contents(id))
}

console.log('2) redo restores the undone exchange:')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
  ])
  useStore.getState().setActiveChat(id)
  useStore.getState().undoMessage()
  check('undo emptied the chat', contents(id).length === 0, contents(id))
  check('redo reports success', useStore.getState().redoMessage() === true)
  check('both messages came back in order', JSON.stringify(contents(id)) === JSON.stringify(['q1', 'a1']), contents(id))
  check('redo stack is empty after replay', useStore.getState().redoMessage() === false)
}

console.log('3) redo works right after undo even without an explicit redo entry:')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
  ])
  useStore.getState().setActiveChat(id)
  useStore.getState().undoMessage()
  useStore.getState().redoMessage()
  // Second undo/redo cycle must still work (stacks stay consistent).
  useStore.getState().undoMessage()
  check('second undo also works', contents(id).length === 0, contents(id))
  useStore.getState().redoMessage()
  check('second redo also works', contents(id).length === 2, contents(id))
}

console.log('4) a new user message invalidates redo:')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
  ])
  useStore.getState().setActiveChat(id)
  useStore.getState().undoMessage()
  useStore.getState().addMessage(id, { role: 'user', content: 'q2' })
  check('redo refused after a fresh user turn', useStore.getState().redoMessage() === false)
  check('history keeps the new turn', JSON.stringify(contents(id)) === JSON.stringify(['q2']), contents(id))
}

console.log('5) undo does nothing on an empty chat / one with no user turn:')
{
  const id = useStore.getState().newChat('ask')
  useStore.getState().setActiveChat(id)
  check('undo on empty chat is false', useStore.getState().undoMessage() === false)
  useStore.getState().addMessage(id, { role: 'assistant', content: 'orphan' })
  check('undo with no user message is false', useStore.getState().undoMessage() === false)
  check('orphan reply is untouched', JSON.stringify(contents(id)) === JSON.stringify(['orphan']))
  check('redo on empty stack is false', useStore.getState().redoMessage() === false)
}

console.log('6) a streaming message blocks undo and redo:')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
    ['user', 'q2'],
  ])
  useStore.getState().setActiveChat(id)
  // The reply to q2 is still streaming when the user hits /undo.
  const streaming = useStore.getState().addMessage(id, { role: 'assistant', content: 'partial' })
  useStore.getState().updateMessage(streaming.id, { streaming: true })
  check('undo refused while streaming', useStore.getState().undoMessage() === false)
  check('history untouched while streaming', contents(id).length === 4, contents(id))
  useStore.getState().updateMessage(streaming.id, { streaming: false })
  check('undo works once the stream ends', useStore.getState().undoMessage() === true)
  check('truncated back to before the exchange', JSON.stringify(contents(id)) === JSON.stringify(['q1', 'a1']), contents(id))
}

console.log('7) clearChat drops the history stacks (no redo into an emptied chat):')
{
  const id = seed([
    ['user', 'q1'],
    ['assistant', 'a1'],
  ])
  useStore.getState().setActiveChat(id)
  useStore.getState().undoMessage()
  useStore.getState().clearChat(id)
  check('chat is empty after clear', contents(id).length === 0, contents(id))
  check('redo cannot restore into the cleared chat', useStore.getState().redoMessage() === false)
}

console.log('8) stacks are per chat: undoing A does not touch B:')
{
  const a = seed([
    ['user', 'a-q1'],
    ['assistant', 'a-a1'],
  ])
  const b = seed([
    ['user', 'b-q1'],
    ['assistant', 'b-a1'],
  ])
  useStore.getState().setActiveChat(a)
  useStore.getState().undoMessage()
  check('chat A truncated', contents(a).length === 0, contents(a))
  check('chat B untouched', contents(b).length === 2, contents(b))
  // B has no undo entry of its own.
  useStore.getState().setActiveChat(b)
  useStore.getState().undoMessage()
  check('B has its own independent undo', contents(b).length === 0, contents(b))
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll tests passed. ✅')
}
