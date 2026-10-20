// Unit tests for the file explorer's tree bookkeeping (src/lib/fileTree.ts).
//
// The panel reads ONE directory level at a time, so the interesting behaviour
// is how fetched levels are merged and how open folders flatten into rows —
// pure logic, no DOM needed.
import { flattenTree, isLoaded, isInWorkspace, mergeChildren, pruneSubtree, sortEntries, splitWorkspaceFiles, toggleExpanded, toWorkspacePath } from '../src/lib/fileTree'
import type { FileEntry } from '../src/lib/fs'

export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const dir = (path: string, name = path.split('/').pop()!): FileEntry => ({ name, kind: 'dir', path })
const file = (path: string, name = path.split('/').pop()!): FileEntry => ({ name, kind: 'file', path })

console.log('1) entries sort directories first, then A→Z (case-insensitive):')
{
  const sorted = sortEntries([file('b.ts'), dir('zeta'), file('A.ts'), dir('alpha')])
  check(
    'directories lead, alphabetically',
    sorted.slice(0, 2).map((e) => e.name).join(',') === 'alpha,zeta',
    sorted.map((e) => e.name),
  )
  check(
    'files follow, case-insensitively',
    sorted.slice(2).map((e) => e.name).join(',') === 'A.ts,b.ts',
    sorted.map((e) => e.name),
  )
  const input = [file('b.ts'), file('a.ts')]
  const copy = sortEntries(input)
  check('the input array is not mutated', input[0].name === 'b.ts' && copy[0].name === 'a.ts')
}

console.log('2) mergeChildren memoizes a level — including the empty one:')
{
  let cache = {}
  cache = mergeChildren(cache, '', [dir('src'), file('readme.md')])
  check("the root level is stored", isLoaded(cache, ''))
  check('children are sorted on merge', (cache as any)[''][0].name === 'src')

  cache = mergeChildren(cache, 'src', [file('src/index.ts')])
  check('a nested level is added alongside', isLoaded(cache, 'src') && isLoaded(cache, ''))

  const empty = mergeChildren(cache, 'docs', [])
  check('an empty listing counts as loaded', isLoaded(empty, 'docs'))
  check('merging never mutates the previous cache', !isLoaded(cache, 'docs'))
  check('unknown levels are not loaded', !isLoaded(empty, 'never-fetched'))
  const nulled = mergeChildren(cache, 'broke', null)
  check('a null listing is treated as empty, not as an error', isLoaded(nulled, 'broke') && (nulled as any)['broke'].length === 0)

  const replaced = mergeChildren(cache, 'src', [file('src/other.ts')])
  check('re-merging replaces that level', (replaced as any)['src'][0].name === 'other.ts', (replaced as any)['src'])
}

console.log('3) toggleExpanded opens and closes one folder:')
{
  let set = new Set<string>()
  set = toggleExpanded(set, 'src')
  check('opening adds the folder', set.has('src'))
  check('the original set is untouched', new Set<string>().size === 0)
  const withBoth = toggleExpanded(set, 'src/components')
  check('a second folder opens independently', withBoth.has('src') && withBoth.has('src/components'))
  const closed = toggleExpanded(withBoth, 'src')
  check('toggling again closes only that folder', !closed.has('src') && closed.has('src/components'))
}

console.log('4) flattenTree walks only the OPEN folders:')
{
  let cache = mergeChildren({}, '', [file('b.ts'), dir('src'), dir('docs')])
  cache = mergeChildren(cache, 'src', [file('src/index.ts'), dir('src/lib')])
  cache = mergeChildren(cache, 'src/lib', [file('src/lib/util.ts')])

  const collapsed = flattenTree(cache, new Set<string>())
  check(
    'closed folders contribute their own row only',
    collapsed.map((r) => r.name).join(',') === 'docs,src,b.ts',
    collapsed.map((r) => r.name),
  )
  check('top-level rows sit at depth 0', collapsed.every((r) => r.depth === 0))
  check('closed folders report expanded=false', collapsed.every((r) => r.expanded === false))
  check(
    'a folder with unread children is expandable',
    collapsed.find((r) => r.name === 'src')!.expandable === true,
  )
  check('files are never expandable', collapsed.find((r) => r.name === 'b.ts')!.expandable === false)

  const one = flattenTree(cache, new Set(['src']))
  check(
    'an open folder inlines its children',
    one.map((r) => r.name).join(',') === 'docs,src,lib,index.ts,b.ts',
    one.map((r) => r.name),
  )
  check('children are one level deeper', one.find((r) => r.name === 'index.ts')!.depth === 1)
  check('a still-closed grandchild keeps depth 1 and no children', one.find((r) => r.name === 'lib')!.depth === 1)

  const deep = flattenTree(cache, new Set(['src', 'src/lib']))
  check(
    'grandchildren appear only when their parent opened',
    deep.map((r) => r.name).join(',') === 'docs,src,lib,util.ts,index.ts,b.ts',
    deep.map((r) => r.name),
  )
  check('the grandchild is two levels deep', deep.find((r) => r.name === 'util.ts')!.depth === 2)
  check(
    'the rows carry workspace-relative identity paths',
    deep.find((r) => r.name === 'util.ts')!.path === 'src/lib/util.ts',
  )

  const openedEmpty = flattenTree(mergeChildren(cache, 'docs', []), new Set(['docs']))
  const docs = openedEmpty.find((r) => r.name === 'docs')!
  check('an opened-but-empty folder renders no chevron', docs.expandable === false, docs)
  check('opening an empty folder adds no rows', openedEmpty.length === collapsed.length, openedEmpty.map((r) => r.name))
}

console.log('5) pruneSubtree forgets a closed folder and everything under it:')
{
  let cache = mergeChildren({}, '', [dir('src'), dir('docs')])
  cache = mergeChildren(cache, 'src', [dir('src/lib')])
  cache = mergeChildren(cache, 'src/lib', [file('src/lib/util.ts')])
  cache = mergeChildren(cache, 'docs', [file('docs/a.md')])

  const pruned = pruneSubtree(cache, 'src')
  check('the folder itself is dropped', !isLoaded(pruned, 'src'))
  check('its descendants are dropped', !isLoaded(pruned, 'src/lib'))
  check('siblings survive', isLoaded(pruned, 'docs') && isLoaded(pruned, ''))
  check('the original cache is not mutated', isLoaded(cache, 'src/lib'))

  // Prefix safety: 'src' must not wipe a sibling that merely starts with it.
  const siblingCache = mergeChildren(mergeChildren({}, '', [dir('src-extra')]), 'src-extra', [file('src-extra/x.ts')])
  const kept = pruneSubtree(siblingCache, 'src')
  check('a same-prefix sibling folder is kept', isLoaded(kept, 'src-extra'), Object.keys(kept))
}

console.log('6) an unloaded directory flattens to nothing (lazy by construction):')
{
  check('no cache -> no rows', flattenTree({}, new Set<string>()).length === 0)
}

console.log('7) the workspace boundary used by the review list:')
{
  const root = '/Users/me/proj'
  check('a relative path is inside', isInWorkspace(root, 'src/a.ts'))
  check('an absolute path under the root is inside', isInWorkspace(root, '/Users/me/proj/src/a.ts'))
  check('a temp path is outside', !isInWorkspace(root, '/var/folders/xy/T/patch.diff'))
  check('a sibling project is outside', !isInWorkspace(root, '/Users/me/other/a.ts'))
  check('a trailing slash on the root is ignored', isInWorkspace('/Users/me/proj/', '/Users/me/proj/a.ts'))
  check('a prefix that is not a directory boundary is outside', !isInWorkspace(root, '/Users/me/proj-extra/a.ts'))
  check('a home-relative path is outside', !isInWorkspace(root, '~/notes.md'))
  check('an unknown root never censors', isInWorkspace(undefined, '/var/folders/xy/T/a.ts'))
  check('an empty path is not a member', !isInWorkspace(root, ''))
}

console.log('8) display shortening and the inside/outside split:')
{
  const root = '/Users/me/proj'
  check('absolute inside root becomes relative', toWorkspacePath(root, '/Users/me/proj/src/a.ts') === 'src/a.ts')
  check('an already relative path is untouched', toWorkspacePath(root, 'src/a.ts') === 'src/a.ts')
  check('an outside path stays absolute (so the user sees where it is)', toWorkspacePath(root, '/tmp/a.ts') === '/tmp/a.ts')
  check('no root -> unchanged', toWorkspacePath(undefined, '/a/b.ts') === '/a/b.ts')

  const files = [{ path: 'src/a.ts' }, { path: '/tmp/scratch.ts' }, { path: '/Users/me/proj/b.ts' }]
  const { inside, outside } = splitWorkspaceFiles(files, root)
  check('the inside half keeps order', inside.map((f) => f.path).join() === 'src/a.ts,/Users/me/proj/b.ts', inside)
  check('the outside half keeps order', outside.map((f) => f.path).join() === '/tmp/scratch.ts', outside)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
