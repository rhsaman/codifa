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
  Settings,
  TokenUsage,
  Workspace,
} from '../types'
import { api, workspaceMcp } from './fs'
import { BUILTIN_IDS, normalizeMode } from './modes'

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

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

export const DEFAULT_MAX_HISTORY = 10

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  opencode: 'opencode',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
  custom: 'Custom API',
}

function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'opencode',
      name: 'opencode',
      kind: 'opencode',
      apiKey: '',
      envVar: 'OPENCODE_API_KEY',
      baseUrl: '',
      model: 'deepseek-v4-flash-free',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openrouter',
      apiKey: '',
      envVar: 'OPENROUTER_API_KEY',
      baseUrl: '',
      model: '',
    },
    {
      id: 'ollama',
      name: 'Ollama (local)',
      kind: 'ollama',
      apiKey: '',
      envVar: '',
      baseUrl: 'http://localhost:11434',
      model: '',
    },
  ]
}

function normalizeProvider(p: ProviderConfig): ProviderConfig {
  const kind = p.kind || 'custom'
  // The opencode gateway uses unprefixed IDs (deepseek-v4-flash-free, not
  // opencode/deepseek-v4-flash-free) — drop the stale prefix if present.
  let model = p.model || ''
  if (kind === 'opencode' && model.startsWith('opencode/')) model = model.slice('opencode/'.length)
  return {
    id: p.id || 'custom',
    name: p.name || PROVIDER_NAMES[kind] || 'Custom API',
    kind,
    apiKey: p.apiKey || '',
    envVar: p.envVar ?? defaultEnvVar(kind),
    baseUrl: p.baseUrl || '',
    model,
    contextWindow: p.contextWindow,
    contextMap: p.contextMap,
    maxHistory: p.maxHistory,
    thinkingLevel: p.thinkingLevel ?? '',
    models: Array.isArray(p.models) ? p.models.map((m) => (kind === 'opencode' ? m.replace(/^opencode\//, '') : m)) : [],
  }
}

function defaultEnvVar(kind: ProviderKind): string {
  switch (kind) {
    case 'opencode':
      return 'OPENCODE_API_KEY'
    case 'openrouter':
      return 'OPENROUTER_API_KEY'
    default:
      return ''
  }
}

interface State {
  loaded: boolean
  settings: Settings
  root: string
  theme: 'dark' | 'light'
  dir: 'rtl' | 'ltr'
  maxHistory: number
  recentModels: string[]
  sidebarOpen: boolean
  workspaceColors: Record<string, string>
  pinnedWorkspaces: string[]
  workspaces: Workspace[]
  chats: Chat[]
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
  removeProviderModel: (id: string, model: string) => void
  setMcpServers: (mcpServers: Record<string, McpServerConfig>) => void
  addMcpServer: (name: string, cfg: McpServerConfig) => void
  updateMcpServer: (name: string, cfg: McpServerConfig) => void
  removeMcpServer: (name: string) => void
  setSystemPrompt: (mode: AgentMode, text: string) => void
  /** Upsert a user-created mode def; kept separate from built-ins. */
  upsertMode: (def: AgentModeDef) => void
  removeMode: (id: AgentMode) => void
  setRecentModels: (recentModels: string[]) => void
  addRecentModel: (model: string) => void
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

  newChat: (mode?: AgentMode) => string
  newChatInRoot: (root: string, mode?: AgentMode) => string
  createWorkspace: (root: string) => string
  setWorkspaceOrder: (keys: string[]) => void
  deleteChat: (id: string) => void
  deleteWorkspace: (key: string) => void
  setWorkspaceColor: (key: string, color: string) => void
  togglePinWorkspace: (key: string) => void
  setActiveChat: (id: string) => void
  setChatMode: (id: string, mode: AgentMode) => void
  setChatRoot: (id: string, root: string) => void
  setChatDraft: (id: string, patch: Partial<ChatDraft>) => void
  renameChat: (id: string, title: string) => void
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => ChatMessage
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void
  markToolReverted: (messageId: string, index: number) => void
  truncateTo: (messageId: string) => boolean
  clearChat: (id: string) => void
  compactChat: (id: string, summary: string, keep?: number) => void
  undoMessage: () => boolean
  redoMessage: () => boolean

  setSettingsOpen: (open: boolean) => void
  setStreaming: (active: boolean, thinking: boolean) => void
  setOutsideAllowed: (allowed: boolean) => void
  /** Live AbortController for the in-flight chat request (survives chat switches). */
  activeAbort: AbortController | null
  setActiveAbort: (abort: AbortController | null) => void
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
  settings: { providers: defaultProviders(), activeProviderId: 'opencode', systemPrompts: {}, mcpServers: {}, modes: [] },
  root: '',
  theme: 'dark',
  dir: 'rtl',
  maxHistory: DEFAULT_MAX_HISTORY,
  fontSize: 14,
  recentModels: [],
  sidebarOpen: true,
  workspaceColors: {},
  pinnedWorkspaces: [],
  workspaces: [],
  chats: [makeChat()],
  activeChatId: '',
  settingsOpen: false,
  isStreaming: false,
  isThinking: false,
  outsideAllowed: false,
  activeAbort: null,
  /** Absolute path of the file currently open in Neovim (null if none / unknown). */
  nvimFile: null,
  /** LSP diagnostics reported for the Neovim file (empty when none / unknown). */
  nvimDiagnostics: [],

  load: async () => {
    const [settings, chats] = await Promise.all([
      api.storeGet<Settings>('settings'),
      api.storeGet<Chat[]>('chats'),
    ])
    const loadedChats0 = chats && chats.length > 0 ? chats : [makeChat()]
    const loadedChats = loadedChats0.map((c) =>
      c.mode ? { ...c, mode: normalizeMode(c.mode) } : c,
    ) as Chat[]
    const activeId = loadedChats[loadedChats.length - 1]?.id ?? ''
    const raw = (settings ?? {}) as Partial<Settings> & { provider?: ProviderConfig }

    let providers: ProviderConfig[]
    let activeProviderId = ''
    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
      providers = raw.providers.map(normalizeProvider)
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

    // Merge MCP connectors that the agent wrote to .coder/mcp.json into the UI
    // settings so they show up in Settings → MCP (file wins, since it may hold
    // agent-created connectors not in the persisted settings).
    const root = typeof raw.root === 'string' ? raw.root : ''
    if (root) {
      const fileMcp = await workspaceMcp(root)
      loadedSettings.mcpServers = { ...(loadedSettings.mcpServers ?? {}), ...fileMcp }
    }

    set({
      loaded: true,
      settings: loadedSettings,
      root,
      dir: raw.dir === 'ltr' ? 'ltr' : 'rtl',
      maxHistory: typeof raw.maxHistory === 'number' && raw.maxHistory > 0 ? raw.maxHistory : DEFAULT_MAX_HISTORY,
      fontSize,
      recentModels: Array.isArray(raw.recentModels) ? raw.recentModels.slice(0, 20) : [],
      sidebarOpen: raw.sidebarOpen !== false,
      workspaceColors: raw.workspaceColors ?? {},
      pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
      workspaces,
      chats: loadedChats,
      activeChatId: activeId,
    })
  },

  persist: () => {
    const { settings, chats, root, dir, maxHistory, recentModels, sidebarOpen, fontSize, workspaceColors, pinnedWorkspaces, workspaces } = get()
    void api.storeSet('settings', { ...settings, root, dir, maxHistory, recentModels, sidebarOpen, fontSize, workspaceColors, pinnedWorkspaces, workspaces })
    void api.storeSet('chats', chats)
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
      settings: { ...s.settings, providers: [...s.settings.providers, provider], activeProviderId: id },
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
          p.id === id ? { ...p, models: Array.from(new Set(models.filter(Boolean))) } : p,
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

  removeProviderModel: (id, model) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) =>
          p.id === id ? { ...p, models: (p.models ?? []).filter((m) => m !== model) } : p,
        ),
      },
    }))
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
  },

  updateMcpServer: (name, cfg) => {
    set((s) => ({
      settings: { ...s.settings, mcpServers: { ...(s.settings.mcpServers ?? {}), [name]: cfg } },
    }))
    get().persist()
  },

  removeMcpServer: (name) => {
    set((s) => {
      const mcpServers = { ...(s.settings.mcpServers ?? {}) }
      delete mcpServers[name]
      return { settings: { ...s.settings, mcpServers } }
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

  upsertMode: (def) => {
    set((s) => {
      const modes = [...(s.settings.modes ?? [])]
      const i = modes.findIndex((m) => m.id === def.id)
      if (i >= 0) modes[i] = def
      else modes.push(def)
      return { settings: { ...s.settings, modes } }
    })
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

  addRecentModel: (model) => {
    const m = (model || '').trim()
    if (!m) return
    set((s) => {
      const recentModels = [m, ...s.recentModels.filter((x) => x !== m)].slice(0, 20)
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
      return { chats, activeChatId }
    })
    get().persist()
  },

  deleteWorkspace: (key) => {
    set((s) => {
      const chats = s.chats.filter((c) => workspaceKey(c.root ?? '') !== key)
      const workspaces = s.workspaces.filter((w) => w.key !== key)
      const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key)
      const activeChatId = s.chats.some((c) => c.id === s.activeChatId && workspaceKey(c.root ?? '') !== key)
        ? s.activeChatId
        : chats[chats.length - 1]?.id ?? ''
      return { chats, workspaces, pinnedWorkspaces, activeChatId }
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

  setActiveChat: (id) => {
    set({ activeChatId: id })
    get().persist()
  },

  setChatMode: (id, mode) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, mode, updatedAt: Date.now() } : c)),
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
    persistSoon()
  },

  renameChat: (id, title) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  addMessage: (message) => {
    const id = uid()
    const full: ChatMessage = { ...message, id, createdAt: Date.now() }
    set((s) => {
      if (message.role === 'user') {
        const st = stackFor(s.activeChatId)
        st.redo = []
      }
      const chats = s.chats.map((c) =>
        c.id === s.activeChatId
          ? {
              ...c,
              messages: [...c.messages, full],
              updatedAt: Date.now(),
              title: c.messages.length === 0 && message.role === 'user' ? message.content.slice(0, 48) : c.title,
            }
          : c,
      )
      return { chats }
    })
    get().persist()
    return full
  },

  updateMessage: (id, patch) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        const has = c.messages.some((m) => m.id === id)
        if (!has) return c
        return {
          ...c,
          messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          updatedAt: Date.now(),
        }
      }),
    }))
    persistSoon()
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
      chats: s.chats.map((c) => (c.id === id ? { ...c, messages: [], updatedAt: Date.now() } : c)),
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
        // summary. We keep one fewer than `keep` (see sliceToBudget: the next
        // turn sends the last `maxHistory` entries, and the appended summary
        // must survive that slice — so recent (keep-1) + summary = keep total).
        const recentCount = keep > 0 ? Math.max(keep - 1, 0) : 0
        const recentStart = Math.max(nonSys.length - recentCount, 0)
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
        return {
          ...c,
          messages: [
            ...messages,
            // Appended at the END so the summary block renders below the
            // conversation (older folded messages above it), matching how
            // compactions read in the scrollback.
            { id: uid(), role: 'system', content: summary, createdAt: Date.now() },
          ],
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

  setActiveAbort: (activeAbort) => set({ activeAbort }),

  setNvimFile: (abs) => set({ nvimFile: abs }),
  setNvimDiagnostics: (diagnostics) => set({ nvimDiagnostics: diagnostics }),
}))

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
