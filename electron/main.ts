import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, nativeImage, screen, session, shell, clipboard } from 'electron'
import { execFile } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { getSidecarUrl, peekSidecarUrl, startSidecar, stopSidecar } from './sidecar'
import { loadShellEnv } from './shell-env'
import { getDataRoot, moveDataRootAsync, setDataRoot } from './store-db'
import { registerSecretsIpc } from './secrets'
import { buildOverlayHtml } from './captureOverlay'
import {
  listDir,
  walkWorkspace,
  readFileSafe,
  readImageDataUrl,
  writeFileSafe,
  deleteSafe,
  searchContent,
  readJsonFile,
  coderDirList,
  coderDirRead,
  coderDirWrite,
  coderDirDelete,
} from './ipc/fs'

const isDev = !!process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null

// A Finder/Dock launch has no shell, so env vars exported in ~/.zshrc etc. never
// reach the app (or the sidecar it spawns). Pull the plain `export NAME=value`
// lines in BEFORE anything reads process.env (settings env checks, sidecar
// spawn), so key-based providers work the same as a terminal launch.
loadShellEnv()

// The packaged app launched from Finder gets a minimal PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`) that has no Homebrew dirs, so bare
// `lsof`/`nvim` lookups fail with ENOENT and the Neovim label never appears.
// Prepend the common install locations so child tools always resolve.
const TOOL_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  process.env.PATH,
].filter(Boolean).join(':')

// --- Neovim "open file" tracking -------------------------------------------
// The user runs nvim with `--listen <socket>` (or a wrapper). We discover the
// running nvim instances, query the focused buffer directly over the RPC socket
// and push the path to the renderer so it can show the "open in Neovim" label.
// Nothing is written to the user's config and no helper files are installed.
let lastNvimAbs: string | null = null
let lastNvimDiags: unknown[] = []
let nvimPollTimer: ReturnType<typeof setInterval> | null = null
let nvimIdleTicks = 0

/** Directories where nvim's server sockets live. nvim names its default socket
 *  `nvim.<pid>.0` under `$TMPDIR/nvim.<uid>/<token>/` on macOS and uses a
 *  `$XDG_RUNTIME_DIR/nvim/<pid>/0` layout on Linux. `lsof` alone is unreliable
 *  on macOS (often returns empty for other processes' sockets), so we prefer to
 *  glob these dirs directly and only probe sockets whose embedded pid is alive. */
function nvimSocketRoots(): string[] {
  const roots: string[] = []
  const tmp = os.tmpdir()
  if (tmp) {
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (name.startsWith('nvim')) roots.push(path.join(tmp, name))
      }
    } catch {
      /* tmp not readable — fall through */
    }
  }
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) roots.push(path.join(xdg, 'nvim'))
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'nvim'))
  return roots
}

/** Parse the owning nvim pid from a socket path (`nvim.<pid>.0`, or the XDG
 *  `.../nvim/<pid>/0` form). Returns null when it isn't a known nvim layout. */
function nvimSocketPid(socket: string): number | null {
  const leaf = path.basename(socket)
  const m = leaf.match(/^nvim\.(\d+)\.0$/)
  if (m) return Number(m[1])
  const parent = path.basename(path.dirname(socket))
  if (leaf === '0' && /^\d+$/.test(parent)) return Number(parent)
  return null
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function walkNvimSocketDir(dir: string, depth: number, acc: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (depth < 5) await walkNvimSocketDir(full, depth + 1, acc)
      continue
    }
    const pid = nvimSocketPid(full)
    if (pid === null) continue
    let isSock = false
    try {
      isSock = fs.statSync(full).isSocket()
    } catch {
      continue
    }
    if (isSock && pidIsAlive(pid)) acc.push(full)
  }
}

/** Unix sockets listening for nvim RPC. Discovered by globbing nvim's socket
 *  dirs (pid-liveness filtered) so it works without Full Disk Access; falls
 *  back to `lsof` for custom `--listen <socket>` paths the glob can't see. */
async function findNvimSockets(): Promise<string[]> {
  const found: string[] = []
  for (const root of nvimSocketRoots()) {
    if (!root) continue
    await walkNvimSocketDir(root, 0, found)
  }
  const uniq = [...new Set(found)]
  if (uniq.length > 0) return uniq
  // Fallback for non-default socket names (user passed `--listen`): enumerate
  // via lsof, keeping only genuine `nvim.<pid>.0` server sockets (this avoids
  // this app's own `nvim --server --remote-expr` subprocesses and stale ones).
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-c', 'nvim', '-U', '-F0n'],
      { timeout: 5000, env: { ...process.env, PATH: TOOL_PATH } },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        const out: string[] = []
        for (const rec of stdout.split('\0')) {
          if (!rec.startsWith('n')) continue
          let p = rec.slice(1)
          if (p.startsWith('->')) p = p.slice(2) // connected socket form
          if (!p.startsWith('/')) continue
          if (!/nvim\.\d+\.0$/.test(p)) continue
          try {
            if (fs.statSync(p).isSocket()) out.push(p)
          } catch {
            /* gone before stat */
          }
        }
        resolve([...new Set(out)])
      },
    )
  })
}

/** Ask one nvim instance for the absolute path of its currently focused buffer
 *  (`expand('%:p')` returns '' for unnamed buffers). */
function queryNvimBuffer(socket: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'nvim',
      ['--server', socket, '--remote-expr', 'expand("%:p")'],
      { timeout: 1500, env: { ...process.env, PATH: TOOL_PATH } },
      (err, stdout) => {
        if (err) return resolve(null)
        const v = String(stdout ?? '').trim()
        resolve(v || null)
      },
    )
  })
}

/** Ask one nvim instance for the Language-Server diagnostics of its current
 *  buffer (`vim.lsp.diagnostic.get(0)`), encoded as a compact JSON array.
 *
 *  `--remote-expr` with `luaeval('...')` only accepts a single Lua EXPRESSION,
 *  so the whole body must be an immediately-invoked function expression
 *  (`(function() ... end)()`) — plain multi-statement Lua (locals, `for`,
 *  top-level `return`) makes nvim error with "unexpected symbol". The body runs
 *  inside a pcall so a buffer without any LSP client (or an older nvim) resolves
 *  to an empty array instead of erroring, and the JSON encoder falls back to
 *  `vim.fn.json_encode` for nvim < 0.10 where `vim.json` does not exist.
 *  Everything goes over the same `--server <socket> --remote-expr` channel the
 *  buffer path uses, so no config/helper files are needed.
 */
function queryNvimDiagnostics(socket: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const body =
      "function() local ok,res=pcall(function() " +
      "local d=vim.lsp.diagnostic.get(0) or {} local a={} " +
      "for _,x in ipairs(d) do a[#a+1]={lnum=x.lnum,col=x.col,end_lnum=x.end_lnum," +
      "end_col=x.end_col,severity=x.severity,source=x.source,code=x.code,message=x.message} end " +
      "local enc=vim.json and function(t) return vim.json.encode(t) end or function(t) return vim.fn.json_encode(t) end " +
      "return enc(a) end) " +
      "return ok and res or \"[]\" end"
    execFile(
      'nvim',
      ['--server', socket, '--remote-expr', `luaeval('(${body})()')`],
      { timeout: 1500, env: { ...process.env, PATH: TOOL_PATH } },
      (err, stdout) => {
        if (err) return resolve([])
        const raw = String(stdout ?? '').trim()
        if (!raw) return resolve([])
        try {
          const parsed = JSON.parse(raw)
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch {
          resolve([])
        }
      },
    )
  })
}

async function pollNvimFile(): Promise<void> {
  const sockets = await findNvimSockets()
  let abs: string | null = null
  let diags: unknown[] = []
  for (const sock of sockets.slice(0, 8)) {
    abs = await queryNvimBuffer(sock)
    if (abs) {
      diags = await queryNvimDiagnostics(sock)
      break
    }
  }
  const diagKey = JSON.stringify(diags)
  const absChanged = abs !== lastNvimAbs
  const diagChanged = diagKey !== JSON.stringify(lastNvimDiags)
  if (!absChanged && !diagChanged) return
  lastNvimAbs = abs
  lastNvimDiags = diags
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('nvim:file', { abs, diagnostics: diags })
  }
}

function watchNvimFile(): void {
  if (nvimPollTimer) return
  const tick = async (): Promise<void> => {
    const sockets = await findNvimSockets()
    // Back off when nothing is open so an idle app doesn't keep spawning
    // `lsof` + `nvim --remote-expr` subprocesses every 1.5 s (this churn was
    // the top suspect for system-wide sluggishness/freezes while the app ran).
    if (sockets.length === 0) {
      nvimIdleTicks += 1
      if (nvimIdleTicks > 0 && nvimPollTimer) {
        clearInterval(nvimPollTimer)
        nvimPollTimer = setInterval(tick, 5000)
        nvimPollTimer.unref?.()
      }
    } else if (nvimIdleTicks > 0 && nvimPollTimer) {
      nvimIdleTicks = 0
      clearInterval(nvimPollTimer)
      nvimPollTimer = setInterval(tick, 1500)
      nvimPollTimer.unref?.()
    } else {
      nvimIdleTicks = 0
    }
    await pollNvimFile()
  }
  // Start lazy: a grace delay after the window is up, so app launch never has
  // to contend with a burst of subprocess spawns on top of first-paint work.
  setTimeout(() => {
    if (nvimPollTimer) return
    nvimPollTimer = setInterval(tick, 1500)
    nvimPollTimer.unref?.()
    void tick()
  }, 5000)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'CODEFA',
    icon: path.join(import.meta.dirname, '../build/icon.png'),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: !isDev,
    webPreferences: {
      preload: import.meta.dirname + '/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  // --- secrets (API keys / OAuth creds encrypted at rest) -------------------
  registerSecretsIpc()

  // --- sidecar --------------------------------------------------------------
  ipcMain.handle('sidecar:url', async () => getSidecarUrl())

  // --- neovim open-file state ----------------------------------------------
  ipcMain.handle('nvim:get', () => ({ abs: lastNvimAbs, diagnostics: lastNvimDiags }))

  // --- global environment (used for API keys / base URLs) -------------------
  // Any env var may be looked up so the Settings UI can check a user-specified
  // name (e.g. OPENROUTER_API_KEY); only a presence boolean is ever revealed,
  // never the value itself.
  const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/
  ipcMain.handle('env:get', (_e, key: string) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128 || !ENV_VAR_PATTERN.test(key)) return null
    return process.env[key] ?? null
  })

  // --- Google OAuth sign-in -------------------------------------------------
  // Opens Google's consent page in the OS's default browser (NOT an embedded
  // window). Google redirects to the sidecar's loopback callback URL, which the
  // sidecar itself handles (exchanging the code and caching the tokens); the
  // main process polls the sidecar until that result lands. Resolves with
  // {refreshToken, accessToken, expiresIn} or rejects with the failure reason.
  ipcMain.handle('oauth:google', async (_e, clientId: unknown, clientSecret: unknown, scope?: unknown) => {
    const cid = typeof clientId === 'string' ? clientId.trim() : ''
    const csec = typeof clientSecret === 'string' ? clientSecret.trim() : ''
    if (!cid) throw new Error('missing Google OAuth client id')
    const sidecar = await getSidecarUrl()
    if (!sidecar) throw new Error('Python agent not ready — run `npm run setup`')

    const start = await fetch(`${sidecar}/oauth/google/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cid,
        client_secret: csec,
        scope: typeof scope === 'string' && scope.trim() ? scope.trim() : '',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!start.ok) {
      const body = await start.json().catch(() => ({}))
      throw new Error((body as { detail?: string }).detail || `oauth start failed (${start.status})`)
    }
    const { url: consentUrl, state } = (await start.json()) as { url: string; state: string }
    if (!consentUrl || !state) throw new Error('oauth start returned no url')

    await shell.openExternal(consentUrl)

    // Poll the sidecar for the completed exchange (the OS browser redirected
    // there after consent). Give the user 5 minutes to approve.
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750))
      const res = await fetch(`${sidecar}/oauth/google/result?state=${encodeURIComponent(state)}`, {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null)
      if (!res) continue
      const data = (await res.json().catch(() => null)) as
        | { status: string; message?: string; refresh_token?: string; access_token?: string; expires_in?: number }
        | null
      if (!data || data.status === 'pending') continue
      if (data.status === 'error') {
        throw new Error(data.message || 'Google sign-in failed')
      }
      return {
        refreshToken: data.refresh_token ?? '',
        accessToken: data.access_token ?? '',
        expiresIn: data.expires_in ?? 3600,
      }
    }
    throw new Error('Google sign-in timed out')
  })

  // --- folder selection -----------------------------------------------------
  ipcMain.handle('dialog:select-folder', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select project folder',
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // --- file selection (attach to the LLM by path; never copied) -------------
  ipcMain.handle('dialog:select-file', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select an image or file to attach',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // --- safe file system -----------------------------------------------------
  ipcMain.handle('fs:list', (_e, root: string, rel: string) => {
    return listDir(root, rel)
  })
  ipcMain.handle('fs:walk', (_e, root: string) => {
    return walkWorkspace(root)
  })
  ipcMain.handle('fs:read', (_e, root: string, rel: string) => {
    return readFileSafe(root, rel)
  })
  ipcMain.handle('fs:write', (_e, root: string, rel: string, content: string) => {
    writeFileSafe(root, rel, content)
    return true
  })
  ipcMain.handle('fs:delete', (_e, root: string, rel: string) => {
    return deleteSafe(root, rel)
  })
  ipcMain.handle('fs:search', (_e, root: string, query: string) => {
    return searchContent(root, query)
  })
  ipcMain.handle('fs:read-image', (_e, absPath: string) => {
    return readImageDataUrl(absPath)
  })

  // --- clipboard (reliable copy for the renderer) ---------------------------
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : '')
    return true
  })

  // --- global user data folder (Data path in Settings) ----------------------
  ipcMain.handle('coder:list', (_e, rel: string) => {
    return coderDirList(rel)
  })
  ipcMain.handle('coder:read', (_e, rel: string) => {
    return coderDirRead(rel)
  })
  ipcMain.handle('coder:write', (_e, rel: string, content: string) => {
    coderDirWrite(rel, content)
    return true
  })
  ipcMain.handle('coder:delete', (_e, rel: string) => {
    return coderDirDelete(rel)
  })

  // --- screen capture (screenshot -> temp png -> attach to the model) -------
  ipcMain.handle('screenshot:capture', async () => {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.bounds
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return null
    const png = src.thumbnail.toPNG()
    const tmpPath = path.join(os.tmpdir(), `coder-shot-${Date.now()}.png`)
    try {
      fs.writeFileSync(tmpPath, png)
    } catch {
      return null
    }
    return { path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // Capture a user-selected region: full-screen overlay window, drag to select.
  ipcMain.handle('screenshot:capture-region', async () => {
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor || 1
    const { x, y, width, height } = display.bounds
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
    })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return null
    const shot = src.thumbnail

    const htmlPath = path.join(os.tmpdir(), `coder-overlay-${Date.now()}.html`)
    try {
      fs.writeFileSync(htmlPath, buildOverlayHtml(width, height, shot.toDataURL()))
    } catch {
      return null
    }

    return await new Promise<{ path: string; dataUrl: string } | null>((resolve) => {
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        fullscreenable: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(import.meta.dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

      let settled = false
      const settle = (result: { path: string; dataUrl: string } | null): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener('overlay:selected', onSelected)
        ipcMain.removeListener('overlay:cancel', onCancel)
        clearTimeout(timer)
        try {
          fs.unlinkSync(htmlPath)
        } catch {
          /* ignore */
        }
        if (!win.isDestroyed()) win.destroy()
        resolve(result)
      }
      const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.round(v), max))

      const onSelected = (_e: Electron.IpcMainEvent, rect: { x: number; y: number; width: number; height: number }): void => {
        const r = {
          x: clamp((rect?.x ?? 0) * scaleFactor, shot.getSize().width),
          y: clamp((rect?.y ?? 0) * scaleFactor, shot.getSize().height),
          width: clamp((rect?.width ?? 0) * scaleFactor, shot.getSize().width),
          height: clamp((rect?.height ?? 0) * scaleFactor, shot.getSize().height),
        }
        const cropped = shot.crop(r)
        if (cropped.isEmpty()) return settle(null)
        const png = cropped.toPNG()
        const tmpPath = path.join(os.tmpdir(), `coder-shot-${Date.now()}.png`)
        try {
          fs.writeFileSync(tmpPath, png)
        } catch {
          return settle(null)
        }
        settle({ path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
      }
      const onCancel = (): void => settle(null)

      ipcMain.on('overlay:selected', onSelected)
      ipcMain.on('overlay:cancel', onCancel)
      win.on('closed', () => settle(null))
      const timer = setTimeout(() => settle(null), 120000)

      win.loadFile(htmlPath).then(
        () => {
          win.show()
          win.focus()
        },
        () => settle(null),
      )
    })
  })

  // Normalize any attached image to a temp PNG (like screenshots), so formats
  // such as HEIC or oversized files reach the model regardless of source.
  ipcMain.handle('image:normalize', (_e, absPath: string) => {
    if (typeof absPath !== 'string' || !absPath) return null
    let img = nativeImage.createFromPath(absPath)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const maxDim = 2048
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height)
      img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
    }
    const png = img.toPNG()
    const tmpPath = path.join(os.tmpdir(), `coder-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    try {
      fs.writeFileSync(tmpPath, png)
    } catch {
      return null
    }
    return { path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // --- persistence ----------------------------------------------------------
  // Settings + chats/messages live in one SQLite DB owned by the Python
  // sidecar ({data root}/coder.db, see backend/state_db.py). The renderer
  // keeps the same store:get/store:set contract; only the backing store
  // changes. Legacy JSON files are imported on first run and then archived —
  // the app no longer writes them.
  ipcMain.handle('store:get', async (_e, key: string) => {
    const state = await loadAppState()
    if (key === 'settings') return state.settings
    if (key === 'chats') return state.chats
    return null
  })
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    if (key === 'settings') {
      queueStateWrite({ settings: value })
      return true
    }
    if (key === 'chats') {
      queueStateWrite({ chats: Array.isArray(value) ? value : [] })
      return true
    }
    if (key === 'deleted_chats') {
      queueStateWrite({ deleted_chats: Array.isArray(value) ? (value as string[]) : [] })
      return true
    }
    if (key === 'deleted_workspaces') {
      queueStateWrite({ deleted_workspaces: Array.isArray(value) ? (value as string[]) : [] })
      return true
    }
    return false
  })

  // --- data root (Settings → Data path) ------------------------------------
  ipcMain.handle('data:path', () => getDataRoot())
  // Whether a settings file already exists in the data root. Used by the
  // renderer's settings-wipe guard: on a genuine FIRST run there is no file, so
  // writing defaults is fine; on a cold start where the sidecar briefly can't
  // read an existing file (slow external volume), the renderer must NOT persist
  // its defaults over the real settings. Checks the main-process side because
  // it may succeed even while the sidecar/volume mount is still warming up.
  ipcMain.handle('data:has-settings', () => {
    try {
      return fs.existsSync(path.join(getDataRoot(), 'settings.json'))
    } catch {
      return false
    }
  })
  ipcMain.handle('data:move', async (_e, p: string) => {
    // Flush anything still queued so no state is lost across the move.
    await flushStateQueue()
    // Stop the sidecar and WAIT for it to exit so the DB's WAL is
    // checkpointed and the files are quiescent before we copy them.
    await stopSidecar()
    const win = BrowserWindow.getAllWindows()[0]
    const moved = await moveDataRootAsync(p, (label, pct) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('migrate:progress', { label, pct })
      }
    })
    // Everything lives under one root now: point it at the new location.
    setDataRoot(moved)
    try {
      await startSidecar()
    } catch (err) {
      throw new Error(`sidecar restart after data move failed: ${(err as Error).message}`)
    }
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('sidecar:changed')
    }
    appState = null
    return moved
  })
}

// --- state store (sidecar DB with legacy-JSON fallback) -------------------- //

interface AppState {
  settings: unknown
  chats: unknown[]
}

let appState: AppState | null = null
let pendingWrites: { settings?: unknown; chats?: unknown[]; deleted_chats?: string[]; deleted_workspaces?: string[] } = {}
let stateFlushTimer: ReturnType<typeof setTimeout> | null = null
let stateFlushInFlight: Promise<void> | null = null

/** Read the whole app state. Relies on the sidecar DB when reachable. */
async function loadAppState(): Promise<AppState> {
  if (appState) return appState
  // Bounded wait: never block the renderer's first load on a slow sidecar.
  const url = await Promise.race([
    getSidecarUrl().catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ])
  if (url) {
    try {
      const res = await fetch(`${url}/app/state`)
      const data = (res.ok ? await res.json() : {}) as {
        settings?: unknown
        chats?: unknown[]
      }
      const cached = readStateCache()
      // Guard: if the sidecar returns an EMPTY state (settings: null) but a
      // cache from a previous run exists, prefer the cache — a cold start on a
      // slow external volume can otherwise read "no settings" and let the
      // renderer persist defaults over the real file. The cache is refreshed by
      // refreshAppStateLater once the sidecar returns real data.
      const settings = data.settings ?? cached?.settings ?? null
      const chats = Array.isArray(data.chats) && data.chats.length > 0
        ? data.chats
        : (cached?.chats ?? [])
      appState = { settings, chats }
      writeStateCache(appState)
      return appState
    } catch {
      /* sidecar drop — fall through to cache/legacy */
    }
  }
  // Cold start: the sidecar may still be booting. Show the last cached state
  // (from a previous run) instead of an empty sidebar, then refresh in the
  // background once the sidecar is reachable.
  appState = readStateCache() ?? {
    settings: readJsonFile('settings.json', {}),
    chats: readJsonFile('chats.json', []),
  }
  void refreshAppStateLater()
  return appState
}

/** Cache the last known app state so a cold start can show it immediately.
 *  Async fire-and-forget: a full-state write must never block the main process
 *  (the old writeFileSync froze the window on every debounced flush). */
function writeStateCache(state: AppState): void {
  try {
    const file = path.join(getDataRoot(), 'app-state-cache.json')
    void fs.promises.writeFile(file, JSON.stringify(state), 'utf-8')
  } catch {
    /* non-fatal */
  }
}

function readStateCache(): AppState | null {
  try {
    const file = path.join(getDataRoot(), 'app-state-cache.json')
    if (!fs.existsSync(file)) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      settings?: unknown
      chats?: unknown[]
    }
    return {
      settings: data.settings ?? null,
      chats: Array.isArray(data.chats) ? data.chats : [],
    }
  } catch {
    return null
  }
}

/** After a cold-start fallback, fetch the real state once the sidecar is up. */
async function refreshAppStateLater(): Promise<void> {
  // getSidecarUrl() waits for the sidecar to become healthy (deduped), so a
  // single call is enough — no polling loop needed.
  const url = await getSidecarUrl().catch(() => null)
  if (!url) return
  try {
    const res = await fetch(`${url}/app/state`)
    const data = (res.ok ? await res.json() : {}) as {
      settings?: unknown
      chats?: unknown[]
    }
    const cached = readStateCache()
    // Same guard as loadAppState: never downgrade to an empty state (volume
    // still warming up) when a previous run's cache has real data.
    appState = {
      settings: data.settings ?? cached?.settings ?? null,
      chats: Array.isArray(data.chats) && data.chats.length > 0
        ? data.chats
        : (cached?.chats ?? []),
    }
    writeStateCache(appState)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sidecar:changed')
    }
  } catch {
    /* sidecar still down — leave the cached state */
  }
}

/** Merge a partial write into the pending batch and schedule a debounced flush. */
function queueStateWrite(partial: {
  settings?: unknown
  chats?: unknown[]
  deleted_chats?: string[]
  deleted_workspaces?: string[]
}): void {
  if (partial.settings !== undefined) pendingWrites.settings = partial.settings
  if (partial.chats !== undefined) pendingWrites.chats = partial.chats
  if (partial.deleted_chats !== undefined) {
    pendingWrites.deleted_chats = [
      ...(pendingWrites.deleted_chats ?? []),
      ...partial.deleted_chats,
    ]
  }
  if (partial.deleted_workspaces !== undefined) {
    pendingWrites.deleted_workspaces = [
      ...(pendingWrites.deleted_workspaces ?? []),
      ...partial.deleted_workspaces,
    ]
  }
  if (stateFlushTimer) clearTimeout(stateFlushTimer)
  stateFlushTimer = setTimeout(() => void flushStateQueue(), 300)
}

/** Write pending state to the sidecar DB (single atomic-ish POST). */
async function flushStateQueue(): Promise<void> {
  // Serialize flushes: if one is already in flight, wait for it to finish
  // before starting the next. The backend does a FULL settings overwrite, so
  // an older snapshot finishing after a newer one would silently revert the
  // user's latest change (e.g. add model + set subagent models then quit).
  // This lock guarantees newest-wins ordering.
  if (stateFlushInFlight) {
    await stateFlushInFlight
    if (!pendingWrites.settings && !Array.isArray(pendingWrites.chats) && !pendingWrites.deleted_chats?.length && !pendingWrites.deleted_workspaces?.length) return
  }
  if (stateFlushTimer) {
    clearTimeout(stateFlushTimer)
    stateFlushTimer = null
  }
  if (!pendingWrites.settings && !Array.isArray(pendingWrites.chats) && !pendingWrites.deleted_chats?.length && !pendingWrites.deleted_workspaces?.length) return
  const batch = pendingWrites
  pendingWrites = {}
  const run = (async () => {
    // Prefer the already-running sidecar (fast path, and crucial on quit: never
    // block shutdown on a 30s sidecar boot). Only if there is none do we try to
    // start one. Either way, a failure below RE-ENQUEUES the batch — a settings
    // change must never be silently dropped because the sidecar was briefly down.
    const url = peekSidecarUrl() ?? (await getSidecarUrl().catch(() => null))
    if (!url) {
      reenqueueBatch(batch)
      return
    }
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      try {
        await fetch(`${url}/app/state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch),
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(t)
      }
      // Keep the cold-start cache fresh with the latest writes.
      if (appState) {
        if (batch.settings !== undefined) appState.settings = batch.settings
        if (Array.isArray(batch.chats)) appState.chats = batch.chats
        if (batch.deleted_chats?.length) {
          appState.chats = (appState.chats ?? []).filter((c: any) => !batch.deleted_chats!.includes(c.id))
        }
        writeStateCache(appState)
      }
    } catch {
      // Sidecar briefly down / request failed: keep the batch and retry after
      // the next write. Never drop it.
      reenqueueBatch(batch)
    }
  })()
  stateFlushInFlight = run
  try {
    await run
  } finally {
    stateFlushInFlight = null
  }
}

/** Merge a failed write batch back into the pending queue so it is retried on
 *  the next flush instead of being silently dropped (would lose settings). */
function reenqueueBatch(batch: {
  settings?: unknown
  chats?: unknown[]
  deleted_chats?: string[]
  deleted_workspaces?: string[]
}): void {
  if (batch.settings !== undefined && pendingWrites.settings === undefined) pendingWrites.settings = batch.settings
  if (Array.isArray(batch.chats) && !Array.isArray(pendingWrites.chats)) pendingWrites.chats = batch.chats
  if (batch.deleted_chats?.length && !pendingWrites.deleted_chats?.length) {
    pendingWrites.deleted_chats = [...(pendingWrites.deleted_chats ?? []), ...batch.deleted_chats]
  }
  if (batch.deleted_workspaces?.length && !pendingWrites.deleted_workspaces?.length) {
    pendingWrites.deleted_workspaces = [...(pendingWrites.deleted_workspaces ?? []), ...batch.deleted_workspaces]
  }
}

/**
 * One-time migration from the legacy JSON files to the sidecar DB. Runs before
 * the renderer mounts so the very first load already reads from SQLite. Old
 * JSON files are renamed to *.bak afterwards; nothing is deleted.
 *
 * The legacy files lived at ~/.coder (the pre-1.2 default). IMPORTANT: we only
 * scan that true legacy path — never the ACTIVE data root. In the file-backed
 * store the active root's settings.json/chats.json are the LIVE state written
 * by state_db, not legacy leftovers; running this over getDataRoot() used to
 * rename the live settings.json to settings.json.bak on every launch, which
 * wiped the user's settings on each restart.
 */
async function migrateLegacyState(): Promise<void> {
  const roots = [path.join(os.homedir(), '.coder')]
  for (const root of roots) {
    await migrateLegacyStateFrom(root)
  }
}

async function migrateLegacyStateFrom(root: string): Promise<void> {
  const settingsFile = path.join(root, 'settings.json')
  const chatsFile = path.join(root, 'chats.json')
  const hasSettings = fs.existsSync(settingsFile)
  const hasChats = fs.existsSync(chatsFile)
  if (!hasSettings && !hasChats) return

  const url = await getSidecarUrl().catch(() => null)
  if (!url) return
  // Only import when the DB is still empty — never clobber newer data with
  // stale JSON (e.g. a failed rename leaves the JSON behind).
  let existing: { settings?: unknown; chats?: unknown[] } = {}
  try {
    const st = await fetch(`${url}/app/state`)
    existing = st.ok ? (await st.json()) : {}
  } catch {
    /* treat as empty */
  }
  if (existing.settings != null || (Array.isArray(existing.chats) && existing.chats.length > 0)) {
    // DB already has state — still archive the legacy files so they stop
    // shadowing the new storage, but do not import.
    if (hasSettings) {
      try { fs.renameSync(settingsFile, `${settingsFile}.bak`) } catch { /* ignore */ }
    }
    if (hasChats) {
      try { fs.renameSync(chatsFile, `${chatsFile}.bak`) } catch { /* ignore */ }
    }
    return
  }
  const body: { settings?: unknown; chats?: unknown[] } = {}
  if (hasSettings) {
    try {
      body.settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
    } catch {
      /* corrupt legacy file → ignore */
    }
  }
  if (hasChats) {
    try {
      body.chats = JSON.parse(fs.readFileSync(chatsFile, 'utf-8'))
    } catch {
      /* corrupt legacy file → ignore */
    }
  }
  if (!body.settings && !Array.isArray(body.chats)) return

  try {
    const res = await fetch(`${url}/app/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      if (hasSettings) {
        try {
          fs.renameSync(settingsFile, `${settingsFile}.bak`)
        } catch {
          /* keep the file; it is no longer read */
        }
      }
      if (hasChats) {
        try {
          fs.renameSync(chatsFile, `${chatsFile}.bak`)
        } catch {
          /* keep the file; it is no longer read */
        }
      }
    }
  } catch {
    /* sidecar not ready — the JSON stays until the next launch */
  }
}

app.whenReady().then(async () => {
  registerIpc()
  // Grant microphone access in-app so voice input works even on dev-server /
  // unsigned builds, where Electron would otherwise auto-deny media requests
  // and getUserMedia would fail silently or error out.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write',
  )
  // Import any legacy JSON state into the SQLite DB BEFORE the renderer
  // mounts, so the very first store:get already reads from the DB (and the
  // sidecar is up). Bounded to ~4s so a broken/missing backend can never stall
  // window creation; failures are non-fatal and the renderer degrades.
  try {
    await Promise.race([
      migrateLegacyState(),
      new Promise((r) => setTimeout(r, 4000)),
    ])
  } catch (err) {
    console.error('legacy migration failed:', err)
  }
  createWindow()
  // Start the sidecar lazily (a no-op if migrateLegacyState already did);
  // failures are surfaced in the UI, not fatal.
  getSidecarUrl().catch((err) => console.error('sidecar startup failed:', err))
  // Track the file open in Neovim (live RPC socket poll; see watchNvimFile).
  watchNvimFile()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    createWindow()
  }
})

let quitting = false
app.on('before-quit', (e) => {
  // Block quit until pending state writes (settings/chats) are flushed to the
  // sidecar, so user-initiated saves made right before quitting are not lost.
  if (quitting) return
  e.preventDefault()
  quitting = true
  // Ask the renderer to flush its in-memory state (deferred mid-stream writes)
  // into the main process's pending batch before we flush that batch. The
  // renderer ACKs with 'flush-persist-done' once its store:set IPC has been
  // sent, so we never flush before its writes have landed in our queue.
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('flush-persist')
  }
  // Give the renderer a short grace to push its writes, then flush the main
  // queue. A hard timeout guarantees the app ALWAYS closes even if the sidecar
  // is unresponsive (a hung fetch must never block quit).
  const finish = () => {
    stopSidecar()
    app.quit()
  }
  const hardTimer = setTimeout(finish, 8000)
  let flushed = false
  const doFlush = async () => {
    if (flushed) return
    flushed = true
    // Retry a few times: flushStateQueue re-enqueues on failure, but on quit
    // there is no later flush — so a briefly-slow sidecar must not silently
    // drop the user's settings. Each attempt has its own 1.5s fetch timeout.
    for (let attempt = 0; attempt < 4; attempt++) {
      await flushStateQueue().catch(() => {})
      const stillPending =
        pendingWrites.settings !== undefined ||
        Array.isArray(pendingWrites.chats) ||
        (pendingWrites.deleted_chats?.length ?? 0) > 0 ||
        (pendingWrites.deleted_workspaces?.length ?? 0) > 0
      if (!stillPending) break
      await new Promise((r) => setTimeout(r, 300))
    }
    clearTimeout(hardTimer)
    finish()
  }
  const ackTimer = setTimeout(doFlush, 1500)
  ipcMain.once('flush-persist-done', () => {
    clearTimeout(ackTimer)
    // Tiny delay so the renderer's store:set IPC lands in the main queue
    // before we flush it.
    setTimeout(doFlush, 100)
  })
})