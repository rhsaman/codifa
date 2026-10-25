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
const COMMAND_USAGE_KEY = 'coder:commandUsage'

export const MAX_HISTORY = 10
export const MAX_PINS = 3
export const MAX_COMMAND_USAGE = 20

/** What the token AFTER a sub-command expects.
 *
 *  `name` — a real object the app knows (a plugin/skill/connector/document name),
 *           so the menu can offer the names that actually exist instead of
 *           making the user recall a slug.
 *  `repo` — a git repo reference (`owner/repo`, a URL, or a local path), with the
 *           tokens after it being the sub-folder and the branch.
 *  `free` — prose the model reads; nothing to complete. */
export type ArgKind = 'name' | 'repo' | 'free'

/** One sub-command of a slash command. */
export interface SubCommand {
  name: string
  hint: string
  /** What the token right after `name` expects. */
  arg: ArgKind
  /** The token after that (an install's sub-folder, then its branch). */
  rest?: ArgKind
}

/** Sub-commands per command, in the order the menu lists them.
 *
 *  One source of truth for the menu, the `/help` text and the dispatcher: the
 *  words used to be typed only inside the hint strings, so the menu could not
 *  offer them and `handleCommand` had to re-parse them by hand. */
export const SUBCOMMANDS: Record<string, SubCommand[]> = {
  plugin: [
    { name: 'list', hint: 'List installed bundles', arg: 'free' },
    { name: 'install', hint: 'Install a bundle from a repo', arg: 'repo', rest: 'free' },
    { name: 'create', hint: 'Create a bundle from a description', arg: 'free' },
    { name: 'run', hint: 'Run one of the bundle\u2019s scripts', arg: 'free' },
    { name: 'update', hint: 'Edit a bundle (skills, scripts, keywords)', arg: 'name' },
    { name: 'on', hint: 'Switch a bundle on', arg: 'name' },
    { name: 'off', hint: 'Switch a bundle off', arg: 'name' },
    { name: 'remove', hint: 'Delete a bundle and its contents', arg: 'name' },
  ],
  skill: [
    { name: 'list', hint: 'List every installed skill', arg: 'free' },
    { name: 'install', hint: 'Install a skill from a repo', arg: 'repo', rest: 'free' },
    { name: 'create', hint: 'Create a skill from a description', arg: 'free' },
    { name: 'update', hint: 'Edit an existing skill', arg: 'name' },
    { name: 'remove', hint: 'Delete a skill', arg: 'name' },
  ],
  mcp: [
    { name: 'list', hint: 'List every connector', arg: 'free' },
    // `install` was already implemented in the dispatcher but missing from this
    // table, so the menu could not offer it and `/help` hid it — a path only a
    // user who already knew the word could reach.
    { name: 'install', hint: 'Install a connector bundle from a repo', arg: 'repo', rest: 'free' },
    { name: 'create', hint: 'Create a connector from a description', arg: 'free' },
    { name: 'update', hint: 'Edit an existing connector', arg: 'name' },
    { name: 'remove', hint: 'Delete a connector', arg: 'name' },
  ],
  artifact: [
    { name: 'list', hint: 'List this chat\u2019s documents', arg: 'free' },
    { name: 'create', hint: 'Build a document from a description', arg: 'free' },
    { name: 'update', hint: 'Edit an existing document', arg: 'name' },
    { name: 'remove', hint: 'Delete a document', arg: 'name' },
  ],
  schedule: [
    { name: 'list', hint: 'List scheduled tasks', arg: 'free' },
    { name: 'create', hint: 'Create a scheduled task', arg: 'free' },
    { name: 'update', hint: 'Edit a scheduled task', arg: 'name' },
    { name: 'run', hint: 'Run a task now', arg: 'name' },
    { name: 'remove', hint: 'Delete a scheduled task', arg: 'name' },
  ],
  goal: [{ name: 'clear', hint: 'Clear the current goal', arg: 'free' }],
}

/** The free-text BODY of a line, with a sub-command the menu offers stripped.
 *
 *  `/schedule create هر روز ساعت نه` used to forward the whole tail verbatim, so
 *  the model was handed the description `"create هر روز ساعت نه"` — and for
 *  `/plugin create` the word arrived right after a prompt that already said
 *  "Create or edit a plugin …". Only a KNOWN sub-command is stripped: a line
 *  with none (`/plugin یک پلاگین بساز`) keeps every word, or the first one would
 *  silently vanish from the description. */
export function slashBody(command: string, rest: string): string {
  const text = rest.trim()
  if (!text) return ''
  const key = command.startsWith('/') ? command.slice(1) : command
  const parts = text.split(/\s+/)
  const known = (SUBCOMMANDS[key] ?? []).some((s) => s.name === parts[0].toLowerCase())
  return known ? parts.slice(1).join(' ') : text
}

/** Where the caret sits in the whitespace-separated words of a slash line. */
export interface SlashCaret {
  /** Offset where the caret's word starts (0 for the `/command` token). */
  start: number
  /** Offset just past the caret's word. */
  end: number
  /** The characters of the caret's word, WITHOUT a leading slash on word 0. */
  word: string
  /** 0 = the command itself, 1 = its sub-command, 2+ = a value. */
  index: number  /** The complete words BEFORE the caret's, command first (no slash). */
  prev: string[]
}

/** Locate the word the caret is inside, for the multi-level slash menu.
 *
 *  The palette used to close as soon as the user typed a space, which left no
 *  way to offer `/plugin install` \u2192 `list|install|\u2026`; the caret position is what
 *  tells the menu WHICH level it is completing. Returns null when the input is
 *  not a slash line or the caret is in a leading blank. */
export function slashCaretAt(text: string, caret: number): SlashCaret | null {
  if (!text.startsWith('/')) return null
  const pos = Math.max(0, Math.min(caret, text.length))
  let start = pos
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  let end = pos
  while (end < text.length && !/\s/.test(text[end])) end++
  const raw = text.slice(start, end)
  if (start === 0) {
    // Word 0 is `/name`; a bare "/" has nothing to complete yet.
    return { start, end, word: raw.slice(1), index: 0, prev: [] }
  }
  const before = text.slice(1, start).trim()
  const prev = before ? before.split(/\s+/) : []
  // `prev` holds the complete words ahead of this one (the command first), so
  // its LENGTH is this word's 0-based position: 1 = the sub-command, 2 = the
  // first value, and so on.
  return { start, end, word: raw, index: prev.length, prev }
}

/** One-time rename of the stored history/pins/usage to the new command names.
 *
 *  Those lists live in localStorage under the OLD names, so without this the
 *  recent-command ordering silently loses its history and the history popup
 *  keeps offering `/create-skill`, a command that no longer exists. */
export function migrateCommandNames(): void {
  const s = storage()
  if (!s) return
  const renames: Record<string, string> = { 'create-skill': 'skill', 'create-mcp': 'mcp' },
    rewrite = (raw: string): string =>
      raw.replace(/\/(create-skill|create-mcp)\b/g, (_m, n: string) => `/${renames[n]}`)
  try {
    const history = s.getItem(HISTORY_KEY)
    if (history) {
      const arr = JSON.parse(history)
      if (Array.isArray(arr)) {
        const next = arr.map((x) => (typeof x === 'string' ? rewrite(x) : x))
        if (JSON.stringify(next) !== JSON.stringify(arr))
          s.setItem(HISTORY_KEY, JSON.stringify(next))
      }
    }
  } catch {
    /* a corrupt entry must not block startup */
  }
  try {
    const pinsRaw = s.getItem(PINS_KEY)
    if (pinsRaw) {
      const arr = JSON.parse(pinsRaw)
      if (Array.isArray(arr)) {
        const next = arr.map((x) => (typeof x === 'string' ? rewrite(x) : x))
        if (JSON.stringify(next) !== JSON.stringify(arr))
          s.setItem(PINS_KEY, JSON.stringify(next))
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const usageRaw = s.getItem(COMMAND_USAGE_KEY)
    if (usageRaw) {
      const arr = JSON.parse(usageRaw)
      if (Array.isArray(arr)) {
        // Usage stores BARE names (no slash), so the rewrite is a lookup.
        const next = arr.map((x) =>
          typeof x === 'string' && renames[x.trim().toLowerCase()]
            ? renames[x.trim().toLowerCase()]
            : x,
        )
        if (JSON.stringify(next) !== JSON.stringify(arr))
          s.setItem(COMMAND_USAGE_KEY, JSON.stringify(next))
      }
    }
  } catch {
    /* ignore */
  }
}

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
 *  Examples: "/compact" -> "Compact", "/skill install foo" -> "Skill: install foo". */
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
    case 'skill':
      return args ? `Skill: ${args}` : 'Skills'
    case 'mcp':
      return args ? `MCP: ${args}` : 'MCP connectors'
    case 'plugin':
      return args ? `Plugin: ${args}` : 'Plugins'
    case 'artifact':
      return args ? `Artifact: ${args}` : 'Artifact'
    case 'schedule':
      return args ? `Schedule: ${args}` : 'Schedules'
    case 'goal':
      if (args === 'clear') return 'Clear goal'
      return args ? `Goal: ${args}` : 'Set a persistent goal'
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

/** Load persisted slash-command usage (bare command names, newest first). */
export function loadCommandUsage(): string[] {
  const s = storage()
  if (!s) return []
  try {
    const raw = s.getItem(COMMAND_USAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => typeof x === 'string')
      .map((x) => (x as string).trim().toLowerCase().replace(/^\//, ''))
      .filter((x) => x.length > 0)
      .slice(0, MAX_COMMAND_USAGE)
  } catch {
    return []
  }
}

/** Record a slash-command use at the front (dedupe, cap length). Accepts raw
 *  input ("/compact ..."). Non-slash or bare "/" input leaves the list
 *  unchanged. Returns the new list. */
export function recordCommandUsage(input: string, prev?: string[]): string[] {
  const base = prev ?? loadCommandUsage()
  if (!isSlashCommand(input)) return base
  const name = parseSlashInput(input)?.name?.trim().toLowerCase() ?? ''
  if (!name) return base
  const next = [name, ...base.filter((x) => x !== name)].slice(0, MAX_COMMAND_USAGE)
  const s = storage()
  try {
    s?.setItem(COMMAND_USAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  // Notify every mounted chat panel so its command popup re-sorts immediately.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('coder:command-usage'))
    }
  } catch {
    /* ignore */
  }
  return next
}

/** Forget slash commands that no longer exist.
 *
 *  A plugin's skills become `/`-commands named after each skill, and every use
 *  is remembered in three places: the prompt history, the pinned commands and
 *  the recency order of the menu. Deleting a plugin removes the command from
 *  the palette, but those three kept its name forever — so `/my-plugin-skill`
 *  stayed pinned and a mistyped line kept suggesting a command that was gone.
 *
 *  Matching is on the PARSED name, so `/skill update x` is only forgotten when
 *  `skill` itself is in `names`. Returns nothing: the stores are the state.
 */
export function forgetCommands(names: string[]): void {
  const dead = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))
  if (dead.size === 0) return
  const s = storage()
  if (!s) return
  const nameOf = (text: string) => parseSlashInput(text)?.name?.trim().toLowerCase() ?? ''
  try {
    const history = loadHistory().filter((t) => !dead.has(nameOf(t)))
    s.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    /* ignore */
  }
  try {
    const pins = loadPins().filter((t) => !dead.has(nameOf(t)))
    s.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    /* ignore */
  }
  try {
    const usage = loadCommandUsage().filter((n) => !dead.has(n.trim().toLowerCase()))
    s.setItem(COMMAND_USAGE_KEY, JSON.stringify(usage))
    // Same event `recordCommandUsage` fires, so every mounted composer drops
    // the dead name from its order without waiting for a remount.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('coder:command-usage'))
    }
  } catch {
    /* ignore */
  }
}

/** Generic recent-first sort by usage: used items first (newest use first),
 *  never-used keep their original relative order. Shared by the command and
 *  skill popups so both sort the same way. Matching stays the caller's job. */
export function sortByRecentUsage<T>(items: T[], usage: string[], keyOf: (item: T) => string): T[] {
  if (usage.length === 0) return [...items]
  const rank = new Map<string, number>()
  usage.forEach((n, i) => {
    const key = n.trim().toLowerCase()
    if (key && !rank.has(key)) rank.set(key, i)
  })
  return [...items]
    .map((item, idx) => {
      const k = keyOf(item).toLowerCase()
      return { item, idx, r: rank.has(k) ? (rank.get(k) as number) : Number.POSITIVE_INFINITY }
    })
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.idx - b.idx))
    .map((x) => x.item)
}

/** Bottom-anchored popup order (terminal-style, like the recent-prompt popup):
 *  oldest on top, newest just above the bottom. Unused items keep their
 *  original order on top; used items sit at the bottom oldest-first with the
 *  newest last (closest to the input). Shared by the command and skill popups. */
export function bottomAnchoredByUsage<T>(items: T[], usage: string[], keyOf: (item: T) => string): T[] {
  if (usage.length === 0) return [...items]
  const rank = new Map<string, number>()
  usage.forEach((n, i) => {
    const key = n.trim().toLowerCase()
    if (key && !rank.has(key)) rank.set(key, i)
  })
  return [...items]
    .map((item, idx) => {
      const k = keyOf(item).toLowerCase()
      const r = rank.has(k) ? (rank.get(k) as number) : Number.POSITIVE_INFINITY
      return { item, idx, r }
    })
    .sort((a, b) => {
      const aUsed = a.r !== Number.POSITIVE_INFINITY
      const bUsed = b.r !== Number.POSITIVE_INFINITY
      if (aUsed !== bUsed) return aUsed ? 1 : -1
      if (!aUsed) return a.idx - b.idx
      if (a.r !== b.r) return b.r - a.r
      return a.idx - b.idx
    })
    .map((x) => x.item)
}

/** Sort command rows by recent usage: used commands first (newest use first),
 *  never-used commands keep their original relative order. Matching stays the
 *  caller's job — this only reorders. */
export function sortCommandsByUsage<T extends { name: string }>(commands: T[], usage: string[]): T[] {
  return sortByRecentUsage(commands, usage, (c) => c.name)
}

/** Ordered popup rows bottom-anchored (terminal-style): oldest history first
 *  at the top, newest just above the bottom, pins last at the very bottom.
 *  `history` arrives newest-first, so the unpinned rest is reversed. */
export function historyRows(history: string[], pins: string[]): string[] {
  const pinned = pins.filter((p) => p.trim().length > 0)
  const rest = history.filter((h) => !pinned.includes(h)).reverse()
  return [...rest, ...pinned]
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
