import type { Chat } from '../../types'
// Extracted verbatim from store.ts (pure helpers, no store access).

/**
 * Drop chats that share an `id`, keeping the LAST occurrence (it carries the
 * most recent data). Two chats with the same `id` would otherwise both render
 * in the sidebar, and because the 3-dot menu is keyed on chat id, opening it
 * for one row would open it for BOTH. The backend already de-duplicates on
 * disk; this is the final defensive guard on the loaded payload.
 */
export function dedupeChats(chats: Chat[]): Chat[] {
  const seen = new Set<string>()
  const out: Chat[] = []
  for (let i = chats.length - 1; i >= 0; i--) {
    const c = chats[i]
    if (!c?.id || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  // Restore original order (first occurrence position of each kept id).
  out.reverse()
  return out
}

/**
 * Decide which chat list wins on `load()` so a transient backend miss never
 * wipes the sidebar ("workspaces show but chats disappear").
 *
 * - `incoming` empty + held chats + missing settings + settings file on disk
 *   = full transient miss → caller keeps everything (`emptyMiss`).
 * - `incoming` empty + held chats (settings arrived or first run has no file)
 *   = partial miss → keep the held chats (`kept`).
 * - Otherwise the fresh payload wins (genuine wipe / fresh profile settles
 *   to empty, normal refresh replaces).
 *
 * Pure for test (no store access).
 */
export function selectLoadedChats(
  prev: Chat[],
  incoming: Chat[] | null | undefined,
  opts: { settingsMissing: boolean; hasSettingsFile: boolean },
): { chats: Chat[]; kept: boolean; emptyMiss: boolean } {
  const fresh = incoming && incoming.length > 0 ? incoming : []
  if (fresh.length === 0 && prev.length > 0) {
    if (opts.settingsMissing && opts.hasSettingsFile) {
      return { chats: prev, kept: true, emptyMiss: true }
    }
    if (!opts.settingsMissing) {
      return { chats: prev, kept: true, emptyMiss: false }
    }
    // Genuine wipe (no settings file on disk at all): settle to empty.
    return { chats: [], kept: false, emptyMiss: false }
  }
  return { chats: fresh, kept: false, emptyMiss: false }
}

// ---------------------------------------------------------------------------
// Lazy chat bodies
//
// settings.json carries chat INDEX rows only (title/dates/root/dir/
// messageCount). A transcript lives in its own file and is fetched with
// `chatGet` the moment the user opens the chat; bodies of chats the user has
// since closed are dropped again, so a session with hundreds of chats never
// holds more than a handful of transcripts in memory.
// ---------------------------------------------------------------------------

/** How many hydrated chat bodies stay resident (most-recently-open first). */
