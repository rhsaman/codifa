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
  probeSidecar: () => window.coder.probeSidecar(),
  getEnv: (key: string): Promise<string | null> => window.coder.getEnv(key),
  googleSignIn: (
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> =>
    window.coder.googleSignIn(clientId, clientSecret, scope),
  selectFolder: () => window.coder.selectFolder(),
  selectFile: () => window.coder.selectFile(),
  importFile: (absPath: string): Promise<string | null> => window.coder.importFile(absPath),
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
  onSidecarDead: (cb: () => void): (() => void) => window.coder.onSidecarDead(cb),
  onFlushPersist: (cb: () => void): (() => void) => window.coder.onFlushPersist(cb),
  flushPersistDone: (): void => window.coder.flushPersistDone(),
  onMigrateProgress: (cb: (evt: { label: string; pct: number }) => void): (() => void) =>
    window.coder.onMigrateProgress(cb),
  openFileExternal: async (
    absPath: string,
    editor: 'nvim' | 'vscode' | 'cmux' | 'ghostty' | 'warp' | 'default',
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const fn = (window as unknown as { coder?: { openFileExternal?: unknown } }).coder?.openFileExternal
      if (typeof fn !== 'function') {
        return { ok: false, error: 'External open is unavailable (preload outdated — rebuild the app).' }
      }
      const res = await (fn as (a: string, e: string) => Promise<{ ok: boolean; error?: string } | null>).call(window.coder, absPath, editor)
      if (res && typeof res.ok === 'boolean') return res
      return { ok: false, error: 'External open is unavailable in this environment.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  openWorkspaceFolder: async (dir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const fn = (window as unknown as { coder?: { openWorkspaceFolder?: unknown } }).coder?.openWorkspaceFolder
      if (typeof fn !== 'function') {
        return { ok: false, error: 'Reveal in file manager is unavailable (preload outdated — rebuild the app).' }
      }
      const res = await (fn as (d: string) => Promise<{ ok: boolean; error?: string } | null>).call(window.coder, dir)
      if (res && typeof res.ok === 'boolean') return res
      return { ok: false, error: 'Reveal in file manager is unavailable in this environment.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  openWorkspaceTerminal: async (dir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const fn = (window as unknown as { coder?: { openWorkspaceTerminal?: unknown } }).coder?.openWorkspaceTerminal
      if (typeof fn !== 'function') {
        return { ok: false, error: 'Terminal open is unavailable (preload outdated — rebuild the app).' }
      }
      const res = await (fn as (d: string) => Promise<{ ok: boolean; error?: string } | null>).call(window.coder, dir)
      if (res && typeof res.ok === 'boolean') return res
      return { ok: false, error: 'Terminal open is unavailable in this environment.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'dist-electron',
  'release', 'build', 'coverage', '.idea', '.vscode', '.next', 'out', 'target',
  'node_modules/.cache', 'vendor', '.ruff_cache', '.github', '.playwright', '.playwright-mcp',
])
const MAX_INDEXED = 800

export interface WorkspaceFile {
  rel: string
  name: string
}

/** Per-root usage-frequency counters for quick-open (Ctrl+P), so "most used"
 *  sort has something to sort by. Persisted in localStorage — renderer-only,
 *  no IPC round-trip needed, and it's a soft UX preference (not critical
 *  data), so a quota/parse failure just degrades to alphabetical, not fatal. */
const FILE_USAGE_PREFIX = 'coder:file-usage:'

export function loadFileUsage(root: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(FILE_USAGE_PREFIX + root)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function bumpFileUsage(root: string, rel: string): void {
  try {
    const usage = loadFileUsage(root)
    usage[rel] = (usage[rel] ?? 0) + 1
    localStorage.setItem(FILE_USAGE_PREFIX + root, JSON.stringify(usage))
  } catch {
    /* ignore */
  }
}

/** Per-root quick-open cache (TTL like the Electron walk cache): Ctrl+P re-opens
 *  re-walk the same tree every time; caching the file list per root for a few
 *  seconds turns repeated opens into a map hit instead of a full IPC walk. */
const WORKSPACE_CACHE_TTL_MS = 10_000
const workspaceCache = new Map<string, { at: number; files: WorkspaceFile[] }>()

export async function workspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const hit = workspaceCache.get(root)
  if (hit && Date.now() - hit.at < WORKSPACE_CACHE_TTL_MS) return hit.files
  // Single-pass walk in the main process: fast, no per-directory IPC, and no
  // 800-file cap that used to silently drop whole subfolders (e.g. the second
  // of two project folders). Falls back to the old per-dir walk if unavailable.
  const walked = await api.fsWalk(root).catch(() => null)
  const files = walked ?? (await fallbackWalk(root))
  workspaceCache.set(root, { at: Date.now(), files })
  // Keep the cache bounded: drop the oldest entry when it grows past 20 roots.
  if (workspaceCache.size > 20) {
    const oldest = workspaceCache.keys().next().value
    if (oldest !== undefined) workspaceCache.delete(oldest)
  }
  return files
}

async function fallbackWalk(root: string): Promise<WorkspaceFile[]> {
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

/** Strip invisible bidi/zero-width marks and normalize separators. Model
 *  output and tool results routinely carry RTL marks inside paths, which made
 *  `fs_read` miss a file that exists while the suggestion list (which already
 *  normalized) found it. */
export function normPath(p: string): string {
  return p
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
}

/** Resolve a chip path that failed to open directly against the workspace
 *  index. A scoped grep returns bare names ("toolNesting.test.ts" for
 *  path=tests) and a moved file keeps its name, so an exact basename match
 *  wins; otherwise the closest suggestion is used. Returns null when nothing
 *  matches — the caller then reports the path as missing. */
export function resolveWorkspacePath(
  target: string,
  files: WorkspaceFile[],
): WorkspaceFile | null {
  const clean = normPath(target)
  const base = clean.split('/').pop() ?? clean
  if (!base) return null
  const exact = files.find((f) => f.name === base)
  if (exact) return exact
  return suggestSimilarFiles(clean, files, 1)[0] ?? null
}

/** Rank workspace files that look like the closest match for a path that
 *  failed to open — model output (plans, summaries) is full of paths that were
 *  never created or have moved, and a bare "not found" is a dead end. Order:
 *  the same basename elsewhere in the tree first, then files in the same
 *  directory, then same-extension names sharing a stem prefix. Pure so
 *  plain-node tests can cover the ranking. */
export function suggestSimilarFiles(
  targetRel: string,
  files: WorkspaceFile[],
  limit = 8,
): WorkspaceFile[] {
  const norm = normPath
  const target = norm(targetRel)
  if (!target) return []
  const base = target.split('/').pop() ?? target
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
  const scored: { file: WorkspaceFile; score: number }[] = []
  for (const f of files) {
    const rel = norm(f.rel)
    if (!rel || rel === target) continue
    const fb = rel.split('/').pop() ?? rel
    const fdot = fb.lastIndexOf('.')
    const fstem = (fdot > 0 ? fb.slice(0, fdot) : fb).toLowerCase()
    const fext = fdot > 0 ? fb.slice(fdot).toLowerCase() : ''
    const fdir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    let score = 0
    if (fb.toLowerCase() === base.toLowerCase()) score = 100
    else if (fdir === dir) score = 60
    else if (
      ext &&
      fext === ext &&
      stem.length >= 3 &&
      (fstem.startsWith(stem.slice(0, 3)) || stem.startsWith(fstem.slice(0, 3)))
    )
      score = 40
    if (score > 0) scored.push({ file: { rel, name: f.name }, score })
  }
  scored.sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel))
  return scored.slice(0, limit).map((s) => s.file)
}
