// The /chat/stream `history` payload is rebuilt from the store on EVERY turn
// (Chat.tsx), so everything it carries is JSON-serialized, shipped over HTTP
// and re-parsed into a serde_json DOM in Rust — on every single turn.
//
// The Rust side reads only `role` + `content` plus a small recap projection
// (agent.rs `history_recap`): toolActivity's tool/status/args/summary/
// results[].content/resultText, `preservedToolSummary` and the plan's
// completion count. Everything else — inline image data URLs, per-message
// `thinking`, nested tool children, the full tool `items` rows, diffs,
// timings — was travelling on the wire and being allocated for nothing. That
// is what made memory spike on long chats: a single 200 KB base64 image
// attached to one old message was re-serialized on every later turn.
//
// The caps below MIRROR `history_recap`, so the model's input stays
// byte-identical: the recap truncates `args` to the first 200 chars of its
// serialization and each results[].content to 400, so sending more than that
// could never reach the model anyway. Cutting a string's TAIL cannot change
// those first 200 chars, which is why this projection is lossless.

import type { ChatMessage, ToolActivity } from '../types'

/** Cap for each string inside `args`. `history_recap` serializes the whole
 *  object and keeps 200 chars; a tail cut never changes that prefix. */
const ARG_STRING_CAP = 400
/** `history_recap` reads at most the first 2 result rows... */
const RESULT_ROWS = 2
/** ...and at most 400 chars of each row's `content`. */
const RESULT_CONTENT_CAP = 400
/** `history_recap` caps resultText at RECAP_EXPLORE_CHARS (8000) for
 *  explore/task and 400 for every other tool; 8000 keeps both cases exact. */
const RESULT_TEXT_CAP = 8_000

export interface HistoryToolEntry {
  tool: string
  status: string
  args?: Record<string, unknown>
  summary?: string
  results?: Array<Record<string, unknown>>
  resultText?: string
}

export interface HistoryEntry {
  role: string
  content: string
  plan?: ChatMessage['plan']
  toolActivity?: HistoryToolEntry[]
  preservedToolSummary?: string
  /** Filesystem paths (NOT inline data URLs) of the images on this message, so
   *  the backend can re-read them for the model without the renderer
   *  re-serializing megabytes of base64 on every turn (the long-chat memory
   *  spike this projection exists to prevent). */
  images?: string[]
}

function cut(v: string, cap: number): string {
  return v.length > cap ? v.slice(0, cap) : v
}

/** Narrow one tool card to the fields the backend reads from history. */
function projectTool(a: ToolActivity): HistoryToolEntry {
  const out: HistoryToolEntry = { tool: a.tool, status: a.status }
  if (a.args && typeof a.args === 'object') {
    // Rebuild with the SAME key order so the serialized prefix is unchanged.
    const args: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a.args)) {
      args[k] = typeof v === 'string' ? cut(v, ARG_STRING_CAP) : v
    }
    out.args = args
  }
  if (typeof a.summary === 'string') out.summary = a.summary
  if (Array.isArray(a.results) && a.results.length > 0) {
    out.results = a.results.slice(0, RESULT_ROWS).map((row) => {
      // `results` rows are typed as SearchResultItem (no index signature), but
      // the recap reads them as a plain JSON object — hence the double cast.
      const copy = { ...(row as unknown as Record<string, unknown>) }
      if (typeof copy.content === 'string') {
        copy.content = cut(copy.content, RESULT_CONTENT_CAP)
      }
      return copy
    })
  }
  if (typeof a.resultText === 'string') {
    out.resultText = cut(a.resultText, RESULT_TEXT_CAP)
  }
  return out
}

/** Project one stored message into the shape the backend actually consumes.
 *  Half-finished cards are dropped here, matching `history_recap`, which skips
 *  `status == "running"` — a running call must never be replayed to the model.
 *  Fields are omitted (not set to undefined) so short messages stay tiny. */
export function projectHistoryMessage(m: ChatMessage): HistoryEntry {
  const out: HistoryEntry = { role: m.role, content: m.content }
  if (Array.isArray(m.plan) && m.plan.length > 0) out.plan = m.plan
  const acts = (m.toolActivity ?? []).filter((a) => a.status !== 'running')
  if (acts.length > 0) out.toolActivity = acts.map(projectTool)
  if (
    typeof m.preservedToolSummary === 'string' &&
    m.preservedToolSummary.length > 0
  ) {
    out.preservedToolSummary = m.preservedToolSummary
  }
  // Image ATTACHMENTS travel as paths only: the payload stays small and the
  // backend resolves the bytes itself (data URLs were dropped from history
  // precisely because re-sending them on every turn blew up memory).
  const imgs = (m.images ?? [])
    .map((i) => (typeof i === 'string' ? i : i?.path))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (imgs.length > 0) out.images = imgs
  return out
}
