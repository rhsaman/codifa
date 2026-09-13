/**
 * Tests for `src/lib/provider-fetch.ts`:
 *  - `shouldSkipFetch` (pure)
 *  - `mergeFetchedModels` (pure)
 *  - `fetchAndPersist` (I/O — uses injected `fetchFn` and `store` so we
 *    never hit the network or real zustand)
 */

import './_globals.ts'

import {
  shouldSkipFetch,
  mergeFetchedModels,
  fetchAndPersist,
  type StoreLike,
} from '../src/lib/provider-fetch'
import type { ProviderConfig } from '../src/types'
import type { ModelsResult } from '../src/lib/api'

let pass = 0
let fail = 0
function assert(name: string, cond: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}
function assertEq<T>(name: string, got: T, want: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}

// ---------------------------------------------------------------------------
// shouldSkipFetch
// ---------------------------------------------------------------------------
console.log('shouldSkipFetch')

{
  const p: ProviderConfig = { id: 'x', kind: 'ollama', baseUrl: 'http://localhost:11434/v1' }
  assertEq('enabled + baseUrl → no skip', shouldSkipFetch(p), false)
}
{
  const p: ProviderConfig = { id: 'x', kind: 'ollama', baseUrl: '', enabled: false }
  assertEq('disabled wins over empty baseUrl', shouldSkipFetch(p), 'disabled')
}
{
  const p: ProviderConfig = { id: 'x', kind: 'ollama', baseUrl: '' }
  assertEq('empty baseUrl → no-base-url', shouldSkipFetch(p), 'no-base-url')
}
{
  const p: ProviderConfig = { id: 'x', kind: 'ollama', baseUrl: '   ' }
  assertEq('whitespace-only baseUrl → no-base-url', shouldSkipFetch(p), 'no-base-url')
}
{
  const p: ProviderConfig = { id: 'x', kind: 'ollama', baseUrl: 'http://x', enabled: true }
  assertEq('enabled=true + baseUrl → no skip', shouldSkipFetch(p), false)
}
{
  // enabled undefined defaults to truthy (matches the JS semantics the rest of
  // the codebase uses — `p.enabled === false` only skips when explicitly off).
  const p: ProviderConfig = { id: 'x', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
  assertEq('enabled undefined → no skip', shouldSkipFetch(p), false)
}

// ---------------------------------------------------------------------------
// mergeFetchedModels
// ---------------------------------------------------------------------------
console.log('\nmergeFetchedModels')

// Provider mock for mergeFetchedModels tests (foreign filter needs ProviderConfig)
const mp = { id: 'local', kind: 'ollama' as const, baseUrl: 'http://localhost:11434/v1', models: [] as string[], removedModels: [] as string[] }

{
  // کاتالوگ زنده معیار قطعی است: لیست ذخیره‌شده‌ی قبلی نگه داشته نمی‌شود
  // تا مدلی که پروایدر حذف/تغییرنام کرده («No such model») از لیست زنده برود.
  const out = mergeFetchedModels(mp, ['a', 'b'], [])
  assertEq('fetched only — existing list is NOT kept', out, ['a', 'b'])
}
{
  const out = mergeFetchedModels(mp, ['a', 'b', 'a'], [])
  assertEq('dedup within fetched', out, ['a', 'b'])
}
{
  const out = mergeFetchedModels(mp, ['a', 'b'], ['a'])
  assertEq('removed filters from fetched', out, ['b'])
}
{
  const out = mergeFetchedModels(mp, [], [])
  assertEq('empty fetched → empty list', out, [])
}
{
  const out = mergeFetchedModels(mp, ['a', 'b'], ['e'])
  assertEq('removed that is not in the fetched list → ignored', out, ['a', 'b'])
}
{
  // Foreign models (belonging to another provider) are filtered from fetched
  const out = mergeFetchedModels(mp, ['openrouter/sonnet', 'local-model'], [])
  assertEq('foreign fetched removed', out, ['local-model'])
}
{
  // Doubly-prefixed: m='local/google/gemini' → bareModel → 'google/gemini' → foreign
  const out = mergeFetchedModels(mp, ['local/google/gemini', 'local/qwen-4b'], [])
  assertEq('doubly-prefixed foreign stripped', out, ['local/qwen-4b'])
}

console.log('\nmergeFetchedModels — addedModels (مدل‌های دستی)')

{
  // مدل دستی‌اضافه حتی وقتی کاتالوگ زنده آن را برنمی‌گرداند نگه داشته می‌شود
  const p = { ...mp, addedModels: ['my-manual-model'] }
  const out = mergeFetchedModels(p, ['a', 'b'], [])
  assertEq('manual model survives a live fetch', out, ['a', 'b', 'my-manual-model'])
}

{
  // مدل دستی که کاربر بعداً hide کرده (removed) مخفی می‌ماند
  const p = { ...mp, addedModels: ['my-manual-model'] }
  const out = mergeFetchedModels(p, ['a'], ['my-manual-model'])
  assertEq('removed manual model stays hidden', out, ['a'])
}

{
  // مدل دستی متعلق به پروایدر دیگر (foreign) فیلتر می‌شود
  const p = { ...mp, addedModels: ['openrouter/sonnet'] }
  const out = mergeFetchedModels(p, ['a'], [])
  assertEq('foreign manual model filtered', out, ['a'])
}

{
  // مدل دستی که خود کاتالوگ هم برمی‌گرداند → بدون تکرار
  const p = { ...mp, addedModels: ['a'] }
  const out = mergeFetchedModels(p, ['a', 'b'], [])
  assertEq('manual model deduped with catalog', out, ['a', 'b'])
}

// ---------------------------------------------------------------------------
// fetchAndPersist
// ---------------------------------------------------------------------------
console.log('\nfetchAndPersist')

function mkStore(initial: ProviderConfig[]): StoreLike & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  return {
    calls,
    settings: { providers: initial },
    setProviderContextMap: (id, data) => calls.push({ method: 'setProviderContextMap', args: [id, data] }),
    setProviderPricingMap: (id, data) => calls.push({ method: 'setProviderPricingMap', args: [id, data] }),
    setProviderReasoningMap: (id, data) => calls.push({ method: 'setProviderReasoningMap', args: [id, data] }),
    setProviderModels: (id, models) => calls.push({ method: 'setProviderModels', args: [id, models] }),
    healStaleModels: (id, validModels) => calls.push({ method: 'healStaleModels', args: [id, validModels] }),
    updateProvider: (id, patch) => calls.push({ method: 'updateProvider', args: [id, patch] }),
  }
}

function mkProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'local',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    ...overrides,
  }
}

function mkResult(models: string[]): ModelsResult {
  return {
    models,
    context: { [models[0] ?? 'a']: 8192 },
    pricing: { [models[0] ?? 'a']: { input: 0, output: 0 } },
    reasoning: { [models[0] ?? 'a']: false },
  }
}

async function run<T>(name: string, fn: () => Promise<T>, expect: T): Promise<void> {
  try {
    const got = await fn()
    assertEq(name, got, expect)
  } catch (err) {
    fail++
    console.error(`  ✗ ${name} threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- skip cases: fetchFn must NOT be called --------------------------------

await run(
  'skip when enabled=false (no fetch, no store call)',
  async () => {
    let fetched = false
    const store = mkStore([])
    const p = mkProvider({ enabled: false })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => { fetched = true; return mkResult(['x']) },
      store: { getState: () => store },
    })
    return { r, fetched, calls: store.calls.length }
  },
  { r: { ok: false, skipped: true, reason: 'disabled' }, fetched: false, calls: 0 },
)

await run(
  'skip when baseUrl is empty (no fetch, no store call)',
  async () => {
    let fetched = false
    const store = mkStore([])
    const p = mkProvider({ baseUrl: '' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => { fetched = true; return mkResult(['x']) },
      store: { getState: () => store },
    })
    return { r, fetched, calls: store.calls.length }
  },
  { r: { ok: false, skipped: true, reason: 'no-base-url' }, fetched: false, calls: 0 },
)

// --- happy path: store updates ---------------------------------------------

await run(
  'normal fetch: writes context/pricing/reasoning/models',
  async () => {
    const store = mkStore([mkProvider({ id: 'local', models: [], removedModels: [] })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['llama3', 'mistral']),
      store: { getState: () => store },
    })
    return {
      ok: r.ok,
      count: r.ok ? r.count : -1,
      methods: store.calls.map((c) => c.method),
      models: (store.calls.find((c) => c.method === 'setProviderModels')?.args[1] as string[] | undefined) ?? null,
    }
  },
  {
    ok: true,
    count: 2,
    methods: [
      'setProviderContextMap',
      'setProviderPricingMap',
      'setProviderReasoningMap',
      'setProviderModels',
      // provider بدون model → auto-pick اولین مدل کاتالوگ
      'updateProvider',
      // و ترمیم چت‌ها/recents با مدل stale
      'healStaleModels',
    ],
    models: ['llama3', 'mistral'],
  },
)

await run(
  'merge: live catalog is authoritative — stale saved models are dropped',
  async () => {
    // مدل ذخیره‌شده‌ی "custom-model" در کاتالوگ زنده نیست → از لیست می‌رود.
    // مدل "old-model" هم hide شده و حتی اگر پروایدر برگرداندش مخفی می‌ماند.
    const store = mkStore([
      mkProvider({
        id: 'local',
        models: ['custom-model'],
        removedModels: ['old-model'],
      }),
    ])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['llama3', 'old-model', 'mistral']),
      store: { getState: () => store },
    })
    const models = (store.calls.find((c) => c.method === 'setProviderModels')?.args[1] as string[] | undefined) ?? []
    return { ok: r.ok, models: models.slice().sort() }
  },
  { ok: true, models: ['llama3', 'mistral'].sort() },
)

// --- self-heal: مدل انتخابی از کاتالوگ واقعی provider درمیاد ------------------

await run(
  'self-heal: ردیف custom + مدل جعلی (laguna) → جایگزینی با اولین مدل واقعی',
  async () => {
    // دقیقاً باگ laguna: مدل "laguna-s-2.1-free" روی گیت‌وی opencode ثبت شده ولی
    // در کاتالوگ واقعی نیست → باید با اولین مدل واقعی جایگزین بشه.
    const store = mkStore([
      mkProvider({
        id: 'opencode',
        kind: 'custom',
        baseUrl: 'https://opencode.ai/zen/v1',
        model: 'laguna-s-2.1-free',
        models: ['laguna-s-2.1-free'],
      }),
    ])
    const p = mkProvider({
      id: 'opencode',
      kind: 'custom',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'laguna-s-2.1-free',
    })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['deepseek-v4-flash-free', 'mimo-v2.5-free']),
      store: { getState: () => store },
    })
    const upd = store.calls.find((c) => c.method === 'updateProvider')
    return { ok: r.ok, patch: upd?.args[1] ?? null }
  },
  { ok: true, patch: { model: 'deepseek-v4-flash-free' } },
)

await run(
  'self-heal: مدل خارج از لیست + kind=custom → جایگزینی با اولین مدل کاتالوگ',
  async () => {
    // کاتالوگ زنده برای همه‌ی kindها معیار قطعی است: حتی provider سفارشی که
    // /models ناقص برمی‌گرداند، مدل stale را از دست می‌دهد — مدل انتخابی به
    // اولین مدل واقعی کاتالوگ برمی‌گردد تا ارسال بعدی «No such model» ندهد.
    const store = mkStore([
      mkProvider({
        id: 'custom',
        kind: 'custom',
        baseUrl: 'http://my-gw/v1',
        model: 'my-private-model',
        models: ['my-private-model'],
      }),
    ])
    const p = mkProvider({
      id: 'custom',
      kind: 'custom',
      baseUrl: 'http://my-gw/v1',
      model: 'my-private-model',
    })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['gpt-x']),
      store: { getState: () => store },
    })
    const upd = store.calls.find((c) => c.method === 'updateProvider')
    return { ok: r.ok, patch: upd?.args[1] ?? null }
  },
  { ok: true, patch: { model: 'gpt-x' } },
)

await run(
  'heal: چت‌ها و recents با مدل stale ترمیم می‌شوند',
  async () => {
    // بعد از setProviderModels باید healStaleModels با کاتالوگ merge‌شده
    // صدا زده شود تا چت‌هایی که مدلشان حذف شده به مدل معتبر برگردند.
    const store = mkStore([
      mkProvider({
        id: 'opencode',
        kind: 'custom',
        baseUrl: 'https://opencode.ai/zen/v1',
        model: 'mimo-v2.5-free',
        models: ['mimo-v2.5-free'],
      }),
    ])
    const p = mkProvider({
      id: 'opencode',
      kind: 'custom',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'mimo-v2.5-free',
    })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['deepseek-v4-flash-free']),
      store: { getState: () => store },
    })
    const heal = store.calls.find((c) => c.method === 'healStaleModels')
    return { ok: r.ok, healArgs: heal?.args ?? null }
  },
  { ok: true, healArgs: ['opencode', ['deepseek-v4-flash-free']] },
)

await run(
  'self-heal: مدل معتبر در کاتالوگ → بدون updateProvider',
  async () => {
    const store = mkStore([
      mkProvider({
        id: 'opencode',
        kind: 'custom',
        baseUrl: 'https://opencode.ai/zen/v1',
        model: 'mimo-v2.5-free',
        models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'],
      }),
    ])
    const p = mkProvider({
      id: 'opencode',
      kind: 'custom',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'mimo-v2.5-free',
    })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['deepseek-v4-flash-free', 'mimo-v2.5-free']),
      store: { getState: () => store },
    })
    const hasUpdate = store.calls.some((c) => c.method === 'updateProvider')
    return { ok: r.ok, hasUpdate }
  },
  { ok: true, hasUpdate: false },
)

await run(
  'empty fetch result: writes maps but skips setProviderModels',
  async () => {
    const store = mkStore([mkProvider({ id: 'local' })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult([]),
      store: { getState: () => store },
    })
    return {
      ok: r.ok,
      count: r.ok ? r.count : -1,
      hasSetProviderModels: store.calls.some((c) => c.method === 'setProviderModels'),
    }
  },
  { ok: true, count: 0, hasSetProviderModels: false },
)

await run(
  'fetch throws: error returned, no store writes',
  async () => {
    const store = mkStore([mkProvider({ id: 'local' })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => { throw new Error('network down') },
      store: { getState: () => store },
    })
    return {
      ok: r.ok,
      error: !r.ok && 'error' in r ? r.error : null,
      calls: store.calls.length,
    }
  },
  { ok: false, error: 'network down', calls: 0 },
)

await run(
  'fetch throws + manual models: addedModels are appended to the saved list',
  async () => {
    // گیت‌وی فچ را بلاک کرد (401 unauthorized client) — مدل‌های دستی‌اضافه‌ی
    // کاربر باید به لیست ذخیره‌شده الصاق شوند تا در composer قابل انتخاب بمانند.
    const store = mkStore([
      mkProvider({ id: 'local', models: ['llama3'], addedModels: ['my-manual-model'] }),
    ])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => { throw new Error('unauthorized client') },
      store: { getState: () => store },
    })
    const models = (store.calls.find((c) => c.method === 'setProviderModels')?.args[1] as string[] | undefined) ?? null
    return { ok: r.ok, models }
  },
  { ok: false, models: ['llama3', 'my-manual-model'] },
)

await run(
  'fetch throws + no manual models: saved list untouched',
  async () => {
    // بدون addedModels، شکست فچ نباید لیست ذخیره‌شده را تغییر دهد.
    const store = mkStore([mkProvider({ id: 'local', models: ['llama3'] })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => { throw new Error('network down') },
      store: { getState: () => store },
    })
    const hasSet = store.calls.some((c) => c.method === 'setProviderModels')
    return { ok: r.ok, hasSet }
  },
  { ok: false, hasSet: false },
)

await run(
  'cancelled before result applied: error returned, no setProviderModels',
  async () => {
    const store = mkStore([mkProvider({ id: 'local' })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      cancelled: () => true,
      fetchFn: async () => mkResult(['llama3']),
      store: { getState: () => store },
    })
    return {
      ok: r.ok,
      error: !r.ok && 'error' in r ? r.error : null,
      hasSetProviderModels: store.calls.some((c) => c.method === 'setProviderModels'),
    }
  },
  { ok: false, error: 'cancelled', hasSetProviderModels: false },
)

await run(
  'provider deleted between snapshot and result: still applies (existing=[])',
  async () => {
    // store has NO provider with id 'local' — simulates a delete during fetch
    const store = mkStore([mkProvider({ id: 'openrouter' })])
    const p = mkProvider({ id: 'local' })
    const r = await fetchAndPersist(p, {
      fetchFn: async () => mkResult(['llama3']),
      store: { getState: () => store },
    })
    const models = (store.calls.find((c) => c.method === 'setProviderModels')?.args[1] as string[] | undefined) ?? null
    return { ok: r.ok, models }
  },
  { ok: true, models: ['llama3'] },
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
