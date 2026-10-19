/**
 * MCP tool-name helpers.
 *
 * The native agent exposes an MCP tool BARE (`list_containers`) when its name is
 * unique across the enabled connectors, and qualified
 * (`mcp__docker__list_containers`) only when two connectors both claim it.
 * Both forms must behave identically in the UI, so every consumer goes through
 * these helpers instead of matching the raw string — a `startsWith("browser_")`
 * check silently missed every qualified browser call and the right-side Browser
 * panel never docked.
 */

/** The tool name without its `mcp__<server>__` prefix (unchanged when bare). */
export function bareToolName(tool: string): string {
  if (!tool.startsWith("mcp__")) return tool
  const rest = tool.slice(5)
  const i = rest.indexOf("__")
  return i > 0 ? rest.slice(i + 2) : tool
}

/** The connector a qualified name belongs to, or "" for a bare name. */
export function mcpServerOf(tool: string): string {
  if (!tool.startsWith("mcp__")) return ""
  const rest = tool.slice(5)
  const i = rest.indexOf("__")
  return i > 0 ? rest.slice(0, i) : ""
}

/** True for a browser tool, bare or MCP-qualified. The right-side Browser
 *  panel docks on the first one so the agent's browsing stays visible in-app. */
export function isBrowserTool(tool: string): boolean {
  return bareToolName(tool).startsWith("browser_")
}
