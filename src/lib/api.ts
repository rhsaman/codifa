import type { AgentMode, McpServerConfig, ModeCapabilities, NvimDiagnostic, ProviderConfig, SidecarEvent } from '../types'
import { api } from './fs'
import { modelContextWindow } from './context'

let sidecarUrl: string | null = null

api.onSidecarChanged(() => {
  sidecarUrl = null
})

export async function ensureSidecar(): Promise<string | null> {
  if (sidecarUrl) return sidecarUrl
  const url = await api.getSidecarUrl()
  if (url) sidecarUrl = url
  return sidecarUrl
}

export interface ModelPricing {
  input: number
  output: number
  /** USD per MILLION tokens for prompt-cache reads, when the provider advertises
   *  a separate (cheaper than full input) rate. Falls back to `input` at the
   *  meter when absent. */
  cacheRead?: number
  /** USD per MILLION tokens for prompt-cache writes, when advertised. */
  cacheWrite?: number
}

/** Query params / body fields carrying a provider's OAuth credentials. Empty for
 *  key-based providers so the request shape is unchanged. */
function oauthParams(cfg: ProviderConfig): Array<[string, string]> {
  if (cfg.authType !== 'oauth') return []
  const out: Array<[string, string]> = [['auth_type', 'oauth']]
  if (cfg.oauthClientId) out.push(['oauth_client_id', cfg.oauthClientId])
  if (cfg.oauthClientSecret) out.push(['oauth_client_secret', cfg.oauthClientSecret])
  if (cfg.oauthRefreshToken) out.push(['oauth_refresh_token', cfg.oauthRefreshToken])
  return out
}

export interface ModelsResult {
  models: string[]
  context: Record<string, number>
  /** USD per MILLION tokens, when the provider/models.dev advertises a price. */
  pricing: Record<string, ModelPricing>
  /** Per-model reasoning-support flag (models.dev limit.reasoning / provider payload). */
  reasoning: Record<string, boolean>
}

/**
 * Transcribe a recorded audio blob using the local Whisper model in the sidecar.
 * Returns the transcribed text. Fully local and offline (the Whisper "small"
 * model ships inside the packaged backend/whisper/ folder).
 */
export async function transcribeAudio(
  blob: Blob,
  onModelLoading?: (loading: boolean) => void,
  lang?: string,
): Promise<string> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const form = new FormData()
  form.append('audio', blob, 'clip.wav')
  if (lang) form.append('lang', lang)
  if (onModelLoading) onModelLoading(true)
  try {
    const res = await fetch(`${url}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(
        (body as { detail?: string }).detail || `transcription failed (${res.status})`,
      )
    }
    const data = (await res.json()) as { text: string }
    return (data.text ?? '').trim()
  } finally {
    if (onModelLoading) onModelLoading(false)
  }
}

/**
 * Best-effort write of a short-term (~24h) memory note into the workspace RAG
 * store. Used after /compact so the summary stays recallable. Resolves without
 * throwing when the store isn't available.
 */
export async function addMemoryNote(
  root: string,
  text: string,
  vectorDbPath?: string,
): Promise<void> {
  const url = await ensureSidecar()
  if (!url || !root || !text) return
  try {
    const res = await fetch(`${url}/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root,
        text,
        vector_db_path: vectorDbPath ?? '',
        memory_type: 'short_term',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    await res.json().catch(() => ({}))
  } catch {
    // Silent: compaction must never fail because a note couldn't be saved.
  }
}

export async function fetchModels(cfg: ProviderConfig): Promise<ModelsResult> {  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_key: cfg.apiKey,
  })
  if (cfg.envVar) params.set('env_var', cfg.envVar)
  for (const [k, v] of oauthParams(cfg)) params.set(k, v)
  const res = await fetch(`${url}/models?${params}`, { signal: AbortSignal.timeout(90_000) })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail || `models request failed (${res.status})`)
  }
  const data = (await res.json()) as {
    models: Array<{ id: string; context: number | null; pricing?: ModelPricing | null; reasoning?: boolean | null }>
  }
  const models: string[] = []
  const context: Record<string, number> = {}
  const pricing: Record<string, ModelPricing> = {}
  const reasoning: Record<string, boolean> = {}
  for (const m of data.models ?? []) {
    models.push(m.id)
    if (m.context) context[m.id] = m.context
    if (m.pricing) pricing[m.id] = m.pricing
    if (typeof m.reasoning === 'boolean') reasoning[m.id] = m.reasoning
  }
  return { models, context, pricing, reasoning }
}

export interface CreditsResult {
  balance: number
  total_credits: number
  total_usage: number
}

/** Fetch the provider account's remaining credit balance (OpenRouter only;
 *  other providers return an empty object → UI shows no balance line). */
export async function fetchCredits(cfg: ProviderConfig): Promise<Partial<CreditsResult>> {
  const url = await ensureSidecar()
  if (!url) return {}
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_key: cfg.apiKey,
  })
  if (cfg.envVar) params.set('env_var', cfg.envVar)
  for (const [k, v] of oauthParams(cfg)) params.set(k, v)
  try {
    const res = await fetch(`${url}/credits?${params}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return {}
    const data = (await res.json()) as Partial<CreditsResult>
    return data
  } catch {
    return {}
  }
}

export interface StreamParams {
  provider: ProviderConfig
  root: string
  mode: AgentMode
  prompt: string
  /** Renderer-side chat id — the backend stores plans per chat under
   *  <data>/plan/<workspace>/<chat-id>/plan.md. */
  chatId?: string
  history: Array<{
    role: string
    content: string
    thinking?: string
    plan?: Array<{ content: string; status: string }>
    mode?: string
    toolActivity?: Array<{
      tool: string
      args?: Record<string, unknown>
      summary?: string
      status: string
    }>
  }>
  /** How many recent messages to send per turn / preserve verbatim on compact. */
  maxHistory?: number
  attachments?: string[]
  images?: string[]
  systemPrompt?: string
  thinkingLevel?: string
  mcpServers?: Record<string, McpServerConfig>
  /** Names of skills selected for this turn (only these are loaded). */
  skills?: string[]
  /** Allow the agent to create skills / MCP connectors (via /skill /mcp). */
  allowCreate?: boolean
  /** Per-mode tool capabilities sent to the backend for tool gating. */
  cap?: ModeCapabilities
  /** User pre-approved outside-workspace access for this session/workspace. */
  allowOutside?: boolean
  /** Absolute path of the file currently open in Neovim (auto-mentioned). */
  nvimFile?: string
  /** LSP diagnostics for the Neovim file, so the agent can see its issues. */
  nvimDiagnostics?: NvimDiagnostic[]
  /** Directory for the per-workspace RAG vector store ("" = backend default). */
  vectorDbPath?: string
  /** Size / TTL bounds for the RAG store (max_docs, max_chunks, ttl_days). */
  vectorConfig?: { ttl_days: number; max_docs: number; max_chunks: number }
  /** Per-subagent model overrides (explore, vision, compact). */
  subagentModels?: Record<string, string>
  /** Pre-emptive auto-compact threshold as a FRACTION of the context window
   *  (0.5–0.95, default 0.8). */
  compactThreshold?: number
  signal?: AbortSignal
}

export async function streamChat(
  params: StreamParams,
  onEvent: (event: SidecarEvent) => void,
): Promise<void> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')

  const res = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      provider: params.provider.kind,
      api_key: params.provider.apiKey,
      env_var: params.provider.envVar ?? '',
      base_url: params.provider.baseUrl,
      auth_type: params.provider.authType ?? '',
      oauth_client_id: params.provider.oauthClientId ?? '',
      oauth_client_secret: params.provider.oauthClientSecret ?? '',
      oauth_refresh_token: params.provider.oauthRefreshToken ?? '',
      model: params.provider.model,
      root: params.root,
      mode: params.mode,
      prompt: params.prompt,
      chat_id: params.chatId ?? '',
      history: params.history,
      max_history: params.maxHistory ?? 10,
      attachments: params.attachments ?? [],
      images: params.images ?? [],
      system_prompt: params.systemPrompt ?? '',
      thinking_level: params.thinkingLevel ?? '',
      mcp_servers: params.mcpServers ?? {},
      skills: params.skills ?? [],
      allow_create: params.allowCreate ?? false,
      cap: params.cap ?? {},
      allow_outside: params.allowOutside ?? false,
      nvim_file: params.nvimFile ?? "",
      nvim_diagnostics: params.nvimDiagnostics ?? [],
      vector_db_path: params.vectorDbPath ?? "",
      vector_config: params.vectorConfig ?? null,
      subagent_models: params.subagentModels ?? {},
      compact_threshold: params.compactThreshold ?? 0.8,
      context_window: modelContextWindow(params.provider, params.provider.model) ?? 0,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail || `chat request failed (${res.status})`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Parse one complete SSE frame (everything between two blank lines).
  const parseFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try {
        const event = JSON.parse(raw) as SidecarEvent
        onEvent(event)
      } catch {
        /* skip malformed frame */
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        parseFrame(chunk)
      }
    }
    // Flush whatever is left after the last blank line: the final SSE frame
    // usually arrives WITHOUT a trailing "\n\n" (the stream just closes), so
    // without this the LAST text/done/usage event is silently dropped and the
    // streamed message looks truncated — "the ending gets deleted". Also flush
    // any pending multi-byte UTF-8 tail (decoder.decode() with no args).
    buffer += decoder.decode()
    if (buffer.trim()) parseFrame(buffer)
  } finally {
    reader.releaseLock()
  }
}

/** Deliver a message to a RUNNING agent for this chat (no abort, injected at
 *  the next tool call). Returns false if the sidecar is unreachable or the
 *  chat_id/prompt are invalid. */
export async function steerChat(
  chatId: string,
  id: string,
  prompt: string,
): Promise<boolean> {
  const url = await ensureSidecar()
  if (!url) return false
  try {
    const res = await fetch(`${url}/chat/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, id, prompt }),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
    return body.ok !== false
  } catch {
    return false
  }
}

/** Cancel a pending steer message (user deleted it before the agent read it). */
export async function cancelSteer(chatId: string, id: string): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  try {
    await fetch(`${url}/chat/steer/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, id }),
    })
  } catch {
    /* best effort */
  }
}

/** Answer a pending outside-workspace permission / confirm_action request from the agent. */
export async function respondPermission(
  id: string,
  allowed: boolean,
): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  try {
    await fetch(`${url}/permission/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, allowed }),
    })
  } catch {
    /* best effort */
  }
}

/** Answer a pending ask_user question (multiple-choice or free-text) from the agent. */
export async function respondAsk(id: string, answer: string): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  try {
    await fetch(`${url}/ask/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer }),
    })
  } catch {
    /* best effort */
  }
}

// ---- Managed on-device models (whisper / embedding) ---------------------- //

export type ManagedModelKind = "whisper" | "embedding"

export interface ModelDirInfo {
  repo: string
  dir: string
  size: number
  ready: boolean
}

export interface ModelRunState {
  state: "downloading" | "error"
  repo: string
  error?: string
}

export interface ModelKindStatus {
  dirs: ModelDirInfo[]
  running?: ModelRunState
}

export interface ModelsStatus {
  whisper: ModelKindStatus
  embedding: ModelKindStatus
}

/** Kick off a background model download (Settings → Models). */
export async function downloadModel(
  kind: ManagedModelKind,
  model: string,
  baseUrl = "",
): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  await fetch(`${url}/models/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, model, base_url: baseUrl }),
  })
}

/** Poll the current download state + on-disk model dirs. */
export async function getModelsStatus(): Promise<ModelsStatus> {
  const url = await ensureSidecar()
  if (!url) return { whisper: { dirs: [] }, embedding: { dirs: [] } }
  const res = await fetch(`${url}/models/status`)
  if (!res.ok) return { whisper: { dirs: [] }, embedding: { dirs: [] } }
  const data = (await res.json()) as ModelsStatus
  return {
    whisper: data.whisper ?? { dirs: [] },
    embedding: data.embedding ?? { dirs: [] },
  }
}

/** Delete a downloaded model folder. */
export async function removeModel(
  kind: ManagedModelKind,
  model: string,
): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  await fetch(`${url}/models/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, model }),
  })
}

// ---- Skills & MCP connectors (stored in the sidecar's app database) ------- //

export interface SkillRow {
  name: string
  slug: string
  description: string
  path: string
  content: string
}

export interface SkillSyncResult {
  ok: boolean
  name?: string
  indexed?: boolean
  note?: string
  removed?: boolean
}

/** List all skills from the app database. */
export async function listSkills(): Promise<SkillRow[]> {
  const url = await ensureSidecar()
  if (!url) return []
  try {
    const res = await fetch(`${url}/skills`)
    if (!res.ok) return []
    const data = (await res.json()) as { skills?: SkillRow[] }
    return data.skills ?? []
  } catch {
    return []
  }
}

/** Create/update/delete a skill in the app database. */
export async function syncSkill(params: {
  name: string
  previousName?: string
  content?: string
  description?: string
  delete?: boolean
}): Promise<SkillSyncResult> {
  const url = await ensureSidecar()
  if (!url) return { ok: false, note: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/skills/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: params.name,
        previous_name: params.previousName ?? "",
        content: params.content ?? "",
        description: params.description ?? "",
        delete: params.delete ?? false,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { ok: false, note: body.detail || `save failed (${res.status})` }
    }
    return (await res.json()) as SkillSyncResult
  } catch {
    return { ok: false, note: "could not reach the agent" }
  }
}

/** List MCP connectors (+ builtin names) from the app database. */
export async function listMcp(): Promise<{
  mcpServers: Record<string, McpServerConfig>
  builtins: string[]
}> {
  const url = await ensureSidecar()
  if (!url) return { mcpServers: {}, builtins: [] }
  try {
    const res = await fetch(`${url}/mcp`)
    if (!res.ok) return { mcpServers: {}, builtins: [] }
    const data = (await res.json()) as {
      mcpServers?: Record<string, McpServerConfig>
      builtins?: string[]
    }
    return {
      mcpServers: data.mcpServers ?? {},
      builtins: Array.isArray(data.builtins) ? data.builtins : [],
    }
  } catch {
    return { mcpServers: {}, builtins: [] }
  }
}

/** Save an MCP connector to the app database. */
export async function saveMcp(name: string, cfg: McpServerConfig): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  try {
    await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cfg }),
    })
  } catch {
    /* best effort */
  }
}

/** Remove an MCP connector from the app database. */
export async function deleteMcp(name: string): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  try {
    await fetch(`${url}/mcp/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  } catch {
    /* best effort */
  }
}

export interface MemoryStats {
  available: boolean
  db: string
  docs: number
  chunks: number
  kinds: Record<string, number>
  max_docs: number
  max_chunks: number
  ttl_days: number
}

/** RAG store usage for a workspace (docs/chunks + active TTL/caps). */
export async function getMemoryStats(
  root: string,
  vectorDbPath?: string,
): Promise<MemoryStats> {
  const url = await ensureSidecar()
  const empty: MemoryStats = {
    available: false,
    db: "",
    docs: 0,
    chunks: 0,
    kinds: {},
    max_docs: 0,
    max_chunks: 0,
    ttl_days: 0,
  }
  if (!url || !root) return empty
  try {
    const qs = new URLSearchParams({ root })
    if (vectorDbPath) qs.set("vector_db_path", vectorDbPath)
    const res = await fetch(`${url}/memory/stats?${qs.toString()}`)
    if (!res.ok) return empty
    return { ...empty, ...((await res.json()) as Partial<MemoryStats>) }
  } catch {
    return empty
  }
}

/** Wipe the workspace's RAG store (memory notes + saved web chunks). */
export async function clearMemory(
  root: string,
  vectorDbPath?: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = await ensureSidecar()
  if (!url || !root) return { ok: false, error: "no active workspace" }
  try {
    const res = await fetch(`${url}/memory/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, vector_db_path: vectorDbPath ?? "" }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { ok: false, error: body.detail || `clear failed (${res.status})` }
    }
    return (await res.json()) as { ok: boolean; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
