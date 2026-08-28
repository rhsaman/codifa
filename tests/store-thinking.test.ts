// Tests for the lightweight `isThinking` flag driven by the streaming layer.
// The backend no longer streams raw thinking text; it emits a lightweight
// `{"kind": "thinking", "active": bool}` signal that the frontend maps onto
// the global `isThinking` flag (used to show a glow around the composer).
//
// We test the pure reducer logic of `setStreaming` in isolation (mirrored from
// src/lib/store.ts) so the test stays dependency-free (no electron/fs chain).
// Run: node test/store-thinking.test.ts

type State = { isStreaming: boolean; isThinking: boolean }
type SetState = (partial: Partial<State> | ((s: State) => Partial<State>)) => void

function makeSetStreaming(set: SetState) {
  return (active: boolean, thinking: boolean) =>
    set((s) => {
      if (s.isStreaming === active && s.isThinking === thinking) return {}
      return { isStreaming: active, isThinking: thinking }
    })
}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) setStreaming(active, thinking) پرچم isThinking را درست ست می‌کند:')
{
  let state: State = { isStreaming: false, isThinking: false }
  const set: SetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }
  const setStreaming = makeSetStreaming(set)

  check('مقدار اولیه isThinking false است', state.isThinking === false)

  setStreaming(true, true)
  check('با شروع thinking، isThinking true می‌شود', state.isThinking === true)
  check('با شروع thinking، isStreaming true می‌شود', state.isStreaming === true)

  setStreaming(true, false)
  check('با پایان thinking (ادامه استریم)، isThinking false می‌شود', state.isThinking === false)
  check('با پایان thinking، isStreaming همچنان true است', state.isStreaming === true)

  setStreaming(false, false)
  check('با پایان استریم، isThinking false می‌شود', state.isThinking === false)
  check('با پایان استریم، isStreaming false می‌شود', state.isStreaming === false)
}

console.log('2) وقتی هر دو پرچم تغییر نکرده‌اند، no-op است:')
{
  let state: State = { isStreaming: true, isThinking: true }
  let mutations = 0
  const set: SetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    if (Object.keys(next).length === 0) return
    mutations++
    state = { ...state, ...next }
  }
  const setStreaming = makeSetStreaming(set)

  setStreaming(true, true)
  check('فراخوانی مجدد با مقادیر یکسان تغییری ایجاد نمی‌کند', mutations === 0)
  check('وضعیت بدون تغییر می‌ماند', state.isStreaming === true && state.isThinking === true)
}

console.log('3) رسیدن یک chunk متن در حین thinking نباید نور را خاموش کند:')
{
  // Mirrors Chat.tsx handleEvent: a "text" event calls
  // setStreaming(true, useStore.getState().isThinking) — it must preserve the
  // current isThinking flag instead of forcing it to false.
  let state: State = { isStreaming: true, isThinking: true }
  const set: SetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }
  const setStreaming = makeSetStreaming(set)

  // Simulate a text chunk arriving while the model is still reasoning.
  setStreaming(true, state.isThinking)
  check('با رسیدن text chunk، isThinking همچنان true می‌ماند', state.isThinking === true)
  check('با رسیدن text chunk، isStreaming همچنان true است', state.isStreaming === true)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد.`)
  process.exit(1)
} else {
  console.log('\nهمه تست‌ها پاس شدند. ✅')
}
