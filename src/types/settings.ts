import type { Chat } from './chat.ts'
import type { MarketplaceSource } from './market.ts'
import type { McpServerConfig, SearchConsoleConfig, SearchPluginConfig } from './mcp.ts'
import type { AgentModeDef, CustomSubagent, MediaFallback, ProviderConfig, RecentModel, SttFallback, ThinkingLevel, ToolFallback, TtsFallback } from './providers.ts'


export interface Settings {
  providers: ProviderConfig[]
  activeProviderId: string
  systemPrompts?: Record<string, string>
  /** User-created modes; built-ins live in `src/lib/modes.ts`. */
  modes?: AgentModeDef[]
  /** MCP tool connectors (key = connector name), sent to the agent each run. */
  mcpServers?: Record<string, McpServerConfig>
  /** MCP connector names switched on via the composer popup. Applied to every
   *  message; defaults to none. */
  mcpEnabled?: string[]
  /** Connectors the model loaded with `use_mcp`. Their tool schemas are NOT
   *  inlined until the connector is named here, so a switched-on-but-unused
   *  connector costs one prompt line instead of its whole catalogue (measured:
   *  391 tools / ~59K tokens for one enabled Proxmox connector a turn never
   *  touched). Persisted per chat so a connector is asked for once, not every
   *  turn. */
  mcpActive?: string[]
  /** The agent's Browser switch (composer → MCP tools → Browser). Stored like
   *  `computerUse`: when off, no `browser_*` tool is bound to the model. */
  browserUse?: boolean
  fontSize?: number
  /** Point size of CODE opened in the side-pane file viewer. Independent of
   *  `fontSize` (the chat transcript) so reading a long file never forces the
   *  chat to grow with it. */
  viewerFontSize?: number
  /** Point size of every terminal screen (bottom panel and side-pane tabs).
   *  Independent of `fontSize`, like `viewerFontSize`. */
  terminalFontSize?: number
  root?: string
  dir?: 'rtl' | 'ltr'
  compact?: boolean
  recentModels?: RecentModel[]
  sidebarOpen?: boolean
  /** Docked right panel (todos + future sections) — persisted like sidebarOpen. */
  rightPanelOpen?: boolean
  /** User-level data root: skills/plans/mcp files live under this folder.
   *  Default: ~/.codifa. */
  dataPath?: string
  /** Directory the Settings → Storage backup zip is written to.
   *  Empty = the data root itself (~/.codifa by default). */
  backupPath?: string
  /** URL of a static update feed on the user's own site — checked before
   *  GitHub releases. See commands.rs `fetch_site_feed` for the JSON shape.
   *  Empty = GitHub releases only. */
  updateFeedUrl?: string
  /** STT source: a settings.providers id (remote OpenAI-compatible endpoint). */
  sttProviderId?: string
  /** Remote STT model id sent to {base_url}/audio/transcriptions (e.g. whisper-1). */
  sttModel?: string
  /** Ordered STT fallback targets, tried after the primary STT source fails. */
  sttFallbacks?: SttFallback[]
  /** STT language hint sent to the provider ('fa', 'en', …). Empty = auto. */
  sttLanguage?: string
  /** TTS source: a settings.providers id (remote OpenAI-compatible /audio/speech). */
  ttsProviderId?: string
  /** TTS model id sent to {base_url}/audio/speech (e.g. tts-1). */
  ttsModel?: string
  /** Remote TTS voice id sent to {base_url}/audio/speech (e.g. alloy). */
  ttsVoice?: string
  /** Ordered TTS fallback targets, tried after the primary TTS source fails. */
  ttsFallbacks?: TtsFallback[]
  /** Image-generation source: a settings.providers id (OpenAI-compatible
   *  /images/generations or Google Gemini :generateContent). Empty = the
   *  generate_image / edit_image tools answer "not configured". */
  imageProviderId?: string
  /** Default image model id (e.g. gpt-image-1); a tool call may override it. */
  imageModel?: string
  /** Ordered image fallback targets, tried after the primary source fails. */
  imageFallbacks?: MediaFallback[]
  /** Video-generation source: a settings.providers id (OpenAI-compatible /videos
   *  i.e. Sora, or Google Veo predictLongRunning). Empty = generate_video
   *  answers "not configured". */
  videoProviderId?: string
  /** Default video model id (e.g. sora-2); a tool call may override it. */
  videoModel?: string
  /** Ordered video fallback targets, tried after the primary source fails. */
  videoFallbacks?: MediaFallback[]
  /** Realtime (speech-to-speech) provider id. Empty = live voice runs the
   *  chunked STT + TTS pipeline instead of a realtime session. */
  liveProviderId?: string
  /** Live voice (realtime speech-to-speech) model id (e.g. gpt-realtime). */
  liveModel?: string
  /** Live voice id used for the realtime session (e.g. alloy). */
  liveVoice?: string
  /** One number for `web_search`: how many results it returns AND how many of
   *  them get their real page content fetched before answering (Settings →
   *  Web Providers). 0 = no page fetch, snippet-only. Default: 5. */
  webSearchAutoFetch?: number
  /** Web-search engines for the web_search tool (Settings → Plugins). Order
   *  decides primary vs fallback. Empty = DuckDuckGo only (backward compat). */
  searchPlugins?: SearchPluginConfig[]
  /** Google Search Console OAuth + site for the search_console tool. */
  searchConsole?: SearchConsoleConfig
  /** Per-workspace accent color, keyed by workspace key (root path, "" for no project). */
  workspaceColors?: Record<string, string>
  /** Workspace keys pinned to the top of the sidebar, most-recently-pinned first. */
  pinnedWorkspaces?: string[]
  /** Chat ids pinned to the top of their workspace group, most-recently-pinned first. */
  pinnedChats?: string[]
  /** Persisted workspace list — workspaces outlive their chats (deleting all a
   *  workspace's chats does NOT remove the workspace itself). Empty workspaces
   *  still render. Order is user-controlled (drag-and-drop in the sidebar). */
  workspaces?: Workspace[]
  /** Per-subagent model overrides (namespace / explorer / vision / compact).
   *  Each key maps to a model from the active provider, or empty = use the
   *  parent model. */
  subagentModels?: Record<string, string>
  /** Per-tool reasoning-effort override, keyed by the same slot names as
   *  `subagentModels` (compact / explore / web / schedule / title). Empty or
   *  missing = inherit the main model's thinking level. */
  subagentThinking?: Record<string, ThinkingLevel>
  /** Per-tool fallback models, keyed by the SAME slot names as
   *  `subagentModels` (explore / vision / schedule / compact / web / title).
   *  Each list is tried top-to-bottom — and only for that tool, only while that
   *  tool's own model is failing. Every attempt of a later call starts again at
   *  the tool's own model, and a fallback never overrides the tool's reasoning
   *  level. */
  toolFallbacks?: Record<string, ToolFallback[]>
  /** User-created sub-agents (Settings → Sub-agents). Advertised to the model as
   *  delegation tools alongside plugin agents; every one of them runs on the
   *  same Settings → Tools → "Sub-agent" model row. */
  customSubagents?: CustomSubagent[]
  /** Single auto-compaction threshold as a percentage of the RAW context window.
   *  Auto-compaction fires once `total_tokens >= ctx * compactAtPercent / 100`.
   *  The reserved headroom is implicit: `(100 - compactAtPercent)%` of the window
   *  is left free. 80 = compact at 80% of the window (20% headroom). Range 1–99.
   *  Default 80. The context meter shows `total_tokens`, so the meter and the
   *  trigger always agree (the bar hits the threshold exactly when compaction
   *  fires). */
  compactAtPercent?: number
  /** Suppress OS/browser keyboard suggestions — autocomplete, autocorrect,
   *  inline predictions and spell-check marks — in every text field of the app
   *  (composer, search boxes, comment boxes and the terminal's hidden input).
   *  Applied at the DOM level by `src/lib/inputSuppress.ts`, so the terminal
   *  and every imperatively created field are covered too. Turning it off
   *  restores each field's original attributes. Default: true (suggestions are
   *  OFF) — the platform defaults are wrong for a code editor. */
  disableTextSuggestions?: boolean
  /** Which terminal Neovim (and "open terminal here") launches into. Ids live in
   *  `src/lib/nvimTerminals.ts`; the Rust side reads the SAME key out of
   *  settings.json so a backend-only open follows it too. Default: 'inapp'. */
  nvimTerminal?: string
  /** Shell the in-app terminal tabs run (Settings → Terminal). Empty = the OS
   *  login shell ($SHELL). Read straight from settings.json by src-tauri's pty. */
  terminalShell?: string
  /** History turn limit sent to the model. 0 = full history (default). N > 0 =
   *  last N turns verbatim + a compact summary of the rest. Works with
   *  auto-compact (summary is merged, not re-expanded). */
  historyLimit?: number
  /** Bytes of skill catalog allowed in the system prompt each turn (see
   *  skillCatalogMaxChars in Settings → Skills). The agent clamps it to
   *  [1500, 12000]; 6000 is the cheap default. */
  skillCatalogMaxChars?: number
  /** Plugin marketplaces the user added (Settings → Marketplaces). Each one is
   *  a repo holding an index of installable plugins. */
  marketplaces?: MarketplaceSource[]
  /** Which generation of the shipped marketplace defaults this file last saw.
   *  A current-version file keeps the user's list untouched; an older one gets
   *  just the newly shipped kinds added once (never a silent re-add of a
   *  removed source). */
  marketplaceDefaultsVersion?: number
  /** Tool result cache TTL in minutes (default 60). */
  cacheTtlMinutes?: number
  /** Schedule run ids already seen in the inbox (badge state). Persisted so
   *  read runs stay read across restarts. */
  scheduleRunsSeen?: string[]
  /** Persisted hard switch for desktop control (the `computer` tool). Like an
   *  MCP connector: when false the backend never binds the tool — the agent
   *  cannot touch the desktop even if the prompt asks for it. When true the
   *  tool binds and per-action runtime permission prompting still applies. */
  computerUse?: boolean
}

/** A first-class workspace in the sidebar. ``root`` is the project folder; may
 *  be null for the "No project" bucket. Workspaces are only removed via the
 *  sidebar trash button, never by deleting their chats. */
export interface Workspace {
  key: string
  root: string | null
  label: string
}

