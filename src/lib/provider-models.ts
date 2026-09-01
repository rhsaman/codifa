/**
 * Shared helpers for merging a fresh `/models` response with a provider's
 * persisted `models` / `removedModels` lists. Used by both the one-time
 * startup refresh in App.tsx and the Settings → Providers fetch, so the
 * two callers can never drift apart in their dedup / removal semantics.
 *
 * Contract: the returned list is the canonical, ordered, deduplicated model
 * id list to persist as `p.models` — it ALWAYS contains the provider's live
 * catalog (filtered against the user's removals) followed by the user's
 * own custom additions, with no duplicates.
 */
export function mergeProviderModels(
  existing: readonly string[] | undefined,
  removed: readonly string[] | undefined,
  fetched: readonly string[] | undefined,
): string[] {
  const removedSet = new Set(removed ?? [])
  const live = (fetched ?? []).filter((m) => !removedSet.has(m))
  const kept = (existing ?? []).filter((m) => !removedSet.has(m))
  return Array.from(new Set([...live, ...kept]))
}
