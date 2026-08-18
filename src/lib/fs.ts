import type { NvimDiagnostic } from '../types'

export interface FileEntry {
  name: string
  kind: 'file' | 'dir' | 'link'
  path: string
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

export const api = {
  getSidecarUrl: () => window.coder.getSidecarUrl(),
  getEnv: (key: string): Promise<string | null> => window.coder.getEnv(key),
  googleSignIn: (
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> =>
    window.coder.googleSignIn(clientId, clientSecret, scope),
  selectFolder: () => window.coder.selectFolder(),
  selectFile: () => window.coder.selectFile(),
  fsList: (root: string, rel: string): Promise<FileEntry[]> => window.coder.fsList(root, rel),
  fsWalk: (root: string): Promise<WorkspaceFile[]> => window.coder.fsWalk(root),
  fsRead: (root: string, rel: string): Promise<{ content: string }> => window.coder.fsRead(root, rel),
  fsWrite: (root: string, rel: string, content: string): Promise<boolean> =>
    window.coder.fsWrite(root, rel, content),
  fsDelete: (root: string, rel: string): Promise<boolean> =>
    window.coder.fsDelete(root, rel),
  coderList: (rel: string): Promise<FileEntry[]> => window.coder.coderList(rel),
  coderRead: (rel: string): Promise<{ content: string }> => window.coder.coderRead(rel),
  coderWrite: (rel: string, content: string): Promise<boolean> =>
    window.coder.coderWrite(rel, content),
  coderDelete: (rel: string): Promise<boolean> => window.coder.coderDelete(rel),
  searchContent: (root: string, query: string): Promise<SearchMatch[]> =>
    window.coder.searchContent(root, query),
  readImage: (absPath: string): Promise<string | null> => window.coder.readImage(absPath),
  normalizeImage: (absPath: string): Promise<{ path: string; dataUrl: string } | null> =>
    window.coder.normalizeImage(absPath),
  captureScreen: (): Promise<{ path: string; dataUrl: string } | null> => window.coder.captureScreen(),
  captureRegion: (): Promise<{ path: string; dataUrl: string } | null> => window.coder.captureRegion(),
  getPathForFile: (file: File): string => window.coder.getPathForFile(file),
  storeGet: <T>(key: string): Promise<T | null> => window.coder.storeGet<T>(key),
  storeSet: (key: string, value: unknown): Promise<boolean> => window.coder.storeSet(key, value),
  getDataPath: (): Promise<string> => window.coder.getDataPath(),
  hasSettingsFile: (): Promise<boolean> => window.coder.hasSettingsFile(),
  moveDataPath: (p: string): Promise<string> => window.coder.moveDataPath(p),
  onSidecarChanged: (cb: () => void): (() => void) => window.coder.onSidecarChanged(cb),
  onFlushPersist: (cb: () => void): (() => void) => window.coder.onFlushPersist(cb),
  flushPersistDone: (): void => window.coder.flushPersistDone(),
  onMigrateProgress: (cb: (evt: { label: string; pct: number }) => void): (() => void) =>
    window.coder.onMigrateProgress(cb),
  getNvimFile: (): Promise<{ abs: string | null; diagnostics: NvimDiagnostic[] }> =>
    window.coder.getNvimFile() as Promise<{ abs: string | null; diagnostics: NvimDiagnostic[] }>,
  onNvimFile: (
    cb: (f: { abs: string | null; diagnostics: NvimDiagnostic[] }) => void,
  ): (() => void) =>
    window.coder.onNvimFile(
      (f: { abs: string | null; diagnostics: unknown[] }) =>
        cb(f as { abs: string | null; diagnostics: NvimDiagnostic[] }),
    ),
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'dist-electron',
  'release', 'build', 'coverage', '.idea', '.vscode', '.next', 'out', 'target',
  'node_modules/.cache', 'vendor',
])
const MAX_INDEXED = 800

export interface WorkspaceFile {
  rel: string
  name: string
}

export async function workspaceFiles(root: string): Promise<WorkspaceFile[]> {
  // Single-pass walk in the main process: fast, no per-directory IPC, and no
  // 800-file cap that used to silently drop whole subfolders (e.g. the second
  // of two project folders). Falls back to the old per-dir walk if unavailable.
  const walked = await api.fsWalk(root).catch(() => null)
  if (walked) return walked
  const out: WorkspaceFile[] = []
  const stack: string[] = ['']
  while (stack.length > 0 && out.length < MAX_INDEXED) {
    const rel = stack.pop()!
    const entries = await api.fsList(root, rel).catch(() => [])
    for (const e of entries) {
      if (e.kind === 'dir') {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(e.path)
      } else {
        out.push({ rel: e.path, name: e.name })
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}
