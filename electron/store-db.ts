import { app } from 'electron'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

/**
 * App state store (settings + chats + plans + skills + MCP connectors).
 * This module owns the location logic: resolves the configurable "Data path"
 * (default ~/.codefa), boots it, and moves all app data when the user changes
 * the path in Settings.
 *
 * User data lives as PLAIN FILES under the data root (owned by the sidecar's
 * backend/state_db.py): settings.json, chats/<workspace>/<chat-id>.json,
 * plan/<workspace>/<chat-id>/plan.md, skills/<slug>/skill.md, mcp/<name>.json.
 * The only SQLite that remains is the RAG vector store under <root>/vector-db
 * (per-workspace .sqlite files), so moving the root relocates everything the
 * app owns.
 */

const DEFAULT_DATA_DIR = '.codefa'
/** The pre-1.2 default root; copied into the new default on first launch
 *  (non-destructively) so existing users keep their data after the rename. */
const LEGACY_DATA_DIR = '.coder'
let cachedRoot: string | null = null

function pointerFile(): string {
  return path.join(app.getPath('userData'), 'data-root.json')
}

/** Alias for getDataRoot() — resolves the active data root, creating it. */
export function resolveDataPath(): string {
  return getDataRoot()
}

/** The active data root (default ~/.codefa unless the user moved it). */
export function getDataRoot(): string {
  if (cachedRoot) return cachedRoot
  try {
    if (fs.existsSync(pointerFile())) {
      const raw = JSON.parse(fs.readFileSync(pointerFile(), 'utf-8')) as { path?: string }
      if (raw && typeof raw.path === 'string' && raw.path.trim()) {
        cachedRoot = path.resolve(raw.path)
        fs.mkdirSync(cachedRoot, { recursive: true })
        return cachedRoot
      }
    }
  } catch {
    /* corrupt/unreadable pointer → fall back to default */
  }
  cachedRoot = path.join(os.homedir(), DEFAULT_DATA_DIR)
  migrateLegacyRootOnce()
  try {
    fs.mkdirSync(cachedRoot, { recursive: true })
  } catch {
    /* best effort */
  }
  return cachedRoot
}

/**
 * One-time, non-destructive migration from the old ~/.coder default. When the
 * user never picked a custom data path and the new default doesn't exist yet,
 * the legacy root is COPIED into it (never moved/deleted — the old folder is
 * left intact so nothing can be lost). Runs at most once in practice: the
 * second launch already finds the new root in place.
 */
function migrateLegacyRootOnce(): void {
  if (!cachedRoot) return
  if (fs.existsSync(cachedRoot)) return // already migrated or fresh
  const legacy = path.join(os.homedir(), LEGACY_DATA_DIR)
  if (legacy === cachedRoot || !fs.existsSync(legacy)) return
  try {
    copyTree(legacy, cachedRoot)
  } catch {
    /* best effort — an empty new root is fine; data stays in ~/.coder */
  }
}

/** Persist the new data root so the next launch finds the same DB. */
export function setDataRoot(root: string): string {
  const abs = path.resolve(root)
  fs.mkdirSync(abs, { recursive: true })
  cachedRoot = abs
  try {
    fs.writeFileSync(
      pointerFile(),
      JSON.stringify({ path: abs }, null, 2),
      'utf-8',
    )
  } catch {
    /* ignore — best effort persistence of the pointer */
  }
  return abs
}

/** Absolute path of the app's (legacy) SQLite state DB — kept for compat;
 *  user data is now plain files, this DB is migrated away on first use. */
export function coderDbPath(): string {
  return path.join(getDataRoot(), 'coder.db')
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry)
    const to = path.join(dest, entry)
    const st = fs.statSync(from)
    if (st.isDirectory()) {
      copyTree(from, to)
    } else if (st.isFile()) {
      if (!fs.existsSync(to)) fs.copyFileSync(from, to)
      else try { fs.copyFileSync(from, to) } catch { /* keep existing */ }
    }
  }
}

async function copyTreeAsync(
  src: string,
  dest: string,
  onProgress: (label: string, pct: number) => void,
): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src)
  let done = 0
  for (const entry of entries) {
    const from = path.join(src, entry)
    const to = path.join(dest, entry)
    const st = await fsp.stat(from)
    if (st.isDirectory()) {
      await copyTreeAsync(from, to, onProgress)
    } else if (st.isFile()) {
      try { await fsp.copyFile(from, to) } catch { /* keep existing */ }
    }
    done++
    onProgress(path.basename(src), Math.round((done / entries.length) * 100))
    await new Promise((r) => setImmediate(r))
  }
}

/**
 * Move the ENTIRE data root to the new configured path. Every file and folder
 * under the current root (chats, vector-db, models, memory, cache.sqlite,
 * settings.json, skills, mcp, plan, logs…) is copied to the new location and
 * then removed from the old one — nothing stays behind. Copy-then-delete keeps
 * the data safe: the old root is only cleaned up after a successful copy.
 */
export function moveDataRootAsync(
  newRootRaw: string,
  onProgress: (label: string, pct: number) => void,
): Promise<string> {
  const from = getDataRoot()
  const target = path.resolve(newRootRaw.trim() || '')
  if (!target) return Promise.resolve(from)
  if (target === from) return Promise.resolve(from)
  if (target.startsWith(from + path.sep)) {
    // Moving into a subdirectory of the current root would copy into itself.
    return Promise.resolve(from)
  }
  const items = getRootItems(from)
  onProgress('Preparing', 0)
  return copyAllAsync(from, target, items, onProgress)
    .then(() => onProgress('Cleaning up old location', 90))
    .then(() => removeAllAsync(from, items))
    .then(() => {
      onProgress('Done', 100)
      return target
    })
}

/** Top-level files + dirs that exist under a data root. */
function getRootItems(root: string): string[] {
  let names: string[] = []
  try { names = fs.readdirSync(root) } catch { return [] }
  return names.filter((n) => n !== '.DS_Store')
}

async function copyAllAsync(
  from: string,
  target: string,
  items: string[],
  onProgress: (label: string, pct: number) => void,
): Promise<void> {
  await fsp.mkdir(target, { recursive: true })
  const total = items.length
  let done = 0
  for (const name of items) {
    const src = path.join(from, name)
    const dest = path.join(target, name)
    try {
      const st = await fsp.stat(src)
      if (st.isDirectory()) {
        await copyTreeAsync(src, dest, () => {})
      } else if (st.isFile()) {
        await fsp.copyFile(src, dest)
      }
    } catch {
      /* best effort — skip unreadable item */
    }
    done++
    onProgress(`Copying ${name}`, Math.round((done / total) * 85))
    await new Promise((r) => setImmediate(r))
  }
}

async function removeAllAsync(root: string, items: string[]): Promise<void> {
  for (const name of items) {
    const p = path.join(root, name)
    try {
      const st = await fsp.stat(p)
      if (st.isDirectory()) {
        await fsp.rm(p, { recursive: true, force: true })
      } else {
        await fsp.unlink(p)
      }
    } catch {
      /* best effort */
    }
    await new Promise((r) => setImmediate(r))
  }
}