/** Delegation-tool helpers shared by the event fold (`toolActivity.ts`) and the
 *  render layer (`toolcall/naming.ts`), kept free of React/store imports.
 *
 *  Every sub-agent is advertised under ONE prefix — the builtin research agent
 *  keeps the bare `explore`, and every custom/plugin profile is `agent__<id>`
 *  (a custom row's stable id, or a bundle agent's frontmatter name). The chat
 *  must treat both alike: nested child events, the sub-agent card, the side
 *  panel, and the "is this a delegation?" filters all key on this predicate. */

export const DELEGATION_PREFIX = "agent__";

/** True for every delegation tool: `explore` or any `agent__<id>`. */
export function isDelegationTool(tool: string): boolean {
  return tool === "explore" || tool.startsWith(DELEGATION_PREFIX);
}

/** The stable id behind an `agent__<id>` delegation tool ("" otherwise). */
export function subagentIdOf(tool: string): string {
  return tool.startsWith(DELEGATION_PREFIX)
    ? tool.slice(DELEGATION_PREFIX.length).trim()
    : "";
}
