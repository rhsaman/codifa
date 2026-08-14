import { execSync, spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import * as os from 'os'
import { getDataRoot } from './store-db'
import { getSecretsKey } from './secrets'

export interface SidecarHandle {
  url: string
  process: ChildProcess
}

function findBackendDir(): string | null {
  const candidates = [
    process.env.CODER_BACKEND,
    path.join(process.cwd(), 'backend'),
    path.join(app.getAppPath(), 'backend'),
    path.join(process.resourcesPath, 'backend'),
    path.join(app.getAppPath(), 'resources', 'backend'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'server.py'))) {
      return candidate
    }
  }
  return null
}

function getPythonRunner(backendDir: string): { cmd: string; args: string[] } | null {
  const venvPython = path.join(backendDir, '.venv', 'bin', 'python')
  if (process.platform === 'win32') {
    const venvPythonWin = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    if (fs.existsSync(venvPythonWin)) {
      return { cmd: venvPythonWin, args: [] }
    }
    return null
  }
  if (fs.existsSync(venvPython)) {
    return { cmd: venvPython, args: [] }
  }
  return null
}

/**
 * Merge the minimal GUI-launched PATH with the user's login-shell PATH.
 *
 * When the app is opened from the Dock/Finder (not a terminal), Electron inherits
 * a stripped PATH (usually just /usr/bin:/bin:...) so CLI tools installed by
 * Homebrew / Docker Desktop / etc. (e.g. `docker` at /usr/local/bin or
 * /opt/homebrew/bin) cannot be found by children — including stdio MCP servers
 * like `docker mcp gateway run`. In dev the shell already provides these, so the
 * discrepancy only shows up in the packaged .app. The MCP server is spawned by
 * the Python sidecar, which inherits this process's env, so fixing PATH here
 * repairs the whole subtree.
 *
 * Platform notes: this only matters on macOS (Dock launches drop the login PATH).
 * Linux launch contexts already carry the full PATH; Windows has no POSIX login
 * shell to probe AND already passes the full system %PATH% to GUI apps, so for
 * win32 we only normalize the separator (';' not ':').
 */
function shellPath(): string {
  const isWin = process.platform === 'win32'
  const sep = isWin ? ';' : ':'
  const parts = new Set<string>()
  for (const p of (process.env.PATH || '').split(sep)) if (p) parts.add(p)
  if (isWin) {
    return Array.from(parts).join(sep)
  }
  // Common, predictable CLI locations regardless of the launch context.
  for (const dir of [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]) {
    if (fs.existsSync(dir)) parts.add(dir)
  }
  // Ask the login shell for the real user PATH and merge it in. macOS GUI apps
  // don't load shell rc files, so this is the authoritative source for tools the
  // user installed via brew/nvm etc. Silence errors — a slower/no shell just
  // falls back to the defaults above.
  try {
    const shell =
      process.env.SHELL ||
      (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    const probe =
      process.platform === 'darwin'
        ? `${shell} -l -c 'echo -n "$PATH"'`
        : `${shell} -c 'echo -n "$PATH"'`
    const out = execSync(probe, { timeout: 3000, encoding: 'utf8' })
    for (const p of out.split(sep)) if (p) parts.add(p)
  } catch {
    /* ignore — defaults above are enough */
  }
  return Array.from(parts).join(sep)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('could not allocate port')))
      }
    })
  })
}

let handle: SidecarHandle | null = null
let starting: Promise<SidecarHandle> | null = null
// Set right before an intentional stop so the exit handler can log a calm
// "stopped" message instead of a scary "exited with code null".
let stopping = false

export function startSidecar(): Promise<SidecarHandle> {
  if (handle) return Promise.resolve(handle)
  if (starting) return starting
  starting = doStart().finally(() => {
    starting = null
  })
  return starting
}

async function doStart(): Promise<SidecarHandle> {
  const backendDir = findBackendDir()
  if (!backendDir) {
    throw new Error('backend/server.py not found; run `npm run setup`')
  }

  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const runner = getPythonRunner(backendDir)

  let child: ChildProcess
  const childEnv = {
    ...process.env,
    PATH: shellPath(),
    PYTHONIOENCODING: 'utf-8',
    // User-level data root (configurable from Settings → Data path). The
    // sidecar owns the SQLite state DB and the skills/plans/mcp files there,
    // so it must agree with Electron about where that root is.
    CODER_DATA_DIR: getDataRoot(),
    // AES key used to decrypt secrets (API keys / OAuth creds) that the
    // renderer stores encrypted in settings.json. In-memory only, never on disk.
    CODER_SECRET_KEY: getSecretsKey(),
  }
  if (runner) {
    child = spawn(runner.cmd, [...runner.args, path.join(backendDir, 'server.py'), '--port', String(port)], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    })
  } else {
    const args = ['run', '--project', backendDir, 'python', 'server.py', '--port', String(port)]
    child = spawn('uv', args, {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    })
  }

  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.log('[sidecar]', text)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.error('[sidecar]', text)
  })
  child.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[sidecar] stopped (${signal || 'exit'})`)
      stopping = false
    } else if (code === null) {
      console.error(`[sidecar] exited unexpectedly (signal ${signal})`)
    } else {
      console.error(`[sidecar] exited with code ${code}`)
    }
    handle = null
  })
  child.on('error', (err) => {
    console.error('[sidecar] spawn error', err)
    handle = null
  })

  // Wait for the health endpoint (with a 30s budget).
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Python sidecar exited during startup; run `npm run setup`')
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        handle = { url, process: child }
        return handle
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  child.kill()
  throw new Error('Python sidecar did not become healthy; run `npm run setup`')
}

export async function getSidecarUrl(): Promise<string | null> {
  try {
    const h = await startSidecar()
    return h.url
  } catch (err) {
    console.error('[sidecar]', (err as Error).message)
    return null
  }
}

/** Return the running sidecar's URL WITHOUT starting/restarting it.
 *  Used by the quit flush so saving settings/chats never blocks a shutdown on a
 *  30s sidecar boot (a dead sidecar can't accept writes anyway). */
export function peekSidecarUrl(): string | null {
  return handle ? handle.url : null
}

export async function stopSidecar(timeoutMs = 5000): Promise<void> {
  const current = handle
  if (!current) return
  handle = null
  stopping = true
  const proc = current.process
  // Already gone — nothing to wait for.
  if (proc.exitCode !== null) {
    stopping = false
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.error('[sidecar] stop timed out; killing')
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}
