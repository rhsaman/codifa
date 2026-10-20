// Node test for the workspace path resolver used when a file chip's path does
// not open directly: a scoped grep returns bare names ("toolNesting.test.ts"
// for path=tests) and a moved file keeps its name, so the viewer must resolve
// the chip against the workspace index instead of reporting "No file exists".
import { normPath, resolveWorkspacePath, type WorkspaceFile } from '../src/lib/fs'

let failed = 0
function check(name: string, cond: boolean, actual?: unknown) {
  if (cond) {
    console.log(`ok - ${name}`)
  } else {
    failed++
    console.error(`FAIL - ${name}`, actual)
  }
}

const files: WorkspaceFile[] = [
  { rel: 'tests/toolNesting.test.ts', name: 'toolNesting.test.ts' },
  { rel: 'src/lib/fs.ts', name: 'fs.ts' },
  { rel: 'src/components/Chat.tsx', name: 'Chat.tsx' },
]

check(
  'bare basename resolves to its workspace path',
  resolveWorkspacePath('toolNesting.test.ts', files)?.rel === 'tests/toolNesting.test.ts',
  resolveWorkspacePath('toolNesting.test.ts', files),
)

check(
  'stale directory still resolves by basename',
  resolveWorkspacePath('old/dir/fs.ts', files)?.rel === 'src/lib/fs.ts',
  resolveWorkspacePath('old/dir/fs.ts', files),
)

check(
  'unknown extension falls back to the closest suggestion',
  resolveWorkspacePath('src/components/Chat.ts', files)?.rel === 'src/components/Chat.tsx',
  resolveWorkspacePath('src/components/Chat.ts', files),
)

check(
  'nothing similar returns null',
  resolveWorkspacePath('nope/zzz.qqq', files) === null,
  resolveWorkspacePath('nope/zzz.qqq', files),
)

// Invisible bidi marks ride along inside paths copied from model output and
// tool results; they made fs_read miss files that exist.
check(
  'normPath strips bidi/zero-width marks',
  normPath('\u202atests/toolNesting.test.ts\u200f') === 'tests/toolNesting.test.ts',
  normPath('\u202atests/toolNesting.test.ts\u200f'),
)

check(
  'normPath normalizes backslashes and leading ./',
  normPath('.\\src\\lib\\fs.ts') === 'src/lib/fs.ts',
  normPath('.\\src\\lib\\fs.ts'),
)

check(
  'a bidi-marked chip still resolves',
  resolveWorkspacePath('\u202atoolNesting.test.ts', files)?.rel === 'tests/toolNesting.test.ts',
  resolveWorkspacePath('\u202atoolNesting.test.ts', files),
)

// A bridge that RESOLVES null instead of rejecting (web build, stub) used to
// make `files.find(...)` throw and kill the whole viewer lookup.
check(
  'a nullish workspace index resolves to null instead of throwing',
  resolveWorkspacePath('src/App.tsx', null as unknown as WorkspaceFile[]) === null,
  resolveWorkspacePath('src/App.tsx', null as unknown as WorkspaceFile[]),
)

if (failed > 0) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
