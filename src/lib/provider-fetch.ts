/**
 * Helpers for fetching a provider's live model list and persisting it
 * into the store. Used by the auto-fetch in `App.tsx` startup and can
 * be reused elsewhere (e.g. by SettingsModal) so the merge logic lives
 * in exactly one place.
 *
 * Kept in its own file (instead of inside `ProviderModelSelect.tsx`)
 * so it can be unit-tested without pulling in React/zustand at the
 * module level — `useStore` is only touched via the optional
 * `store` parameter.
 */
import { fetchModels, type ModelsResult } from './api'
import { useStore } from './store'
import { isForeignModelId } from './provider-meta'
import type { ProviderConfig } from '../types'

export type FetchSkipReason = 'no-base-url' | 'disabled'

export type FetchAndPersistResult =
  | { ok: true; count: number }
  | { ok: false; skipped: true; reason: FetchSkipReason }
  | { ok: false; error: string }

/** Minimal store surface the helper needs. `getState` returns a snapshot. */
export interface StoreLike {
  setProviderContextMap: (id: string, data: Record<string, number>) => void
  setProviderPricingMap: (
    id: string,
    data: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>,
  ) => void
  setProviderReasoningMap: (id: string, data: Record<string, boolean>) => void
  setProviderModels: (id: string, models: string[]) => void
  settings: { providers: ProviderConfig[] }
}

export interface FetchOptions {
  /** Caller-controlled cancellation: return true to discard the in-flight result. */
  cancelled?: () => boolean
  /** Override the network call (used in tests). Defaults to `fetchModels`. */
  fetchFn?: (p: ProviderConfig) => Promise<ModelsResult>
  /** Override the store (used in tests). Defaults to `useStore`. */
  store?: { getState: () => StoreLike }
}

/**
 * Pure decision: should we skip the network call entirely?
 * - providers with an empty baseUrl would hit a meaningless URL
 *   and waste a probe; this covers both unset defaults and a
 *   user-cleared editable field (e.g. a fresh ollama row)
 */
export function shouldSkipFetch(p: ProviderConfig): false | FetchSkipReason {
  if (p.enabled === false) return 'disabled'
  if (!p.baseUrl || p.baseUrl.trim() === '') return 'no-base-url'
  return false
}

/**
 * Pure merge: keep fetched models (minus anything the user removed and minus
 * models that belong to a foreign provider), then keep existing models too
 * (also filtering foreign entries).  Deduplicates.  Does NOT touch the store.
 */
export function mergeFetchedModels(
  p: ProviderConfig,
  fetched: string[],
  existing: string[],
  removed: string[],
): string[] {
  const removedSet = new Set(removed)
  const prefix = `${p.id}/`
  const bare = (m: string) => (m.startsWith(prefix) ? m.slice(prefix.length) : m)

  return Array.from(
    new Set([
      ...fetched.filter((m) => {
        const b = bare(m)
        return !removedSet.has(b) && !isForeignModelId(p, b)
      }),
      ...existing.filter((m) => {
        const b = bare(m)
        return !isForeignModelId(p, b)
      }),
    ]),
  )
}

/**
 * Fetch a provider's live `/models` list and write the result into the
 * store. Returns a small result envelope so callers can log or count
 * outcomes without throwing — exceptions from `fetchFn` are caught
 * and turned into `{ ok: false, error }`.
 */
export async function fetchAndPersist(
  p: ProviderConfig,
  options: FetchOptions = {},
): Promise<FetchAndPersistResult> {
  const skip = shouldSkipFetch(p)
  if (skip) return { ok: false, skipped: true, reason: skip }

  const fetchFn = options.fetchFn ?? fetchModels
  try {
    const res = await fetchFn(p)
    if (options.cancelled?.()) return { ok: false, error: 'cancelled' }

    const store = (options.store ?? useStore).getState()
    store.setProviderContextMap(p.id, res.context)
    store.setProviderPricingMap(p.id, res.pricing)
    store.setProviderReasoningMap(p.id, res.reasoning)

    if (res.models.length === 0) return { ok: true, count: 0 }

    const fresh = store.settings.providers.find((x) => x.id === p.id)
    const existing = fresh?.models ?? []
    const removed = fresh?.removedModels ?? []
    const merged = mergeFetchedModels(p, res.models, existing, removed)
    store.setProviderModels(p.id, merged)
    return { ok: true, count: merged.length }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
