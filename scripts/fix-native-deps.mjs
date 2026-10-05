/**
 * postinstall hardening for native dependencies used by the in-app terminal.
 *
 * Runs after every `npm install` and fixes two things that break silently
 * otherwise:
 *
 * 1. node-pty's macOS `spawn-helper` ships without the executable bit in the
 *    published tarball, so every pty spawn fails with `posix_spawnp failed`
 *    until it is chmod'ed.
 * 2. On recent macOS versions (26/27), XProtect flags the stock Electron dev
 *    binary as malware (a known false positive for Electron 31) and blocks
 *    launch. Re-signing the bundle ad-hoc changes its code signature and
 *    clears the false positive. Only touches `node_modules/electron/dist`
 *    when it exists — packaging (electron-builder + scripts/ad-hoc-sign.mjs)
 *    signs the real app bundle separately.
 *
 * Everything is best-effort: any failure logs a warning and exits 0 so a
 * plain `npm install` never breaks on platforms where a fix does not apply.
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const warn = (msg) => console.warn(`fix-native-deps: ${msg}`)

function fixSpawnHelper() {
  const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return
  for (const entry of readdirSync(prebuilds)) {
    const helper = join(prebuilds, entry, 'spawn-helper')
    if (!existsSync(helper)) continue
    try {
      execFileSync('chmod', ['+x', helper])
      console.log(`fix-native-deps: chmod +x ${helper}`)
    } catch (err) {
      warn(`could not chmod spawn-helper (${entry}): ${err.message}`)
    }
  }
}

function resignElectron() {
  if (process.platform !== 'darwin') return
  const app = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
  if (!existsSync(app)) return
  try {
    // Ad-hoc identity ("-"): keeps the dev binary runnable while leaving the
    // packaged app's own signing flow (afterSign) untouched.
    execFileSync('xattr', ['-cr', app], { stdio: 'ignore' })
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
    console.log('fix-native-deps: re-signed node_modules/electron/dist (XProtect workaround)')
  } catch (err) {
    warn(`electron re-sign failed (run \`codesign --force --deep --sign - "${app}"\` manually): ${err.message}`)
  }
}

try {
  fixSpawnHelper()
  resignElectron()
} catch (err) {
  warn(`unexpected error: ${err?.message ?? err}`)
}
