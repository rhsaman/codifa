
export type ProviderKind = 'openrouter' | 'ollama' | 'custom' | 'google' | 'nvidia' | 'cloudflare' | 'anthropic'

export type AgentMode = string

/** A recently used model, tied to the provider it was used on so it can be
 *  re-selected unambiguously (models are shown as provider/model). */
export interface RecentModel {
  providerId: string
  model: string
  /** Epoch ms when this model was last used — used to sort recents by usage time. */
  lastUsed?: number
  /** مدل پین‌شده همیشه بالای لیست اخیر می‌ماند و از حذف خودکار مصون است (سقف ۵). */
  pinned?: boolean
}

/** مدلی که تستش سبز (✓) بوده — لیست ماندگار تب «Checked» پیکر مدل. در
 *  settings ذخیره می‌شود تا بعد از ری‌استارت هم تب همان مدل‌ها را نشان دهد؛
 *  با تست مجدد ناموفق یا حذف دستی (✕) از لیست خارج می‌شود. */
export interface CheckedModel {
  providerId: string
  model: string
  /** Epoch ms of the last passing test. */
  lastOkAt?: number
}

/** Per-mode tool access. Sent to the backend so tool gating is data-driven
 *  instead of hardcoded to mode names — lets anyone add custom modes. */
export interface ModeCapabilities {
  readFiles: boolean // list / search (grep/glob)
  writeFiles: boolean // write_file / edit_file
  runTerminal: boolean // run_terminal
  web: boolean // web_search / fetch_url
}

/** One agent mode: built-in (ask / plan / build) or user-created. */
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
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export interface ProviderHeader {
  key: string
  value: string
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  /** Ordered API keys, top = tried first (9router-style fallback). */
  apiKeys: string[]
  /** Legacy single key (migrated into apiKeys on load). */
  apiKey?: string
  /** Extra request headers sent verbatim with every call to this provider —
   *  for gateways that only answer their own client (OpenCode Zen and its
   *  `x-opencode-*` signature). Values are encrypted at rest like the keys. */
  headers?: ProviderHeader[]
  baseUrl: string
  /** Account id of an account-scoped gateway (Cloudflare): its base URL is
   *  built from this id, so it is the field the user fills in. */
  accountId?: string
  model: string
  enabled?: boolean
  /** شرکت‌دادن پروایدر در «تست گروهی» (Recent / Checked / نتایج جستجو / تست همهٔ
   *  مدل‌های پروایدر). `false` = از تست گروهی کنار گذاشته می‌شود ولی تست تکیِ
   *  هر مدلش همچنان کار می‌کند. نبودِ مقدار = روشن (پیش‌فرض). */
  groupTest?: boolean
  /** Live per-model context windows (tokens) reported by the provider's /models endpoint. */
  contextMap?: Record<string, number>
  /** مقادیر دستی کانتکست که کاربر برای مدل‌های کاستوم وارد کرده؛ بر contextMap اولویت دارد. */
  manualContextMap?: Record<string, number>
  /** مقادیر دستی reasoning که کاربر برای مدل‌ها وارد کرده؛ بر reasoningMap و
   *  heuristic نام مدل اولویت دارد. */
  manualReasoningMap?: Record<string, boolean>
  /** Live per-model image-input capability, reported by the provider's
   *  `/models` payload or the models.dev catalog (`modalities.input` contains
   *  `image`). Absent means UNKNOWN: the composer sends the images to the main
   *  model and only falls back to the Vision slot when the provider rejects
   *  them. */
  visionMap?: Record<string, boolean>
  /** مقادیر دستی vision که کاربر برای مدل‌ها وارد کرده؛ بر visionMap اولویت
   *  دارد. */
  manualVisionMap?: Record<string, boolean>
  /** Live per-model USD-per-million-token pricing reported by the provider's /models endpoint. */
  pricingMap?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  reasoningMap?: Record<string, boolean>
  /** Reasoning capability LEARNED from the model's own output: its response
   *  streamed reasoning content, so this provider+model demonstrably reasons.
   *  Only `true` is ever recorded — a call that produced no reasoning proves
   *  nothing, since a short prompt need not trigger it. Kept apart from
   *  `reasoningMap` because a `/models` fetch replaces that map wholesale and
   *  would erase observed facts. This is how a gateway that describes no
   *  capability at all — NVIDIA NIM reports only `id`/`object`/`created`/
   *  `owned_by` — still ends up with exactly the right models marked, with no
   *  model list anywhere in the code. */
  observedReasoningMap?: Record<string, boolean>
  /** Thinking LEVELS each model really supports, as the provider /models payload
   *  or the models.dev catalog reported them (e.g. `['none','high']` for a model
   *  whose gateway says thinking is a plain switch). A missing key means NO
   *  source described that model, so the composer keeps its full list rather
   *  than hiding options nobody ruled out; an empty array means the model has no
   *  thinking mode at all. */
  thinkingLevelsMap?: Record<string, ThinkingLevel[]>
  thinkingLevel?: ThinkingLevel
  models?: string[]
  /** Models the user explicitly removed; hidden from the live /models catalog. */
  removedModels?: string[]
  /** Models the user manually added; always kept even when the live /models
   *  catalog is unreachable or doesn't list them (e.g. a gateway that hides
   *  its catalog from unknown clients). */
  addedModels?: string[]
}

/** One STT fallback target: 'local' = on-device Whisper, otherwise a settings.providers id. */
export interface SttFallback {
  providerId: string
  model: string
}

/** One TTS fallback target: a settings.providers id plus model/voice. */
export interface TtsFallback {
  providerId: string
  model: string
  voice: string
}

/** One tool-model fallback target: "providerId/model", tried in list order when
 *  the tool's OWN model fails. It never carries its own reasoning level — a
 *  fallback always runs at the reasoning effort of the tool it stands in for. */
export interface ToolFallback {
  providerId: string
  model: string
}

/** One image/video-generation fallback target: a settings.providers id plus the
 *  model id that target serves. Same shape as a tool fallback, kept as its own
 *  type because the media slots resolve keys per provider kind (OpenAI-compatible
 *  vs Google), not per reasoning level. */
export interface MediaFallback {
  providerId: string
  model: string
}

/** Live voice session state for the realtime speech-to-speech UI. */
export type LiveVoiceState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error'

/** Request for a realtime voice session (ephemeral token mint). */
export interface RealtimeSessionRequest {
  kind: string
  baseUrl: string
  apiKeys?: string[]
  model?: string
  voice?: string
}

/** Ephemeral realtime session minted by the sidecar (never contains the master key). */
export interface RealtimeSessionResponse {
  ephemeralToken: string
  websocketUrl: string
  expiresAt: string
}

