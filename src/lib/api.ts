import type { AgentMode, McpServerConfig, ModeCapabilities, NvimDiagnostic, ProviderConfig, ScheduleRun, ScheduledTask, SearchResultItem, SidecarEvent, TraceEntry, TraceKind } from '../types'
import { api } from './fs'
import { modelContextWindow } from './context'

let sidecarUrl: string | null = null
// In-flight `ensureSidecar` resolution. Shared by every concurrent caller so
// React StrictMode's double-mount + the multiple effects that all call
// `fetchModels` / `fetchCredits` on chat switch coalesce into ONE probe (or
// ONE getSidecarUrl IPC) instead of firing `/health` for each call. Without
// this, a single chat switch produced 3× /health (one per ensureSidecar
// invocation × 2 in StrictMode).
let sidecarInFlight: Promise<string | null> | null = null

api.onSidecarChanged(() => {
  sidecarUrl = null
  sidecarInFlight = null
})

// The Electron sidecar process crashed (e.g. segfault while loading the Whisper
// model). Its port is now dead, so drop the cached URL immediately instead of
// waiting for the next health probe to fail with "Failed to fetch".
api.onSidecarDead(() => {
  sidecarUrl = null
  sidecarInFlight = null
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
  // Dedup: if a previous call is still resolving (probing /health or
  // awaiting the getSidecarUrl IPC), every concurrent caller awaits the
  // SAME promise instead of each firing its own /health probe.
  if (sidecarInFlight) return sidecarInFlight
  const p = (async () => {
    if (sidecarUrl) {
      // The cached URL may point at a dead process (e.g. the Python sidecar
      // crashed while loading the Whisper model). Probe before trusting it so
      // we don't keep hitting a dead port and surfacing "Failed to fetch".
      // We DO probe on every call (no "fast path" that skips the probe) so
      // a crash between calls is detected immediately: the previous resolution
      // success doesn't mean the sidecar is still alive, and skipping the
      // probe would leave the user hitting a dead port until the next call.
      if (await isSidecarAlive(sidecarUrl)) return sidecarUrl
      sidecarUrl = null
    }
    const url = await api.getSidecarUrl()
    if (url) sidecarUrl = url
    return sidecarUrl
  })()
  sidecarInFlight = p
  // After the resolution settles, clear the in-flight slot so subsequent
  // sequential callers re-probe (health-check) instead of blindly reusing
  // a potentially stale result. Concurrent callers that arrived while the
  // probe was still in-flight already share `p` and will get the same
  // result without an extra /health call. The slot is also reset by
  // onSidecarChanged / onSidecarDead for the explicit crash scenario.
  p.finally(() => { sidecarInFlight = null })
  return p
}

/**
 * Drop the cached sidecar URL so the next `ensureSidecar()` re-resolves
 * (and re-starts the sidecar if it died). Called by the background health
 * probe in App.tsx when a /health ping against the cached URL fails — the
 * cached URL points at a dead port and every subsequent request would
 * surface "Failed to fetch" otherwise. Safe to call from any context.
 */
export function invalidateSidecarCache(): void {
  sidecarUrl = null
  sidecarInFlight = null
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

export interface ModelsResult {
  models: string[]
  context: Record<string, number>
  /** USD per MILLION tokens, when the provider/models.dev advertises a price. */
  pricing: Record<string, ModelPricing>
  /** Per-model reasoning-support flag (models.dev limit.reasoning / provider payload). */
  reasoning: Record<string, boolean>
}

/** Ordered keys for a provider (top = tried first). Sent as api_keys. */
export function providerKeys(cfg: Pick<ProviderConfig, 'apiKeys'> & { apiKey?: string }): string[] {
  const raw = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : []
  const out = raw.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
  if (out.length === 0 && typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '') out.push(cfg.apiKey)
  return out
}

/** Remote STT provider details forwarded to POST /transcribe. Omit for local Whisper. */
export interface TranscribeProviderOpts {
  kind: string
  baseUrl: string
  apiKeys?: string[]
  model?: string
}

/** Remote TTS provider details forwarded to POST /tts. */
export interface SpeakProviderOpts {
  kind: string
  baseUrl: string
  apiKeys?: string[]
  model?: string
  voice?: string
}

/**
 * Synthesize text to speech via the sidecar.
 * Remote (opts): forwarded to POST {base_url}/audio/speech.
 * Returns the audio bytes as a Blob.
 *
 * The sidecar streams the audio (StreamingResponse), so callers that want
 * first-byte latency should use `speakTextStream` below instead of waiting
 * for the full Blob here.
 */
export async function speakText(
  text: string,
  opts: SpeakProviderOpts,
  callerSignal?: AbortSignal,
): Promise<Blob> {
  return await speakTextStream(text, opts, undefined, callerSignal)
}

/**
 * Read the /tts response as progressive audio chunks.
 * Resolves once the FIRST chunk arrives (so playback can start early) and
 * keeps invoking `onChunk` for the rest in the background. The returned
 * promise settles when the whole body is consumed.
 */
export async function speakTextStream(
  text: string,
  opts: SpeakProviderOpts,
  onChunk?: (chunk: BlobPart, first: boolean) => void,
  callerSignal?: AbortSignal,
): Promise<Blob> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const body: Record<string, string> = {
    text,
    provider: opts.kind,
    base_url: opts.baseUrl,
  }
  if ((opts.model ?? '').trim()) body.model = (opts.model ?? '').trim()
  if ((opts.voice ?? '').trim()) body.voice = (opts.voice ?? '').trim()
  const speakKeys = (opts.apiKeys ?? []).filter((k) => typeof k === 'string' && k)
  if (speakKeys.length > 0) body.api_keys = JSON.stringify(speakKeys)
  const timeoutSignal = AbortSignal.timeout(120_000)
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  const signal =
    callerSignal && typeof anyFn === 'function'
      ? anyFn([callerSignal, timeoutSignal])
      : (callerSignal ?? timeoutSignal)
  const post = async (base: string): Promise<Blob> => {
    const chunks: BlobPart[] = []
    let first = true
    await postTtsChunks(base, body, signal, (chunk) => {
      chunks.push(chunk)
      try {
        onChunk?.(chunk, first)
      } finally {
        first = false
      }
    })
    const firstType = chunks.length > 0 && chunks[0] instanceof Blob ? (chunks[0] as Blob).type : ''
    return new Blob(chunks, { type: firstType || 'audio/mpeg' })
  }
  try {
    return await post(url)
  } catch (err) {
    if (callerSignal?.aborted) throw err
    if (err instanceof TypeError) {
      sidecarUrl = null
      const retryUrl = await ensureSidecar()
      if (retryUrl && retryUrl !== url) {
        return await post(retryUrl)
      }
    }
    throw err
  }
}

/** POST /tts and forward each body chunk to `onChunk` as it arrives. */
async function postTtsChunks(
  base: string,
  body: Record<string, string>,
  signal: AbortSignal,
  onChunk: (chunk: BlobPart) => void,
): Promise<void> {
  const res = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(
      (data as { detail?: string }).detail || `speech synthesis failed (${res.status})`,
    )
  }
  const contentType = res.headers?.get?.('content-type')?.split(';')[0]?.trim() || 'audio/mpeg'
  // Fast path: no streaming body (mocked fetch in tests) — single chunk.
  if (!res.body || typeof (res.body as ReadableStream).getReader !== 'function') {
    const blob = await res.blob()
    onChunk(blob.size > 0 ? blob : new Blob([], { type: contentType }))
    return
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        const copy = value.slice().buffer as ArrayBuffer
        onChunk(new Blob([copy], { type: contentType }))
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // best-effort — reader may already be closed after cancel
    }
  }
}

/** Split long text into sentence chunks for queued TTS playback. */
export function splitTtsSentences(text: string, maxLen = 280): string[] {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // Only true sentence boundaries (. ! ? … ؟) — splitting on colon/semicolon
  // chopped mid-sentence phrases into tiny chunks, multiplying requests and
  // making playback choppy. Colons/semicolons stay inside the chunk.
  const parts = clean.split(/(?<=[.!?…؟!])/u).map((s) => s.trim()).filter(Boolean)
  const sentences = parts.length > 0 ? parts : [clean]
  const out: string[] = []
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s)
      continue
    }
    // Long sentence without punctuation: hard-split on word boundaries.
    const words = s.split(' ')
    let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (next.length > maxLen && cur) {
        out.push(cur)
        cur = w
      } else {
        cur = next
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

/**
 * Transcribe a recorded audio blob via the sidecar.
 * Local (no opts): on-device Whisper, fully offline.
 * Remote (opts): forwarded to POST {base_url}/audio/transcriptions.
 * Returns the transcribed text.
 */
export async function transcribeAudio(
  blob: Blob,
  onModelLoading?: (loading: boolean) => void,
  lang?: string,
  opts?: TranscribeProviderOpts,
): Promise<string> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const form = new FormData()
  form.append('audio', blob, 'clip.wav')
  if (lang) form.append('lang', lang)
  if (opts) {
    form.append('provider', opts.kind)
    form.append('base_url', opts.baseUrl)
    const sttKeys = (opts.apiKeys ?? []).filter((k) => typeof k === 'string' && k)
    if (sttKeys.length > 0) form.append('api_keys', JSON.stringify(sttKeys))
    if (opts.model) form.append('model', opts.model)
  }
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

export async function fetchModels(cfg: ProviderConfig): Promise<ModelsResult> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  // Dedupe concurrent calls for the SAME provider config. React StrictMode
  // mounts every effect twice in dev, and ProviderModelSelect + Chat.tsx both
  // fire on chat switch — without this cache, a single chat switch produced
  // 2× /models?provider=… requests (the user's reported "هر کدوم ۲ بار فچ
  // میشه"). The cache holds the in-flight Promise so the second caller awaits
  // the first; resolved promises are kept briefly to also dedupe back-to-back
  // calls (e.g. provider config edit + dropdown open).
  const sig = providerRequestKey(cfg)
  const cached = modelsInFlight.get(sig)
  if (cached) return cached
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_keys: JSON.stringify(providerKeys(cfg)),
  })
  const p = (async () => {
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
  })()
  modelsInFlight.set(sig, p)
  // Clear the cache entry once the request settles, but keep a short "fresh"
  // window so a re-mount within ~1s still dedupes.
  // `p.finally(...)` returns a NEW promise mirroring p's rejection — swallow
  // it here: callers await `p` itself and surface its error, while this
  // derived promise has no other handler (an unhandled rejection otherwise).
  p.finally(() => {
    setTimeout(() => {
      if (modelsInFlight.get(sig) === p) modelsInFlight.delete(sig)
    }, 1000)
  }).catch(() => {})
  return p
}

// In-flight /models dedup. Keyed by provider config so changing baseUrl /
// apiKey always triggers a fresh fetch.
const modelsInFlight = new Map<string, Promise<ModelsResult>>()

export interface ModelTestResult { ok: boolean; reply: string }

/** Probe a single model with a tiny completion (POST /models/test). Throws
 *  the server's `detail` on failure so the UI can show the real error. */
export async function testModel(cfg: ProviderConfig, model: string): Promise<ModelTestResult> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const body: Record<string, unknown> = {
    provider: cfg.kind,
    base_url: cfg.baseUrl ?? '',
    api_keys: providerKeys(cfg),
    model,
  }
  const res = await fetch(`${url}/models/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // > backend's 65s cap so the server's real error message surfaces
    // instead of a client-side abort.
    signal: AbortSignal.timeout(75_000),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `model test failed (${res.status})`)
  }
  return (await res.json()) as ModelTestResult
}
function providerRequestKey(cfg: ProviderConfig): string {
  return [
    cfg.id,
    cfg.kind,
    cfg.baseUrl ?? "",
    providerKeys(cfg).join(','),
  ].join("|")
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
  // Dedupe concurrent calls (React StrictMode mounts effects twice in dev,
  // and a chat switch re-fires the polling effect — without this, every
  // chat switch fired 2× /credits?provider=…).
  const sig = providerRequestKey(cfg)
  const cached = creditsInFlight.get(sig)
  if (cached) return cached
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_keys: JSON.stringify(providerKeys(cfg)),
  })
  const p = (async () => {
    try {
      const res = await fetch(`${url}/credits?${params}`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return {}
      const data = (await res.json()) as Partial<CreditsResult>
      return data
    } catch {
      return {}
    }
  })()
  creditsInFlight.set(sig, p)
  p.finally(() => {
    setTimeout(() => {
      if (creditsInFlight.get(sig) === p) creditsInFlight.delete(sig)
    }, 1000)
  })
  return p
}

const creditsInFlight = new Map<string, Promise<Partial<CreditsResult>>>()

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
    plan?: Array<{ id?: string; content: string; status: string }>
    mode?: string
    toolActivity?: Array<{
      tool: string
      args?: Record<string, unknown>
      callId?: number | string
      summary?: string
      status: string
      items?: Array<SearchResultItem | Record<string, unknown>>
      results?: Array<SearchResultItem | Record<string, unknown>>
      diff?: string
    }>
    /** Tool-output recap from a previously interrupted turn. NOT rendered in
     *  the UI; folded into the assistant message's content server-side so the
     *  model sees what was already done without re-executing the tools. */
    preservedToolSummary?: string
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
  /** Outside-workspace folders the user pre-approved per-folder ("Always
   *  allow" on the per-folder permission dialog) — absolute realpaths. */
  allowOutsideFolders?: string[]
  /** User pre-approved desktop-app control (the `computer` tool's mutating
   *  actions) for this session/workspace — set by "Always allow". */
  allowComputer?: boolean
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
  /** Auto-compaction threshold as a percentage of the raw context window.
   *  Auto-compaction fires once `total_tokens >= ctx * compactAtPercent / 100`. */
  compactAtPercent?: number
  /** Max tool-loop steps per turn. 0/undefined = backend auto from ctx. */
  maxSteps?: number
  /** Explicit restart (message retry icon / truncate-and-restart). Backend
   *  clears the interrupted-turn checkpoint and starts fresh instead of
   *  resuming old tool work. Omit/false for normal sends and banner resumes. */
  restart?: boolean
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
  // Whether ANY event (incl. keepalive) was delivered on this attempt. Used to
  // distinguish a genuine sidecar crash-before-output (no events — heal with a
  // reconnect) from an interrupted mid-turn stream (events already flowing — do
  // NOT auto-re-send the turn, or it would retry on an idle chat).
  let gotAnyEvent = false
  const wrappedOnEvent = (e: SidecarEvent) => {
    if (e?.kind === 'done') gotDone = true
    gotAnyEvent = true
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
          // `provider` stays as the kind so the backend can keep using it as
          // the model-lookup / timeout key, which is provider-KIND-scoped
          // (e.g. "openrouter" / "opencode" / "google"). `provider_id` carries
          // the user-configured id so per-usage entries group under the right
          // provider even when several providers share the same kind.
          provider: params.provider.kind,
          provider_id: params.provider.id,
          api_keys: providerKeys(params.provider),
          base_url: params.provider.baseUrl,
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
          allow_outside_folders: params.allowOutsideFolders ?? [],
          allow_computer: params.allowComputer ?? false,
          nvim_file: params.nvimFile ?? "",
          nvim_diagnostics: params.nvimDiagnostics ?? [],
          vector_db_path: params.vectorDbPath ?? "",
          vector_config: params.vectorConfig ?? null,
          subagent_models: params.subagentModels ?? {},
          providers: params.providers ?? {},
          // Single auto-compaction threshold as a percentage of the raw window.
          compact_at_percent: params.compactAtPercent ?? 80,
          // Max tool-loop steps per turn (Settings → General, 0 = backend auto).
          max_steps: params.maxSteps ?? 0,
          restart: params.restart ?? false,
          context_window: modelContextWindow(params.provider, params.provider.model) ?? 0,
        }),
      })
    } catch (err) {
      // fetch() threw (connection refused / DNS / dropped socket) — retryable.
      if (params.signal?.aborted) throw err
      // Surface the self-heal so the user isn't left wondering why the turn
      // restarted on its own (the "interrupted itself" confusion).
      wrappedOnEvent({
        kind: 'retry',
        attempt: attempt + 1,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        reason: 'Connection lost — reconnecting from checkpoint…',
        reconnecting: true,
      } as SidecarEvent)
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
      // Only auto-reconnect on a genuine sidecar crash BEFORE any output (no
      // event was delivered). If events were already flowing and the stream then
      // dropped, it's an interruption (client disconnect / user navigated away),
      // not a crash. Re-sending the whole turn here would retry on an idle chat —
      // exactly the unwanted "Provider hiccup during idle" behavior. Instead,
      // throw so the UI shows a Retry banner; clicking it resumes the backend from
      // the LangGraph checkpoint.
      if (gotAnyEvent) {
        throw new Error(
          'Connection lost mid-turn — the turn was interrupted. Click Retry to resume from the last checkpoint.',
        )
      }
      // Surface the self-heal so the user isn't left wondering why the turn
      // restarted on its own (the "interrupted itself" confusion).
      wrappedOnEvent({
        kind: 'retry',
        attempt: attempt + 1,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        reason: 'Connection lost — reconnecting from checkpoint…',
        reconnecting: true,
      } as SidecarEvent)
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
  apiKeys: string[]
  /** User-configured provider id — usage attribution groups by this, not kind. */
  id?: string
}

/** Token usage of the summarizer model, as reported by the backend. */
export interface CompactUsage {
  model?: string
  provider?: string
  provider_id?: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

export interface CompactResult {
  summary: string | null
  keep: number
  error?: string
  usage?: CompactUsage
}

/** Manual ``/compact`` — runs opencode-style compaction on the backend and
 *  returns the structured summary plus the number of recent turns to keep
 *  verbatim (opencode's token-budgeted tail). */
export async function triggerCompact(params: {
  provider: CompactProvider
  fallback: CompactProvider
  history: Array<{
    role: string
    content: string
    thinking?: string
    plan?: Array<{ id?: string; content: string; status: string }>
    mode?: string
    toolActivity?: Array<{
      tool: string
      args?: Record<string, unknown>
      callId?: number | string
      summary?: string
      status: string
      items?: Array<SearchResultItem | Record<string, unknown>>
      results?: Array<SearchResultItem | Record<string, unknown>>
      diff?: string
    }>
    preservedToolSummary?: string
  }>
  contextWindow?: number
  compactAtPercent?: number
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
      api_keys: params.provider.apiKeys,
      provider_id: params.provider.id ?? '',
      fallback_provider: params.fallback.kind,
      fallback_model: params.fallback.model,
      fallback_base_url: params.fallback.baseUrl,
      fallback_api_keys: params.fallback.apiKeys,
      fallback_provider_id: params.fallback.id ?? '',
      history: params.history,
      context_window: params.contextWindow ?? 0,
      compact_at_percent: params.compactAtPercent ?? 80,
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
  attachments: string[] = [],
  images: Array<{ path: string; name: string; dataUrl?: string }> = [],
  opts: { mcpServers?: Record<string, McpServerConfig>; skills?: string[] } = {},
): Promise<boolean> {
  const url = await ensureSidecar()
  if (!url) return false
  try {
    const res = await fetch(`${url}/chat/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        id,
        prompt,
        attachments,
        images,
        mcp_servers: opts.mcpServers ?? {},
        skills: opts.skills ?? [],
      }),
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

// ---- Managed on-device models (whisper / embedding / laya) ------------ //

export type ManagedModelKind = "whisper" | "embedding" | "laya"

export interface ModelDirInfo {
  repo: string
  dir: string
  size: number
  ready: boolean
}

export interface ModelRunState {
  state: "downloading" | "paused" | "error"
  repo: string
  error?: string
  /** Downloaded bytes so far (cumulative across all files). */
  downloaded_bytes?: number
  /** Estimated total size (bytes); zero means still unknown. */
  total_bytes?: number
  /** Percent 0–100 (one decimal). */
  percent?: number
  /** Live speed (bytes/sec, 5s rolling average). */
  speed_bps?: number
}

export interface ModelKindStatus {
  dirs: ModelDirInfo[]
  running?: ModelRunState
}

export interface ModelsStatus {
  whisper: ModelKindStatus
  embedding: ModelKindStatus
  laya?: ModelKindStatus
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
  if (!url) return { whisper: { dirs: [] }, embedding: { dirs: [] }, laya: { dirs: [] } }
  const res = await fetch(`${url}/models/status`)
  if (!res.ok) return { whisper: { dirs: [] }, embedding: { dirs: [] }, laya: { dirs: [] } }
  const data = (await res.json()) as ModelsStatus
  return {
    whisper: data.whisper ?? { dirs: [] },
    embedding: data.embedding ?? { dirs: [] },
    laya: data.laya ?? { dirs: [] },
  }
}

/** وضعیت تصمیم‌گیر محلی laya (نصب/آماده/ریپو/پروایدر + دلیل دقیق + وزن + پروگرس) برای Settings → Models. */
export interface LayaStatus {
  available: boolean
  ready: boolean
  repo: string
  provider?: string
  /** دلیل دقیق آماده‌نبودن: laya-not-installed | laya-weights-missing | laya-error… */
  reason?: string
  /** پوشه وزن محلی + حجم بایت. */
  weight_dir?: string
  size?: number
  /** پروگرس دانلود در حال اجرا (همان شکل ModelRunState). */
  running?: ModelRunState
}

/** خواندن وضعیت laya از سایدکار؛ در صورت قطعی، پیش‌فرض خاموش برمی‌گردد. */
export async function getLayaStatus(): Promise<LayaStatus> {
  const url = await ensureSidecar()
  const empty: LayaStatus = { available: false, ready: false, repo: '' }
  if (!url) return empty
  try {
    const res = await fetch(`${url}/models/laya-status`)
    if (!res.ok) return empty
    return { ...empty, ...((await res.json()) as Partial<LayaStatus>) }
  } catch {
    return empty
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

/** Pause a running download (downloaded bytes are kept). */
export async function pauseModelDownload(kind: ManagedModelKind): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  const res = await fetch(`${url}/models/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(
      (data as { detail?: string }).detail || `pause failed (${res.status})`,
    )
  }
}

/** Resume a paused download from where it stopped. */
export async function resumeModelDownload(kind: ManagedModelKind): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  const res = await fetch(`${url}/models/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(
      (data as { detail?: string }).detail || `resume failed (${res.status})`,
    )
  }
}

/** Stop an in-flight download; partial files stay for later resume. */
export async function cancelModelDownload(kind: ManagedModelKind): Promise<void> {
  const url = await ensureSidecar()
  if (!url) return
  const res = await fetch(`${url}/models/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(
      (data as { detail?: string }).detail || `stop failed (${res.status})`,
    )
  }
}

// ---- Skills & MCP connectors (file-based in the app's user data folder) ---- //

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
  if (!url) {
    console.error('[skills] listSkills: sidecar not available')
    return []
  }
  try {
    const res = await fetch(`${url}/skills`)
    if (!res.ok) {
      console.error(`[skills] listSkills: /skills returned ${res.status}`)
      return []
    }
    const data = (await res.json()) as { skills?: SkillRow[] }
    return data.skills ?? []
  } catch (err) {
    console.error('[skills] listSkills: fetch failed', err)
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

/** List MCP connectors (+ builtin names) from the app's user data folder. */
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

/** Save an MCP connector to the app's user data folder. */
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

/** Remove an MCP connector from the app's user data folder. */
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

// --- Checkpoints (Undo) ---------------------------------------------------

export interface CheckpointEntry {
  seq: number
  created: number
  paths: string[]
}

export interface CheckpointRestoreResult {
  seq: number
  restored: { path: string; changed: boolean }[]
  errors?: string[]
}

/** لیست snapshotهای یک chat (جدیدترین اول). */
export async function listCheckpoints(
  chatId: string,
): Promise<CheckpointEntry[]> {
  const url = await ensureSidecar()
  if (!url || !chatId) return []
  try {
    const res = await fetch(`${url}/checkpoints/${encodeURIComponent(chatId)}`)
    if (!res.ok) return []
    const body = (await res.json()) as { checkpoints?: CheckpointEntry[] }
    return body.checkpoints ?? []
  } catch {
    return []
  }
}

/** Restore یک snapshot در workspace. خطا را به‌صورت رشته برمی‌گرداند. */
export async function restoreCheckpoint(
  chatId: string,
  seq: number,
  root: string,
): Promise<{ ok: true; result: CheckpointRestoreResult } | { ok: false; error: string }> {
  const url = await ensureSidecar()
  if (!url) return { ok: false, error: "Python agent not ready" }
  try {
    const res = await fetch(
      `${url}/checkpoints/${encodeURIComponent(chatId)}/${seq}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { ok: false, error: body.detail || `restore failed (${res.status})` }
    }
    return { ok: true, result: (await res.json()) as CheckpointRestoreResult }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- Git ---------------------------------------------------------------------

export interface GitStatusEntry {
  xy: string
  path: string
  st: string
  wt: string
}

export interface GitStatus {
  branch: string
  entries: GitStatusEntry[]
  error?: string
}

export interface GitDiff {
  diff: string
  truncated: boolean
  error?: string
}

export interface GitCommitInfo {
  hash: string
  date: string
  subject: string
}

export interface GitLog {
  commits: GitCommitInfo[]
  error?: string
}

export interface GitCommitResult {
  commit: string
  summary: string
}

async function sidecarGet<T>(path: string): Promise<T | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}${path}`)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `request failed (${res.status})` }
    }
    return (await res.json()) as T
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** وضعیت working tree گیت (branch + فایل‌های تغییر یافته). */
export async function gitStatus(root: string): Promise<GitStatus | { error: string }> {
  return sidecarGet<GitStatus>(`/git/status?root=${encodeURIComponent(root)}`)
}

/** Diff تغییرات uncommitted (یا staged). */
export async function gitDiff(
  root: string,
  path = "",
  staged = false,
): Promise<GitDiff | { error: string }> {
  const q = new URLSearchParams({ root, path, staged: String(staged) })
  return sidecarGet<GitDiff>(`/git/diff?${q.toString()}`)
}

/** تاریخچه‌ی commitها (جدیدترین اول). */
export async function gitLog(root: string, limit = 20): Promise<GitLog | { error: string }> {
  const q = new URLSearchParams({ root, limit: String(limit) })
  return sidecarGet<GitLog>(`/git/log?${q.toString()}`)
}

/** Diff یک کامیت مشخص (پیش‌فرض HEAD)، اختیاری محدود به یک فایل. */
export async function gitShow(
  root: string,
  rev = "HEAD",
  path = "",
): Promise<GitDiff | { error: string }> {
  const q = new URLSearchParams({ root, rev, path })
  return sidecarGet<GitDiff>(`/git/show?${q.toString()}`)
}

/** Commit تغییرات staged (یا همه با add_all). */
export async function gitCommit(
  root: string,
  message: string,
  addAll = false,
): Promise<GitCommitResult | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, message, add_all: addAll }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, string>
    if (!res.ok) return { error: body.detail || `commit failed (${res.status})` }
    return body as unknown as GitCommitResult
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export interface GitDiscardResult {
  discarded: boolean
}

/** Discard all uncommitted changes (tracked + untracked, keeps ignored files). */
export async function gitDiscard(
  root: string,
): Promise<GitDiscardResult | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/git/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok)
      return { error: (body.detail as string) || `discard failed (${res.status})` }
    return body as unknown as GitDiscardResult
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export interface GitBranches {
  current: string
  branches: string[]
}

/** List local git branches plus the current one. */
export async function gitBranches(root: string): Promise<GitBranches | { error: string }> {
  return sidecarGet<GitBranches>(`/git/branches?root=${encodeURIComponent(root)}`)
}

/** Checkout an existing branch, or create+checkout when create is true. */
export async function gitCheckout(
  root: string,
  branch: string,
  create = false,
): Promise<{ current: string } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, branch, create }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { error: (body.detail as string) || `checkout failed (${res.status})` }
    return body as unknown as { current: string }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export interface GitAutoCommitResult {
  commit: string
  summary: string
  message: string
  /** Token usage of the commit-message call, for the sidebar Model usage panel. */
  usage?: CompactUsage
}

/** Generate a commit message with one LLM call and commit, without touching chat. */
export async function gitAutoCommit(
  root: string,
  provider: { kind: string; model: string; baseUrl: string; apiKeys: string[]; id?: string },
): Promise<GitAutoCommitResult | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/git/autocommit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root,
        provider: provider.kind,
        model: provider.model,
        base_url: provider.baseUrl,
        api_keys: provider.apiKeys,
        provider_id: provider.id ?? "",
      }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { error: (body.detail as string) || `autocommit failed (${res.status})` }
    return body as unknown as GitAutoCommitResult
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// --- زمان‌بندی تسک‌ها (مثل Codex) -------------------------------------------

export interface ScheduleUpsert {
  id?: string
  name: string
  prompt: string
  cron: string
  enabled: boolean
  root: string
  mode: string
  provider_id?: string
  model?: string
}

/** لیست تسک‌های زمان‌بندی (همراه next_run محاسبه‌شده). */
export async function listSchedules(): Promise<ScheduledTask[] | { error: string }> {
  const out = await sidecarGet<{ schedules: ScheduledTask[] }>('/schedules')
  if ('error' in out) return out
  return out.schedules ?? []
}

/** ساخت/ویرایش تسک زمان‌بندی (id خالی = ساخت جدید). */
export async function saveSchedule(
  task: ScheduleUpsert,
): Promise<ScheduledTask | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    })
    const body = (await res.json().catch(() => ({}))) as {
      schedule?: ScheduledTask
      detail?: string
    }
    if (!res.ok || !body.schedule) return { error: body.detail || `save failed (${res.status})` }
    return body.schedule
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** حذف تسک زمان‌بندی (تاریخچه اجراها نگه داشته می‌شود). */
export async function deleteSchedule(id: string): Promise<{ ok: true } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}`, { method: "DELETE" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `delete failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** اجرای دستی یک تسک (بدون انتظار برای سررسید). شناسه‌ی ران را برمی‌گرداند تا پولینگ دقیق همان اجرا ممکن شود. */
export async function runScheduleNow(id: string): Promise<{ ok: true; run_id?: string } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}/run`, { method: "POST" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `run failed (${res.status})` }
    }
    const body = (await res.json().catch(() => ({}))) as { run_id?: string }
    return typeof body.run_id === "string" && body.run_id ? { ok: true, run_id: body.run_id } : { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** تاریخچه اجراهای یک تسک (جدیدترین اول). */
export async function listScheduleRuns(
  id: string,
  limit = 20,
): Promise<ScheduleRun[] | { error: string }> {
  const out = await sidecarGet<{ runs: ScheduleRun[] }>(
    `/schedules/${encodeURIComponent(id)}/runs?limit=${limit}`,
  )
  if ('error' in out) return out
  return out.runs ?? []
}

/** پاک‌کردن چت اینباکس یک کرون: حذف همه اجراهای همان تسک. */
export async function clearScheduleRuns(
  id: string,
): Promise<{ ok: true; removed: number } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}/runs`, { method: "DELETE" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `clear failed (${res.status})` }
    }
    const body = (await res.json().catch(() => ({}))) as { removed?: number }
    return { ok: true, removed: typeof body.removed === 'number' ? body.removed : 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** حذف همه ران‌های یتیم (ران تسک‌های حذف‌شده). */
export async function clearOrphanScheduleRuns(): Promise<{ ok: true; removed: number } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedule-runs/orphans`, { method: "DELETE" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `clear failed (${res.status})` }
    }
    const body = (await res.json().catch(() => ({}))) as { removed?: number }
    return { ok: true, removed: typeof body.removed === 'number' ? body.removed : 0 }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** حذف تکی یک ران با id. */
export async function deleteScheduleRun(
  runId: string,
): Promise<{ ok: true } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: "Python agent not ready" }
  try {
    const res = await fetch(`${url}/schedule-runs/${encodeURIComponent(runId)}`, { method: "DELETE" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `delete failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** لاگ‌های چت جاری برای پنل Trace (لایا / LLM / پرامپت) با فیلتر اختیاری نوع. */
export async function getChatTraces(
  chatId: string,
  kind?: TraceKind,
): Promise<TraceEntry[] | { error: string }> {
  if (!chatId) return []
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  const out = await sidecarGet<{ traces: TraceEntry[] }>(
    `/chats/${encodeURIComponent(chatId)}/traces${q}`,
  )
  if ('error' in out) return out
  return out.traces ?? []
}

/** پاک‌کردن لاگ چت جاری. */
export async function clearChatTraces(chatId: string): Promise<{ ok: true; removed: number } | { error: string }> {
  const url = await ensureSidecar()
  if (!url || !chatId) return { error: 'Python agent not ready' }
  try {
    const res = await fetch(`${url}/chats/${encodeURIComponent(chatId)}/traces`, { method: 'DELETE' })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: body.detail || `clear failed (${res.status})` }
    }
    return (await res.json()) as { ok: true; removed: number }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** تازه‌ترین اجراهای همه تسک‌ها (برای Inbox؛ جدیدترین اول). */
export async function listAllScheduleRuns(
  limit = 50,
): Promise<ScheduleRun[] | { error: string }> {
  const out = await sidecarGet<{ runs: ScheduleRun[] }>(
    `/schedule-runs?limit=${limit}`,
  )
  if ('error' in out) return out
  return out.runs ?? []
}
