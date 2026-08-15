import { create } from 'zustand'
import type {
  AgentMode,
  AgentModeDef,
  Chat,
  ChatDraft,
  ChatMessage,
  McpServerConfig,
  ProviderConfig,
  ProviderKind,
  QueuedMessage,
  RecentModel,
  SearchConsoleConfig,
  SearchPluginConfig,
  SearchPluginKind,
  Settings,
  TokenUsage,
  Workspace,
} from '../types'
import { api } from './fs'
import { deleteMcp, listMcp, saveMcp } from './api'
import { BUILTIN_IDS, normalizeMode } from './modes'
import { encryptSettings, decryptSettings } from './secrets'
import { PROVIDER_META } from './provider-meta'

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// Strip transient, in-memory-only fields from messages AND chats before
// persisting so they never reappear after a restart (e.g. the rate-limit retry
// banner, or a stale ask/permission popup whose agent is long gone).
function sanitizeChats(chats: Chat[]): Chat[] {
  return chats.map((c) => {
    const clean = { ...c }
    delete clean.pendingAsk
    delete clean.pendingPermission
    return {
      ...clean,
      messages: c.messages.map((m) => {
        const msg = { ...m } as Record<string, unknown>
        delete msg.retry
        delete msg.streaming
        delete msg.thinking
        delete msg.toolActivity
        return msg as unknown as ChatMessage
      }),
    }
  })
}

/** Display labels for the built-in modes (used in the mode-switch history note). */
const MODE_LABELS: Record<string, string> = { ask: 'Ask', plan: 'Plan', coder: 'Coder' }

/** Canonical display label per web-search engine kind — the label saved in a
 *  plugin row is derived metadata, never user-edited, so stale/legacy labels
 *  are replaced on hydration. */
const SEARCH_PLUGIN_LABELS: Record<SearchPluginKind, string> = {
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily',
}

/** Reduce an ordered plugin list to the first occurrence of each kind, keeping
 *  the original order, so a stray duplicate (left by a migration) can't show
 *  twice in Settings → Plugins or be tried twice by the backend. */
function dedupeByKind(rows: SearchPluginConfig[]): SearchPluginConfig[] {
  const seen = new Set<SearchPluginKind>()
  const out: SearchPluginConfig[] = []
  for (const r of rows) {
    if (seen.has(r.kind)) continue
    seen.add(r.kind)
    out.push(r)
  }
  return out
}

/** Map legacy prompt keys from before the modes registry onto current ids. */
function migrateModePrompts(prompts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...prompts }
  if ('chat' in out && !('ask' in out)) {
    out.ask = out.chat
    delete out.chat
  }
  if ('codewriter' in out && !('coder' in out)) {
    out.coder = out.codewriter
    delete out.codewriter
  }
  return out
}

let persistTimer: ReturnType<typeof setTimeout> | undefined
function persistSoon(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => useStore.getState().persist(), 500)
}

// Flush any deferred (mid-stream) persist immediately — used on app close so
// user-initiated saves made while streaming are not lost. ALWAYS writes the
// full current state (not just when a timer is pending): the main process only
// flushes its own queue after it receives the ACK, so writing unconditionally
// guarantees every in-memory change (added provider model, subagent model,
// …) reaches the main process before quit.
function flushPendingPersist(): Promise<unknown> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  return writeStateNow(useStore.getState())
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushPendingPersist()
  })
  // The main process asks the renderer to flush right before quitting, then
  // waits for this ACK before flushing its own queue — closing the race where
  // a write (e.g. a subagent model picked while streaming) arrived after the
  // main flush had already run and was silently dropped.
  api.onFlushPersist(() => {
    flushPendingPersist()
      .catch(() => {})
      .finally(() => {
        api.flushPersistDone()
      })
  })
}

/** Serialize the current store state to the sidecar DB (settings + chats).
 *  Shared by the debounced `persist` (skipped while a reply is streaming) and
 *  the force flush used on app quit. */
// Serialize settings persistence: each writeStateNow snapshots state
// synchronously, but encryption is async — a newer persist can overtake an older
// one, and letting the stale snapshot win would revert the user's latest change.
// A monotonic counter drops any snapshot that a newer writeStateNow superseded.
let persistSeq = 0
function writeStateNow(s: ReturnType<typeof useStore.getState>): Promise<unknown> {
  const { settings, chats, root, dir, maxHistory, recentModels, sidebarOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, embeddingModel, embeddingBaseUrl, subagentModels, taskTtlHours, shortTermTtlHours, longTermTtlHours, cacheTtlMinutes, memoryMaxNotes, memorySlidingTtl, memoryTtlDays, memoryMaxDocs, memoryMaxChunks, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats } = s
  const seq = ++persistSeq
  const memory = { taskTtlHours, shortTermTtlHours, longTermTtlHours, cacheTtlMinutes, maxNotes: memoryMaxNotes, slidingTtl: memorySlidingTtl }
  const writes: Promise<unknown>[] = [
    api.storeSet('chats', sanitizeChats(chats)),
  ]
  // Skip persisting settings while the store still holds cold-start defaults
  // (sidecar returned null on load, e.g. an external data volume that mounted
  // late). Writing defaults here is exactly what clobbered the real
  // settings.json on restart. Chats are safe to write regardless.
  if (s.settingsHydrated) {
    // Encrypt API keys / OAuth secrets before they reach settings.json on disk.
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, maxHistory, recentModels, sidebarOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, embeddingModel, embeddingBaseUrl, subagentModels, memory, memoryTtlDays, memoryMaxDocs, memoryMaxChunks, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats } as Settings)
        if (seq !== persistSeq) return
        await api.storeSet('settings', payload)
      })(),
    )
  }
  const del = s.deletedChatIds
  if (del.length) writes.push(api.storeSet('deleted_chats', del))
  const delW = s.deletedWorkspaceRoots
  if (delW.length) writes.push(api.storeSet('deleted_workspaces', delW))
  return Promise.all(writes)
}

// Per-chat in-memory undo/redo stacks (not persisted). An "exchange" is a user
// message plus every message that follows it (usually one assistant reply).
const historyStacks = new Map<string, { undo: ChatMessage[][]; redo: ChatMessage[][] }>()
function stackFor(chatId: string): { undo: ChatMessage[][]; redo: ChatMessage[][] } {
  let st = historyStacks.get(chatId)
  if (!st) {
    st = { undo: [], redo: [] }
    historyStacks.set(chatId, st)
  }
  return st
}

/** Default "Messages to remember" (cloud/global). Local providers (ollama) use
 *  a smaller default (see `defaultMaxHistoryFor`), since their models usually
 *  have small context windows. */
export const DEFAULT_MAX_HISTORY = 10

/** Local providers keep far fewer past messages by default — a small local
 *  model's context window is quickly flooded by several verbose tool-loop turns. */
export const LOCAL_MAX_HISTORY = 3

/** Resolve the default "Messages to remember" for a provider kind: local
 *  providers get `LOCAL_MAX_HISTORY`, everything else `DEFAULT_MAX_HISTORY`.
 *  An explicit per-provider `maxHistory` always overrides this at call sites. */
export function defaultMaxHistoryFor(kind: ProviderKind | undefined | null): number {
  return PROVIDER_META[kind ?? 'custom']?.local ? LOCAL_MAX_HISTORY : DEFAULT_MAX_HISTORY
}

export const PROVIDER_NAMES: Record<ProviderKind, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.name]),
) as Record<ProviderKind, string>

function defaultProviders(): ProviderConfig[] {
  const row = (id: ProviderKind, extra: Partial<ProviderConfig> = {}): ProviderConfig => {
    const meta = PROVIDER_META[id]
    return {
      id: id === 'ollama' ? 'local' : id,
      name: meta.name,
      kind: id,
      apiKey: '',
      envVar: meta.defaultEnvVar,
      baseUrl: meta.defaultBaseUrl ?? '',
      model: '',
      ...extra,
    }
  }
  return [
    row('opencode', { model: 'deepseek-v4-flash-free' }),
    row('openrouter'),
    row('ollama'),
    row('google'),
    row('nvidia'),
    row('cloudflare'),
    row('tokenrouter'),
  ]
}

function normalizeProvider(p: ProviderConfig): ProviderConfig {
  const kind = p.kind || 'custom'
  const meta = PROVIDER_META[kind]
  // Kinds that use unprefixed model ids (opencode) — drop any stale provider
  // prefix if present.
  const unprefixed = meta?.unprefixedModelId
  let model = p.model || ''
  if (unprefixed && model.startsWith('opencode/')) model = model.slice('opencode/'.length)
  return {
    // The local llama.cpp provider's id was historically 'ollama'; keep it
    // stable by migrating any legacy rows to the canonical 'local' id.
    id: p.id === 'ollama' ? 'local' : p.id || 'custom',
    name: p.name || PROVIDER_NAMES[kind] || 'Custom API',
    kind,
    apiKey: p.apiKey || '',
    envVar: p.envVar ?? defaultEnvVar(kind),
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl: p.baseUrl || meta?.defaultBaseUrl || '',
    model,
    authType: p.authType ?? '',
    oauthClientId: p.oauthClientId || '',
    oauthClientSecret: p.oauthClientSecret || '',
    oauthRefreshToken: p.oauthRefreshToken || '',
    contextWindow: p.contextWindow,
    contextMap: p.contextMap,
    pricingMap: p.pricingMap,
    maxHistory: p.maxHistory,
    thinkingLevel: p.thinkingLevel ?? '',
    models: Array.isArray(p.models)
      ? p.models.map((m) => (unprefixed ? m.replace(/^opencode\//, '') : m))
      : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : [],
  }
}

function defaultEnvVar(kind: ProviderKind): string {
  return PROVIDER_META[kind]?.defaultEnvVar ?? ''
}

/** Accept both the current {providerId, model} shape and legacy bare strings. */
function normalizeRecentModels(raw: unknown): RecentModel[] {
  if (!Array.isArray(raw)) return []
  const out: RecentModel[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ providerId: '', model: entry.trim() })
    } else if (entry && typeof entry === 'object') {
      const e = entry as { providerId?: unknown; model?: unknown }
      const model = typeof e.model === 'string' ? e.model.trim() : ''
      const pid = typeof e.providerId === 'string' ? e.providerId : ''
      if (model) out.push({ providerId: pid === 'ollama' ? 'local' : pid, model })
    }
  }
  return out.slice(0, 20)
}

interface State {
  loaded: boolean
  /** True once the sidecar returned a non-empty settings payload on load.
   *  While false, the store holds DEFAULTS (cold-start fallback) and must NOT
   *  persist them — writing defaults would clobber the real settings.json on a
   *  slow volume. */
  settingsHydrated: boolean
  settings: Settings
  /** Names of built-in MCP connectors (e.g. "docker") that can't be removed. */
  builtinMcp: string[]
  root: string
  theme: 'dark' | 'light'
  dir: 'rtl' | 'ltr'
  maxHistory: number
  recentModels: RecentModel[]
  sidebarOpen: boolean
  workspaceColors: Record<string, string>
  pinnedWorkspaces: string[]
  /** Chat ids pinned to the top of their workspace group (most-recently-pinned first). */
  pinnedChats: string[]
  workspaces: Workspace[]
  chats: Chat[]
  /** Chat ids deleted in the UI but not yet removed from the sidecar DB. */
  deletedChatIds: string[]
  /** Project roots whose workspace was deleted — their vector store is removed. */
  deletedWorkspaceRoots: string[]
  activeChatId: string
  settingsOpen: boolean
  isStreaming: boolean
  isThinking: boolean
  /** Session-scoped "allow outside-workspace" (reset when the root changes). */
  outsideAllowed: boolean

  load: () => Promise<void>
  persist: () => void

  setProviderConfig: (patch: Partial<ProviderConfig>) => void
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void
  addProvider: () => string
  removeProvider: (id: string) => void
  setActiveProvider: (id: string) => void
  setProviderModels: (id: string, models: string[]) => void
  setProviderContextMap: (id: string, contextMap: Record<string, number>) => void
  setProviderPricingMap: (id: string, pricingMap: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>) => void
  removeProviderModel: (id: string, model: string) => void
  setMcpServers: (mcpServers: Record<string, McpServerConfig>) => void
  addMcpServer: (name: string, cfg: McpServerConfig) => void
  updateMcpServer: (name: string, cfg: McpServerConfig) => void
  removeMcpServer: (name: string) => void
  setMcpEnabled: (name: string, on: boolean) => void
  setSystemPrompt: (mode: AgentMode, text: string) => void
  /** Toggle auto-skill selection (RAG) in Coder mode. */
  setAutoSkills: (on: boolean) => void
  /** Remove a mode (and its custom system prompt); used to purge legacy custom modes. */
  removeMode: (id: AgentMode) => void
  setRecentModels: (recentModels: RecentModel[]) => void
  addRecentModel: (model: string, providerId?: string) => void
  setRoot: (root: string) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setTheme: (theme: 'dark' | 'light') => void
  toggleTheme: () => void
  setDir: (dir: 'rtl' | 'ltr') => void
  toggleDir: () => void
  setMaxHistory: (n: number) => void
  fontSize: number
  setFontSize: (n: number) => void
  /** Directory for the per-workspace RAG vector store; "" = default. */
  vectorDbPath: string
  setVectorDbPath: (p: string) => void
  /** RAG store bounds: TTL (days), max docs, max chunks. */
  memoryTtlDays: number
  memoryMaxDocs: number
  memoryMaxChunks: number
  setMemoryConfig: (c: { ttlDays?: number; maxDocs?: number; maxChunks?: number }) => void
  /** User-level data root (app DB + skills/plans/mcp + vector stores). */
  dataPath: string
  setDataPath: (p: string) => void
  /** On-device model preferences (Settings → Models). */
  whisperModel: string
  whisperBaseUrl: string
  embeddingModel: string
  embeddingBaseUrl: string
  setWhisperModel: (m: string) => void
  setWhisperBaseUrl: (u: string) => void
  setEmbeddingModel: (m: string) => void
  setEmbeddingBaseUrl: (u: string) => void
  /** Per-subagent model overrides: explore / vision / compact. */
  subagentModels: Record<string, string>
  setSubagentModel: (agent: string, model: string) => void
  /** Memory-type TTLs (configurable from Settings → Memory). */
  taskTtlHours: number
  shortTermTtlHours: number
  longTermTtlHours: number
  cacheTtlMinutes: number
  memoryMaxNotes: number
  memorySlidingTtl: boolean
  setMemoryTtlConfig: (c: { task?: number; shortTerm?: number; longTerm?: number; cache?: number; maxNotes?: number; sliding?: boolean }) => void

  /** Web-search engines for web_search (Settings → Plugins). */
  searchPlugins: SearchPluginConfig[]
  setSearchPlugins: (plugins: SearchPluginConfig[]) => void
  /** Google Search Console OAuth + site for the search_console tool. */
  searchConsole: SearchConsoleConfig
  setSearchConsole: (patch: Partial<SearchConsoleConfig>) => void

  newChat: (mode?: AgentMode) => string
  newChatInRoot: (root: string, mode?: AgentMode) => string
  createWorkspace: (root: string) => string
  setWorkspaceOrder: (keys: string[]) => void
  deleteChat: (id: string) => void
  deleteWorkspace: (key: string) => void
  setWorkspaceColor: (key: string, color: string) => void
  togglePinWorkspace: (key: string) => void
  togglePinChat: (id: string) => void
  setActiveChat: (id: string) => void
  setChatMode: (id: string, mode: AgentMode) => void
  setChatRoot: (id: string, root: string) => void
  setChatDraft: (id: string, patch: Partial<ChatDraft>) => void
  renameChat: (id: string, title: string) => void
  addMessage: (chatId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>) => ChatMessage
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void
  /** Record a message typed while the chat's agent is already working. */
  queueMessage: (chatId: string, msg: Omit<QueuedMessage, 'createdAt'>) => void
  removeQueuedMessage: (chatId: string, id: string) => void
  clearQueue: (chatId: string) => void
  /** Mark a queued message as consumed (steered into the running agent). */
  markQueuedSent: (chatId: string, id: string) => void
  /** Add a model's token deltas to the chat-wide cumulative usage (survives
   *  compacts, unlike a single message's per-turn usage). */
  accrueChatUsage: (
    chatId: string,
    modelId: string,
    delta: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ) => void
  /** Zero the cumulative per-model usage of a chat (sidebar "reset" button). */
  resetChatUsage: (chatId: string) => void
  /** Set/clear a chat's pending `ask_user` request. Stored on the chat (not
   *  local component state) so it survives the ChatPanel remount that happens
   *  on every chat switch (`key={activeChatId}`) — otherwise a background
   *  chat's ask request is silently lost and its popup never appears. */
  setChatPendingAsk: (
    chatId: string,
    req: { id: string; question: string; options: string[] } | null,
  ) => void
  /** Set/clear a chat's pending `permission` request. Same rationale as
   *  `setChatPendingAsk`: stored on the chat so it survives the ChatPanel
   *  remount on chat switch. */
  setChatPendingPermission: (
    chatId: string,
    req: { id: string; action: string; path?: string; reason?: string; scope?: string } | null,
  ) => void
  markToolReverted: (messageId: string, index: number) => void
  truncateTo: (messageId: string) => boolean
  clearChat: (id: string) => void
  compactChat: (id: string, summary: string, keep?: number) => void
  undoMessage: () => boolean
  redoMessage: () => boolean

  setSettingsOpen: (open: boolean) => void
  setStreaming: (active: boolean, thinking: boolean) => void
  setOutsideAllowed: (allowed: boolean) => void
  /** Whether any chat currently has a streaming assistant message (persist gate
   *  and multi-chat "busy" indication). */
  anyStreaming: () => boolean
  /** Live AbortControllers per chat id (survive chat switches, allow multiple
   *  chats to run concurrently). */
  chatAborts: Record<string, AbortController | null>
  setChatAbort: (chatId: string, abort: AbortController | null) => void
  /** File open in Neovim (absolute path), fed by the main-process watcher. */
  nvimFile: string | null
  setNvimFile: (abs: string | null) => void
  /** LSP diagnostics for the Neovim file, reported by nvim's language server. */
  nvimDiagnostics: import('../types').NvimDiagnostic[]
  setNvimDiagnostics: (diagnostics: import('../types').NvimDiagnostic[]) => void
}

function makeChat(mode: AgentMode = 'ask'): Chat {
  const now = Date.now()
  return {
    id: uid(),
    title: 'New chat',
    mode,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Stable sidebar workspace key derived from a chat root ("" -> "no project" bucket). */
export function workspaceKey(root: string): string {
  return root || '__none__'
}

/** Last path segment of a root folder, for a compact workspace label. */
function workspaceLabel(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  if (!trimmed) return 'No project'
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

function makeWorkspace(root: string): Workspace {
  const key = workspaceKey(root)
  return { key, root: root || null, label: workspaceLabel(root) }
}

export const useStore = create<State>((set, get) => ({
  loaded: false,
  settingsHydrated: false,
  settings: { providers: defaultProviders(), activeProviderId: 'opencode', systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], autoSkills: false },
  builtinMcp: [],
  root: '',
  theme: 'dark',
  dir: 'rtl',
  maxHistory: DEFAULT_MAX_HISTORY,
  fontSize: 14,
  vectorDbPath: '',
  memoryTtlDays: 180,
  memoryMaxDocs: 500,
  memoryMaxChunks: 4000,
  whisperModel: 'Systran/faster-whisper-medium',
  whisperBaseUrl: '',
  embeddingModel: 'intfloat/multilingual-e5-base',
  embeddingBaseUrl: '',
  recentModels: [],
  subagentModels: {},
  taskTtlHours: 6,
  shortTermTtlHours: 24,
  longTermTtlHours: 8760,
  cacheTtlMinutes: 60,
  memoryMaxNotes: 500,
  memorySlidingTtl: true,
  searchPlugins: [{ kind: 'duckduckgo', label: 'DuckDuckGo', enabled: true, order: 0 }],
  searchConsole: { clientId: '', clientSecret: '', refreshToken: '', siteUrl: '' },
  sidebarOpen: true,
  dataPath: '',
  workspaceColors: {},
  pinnedWorkspaces: [],
  pinnedChats: [],
  workspaces: [],
  chats: [],
  deletedChatIds: [],
  deletedWorkspaceRoots: [],
  activeChatId: '',
  settingsOpen: false,
  isStreaming: false,
  isThinking: false,
  outsideAllowed: false,
  chatAborts: {},
  setChatAbort: (chatId, abort) =>
    set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),
  /** Absolute path of the file currently open in Neovim (null if none / unknown). */
  nvimFile: null,
  /** LSP diagnostics reported for the Neovim file (empty when none / unknown). */
  nvimDiagnostics: [],

  load: async () => {
    const [settings, chats] = await Promise.all([
      api.storeGet<Settings>('settings'),
      api.storeGet<Chat[]>('chats'),
    ])
    // True on a genuine first run (no settings file on disk yet) — in that case
    // the store's defaults ARE the correct state and may be persisted. On a cold
    // start where an existing settings file is briefly unreadable (slow external
    // volume), this stays false and the store refuses to write defaults over the
    // real file until a refresh returns the actual settings.
    let hasSettingsFile = false
    try {
      hasSettingsFile = (await api.hasSettingsFile()) ?? false
    } catch {
      /* treat as present — safest for the wipe guard */
    }
    // The authoritative data root is the pointer file in Electron (data-root.json),
    // not whatever stale value was last persisted into the settings DB. Sync it so
    // Settings → Memory shows where data actually lives.
    let realDataPath = ''
    try {
      realDataPath = (await api.getDataPath()) ?? ''
    } catch {
      /* keep the persisted value */
    }
    const loadedChats0 = chats && chats.length > 0 ? chats : []
    const loadedChats = loadedChats0.map((c) =>
      c.mode ? { ...c, mode: normalizeMode(c.mode) } : c,
    ) as Chat[]
    const activeId = loadedChats[loadedChats.length - 1]?.id ?? ''
    // Decrypt any secrets (API keys / OAuth creds) the settings file holds, so
    // the in-memory store always works with plaintext.
    const raw = await decryptSettings((settings ?? {}) as Partial<Settings> & { provider?: ProviderConfig })

    let providers: ProviderConfig[]
    let activeProviderId = ''
    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
      providers = raw.providers.map(normalizeProvider)
      // Backfill built-in provider rows that are missing from a settings file
      // saved by an older build (e.g. a google provider added in a newer
      // version), so it appears in Settings without the user re-adding it.
      const present = new Set(providers.map((p) => p.id))
      for (const def of defaultProviders()) {
        if (!present.has(def.id)) providers.push(def)
      }
      activeProviderId = providers.some((p) => p.id === raw.activeProviderId)
        ? raw.activeProviderId!
        : providers[0].id
    } else if (raw.provider) {
      // Migrate the old single-provider shape.
      const oldP = raw.provider
      const kind: ProviderKind =
        oldP.id === 'openrouter' || oldP.id === 'ollama' || oldP.id === 'opencode'
          ? oldP.id
          : 'custom'
      const name = PROVIDER_NAMES[kind]
      const legacy = normalizeProvider({
        id: oldP.id || 'custom',
        name: name || oldP.name || 'Custom API',
        kind,
        apiKey: oldP.apiKey || '',
        baseUrl: kind === 'custom' || kind === 'ollama' ? oldP.baseUrl || '' : '',
        model: oldP.model || '',
        contextWindow: oldP.contextWindow,
      })
      const defs = defaultProviders().filter((p) => p.id !== legacy.id)
      providers = [legacy, ...defs]
      activeProviderId = legacy.id
    } else {
      providers = defaultProviders()
      activeProviderId = providers[0].id
    }

    const loadedSettings: Settings = {
      providers,
      activeProviderId,
      systemPrompts: migrateModePrompts(raw.systemPrompts ?? {}),
      modes: Array.isArray(raw.modes)
        ? raw.modes.filter((m: AgentModeDef) => m && !BUILTIN_IDS.has(m.id))
        : [],
      mcpServers: raw.mcpServers ?? {},
      mcpEnabled: Array.isArray(raw.mcpEnabled)
        ? raw.mcpEnabled.filter((n: string) => !!raw.mcpServers?.[n])
        : [],
    }
    const fontSize = typeof raw.fontSize === 'number' && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14
    document.documentElement.style.setProperty('--chat-font-size', `${fontSize}px`)

    // First-class workspaces. Persisted list wins; otherwise backfill from the
    // existing chats so the sidebar keeps showing workspaces that predate this.
    let workspaces = Array.isArray(raw.workspaces)
      ? raw.workspaces.map((w) => ({
          key: String(w?.key ?? workspaceKey(String(w?.root ?? ''))),
          root: typeof w?.root === 'string' ? w.root : null,
          label: String(w?.label ?? '').trim() || workspaceLabel(String(w?.root ?? '')),
        }))
      : []
    const chatRoots = [...new Set(loadedChats.map((c) => c.root ?? ''))]
    if (workspaces.length === 0 && chatRoots.length > 0) {
      workspaces = chatRoots.map(makeWorkspace)
    } else {
      // Make sure any workspace that has chats but no persisted entry exists.
      const known = new Set(workspaces.map((w) => w.key))
      for (const r of chatRoots) {
        if (!known.has(workspaceKey(r))) workspaces.push(makeWorkspace(r))
      }
    }

    // Merge MCP connectors from the sidecar's app database into the UI
    // settings so they show up in Settings → MCP (DB wins, since it also holds
    // agent-created connectors not in the persisted settings).
    const root = typeof raw.root === 'string' ? raw.root : ''
    const dbMcp = await listMcp()
    const mergedMcp = { ...(loadedSettings.mcpServers ?? {}), ...(dbMcp.mcpServers ?? {}) }
    loadedSettings.mcpServers = mergedMcp
    const builtins = (dbMcp.builtins ?? []).filter((n) => mergedMcp[n])

    // Rows for removed engines (e.g. Google Custom Search, sunset by Google) are
    // dropped here so they disappear from Settings → Plugins on reload. Labels
    // are canonicalized per kind (a removed engine previously coerced to
    // `duckduckgo` left a stale "Google (Custom Search)" label behind), and
    // duplicate kinds (the same leftover) are reduced to the first occurrence.
    const searchPlugins = Array.isArray(raw.searchPlugins)
      ? dedupeByKind(
          (raw.searchPlugins as Partial<SearchPluginConfig>[])
            .filter((p) => (['duckduckgo', 'tavily'] as const).includes(p.kind as SearchPluginConfig['kind']))
            .map((p) => {
              const kind = p.kind as SearchPluginConfig['kind']
              return {
                kind,
                label: SEARCH_PLUGIN_LABELS[kind] || p.label || '',
                enabled: p.enabled !== false,
                order: typeof p.order === 'number' ? p.order : 0,
                apiKey: p.apiKey || '',
              }
            }),
        )
      : []

    set({
      loaded: true,
      // Only treat persisted settings as authoritative once the sidecar
      // actually returned them. A cold-start where the external volume isn't
      // mounted yet returns null here — the store stays on defaults and refuses
      // to persist them until a refresh returns the real file. A genuine first
      // run (no settings file at all) is fine to persist, though.
      settingsHydrated: settings !== null || !hasSettingsFile,
      settings: loadedSettings,
      builtinMcp: builtins,
      root,
      dir: raw.dir === 'ltr' ? 'ltr' : 'rtl',
      maxHistory: typeof raw.maxHistory === 'number' && raw.maxHistory > 0 ? raw.maxHistory : DEFAULT_MAX_HISTORY,
      fontSize,
      vectorDbPath: typeof raw.vectorDbPath === 'string' ? raw.vectorDbPath : '',
      memoryTtlDays: typeof raw.memoryTtlDays === 'number' && raw.memoryTtlDays > 0 ? raw.memoryTtlDays : 180,
      memoryMaxDocs: typeof raw.memoryMaxDocs === 'number' && raw.memoryMaxDocs >= 10 ? raw.memoryMaxDocs : 500,
      memoryMaxChunks: typeof raw.memoryMaxChunks === 'number' && raw.memoryMaxChunks >= 50 ? raw.memoryMaxChunks : 4000,
      dataPath: typeof raw.dataPath === 'string' && raw.dataPath.trim() ? raw.dataPath : (realDataPath || ''),
      whisperModel: typeof raw.whisperModel === 'string' && raw.whisperModel.trim() ? raw.whisperModel : 'Systran/faster-whisper-medium',
      whisperBaseUrl: typeof raw.whisperBaseUrl === 'string' ? raw.whisperBaseUrl : '',
      embeddingModel: typeof raw.embeddingModel === 'string' && raw.embeddingModel.trim() ? raw.embeddingModel : 'intfloat/multilingual-e5-base',
      embeddingBaseUrl: typeof raw.embeddingBaseUrl === 'string' ? raw.embeddingBaseUrl : '',
      subagentModels: typeof raw.subagentModels === 'object' && raw.subagentModels !== null
        ? { ...(raw.subagentModels as Record<string, string>) }
        : {},
      taskTtlHours: typeof raw.memory?.taskTtlHours === 'number' && raw.memory.taskTtlHours > 0 ? raw.memory.taskTtlHours : 6,
      shortTermTtlHours: typeof raw.memory?.shortTermTtlHours === 'number' && raw.memory.shortTermTtlHours > 0 ? raw.memory.shortTermTtlHours : 24,
      longTermTtlHours: typeof raw.memory?.longTermTtlHours === 'number' && raw.memory.longTermTtlHours > 0 ? raw.memory.longTermTtlHours : 8760,
      cacheTtlMinutes: typeof raw.memory?.cacheTtlMinutes === 'number' && raw.memory.cacheTtlMinutes > 0 ? raw.memory.cacheTtlMinutes : 60,
      memoryMaxNotes: typeof raw.memory?.maxNotes === 'number' && raw.memory.maxNotes >= 20 ? raw.memory.maxNotes : 500,
      memorySlidingTtl: typeof raw.memory?.slidingTtl === 'boolean' ? raw.memory.slidingTtl : true,
      // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
      // are dropped here so they disappear from Settings → Plugins on reload.
      searchPlugins: searchPlugins.length > 0
        ? searchPlugins
        : [{ kind: 'duckduckgo', label: 'DuckDuckGo', enabled: true, order: 0 }],
      searchConsole: {
        clientId: typeof raw.searchConsole?.clientId === 'string' ? raw.searchConsole.clientId : '',
        clientSecret: typeof raw.searchConsole?.clientSecret === 'string' ? raw.searchConsole.clientSecret : '',
        refreshToken: typeof raw.searchConsole?.refreshToken === 'string' ? raw.searchConsole.refreshToken : '',
        siteUrl: typeof raw.searchConsole?.siteUrl === 'string' ? raw.searchConsole.siteUrl : '',
      },
      recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
      sidebarOpen: raw.sidebarOpen !== false,
      workspaceColors: raw.workspaceColors ?? {},
      pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
      pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
      workspaces,
      chats: loadedChats,
      activeChatId: activeId,
    })
  },

  persist: () => {
    // Never rewrite the whole DB while a reply is streaming: each SSE token
    // fires store updates, and persisting every one hammers coder.db / the
    // cache file. The final state is persisted once streaming ends.
    // BUT never DROP user-initiated saves (mode prompts, subagent models,
    // provider config) made mid-stream: defer until streaming ends instead.
    if (get().anyStreaming()) {
      persistSoon()
      return
    }
    writeStateNow(get())
  },

  setProviderConfig: (patch) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) =>
          p.id === s.settings.activeProviderId ? { ...p, ...patch } : p,
        ),
        activeProviderId: s.settings.activeProviderId,
      },
    }))
    get().persist()
  },

  updateProvider: (id, patch) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) =>
          p.id === id ? normalizeProvider({ ...p, ...patch }) : p,
        ),
        activeProviderId: s.settings.activeProviderId,
      },
    }))
    get().persist()
  },

  addProvider: () => {
    const id = `custom-${Date.now().toString(36)}`
    const provider: ProviderConfig = {
      id,
      name: 'New provider',
      kind: 'custom',
      apiKey: '',
      baseUrl: '',
      model: '',
      models: [],
    }
    set((s) => ({
      settings: { ...s.settings, providers: [...s.settings.providers, provider] },
    }))
    get().persist()
    return id
  },

  removeProvider: (id) => {
    set((s) => {
      const providers = s.settings.providers.filter((p) => p.id !== id)
      const out = providers.length > 0 ? providers : defaultProviders()
      const active =
        s.settings.activeProviderId === id || !out.some((p) => p.id === s.settings.activeProviderId)
          ? out[0].id
          : s.settings.activeProviderId
      return { settings: { ...s.settings, providers: out, activeProviderId: active } }
    })
    get().persist()
  },

  setActiveProvider: (id) => {
    set((s) => {
      if (!s.settings.providers.some((p) => p.id === id)) return {}
      return { settings: { ...s.settings, activeProviderId: id } }
    })
    get().persist()
  },

  setProviderModels: (id, models) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) =>
          p.id === id
            ? {
                ...p,
                models: Array.from(new Set(models.filter(Boolean))),
                // Explicitly re-added models are no longer hidden.
                removedModels: (p.removedModels ?? []).filter((m) => !models.includes(m)),
              }
            : p,
        ),
      },
    }))
    get().persist()
  },

  setProviderContextMap: (id, contextMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => (p.id === id ? { ...p, contextMap } : p)),
      },
    }))
    get().persist()
  },

  setProviderPricingMap: (id, pricingMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => (p.id === id ? { ...p, pricingMap } : p)),
      },
    }))
    get().persist()
  },

  removeProviderModel: (id, model) => {
    set((s) => {
      const target = s.settings.providers.find((p) => p.id === id)
      const remaining = (target?.models ?? []).filter((m) => m !== model)
      return {
        settings: {
          ...s.settings,
          providers: s.settings.providers.map((p) =>
            p.id === id
              ? {
                  ...p,
                  models: remaining,
                  removedModels: Array.from(new Set([...(p.removedModels ?? []), model])),
                  // The main model is chosen in the composer, NOT here — never
                  // rewrite `model` when a provider model is removed.
                }
              : p,
          ),
        },
        recentModels: s.recentModels.filter((r) => !(r.providerId === id && r.model === model)),
      }
    })
    get().persist()
  },

  setMcpServers: (mcpServers) => {
    set((s) => ({ settings: { ...s.settings, mcpServers } }))
    get().persist()
  },

  addMcpServer: (name, cfg) => {
    set((s) => ({
      settings: { ...s.settings, mcpServers: { ...(s.settings.mcpServers ?? {}), [name]: cfg } },
    }))
    get().persist()
    void saveMcp(name, cfg)
  },

  updateMcpServer: (name, cfg) => {
    set((s) => ({
      settings: { ...s.settings, mcpServers: { ...(s.settings.mcpServers ?? {}), [name]: cfg } },
    }))
    get().persist()
    void saveMcp(name, cfg)
  },

  removeMcpServer: (name) => {
    if (get().builtinMcp.includes(name)) return
    set((s) => {
      const mcpServers = { ...(s.settings.mcpServers ?? {}) }
      delete mcpServers[name]
      const mcpEnabled = (s.settings.mcpEnabled ?? []).filter((n) => n !== name)
      return { settings: { ...s.settings, mcpServers, mcpEnabled } }
    })
    get().persist()
    void deleteMcp(name)
  },

  setMcpEnabled: (name, on) => {
    set((s) => {
      const cur = new Set(s.settings.mcpEnabled ?? [])
      if (on) cur.add(name)
      else cur.delete(name)
      return { settings: { ...s.settings, mcpEnabled: [...cur] } }
    })
    get().persist()
  },

  setSystemPrompt: (mode, text) => {
    set((s) => ({
      settings: {
        ...s.settings,
        systemPrompts: { ...(s.settings.systemPrompts ?? {}), [mode]: text },
      },
    }))
    get().persist()
  },

  removeMode: (id) => {
    set((s) => {
      const modes = (s.settings.modes ?? []).filter((m) => m.id !== id)
      const systemPrompts = { ...(s.settings.systemPrompts ?? {}) }
      delete systemPrompts[id]
      return { settings: { ...s.settings, modes, systemPrompts } }
    })
    get().persist()
  },

  setRoot: (root) => {
    set({ root, outsideAllowed: false })
    get().persist()
  },

  setTheme: (theme) => {
    set({ theme })
    document.documentElement.dataset.theme = theme
  },

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },

  setDir: (dir) => {
    set({ dir })
    get().persist()
  },

  toggleDir: () => {
    const next = get().dir === 'rtl' ? 'ltr' : 'rtl'
    get().setDir(next)
  },

  setMaxHistory: (maxHistory) => {
    set({ maxHistory })
    get().persist()
  },

  setFontSize: (fontSize) => {
    const n = Math.min(24, Math.max(10, Math.round(fontSize)))
    document.documentElement.style.setProperty('--chat-font-size', `${n}px`)
    set({ fontSize: n })
    get().persist()
  },

  setVectorDbPath: (vectorDbPath) => {
    set({ vectorDbPath: (vectorDbPath ?? '').trim() })
    get().persist()
  },

  setMemoryConfig: ({ ttlDays, maxDocs, maxChunks }) => {
    set({
      memoryTtlDays: typeof ttlDays === 'number' && ttlDays > 0 ? Math.round(ttlDays) : get().memoryTtlDays,
      memoryMaxDocs: typeof maxDocs === 'number' && maxDocs >= 10 ? Math.round(maxDocs) : get().memoryMaxDocs,
      memoryMaxChunks: typeof maxChunks === 'number' && maxChunks >= 50 ? Math.round(maxChunks) : get().memoryMaxChunks,
    })
    get().persist()
  },

  setDataPath: (dataPath) => {
    set({ dataPath: (dataPath ?? '').trim() })
    get().persist()
  },

  setWhisperModel: (m) => {
    set({ whisperModel: (m ?? '').trim() || 'Systran/faster-whisper-medium' })
    get().persist()
  },
  setWhisperBaseUrl: (u) => {
    set({ whisperBaseUrl: (u ?? '').trim() })
    get().persist()
  },
  setEmbeddingModel: (m) => {
    set({ embeddingModel: (m ?? '').trim() || 'intfloat/multilingual-e5-base' })
    get().persist()
  },
  setEmbeddingBaseUrl: (u) => {
    set({ embeddingBaseUrl: (u ?? '').trim() })
    get().persist()
  },

  setSubagentModel: (agent, model) => {
    set((s) => {
      const subagentModels = { ...s.subagentModels }
      if (model) subagentModels[agent] = model
      else delete subagentModels[agent]
      return { subagentModels }
    })
    get().persist()
  },

  setMemoryTtlConfig: (c) => {
    set({
      taskTtlHours: typeof c.task === 'number' && c.task > 0 ? Math.round(c.task) : get().taskTtlHours,
      shortTermTtlHours: typeof c.shortTerm === 'number' && c.shortTerm > 0 ? Math.round(c.shortTerm) : get().shortTermTtlHours,
      longTermTtlHours: typeof c.longTerm === 'number' && c.longTerm > 0 ? Math.round(c.longTerm) : get().longTermTtlHours,
      cacheTtlMinutes: typeof c.cache === 'number' && c.cache > 0 ? Math.round(c.cache) : get().cacheTtlMinutes,
      memoryMaxNotes: typeof c.maxNotes === 'number' && c.maxNotes >= 20 ? Math.round(c.maxNotes) : get().memoryMaxNotes,
      memorySlidingTtl: typeof c.sliding === 'boolean' ? c.sliding : get().memorySlidingTtl,
    })
    get().persist()
  },

  setSearchPlugins: (searchPlugins) => {
    set({ searchPlugins })
    get().persist()
  },

  setSearchConsole: (patch) => {
    set((s) => ({ searchConsole: { ...s.searchConsole, ...patch } }))
    get().persist()
  },

  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen })
    get().persist()
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen
    get().setSidebarOpen(next)
  },

  setRecentModels: (recentModels) => {
    set({ recentModels })
    get().persist()
  },

  addRecentModel: (model, providerId) => {
    const m = (model || '').trim()
    if (!m) return
    const pid = providerId || ''
    set((s) => {
      const recentModels = [
        { providerId: pid, model: m },
        ...s.recentModels.filter((x) => x.model !== m || x.providerId !== pid),
      ].slice(0, 20)
      return { recentModels }
    })
    get().persist()
  },

  newChat: (mode) => {
    const chat = makeChat(mode ?? 'ask')
    const s = useStore.getState()
    const prevRoot = s.chats.find((c) => c.id === s.activeChatId)?.root
    const lastRoot = [...s.chats].reverse().find((c) => c.root)?.root
    chat.root = prevRoot ?? lastRoot ?? s.root
    const activeChatId = chat.id
    set((st) => ({ chats: [...st.chats, chat], activeChatId }))
    get().persist()
    return activeChatId
  },

  newChatInRoot: (root, mode) => {
    const key = workspaceKey(root ?? '')
    const chat = makeChat(mode ?? 'ask')
    chat.root = root || undefined
    const activeChatId = chat.id
    set((st) => {
      // Register the workspace if unknown (kept in place thereafter).
      let workspaces = st.workspaces
      if (!workspaces.some((w) => w.key === key)) {
        workspaces = [...workspaces, makeWorkspace(root ?? '')]
      }
      return { workspaces, chats: [...st.chats, chat], activeChatId }
    })
    get().persist()
    return activeChatId
  },

  createWorkspace: (root) => {
    const key = workspaceKey(root ?? '')
    const ws = makeWorkspace(root ?? '')
    set((s) => {
      const workspaces = s.workspaces.some((w) => w.key === key)
        ? s.workspaces
        : [...s.workspaces, ws]
      return { workspaces }
    })
    get().persist()
    return key
  },

  setWorkspaceOrder: (keys) => {
    set((s) => {
      const ordered = [...keys]
        .map((k) => s.workspaces.find((w) => w.key === k))
        .filter((w): w is Workspace => Boolean(w))
      // Keep any workspaces not present in the drag list (safety).
      const known = new Set(ordered.map((w) => w.key))
      for (const w of s.workspaces) if (!known.has(w.key)) ordered.push(w)
      return { workspaces: ordered }
    })
    get().persist()
  },

  deleteChat: (id) => {
    set((s) => {
      const chats = s.chats.filter((c) => c.id !== id)
      const activeChatId = s.activeChatId === id ? (chats[chats.length - 1]?.id ?? '') : s.activeChatId
      return { chats, activeChatId, deletedChatIds: [...s.deletedChatIds, id], pinnedChats: s.pinnedChats.filter((k) => k !== id) }
    })
    get().persist()
  },

  deleteWorkspace: (key) => {
    set((s) => {
      const chats = s.chats.filter((c) => workspaceKey(c.root ?? '') !== key)
      const workspaces = s.workspaces.filter((w) => w.key !== key)
      const doomedIds = new Set(
        s.chats
          .filter((c) => workspaceKey(c.root ?? '') === key)
          .map((c) => c.id),
      )
      const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key)
      const pinnedChats = s.pinnedChats.filter((k) => !doomedIds.has(k))
      const activeChatId = s.chats.some((c) => c.id === s.activeChatId && workspaceKey(c.root ?? '') !== key)
        ? s.activeChatId
        : chats[chats.length - 1]?.id ?? ''
      return {
        chats,
        workspaces,
        pinnedWorkspaces,
        pinnedChats,
        activeChatId,
        deletedChatIds: [
          ...s.deletedChatIds,
          ...s.chats.filter((c) => workspaceKey(c.root ?? '') === key).map((c) => c.id),
        ],
        deletedWorkspaceRoots: [
          ...s.deletedWorkspaceRoots,
          ...s.chats.filter((c) => workspaceKey(c.root ?? '') === key).map((c) => c.root ?? ''),
        ],
      }
    })
    get().persist()
  },

  setWorkspaceColor: (key, color) => {
    set((s) => {
      const workspaceColors = { ...s.workspaceColors }
      if (color) workspaceColors[key] = color
      else delete workspaceColors[key]
      return { workspaceColors }
    })
    get().persist()
  },

  togglePinWorkspace: (key) => {
    set((s) => {
      const wasPinned = s.pinnedWorkspaces.includes(key)
      const pinnedWorkspaces = wasPinned
        ? s.pinnedWorkspaces.filter((k) => k !== key)
        : [key, ...s.pinnedWorkspaces]
      return { pinnedWorkspaces }
    })
    get().persist()
  },

  togglePinChat: (id) => {
    set((s) => {
      const wasPinned = s.pinnedChats.includes(id)
      const pinnedChats = wasPinned
        ? s.pinnedChats.filter((k) => k !== id)
        : [id, ...s.pinnedChats]
      return { pinnedChats }
    })
    get().persist()
  },

  setActiveChat: (id) => {
    set({ activeChatId: id })
    get().persist()
  },

  setChatMode: (id, mode) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== id) return c
        // Record the switch in the history so the agent sees the mode change in
        // the conversation (not just in the system prompt) and the compact
        // summary preserves it. System messages are always kept by sliceToBudget.
        const label = MODE_LABELS[mode] ?? mode
        const modeMsg: ChatMessage = {
          id: uid(),
          role: 'system',
          content: `[Mode switched to ${label} — the next user message runs in ${label} mode.]`,
          modeSwitch: true,
          createdAt: Date.now(),
        }
        return { ...c, mode, messages: [...c.messages, modeMsg], updatedAt: Date.now() }
      }),
    }))
    get().persist()
  },

  setChatRoot: (id, root) => {
    set((s) => ({
      root: s.activeChatId === id ? root : s.root,
      chats: s.chats.map((c) => (c.id === id ? { ...c, root, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  setChatDraft: (id, patch) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id ? { ...c, draft: { ...c.draft, ...patch } } : c,
      ),
    }))
  },

  renameChat: (id, title) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  addMessage: (chatId, message) => {
    const id = uid()
    const full: ChatMessage = { ...message, id, createdAt: Date.now() }
    set((s) => {
      if (message.role === 'user') {
        const st = stackFor(chatId)
        st.redo = []
      }
      const chats = s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: [...c.messages, full],
              // A chat's sidebar position only changes when its agent's turn
              // COMPLETES (see updateMessage). Sending a user message or the
              // streaming assistant message must NOT float the chat to the top
              // mid-run, or two concurrent chats keep swapping places. Instant
              // completed assistant replies (undo/redo/help/skill confirmations)
              // still bump, since they're finished turns.
              updatedAt:
                !message.streaming && message.role === 'assistant'
                  ? Date.now()
                  : c.updatedAt,
              title: c.messages.length === 0 && message.role === 'user' ? message.content.slice(0, 48) : c.title,
            }
          : c,
      )
      return { chats }
    })
    get().persist()
    return full
  },

  queueMessage: (chatId, msg) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? { ...c, queued: [...(c.queued ?? []), { ...msg, createdAt: Date.now() }] }
          : c,
      ),
    }))
    get().persist()
  },

  removeQueuedMessage: (chatId, id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, queued: (c.queued ?? []).filter((q) => q.id !== id) } : c,
      ),
    }))
    get().persist()
  },

  clearQueue: (chatId) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, queued: [] } : c)),
    }))
    get().persist()
  },

  markQueuedSent: (chatId, id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? { ...c, queued: (c.queued ?? []).map((q) => (q.id === id ? { ...q, sent: true } : q)) }
          : c,
      ),
    }))
    get().persist()
  },

  updateMessage: (id, patch) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        const msg = c.messages.find((m) => m.id === id)
        if (!msg) return c
        // Only the turn-completion transition (streaming true -> false) moves
        // the chat in the sidebar; per-token content/thinking/tool deltas must
        // not reorder it, or two concurrent chats trade places constantly.
        const completes =
          msg.streaming === true && patch.streaming === false
        return {
          ...c,
          messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          updatedAt: completes ? Date.now() : c.updatedAt,
        }
      }),
    }))
    // updateMessage fires on every SSE token while streaming — persisting the
    // whole chats array each time is what hammers coder.db / app-state-cache.json.
    // Skip it during streaming; the final state is persisted once the stream ends
    // (setStreaming(false) → the trailing updateMessage({streaming:false})).
    if (!get().anyStreaming()) persistSoon()
  },

  accrueChatUsage: (chatId, modelId, delta) => {
    if ((delta.input || 0) <= 0 && (delta.output || 0) <= 0) return
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== chatId) return c
        const usage = { ...(c.usage ?? {}) }
        const prev = usage[modelId] ?? { input: 0, output: 0 }
        usage[modelId] = {
          input: prev.input + (delta.input || 0),
          output: prev.output + (delta.output || 0),
          cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
          cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
          lastUsed: Date.now(),
        }
        // Usage fires once per model call INSIDE a run — don't reorder the
        // sidebar mid-turn. The turn-completion bump in updateMessage handles
        // reordering when the agent finishes.
        const working = c.messages.some((m) => m.streaming)
        return { ...c, usage, updatedAt: working ? c.updatedAt : Date.now() }
      }),
    }))
    // Usage events fire once per completed model call (not per token), and
    // persistSoon is debounced, so persisting here is cheap and safe.
    persistSoon()
  },

  resetChatUsage: (chatId) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, usage: undefined, updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
  },

  setChatPendingAsk: (chatId, req) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, pendingAsk: req } : c)),
    }))
  },

  setChatPendingPermission: (chatId, req) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, pendingPermission: req } : c)),
    }))
  },

  markToolReverted: (messageId, index) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        const has = c.messages.some((m) => m.id === messageId)
        if (!has) return c
        return {
          ...c,
          messages: c.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  toolActivity: (m.toolActivity ?? []).map((act, i) =>
                    i === index ? { ...act, reverted: true } : act,
                  ),
                }
              : m,
          ),
          updatedAt: Date.now(),
        }
      }),
    }))
    persistSoon()
  },

  clearChat: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id ? { ...c, messages: [], usage: undefined, updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
  },

  truncateTo: (messageId) => {
    const s = get()
    const chat = s.chats.find((c) => c.id === s.activeChatId)
    if (!chat) return false
    const idx = chat.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return false
    set((st) => ({
      chats: st.chats.map((c) =>
        c.id === s.activeChatId
          ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() }
          : c,
      ),
    }))
    get().persist()
    return true
  },

  compactChat: (id, summary, keep = 0) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== id) return c
        const nonSys = c.messages.filter((m) => m.role !== 'system')
        // Keep the last `keep` messages verbatim; fold everything older into the
        // summary. `keep` is the EXACT number of recent turns to preserve (the
        // backend reports it for auto-compact; the manual /compact path passes
        // maxHistory-1). The summary is appended so the next turn's
        // sliceToBudget (which sends the last maxHistory entries, system-first)
        // keeps summary + recent together without contradicting either.
        const recentStart = Math.max(nonSys.length - keep, 0)
        const compactedIds = new Set(
          nonSys.slice(0, recentStart).map((m) => m.id),
        )
        // On a repeated /compact, also fold any PREVIOUS system summary so only
        // the newest summary renders as the prominent block (the old ones stay
        // greyed/collapsible like any other folded message).
        for (const m of c.messages) {
          if (m.role === 'system') compactedIds.add(m.id)
        }
        const messages = c.messages.map((m) =>
          compactedIds.has(m.id)
            ? { ...m, compacted: true, usage: undefined as TokenUsage | undefined }
            : { ...m, usage: undefined as TokenUsage | undefined },
        )
        const summaryMsg = {
          id: uid(),
          role: 'system' as const,
          content: summary,
          usage: undefined as TokenUsage | undefined,
          createdAt: Date.now(),
        }
        // Insert the summary at the COMPACTION BOUNDARY — right after the folded
        // older messages and BEFORE the preserved recent ones — so it reads as a
        // in-conversation checkpoint (like a steer note) with the kept verbatim
        // turns and any follow-up tool calls AFTER it, instead of a bubble glued
        // to the bottom of the scrollback. The model still receives it first on
        // the next request (sliceToBudget sorts system-first).
        let boundary = 0
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].compacted) boundary = i + 1
        }
        messages.splice(boundary, 0, summaryMsg)
        return {
          ...c,
          messages,
          updatedAt: Date.now(),
        }
      }),
    }))
    get().persist()
  },

  undoMessage: () => {
    const s = get()
    const chat = s.chats.find((c) => c.id === s.activeChatId)
    if (!chat || chat.messages.length === 0) return false
    let idx = -1
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user') {
        idx = i
        break
      }
    }
    if (idx === -1) return false
    const removed = chat.messages.slice(idx)
    const st = stackFor(chat.id)
    st.undo.push(removed)
    st.redo = []
    set((stt) => ({
      chats: stt.chats.map((c) =>
        c.id === chat.id ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
    return true
  },

  redoMessage: () => {
    const s = get()
    const chat = s.chats.find((c) => c.id === s.activeChatId)
    if (!chat) return false
    const st = stackFor(chat.id)
    const exchange = st.undo.pop()
    if (!exchange) return false
    st.redo.push(exchange)
    set((stt) => ({
      chats: stt.chats.map((c) =>
        c.id === chat.id ? { ...c, messages: [...c.messages, ...exchange], updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
    return true
  },

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setStreaming: (active, thinking) =>
    set((s) => {
      if (s.isStreaming === active && s.isThinking === thinking) return {}
      return { isStreaming: active, isThinking: thinking }
    }),

  setOutsideAllowed: (allowed) => set({ outsideAllowed: allowed }),

  anyStreaming: () => get().chats.some((c) => c.messages.some((m) => m.streaming)),

  setAutoSkills: (on) => {
    set((s) => ({ settings: { ...s.settings, autoSkills: on } }))
    get().persist()
  },

  setNvimFile: (abs) => set({ nvimFile: abs }),
  setNvimDiagnostics: (diagnostics) => set({ nvimDiagnostics: diagnostics }),
}))

/**
 * Force-persist the store NOW, ignoring the streaming guard. Called on app
 * quit (beforeunload) so a change made while a reply was streaming — e.g. a
 * subagent model picked in Settings, which `persist()` had deferred via
 * persistSoon() — is never lost to a timer that never fires before the window
 * closes. The main process then flushes its own queue on will-quit.
 */
export function flushStateNow(): Promise<unknown> {
  clearTimeout(persistTimer)
  return writeStateNow(useStore.getState())
}

// Re-fetch state when the sidecar becomes reachable (cold-start refresh) or
// after a data-root move, so the sidebar never stays empty/stale.
api.onSidecarChanged(() => {
  void useStore.getState().load()
})

export function getActiveChat(): Chat | null {
  const s = useStore.getState()
  return s.chats.find((c) => c.id === s.activeChatId) ?? null
}

export function getActiveMode(): AgentMode {
  return getActiveChat()?.mode ?? 'ask'
}

export function getActiveProvider(): ProviderConfig {
  const s = useStore.getState()
  return (
    s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
    s.settings.providers[0]
  )
}
