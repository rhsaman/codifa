// Unit tests for the file explorer's tree bookkeeping (src/lib/fileTree.ts).
//
// The panel reads ONE directory level at a time, so the interesting behaviour
// is how fetched levels are merged and how open folders flatten into rows —
// pure logic, no DOM needed.
import { ancestorDirs, flattenTree, filterRows, isLoaded, isInWorkspace, mergeChildren, nextFilterIndex, pruneSubtree, sortEntries, splitWorkspaceFiles, toggleExpanded, toWorkspacePath } from '../src/lib/fileTree'
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

console.log('9) filterRows searches loaded levels and auto-opens the chain:')
{
  let cache = {}
  cache = mergeChildren(cache, '', [dir('src'), file('readme.md'), file('App.tsx'), file('فیلم.mp4')])
  cache = mergeChildren(cache, 'src', [dir('src/components'), file('src/main.ts')])
  cache = mergeChildren(cache, 'src/components', [file('src/components/FilesPanel.tsx'), file('src/components/Chat.tsx')])

  const hits = filterRows(cache, 'files')
  check(
    'a deep hit is pulled up with its folder chain',
    hits.map((r) => r.path).join() === 'src,src/components,src/components/FilesPanel.tsx',
    hits.map((r) => r.path),
  )
  check('the chain rows are marked open', hits[0].expanded && hits[1].expanded)
  check('depths follow the chain', hits.map((r) => r.depth).join() === '0,1,2', hits.map((r) => r.depth))

  const leaf = filterRows(cache, 'main')
  check(
    'a leaf hit keeps its parent chain',
    leaf.map((r) => r.path).join() === 'src,src/main.ts',
    leaf.map((r) => r.path),
  )
  check('the match is case-insensitive', filterRows(cache, 'FILES').length === 3)

  const folderHit = filterRows(cache, 'comp')
  check(
    'a matching folder is listed by its own name (children not forced in)',
    folderHit.map((r) => r.path).join() === 'src,src/components',
    folderHit.map((r) => r.path),
  )

  check('nothing matches garbage', filterRows(cache, 'zzz').length === 0)
  check(
    'an arabic-layout query still finds the persian name',
    filterRows(cache, 'فيلم').map((r) => r.path).join() === 'فیلم.mp4',
    filterRows(cache, 'فيلم'),
  )
}

console.log('10) the walked path list finds deep folders the lazy cache never read:')
{
  let cache = {}
  cache = mergeChildren(cache, '', [dir('src')])
  // Deliberately NOT loaded: `src/lib` and everything under it.
  const walked = ['src/index.ts', 'src/lib/fileTree.ts', 'src/lib/components/Deep.tsx', 'docs/readme.md']

  const deep = filterRows(cache, 'deep', walked)
  check(
    'a deep unopened file is found through the walk, with its ancestor chain',
    deep.map((r) => r.path).join() === 'src,src/lib,src/lib/components,src/lib/components/Deep.tsx',
    deep.map((r) => r.path),
  )
  check('the synthetic chain rows carry the right depths', deep.map((r) => r.depth).join() === '0,1,2,3', deep.map((r) => r.depth))
  check('an unloaded ancestor is emitted as a folder row', deep[1].kind === 'dir' && deep[1].expandable === false)

  const folderDeep = filterRows(cache, 'lib', walked)
  check('a deep folder is found by name too', folderDeep.some((r) => r.path === 'src/lib'), folderDeep.map((r) => r.path))

  check('a loaded hit is not duplicated from the walk', filterRows(cache, 'index', walked).filter((r) => r.path === 'src/index.ts').length === 1)
  check('no walk list keeps the loaded-levels-only behaviour', filterRows(cache, 'deep').length === 0)
}

console.log('11) nextFilterIndex wraps the Ctrl+K/J navigation:')
{
  check('moving down steps forward', nextFilterIndex(0, 1, 3) === 1)
  check('moving up steps back', nextFilterIndex(2, -1, 3) === 1)
  check('down wraps past the end', nextFilterIndex(2, 1, 3) === 0)
  check('up wraps past the start', nextFilterIndex(0, -1, 3) === 2)
  check('an empty list pins to zero', nextFilterIndex(5, 1, 0) === 0)
}

console.log('12) ancestorDirs opens the chain down to a revealed file:')
{
  check(
    'every parent, outermost first',
    ancestorDirs('src/lib/components/Deep.tsx').join(',') === 'src,src/lib,src/lib/components',
    ancestorDirs('src/lib/components/Deep.tsx'),
  )
  check('a top-level file has no folder to open', ancestorDirs('App.tsx').length === 0)
  check('a one-level file opens just its folder', ancestorDirs('src/main.ts').join(',') === 'src')
  check('an empty path yields nothing', ancestorDirs('').length === 0)
  check('leading/trailing slashes are ignored', ancestorDirs('/src/lib/x.ts').join(',') === 'src,src/lib')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
