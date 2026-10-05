/**
 * In-app terminal panel backend.
 *
 * Owns the PTY sessions spawned with node-pty in the main process and bridges
 * them to the renderer over IPC:
 *
 *   terminal:create  → spawn a login shell, returns {id, shell, cwd}
 *   terminal:list    → live sessions (a reloaded renderer re-attaches to them)
 *   terminal:write   → user keystrokes into the pty
 *   terminal:resize  → cols/rows from the xterm fit addon
 *   terminal:kill    → close one session
 *   terminal:data    (event) → pty output, tagged with the session id
 *   terminal:exit    (event) → session ended, tagged with the session id
 *
 * Sessions outlive the panel being closed (like VSCode) and are killed when
 * the app quits.
 */
import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import * as pty from 'node-pty'

interface TerminalSession {
  id: string
  term: pty.IPty
  /** Basename of the shell binary (zsh, bash, powershell, …) for the tab label. */
  shell: string
  cwd: string
}

const sessions = new Map<string, TerminalSession>()

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/** Spawn a login shell so the user's profile (PATH with Homebrew, nvm, …)
 *  applies, exactly like a terminal opened inside their DE would. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'powershell.exe', args: [] }
  }
  const file = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: ['-l'] }
}

/** Only accept an existing absolute directory; anything else falls back to the
 *  home dir (a stale workspace path must never fail the spawn). */
function validCwd(dir: unknown): string {
  if (typeof dir === 'string') {
    const d = dir.trim()
    if (d && path.isAbsolute(d)) {
      try {
        if (fs.statSync(d).isDirectory()) return d
      } catch {
        /* fall through to home */
      }
    }
  }
  return os.homedir()
}

function killSession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  sessions.delete(id)
  try {
    s.term.kill()
  } catch {
    /* already dead */
  }
  return true
}

/** Kill every live session — called once on app quit so no orphaned shells
 *  are left behind. */
export function killAllTerminalSessions(): void {
  for (const id of Array.from(sessions.keys())) killSession(id)
}

export function registerTerminalIpc(): void {
  ipcMain.handle('terminal:create', (_e, dir: unknown) => {
    const cwd = validCwd(dir)
    const { file, args } = defaultShell()
    const term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as { [key: string]: string },
    })
    const id = randomUUID()
    const session: TerminalSession = { id, term, shell: path.basename(file), cwd }
    sessions.set(id, session)
    term.onData((data) => broadcast('terminal:data', id, data))
    term.onExit(({ exitCode }) => {
      // Only report if still tracked — an explicit kill already removed it.
      if (sessions.delete(id)) broadcast('terminal:exit', id, exitCode)
    })
    return { id, shell: session.shell, cwd }
  })

  ipcMain.handle('terminal:list', () =>
    Array.from(sessions.values()).map((s) => ({ id: s.id, shell: s.shell, cwd: s.cwd })),
  )

  ipcMain.handle('terminal:write', (_e, id: unknown, data: unknown) => {
    const s = sessions.get(typeof id === 'string' ? id : '')
    if (!s || typeof data !== 'string') return false
    s.term.write(data)
    return true
  })

  ipcMain.handle('terminal:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    const s = sessions.get(typeof id === 'string' ? id : '')
    const c = Math.round(Number(cols))
    const r = Math.round(Number(rows))
    if (!s || !Number.isFinite(c) || !Number.isFinite(r)) return false
    s.term.resize(Math.max(2, Math.min(500, c)), Math.max(2, Math.min(200, r)))
    return true
  })

  ipcMain.handle('terminal:kill', (_e, id: unknown) => killSession(typeof id === 'string' ? id : ''))
}
