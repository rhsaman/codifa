import type { ChatMessage, PluginInfo, ToolActivity } from '../types'
import type { SkillRow } from './api'
import { isSkillTool } from './toolActivity'

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
  /** Every connector the turn had ENABLED, with `used` telling whether the model
   *  actually loaded it. Enabled-but-never-loaded is the common case and the one
   *  worth seeing: the connector cost the turn an index line, not its schemas. */
  mcp: TurnMcp[]
}

/** One connector as the turn saw it. */
export interface TurnMcp {
  name: string
  used: boolean
}

/** True when a message carries real work: a tool call, an answer or a thought.
 *  An aborted/queued assistant row (all three empty) is not work. */
function ran(m: ChatMessage): boolean {
  if (m.role === 'user') return false
  if ((m.toolActivity?.length ?? 0) > 0) return true
  return Boolean(m.content?.trim() || m.thinking?.trim())
}

/** Index of the message that opens the turn the card describes: the newest
 *  user message above the newest work, or -1 when the chat has no user message
 *  yet. Pure.
 *
 *  NOT simply the newest user message: queued steers and follow-ups typed
 *  after the agent finished sit BELOW the work, so anchoring on the last user
 *  row emptied the window (`slice(lastUser + 1)`) and the right panel reported
 *  "runs without skills" while the transcript showed a `Load Skill` card one
 *  message above. A trailing user message with no answer yet belongs to the
 *  same turn the user is looking at. When nothing has run at all, fall back to
 *  the newest user message so an attached-but-unused skill still shows. */
export function turnStart(messages: ChatMessage[]): number {
  let newestUser = -1
  let lastWork = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') newestUser = i
    else if (ran(m)) lastWork = i
  }
  if (lastWork === -1) return newestUser
  for (let i = lastWork; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return newestUser
}

/** Comparison key for a skill name. Models rewrite a name when they call the
 *  tool — an attached `Test UI` comes back as `test-ui`, `test_ui` or
 *  `TESTUI` — so keying on case alone listed the same skill twice: one row
 *  attached-but-unused plus one loaded. Lowercase the name and drop the
 *  separators; letters outside ASCII (Persian names) are left untouched. */
function skillKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s\-_.]+/g, '')
}

/** Collect the skills a turn's tool calls asked for, keyed by `skillKey` so an
 *  attached `@Ponytail` and a loaded `ponytail`/`pony-tail` count as one. */
function loadedSkills(
  list: ToolActivity[] | undefined,
  out: Map<string, string>,
): void {
  for (const a of list ?? []) {
    if (isSkillTool(a.tool)) {
      const raw = a.args?.name ?? a.args?.file
      if (typeof raw === 'string' && raw.trim()) {
        const name = raw.trim()
        out.set(skillKey(name), name)
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
    const key = skillKey(name)
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
  return { skills, mcp: enabledConnectors(turn, loadedMcp(messages.slice(start + 1))) }
}

/** Connectors the turn loaded on demand. The `mcp_loaded` event on the turn's
 *  user message is authoritative (it is what `use_mcp` reports); a call by the
 *  connector's `mcp__<server>__` prefix is the fallback for a resumed turn whose
 *  event predates this field. Sub-agent calls live under `children`, but a
 *  sub-agent never loads a connector — kept for symmetry. */
function loadedMcp(list: ChatMessage[]): Set<string> {
  const out = new Set<string>()
  for (const m of list) {
    for (const name of m.mcpLoaded ?? []) out.add(name)
    for (const a of m.toolActivity ?? []) {
      if (a.tool === 'use_mcp') {
        const raw = a.args?.server ?? a.args?.name
        if (typeof raw === 'string' && raw.trim()) out.add(raw.trim())
      } else if (a.tool.startsWith('mcp__')) {
        const end = a.tool.indexOf('__', 5)
        if (end > 5) out.add(a.tool.slice(5, end))
      }
    }
  }
  return out
}

/** Enabled connectors paired with whether the model actually loaded them. The
 *  `mcp_loaded` stream event is the authoritative signal; a tool call by the
 *  connector's `mcp__<server>__` prefix counts too, so a turn that called a tool
 *  straight after loading still reads as used. */
function enabledConnectors(turn: ChatMessage, loaded: Set<string>): TurnMcp[] {
  const out: TurnMcp[] = []
  for (const name of Object.keys(turn.mcpServers ?? {})) {
    out.push({ name, used: loaded.has(name) })
  }
  // Loaded without being listed (a plugin connector) still belongs here.
  for (const name of loaded) {
    if (!out.some((c) => c.name === name)) out.push({ name, used: true })
  }
  return out
}

/** Plugin that ships a skill ("" when it comes from the store itself). */
export function skillOwner(name: string, catalog: SkillRow[]): string {
  const key = skillKey(name)
  if (!key) return ''
  const row = catalog.find(
    (r) => skillKey(r.name) === key || skillKey(r.slug ?? '') === key,
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
      if (p.mcp?.includes(connector.name)) add(p.name || p.slug)
    }
  }
  return out
}
