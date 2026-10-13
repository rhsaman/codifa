import { create } from 'zustand'
import type {
  AgentMode,
  AgentModeDef,
  Chat,
  ChatDraft,
  ChatMessage,
  McpServerConfig,
  MessageSegment,
  ProviderConfig,
  ProviderKind,
  QueuedMessage,
  RecentModel,
  SearchConsoleConfig,
  SearchPluginConfig,
  SearchPluginKind,
  Settings,
  SttFallback,
  TtsFallback,
  ThinkingLevel,
  TokenUsage,
  ToolActivity,
  LspStatus,
  Workspace,
} from '../types'

/** Max persisted inbox seen ids — newest win, so the badge store stays bounded. */
export const MAX_SCHEDULE_RUNS_SEEN = 500

/** Normalize persisted seen ids to a bounded list of non-empty strings. Pure for test. */
export function normalizeScheduleRunsSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v === 'string' && v.trim()) out.push(v)
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN)
}
import { api } from './fs'
import { deleteMcp, listMcp, requestChatTitle, saveMcp } from './api'
import { BUILTIN_IDS, normalizeMode } from './modes'
import { encryptSettings, decryptSettings } from './secrets'
import { PROVIDER_META } from './provider-meta'
import { DEFAULT_THEME } from './themes'
import { normalizeUsageEntry, normalizeUsageModel } from './usage'
import type { ChatDropPos, ChatSplitDir, ChatTreeNode } from './chatTree'
import { appendChat, bestSplitDir, buildFromList, CHAT_WINDOW_MAX, collectChatIds, containsChat, dropOnto, dropOntoRoot, leafCount, loadChatTree, normalizeTree, openBeside, persistChatTree, removeChat, resizePair, setChatSize, setNodeSize, setRootDir, sizesByChat, swapChats, toggleFullscreenId } from './chatTree'

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Cap on persisted `compacted` summary messages kept per chat (newest kept).
 *  Compacted messages are excluded from the history sent to the model
 *  (`!m.compacted` in Chat.tsx), so beyond the newest few they are dead weight
 *  in renderer memory and in every persisted snapshot. Active history (the
 *  messages actually sent to the agent) is never touched by this cap. */
export const MAX_COMPACTED_PER_CHAT = 50

/** Drop the OLDEST compacted messages beyond the cap (pure, for test).
 *  Returns the input array unchanged when the cap is not exceeded. */
export function capCompactedMessages(messages: ChatMessage[]): ChatMessage[] {
  let overflow = 0
  for (const m of messages) if (m.compacted) overflow++
  if (overflow <= MAX_COMPACTED_PER_CHAT) return messages
  overflow -= MAX_COMPACTED_PER_CHAT
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.compacted && overflow > 0) {
      overflow--
      continue
    }
    out.push(m)
  }
  return out
}

// Persian label for live LSP install/update progress. Shown in the
// thinking/working row with a loading state so a pause reads as waiting.
// Returns null when nothing should render (no status or terminal phase).
// Pure for test.
export function lspStatusLabel(status: LspStatus | null | undefined): string | null {
  if (!status) return null
  if (status.phase === 'done' || status.phase === 'error') return null
  const lang = (status.language ?? '').trim()
  const suffix = lang ? ` ${lang}` : ''
  if (status.phase === 'updating') return `در حال آپدیت LSP${suffix}...`
  return `در حال نصب LSP${suffix}...`
}

// Normalize a backend status/tool event into LspStatus. Accepts the
// {kind:"status",stage:"lsp"} shape and lsp_* tool activity with an
// installing/updating summary. Returns null when the event is not LSP
// progress. Pure for test.
export function lspStatusFromEvent(ev: {
  stage?: string
  tool?: string
  status?: string
  summary?: string
  content?: string
  language?: string
}): LspStatus | null {
  const stage = (ev.stage ?? '').trim().toLowerCase()
  const tool = (ev.tool ?? '').trim().toLowerCase()
  const isLsp = stage === 'lsp' || tool === 'lsp' || tool.startsWith('lsp_')
  if (!isLsp) return null
  const text = `${ev.summary ?? ''} ${ev.content ?? ''} ${ev.status ?? ''}`.toLowerCase()
  const updating = text.includes('updat') || text.includes('آپدیت') || text.includes('به‌روزرسانی') || text.includes('بروز')
  const done = text.includes('done') || text.includes('complete') || ev.status === 'done'
  const failed = text.includes('fail') || text.includes('error') || ev.status === 'error'
  if (failed) return { phase: 'error', language: ev.language }
  if (done) return { phase: 'done', language: ev.language }
  return { phase: updating ? 'updating' : 'installing', language: ev.language }
}

// Strip transient, in-memory-only fields from messages AND chats before
// persisting so they never reappear after a restart (e.g. the rate-limit retry
// banner, or a stale ask/permission popup whose agent is long gone).
// Chats with zero messages are dropped entirely: a fresh "new chat" tab only
// becomes real (sidebar row + file on disk) once the first message is sent.
export function sanitizeChats(chats: Chat[]): Chat[] {
  return chats.filter((c) => (c.messages?.length ?? 0) > 0).map((c) => {
    const clean = { ...c }
    delete clean.pendingAsk
    delete clean.pendingPermission
    return {
      ...clean,
      messages: capCompactedMessages(c.messages.map((m) => {
        const msg = { ...m } as Record<string, unknown>
        delete msg.retry
        // A message persisted mid-stream (heartbeat snapshot) is marked so the
        // UI can show it as "interrupted" after a crash/power cut instead of
        // looking like a complete reply. The final write once the turn ends
        // (streaming=false) clears the flag naturally.
        if (msg.streaming) msg.interrupted = true
        delete msg.streaming
        delete msg.thinking
        delete msg.lspStatus
        // Keep toolActivity (trimmed) so tool cards survive a restart — it was
        // previously stripped as transient, which is why tool calls vanished
        // after any reload, not just after a power cut.
        if (Array.isArray(msg.toolActivity)) {
          msg.toolActivity = trimToolActivity(msg.toolActivity as ToolActivity[])
        }
        // Cap base64 image payloads on the persisted copy only (see
        // MAX_PERSIST_IMAGE_CHARS): keeps chat JSON + heartbeat IPC small.
        if (Array.isArray(msg.images)) {
          msg.images = (msg.images as unknown[]).map(trimPersistImageValue) as ChatMessage['images']
        }
        return msg as unknown as ChatMessage
      })),
    }
  })
}

// ── Mid-stream persistence (heartbeat) ────────────────────────────────────────
// While a reply is streaming, the store defers full writes (see persist()) so
// per-token updates don't hammer the DB. But that alone means a power cut loses
// the ENTIRE in-flight turn — it never reached disk. The heartbeat below writes
// a throttled chats-only snapshot at most once every MID_STREAM_MS while a run
// is active, so a crash loses at most the last ~2s instead of the whole turn.
const MID_STREAM_MS = 2000
let lastMidStreamPersist = 0

// Bounds on persisted toolActivity so the chat JSON (and every heartbeat IPC
// payload) stays small even for tool calls with huge args/diffs/results.
const MAX_TOOL_TEXT = 4000 // summary / diff
const MAX_TOOL_ARG = 2000 // per string value inside args

// Cap on persisted base64 image payloads so one pasted screenshot (often
// 1-5MB as data:image/...;base64) doesn't bloat every chats snapshot +
// heartbeat IPC payload. Only applies to the persisted copy in sanitizeChats;
// in-memory messages keep the full data URL for render + model context.
const MAX_PERSIST_IMAGE_CHARS = 100_000
function trimPersistImageValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v.length > MAX_PERSIST_IMAGE_CHARS && v.slice(0, 80).includes('base64')) {
      return v.slice(0, MAX_PERSIST_IMAGE_CHARS) + '…'
    }
    return v
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['data', 'dataUrl', 'url', 'content'] as const) {
      const s = o[k]
      if (typeof s === 'string' && s.length > MAX_PERSIST_IMAGE_CHARS && (s.startsWith('data:') || s.slice(0, 80).includes('base64'))) {
        return { ...o, [k]: s.slice(0, MAX_PERSIST_IMAGE_CHARS) + '…' }
      }
    }
  }
  return v
}

/** Validate a base64 image data URL, returning a clean version or null.
 *  Drops truncated payloads (persisted snapshots cut with '…'), whitespace,
 *  and non-base64 chars; repairs missing padding. Never throws. */
export function sanitizeImageDataUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s.startsWith('data:')) return null
  if (s.includes('\u2026')) return null
  const comma = s.indexOf(',')
  if (comma < 0) return null
  const head = s.slice(0, comma)
  let payload = s.slice(comma + 1).replace(/\s+/g, '')
  if (!payload) return null
  if (!/;base64/i.test(head)) {
    return head.startsWith('data:image/') ? null : s
  }
  if (/[^A-Za-z0-9+/=]/.test(payload)) return null
  if (payload.length % 4 === 1) return null
  payload += '='.repeat((4 - (payload.length % 4)) % 4)
  try {
    atob(payload)
  } catch {
    return null
  }
  return `${head},${payload}`
}

function trimToolActivity(acts: ToolActivity[]): ToolActivity[] {
  return acts.map((a) => {
    const out: ToolActivity = { ...a }
    if (typeof out.summary === 'string' && out.summary.length > MAX_TOOL_TEXT) {
      out.summary = out.summary.slice(0, MAX_TOOL_TEXT) + '…'
    }
    if (typeof out.diff === 'string' && out.diff.length > MAX_TOOL_TEXT) {
      out.diff = out.diff.slice(0, MAX_TOOL_TEXT) + '…'
    }
    if (out.args && typeof out.args === 'object') {
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(out.args)) {
        args[k] = typeof v === 'string' && v.length > MAX_TOOL_ARG ? v.slice(0, MAX_TOOL_ARG) + '…' : v
      }
      out.args = args
    }
    // NOTE: `items` (the full tool result) is intentionally NOT truncated here.
    // It is the actual context the model receives (rebuilt into ToolMessages on
    // the backend), so trimming it would silently shrink the context sent to the
    // provider. We keep `summary`/`diff`/`args` trimming for file-size sanity,
    // but the verbatim result must stay complete so "all messages up to the last
    // compact" are truly sent. This is the user's explicit "send full context".
    if (Array.isArray(out.children)) out.children = trimToolActivity(out.children)
    return out
  })
}

/** Display labels for the built-in modes (used in the mode-switch history note). */
const MODE_LABELS: Record<string, string> = { ask: 'Ask', plan: 'Plan', build: 'Build' }

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
  if ('codewriter' in out && !('build' in out)) {
    out.build = out.codewriter
    delete out.codewriter
  }
  // Legacy "coder" key is dropped outright (not mapped to build).
  if ('coder' in out) {
    delete out.coder
  }
  return out
}

let persistTimer: ReturnType<typeof setTimeout> | undefined
// Debounce window for the main `persist` path. Kept short (100ms) so a
// user-initiated setting change in Settings → Storage lands on disk before
// the user can reach the quit menu / Cmd-Q — the 500ms we used previously
// was wide enough that rapid edits + an immediate quit could drop the last
// value on the floor (the IPC handler for `flush-persist` still does the
// authoritative sync flush, but the sooner `storeSet('settings', ...)` is
// called, the less work the flush has to recover from).
// Coerce a value from a (possibly stringified) settings.json field to a
// positive integer, falling back to `fallback` when nothing usable is on disk.
// Settings fields may round-trip through JSON safely, but the IPC layer or
// an older settings file can hand us string-shaped digits ("30") or null.
// Accept anything that coerces to a valid value rather than silently
// falling back to the default — the user did set it, so don't erase it.
function coercePositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v as number)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}
function coerceNonNegInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v as number)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}
function coerceBoundedInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v as number)
  if (!Number.isFinite(n)) return fallback
  const r = Math.round(n)
  return Math.max(min, Math.min(max, r))
}

/** Normalize a persisted STT fallback list: keep rows with a provider id, trim model. */
function normalizeSttFallbacks(raw: unknown): SttFallback[] {
  if (!Array.isArray(raw)) return []
  const out: SttFallback[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const rec = r as Record<string, unknown>
    const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : ''
    if (!providerId) continue
    const model = typeof rec.model === 'string' ? rec.model.trim() : ''
    out.push({ providerId, model })
  }
  return out
}

/** Normalize a persisted TTS fallback list: keep rows with a provider id, trim model/voice. */
function normalizeTtsFallbacks(raw: unknown): TtsFallback[] {
  if (!Array.isArray(raw)) return []
  const out: TtsFallback[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const rec = r as Record<string, unknown>
    const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : ''
    if (!providerId) continue
    const model = typeof rec.model === 'string' ? rec.model.trim() : ''
    const voice = typeof rec.voice === 'string' ? rec.voice.trim() : ''
    out.push({ providerId, model, voice })
  }
  return out
}

const PERSIST_DEBOUNCE_MS = 100
function persistSoon(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => useStore.getState().persist(), PERSIST_DEBOUNCE_MS)
}

const OPEN_CHATS_KEY = 'coder:openChats'
const ACTIVE_CHAT_KEY = 'coder:activeChat'

function persistOpenChats(ids: string[]): void {
  try {
    localStorage.setItem(OPEN_CHATS_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable */
  }
}

function loadOpenChats(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_CHATS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
  } catch {
    return []
  }
}

function persistActiveChat(id: string): void {
  try {
    if (id) localStorage.setItem(ACTIVE_CHAT_KEY, id)
    else localStorage.removeItem(ACTIVE_CHAT_KEY)
  } catch {
    /* storage unavailable */
  }
}

function loadActiveChat(): string {
  try {
    const raw = localStorage.getItem(ACTIVE_CHAT_KEY)
    return typeof raw === 'string' ? raw : ''
  } catch {
    return ''
  }
}

function persistOpenState(ids: string[], activeId: string): void {
  persistOpenChats(ids)
  persistActiveChat(activeId)
}

const VISIBLE_CHATS_KEY = 'coder:visibleChats'
const WINDOW_SIZES_KEY = 'coder:chatWindowSizes'

function loadVisibleChats(): string[] {
  try {
    const raw = localStorage.getItem(VISIBLE_CHATS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
  } catch {
    return []
  }
}

function persistVisibleChats(ids: string[]): void {
  try {
    localStorage.setItem(VISIBLE_CHATS_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable */
  }
}

function loadWindowSizes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WINDOW_SIZES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (k && Number.isFinite(n) && n > 0.1 && n < 10) out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

function persistWindowSizes(sizes: Record<string, number>): void {
  try {
    localStorage.setItem(WINDOW_SIZES_KEY, JSON.stringify(sizes))
  } catch {
    /* storage unavailable */
  }
}

/** Split orientation of the multi-window chat group. Pure for test. */
export type ChatLayout = 'vertical' | 'horizontal'

export function normalizeChatLayout(v: unknown): ChatLayout {
  return v === 'horizontal' ? 'horizontal' : 'vertical'
}

const CHAT_LAYOUT_KEY = 'coder:chatLayout'

function loadChatLayout(): ChatLayout {
  try {
    return normalizeChatLayout(localStorage.getItem(CHAT_LAYOUT_KEY))
  } catch {
    return 'vertical'
  }
}

function persistChatLayout(layout: ChatLayout): void {
  try {
    localStorage.setItem(CHAT_LAYOUT_KEY, layout)
  } catch {
    /* storage unavailable */
  }
}

/** Normalize a visible-window list against valid chat ids (pure, for test).
 *  Keeps order, drops unknown ids, dedupes. Falls back to [activeId] when
 *  empty but a valid active exists, otherwise to the first valid id. */
export function normalizeVisibleChats(visible: string[], validIds: Set<string>, activeId: string): string[] {
  const out: string[] = []
  for (const id of visible) {
    if (validIds.has(id) && !out.includes(id)) out.push(id)
  }
  if (out.length === 0) {
    if (activeId && validIds.has(activeId)) return [activeId]
    const first = [...validIds][0]
    return first ? [first] : []
  }
  return out
}

function treeDirFromLayout(layout: ChatLayout): ChatSplitDir {
  return layout === 'horizontal' ? 'row' : 'col'
}

/** Best direction for a newly opened window from the chat area aspect.
 *  Wide area splits side-by-side (row), tall area stacks (col); falls back
 *  to the saved layout when the DOM is unavailable (tests/SSR). */
function smartAppendDir(fallback: ChatLayout): ChatSplitDir {
  try {
    if (typeof document !== 'undefined') {
      const rect = document.querySelector('[data-testid="chat-windows"]')?.getBoundingClientRect()
      if (rect && rect.width > 0 && rect.height > 0) return bestSplitDir(rect.width, rect.height)
    }
    if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerHeight > 0) {
      return bestSplitDir(Math.max(1, window.innerWidth - 320), window.innerHeight)
    }
  } catch {
    /* fall through to layout */
  }
  return treeDirFromLayout(fallback)
}

/** Explicit opens never replace: hidden chats open beside focus. */

/** Persist a split tree plus its legacy mirrors (visible ids, sizes, layout). */
function persistTreeMirrors(tree: ChatTreeNode | null, fallbackLayout: ChatLayout): { visibleChatIds: string[]; chatWindowSizes: Record<string, number>; chatLayout: ChatLayout } {
  persistChatTree(tree)
  if (!tree) return { visibleChatIds: [], chatWindowSizes: {}, chatLayout: fallbackLayout }
  const visibleChatIds = collectChatIds(tree)
  const chatWindowSizes = sizesByChat(tree)
  const chatLayout: ChatLayout = tree.kind === 'split' ? (tree.dir === 'row' ? 'horizontal' : 'vertical') : fallbackLayout
  persistVisibleChats(visibleChatIds)
  persistWindowSizes(chatWindowSizes)
  persistChatLayout(chatLayout)
  return { visibleChatIds, chatWindowSizes, chatLayout }
}

/** Ensure a tree exists from a flat visible list (migration / first split). */
function ensureTree(tree: ChatTreeNode | null, visible: string[], layout: ChatLayout): ChatTreeNode | null {
  if (tree && leafCount(tree) > 0) return tree
  return buildFromList(visible, treeDirFromLayout(layout))
}

const CHAT_FULL_KEY = 'coder:chatFull'

function loadChatFullscreen(): boolean {
  try {
    return localStorage.getItem(CHAT_FULL_KEY) === '1'
  } catch {
    return false
  }
}

function persistChatFullscreen(v: boolean): void {
  try {
    localStorage.setItem(CHAT_FULL_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

const WINDOW_FULL_KEY = 'coder:windowFullscreen'

function loadWindowFullscreen(): string | null {
  try {
    const v = localStorage.getItem(WINDOW_FULL_KEY)
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

function persistWindowFullscreen(id: string | null): void {
  try {
    if (id) localStorage.setItem(WINDOW_FULL_KEY, id)
    else localStorage.removeItem(WINDOW_FULL_KEY)
  } catch {
    /* storage unavailable */
  }
}

// Bottom terminal panel visibility (Cmd/Ctrl+J). Session-level UI state like
// chatFullscreen — localStorage instead of the settings payload so the
// backend's default-skeleton detection stays untouched.
const TERMINAL_PANEL_KEY = 'coder:terminalPanel'

function loadTerminalPanel(): boolean {
  try {
    return localStorage.getItem(TERMINAL_PANEL_KEY) === '1'
  } catch {
    return false
  }
}

function persistTerminalPanel(v: boolean): void {
  try {
    localStorage.setItem(TERMINAL_PANEL_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

const TERMINAL_FULL_KEY = 'coder:terminalFullscreen'

function loadTerminalFullscreen(): boolean {
  try {
    return localStorage.getItem(TERMINAL_FULL_KEY) === '1'
  } catch {
    return false
  }
}

function persistTerminalFullscreen(v: boolean): void {
  try {
    localStorage.setItem(TERMINAL_FULL_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

// Lightweight debounced write for panel visibility toggles (sidebar / right
// panel). A toggle must feel instant: it only flips a boolean in
// memory and schedules a settings-only write in the background — never the
// heavy full snapshot (sanitizeChats over every message + AES encryption +
// chats IPC) on the keydown path. Chats are untouched by a toggle, so there
// is nothing to lose by skipping them here; the next full persist (or the
// quit flush below) still includes the latest panel flags.
let panelPersistTimer: ReturnType<typeof setTimeout> | undefined
function persistPanelsSoon(): void {
  clearTimeout(panelPersistTimer)
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = undefined
    void writeSettingsNow(useStore.getState())
  }, PERSIST_DEBOUNCE_MS)
}

// Chats-only snapshot for the mid-stream heartbeat: skips settings entirely so
// the (async, AES) settings encryption is never re-run every 2s during a run.
// Persists only the running chat(s) — never the whole list — so a 2s tick does
// not deep-copy every message + tool result of idle chats in the renderer and
// the main process. The backend upserts chat files, so a subset write is safe;
// the next full persist rewrites everything.
function writeChatsNow(s: ReturnType<typeof useStore.getState>): void {
  const streaming = s.chats.filter((c) => c.messages.some((m) => m.streaming))
  const subset = streaming.length > 0 ? streaming : s.chats.filter((c) => c.id === s.activeChatId)
  if (subset.length === 0) return
  void api.storeSet('chats', sanitizeChats(subset))
}

// Settings-only snapshot for panel toggles: skips the chats sanitize + write
// entirely so toggling the sidebar / right panel never walks every message.
// Shares the persistSeq guard with writeStateNow so a stale snapshot can
// never overtake a newer full write.
function writeSettingsNow(s: ReturnType<typeof useStore.getState>): Promise<unknown> {
  if (!s.settingsHydrated) return Promise.resolve()
  const seq = ++persistSeq
  return (async () => {
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } as Settings)
    if (seq !== persistSeq) return
    await api.storeSet('settings', payload)
  })()
}

// Called from updateMessage on every SSE token. While streaming, only a cheap
// Date.now() check runs per token; the actual write happens at most once per
// MID_STREAM_MS. When not streaming, falls back to the normal debounced persist.
function maybePersistMidStream(): void {
  if (useStore.getState().anyStreaming()) {
    const now = Date.now()
    if (now - lastMidStreamPersist >= MID_STREAM_MS) {
      lastMidStreamPersist = now
      writeChatsNow(useStore.getState())
    }
  } else {
    persistSoon()
  }
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
  if (panelPersistTimer) {
    clearTimeout(panelPersistTimer)
    panelPersistTimer = undefined
  }
  // Mounted chat panels keep their scroll position in a ref (not the store) so
  // scrolling never re-renders the transcript. Before ANY flush — including the
  // main process's `flush-persist` on quit, which runs before the renderer's
  // `beforeunload` — ask them to push the latest position into the store so the
  // snapshot below includes it. The Sidebar also flushes its localStorage UI
  // state here, so a toggle/resize made right before quitting is never lost to
  // the debounce.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('coder:flush-ui'))
  }
  return writeStateNow(useStore.getState())
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    // Best-effort fallback for teardown that bypasses the main process (e.g. a
    // renderer crash). The reliable path is the `flush-persist` ACK below; here
    // we only make sure an error is never silently swallowed.
    flushPendingPersist().catch((err) => console.error('state flush on unload failed:', err))
  })
  window.addEventListener('pagehide', () => {
    flushPendingPersist().catch((err) => console.error('state flush on pagehide failed:', err))
  })
  // The main process asks the renderer to flush right before quitting, then
  // waits for this ACK before flushing its own queue — closing the race where
  // a write (e.g. a subagent model picked while streaming) arrived after the
  // main flush had already run and was silently dropped.
  api.onFlushPersist(() => {
    Promise.resolve()
      .then(() => flushPendingPersist())
      .catch((err) => console.error('state flush on quit failed:', err))
      .finally(() => {
        try {
          api.flushPersistDone()
        } catch (e) {
          console.error('flushPersistDone failed:', e)
        }
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
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s
  const seq = ++persistSeq
  const writes: Promise<unknown>[] = [
    (async () => {
      if (seq !== persistSeq) return
      await api.storeSet('chats', sanitizeChats(chats))
    })(),
  ]
  // Skip persisting settings while the store still holds cold-start defaults
  // (sidecar returned null on load, e.g. an external data volume that mounted
  // late). Writing defaults here is exactly what clobbered the real
  // settings.json on restart. Chats are safe to write regardless.
  if (s.settingsHydrated) {
    // Encrypt API keys / OAuth secrets before they reach settings.json on disk.
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } as Settings)
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

export const PROVIDER_NAMES: Record<ProviderKind, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.name]),
) as Record<ProviderKind, string>

export function providerApiKeys(p: Pick<ProviderConfig, 'apiKeys'> & { apiKey?: string }): string[] {
  const raw = Array.isArray(p.apiKeys) ? p.apiKeys : []
  const out = raw.map((k) => (typeof k === 'string' ? k : '')).filter((k) => k.trim() !== '')
  if (out.length === 0 && typeof p.apiKey === 'string' && p.apiKey.trim() !== '') out.push(p.apiKey)
  return out
}

function defaultProviders(): ProviderConfig[] {
  const row = (id: ProviderKind, extra: Partial<ProviderConfig> = {}): ProviderConfig => {
    const meta = PROVIDER_META[id]
    return {
      id: id === 'ollama' ? 'local' : id,
      name: meta.name,
      kind: id,
      apiKeys: [],
      baseUrl: meta.defaultBaseUrl ?? '',
      model: '',
      ...extra,
    }
  }
  return [
    row('openrouter'),
    row('ollama'),
    row('google'),
    row('nvidia'),
    row('cloudflare'),
    row('tokenrouter'),
  ]
}

function normalizeProvider(p: ProviderConfig): ProviderConfig {
  // 'opencode' rows from older builds: the kind no longer exists — keep the
  // row alive as a custom provider (id, baseUrl unchanged) so saved
  // chats and the active-provider pointer keep resolving.
  const rawKind = (p.kind || '') as string
  const kind: ProviderKind = rawKind === 'opencode' ? 'custom' : p.kind || 'custom'
  const meta = PROVIDER_META[kind]
  const raw = p as unknown as Record<string, unknown>
  const keys: string[] = []
  if (Array.isArray(raw.apiKeys)) {
    for (const k of raw.apiKeys) if (typeof k === 'string' && k.trim() !== '') keys.push(k)
  }
  if (keys.length === 0 && typeof raw.apiKey === 'string' && (raw.apiKey as string).trim() !== '') {
    keys.push((raw.apiKey as string))
  }
  return {
    // The local llama.cpp provider's id was historically 'ollama'; keep it
    // stable by migrating any legacy rows to the canonical 'local' id.
    id: p.id === 'ollama' ? 'local' : p.id || 'custom',
    name: p.name || PROVIDER_NAMES[kind] || 'Custom API',
    kind,
    apiKeys: keys,
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl: p.baseUrl || meta?.defaultBaseUrl || '',
    model: p.model || '',
    contextMap: p.contextMap,
    manualContextMap: p.manualContextMap,
    manualReasoningMap: p.manualReasoningMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
    thinkingLevel: p.thinkingLevel ?? '',
    models: Array.isArray(p.models) ? p.models : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : [],
    addedModels: Array.isArray(p.addedModels) ? p.addedModels : [],
  }
}



/** سقف مدل‌های پین‌شده در لیست اخیر — پین‌شده‌ها همیشه بالای لیست‌اند و از حذف خودکار مصون‌اند. */
export const MAX_PINNED_RECENT_MODELS = 3

/** مرتب‌سازی لیست اخیر: پین‌شده‌ها اول (تازه‌ترین اول)، بعد بقیه (تازه‌ترین اول). */
export function sortRecentModels(list: RecentModel[]): RecentModel[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
  })
}

/** Accept both the current {providerId, model} shape and legacy bare strings. */
function normalizeRecentModels(raw: unknown): RecentModel[] {
  if (!Array.isArray(raw)) return []
  const out: RecentModel[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ providerId: '', model: entry.trim(), lastUsed: Date.now() })
    } else if (entry && typeof entry === 'object') {
      const e = entry as { providerId?: unknown; model?: unknown; lastUsed?: unknown; pinned?: unknown }
      const model = typeof e.model === 'string' ? e.model.trim() : ''
      const pid = typeof e.providerId === 'string' ? e.providerId : ''
      const lastUsed = typeof e.lastUsed === 'number' ? e.lastUsed : Date.now()
      const pinned = e.pinned === true
      if (model) out.push({ providerId: pid === 'ollama' ? 'local' : pid, model, lastUsed, ...(pinned ? { pinned: true as const } : {}) })
    }
  }
  // پین‌شده‌ها اول؛ سقف پین روی داده قدیمی هم اعمال می‌شود (۳ تای تازه‌تر می‌مانند).
  const ordered = sortRecentModels(out)
  const pinned = ordered.filter((r) => r.pinned).slice(0, MAX_PINNED_RECENT_MODELS)
  const pinnedKeys = new Set(pinned.map((r) => `${r.providerId}/${r.model}`))
  for (const r of ordered) {
    if (r.pinned && !pinnedKeys.has(`${r.providerId}/${r.model}`)) delete r.pinned
  }
  // Sort by lastUsed descending (most recent first) and limit to 20
  return [...pinned, ...ordered.filter((r) => !r.pinned)].slice(0, 20)
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
  theme: string
  dir: 'rtl' | 'ltr'
  recentModels: RecentModel[]
  sidebarOpen: boolean
  /** Docked right panel (todos + future sections) — persisted like sidebarOpen. */
  rightPanelOpen: boolean
  /** Bottom terminal panel (Cmd/Ctrl+J). Persisted in localStorage like
   *  chatFullscreen, NOT in the settings payload. Sessions survive hiding. */
  terminalPanelOpen: boolean
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
  /** VSCode-style open chat tabs (editor group left). Subset of chat ids in
   *  open order. Closing a tab does NOT delete the chat (sidebar keeps it).
   *  Persisted in localStorage `coder:openChats` so tabs restore on restart. */
  openChatIds: string[]
  /** Visible chat windows in split order (multi-window). Single
   *  window = [activeChatId]. Persisted in localStorage `coder:visibleChats`. */
  visibleChatIds: string[]
  /** Relative flex size per visible window (default 1). Persisted in
   *  localStorage `coder:chatWindowSizes`. */
  chatWindowSizes: Record<string, number>
  /** Split orientation of the chat group (VSCode-like). Vertical stacks
   *  windows top-to-bottom, horizontal places them side-by-side.
   *  Persisted in localStorage `coder:chatLayout`. */
  chatLayout: ChatLayout
  /** VSCode-like split tree for chat windows. Null = single focused chat.
   *  Persisted in localStorage `coder:chatTree`; visibleChatIds /
   *  chatWindowSizes / chatLayout mirror it for legacy readers. */
  chatTree: ChatTreeNode | null
  /** Chat ids whose agent FINISHED a turn (sent a message) while the user was
   *  looking at another chat → steady green dot in the sidebar. Session-scoped
   *  (not persisted); cleared when the user opens the chat (setActiveChat). */
  unreadChats: string[]
  settingsOpen: boolean
  isStreaming: boolean
  isThinking: boolean
  /** Session-scoped "allow outside-workspace" (reset when the root changes). */
  outsideAllowed: boolean
  /** Session-scoped outside-workspace folders approved per-folder ("Always
   *  allow" on the per-folder permission dialog). Reset when the root changes,
   *  same lifecycle as outsideAllowed. */
  outsideFolders: string[]
  /** Persisted "desktop control enabled" hard switch (Settings → Tools →
   *  Computer use). Like an MCP connector: when OFF the `computer` tool is
   *  never bound — the agent cannot touch the desktop at all, even if the
   *  prompt asks for it. When ON, per-action runtime permission prompting
   *  still applies until "Always allow". */
  computerUse: boolean
  /** Global "Ctrl+X prefix armed" hint. The prefix is app-wide (managed in
   *  App.tsx), so this lives at the store root, not per-chat. */
  prefixNotice: string | null

  load: () => Promise<void>
  persist: () => void
  /** Force an immediate full-state write to the sidecar (clears any pending
   *  debounced persist). Used on app close so a scroll position / UI state
   *  updated right before quitting is never lost to a timer. */
  flushNow: () => void

  setProviderConfig: (patch: Partial<ProviderConfig>) => void
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void
  addProvider: () => string
  removeProvider: (id: string) => void
  setActiveProvider: (id: string) => void
  setProviderModels: (id: string, models: string[]) => void
  /** افزودن دستی یک مدل به پروایدر (در addedModels ثبت می‌شود تا فچ‌ها حذفش نکنند). */
  addManualModel: (id: string, model: string, contextTokens?: number) => void
  setManualModelContext: (id: string, model: string, contextTokens: number | null) => void
  setManualModelReasoning: (id: string, model: string, reasoning: boolean | null) => void
  removeManualModel: (id: string, model: string) => void
  setProviderContextMap: (id: string, contextMap: Record<string, number>) => void
  setProviderPricingMap: (id: string, pricingMap: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>) => void
  setProviderReasoningMap: (id: string, reasoningMap: Record<string, boolean>) => void
  healStaleModels: (providerId: string, validModels: string[]) => void
  setMcpServers: (mcpServers: Record<string, McpServerConfig>) => void
  addMcpServer: (name: string, cfg: McpServerConfig) => void
  updateMcpServer: (name: string, cfg: McpServerConfig) => void
  removeMcpServer: (name: string) => void
  setMcpEnabled: (name: string, on: boolean) => void
  setSystemPrompt: (mode: AgentMode, text: string) => void
  /** Auto-compaction threshold as a percentage of the raw context window. */
  setCompactAtPercent: (percent: number) => void
  /** Remove a mode (and its custom system prompt); used to purge legacy custom modes. */
  removeMode: (id: AgentMode) => void
  setRecentModels: (recentModels: RecentModel[]) => void
  addRecentModel: (model: string, providerId?: string) => void
  /** حذف دستی یک مدل از لیست اخیر (حتی پین‌شده) — پین‌شده‌ها فقط از حذف خودکار مصون‌اند. */
  removeRecentModel: (model: string, providerId?: string) => void
  /** پین/آنپین یک مدل اخیر؛ سقف ۳ پین. وقتی سقف پر است پین جدید انجام نمی‌شود و false برمی‌گردد. */
  togglePinRecentModel: (model: string, providerId?: string) => boolean
  setRoot: (root: string) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setRightPanelOpen: (open: boolean) => void
  toggleRightPanel: () => void
  setTerminalPanelOpen: (open: boolean) => void
  toggleTerminalPanel: () => void
  /** Terminal fullscreen (Ctrl+M while the terminal has focus). Persisted in
   *  localStorage like terminalPanelOpen. */
  terminalFullscreen: boolean
  setTerminalFullscreen: (v: boolean) => void
  toggleTerminalFullscreen: () => void
  setTheme: (theme: string) => void
  setDir: (dir: 'rtl' | 'ltr') => void
  toggleDir: () => void
  fontSize: number
  setFontSize: (n: number) => void
  /** Directory for the per-workspace RAG vector store; "" = default. */
  vectorDbPath: string
  setVectorDbPath: (p: string) => void
  /** How many top web_search results are auto-fetched for real page content (0 = off, snippet-only). */
  webSearchAutoFetch: number
  setWebSearchAutoFetch: (n: number) => void
  /** TTL for web/fetch text cache + RAG storage (days). */
  ragWebTtlDays: number
  setRagWebTtlDays: (d: number) => void
  /** User-level data root (skills/plans/mcp + vector stores). */
  dataPath: string
  setDataPath: (p: string) => void
  /** On-device model preferences (Settings → Models). */
  whisperModel: string
  whisperBaseUrl: string
  /** STT source: 'local' = on-device Whisper, otherwise a settings.providers id. */
  sttProviderId: string
  /** Remote STT model id sent to {base_url}/audio/transcriptions. */
  sttModel: string
  /** Ordered STT fallback targets, tried after the primary STT source fails. */
  sttFallbacks: SttFallback[]
  /** TTS source: a settings.providers id (remote OpenAI-compatible /audio/speech). */
  ttsProviderId: string
  /** Remote TTS model id sent to {base_url}/audio/speech. */
  ttsModel: string
  /** Remote TTS voice id sent to {base_url}/audio/speech. */
  ttsVoice: string
  /** Ordered TTS fallback targets, tried after the primary TTS source fails. */
  ttsFallbacks: TtsFallback[]
  embeddingModel: string
  embeddingBaseUrl: string
  setWhisperModel: (m: string) => void
  setWhisperBaseUrl: (u: string) => void
  setSttProviderId: (id: string) => void
  setSttModel: (m: string) => void
  setSttFallbacks: (f: SttFallback[]) => void
  setTtsProviderId: (id: string) => void
  setTtsModel: (m: string) => void
  setTtsVoice: (v: string) => void
  setTtsFallbacks: (f: TtsFallback[]) => void
  setEmbeddingModel: (m: string) => void
  setEmbeddingBaseUrl: (u: string) => void
  /** Per-subagent model overrides: explore / vision / compact. */
  subagentModels: Record<string, string>
  setSubagentModel: (agent: string, model: string) => void
  /** Tool result cache TTL (minutes). */
  cacheTtlMinutes: number
  setMemoryTtlConfig: (c: { cache?: number }) => void
  /** History turn limit sent to the model. 0 = full history (default). */
  historyLimit: number
  setHistoryLimit: (n: number) => void

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
  renameWorkspace: (key: string, label: string) => void
  /** تغییر مسیر (root) یک ورک‌اسپیس: کلید جدید از مسیر جدید ساخته می‌شود و
   *  همه چت‌ها، پین و رنگ به کلید جدید منتقل می‌شوند. کلید جدید را برمی‌گرداند. */
  moveWorkspace: (key: string, root: string) => string
  togglePinWorkspace: (key: string) => void
  togglePinChat: (id: string) => void
  setActiveChat: (id: string) => void
  /** Open a chat tab (VSCode-style). Adds to openChatIds if missing and activates. */
  openChat: (id: string) => void
  /** Close a chat tab without deleting the chat data (sidebar keeps it). */
  closeChatTab: (id: string) => void
  /** Bulk-close tabs that are not active, not streaming and not open in a
   *  multi-window pane. Chats stay in the sidebar. Returns the closed ids. */
  closeInactiveChatTabs: () => string[]
  /** Recently closed chat tabs (newest first, capped) for the tab-list
   *  menu's "Recently closed" section. In-memory only. */
  recentlyClosedChatTabs: { id: string; at: number }[]
  /** Reopen a closed chat tab: activates the chat and re-opens its tab. */
  reopenChatTab: (id: string) => void
  /** VSCode-style drag reorder: move the dragged chat tab to the drop position. */
  moveChatTab: (fromId: string, toId: string, after?: boolean) => void
  /** Show a chat as a stacked window (adds to visibleChatIds + focuses). */
  openInWindow: (id: string) => void
  /** Hide a window without deleting the chat (focus moves to neighbor). */
  closeWindow: (id: string) => void
  /** Focus a visible window (sets activeChatId, keeps other windows). */
  focusWindow: (id: string) => void
  /** Reorder stacked windows via header drag. */
  moveWindow: (fromId: string, toId: string, after?: boolean) => void
  /** Relative flex size of a window (resize handle). */
  setWindowSize: (id: string, size: number) => void
  /** Split orientation of the chat group (vertical/horizontal). */
  setChatLayout: (layout: ChatLayout) => void
  /** VSCode-like drop: drag chat onto target leaf edge or center. */
  dropChatOnto: (dragChatId: string, targetChatId: string, pos: ChatDropPos) => void
  /** Root-edge drop: move a chat to the outer edge of the chat area.
   *  The dragged window's own space counts as empty (removed first). */
  dropChatOntoRoot: (dragChatId: string, pos: ChatDropPos) => void
  /** Resize a split-tree node by node id. */
  setTreeNodeSize: (nodeId: string, size: number) => void
  /** Resize two sibling split children atomically. */
  resizeTreePair: (parentId: string, firstId: string, secondId: string, firstSize: number, secondSize: number) => void
  /** Fullscreen toggle for the chat group (viewer group hides). Persisted in
   *  localStorage so the layout survives restarts. */
  chatFullscreen: boolean
  setChatFullscreen: (v: boolean) => void
  toggleChatFullscreen: () => void
  /** Fullscreen chat window inside the chat group (other windows hide, viewer
   *  group stays). Stores the fullscreen chat id, null = off. Persisted. */
  windowFullscreenId: string | null
  setWindowFullscreen: (id: string | null) => void
  toggleWindowFullscreen: (id?: string) => void
  setChatMode: (id: string, mode: AgentMode) => void
  /** Silent mode sync for backend-driven switches (plan approval → build via
   *  the `mode_changed` event): updates chat.mode WITHOUT the "[Mode switched
   *  …]" marker message — the backend already narrates the transition. */
  setChatModeQuiet: (id: string, mode: AgentMode) => void
  /** Persistent goal actions (Codex Goal mode style). Stored on the chat so the
   *  goal survives reload via the existing chats persistence. */
  setGoal: (id: string, condition: string) => void
  clearGoal: (id: string) => void
  pauseGoal: (id: string) => void
  resumeGoal: (id: string) => void
  /** Halt a chat's goal loop after an explicit Stop (Codex-style): keeps the
   *  goal attached for manual sends but blocks auto-continue until Resume. */
  stopGoal: (id: string) => void
  /** Re-arm a stopped goal loop after an explicit user send (not auto-drive). */
  rearmGoal: (id: string) => void
  incrementGoalTurn: (id: string) => void
  setChatRoot: (id: string, root: string) => void
  setChatDraft: (id: string, patch: Partial<ChatDraft>) => void
  setChatThinkingLevel: (id: string, level: ThinkingLevel) => void
  setChatProvider: (id: string, providerId: string, model: string) => void
  renameChat: (id: string, title: string) => void
  /** Create a new chat pre-seeded with one section of a previous answer, so the
   *  user can ask follow-up questions about that section in isolation (reading
   *  mode → "سوال از این بخش"). Inherits the source chat's root/mode/provider. */
  forkSection: (messageId: string, sectionTitle: string, sectionContent: string) => void
  /** Fork a chat from a message: create a new chat with history up to and
   *  including the given message, inheriting root/mode/provider, and switch
   *  to it so the user can continue there. Returns the new chat id. */
  forkChatFromMessage: (messageId: string) => string | null
  /** Transient flag: focus the composer on the next ChatPanel mount (set by
   *  forkSection so the user can immediately type their question). */
  focusComposer: boolean
  setFocusComposer: (v: boolean) => void
  /** Transient compact/command/stall banners, stored per-chat so they survive
   *  the ChatPanel remount on chat switch (same rationale as pendingAsk). */
  setChatCompacting: (id: string, compacting: boolean) => void
  setChatCompactNotice: (id: string, notice: string | null) => void
  setChatCompactError: (id: string, error: string | null) => void
  setChatCmdError: (id: string, error: string | null) => void
  setChatLiveError: (id: string, error: string | null) => void
  setChatTtsError: (id: string, error: string | null) => void
  setChatSkillNotice: (id: string, notice: string | null) => void
  /** Revision counter per ABSOLUTE file path, bumped whenever the agent
   *  writes that file (write_document tool_result / write_file+edit_file
   *  diff events). The file viewer subscribes to its own path's counter and
   *  re-fetches, so document edits show up LIVE while the agent works. */
  docRev: Record<string, number>
  bumpDocRev: (absPath: string) => void
  /** Per-chat scroll restoration anchor (see Chat.scrollPos). */
  setChatScrollPos: (id: string, pos: { id: string; offset: number; atBottom: boolean } | null) => void
  /** In-memory-only scroll anchor update (no persist) — used by the
   *  `coder:flush-ui` handler to push a panel's ref-held position into the
   *  store right before a flush writes the snapshot. */
  setChatScrollPosMem: (id: string, pos: { id: string; offset: number; atBottom: boolean } | null) => void
  /** Set/clear the app-wide Ctrl+X prefix hint. */
  setPrefixNotice: (notice: string | null) => void
  addMessage: (chatId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>) => ChatMessage
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void
  /** Atomically append segments to a message (no lost-update race between
   *  concurrent SSE events). Reads the latest segments INSIDE set(), merges,
   *  and dedupes identical user/compact/tool segments. Returns true when at
   *  least one segment was added. */
  appendMessageSegments: (id: string, segments: MessageSegment[]) => boolean
  /** Remove a message from a chat's thread (e.g. cancelling a pending steer). */
  removeMessage: (chatId: string, id: string) => void
  /** Record a message typed while the chat's agent is already working. */
  queueMessage: (chatId: string, msg: Omit<QueuedMessage, 'createdAt'>) => void
  removeQueuedMessage: (chatId: string, id: string) => void
  clearQueue: (chatId: string) => void
  /** Mark a queued message as consumed (steered into the running agent). */
  markQueuedSent: (chatId: string, id: string) => void
  /** Add a (provider, model) token delta to the chat-wide cumulative usage
   *  (survives compacts, unlike a single message's per-turn usage). The
   *  provider and model are stored EXPLICITLY so the sidebar shows the exact
   *  provider/model with no parsing or guessing. */
  accrueChatUsage: (
    chatId: string,
    providerId: string,
    model: string,
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
    req: { id: string; question: string; options: string[]; style?: string } | null,
  ) => void
  /** Set/clear a chat's pending `permission` request. Same rationale as
   *  `setChatPendingAsk`: stored on the chat so it survives the ChatPanel
   *  remount on chat switch. */
  setChatPendingPermission: (
    chatId: string,
    req: { id: string; action: string; path?: string; reason?: string; scope?: string; folder?: string } | null,
  ) => void
  markToolReverted: (messageId: string, index: number) => void
  truncateTo: (messageId: string) => boolean
  clearChat: (id: string) => void
  compactChat: (id: string, summary: string, keep?: number) => void
  undoMessage: () => boolean
  redoMessage: () => boolean

  setSettingsOpen: (open: boolean) => void
  setStreaming: (active: boolean, thinking: boolean) => void
  /** باز/بسته بودن فرم ساخت تسک زمان‌بندی در پنل راست (session-scoped). */
  scheduleFormOpen: boolean
  setScheduleFormOpen: (open: boolean) => void
  /** کش تسک‌های زمان‌بندی (از GET /schedules؛ session-scoped). */
  schedules: import('../types').ScheduledTask[]
  setSchedules: (schedules: import('../types').ScheduledTask[]) => void
  /** باز/بسته بودن Inbox کرون‌ها (session-scoped). */
  scheduleInboxOpen: boolean
  setScheduleInboxOpen: (open: boolean) => void
  /** تسک انتخاب‌شده داخل Inbox (چت همان کرون)؛ null یعنی هیچ انتخابی. */
  scheduleInboxSelected: string | null
  setScheduleInboxSelected: (id: string | null) => void
  /** شناسه اجراهای دیده‌شده (برای بج نوتیفیکیشن Inbox؛ session-scoped). */
  scheduleRunsSeen: string[]
  markScheduleRunsSeen: (ids: string[]) => void
  setOutsideAllowed: (allowed: boolean) => void
  /** Add a per-folder outside-workspace grant ("Always allow" on the per-folder
   *  permission dialog). Idempotent; session-scoped like outsideAllowed. */
  addOutsideFolder: (folder: string) => void
  setComputerUse: (v: boolean) => void
  /** Whether any chat currently has a streaming assistant message (persist gate
   *  and multi-chat "busy" indication). */
  anyStreaming: () => boolean
  /** Live AbortControllers per chat id (survive chat switches, allow multiple
   *  chats to run concurrently). */
  chatAborts: Record<string, AbortController | null>
  setChatAbort: (chatId: string, abort: AbortController | null) => void
}

/**
 * Drop chats that share an `id`, keeping the LAST occurrence (it carries the
 * most recent data). Two chats with the same `id` would otherwise both render
 * in the sidebar, and because the 3-dot menu is keyed on chat id, opening it
 * for one row would open it for BOTH. The backend already de-duplicates on
 * disk; this is the final defensive guard on the loaded payload.
 */
export function dedupeChats(chats: Chat[]): Chat[] {
  const seen = new Set<string>()
  const out: Chat[] = []
  for (let i = chats.length - 1; i >= 0; i--) {
    const c = chats[i]
    if (!c?.id || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  // Restore original order (first occurrence position of each kept id).
  out.reverse()
  return out
}

/**
 * Decide which chat list wins on `load()` so a transient backend miss never
 * wipes the sidebar ("workspaces show but chats disappear").
 *
 * - `incoming` empty + held chats + missing settings + settings file on disk
 *   = full transient miss → caller keeps everything (`emptyMiss`).
 * - `incoming` empty + held chats (settings arrived or first run has no file)
 *   = partial miss → keep the held chats (`kept`).
 * - Otherwise the fresh payload wins (genuine wipe / fresh profile settles
 *   to empty, normal refresh replaces).
 *
 * Pure for test (no store access).
 */
export function selectLoadedChats(
  prev: Chat[],
  incoming: Chat[] | null | undefined,
  opts: { settingsMissing: boolean; hasSettingsFile: boolean },
): { chats: Chat[]; kept: boolean; emptyMiss: boolean } {
  const fresh = incoming && incoming.length > 0 ? incoming : []
  if (fresh.length === 0 && prev.length > 0) {
    if (opts.settingsMissing && opts.hasSettingsFile) {
      return { chats: prev, kept: true, emptyMiss: true }
    }
    if (!opts.settingsMissing) {
      return { chats: prev, kept: true, emptyMiss: false }
    }
    // Genuine wipe (no settings file on disk at all): settle to empty.
    return { chats: [], kept: false, emptyMiss: false }
  }
  return { chats: fresh, kept: false, emptyMiss: false }
}

function makeChat(mode: AgentMode = 'ask'): Chat {
  const now = Date.now()
  const s = useStore.getState()
  const activeProvider =
    s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
    s.settings.providers[0]
  // Default a new chat to the most recently used model so it continues where the
  // user left off, instead of always falling back to the provider's default model.
  // sortRecentModels mirrors the recent-models list in the model selector
  // (its top entry is exactly the provider+model we want to inherit here).
  const recent = sortRecentModels(s.recentModels)[0]
  const recentProvider = recent
    ? s.settings.providers.find((p) => p.id === recent.providerId)
    : undefined
  const providerId = recentProvider?.id ?? activeProvider?.id
  const model = recentProvider && recent ? recent.model : activeProvider?.model
  // Guard against an (astronomically unlikely) uid() collision: never hand out
  // an id that already exists in the store, so two chats can never share an id
  // and make the 3-dot menu open for both.
  let id = uid()
  while (s.chats.some((c) => c.id === id)) id = uid()
  return {
    id,
    title: 'New chat',
    mode,
    thinkingLevel: 'medium',
    providerId,
    model,
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
  settings: { providers: defaultProviders(), activeProviderId: 'openrouter', systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80 },
  builtinMcp: [],
  root: '',
  theme: DEFAULT_THEME,
  dir: 'rtl',
  fontSize: 14,
  vectorDbPath: '',
  webSearchAutoFetch: 3,
  ragWebTtlDays: 90,
  whisperModel: 'Systran/faster-whisper-medium',
  whisperBaseUrl: '',
  sttProviderId: 'local',
  sttModel: 'whisper-1',
  sttFallbacks: [],
  ttsProviderId: '',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  ttsFallbacks: [],
  embeddingModel: 'intfloat/multilingual-e5-base',
  embeddingBaseUrl: '',
  recentModels: [],
  subagentModels: {},
  cacheTtlMinutes: 60,
  historyLimit: 0,
  searchPlugins: [{ kind: 'duckduckgo', label: 'DuckDuckGo', enabled: true, order: 0 }],
  searchConsole: { clientId: '', clientSecret: '', refreshToken: '', siteUrl: '' },
  sidebarOpen: true,
  rightPanelOpen: false,
  terminalPanelOpen: typeof window !== 'undefined' ? loadTerminalPanel() : false,
  terminalFullscreen: typeof window !== 'undefined' ? loadTerminalFullscreen() : false,
  dataPath: '',
  workspaceColors: {},
  pinnedWorkspaces: [],
  pinnedChats: [],
  workspaces: [],
  chats: [],
  deletedChatIds: [],
  deletedWorkspaceRoots: [],
  activeChatId: typeof window !== 'undefined' ? loadActiveChat() : '',
  openChatIds: typeof window !== 'undefined' ? loadOpenChats() : [],
  visibleChatIds: typeof window !== 'undefined' ? loadVisibleChats() : [],
  chatWindowSizes: typeof window !== 'undefined' ? loadWindowSizes() : {},
  chatLayout: typeof window !== 'undefined' ? loadChatLayout() : 'vertical',
  chatTree: typeof window !== 'undefined' ? loadChatTree() : null,
  recentlyClosedChatTabs: [],
  chatFullscreen: typeof window !== 'undefined' ? loadChatFullscreen() : false,
  windowFullscreenId: typeof window !== 'undefined' ? loadWindowFullscreen() : null,
  focusComposer: false,
  unreadChats: [],
  prefixNotice: null,
  settingsOpen: false,
  scheduleFormOpen: false,
  schedules: [],
  setScheduleFormOpen: (open) => set({ scheduleFormOpen: open }),
  setSchedules: (schedules) => set({ schedules }),
  scheduleInboxOpen: false,
  setScheduleInboxOpen: (open) => set({ scheduleInboxOpen: open }),
  scheduleInboxSelected: null,
  setScheduleInboxSelected: (id) => set({ scheduleInboxSelected: id }),
  scheduleRunsSeen: [],
  markScheduleRunsSeen: (ids) => {
    set((s) => ({ scheduleRunsSeen: [...new Set([...s.scheduleRunsSeen, ...ids])].slice(-MAX_SCHEDULE_RUNS_SEEN) }))
    get().persist()
  },
  isStreaming: false,
  isThinking: false,
  outsideAllowed: false,
  outsideFolders: [],
  computerUse: false,
  chatAborts: {},
  setChatAbort: (chatId, abort) =>
    set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),

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
    // Never downgrade on a transient backend miss: a background refresh (e.g.
    // `sidecar:changed` after a sidecar restart) that observes an empty payload
    // while the store already holds chats must not wipe the sidebar — that is
    // the "workspaces show but chats disappear" bug. A genuine wipe (no
    // settings file on disk) or a fresh profile still settles to empty.
    const prevChats = get().chats
    const picked = selectLoadedChats(prevChats, chats, {
      settingsMissing: settings == null,
      hasSettingsFile,
    })
    if (picked.emptyMiss) {
      set({ loaded: true })
      return
    }
    const keptChats = picked.kept
    const loadedChats0 = picked.chats
    // Drop any duplicate chat ids (last occurrence wins) so two chats sharing an
    // id can never both render — that would make the 3-dot menu open for BOTH
    // rows, since the menu is keyed on chat id. The backend already de-duplicates
    // on disk, but this is the final defensive guard on the loaded payload.
    const dedupedChats = dedupeChats(loadedChats0)
    const providerIds = (settings?.providers ?? []).map((p) => p.id)
    const loadedChats = dedupedChats.map((c) => {
      // Transient compact/command/stall banners must never survive a reload —
      // no request is running after a restart, so a persisted `compacting` or
      // `stalled` would show a stale loading banner forever.
      const clean = { ...c }
      delete clean.compacting
      delete clean.compactNotice
      delete clean.compactError
      delete clean.cmdError
      delete clean.skillNotice
      delete clean.stalled
      // Migrate legacy keyed usage → explicit (providerId, model) entries once,
      // on load. New usage is written directly as entries, so the live path
      // never parses or guesses.
      const migrated = normalizeUsageEntry(
        clean.usage,
        c.providerId ?? settings?.activeProviderId ?? "",
        providerIds,
      )
      const next = migrated ? { ...clean, usage: migrated } : clean
      // Codex-style: a reload never auto-continues a goal loop. Nothing is
      // running after a restart, so park every loaded goal in `stopped` — the
      // user resumes explicitly with the goal bar play button. Prevents the
      // "open window starts working by itself" report.
      if (next.goal?.active && !next.goal.paused) {
        next.goal = { ...next.goal, stopped: true }
      }
      return next.mode ? { ...next, mode: normalizeMode(next.mode) } : next
    }) as Chat[]
    const prevActiveId = get().activeChatId
    const memOpen = get().openChatIds
    const memVisible = get().visibleChatIds ?? []
    const fallbackActive =
      keptChats && prevChats.some((c) => c.id === prevActiveId)
        ? prevActiveId
        : (loadedChats[loadedChats.length - 1]?.id ?? '')
    const validIds = new Set(loadedChats.map((c) => c.id))
    let openChatIds: string[]
    let activeId: string
    let visibleChatIds: string[]
    if (keptChats && memOpen.length > 0) {
      // Background refresh (sidecar:changed) while the app is already running:
      // keep the live tab order, just drop ids whose chats vanished.
      openChatIds = memOpen.filter((id) => validIds.has(id))
      activeId = validIds.has(fallbackActive) ? fallbackActive : (openChatIds[openChatIds.length - 1] ?? '')
      if (activeId && !openChatIds.includes(activeId)) openChatIds = [...openChatIds, activeId]
      if (openChatIds.length === 0 && loadedChats.length > 0 && activeId) openChatIds = [activeId]
      visibleChatIds = normalizeVisibleChats(memVisible.length > 0 ? memVisible : [activeId], validIds, activeId)
    } else {
      // Fresh startup: restore the previous session's tabs from localStorage.
      const storedOpen = loadOpenChats().filter((id) => validIds.has(id))
      const storedActive = loadActiveChat()
      const candidate = validIds.has(storedActive) ? storedActive : fallbackActive
      openChatIds = storedOpen
      if (candidate && !openChatIds.includes(candidate)) openChatIds = [...openChatIds, candidate]
      if (openChatIds.length === 0 && candidate) openChatIds = [candidate]
      activeId = validIds.has(candidate) ? candidate : (openChatIds[openChatIds.length - 1] ?? '')
      // Normalize storage so deleted ids never linger for the next launch.
      if (openChatIds.length > 0 || activeId) persistOpenState(openChatIds, activeId)
      const storedVisible = loadVisibleChats().filter((id) => validIds.has(id))
      visibleChatIds = normalizeVisibleChats(storedVisible.length > 0 ? storedVisible : (activeId ? [activeId] : []), validIds, activeId)
      if (visibleChatIds.length > 0) persistVisibleChats(visibleChatIds)
    }
    // Normalize the persisted split tree (dedupe + drop deleted ids) so
    // close/hide never sees duplicates and tree/visible never diverge.
    // A raw persisted tree may hold stale or duplicated chat ids while
    // visibleChatIds was already normalized above — sync them here once.
    const storedTree = typeof window !== 'undefined' ? normalizeTree(loadChatTree(), validIds) : null
    let chatTree: ChatTreeNode | null = storedTree
    const treeIds = chatTree ? collectChatIds(chatTree) : []
    if (treeIds.length === 0) {
      chatTree = visibleChatIds.length > 0 ? buildFromList(visibleChatIds, treeDirFromLayout(loadChatLayout())) : null
      if (chatTree) persistChatTree(chatTree)
    } else {
      // Tree is authoritative when it exists; mirrors follow it.
      const synced = normalizeVisibleChats(treeIds, validIds, activeId)
      if (JSON.stringify(synced) !== JSON.stringify(visibleChatIds)) {
        visibleChatIds = synced
        persistVisibleChats(visibleChatIds)
      }
    }
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
        oldP.id === 'openrouter' || oldP.id === 'ollama' ? oldP.id : 'custom'
      const name = PROVIDER_NAMES[kind]
      const legacy = normalizeProvider({
        id: oldP.id || 'custom',
        name: name || oldP.name || 'Custom API',
        kind,
        apiKeys: typeof oldP.apiKey === 'string' && oldP.apiKey ? [oldP.apiKey] : [],
        baseUrl: kind === 'custom' || kind === 'ollama' ? oldP.baseUrl || '' : '',
        model: oldP.model || '',
      } as ProviderConfig)
      const defs = defaultProviders().filter((p) => p.id !== legacy.id)
      providers = [legacy, ...defs]
      activeProviderId = legacy.id
    } else {
      providers = defaultProviders()
      activeProviderId = providers[0].id
    }

    // Migration: OAuth was removed from the Google provider (Gemini = API key
    // only, like every other provider). A legacy google provider row that was
    // signed in via OAuth carries the Search Console OAuth trio — move it to
    // the searchConsole config so the tool keeps working without a re-login.
    const legacyGoogle = (raw.providers as Array<Record<string, unknown>> | undefined)?.find(
      (p) => p && (p as { kind?: string }).kind === 'google',
    ) as
      | { oauthClientId?: string; oauthClientSecret?: string; oauthRefreshToken?: string }
      | undefined
    const legacySc = raw.searchConsole
    const migratedSc: SearchConsoleConfig = {
      clientId: legacySc?.clientId ?? legacyGoogle?.oauthClientId ?? '',
      clientSecret: legacySc?.clientSecret ?? legacyGoogle?.oauthClientSecret ?? '',
      refreshToken: legacySc?.refreshToken ?? legacyGoogle?.oauthRefreshToken ?? '',
      siteUrl: legacySc?.siteUrl ?? '',
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
      compactAtPercent:
        typeof raw.compactAtPercent === 'number' &&
        raw.compactAtPercent >= 1 &&
        raw.compactAtPercent <= 99
          ? Math.round(raw.compactAtPercent)
          : 80,
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
    if (settings == null && get().workspaces.length > 0) {
      // Transient settings miss: keep the held workspace entries (custom
      // labels/order) and only backfill roots the held list lacks.
      const cur = get().workspaces
      const known = new Set(cur.map((w) => w.key))
      workspaces = [...cur]
      for (const r of chatRoots) {
        const k = workspaceKey(r)
        if (!known.has(k)) {
          known.add(k)
          workspaces.push(makeWorkspace(r))
        }
      }
    }

    // Merge MCP connectors from the sidecar's user data folder into the UI
    // settings so they show up in Settings → MCP (the folder wins, since it
    // also holds agent-created connectors not in the persisted settings).
    const root = typeof raw.root === 'string' ? raw.root : ''
    const dbMcp = await listMcp()
    const mergedMcp = { ...(loadedSettings.mcpServers ?? {}), ...(dbMcp.mcpServers ?? {}) }
    loadedSettings.mcpServers = mergedMcp
    const builtins = (dbMcp.builtins ?? []).filter((n) => mergedMcp[n])

    // Respect the user's explicit on/off choices for MCP connectors. Built-in
    // connectors (e.g. Docker) default to OFF — the user turns them on via the
    // composer chip or Settings → MCP. We never auto-enable them.
    const userEnabled = raw.mcpEnabled
    const enabledSet = new Set(
      Array.isArray(userEnabled) ? userEnabled.filter((n: string) => !!mergedMcp[n]) : [],
    )
    loadedSettings.mcpEnabled = [...enabledSet]

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
      fontSize,
      vectorDbPath: typeof raw.vectorDbPath === 'string' ? raw.vectorDbPath : '',
      dataPath: typeof raw.dataPath === 'string' && raw.dataPath.trim() ? raw.dataPath : (realDataPath || ''),
      whisperModel: typeof raw.whisperModel === 'string' && raw.whisperModel.trim() ? raw.whisperModel : 'Systran/faster-whisper-medium',
      whisperBaseUrl: typeof raw.whisperBaseUrl === 'string' ? raw.whisperBaseUrl : '',
      sttProviderId: typeof raw.sttProviderId === 'string' && raw.sttProviderId.trim() ? raw.sttProviderId : 'local',
      sttModel: typeof raw.sttModel === 'string' && raw.sttModel.trim() ? raw.sttModel : 'whisper-1',
      sttFallbacks: normalizeSttFallbacks((raw as Record<string, unknown>).sttFallbacks),
      ttsProviderId: typeof raw.ttsProviderId === 'string' ? raw.ttsProviderId.trim() : '',
      // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
      // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
      ttsModel: typeof raw.ttsModel === 'string' ? raw.ttsModel.trim() : 'tts-1',
      ttsVoice: typeof raw.ttsVoice === 'string' ? raw.ttsVoice.trim() : 'alloy',
      ttsFallbacks: normalizeTtsFallbacks((raw as Record<string, unknown>).ttsFallbacks),
      embeddingModel: typeof raw.embeddingModel === 'string' && raw.embeddingModel.trim() ? raw.embeddingModel : 'intfloat/multilingual-e5-base',
      embeddingBaseUrl: typeof raw.embeddingBaseUrl === 'string' ? raw.embeddingBaseUrl : '',
      subagentModels: typeof raw.subagentModels === 'object' && raw.subagentModels !== null
        ? { ...(raw.subagentModels as Record<string, string>) }
        : {},
      // Coerce numbers defensively: settings.json may round-trip numbers
      // through JSON safely, but the IPC layer or an older settings file
      // can hand us string-shaped digits ("30") or null. Accept anything that
      // coerces to a valid value rather than silently falling back to the
      // default — the user did set it, so don't erase their choice.
      cacheTtlMinutes: coercePositiveInt(raw.cacheTtlMinutes, 60),
      historyLimit: coerceNonNegInt(raw.historyLimit, 0),
      // Migration: اگه settings قدیمی webSearchTtlDays داشت ولی ragWebTtlDays نداشت،
      // مقدار webSearchTtlDays → ragWebTtlDays منتقل بشه.
      ragWebTtlDays: coercePositiveInt(raw.ragWebTtlDays, 0)
        || coercePositiveInt((raw as Record<string, unknown>).webSearchTtlDays, 0)
        || 90,
      // 0 is a valid, deliberate value (auto-fetch disabled) — keep it.
      webSearchAutoFetch: coerceBoundedInt(raw.webSearchAutoFetch, 3, 0, 10),
      // Hard desktop-control switch: absent/false in old settings files = OFF.
      computerUse: (raw as { computerUse?: unknown }).computerUse === true,
      // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
      // are dropped here so they disappear from Settings → Plugins on reload.
      searchPlugins: searchPlugins.length > 0
        ? searchPlugins
        : [{ kind: 'duckduckgo', label: 'DuckDuckGo', enabled: true, order: 0 }],
      searchConsole: migratedSc,
      recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
      sidebarOpen: raw.sidebarOpen !== false,
      rightPanelOpen: raw.rightPanelOpen === true,
      workspaceColors: raw.workspaceColors ?? {},
      pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
      pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
      scheduleRunsSeen: normalizeScheduleRunsSeen((raw as { scheduleRunsSeen?: unknown }).scheduleRunsSeen),
      workspaces,
      chats: loadedChats,
      activeChatId: activeId,
      openChatIds,
      visibleChatIds,
      chatTree,
      // Self-clean pre-existing empty chats left on disk by older builds (a
      // fresh tab used to persist immediately). They stay usable in-memory
      // but are queued for file deletion on the next persist; live chats that
      // already have messages are untouched. In-memory-only empty tabs can
      // never appear here (they are filtered from disk writes), so this only
      // ever matches stale files.
      deletedChatIds: [
        ...new Set([
          ...get().deletedChatIds,
          ...loadedChats.filter((c) => (c.messages?.length ?? 0) === 0).map((c) => c.id),
        ]),
      ],
    })
  },

  persist: () => {
    // Never rewrite the whole DB per SSE token while a reply is streaming.
    // Instead of deferring EVERYTHING until the stream ends (which lost the
    // whole in-flight turn on a power cut), write a throttled chats-only
    // snapshot at most once every MID_STREAM_MS — a crash then loses at most
    // the last ~2s. User-initiated saves (mode prompts, subagent models,
    // provider config) made mid-stream are still deferred, never dropped: the
    // final writeStateNow once streaming ends includes them.
    if (get().anyStreaming()) {
      const now = Date.now()
      if (now - lastMidStreamPersist >= MID_STREAM_MS) {
        lastMidStreamPersist = now
        writeChatsNow(get())
      } else {
        persistSoon()
      }
      return
    }
    lastMidStreamPersist = 0
    writeStateNow(get())
  },

  flushNow: () => {
    flushPendingPersist()
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
      apiKeys: [],
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
                // Manual models survive as long as they are still in the list.
                addedModels: (p.addedModels ?? []).filter((m) => models.includes(m)),
              }
            : p,
        ),
      },
    }))
    get().persist()
  },

  // افزودن دستی یک مدل به پروایدر: هم به لیست ظاهری اضافه می‌شود و هم در
  // addedModels ثبت می‌شود تا فچ‌های بعدی (حتی ناموفق) آن را حذف نکنند.
  // افزودن دستی مدل + ثبت اختیاری کانتکست دستی؛ ورودی دستی کانتکست فقط برای
  // kind‌هایی معنا دارد که /models‌شان پنجره‌ی قابل‌اعتماد گزارش نمی‌کند
  // (`manualContextInput` در PROVIDER_META — همین یک رجیستری، بدون چک done‌شده‌ی kind).
  addManualModel: (id, model, contextTokens?) => {
    const m = model.trim()
    if (!m) return
    const ctx =
      typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0
        ? Math.floor(contextTokens)
        : undefined
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
          const acceptsManual = !!PROVIDER_META[p.kind]?.manualContextInput
          const manual =
            ctx !== undefined && acceptsManual
              ? { ...(p.manualContextMap ?? {}), [bare]: ctx }
              : p.manualContextMap
          return {
            ...p,
            models: Array.from(new Set([...(p.models ?? []), m])),
            addedModels: Array.from(new Set([...(p.addedModels ?? []), m])),
            removedModels: (p.removedModels ?? []).filter((x) => x !== m),
            ...(manual !== undefined ? { manualContextMap: manual } : {}),
          }
        }),
      },
    }))
    get().persist()
  },

  // ویرایش/حذف مقدار دستی کانتکست یک مدل دستی (کلید نرمال‌شده‌ی bare). مثل
  // افزودن، فقط برای kind‌های دارای manualContextInput اعمال می‌شود.
  setManualModelContext: (id, model, contextTokens) => {
    const m = model.trim()
    if (!m) return
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p
          if (!PROVIDER_META[p.kind]?.manualContextInput) return p
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
          const next = { ...(p.manualContextMap ?? {}) }
          if (contextTokens === null || !(contextTokens > 0)) delete next[bare]
          else next[bare] = Math.floor(contextTokens)
          return { ...p, manualContextMap: next }
        }),
      },
    }))
    get().persist()
  },

  // ثبت/حذف پرچم دستی reasoning برای یک مدل دستی (کلید نرمال‌شده‌ی bare).
  // برخلاف کانتکست، به kind گیت‌وی وابسته نیست: هر مدلی که کاربر دستی اضافه
  // کرده می‌تواند reasoning-capable اعلام شود تا pill تغییر effort در کامپوزر
  // نمایش داده شود و reasoning_effort به بک‌اند ارسال گردد.
  setManualModelReasoning: (id, model, reasoning) => {
    const m = model.trim()
    if (!m) return
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
          const next = { ...(p.manualReasoningMap ?? {}) }
          if (reasoning === null) {
            delete next[bare]
            delete next[m]
          } else {
            next[bare] = reasoning
          }
          return { ...p, manualReasoningMap: next }
        }),
      },
    }))
    get().persist()
  },

  // حذف یک مدل دستی به‌همراه مقادیر دستی کانتکست و reasoning آن.
  removeManualModel: (id, model) => {
    const m = model.trim()
    if (!m) return
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
          const next = { ...(p.manualContextMap ?? {}) }
          delete next[bare]
          delete next[m]
          const nextReasoning = { ...(p.manualReasoningMap ?? {}) }
          delete nextReasoning[bare]
          delete nextReasoning[m]
          return {
            ...p,
            models: (p.models ?? []).filter((x) => x !== m),
            addedModels: (p.addedModels ?? []).filter((x) => x !== m),
            manualContextMap: next,
            manualReasoningMap: nextReasoning,
          }
        }),
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

  setProviderReasoningMap: (id, reasoningMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => (p.id === id ? { ...p, reasoningMap } : p)),
      },
    }))
    get().persist()
  },

  // ترمیم خودکار ارجاع‌های مدلِ ازکاتالوگ‌رفته: وقتی لیست زنده‌ی /models
  // می‌آید، مدل‌های حذف‌شده/تغییرنام‌یافته‌ی پروایدر دیگر معتبر نیستند.
  // چت‌هایی که هنوز روی چنین مدلی هستند به اولین مدل معتبر برمی‌گردند و
  // recents همان پروایدر پاکسازی می‌شوند تا ارسال بعدی هرگز با خطای
  // «No such model» شکست نخورد. updatedAt عمداً دست نمی‌خورد تا ترتیب
  // چت‌ها در سایدبار جابه‌جا نشود.
  healStaleModels: (providerId, validModels) => {
    if (validModels.length === 0) return
    const bare = (m: string) => (m.startsWith(`${providerId}/`) ? m.slice(providerId.length + 1) : m)
    const valid = new Set(validModels.map(bare))
    const fallback = bare(validModels[0])
    set((s) => ({
      chats: s.chats.map((c) => {
        const owner = c.providerId ?? s.settings.activeProviderId
        if (owner !== providerId || !c.model || valid.has(bare(c.model))) return c
        return { ...c, model: fallback }
      }),
      recentModels: s.recentModels.filter(
        (r) => r.providerId !== providerId || valid.has(bare(r.model)),
      ),
    }))
    get().persist()
  },

  setMcpServers: (mcpServers) => {
    set((s) => ({ settings: { ...s.settings, mcpServers } }))
    get().persist()
  },

  addMcpServer: (name, cfg) => {
    set((s) => {
      const mcpServers = { ...(s.settings.mcpServers ?? {}), [name]: cfg }
      // New connectors default to OFF — the user turns them on via the composer
      // chip or Settings → MCP. We never auto-enable.
      return { settings: { ...s.settings, mcpServers } }
    })
    get().persist()
    void saveMcp(name, cfg)
  },

  updateMcpServer: (name, cfg) => {
    set((s) => {
      const mcpServers = { ...(s.settings.mcpServers ?? {}), [name]: cfg }
      return { settings: { ...s.settings, mcpServers } }
    })
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
    set({ root, outsideAllowed: false, outsideFolders: [] })
    get().persist()
  },

  setTheme: (theme) => {
    set({ theme })
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('coder:theme', theme)
    } catch {}
  },

  setDir: (dir) => {
    set({ dir })
    get().persist()
  },

  toggleDir: () => {
    const next = get().dir === 'rtl' ? 'ltr' : 'rtl'
    get().setDir(next)
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
  setSttProviderId: (id) => {
    set({ sttProviderId: (id ?? '').trim() || 'local' })
    get().persist()
  },
  setSttModel: (m) => {
    set({ sttModel: (m ?? '').trim() || 'whisper-1' })
    get().persist()
  },
  setSttFallbacks: (f) => {
    set({ sttFallbacks: normalizeSttFallbacks(f) })
    get().persist()
  },
  setTtsProviderId: (id) => {
    set({ ttsProviderId: (id ?? '').trim() })
    get().persist()
  },
  setTtsModel: (m) => {
    // خالی مجاز است: بعضی پروایدرهای 9router مدل ندارند — مقدار خالی یعنی
    // «ارسال نکن» و در payload حذف می‌شود. fallback قبلی (`|| 'tts-1'`)
    // پاک‌کردن فیلد را غیرممکن می‌کرد (با هر حذف کامل، مقدار به پیش‌فرض
    // برمی‌گشت و حس «غیرقابل ویرایش بودن» می‌داد).
    set({ ttsModel: (m ?? '').trim() })
    get().persist()
  },
  setTtsVoice: (v) => {
    // خالی مجاز است — مثل setTtsModel.
    set({ ttsVoice: (v ?? '').trim() })
    get().persist()
  },
  setTtsFallbacks: (f) => {
    set({ ttsFallbacks: normalizeTtsFallbacks(f) })
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
  setWebSearchAutoFetch: (n) => {
    // 0 is a valid, deliberate value (disable auto-fetch) — unlike the TTL
    // setters above, we can't fall back with `|| default` since that would
    // silently turn 0 back into the default.
    const r = Math.round(n)
    set({ webSearchAutoFetch: Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 3 })
    get().persist()
  },
  setRagWebTtlDays: (d) => {
    set({ ragWebTtlDays: Math.max(1, Math.round(d) || 90) })
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
      cacheTtlMinutes: typeof c.cache === 'number' && c.cache > 0 ? Math.round(c.cache) : get().cacheTtlMinutes,
    })
    get().persist()
  },

  setHistoryLimit: (n) => {
    set({ historyLimit: Math.max(0, Math.round(n) || 0) })
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
    persistPanelsSoon()
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen
    get().setSidebarOpen(next)
  },

  setRightPanelOpen: (rightPanelOpen) => {
    set({ rightPanelOpen })
    persistPanelsSoon()
  },

  toggleRightPanel: () => {
    const next = !get().rightPanelOpen
    get().setRightPanelOpen(next)
  },

  setTerminalPanelOpen: (terminalPanelOpen) => {
    set((s) => ({
      terminalPanelOpen,
      terminalFullscreen: terminalPanelOpen ? s.terminalFullscreen : false,
    }))
    persistTerminalPanel(terminalPanelOpen)
    if (!terminalPanelOpen) persistTerminalFullscreen(false)
  },

  toggleTerminalPanel: () => {
    const next = !get().terminalPanelOpen
    get().setTerminalPanelOpen(next)
  },

  setTerminalFullscreen: (v) => {
    // Fullscreen needs an open panel — open it first so Ctrl+M works even
    // when the panel was closed.
    if (v && !get().terminalPanelOpen) get().setTerminalPanelOpen(true)
    persistTerminalFullscreen(v)
    set({ terminalFullscreen: v })
  },

  toggleTerminalFullscreen: () => {
    get().setTerminalFullscreen(!get().terminalFullscreen)
  },

  setRecentModels: (recentModels) => {
    set({ recentModels })
    get().persist()
  },

  addRecentModel: (model, providerId) => {
    const m = (model || '').trim()
    if (!m) return
    const pid = providerId || ''
    const now = Date.now()
    set((s) => {
      const prev = s.recentModels.find((x) => x.model === m && x.providerId === pid)
      const pinned = prev?.pinned === true
      // پین‌شده‌ها همیشه بالای لیست‌اند و از حذف خودکار (سقف ۲۰) مصون‌اند:
      // اول پین‌شده‌ها (تازه‌ترین اول)، بعد بقیه؛ سقف فقط روی غیرپین‌شده‌ها اعمال می‌شود.
      const rest = s.recentModels.filter((x) => x.model !== m || x.providerId !== pid)
      const entry: RecentModel = { providerId: pid, model: m, lastUsed: now, ...(pinned ? { pinned: true as const } : {}) }
      const pinnedRest = sortRecentModels(rest.filter((x) => x.pinned)).slice(0, MAX_PINNED_RECENT_MODELS)
      const unpinnedRest = sortRecentModels(rest.filter((x) => !x.pinned))
      const recentModels = pinned
        ? [entry, ...pinnedRest, ...unpinnedRest].slice(0, 20)
        : [...pinnedRest, entry, ...unpinnedRest].slice(0, 20)
      return { recentModels }
    })
    get().persist()
  },

  removeRecentModel: (model, providerId) => {
    const m = (model || '').trim()
    if (!m) return
    const pid = providerId || ''
    // مدل پین‌شده اصلاً از لیست اخیر حذف نمی‌شود — نه دستی، نه خودکار.
    // برای حذفش اول باید آنپین شود.
    set((s) => ({
      recentModels: s.recentModels.filter((x) => x.model !== m || x.providerId !== pid || x.pinned),
    }))
    get().persist()
  },

  togglePinRecentModel: (model, providerId) => {
    const m = (model || '').trim()
    if (!m) return false
    const pid = providerId || ''
    let pinnedNow = false
    let changed = false
    set((s) => {
      const target = s.recentModels.find((x) => x.model === m && x.providerId === pid)
      if (!target) return {}
      if (target.pinned) {
        changed = true
        return { recentModels: sortRecentModels(s.recentModels.map((x) => (x.model === m && x.providerId === pid ? { ...x, pinned: undefined } : x))) }
      }
      if (s.recentModels.filter((x) => x.pinned).length >= MAX_PINNED_RECENT_MODELS) return {}
      pinnedNow = true
      changed = true
      return { recentModels: sortRecentModels(s.recentModels.map((x) => (x.model === m && x.providerId === pid ? { ...x, pinned: true as const } : x))) }
    })
    if (changed) get().persist()
    return pinnedNow
  },

  newChat: (mode) => {
    const chat = makeChat(mode ?? 'ask')
    const s = useStore.getState()
    const prevRoot = s.chats.find((c) => c.id === s.activeChatId)?.root
    const lastRoot = [...s.chats].reverse().find((c) => c.root)?.root
    chat.root = prevRoot ?? lastRoot ?? s.root
    const activeChatId = chat.id
    set((st) => {
      const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId]
      persistOpenState(openChatIds, activeChatId)
      // New chat replaces single-window view; in multi-window it always
      // opens a new window (never replaces) placed along the best axis.
      const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1
      if (single) {
        persistVisibleChats([activeChatId])
        persistChatTree(null)
        return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false }
      }
      const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout)
      const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout))
      const mirrors = persistTreeMirrors(chatTree, st.chatLayout)
      return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false }
    })
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
      const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId]
      persistOpenState(openChatIds, activeChatId)
      const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1
      if (single) {
        persistVisibleChats([activeChatId])
        persistChatTree(null)
        return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false }
      }
      const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout)
      const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout))
      const mirrors = persistTreeMirrors(chatTree, st.chatLayout)
      return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false }
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
      const openChatIds = s.openChatIds.filter((cid) => cid !== id)
      let activeChatId = s.activeChatId
      if (s.activeChatId === id) {
        const idx = s.openChatIds.indexOf(id)
        const remaining = openChatIds
        activeChatId = remaining[Math.min(Math.max(idx - 1, 0), remaining.length - 1)] ?? chats[chats.length - 1]?.id ?? ''
        if (!remaining.includes(activeChatId) && activeChatId) remaining.push(activeChatId)
      }
      const finalOpen = openChatIds.includes(activeChatId) || !activeChatId ? openChatIds : [...openChatIds, activeChatId]
      persistOpenState(finalOpen, activeChatId)
      const validIds = new Set(chats.map((c) => c.id))
      const baseTree = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout))
      const normalized = normalizeTree(removeChat(baseTree, id), validIds)
      const fallbackVisible = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId)
      const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null)
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible
      const chatWindowSizes = mirrors.chatWindowSizes
      return {
        chats,
        activeChatId,
        openChatIds: finalOpen,
        visibleChatIds,
        chatWindowSizes,
        chatTree,
        deletedChatIds: [...s.deletedChatIds, id],
        pinnedChats: s.pinnedChats.filter((k) => k !== id),
        unreadChats: s.unreadChats.filter((cid) => cid !== id),
      }
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
      const openChatIds = s.openChatIds.filter((cid) => !doomedIds.has(cid))
      if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId)
      persistOpenState(openChatIds, activeChatId)
      const validIds = new Set(chats.map((c) => c.id))
      const baseTreeWs = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout))
      let pruned: ChatTreeNode | null = baseTreeWs
      for (const dead of doomedIds) pruned = removeChat(pruned, dead)
      const normalizedWs = normalizeTree(pruned, validIds)
      const fallbackWs = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId)
      const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s.chatLayout)) : null)
      const mirrorsWs = persistTreeMirrors(chatTreeWs, s.chatLayout)
      const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs
      return {
        chats,
        workspaces,
        pinnedWorkspaces,
        pinnedChats,
        activeChatId,
        openChatIds,
        visibleChatIds,
        chatTree: chatTreeWs,
        chatWindowSizes: mirrorsWs.chatWindowSizes,
        chatLayout: mirrorsWs.chatLayout,
        unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
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

  renameWorkspace: (key, label) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.key === key ? { ...w, label } : w,
      ),
    }))
    get().persist()
  },

  moveWorkspace: (key, root) => {
    const trimmed = (root ?? '').trim()
    // نرمال‌سازی اسلش انتهایی تا «/b/» همان «/b» حساب شود و کلید تکراری نسازد.
    const nextRoot = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed
    const nextKey = workspaceKey(nextRoot)
    const prev = get().workspaces.find((w) => w.key === key)
    const prevRoot = prev?.root ?? get().chats.find((c) => workspaceKey(c.root ?? '') === key)?.root ?? ''
    // مسیر یکسان (فقط تفاوت اسلش انتهایی) → فقط root را نرمال کن.
    if (nextKey === key) {
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.key === key ? { ...w, root: nextRoot || null } : w,
        ),
        chats: s.chats.map((c) =>
          workspaceKey(c.root ?? '') === key
            ? { ...c, root: nextRoot || undefined, updatedAt: Date.now() }
            : c,
        ),
        root: s.root === prevRoot ? nextRoot : s.root,
      }))
      get().persist()
      return key
    }
    // ورک‌اسپیس مبدأ ناشناخته → مثل ساخت جدید رفتار کن تا گم نشود.
    if (!prev && get().chats.every((c) => workspaceKey(c.root ?? '') !== key)) {
      get().createWorkspace(nextRoot)
      return nextKey
    }
    set((s) => {
      const targetExists = s.workspaces.some((w) => w.key === nextKey)
      // لیبل: اگه کاربر اسم سفارشی گذاشته بود حفظش کن، وگرنه از پوشه جدید بساز.
      const prevLabel = prev?.label ?? workspaceLabel(prevRoot)
      const label =
        prev && prevLabel !== workspaceLabel(prevRoot)
          ? prevLabel
          : workspaceLabel(nextRoot)
      let workspaces: Workspace[]
      if (targetExists) {
        // ادغام در ورک‌اسپیس مقصدِ موجود: مبدأ حذف، مقصد سر جایش می‌ماند.
        workspaces = s.workspaces
          .filter((w) => w.key !== key)
          .map((w) => (w.key === nextKey ? { ...w, root: nextRoot || null } : w))
      } else {
        workspaces = s.workspaces.map((w) =>
          w.key === key ? { ...w, key: nextKey, root: nextRoot || null, label } : w,
        )
      }
      const workspaceColors = { ...s.workspaceColors }
      if (workspaceColors[key] !== undefined && workspaceColors[nextKey] === undefined) {
        workspaceColors[nextKey] = workspaceColors[key]
      }
      delete workspaceColors[key]
      return {
        workspaces,
        chats: s.chats.map((c) =>
          workspaceKey(c.root ?? '') === key
            ? { ...c, root: nextRoot || undefined, updatedAt: Date.now() }
            : c,
        ),
        workspaceColors,
        pinnedWorkspaces: s.pinnedWorkspaces.map((k) => (k === key ? nextKey : k)),
        root: s.root === prevRoot ? nextRoot : s.root,
        deletedWorkspaceRoots: prevRoot ? [...s.deletedWorkspaceRoots, prevRoot] : s.deletedWorkspaceRoots,
      }
    })
    get().persist()
    return nextKey
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
    set((s) => {
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id]
      persistOpenState(openChatIds, id)
      // Single-window navigation replaces the visible set; in multi-window
      // the chat always opens a new window (never replaces an open one).
      const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1
      let chatTree: ChatTreeNode | null = s.chatTree
      let visibleChatIds = s.visibleChatIds
      let chatWindowSizes = s.chatWindowSizes
      let chatLayout = s.chatLayout
      if (single) {
        visibleChatIds = [id]
        chatTree = null
        persistVisibleChats(visibleChatIds)
        persistChatTree(null)
      } else if (!containsChat(chatTree, id)) {
        // Tab/sidebar select never replaces: hidden chat opens a new window.
        const base = ensureTree(chatTree, visibleChatIds, s.chatLayout)
        chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout))
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
        visibleChatIds = mirrors.visibleChatIds
        chatWindowSizes = mirrors.chatWindowSizes
        chatLayout = mirrors.chatLayout
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        // Opening a chat clears its green "new message" dot.
        unreadChats: s.unreadChats.filter((cid) => cid !== id),
      }
    })
    // Switching chats changes only TRANSIENT state: activeChatId and
    // unreadChats are never serialized (see writeStateNow), so the old
    // get().persist() here was pure overhead ON THE CLICK PATH — it
    // synchronously deep-copied (sanitizeChats) and IPC-structured-cloned
    // EVERY chat and message before React could render the switch, so the
    // sidebar highlight + panel swap lagged by however long the whole store
    // took to copy (grows with TOTAL data, not the active chat's message
    // count). Debounce instead: a real change persists on its own, and
    // flushPendingPersist on beforeunload still covers a quick quit.
    persistSoon()
  },

  openChat: (id) => {
    set((s) => {
      if (!s.chats.some((c) => c.id === id)) return {}
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id]
      persistOpenState(openChatIds, id)
      const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1
      let chatTree: ChatTreeNode | null = s.chatTree
      let visibleChatIds = s.visibleChatIds
      let chatWindowSizes = s.chatWindowSizes
      let chatLayout = s.chatLayout
      if (single) {
        visibleChatIds = [id]
        chatTree = null
        persistVisibleChats(visibleChatIds)
        persistChatTree(null)
      } else if (!containsChat(chatTree, id)) {
        // Sidebar/tab select never replaces: hidden chat opens a new window.
        const base = ensureTree(chatTree, visibleChatIds, s.chatLayout)
        chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout))
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
        visibleChatIds = mirrors.visibleChatIds
        chatWindowSizes = mirrors.chatWindowSizes
        chatLayout = mirrors.chatLayout
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        unreadChats: s.unreadChats.filter((cid) => cid !== id),
      }
    })
    persistSoon()
  },

  closeChatTab: (id) => {
    set((s) => {
      if (!s.openChatIds.includes(id)) return {}
      const idx = s.openChatIds.indexOf(id)
      const openChatIds = s.openChatIds.filter((cid) => cid !== id)
      let activeChatId = s.activeChatId
      if (s.activeChatId === id) {
        activeChatId = openChatIds[Math.min(idx, openChatIds.length - 1)] ?? ''
      }
      persistOpenState(openChatIds, activeChatId)
      // Closing a tab also hides its window; keep at least the active visible.
      const validIds = new Set(s.chats.map((c) => c.id))
      const baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout))
      const normalizedCt = normalizeTree(removeChat(baseTreeCt, id), validIds)
      const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId)
      const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null)
      const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout)
      const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt
      // Tab-list menu "Recently closed": keep the id while the chat itself
      // still exists (deleting the chat clears it via the chat store).
      const recentlyClosedChatTabs = s.chats.some((c) => c.id === id)
        ? [{ id, at: Date.now() }, ...s.recentlyClosedChatTabs.filter((r) => r.id !== id)].slice(0, 8)
        : s.recentlyClosedChatTabs
      return { openChatIds, activeChatId, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs }
    })
    persistSoon()
  },

  closeInactiveChatTabs: () => {
    let closed: string[] = []
    set((s) => {
      const streaming = new Set(
        s.chats
          .filter((c) => c.messages.some((m) => m.streaming || m.retry?.reconnecting === true))
          .map((c) => c.id),
      )
      const visible = new Set(s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds)
      const toClose = s.openChatIds.filter(
        (id) => id !== s.activeChatId && !streaming.has(id) && !visible.has(id),
      )
      if (toClose.length === 0) return {}
      closed = toClose
      const drop = new Set(toClose)
      const openChatIds = s.openChatIds.filter((cid) => !drop.has(cid))
      persistOpenState(openChatIds, s.activeChatId)
      const validIds = new Set(s.chats.map((c) => c.id))
      let baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout))
      for (const id of toClose) {
        if (!baseTreeCt) break
        baseTreeCt = removeChat(baseTreeCt, id)
      }
      const normalizedCt = normalizeTree(baseTreeCt, validIds)
      const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !drop.has(cid)), validIds, s.activeChatId)
      const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null)
      const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout)
      const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt
      // Tab-list menu "Recently closed": keep ids while the chat itself
      // still exists (deleting the chat clears it via the chat store).
      const now = Date.now()
      const kept = toClose.filter((id) => s.chats.some((c) => c.id === id))
      const recentlyClosedChatTabs = [
        ...kept.map((id, i) => ({ id, at: now - i })),
        ...s.recentlyClosedChatTabs.filter((r) => !drop.has(r.id)),
      ].slice(0, 8)
      return { openChatIds, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs }
    })
    persistSoon()
    return closed
  },

  reopenChatTab: (id) => {
    set((s) => ({
      recentlyClosedChatTabs: s.recentlyClosedChatTabs.filter((r) => r.id !== id),
    }))
    get().openChat(id)
  },

  moveChatTab: (fromId, toId, after = false) => {
    set((s) => {
      const from = s.openChatIds.indexOf(fromId)
      if (from === -1 || !s.openChatIds.includes(toId) || fromId === toId) return {}
      const rest = s.openChatIds.filter((cid) => cid !== fromId)
      let dest = rest.indexOf(toId) + (after ? 1 : 0)
      dest = Math.max(0, Math.min(rest.length, dest))
      const openChatIds = rest.slice()
      openChatIds.splice(dest, 0, fromId)
      persistOpenState(openChatIds, fromId)
      return {
        openChatIds,
        activeChatId: fromId,
        unreadChats: s.unreadChats.filter((cid) => cid !== fromId),
      }
    })
    persistSoon()
  },

  openInWindow: (id) => {
    set((s) => {
      if (!s.chats.some((c) => c.id === id)) return {}
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [s.activeChatId], s.chatLayout)
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id]
      persistOpenState(openChatIds, id)
      const chatTree = containsChat(base, id) ? base : openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout))
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        unreadChats: s.unreadChats.filter((cid) => cid !== id),
      }
    })
    persistSoon()
  },

  closeWindow: (id) => {
    set((s) => {
      const treeIds = s.chatTree ? collectChatIds(s.chatTree) : []
      const ids = treeIds.length > 0 ? treeIds : s.visibleChatIds
      if (!ids.includes(id) && !s.visibleChatIds.includes(id)) return {}
      if (new Set([...treeIds, ...s.visibleChatIds]).size <= 1 && ids.length <= 1) return {}
      const idx = ids.indexOf(id)
      const base = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout))
      const pruned = removeChat(base, id)
      const fallbackVisible = (s.visibleChatIds.length > 0 ? s.visibleChatIds : ids).filter((cid) => cid !== id)
      const chatTree = pruned ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null)
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible
      let activeChatId = s.activeChatId
      if (s.activeChatId === id) {
        activeChatId = visibleChatIds[Math.min(Math.max(idx, 0), visibleChatIds.length - 1)] ?? ''
      }
      if (activeChatId !== s.activeChatId) persistOpenState(s.openChatIds, activeChatId)
      const windowFullscreenId = s.windowFullscreenId === id ? null : s.windowFullscreenId
      if (s.windowFullscreenId === id) persistWindowFullscreen(null)
      return {
        visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        activeChatId,
        windowFullscreenId,
        unreadChats: s.unreadChats.filter((cid) => cid !== activeChatId),
      }
    })
    // No DB persist: closeWindow only touches localStorage mirrors (tree /
    // visible / sizes / layout / open state) plus transient active/unread —
    // chats and settings are untouched, so a full snapshot here is pure
    // overhead on the click path (sanitizeChats over every message + IPC
    // right before paint = the minimize lag). Mirrors are already written
    // synchronously above; the next real change persists.
  },

  focusWindow: (id) => {
    set((s) => {
      if (!s.chats.some((c) => c.id === id)) return {}
      if (s.activeChatId === id) return {}
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id]
      persistOpenState(openChatIds, id)
      // Focusing a hidden chat opens a new window beside the previous focus.
      let chatTree: ChatTreeNode | null = s.chatTree
      let visibleChatIds = s.visibleChatIds
      let chatWindowSizes = s.chatWindowSizes
      let chatLayout = s.chatLayout
      if (!containsChat(chatTree, id)) {
        if (leafCount(chatTree) <= 1 && visibleChatIds.length <= 1) {
          visibleChatIds = [id]
          chatTree = null
          persistVisibleChats(visibleChatIds)
          persistChatTree(null)
        } else {
          // Focusing a hidden chat never replaces: open a new window instead.
          const base = ensureTree(chatTree, visibleChatIds, s.chatLayout)
          chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout))
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
          visibleChatIds = mirrors.visibleChatIds
          chatWindowSizes = mirrors.chatWindowSizes
          chatLayout = mirrors.chatLayout
        }
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        unreadChats: s.unreadChats.filter((cid) => cid !== id),
      }
    })
    persistSoon()
  },

  moveWindow: (fromId, toId, after = false) => {
    set((s) => {
      // Legacy linear reorder kept for compat; tree-aware when possible.
      if (s.chatTree) {
        const base = ensureTree(s.chatTree, s.visibleChatIds, s.chatLayout)
        if (!base) return {}
        // Map linear before/after onto the root axis for single-level trees.
        const flatDir = base.kind === 'split' ? base.dir : treeDirFromLayout(s.chatLayout)
        const isFlat = base.kind !== 'split' || base.children.every((c) => c.kind === 'leaf')
        const root = isFlat && base.kind === 'split' ? base : buildFromList(collectChatIds(base), flatDir)
        if (!root || root.kind !== 'split') return {}
        const ids = collectChatIds(root)
        if (!ids.includes(fromId) || !ids.includes(toId) || fromId === toId) return {}
        const rest = ids.filter((cid) => cid !== fromId)
        let dest = rest.indexOf(toId) + (after ? 1 : 0)
        dest = Math.max(0, Math.min(rest.length, dest))
        const ordered = rest.slice()
        ordered.splice(dest, 0, fromId)
        const sizes = sizesByChat(base)
        const chatTree = buildFromList(ordered, root.dir, sizes)
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
        return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout }
      }
      const from = s.visibleChatIds.indexOf(fromId)
      if (from === -1 || !s.visibleChatIds.includes(toId) || fromId === toId) return {}
      const rest = s.visibleChatIds.filter((cid) => cid !== fromId)
      let dest = rest.indexOf(toId) + (after ? 1 : 0)
      dest = Math.max(0, Math.min(rest.length, dest))
      const visibleChatIds = rest.slice()
      visibleChatIds.splice(dest, 0, fromId)
      persistVisibleChats(visibleChatIds)
      return { visibleChatIds }
    })
    persistSoon()
  },

  setWindowSize: (id, size) => {
    const clamped = Number.isFinite(size) ? Math.max(0.25, Math.min(4, size)) : 1
    set((s) => {
      const ids = s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds
      if (!ids.includes(id)) return {}
      if (s.chatTree) {
        const chatTree = setChatSize(s.chatTree, id, clamped)
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
        return { chatTree, chatWindowSizes: mirrors.chatWindowSizes, visibleChatIds: mirrors.visibleChatIds, chatLayout: mirrors.chatLayout }
      }
      const chatWindowSizes = { ...s.chatWindowSizes, [id]: clamped }
      persistWindowSizes(chatWindowSizes)
      return { chatWindowSizes }
    })
  },

  setChatLayout: (layout) => {
    const next = normalizeChatLayout(layout)
    set((s) => {
      if (s.chatTree && s.chatTree.kind === 'split') {
        const chatTree = setRootDir(s.chatTree, next === 'horizontal' ? 'row' : 'col')
        const mirrors = persistTreeMirrors(chatTree, next)
        return { chatLayout: mirrors.chatLayout, chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes }
      }
      persistChatLayout(next)
      return { chatLayout: next }
    })
  },

  dropChatOnto: (dragChatId, targetChatId, pos) => {
    if (!dragChatId || !targetChatId) return
    // Never open a duplicate window for the same chat.
    if (dragChatId === targetChatId) return
    set((s) => {
      if (!s.chats.some((c) => c.id === dragChatId)) return {}
      if (!s.chats.some((c) => c.id === targetChatId)) return {}
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [targetChatId], s.chatLayout)
      // Full: a new chat cannot split in, but center drop replaces the target window.
      if (base && !containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX && pos !== 'center') {
        const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId]
        persistOpenState(openChatIds, s.activeChatId)
        return { openChatIds }
      }
      const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId]
      persistOpenState(openChatIds, dragChatId)
      const chatTree = dropOnto(base, dragChatId, targetChatId, pos)
      if (!chatTree) return {}
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      if (s.windowFullscreenId) persistWindowFullscreen(null)
      return {
        activeChatId: dragChatId,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        windowFullscreenId: null,
        unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId),
      }
    })
    persistSoon()
  },

  dropChatOntoRoot: (dragChatId, pos) => {
    if (!dragChatId) return
    if (pos === 'center') return
    set((s) => {
      if (!s.chats.some((c) => c.id === dragChatId)) return {}
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [dragChatId], s.chatLayout)
      if (!base) return {}
      if (!containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX) {
        const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId]
        persistOpenState(openChatIds, s.activeChatId)
        return { openChatIds }
      }
      const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId]
      persistOpenState(openChatIds, dragChatId)
      const chatTree = dropOntoRoot(base, dragChatId, pos)
      if (!chatTree || chatTree === base) return { openChatIds }
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      if (s.windowFullscreenId) persistWindowFullscreen(null)
      return {
        activeChatId: dragChatId,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        windowFullscreenId: null,
        unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId),
      }
    })
    persistSoon()
  },

  setTreeNodeSize: (nodeId, size) => {
    set((s) => {
      if (!s.chatTree) return {}
      const chatTree = setNodeSize(s.chatTree, nodeId, size)
      if (!chatTree || chatTree === s.chatTree) return {}
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout }
    })
  },

  resizeTreePair: (parentId, firstId, secondId, firstSize, secondSize) => {
    set((s) => {
      if (!s.chatTree) return {}
      const chatTree = resizePair(s.chatTree, parentId, firstId, secondId, firstSize, secondSize)
      if (!chatTree || chatTree === s.chatTree) return {}
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout)
      return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout }
    })
  },

  setChatFullscreen: (v) => {
    set(() => {
      persistChatFullscreen(v)
      return { chatFullscreen: v }
    })
  },

  toggleChatFullscreen: () => {
    set((s) => {
      persistChatFullscreen(!s.chatFullscreen)
      return { chatFullscreen: !s.chatFullscreen }
    })
  },

  setWindowFullscreen: (id) => {
    persistWindowFullscreen(id)
    set({ windowFullscreenId: id })
  },

  toggleWindowFullscreen: (id) => {
    const st = get()
    const target = id ?? st.activeChatId
    if (!target) return
    const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds
    // Single window already fills the chat area — nothing to expand.
    if (ids.length < 2 && !st.windowFullscreenId) return
    const next = toggleFullscreenId(st.windowFullscreenId, target)
    persistWindowFullscreen(next)
    if (next && st.activeChatId !== next) {
      const openChatIds = st.openChatIds.includes(next) ? st.openChatIds : [...st.openChatIds, next]
      persistOpenState(openChatIds, next)
      set({ windowFullscreenId: next, activeChatId: next, openChatIds, unreadChats: st.unreadChats.filter((cid) => cid !== next) })
    } else {
      set({ windowFullscreenId: next })
    }
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

  setChatModeQuiet: (id, mode) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, mode, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  setGoal: (id, condition) => {
    const text = (condition ?? '').trim()
    if (!text) return
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id
          ? { ...c, goal: { condition: text, active: true, paused: false, stopped: false, startedAt: Date.now(), turns: 0 }, updatedAt: Date.now() }
          : c,
      ),
    }))
    get().persist()
  },

  clearGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, goal: null, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  pauseGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: true, stopped: false }, updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
  },

  resumeGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: false, stopped: false }, updatedAt: Date.now() } : c,
      ),
    }))
    get().persist()
  },

  stopGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id && c.goal?.active && !c.goal.paused
          ? { ...c, goal: { ...c.goal, stopped: true }, updatedAt: Date.now() }
          : c,
      ),
    }))
    get().persist()
  },

  rearmGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id && c.goal?.active && c.goal.stopped
          ? { ...c, goal: { ...c.goal, stopped: false }, updatedAt: Date.now() }
          : c,
      ),
    }))
    get().persist()
  },

  incrementGoalTurn: (id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === id && c.goal?.active && !c.goal.paused
          ? { ...c, goal: { ...c.goal, turns: (c.goal.turns ?? 0) + 1 } }
          : c,
      ),
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
    // Draft writes happen on every keystroke: keep the `chats` array (and every
    // other chat object) referentially stable so Sidebar / ChatPanel subscribers
    // that don't depend on this chat's draft never re-render. Only the edited
    // chat gets a new object, and only when the merged draft actually changed.
    // No persist: drafts are transient composer state, flushed with the next
    // real change (or the quit flush).
    set((s) => {
      const idx = s.chats.findIndex((c) => c.id === id)
      if (idx === -1) return {}
      const cur = s.chats[idx]
      const next = { ...cur.draft, ...patch }
      const prev = cur.draft ?? {}
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
      let changed = false
      for (const k of keys) {
        if ((prev as Record<string, unknown>)[k] !== (next as Record<string, unknown>)[k]) {
          changed = true
          break
        }
      }
      if (!changed) return {}
      const chats = s.chats.slice()
      chats[idx] = { ...cur, draft: next }
      return { chats }
    })
  },
  setChatThinkingLevel: (id, level) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, thinkingLevel: level, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },
  setChatProvider: (id, providerId, model) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, providerId, model, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  renameChat: (id, title) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)),
    }))
    get().persist()
  },

  forkSection: (messageId, sectionTitle, sectionContent) => {
    const s = useStore.getState()
    const src = s.chats.find((c) => c.messages.some((m) => m.id === messageId))
    if (!src) return
    // Same workspace + mode as the source chat, so the follow-up lives next to
    // the original conversation and behaves identically (tools, modes, …).
    const chatId = s.newChatInRoot(src.root ?? '', src.mode)
    if (src.providerId) {
      useStore.getState().setChatProvider(chatId, src.providerId, src.model ?? '')
    }
    const label = sectionTitle.trim() || 'بخش'
    // Seed the new chat with the section's full content as its first message —
    // the agent receives the whole history, so it knows exactly what the
    // follow-up question is about without the rest of the long answer.
    const context = `📌 بخش «${label}» از پاسخ قبلی:\n\n${sectionContent.trim()}`
    useStore.getState().addMessage(chatId, { role: 'user', content: context })
    useStore.getState().renameChat(chatId, label)
    // The ChatPanel remounts on the chat switch (key={activeChatId}); this flag
    // makes it focus the composer so the user can type their question at once.
    useStore.getState().setFocusComposer(true)
  },

  setFocusComposer: (v) => set({ focusComposer: v }),

  forkChatFromMessage: (messageId) => {
    const src = get().chats.find((c) => c.messages.some((m) => m.id === messageId))
    if (!src) return null
    const idx = src.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return null
    // Same workspace + mode + provider as the source chat, so the fork
    // behaves identically and lives next to the original conversation.
    const chatId = get().newChatInRoot(src.root ?? '', src.mode)
    if (src.providerId) {
      get().setChatProvider(chatId, src.providerId, src.model ?? '')
    }
    // Copy the history up to and including the fork point (fresh objects so
    // edits in one chat never leak into the other via shared references).
    const cut = src.messages.slice(0, idx + 1).map((m) => ({ ...m }))
    set((st) => ({
      chats: st.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: cut,
              title: `${src.title} (fork)`.slice(0, 80),
              thinkingLevel: src.thinkingLevel,
              updatedAt: Date.now(),
            }
          : c,
      ),
      activeChatId: chatId,
    }))
    get().persist()
    get().setFocusComposer(true)
    return chatId
  },

  addMessage: (chatId, message) => {
    const id = uid()
    const full: ChatMessage = { ...message, id, createdAt: Date.now() }
    // Title-generator trigger: first user message of a fresh chat still
    // titled 'New chat'. System mode-switch notices and assistant hints
    // don't count — switching to build/plan before the first send adds a
    // system message, so messages.length would wrongly block the trigger.
    // `autoTitle` mirrors the slice title the insert below sets, so the
    // resolve step can tell an untouched auto title (safe to replace) from
    // a manual rename (must keep).
    const prev = get().chats.find((c) => c.id === chatId)
    const autoTitle = message.content.slice(0, 48)
    const hasPriorUser = !!prev?.messages.some((m) => m.role === 'user')
    const shouldTitle =
      message.role === 'user' &&
      !!prev &&
      !hasPriorUser &&
      prev.title === 'New chat' &&
      message.content.trim() !== ''
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
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt:
                !message.streaming &&
                (message.role === 'user' || message.role === 'assistant')
                  ? Date.now()
                  : c.updatedAt,
              title: c.messages.length === 0 && message.role === 'user' ? message.content.slice(0, 48) : c.title,
            }
          : c,
      )
      return { chats }
    })
    get().persist()
    if (shouldTitle) {
      // Fire-and-forget: runs parallel to the main agent turn, never blocks it.
      // Trigger line: proves addMessage fired for the first user message.
      console.info('[title] generating title for new chat', chatId.slice(-6))
      void (async () => {
        try {
          const st = get()
          const chat = st.chats.find((c) => c.id === chatId)
          const provider =
            st.settings.providers.find(
              (p) => p.id === (chat?.providerId ?? st.settings.activeProviderId),
            ) ?? st.settings.providers[0]
          if (!provider) return
          const res = await requestChatTitle({
            provider,
            subagentModels: st.subagentModels ?? {},
            providers: Object.fromEntries(
              (st.settings.providers ?? []).map((p) => [p.id, p]),
            ),
            text: message.content.slice(0, 1000),
            chatId,
          })
          const title = typeof res?.title === 'string' ? res.title.trim() : ''
          if (title) {
            // Apply first: usage bookkeeping must never block the rename.
            try {
              const cur = get().chats.find((c) => c.id === chatId)
              if (!cur) {
                console.info('[title] chat gone — skipping apply')
              } else if (
                cur.title !== 'New chat' &&
                cur.title !== autoTitle &&
                (cur.title || '').trim() !== ''
              ) {
                console.info('[title] title changed meanwhile — keeping it:', cur.title)
              } else {
                get().renameChat(chatId, title)
                console.info('[title] applied title:', title, chatId.slice(-6))
              }
            } catch (err) {
              console.warn('[title] apply failed — keeping auto title', err)
            }
          }
          const cu = res?.usage
          if (cu) {
            try {
              // Bill the title call under the provider/model that actually ran
              // it (provider_id > kind > chat provider), mirroring the compact
              // path — the sidebar then lists it like every other model call.
              const pid = cu.provider_id || cu.provider || provider.id
              const usageModel = normalizeUsageModel(pid, cu.model || provider.model || 'main')
              get().accrueChatUsage(chatId, pid, usageModel, {
                input: cu.input_tokens ?? 0,
                output: cu.output_tokens ?? 0,
                cacheRead: cu.cache_read_tokens ?? 0,
                cacheWrite: cu.cache_write_tokens ?? 0,
              })
            } catch (err) {
              console.warn('[title] usage accrue failed', err)
            }
          }
        } catch (err) {
          // Never swallow: a silent catch is why "no logs" was undebuggable.
          console.warn('[title] title flow failed — keeping auto title', err)
        }
      })()
    } else if (
      message.role === 'user' &&
      !!prev &&
      !hasPriorUser &&
      message.content.trim() !== ''
    ) {
      // First user message but the trigger guard blocked (title already left
      // 'New chat'). When the current title is just this message's own auto
      // slice (resend/retry path), there is nothing to diagnose — keep it at
      // debug so the console stays quiet; a genuinely different title (manual
      // rename, fork) is still logged at info with the chat id.
      if (prev.title !== autoTitle) {
        console.info('[title] trigger skipped — current title:', prev.title, chatId.slice(-6))
      } else {
        console.debug('[title] trigger skipped — title already matches first message', chatId.slice(-6))
      }
    }
    return full
  },

  removeMessage: (chatId, id) => {
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? { ...c, messages: c.messages.filter((m) => m.id !== id) }
          : c,
      ),
    }))
    get().persist()
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
    set((s) => {
      // Only the chat that actually contains the message needs rebuilding, so
      // we find it once and map just its messages instead of mapping every chat
      // (and every message inside each) on every SSE token. This keeps the
      // other chat references stable so subscribers that don't depend on the
      // edited message don't re-render.
      const targetChat = s.chats.find((c) => c.messages.some((m) => m.id === id))
      if (!targetChat) return {}
      const msg = targetChat.messages.find((m) => m.id === id)!
      // Only the turn-completion transition (streaming true -> false) moves the
      // chat in the sidebar; per-token content/thinking/tool deltas must not
      // reorder it, or two concurrent chats trade places constantly.
      const completes = msg.streaming === true && patch.streaming === false
      const updatedChat = {
        ...targetChat,
        messages: targetChat.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        updatedAt: completes ? Date.now() : targetChat.updatedAt,
      }
      // A turn finishing in a chat the user is NOT looking at = new message in
      // the background → steady green dot in the sidebar until the user opens it.
      const unreadChats =
        completes &&
        targetChat.id !== s.activeChatId &&
        !s.unreadChats.includes(targetChat.id)
          ? [...s.unreadChats, targetChat.id]
          : s.unreadChats
      return {
        chats: s.chats.map((c) => (c.id === targetChat.id ? updatedChat : c)),
        unreadChats,
      }
    })
    // updateMessage fires on every SSE token while streaming — persisting the
    // whole chats array each time is what hammers coder.db / app-state-cache.json.
    // While streaming, maybePersistMidStream() throttles to one chats-only
    // snapshot per MID_STREAM_MS (heartbeat); once the stream ends
    // (setStreaming(false) → the trailing updateMessage({streaming:false})) it
    // falls back to the normal debounced full persist.
    maybePersistMidStream()
  },

  appendMessageSegments: (id, segments) => {
    if (!segments || segments.length === 0) return false
    let added = false
    set((s) => {
      const targetChat = s.chats.find((c) => c.messages.some((m) => m.id === id))
      if (!targetChat) return {}
      const msg = targetChat.messages.find((m) => m.id === id)!
      const cur = msg.segments ?? []
      const next = [...cur]
      for (const seg of segments) {
        const dup = next.some((e) => {
          if (e.kind !== seg.kind) return false
          if (seg.kind === 'user' && e.kind === 'user') return e.id === (seg as { id: string }).id
          if (seg.kind === 'compact' && e.kind === 'compact') return e.id === (seg as { id: string }).id
          if (seg.kind === 'tool' && e.kind === 'tool')
            return e.index === (seg as { index: number }).index
          return false
        })
        if (!dup) {
          next.push(seg)
          added = true
        }
      }
      if (!added) return {}
      return {
        chats: s.chats.map((c) =>
          c.id === targetChat.id
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === id ? { ...m, segments: next } : m,
                ),
              }
            : c,
        ),
      }
    })
    if (added) maybePersistMidStream()
    return added
  },

  accrueChatUsage: (chatId, providerId, model, delta) => {
    // Keep cache-only events (input=0, output=0, but cacheRead/cacheWrite>0):
    // those are real billed tokens and must not be dropped, otherwise the
    // cached portion silently disappears from the totals.
    const hasTokens =
      (delta.input || 0) > 0 ||
      (delta.output || 0) > 0 ||
      (delta.cacheRead || 0) > 0 ||
      (delta.cacheWrite || 0) > 0;
    if (!hasTokens) return
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== chatId) return c
        const entries = [...(c.usage?.entries ?? [])]
        const idx = entries.findIndex(
          (e) => e.providerId === providerId && e.model === model,
        )
        if (idx >= 0) {
          const prev = entries[idx]
          entries[idx] = {
            ...prev,
            input: prev.input + (delta.input || 0),
            output: prev.output + (delta.output || 0),
            cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
            cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
            lastUsed: Date.now(),
          }
        } else {
          entries.push({
            providerId,
            model,
            input: delta.input || 0,
            output: delta.output || 0,
            cacheRead: delta.cacheRead ?? 0,
            cacheWrite: delta.cacheWrite ?? 0,
            lastUsed: Date.now(),
          })
        }
        // Usage fires once per model call INSIDE a run — don't reorder the
        // sidebar mid-turn. The turn-completion bump in updateMessage handles
        // reordering when the agent finishes.
        const working = c.messages.some((m) => m.streaming)
        return { ...c, usage: { entries }, updatedAt: working ? c.updatedAt : Date.now() }
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

  setChatCompacting: (id, compacting) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, compacting } : c)),
    }))
  },

  setChatCompactNotice: (id, compactNotice) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, compactNotice } : c)),
    }))
  },

  setChatCompactError: (id, compactError) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, compactError } : c)),
    }))
  },

  setChatCmdError: (id, cmdError) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, cmdError } : c)),
    }))
  },

  setChatLiveError: (id, liveError) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, liveError } : c)),
    }))
  },

  setChatTtsError: (id, ttsError) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, ttsError } : c)),
    }))
  },

  setChatSkillNotice: (id, skillNotice) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, skillNotice } : c)),
    }))
  },

  docRev: {},

  bumpDocRev: (absPath) => {
    set((s) => ({
      docRev: { ...s.docRev, [absPath]: (s.docRev[absPath] ?? 0) + 1 },
    }))
  },

  

  setChatScrollPos: (id, pos) => {
    set((s) => ({
      // Deliberately NOT bumping updatedAt: scrolling shouldn't reorder chats.
      chats: s.chats.map((c) => (c.id === id ? { ...c, scrollPos: pos } : c)),
    }))
    get().persist()
  },

  // In-memory-only variant: updates the store WITHOUT persisting. Used by the
  // `coder:flush-ui` handler so a chat panel can push its ref-held scroll
  // position into the store right before a flush writes the snapshot — no
  // redundant write, no recursion into persist().
  setChatScrollPosMem: (id, pos) => {
    set((s) => {
      const cur = s.chats.find((c) => c.id === id)?.scrollPos ?? null
      const same =
        (cur === null && pos === null) ||
        (cur !== null &&
          pos !== null &&
          cur.id === pos.id &&
          cur.offset === pos.offset &&
          cur.atBottom === pos.atBottom)
      if (same) return {}
      return {
        chats: s.chats.map((c) => (c.id === id ? { ...c, scrollPos: pos } : c)),
      }
    })
  },

  setPrefixNotice: (prefixNotice) => {
    set({ prefixNotice })
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
    // Find the chat that actually contains the message instead of assuming
    // the active chat: a retry click resolves its origin chat first, and
    // truncating the wrong (viewed) chat would leave the original turn in
    // place while send() appends a second identical user bubble.
    const target = s.chats.find((c) => c.messages.some((m) => m.id === messageId))
    if (!target) return false
    const idx = target.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return false
    const targetId = target.id
    set((st) => ({
      chats: st.chats.map((c) =>
        c.id === targetId
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
        // 1 — opencode-style, only the last message survives verbatim). The
        // summary is appended so the next turn (which sends the FULL history,
        // system-first) keeps summary + recent together without contradicting
        // either.
        const recentStart = Math.max(nonSys.length - keep, 0)
        const compactedIds = new Set(
          nonSys.slice(0, recentStart).map((m) => m.id),
        )
        // Never fold a message that is STILL STREAMING: the summary must land
        // BEFORE the live reply so the rest of the stream renders after the
        // checkpoint (a steer message added mid-stream would otherwise push the
        // streaming reply above the summary and the tail would contradict it).
        for (const m of c.messages) {
          if (m.streaming) compactedIds.delete(m.id)
        }
        // On a repeated /compact, also fold any PREVIOUS system summary so only
        // the newest summary renders as the prominent block (the old ones stay
        // in the scrollback like any other folded message).
        for (const m of c.messages) {
          if (m.role === 'system') compactedIds.add(m.id)
        }
        // Folded messages KEEP their per-turn usage so their token badge stays
        // visible (the context meter ignores them — it only scans non-compacted
        // messages). The preserved tail, however, has its usage CLEARED: that
        // usage is the PRE-compact input+output of the last exchange, and
        // keeping it pinned the context meter at the pre-compact size after
        // every compact ("manual compact doesn't lower the meter"). With the
        // tail's usage cleared, the meter falls back to the post-compact
        // estimate (system prompt + summary + preserved tail) until the next
        // real usage event lands. chat.usage (per-model session totals) is
        // untouched — it only ever grows.
        const messages = c.messages.map((m) =>
          compactedIds.has(m.id)
            ? { ...m, compacted: true }
            : { ...m, usage: undefined },
        )
        const summaryMsg = {
          id: uid(),
          role: 'system' as const,
          content: summary,
          usage: undefined as TokenUsage | undefined,
          compacted: false,
          createdAt: Date.now(),
        }
        // If a message is still streaming (auto-compact fired mid-turn), also
        // drop a `compact` segment onto it so the checkpoint renders INLINE at
        // the exact point in the stream where it happened — same mechanism as
        // an interleaved steer message (`kind: 'user'`) — instead of only
        // showing up after the whole turn finishes. The summary message itself
        // is still appended below for the between-turns case (no live message
        // to attach a segment to) and so the backend/history logic below is
        // unaffected.
        const streaming = messages.find((m) => m.streaming)
        const withSeg = streaming
          ? messages.map((m) =>
              m.id === streaming.id
                ? {
                    ...m,
                    segments: [
                      ...(m.segments ?? []),
                      { kind: 'compact', id: summaryMsg.id } as MessageSegment,
                    ],
                  }
                : m,
            )
          : messages
        // Append the summary at the END of the conversation. Between turns this
        // is also where it renders (the user wants the checkpoint below the
        // reply, not above it). Mid-turn, the inline segment above already
        // anchors its VISUAL position — this push just keeps it present in the
        // flat list for folding/history purposes. Array order here is fine
        // either way: the backend normalizes history order itself (moving
        // system summaries to the head) before compacting, so it always finds
        // and merges a prior summary regardless of where it sits.
        withSeg.push(summaryMsg)
        return {
          ...c,
          messages: withSeg,
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

  addOutsideFolder: (folder) =>
    set((s) => ({
      outsideFolders:
        folder && !s.outsideFolders.includes(folder)
          ? [...s.outsideFolders, folder]
          : s.outsideFolders,
    })),

  setComputerUse: (v) => set({ computerUse: v }),

  anyStreaming: () => get().chats.some((c) => c.messages.some((m) => m.streaming)),

  setCompactAtPercent: (percent: number) => {
    set((s) => ({ settings: { ...s.settings, compactAtPercent: percent } }))
    get().persist()
  },
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

/** Resolve the provider a chat should run on: the chat's own per-chat override
 *  (set via the composer picker) when present, else the global active provider.
 *  The returned provider carries the chat's model override too, so a chat that
 *  picked a different model sends on that model without touching the global
 *  default. */
export function getChatProvider(chatId: string | null | undefined): ProviderConfig {
  const s = useStore.getState()
  const ch = chatId ? (s.chats.find((c) => c.id === chatId) ?? null) : null
  const overrideId = ch?.providerId
  const p =
    s.settings.providers.find((x) => x.id === (overrideId ?? s.settings.activeProviderId)) ??
    s.settings.providers[0]
  return ch?.model ? { ...p, model: ch.model } : p
}
