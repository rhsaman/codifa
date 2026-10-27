import { ensureSidecar, providerKeys, syncSkill } from './api'
import type { SkillRow } from './api'
import type {
  McpServerConfig,
  PluginInfo,
  PluginInstallResult,
  ProviderConfig,
  ToolFallback,
} from '../types'
import { toolFallbackEntries } from './toolSlots'

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

/** One part whose English description should become Persian trigger phrases. */
export interface KeywordRequestItem {
  name: string
  description: string
}

/** Translate part descriptions into the Persian phrases the catalog matches on.
 *
 *  The catalog is matched by KEY, so an English-only description leaves a part
 *  unreachable from a Persian request: the phrases have to be written down, and
 *  a translation of what the part says it does is the only honest source. The
 *  provider snapshot travels with the call exactly like the title call's — the
 *  backend has no settings of its own to read here. */
export async function translateKeywords(params: {
  provider: ProviderConfig
  subagentModels?: Record<string, string>
  subagentThinking?: Record<string, string>
  /** Settings → Tools fallback lists, keyed like `subagentModels`: the "Other"
   *  group's list is what the translation retries on when its model fails. */
  toolFallbacks?: Record<string, string[]>
  providers?: Record<string, ProviderConfig>
  modelReasoning?: boolean
  items: KeywordRequestItem[]
}): Promise<{ keywords: Record<string, string[]>; error?: string }> {
  const url = await ensureSidecar()
  if (!url) return { keywords: {}, error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: params.provider.kind,
        provider_id: params.provider.id,
        api_keys: providerKeys(params.provider),
        base_url: params.provider.baseUrl,
        model: params.provider.model,
        subagent_models: params.subagentModels ?? {},
        subagent_thinking: params.subagentThinking ?? {},
        tool_fallbacks: params.toolFallbacks ?? {},
        providers: params.providers ?? {},
        model_reasoning: params.modelReasoning ?? false,
        items: params.items,
      }),
      // One batched call for the whole list, so the budget only has to cover a
      // slow model, not one round trip per skill.
      signal: AbortSignal.timeout(120_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      keywords?: Record<string, string[]>
      error?: string
      detail?: string
    }
    if (!res.ok) return { keywords: {}, error: data.detail || `request failed (${res.status})` }
    return data.error && !data.keywords
      ? { keywords: {}, error: data.error }
      : { keywords: data.keywords ?? {}, ...(data.error ? { error: data.error } : {}) }
  } catch (err) {
    return { keywords: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The provider snapshot a one-shot model call runs on.
 *
 *  Passed in explicitly rather than read from the store here: the two callers
 *  (a Settings component and a chat command handler) already hold this state,
 *  and a data module that reached into the store would be untestable on its own. */
export interface KeywordFillContext {
  provider: ProviderConfig | undefined
  subagentModels?: Record<string, string>
  subagentThinking?: Record<string, string>
  toolFallbacks?: Record<string, ToolFallback[]>
  providers?: ProviderConfig[]
  modelReasoning?: boolean
}

export interface KeywordFillResult {
  /** Skills that needed keywords and got them on disk. */
  filled: number
  /** Skills that needed them (none of their own, and a description to read). */
  total: number
  /** Why nothing could be filled, when that happened. */
  error?: string
}

/** Give a bundle's keyword-less skills the Persian phrases their descriptions imply.
 *
 *  A bundle installed from a marketplace ships English descriptions, and the
 *  catalog is matched by KEY — so every skill of a fresh install was invisible to
 *  a Persian request until somebody opened the page and clicked Translate. Doing
 *  it here makes an install (from the browser or from `/plugin install`) land
 *  ready to trigger.
 *
 *  Only skills that carry NO keywords of their own AND have a description are
 *  touched: a list the repo shipped, or the user typed, is never overwritten, and
 *  the whole batch is one model call. Never throws — a failed translation reports
 *  its reason and leaves every file as it was. */
export async function fillMissingKeywords(
  slug: string,
  ctx: KeywordFillContext,
): Promise<KeywordFillResult> {
  if (!ctx.provider) return { filled: 0, total: 0, error: 'no model provider is configured' }
  const listed = await listPluginSkills()
  if ('error' in listed) return { filled: 0, total: 0, error: listed.error }
  const pending = listed.filter(
    (row) =>
      row.plugin_slug === slug &&
      (row.fa_keywords ?? []).length === 0 &&
      (row.description ?? '').trim() !== '',
  )
  if (pending.length === 0) return { filled: 0, total: 0 }
  const res = await translateKeywords({
    provider: ctx.provider,
    subagentModels: ctx.subagentModels,
    subagentThinking: ctx.subagentThinking,
    toolFallbacks: toolFallbackEntries(ctx.toolFallbacks),
    providers: Object.fromEntries((ctx.providers ?? []).map((p) => [p.id, p])),
    modelReasoning: ctx.modelReasoning ?? false,
    items: pending.map((row) => ({ name: row.name, description: row.description })),
  })
  let filled = 0
  for (const row of pending) {
    const phrases = res.keywords[row.name]
    if (!phrases || phrases.length === 0) continue
    // An empty `content` makes the writer keep the body already on disk, so only
    // the keywords change.
    const out = await syncSkill({
      name: row.name,
      description: row.description,
      faKeywords: phrases,
      plugin: slug,
    })
    if (out.ok) filled += 1
  }
  return {
    filled,
    total: pending.length,
    // A partial fill is a success, not an error: the reason is only worth
    // reporting when nothing landed at all.
    ...(filled === 0 && res.error ? { error: res.error } : {}),
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

/** One plugin a marketplace index advertises, already an install address.
 *
 *  `repo`/`repo_path`/`repo_ref` are exactly the arguments `installPlugin`
 *  takes, so a row from the browse list installs without any translation.
 */
export interface MarketplaceEntry {
  name: string
  description: string
  version: string
  author: string
  /** The index's own topic tag (`security`, `documentation`…), when it has one.
   *  It is what a Persian keyword seed derives from at install time. */
  category?: string
  repo: string
  repo_path: string
  repo_ref: string
}

/** A marketplace index: its own name plus the plugins it lists. */
export interface MarketplaceIndex {
  name: string
  description: string
  source: string
  count: number
  plugins: MarketplaceEntry[]
  /** The list came from the saved copy because GitHub could not be reached. */
  stale?: boolean
}

/** How long one browse may wait before it is reported as failed.
 *
 *  A cached index answers in milliseconds; a cold one is a GitHub round-trip
 *  plus the file read. */
export const MARKET_BROWSE_TIMEOUT_MS = 45_000

/** Browse a marketplace repo's index WITHOUT installing anything. */
export async function listMarketplace(body: {
  repo: string
  path?: string
  git_ref?: string
  /** Ignore a still-fresh disk copy and ask GitHub again. */
  refresh?: boolean
}): Promise<MarketplaceIndex | { error: string }> {
  // Everything is caught here, including `ensureSidecar`: it rejects when the
  // IPC itself throws (no `window.coder` at all). Letting that escape made the
  // caller's `setLoading(false)` unreachable and the tab sat on "Reading the
  // index…" forever instead of showing why it failed.
  try {
    return await browseIndex(body)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function browseIndex(body: {
  repo: string
  path?: string
  git_ref?: string
  refresh?: boolean
}): Promise<MarketplaceIndex | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  const q = new URLSearchParams({ repo: body.repo })
  if (body.path) q.set('path', body.path)
  if (body.git_ref) q.set('git_ref', body.git_ref)
  if (body.refresh) q.set('refresh', '1')
  // A cold read goes out to GitHub (two API round-trips) and the router runs it
  // on a blocking task, so a slow or rate-limited request must not be able to
  // keep the tab on "Reading the index..." forever: without a deadline the
  // `finally` that clears `loading` never runs. A cached index still answers in
  // milliseconds, so the cap only bounds the miss.
  const res = await fetch(`${url}/plugins/marketplace?${q}`, {
    signal: AbortSignal.timeout(MARKET_BROWSE_TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => ({}))) as MarketplaceIndex & { detail?: string }
  if (!res.ok) return { error: data.detail || `browse failed (${res.status})` }
  return data
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
  /** Which marketplace tab the row came from: `skills` writes the skills store
   *  and `mcp` the connector store, so an installed skill is where Settings →
   *  Skills (and `@`) reads from. Omitted = a plugin bundle. */
  kind?: 'plugins' | 'skills' | 'mcp'
  /** The index row's declared category + description, used only to seed Persian
   *  keywords when the bundle ships none. */
  category?: string
  description?: string
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

/** One skill of a plugin bundle, tagged with the bundle it belongs to. */
export interface PluginSkillRow extends SkillRow {
  /** Folder slug of the owning bundle — what a save/delete must target. */
  plugin_slug?: string
  /** False when the bundle is switched off; Settings still lists and edits it. */
  plugin_enabled?: boolean
}

/** Every skill inside EVERY plugin, enabled or not.
 *
 *  `/skills` lists only the user's own store and `/skills/available` only what
 *  the agent can load right now (a switched-off bundle contributes nothing),
 *  so neither can back a Settings list that has to show what a bundle CONTAINS
 *  — which is exactly what someone goes looking for while it is off.
 */
export async function listPluginSkills(): Promise<PluginSkillRow[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/skills`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { skills?: PluginSkillRow[] }
    return data.skills ?? []
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** One connector of a plugin bundle. */
export interface PluginConnectorRow {
  name: string
  cfg: McpServerConfig
  /** What this connector is for — stored in the bundle manifest, NOT in `cfg`
   *  (that object is forwarded to the MCP server verbatim). */
  description?: string
  /** Persian phrases this connector answers to; same store as `description`. */
  fa_keywords?: string[]
  /** Owning plugin's display name. */
  plugin?: string
  plugin_slug?: string
  plugin_enabled?: boolean
}

/** One runnable script of a plugin bundle. */
export interface PluginScriptRow {
  name: string
  language: string
  description: string
  fa_keywords?: string[]
  /** Source file the code lives in (`main.rs`, `main.py`, …). */
  file?: string
  plugin?: string
  plugin_slug?: string
  plugin_enabled?: boolean
}

/** Every script inside every plugin, each row naming its owner. */
export async function listPluginScripts(): Promise<PluginScriptRow[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/scripts`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { scripts?: PluginScriptRow[] }
    return data.scripts ?? []
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Every connector inside every plugin, each row naming its owner. */
export async function listPluginConnectors(): Promise<
  PluginConnectorRow[] | { error: string }
> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/mcp`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { connectors?: PluginConnectorRow[] }
    return data.connectors ?? []
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Upsert one connector inside a plugin bundle (a rename drops the old key). */
export async function savePluginConnector(
  slug: string,
  name: string,
  cfg: McpServerConfig,
  previousName?: string,
  /** The row's own description and Persian keywords. They travel in the same
   *  call but are filed in the bundle manifest — never inside `cfg`, which the
   *  MCP client forwards verbatim. */
  meta?: { description?: string; faKeywords?: string | string[] },
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/mcp/save', {
    slug,
    name,
    cfg,
    ...(previousName && previousName !== name ? { previous_name: previousName } : {}),
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
    ...(meta?.faKeywords !== undefined ? { fa_keywords: meta.faKeywords } : {}),
  })
  return 'error' in out ? out : { ok: true }
}

/** Remove one connector from a plugin bundle. */
export async function deletePluginConnector(
  slug: string,
  name: string,
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/mcp/delete', { slug, name })
  return 'error' in out ? out : { ok: true }
}

/** Patch one script's own metadata inside a bundle.
 *
 *  Sends NO `content`, so the backend keeps the body and the language already
 *  on disk — only the description and the Persian keywords change. */
export async function savePluginScript(
  slug: string,
  name: string,
  meta: { description?: string; faKeywords?: string | string[] },
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/update', {
    slug,
    scripts: [
      {
        name,
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        ...(meta.faKeywords !== undefined ? { fa_keywords: meta.faKeywords } : {}),
      },
    ],
  })
  return 'error' in out ? out : { ok: true }
}

/** Remove one script (its folder, manifest and code) from a bundle. */
export async function deletePluginScript(
  slug: string,
  name: string,
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/update', { slug, deleted_scripts: [name] })
  return 'error' in out ? out : { ok: true }
}
