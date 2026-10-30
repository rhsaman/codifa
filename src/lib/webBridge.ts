/**
 * Web bridge: the browser implementation of `window.coder` against the codifa
 * server (`codifa serve`).
 *
 * The desktop app reaches these capabilities through Tauri IPC; a browser has
 * no Tauri runtime, so this bridge carries the same `CoderApi` surface over:
 * - the native router's HTTP endpoints (the agent/chat/git/skills traffic was
 *   ALREADY HTTP — `ensureSidecar()` just resolves to this page's origin, so
 *   every fetch in src/lib/api.ts works here unchanged), plus
 * - `/web/call` (the server-side command dispatcher), `/web/upload` for
 *   dropped files, and `/ws/terminal` for live pty sessions.
 *
 * The server token-gates all of it (see backend_light::web_auth); the session
 * cookie is planted when the user opens the `?token=…` URL the server prints.
 *
 * Desktop-only capabilities (native dialogs, screen capture, TCC, the
 * updater) answer their type's "unavailable" values rather than throwing: the
 * UI already renders a harness/stub world, and a web user must get a clean
 * degradation, not a crash.
 */
import type {
  CoderApi,
  FileEntry,
  OpResult,
  SearchMatch,
  TerminalSessionInfo,
} from '../types/coderApi'

const ORIGIN = window.location.origin

/** One round-trip to the server command dispatcher. Throws like invoke does. */
async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${ORIGIN}/web/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  })
  if (!res.ok) throw new Error(`${cmd}: HTTP ${res.status}`)
  const data = (await res.json()) as { ok: boolean; result?: T; error?: string }
  if (!data.ok) throw new Error(data.error ?? `${cmd} failed`)
  return data.result as T
}

// ---------------------------------------------------------------------------
// Terminal channel: one WebSocket multiplexes every pty session. The client
// routes `data`/`exit` events by session id — the same payload shape the
// desktop renderer receives from the `terminal:data` / `terminal:exit` events.
// ---------------------------------------------------------------------------

type TermReply = {
  req?: number
  t: string
  id?: string
  data?: string
  code?: number
  ok?: boolean
  info?: TerminalSessionInfo
  sessions?: TerminalSessionInfo[]
  message?: string
}

const REQ_TIMEOUT_MS = 20_000

class TerminalChannel {
  private ws: WebSocket | null = null
  private opening: Promise<WebSocket> | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (r: TermReply) => void; timer: ReturnType<typeof setTimeout> }>()
  private dataCbs = new Set<(id: string, data: string) => void>()
  private exitCbs = new Set<(id: string, code: number) => void>()
  private closed = false

  private url(): string {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/ws/terminal`
  }

  /** Connected socket, opening one on demand. Reconnects while callbacks exist. */
  async ready(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    if (this.opening) return this.opening
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url())
      } catch (e) {
        this.opening = null
        reject(e instanceof Error ? e : new Error('websocket construct failed'))
        return
      }
      const timer = setTimeout(() => {
        ws.close()
        this.opening = null
        reject(new Error('terminal websocket timeout'))
      }, REQ_TIMEOUT_MS)
      ws.onopen = () => {
        clearTimeout(timer)
        this.ws = ws
        this.opening = null
        resolve(ws)
      }
      ws.onmessage = (e) => {
        let msg: TermReply
        try {
          msg = JSON.parse(String(e.data)) as TermReply
        } catch {
          return
        }
        if (msg.t === 'data' && msg.id) {
          for (const cb of this.dataCbs) cb(msg.id, msg.data ?? '')
        } else if (msg.t === 'exit' && msg.id) {
          for (const cb of this.exitCbs) cb(msg.id, msg.code ?? 0)
        } else if (msg.req != null) {
          const entry = this.pending.get(msg.req)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(msg.req)
            entry.resolve(msg)
          }
        }
      }
      ws.onclose = () => {
        this.ws = null
        // Fail anything still awaiting a reply — terminalCreate must not hang.
        for (const [k, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.resolve({ t: 'error', message: 'terminal websocket closed' })
          this.pending.delete(k)
        }
        // A panel that died with the socket revives through terminalList();
        // reconnect so NEW creates keep working while the page stays open.
        if (!this.closed && (this.dataCbs.size > 0 || this.exitCbs.size > 0)) {
          setTimeout(() => {
            this.ready().catch(() => {
              /* retried again by the next create/subscribe */
            })
          }, 2000)
        }
      }
    })
    return this.opening
  }

  async request(payload: Record<string, unknown>): Promise<TermReply> {    const ws = await this.ready()
    const req = ++this.seq
    return new Promise<TermReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req)
        resolve({ t: 'error', message: 'terminal request timeout' })
      }, REQ_TIMEOUT_MS)
      this.pending.set(req, { resolve, timer })
      ws.send(JSON.stringify({ req, ...payload }))
    })
  }

  subscribeData(cb: (id: string, data: string) => void): () => void {
    this.dataCbs.add(cb)
    void this.ready().catch(() => {})
    return () => this.dataCbs.delete(cb)
  }

  subscribeExit(cb: (id: string, code: number) => void): () => void {
    this.exitCbs.add(cb)
    void this.ready().catch(() => {})
    return () => this.exitCbs.delete(cb)
  }

  dispose(): void {
    this.closed = true
    this.ws?.close()
  }
}

// ---------------------------------------------------------------------------
// Dropped web files: a browser File has no server path, so getPathForFile
// hands out a synthetic id and importFile uploads the content through
// /web/upload, returning the REAL server path every later read uses.
// ---------------------------------------------------------------------------

const webFileIds = new WeakMap<File, string>()
const webFiles = new Map<string, File>()
let webFileSeq = 0

async function uploadWebFile(id: string): Promise<string | null> {
  const file = webFiles.get(id)
  if (!file) return null
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await fetch(`${ORIGIN}/web/upload`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload: HTTP ${res.status}`)
  const data = (await res.json()) as { ok: boolean; path?: string }
  if (!data.ok || !data.path) return null
  return data.path
}

let lastPromptedPath = ''

/** The web stand-in for the native folder/file dialog: the user types the
 *  absolute SERVER path, validated through fs_list before it is accepted. */
async function promptForServerPath(
  kind: 'folder' | 'file',
): Promise<string | string[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = window.prompt(
      attempt === 0
        ? `Enter the absolute ${kind} path on the server:`
        : 'Path not found on the server — try again:',
      lastPromptedPath,
    )
    if (value == null) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    lastPromptedPath = trimmed
    try {
      await call<FileEntry[]>('fs_list', { root: trimmed, rel: '' })
      return kind === 'file' ? [trimmed] : trimmed
    } catch {
      // fall through to the next prompt
    }
  }
  return null
}

const bridge: CoderApi = {
  // The server IS the sidecar in web mode: same origin as this page.
  getSidecarUrl: () => Promise.resolve(ORIGIN),
  probeSidecar: async () => {
    try {
      const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(2500) })
      return res.ok
    } catch {
      return false
    }
  },
  secretsGetKey: () => call<string>('secrets_get_key'),
  getEnv: (key) => call<string | null>('get_env', { key }),

  googleSignIn: async () => {
    throw new Error(
      'Google sign-in opens a browser on the SERVER machine, so it needs the desktop app — use an API key for this provider instead.',
    )
  },

  selectFolder: async () => (await promptForServerPath('folder')) as string | null,
  selectFile: async () => (await promptForServerPath('file')) as string[],

  importFile: async (absPath) => {
    if (absPath.startsWith('webfile:')) return uploadWebFile(absPath)
    return call<string | null>('import_file', { abs_path: absPath })
  },

  fsList: (root, rel) => call<FileEntry[]>('fs_list', { root, rel }),
  fsWalk: (root) =>
    call<{ path: string; name: string }[]>('fs_walk', { root }).then((entries) =>
      entries.map((e) => ({ rel: e.path, name: e.name })),
    ),
  fsRead: (root, rel) => call<{ content: string } | null>('fs_read', { root, rel }),
  fsWrite: (root, rel, content) => call<boolean>('fs_write', { root, rel, content }),
  fsDelete: (root, rel) => call<boolean>('fs_delete', { root, rel }),
  fsCopy: (root, from, to) => call<boolean>('fs_copy', { root, from, to }),
  fsRename: (root, from, to) => call<boolean>('fs_rename', { root, from, to }),
  coderList: (rel) => call<FileEntry[]>('coder_list', { rel }),
  coderRead: (rel) => call<{ content: string }>('coder_read', { rel }),
  coderWrite: (rel, content) => call<boolean>('coder_write', { rel, content }),
  coderDelete: (rel) => call<boolean>('coder_delete', { rel }),

  copyText: async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Clipboard permission denied (or insecure context): the textarea
      // fallback covers http://lan-ip access where the async clipboard API
      // is gated away.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    }
  },
  searchContent: (root, query) => call<SearchMatch[]>('search_content', { root, query }),
  readImage: (absPath) => call<string | null>('read_image', { abs_path: absPath }),
  readPdfBase64: (absPath) => call<string | null>('read_pdf_base64', { abs_path: absPath }),
  normalizeImage: (absPath) =>
    call<{ path: string; dataUrl: string } | null>('normalize_image', { abs_path: absPath }),

  captureScreen: () => Promise.resolve(null),
  computerPermissions: () =>
    Promise.resolve({ screen: false, accessibility: false, identity: null }),
  requestScreenRecording: () => Promise.resolve(false),

  getPathForFile: (file) => {
    const existing = webFileIds.get(file)
    if (existing) return existing
    const id = `webfile:${++webFileSeq}`
    webFileIds.set(file, id)
    webFiles.set(id, file)
    return id
  },

  storeGet: <T>(key: string) => call<T | null>('store_get', { key }),
  storeSet: (key, value) => call<boolean>('store_set', { key, value }),
  chatGet: <T>(id: string) => call<T | null>('chat_get', { id }),
  getDataPath: () => call<string>('get_data_path'),
  hasSettingsFile: () => call<boolean>('has_settings_file'),

  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  },
  openExternalChrome: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  },
  openFileExternal: async () => ({
    ok: false,
    error: 'Opening files in external apps needs the desktop app — use the in-app viewer or a terminal tab.',
  }),
  openWorkspaceFolder: async () => ({
    ok: false,
    error: 'Revealing a folder is a desktop capability.',
  }),
  openWorkspaceTerminal: async () => ({
    ok: false,
    error: 'Open a terminal tab inside the app instead (the in-app terminal works in the web version).',
  }),

  terminalCreate: async (cwd, program, args, shell, id) => {
    const reply = await channels.terminal.request({
      t: 'create',
      cwd,
      program: program ?? null,
      args: args ?? null,
      shell: shell ?? null,
      requested_id: id ?? null,
    })
    if (reply.t === 'created' && reply.info) return reply.info
    throw new Error(reply.message ?? 'terminal_create failed')
  },
  terminalList: async () => {
    const reply = await channels.terminal.request({ t: 'list' })
    return reply.sessions ?? []
  },
  terminalWrite: async (id, data) => {
    const reply = await channels.terminal.request({ t: 'write', id, data })
    return reply.ok ?? false
  },
  terminalResize: async (id, cols, rows) => {
    const reply = await channels.terminal.request({ t: 'resize', id, cols, rows })
    return reply.ok ?? false
  },
  terminalKill: async (id) => {
    const reply = await channels.terminal.request({ t: 'kill', id })
    return reply.ok ?? false
  },
  onTerminalData: (cb) => channels.terminal.subscribeData(cb),
  onTerminalExit: (cb) => channels.terminal.subscribeExit(cb),

  moveDataPath: (p) => call<string>('move_data_path', { p }),
  onSidecarChanged: () => () => {},
  onSidecarDead: () => () => {},
  // The server persists synchronously (no coalescing window to flush).
  onFlushPersist: () => () => {},
  flushPersistDone: () => {},
  onMigrateProgress: () => () => {},

  createBackup: (destDir) => call('create_backup', { dest_dir: destDir }),
  cancelBackup: () => call<void>('cancel_backup'),
  onBackupProgress: () => () => {},
  onRestoreProgress: () => () => {},
  backupInfo: (path) =>
    call<{ created: string; files: number; bytes: number; version: string; dataRoot: string }>(
      'backup_info',
      { path },
    ),
  restoreBackup: (path) => call<{ files: number; elapsedMs: number }>('restore_backup', { path }),
  restartApp: async () => {
    // The server process re-execs; the answer may never arrive. Poll /health
    // and reload so the page lands on the fresh server.
    void call<void>('restart_app').catch(() => {})
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) break
      } catch {
        /* still restarting */
      }
    }
    window.location.reload()
  },

  checkForUpdates: () =>
    Promise.resolve({
      available: false,
      currentVersion: 'web',
      latestVersion: 'web',
      notes: 'The web server build updates like any server binary: pull and restart.',
      assetName: null,
      assetUrl: null,
      releaseUrl: '',
    }),
  startUpdate: async () => ({ ok: false, error: 'Auto-update is desktop-only.' }),
  onUpdateProgress: () => () => {},
}

/** Lazily created singletons (module-level would connect on import even in
 *  pages that never use a terminal — the harness loads this module too). */
const channels = { terminal: new TerminalChannel() }

/** Install the web bridge. Only when NOTHING else already provides
 *  `window.coder` — the Tauri bridge wins on desktop, the test harness stub
 *  wins on the harness pages. */
export function installWebBridge(): boolean {
  const w = window as unknown as { coder?: unknown }
  if (w.coder) return false
  w.coder = bridge
  return true
}

/** True when this page is served by a codifa server (not the Tauri shell). */
export function isWebMode(): boolean {
  return (window as unknown as { coder?: unknown }).coder === bridge
}
