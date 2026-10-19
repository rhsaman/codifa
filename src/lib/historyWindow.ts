// History turn limit (Settings → General): trim the WIRE history to the last N
// conversation turns before the /chat/stream payload is sent to the model.
//
// The stored transcript and the UI are never touched — only the request
// shrinks, so nothing "disappears" from the conversation the way the old
// renderer-side tail slice used to make messages vanish every turn.
//
// A "turn" begins at a `user` message: its assistant replies, tool cards and
// any entries between it and the next `user` ride along with it. Slicing is
// therefore always on a `user` boundary, so a tool call and its result are
// never orphaned (providers reject a `tool` reply with no preceding call).
//
// `system` entries (compacted summaries written by auto-compaction, mode
// notices) stand in for the older turns being dropped, so they are ALWAYS
// kept — dropping them would erase the only record of the compacted context.
//
// This mirrors the removed Python backend's `_slice_history_by_turns` (the
// Rust rewrite dropped the mechanism but left the UI setting, so it was dead).

interface RoleEntry {
  role: string
}

/**
 * Keep only the last `limit` turns of `history`, plus every `system` entry.
 *
 * `limit <= 0` (the default, "Off") returns `history` unchanged. When the
 * history holds fewer than `limit` turns, nothing is dropped. Order is
 * preserved: system entries first, then the surviving tail — the same order
 * the send path already builds (`Chat.tsx` sorts summaries to the head).
 */
export function applyHistoryLimit<T extends RoleEntry>(
  history: T[],
  limit: number,
): T[] {
  const n = Math.floor(limit)
  if (!Number.isFinite(n) || n <= 0) return history

  // Walk backwards counting `user` messages; the Nth one from the end starts
  // the window.
  let turns = 0
  let cut = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      turns++
      if (turns === n) {
        cut = i
        break
      }
    }
  }
  // Fewer turns than the limit — the whole history fits, keep it untouched.
  if (cut < 0) return history

  const systems: T[] = []
  const tail: T[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role === 'system') systems.push(m)
    else if (i >= cut) tail.push(m)
  }
  return systems.length > 0 ? [...systems, ...tail] : tail
}
