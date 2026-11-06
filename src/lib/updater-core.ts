/**
 * Pure, platform-agnostic helpers for the updater (GitHub releases + the
 * user's own static JSON feed). No platform imports here so the logic can be
 * unit-tested in plain Node (see tests/updater-core.test.ts).
 *
 * MUST stay behavior-identical to the LIVE comparison in
 * src-tauri/src/commands.rs (`parse_version` / `is_newer`) — the Rust copy is
 * what actually runs; this twin only exists so the semantics stay pinned by
 * tests. Any change here must be mirrored there (and vice versa).
 */

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  /** GitHub's `digest` (`sha256:<hex>`) or a site feed's `sha256`. */
  digest?: string
  sha256?: string
}

/** A version split into its numeric base and an optional prerelease id. */
export function parseVersion(v: string): { nums: number[]; pre: string | null } {
  const s = String(v).trim().replace(/^v/i, '')
  const dash = s.indexOf('-')
  const base = dash >= 0 ? s.slice(0, dash) : s
  const pre = dash >= 0 && s.length > dash + 1 ? s.slice(dash + 1).toLowerCase() : null
  const nums = base.split('.').map((n) => parseInt(n.trim(), 10) || 0)
  return { nums, pre }
}

/** `rc10` → ['rc', 10] so rc10 sorts after rc9; a tail without digits ranks 0. */
function preKey(pre: string): [string, number] {
  const m = /^(.*?)(\d+)$/.exec(pre)
  return m ? [m[1], parseInt(m[2], 10) || 0] : [pre, 0]
}

/**
 * True when `candidate` should be OFFERED over the running `current`.
 *
 * Numeric base parts compare first. A PRERELEASE is only offered when the
 * running build is itself a prerelease: publishing `v2.1.0-rc1` must never
 * prompt the whole stable base to "update" to an RC (the old comparison read
 * `2.1.0-rc1` as [2,1,0] and pushed it to every user). Same base: rc → final
 * release is always an upgrade; rc → newer rc compares by its trailing
 * number (`rc10` > `rc9`). A tag with no numbers (`nightly`) parses to [0]
 * and never wins.
 */
export function isNewer(current: string, candidate: string): boolean {
  const c = parseVersion(current)
  const n = parseVersion(candidate)
  const len = Math.max(c.nums.length, n.nums.length)
  for (let i = 0; i < len; i++) {
    const x = n.nums[i] ?? 0
    const y = c.nums[i] ?? 0
    if (x !== y) return x > y && (n.pre === null || c.pre !== null)
  }
  if (c.pre && !n.pre) return true
  if (c.pre && n.pre && c.pre !== n.pre) {
    const [ch, cn] = preKey(c.pre)
    const [nh, nn] = preKey(n.pre)
    if (nh !== ch) return nh > ch
    return nn > cn
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
 *    releases that don't follow builder naming). An arm64 .dmg is never picked
 *    for an x64 Mac (it would mount but the app inside can't run).
 *  - Windows: NSIS "Setup" .exe first, then any .exe (portable builds).
 *  - Linux: AppImage (runs without sudo; a .deb would need root to install).
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: string,
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

/**
 * The sha256 a feed pins to an asset: GitHub's `digest` (`sha256:<hex>`) or a
 * site feed's `sha256`. Absent/malformed = no pin; the download then falls
 * back to the size check only. Mirrors commands.rs `asset_sha256`.
 */
export function assetSha256(a: ReleaseAsset): string | null {
  const hex64 = (s: string): string | null => {
    const t = s.trim().toLowerCase()
    return /^[0-9a-f]{64}$/.test(t) ? t : null
  }
  const digest = a.digest?.trim()
  if (digest?.startsWith('sha256:')) {
    const hex = hex64(digest.slice('sha256:'.length))
    if (hex) return hex
  }
  return a.sha256 ? hex64(a.sha256) : null
}
