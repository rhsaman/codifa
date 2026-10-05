// Helpers for slash commands: parsing, pretty labels (no leading slash),
// prompt history and pinned commands (max 3 pins).
// Pure functions + localStorage persistence, so they are unit-testable
// without React or the zustand store.

export interface ParsedSlash {
  name: string
  args: string
}

const HISTORY_KEY = 'coder:promptHistory'
const PINS_KEY = 'coder:pinnedCommands'

export const MAX_HISTORY = 10
export const MAX_PINS = 3

function storage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* ignore */
  }
  return null
}

/** True when the trimmed input is a slash command (starts with "/"). */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith('/')
}

/** Parse "/name rest of args" into name + args. Returns null when not a slash command. */
export function parseSlashInput(text: string): ParsedSlash | null {
  const t = text.trimStart()
  if (!t.startsWith('/')) return null
  const without = t.slice(1).trim()
  if (!without) return { name: '', args: '' }
  const space = without.search(/\s/)
  if (space === -1) return { name: without.toLowerCase(), args: '' }
  return {
    name: without.slice(0, space).toLowerCase(),
    args: without.slice(space + 1).trim(),
  }
}

/** Character range of the leading "/name" token in the raw input, so the
 *  composer can paint only the command token in the accent color while args
 *  and plain text keep the normal text color (Codex-style). Returns null when
 *  there is no "/name" token (plain text, bare "/", or "/ " with no name).
 *  Example: "  /compact foo" -> { start: 2, end: 10 } covering "/compact". */
export function slashTokenRange(text: string): { start: number; end: number } | null {
  const m = /^\s*\/[^\s]+/.exec(text)
  if (!m) return null
  const token = m[0]
  // Bare "/" or "/ " has no command name to highlight.
  if (/^\s*\/\s*$/.test(token)) return null
  const start = text.indexOf('/', 0)
  if (start === -1) return null
  return { start, end: start + token.slice(token.indexOf('/')).length }
}

/** Pretty label for a slash command WITHOUT the leading slash.
 *  Known commands get a human label; unknown ones just lose the slash.
 *  Examples: "/compact" -> "Compact", "/create-skill foo" -> "Create skill: foo". */
export function prettySlashLabel(text: string): string {
  const parsed = parseSlashInput(text)
  if (!parsed) return text
  const { name, args } = parsed
  switch (name) {
    case 'help':
      return 'Help'
    case 'compact':
      return args ? `Compact: ${args}` : 'Compact context'
    case 'clear':
      return 'Clear chat'
    case 'new':
      return 'New chat'
    case 'undo':
      return 'Undo last exchange'
    case 'redo':
      return 'Redo last exchange'
    case 'create-skill':
      return args ? `Create skill: ${args}` : 'Create skill'
    case 'create-mcp':
      return args ? `Create connector: ${args}` : 'Create connector'
    case '':
      return '/'
    default:
      return args ? `${name} ${args}` : name
  }
}

/** Load persisted prompt history (newest first). Empty array when unavailable. */
export function loadHistory(): string[] {
  const s = storage()
  if (!s) return []
  try {
    const raw = s.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

/** Record a prompt at the front (dedupe, cap length). Returns the new list. */
export function recordHistory(text: string, prev?: string[]): string[] {
  const t = text.trim()
  if (!t) return prev ?? loadHistory()
  const base = prev ?? loadHistory()
  const next = [t, ...base.filter((x) => x !== t)].slice(0, MAX_HISTORY)
  const s = storage()
  try {
    s?.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

/** Load pinned commands (max 3, oldest-first pin order). */
export function loadPins(): string[] {
  const s = storage()
  if (!s) return []
  try {
    const raw = s.getItem(PINS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => typeof x === 'string').slice(0, MAX_PINS)
  } catch {
    return []
  }
}

/** Toggle a pin. Returns the new pin list (max 3; oldest pin wins the cap). */
export function togglePin(text: string, prev?: string[]): string[] {
  const t = text.trim()
  if (!t) return prev ?? loadPins()
  const base = prev ?? loadPins()
  let next: string[]
  if (base.includes(t)) {
    next = base.filter((x) => x !== t)
  } else {
    next = [...base, t].slice(-MAX_PINS)
  }
  const s = storage()
  try {
    s?.setItem(PINS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

/** Ordered popup rows: pins first (in pin order), then history minus pinned. */
export function historyRows(history: string[], pins: string[]): string[] {
  const pinned = pins.filter((p) => p.trim().length > 0)
  const rest = history.filter((h) => !pinned.includes(h))
  return [...pinned, ...rest]
}

/** Short card title for a history row (Codex-style popup card): the raw slash
 *  command name (e.g. "create-skill"), or the first words of a plain prompt
 *  truncated at a word boundary (max ~30 chars). */
export function historyTitle(text: string): string {
  const parsed = parseSlashInput(text)
  if (parsed) return parsed.name || prettySlashLabel(text)
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= 30) return t
  const cut = t.slice(0, 30)
  const sp = cut.lastIndexOf(' ')
  return (sp > 10 ? cut.slice(0, sp) : cut) + '…'
}

/** Secondary meta line under the title: command args (or the pretty label when
 *  the command has no args), or the full plain prompt on one line. */
export function historyMeta(text: string): string {
  const parsed = parseSlashInput(text)
  if (parsed) return parsed.args || prettySlashLabel(text)
  return text.trim().replace(/\s+/g, ' ')
}
