/**
 * Single source of truth for per-provider-kind metadata, shared by the store
 * (defaults), the Settings UI (labels / env-var hints / credential banner /
 * base-URL hints / OAuth) and — mirrored on the Python side by
 * `backend/providers.py::_PROVIDERS` — the sidecar.
 *
 * Adding a new provider kind is ONE entry here (plus its twin in
 * backend/providers.py) — no scattered per-kind ternaries.
 */
import type { ProviderKind } from '../types'

export interface ProviderKindMeta {
  kind: ProviderKind
  /** Label for the kind badge / picker. */
  label: string
  /** Default provider-row name. */
  name: string
  /** Default env-var name stored for this kind ('' = none). */
  defaultEnvVar: string
  /** Every env-var name this kind accepts (shown as hints to the user). */
  envVars: string[]
  /** True = the provider can never run without a credential (env var or saved
   *  key); the UI blocks Save and the backend refuses to build the model. */
  requiresKey: boolean
  /** True = a fixed, built-in provider (no editable name, shown by default). */
  builtin: boolean
  /** True = runs locally with no network credential (ollama). */
  local?: boolean
  /** True = the user can enter a custom Base URL (custom / ollama). */
  editableBaseUrl?: boolean
  /** Read-only base-URL hint shown for built-in providers. */
  baseUrlHint?: string
  /** Default base URL for built-in providers (used when user doesn't override). */
  defaultBaseUrl?: string
  /** True = supports Google-style OAuth sign-in. */
  oauth?: boolean
  /** True = model ids carry no provider prefix (opencode). */
  unprefixedModelId?: boolean
  /** Extra hint line (e.g. an account id env var also required). */
  extraHint?: string
}

export const PROVIDER_META: Record<ProviderKind, ProviderKindMeta> = {
  opencode: {
    kind: 'opencode',
    label: 'opencode gateway',
    name: 'opencode',
    defaultEnvVar: 'OPENCODE_API_KEY',
    envVars: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
    requiresKey: false,
    builtin: true,
    unprefixedModelId: true,
    baseUrlHint: 'https://opencode.ai/zen/v1 — routed via the opencode gateway (never OpenRouter).',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    name: 'OpenRouter',
    defaultEnvVar: 'OPENROUTER_API_KEY',
    envVars: ['OPENROUTER_API_KEY'],
    requiresKey: true,
    builtin: true,
    baseUrlHint: 'https://openrouter.ai/api/v1',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  google: {
    kind: 'google',
    label: 'Google',
    name: 'Google',
    defaultEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    envVars: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    requiresKey: true,
    builtin: true,
    oauth: true,
    baseUrlHint: 'https://generativelanguage.googleapis.com/v1beta/openai — Gemini models via Google.',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  nvidia: {
    kind: 'nvidia',
    label: 'NVIDIA',
    name: 'NVIDIA',
    defaultEnvVar: 'NVIDIA_API_KEY',
    envVars: ['NVIDIA_API_KEY'],
    requiresKey: true,
    builtin: true,
    baseUrlHint: 'https://integrate.api.nvidia.com/v1 — NVIDIA NIM hosted models.',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  cloudflare: {
    kind: 'cloudflare',
    label: 'Cloudflare',
    name: 'Cloudflare',
    defaultEnvVar: 'CLOUDFLARE_AUTH_TOKEN',
    envVars: ['CLOUDFLARE_AUTH_TOKEN', 'CLOUDFLARE_API_TOKEN'],
    requiresKey: true,
    builtin: true,
    baseUrlHint: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1 — Workers AI.',
    extraHint: 'Also requires CLOUDFLARE_ACCOUNT_ID in your environment.',
    defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
  },
  tokenrouter: {
    kind: 'tokenrouter',
    label: 'TokenRouter',
    name: 'TokenRouter',
    defaultEnvVar: 'TOKEN_ROUTER_API_KEY',
    envVars: ['TOKEN_ROUTER_API_KEY', 'TOKENROUTER_API_KEY'],
    requiresKey: true,
    builtin: true,
    baseUrlHint: 'https://api.tokenrouter.com/v1 — unified AI model hub.',
    defaultBaseUrl: 'https://api.tokenrouter.com/v1',
  },
  ollama: {
    kind: 'ollama',
    label: 'local',
    name: 'local',
    defaultEnvVar: '',
    envVars: [],
    requiresKey: false,
    builtin: true,
    local: true,
    editableBaseUrl: true,
  },
  custom: {
    kind: 'custom',
    label: 'Custom API',
    name: 'Custom API',
    defaultEnvVar: '',
    envVars: [],
    requiresKey: false,
    builtin: false,
    editableBaseUrl: true,
  },
}

export function providerMeta(kind: ProviderKind | undefined | null): ProviderKindMeta {
  return PROVIDER_META[kind ?? 'custom'] ?? PROVIDER_META.custom
}
