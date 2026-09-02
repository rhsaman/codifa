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
  const out = mergeFetchedModels(mp, ['a', 'b'], ['c', 'd'], [])
  assertEq('disjoint fetched + existing', out.sort(), ['a', 'b', 'c', 'd'].sort())
}
{
  const out = mergeFetchedModels(mp, ['a', 'b'], ['b', 'c'], [])
  assertEq('overlap → dedup (b appears once)', out, ['a', 'b', 'c'])
}
{
  const out = mergeFetchedModels(mp, ['a', 'b'], ['c'], ['a'])
  assertEq('removed filters from fetched', out, ['b', 'c'])
}
{
  const out = mergeFetchedModels(mp, [], ['a', 'b'], [])
  assertEq('empty fetched + existing preserved', out, ['a', 'b'])
}
{
  const out = mergeFetchedModels(mp, ['a', 'b'], ['c', 'd'], ['e'])
  assertEq('removed that is not in either list → ignored', out.sort(), ['a', 'b', 'c', 'd'].sort())
}
{
  const out = mergeFetchedModels(mp, ['a'], ['a', 'b'], [])
  assertEq('order: fetched first, then existing', out, ['a', 'b'])
}
{
  // Foreign models should be filtered from both fetched and existing
  const out = mergeFetchedModels(mp, ['openrouter/sonnet', 'local-model'], ['gpt-4', 'qwen-local'], [])
  assertEq('foreign fetched removed, foreign existing removed', out.sort(), ['gpt-4', 'local-model', 'qwen-local'].sort())
}
{
  // Doubly-prefixed: m='local/google/gemini' → bareModel → 'google/gemini' → foreign
  const out = mergeFetchedModels(mp, ['local/google/gemini', 'local/qwen-4b'], [], [])
  assertEq('doubly-prefixed foreign stripped', out, ['local/qwen-4b'])
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
    ],
    models: ['llama3', 'mistral'],
  },
)

await run(
  'merge: keeps existing custom models, drops removed',
  async () => {
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
  { ok: true, models: ['custom-model', 'llama3', 'mistral'].sort() },
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
