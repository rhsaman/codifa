/**
 * Encrypts secrets (API keys / OAuth client id + secret / refresh tokens) at
 * rest in settings.json. The AES-256-GCM key is owned by the Electron main
 * process (kept wrapped by the OS keychain via `safeStorage`) and handed to the
 * renderer over IPC; the Python sidecar receives the same key via its
 * `CODER_SECRET_KEY` env var. The key only ever exists in memory at runtime.
 *
 * Values are stored as `enc:v1:<base64(iv)>.<base64(ciphertext+tag)>`. Anything
 * without the prefix is treated as legacy plaintext (existing settings files).
 */
import type { Settings, ProviderConfig, SearchPluginConfig } from '../types'

const PREFIX = 'enc:v1:'

let keyPromise: Promise<CryptoKey | null> | null = null

function getKey(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    try {
      const b64 = await window.coder.secretsGetKey()
      if (!b64) return null
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    } catch {
      return null
    }
  })()
  return keyPromise
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(u8: Uint8Array): string {
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encrypt a secret for storage. Empty strings and failures pass through. */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return ''
  const k = await getKey()
  if (!k) return plain
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new Uint8Array(enc.encode(plain))))
    return `${PREFIX}${toB64(iv)}.${toB64(ct)}`
  } catch {
    return plain
  }
}

/** Decrypt a stored secret. Legacy plaintext passes through untouched. */
export async function decryptSecret(val: string): Promise<string> {
  if (!val || !val.startsWith(PREFIX)) return val
  const k = await getKey()
  if (!k) return ''
  try {
    const body = val.slice(PREFIX.length)
    const sep = body.indexOf('.')
    const iv = fromB64(body.slice(0, sep))
    const ct = fromB64(body.slice(sep + 1))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct)
    return dec.decode(pt)
  } catch {
    // Undecryptable (key rotated / keychain moved) — treat as empty rather than
    // leak the ciphertext into the UI or a token request.
    return ''
  }
}

const SECRET_KEYS = ['apiKey', 'oauthClientId', 'oauthClientSecret', 'oauthRefreshToken'] as const

async function encryptProvider(p: ProviderConfig): Promise<ProviderConfig> {
  const out: ProviderConfig = { ...p }
  for (const key of SECRET_KEYS) {
    const v = (out as unknown as Record<string, string | undefined>)[key]
    ;(out as unknown as Record<string, string>)[key] = await encryptSecret(v || '')
  }
  return out
}

async function decryptProvider(p: ProviderConfig): Promise<ProviderConfig> {
  const out: ProviderConfig = { ...p }
  for (const key of SECRET_KEYS) {
    const v = (out as unknown as Record<string, string | undefined>)[key]
    ;(out as unknown as Record<string, string>)[key] = await decryptSecret(v || '')
  }
  return out
}

/** Encrypt every secret field in a settings payload before it is persisted. */
export async function encryptSettings(raw: Settings): Promise<Settings> {
  const providers = Array.isArray(raw.providers)
    ? await Promise.all(raw.providers.map(encryptProvider))
    : raw.providers
  const searchConsole = raw.searchConsole
    ? {
        ...raw.searchConsole,
        clientId: await encryptSecret(raw.searchConsole.clientId || ''),
        clientSecret: await encryptSecret(raw.searchConsole.clientSecret || ''),
        refreshToken: await encryptSecret(raw.searchConsole.refreshToken || ''),
      }
    : raw.searchConsole
  const searchPlugins = Array.isArray(raw.searchPlugins)
    ? await Promise.all(
        raw.searchPlugins.map(async (p: SearchPluginConfig) => ({ ...p, apiKey: await encryptSecret(p.apiKey || '') })),
      )
    : raw.searchPlugins
  return { ...raw, providers, searchConsole, searchPlugins }
}

/** Decrypt every secret field in settings loaded from disk. */
export async function decryptSettings(raw: Partial<Settings> & { provider?: ProviderConfig }): Promise<
  Partial<Settings> & { provider?: ProviderConfig }
> {
  if (!raw || typeof raw !== 'object') return raw
  const providers = Array.isArray(raw.providers)
    ? await Promise.all(raw.providers.map(decryptProvider))
    : raw.providers
  const searchConsole = raw.searchConsole
    ? {
        ...raw.searchConsole,
        clientId: await decryptSecret(raw.searchConsole.clientId || ''),
        clientSecret: await decryptSecret(raw.searchConsole.clientSecret || ''),
        refreshToken: await decryptSecret(raw.searchConsole.refreshToken || ''),
      }
    : raw.searchConsole
  const searchPlugins = Array.isArray(raw.searchPlugins)
    ? await Promise.all(
        raw.searchPlugins.map(async (p: SearchPluginConfig) => ({ ...p, apiKey: await decryptSecret(p.apiKey || '') })),
      )
    : raw.searchPlugins
  const provider = raw.provider
    ? { ...raw.provider, apiKey: await decryptSecret(raw.provider.apiKey || '') }
    : raw.provider
  return { ...raw, providers, searchConsole, searchPlugins, provider }
}
