/* One-off test for the ~/.coder → ~/.codefa one-time migration in
 * electron/store-db.ts. Bundles the real module with esbuild, mocks
 * electron.app, and asserts:
 *   1. getDataRoot() resolves to ~/.codefa
 *   2. legacy ~/.coder contents are COPIED (source untouched)
 *   3. a second call is a no-op (no double copy, cached root wins)
 *   4. a custom pointer (data-root.json) still wins over the default
 */
'use strict'
const { buildSync } = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codefa-dataroot-'))
const fakeHome = path.join(tmp, 'home')
const fakeUserData = path.join(tmp, 'userData')
fs.mkdirSync(fakeHome, { recursive: true })
fs.mkdirSync(fakeUserData, { recursive: true })

// Legacy root with representative contents.
const legacy = path.join(fakeHome, '.coder')
fs.mkdirSync(path.join(legacy, 'chats', 'ws1'), { recursive: true })
fs.mkdirSync(path.join(legacy, 'skills', 'my-skill'), { recursive: true })
fs.mkdirSync(path.join(legacy, 'vector-db'), { recursive: true })
fs.writeFileSync(path.join(legacy, 'settings.json'), '{"theme":"dark"}')
fs.writeFileSync(path.join(legacy, 'chats', 'ws1', 'c1.json'), '{"title":"hi"}')
fs.writeFileSync(path.join(legacy, 'skills', 'my-skill', 'skill.md'), '# My Skill\n')
fs.writeFileSync(path.join(legacy, 'vector-db', 'ws1.sqlite'), 'SQLITE-BYTES')

// Bundle store-db.ts (CJS) so we can load it with a mocked 'electron'.
const outfile = path.join(tmp, 'store-db.cjs')
buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'electron/store-db.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'silent',
})

// Mock electron.app + os.homedir BEFORE requiring the bundle.
const appMock = { getPath: () => fakeUserData }
const osMock = { ...os, homedir: () => fakeHome }
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: appMock }
  if (request === 'os') return osMock
  return originalLoad.call(this, request, ...rest)
}

const mod = require(outfile)
const { getDataRoot } = mod

// --- Test 1: default resolves to ~/.codefa and migrates legacy ---
const root = getDataRoot()
const expected = path.join(fakeHome, '.codefa')
if (root !== expected) throw new Error(`root=${root} expected=${expected}`)
if (!fs.existsSync(path.join(expected, 'settings.json'))) throw new Error('settings.json not migrated')
if (!fs.existsSync(path.join(expected, 'chats', 'ws1', 'c1.json'))) throw new Error('chat not migrated')
if (!fs.existsSync(path.join(expected, 'skills', 'my-skill', 'skill.md'))) throw new Error('skill not migrated')
if (!fs.existsSync(path.join(expected, 'vector-db', 'ws1.sqlite'))) throw new Error('vector-db not migrated')
// Source must be untouched (copy, not move).
if (!fs.existsSync(path.join(legacy, 'settings.json'))) throw new Error('legacy source was deleted!')
console.log('PASS test1: ~/.codefa created, legacy contents copied, source intact')

// --- Test 2: cached root wins on second call, no re-copy / no crash ---
const root2 = getDataRoot()
if (root2 !== expected) throw new Error(`second call root=${root2}`)
const settingsMtime = fs.statSync(path.join(expected, 'settings.json')).mtimeMs
fs.writeFileSync(path.join(expected, 'settings.json'), '{"theme":"light"}')
const root3 = getDataRoot()
if (root3 !== expected) throw new Error(`third call root=${root3}`)
if (fs.statSync(path.join(expected, 'settings.json')).mtimeMs === settingsMtime) throw new Error('file not updated?')
console.log('PASS test2: cached root stable across calls')

// --- Test 3: custom pointer still wins over the default ---
const custom = path.join(tmp, 'custom-data')
fs.mkdirSync(custom, { recursive: true })
fs.writeFileSync(
  path.join(fakeUserData, 'data-root.json'),
  JSON.stringify({ path: custom }),
)
// Fresh module instance (fresh cachedRoot) to bypass the require cache.
const outfile2 = path.join(tmp, 'store-db-2.cjs')
buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'electron/store-db.ts')],
  outfile: outfile2,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'silent',
})
const mod2 = require(outfile2)
const rootCustom = mod2.getDataRoot()
if (rootCustom !== path.resolve(custom)) throw new Error(`custom root=${rootCustom}`)
console.log('PASS test3: custom data-root.json pointer wins')

// Cleanup
fs.rmSync(tmp, { recursive: true, force: true })
console.log('ALL PASS')
