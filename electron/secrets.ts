import { app, ipcMain, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * Per-installation AES-256-GCM key used to encrypt API keys / OAuth secrets at
 * rest in settings.json. The key itself never sits in plaintext on disk: it is
 * stored wrapped by Electron `safeStorage` (macOS Keychain / Windows DPAPI /
 * Linux kwallet) as `<userData>/secrets.key`. The same key is handed to the
 * renderer (via `secrets:getKey` IPC) and to the Python sidecar (via the
 * `CODER_SECRET_KEY` env var) so both sides can encrypt/decrypt — and the key
 * only ever exists in memory at runtime.
 */

const PREFIX_ENCRYPTED = 'enc:'
const PREFIX_PLAIN = 'raw:'

let cachedKey: string | null = null

function keyFile(): string {
  return path.join(app.getPath('userData'), 'secrets.key')
}

function writeKeyFile(content: string): void {
  const file = keyFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, { mode: 0o600 })
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* best effort */
    }
  } catch {
    /* best effort — will regenerate next launch */
  }
}

/** The base64 32-byte AES key (lazily generated + safeStorage-wrapped once). */
export function getSecretsKey(): string {
  if (cachedKey) return cachedKey
  const file = keyFile()
  let b64 = ''
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim()
      if (raw.startsWith(PREFIX_ENCRYPTED)) {
        const inner = raw.slice(PREFIX_ENCRYPTED.length)
        if (safeStorage.isEncryptionAvailable()) {
          b64 = safeStorage.decryptString(Buffer.from(inner, 'base64'))
        }
      } else if (raw.startsWith(PREFIX_PLAIN)) {
        b64 = raw.slice(PREFIX_PLAIN.length)
      }
    } catch {
      /* undecryptable (e.g. keychain unavailable) → regenerate below */
    }
  }
  if (!b64 || b64.length < 16) {
    b64 = crypto.randomBytes(32).toString('base64')
    try {
      if (safeStorage.isEncryptionAvailable()) {
        writeKeyFile(`${PREFIX_ENCRYPTED}${safeStorage.encryptString(b64).toString('base64')}`)
      } else {
        console.warn('[secrets] OS keychain unavailable (e.g. headless Linux) — storing the encryption key with file permissions only (0600) instead of safeStorage.')
        writeKeyFile(`${PREFIX_PLAIN}${b64}`)
      }
    } catch {
      console.warn('[secrets] safeStorage encrypt failed — storing the encryption key with file permissions only (0600) instead of safeStorage.')
      writeKeyFile(`${PREFIX_PLAIN}${b64}`)
    }
  }
  cachedKey = b64
  return b64
}

/** Register the IPC channel the renderer uses to fetch the encryption key. */
export function registerSecretsIpc(): void {
  ipcMain.handle('secrets:getKey', () => getSecretsKey())
}
