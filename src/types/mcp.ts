import type { Settings } from './settings.ts'


/** Transport type for an MCP tool connector. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server connector (stored in the app's user data folder). */
export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Explicit transport hint (e.g. `stdio`); inferred from command/url otherwise. */
  type?: string
}

/** A web-search engine backend selectable in Settings → Plugins. Order decides
 *  the primary (order 0) and the fallbacks (higher order = tried later). Add a
 *  new engine later by adding a `SearchPluginKind` + a row in the backend
 *  registry `SEARCH_BACKENDS`; no other code changes. */
export type SearchPluginKind = 'duckduckgo' | 'tavily'

export interface SearchPluginConfig {
  kind: SearchPluginKind
  label: string
  enabled: boolean
  /** Lower = tried first. order 0 = primary, higher = fallback. */
  order: number
  /** Tavily API key (duckduckgo needs none). */
  apiKey?: string
}

/** Google Search Console integration (Settings → Plugins): OAuth client from
 *  the Google Cloud Console + the site whose search-analytics data the
 *  `search_console` tool queries. */
export interface SearchConsoleConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  siteUrl: string
}

/** One verbatim request header of a provider row. */
