// Unit tests for suggestSimilarFiles (src/lib/fs.ts): ranking of close
// workspace matches offered when a clicked file path doesn't exist.
// Run: npx esbuild tests/fileSuggest.test.ts --bundle --platform=node \
//        --format=esm --packages=external --external:electron --outfile=tests/.tmp-fileSuggest.mjs && node tests/.tmp-fileSuggest.mjs

import { suggestSimilarFiles } from '../src/lib/fs'

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

const files = [
  { rel: 'README.md', name: 'README.md' },
  { rel: 'src/App.tsx', name: 'App.tsx' },
  { rel: 'src/components/Chat.tsx', name: 'Chat.tsx' },
  { rel: 'src/components/ChatMessage.tsx', name: 'ChatMessage.tsx' },
  { rel: 'src/components/ChatTabBar.tsx', name: 'ChatTabBar.tsx' },
  { rel: 'src/lib/store.ts', name: 'store.ts' },
  { rel: 'src/lib/stores/legacy.ts', name: 'legacy.ts' },
  { rel: 'backend/server.py', name: 'server.py' },
]

console.log('1) same basename anywhere beats everything:')
{
  const out = suggestSimilarFiles('docs/App.tsx', files)
  check('finds src/App.tsx', out[0]?.rel === 'src/App.tsx', out.map((f) => f.rel))
  check('no self-suggestion leaks for a missing path', out.every((f) => f.rel !== 'docs/App.tsx'))
}

console.log('2) same-directory siblings rank next:')
{
  // ChatWindows.tsx never existed (a planned path) — its directory siblings
  // are the useful hint.
  const out = suggestSimilarFiles('src/components/ChatWindows.tsx', files)
  const rels = out.map((f) => f.rel)
  check('all three Chat* siblings suggested', rels.length === 3 && rels.every((r) => r.startsWith('src/components/')), rels)
  check('sorted alphabetically after the tie', rels[0] === 'src/components/Chat.tsx', rels)
}

console.log('3) same-extension stem-prefix matches fill the rest:')
{
  const out = suggestSimilarFiles('src/lib/storages.ts', files)
  const rels = out.map((f) => f.rel)
  check('store.ts suggested via stem prefix', rels.includes('src/lib/store.ts'), rels)
  check('python files never suggested for .ts', rels.every((r) => !r.endsWith('.py')), rels)
}

console.log('4) edge cases:')
{
  check('empty target yields nothing', suggestSimilarFiles('', files).length === 0)
  check('empty tree yields nothing', suggestSimilarFiles('src/App.tsx', []).length === 0)
  check('limit respected', suggestSimilarFiles('src/components/ChatWindows.tsx', files, 2).length === 2)
  check('backslash paths normalized', suggestSimilarFiles('src\\components\\ChatWindows.tsx', files).length === 3)
  check('exact existing path is never suggested', suggestSimilarFiles('src/lib/store.ts', files).every((f) => f.rel !== 'src/lib/store.ts'))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll fileSuggest checks passed')
process.exit(0)
