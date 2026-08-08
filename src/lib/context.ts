import type { Chat } from '../types'

export const CHARS_PER_TOKEN = 4

/**
 * Estimate the characters that would be sent to the model this turn:
 * system prompt + builtin/workspace note + last maxHistory message text +
 * the actual tool payload (name, args, result summary, diff).
 */
export function estimateContextChars(
  chat: Chat | null,
  systemPrompt: string,
  maxHistory: number,
): number {
  const msgs = chat?.messages ?? []
  let chars = 0
  chars += systemPrompt.length
  chars += 2200 // builtin system prompt + auto-scout/workspace note
  const active = msgs.filter((m) => !m.compacted)
  const talk = active.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system',
  )
  for (const m of talk.slice(-maxHistory)) chars += m.content.length
  for (const m of active.slice(-maxHistory)) {
    for (const act of m.toolActivity ?? []) {
      chars += act.tool.length
      if (act.args) chars += JSON.stringify(act.args).length
      if (act.summary) chars += act.summary.length
      if (act.diff) chars += act.diff.length
    }
  }
  return chars
}

export function estimateContextTokens(
  chat: Chat | null,
  systemPrompt: string,
  maxHistory: number,
): number {
  return Math.floor(
    estimateContextChars(chat, systemPrompt, maxHistory) / CHARS_PER_TOKEN,
  )
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

export function contextPercent(used: number, windowSize: number | null): number | null {
  if (!windowSize || windowSize <= 0) return null
  return Math.min(100, Math.round((used / windowSize) * 100))
}
