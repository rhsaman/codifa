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
  healStaleModels: (id: string, validModels: string[]) => void
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void
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

/** Strip a redundant `${p.id}/` prefix from a stored model id. */
export function bareModelId(p: { id: string }, m: string): string {
  const prefix = `${p.id}/`
  return m.startsWith(prefix) ? m.slice(prefix.length) : m
}

/**
 * ادغام بر اساس کاتالوگ زنده‌ی /models — معیار قطعی. خروجی فقط همان
 * مدل‌هایی است که پروایدر الان عرضه می‌کند (منهای مدل‌های hide‌شده‌ی
 * کاربر و مدل‌های متعلق به پروایدر دیگر)، بدون تکرار. لیست ذخیره‌شده‌ی
 * قبلی عمداً نگه داشته نمی‌شود تا مدلی که پروایدر حذف یا تغییرنام کرده
 * («No such model») هرگز در لیست زنده نماند. store را تغییر نمی‌دهد.
 *
 * استثنا: مدل‌هایی که کاربر دستی اضافه کرده (addedModels) همیشه نگه
 * داشته می‌شوند — حتی وقتی کاتالوگ زنده در دسترس نیست یا گیت‌وی فهرست
 * مدل‌هایش را به کلاینت‌های ناشناس نشان نمی‌دهد.
 */
export function mergeFetchedModels(
  p: ProviderConfig,
  fetched: string[],
  removed: string[],
): string[] {
  const removedSet = new Set(removed)
  const added = new Set((p.addedModels ?? []).map((m) => bareModelId(p, m)))

  return Array.from(
    new Set(
      [
        ...fetched.filter((m) => {
          const b = bareModelId(p, m)
          return !removedSet.has(b) && !isForeignModelId(p, b)
        }),
        ...Array.from(added).filter((b) => !removedSet.has(b) && !isForeignModelId(p, b)),
      ],
    ),
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
    const removed = fresh?.removedModels ?? []
    const merged = mergeFetchedModels(p, res.models, removed)
    store.setProviderModels(p.id, merged)
    // انتخاب/ترمیم خودکار مدل از کاتالوگ واقعی پروایدر (هرگز مقدار
    // hardcode‌شده):
    // - `model` خالی → اولین مدل کاتالوگ;
    // - مدل انتخابی‌ای که در کاتالوگ فچ‌شده نیست stale است (پروایدر آن را
    //   حذف یا تغییرنام کرده، مثل "mimo-v2.5-free") → با اولین مدل واقعی
    //   جایگزین می‌شود تا چت‌ها با «No such model» شکست نخورند.
    const current = fresh?.model ?? ''
    const inCatalog = res.models.some(
      (m) => bareModelId(p, m) === bareModelId(p, current),
    )
    if (fresh && merged.length > 0 && (!current || !inCatalog)) {
      store.updateProvider(p.id, { model: bareModelId(p, merged[0]) })
    }
    // ترمیم همه‌ی چت‌ها و recents که هنوز به مدلی اشاره می‌کنند که پروایدر
    // دیگر عرضه نمی‌کند — وگرنه ارسال بعدی همان چت با «No such model»
    // می‌شکند حتی وقتی کاتالوگ بالا تازه است.
    if (merged.length > 0) store.healStaleModels(p.id, merged)
    return { ok: true, count: merged.length }
  } catch (err) {
    // فچ شکست خورد (گیت‌وی در دسترس نیست یا کلاینت را بلاک کرده). لیست
    // ذخیره‌شده دست نمی‌خورد؛ فقط مدل‌های دستی‌اضافه‌ی کاربر را که هنوز
    // در لیست نیستند به آن می‌افزاییم تا همیشه قابل انتخاب بمانند.
    const store = (options.store ?? useStore).getState()
    const fresh = store.settings.providers.find((x) => x.id === p.id)
    if (fresh) {
      const existing = new Set((fresh.models ?? []).map((m) => bareModelId(p, m)))
      const missing = (fresh.addedModels ?? [])
        .map((m) => bareModelId(p, m))
        .filter((b) => !existing.has(b) && !isForeignModelId(p, b))
      if (missing.length > 0) {
        store.setProviderModels(p.id, [...(fresh.models ?? []), ...missing])
      }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
