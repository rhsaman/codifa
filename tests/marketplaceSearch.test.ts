// Unit tests for `/plugin marketplace add|remove` address parsing and the
// `/plugin search` shortlist (src/lib/plugins.ts + src/lib/marketplaceSearch.ts).
//
// Why it matters: the command and Settings → Marketplaces must agree on what an
// address means, and the model must only ever see plugins that really exist in
// a saved index. The ranking is pure, so a Persian request is expanded to the
// English vocabulary the indexes use before the model picks from the list.

;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  location: { href: 'http://localhost/' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { addEventListener: () => {}, removeEventListener: () => {} },
  coder: new Proxy(
    {
      getSidecarUrl: async () => 'http://127.0.0.1:8899',
      onSidecarChanged: () => () => {},
      onSidecarDead: () => () => {},
    },
    {
      get: (target: Record<string, unknown>, key: string) =>
        key in target ? target[key] : () => () => {},
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const {
  parseMarketplaceAddress,
  parsePluginInstallSpec,
  findMarketplaces,
  marketKey,
} = await import('../src/lib/plugins.ts')
const { rankMarketplaceHits, describeMarketplaceHit } = await import(
  '../src/lib/marketplaceSearch.ts'
)

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.error(`  ✗ ${name}`, extra ?? '')
  }
}

function entry(over: Record<string, unknown> = {}) {
  return {
    name: 'Security Audit',
    description: 'Audit a codebase for vulnerabilities and secrets',
    version: '1.0.0',
    author: 'team',
    category: 'security',
    repo: 'owner/security',
    repo_path: '',
    repo_ref: '',
    ...over,
  }
}

console.log('1) parseMarketplaceAddress keeps repo, ref and sub-path apart:')
{
  const plain = parseMarketplaceAddress('owner/repo')
  check('plain repo', plain.repo === 'owner/repo' && !plain.path && !plain.git_ref, plain)

  const tagged = parseMarketplaceAddress('owner/repo@v1.2.3/sub/dir')
  check(
    'tag and sub-path',
    tagged.repo === 'owner/repo' && tagged.git_ref === 'v1.2.3' && tagged.path === 'sub/dir',
    tagged,
  )

  const branch = parseMarketplaceAddress('owner/repo@feature/x')
  check(
    'a branch ref ends at the first slash',
    branch.repo === 'owner/repo' && branch.git_ref === 'feature' && branch.path === 'x',
    branch,
  )

  const url = parseMarketplaceAddress('https://github.com/owner/repo')
  check('a full URL stays whole', url.repo === 'https://github.com/owner/repo', url)

  const empty = parseMarketplaceAddress('   ')
  check('empty has no repo', empty.repo === '', empty)
}

console.log('2) findMarketplaces matches the names a user types from memory:')
{
  const markets = [
    { repo: 'anthropics/claude-plugins-community', label: 'Community', kind: 'plugins' },
    { repo: 'https://github.com/obra/superpowers-marketplace', kind: 'plugins' },
    { repo: 'me/tools', label: 'My Tools', path: 'plugins', git_ref: 'dev', kind: 'plugins' },
  ]

  check('label is case-insensitive', findMarketplaces(markets, 'community').length === 1)
  check('short repo matches a stored URL', findMarketplaces(markets, 'obra/superpowers-marketplace').length === 1)
  check('address with ref and path matches', findMarketplaces(markets, 'me/tools@dev/plugins').length === 1)
  check('unknown name matches nothing', findMarketplaces(markets, 'nope').length === 0)
  check('empty query matches nothing', findMarketplaces(markets, '  ').length === 0)
  check(
    'marketKey is stable for one address',
    marketKey('me/tools', 'plugins', 'dev') === 'me/tools|plugins|dev',
  )
}

console.log('3) rankMarketplaceHits picks the right rows before the model sees them:')
{
  const hits = [
    { entry: entry(), marketplace: 'Community', score: 0 },
    {
      entry: entry({
        name: 'Recipe Box',
        description: 'Cook dinner with what is in the fridge',
        category: 'cooking',
        repo: 'owner/recipes',
      }),
      marketplace: 'Community',
      score: 0,
    },
    {
      entry: entry({
        name: 'Docker Deploy',
        description: 'Deploy containers to a server',
        category: 'deployment',
        repo: 'owner/deploy',
      }),
      marketplace: 'Community',
      score: 0,
    },
  ]

  const security = rankMarketplaceHits(hits, 'security audit')
  check('the matching plugin is first', security[0]?.entry.name === 'Security Audit', security)

  const persian = rankMarketplaceHits(hits, 'امنیت')
  check('a Persian request expands to security', persian[0]?.entry.name === 'Security Audit', persian)

  const deploy = rankMarketplaceHits(hits, 'داکر')
  check('a Persian docker request finds the deploy plugin', deploy[0]?.entry.name === 'Docker Deploy', deploy)

  const capped = rankMarketplaceHits(hits, 'security', 1)
  check('max caps the shortlist', capped.length === 1, capped)

  const noMatch = rankMarketplaceHits(hits, 'zzzzzzzz')
  check('no keyword match still returns a shortlist', noMatch.length === hits.length, noMatch)
}

console.log('4) duplicate addresses collapse and the install command is exact:')
{
  const same = entry({ repo: 'owner/security', repo_path: 'skills/audit', repo_ref: 'v1' })
  const hits = [
    { entry: same, marketplace: 'One', score: 0 },
    { entry: same, marketplace: 'Two', score: 0 },
  ]
  const ranked = rankMarketplaceHits(hits, 'audit')
  check('one row per install address', ranked.length === 1, ranked)

  const line = describeMarketplaceHit(ranked[0])
  check(
    'install command carries repo, path and ref in order',
    line.includes('/plugin install owner/security skills/audit v1'),
    line,
  )
  check('the marketplace name is shown', line.includes('(One)'), line)
}

console.log("5) parsePluginInstallSpec reads Claude Code's plugin@marketplace spelling:")
{
  const scoped = parsePluginInstallSpec('prompts.chat@prompts.chat')
  check(
    'plugin and marketplace split at @',
    scoped?.plugin === 'prompts.chat' && scoped?.marketplace === 'prompts.chat',
    scoped,
  )
  check('owner/repo@ref stays a repo address', parsePluginInstallSpec('owner/repo@v1') === null)
  check(
    'an SSH address stays a repo address',
    parsePluginInstallSpec('git@github.com:owner/repo') === null,
  )
  check(
    'a marketplace URL after @ is allowed',
    parsePluginInstallSpec('plug@https://github.com/f/prompts.chat')?.marketplace ===
      'https://github.com/f/prompts.chat',
  )
  check('a bare name has no marketplace', parsePluginInstallSpec('eurusd') === null)
  check(
    'an empty half is rejected',
    parsePluginInstallSpec('@market') === null && parsePluginInstallSpec('plug@') === null,
  )

  const markets = [{ repo: 'f/prompts.chat', kind: 'plugins' }]
  check(
    "a repo's last segment finds the marketplace saved as owner/repo",
    findMarketplaces(markets, 'prompts.chat').length === 1,
  )
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
}
console.log('\nAll marketplace search tests passed.')
