import * as fs from 'fs'
import * as path from 'path'
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

/** Walk the whole workspace tree in ONE pass and return every file quick-open
 *  should index (relative path + name). Skips dependency/build dirs and
 *  dot-dirs like `.git`/`.cache`, but keeps other dotfiles (`.config`, `.env`,
 *  `.github`) so config files are findable. A single IPC call avoids the old
 *  per-directory round-trips and the 800-file cap that silently dropped whole
 *  subfolders (e.g. the second of two project folders). */
export function walkWorkspace(root: string): { rel: string; name: string }[] {
  if (!root || !fs.existsSync(root)) return []
  const out: { rel: string; name: string }[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= MAX_WALK_FILES) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(full)
      } else if (e.isFile()) {
        if (e.name === '.DS_Store') continue
        out.push({
          rel: path.relative(root, full).split(path.sep).join('/'),
          name: e.name,
        })
      }
    }
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
const MAX_SEARCH_FILES = 4000
const MAX_SEARCH_BYTES = 2_000_000

function walkFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(full)
      } else if (e.isFile()) {
        if (e.name === '.DS_Store') continue
        out.push(full)
        if (out.length >= MAX_SEARCH_FILES) return out
      }
    }
  }
  return out
}

export function searchContent(root: string, query: string): SearchMatch[] {
  const q = query.toLowerCase().trim()
  if (!q) return []
  const matches: SearchMatch[] = []
  for (const file of walkFiles(root)) {
    if (matches.length >= MAX_SEARCH_MATCHES) break
    const ext = path.extname(file).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext) && !['.md', '.txt'].includes(ext)) continue
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