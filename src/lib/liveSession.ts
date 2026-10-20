// Live voice session mode: which pipeline live voice runs on.
//
// Live voice must work with ANY provider, not only OpenAI. There are two
// pipelines and the choice is made from settings, never hardcoded:
//
//  1. 'realtime' — full-duplex speech-to-speech over a WebSocket (the ChatGPT
//     Live shape). Used when the user picked a realtime-capable provider
//     (Settings → Media Providers → Live voice). Any endpoint that speaks the
//     OpenAI-compatible realtime protocol works: OpenAI, OpenRouter, LiteLLM,
//     vLLM, Azure-style gateways, self-hosted proxies.
//
//  2. 'chunked' — the provider-agnostic fallback: mic PCM cut into overlapping
//     chunks -> /transcribe -> chat turn -> progressive TTS. Only needs the
//     STT/TTS settings that already exist, so it works with literally any
//     provider or model, including ones with no realtime support at all.
//
// The fallback is also the recovery path: if minting a realtime session fails
// (provider has no /realtime endpoint, missing key, bad model), the caller
// retries on 'chunked' instead of surfacing a dead live button.

export type LiveMode = 'realtime' | 'chunked'

/** Everything the realtime session mint needs, resolved from settings. */
export interface RealtimeTarget {
  kind: string
  baseUrl: string
  apiKeys: string[]
  model: string
  voice: string
}

/** Minimal provider shape needed to build a realtime target. */
export interface RealtimeProviderLike {
  kind: string
  baseUrl?: string
}

/**
 * Build the realtime mint target for the configured live-voice provider.
 *
 * Returns null when the setting cannot produce a usable session — no provider
 * selected, provider gone, no base URL, no model — and the caller then runs the
 * chunked pipeline, which needs none of these. An empty API key list is passed
 * through on purpose: local/self-hosted gateways may accept unauthenticated
 * realtime sessions, and if the mint rejects it the caller falls back anyway.
 */
export function buildRealtimeTarget(
  provider: RealtimeProviderLike | undefined,
  apiKeys: ReadonlyArray<string> | undefined,
  liveModel: string | undefined,
  liveVoice: string | undefined,
): RealtimeTarget | null {
  if (!provider) return null
  const kind = (provider.kind ?? '').trim()
  const baseUrl = (provider.baseUrl ?? '').trim()
  // The Rust mint rejects an empty model outright, so require it here and let
  // the chunked pipeline handle the "not configured yet" case.
  const model = (liveModel ?? '').trim()
  if (!kind || !baseUrl || !model) return null
  return {
    kind,
    baseUrl,
    apiKeys: (apiKeys ?? []).filter((k) => typeof k === 'string' && k.trim() !== ''),
    model,
    voice: (liveVoice ?? '').trim(),
  }
}

/**
 * Resolve which pipeline live voice should start on.
 *
 * `providerFound` distinguishes "nothing configured" from "configured but the
 * provider was deleted", so a stale id never produces a realtime attempt.
 */
export function resolveLiveMode(
  liveProviderId: string | undefined,
  providerFound: boolean,
): LiveMode {
  const id = (liveProviderId ?? '').trim()
  return id && providerFound ? 'realtime' : 'chunked'
}

/**
 * Merge one live transcript payload into the text accumulated so far.
 *
 * Realtime gateways disagree about the shape of the same event: some send the
 * FULL transcript so far, some send only the new delta, some repeat the tail.
 * All three are handled here so the mirrored chat bubble reads correctly
 * whichever server is behind the endpoint.
 */
export function mergeLiveTranscript(accumulated: string, incoming: string): string {
  const prev = accumulated ?? ''
  const next = incoming ?? ''
  if (!next) return prev
  if (!prev) return next
  // Cumulative payload: it already contains everything we had.
  if (next.startsWith(prev)) return next
  // Delta we already applied: keep what we have instead of duplicating it.
  if (prev.endsWith(next)) return prev
  // Genuine delta: deltas arrive at word or character granularity, so they are
  // concatenated verbatim (no injected separator, which would split a word a
  // character-level gateway is still building).
  return `${prev}${next}`
}

/**
 * Resolve the text of a FINAL transcript event.
 *
 * The `.done` payload is normally the complete transcript, but gateways that
 * only stream deltas send just the trailing fragment there. Trust the final
 * payload when it is at least as long as what was streamed; otherwise keep the
 * accumulation, so no gateway can truncate the visible transcript.
 */
export function finalizeLiveTranscript(accumulated: string, finalPayload: string): string {
  const acc = (accumulated ?? '').trim()
  const fin = (finalPayload ?? '').trim()
  if (!fin) return acc
  if (!acc) return fin
  if (fin.length >= acc.length) return fin
  return mergeLiveTranscript(acc, fin).trim()
}
