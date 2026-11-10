import { ensureSidecar } from './api'
import { looksLikeRepoAddress } from './repoAddress'
import type { SkillRow } from './api'
import type { McpServerConfig, PluginInfo, PluginInstallResult } from '../types'

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
  /** The skill folders this row publishes, when the index names them. A row
   *  may point at the repo root and still select only part of its skills
   *  (`anthropics/skills` does), so the install must carry this list. */
  skills?: string[]
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
  // `true` spelled out: the backend's query bool only accepts true/false, and
  // `1` turned every chip click and Refresh into a 400 before the read began.
  if (body.refresh) q.set('refresh', 'true')
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
 *
 *  While the request runs, the row is registered in the module-level install
 *  registry below: an install is a BACKEND job that outlives the component that
 *  started it, and the UI has to keep telling the truth about it across tab
 *  switches and Settings reopenings. */
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
  /** The skill folders the row publishes. A row can point at a repo root and
   *  still select a subset (`anthropics/skills`), so this list is what keeps
   *  the install from pulling in every skill in the repo. */
  skills?: string[]
}): Promise<PluginInstallResult | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  const key = marketKey(body.repo, body.repo_path, body.repo_ref)
  installingRows.set(key, body.name ?? body.repo)
  notifyInstalls()
  try {
    let res: Response
    try {
      res = await fetch(`${url}/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // A network-level failure — most often the webview cutting a request that
      // heard no bytes for ~60s (WebKit's no-data timer). The backend's
      // blocking install keeps running either way, so "connection dropped" is
      // NOT "install failed": watch the plugin list for the bundle landing
      // before reporting anything.
      return await waitForLateInstall(body, err)
    }
    const data = (await res.json().catch(() => ({}))) as PluginInstallResult & { detail?: string }
    if (!res.ok) return { error: data.detail || `install failed (${res.status})` }
    return data
  } finally {
    installingRows.delete(key)
    notifyInstalls()
  }
}

/** Live progress of the install the sidecar is running right now.
 *
 *  The install is one blocking POST, so this is a POLL, not a stream: the
 *  chat's progress bubble reads it on a timer while the request is in flight
 *  and stops the moment the request settles (idle = nothing running).
 *  `listing` walks the repo tree, `reading` carries done/total over the bundle
 *  files, `writing` is the bundle hitting disk. */
export interface InstallProgress {
  phase: 'listing' | 'reading' | 'writing' | 'idle'
  done: number
  total: number
}

export async function installProgress(): Promise<InstallProgress | null> {
  const url = await ensureSidecar()
  if (!url) return null
  try {
    const res = await fetch(`${url}/plugins/install-progress`)
    if (!res.ok) return null
    return (await res.json()) as InstallProgress
  } catch {
    return null
  }
}

/** Install addresses of the rows that are MID-INSTALL right now, module-level.
 *
 *  Keyed by install address (`marketKey`), valued by the row name for
 *  debugging. Component state cannot hold this: the Marketplaces editor
 *  unmounts on every tab switch inside Settings, and losing the flight made a
 *  running install invisible — the card fell back to a plain Install button,
 *  which read as "my download was cancelled" and invited a second, concurrent
 *  install of the same row. It also cannot be ONE busy string: two rows
 *  installing side by side must both keep their spinner, not blank each other. */
const installingRows = new Map<string, string>()
/** Bumped on every registry change; a re-render trigger for subscribers, which
 *  then read the rows through `isRowInstalling`. */
let installVersion = 0
const installListeners = new Set<() => void>()

function notifyInstalls(): void {
  installVersion += 1
  for (const listener of installListeners) listener()
}

/** Subscribe to install-flight changes; pairs with `isRowInstalling`. */
export function subscribeInstallChanges(listener: () => void): () => void {
  installListeners.add(listener)
  return () => {
    installListeners.delete(listener)
  }
}

/** Monotonic version of the install registry, for subscribers that want a
 *  `useSyncExternalStore` snapshot value instead of a callback. */
export function installStateVersion(): number {
  return installVersion
}

/** Whether the row at this install address is mid-install right now. */
export function isRowInstalling(key: string): boolean {
  return installingRows.has(key)
}

/** The stable id of one install address — repo, sub-folder and ref. */
export function marketKey(repo: string, path?: string, gitRef?: string): string {
  return `${repo}|${path ?? ''}|${gitRef ?? ''}`
}

/** One marketplace address parsed from the single string a user types.
 *
 *  `owner/repo@ref/sub-path`: the ref ends at the first `/` after the `@`
 *  (tags may hold slashes), and everything after it is the sub-folder. The
 *  Settings form and the `/plugin marketplace add` command share this parser so
 *  the two can never disagree about what an address means. */
export interface MarketplaceAddress {
  repo: string
  path?: string
  git_ref?: string
}

export function parseMarketplaceAddress(raw: string): MarketplaceAddress {
  let addr = raw.trim()
  if (!addr) return { repo: '' }
  let refPart = ''
  let subPart = ''
  const at = addr.indexOf('@')
  if (at > 0 && !addr.startsWith('/')) {
    const tail = addr.slice(at + 1)
    const slash = tail.indexOf('/')
    refPart = slash === -1 ? tail : tail.slice(0, slash)
    if (slash !== -1) subPart = tail.slice(slash + 1)
    addr = addr.slice(0, at)
  }
  return {
    repo: addr,
    ...(subPart.trim() ? { path: subPart.trim() } : {}),
    ...(refPart.trim() ? { git_ref: refPart.trim() } : {}),
  }
}

/** The name a marketplace is shown under everywhere in the UI. */
export function marketplaceLabel(m: { repo: string; label?: string }): string {
  return (m.label ?? '').trim() || m.repo
}

/** Normalise a repo address for comparison only: a copied GitHub URL and the
 *  short `owner/repo` a marketplace was added with are the same place. */
function comparableRepo(repo: string): string {
  return repo
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/** Whether two marketplace addresses point at the SAME place.
 *
 *  A copied GitHub URL and the short `owner/repo` a marketplace was added with
 *  are one source: comparing raw strings saved the same catalogue twice (once
 *  from Settings, once from an install that registered it). Path and ref still
 *  have to match — two indexes can live in one repo. */
export function sameMarketplace(
  a: { repo: string; path?: string; git_ref?: string },
  b: { repo: string; path?: string; git_ref?: string },
): boolean {
  return (
    comparableRepo(a.repo) === comparableRepo(b.repo) &&
    (a.path ?? '') === (b.path ?? '') &&
    (a.git_ref ?? '') === (b.git_ref ?? '')
  )
}

/** Whether two repo addresses name the same repository (`owner/repo` vs URL). */
export function sameRepo(a: string, b: string): boolean {
  return comparableRepo(a) === comparableRepo(b)
}

/** The slug a plugin NAME produces — the same `safe_file` the backend writes. */
export function pluginSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
}

/** The installed bundle that IS this marketplace row, when one exists.
 *
 *  Address alone is not enough: a marketplace can point several rows at the
 *  same source folder (`anthropics/skills` publishes five rows from `./`), so
 *  matching only the address marked EVERY row installed after one root
 *  install. The row's name (its slug) distinguishes them; the repo still has
 *  to match, so a same-named bundle from another marketplace does not hide it.
 *  Matching ignores the sub-folder and ref on purpose: a root install of a
 *  single-bundle repo is the same bundle a row points into.
 */
export function installedForRow<
  T extends { name?: string; slug?: string; source_repo?: string },
>(installed: T[], row: { name: string; repo: string }): T | undefined {
  const wanted = pluginSlug(row.name)
  const wantedName = row.name.trim().toLowerCase()
  return installed.find((p) => {
    if (!sameRepo(p.source_repo ?? '', row.repo)) return false
    const name = (p.name ?? '').trim().toLowerCase()
    return (
      p.slug === wanted ||
      pluginSlug(name) === wanted ||
      name === wantedName
    )
  })
}

/** The installed bundle that came from EXACTLY this install address, when one
 *  exists. Unlike `installedForRow` the sub-folder and ref matter here: one repo
 *  can publish several bundles, and installing the root is not the same act as
 *  installing a row that points into `skills/…`. Used to refuse a second
 *  install of something already on disk instead of re-downloading it. */
export function installedFromAddress<
  T extends { source_repo?: string; source_path?: string; source_ref?: string },
>(
  installed: T[],
  address: { repo: string; repo_path?: string; repo_ref?: string },
): T | undefined {
  const repo = address.repo.trim()
  if (!repo) return undefined
  return installed.find((p) => {
    const source = (p.source_repo ?? '').trim()
    if (!source || !sameRepo(source, repo)) return false
    return (
      (p.source_path ?? '') === (address.repo_path ?? '') &&
      (p.source_ref ?? '') === (address.repo_ref ?? '')
    )
  })
}

/** Every saved marketplace a typed name/address resolves to.
 *
 *  Matching is deliberately broad — label, repo, `repo@ref/path`, the install
 *  key, and the repo's LAST segment — because both
 *  `/plugin marketplace remove` and `/plugin install plugin@marketplace` are
 *  typed from memory. The last segment is what makes
 *  `prompts.chat@prompts.chat` find a source saved as `f/prompts.chat` (the
 *  index's own name is not stored on older saves). Callers report an ambiguous
 *  result instead of guessing. */
export function findMarketplaces<T extends { repo: string; label?: string; path?: string; git_ref?: string }>(
  marketplaces: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const qRepo = comparableRepo(q)
  const lastSegment = (repo: string) => comparableRepo(repo).split('/').pop() ?? ''
  return marketplaces.filter((m) => {
    const label = (m.label ?? '').trim().toLowerCase()
    const repo = m.repo.trim().toLowerCase()
    const address = `${m.repo}${m.git_ref ? `@${m.git_ref}` : ''}${m.path ? `/${m.path}` : ''}`.toLowerCase()
    return (
      label === q ||
      repo === q ||
      address === q ||
      marketKey(m.repo, m.path, m.git_ref).toLowerCase() === q ||
      comparableRepo(m.repo) === qRepo ||
      lastSegment(m.repo) === qRepo
    )
  })
}

/** Split Claude Code's install spelling `plugin@marketplace`.
 *
 *  Only the LEFT side decides: a plugin name never holds `/` or `:`, so
 *  `owner/repo`, `owner/repo@ref` and `git@host:owner/repo` are repo addresses
 *  and stay on the bundle-install path. The right side may name a SAVED
 *  marketplace or be a repo address typed in full (`plugin@owner/repo`).
 *  Returns null for anything that is not this spelling.
 */
export function parsePluginInstallSpec(
  raw: string,
): { plugin: string; marketplace: string } | null {
  const spec = raw.trim()
  const at = spec.indexOf('@')
  if (at <= 0) return null
  const plugin = spec.slice(0, at).trim()
  const marketplace = spec.slice(at + 1).trim()
  if (!plugin || !marketplace) return null
  if (/[/:]/.test(plugin)) return null
  // `git@github.com:owner/repo` is an SSH address, not a scoped install; an
  // explicit `https://…` marketplace address is fine.
  if (marketplace.includes(':') && !/^https?:\/\//i.test(marketplace)) return null
  return { plugin, marketplace }
}

/** Where a scoped install's row came from: the address the caller saves when
 *  the marketplace was typed in full instead of already being in the list. */
export interface ScopedMarketplaceSource {
  repo: string
  label?: string
  path?: string
  git_ref?: string
}

export interface ScopedMarketplaceInstall {
  entry: MarketplaceEntry
  source: ScopedMarketplaceSource
  /** False when the user addressed the marketplace by repo but has not saved it. */
  saved: boolean
}

/** Resolve `plugin@marketplace` to the marketplace row it names.
 *
 *  The marketplace is matched against the saved sources first (label, repo, or
 *  the repo's last segment — see `findMarketplaces`), then accepted as a repo
 *  address. Reading the index is the only I/O; the row it returns is already
 *  the exact `repo`/`repo_path`/`repo_ref` an install takes, so the caller
 *  never translates addresses by hand.
 */
export async function resolvePluginInstall(
  markets: Array<{ repo: string; label?: string; path?: string; git_ref?: string }>,
  spec: { plugin: string; marketplace: string },
): Promise<ScopedMarketplaceInstall | { error: string }> {
  const matches = findMarketplaces(markets, spec.marketplace)
  let source: ScopedMarketplaceSource
  let saved = false
  if (matches.length > 1) {
    return {
      error:
        `\`${spec.marketplace}\` matches several marketplaces: ` +
        matches.map((m) => `**${marketplaceLabel(m)}**`).join(', ') +
        '. Use the exact name.',
    }
  }
  if (matches.length === 1) {
    const m = matches[0]
    source = {
      repo: m.repo,
      ...(m.label ? { label: m.label } : {}),
      ...(m.path ? { path: m.path } : {}),
      ...(m.git_ref ? { git_ref: m.git_ref } : {}),
    }
    saved = true
  } else if (looksLikeRepoAddress(spec.marketplace)) {
    const parsed = parseMarketplaceAddress(spec.marketplace)
    if (!parsed.repo) return { error: 'That address has no repo — use `owner/repo`.' }
    source = {
      repo: parsed.repo,
      ...(parsed.path ? { path: parsed.path } : {}),
      ...(parsed.git_ref ? { git_ref: parsed.git_ref } : {}),
    }
  } else {
    return {
      error:
        `No saved marketplace matches \`${spec.marketplace}\`. Add it first with ` +
        `\`/plugin marketplace add <owner/repo>\`, or pass its repo address: ` +
        `\`/plugin install ${spec.plugin}@owner/repo\`.`,
    }
  }
  const out = await listMarketplace({
    repo: source.repo,
    ...(source.path ? { path: source.path } : {}),
    ...(source.git_ref ? { git_ref: source.git_ref } : {}),
  })
  if ('error' in out) {
    return { error: `Could not read marketplace \`${source.repo}\`: ${out.error}` }
  }
  const label = out.name.trim() || source.label || source.repo
  source.label = label
  const wanted = spec.plugin.trim().toLowerCase()
  const exact = out.plugins.find((p) => p.name.trim().toLowerCase() === wanted)
  // A one-row catalogue has no ambiguity to resolve: the user named a
  // marketplace that publishes exactly one plugin, so install that one even
  // when the index spells its name differently.
  const entry = exact ?? (out.plugins.length === 1 ? out.plugins[0] : undefined)
  if (!entry) {
    return {
      error:
        `Marketplace **${label}** lists no plugin named \`${spec.plugin}\`. ` +
        (out.plugins.length
          ? `Available: ${out.plugins.map((p) => `\`${p.name}\``).join(', ')}.`
          : 'Its index lists no plugins.'),
    }
  }
  return { entry, source, saved }
}

/** Read a repo as a marketplace index, or null when it is not one.
 *
 *  Most install sources are plain plugin repos, so "no index" is the ordinary
 *  answer and must not be shown as an error. */
export async function readMarketplaceIndex(body: {
  repo: string
  path?: string
  git_ref?: string
}): Promise<MarketplaceIndex | null> {
  const out = await listMarketplace(body)
  return 'error' in out ? null : out
}

/** How long a dropped install connection is watched before the failure is
 *  reported as real. The backend task runs to completion either way; the poll
 *  only decides what the UI SAYS about it. */
let LATE_INSTALL_WATCH_MS = 60_000
let LATE_INSTALL_POLL_MS = 2_000

/** Test hook: the late-install watch runs on real timers, so a test shrinks
 *  the window to keep the suite fast. Not for app code. */
export function _setLateInstallTimingForTests(pollMs: number, watchMs: number): void {
  LATE_INSTALL_POLL_MS = pollMs
  LATE_INSTALL_WATCH_MS = watchMs
}

/** A dropped connection is not a failed install: poll the plugin list until the
 *  bundle lands (matched by the address it was installed from — the same three
 *  fields the "Update" badge matches on), then report success like a finished
 *  response would. Never lands → report the drop, with the hint that the
 *  backend may still be working. */
async function waitForLateInstall(
  body: { repo: string; repo_path?: string; repo_ref?: string },
  cause: unknown,
): Promise<PluginInstallResult | { error: string }> {
  const deadline = Date.now() + LATE_INSTALL_WATCH_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LATE_INSTALL_POLL_MS))
    let listed: PluginInfo[] | { error: string }
    try {
      listed = await listPlugins()
    } catch {
      continue
    }
    if (!Array.isArray(listed)) continue
    const landed = listed.find(
      (p) =>
        (p.source_repo ?? '') === body.repo &&
        (p.source_path ?? '') === (body.repo_path ?? '') &&
        (p.source_ref ?? '') === (body.repo_ref ?? ''),
    )
    if (!landed) continue
    // The success note reads the skill/connector counts off the result, so
    // fill them from the same stores a finished response would have carried.
    const [skills, connectors] = await Promise.all([
      listPluginSkills()
        .then((rows) => (Array.isArray(rows) ? rows : ([] as PluginSkillRow[])))
        .catch(() => [] as PluginSkillRow[]),
      listPluginConnectors()
        .then((rows) => (Array.isArray(rows) ? rows : ([] as PluginConnectorRow[])))
        .catch(() => [] as PluginConnectorRow[]),
    ])
    return {
      installed: 'created',
      slug: landed.slug,
      skills: skills.filter((s) => s.plugin_slug === landed.slug).map((s) => s.name),
      mcp: connectors.filter((c) => c.plugin_slug === landed.slug).map((c) => c.name),
      plugin: landed,
    }
  }
  const why = cause instanceof Error ? cause.message : String(cause)
  return {
    error:
      `${why} — the connection to the backend dropped mid-install, but the install ` +
      `may still finish there; check the Plugins tab before retrying`,
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

/** One slash command of a plugin bundle. */
export interface PluginCommandRow {
  /** The word typed after `/` — the file stem, so it is what the palette shows. */
  name: string
  description: string
  /** The body the model receives, with `$ARGUMENTS` placeholders still in it. */
  content?: string
  plugin?: string
  plugin_slug?: string
  plugin_enabled?: boolean
}

/** Every slash command inside every plugin, enabled or not. */
export async function listPluginCommands(): Promise<PluginCommandRow[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/commands`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { commands?: PluginCommandRow[] }
    return data.commands ?? []
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** One sub-agent profile of a plugin bundle. */
export interface PluginAgentRow {
  name: string
  description: string
  /** Tools it declared in `agents/*.md`. Empty = the kind's default set; a
   *  non-empty list is the exact set, including `Bash`/`Edit`/`Write`. */
  tools?: string[]
  /** Its system prompt. */
  prompt?: string
  plugin?: string
  plugin_slug?: string
  plugin_enabled?: boolean
}

/** Every sub-agent profile inside every plugin, enabled or not.
 *
 *  All of them run on the Explore row of Settings → Tools — there is no
 *  per-profile model, which is what the Settings note points at.
 */
export async function listPluginAgents(): Promise<PluginAgentRow[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const res = await fetch(`${url}/plugins/agents`)
    if (!res.ok) return { error: `list failed (${res.status})` }
    const data = (await res.json()) as { agents?: PluginAgentRow[] }
    return data.agents ?? []
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
  /** The row's own description. It travels in the same call but is filed in
   *  the bundle manifest — never inside `cfg`, which the MCP client forwards
   *  verbatim. */
  meta?: { description?: string },
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/mcp/save', {
    slug,
    name,
    cfg,
    ...(previousName && previousName !== name ? { previous_name: previousName } : {}),
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
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
 *  on disk — only the description changes. */
export async function savePluginScript(
  slug: string,
  name: string,
  meta: { description?: string },
): Promise<{ ok: true } | { error: string }> {
  const out = await postPlugin('/plugins/update', {
    slug,
    scripts: [
      {
        name,
        ...(meta.description !== undefined ? { description: meta.description } : {}),
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
