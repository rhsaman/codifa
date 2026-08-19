/**
 * Pure, platform-agnostic helpers for the GitHub-releases updater.
 * No `electron` imports here so the logic can be unit-tested in plain Node
 * (see test/updater-core.test.ts).
 */

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export function parseVersion(v: string): number[] {
  return String(v)
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

export function isNewer(latest: string, current: string): boolean {
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

/**
 * Pick the installer asset for a platform/arch from a release's asset list.
 * `platform`/`arch` are injectable so every OS can be tested from one machine.
 *
 * Ordering matters:
 *  - macOS: exact-arch .dmg → universal .dmg → exact-arch -mac.zip →
 *    universal .zip → any .dmg → any -mac.zip (last resorts for hand-made
 *    releases that don't follow electron-builder naming). An arm64 .dmg is
 *    never picked for an x64 Mac (it would mount but the app inside can't run).
 *  - Windows: NSIS "Setup" .exe first (electron-builder's default), then any
 *    .exe (portable builds).
 *  - Linux: AppImage (runs without sudo; a .deb would need root to install).
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  const name = (a: ReleaseAsset): string => a.name.toLowerCase()
  const has = (a: ReleaseAsset, needle: string): boolean => name(a).includes(needle)
  const ends = (a: ReleaseAsset, suffix: string): boolean => name(a).endsWith(suffix)
  const universal = (a: ReleaseAsset): boolean => has(a, 'universal')

  if (platform === 'darwin') {
    const archKey = arch === 'arm64' ? 'arm64' : 'x64'
    return (
      assets.find((a) => has(a, `-${archKey}.dmg`)) ??
      assets.find((a) => universal(a) && ends(a, '.dmg')) ??
      assets.find((a) => has(a, `${archKey}-mac.zip`)) ??
      assets.find((a) => universal(a) && ends(a, '.zip')) ??
      assets.find((a) => ends(a, '.dmg')) ??
      assets.find((a) => ends(a, '-mac.zip')) ??
      null
    )
  }
  if (platform === 'win32') {
    return (
      assets.find((a) => ends(a, '.exe') && (has(a, 'setup') || has(a, 'set up'))) ??
      assets.find((a) => ends(a, '.exe')) ??
      null
    )
  }
  if (platform === 'linux') {
    return assets.find((a) => ends(a, '.appimage')) ?? null
  }
  return null
}