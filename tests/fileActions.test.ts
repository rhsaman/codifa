// The explorer's file actions: copy naming, move rules, and the wiring that
// makes a row editable (right-click menu, drag & drop, inline rename).
//
// The pure rules live in src/lib/fileTree.ts; the component only wires them to
// `api.fsCopy` / `api.fsRename` / `api.fsDelete`. Both halves are locked here:
//   * a copy never collides and keeps its extension;
//   * a drop that changes nothing (own folder, own subtree) is refused BEFORE
//     the backend is asked — a refused move must never light up as if it would
//     work;
//   * the rows really carry the handlers, and the panel really calls the three
//     fs primitives;
//   * every layer (typed api, bridge, Rust command, handler registration)
//     exposes copy and rename.
//
// `fileTree.ts` only imports a TYPE from `fs.ts`, so this needs no bridge stub.
export {}
import { readFileSync } from 'node:fs'
import { copyName, isInside, joinPath, moveTarget, parentPath } from '../src/lib/fileTree'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

console.log('1) a copy gets a free name next to its source:')
{
  check('a plain file keeps its extension', copyName('App.tsx', new Set()) === 'App copy.tsx', copyName('App.tsx', new Set()))
  check('a dotfile keeps its whole name as the base', copyName('.env', new Set()) === '.env copy', copyName('.env', new Set()))
  check('a folder has no extension to split', copyName('src', new Set()) === 'src copy', copyName('src', new Set()))
  check(
    'a taken name counts up instead of colliding',
    copyName('App.tsx', new Set(['App copy.tsx'])) === 'App copy 2.tsx',
    copyName('App.tsx', new Set(['App copy.tsx'])),
  )
  check(
    'the walk stops at the first free slot',
    copyName('a.md', new Set(['a copy.md', 'a copy 2.md'])) === 'a copy 3.md',
    copyName('a.md', new Set(['a copy.md', 'a copy 2.md'])),
  )
  check(
    'a source name that already says "copy" still works',
    copyName('a copy.ts', new Set()) === 'a copy copy.ts',
    copyName('a copy.ts', new Set()),
  )
}

console.log('2) path helpers keep the tree spelling:')
{
  check('parent of a nested path', parentPath('src/lib/fs.ts') === 'src/lib', parentPath('src/lib/fs.ts'))
  check('parent of a top-level entry is the root', parentPath('README.md') === '', parentPath('README.md'))
  check('parent of a top-level folder is the root', parentPath('src') === '', parentPath('src'))
  check('joining under the root never doubles the slash', joinPath('', 'a.ts') === 'a.ts', joinPath('', 'a.ts'))
  check('joining under a folder', joinPath('src', 'a.ts') === 'src/a.ts', joinPath('src', 'a.ts'))
  check('a path is inside itself', isInside('src', 'src') === true)
  check('a deeper path is inside its folder', isInside('src', 'src/lib') === true)
  check('a name that merely starts the same is not inside', isInside('src', 'srclib') === false, isInside('src', 'srclib'))
  check('the workspace root contains nothing by this rule', isInside('', 'src') === false)
}

console.log('3) a drop is refused before it reaches the backend:')
{
  check('moving into the current folder changes nothing', moveTarget('src/a.ts', 'src') === null, moveTarget('src/a.ts', 'src'))
  check('moving a top-level file onto the root changes nothing', moveTarget('a.ts', '') === null, moveTarget('a.ts', ''))
  check('moving a folder into itself is refused', moveTarget('src', 'src') === null, moveTarget('src', 'src'))
  check('moving a folder into its own subtree is refused', moveTarget('src', 'src/lib') === null, moveTarget('src', 'src/lib'))
  check('moving into another folder is allowed', moveTarget('src/a.ts', 'lib') === 'lib', moveTarget('src/a.ts', 'lib'))
  check('moving a top-level file into a folder is allowed', moveTarget('a.ts', 'src') === 'src', moveTarget('a.ts', 'src'))
  check('moving back up to the root is allowed', moveTarget('src/a.ts', '') === '', moveTarget('src/a.ts', ''))
}

console.log('4) the rows really carry the editing handlers:')
{
  const src = readFileSync('src/components/FilesPanel.tsx', 'utf8')
  check('right-click opens the menu', src.includes('onContextMenu=') && src.includes('setMenu({'))
  check('the menu offers copy, rename and delete', src.includes('Copy') && src.includes('Rename') && src.includes('Delete'))
  check('delete asks before touching the disk', src.includes('confirming'))
  check('rows are draggable', /\n\s+draggable\n/.test(src), 'draggable attribute missing')
  check('a drag carries the row path', src.includes('e.dataTransfer.setData("text/plain", row.path)'))
  check('only a folder accepts a drop', src.includes('if (!isDir || !dragPath) return;'))
  check('a refused move never highlights', src.includes('if (moveTarget(dragPath, row.path) === null) return;'))
  check('the hovered folder is highlighted', src.includes('files-row-drop'))
  check('the dragged row is dimmed', src.includes('files-row-dragging'))
  check('the drop is not handled twice by row and list', src.includes('e.stopPropagation()'))
  check('rename swaps in the shared input', src.includes('<ChatRenameInput') && src.includes('files-rename-input'))
  check('an empty or unchanged rename never touches the disk', src.includes('if (!name || name ==='))
  check('copy goes through fsCopy', src.includes('api.fsCopy(root, path,'))
  check('rename goes through fsRename', src.includes('api.fsRename(root, path,'))
  check('delete goes through fsDelete', src.includes('api.fsDelete(root, path)'))
  check('a move goes through fsRename', src.includes('api.fsRename(root, from,'))
  check('a failed mutation is reported above the tree', src.includes('files-panel-error') && src.includes('setActionError'))
  check('the tree is re-read after every mutation', src.includes('refreshTree()'))
  check('the menu is portalled so the pane cannot clip it', src.includes('createPortal('))
}

console.log('5) every class the new rows use has a style:')
{
  const css = readFileSync('src/styles/global.css', 'utf8')
  for (const cls of [
    '.files-panel-error',
    '.files-row.files-row-drop',
    '.files-row.files-row-dragging',
    '.files-row.files-row-renaming',
    '.files-rename-input',
    '.files-ctx-menu',
    '.files-ctx-confirm',
    '.files-ctx-path',
    '.files-ctx-actions',
  ]) {
    check(`${cls} is styled`, css.includes(cls), cls)
  }
  // The rail's "+" menu is the single entry point for the pages; its trigger
  // reuses the shared tab-list button shell.
  check('the "+" menu trigger is styled', css.includes('.viewer-pane-head .tab-list-btn'), '.viewer-pane-head .tab-list-btn')
}

console.log('6) every layer exposes copy and rename:')
{
  const fsSrc = readFileSync('src/lib/fs.ts', 'utf8')
  check('the api wrapper forwards fsCopy', fsSrc.includes('window.coder.fsCopy(root, from, to)'))
  check('the api wrapper forwards fsRename', fsSrc.includes('window.coder.fsRename(root, from, to)'))

  const typesSrc = readFileSync('src/types/coderApi.ts', 'utf8')
  check('the bridge type declares fsCopy', typesSrc.includes('fsCopy(root: string, from: string, to: string)'))
  check('the bridge type declares fsRename', typesSrc.includes('fsRename(root: string, from: string, to: string)'))

  const bridgeSrc = readFileSync('src/lib/tauriBridge.ts', 'utf8')
  check('the bridge invokes fs_copy', bridgeSrc.includes("'fs_copy'"))
  check('the bridge invokes fs_rename', bridgeSrc.includes("'fs_rename'"))

  const cmdSrc = readFileSync('src-tauri/src/commands.rs', 'utf8')
  check('the Rust command fs_copy exists', cmdSrc.includes('pub fn fs_copy('))
  check('the Rust command fs_rename exists', cmdSrc.includes('pub fn fs_rename('))
  check('a copy never overwrites silently', cmdSrc.includes('destination already exists'))
  check('both commands resolve through the safe-path guard', (cmdSrc.match(/resolve_safe\(Path::new\(&root\), &(from|to)\)/g) ?? []).length >= 4)
  check('a folder copy is recursive', cmdSrc.includes('state::copy_tree'))

  const mainSrc = readFileSync('src-tauri/src/main.rs', 'utf8')
  check('fs_copy is registered as a handler', mainSrc.includes('commands::fs_copy'))
  check('fs_rename is registered as a handler', mainSrc.includes('commands::fs_rename'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
