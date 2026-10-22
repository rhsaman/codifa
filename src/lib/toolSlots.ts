import type { ThinkingLevel, ToolFallback } from '../types'

/** The side-task slots that Settings → Tools → "Other" drives as ONE group:
 *  the context-compaction summariser (`compact`), the web-search distiller
 *  (`web`) and the chat-title / commit-message generator (`title`, `compact`).
 *  They are all short, cheap calls where a single model choice is what the user
 *  wants, so the row writes and reads them together.
 *
 *  Keep this list as the single source of truth. Reading one hardcoded key
 *  while the row stored the model under another was a real bug: the commit
 *  message kept running on the main chat model because only `compact` was
 *  read, and the settings row had the picked model stored under `title`/`web`. */
export const OTHER_SLOTS = ['compact', 'web', 'title'] as const

export type OtherSlot = (typeof OTHER_SLOTS)[number]

/** The tool slots that can carry their own fallback list, expressed with the
 *  REAL stored keys: the "Other" row writes `compact` / `web` / `title`
 *  together, exactly like `OTHER_SLOTS`. Mirrors the slot names the Rust side
 *  reads in `tool_fallbacks`. */
export const TOOL_FALLBACK_SLOTS = ['explore', 'vision', 'schedule', ...OTHER_SLOTS] as const

/** The wire shape for the per-tool fallback map: slot name →
 *  `["providerId/model", …]`, in list order. Rows without a provider id (or
 *  without a model) cannot address a provider, so they are dropped rather than
 *  sent as an unroutable entry. */
/** The wire value for a main-model rung. `resolve_slot_target` in the Rust
 *  backend resolves this string to the request's OWN model, which is exactly
 *  what the row means, so it must stay in the set below and in sync with the
 *  sentinel list there. */
const MAIN_MODEL_ENTRY = 'main model'

export function toolFallbackEntries(
  map: Record<string, ToolFallback[]> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!map) return out
  for (const slot of TOOL_FALLBACK_SLOTS) {
    const list = (map[slot] ?? [])
      .map((r) => {
        const pid = r.providerId.trim()
        const model = r.model.trim()
        // A row that names nothing is the composer's own model. It travels by
        // NAME instead of being dropped as unroutable: the row is a real rung
        // in the user's try order, and the backend resolves the sentinel to the
        // request's own model. A HALF-filled row stays unroutable and is
        // dropped by the filter below.
        if (!pid && !model) return MAIN_MODEL_ENTRY
        return `${pid}/${model}`
      })
      .filter((entry) => !entry.startsWith('/') && !entry.endsWith('/'))
    if (list.length) out[slot] = list
  }
  return out
}

/** What a row's model picker must show: `providerId/model` when both are set,
 *  the provider alone while its model is still unpicked, a bare model id for
 *  legacy rows, and `''` (which the picker renders as "Main model") when the
 *  row means the composer's own model. */
export function toolFallbackValue(row: ToolFallback): string {
  const pid = row.providerId.trim()
  const model = row.model.trim()
  if (pid && model) return `${pid}/${model}`
  if (pid) return `${pid}/`
  return model
}

/** The model a stored fallback row stands for, as the "providerId/model" entry
 *  the rest of the app speaks, or `''` when the row means "whatever the
 *  composer is running" (or does not name a model at all). */
export function toolFallbackToModel(row: ToolFallback): string {
  const pid = row.providerId.trim()
  const model = row.model.trim()
  if (pid && model) return model.includes('/') ? model : `${pid}/${model}`
  return pid ? '' : model
}

/** The row that stands for "the composer's own model" in a tool's try order:
 *  a row naming nothing, which is the same shape as a tool that inherits the
 *  composer's model. */
export function mainModelRow(): ToolFallback {
  return { providerId: '', model: '' }
}

/** A tool's whole try order: its OWN model as rung 0, then the configured
 *  fallbacks. `own` is `''` when the tool inherits the composer's model, which
 *  is what a main-model row means as well, so the two collapse into one.
 *
 *  The own model is a single "providerId/model" string, so it is split here —
 *  every row of the returned list is otherwise shaped like a fallback, which is
 *  what lets row 0 be moved, replaced and removed like any other rung. */
export function toolChainRows(
  own: string,
  fallbacks: ToolFallback[],
): ToolFallback[] {
  const entry = own.trim()
  const slash = entry.indexOf('/')
  const head: ToolFallback =
    slash > 0
      ? { providerId: entry.slice(0, slash), model: entry.slice(slash + 1) }
      : { providerId: '', model: entry }
  return [head, ...fallbacks]
}

/** Split a tool's try order back into its OWN model plus its fallback list —
 *  the exact inverse of `toolChainRows`. Row 0 is what the tool runs by
 *  default, so moving a model into row 0 re-points the tool at it. */
export function toolChainSet(rows: ToolFallback[]): {
  own: string
  fallbacks: ToolFallback[]
} {
  return { own: toolFallbackToModel(rows[0] ?? mainModelRow()), fallbacks: rows.slice(1) }
}

/** Move one row up (`-1`) or down (`1`), returning a new list. Row 0 is
 *  reorderable like any other — that is how a model stops being the tool's own
 *  model and becomes a later rung. An out-of-range move returns the input. */
export function moveFallback<Row>(rows: Row[], idx: number, dir: -1 | 1): Row[] {
  const j = idx + dir
  if (idx < 0 || idx >= rows.length || j < 0 || j >= rows.length) return rows
  const next = [...rows]
  const [row] = next.splice(idx, 1)
  next.splice(j, 0, row)
  return next
}

/** The "Other" row's fallback list: the group's first non-empty list — the very
 *  value the settings row displays. Mirrors `other_slot_fallbacks` in
 *  `src-tauri/src/backend_light.rs`, so the row and the call can never disagree
 *  about which key holds the pick. */export function otherSlotFallbacks(
  map: Record<string, ToolFallback[]> | undefined,
): ToolFallback[] {
  if (!map) return []
  for (const key of OTHER_SLOTS) {
    const rows = map[key]
    if (rows && rows.length) return rows
  }
  return []
}

/** Values that mean "follow the main model". Mirrors `resolve_slot_target` in
 *  `src-tauri/src/backend_light.rs`, which treats these as "use the parent". */
const MAIN_MODEL_ENTRIES = new Set(['', 'main', 'main_model', 'main model'])

/** True when a Tool Models entry means "inherit the main model". */
export function isMainModelEntry(entry: string | undefined | null): boolean {
  return MAIN_MODEL_ENTRIES.has((entry ?? '').trim().toLowerCase())
}

/** The model the "Other" row currently points at: the group's first explicit
 *  entry, i.e. exactly the value the settings row displays. Every consumer must
 *  resolve through this instead of reading a single hardcoded slot key. */
export function otherSlotModel(models: Record<string, string> | undefined): string {
  for (const key of OTHER_SLOTS) {
    const v = (models?.[key] ?? '').trim()
    if (!isMainModelEntry(v)) return v
  }
  return ''
}

/** Reasoning effort of the "Other" group: its first explicit level, else the
 *  `none` default (which sends no reasoning parameter at all). */
export function otherSlotLevel(
  levels: Record<string, ThinkingLevel> | undefined,
): ThinkingLevel {
  for (const key of OTHER_SLOTS) {
    const v = levels?.[key]
    if (v) return v
  }
  return 'none'
}

/** Make the Other group internally consistent: every slot that is unset (or
 *  still on a "main model" sentinel) inherits the group's model.
 *
 *  The row writes all three keys at once, so a group that is only partially
 *  filled is stale state from an older build or from a whole-object settings
 *  write. Such a group is invisible in the UI (the row shows the first
 *  non-empty entry) but makes every consumer that reads a missing key fall
 *  back to the main model. Running this on load keeps disk and UI in sync. */
export function withOtherSlotsFilled(
  models: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...(models ?? {}) }
  const group = otherSlotModel(out)
  if (!group) return out
  for (const key of OTHER_SLOTS) {
    if (isMainModelEntry(out[key])) out[key] = group
  }
  return out
}
