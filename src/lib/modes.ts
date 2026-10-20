import type { AgentMode, AgentModeDef, Settings } from '../types'

/** Built-in modes. Prompts themselves are authoritative on the backend; the
 *  `prompt` here is only the user's per-mode custom prompt from settings.
 *  Any built-in capability missing from this registry falls back to "ask". */
export const BUILTIN_MODES: AgentModeDef[] = [
  {
    id: 'ask',
    label: 'Ask',
    icon: 'chat',
    description: 'Mentor mode: short, simple answers in plain words — which file, which line, what to change. Expands only when you ask for detail. Reads and inspects freely (files, shell, web); never writes.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true },
  },
  {
    id: 'plan',
    label: 'Plan',
    icon: 'list',
    description: 'Plans the work: a short, scannable step list naming the files it touches, for Build mode to execute. Reads and inspects freely; never writes.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true },
  },
  {
    id: 'build',
    label: 'Build',
    icon: 'code',
    description: 'Write and edit code, run commands. Full access to your project — the edit is the artifact, the reply is a short report of what changed.',
    capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true },
  },
]

export const BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id))

/** Only the three built-in modes exist — user-created custom modes were removed. */
export function allModes(_settings: Settings): AgentModeDef[] {
  return [...BUILTIN_MODES]
}

export function getMode(settings: Settings, id: AgentMode): AgentModeDef {
  return (
    allModes(settings).find((m) => m.id === id) ??
    BUILTIN_MODES.find((m) => m.id === 'ask')!
  )
}

export const FALLBACK_MODE: AgentModeDef = BUILTIN_MODES[0]

/** Legacy mode ids from before the modes registry existed. */
export function normalizeMode(id: AgentMode | undefined): AgentMode {
  if (id === 'chat') return 'ask'
  if (id === 'codewriter') return 'build'
  return id || 'ask'
}