/** Prompt fragments stating the CURRENT state of the record an `update` edits.
 *
 *  `/… update` hands the work to the model, but two of these records cannot be
 *  READ by any tool it has: `create_mcp` REPLACES the whole connector config
 *  (`read` refuses any path outside the project root, and connectors live in
 *  the app's data folder), and the `artifact` tool has no read action at all.
 *  A prompt saying "read its current config first" was therefore
 *  unimplementable: an edited connector came back with its env/args dropped,
 *  and an edited artifact was regenerated from memory — losing whatever the
 *  model did not happen to repeat.
 *
 *  The composer already holds these values, so it states them instead. Pure on
 *  purpose: fetching stays in Chat.tsx, the wording is unit-tested here.
 */

import type { McpServerConfig } from '../types'

/** The slice of an artifact document this needs.
 *
 *  Kept structural rather than imported from `./artifacts`: that module pulls
 *  in the fetch layer (`ensureSidecar` -> `window.coder`), which would make
 *  this file untestable under plain node. */
export interface ArtifactBody {
  title?: string
  kind?: string
  version?: number
  content: string
}

/** The stored spelling of a name the user typed. The tools themselves match
 *  names case-insensitively, so the prompt must agree with them. */
function findKey(names: string[], wanted: string): string | undefined {
  const want = wanted.trim().toLowerCase()
  return names.find((n) => n.toLowerCase() === want)
}

/** Current saved config of one MCP connector, for an `update` prompt. */
export function connectorContext(
  name: string,
  servers: Record<string, McpServerConfig>,
): string {
  const key = findKey(Object.keys(servers), name)
  if (!key) {
    return (
      ` No connector named "${name}" is saved, so list them first (the exact ` +
      `name matters) or create it with create_mcp instead of updating.`
    )
  }
  return (
    ` Its CURRENT saved config is:\n\n\`\`\`json\n` +
    JSON.stringify(servers[key], null, 2) +
    `\n\`\`\`\n\ncreate_mcp REPLACES the whole record, so send EVERY field back ` +
    `and change only what was asked.`
  )
}

/** Current saved body of one artifact, for an `update` prompt.
 *
 *  Never truncated: a cut body would be saved back as the next version and
 *  silently destroy the rest of the document — the exact failure this exists
 *  to prevent. */
export function artifactContext(doc: ArtifactBody | { error: string }): string {
  if ('error' in doc) {
    return ` It could not be read (${doc.error}), so find the right id with the artifact list first.`
  }
  const title = doc.title ? `, title "${doc.title}"` : ''
  return (
    ` Its CURRENT saved body (kind ${doc.kind ?? 'html'}, v${doc.version ?? 1}${title}) is:\n\n` +
    doc.content +
    `\n\n---\naction=update saves a WHOLE new version: return the complete edited ` +
    `document as content, never a fragment.`
  )
}
