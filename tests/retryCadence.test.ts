// The auto-retry contract for a dropped connection and for a failed turn.
//
// Two behaviours are pinned here:
//   1. A dropped socket is auto-resumed on a FIXED 10s cadence, at most 10
//      times — never on an exponential ladder, and never on a wall-clock
//      limit (a merely slow model must not be retried or cut off at all).
//   2. The chat panel retries a turn that ERRORED on the same 10s x 10 ladder,
//      so a transient provider failure recovers without a manual click.
//
// setTimeout is completed instantly so the suite never sleeps for the real
// 10s delays; the ASSERTIONS are about attempt counts, not wall-clock.
export {}

// Pass-through timer that collapses the retry waits to 0ms. Anything shorter
// than a second (internal batching) keeps its real delay.
const realSetTimeout = globalThis.setTimeout
;(globalThis as any).setTimeout = (cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(cb, typeof ms === 'number' && ms >= 1000 ? 0 : ms, ...rest)

// Stub the desktop bridge so ensureSidecar() resolves a URL. MUST run before
// importing api.ts (which reads window.coder at module load).
;(globalThis as any).window = {
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://localhost:9999',
    },
    {
      get: (target, prop) => {
        if (prop in target) return (target as any)[prop]
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}

const { streamChat } = await import('../src/lib/api.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

// Every request fails at the transport level: this is the "connection dropped"
// signal (the socket itself, not a model that is slow).
let calls = 0
const retryEvents: Array<{ attempt?: number; max_attempts?: number; reconnecting?: boolean }> = []
;(globalThis as any).fetch = async () => {
  calls++
  throw new Error('ECONNREFUSED 127.0.0.1:9999')
}

const params = {
  provider: {
    kind: 'custom',
    id: 'p1',
    model: 'm',
    baseUrl: 'http://localhost:1/v1',
    apiKeys: ['k'],
  },
  root: '/tmp/ws',
  mode: 'build',
  prompt: 'hi',
  history: [],
}

let threw = false
try {
  await streamChat(params as any, (e: any) => {
    if (e?.kind === 'retry') retryEvents.push(e)
  })
} catch {
  threw = true
}

console.log('1) a dropped connection retries 10 times, then gives up:')
{
  // `calls` also counts the /health probes ensureSidecar runs before each
  // retry, so it is only a lower bound; the retry EVENTS are the contract.
  check('the stream request was re-issued at least 11 times', calls >= 11, calls)
  check('exactly 10 retry events were surfaced', retryEvents.length === 10, retryEvents.length)
  check(
    'each retry advertises the 10-attempt budget',
    retryEvents.every((e) => e.max_attempts === 10),
    retryEvents.map((e) => e.max_attempts),
  )
  check(
    'attempt numbers increment 1..10',
    retryEvents.map((e) => e.attempt).join(',') ===
      '1,2,3,4,5,6,7,8,9,10',
    retryEvents.map((e) => e.attempt),
  )
  check('the retries are marked as reconnecting', retryEvents.every((e) => e.reconnecting === true))
  check('an exhausted ladder finally throws', threw === true)
}

// The panel-side error ladder must use the SAME cadence. Assert on the source:
// the values are module-scope constants, so a drift between the transport and
// the turn-level ladder would be invisible at runtime until it misbehaved.
console.log('2) the chat panel error ladder matches the transport cadence:')
{
  const fs = await import('node:fs')
  const chatSrc = fs.readFileSync('src/components/Chat.tsx', 'utf8')
  const apiSrc = fs.readFileSync('src/lib/api.ts', 'utf8')
  check(
    'api.ts uses a fixed 10s reconnect delay',
    /const RECONNECT_DELAY_MS = 10_000/.test(apiSrc),
  )
  check(
    'api.ts allows 10 reconnect attempts',
    /const MAX_RECONNECT_ATTEMPTS = 10/.test(apiSrc),
  )
  check(
    'the exponential ladder is gone',
    !apiSrc.includes('BASE_BACKOFF_MS * 2 **'),
  )
  check(
    'Chat.tsx retries a failed turn every 10s, at most 10 times',
    /const CHAT_ERROR_MAX_RETRIES = 10;/.test(chatSrc) &&
      /const CHAT_ERROR_RETRY_DELAY_MS = 10_000;/.test(chatSrc),
  )
  check(
    'the error branch actually arms that retry',
    chatSrc.includes('autoRetryFor(originId).schedule(CHAT_ERROR_RETRY_DELAY_MS'),
  )
}

// The mid-turn steer must interrupt an in-flight model reply, so the panel has
// to understand the event the backend emits when it drops that reply.
console.log('3) the steer-interrupt signal is wired end to end:')
{
  const fs = await import('node:fs')
  const typesSrc = fs.readFileSync('src/types.ts', 'utf8')
  const chatSrc = fs.readFileSync('src/components/Chat.tsx', 'utf8')
  const llmSrc = fs.readFileSync('src-tauri/src/llm.rs', 'utf8')
  const agentSrc = fs.readFileSync('src-tauri/src/agent.rs', 'utf8')
  check("the event union knows 'steer_interrupt'", typesSrc.includes("'steer_interrupt'"))
  check(
    'the panel handles steer_interrupt',
    chatSrc.includes('event.kind === "steer_interrupt"'),
  )
  check(
    'the stream can actually be dropped mid-flight',
    llmSrc.includes('tokio::select!') && llmSrc.includes('acc.interrupted = true'),
  )
  check(
    'steering wakes that select via an event, not a timer',
    llmSrc.includes('pub struct InterruptSignal') && llmSrc.includes('notify_waiters'),
  )
  check(
    'the agent forwards the reasoning state to the pill',
    agentSrc.includes('emit(&AgentEvent::Thinking { active })'),
  )
  // The signal is a monotonic GENERATION, not a clearable bool: a raise that
  // lands while no stream is parked must not be swallowed by a reset() (that
  // lost-steer race is why steering only worked sometimes).
  check(
    'the stream stamps itself with the signal generation on start',
    llmSrc.includes('acc.interrupt_base = sig.generation()'),
  )
  check(
    'the stream waits for raises newer than its own stamp',
    llmSrc.includes('sig.wait_for(acc.interrupt_base)'),
  )
  check(
    'the consumed interrupt is NOT cleared (a reset would lose a second steer)',
    !agentSrc.includes('steer_flag.reset();'),
  )
}

// A steer can only be injected by a model call, so a turn that ends WITHOUT one
// (provider error, step budget, Stop inside a tool batch) has to hand the queued
// steer back instead of erasing it. That silent erase was the other half of
// "steering only works sometimes": which exit the turn took decided the
// outcome. The renderer then re-sends those bubbles as the next turn.
console.log('4) a steer no step could carry is handed back, not erased:')
{
  const fs = await import('node:fs')
  const typesSrc = fs.readFileSync('src/types.ts', 'utf8')
  const chatSrc = fs.readFileSync('src/components/Chat.tsx', 'utf8')
  const agentSrc = fs.readFileSync('src-tauri/src/agent.rs', 'utf8')
  check(
    "the panel knows the 'steer_dropped' event",
    typesSrc.includes("'steer_dropped'") && chatSrc.includes('event.kind === "steer_dropped"'),
  )
  check(
    'the agent reports un-carried steers as dropped',
    agentSrc.includes('SteerDropped') && agentSrc.includes('"kind": "steer_dropped"'),
  )
  // Every non-draining exit must call it, or the turn silently swallows the
  // steer on that particular path only (the intermittent report).
  const dropCalls = agentSrc.split('drop_steers(&req.chat_id, emit);').length - 1
  check(
    `every turn exit hands steers back (found ${dropCalls} call sites)`,
    dropCalls >= 4,
  )
  check(
    'a pending steer is re-sent as the next turn',
    chatSrc.includes('sendPendingSteerNext'),
  )
  // The end-of-turn drain must not clobber an armed error retry: `schedule()`
  // clears the pending timer first, so draining over it would cancel the retry
  // the user asked for.
  check(
    'the drain stands down while an error retry is armed',
    chatSrc.includes('const retryArmed =') && chatSrc.includes('if (cNow && !retryArmed)'),
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll retryCadence checks passed')
process.exit(0)
