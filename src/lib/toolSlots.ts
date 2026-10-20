import type { ThinkingLevel } from '../types'

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
