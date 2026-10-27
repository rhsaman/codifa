import type { McpServerConfig } from '../types'
import { listMcp } from './api'
import type { PluginCommand } from './skills'

/** What a `/`-plugin command expands to for ONE turn.
 *
 *  A plugin is a BUNDLE the user installed as a unit: naming it must load the
 *  bundle, not one skill out of it. Every skill it holds is attached (the
 *  backend's `skills` filter is a whitelist, so an empty list means "all"), and
 *  its MCP connectors come along with their schemas. A bundle the user has to
 *  take apart by hand is the bundle failing at its one job. */
export interface PluginTurn {
  /** Every skill in the bundle, by the display name the backend attaches by. */
  skills: string[]
  /** The bundle's own connectors, as the per-turn `mcpServers` override. */
  mcpServers?: Record<string, McpServerConfig>
  /** Connector names, for the transcript line that says what came along. */
  mcpNames: string[]
}

/** The bundle's skills, in catalog order. */
export function bundleSkillNames(cmd: PluginCommand): string[] {
  return [...new Set(cmd.skills.map((s) => s.skill).filter(Boolean))]
}

/** Resolve everything `/<plugin>` brings to a turn.
 *
 *  Naming the bundle loads ALL of it — that is why the user bundled it. Passing
 *  `onlySkill` narrows the turn to one skill while still bringing the bundle's
 *  connectors, which is how a single skill or one MCP server is reached without
 *  spelling out the whole bundle. Pass `onlyMcp` to keep just those connectors.
 *
 *  Connectors live in a flat store keyed by name and exposed with the owning
 *  bundle's folder, so a name is attributed to its bundle through `dirs` —
 *  matching on the bundle SLUG would miss a folder named differently. A failed
 *  read yields the skills alone: the turn must still run. */
export async function resolvePluginTurn(
  cmd: PluginCommand,
  opts: { onlySkill?: string; onlyMcp?: string[] } = {},
): Promise<PluginTurn> {
  const skills = opts.onlySkill ? [opts.onlySkill] : bundleSkillNames(cmd)
  try {
    const { mcpServers, dirs } = await listMcp()
    const wanted = opts.onlyMcp?.map((n) => n.trim().toLowerCase()).filter(Boolean)
    const mcpNames = Object.keys(mcpServers ?? {}).filter((name) => {
      // An explicitly named connector may live outside the bundle (a shared
      // server the bundle reuses), so the name alone is enough for it.
      if (wanted?.length) return wanted.includes(name.toLowerCase())
      const dir = dirs?.[name]
      return !!dir && dir.replace(/\/+$/, '').endsWith(`/${cmd.name}`)
    })
    if (mcpNames.length === 0) return { skills, mcpNames }
    const scoped: Record<string, McpServerConfig> = {}
    for (const name of mcpNames) scoped[name] = mcpServers[name]
    return { skills, mcpServers: scoped, mcpNames }
  } catch {
    return { skills, mcpNames: [] }
  }
}
