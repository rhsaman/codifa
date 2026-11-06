import type { Chat, ChatMessage, LspStatus } from '../../types'
// Extracted verbatim from store.ts (pure helpers, no store access).

export const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Cap on persisted `compacted` summary messages kept per chat (newest kept).
 *  Compacted messages are excluded from the history sent to the model
 *  (`!m.compacted` in Chat.tsx), so beyond the newest few they are dead weight
 *  in renderer memory and in every persisted snapshot. Active history (the
 *  messages actually sent to the agent) is never touched by this cap. */
export const MAX_COMPACTED_PER_CHAT = 50

/** Drop the OLDEST compacted messages beyond the cap (pure, for test).
 *  Returns the input array unchanged when the cap is not exceeded. */
export function capCompactedMessages(messages: ChatMessage[]): ChatMessage[] {
  let overflow = 0
  for (const m of messages) if (m.compacted) overflow++
  if (overflow <= MAX_COMPACTED_PER_CHAT) return messages
  overflow -= MAX_COMPACTED_PER_CHAT
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.compacted && overflow > 0) {
      overflow--
      continue
    }
    out.push(m)
  }
  return out
}

/** How much of a message is quoted into the fork seed. The seed is sent on
 *  every turn of the fork, so an unbounded transcript would rebuild the very
 *  cost the fork exists to escape. */
export const FORK_SEED_CHARS_PER_MESSAGE = 600
/** Total seed budget. The seed stands in for the whole conversation, so it is
 *  one small system message rather than a second transcript. */
export const FORK_SEED_MAX_CHARS = 4000

/** One line of a fork seed: a short, single-line digest of a message. */
export function forkSeedLine(m: ChatMessage): string {
  const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Context'
  // Collapse whitespace so a multi-paragraph message costs ONE line.
  const flat = m.content.replace(/\s+/g, ' ').trim()
  const body =
    flat.length > FORK_SEED_CHARS_PER_MESSAGE
      ? `${flat.slice(0, FORK_SEED_CHARS_PER_MESSAGE).trimEnd()}…`
      : flat
  return `${who}: ${body}`
}

/**
 * Build the COMPACTED context seed a fork starts from.
 *
 * A fork must NOT inherit the source transcript: copied messages are live wire
 * history, so every turn of the fork re-sends the entire long conversation —
 * exactly the token cost the user forked to leave behind. Instead the fork is
 * seeded with ONE `system` message digesting the conversation up to the fork
 * point (the same role compaction uses, so the backend merges it as context).
 *
 * Pure and synchronous: `forkChatFromMessage` switches to the new chat in the
 * same tick, so the seed cannot depend on an async summarizer. The first user
 * message of the fork can still grow the context normally from there.
 */
export function forkSeedMessage(src: Chat, forkIndex: number): ChatMessage {
  // Only what the model would actually have seen: compacted messages are the
  // ones an earlier summarizer already folded away, so quoting them again (on
  // top of the summary that replaced them) would double-count old context.
  const upto = src.messages.slice(0, forkIndex + 1).filter((m) => !m.compacted && !m.modeSwitch)
  const lines: string[] = []
  let budget = FORK_SEED_MAX_CHARS
  // Walk BACKWARDS: the newest turns matter most when the budget runs out.
  for (let i = upto.length - 1; i >= 0; i--) {
    const line = forkSeedLine(upto[i])
    if (line.length > budget) break
    budget -= line.length + 1
    lines.unshift(line)
  }
  const body = lines.join('\n')
  const header = src.title && src.title !== 'New chat' ? src.title : 'Forked conversation'
  return {
    id: uid(),
    role: 'system',
    content:
      `[Forked from \u00ab${header}\u00bb \u2014 compacted context up to the fork point]\n` +
      (body || '(no earlier context)') +
      '\n[End of forked context \u2014 continue from here.]',
    // Deliberately NOT `compacted`: that flag means "folded into a summary, so
    // keep it OFF the wire" (isWireHistoryMessage), and this seed IS the wire
    // context the fork runs on. As a plain `system` message it travels like any
    // other system turn, and the send path sorts it to the FRONT of the history
    // — so the model reads it before the user's first new message.
    createdAt: Date.now(),
  }
}

// Persian label for live LSP install/update progress. Shown in the
// thinking/working row with a loading state so a pause reads as waiting.
// Returns null when nothing should render (no status or terminal phase).
// Pure for test.
export function lspStatusLabel(status: LspStatus | null | undefined): string | null {
  if (!status) return null
  if (status.phase === 'done' || status.phase === 'error') return null
  const lang = (status.language ?? '').trim()
  const suffix = lang ? ` ${lang}` : ''
  if (status.phase === 'updating') return `در حال آپدیت LSP${suffix}...`
  return `در حال نصب LSP${suffix}...`
}

// Normalize a backend status/tool event into LspStatus. Accepts the
// {kind:"status",stage:"lsp"} shape and lsp_* tool activity with an
// installing/updating summary. Returns null when the event is not LSP
// progress. Pure for test.
export function lspStatusFromEvent(ev: {
  stage?: string
  tool?: string
  status?: string
  summary?: string
  content?: string
  language?: string
}): LspStatus | null {
  const stage = (ev.stage ?? '').trim().toLowerCase()
  const tool = (ev.tool ?? '').trim().toLowerCase()
  const isLsp = stage === 'lsp' || tool === 'lsp' || tool.startsWith('lsp_')
  if (!isLsp) return null
  const text = `${ev.summary ?? ''} ${ev.content ?? ''} ${ev.status ?? ''}`.toLowerCase()
  const updating = text.includes('updat') || text.includes('آپدیت') || text.includes('به‌روزرسانی') || text.includes('بروز')
  const done = text.includes('done') || text.includes('complete') || ev.status === 'done'
  const failed = text.includes('fail') || text.includes('error') || ev.status === 'error'
  if (failed) return { phase: 'error', language: ev.language }
  if (done) return { phase: 'done', language: ev.language }
  return { phase: updating ? 'updating' : 'installing', language: ev.language }
}

/** How long a SENT queue entry is kept before it is dropped from the persisted
 *  copy. Long enough that the turn it produced is certainly in the transcript,
 *  short enough that a session never carries screenshots it already sent. */
