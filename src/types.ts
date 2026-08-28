export type ProviderKind = 'opencode' | 'openrouter' | 'ollama' | 'custom' | 'google' | 'nvidia' | 'cloudflare' | 'tokenrouter'

export type AgentMode = string

/** A recently used model, tied to the provider it was used on so it can be
 *  re-selected unambiguously (models are shown as provider/model). */
export interface RecentModel {
  providerId: string
  model: string
  /** Epoch ms when this model was last used — used to sort recents by usage time. */
  lastUsed?: number
}

/** Per-mode tool access. Sent to the backend so tool gating is data-driven
 *  instead of hardcoded to mode names — lets anyone add custom modes. */
export interface ModeCapabilities {
  readFiles: boolean // list / search (grep/glob)
  writeFiles: boolean // write_file / edit_file
  runTerminal: boolean // run_terminal
  web: boolean // web_search / fetch_url
}

/** One agent mode: built-in (ask / plan / coder) or user-created. */
export interface AgentModeDef {
  id: AgentMode
  label: string
  icon?: string
  description: string
  capabilities: ModeCapabilities
}

export type ThinkingLevel =
  | ''
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'

/** Transport type for an MCP tool connector. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server connector (stored in the app database). */
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

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  apiKey: string
  envVar?: string
  baseUrl: string
  model: string
  /** OAuth login (Google "google" kind): auth_type = "oauth" turns the provider
   *  into a token-based connection resolved from oauthRefreshToken. */
  authType?: string
  oauthClientId?: string
  oauthClientSecret?: string
  oauthRefreshToken?: string
  contextWindow?: number
  /** Live per-model context windows (tokens) reported by the provider's /models endpoint. */
  contextMap?: Record<string, number>
  /** Live per-model USD-per-million-token pricing reported by the provider's /models endpoint. */
  pricingMap?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  reasoningMap?: Record<string, boolean>
  thinkingLevel?: ThinkingLevel
  models?: string[]
  /** Models the user explicitly removed; hidden from the live /models catalog. */
  removedModels?: string[]
}

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
  fontSize?: number
  root?: string
  dir?: 'rtl' | 'ltr'
  compact?: boolean
  recentModels?: RecentModel[]
  sidebarOpen?: boolean
  /** Directory for the per-workspace RAG vector store (memory + web chunks).
   *  Empty string = default ({dataPath}/vector-db). */
  vectorDbPath?: string
  /** User-level data root: app DB (coder.db), skills/plans/mcp files and the
   *  vector store all live under this folder. Default: ~/.codifa. */
  dataPath?: string
  /** On-device Whisper (voice) model: HuggingFace repo id + optional mirror. */
  whisperModel?: string
  whisperBaseUrl?: string
  /** On-device embedding (RAG memory) model: repo id + optional mirror. */
  embeddingModel?: string
  embeddingBaseUrl?: string
  /** TTL for web search / fetch cache (days). Default: 7. */
  webSearchTtlDays?: number
  fetchUrlTtlDays?: number
  /** TTL for RAG web/fetch storage (days). Default: 90. */
  ragWebTtlDays?: number
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
  /** Compaction headroom (tokens) reserved below the context window — opencode's
   *  `reserved`/`COMPACTION_BUFFER`. Auto-compaction fires at `ctx - reserved`
   *  (opencode's `usable`). Default 20_000. */
  compactHeadroom?: number
  /** Fraction of the usable window at which mid-turn auto-compaction fires
   *  (0.1–0.95). 0.5 = compact once a turn uses half the usable window, well
   *  before the hard overflow limit. Default 0.5. */
  compactTriggerFraction?: number
  /** History turn limit sent to the model. 0 = full history (default). N > 0 =
   *  last N turns verbatim + a compact summary of the rest. Works with
   *  auto-compact (summary is merged, not re-expanded). */
  historyLimit?: number
  /** Tool result cache TTL in minutes (default 60). */
  cacheTtlMinutes?: number
}

/** A first-class workspace in the sidebar. ``root`` is the project folder; may
 *  be null for the "No project" bucket. Workspaces are only removed via the
 *  sidebar trash button, never by deleting their chats. */
export interface Workspace {
  key: string
  root: string | null
  label: string
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface SearchResultItem {
  title: string
  url: string
  snippet?: string
}

export interface ToolActivity {
  tool: string
  args?: Record<string, unknown>
  summary?: string
  status: 'running' | 'done' | 'error' | 'denied'
  diff?: string
  elapsedMs?: number
  startedAt?: number
  reverted?: boolean
  /** Per-call correlation id (backend-assigned) so a tool_result resolves the
   *  exact card it belongs to even when the same tool runs many times. */
  callId?: number
  /** True for tool calls emitted by a SUB-AGENT (e.g. explore's internal
   *  read/grep/glob). Rendered nested inside the parent explore card, not as a
   *  top-level timeline card. */
  sub?: boolean
  /** Parallel explore fan-out branch id (0-based). Lets the UI nest each
   *  branch's sub-agent events under ITS OWN explore card instead of dumping
   *  every branch into one card. */
  branch?: number
  /** Nested sub-agent tool calls when this is an explore card. */
  children?: ToolActivity[]
  /** Which model executed this specific tool call. Empty/absent = the main
   *  conversation model; set for calls issued by a sub-agent (e.g. explore's
   *  own resolved model from Settings → Tools). */
  model?: string
  /** Structured result rows (e.g. web_search hits) shown in the tool card. */
  items?: SearchResultItem[]
  /** Alias of `items` — the backend emits `results` on tool_result events, and
   *  the UI stores them here so a reconnect can replay the tool without
   *  re-executing it (re-execution wastes context). */
  results?: SearchResultItem[]
  /** Which web-search provider produced these results (e.g. 'tavily'). */
  engine?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One cumulative usage entry for a single (provider, model) pair used by a
 *  chat. `providerId` and `model` are stored EXPLICITLY (not encoded in a key
 *  string) so the sidebar shows the exact provider/model with no parsing or
 *  guessing — and any future provider/model displays correctly. */
export interface ChatUsageEntry {
  /** The provider that ACTUALLY ran this model (its id). */
  providerId: string
  /** The model id as reported by the backend (may itself carry a namespace,
   *  e.g. "anthropic/claude-3.5-sonnet" — that is part of the model, NOT a
   *  provider). */
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** Epoch ms of the last token accrual for this model — used to sort "most
   *  recently used" first in the sidebar usage panel. */
  lastUsed?: number
}

/** Per-chat cumulative token usage (session totals). A flat list of explicit
 *  (provider, model) entries — survives compacts and reloads and only ever
 *  grows, unlike a single message's `TokenUsage` which is per-turn. */
export interface ChatUsage {
  entries: ChatUsageEntry[]
}

/** One Language-Server diagnostic reported by Neovim for the active buffer.
 *  `severity` is 1=Error, 2=Warning, 3=Information, 4=Hint (LSP LSPClient
 *  number) or a string when the server reports it as text. */
export interface NvimDiagnostic {
  lnum: number
  col: number
  end_lnum?: number
  end_col?: number
  severity: number | string
  source?: string
  code?: string | number | null
  message: string
}

/** Chronological unit of an assistant message. Text is split into slices around
 *  each tool call so the UI can interleave tool cards with the reply (Claude
 *  style) instead of stacking all tools at the top/bottom. `tool` segments
 *  reference `ChatMessage.toolActivity[index]`. */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; index: number }
  | { kind: 'user'; id: string }

export interface ChatMessage {
  id: string
  role: Role
  content: string
  mode?: AgentMode
  toolActivity?: ToolActivity[]
  /** Interleaved render order (text slices + tool call positions). Absent on
   *  messages persisted before this feature; they fall back to legacy layout. */
  segments?: MessageSegment[]
  plan?: Array<{ id?: string; content: string; status: string }>
  thinking?: string
  /** True while this assistant message is still being generated (live status line). */
  streaming?: boolean
  /** True only while the backend has confirmed the model is actually
   *  producing reasoning content (driven by the {kind:"thinking",active:true}
   *  event). Gates the in-message "Thinking" indicator. */
  thinkingActive?: boolean
  /** True when this message was persisted mid-stream (heartbeat snapshot) and
   *  the app died before the turn completed — shown as "interrupted" after a
   *  crash/power cut instead of looking like a complete reply. Cleared by the
   *  final write once the turn ends normally. */
  interrupted?: boolean
  /** True for a user message steered into a RUNNING agent (typed mid-run). It
   *  is visible immediately; the backend confirms delivery with `steer_applied`
   *  (flag cleared) or, if the turn ends without injecting it, it is re-sent as
   *  the next turn reusing this same message. */
  steerPending?: boolean
  /** True for a user message steered into a RUNNING agent once the backend
   *  confirmed delivery (`steer_applied`): the message's own bubble is hidden
   *  and it is instead rendered inline, right after the tool call that carried
   *  it, via a `{ kind: 'user' }` segment on the assistant message. */
  steerInterleaved?: boolean
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  usage?: TokenUsage
  error?: boolean
  retry?: { attempt: number; maxAttempts: number; delay: number; reason: string; gaveUp?: boolean; watchdog?: boolean; model?: string; agent?: string; fallback?: boolean } | null
  /** True once this message has been folded into a compact summary (kept in the
   *  UI as a greyed, collapsible entry but NOT re-sent to the model). */
  compacted?: boolean
  modeSwitch?: boolean
  createdAt: number
}

/** Pending composer state scoped to one chat (labels below the input), so
 *  mentions / MCP chips picked in one chat never leak into another. */
export interface ChatDraft {
  input?: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  /** True while the composer's mention of a Neovim file was active, so a queued
   *  turn started from another chat can reproduce the mention. */
  nvimMentioned?: string
}

/** A message typed while the chat's agent is already working. `kind: 'steer'`
 *  is delivered to the RUNNING agent (via /chat/steer, injected at the next
 *  tool call, no abort); `kind: 'queue'` waits and auto-sends one-by-one after
 *  the current turn completes. `sent` is set once the message has been turned
 *  into a real chat turn (either consumed mid-run or drained). */
export interface QueuedMessage {
  id: string
  text: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  kind: 'steer' | 'queue'
  createdAt: number
  sent?: boolean
}

export interface Chat {
  id: string
  title: string
  mode: AgentMode
  /** Per-chat reasoning effort override (defaults to the provider default). */
  thinkingLevel?: ThinkingLevel
  /** Per-chat provider override (defaults to the global active provider). */
  providerId?: string
  /** Per-chat model override (defaults to the global active provider's model). */
  model?: string
  root?: string
  messages: ChatMessage[]
  /** Cumulative per-model token usage for this chat (session totals). */
  usage?: ChatUsage
  draft?: ChatDraft
  /** Messages typed while this chat's agent was working, sent/steered later. */
  queued?: QueuedMessage[]
  /** A pending `ask_user` request from a RUNNING agent turn. Lives on the chat
   *  (not local component state) because `<ChatPanel key={activeChatId} />`
   *  fully unmounts/remounts on every chat switch — local state would silently
   *  lose the request (and the popup would never appear) if the user isn't
   *  looking at this exact chat when the `ask` event arrives, or switches away
   *  and back while the agent is still waiting for a response. */
  pendingAsk?: { id: string; question: string; options: string[] } | null
  /** A pending `permission` request from a RUNNING agent turn. Same rationale
   *  as `pendingAsk`: lives on the chat so it survives the ChatPanel remount
   *  on chat switch. */
  pendingPermission?: { id: string; action: string; path?: string; reason?: string; scope?: string } | null
  /** Transient compact/command/stall banners, kept on the chat (not local
   *  component state) for the same reason as `pendingAsk`: `<ChatPanel
   *  key={activeChatId} />` remounts on every chat switch, so local state would
   *  silently drop these the moment the user looks at another chat and comes
   *  back. Cleared on load — nothing is running after a restart. */
  compacting?: boolean
  compactNotice?: string | null
  compactError?: string | null
  cmdError?: string | null
  stalled?: boolean
  /** Per-chat scroll restoration anchor: the message id at the top of the
   *  viewport when the user last scrolled, plus the pixel offset from that
   *  message's top to the viewport top. `atBottom` means the user was pinned
   *  to the newest messages. Restored on chat switch / app restart. */
  scrollPos?: { id: string; offset: number; atBottom: boolean } | null
  createdAt: number
  updatedAt: number
}

export interface SidecarEvent {
  kind: 'text' | 'thinking' | 'tool' | 'tool_result' | 'diff' | 'error' | 'done' | 'usage' | 'retry' | 'retry_giveup' | 'compact' | 'compact_start' | 'compact_failed' | 'plan' | 'permission' | 'ask' | 'skill' | 'mcp' | 'subagent_models' | 'steer_applied' | 'keepalive'
  content?: string
  tool?: string
  args?: Record<string, unknown>
  summary?: string
  /** Tool-result status: 'error' marks a failed tool call (renders red ✗); 'denied' marks a cap-blocked call (renders ⏹). */
  status?: 'error' | 'done' | 'denied'
  /** Per-call correlation id pairing a 'tool' event with its 'tool_result'. */
  call_id?: number
  /** Number of recent turns the backend preserved verbatim on a 'compact'
   *  event, so the frontend folds exactly the same older turns. */
  keep?: number
  diff?: string
  path?: string
  /** Skill names attached for this turn via @mention (the 'skill' event kind). */
  skills?: string[]
  /** True when the skills were attached manually by the user (@mention). */
  manual?: boolean
  /** Informational note on a 'skill' event with an empty skills list (e.g. an attached skill wasn't found). */
  note?: string
  /** MCP connector names active for this turn (the 'mcp' event kind). */
  servers?: string[]
  /** Per-subagent model routing (the 'subagent_models' event kind): which model actually ran for explore/search/web/compact/vision. */
  models?: Record<string, string>
  /** update_plan items: [{ content, status }] */
  items?: Array<{ id?: string; content: string; status: string }>
  /** Steer messages the running agent consumed (injected into a tool result);
   *  the frontend removes these ids from the chat's pending queue. */
  ids?: string[]
  /** Structured tool results (web_search hits) shown in the tool card. */
  results?: SearchResultItem[]
  /** Which web-search provider produced the results (e.g. 'tavily'). */
  engine?: string
  /** True for events emitted by a sub-agent (explore's internal read/grep/glob)
   *  — the parent nests these inside the explore card instead of a top-level card. */
  sub?: boolean
  /** Parallel explore fan-out branch id (0-based). The backend emits one explore
   *  card per branch and tags each branch's sub-events with its id, so the UI
   *  nests each branch's read/grep/glob under ITS OWN card. */
  branch?: number
  /** Which model executed this specific event: for 'tool'/'tool_result' kinds,
   *  the model that ran the call; for 'usage' events, the model the usage
   *  belongs to. Empty/absent = the main conversation model. */
  model?: string
  /** permission/ask request id (echoed back via /permission/respond or /ask/respond) */
  id?: string
  action?: string
  /** 'confirm' for a generic confirm_action request; absent/'outside' for the original outside-workspace permission prompt */
  scope?: string
  /** ask_user: the question text and, when multiple-choice, its options */
  question?: string
  options?: string[]
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  context_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  /** Overflow events are REJECTED (unbilled) requests — never counted in billed totals. */
  unbilled?: boolean
  attempt?: number
  max_attempts?: number
  delay?: number
  reason?: string
  /** Agent label for retry events (e.g. "main agent", "explore subagent") — so the user knows WHICH model to change. */
  agent?: string
  /** True on a retry-family event when a sub-agent model hard-failed and the
   *  tool fell back to the MAIN model — the UI renders a distinct
   *  'sub-agent failed — using main model' banner instead of a spinner. */
  fallback?: boolean
  /** Thinking signal: true when the model starts reasoning, false when it
   *  stops. The backend emits this instead of streaming raw thinking text
   *  (which slowed the UI); the frontend uses it to glow the composer. */
  active?: boolean
}
