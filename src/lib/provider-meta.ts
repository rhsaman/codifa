/**
 * Single source of truth for per-provider-kind metadata, shared by the store
 * (defaults), the Settings UI (labels / env-var hints / credential banner /
 * base-URL hints) and — mirrored on the Python side by
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
  /** Read-only base-URL hint shown for built-in providers (just the URL). */
  baseUrlHint?: string
  /** Optional description shown below the base-URL hint. */
  baseUrlDesc?: string
  /** Default base URL for built-in providers (used when user doesn't override). */
  defaultBaseUrl?: string
  /** Extra hint line (e.g. an account id env var also required). */
  extraHint?: string
}

export const PROVIDER_META: Record<ProviderKind, ProviderKindMeta> = {
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
    baseUrlHint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlDesc: 'Gemini models via Google.',
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
    baseUrlHint: 'https://integrate.api.nvidia.com/v1',
    baseUrlDesc: 'NVIDIA NIM hosted models.',
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
    baseUrlHint: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1',
    baseUrlDesc: 'Workers AI.',
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
    baseUrlHint: 'https://api.tokenrouter.com/v1',
    baseUrlDesc: 'Unified AI model hub.',
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
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic-compatible',
    name: 'Anthropic',
    defaultEnvVar: 'ANTHROPIC_API_KEY',
    envVars: ['ANTHROPIC_API_KEY'],
    requiresKey: true,
    builtin: false,
    editableBaseUrl: true,
    baseUrlHint: 'https://api.anthropic.com',
    baseUrlDesc: 'Native Anthropic protocol (/v1/messages, x-api-key). Works with any Anthropic-compatible gateway.',
  },
}

export function providerMeta(kind: ProviderKind | undefined | null): ProviderKindMeta {
  return PROVIDER_META[kind ?? 'custom'] ?? PROVIDER_META.custom
}

/** Built-in provider kind ids that are known to act as a model-id prefix
 *  on the wire (e.g. OpenRouter returns "openai/gpt-4o"). A model id that
 *  starts with `${kind}/` therefore
 *  belongs to THAT provider's catalog and must not be rendered under a
 *  different provider — even if it has been persisted into the wrong
 *  provider row (e.g. a stale recentModels entry migrated onto another
 *  provider, or a hand-edited `p.models` list).
 *
 *  This is intentionally a fixed set of built-in kind ids, NOT derived
 *  from per-user `p.id` values, because the user is free to rename their
 *  provider row ("my-openrouter"); only the kind id is authoritative.
 *
 *  `opencode` is included even though the kind was removed (rows migrate
 *  to `custom`): model ids prefixed `opencode/...` still circulate in
 *  persisted lists and must stay classifiable as a gateway identity.
 */
export const FOREIGN_PROVIDER_PREFIXES: ReadonlySet<string> = new Set([
  ...Object.keys(PROVIDER_META),
  'opencode',
])

/** Kinds that aggregate multi-vendor catalogs. Their wire ids are routinely
 *  vendor-namespaced ("google/gemini-2.5-flash", "anthropic/claude-…",
 *  "nvidia/nemotron-…") — prefixes that collide with our own kind ids but
 *  are legitimate entries in that row's catalog, not cross-row contamination. */
const AGGREGATOR_KINDS: ReadonlySet<string> = new Set(['openrouter', 'tokenrouter'])

/** Kind ids used as VENDOR namespaces on aggregator/host wire ids. These get
 *  the multi-vendor exemption; gateway/client identities (opencode, ollama,
 *  custom) stay foreign even on those rows. */
const VENDOR_NAMESPACE_KINDS: ReadonlySet<string> = new Set([
  'google',
  'anthropic',
  'nvidia',
  'cloudflare',
])

/** True when the row is (or points at) a multi-vendor aggregator, so
 *  kind-colliding vendor prefixes in its catalog must not be filtered. */
function isAggregatorRow(p: { id: string; kind?: string; baseUrl?: string }): boolean {
  if (p.kind && AGGREGATOR_KINDS.has(p.kind)) return true
  // Test mocks / legacy rows often carry the kind only in `id`.
  if (AGGREGATOR_KINDS.has(p.id)) return true
  // Custom rows pointed at a known aggregator gateway have the same catalog shape.
  const base = (p.baseUrl || '').toLowerCase()
  return base.includes('openrouter.ai') || base.includes('tokenrouter.com')
}

/** Kind-colliding prefixes this row may legitimately contain in its OWN
 *  catalog (empty/null = none — foreign prefixes are filtered as usual).
 *
 *  - Aggregators (OpenRouter / TokenRouter, kind or baseUrl): every vendor
 *    namespace above, plus their own wire prefix (custom→openrouter.ai
 *    returns "openrouter/auto" — head !== p.id after bareModel).
 *  - NVIDIA NIM: hosts Google Gemma as "google/gemma-*" — the same head as
 *    the Google provider row, so "google" must stay visible here. */
function allowedVendorPrefixes(p: {
  id: string
  kind?: string
  baseUrl?: string
}): ReadonlySet<string> {
  if (isAggregatorRow(p)) {
    const own = new Set<string>(VENDOR_NAMESPACE_KINDS)
    if (p.kind && AGGREGATOR_KINDS.has(p.kind)) own.add(p.kind)
    if (AGGREGATOR_KINDS.has(p.id)) own.add(p.id)
    const base = (p.baseUrl || '').toLowerCase()
    if (base.includes('openrouter.ai')) own.add('openrouter')
    if (base.includes('tokenrouter.com')) own.add('tokenrouter')
    return own
  }
  if (p.kind === 'nvidia' || p.id === 'nvidia') return new Set(['google'])
  return new Set()
}

/** True when a BARE model id (already passed through `bareModel` so any
 *  redundant `${p.id}/` prefix is stripped) belongs to a DIFFERENT known
 *  provider kind, and therefore must not be rendered under this provider.
 *
 *  Examples (all under p.id = "local"):
 *    "google/gemini-2.5"     → head = "google" ∈ prefixes, head !== p.id → FOREIGN
 *    "nvidia/foo"            → head = "nvidia"   ∈ prefixes, head !== p.id → FOREIGN
 *    "llama3"                → no slash                              → INTERNAL
 *    "meta-llama/llama-3.1"  → head = "meta-llama", unknown kind     → INTERNAL
 *    "local/foo"             → head = "local",   head === p.id       → INTERNAL
 *
 *  Multi-vendor host rows keep kind-colliding prefixes that appear in their
 *  OWN live catalogs (not cross-row leakage):
 *    openrouter + "anthropic/claude-…" → INTERNAL (OpenRouter sells Claude)
 *    openrouter + "google/gemini-…"    → INTERNAL
 *    nvidia     + "google/gemma-…"     → INTERNAL (NIM hosts Gemma)
 *    openrouter + "opencode/foo"       → FOREIGN  (gateway id, never a vendor)
 *    nvidia     + "openrouter/sonnet"  → FOREIGN  (not in NIM's catalog)
 *
 *  Why run on `b` (after bareModel) and not on the raw `m`? Because a
 *  stored entry may carry a doubled prefix that the raw check would miss:
 *    m = "local/google/gemini-2.5", p.id = "local"
 *    raw:   head = "local"   === p.id → not foreign (WRONG, leaks through)
 *    b  = "google/gemini-2.5"
 *    bare:  head = "google" ∈ prefixes, head !== p.id → foreign ✓
 *
 *  This is intentionally stricter than "starts with any `${providerId}/`":
 *  we only flag KNOWN kind prefixes, so nvidia's own catalog entries like
 *  "meta-llama/llama-3.1-70b-instruct" (which carry a slash but no known
 *  provider prefix) are kept. */
export function isForeignModelId(
  p: { id: string; kind?: string; baseUrl?: string },
  b: string,
): boolean {
  const slash = b.indexOf('/')
  if (slash <= 0) return false
  const head = b.slice(0, slash)
  if (head === p.id) return false
  if (!FOREIGN_PROVIDER_PREFIXES.has(head)) return false
  if (allowedVendorPrefixes(p).has(head)) return false
  return true
}
