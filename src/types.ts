export type ProviderKind = 'opencode' | 'openrouter' | 'ollama' | 'custom'

export type AgentMode = string

/** Per-mode tool access. Sent to the backend so tool gating is data-driven
 *  instead of hardcoded to mode names — lets anyone add custom modes. */
export interface ModeCapabilities {
  readFiles: boolean // list / search / fuzzy_find
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
  | 'xhigh'

/** Transport type for an MCP tool connector. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server connector (Claude Code `.mcp.json` shape). */
export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Explicit transport hint (e.g. `stdio`); inferred from command/url otherwise. */
  type?: string
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  apiKey: string
  envVar?: string
  baseUrl: string
  model: string
  contextWindow?: number
  /** Live per-model context windows (tokens) reported by the provider's /models endpoint. */
  contextMap?: Record<string, number>
  /** Per-provider "Messages to remember" — how many recent user/assistant messages are sent each turn. */
  maxHistory?: number
  thinkingLevel?: ThinkingLevel
  models?: string[]
}

export interface Settings {
  providers: ProviderConfig[]
  activeProviderId: string
  systemPrompts?: Record<string, string>
  /** User-created modes; built-ins live in `src/lib/modes.ts`. */
  modes?: AgentModeDef[]
  /** MCP tool connectors (key = connector name), sent to the agent each run. */
  mcpServers?: Record<string, McpServerConfig>
  fontSize?: number
  root?: string
  dir?: 'rtl' | 'ltr'
  maxHistory?: number
  compact?: boolean
  recentModels?: string[]
  sidebarOpen?: boolean
  /** Per-workspace accent color, keyed by workspace key (root path, "" for no project). */
  workspaceColors?: Record<string, string>
  /** Workspace keys pinned to the top of the sidebar, most-recently-pinned first. */
  pinnedWorkspaces?: string[]
  /** Persisted workspace list — workspaces outlive their chats (deleting all a
   *  workspace's chats does NOT remove the workspace itself). Empty workspaces
   *  still render. Order is user-controlled (drag-and-drop in the sidebar). */
  workspaces?: Workspace[]
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

export interface ToolActivity {
  tool: string
  args?: Record<string, unknown>
  summary?: string
  status: 'running' | 'done' | 'error'
  diff?: string
  elapsedMs?: number
  startedAt?: number
  reverted?: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
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

export interface ChatMessage {
  id: string
  role: Role
  content: string
  mode?: AgentMode
  toolActivity?: ToolActivity[]
  plan?: Array<{ content: string; status: string }>
  thinking?: string
  /** True while this assistant message is still being generated (live status line). */
  streaming?: boolean
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  usage?: TokenUsage
  error?: boolean
  retry?: { attempt: number; maxAttempts: number; delay: number; reason: string } | null
  /** True once this message has been folded into a compact summary (kept in the
   *  UI as a greyed, collapsible entry but NOT re-sent to the model). */
  compacted?: boolean
  createdAt: number
}

/** Pending composer state scoped to one chat (labels below the input), so
 *  mentions / skills / MCP chips picked in one chat never leak into another. */
export interface ChatDraft {
  input?: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  skillChips?: Array<{ kind: 'skill' | 'mcp'; name: string; path?: string }>
}

export interface Chat {
  id: string
  title: string
  mode: AgentMode
  root?: string
  messages: ChatMessage[]
  draft?: ChatDraft
  createdAt: number
  updatedAt: number
}

export interface SidecarEvent {
  kind: 'text' | 'thinking' | 'tool' | 'tool_result' | 'diff' | 'error' | 'done' | 'usage' | 'retry' | 'compact' | 'plan' | 'permission' | 'ask'
  content?: string
  tool?: string
  args?: Record<string, unknown>
  summary?: string
  diff?: string
  path?: string
  /** update_plan items: [{ content, status }] */
  items?: Array<{ content: string; status: string }>
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
  cache_read_tokens?: number
  cache_write_tokens?: number
  attempt?: number
  max_attempts?: number
  delay?: number
  reason?: string
}
