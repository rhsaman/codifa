import type { ChatMessage, PluginInfo, ToolActivity } from '../types'
import type { SkillRow } from './api'

/** One skill a turn touched: attached up front (@mention / plugin command) or
 *  loaded mid-run by the agent itself through `load_skill`. */
export interface TurnSkill {
  name: string
  /** True once the agent actually loaded this skill's body during the turn. */
  used: boolean
}

/** What the current turn ran with — the newest user message and everything the
 *  agent did after it. Per-chat by construction: the caller passes ONE chat's
 *  message list, the same list the todo panel derives from. */
export interface TurnUsage {
  skills: TurnSkill[]
  /** Enabled MCP connector names for the turn. */
  mcp: string[]
}

/** Index of the message that opens the current turn (the newest user message),
 *  or -1 when the chat has no user message yet. Pure. */
export function turnStart(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** Collect the skills a turn's tool calls asked for, keyed by lowercase name so
 *  an attached `@Ponytail` and a loaded `ponytail` count as one skill. */
function loadedSkills(
  list: ToolActivity[] | undefined,
  out: Map<string, string>,
): void {
  for (const a of list ?? []) {
    if (a.tool === 'load_skill') {
      const raw = a.args?.name ?? a.args?.file
      if (typeof raw === 'string' && raw.trim()) {
        const name = raw.trim()
        out.set(name.toLowerCase(), name)
      }
    }
    // Sub-agent calls live under `children`: a skill loaded inside an explore
    // run still belongs to this turn.
    loadedSkills(a.children, out)
  }
}

/** Skills + connectors of one turn. Pure, so a test can call it directly. */
export function turnUsage(messages: ChatMessage[]): TurnUsage {
  const start = turnStart(messages)
  if (start === -1) return { skills: [], mcp: [] }
  const turn = messages[start]
  const loaded = new Map<string, string>()
  for (const m of messages.slice(start + 1)) loadedSkills(m.toolActivity, loaded)

  const skills: TurnSkill[] = []
  const seen = new Set<string>()
  for (const name of turn.skills ?? []) {
    const key = name.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    skills.push({ name, used: loaded.has(key) })
  }
  // A skill the agent loaded without being handed it up front belongs here too.
  for (const [key, name] of loaded) {
    if (seen.has(key)) continue
    seen.add(key)
    skills.push({ name, used: true })
  }
  return { skills, mcp: Object.keys(turn.mcpServers ?? {}) }
}

/** Plugin that ships a skill ("" when it comes from the store itself). */
export function skillOwner(name: string, catalog: SkillRow[]): string {
  const key = name.trim().toLowerCase()
  if (!key) return ''
  const row = catalog.find(
    (r) => r.name.toLowerCase() === key || (r.slug ?? '').toLowerCase() === key,
  )
  return row?.plugin ?? ''
}

/** Plugins behind the turn's skills and connectors, in first-seen order. */
export function usagePlugins(
  usage: TurnUsage,
  catalog: SkillRow[],
  plugins: PluginInfo[],
): string[] {
  const out: string[] = []
  const add = (name: string) => {
    if (name && !out.includes(name)) out.push(name)
  }
  for (const s of usage.skills) add(skillOwner(s.name, catalog))
  for (const connector of usage.mcp) {
    for (const p of plugins) {
      if (p.mcp?.includes(connector)) add(p.name || p.slug)
    }
  }
  return out
}
