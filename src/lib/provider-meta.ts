/**
 * Single source of truth for per-provider-kind metadata, shared by the store
 * (defaults), the Settings UI (labels / credential banner /
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
  /** True = the provider can never run without a credential (a saved
   *  key); the UI blocks Save and the backend refuses to build the model. */
  requiresKey: boolean
  /** True = a fixed, built-in provider (no editable name, shown by default). */
  builtin: boolean
  /** True = runs locally with no network credential (ollama). */
  local?: boolean
  /** True = the user can enter a custom Base URL (custom / ollama). */
  editableBaseUrl?: boolean
  /** True = the Settings form lets the user type a model id by hand AND (this
   *  flag) its context window in tokens. Only kinds whose /models endpoint
   *  can't be trusted to report a window need it (custom gateways); built-in
   *  providers get their window from models.dev automatically. */
  manualContextInput?: boolean
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
    requiresKey: true,
    builtin: true,
    baseUrlHint: 'https://openrouter.ai/api/v1',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  google: {
    kind: 'google',
    label: 'Google',
    name: 'Google',
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
    requiresKey: false,
    builtin: true,
    local: true,
    editableBaseUrl: true,
  },
  custom: {
    kind: 'custom',
    label: 'Custom API',
    name: 'Custom API',
    requiresKey: false,
    builtin: false,
    editableBaseUrl: true,
    manualContextInput: true,
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic-compatible',
    name: 'Anthropic',
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
 *  kind-colliding vendor prefixes in its catalog must not be filtered.
 *
 *  ردیف‌های custom هم شامل می‌شوند: یک endpoint دلخواه (مثل 9router که
 *  nvidia/*، gemini/*، groq/* و … را زیر یک baseUrl واحد عرضه می‌کند)
 *  هیچ سیگنال قابل اتکایی از kind برای تک‌فروشنده بودن ندارد، پس
 *  prefixهای فروشنده‌ی شناخته‌شده در آن‌ها فیلتر نمی‌شوند. هویت‌های
 *  گیت‌وی (openrouter، ollama، opencode، …) همچنان خارجی می‌مانند مگر
 *  baseUrl خود ردیف به همان گیت‌وی اشاره کند.
 *
 *  تشخیص ساختاری است (kind / id ردیف) — نه تطبیق آدرس یا پورت (نه
 *  localhost، نه شماره‌ی سرور). معادل تشخیص «بر اساس شناسه‌های زندهٔ
 *  کاتالوگ» (cl/… ، nvidia/…) است: چون این فیلتر روی همان لیستِ ذخیره‌شده
 *  از کاتالوگ زنده اجرا می‌شود، اجازه دادن به headهای موجود در خود لیست
 *  عملاً no-op است و فقط بررسی‌های pre-add (قبل از persist) را می‌شکند؛
 *  پس قاعده به صورت ساختاری و یک‌جا اینجا تعریف می‌شود. */
function isAggregatorRow(p: { id: string; kind?: string; baseUrl?: string }): boolean {
  if (p.kind && AGGREGATOR_KINDS.has(p.kind)) return true
  // Test mocks / legacy rows often carry the kind only in `id`.
  if (AGGREGATOR_KINDS.has(p.id)) return true
  // Custom rows are arbitrary gateways (multi-vendor by nature).
  if (p.kind === 'custom') return true
  if (p.id === 'custom' || p.id.startsWith('custom-')) return true
  // Other kinds pointed at a known aggregator gateway share the catalog shape.
  const base = (p.baseUrl || '').toLowerCase()
  return base.includes('openrouter.ai') || base.includes('tokenrouter.com')
}

/** Kind-colliding prefixes this row may legitimately contain in its OWN
 *  catalog (empty/null = none — foreign prefixes are filtered as usual).
 *
 *  - Aggregators (OpenRouter / TokenRouter, kind or baseUrl) و ردیف‌های
 *    custom (گیت‌وی چندفروشنده‌ی دلخواه مثل 9router): every vendor
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
