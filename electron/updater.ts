import { app, shell, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { pickAsset, isNewer, type ReleaseAsset } from './updater-core'

const execFileAsync = promisify(execFile)

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string
  notes: string
  assetName: string | null
  assetUrl: string | null
  releaseUrl: string
}

export interface UpdateProgress {
  phase: 'downloading' | 'installing'
  percent: number
}

const REPO = 'rhsaman/codifa'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

interface Release {
  tag_name: string
  body: string
  html_url: string
  assets: ReleaseAsset[]
}

// GitHub's unauthenticated API is rate-limited to 60 req/hr per IP. The button
// checks on mount + every 30 min, and startUpdate re-checks — cache the result
// briefly so those calls don't burn the quota and start failing on any OS.
let cachedCheck: { at: number; info: UpdateInfo } | null = null
const CHECK_TTL_MS = 5 * 60_000

/** Compare the installed version against the latest GitHub release. Never
 *  throws: any network/API failure just reports "no update" so the UI stays
 *  quiet instead of erroring on launch. Results are cached for a few minutes
 *  to stay under GitHub's unauthenticated rate limit. */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const now = Date.now()
  if (cachedCheck && now - cachedCheck.at < CHECK_TTL_MS) return cachedCheck.info

  const currentVersion = app.getVersion()
  const empty = (): UpdateInfo => ({
    available: false,
    currentVersion,
    latestVersion: currentVersion,
    notes: '',
    assetName: null,
    assetUrl: null,
    releaseUrl: `https://github.com/${REPO}/releases/latest`,
  })

  let info: UpdateInfo
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codifa' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      info = empty()
    } else {
      const release = (await res.json()) as Release
      const latestVersion = release.tag_name.replace(/^v/i, '')
      const asset = pickAsset(release.assets ?? [], process.platform, process.arch)
      info = {
        available: isNewer(latestVersion, currentVersion),
        currentVersion,
        latestVersion,
        notes: release.body ?? '',
        assetName: asset?.name ?? null,
        assetUrl: asset?.browser_download_url ?? null,
        releaseUrl: release.html_url || `https://github.com/${REPO}/releases/latest`,
      }
    }
  } catch {
    info = empty()
  }

  cachedCheck = { at: Date.now(), info }
  return info
}

/** Directory where downloaded installers are cached. Lives under userData
 *  (NOT the OS temp dir) so a completed download survives temp cleanup and a
 *  retry can reuse it instead of re-downloading the whole asset. */
function updatesDir(): string {
  return path.join(app.getPath('userData'), 'updates')
}

async function statSafe(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p)
  } catch {
    return null
  }
}

async function readSizeFile(p: string): Promise<number | null> {
  try {
    const n = Number(await fs.promises.readFile(p, 'utf8'))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Download the latest installer (with progress events) and launch it.
 *  The file is cached under userData/updates and reused on retry, so a failed
 *  install never forces the user to re-download the whole asset. */
export async function startUpdate(
  win: BrowserWindow | null,
): Promise<{ ok: boolean; error?: string }> {
  const info = await checkForUpdates()
  if (!info.available || !info.assetUrl || !info.assetName) {
    return { ok: false, error: 'No update available' }
  }
  const send = (phase: UpdateProgress['phase'], percent: number): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:progress', { phase, percent })
    }
  }
  const dir = updatesDir()
  await fs.promises.mkdir(dir, { recursive: true })
  const dest = path.join(dir, info.assetName)
  const sizeFile = `${dest}.size`

  try {
    // Reuse a previously downloaded, size-verified installer instead of
    // re-downloading the whole asset on every retry.
    const existing = await statSafe(dest)
    const expected = await readSizeFile(sizeFile)
    if (existing && expected !== null && existing.size === expected) {
      send('installing', 100)
      await installAsset(dest)
      return { ok: true }
    }

    send('downloading', 0)
    const res = await fetch(info.assetUrl, {
      headers: { 'User-Agent': 'codifa' },
      signal: AbortSignal.timeout(30 * 60_000),
    })
    if (!res.ok || !res.body) {
      return { ok: false, error: `Download failed (HTTP ${res.status})` }
    }
    const total = Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        received += value.length
        if (total > 0) send('downloading', Math.min(99, Math.round((received / total) * 100)))
      }
    }
    // A stream that ends early (dropped connection, expired signed URL) would
    // otherwise write a truncated .dmg that macOS refuses to mount — detect it.
    if (total > 0 && received !== total) {
      await fs.promises.rm(dest, { force: true }).catch(() => {})
      await fs.promises.rm(sizeFile, { force: true }).catch(() => {})
      return {
        ok: false,
        error: `Download incomplete: got ${received} of ${total} bytes — click Retry to download again`,
      }
    }
    await fs.promises.writeFile(dest, Buffer.concat(chunks))
    await fs.promises.writeFile(sizeFile, String(received), 'utf8')
    send('installing', 100)
    await installAsset(dest)
    return { ok: true }
  } catch (err) {
    // Only drop the cache when the download itself failed; a failed *install*
    // keeps the cached file so Retry reuses it instead of re-downloading.
    const cached = await statSafe(dest)
    const expected = await readSizeFile(sizeFile)
    if (!cached || expected === null || cached.size !== expected) {
      await fs.promises.rm(dest, { force: true }).catch(() => {})
      await fs.promises.rm(sizeFile, { force: true }).catch(() => {})
    }
    return { ok: false, error: (err as Error).message || 'Update failed' }
  }
}

/** Launch the downloaded installer for the current platform. */
async function installAsset(dest: string): Promise<void> {
  if (process.platform === 'darwin') {
    // macOS: mounts/opens the .dmg in Finder. If the default handler refuses,
    // fall back to the `open` CLI so we surface a real error instead of a
    // silent "Retry" loop.
    const err = await shell.openPath(dest)
    if (err) {
      try {
        await execFileAsync('open', [dest])
      } catch (e) {
        throw new Error(
          `Could not open installer: ${err}` +
            (e instanceof Error ? ` (${e.message})` : ''),
        )
      }
    }
    return
  }
  if (process.platform === 'win32') {
    const err = await shell.openPath(dest)
    if (err) throw new Error(err)
    return
  }
  // Linux AppImage: make it executable and launch it. APPIMAGE_EXTRACT_AND_RUN
  // makes it self-extract, so it works even on distros without FUSE (the usual
  // AppImage failure mode) instead of silently dying.
  try {
    fs.chmodSync(dest, 0o755)
  } catch {
    /* best effort */
  }
  const child = spawn(dest, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
  })
  child.unref()
}