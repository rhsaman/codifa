// Stage the Python backend for Tauri bundling with symlinks dereferenced.
// The Tauri bundler skips symlinked files (e.g. .venv/bin/python), which
// leaves the bundled venv without an interpreter; a dereferenced copy keeps
// it runnable inside the .app resources.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'backend')
const dest = path.join(root, '.tauri-backend')

rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, {
  recursive: true,
  dereference: true,
  filter: (s) => !/__pycache__|\.pytest_cache|\.pyc$/.test(s),
})

// The venv's bin/python is a dereferenced copy of the base interpreter, whose
// dylib lookup (@executable_path/../lib/libpython3.12.dylib) only resolves in
// the base install layout. Copy the dylib next to the venv's site-packages and
// ship the base stdlib inside the bundle so the venv is self-contained.
const cfg = readFileSync(path.join(dest, '.venv', 'pyvenv.cfg'), 'utf8')
const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim()
if (!home) throw new Error('pyvenv.cfg: home not found')
const baseLib = path.join(path.dirname(home), 'lib')
cpSync(path.join(baseLib, 'libpython3.12.dylib'), path.join(dest, '.venv', 'lib', 'libpython3.12.dylib'))
const bundledBase = path.join(dest, '.python-base')
rmSync(bundledBase, { recursive: true, force: true })
cpSync(path.dirname(home), bundledBase, {
  recursive: true,
  dereference: true,
  filter: (s) => !/__pycache__|\.pyc$/.test(s),
})
writeFileSync(
  path.join(dest, '.venv', 'pyvenv.cfg'),
  cfg.replace(/^home\s*=.*$/m, 'home = ../.python-base/bin'),
)
console.log('staged backend ->', dest, '(base python + dylib bundled)')
