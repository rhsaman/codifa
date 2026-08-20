import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { getDataRoot } from '../store-db'

/**
 * Resolve a renderer-supplied relative path against a project ROOT, rejecting
 * any attempt to escape it (absolute paths, `..`, symlink escapes).
 * Non-existent targets resolve against their nearest existing ancestor so new
 * files can still be written inside the root.
 */
export function resolveSafe(root: string, relPath: string): string {
  const rootReal = fs.realpathSync(root)
  const rel = relPath.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  // The root itself: no dirname check (the parent is, by definition, outside).
  if (!rel) return rootReal
  const candidate = path.join(rootReal, rel)
  // Walk up to the nearest EXISTING ancestor (the target itself may not exist
  // yet) and resolve THAT, so a brand-new nested path (e.g. .codifa/skills/x)
  // can be created without the intermediate directories existing. If that
  // ancestor is a symlink, realpathSync resolves its target and the containment
  // check below still catches any escape out of the root.
  let anchor = candidate
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor)
    if (parent === anchor) throw new Error('path escapes project root')
    anchor = parent
  }
  const anchorReal = fs.realpathSync(anchor)
  if (anchorReal !== rootReal && !anchorReal.startsWith(rootReal + path.sep)) {
    throw new Error('path escapes project root')
  }
  return path.join(anchorReal, path.relative(anchor, candidate))
}

/** Directories excluded from file listings / quick-open / search. Mirrors
 *  backend/tools.py `_SKIP_DIRS` so the agent, Ctrl+P and the file tree all
 *  agree on what is visible. Hidden dirs NOT in this set (`.config`, `.github`,
 *  …) stay visible — config files are real workspace content. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
  '.nuxt', 'dist', 'dist-electron', 'release', 'build', 'coverage',
  '.cache', '.idea', '.vscode', '.DS_Store', 'target', 'vendor',
  '.tox', '.mypy_cache', '.pytest_cache', 'out', 'bin', 'obj',
])

const MAX_WALK_FILES = 50_000

/** Per-root walk cache (TTL like backend/tools.py `_walk_cache`): Ctrl+P and
 *  content search re-walk the same tree on every open/keystroke; caching the
 *  file list per root for a few seconds turns repeated walks into a map hit. */
const WALK_CACHE_TTL_MS = 10_000
const walkCache = new Map<string, { at: number; files: string[] }>()

function cachedWalk(root: string): string[] {
  const hit = walkCache.get(root)
  if (hit && Date.now() - hit.at < WALK_CACHE_TTL_MS) return hit.files
  const files: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && files.length < MAX_WALK_FILES) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (files.length >= MAX_WALK_FILES) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(full)
      } else if (e.isFile()) {
        if (e.name === '.DS_Store') continue
        files.push(full)
      }
    }
  }
  walkCache.set(root, { at: Date.now(), files })
  // Keep the cache bounded: drop the oldest entry when it grows past 50 roots.
  if (walkCache.size > 50) {
    const oldest = walkCache.keys().next().value
    if (oldest !== undefined) walkCache.delete(oldest)
  }
  return files
}

/** Walk the whole workspace tree in ONE pass and return every file quick-open
 *  should index (relative path + name). Skips dependency/build dirs and
 *  dot-dirs like `.git`/`.cache`, but keeps other dotfiles (`.config`, `.env`,
 *  `.github`) so config files are findable. A single IPC call avoids the old
 *  per-directory round-trips and the 800-file cap that silently dropped whole
 *  subfolders (e.g. the second of two project folders). */
export function walkWorkspace(root: string): { rel: string; name: string }[] {
  if (!root || !fs.existsSync(root)) return []
  const out: { rel: string; name: string }[] = []
  for (const full of cachedWalk(root)) {
    out.push({
      rel: path.relative(root, full).split(path.sep).join('/'),
      name: path.basename(full),
    })
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

export function listDir(root: string, relPath: string): { name: string; kind: string; path: string }[] {
  if (!root || !fs.existsSync(root)) return []
  let target: string
  try {
    target = resolveSafe(root, relPath)
  } catch {
    return []
  }
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: { name: string; kind: string; path: string }[] = []
  for (const name of dirents) {
    if (name.isDirectory() && SKIP_DIRS.has(name.name)) continue
    if (name.isFile() && name.name === '.DS_Store') continue
    let kind = 'file'
    if (name.isSymbolicLink()) kind = 'link'
    else if (name.isDirectory()) kind = 'dir'
    const rel = [relPath, name.name].filter(Boolean).join('/')
    entries.push({ name: name.name, kind, path: rel })
  }
  entries.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (a.kind !== 'dir' && b.kind === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export function readFileSafe(root: string, relPath: string): { content: string } | null {
  const target = resolveSafe(root, relPath)
  if (!fs.existsSync(target)) return null
  if (fs.statSync(target).isDirectory()) {
    throw new Error('path is a directory')
  }
  return { content: fs.readFileSync(target, 'utf-8') }
}

export function writeFileSafe(root: string, relPath: string, content: string): void {
  const target = resolveSafe(root, relPath)
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    throw new Error('path is a directory')
  }
  const dir = path.dirname(target)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

export function deleteSafe(root: string, relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  if (!rel) return false
  const target = resolveSafe(root, rel)
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

const TEXT_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.yaml', '.yml',
  '.toml', '.md', '.mdx', '.txt', '.html', '.css', '.scss', '.less', '.vue',
  '.svelte', '.c', '.cc', '.cpp', '.h', '.hpp', '.rs', '.go', '.java',
  '.kt', '.swift', '.rb', '.php', '.sh', '.bash', '.zsh', '.sql',
  '.xml', '.ini', '.cfg', '.conf', '.env', '.csv', '.tsv', '.gitignore',
])

const MAX_SEARCH_MATCHES = 200
const MAX_SEARCH_BYTES = 2_000_000

function walkFiles(root: string): string[] {
  return cachedWalk(root)
}

/** ripgrep is the fast path for content search (the backend already uses it).
 *  Build include/exclude globs from the SAME sets the JS walk uses so both
 *  paths agree on what is searchable. */
const RG_INCLUDE_GLOBS = [...TEXT_EXTENSIONS].map((ext) => `**/*${ext}`)
const RG_EXCLUDE_GLOBS: string[] = []
for (const d of SKIP_DIRS) {
  RG_EXCLUDE_GLOBS.push(`!**/${d}/**`, `!**/${d}`)
}

/** Content search via ripgrep, spawned with cwd=root so match paths come back
 *  relative to the root. Returns null when rg is unavailable so the caller
 *  falls back to the JS scan. Non-blocking: the main process is never held up
 *  on a big repo (the old sync read-every-file scan froze the whole app). */
function rgSearch(root: string, query: string): Promise<SearchMatch[] | null> {
  return new Promise((resolve) => {
    const args = [
      '--json', '-i', '-F', '--no-ignore', '--hidden', '--color', 'never',
      '--max-filesize', String(MAX_SEARCH_BYTES),
    ]
    // Each glob MUST be its own `-g` flag — passing them bare makes rg treat
    // them as positional paths (it then searches the WHOLE tree, e.g. a 4GB
    // release/ dir, instead of pruning it).
    for (const g of RG_INCLUDE_GLOBS) args.push('-g', g)
    for (const g of RG_EXCLUDE_GLOBS) args.push('-g', g)
    args.push('-e', query, '.')
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('rg', args, { cwd: root, windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const finish = (result: SearchMatch[] | null) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* already exited */
      }
      resolve(result)
    }
    child.on('error', () => finish(null)) // ENOENT → rg not installed
    const matches: SearchMatch[] = []
    let buf = ''
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as {
              type?: string
              data?: {
                path?: { text?: string }
                line_number?: number
                lines?: { text?: string }
              }
            }
            if (obj.type === 'match' && obj.data) {
              matches.push({
                file: (obj.data.path?.text ?? '').replace(/\\/g, '/').replace(/^\.\//, ''),
                line: obj.data.line_number ?? 0,
                text: (obj.data.lines?.text ?? '').replace(/\n$/, '').slice(0, 300),
              })
              if (matches.length >= MAX_SEARCH_MATCHES) {
                finish(matches)
                return
              }
            }
          } catch {
            /* skip malformed line */
          }
        }
      })
      child.stdout.on('end', () => finish(matches))
    }
    child.on('close', () => finish(matches))
    if (child.stderr) {
      child.stderr.on('data', () => {
        /* ignore */
      })
    }
  })
}

export async function searchContent(root: string, query: string): Promise<SearchMatch[]> {
  const q = query.trim()
  if (!q) return []
  if (!root || !fs.existsSync(root)) return []
  const fast = await rgSearch(root, q)
  if (fast) return fast
  return searchContentFallback(root, q)
}

/** Slow-path JS scan (used only when ripgrep is not installed): walks the tree
 *  and reads every file. Kept as the fallback so content search still works
 *  everywhere, but rg is ~100x faster on a real repo. */
function searchContentFallback(root: string, query: string): SearchMatch[] {
  const q = query.toLowerCase()
  const matches: SearchMatch[] = []
  for (const file of walkFiles(root)) {
    if (matches.length >= MAX_SEARCH_MATCHES) break
    const ext = path.extname(file).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) continue
    let content: string
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_SEARCH_BYTES) continue
      content = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.toLowerCase().includes(q)) {
        matches.push({
          file: path.relative(root, file).split(path.sep).join('/'),
          line: i + 1,
          text: line.slice(0, 300),
        })
        if (matches.length >= MAX_SEARCH_MATCHES) break
      }
    }
  }
  return matches
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/** Read an image file by absolute path into a data URL (for preview thumbnails). */
export function readImageDataUrl(absPath: string): string | null {
  if (typeof absPath !== 'string') return null
  const mime = IMAGE_MIME[path.extname(absPath).toLowerCase()]
  if (!mime) return null
  try {
    const data = fs.readFileSync(absPath)
    if (data.length > 8 * 1024 * 1024) return null
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

/** Best-effort name for a file path (used for display). */
export function baseName(relPath: string): string {
  return path.basename(relPath.replace(/\\/g, '/')) || relPath
}

// --------------------------------------------------------------------------- //
// Persistence: settings + chats stored in the sidecar SQLite DB under the
// configurable data root (default ~/.codifa). Skills/MCP files also resolve
// against that same root.
// --------------------------------------------------------------------------- //

function dataDir(): string {
  const dir = getDataRoot()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolve a renderer-supplied relative path against the data root, rejecting
 *  any attempt to escape it. The target may not exist yet (new skills/mcp files). */
function resolveCoderSafe(relPath: string): string {
  const base = getDataRoot()
  const rel = relPath.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  if (!rel) return base
  const candidate = path.resolve(base, rel)
  const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('path escapes the data root')
  }
  return resolved
}

export function coderDirList(relPath: string): { name: string; kind: string; path: string }[] {
  let target: string
  try {
    target = resolveCoderSafe(relPath)
  } catch {
    return []
  }
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: { name: string; kind: string; path: string }[] = []
  for (const name of dirents) {
    let kind = 'file'
    if (name.isSymbolicLink()) kind = 'link'
    else if (name.isDirectory()) kind = 'dir'
    const rel = [relPath, name.name].filter(Boolean).join('/')
    entries.push({ name: name.name, kind, path: rel })
  }
  entries.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (a.kind !== 'dir' && b.kind === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export function coderDirRead(relPath: string): { content: string } | null {
  const target = resolveCoderSafe(relPath)
  if (!fs.existsSync(target)) return null
  if (fs.statSync(target).isDirectory()) throw new Error('path is a directory')
  return { content: fs.readFileSync(target, 'utf-8') }
}

export function coderDirWrite(relPath: string, content: string): void {
  const target = resolveCoderSafe(relPath)
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    throw new Error('path is a directory')
  }
  const dir = path.dirname(target)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

export function coderDirDelete(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  if (!rel) return false
  const target = resolveCoderSafe(rel)
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

export function readJsonFile<T>(name: string, fallback: T): T {
  try {
    const file = path.join(dataDir(), name)
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
    }
  } catch {
    /* ignore corrupt file */
  }
  return fallback
}

export function writeJsonFile(name: string, value: unknown): void {
  const file = path.join(dataDir(), name)
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8')
}