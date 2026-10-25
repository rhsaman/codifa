/**
 * Pure tree bookkeeping for the file explorer (src/components/FilesPanel.tsx).
 *
 * The panel lists ONE directory level at a time (`api.fsList(root, rel)`), so
 * the tree is a cache of already-fetched levels plus the set of open folders.
 * Keeping that logic here — no React, no DOM — makes the merge/toggle/flatten
 * rules unit-testable; the component stays a thin renderer over `flattenTree`.
 *
 *  The name filter (`filterRows`) has two sources: the LOADED levels of this
 *  lazy tree, and — when the caller passes one — a full workspace path list
 *  (`fs_walk`), which is what makes a deep unopened folder findable.
 */
import type { FileEntry } from './fs'
import { foldFa } from './fuzzy'

/** Fetched children for a directory, keyed by workspace-relative dir path
 *  ('' = the workspace root itself). */
export type TreeCache = Record<string, FileEntry[]>

export interface TreeRow {
  /** Workspace-relative path — also the identity of the row. */
  path: string
  name: string
  kind: FileEntry['kind']
  /** 0 for a top-level entry, +1 per level of nesting below it. */
  depth: number
  /** True when this row is an open folder. */
  expanded: boolean
  /** True when a chevron makes sense: a directory that is not known-empty. */
  expandable: boolean
}

/** Directories first, then files; each group A→Z, case-insensitive. The
 *  backend sorts the same way, but the explorer re-sorts so a cached level and
 *  a freshly fetched one can never disagree (and so the rule is testable). */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'dir'
    const bDir = b.kind === 'dir'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** Store one directory's freshly fetched children. Empty/absent input still
 *  memoizes the directory as loaded — that is how an empty folder is known to
 *  be empty instead of merely not-fetched. */
export function mergeChildren(
  cache: TreeCache,
  dir: string,
  entries: readonly FileEntry[] | null | undefined,
): TreeCache {
  return { ...cache, [dir]: sortEntries(entries ?? []) }
}

/** Every ancestor directory of a workspace-relative file path, outermost
 *  first (`a/b/c.ts` → `['a', 'a/b']`). Used to open the chain down to a hit
 *  without opening the file's own folder siblings. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(0, i + 1).join('/'))
  return out
}

/** Open a folder if it was closed, close it if it was open. */
export function toggleExpanded(expanded: ReadonlySet<string>, dir: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(dir)) next.delete(dir)
  else next.add(dir)
  return next
}

/** True when a directory's children are already in the cache (including the
 *  "loaded and empty" case, which `[]` represents). */
export function isLoaded(cache: TreeCache, dir: string): boolean {
  return Object.prototype.hasOwnProperty.call(cache, dir)
}

/** A folder is expandable unless its children are loaded AND empty — an empty
 *  directory should not advertise a chevron that opens nothing. */
function isExpandable(cache: TreeCache, entry: FileEntry): boolean {
  if (entry.kind !== 'dir') return false
  const kids = cache[entry.path]
  return !(kids && kids.length === 0)
}

/**
 * Depth-first walk of the OPEN folders into the flat row list the panel
 * renders. Closed folders contribute their own row only — their children are
 * not walked, which is exactly what makes the tree lazy.
 */
export function flattenTree(
  cache: TreeCache,
  expanded: ReadonlySet<string>,
  dir = '',
  depth = 0,
): TreeRow[] {
  const children = cache[dir]
  if (!children) return []
  const rows: TreeRow[] = []
  for (const entry of children) {
    const isDir = entry.kind === 'dir'
    const open = isDir && expanded.has(entry.path)
    rows.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      depth,
      expanded: open,
      expandable: isExpandable(cache, entry),
    })
    if (open) rows.push(...flattenTree(cache, expanded, entry.path, depth + 1))
  }
  return rows
}

/** Case- and Persian-layout-insensitive name match for the tree filter (the
 *  same folding the rest of the app's matchers use, so searching stays
 *  consistent with the composer palette and the quick-open overlay). */
function filterName(needle: string, path: string): boolean {
  return foldFa(path).includes(needle)
}

/**
 * Rows visible while a NAME FILTER is active: every LOADED level is searched
 * (laziness is preserved — an unread folder has nothing to search until it is
 * opened) and matching entries auto-expand their folder chain, so a hit three
 * levels down shows up even though the user never opened those folders.
 *
 * Folders that carry no match themselves stay listed when something under
 * them matches (as the open chain to it); a folder whose own NAME matches is
 * listed even when nothing inside does. A blank query has no filtering —
 * callers render the plain `flattenTree` rows for it.
 */
export function filterRows(
  cache: TreeCache,
  query: string,
  /** Full workspace paths (`fs_walk`): every file and folder on disk, not just
   *  the loaded levels. Absent/empty keeps the loaded-levels-only behaviour. */
  walked: readonly string[] = [],
  dir = '',
  depth = 0,
): TreeRow[] {
  if (!query) return []
  const needle = foldFa(query).trim()
  if (!needle) return []
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  for (const entry of cache[dir] ?? []) {
    const isDir = entry.kind === 'dir'
    const kids = isDir && cache[entry.path] ? filterRows(cache, query, walked, entry.path, depth + 1) : []
    if (kids.length === 0 && !filterName(needle, entry.name)) continue
    seen.add(entry.path)
    rows.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      depth,
      // Carriers stay open while the filter is on; they collapse back on
      // their own the moment the query changes.
      expanded: true,
      expandable: isExpandable(cache, entry),
    })
    rows.push(...kids)
  }
  rows.push(...walkedRows(walked, needle, cache, seen))
  return rows
}

/**
 * Matches from the walked path list that the loaded tree did not already
 * produce — the deep files and folders the lazy cache has never read.
 *
 * A hit's ancestor chain is emitted as carrier rows (a folder with no match of
 * its own is still reachable), one row per path, so a match four levels down in
 * an unopened folder still renders with its indent. Ancestors that ARE loaded
 * inherit the real children, so the row behaves as a folder rather than a
 * dead end.
 */
function walkedRows(
  walked: readonly string[],
  needle: string,
  cache: TreeCache,
  seen: ReadonlySet<string>,
): TreeRow[] {
  // Every path the walk knows is a directory when it also prefixes another
  // walked path (or when its level was already fetched). Guessing from `cache`
  // alone labelled an unopened folder as a FILE, so a deep match rendered with
  // the wrong icon and no chevron.
  const dirs = new Set<string>()
  for (const raw of walked) {
    const path = raw.replace(/^\/+/, '')
    const cut = path.lastIndexOf('/')
    if (cut > 0) dirs.add(path.slice(0, cut))
  }
  for (const p of Object.keys(cache)) if (p) dirs.add(p)
  const emitted = new Map<string, TreeRow>()
  const emit = (path: string, depth: number) => {
    const existing = emitted.get(path)
    if (existing) return
    const isDir = dirs.has(path)
    emitted.set(path, {
      path,
      name: path.split('/').pop() ?? path,
      kind: isDir ? 'dir' : 'file',
      depth,
      expanded: true,
      // A folder the walk never opened has no fetched children, so a chevron
      // would open nothing: it stays a label until its level is fetched.
      expandable: isDir && cache[path] ? isExpandable(cache, { kind: 'dir', path } as FileEntry) : false,
    })
  }
  for (const raw of walked) {
    const path = raw.replace(/^\/+/, '')
    if (!path || seen.has(path) || !filterName(needle, path)) continue
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      // A loaded ancestor already owns this row through the recursive pass.
      if (seen.has(dirPath)) continue
      emit(dirPath, i - 1)
    }
    emit(path, parts.length - 1)
  }
  return [...emitted.values()].sort(
    (a, b) => a.depth - b.depth || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }),
  )
}

/** Wrap-around step for the Ctrl+K/J navigation over the filter's rows.
 *
 *  Pure so the wrap rule (and the empty-list guard) is testable without a DOM:
 *  an empty list always yields 0, otherwise the index moves by `delta` and
 *  wraps in both directions. */
export function nextFilterIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return ((current + delta) % count + count) % count
}

/** Drop every cached level under a closed folder: reopening must re-read from
 *  disk, otherwise a stale listing survives a refresh of its parent. */
export function pruneSubtree(cache: TreeCache, dir: string): TreeCache {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const next: TreeCache = {}
  for (const key of Object.keys(cache)) {
    if (key === dir || key.startsWith(prefix)) continue
    next[key] = cache[key]
  }
  return next
}

// --- path helpers for explorer operations (rename / copy / move) ------------

/** Parent directory of a workspace-relative path ('' for a top-level entry). */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** Join a directory and a name into a workspace-relative path. Keeps the path
 *  exactly as the tree spells it — a leading '' never produces '/name'. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** True when `path` is `dir` itself or lives underneath it. */
export function isInside(dir: string, path: string): boolean {
  if (!dir) return false
  return path === dir || path.startsWith(`${dir}/`)
}

/** Where a drop should move an entry: the folder it landed on. Null means the
 *  move is refused — a drop onto the entry's own folder changes nothing, and a
 *  drop into the entry itself (or its subtree) is a tree that cannot exist. */
export function moveTarget(from: string, ontoDir: string): string | null {
  if (isInside(from, ontoDir)) return null
  if (ontoDir === parentPath(from)) return null
  return ontoDir
}

/** Free name for a copy of `name` sitting in the same folder: "<base> copy",
 *  then "<base> copy 2", "<base> copy 3"… The extension travels with the copy
 *  so the new file still opens in the right viewer; a dotfile (".env") has no
 *  extension to preserve, so its whole name is the base. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  let candidate = `${base} copy${ext}`
  for (let i = 2; taken.has(candidate); i++) candidate = `${base} copy ${i}${ext}`
  return candidate
}

// --- workspace boundary for the review/diff surfaces ------------------------

/** Trailing slashes never take part in a prefix comparison. */
function rootPrefix(root: string): string {
  return root.replace(/\/+$/, '')
}

/** Shorten a path for display: an absolute path inside the root becomes
 *  workspace-relative, while an already-relative path (or one genuinely outside
 *  the workspace) is returned unchanged, so the caller can still show where it
 *  lives. Used by the file lists only — never to resolve a file. */
export function toWorkspacePath(root: string | undefined, path: string): string {
  if (!root || !path.startsWith('/')) return path
  const dir = rootPrefix(root)
  if (!dir || !path.startsWith(`${dir}/`)) return path
  return path.slice(dir.length + 1)
}

/** True when `path` belongs to the workspace: relative paths always do (git and
 *  the tools report them relative to the root), absolute ones only when they sit
 *  under it. Absolute paths outside the workspace reach these surfaces because
 *  the agent is allowed to write the OS temp dir — the review list must not
 *  present those as part of the project. An unknown root never censors. */
export function isInWorkspace(root: string | undefined, path: string): boolean {
  if (!path) return false
  if (!path.startsWith('/') && !path.startsWith('~/')) return true
  if (!root) return true
  if (path.startsWith('~/')) return false
  const dir = rootPrefix(root)
  return path === dir || path.startsWith(`${dir}/`)
}

/** Split a file list into the entries inside the workspace and the ones pointing
 *  elsewhere, preserving the original order in both halves. */
export function splitWorkspaceFiles<T extends { path: string }>(
  files: T[],
  root: string | undefined,
): { inside: T[]; outside: T[] } {
  const inside: T[] = []
  const outside: T[] = []
  for (const f of files) {
    if (isInWorkspace(root, f.path)) inside.push(f)
    else outside.push(f)
  }
  return { inside, outside }
}
