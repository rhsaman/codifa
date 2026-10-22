import { ensureSidecar } from './api'
import type { PluginInfo, PluginInstallResult } from '../types'

/** POST a plugin action and return the resulting plugin record.
 *
 *  Every call goes to the same module the agent's `plugin` tool writes, so a
 *  plugin edited here and one edited by the agent can never disagree.
 */
async function postPlugin(
  path: string,
  body: Record<string, unknown>,
): Promise<PluginInfo | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as PluginInfo & { detail?: string }
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` }
    return data
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** List every plugin folder, enabled or not. */
export async function listPlugins(): Promise<PluginInfo[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { plugins?: PluginInfo[] }
    return data.plugins ?? []
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Create a plugin bundle (fails when the slug already exists). */
export function createPlugin(body: Record<string, unknown>): Promise<PluginInfo | { error: string }> {
  return postPlugin('/plugins/create', body)
}

/** Patch an existing plugin; only the fields sent are changed. */
export function updatePlugin(body: Record<string, unknown>): Promise<PluginInfo | { error: string }> {
  return postPlugin('/plugins/update', body)
}

/** Install a whole bundle out of a git repo — the Claude Desktop flow.
 *
 *  The backend reads the repo (`plugin.json` / `.claude-plugin/plugin.json`,
 *  its skills and its `.mcp.json`) and writes it through the same path a
 *  hand-authored plugin takes, so a reinstall updates in place.
 */
export async function installPlugin(body: {
  repo: string
  repo_path?: string
  repo_ref?: string
  name?: string
  slug?: string
}): Promise<PluginInstallResult | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as PluginInstallResult & { detail?: string }
    if (!res.ok) return { error: data.detail || `install failed (${res.status})` }
    return data
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Switch a plugin on/off. `enabled` omitted = flip the current value. */
export function togglePlugin(
  slug: string,
  enabled?: boolean,
): Promise<PluginInfo | { error: string }> {
  return postPlugin('/plugins/toggle', enabled === undefined ? { slug } : { slug, enabled })
}

/** Remove a plugin folder and everything inside it. */
export async function deletePlugin(slug: string): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/delete', { slug })
  return 'error' in out ? out : { ok: true }
}
