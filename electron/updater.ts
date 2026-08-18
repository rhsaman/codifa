import { app, shell, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

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

function parseVersion(v: string): number[] {
  return String(v)
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface Release {
  tag_name: string
  body: string
  html_url: string
  assets: ReleaseAsset[]
}

/** Pick the installer asset for the current platform/arch from a release. */
function pickAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const plat = process.platform
  const arch = process.arch
  const name = (a: ReleaseAsset): string => a.name.toLowerCase()
  if (plat === 'darwin') {
    const archKey = arch === 'arm64' ? 'arm64' : 'x64'
    return (
      assets.find((a) => name(a).includes(`-${archKey}.dmg`)) ??
      assets.find((a) => name(a).includes(`${archKey}-mac.zip`)) ??
      assets.find((a) => name(a).endsWith('.dmg')) ??
      assets.find((a) => name(a).endsWith('-mac.zip')) ??
      null
    )
  }
  if (plat === 'win32') {
    return assets.find((a) => name(a).endsWith('.exe')) ?? null
  }
  if (plat === 'linux') {
    return assets.find((a) => name(a).endsWith('.appimage')) ?? null
  }
  return null
}

/** Compare the installed version against the latest GitHub release. Never
 *  throws: any network/API failure just reports "no update" so the UI stays
 *  quiet instead of erroring on launch. */
export async function checkForUpdates(): Promise<UpdateInfo> {
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
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codifa' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return empty()
    const release = (await res.json()) as Release
    const latestVersion = release.tag_name.replace(/^v/i, '')
    const asset = pickAsset(release.assets ?? [])
    return {
      available: isNewer(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      notes: release.body ?? '',
      assetName: asset?.name ?? null,
      assetUrl: asset?.browser_download_url ?? null,
      releaseUrl: release.html_url || `https://github.com/${REPO}/releases/latest`,
    }
  } catch {
    return empty()
  }
}

/** Download the latest installer (with progress events) and launch it. */
export async function startUpdate(
  win: BrowserWindow | null,
): Promise<{ ok: boolean; error?: string }> {
  const info = await checkForUpdates()
  if (!info.available || !info.assetUrl || !info.assetName) {
    return { ok: false, error: 'No update available' }
  }
  const dest = path.join(app.getPath('temp'), info.assetName)
  const send = (phase: UpdateProgress['phase'], percent: number): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:progress', { phase, percent })
    }
  }
  try {
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
    await fs.promises.writeFile(dest, Buffer.concat(chunks))
    send('installing', 100)
    await installAsset(dest)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Update failed' }
  }
}

/** Launch the downloaded installer for the current platform. */
async function installAsset(dest: string): Promise<void> {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    // macOS: mounts/opens the .dmg in Finder. Windows: runs the NSIS installer.
    const err = await shell.openPath(dest)
    if (err) throw new Error(err)
    return
  }
  // Linux AppImage: make it executable and launch it directly.
  try {
    fs.chmodSync(dest, 0o755)
  } catch {
    /* best effort */
  }
  const child = spawn(dest, [], { detached: true, stdio: 'ignore' })
  child.unref()
}