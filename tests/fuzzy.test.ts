// Unit tests for the shared fuzzy matcher (src/lib/fuzzy.ts) and the composer's
// "did you mean?" suggestions. Pure functions, so no window stub is needed.
//
// Why it matters: every list filter used a plain `includes`, so a half-typed
// word or any Arabic/Persian spelling difference matched nothing at all — and a
// mistyped command only produced an error message.

import { foldFa, fuzzyScore, rankMatches, didYouMean, similarity, nearMiss } from '../src/lib/fuzzy.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) foldFa normalizes the spelling a user cannot see:')
{
  check('Arabic yeh folds to the Persian one', foldFa('فیلم') === foldFa('فيلم'), [foldFa('فیلم'), foldFa('فيلم')])
  check('Arabic kaf folds too', foldFa('کتاب') === foldFa('كتاب'))
  check('ZWNJ is dropped', foldFa('نیم‌فاصله') === foldFa('نیمفاصله'), foldFa('نیم‌فاصله'))
  check('harakat are dropped', foldFa('کِتاب') === foldFa('کتاب'), foldFa('کِتاب'))
  check('latin is lower-cased, not otherwise changed', foldFa('Plugin') === 'plugin')
}

console.log('2) fuzzyScore matches subsequences and prefers real matches:')
{
  check('exact prefix scores high', fuzzyScore('plug', 'plugin') > fuzzyScore('plg', 'plugin'))
  check('scattered letters still match', fuzzyScore('pgi', 'plugin') > 0)
  check('unrelated text is zero', fuzzyScore('zzz', 'plugin') === 0)
  check('empty pattern is zero', fuzzyScore('', 'plugin') === 0)
  check('persian keyword found from an arabic-layout query', fuzzyScore('فيلم', 'فیلم, سینما') > 0)
  check('subsequence respects order', fuzzyScore('gnilp', 'plugin') === 0)
}

console.log('3) rankMatches keeps the best first and the order stable:')
{
  const items = ['plugin', 'playground', 'plex', 'artifact']
  const ranked = rankMatches(items, 'pl', (x) => x)
  check('only matches are returned', ranked.every((x) => x.startsWith('pl')), ranked)
  check('unmatched dropped', !ranked.includes('artifact'), ranked)
  const empty = rankMatches(items, '   ', (x) => x)
  check('blank query keeps every item in order', JSON.stringify(empty) === JSON.stringify(items), empty)
  const byField = rankMatches([{ n: 'alpha' }, { n: 'beta' }], 'bet', (o) => o.n)
  check('a key function is honoured', byField.length === 1 && byField[0].n === 'beta', byField)
  // A swapped pair is the most common typo, and the subsequence scorer alone
  // cannot see it — the menu used to go empty on `/updtae`.
  const typo = rankMatches(['update', 'remove', 'install'], 'updtae', (x) => x)
  check('a transposition still ranks the row', typo[0] === 'update', typo)
  const noise = rankMatches(['update', 'remove', 'install'], 'zzzz', (x) => x)
  check('garbage matches nothing', noise.length === 0, noise)
  // A near-miss must not drag in EVERY row: only the close ones survive.
  const few = rankMatches(['list', 'install', 'upload'], 'instal', (x) => x)
  check('a near miss keeps only the close rows', few.length === 1 && few[0] === 'install', few)
  // A name is often several words joined by a separator; a typo inside ONE part
  // is a near miss for the whole name only if the parts are compared alone.
  const slug = rankMatches(['note-taker', 'pdf-tools'], 'ntoe', (x) => x)
  check('a typo inside one word of a slug still matches', slug.length === 1 && slug[0] === 'note-taker', slug)
}

console.log('4) didYouMean suggests the closest real commands:')
{
  const cmds = ['help', 'compact', 'clear', 'skill', 'mcp', 'plugin', 'artifact', 'schedule', 'goal']
  const typo = didYouMean('plugni', cmds)
  check('a transposition still finds the command', typo.includes('plugin'), typo)
  const short = didYouMean('skil', cmds)
  check('a missing letter finds the command', short.includes('skill'), short)
  check('the cap is honoured', didYouMean('zzzz', cmds).length === 0, didYouMean('zzzz', cmds))
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll tests passed. ✅')
}
