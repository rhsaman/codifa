/**
 * Pure tree bookkeeping for the file explorer (src/components/FilesPanel.tsx).
 *
 * The panel lists ONE directory level at a time (`api.fsList(root, rel)`), so
 * the tree is a cache of already-fetched levels plus the set of open folders.
 * Keeping that logic here — no React, no DOM — makes the merge/toggle/flatten
 * rules unit-testable; the component stays a thin renderer over `flattenTree`.
 */
import type { FileEntry } from './fs'

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
