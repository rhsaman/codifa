/**
 * Wrapper around electron-builder that works around a macOS 27 SDK mismatch.
 *
 * Symptom (macOS 27.x, Xcode 26.x selected):
 *   SOLINK_MODULE fails with
 *   `tapi error: malformed file .../MacOSX27.0.sdk/usr/lib/libSystem.B.tbd:
 *    unknown architecture arm64e.x1-macos`
 *
 * Cause: node-gyp picks the CommandLineTools SDK
 * (`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` -> MacOSX27.0.sdk)
 * while the compiler driver resolves to the Xcode 26.x toolchain whose
 * linker (ld-1266.x) predates the arm64e.x1 slice. The CLT 27.0 SDK is also
 * currently broken for C++ (`'functional' file not found`), so the only
 * reliable combination on this OS is the Xcode 26.x SDK + Xcode toolchain.
 *
 * Fix: when running on macOS and SDKROOT is not already set, point SDKROOT
 * at the Xcode SDK. When Xcode is not installed (CLT-only machine with the
 * broken 27 SDK), fall back to `-c.npmRebuild=false` so the prebuilt
 * node-pty binary (N-API, ships in prebuilds/darwin-*) is used instead of
 * compiling from source. Linux/Windows builds always need a rebuild when no
 * prebuilt exists, so they are left untouched.
 */
import { execFileSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'

const XCODE_SDK =
  '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'

function resolveMacEnv(env, extraConfigArgs) {
  if (process.platform !== 'darwin' || env.SDKROOT) return
  if (existsSync(XCODE_SDK)) {
    env.SDKROOT = XCODE_SDK
    console.log(`run-electron-builder: SDKROOT=${XCODE_SDK} (Xcode SDK workaround)`)
    return
  }
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8',
    }).trim()
    // Only trust SDKs that are not the broken CLT 27 one.
    if (sdk && !sdk.includes('CommandLineTools')) {
      env.SDKROOT = sdk
      console.log(`run-electron-builder: SDKROOT=${sdk} (from xcrun)`)
      return
    }
  } catch {
    /* fall through to prebuilt fallback */
  }
  // CLT-only machine: skip source rebuild, use N-API prebuilt.
  extraConfigArgs.push('-c.npmRebuild=false')
  console.warn(
    'run-electron-builder: Xcode SDK not found, passing -c.npmRebuild=false to use prebuilt node-pty'
  )
}

const args = process.argv.slice(2)
const extraConfigArgs = []
const env = { ...process.env }
resolveMacEnv(env, extraConfigArgs)

const res = spawnSync('npx', ['electron-builder', ...args, ...extraConfigArgs], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})
process.exit(res.status ?? 1)
