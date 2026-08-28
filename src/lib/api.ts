import type { AgentMode, McpServerConfig, ModeCapabilities, NvimDiagnostic, ProviderConfig, SidecarEvent } from '../types'
import { api } from './fs'
import { modelContextWindow, scaleReserved } from './context'

let sidecarUrl: string | null = null

api.onSidecarChanged(() => {
  sidecarUrl = null
})

// The Electron sidecar process crashed (e.g. segfault while loading the Whisper
// model). Its port is now dead, so drop the cached URL immediately instead of
// waiting for the next health probe to fail with "Failed to fetch".
api.onSidecarDead(() => {
  sidecarUrl = null
})

/**
 * Verify a cached sidecar URL is still alive with a short health probe.
 * Returns true when the server answers `/health` within the timeout.
 */
async function isSidecarAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    // Network-level failure (server down / port dead) — treat as dead.
    return false
  }
}

export async function ensureSidecar(): Promise<string | null> {
  if (sidecarUrl) {
    // The cached URL may point at a dead process (e.g. the Python sidecar
    // crashed while loading the Whisper model). Probe before trusting it so we
    // don't keep hitting a dead port and surfacing "Failed to fetch".
    if (await isSidecarAlive(sidecarUrl)) return sidecarUrl
    sidecarUrl = null
  }
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
  } catch (err) {
    // A network-level failure (TypeError) means the sidecar is unreachable —
    // its cached URL is stale. Drop the cache and retry once against a freshly
    // resolved URL (which restarts the sidecar if needed).
    if (err instanceof TypeError) {
      sidecarUrl = null
      const retryUrl = await ensureSidecar()
      if (retryUrl && retryUrl !== url) {
        const res = await fetch(`${retryUrl}/transcribe`, {
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
      }
    }
    throw err
  } finally {
    if (onModelLoading) onModelLoading(false)
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
      callId?: number | string
      summary?: string
      status: string
      items?: Array<Record<string, unknown>>
    }>
  }>
  attachments?: string[]
  /** Each image is a path string OR an object {path, dataUrl}; the backend
   *  prefers an inline dataUrl so it never depends on reading the frontend's
   *  temp file (covers uploads and screenshots). */
  images?: Array<string | { path: string; dataUrl?: string }>
  systemPrompt?: string
  thinkingLevel?: string
  /** Whether the selected model is reasoning-capable (from the /models
   *  `reasoning` flag). The backend uses this to emit a lightweight composer
   *  glow signal while the model reasons, instead of streaming raw thinking
   *  text. No model names are inferred here — the flag comes straight from the
   *  provider payload / models.dev catalog. */
  modelReasoning?: boolean
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
  /** Full provider configs keyed by provider id, so a "providerId/model"
   *  subagent entry is routed to that provider's own base URL / key. */
  providers?: Record<string, ProviderConfig>
  /** Compaction headroom (tokens) reserved below the context window — opencode's
   *  `reserved`. Auto-compaction fires at `ctx - reserved`. */
  reserved?: number
  /** Fraction of the usable window at which mid-turn auto-compaction fires
   *  (0.1–0.95). Compact once a turn reaches this fraction, before the limit. */
  compactTriggerFraction?: number
  signal?: AbortSignal
}

export async function streamChat(
  params: StreamParams,
  onEvent: (event: SidecarEvent) => void,
): Promise<void> {
  let url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')

  // Self-healing reconnect: if the network drops mid-stream (a fetch/reader
  // error that is NOT a manual abort and NOT an HTTP error from the backend),
  // retry with exponential backoff instead of leaving the user stuck on a dead
  // "Still waiting" state. HTTP errors (5xx, etc.) are NOT retried here — the
  // backend already runs its own retry loop, and a non-2xx is a deliberate
  // response, not a dropped connection.
  const MAX_RECONNECT_ATTEMPTS = 5
  const BASE_BACKOFF_MS = 1000

  // A healthy turn ALWAYS ends with a terminal `done` event (the server emits it
  // in its finally block). If the stream closes WITHOUT one, the sidecar died
  // mid-turn (segfault/OOM) and the OS tore down the socket. We must treat that
  // as a drop — not a clean completion — so the self-healing reconnect below
  // respawns the sidecar and resumes from the on-disk checkpointer, instead of
  // silently stranding the user on a manual resend.
  let gotDone = false
  const wrappedOnEvent = (e: SidecarEvent) => {
    if (e?.kind === 'done') gotDone = true
    onEvent(e)
  }

  const parseFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      // SSE comments (": keepalive") are the backend's heartbeat — it sends one
      // every ~15s ONLY while the agent is legitimately silent (running a tool
      // or thinking). Forwarding it as a "keepalive" event lets the frontend
      // refresh its stall watchdog clock, so a long-running tool is never
      // mistaken for a dead connection. A genuinely dead socket stops emitting
      // these, which is exactly what the watchdog needs to detect.
      if (line.startsWith(': ')) {
        wrappedOnEvent({ kind: 'keepalive' } as SidecarEvent)
        continue
      }
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try {
        const event = JSON.parse(raw) as SidecarEvent
        wrappedOnEvent(event)
      } catch {
        /* skip malformed frame */
      }
    }
  }

  let attempt = 0
  while (true) {
    // A manual stop must never trigger a reconnect — bail before any work.
    if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // On a reconnect (any attempt after the first), re-resolve the sidecar URL
    // so we pick up the freshly-respawned process instead of the dead port we
    // cached at the start. The first attempt uses the cached URL as before (no
    // extra health probe per turn).
    if (attempt > 0) {
      url = await ensureSidecar()
      if (!url) throw new Error('Python agent not ready — run `npm run setup`')
    }

    // Phase 1: connect. A network failure to even reach the sidecar is
    // retryable; an HTTP error response is not.
    let res: Response
    try {
      res = await fetch(`${url}/chat/stream`, {
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
          attachments: params.attachments ?? [],
          images: params.images ?? [],
          system_prompt: params.systemPrompt ?? '',
          thinking_level: params.thinkingLevel ?? '',
          model_reasoning: params.modelReasoning ?? false,
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
          providers: params.providers ?? {},
          // Scale the compaction headroom to the window: keep the 20k default for
          // large models, but clamp it down for small windows so compaction never
          // fires near the start (opencode clamps reserved to maxOutputTokens).
          reserved: scaleReserved(
            modelContextWindow(params.provider, params.provider.model) ?? 0,
            params.reserved ?? 20000,
          ),
          compact_trigger_fraction: params.compactTriggerFraction ?? 0.8,
          context_window: modelContextWindow(params.provider, params.provider.model) ?? 0,
        }),
      })
    } catch (err) {
      // fetch() threw (connection refused / DNS / dropped socket) — retryable.
      if (params.signal?.aborted) throw err
      attempt++
      if (attempt > MAX_RECONNECT_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)))
      continue
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { detail?: string }).detail || `chat request failed (${res.status})`)
    }
    if (!res.body) throw new Error('no response body')

    // Phase 2: read the SSE stream. A network error mid-read is retryable; we
    // re-run the whole request (the backend resumes from the same user turn).
    try {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

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
      // streamed message looks truncated — "the ending gets deleted". Also
      // flush any pending multi-byte UTF-8 tail (decoder.decode() with no args).
      buffer += decoder.decode()
      if (buffer.trim()) parseFrame(buffer)
      if (!gotDone) {
        // The sidecar died mid-stream (segfault/OOM) and the socket closed
        // without a graceful `done`. Surface it as a drop so the self-healing
        // reconnect (below) respawns the sidecar and resumes from the on-disk
        // checkpointer, rather than silently completing and stranding the user
        // on a manual resend. A normal completion always receives `done`.
        throw new Error("SSE stream ended without a terminal 'done' event (sidecar drop)")
      }
      return // clean completion — no reconnect needed
    } catch (err) {
      // A manual abort must propagate immediately, not trigger a reconnect.
      if (params.signal?.aborted || (err as Error).name === 'AbortError') throw err
      attempt++
      if (attempt > MAX_RECONNECT_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)))
      continue
    }
  }
}

/** A provider config used to drive compaction (primary summarizer + fallback). */
export interface CompactProvider {
  kind: string
  model: string
  baseUrl: string
  apiKey: string
  envVar?: string
  oauthToken?: string
}

export interface CompactResult {
  summary: string | null
  keep: number
  error?: string
}

/** Manual ``/compact`` — runs opencode-style compaction on the backend and
 *  returns the structured summary plus the number of recent turns to keep
 *  verbatim (opencode's token-budgeted tail). */
export async function triggerCompact(params: {
  provider: CompactProvider
  fallback: CompactProvider
  history: Array<{ role: string; content: string }>
  contextWindow?: number
  reserved?: number
  signal?: AbortSignal
}): Promise<CompactResult> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const res = await fetch(`${url}/chat/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      provider: params.provider.kind,
      model: params.provider.model,
      base_url: params.provider.baseUrl,
      api_key: params.provider.apiKey,
      env_var: params.provider.envVar ?? '',
      oauth_token: params.provider.oauthToken ?? '',
      fallback_provider: params.fallback.kind,
      fallback_model: params.fallback.model,
      fallback_base_url: params.fallback.baseUrl,
      fallback_api_key: params.fallback.apiKey,
      fallback_env_var: params.fallback.envVar ?? '',
      fallback_oauth_token: params.fallback.oauthToken ?? '',
      history: params.history,
      context_window: params.contextWindow ?? 0,
      reserved: params.reserved ?? 20000,
    }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(body.detail || `compact request failed (${res.status})`)
  }
  return (await res.json()) as CompactResult
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

// ---- Skills & MCP connectors (skills are file-based; MCP in app db) -------- //

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

/** List all skills (file-based storage in the sidecar's skill dir). */
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

/** Create/update/delete a skill (file-based storage in the sidecar's skill dir). */
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
