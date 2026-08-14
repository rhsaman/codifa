import type { AgentMode, AgentModeDef, Settings } from '../types'

/** Built-in modes. Prompts themselves are authoritative on the backend; the
 *  `prompt` here is only the user's per-mode custom prompt from settings.
 *  Any built-in capability missing from this registry falls back to "ask". */
export const BUILTIN_MODES: AgentModeDef[] = [
  {
    id: 'ask',
    label: 'Ask',
    icon: 'chat',
    description: 'Mentor mode: answers your questions and teaches you step by step — which file, which line, what to change. Read-only, never modifies anything.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: false, web: true },
  },
  {
    id: 'plan',
    label: 'Plan',
    icon: 'list',
    description: 'Plans the work: scouts the code and lays out concrete steps and changes for Coder mode. Read-only files and terminal, never writes.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true },
  },
  {
    id: 'coder',
    label: 'Coder',
    icon: 'code',
    description: 'Write and edit code, run commands. Full access to your project.',
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
  if (id === 'codewriter') return 'coder'
  return id || 'ask'
}